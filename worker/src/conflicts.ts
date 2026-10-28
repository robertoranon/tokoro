// Pure helpers for same-band/same-day conflict detection (worker/SPECS.md 2.1).

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
const SAME_PLACE_DEG = 0.005;

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
