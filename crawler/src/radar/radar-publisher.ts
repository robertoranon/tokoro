import type { NormalizedEvent } from '../types/event.js';

export type RadarOutcome =
  | 'published'
  | 'updated'
  | 'unchanged'
  | 'skipped_no_dates'
  | 'skipped_series'
  | 'failed';

/** An event as returned by GET /events (nulls for empty columns, tags parsed). */
export interface ExistingEntry {
  id: string;
  pubkey?: string;
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

// ~500 m: a move within a town is not a radar-level change; absorbs geocoder
// jitter between weekly runs. Real moves are detected via coordinates only.
const COORD_TOLERANCE = 0.005;

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

/**
 * The existing radar entry for the same edition: closest start_time within
 * the window. An entry held by `ownPubkey` wins over other keys' entries
 * (only our own can be updated); another key's entry still matches when we
 * have none, so the edition is not posted a second time.
 */
export function matchEdition(
  existing: ExistingEntry[],
  startTime: string,
  ownPubkey?: string
): ExistingEntry | undefined {
  const target = asMs(startTime);
  let best: ExistingEntry | undefined;
  let bestRank = Infinity;
  for (const e of existing) {
    if (!isRadarEntry(e)) continue;
    const gap = Math.abs(asMs(e.start_time) - target);
    if (gap > EDITION_WINDOW_DAYS * DAY_MS) continue;
    const foreign = !!ownPubkey && !!e.pubkey && e.pubkey !== ownPubkey;
    const rank = (foreign ? EDITION_WINDOW_DAYS * DAY_MS + 1 : 0) + gap;
    if (rank < bestRank) {
      best = e;
      bestRank = rank;
    }
  }
  return best;
}

const text = (v: string | null | undefined) => v ?? '';

/**
 * True only for changes that matter to the radar: dates, category, a real
 * move (coordinates), or filling a previously empty description. LLM output
 * varies between runs (titles, blurbs, venue/address text, tags), so wording
 * differences never trigger a PUT; when a PUT happens the whole event is sent.
 */
export function differs(
  existing: ExistingEntry,
  next: NormalizedEvent
): boolean {
  return (
    existing.start_time !== next.start_time ||
    text(existing.end_time) !== text(next.end_time) ||
    existing.category !== next.category ||
    Math.abs(existing.lat - next.lat) > COORD_TOLERANCE ||
    Math.abs(existing.lng - next.lng) > COORD_TOLERANCE ||
    (text(existing.description) === '' && text(next.description) !== '')
  );
}

export class RadarPublisher {
  constructor(
    private apiUrl: string,
    private pubkey: string,
    private fetchFn: typeof fetch = fetch
  ) {}

  /**
   * Every event for one festival_url (any date), whichever key published it,
   * so entries published under a previous crawler key are still recognised.
   * The no-geo browse path answers `{ events, has_more }`, 100 per page.
   */
  async lookup(festivalUrl: string): Promise<ExistingEntry[]> {
    const all: ExistingEntry[] = [];
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({
        festival_url: festivalUrl,
        from: LOOKUP_FROM,
        to: LOOKUP_TO,
        offset: String(offset),
      });
      const res = await this.fetchFn(`${this.apiUrl}/events?${params}`);
      if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
      const data = (await res.json()) as {
        events?: unknown;
        has_more?: boolean;
      };
      if (!data || !Array.isArray(data.events)) {
        throw new Error(
          'Lookup returned an unexpected shape (expected { events: [...] })'
        );
      }
      all.push(...(data.events as ExistingEntry[]));
      if (!data.has_more || data.events.length === 0) return all;
      offset += data.events.length;
    }
    return all;
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
    // Held by another key (e.g. a previous crawler key): it counts as the
    // edition, but it is not ours to update, and posting again duplicates it.
    if (match.pubkey && match.pubkey !== this.pubkey) {
      console.log(
        `= Already in the database under another key: ${event.title}`
      );
      return 'unchanged';
    }
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
