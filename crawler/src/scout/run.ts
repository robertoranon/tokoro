import type { ScoutSource } from './sources-config.js';
import {
  mergeNewCandidates,
  type Candidate,
  type RawCandidate,
  type ScoutState,
} from './candidates.js';

export interface SourceOutcome {
  source: string;
  status: 'ok' | 'failed';
  found: number;
  added: number;
  skipped: number;
  error?: string;
}

export interface ScoutRunInput {
  sources: ScoutSource[];
  /** Fetch + extract one source. Throwing marks the source as failed. */
  scoutOne: (source: ScoutSource) => Promise<RawCandidate[]>;
  /** Current inbox contents (kept as is; new candidates are appended). */
  existing: Candidate[];
  state: ScoutState;
  /** Dedup keys of the watchlist and the inbox. */
  known: Set<string>;
  today: string;
}

export interface ScoutRunResult {
  candidates: Candidate[];
  state: ScoutState;
  outcomes: SourceOutcome[];
}

/** Sequential, like the radar and the scheduler: one source failing never stops the rest. */
export async function scoutSources(
  input: ScoutRunInput
): Promise<ScoutRunResult> {
  let state = input.state;
  const candidates = [...input.existing];
  const outcomes: SourceOutcome[] = [];

  for (const source of input.sources) {
    try {
      const found = await input.scoutOne(source);
      const merged = mergeNewCandidates(found, {
        source: source.name,
        today: input.today,
        known: input.known,
        state,
      });
      state = merged.state;
      candidates.push(...merged.added);
      outcomes.push({
        source: source.name,
        status: 'ok',
        found: found.length,
        added: merged.added.length,
        skipped: merged.skipped,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ❌ Source "${source.name}" failed: ${message}`);
      outcomes.push({
        source: source.name,
        status: 'failed',
        found: 0,
        added: 0,
        skipped: 0,
        error: message,
      });
    }
  }
  return { candidates, state, outcomes };
}

export function summarizeScout(outcomes: SourceOutcome[]) {
  return {
    sources_total: outcomes.length,
    sources_failed: outcomes.filter(o => o.status === 'failed').length,
    candidates_found: outcomes.reduce((n, o) => n + o.found, 0),
    candidates_new: outcomes.reduce((n, o) => n + o.added, 0),
  };
}
