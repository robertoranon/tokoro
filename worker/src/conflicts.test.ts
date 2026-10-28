import { describe, it, expect } from 'vitest';
import { makeD1, ALL_MIGRATIONS } from '../test-support/d1';
import {
  isRange,
  groupByPlace,
  ConflictEvent,
  reevaluateConflicts,
  purgeConflictLinks,
} from './conflicts';

const ev = (id: string, lat: number, lng: number): ConflictEvent => ({
  id,
  act_url: 'https://band.example',
  start_time: '2027-06-18T20:00:00',
  end_time: null,
  lat,
  lng,
  venue_name: null,
});

describe('isRange', () => {
  it('is true when the end is on a later day', () => {
    expect(
      isRange({
        start_time: '2027-06-18T20:00:00',
        end_time: '2027-06-20T02:00:00',
      })
    ).toBe(true);
  });
  it('is false for null, same day, or earlier end', () => {
    expect(isRange({ start_time: '2027-06-18T20:00:00', end_time: null })).toBe(
      false
    );
    expect(
      isRange({
        start_time: '2027-06-18T20:00:00',
        end_time: '2027-06-18T23:00:00',
      })
    ).toBe(false);
    expect(
      isRange({
        start_time: '2027-06-18T20:00:00',
        end_time: '2027-06-17T23:00:00',
      })
    ).toBe(false);
  });
});

describe('groupByPlace', () => {
  it('groups events 0.004 degrees apart', () => {
    expect(
      groupByPlace([ev('a', 53.0, -6.0), ev('b', 53.004, -6.004)])
    ).toHaveLength(1);
  });
  it('separates Dublin and Cork', () => {
    const g = groupByPlace([ev('a', 53.35, -6.26), ev('b', 51.9, -8.47)]);
    expect(g.map(c => c.map(e => e.id))).toEqual([['a'], ['b']]);
  });
  it('is order independent', () => {
    const a = ev('a', 53.35, -6.26),
      b = ev('b', 51.9, -8.47),
      c = ev('c', 53.351, -6.261);
    const norm = (gs: ConflictEvent[][]) =>
      gs.map(g => g.map(e => e.id).sort()).sort();
    expect(norm(groupByPlace([a, b, c]))).toEqual(
      norm(groupByPlace([c, b, a]))
    );
    expect(norm(groupByPlace([a, b, c]))).toEqual([['a', 'c'], ['b']]);
  });
  it('chains three events into one cluster', () => {
    const g = groupByPlace([
      ev('a', 53.0, -6.0),
      ev('b', 53.004, -6.0),
      ev('c', 53.008, -6.0),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].map(e => e.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('conflict schema', () => {
  it('has events.held defaulting to 0 and the three tables', async () => {
    const db = makeD1(ALL_MIGRATIONS);
    await db
      .prepare(
        `INSERT INTO events (id,pubkey,signature,title,lat,lng,geohash5,geohash6,start_time,category,created_at)
       VALUES ('e1','p','s','t',1,1,'g5','g6','2027-06-18T20:00:00','music','2026-01-01T00:00:00')`
      )
      .run();
    const row = await db
      .prepare('SELECT held FROM events WHERE id = ?')
      .bind('e1')
      .first<{ held: number }>();
    expect(row?.held).toBe(0);
    for (const t of ['conflicts', 'conflict_events', 'conflict_proposals']) {
      const r = await db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .bind(t)
        .first();
      expect(r, t).toBeTruthy();
    }
  });
});

describe('reevaluateConflicts', () => {
  const DAY = '2027-06-18';
  const BAND = 'https://band.example';
  let n = 0;
  async function add(
    db: any,
    id: string,
    lat: number,
    lng: number,
    o: { act?: string | null; start?: string; end?: string | null } = {}
  ) {
    await db
      .prepare(
        `INSERT INTO events (id,pubkey,signature,title,lat,lng,geohash5,geohash6,start_time,end_time,category,created_at,act_url)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        id,
        'p',
        's',
        'T' + id,
        lat,
        lng,
        'g5',
        'g6',
        o.start ?? `${DAY}T20:00:00`,
        o.end ?? null,
        'music',
        '2026-01-01T00:00:00',
        o.act === undefined ? BAND : o.act
      )
      .run();
    n++;
  }
  const held = async (db: any, id: string) =>
    (await db
      .prepare('SELECT held, alert_pending FROM events WHERE id=?')
      .bind(id)
      .first()) as any;
  const conflicts = async (db: any) =>
    (await db.prepare('SELECT * FROM conflicts ORDER BY id').all())
      .results as any[];

  it('creates a conflict for Dublin/Cork and holds both; idempotent', async () => {
    const db = makeD1(ALL_MIGRATIONS);
    await add(db, 'a', 53.35, -6.26);
    await add(db, 'b', 51.9, -8.47);
    const r = await reevaluateConflicts({ DB: db } as any, BAND + '/', DAY);
    expect(r.created?.events.map(e => e.id).sort()).toEqual(['a', 'b']);
    expect((await held(db, 'a')).held).toBe(1);
    expect((await held(db, 'b')).held).toBe(1);
    const r2 = await reevaluateConflicts({ DB: db } as any, BAND, DAY);
    expect(r2.created).toBeNull();
    expect(await conflicts(db)).toHaveLength(1);
  });

  it('resolves when one event is deleted and releases the survivor', async () => {
    const db = makeD1(ALL_MIGRATIONS);
    await add(db, 'a', 53.35, -6.26, { start: '2999-06-18T20:00:00' });
    await add(db, 'b', 51.9, -8.47, { start: '2999-06-18T20:00:00' });
    const env = { DB: db } as any;
    await reevaluateConflicts(env, BAND, '2999-06-18');
    await db.prepare("DELETE FROM events WHERE id='b'").run();
    const r = await reevaluateConflicts(env, BAND, '2999-06-18');
    expect(r.created).toBeNull();
    const cs = await conflicts(db);
    expect(cs[0].status).toBe('resolved');
    expect(cs[0].resolved_at).toBeTruthy();
    const a = await held(db, 'a');
    expect(a.held).toBe(0);
    expect(a.alert_pending).toBe(1);
  });

  it('does not set alert_pending for past events on release', async () => {
    const db = makeD1(ALL_MIGRATIONS);
    await add(db, 'a', 53.35, -6.26, { start: '2020-06-18T20:00:00' });
    await add(db, 'b', 51.9, -8.47, { start: '2020-06-18T20:00:00' });
    const env = { DB: db } as any;
    await reevaluateConflicts(env, BAND, '2020-06-18');
    await db.prepare("DELETE FROM events WHERE id='b'").run();
    await reevaluateConflicts(env, BAND, '2020-06-18');
    const a = await held(db, 'a');
    expect(a.held).toBe(0);
    expect(a.alert_pending).toBe(0);
  });

  it('ignores same-place events, ranges and events without act_url', async () => {
    const db = makeD1(ALL_MIGRATIONS);
    const env = { DB: db } as any;
    await add(db, 'a', 53.35, -6.26);
    await add(db, 'b', 53.351, -6.261);
    expect((await reevaluateConflicts(env, BAND, DAY)).created).toBeNull();
    await add(db, 'r', 51.9, -8.47, { end: '2027-06-20T02:00:00' });
    expect((await reevaluateConflicts(env, BAND, DAY)).created).toBeNull();
    await add(db, 'n', 48.1, 11.5, { act: null });
    expect((await reevaluateConflicts(env, BAND, DAY)).created).toBeNull();
    expect(await conflicts(db)).toHaveLength(0);
    expect((await held(db, 'a')).held).toBe(0);
  });

  it('leaves a kept conflict with the same event set alone', async () => {
    const db = makeD1(ALL_MIGRATIONS);
    const env = { DB: db } as any;
    await add(db, 'a', 53.35, -6.26);
    await add(db, 'b', 51.9, -8.47);
    await reevaluateConflicts(env, BAND, DAY);
    await db.prepare("UPDATE conflicts SET status='kept'").run();
    await db.prepare('UPDATE events SET held=0').run();
    const r = await reevaluateConflicts(env, BAND, DAY);
    expect(r.created).toBeNull();
    expect(await conflicts(db)).toHaveLength(1);
    expect((await held(db, 'a')).held).toBe(0);
  });

  it('opens a new conflict when a kept set changes', async () => {
    const db = makeD1(ALL_MIGRATIONS);
    const env = { DB: db } as any;
    await add(db, 'a', 53.35, -6.26);
    await add(db, 'b', 51.9, -8.47);
    await reevaluateConflicts(env, BAND, DAY);
    await db.prepare("UPDATE conflicts SET status='kept'").run();
    await db.prepare('UPDATE events SET held=0').run();
    await add(db, 'c', 48.1, 11.5);
    const r = await reevaluateConflicts(env, BAND, DAY);
    expect(r.created?.events).toHaveLength(3);
    const cs = await conflicts(db);
    expect(cs.map(c => c.status)).toEqual(['resolved', 'open']);
    expect((await held(db, 'c')).held).toBe(1);
  });

  it('updates an open conflict when a third event appears', async () => {
    const db = makeD1(ALL_MIGRATIONS);
    const env = { DB: db } as any;
    await add(db, 'a', 53.35, -6.26);
    await add(db, 'b', 51.9, -8.47);
    await reevaluateConflicts(env, BAND, DAY);
    await add(db, 'c', 48.1, 11.5);
    const r = await reevaluateConflicts(env, BAND, DAY);
    expect(r.created).toBeNull();
    expect(await conflicts(db)).toHaveLength(1);
    const links = (await db.prepare('SELECT * FROM conflict_events').all())
      .results;
    expect(links).toHaveLength(3);
    expect((await held(db, 'c')).held).toBe(1);
  });

  it('concurrent reevaluations create exactly one open conflict', async () => {
    const db = makeD1(ALL_MIGRATIONS);
    const env = { DB: db } as any;
    await add(db, 'a', 53.35, -6.26);
    await add(db, 'b', 51.9, -8.47);
    const rs = await Promise.all([
      reevaluateConflicts(env, BAND, DAY),
      reevaluateConflicts(env, BAND, DAY),
    ]);
    expect(rs.filter(r => r.created).length).toBe(1);
    const cs = await conflicts(db);
    expect(cs.filter(c => c.status === 'open')).toHaveLength(1);
    const links = (await db.prepare('SELECT * FROM conflict_events').all())
      .results;
    expect(links).toHaveLength(2);
  });

  it('the unique index rejects a second open conflict', async () => {
    const db = makeD1(ALL_MIGRATIONS);
    const ins = () =>
      db
        .prepare(
          "INSERT OR IGNORE INTO conflicts (act_url, day, status, created_at) VALUES (?, ?, 'open', 'x')"
        )
        .bind(BAND, DAY)
        .run();
    expect((await ins()).meta.changes).toBe(1);
    expect((await ins()).meta.changes).toBe(0);
  });

  it('a moved event stays held and unalerted whichever day is reevaluated first', async () => {
    for (const order of [
      ['D2', 'D1'],
      ['D1', 'D2'],
    ]) {
      const db = makeD1(ALL_MIGRATIONS);
      const env = { DB: db } as any;
      const D1 = '2999-06-18',
        D2 = '2999-06-19';
      await add(db, 'a', 53.35, -6.26, { start: `${D1}T20:00:00` });
      await add(db, 'b', 51.9, -8.47, { start: `${D1}T20:00:00` });
      await add(db, 'c', 48.1, 11.5, { start: `${D2}T20:00:00` });
      await reevaluateConflicts(env, BAND, D1);
      await db
        .prepare("UPDATE events SET start_time = ? WHERE id = 'b'")
        .bind(`${D2}T20:00:00`)
        .run();
      for (const o of order)
        await reevaluateConflicts(env, BAND, o === 'D1' ? D1 : D2);
      const b = await held(db, 'b');
      expect([order.join(), b.held, b.alert_pending]).toEqual([
        order.join(),
        1,
        0,
      ]);
      expect((await held(db, 'c')).held).toBe(1);
      expect((await held(db, 'a')).held).toBe(0);
    }
  });

  it('releases an event that drops out of a still-open conflict', async () => {
    const db = makeD1(ALL_MIGRATIONS);
    const env = { DB: db } as any;
    const day = '2999-06-18';
    const st = { start: `${day}T20:00:00` };
    await add(db, 'a', 53.35, -6.26, st);
    await add(db, 'b', 51.9, -8.47, st);
    await add(db, 'c', 48.1, 11.5, st);
    await reevaluateConflicts(env, BAND, day);
    await db.prepare("DELETE FROM events WHERE id='c'").run();
    await db
      .prepare(
        "UPDATE events SET start_time='2999-07-01T20:00:00' WHERE id='b'"
      )
      .run();
    await add(db, 'd', 41.9, 12.5, st);
    await reevaluateConflicts(env, BAND, day);
    expect((await held(db, 'a')).held).toBe(1);
    expect((await held(db, 'd')).held).toBe(1);
    const b = await held(db, 'b');
    expect([b.held, b.alert_pending]).toEqual([0, 1]);
    const links = (
      await db.prepare('SELECT event_id FROM conflict_events').all()
    ).results as any[];
    expect(links.map(l => l.event_id).sort()).toEqual(['a', 'd']);
  });

  it('purgeConflictLinks removes an event from links and proposals', async () => {
    const db = makeD1(ALL_MIGRATIONS);
    const env = { DB: db } as any;
    await add(db, 'a', 53.35, -6.26);
    await add(db, 'b', 51.9, -8.47);
    await reevaluateConflicts(env, BAND, DAY);
    await db
      .prepare(
        "INSERT INTO conflict_proposals (conflict_id,event_id,action,reason,created_at) VALUES (1,'a','delete','r','x')"
      )
      .run();
    await purgeConflictLinks(env, 'a');
    const l = (await db.prepare('SELECT event_id FROM conflict_events').all())
      .results as any[];
    expect(l.map(x => x.event_id)).toEqual(['b']);
    expect(
      (await db.prepare('SELECT * FROM conflict_proposals').all()).results
    ).toHaveLength(0);
  });
});
