import type { NormalizedEvent } from '../types/event.js';
import { normalizeName } from './tour-shows.js';

export type TourOutcome =
  | 'published'
  | 'updated'
  | 'unchanged'
  | 'adopted' // a duplicate of another key's event, now attached to the band
  | 'duplicate' // a duplicate that could not be attached
  | 'failed';

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
  pubkey?: string;
}

// GET /events is bounded by start_time (default window from now), so the
// lookup must ask for everything explicitly.
const LOOKUP_FROM = '1970-01-01T00:00:00';
const LOOKUP_TO = '2999-12-31T23:59:59';

// ~500 m: absorbs geocoder jitter between runs; real moves are detected via
// coordinates only (LLM wording varies between runs and must not cause a PUT).
const COORD_TOLERANCE = 0.005;

const text = (v: string | null | undefined) => v ?? '';

/**
 * The existing show of the same band on the same local date. The lookup is
 * already scoped to one act_url and this crawler's pubkey. A changed start
 * time on the same day still matches (→ update).
 *
 * 1. At (roughly) the same place, when coordinates are known.
 * 2. Otherwise the same venue name (normalized) on that date, even if the
 *    stored coordinates are far away: that is a show that was geocoded to the
 *    wrong place earlier, and the update corrects it instead of duplicating it.
 */
export function matchShow(
  existing: ExistingShow[],
  startTime: string,
  lat: number | undefined,
  lng: number | undefined,
  venueName?: string
): ExistingShow | undefined {
  const day = startTime.slice(0, 10);
  const sameDay = existing.filter(e => e.start_time.slice(0, 10) === day);

  if (lat !== undefined && lng !== undefined) {
    let best: ExistingShow | undefined;
    let bestDist = Infinity;
    for (const e of sameDay) {
      const dLat = Math.abs(e.lat - lat);
      const dLng = Math.abs(e.lng - lng);
      if (dLat > COORD_TOLERANCE || dLng > COORD_TOLERANCE) continue;
      const dist = dLat + dLng;
      if (dist < bestDist) {
        best = e;
        bestDist = dist;
      }
    }
    if (best) return best;
  }

  const venue = normalizeName(venueName ?? '');
  if (venue === '') return undefined;
  const sameVenue = sameDay.filter(
    e => normalizeName(e.venue_name ?? '') === venue
  );
  if (sameVenue.length <= 1 || lat === undefined || lng === undefined) {
    return sameVenue[0];
  }
  return sameVenue.reduce((a, b) =>
    Math.abs(a.lat - lat) + Math.abs(a.lng - lng) <=
    Math.abs(b.lat - lat) + Math.abs(b.lng - lng)
      ? a
      : b
  );
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

export type AdoptSigner = (
  eventId: string,
  actName: string,
  actUrl: string
) => Promise<string>;

export class TourPublisher {
  constructor(
    private apiUrl: string,
    private pubkey: string,
    private fetchFn: typeof fetch = fetch,
    private signAdopt?: AdoptSigner
  ) {}

  /**
   * Every show of one act (any date), whichever key published it, so events
   * adopted from other keys are recognised. The no-geo browse path answers
   * `{ events, has_more }`, 100 per page.
   */
  async lookup(actUrl: string): Promise<ExistingShow[]> {
    const all: ExistingShow[] = [];
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({
        act_url: actUrl,
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
      all.push(...(data.events as ExistingShow[]));
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
    const body = await res.text().catch(() => '');
    if (res.status === 409) {
      const adopted = await this.adoptDuplicate(body, event);
      if (adopted) return adopted;
    }
    this.logError(res.status, event, body);
    return 'failed';
  }

  /**
   * The worker judged this show a duplicate of an existing event, usually one
   * published by another key (so it cannot be updated). Attach the band to it
   * so it appears under the band; null when this is not an adoptable 409.
   */
  private async adoptDuplicate(
    body: string,
    event: NormalizedEvent
  ): Promise<TourOutcome | null> {
    let existingId: unknown;
    try {
      existingId = JSON.parse(body)?.existing_event_id;
    } catch {
      return null;
    }
    if (
      typeof existingId !== 'string' ||
      !existingId ||
      !this.signAdopt ||
      !event.act_name ||
      !event.act_url
    ) {
      return null;
    }
    try {
      const signature = await this.signAdopt(
        existingId,
        event.act_name,
        event.act_url
      );
      const res = await this.fetchFn(
        `${this.apiUrl}/events/${existingId}/act`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pubkey: this.pubkey,
            act_name: event.act_name,
            act_url: event.act_url,
            signature,
          }),
        }
      );
      if (res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          adopted?: boolean;
        };
        if (json.adopted) {
          console.log(
            `⛓ Linked to existing event ${existingId}: ${event.title}`
          );
          return 'adopted';
        }
        console.log(`= Already linked (event ${existingId}): ${event.title}`);
        return 'unchanged';
      }
      console.log(
        `= Duplicate of event ${existingId}, which could not be linked (HTTP ${res.status}): ${event.title}`
      );
      return 'duplicate';
    } catch (error) {
      console.log(
        `= Duplicate of event ${existingId}, which could not be linked (${error instanceof Error ? error.message : error}): ${event.title}`
      );
      return 'duplicate';
    }
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
    this.logError(res.status, event, await res.text().catch(() => ''));
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

  private logError(status: number, event: NormalizedEvent, body: string): void {
    const hint =
      status === 401 || status === 403
        ? ' — signing or identity bug: check CRAWLER_PRIVKEY / CRAWLER_PUBKEY'
        : status === 409
          ? ' — duplicate of an existing event that could not be linked to this band'
          : '';
    console.error(`API error (${status})${hint}: ${event.title}: ${body}`);
  }
}
