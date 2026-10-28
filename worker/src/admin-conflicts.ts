// Admin conflict endpoints and crawler proposals (worker/SPECS.md 7.16).
import type { Env } from './index';
import { jsonResponse } from './http';
import {
  authAdmin,
  readAdminBody,
  readPayload,
  parseJson,
} from './admin-members';
import { purgeConflictLinks, releaseStatements } from './conflicts';
import { reevaluateAfterWrite } from './conflict-writes';
import { verifyProposalSignature } from './crypto';
import { nowIso } from './members';

const HEX_64 = /^[0-9a-f]{64}$/i;
const HEX_128 = /^[0-9a-f]{128}$/i;
const MAX_REASON = 200;
const MAX_EVENT_ID = 128;
const STATUSES = ['open', 'kept', 'resolved'];

interface ConflictRow {
  id: number;
  act_url: string;
  day: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

/** Handles /admin/conflicts*; null when the path is not one of ours. */
export async function routeAdminConflictRequest(
  request: Request,
  env: Env,
  path: string
): Promise<Response | null> {
  const m = request.method;
  if (m === 'GET' && path === '/admin/conflicts')
    return listConflicts(request, env);
  const res = path.match(/^\/admin\/conflicts\/([^/]+)\/resolve$/);
  if (m === 'POST' && res) return resolveConflict(request, env, res[1]);
  return null;
}

async function listConflicts(request: Request, env: Env): Promise<Response> {
  const a = await authAdmin(request, env, 'admin-read', readPayload(request));
  if (a !== true) return a;
  const status = new URL(request.url).searchParams.get('status') || 'open';
  if (!STATUSES.includes(status)) {
    return jsonResponse({ error: 'Invalid status' }, 400);
  }
  const conflicts = (
    await env.DB.prepare(
      `SELECT id, act_url, day, status, created_at, resolved_at
       FROM conflicts WHERE status = ? ORDER BY day, id`
    )
      .bind(status)
      .all<ConflictRow>()
  ).results;

  const out = [];
  for (const c of conflicts) {
    const events = (
      await env.DB.prepare(
        `SELECT e.* FROM conflict_events ce JOIN events e ON e.id = ce.event_id
         WHERE ce.conflict_id = ? ORDER BY e.start_time, e.id`
      )
        .bind(c.id)
        .all<Record<string, unknown>>()
    ).results.map(
      (e): Record<string, unknown> => ({
        ...e,
        tags: e.tags ? JSON.parse(e.tags as string) : [],
      })
    );
    const proposals = (
      await env.DB.prepare(
        `SELECT id, event_id, action, reason, created_at
         FROM conflict_proposals WHERE conflict_id = ? ORDER BY id`
      )
        .bind(c.id)
        .all()
    ).results;
    const actName =
      (events.find(e => e.act_name)?.act_name as string | undefined) ?? null;
    out.push({
      id: c.id,
      act_url: c.act_url,
      act_name: actName,
      day: c.day,
      status: c.status,
      created_at: c.created_at,
      resolved_at: c.resolved_at,
      events,
      proposals,
    });
  }
  return jsonResponse({ conflicts: out });
}

async function linkedIds(env: Env, conflictId: number): Promise<string[]> {
  return (
    await env.DB.prepare(
      'SELECT event_id FROM conflict_events WHERE conflict_id = ?'
    )
      .bind(conflictId)
      .all<{ event_id: string }>()
  ).results.map(r => r.event_id);
}

async function resolveConflict(
  request: Request,
  env: Env,
  idParam: string
): Promise<Response> {
  const raw = await readAdminBody(request, env);
  if (raw instanceof Response) return raw;
  const a = await authAdmin(request, env, 'admin-conflict-resolve', raw);
  if (a !== true) return a;

  const notFound = jsonResponse({ error: 'Conflict not found' }, 404);
  if (!/^[1-9][0-9]{0,15}$/.test(idParam)) return notFound;
  const id = Number(idParam);
  const conflict = await env.DB.prepare(
    'SELECT id, status FROM conflicts WHERE id = ?'
  )
    .bind(id)
    .first<{ id: number; status: string }>();
  if (!conflict) return notFound;

  const body = parseJson(raw);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);
  if (!['keep_both', 'delete', 'apply_proposal'].includes(body.action)) {
    return jsonResponse(
      { error: 'action must be keep_both, delete or apply_proposal' },
      400
    );
  }
  if (conflict.status !== 'open') {
    return jsonResponse({ error: 'Conflict is not open' }, 400);
  }
  const linked = await linkedIds(env, id);

  if (body.action === 'keep_both') {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE conflicts SET status = 'kept', resolved_at = ? WHERE id = ?"
      ).bind(nowIso(), id),
      ...releaseStatements(env, linked, id),
    ]);
    return jsonResponse({ ok: true });
  }

  let eventId: string;
  if (body.action === 'apply_proposal') {
    if (!Number.isInteger(body.proposal_id)) {
      return jsonResponse({ error: 'proposal_id must be an integer' }, 400);
    }
    const p = await env.DB.prepare(
      'SELECT event_id, action FROM conflict_proposals WHERE id = ?'
    )
      .bind(body.proposal_id)
      .first<{ event_id: string; action: string }>();
    if (!p) return jsonResponse({ error: 'Proposal not found' }, 404);
    eventId = p.event_id;
  } else {
    if (typeof body.event_id !== 'string' || body.event_id === '') {
      return jsonResponse({ error: 'event_id is required' }, 400);
    }
    eventId = body.event_id;
  }
  if (!linked.includes(eventId)) {
    return jsonResponse({ error: 'Event is not part of this conflict' }, 400);
  }

  const event = await env.DB.prepare(
    'SELECT act_url, start_time FROM events WHERE id = ?'
  )
    .bind(eventId)
    .first<{ act_url: string | null; start_time: string }>();
  if (!event) {
    return jsonResponse({ error: 'Event is not part of this conflict' }, 400);
  }
  // As DELETE /events/:id: delete, purge the conflict links, re-check the band-day
  await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(eventId).run();
  await purgeConflictLinks(env, eventId);
  await reevaluateAfterWrite(env, [
    { actUrl: event.act_url, startTime: event.start_time },
  ]);
  return jsonResponse({ ok: true, deleted: eventId });
}

/**
 * POST /conflicts/proposals: an allowlisted key (the crawler) proposes
 * deleting a held event of an open conflict. Idempotent per event.
 */
export async function handlePostProposal(
  request: Request,
  env: Env
): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ error: 'Invalid body' }, 400);
  }
  const { pubkey, signature, event_id: eventId, reason } = body;
  if (
    typeof pubkey !== 'string' ||
    typeof signature !== 'string' ||
    !HEX_64.test(pubkey) ||
    !HEX_128.test(signature)
  ) {
    return jsonResponse(
      { error: 'Missing or malformed pubkey or signature' },
      400
    );
  }
  if (
    typeof eventId !== 'string' ||
    eventId === '' ||
    eventId.length > MAX_EVENT_ID
  ) {
    return jsonResponse({ error: 'event_id is required' }, 400);
  }
  if (
    typeof reason !== 'string' ||
    reason.trim() === '' ||
    reason.length > MAX_REASON
  ) {
    return jsonResponse(
      { error: `reason is required (1-${MAX_REASON} characters)` },
      400
    );
  }

  const blocked = await env.DB.prepare(
    'SELECT pubkey FROM blocklist WHERE pubkey = ?'
  )
    .bind(pubkey)
    .first();
  if (blocked) return jsonResponse({ error: 'Forbidden' }, 403);
  // Unlike publishing, proposals always need an allowlist: none set, none accepted.
  const allowed = (env.ALLOWED_PUBKEYS ?? '')
    .split(',')
    .map(k => k.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(pubkey.toLowerCase())) {
    return jsonResponse(
      { error: 'Forbidden', message: 'Public key not in allowlist' },
      403
    );
  }
  if (!(await verifyProposalSignature(eventId, reason, signature, pubkey))) {
    return jsonResponse({ error: 'Invalid signature' }, 401);
  }

  const target = await env.DB.prepare(
    `SELECT c.id AS conflict_id
     FROM events e
     JOIN conflict_events ce ON ce.event_id = e.id
     JOIN conflicts c ON c.id = ce.conflict_id AND c.status = 'open'
     WHERE e.id = ? AND e.held = 1
     LIMIT 1`
  )
    .bind(eventId)
    .first<{ conflict_id: number }>();
  if (!target) {
    return jsonResponse({ error: 'Event is not in an open conflict' }, 409);
  }

  const existing = await env.DB.prepare(
    "SELECT id, conflict_id FROM conflict_proposals WHERE event_id = ? AND action = 'delete'"
  )
    .bind(eventId)
    .first<{ id: number; conflict_id: number }>();
  let created = false;
  if (existing) {
    // A proposal left from an earlier conflict of the same event moves to the
    // open one (reason and created_at kept), so the admin list shows it.
    if (existing.conflict_id !== target.conflict_id) {
      await env.DB.prepare(
        'UPDATE conflict_proposals SET conflict_id = ? WHERE id = ?'
      )
        .bind(target.conflict_id, existing.id)
        .run();
    }
  } else {
    // UNIQUE (event_id, action): a concurrent duplicate is a no-op
    const ins = await env.DB.prepare(
      `INSERT OR IGNORE INTO conflict_proposals (conflict_id, event_id, action, reason, created_at)
       VALUES (?, ?, 'delete', ?, ?)`
    )
      .bind(target.conflict_id, eventId, reason, nowIso())
      .run();
    created = ins.meta.changes === 1;
  }
  const proposal = await env.DB.prepare(
    `SELECT id, conflict_id, event_id, action, reason, created_at
     FROM conflict_proposals WHERE event_id = ? AND action = 'delete'`
  )
    .bind(eventId)
    .first();
  return jsonResponse(proposal, created ? 201 : 200);
}
