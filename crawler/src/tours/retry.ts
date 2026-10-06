import type { TourSource } from './bands-config.js';
import type { RunRecord } from '../utils/run-log.js';

export interface RetrySelection {
  /** Sources to run again, in bands.yaml order. */
  sources: TourSource[];
  /** `started_at` of the tours run the selection is based on. */
  basedOn?: string;
  /** Failed urls of that run that are no longer (active) in bands.yaml. */
  missing: string[];
  /** There is no tours run in the log at all. */
  noPreviousRun: boolean;
}

/**
 * The sources to repeat after the last live tours run: those that failed
 * outright, and those where some shows failed (`failed_shows`, recorded since
 * the field was introduced; older records only have the source outcome).
 * Only the most recent tours record counts, so repeated `--retry-failed` runs
 * keep narrowing down to what is still failing.
 */
export function selectRetrySources(
  sources: TourSource[],
  records: RunRecord[]
): RetrySelection {
  const last = [...records].reverse().find(r => r.kind === 'tours');
  if (!last) return { sources: [], missing: [], noPreviousRun: true };

  const failed = new Set<string>();
  for (const e of last.entries ?? []) {
    if (e.outcome === 'failed' || (e.failed_shows ?? 0) > 0) failed.add(e.url);
  }
  const known = new Set(sources.map(s => s.url));
  return {
    sources: sources.filter(s => failed.has(s.url)),
    basedOn: typeof last.started_at === 'string' ? last.started_at : undefined,
    missing: [...failed].filter(u => !known.has(u)),
    noPreviousRun: false,
  };
}
