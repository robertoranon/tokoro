import type { NormalizedEvent } from '../types/event.js';

export type TourOutcome = 'published' | 'updated' | 'unchanged' | 'failed';

/** An event as returned by GET /events (nulls for empty columns, tags parsed). */
export interface ExistingShow {
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
  act_name?: string | null;
  act_url?: string | null;
  created_at: string;
}

// The pubkey-only GET path is bounded by start_time (default: now → +7 days),
// so the lookup must ask for everything explicitly.
const LOOKUP_FROM = '1970-01-01T00:00:00';
const LOOKUP_TO = '2999-12-31T23:59:59';

// ~500 m: absorbs geocoder jitter between runs; real moves are detected via
// coordinates only (LLM wording varies between runs and must not cause a PUT).
const COORD_TOLERANCE = 0.005;

const text = (v: string | null | undefined) => v ?? '';

/**
 * The existing show of the same band on the same local date at (roughly) the
 * same place. The lookup is already scoped to one act_url and this crawler's
 * pubkey. A changed start time on the same day still matches (→ update).
 */
export function matchShow(
  existing: ExistingShow[],
  startTime: string,
  lat: number,
  lng: number
): ExistingShow | undefined {
  const day = startTime.slice(0, 10);
  let best: ExistingShow | undefined;
  let bestDist = Infinity;
  for (const e of existing) {
    if (e.start_time.slice(0, 10) !== day) continue;
    const dLat = Math.abs(e.lat - lat);
    const dLng = Math.abs(e.lng - lng);
    if (dLat > COORD_TOLERANCE || dLng > COORD_TOLERANCE) continue;
    const dist = dLat + dLng;
    if (dist < bestDist) {
      best = e;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * True only for changes that matter: start/end time, a real move (coordinates),
 * or filling a previously empty description or url. A known end_time is never
 * erased by a run that did not find one. When a PUT happens the whole event is
 * sent, so all fields are refreshed.
 */
export function differs(
  existing: ExistingShow,
  next: NormalizedEvent
): boolean {
  return (
    existing.start_time !== next.start_time ||
    (text(next.end_time) !== '' &&
      text(existing.end_time) !== text(next.end_time)) ||
    Math.abs(existing.lat - next.lat) > COORD_TOLERANCE ||
    Math.abs(existing.lng - next.lng) > COORD_TOLERANCE ||
    (text(existing.description) === '' && text(next.description) !== '') ||
    (text(existing.url) === '' && text(next.url) !== '')
  );
}

export class TourPublisher {
  constructor(
    private apiUrl: string,
    private pubkey: string,
    private fetchFn: typeof fetch = fetch
  ) {}

  /** All of this crawler's shows for one act_url (any date). */
  async lookup(actUrl: string): Promise<ExistingShow[]> {
    const params = new URLSearchParams({
      pubkey: this.pubkey,
      act_url: actUrl,
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
    return data as ExistingShow[];
  }

  /**
   * Publish, update or leave alone. `event` must already be signed; for an
   * update it must have been normalized with `createdAt: match.created_at`.
   */
  async apply(
    event: NormalizedEvent,
    match: ExistingShow | undefined
  ): Promise<TourOutcome> {
    if (!match) return this.post(event);
    if (!differs(match, event)) {
      console.log(`= Unchanged: ${event.title}`);
      return 'unchanged';
    }
    return this.put(match.id, event);
  }

  private async post(event: NormalizedEvent): Promise<TourOutcome> {
    const res = await this.send('POST', '/events', event);
    if (!res) return 'failed';
    if (res.ok) {
      console.log(`✓ Published: ${event.title}`);
      return 'published';
    }
    await this.logError(res, event);
    return 'failed';
  }

  private async put(id: string, event: NormalizedEvent): Promise<TourOutcome> {
    const res = await this.send('PUT', `/events/${id}`, event);
    if (!res) return 'failed';
    if (res.ok) {
      console.log(`↻ Updated: ${event.title} (ID: ${id})`);
      return 'updated';
    }
    if (res.status === 404) {
      console.log(`Show ${id} vanished before the update — publishing as new`);
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
          ? ' — duplicate of an existing event that is not this crawler’s show'
          : '';
    console.error(`API error (${res.status})${hint}: ${event.title}: ${body}`);
  }
}
