import type { Env } from './index';
import { jsonResponse } from './http';
import {
  verifySignedRequest,
  authErrorResponse,
  readSignedBody,
} from './member-auth';
import { decodeB64Url, normalizeActUrl, normalizeName } from './band-keys';

const MAX_SUGGESTION_NAME = 120;
export const MAX_URL_LENGTH = 500;

export function nowIso(): string {
  return new Date().toISOString().slice(0, 19);
}

/** What differs between following/suggesting a band and a festival. */
export interface MemberKindConfig {
  followTable: string;
  suggestionTable: string;
  /** Column holding the normalized url (follow table and suggestions link). */
  urlColumn: string;
  followDomain: string;
  unfollowDomain: string;
  suggestDomain: string;
  invalidUrlMessage: string;
  /** Admin signature domains for rejecting / linking suggestions. */
  adminRejectDomain: string;
  adminLinkDomain: string;
}

export const BAND_KIND: MemberKindConfig = {
  followTable: 'member_bands',
  suggestionTable: 'band_suggestions',
  urlColumn: 'act_url',
  followDomain: 'band-follow',
  unfollowDomain: 'band-unfollow',
  suggestDomain: 'band-suggest',
  invalidUrlMessage: 'Invalid band url',
  adminRejectDomain: 'admin-suggestion-reject',
  adminLinkDomain: 'admin-suggestion-link',
};

export const FESTIVAL_KIND: MemberKindConfig = {
  followTable: 'member_festivals',
  suggestionTable: 'festival_suggestions',
  urlColumn: 'festival_url',
  followDomain: 'festival-follow',
  unfollowDomain: 'festival-unfollow',
  suggestDomain: 'festival-suggest',
  invalidUrlMessage: 'Invalid festival url',
  adminRejectDomain: 'admin-festival-suggestion-reject',
  adminLinkDomain: 'admin-festival-suggestion-link',
};

interface ActiveMember {
  pubkey: string;
  name: string;
}

/** The active member behind a signed request, or the error Response to return. */
export async function authMember(
  request: Request,
  env: Env,
  domain: string,
  payload: string
): Promise<ActiveMember | Response> {
  const auth = await verifySignedRequest(request, domain, payload);
  if (!auth.ok) return authErrorResponse(auth);
  const row = await env.DB.prepare(
    'SELECT name, revoked_at FROM members WHERE pubkey = ?'
  )
    .bind(auth.pubkey)
    .first<{ name: string; revoked_at: string | null }>();
  if (!row || row.revoked_at) {
    return jsonResponse(
      { error: 'Forbidden', message: 'Not an active member' },
      403
    );
  }
  return { pubkey: auth.pubkey, name: row.name };
}

/** Handles /member/*; returns null when the path is not one of ours. */
export async function routeMemberRequest(
  request: Request,
  env: Env,
  path: string
): Promise<Response | null> {
  if (request.method === 'GET' && path === '/member/me') {
    return handleMemberMe(request, env);
  }
  const band = path.match(/^\/member\/bands\/([^/]+)$/);
  if (band && (request.method === 'POST' || request.method === 'DELETE')) {
    return handleMemberFollow(request, env, band[1], BAND_KIND);
  }
  const festival = path.match(/^\/member\/festivals\/([^/]+)$/);
  if (festival && (request.method === 'POST' || request.method === 'DELETE')) {
    return handleMemberFollow(request, env, festival[1], FESTIVAL_KIND);
  }
  if (request.method === 'POST' && path === '/member/suggestions') {
    return handleMemberSuggest(request, env, BAND_KIND);
  }
  if (request.method === 'POST' && path === '/member/festival-suggestions') {
    return handleMemberSuggest(request, env, FESTIVAL_KIND);
  }
  return null;
}

async function handleMemberMe(request: Request, env: Env): Promise<Response> {
  const m = await authMember(request, env, 'member-read', '/member/me');
  if (m instanceof Response) return m;
  const bands = await env.DB.prepare(
    'SELECT act_url FROM member_bands WHERE pubkey = ? ORDER BY created_at, act_url'
  )
    .bind(m.pubkey)
    .all<{ act_url: string }>();
  const suggestions = await env.DB.prepare(
    `SELECT id, name, url, status, act_url, reject_reason, created_at
     FROM band_suggestions WHERE pubkey = ? ORDER BY id DESC`
  )
    .bind(m.pubkey)
    .all();
  const festivals = await env.DB.prepare(
    'SELECT festival_url FROM member_festivals WHERE pubkey = ? ORDER BY created_at, festival_url'
  )
    .bind(m.pubkey)
    .all<{ festival_url: string }>();
  const festivalSuggestions = await env.DB.prepare(
    `SELECT id, name, url, status, festival_url, reject_reason, created_at
     FROM festival_suggestions WHERE pubkey = ? ORDER BY id DESC`
  )
    .bind(m.pubkey)
    .all();
  const tg = await env.DB.prepare(
    'SELECT telegram_chat_id, radar_alerts FROM members WHERE pubkey = ?'
  )
    .bind(m.pubkey)
    .first<{ telegram_chat_id: string | null; radar_alerts: number }>();
  return jsonResponse({
    name: m.name,
    bands: (bands.results || []).map(r => r.act_url),
    suggestions: suggestions.results || [],
    telegram: {
      linked: !!tg?.telegram_chat_id,
      radar_alerts: tg?.radar_alerts === 1,
    },
    festivals: (festivals.results || []).map(r => r.festival_url),
    festival_suggestions: festivalSuggestions.results || [],
  });
}

async function handleMemberFollow(
  request: Request,
  env: Env,
  encoded: string,
  kind: MemberKindConfig
): Promise<Response> {
  const decoded = decodeB64Url(encoded);
  const actUrl = decoded === null ? null : normalizeActUrl(decoded);
  if (!actUrl) return jsonResponse({ error: kind.invalidUrlMessage }, 400);

  const follow = request.method === 'POST';
  const m = await authMember(
    request,
    env,
    follow ? kind.followDomain : kind.unfollowDomain,
    actUrl
  );
  if (m instanceof Response) return m;

  if (follow) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO ${kind.followTable} (pubkey, ${kind.urlColumn}, created_at) VALUES (?, ?, ?)`
    )
      .bind(m.pubkey, actUrl, nowIso())
      .run();
  } else {
    await env.DB.prepare(
      `DELETE FROM ${kind.followTable} WHERE pubkey = ? AND ${kind.urlColumn} = ?`
    )
      .bind(m.pubkey, actUrl)
      .run();
  }
  return jsonResponse({ [kind.urlColumn]: actUrl });
}

async function handleMemberSuggest(
  request: Request,
  env: Env,
  kind: MemberKindConfig
): Promise<Response> {
  const raw = await readSignedBody(request);
  if (raw instanceof Response) return raw;
  const m = await authMember(request, env, kind.suggestDomain, raw);
  if (m instanceof Response) return m;

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ error: 'Invalid body' }, 400);
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (
    name === '' ||
    name.length > MAX_SUGGESTION_NAME ||
    normalizeName(name) === ''
  ) {
    return jsonResponse(
      { error: `name is required (1-${MAX_SUGGESTION_NAME} characters)` },
      400
    );
  }

  let url: string | null = null;
  if (body.url !== undefined && body.url !== null && body.url !== '') {
    url = normalizeActUrl(body.url);
    if (url === null || url.length > MAX_URL_LENGTH) {
      return jsonResponse(
        {
          error: `url must be an http(s) URL (max ${MAX_URL_LENGTH} characters)`,
        },
        400
      );
    }
  }

  const key = normalizeName(name);
  const pending = await env.DB.prepare(
    `SELECT id, name FROM ${kind.suggestionTable} WHERE pubkey = ? AND status = 'pending'`
  )
    .bind(m.pubkey)
    .all<{ id: number; name: string }>();
  const existing = (pending.results || []).find(
    r => normalizeName(r.name) === key
  );
  if (existing) return jsonResponse({ id: existing.id, duplicate: true }, 200);

  const res = await env.DB.prepare(
    `INSERT INTO ${kind.suggestionTable} (pubkey, name, url, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`
  )
    .bind(m.pubkey, name, url, nowIso())
    .run();
  return jsonResponse({ id: res.meta.last_row_id }, 201);
}
