import type {
  ExtractedEvent,
  FetchedPage,
  NormalizedEvent,
} from '../types/event.js';
import {
  effectiveRegion,
  type BandConfig,
  type BandsConfig,
  type TourSource,
} from './bands-config.js';
import {
  finalizeTourShow,
  inRegion,
  isPastShow,
  matchBand,
  placeQuery,
  type TourShowDraft,
} from './tour-shows.js';
import type { GeoBias } from '../../../shared/utils/geocode.js';
import {
  matchShow,
  type ExistingShow,
  type TourOutcome,
} from './tour-publisher.js';

export type ShowOutcome =
  | TourOutcome
  | 'unmatched'
  | 'skipped_past'
  | 'skipped_out_of_region';

export interface ShowResult {
  title: string;
  outcome: ShowOutcome;
  /**
   * Set on `skipped_out_of_region` when an event published earlier for this
   * show sits somewhere else: it was geocoded to the wrong place, and the
   * correct place is outside the region, so it cannot be corrected by an
   * update. The crawler never deletes; the curator removes it.
   */
  stale?: { id: string; band: string; lat: number; lng: number };
}

export interface TourCounters {
  published: number;
  updated: number;
  unchanged: number;
  unmatched: number;
  skipped_past: number;
  skipped_out_of_region: number;
  failed: number;
}

export function tallyShows(results: ShowResult[]): TourCounters {
  const c: TourCounters = {
    published: 0,
    updated: 0,
    unchanged: 0,
    unmatched: 0,
    skipped_past: 0,
    skipped_out_of_region: 0,
    failed: 0,
  };
  for (const { outcome } of results) c[outcome]++;
  return c;
}

/** One outcome per source, for the run log and the stale-source report. */
export type SourceOutcome =
  | 'published'
  | 'updated'
  | 'unchanged'
  | 'no_shows'
  | 'failed';

export function sourceOutcome(results: ShowResult[]): SourceOutcome {
  const has = (o: ShowOutcome) => results.some(r => r.outcome === o);
  if (has('published')) return 'published';
  if (has('updated')) return 'updated';
  if (has('unchanged')) return 'unchanged';
  if (has('failed')) return 'failed';
  return 'no_shows';
}

export interface TourSourceDeps {
  extract: (page: FetchedPage) => Promise<TourShowDraft[]>;
  lookup: (actUrl: string) => Promise<ExistingShow[]>;
  normalize: (
    event: ExtractedEvent,
    options?: { createdAt?: string; geoBias?: GeoBias }
  ) => Promise<NormalizedEvent | null>;
  apply: (
    event: NormalizedEvent,
    match: ExistingShow | undefined
  ) => Promise<TourOutcome>;
  /**
   * Where the page's places cluster (see `medianBias`), given the geocoder
   * queries of the upcoming shows that have no coordinates. Optional: without
   * it ambiguous places keep the geocoder's own ranking.
   */
  locate?: (queries: string[]) => Promise<GeoBias | undefined>;
  /** This crawler's pubkey; a show held by another key is never updated. */
  ownPubkey?: string;
  /** YYYY-MM-DD; shows before it are skipped. */
  today: string;
}

/** The registry bands a source may attribute shows to. */
function candidateBands(source: TourSource, config: BandsConfig): BandConfig[] {
  const active = config.bands.filter(b => b.status === 'active');
  if (source.mode === 'band') {
    return active.filter(
      b => b.name.toLowerCase() === source.band.toLowerCase()
    );
  }
  if (!source.only) return active;
  const only = new Set(source.only.map(n => n.toLowerCase()));
  return active.filter(b => only.has(b.name.toLowerCase()));
}

/**
 * Everything that happens to one fetched source page: extract, attribute to a
 * band (band mode: the source's band; listing mode: deterministic name match),
 * drop past / out-of-region shows, then normalize (geocode + sign) and
 * publish-or-update. Never throws for a single bad show.
 */
export async function processTourSourcePage(
  page: FetchedPage,
  source: TourSource,
  config: BandsConfig,
  deps: TourSourceDeps
): Promise<ShowResult[]> {
  const drafts = await deps.extract(page);
  const bands = candidateBands(source, config);
  const results: ShowResult[] = [];
  const existingByBand = new Map<string, ExistingShow[]>();
  // Published/updated in this run, so the same show listed twice on one page
  // is not sent twice (the lookup above predates this run's POSTs).
  const handled: ExistingShow[] = [];
  const handledKey = (actUrl: string, day: string) => `${actUrl}|${day}`;
  const seenSameDay = new Map<string, ExistingShow[]>();
  // Ids (real, or stub ids for new shows) already POSTed/PUT in this run.
  const sentIds = new Set<string>();

  // The page's centre, from the places of the upcoming shows that still need
  // geocoding, so a bare "Durham" among US cities resolves to Durham, NC.
  let geoBias: GeoBias | undefined;
  if (deps.locate) {
    const queries = drafts
      .filter(d => !isPastShow(d.start_time, deps.today))
      .filter(d => d.lat === undefined || d.lng === undefined)
      .map(d => placeQuery(d))
      .filter((q): q is string => !!q);
    try {
      geoBias = await deps.locate(queries);
    } catch {
      geoBias = undefined; // evidence unavailable: keep the geocoder's ranking
    }
  }

  for (const draft of drafts) {
    const band =
      source.mode === 'band' ? bands[0] : matchBand(draft.performers, bands);
    if (!band) {
      results.push({ title: draft.title, outcome: 'unmatched' });
      continue;
    }
    if (isPastShow(draft.start_time, deps.today)) {
      results.push({ title: draft.title, outcome: 'skipped_past' });
      continue;
    }
    const region = effectiveRegion(config, band);
    if (
      region &&
      draft.lat !== undefined &&
      draft.lng !== undefined &&
      !inRegion(draft.lat, draft.lng, region)
    ) {
      results.push({ title: draft.title, outcome: 'skipped_out_of_region' });
      continue;
    }

    try {
      let existing = existingByBand.get(band.url);
      if (!existing) {
        existing = await deps.lookup(band.url);
        existingByBand.set(band.url, existing);
      }
      const entry = finalizeTourShow(draft, band, page.url);
      const pool = [
        ...existing,
        ...(seenSameDay.get(
          handledKey(band.url, draft.start_time.slice(0, 10))
        ) ?? []),
      ];

      // Without coordinates the match can only be made after geocoding, so
      // normalize first when needed, matching on the geocoded position.
      let match =
        entry.lat !== undefined && entry.lng !== undefined
          ? matchShow(
              pool,
              String(entry.start_time),
              entry.lat,
              entry.lng,
              entry.venue_name
            )
          : // No coordinates yet: the same venue on the same date still identifies the show.
            matchShow(
              pool,
              String(entry.start_time),
              undefined,
              undefined,
              entry.venue_name
            );
      let normalized = await deps.normalize(entry, {
        createdAt: match?.created_at,
        geoBias,
      });
      if (normalized && !match) {
        match = matchShow(
          pool,
          normalized.start_time,
          normalized.lat,
          normalized.lng,
          entry.venue_name
        );
        if (match) {
          normalized = await deps.normalize(
            { ...entry, lat: normalized.lat, lng: normalized.lng },
            { createdAt: match.created_at, geoBias }
          );
        }
      }
      if (!normalized && match) {
        // LLM extraction varies between runs: a run that finds no usable
        // location must not fail a show whose location is already known.
        console.log(
          `  ↺ No usable location this run — reusing stored coordinates (${match.lat}, ${match.lng})`
        );
        normalized = await deps.normalize(
          { ...entry, lat: match.lat, lng: match.lng },
          { createdAt: match.created_at, geoBias }
        );
      }
      if (!normalized) {
        results.push({ title: draft.title, outcome: 'failed' });
        continue;
      }

      // Region check on geocoded coordinates too (drafts often lack lat/lng).
      if (region && !inRegion(normalized.lat, normalized.lng, region)) {
        const moved =
          match &&
          (Math.abs(match.lat - normalized.lat) > 0.005 ||
            Math.abs(match.lng - normalized.lng) > 0.005);
        results.push({
          title: draft.title,
          outcome: 'skipped_out_of_region',
          ...(match && moved
            ? {
                stale: {
                  id: match.id,
                  band: band.name,
                  lat: match.lat,
                  lng: match.lng,
                },
              }
            : {}),
        });
        continue;
      }

      // Held by another key (an event adopted into this band, or imported
      // elsewhere): it counts as the show, but it is not ours to update, and
      // posting it again would only meet the duplicate check once more.
      if (
        match &&
        match.pubkey &&
        deps.ownPubkey &&
        match.pubkey !== deps.ownPubkey
      ) {
        console.log(
          `= Already in the database under another key: ${normalized.title}`
        );
        results.push({ title: draft.title, outcome: 'unchanged' });
        continue;
      }

      // Already published/updated earlier in this run (same show listed twice
      // on the page): never send it again. A stub id is not a real event id,
      // so a PUT would 404 and fall back to a second POST.
      if (match && sentIds.has(match.id)) {
        console.log(`= Already sent this run: ${normalized.title}`);
        results.push({ title: draft.title, outcome: 'unchanged' });
        continue;
      }

      const outcome = await deps.apply(normalized, match);
      results.push({ title: draft.title, outcome });
      if (outcome === 'published' || outcome === 'updated') {
        const key = handledKey(band.url, normalized.start_time.slice(0, 10));
        const stub: ExistingShow = {
          id: match?.id ?? `new:${key}:${handled.length}`,
          title: normalized.title,
          lat: normalized.lat,
          lng: normalized.lng,
          start_time: normalized.start_time,
          category: normalized.category,
          tags: normalized.tags ?? [],
          created_at: normalized.created_at,
        };
        handled.push(stub);
        sentIds.add(stub.id);
        seenSameDay.set(key, [...(seenSameDay.get(key) ?? []), stub]);
      }
    } catch (error) {
      console.error(
        `  Error on "${draft.title}": ${error instanceof Error ? error.message : error}`
      );
      results.push({ title: draft.title, outcome: 'failed' });
    }
  }
  return results;
}
