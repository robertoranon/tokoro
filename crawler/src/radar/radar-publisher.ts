import type { NormalizedEvent } from '../types/event.js';

export type RadarOutcome =
  | 'published'
  | 'updated'
  | 'unchanged'
  | 'skipped_no_dates'
  | 'failed';

/** An event as returned by GET /events (nulls for empty columns, tags parsed). */
export interface ExistingEntry {
  id: string;
  title: string;
  description?: string | null;
  url?: string | null;
  venue_name?: string | null;
  address?: string | null;
  lat: number;
  lng: number;
  start_time: string;
  end_time?: string | null;
  category: string;
  tags: string[];
  festival_name?: string | null;
  festival_url?: string | null;
  created_at: string;
}

/** Same edition even if the dates shifted; a next-year edition (~365 d) is not. */
export const EDITION_WINDOW_DAYS = 240;
const DAY_MS = 24 * 60 * 60 * 1000;

// The pubkey-only GET path is bounded by start_time (default: now → +7 days),
// so the lookup must ask for everything explicitly.
const LOOKUP_FROM = '1970-01-01T00:00:00';
const LOOKUP_TO = '2999-12-31T23:59:59';

// ~50 m: absorbs geocoder jitter between weekly runs so it never causes a PUT.
const COORD_TOLERANCE = 0.0005;

/**
 * Festival-mode program events carry the same pubkey and festival_url as a
 * radar entry. Only entries that look like radar entries may ever be matched
 * (and therefore overwritten): the 'festival' tag plus the radar date shape
 * that finalizeRadarEntry always produces (start T00:00:00, end T23:59:59).
 * A free-form LLM 'festival' tag on a concert must not be enough.
 */
function isRadarEntry(e: ExistingEntry): boolean {
  return (
    !!e.end_time &&
    e.start_time.endsWith('T00:00:00') &&
    e.end_time.endsWith('T23:59:59') &&
    (e.tags ?? []).includes('festival')
  );
}

const asMs = (localIso: string) => Date.parse(`${localIso.slice(0, 19)}Z`);

/** The existing radar entry for the same edition: closest start_time within the window. */
export function matchEdition(
  existing: ExistingEntry[],
  startTime: string
): ExistingEntry | undefined {
  const target = asMs(startTime);
  let best: ExistingEntry | undefined;
  let bestGap = Infinity;
  for (const e of existing) {
    if (!isRadarEntry(e)) continue;
    const gap = Math.abs(asMs(e.start_time) - target);
    if (gap <= EDITION_WINDOW_DAYS * DAY_MS && gap < bestGap) {
      best = e;
      bestGap = gap;
    }
  }
  return best;
}

const text = (v: string | null | undefined) => v ?? '';

/** True if publishing `next` over `existing` would change anything visible. */
export function differs(
  existing: ExistingEntry,
  next: NormalizedEvent
): boolean {
  const tags = (t: string[] | undefined) =>
    [...(t ?? [])].sort().join('\u0000');
  return !(
    existing.title === next.title &&
    text(existing.description) === text(next.description) &&
    text(existing.url) === text(next.url) &&
    text(existing.venue_name) === text(next.venue_name) &&
    text(existing.address) === text(next.address) &&
    Math.abs(existing.lat - next.lat) <= COORD_TOLERANCE &&
    Math.abs(existing.lng - next.lng) <= COORD_TOLERANCE &&
    existing.start_time === next.start_time &&
    text(existing.end_time) === text(next.end_time) &&
    existing.category === next.category &&
    text(existing.festival_name) === text(next.festival_name) &&
    tags(existing.tags) === tags(next.tags)
  );
}

export class RadarPublisher {
  constructor(
    private apiUrl: string,
    private pubkey: string,
    private fetchFn: typeof fetch = fetch
  ) {}

  /** All of this crawler's events for one festival_url (any date). */
  async lookup(festivalUrl: string): Promise<ExistingEntry[]> {
    const params = new URLSearchParams({
      pubkey: this.pubkey,
      festival_url: festivalUrl,
      from: LOOKUP_FROM,
      to: LOOKUP_TO,
    });
    const res = await this.fetchFn(`${this.apiUrl}/events?${params}`);
    if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
    const data: unknown = await res.json();
    if (!Array.isArray(data)) {
      throw new Error(
        'Lookup returned an unexpected shape (expected an array)'
      );
    }
    return data as ExistingEntry[];
  }

  /**
   * Publish, update or leave alone. `event` must already be signed; for an
   * update it must have been normalized with `createdAt: match.created_at`.
   */
  async apply(
    event: NormalizedEvent,
    match: ExistingEntry | undefined
  ): Promise<RadarOutcome> {
    if (!match) return this.post(event);
    if (!differs(match, event)) {
      console.log(`= Unchanged: ${event.title}`);
      return 'unchanged';
    }
    return this.put(match.id, event);
  }

  private async post(event: NormalizedEvent): Promise<RadarOutcome> {
    const res = await this.send('POST', '/events', event);
    if (!res) return 'failed';
    if (res.ok) {
      console.log(`✓ Published: ${event.title}`);
      return 'published';
    }
    await this.logError(res, event);
    return 'failed';
  }

  private async put(id: string, event: NormalizedEvent): Promise<RadarOutcome> {
    const res = await this.send('PUT', `/events/${id}`, event);
    if (!res) return 'failed';
    if (res.ok) {
      console.log(`↻ Updated: ${event.title} (ID: ${id})`);
      return 'updated';
    }
    if (res.status === 404) {
      console.log(`Entry ${id} vanished before the update — publishing as new`);
      return this.post(event);
    }
    await this.logError(res, event);
    return 'failed';
  }

  private async send(
    method: 'POST' | 'PUT',
    path: string,
    event: NormalizedEvent
  ): Promise<Response | null> {
    try {
      return await this.fetchFn(`${this.apiUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
    } catch (error) {
      console.error(`Network error (${method} ${path}):`, error);
      return null;
    }
  }

  private async logError(res: Response, event: NormalizedEvent): Promise<void> {
    const body = await res.text().catch(() => '');
    const hint =
      res.status === 401 || res.status === 403
        ? ' — signing or identity bug: check CRAWLER_PRIVKEY / CRAWLER_PUBKEY'
        : res.status === 409
          ? ' — duplicate of an existing event that is not this crawler’s radar entry'
          : '';
    console.error(`API error (${res.status})${hint}: ${event.title}: ${body}`);
  }
}
