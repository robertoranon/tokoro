// Same-band/same-day conflict detection (worker/SPECS.md 2.1).
import type { Env } from './index';

export interface ConflictEvent {
  id: string;
  act_url: string | null;
  start_time: string;
  end_time: string | null;
  lat: number;
  lng: number;
  venue_name: string | null;
}

/** What notices and the admin list show for one event. */
export interface ConflictEventRow {
  id: string;
  title: string;
  start_time: string;
  venue_name: string | null;
  address: string | null;
  url: string | null;
}

/** Two events closer than this in both axes (degrees) are the same place. */
export const SAME_PLACE_DEG = 0.005;

/** True when the end falls on a later day than the start. */
export function isRange(e: {
  start_time: string;
  end_time: string | null;
}): boolean {
  if (!e.end_time) return false;
  return e.end_time.slice(0, 10) > e.start_time.slice(0, 10);
}

/**
 * Single-linkage clusters of events within 0.005 degrees in both axes.
 * Events keep input order inside a cluster; clusters are ordered by first appearance.
 */
export function groupByPlace(events: ConflictEvent[]): ConflictEvent[][] {
  const parent = events.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      // epsilon guards against floating-point error at the exact tolerance
      if (
        Math.abs(events[i].lat - events[j].lat) <= SAME_PLACE_DEG + 1e-9 &&
        Math.abs(events[i].lng - events[j].lng) <= SAME_PLACE_DEG + 1e-9
      ) {
        const a = find(i),
          b = find(j);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
  const clusters = new Map<number, ConflictEvent[]>();
  events.forEach((e, i) => {
    const r = find(i);
    const c = clusters.get(r);
    if (c) c.push(e);
    else clusters.set(r, [e]);
  });
  return [...clusters.values()];
}

const norm = (u: string) => u.replace(/\/+$/, '');

/** Delete an event's conflict links and proposals (call on every event delete). */
export async function purgeConflictLinks(
  env: Pick<Env, 'DB'>,
  eventId: string
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM conflict_events WHERE event_id = ?').bind(
      eventId
    ),
    env.DB.prepare('DELETE FROM conflict_proposals WHERE event_id = ?').bind(
      eventId
    ),
  ]);
}

interface Row extends ConflictEvent, ConflictEventRow {}

/** Release events (held = 0); future ones that were held get alert_pending = 1. */
export function releaseStatements(
  env: Pick<Env, 'DB'>,
  ids: string[],
  conflictId: number
) {
  const today = new Date().toISOString().slice(0, 10);
  return ids.map(id =>
    env.DB.prepare(
      `UPDATE events SET
         alert_pending = CASE WHEN held = 1 AND substr(start_time,1,10) > ?
                              THEN 1 ELSE alert_pending END,
         held = 0
       WHERE id = ?
         AND NOT EXISTS (
           SELECT 1 FROM conflict_events ce JOIN conflicts c ON c.id = ce.conflict_id
           WHERE ce.event_id = events.id AND c.status = 'open' AND c.id <> ?)`
    ).bind(today, id, conflictId)
  );
}

/**
 * Bring the conflict state of one band-day in line with the events: hold
 * events that sit at two or more places, release them when that stops.
 */
export async function reevaluateConflicts(
  env: Pick<Env, 'DB'>,
  actUrl: string | null | undefined,
  day: string
): Promise<{
  created: {
    id: number;
    actName: string | null;
    day: string;
    events: ConflictEventRow[];
  } | null;
}> {
  if (!actUrl) return { created: null };
  const act = norm(actUrl);
  if (!act) return { created: null };
  const now = new Date().toISOString().slice(0, 19);

  const { results } = await env.DB.prepare(
    `SELECT id, act_url, act_name, title, start_time, end_time, lat, lng,
            venue_name, address, url
     FROM events
     WHERE RTRIM(act_url,'/') = ? AND substr(start_time,1,10) = ?
     ORDER BY start_time, id`
  )
    .bind(act, day)
    .all<Row & { act_name: string | null }>();
  const events = (results ?? []).filter(e => !isRange(e));
  const groups = groupByPlace(events);
  const conflicted = groups.length >= 2;
  const ids = events.map(e => e.id).sort();

  const open = await env.DB.prepare(
    "SELECT id FROM conflicts WHERE act_url = ? AND day = ? AND status = 'open'"
  )
    .bind(act, day)
    .first<{ id: number }>();
  const kept = (
    await env.DB.prepare(
      "SELECT id FROM conflicts WHERE act_url = ? AND day = ? AND status = 'kept'"
    )
      .bind(act, day)
      .all<{ id: number }>()
  ).results;
  const linked = async (cid: number): Promise<string[]> =>
    (
      await env.DB.prepare(
        'SELECT event_id FROM conflict_events WHERE conflict_id = ?'
      )
        .bind(cid)
        .all<{ event_id: string }>()
    ).results.map(r => r.event_id);

  const holdStmts = () =>
    ids.map(id =>
      env.DB.prepare(
        'UPDATE events SET held = 1, alert_pending = 0 WHERE id = ?'
      ).bind(id)
    );

  if (conflicted) {
    if (open) {
      const old = await linked(open.id);
      const removed = old.filter(id => !ids.includes(id));
      await env.DB.batch([
        env.DB.prepare(
          'DELETE FROM conflict_events WHERE conflict_id = ?'
        ).bind(open.id),
        ...ids.map(id =>
          env.DB.prepare(
            'INSERT OR IGNORE INTO conflict_events (conflict_id, event_id) VALUES (?, ?)'
          ).bind(open.id, id)
        ),
        ...holdStmts(),
        ...releaseStatements(env, removed, open.id),
      ]);
      return { created: null };
    }
    for (const k of kept) {
      const set = (await linked(k.id)).sort();
      if (set.length === ids.length && set.every((v, i) => v === ids[i])) {
        return { created: null };
      }
    }
    const actName = events.find(e => e.act_name)?.act_name ?? null;
    const res = await env.DB.batch([
      ...kept.map(k =>
        env.DB.prepare(
          "UPDATE conflicts SET status = 'resolved', resolved_at = ? WHERE id = ?"
        ).bind(now, k.id)
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO conflicts (act_url, day, status, created_at) VALUES (?, ?, 'open', ?)"
      ).bind(act, day, now),
      ...ids.map(id =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO conflict_events (conflict_id, event_id)
           SELECT id, ? FROM conflicts WHERE act_url = ? AND day = ? AND status = 'open'`
        ).bind(id, act, day)
      ),
      ...holdStmts(),
    ]);
    // The unique open-conflict index makes a lost race a no-op insert.
    const ins = res[kept.length];
    if (ins.meta.changes !== 1) return { created: null };
    const createdId = Number(ins.meta.last_row_id);
    return {
      created: {
        id: createdId,
        actName,
        day,
        events: events.map(e => ({
          id: e.id,
          title: e.title,
          start_time: e.start_time,
          venue_name: e.venue_name,
          address: e.address,
          url: e.url,
        })),
      },
    };
  }

  // fewer than two places: close the open conflict, and any kept one whose set changed
  const stmts = [];
  if (open) {
    const old = await linked(open.id);
    stmts.push(
      env.DB.prepare(
        "UPDATE conflicts SET status = 'resolved', resolved_at = ? WHERE id = ?"
      ).bind(now, open.id),
      ...releaseStatements(env, old, open.id)
    );
  }
  for (const k of kept) {
    const set = (await linked(k.id)).sort();
    if (!(set.length === ids.length && set.every((v, i) => v === ids[i]))) {
      stmts.push(
        env.DB.prepare(
          "UPDATE conflicts SET status = 'resolved', resolved_at = ? WHERE id = ?"
        ).bind(now, k.id)
      );
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { created: null };
}
