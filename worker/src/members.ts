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

interface ActiveMember {
  pubkey: string;
  name: string;
}

/** The active member behind a signed request, or the error Response to return. */
async function authMember(
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
    return handleMemberBand(request, env, band[1]);
  }
  if (request.method === 'POST' && path === '/member/suggestions') {
    return handleMemberSuggest(request, env);
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
  return jsonResponse({
    name: m.name,
    bands: (bands.results || []).map(r => r.act_url),
    suggestions: suggestions.results || [],
  });
}

async function handleMemberBand(
  request: Request,
  env: Env,
  encoded: string
): Promise<Response> {
  const decoded = decodeB64Url(encoded);
  const actUrl = decoded === null ? null : normalizeActUrl(decoded);
  if (!actUrl) return jsonResponse({ error: 'Invalid band url' }, 400);

  const follow = request.method === 'POST';
  const m = await authMember(
    request,
    env,
    follow ? 'band-follow' : 'band-unfollow',
    actUrl
  );
  if (m instanceof Response) return m;

  if (follow) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO member_bands (pubkey, act_url, created_at) VALUES (?, ?, ?)'
    )
      .bind(m.pubkey, actUrl, nowIso())
      .run();
  } else {
    await env.DB.prepare(
      'DELETE FROM member_bands WHERE pubkey = ? AND act_url = ?'
    )
      .bind(m.pubkey, actUrl)
      .run();
  }
  return jsonResponse({ act_url: actUrl });
}

async function handleMemberSuggest(
  request: Request,
  env: Env
): Promise<Response> {
  const raw = await readSignedBody(request);
  if (raw instanceof Response) return raw;
  const m = await authMember(request, env, 'band-suggest', raw);
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
    "SELECT id, name FROM band_suggestions WHERE pubkey = ? AND status = 'pending'"
  )
    .bind(m.pubkey)
    .all<{ id: number; name: string }>();
  const existing = (pending.results || []).find(
    r => normalizeName(r.name) === key
  );
  if (existing) return jsonResponse({ id: existing.id, duplicate: true }, 200);

  const res = await env.DB.prepare(
    `INSERT INTO band_suggestions (pubkey, name, url, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`
  )
    .bind(m.pubkey, name, url, nowIso())
    .run();
  return jsonResponse({ id: res.meta.last_row_id }, 201);
}
