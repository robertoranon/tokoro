import {
  normalizeFestivalUrl,
  parseFestivalsConfig,
} from '../radar/festivals-config.js';
import {
  candidateKeys,
  recordInState,
  urlKey,
  type Candidate,
  type ScoutState,
} from './candidates.js';

export interface PromoteInput {
  candidates: Candidate[];
  festivalsText: string;
  /** Dedup keys (`u:`/`n:`) of the current watchlist. */
  knownUrlKeys: Set<string>;
  state: ScoutState;
  today: string;
}

export interface PromoteResult {
  candidates: Candidate[]; // what stays in the inbox
  festivalsText: string;
  state: ScoutState;
  promoted: Candidate[];
  needsUrl: Candidate[];
  alreadyKnown: Candidate[];
  rejected: Candidate[];
}

const q = (s: string) => JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars

/**
 * Append entries to festivals.yaml as TEXT (the file is hand-curated, a
 * load/dump round trip would destroy its comments), then prove the result
 * still parses and contains every new url. Throws if appending is not safe.
 */
export function appendFestivals(
  text: string,
  entries: Candidate[],
  today: string
): string {
  if (entries.length === 0) return text;

  let out = text.replace(/^festivals:[ \t]*\[[ \t]*\][ \t]*$/m, 'festivals:');
  out = out.replace(/\s*$/, '\n');
  if (!/^festivals:/m.test(out)) out += 'festivals:\n';

  for (const c of entries) {
    out +=
      `\n  - url: ${normalizeFestivalUrl(c.url as string)}\n` +
      `    name: ${q(c.name)}\n` +
      `    status: active\n` +
      `    added: ${today}\n` +
      (c.why ? `    notes: ${q(c.why)}\n` : '');
  }

  const parsed = parseFestivalsConfig(out); // throws on invalid YAML/config
  const urls = new Set(parsed.festivals.map(f => f.url));
  for (const c of entries) {
    if (!urls.has(normalizeFestivalUrl(c.url as string))) {
      throw new Error(
        'Cannot append to festivals.yaml safely (is "festivals:" the last top-level key?). Add the entries by hand.'
      );
    }
  }
  return out;
}

export function promoteCandidates(input: PromoteInput): PromoteResult {
  let state = input.state;
  const remaining: Candidate[] = [];
  const promoted: Candidate[] = [];
  const needsUrl: Candidate[] = [];
  const alreadyKnown: Candidate[] = [];
  const rejected: Candidate[] = [];

  for (const c of input.candidates) {
    if (c.status === 'pending') {
      remaining.push(c);
    } else if (c.status === 'rejected') {
      rejected.push(c);
      state = recordInState(state, candidateKeys(c), 'rejected', input.today);
    } else if (!c.url || urlKey(c.url) === undefined) {
      needsUrl.push(c);
      remaining.push(c); // stays in the inbox until the curator fills the url
    } else if (input.knownUrlKeys.has(`u:${urlKey(c.url)}`)) {
      alreadyKnown.push(c);
      state = recordInState(state, candidateKeys(c), 'approved', input.today);
    } else {
      promoted.push(c);
      state = recordInState(state, candidateKeys(c), 'approved', input.today);
    }
  }

  return {
    candidates: remaining,
    festivalsText: appendFestivals(input.festivalsText, promoted, input.today),
    state,
    promoted,
    needsUrl,
    alreadyKnown,
    rejected,
  };
}
