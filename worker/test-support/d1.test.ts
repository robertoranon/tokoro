import { describe, it, expect } from 'vitest';
import { makeD1 } from './d1';

const count = async (db: D1Database, table: string) =>
  ((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()) as any).n;

describe('makeD1 batch', () => {
  it('runs the statements in order and returns one result per statement', async () => {
    const db = makeD1();
    const res = await db.batch([
      db
        .prepare(
          'INSERT INTO members (pubkey, name, created_at) VALUES (?, ?, ?)'
        )
        .bind('p1', 'Ann', 'x'),
      db
        .prepare('UPDATE members SET name = ? WHERE pubkey = ?')
        .bind('Bea', 'p1'),
      db.prepare('SELECT name FROM members'),
    ]);
    expect(res).toHaveLength(3);
    expect(res.every(r => r.success)).toBe(true);
    expect(res[0].meta.changes).toBe(1);
    expect(res[1].meta.changes).toBe(1);
    expect(res[2].results).toEqual([{ name: 'Bea' }]);
  });

  it('rolls everything back when a statement fails', async () => {
    const db = makeD1();
    await db
      .prepare(
        'INSERT INTO members (pubkey, name, created_at) VALUES (?, ?, ?)'
      )
      .bind('p0', 'Zed', 'x')
      .run();
    await expect(
      db.batch([
        db
          .prepare(
            'INSERT INTO member_bands (pubkey, act_url, created_at) VALUES (?, ?, ?)'
          )
          .bind('p0', 'https://a.example', 'x'),
        db.prepare('DELETE FROM members WHERE pubkey = ?').bind('p0'),
        // primary key violation: fails after two successful writes
        db
          .prepare(
            'INSERT INTO members (pubkey, name, created_at) VALUES (?, ?, ?)'
          )
          .bind('dup', 'A', 'x'),
        db
          .prepare(
            'INSERT INTO members (pubkey, name, created_at) VALUES (?, ?, ?)'
          )
          .bind('dup', 'B', 'x'),
      ])
    ).rejects.toThrow();
    expect(await count(db, 'member_bands')).toBe(0);
    expect(await count(db, 'members')).toBe(1);
    expect(
      await db
        .prepare('SELECT name FROM members WHERE pubkey = ?')
        .bind('p0')
        .first()
    ).toEqual({ name: 'Zed' });
    // the connection is usable again (no transaction left open)
    await db
      .prepare(
        'INSERT INTO members (pubkey, name, created_at) VALUES (?, ?, ?)'
      )
      .bind('p2', 'Cy', 'x')
      .run();
    expect(await count(db, 'members')).toBe(2);
  });
});

describe('makeD1 default schema', () => {
  it('applies every migration, including the telegram alert columns', async () => {
    const db = makeD1();
    await db
      .prepare(
        'INSERT INTO members (pubkey, name, created_at) VALUES (?, ?, ?)'
      )
      .bind('p1', 'Ann', 'x')
      .run();
    const m = (await db
      .prepare('SELECT telegram_chat_id, radar_alerts FROM members')
      .first()) as any;
    expect(m).toEqual({ telegram_chat_id: null, radar_alerts: 0 });
    expect(await count(db, 'telegram_link_codes')).toBe(0);
    expect(await count(db, 'events')).toBe(0);
  });
});
