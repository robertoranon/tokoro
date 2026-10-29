import type { Env } from './index';
import { jsonResponse } from './http';
import {
  verifySignedRequest,
  authErrorResponse,
  readSignedBody,
} from './member-auth';
import { authMember, nowIso } from './members';

export const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const LINK_CODE_PATH = '/member/telegram/link-code';
const CODE_RE = /^[A-Za-z0-9_-]{22}$/;
const CHAT_ID_RE = /^-?\d{1,20}$/;

/** 128 random bits as 22 base64url characters. */
function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const isoAt = (ms: number) => new Date(ms).toISOString().slice(0, 19);

type BotHandler = (env: Env, chatId: string, body: any) => Promise<Response>;

/** Handles the Telegram link endpoints; null when the path is not one of ours. */
export async function routeTelegramRequest(
  request: Request,
  env: Env,
  path: string
): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  if (path === LINK_CODE_PATH) return issueLinkCode(request, env);
  if (path === '/telegram/link')
    return botCall(request, env, 'telegram-link', linkChat);
  if (path === '/telegram/settings')
    return botCall(request, env, 'telegram-settings', updateSettings);
  if (path === '/telegram/unlink')
    return botCall(request, env, 'telegram-unlink', unlinkChat);
  return null;
}

async function issueLinkCode(request: Request, env: Env): Promise<Response> {
  if (!env.TELEGRAM_BOT_USERNAME) {
    return jsonResponse({ error: 'Telegram not configured' }, 503);
  }
  const m = await authMember(
    request,
    env,
    'telegram-link-code',
    LINK_CODE_PATH
  );
  if (m instanceof Response) return m;
  const code = newCode();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM telegram_link_codes WHERE pubkey = ?').bind(
      m.pubkey
    ),
    env.DB.prepare(
      'INSERT INTO telegram_link_codes (code, pubkey, expires_at) VALUES (?, ?, ?)'
    ).bind(code, m.pubkey, isoAt(Date.now() + LINK_CODE_TTL_MS)),
  ]);
  return jsonResponse({
    code,
    bot_url: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=${code}`,
  });
}

/** Auth for calls made by the bot: 503 unconfigured, 413/401 as in 3.6, 403 for any other key. */
async function botCall(
  request: Request,
  env: Env,
  domain: string,
  handler: BotHandler
): Promise<Response> {
  if (!env.TELEGRAM_BOT_PUBKEY) {
    return jsonResponse({ error: 'Telegram not configured' }, 503);
  }
  const raw = await readSignedBody(request);
  if (raw instanceof Response) return raw;
  const auth = await verifySignedRequest(request, domain, raw);
  if (!auth.ok) return authErrorResponse(auth);
  if (auth.pubkey !== env.TELEGRAM_BOT_PUBKEY.toLowerCase()) {
    return jsonResponse({ error: 'Unauthorized' }, 403);
  }
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ error: 'Invalid body' }, 400);
  }
  const chatId =
    typeof body.chat_id === 'string' && CHAT_ID_RE.test(body.chat_id)
      ? body.chat_id
      : null;
  if (!chatId) return jsonResponse({ error: 'chat_id is required' }, 400);
  return handler(env, chatId, body);
}

async function linkChat(
  env: Env,
  chatId: string,
  body: any
): Promise<Response> {
  const code = typeof body.code === 'string' ? body.code : '';
  if (!CODE_RE.test(code)) return jsonResponse({ error: 'Unknown code' }, 404);
  // Consume the code atomically so two concurrent redemptions cannot both win.
  const row = await env.DB.prepare(
    'DELETE FROM telegram_link_codes WHERE code = ? RETURNING pubkey, expires_at'
  )
    .bind(code)
    .first<{ pubkey: string; expires_at: string }>();
  if (!row) return jsonResponse({ error: 'Unknown code' }, 404);
  if (row.expires_at < nowIso()) {
    return jsonResponse({ error: 'Code expired' }, 410);
  }
  const member = await env.DB.prepare(
    'SELECT name, revoked_at, radar_alerts FROM members WHERE pubkey = ?'
  )
    .bind(row.pubkey)
    .first<{ name: string; revoked_at: string | null; radar_alerts: number }>();
  if (!member || member.revoked_at) {
    return jsonResponse({ error: 'Not an active member' }, 403);
  }
  // Clear the chat from any other member first: telegram_chat_id is unique.
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE members SET telegram_chat_id = NULL WHERE telegram_chat_id = ? AND pubkey != ?'
    ).bind(chatId, row.pubkey),
    env.DB.prepare(
      'UPDATE members SET telegram_chat_id = ? WHERE pubkey = ?'
    ).bind(chatId, row.pubkey),
  ]);
  const bands = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM member_bands WHERE pubkey = ?'
  )
    .bind(row.pubkey)
    .first<{ n: number }>();
  const festivals = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM member_festivals WHERE pubkey = ?'
  )
    .bind(row.pubkey)
    .first<{ n: number }>();
  return jsonResponse({
    name: member.name,
    bands: bands?.n ?? 0,
    festivals: festivals?.n ?? 0,
    radar_alerts: member.radar_alerts === 1,
  });
}

async function updateSettings(
  env: Env,
  chatId: string,
  body: any
): Promise<Response> {
  if (typeof body.radar_alerts !== 'boolean') {
    return jsonResponse({ error: 'radar_alerts must be true or false' }, 400);
  }
  const res = await env.DB.prepare(
    'UPDATE members SET radar_alerts = ? WHERE telegram_chat_id = ?'
  )
    .bind(body.radar_alerts ? 1 : 0, chatId)
    .run();
  if (res.meta.changes === 0) {
    return jsonResponse({ error: 'Chat not linked' }, 404);
  }
  return jsonResponse({ radar_alerts: body.radar_alerts });
}

async function unlinkChat(env: Env, chatId: string): Promise<Response> {
  const res = await env.DB.prepare(
    'UPDATE members SET telegram_chat_id = NULL WHERE telegram_chat_id = ?'
  )
    .bind(chatId)
    .run();
  if (res.meta.changes === 0) {
    return jsonResponse({ error: 'Chat not linked' }, 404);
  }
  return jsonResponse({ unlinked: true });
}
