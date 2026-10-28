import { describe, it, expect } from 'vitest';
import { makeD1, ALL_MIGRATIONS } from '../test-support/d1';
import { isRange, groupByPlace, ConflictEvent } from './conflicts';

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
