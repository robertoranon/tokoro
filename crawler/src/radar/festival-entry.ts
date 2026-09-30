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
});
export type FestivalEntryDraft = z.infer<typeof FestivalEntryDraftSchema>;
export type DatedDraft = FestivalEntryDraft & {
  start_time: string;
  end_time: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

export function parseFestivalEntry(
  raw: unknown,
  pageUrl: string
): FestivalEntryDraft | null {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (!candidate || typeof candidate !== 'object') return null;

  // LLMs return null / '' for "unknown"; the schema wants the key absent.
  const cleaned: Record<string, unknown> = Object.fromEntries(
    Object.entries(candidate as Record<string, unknown>).filter(
      ([, v]) => v !== null && v !== ''
    )
  );
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
    DATE_RE.test(d.start_time) &&
    DATE_RE.test(d.end_time) &&
    d.end_time.slice(0, 10) >= d.start_time.slice(0, 10)
  );
}

/** Radar convention: first day at T00:00:00, last day at T23:59:59. */
export function normalizeRadarDates(d: FestivalEntryDraft): FestivalEntryDraft {
  if (
    !d.start_time ||
    !d.end_time ||
    !DATE_RE.test(d.start_time) ||
    !DATE_RE.test(d.end_time)
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
  const fixed = correctEventYear(d as ExtractedEvent);
  if (fixed) return fixed as FestivalEntryDraft;
  const { day_name: _dayName, start_time: _s, end_time: _e, ...rest } = d;
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
    if (key === 'start_time' || key === 'end_time') continue;
    if (isEmpty(key, merged[key]) && !isEmpty(key, value)) merged[key] = value;
  }
  if (!hasDates(base) && hasDates(extra)) {
    merged.start_time = extra.start_time;
    merged.end_time = extra.end_time;
  }
  return merged as FestivalEntryDraft;
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

/** Apply the radar entry conventions (spec §1) to a dated draft. */
export function finalizeRadarEntry(
  d: DatedDraft,
  festivalUrl: string
): ExtractedEvent {
  const tags = [
    ...new Set([...(d.tags ?? []).map(t => t.toLowerCase()), 'festival']),
  ];
  return {
    ...d,
    url: d.url ?? festivalUrl,
    festival_name: stripEdition(d.festival_name ?? d.title),
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
