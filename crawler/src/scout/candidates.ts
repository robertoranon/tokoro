import yaml from 'js-yaml';
import { stripEdition } from '../radar/festival-entry.js';

export type CandidateStatus = 'pending' | 'approved' | 'rejected';
const STATUSES: readonly CandidateStatus[] = [
  'pending',
  'approved',
  'rejected',
];

/** What the LLM proposes for one festival. */
export interface RawCandidate {
  name: string;
  url?: string;
  dates_hint?: string;
  location_hint?: string;
  why: string;
}

/** One entry of candidates.yaml (the review inbox). */
export interface Candidate extends RawCandidate {
  status: CandidateStatus;
  source: string;
  found: string; // YYYY-MM-DD
  notes?: string; // free-form curator notes
}

/** scout-state.json: append-only memory of everything ever proposed, by dedup key. */
export type ScoutState = Record<
  string,
  { status: CandidateStatus; first_seen: string }
>;

/** Lowercase, accent-free, no edition year, no punctuation, no leading "the". */
export function normalizeName(name: string): string {
  return stripEdition(name)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the /, '');
}

const LANG_SEGMENT =
  /^\/(en|it|fr|de|es|pt|nl|pl|cs|sl|hr|sv|da|no|fi|hu|ro|el|ru|tr)(?=\/|$)/;

/**
 * host (no www) + path (no trailing slash), lowercased. Host+path, not host
 * only: several festivals can live on one domain.
 */
export function urlKey(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    const path = u.pathname
      .toLowerCase()
      .replace(/\/index\.(html|htm|php)$/, '')
      .replace(/\/+$/, '')
      .replace(LANG_SEGMENT, '');
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${path}`;
  } catch {
    return undefined;
  }
}

export function candidateKeys(c: { name: string; url?: string }): string[] {
  const keys: string[] = [];
  const u = c.url ? urlKey(c.url) : undefined;
  if (u !== undefined) keys.push(`u:${u}`);
  const n = normalizeName(c.name);
  if (n.length >= 3) keys.push(`n:${n}`);
  return keys;
}

export function knownKeysFromFestivals(
  festivals: Array<{ url: string; name?: string }>
): Set<string> {
  const known = new Set<string>();
  for (const f of festivals) {
    for (const key of candidateKeys({ name: f.name ?? '', url: f.url })) {
      known.add(key);
    }
  }
  return known;
}

export function isKnown(
  keys: string[],
  known: Set<string>,
  state: ScoutState
): boolean {
  return keys.some(
    k => known.has(k) || Object.prototype.hasOwnProperty.call(state, k)
  );
}

/** Record every key with `status`; an existing entry keeps its first_seen. */
export function recordInState(
  state: ScoutState,
  keys: string[],
  status: CandidateStatus,
  today: string
): ScoutState {
  const next: ScoutState = { ...state };
  for (const key of keys) {
    next[key] = { status, first_seen: state[key]?.first_seen ?? today };
  }
  return next;
}

/**
 * Drop what we already know (watchlist, inbox, state — including candidates
 * proposed earlier in the same batch) and turn the rest into pending
 * candidates. Pure: `state` is not mutated, the updated copy is returned.
 */
export function mergeNewCandidates(
  found: RawCandidate[],
  ctx: {
    source: string;
    today: string;
    known: Set<string>;
    state: ScoutState;
  }
): { added: Candidate[]; skipped: number; state: ScoutState } {
  let state = ctx.state;
  const added: Candidate[] = [];
  let skipped = 0;

  for (const raw of found) {
    const keys = candidateKeys(raw);
    if (keys.length === 0 || isKnown(keys, ctx.known, state)) {
      skipped++;
      continue;
    }
    state = recordInState(state, keys, 'pending', ctx.today);
    added.push({
      name: raw.name,
      ...(raw.url ? { url: raw.url } : {}),
      status: 'pending',
      why: raw.why,
      source: ctx.source,
      found: ctx.today,
      ...(raw.dates_hint ? { dates_hint: raw.dates_hint } : {}),
      ...(raw.location_hint ? { location_hint: raw.location_hint } : {}),
    });
  }
  return { added, skipped, state };
}

// ---------- candidates.yaml ----------

const ALLOWED_FIELDS = [
  'name',
  'url',
  'status',
  'why',
  'source',
  'found',
  'dates_hint',
  'location_hint',
  'notes',
];

// js-yaml parses an unquoted `2026-07-25` into a Date.
function dateString(value: unknown, label: string): string {
  if (value === undefined || value === null || value === '') return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  throw new Error(
    `Invalid candidates.yaml: ${label} has invalid found "${String(value)}": expected YYYY-MM-DD`
  );
}

function text(
  value: unknown,
  label: string,
  field: string
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid candidates.yaml: ${label} has invalid ${field}: expected a string`
    );
  }
  return value;
}

export function parseCandidates(content: string): Candidate[] {
  if (!content.trim()) return [];
  const raw = yaml.load(content);
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid candidates.yaml: expected a YAML object at root');
  }
  const list = (raw as Record<string, unknown>).candidates;
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list)) {
    throw new Error('Invalid candidates.yaml: "candidates" must be a list');
  }

  return list.map((item, i): Candidate => {
    if (!item || typeof item !== 'object') {
      throw new Error(
        `Invalid candidates.yaml: entry ${i + 1} must be an object`
      );
    }
    const c = item as Record<string, unknown>;
    const name = text(c.name, `entry ${i + 1}`, 'name');
    if (!name) {
      throw new Error(
        `Invalid candidates.yaml: entry ${i + 1} must have a "name"`
      );
    }
    const label = `"${name}"`;
    for (const key of Object.keys(c)) {
      if (!ALLOWED_FIELDS.includes(key)) {
        throw new Error(
          `Invalid candidates.yaml: ${label} has unknown field "${key}". Allowed: ${ALLOWED_FIELDS.join(', ')}`
        );
      }
    }
    const status = (
      c.status === undefined || c.status === null
        ? 'pending'
        : String(c.status).trim().toLowerCase()
    ) as CandidateStatus;
    if (!STATUSES.includes(status)) {
      throw new Error(
        `Invalid candidates.yaml: ${label} has invalid status "${c.status}". Must be: ${STATUSES.join(', ')}`
      );
    }
    const url = text(c.url, label, 'url');
    const dates = text(c.dates_hint, label, 'dates_hint');
    const where = text(c.location_hint, label, 'location_hint');
    const notes = text(c.notes, label, 'notes');
    return {
      name,
      ...(url ? { url } : {}),
      status,
      why: text(c.why, label, 'why') ?? '',
      source: text(c.source, label, 'source') ?? '',
      found: dateString(c.found, label),
      ...(dates ? { dates_hint: dates } : {}),
      ...(where ? { location_hint: where } : {}),
      ...(notes ? { notes } : {}),
    };
  });
}

export function serializeCandidates(list: Candidate[]): string {
  const header =
    '# Scout inbox. Set status to approved or rejected, fill in a missing url,\n' +
    '# then run: npm run scout-promote\n' +
    '# (this file is rewritten by the scout; comments in it are not preserved)\n';
  // Empty found/source/why are omitted so hand-added entries stay clean.
  const clean = list.map(c => {
    const out: Record<string, unknown> = { ...c };
    for (const k of ['found', 'source', 'why'])
      if (out[k] === '') delete out[k];
    return out;
  });
  return (
    header + yaml.dump({ candidates: clean }, { lineWidth: -1, noRefs: true })
  );
}

// ---------- scout-state.json ----------

export function parseState(content: string): ScoutState {
  if (!content.trim()) return {};
  const raw = JSON.parse(content) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid scout-state.json: expected a JSON object');
  }
  const state: ScoutState = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.startsWith('u:') && !key.startsWith('n:')) {
      throw new Error(`Invalid scout-state.json: bad key "${key}"`);
    }
    const v = value as { status?: unknown; first_seen?: unknown } | null;
    if (
      !v ||
      !STATUSES.includes(v.status as CandidateStatus) ||
      typeof v.first_seen !== 'string'
    ) {
      throw new Error(`Invalid scout-state.json: bad entry for "${key}"`);
    }
    state[key] = {
      status: v.status as CandidateStatus,
      first_seen: v.first_seen,
    };
  }
  return state;
}

export function serializeState(state: ScoutState): string {
  const sorted: ScoutState = {};
  for (const key of Object.keys(state).sort()) sorted[key] = state[key];
  return JSON.stringify(sorted, null, 2) + '\n';
}
