import { z } from 'zod';
import {
  ExtractedEvent,
  ExtractedEventSchema,
  FetchedPage,
} from '../types/event.js';
import { correctEventYear } from '../../../shared/extractors/year-inference.js';

/**
 * What the LLM returns for a festival homepage. Same fields as an extracted
 * event, except dates may be missing (the homepage might not show them) and a
 * missing category falls back to 'other'.
 */
export const FestivalEntryDraftSchema = ExtractedEventSchema.extend({
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  category: ExtractedEventSchema.shape.category.default('other'),
  /** Distinct days (YYYY-MM-DD) on which programmed events take place, when the
   *  page lists a day-by-day program. Used only by the series guard. */
  event_days: z.array(z.string()).optional(),
  /** Other towns/villages/venues where the festival also takes place (not the
   *  principal site). Folded into the description by finalizeRadarEntry. */
  other_places: z.array(z.string()).optional(),
});
export type FestivalEntryDraft = z.infer<typeof FestivalEntryDraftSchema>;
export type DatedDraft = FestivalEntryDraft & {
  start_time: string;
  end_time: string;
};

const RADAR_CATEGORIES: string[] = ['music', 'art', 'theater', 'other'];

const MAX_EVENT_DAYS = 120;
const MAX_OTHER_PLACES = 6;
const MAX_PLACE_LENGTH = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/** First 10 chars are a real calendar date (rejects 2026-02-31, 2026-13-45). */
function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = s.slice(0, 10);
  const date = new Date(`${d}T12:00:00Z`);
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === d;
}

/** Drop or coerce malformed OPTIONAL fields so they cannot sink a good entry. */
function sanitizeOptionalFields(c: Record<string, unknown>): void {
  delete c.festival_url;
  delete c.start_time_utc;
  delete c.end_time_utc;

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
  if (c.tags !== undefined) {
    const list =
      typeof c.tags === 'string'
        ? c.tags.split(',')
        : Array.isArray(c.tags)
          ? c.tags
          : [];
    const tags = list
      .filter((t): t is string => typeof t === 'string')
      .map(t => t.trim())
      .filter(t => t !== '');
    if (tags.length) c.tags = tags;
    else delete c.tags;
  }
  if (c.event_days !== undefined) {
    const list =
      typeof c.event_days === 'string'
        ? c.event_days.split(',')
        : Array.isArray(c.event_days)
          ? c.event_days
          : [];
    const days = [
      ...new Set(
        list
          .filter((d): d is string => typeof d === 'string')
          .map(d => d.trim())
          .filter(d => isRealDate(d))
          .map(d => d.slice(0, 10))
      ),
    ]
      .sort()
      .slice(0, MAX_EVENT_DAYS);
    if (days.length) c.event_days = days;
    else delete c.event_days;
  }
  if (c.other_places !== undefined) {
    const list =
      typeof c.other_places === 'string'
        ? c.other_places.split(',')
        : Array.isArray(c.other_places)
          ? c.other_places
          : [];
    const seen = new Set<string>();
    const places: string[] = [];
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const place = item.trim();
      if (!place || place.length > MAX_PLACE_LENGTH) continue;
      const key = place.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      places.push(place);
    }
    if (places.length) c.other_places = places.slice(0, MAX_OTHER_PLACES);
    else delete c.other_places;
  }
  for (const key of ['start_time', 'end_time']) {
    if (typeof c[key] === 'number') c[key] = String(c[key]);
  }
}

export function parseFestivalEntry(
  raw: unknown,
  pageUrl: string
): FestivalEntryDraft | null {
  let candidate = Array.isArray(raw) ? raw[0] : raw;
  if (!candidate || typeof candidate !== 'object') return null;

  // Unwrap a single-key wrapper such as {"festival": {...}}.
  const keys = Object.keys(candidate);
  if (keys.length === 1 && !(keys[0] in FestivalEntryDraftSchema.shape)) {
    const inner = (candidate as Record<string, unknown>)[keys[0]];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      candidate = inner;
    }
  }

  // LLMs return null / '' for "unknown"; the schema wants the key absent.
  const cleaned: Record<string, unknown> = Object.fromEntries(
    Object.entries(candidate as Record<string, unknown>).filter(
      ([, v]) => v !== null && v !== ''
    )
  );
  sanitizeOptionalFields(cleaned);
  if (
    cleaned.category !== undefined &&
    !RADAR_CATEGORIES.includes(cleaned.category as string)
  ) {
    cleaned.category = 'other';
  }
  if (!cleaned.url) cleaned.url = pageUrl;

  const parsed = FestivalEntryDraftSchema.safeParse(cleaned);
  if (!parsed.success) {
    console.warn(
      `  ⚠ Festival entry failed validation: ${parsed.error.issues
        .map(i => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`
    );
    return null;
  }
  return parsed.data;
}

/** True when both dates are present, ISO-shaped and in order. */
export function hasDates(d: FestivalEntryDraft | null): d is DatedDraft {
  return (
    !!d &&
    !!d.start_time &&
    !!d.end_time &&
    isRealDate(d.start_time) &&
    isRealDate(d.end_time) &&
    d.end_time.slice(0, 10) >= d.start_time.slice(0, 10)
  );
}

/** Radar convention: first day at T00:00:00, last day at T23:59:59. */
export function normalizeRadarDates(d: FestivalEntryDraft): FestivalEntryDraft {
  if (
    !d.start_time ||
    !d.end_time ||
    !isRealDate(d.start_time) ||
    !isRealDate(d.end_time)
  ) {
    return d;
  }
  return {
    ...d,
    start_time: `${d.start_time.slice(0, 10)}T00:00:00`,
    end_time: `${d.end_time.slice(0, 10)}T23:59:59`,
  };
}

/**
 * Validate the year with `day_name` (same rules as the regular extractor).
 * If the day name is unresolvable the dates are stripped — the entry is kept
 * so the caller can still look for dates on an info page.
 */
export function applyYearCorrection(d: FestivalEntryDraft): FestivalEntryDraft {
  if (!d.start_time) {
    const { day_name: _dayName, ...rest } = d;
    return rest;
  }
  const fixed = correctEventYear(
    d as ExtractedEvent
  ) as FestivalEntryDraft | null;
  if (fixed) {
    // Keep event_days in step with a year shift of the dates.
    const yearShift =
      Number(String(fixed.start_time).slice(0, 4)) -
      Number(d.start_time.slice(0, 4));
    if (fixed.event_days && yearShift !== 0) {
      const days = fixed.event_days
        .map(day => `${Number(day.slice(0, 4)) + yearShift}${day.slice(4)}`)
        .filter(isRealDate); // e.g. a leap day has no counterpart
      if (days.length) fixed.event_days = days;
      else delete fixed.event_days;
    }
    return fixed;
  }
  const {
    day_name: _dayName,
    start_time: _s,
    end_time: _e,
    event_days: _days,
    ...rest
  } = d;
  return rest;
}

function isEmpty(key: string, value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return key === 'category' && value === 'other';
}

/**
 * Fill missing fields of `base` from `extra`; never overwrite. Dates travel as
 * a pair so start and end can never come from different pages.
 */
export function mergeEntries(
  base: FestivalEntryDraft | null,
  extra: FestivalEntryDraft | null
): FestivalEntryDraft | null {
  if (!base) return extra;
  if (!extra) return base;

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    // event_days describes the date range, so it travels with the date pair.
    if (key === 'start_time' || key === 'end_time' || key === 'event_days')
      continue;
    if (isEmpty(key, merged[key]) && !isEmpty(key, value)) merged[key] = value;
  }
  if (!hasDates(base) && hasDates(extra)) {
    merged.start_time = extra.start_time;
    merged.end_time = extra.end_time;
    if (extra.event_days) merged.event_days = extra.event_days;
    else delete merged.event_days;
  }
  return merged as FestivalEntryDraft;
}

/** Largest allowed gap (days) between consecutive event days of one festival. */
export const SERIES_MAX_GAP_DAYS = 7;

export interface EventDaysAnalysis {
  isSeries: boolean;
  days: number;
  firstDay?: string;
  lastDay?: string;
  maxGap: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * Series guard: the listed event days (inside the entry's date range) must
 * form one continuous block. A gap above `maxGapDays` between consecutive
 * distinct days means separate events spread over time, not one festival.
 */
export function analyzeEventDays(
  draft: DatedDraft,
  maxGapDays = SERIES_MAX_GAP_DAYS
): EventDaysAnalysis {
  const start = draft.start_time.slice(0, 10);
  const end = draft.end_time.slice(0, 10);
  const days = [...new Set(draft.event_days ?? [])]
    .filter(d => d >= start && d <= end)
    .sort();
  if (days.length < 2) {
    return { isSeries: false, days: days.length, maxGap: 0 };
  }
  let maxGap = 0;
  for (let i = 1; i < days.length; i++) {
    const gap = Math.round(
      (Date.parse(`${days[i]}T00:00:00Z`) -
        Date.parse(`${days[i - 1]}T00:00:00Z`)) /
        MS_PER_DAY
    );
    if (gap > maxGap) maxGap = gap;
  }
  return {
    isSeries: maxGap > maxGapDays,
    days: days.length,
    firstDay: days[0],
    lastDay: days[days.length - 1],
    maxGap,
  };
}

/** A festival that ended before today is off the radar; one running now stays. */
export function isPastEntry(d: DatedDraft, todayISO: string): boolean {
  return d.end_time.slice(0, 10) < todayISO;
}

const EDITION_SUFFIX =
  /\s*[-–—,]?\s*(?:19|20)\d{2}(?:\s*[/–-]\s*(?:\d{2}|\d{4}))?\s*$/;

/** "Terraforma 2026" → "Terraforma". Never returns an empty string. */
export function stripEdition(name: string): string {
  const stripped = name.replace(EDITION_SUFFIX, '').trim();
  return stripped || name;
}

/** Lowercase, accents stripped, whitespace collapsed. */
function normalizePlace(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Description plus "Also takes place in: A, B." for the places not already
 * mentioned in it or covered by the principal site (venue_name / address).
 */
function appendOtherPlaces(
  d: { description?: string; venue_name?: string; address?: string },
  places: string[] | undefined
): string | undefined {
  const description = d.description?.trim();
  if (!places?.length) return d.description;
  const text = normalizePlace(description ?? '');
  const venue = normalizePlace(d.venue_name ?? '');
  const segments = (d.address ?? '').split(',').map(normalizePlace);
  const fresh = places.filter(p => {
    const norm = normalizePlace(p);
    if (!norm || norm === venue || segments.includes(norm)) return false;
    const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(
      `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
      'u'
    ).test(text);
  });
  if (!fresh.length) return d.description;
  const sentence = `Also takes place in: ${fresh.join(', ')}.`;
  return description ? `${description} ${sentence}` : sentence;
}

/** Apply the radar entry conventions (spec §1) to a dated draft. */
export function finalizeRadarEntry(
  d: DatedDraft,
  festivalUrl: string
): ExtractedEvent {
  const { event_days: _eventDays, other_places: otherPlaces, ...rest } = d;
  const description = appendOtherPlaces(d, otherPlaces);
  const tags = [
    ...new Set([
      ...(d.tags ?? []).map(t => t.trim().toLowerCase()).filter(t => t !== ''),
      'festival',
    ]),
  ];
  return {
    ...rest,
    ...(description !== undefined ? { description } : {}),
    url: d.url ?? festivalUrl,
    festival_name: stripEdition(d.festival_name || d.title),
    festival_url: festivalUrl,
    tags,
  };
}

export const MAX_INFO_PAGES = 2;

export interface EntryResolverDeps {
  extract: (page: FetchedPage) => Promise<FestivalEntryDraft | null>;
  discoverInfoPages: (home: FetchedPage) => Promise<string[]>;
  fetchPage: (url: string) => Promise<FetchedPage>;
}

/**
 * Homepage first; if it shows no dates, look at up to MAX_INFO_PAGES
 * info/edition pages and merge what they add (spec §2).
 */
export async function resolveEntryDraft(
  home: FetchedPage,
  deps: EntryResolverDeps
): Promise<FestivalEntryDraft | null> {
  let draft = await deps.extract(home);
  if (hasDates(draft)) return draft;

  const infoUrls = (await deps.discoverInfoPages(home)).slice(
    0,
    MAX_INFO_PAGES
  );
  for (const url of infoUrls) {
    try {
      const page = await deps.fetchPage(url);
      draft = mergeEntries(draft, await deps.extract(page));
    } catch (error) {
      // A broken info page must not fail the whole entry.
      console.warn(
        `  ⚠ Info page ${url} failed: ${error instanceof Error ? error.message : error}`
      );
    }
    if (hasDates(draft)) break;
  }
  return draft;
}

/** True when the 4-digit start year appears in the page URL, title or text,
 *  or when a validated weekday already vouches for the year. */
export function hasYearEvidence(
  draft: { start_time?: string },
  page: { url: string; title: string; text: string },
  dayNameValidated: boolean
): boolean {
  if (dayNameValidated) return true;
  const year = draft.start_time?.slice(0, 4);
  if (!year || !/^\d{4}$/.test(year)) return false;
  const re = new RegExp(`(?<!\\d)${year}(?!\\d)`);
  return [page.url, page.title, page.text].some(s => re.test(s ?? ''));
}

/** Remove the dates, keep everything else. */
export function stripDates(d: FestivalEntryDraft): FestivalEntryDraft {
  const { start_time: _s, end_time: _e, event_days: _days, ...rest } = d;
  return rest;
}
