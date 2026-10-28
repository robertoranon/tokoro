import type { Env } from './index';
import { jsonResponse } from './http';
import {
  verifySignedRequest,
  authErrorResponse,
  readSignedBody,
} from './member-auth';
import { normalizeActUrl, normalizeName } from './band-keys';
import { nowIso, MAX_URL_LENGTH } from './members';

const HEX_64 = /^[0-9a-f]{64}$/i;
const MAX_MEMBER_NAME = 60;
const MAX_REASON = 200;
const MAX_IDS = 200;

/** Ok when the request is signed by ADMIN_PUBKEY; otherwise the error Response. */
export async function authAdmin(
  request: Request,
  env: Env,
  domain: string,
  payload: string
): Promise<true | Response> {
  if (!env.ADMIN_PUBKEY) {
    return jsonResponse({ error: 'Admin not configured' }, 503);
  }
  const auth = await verifySignedRequest(request, domain, payload);
  if (!auth.ok) return authErrorResponse(auth);
  if (auth.pubkey !== env.ADMIN_PUBKEY.toLowerCase()) {
    return jsonResponse({ error: 'Unauthorized' }, 403);
  }
  return true;
}

/**
 * The payload of admin-read: the request path with its query string exactly
 * as requested (e.g. `/admin/suggestions?detail=1`), so a captured signature
 * cannot be replayed with a different query.
 */
export function readPayload(request: Request): string {
  const url = new URL(request.url);
  return url.pathname + url.search;
}

/**
 * The body of a signed admin request: 503 when the admin is not configured,
 * then the checks of readSignedBody (413 / 401 / 413) before reading it.
 */
export async function readAdminBody(
  request: Request,
  env: Env
): Promise<string | Response> {
  if (!env.ADMIN_PUBKEY) {
    return jsonResponse({ error: 'Admin not configured' }, 503);
  }
  return readSignedBody(request);
}

export function parseJson(raw: string): any | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// D1 accepts at most 100 bound parameters per statement: id lists are split
// into chunks that leave room for a few extra parameters.
const ID_CHUNK = 90;

function chunks<T>(list: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
const placeholders = (n: number) => new Array(n).fill('?').join(', ');

function validIds(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_IDS) return null;
  return v.every(n => Number.isInteger(n) && n > 0) ? (v as number[]) : null;
}

/** Handles the admin member/suggestion endpoints; null when the path is not one of ours. */
export async function routeAdminMemberRequest(
  request: Request,
  env: Env,
  path: string
): Promise<Response | null> {
  const m = request.method;
  if (m === 'GET' && path === '/admin/members')
    return listMembers(request, env);
  if (m === 'POST' && path === '/admin/members')
    return createMember(request, env);
  const revoke = path.match(/^\/admin\/members\/([^/]+)\/revoke$/);
  if (m === 'POST' && revoke) return revokeMember(request, env, revoke[1]);
  const del = path.match(/^\/admin\/members\/([^/]+)$/);
  if (m === 'DELETE' && del) return deleteMember(request, env, del[1]);
  if (m === 'GET' && path === '/admin/suggestions')
    return listSuggestions(request, env);
  if (m === 'POST' && path === '/admin/suggestions/reject')
    return rejectSuggestions(request, env);
  if (m === 'POST' && path === '/admin/suggestions/link')
    return linkSuggestions(request, env);
  if (m === 'GET' && path === '/admin/band-followers')
    return listBandFollowers(request, env);
  return null;
}

async function listMembers(request: Request, env: Env): Promise<Response> {
  const a = await authAdmin(request, env, 'admin-read', readPayload(request));
  if (a !== true) return a;
  const res = await env.DB.prepare(
    `SELECT m.pubkey, m.name, m.created_at, m.revoked_at,
            (SELECT COUNT(*) FROM member_bands b WHERE b.pubkey = m.pubkey) AS band_count
     FROM members m ORDER BY m.created_at DESC, m.name`
  ).all();
  return jsonResponse(res.results || []);
}

async function createMember(request: Request, env: Env): Promise<Response> {
  const raw = await readAdminBody(request, env);
  if (raw instanceof Response) return raw;
  const a = await authAdmin(request, env, 'admin-member', raw);
  if (a !== true) return a;
  const body = parseJson(raw);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const pubkey =
    typeof body.pubkey === 'string' ? body.pubkey.toLowerCase() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!HEX_64.test(pubkey)) {
    return jsonResponse({ error: 'pubkey must be 64 hex characters' }, 400);
  }
  if (name === '' || name.length > MAX_MEMBER_NAME) {
    return jsonResponse(
      { error: `name is required (1-${MAX_MEMBER_NAME} characters)` },
      400
    );
  }
  if (pubkey === env.ADMIN_PUBKEY!.toLowerCase()) {
    return jsonResponse(
      { error: 'Cannot register the admin key as a member' },
      400
    );
  }
  const exists = await env.DB.prepare(
    'SELECT pubkey FROM members WHERE pubkey = ?'
  )
    .bind(pubkey)
    .first();
  if (exists) return jsonResponse({ error: 'Member already exists' }, 409);

  await env.DB.prepare(
    'INSERT INTO members (pubkey, name, created_at) VALUES (?, ?, ?)'
  )
    .bind(pubkey, name, nowIso())
    .run();
  return jsonResponse({ pubkey, name }, 201);
}

async function memberExists(env: Env, pubkey: string): Promise<boolean> {
  return !!(await env.DB.prepare('SELECT pubkey FROM members WHERE pubkey = ?')
    .bind(pubkey)
    .first());
}

async function revokeMember(
  request: Request,
  env: Env,
  pubkey: string
): Promise<Response> {
  const target = pubkey.toLowerCase();
  const a = await authAdmin(request, env, 'admin-member-revoke', target);
  if (a !== true) return a;
  if (!(await memberExists(env, target)))
    return jsonResponse({ error: 'Member not found' }, 404);
  await env.DB.prepare(
    'UPDATE members SET revoked_at = ? WHERE pubkey = ? AND revoked_at IS NULL'
  )
    .bind(nowIso(), target)
    .run();
  return jsonResponse({ message: 'Member revoked', pubkey: target });
}

async function deleteMember(
  request: Request,
  env: Env,
  pubkey: string
): Promise<Response> {
  const target = pubkey.toLowerCase();
  const a = await authAdmin(request, env, 'admin-member-delete', target);
  if (a !== true) return a;
  if (!(await memberExists(env, target)))
    return jsonResponse({ error: 'Member not found' }, 404);
  // One batch = one transaction: either all the deletes happen or none.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM member_bands WHERE pubkey = ?').bind(target),
    env.DB.prepare('DELETE FROM band_suggestions WHERE pubkey = ?').bind(
      target
    ),
    env.DB.prepare('DELETE FROM telegram_link_codes WHERE pubkey = ?').bind(
      target
    ),
    env.DB.prepare('DELETE FROM members WHERE pubkey = ?').bind(target),
  ]);
  return jsonResponse({ message: 'Member deleted', pubkey: target });
}

export interface SuggestionRow {
  id: number;
  pubkey: string;
  name: string;
  url: string | null;
  created_at: string;
  member_name: string | null;
}

/** Group suggestions by normalized band name, most requested first. */
export function groupSuggestions(rows: SuggestionRow[], detail: boolean) {
  const groups = new Map<
    string,
    {
      key: string;
      names: Map<string, number>;
      urls: Set<string>;
      pubkeys: Set<string>;
      memberNames: Set<string>;
      ids: number[];
      created_at: string;
    }
  >();
  for (const r of rows) {
    const key = normalizeName(r.name);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        names: new Map(),
        urls: new Set(),
        pubkeys: new Set(),
        memberNames: new Set(),
        ids: [],
        created_at: r.created_at,
      };
      groups.set(key, g);
    }
    g.names.set(r.name, (g.names.get(r.name) || 0) + 1);
    if (r.url) g.urls.add(r.url);
    g.pubkeys.add(r.pubkey);
    if (r.member_name) g.memberNames.add(r.member_name);
    g.ids.push(r.id);
    if (r.created_at < g.created_at) g.created_at = r.created_at;
  }
  const out = [...groups.values()].map(g => ({
    key: g.key,
    name_variants: [...g.names.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([n]) => n),
    urls: [...g.urls],
    members: g.pubkeys.size,
    ids: g.ids,
    created_at: g.created_at,
    ...(detail ? { member_names: [...g.memberNames] } : {}),
  }));
  out.sort(
    (a, b) =>
      b.members - a.members ||
      a.created_at.localeCompare(b.created_at) ||
      a.key.localeCompare(b.key)
  );
  return out;
}

async function listSuggestions(request: Request, env: Env): Promise<Response> {
  const a = await authAdmin(request, env, 'admin-read', readPayload(request));
  if (a !== true) return a;
  const params = new URL(request.url).searchParams;
  const status = params.get('status') || 'pending';
  if (!['pending', 'rejected', 'linked'].includes(status)) {
    return jsonResponse({ error: 'Invalid status' }, 400);
  }
  const res = await env.DB.prepare(
    `SELECT s.id, s.pubkey, s.name, s.url, s.created_at, m.name AS member_name
     FROM band_suggestions s LEFT JOIN members m ON m.pubkey = s.pubkey
     WHERE s.status = ? ORDER BY s.id`
  )
    .bind(status)
    .all<SuggestionRow>();
  return jsonResponse(
    groupSuggestions(res.results || [], params.get('detail') === '1')
  );
}

async function rejectSuggestions(
  request: Request,
  env: Env
): Promise<Response> {
  const raw = await readAdminBody(request, env);
  if (raw instanceof Response) return raw;
  const a = await authAdmin(request, env, 'admin-suggestion-reject', raw);
  if (a !== true) return a;
  const body = parseJson(raw);
  const ids = body ? validIds(body.ids) : null;
  if (!body || !ids)
    return jsonResponse({ error: 'ids must be a non-empty list of ids' }, 400);
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length > MAX_REASON) {
    return jsonResponse(
      { error: `reason is limited to ${MAX_REASON} characters` },
      400
    );
  }
  // One UPDATE per chunk of ids (one for up to ID_CHUNK ids), all in one batch.
  const writes = chunks([...new Set(ids)]).map(chunk =>
    env.DB.prepare(
      `UPDATE band_suggestions SET status = 'rejected', reject_reason = ?
       WHERE status = 'pending' AND id IN (${placeholders(chunk.length)})`
    ).bind(reason || null, ...chunk)
  );
  const results = await env.DB.batch(writes);
  const updated = results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  return jsonResponse({ updated });
}

async function linkSuggestions(request: Request, env: Env): Promise<Response> {
  const raw = await readAdminBody(request, env);
  if (raw instanceof Response) return raw;
  const a = await authAdmin(request, env, 'admin-suggestion-link', raw);
  if (a !== true) return a;
  const body = parseJson(raw);
  const ids = body ? validIds(body.ids) : null;
  if (!body || !ids)
    return jsonResponse({ error: 'ids must be a non-empty list of ids' }, 400);
  const actUrl = normalizeActUrl(body.act_url);
  if (!actUrl || actUrl.length > MAX_URL_LENGTH)
    return jsonResponse(
      {
        error: `act_url must be an http(s) URL (max ${MAX_URL_LENGTH} characters)`,
      },
      400
    );

  // Read first, one query per chunk of ids (one for up to ID_CHUNK ids);
  // unknown and already linked ids are skipped. Then write the follows and
  // the status updates of the remaining suggestions in one batch, which D1
  // runs as a single transaction: all of them happen or none.
  const now = nowIso();
  const linkable: number[] = [];
  for (const chunk of chunks([...new Set(ids)])) {
    const res = await env.DB.prepare(
      `SELECT id, pubkey, status FROM band_suggestions
       WHERE id IN (${placeholders(chunk.length)})`
    )
      .bind(...chunk)
      .all<{ id: number; pubkey: string; status: string }>();
    for (const row of res.results || []) {
      if (row.status !== 'linked') linkable.push(row.id);
    }
  }
  const writes: D1PreparedStatement[] = [];
  for (const chunk of chunks(linkable)) {
    const inList = placeholders(chunk.length);
    writes.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO member_bands (pubkey, act_url, created_at)
         SELECT DISTINCT pubkey, ?, ? FROM band_suggestions WHERE id IN (${inList})`
      ).bind(actUrl, now, ...chunk),
      env.DB.prepare(
        `UPDATE band_suggestions SET status = 'linked', act_url = ?
         WHERE id IN (${inList})`
      ).bind(actUrl, ...chunk)
    );
  }
  if (writes.length > 0) await env.DB.batch(writes);
  return jsonResponse({ updated: linkable.length });
}

async function listBandFollowers(
  request: Request,
  env: Env
): Promise<Response> {
  const a = await authAdmin(request, env, 'admin-read', readPayload(request));
  if (a !== true) return a;
  const res = await env.DB.prepare(
    `SELECT b.act_url, COUNT(*) AS followers
     FROM member_bands b JOIN members m ON m.pubkey = b.pubkey
     WHERE m.revoked_at IS NULL
     GROUP BY b.act_url ORDER BY followers DESC, b.act_url`
  ).all();
  return jsonResponse(res.results || []);
}
