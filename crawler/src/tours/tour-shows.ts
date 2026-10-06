import { z } from 'zod';
import type { ExtractedEvent } from '../types/event.js';
import type { BandConfig, Region } from './bands-config.js';

/** One show as the LLM reports it (a single concert on a single date). */
export const TourShowDraftSchema = z.object({
  title: z.string().min(1),
  performers: z.array(z.string()),
  start_time: z.string(),
  end_time: z.string().optional(),
  description: z.string().optional(),
  url: z.string().url().optional(),
  venue_name: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  tags: z.array(z.string()).optional(),
});
export type TourShowDraft = z.infer<typeof TourShowDraftSchema>;

const MAX_SHOWS = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/** First 10 chars are a real calendar date (rejects 2030-02-31). */
function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = s.slice(0, 10);
  const date = new Date(`${d}T12:00:00Z`);
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === d;
}

/**
 * "2030-11-12" → "2030-11-12T00:00:00"; "2030-11-12 21:00" / "…T21:00Z" →
 * "2030-11-12T21:00:00". Local time is kept as written (no zone conversion).
 * undefined when it is not a real date.
 */
export function toLocalDateTime(raw: string): string | undefined {
  const s = raw
    .trim()
    .replace(' ', 'T')
    .replace(/(Z|[+-]\d{2}:\d{2})$/, '');
  if (!isRealDate(s)) return undefined;
  const date = s.slice(0, 10);
  const m = s.slice(10).match(/^T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return `${date}T00:00:00`;
  const [, hh, mm, ss] = m;
  if (Number(hh) > 23 || Number(mm) > 59) return `${date}T00:00:00`;
  return `${date}T${hh}:${mm}:${ss ?? '00'}`;
}

/** A show before today (local date of the venue) is past; today is not. */
export function isPastShow(startTime: string, todayISO: string): boolean {
  return startTime.slice(0, 10) < todayISO;
}

export function inRegion(
  lat: number,
  lng: number,
  region: Region | undefined
): boolean {
  if (!region) return true;
  return (
    lat >= region.south &&
    lat <= region.north &&
    lng >= region.west &&
    lng <= region.east
  );
}

/** Lowercase, accents stripped, punctuation → space, whitespace collapsed. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The registry band whose name or alias equals one of the performers
 * (normalized, whole-name equality — never substring). First band wins.
 */
export function matchBand(
  performers: string[],
  bands: BandConfig[]
): BandConfig | undefined {
  const bill = new Set(performers.map(normalizeName).filter(n => n !== ''));
  if (bill.size === 0) return undefined;
  for (const band of bands) {
    const names = [band.name, ...(band.aliases ?? [])].map(normalizeName);
    if (names.some(n => n !== '' && bill.has(n))) return band;
  }
  return undefined;
}

const asList = (v: unknown): unknown[] =>
  typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v : [];

function cleanStrings(v: unknown): string[] {
  return asList(v)
    .filter((x): x is string => typeof x === 'string')
    .map(x => x.trim())
    .filter(x => x !== '');
}

/** Coerce/drop malformed fields so one bad value cannot sink a good show. */
function cleanShow(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c: Record<string, unknown> = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      ([, v]) => v !== null && v !== ''
    )
  );
  c.performers = cleanStrings(c.performers);
  if (c.tags !== undefined) {
    const tags = cleanStrings(c.tags);
    if (tags.length) c.tags = tags;
    else delete c.tags;
  }
  if (c.url !== undefined) {
    try {
      new URL(String(c.url));
    } catch {
      delete c.url;
    }
  }
  for (const [key, min, max] of [
    ['lat', -90, 90],
    ['lng', -180, 180],
  ] as const) {
    if (c[key] === undefined) continue;
    const n = typeof c[key] === 'number' ? (c[key] as number) : Number(c[key]);
    if (isNaN(n) || n < min || n > max) delete c[key];
    else c[key] = n;
  }
  for (const key of ['start_time', 'end_time']) {
    if (typeof c[key] === 'number') c[key] = String(c[key]);
  }
  if (typeof c.start_time !== 'string') return null;
  const start = toLocalDateTime(c.start_time);
  if (!start) return null;
  c.start_time = start;
  if (typeof c.end_time === 'string') {
    const end = toLocalDateTime(c.end_time);
    if (end) c.end_time = end;
    else delete c.end_time;
  }
  return c;
}

/**
 * Accepts {"shows": [...]}, a bare array, or a single wrapper key around
 * either. Invalid shows are dropped one by one; never throws.
 */
export function parseTourShows(raw: unknown, pageUrl: string): TourShowDraft[] {
  let list: unknown = raw;
  if (list && typeof list === 'object' && !Array.isArray(list)) {
    const obj = list as Record<string, unknown>;
    list = Array.isArray(obj.shows)
      ? obj.shows
      : Object.keys(obj).length === 1
        ? Object.values(obj)[0]
        : undefined;
  }
  if (!Array.isArray(list)) return [];

  const shows: TourShowDraft[] = [];
  for (const item of list.slice(0, MAX_SHOWS)) {
    const cleaned = cleanShow(item);
    if (!cleaned) continue;
    const parsed = TourShowDraftSchema.safeParse(cleaned);
    if (!parsed.success) {
      console.warn(
        `  ⚠ Show failed validation: ${parsed.error.issues
          .map(i => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`
      );
      continue;
    }
    shows.push(parsed.data);
  }
  return shows;
}

const BAND_TOUR_TAG = 'band-tour';

/** Apply the tour show conventions (spec §2.3) to a draft for a known band. */
export function finalizeTourShow(
  d: TourShowDraft,
  band: BandConfig,
  pageUrl: string
): ExtractedEvent {
  const bandKey = normalizeName(band.name);
  const tags = [
    ...new Set([
      ...(d.tags ?? []).map(t => t.trim().toLowerCase()).filter(t => t !== ''),
      BAND_TOUR_TAG,
    ]),
  ].filter(t => normalizeName(t) !== bandKey);

  // Geocoding works best with "street, city"; add the city when the address
  // does not already mention it.
  let address = d.address?.trim() || undefined;
  const city = d.city?.trim();
  if (city) {
    if (!address) address = city;
    else if (!normalizeName(address).includes(normalizeName(city))) {
      address = `${address}, ${city}`;
    }
  }

  const support = d.performers.filter(p => normalizeName(p) !== bandKey);
  const description =
    d.description?.trim() ||
    (support.length ? `With ${support.join(', ')}.` : undefined);

  const { performers: _p, city: _c, ...rest } = d;
  return {
    ...rest,
    ...(address !== undefined ? { address } : {}),
    ...(description !== undefined ? { description } : {}),
    start_time: toLocalDateTime(d.start_time) ?? d.start_time,
    category: 'music',
    tags,
    url: d.url ?? pageUrl,
    act_name: band.name,
    act_url: band.url,
  };
}
