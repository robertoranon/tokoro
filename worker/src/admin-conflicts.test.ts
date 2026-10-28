import { describe, it, expect, beforeEach } from 'vitest';
import * as ed from '@noble/ed25519';
import { routeAdminConflictRequest } from './admin-conflicts';
import worker from './index';
import { reevaluateConflicts } from './conflicts';
import { proposalMessage } from './crypto';
import { makeD1, ALL_MIGRATIONS } from '../test-support/d1';
import {
  makeKey,
  authHeaders,
  toHex,
  type TestKey,
} from '../test-support/sign';

const BAND = 'https://band.example';
const DAY = '2030-06-18';

let env: any;
let admin: TestKey;
let crawler: TestKey;

async function addEvent(
  id: string,
  lat: number,
  lng: number,
  o: { day?: string; tags?: string } = {}
) {
  await env.DB.prepare(
    `INSERT INTO events (id,pubkey,signature,title,lat,lng,geohash5,geohash6,
       start_time,category,created_at,act_name,act_url,tags)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      id,
      'p',
      's',
      'Show ' + id,
      lat,
      lng,
      'g5',
      'g6',
      `${o.day ?? DAY}T20:00:00`,
      'music',
      '2026-01-01T00:00:00',
      'The Band',
      BAND,
      o.tags ?? '["rock"]'
    )
    .run();
}

/** Dublin + Cork on DAY: one open conflict, both held. Returns its id. */
async function openConflict(day = DAY, prefix = ''): Promise<number> {
  await addEvent(prefix + 'dublin', 53.35, -6.26, { day });
  await addEvent(prefix + 'cork', 51.9, -8.47, { day });
  const { created } = await reevaluateConflicts(env, BAND, day);
  return created!.id;
}

const row = async (id: string) =>
  (await env.DB.prepare('SELECT held, alert_pending FROM events WHERE id = ?')
    .bind(id)
    .first()) as any;
const conflict = async (id: number) =>
  (await env.DB.prepare('SELECT * FROM conflicts WHERE id = ?')
    .bind(id)
    .first()) as any;

async function adminCall(
  key: TestKey,
  method: string,
  path: string,
  domain: string,
  payload: string,
  body?: string,
  query = ''
) {
  const headers = await authHeaders(key, domain, payload);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return (await routeAdminConflictRequest(
    new Request('https://w.test' + path + query, { method, headers, body }),
    env,
    path
  ))!;
}

const list = (query = '') =>
  adminCall(
    admin,
    'GET',
    '/admin/conflicts',
    'admin-read',
    '/admin/conflicts' + query,
    undefined,
    query
  );

const resolve = (id: number | string, body: unknown, key = admin) => {
  const raw = JSON.stringify(body);
  return adminCall(
    key,
    'POST',
    `/admin/conflicts/${id}/resolve`,
    'admin-conflict-resolve',
    raw,
    raw
  );
};

async function signProposal(key: TestKey, eventId: string, reason: string) {
  return toHex(
    await ed.signAsync(await proposalMessage(eventId, reason), key.priv)
  );
}

async function propose(
  key: TestKey,
  eventId: string,
  reason: string,
  signature?: string
) {
  const sig = signature ?? (await signProposal(key, eventId, reason));
  return worker.fetch(
    new Request('https://w.test/conflicts/proposals', {
      method: 'POST',
      body: JSON.stringify({
        pubkey: key.pubkey,
        event_id: eventId,
        reason,
        signature: sig,
      }),
    }),
    env
  );
}

const proposalCount = async () =>
  (
    (await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM conflict_proposals'
    ).first()) as any
  ).n;

beforeEach(async () => {
  admin = await makeKey();
  crawler = await makeKey();
  env = {
    DB: makeD1(ALL_MIGRATIONS),
    ADMIN_PUBKEY: admin.pubkey,
    ALLOWED_PUBKEYS: crawler.pubkey,
  };
});

describe('admin auth', () => {
  it('503 when ADMIN_PUBKEY is not configured', async () => {
    env.ADMIN_PUBKEY = undefined;
    expect((await list()).status).toBe(503);
    const id = await openConflict();
    expect((await resolve(id, { action: 'keep_both' })).status).toBe(503);
  });

  it('403 for a valid signature from another key', async () => {
    const other = await makeKey();
    const res = await adminCall(
      other,
      'GET',
      '/admin/conflicts',
      'admin-read',
      '/admin/conflicts'
    );
    expect(res.status).toBe(403);
    const id = await openConflict();
    expect((await resolve(id, { action: 'keep_both' }, other)).status).toBe(
      403
    );
  });

  it('401 for an unsigned request', async () => {
    const res = (await routeAdminConflictRequest(
      new Request('https://w.test/admin/conflicts'),
      env,
      '/admin/conflicts'
    ))!;
    expect(res.status).toBe(401);
  });

  it('an admin-read signature cannot be replayed on admin-conflict-resolve', async () => {
    const id = await openConflict();
    const raw = JSON.stringify({ action: 'keep_both' });
    const res = await adminCall(
      admin,
      'POST',
      `/admin/conflicts/${id}/resolve`,
      'admin-read',
      raw,
      raw
    );
    expect(res.status).toBe(401);
    expect((await conflict(id)).status).toBe('open');
  });

  it('returns null for paths it does not own', async () => {
    const r = await routeAdminConflictRequest(
      new Request('https://w.test/admin/members'),
      env,
      '/admin/members'
    );
    expect(r).toBeNull();
  });

  it('is routed by the worker', async () => {
    const headers = await authHeaders(admin, 'admin-read', '/admin/conflicts');
    const res = await worker.fetch(
      new Request('https://w.test/admin/conflicts', { headers }),
      env
    );
    expect(res.status).toBe(200);
  });
});

describe('GET /admin/conflicts', () => {
  it('lists open conflicts with their held events and proposals', async () => {
    const id = await openConflict();
    expect(
      (await propose(crawler, 'cork', 'not on the band site')).status
    ).toBe(201);
    const res = await list();
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.conflicts).toHaveLength(1);
    const c = body.conflicts[0];
    expect(c).toMatchObject({
      id,
      act_url: BAND,
      act_name: 'The Band',
      day: DAY,
      status: 'open',
      created_at: expect.any(String),
      resolved_at: null,
    });
    expect(c.events.map((e: any) => e.id).sort()).toEqual(['cork', 'dublin']);
    expect(c.events.every((e: any) => e.held === 1)).toBe(true);
    expect(c.events[0].tags).toEqual(['rock']);
    expect(c.events[0].title).toMatch(/^Show /);
    expect(c.proposals).toEqual([
      {
        id: expect.any(Number),
        event_id: 'cork',
        action: 'delete',
        reason: 'not on the band site',
        created_at: expect.any(String),
      },
    ]);
  });

  it('filters by status', async () => {
    const open = await openConflict();
    const kept = await openConflict('2030-06-19', 'b');
    expect((await resolve(kept, { action: 'keep_both' })).status).toBe(200);

    const opened: any = await (await list()).json();
    expect(opened.conflicts.map((c: any) => c.id)).toEqual([open]);
    const keptList: any = await (await list('?status=kept')).json();
    expect(keptList.conflicts.map((c: any) => c.id)).toEqual([kept]);
    const resolved: any = await (await list('?status=resolved')).json();
    expect(resolved.conflicts).toEqual([]);
    expect((await list('?status=bogus')).status).toBe(400);
  });
});

describe('POST /admin/conflicts/:id/resolve', () => {
  it('keep_both marks the conflict kept and releases its events', async () => {
    const id = await openConflict();
    const res = await resolve(id, { action: 'keep_both' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await conflict(id)).status).toBe('kept');
    for (const e of ['dublin', 'cork']) {
      expect(await row(e)).toEqual({ held: 0, alert_pending: 1 });
    }
    // a later reconcile of the unchanged set leaves it alone
    await reevaluateConflicts(env, BAND, DAY);
    expect((await conflict(id)).status).toBe('kept');
    expect((await row('cork')).held).toBe(0);
  });

  it('delete removes the event, resolves the conflict and releases the survivor', async () => {
    const id = await openConflict();
    await propose(crawler, 'cork', 'wrong city');
    const res = await resolve(id, { action: 'delete', event_id: 'cork' });
    expect(res.status).toBe(200);
    expect(await row('cork')).toBeNull();
    expect(await row('dublin')).toEqual({ held: 0, alert_pending: 1 });
    expect((await conflict(id)).status).toBe('resolved');
    expect(await proposalCount()).toBe(0);
  });

  it('apply_proposal deletes the proposed event', async () => {
    const id = await openConflict();
    await propose(crawler, 'dublin', 'venue closed');
    const p = (await env.DB.prepare(
      'SELECT id FROM conflict_proposals'
    ).first()) as any;
    const res = await resolve(id, {
      action: 'apply_proposal',
      proposal_id: p.id,
    });
    expect(res.status).toBe(200);
    expect(await row('dublin')).toBeNull();
    expect((await row('cork')).held).toBe(0);
    expect((await conflict(id)).status).toBe('resolved');
    expect(await proposalCount()).toBe(0);
  });

  it('404 for an unknown conflict or proposal', async () => {
    const id = await openConflict();
    expect((await resolve(999, { action: 'keep_both' })).status).toBe(404);
    expect((await resolve('abc', { action: 'keep_both' })).status).toBe(404);
    expect(
      (await resolve(id, { action: 'apply_proposal', proposal_id: 999 })).status
    ).toBe(404);
  });

  it('400 when the event is not part of the conflict, or the conflict is not open', async () => {
    const id = await openConflict();
    const other = await openConflict('2030-06-19', 'b');
    expect(
      (await resolve(id, { action: 'delete', event_id: 'bcork' })).status
    ).toBe(400);
    expect(
      (await resolve(id, { action: 'delete', event_id: 'nope' })).status
    ).toBe(400);
    expect((await row('bcork')).held).toBe(1);
    // a proposal of another conflict cannot be applied here
    await propose(crawler, 'bcork', 'x');
    const p = (await env.DB.prepare(
      'SELECT id FROM conflict_proposals'
    ).first()) as any;
    expect(
      (await resolve(id, { action: 'apply_proposal', proposal_id: p.id }))
        .status
    ).toBe(400);
    expect((await resolve(id, { action: 'bogus' })).status).toBe(400);

    expect((await resolve(other, { action: 'keep_both' })).status).toBe(200);
    expect((await resolve(other, { action: 'keep_both' })).status).toBe(400);
    expect(
      (await resolve(other, { action: 'delete', event_id: 'bcork' })).status
    ).toBe(400);
    expect(await row('bcork')).not.toBeNull();
  });
});

describe('POST /conflicts/proposals', () => {
  it('records a delete proposal for a held event; twice gives one row', async () => {
    const id = await openConflict();
    const first = await propose(crawler, 'cork', 'not on the band site');
    expect(first.status).toBe(201);
    const p: any = await first.json();
    expect(p).toMatchObject({
      id: expect.any(Number),
      conflict_id: id,
      event_id: 'cork',
      action: 'delete',
      reason: 'not on the band site',
    });
    const again = await propose(crawler, 'cork', 'not on the band site');
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).id).toBe(p.id);
    expect(await proposalCount()).toBe(1);
    expect(first.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('403 for a key that is not allowlisted, or when no allowlist is set', async () => {
    await openConflict();
    const stranger = await makeKey();
    expect((await propose(stranger, 'cork', 'x')).status).toBe(403);
    env.ALLOWED_PUBKEYS = undefined;
    expect((await propose(crawler, 'cork', 'x')).status).toBe(403);
    expect(await proposalCount()).toBe(0);
  });

  it('403 for a blocklisted key', async () => {
    await openConflict();
    await env.DB.prepare(
      "INSERT INTO blocklist (pubkey, created_at) VALUES (?, '2026-01-01T00:00:00')"
    )
      .bind(crawler.pubkey)
      .run();
    expect((await propose(crawler, 'cork', 'x')).status).toBe(403);
  });

  it('409 unless the event is held in an open conflict', async () => {
    await addEvent('solo', 53.35, -6.26);
    let res = await propose(crawler, 'solo', 'x');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Event is not in an open conflict',
    });
    expect((await propose(crawler, 'missing', 'x')).status).toBe(409);

    const id = await openConflict('2030-06-19', 'b');
    await resolve(id, { action: 'keep_both' });
    res = await propose(crawler, 'bcork', 'x');
    expect(res.status).toBe(409);
    expect(await proposalCount()).toBe(0);
  });

  it('401 for a bad signature', async () => {
    await openConflict();
    const sig = await signProposal(crawler, 'cork', 'other reason');
    expect((await propose(crawler, 'cork', 'x', sig)).status).toBe(401);
    expect(await proposalCount()).toBe(0);
  });

  it('400 for a bad reason or malformed fields', async () => {
    await openConflict();
    expect((await propose(crawler, 'cork', 'x'.repeat(201))).status).toBe(400);
    expect((await propose(crawler, 'cork', '')).status).toBe(400);
    expect((await propose(crawler, 'cork', '   ')).status).toBe(400);
    expect((await propose(crawler, 'cork', 'x', 'zz')).status).toBe(400);
    const bad = await worker.fetch(
      new Request('https://w.test/conflicts/proposals', {
        method: 'POST',
        body: 'not json',
      }),
      env
    );
    expect(bad.status).toBe(400);
    expect((await propose(crawler, 'cork', 'x'.repeat(200))).status).toBe(201);
  });

  it('deleting the event removes its proposals', async () => {
    const id = await openConflict();
    await propose(crawler, 'cork', 'x');
    await resolve(id, { action: 'delete', event_id: 'cork' });
    expect(await proposalCount()).toBe(0);
  });
});
