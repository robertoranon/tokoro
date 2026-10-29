import yaml from 'js-yaml';
import {
  normalizeActUrl,
  parseBandsConfig,
  type BandsConfig,
} from './bands-config.js';
import { normalizeName } from './tour-shows.js';

export interface NewBand {
  name: string;
  /** The band's official site (becomes act_url). */
  url: string;
  /** The tour page; when absent no `sources` entry is written. */
  tourUrl?: string;
  /** Written to the band's `notes` (curator notes, never sent to the LLM or API). */
  note: string;
}

export interface AppendResult {
  text: string;
  added: NewBand[];
  skipped: { name: string; reason: 'name' | 'url'; existing: string }[];
  /** Band added, but its tour page was already a source. */
  sourceSkipped: { name: string; tourUrl: string }[];
}

const q = (s: string) => JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars

/** The existing band whose name or alias equals `name` (normalized), if any. */
export function knownBandName(
  config: BandsConfig,
  name: string
): string | undefined {
  const key = normalizeName(name);
  for (const b of config.bands) {
    if ([b.name, ...(b.aliases ?? [])].some(n => normalizeName(n) === key)) {
      return b.name;
    }
  }
  return undefined;
}

const TOP_KEY = /^[A-Za-z_][\w-]*:/;

/** Exclusive end of a section's content: trailing blank lines and column-0
 *  comments belong to whatever comes next, so insertion goes before them. */
function sectionEnd(lines: string[], start: number): number {
  let limit = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (TOP_KEY.test(lines[i])) {
      limit = i;
      break;
    }
  }
  let end = limit;
  while (
    end > start + 1 &&
    (lines[end - 1].trim() === '' || lines[end - 1].startsWith('#'))
  ) {
    end--;
  }
  return end;
}

function addToSection(
  lines: string[],
  key: 'bands' | 'sources',
  blocks: string[][]
): void {
  const flat = blocks.flatMap(b => ['', ...b]);
  const at = lines.findIndex(l => l.startsWith(`${key}:`));
  if (at === -1) {
    if (key === 'bands') {
      const s = lines.findIndex(l => l.startsWith('sources:'));
      lines.splice(s === -1 ? lines.length : s, 0, 'bands:', ...flat, '');
    } else {
      lines.push('', 'sources:', ...flat);
    }
    return;
  }
  // "bands: []" (optionally followed by a comment) becomes a block list.
  lines[at] = lines[at].replace(
    /^(\w+:)[ \t]*\[[ \t]*\]([ \t]*#.*)?$/,
    (_m, k: string, c?: string) => k + (c ?? '')
  );
  lines.splice(sectionEnd(lines, at), 0, ...flat);
}

const byText = (a: string, b: string) =>
  a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true });

const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * Sort the items of a top-level block list alphabetically, as TEXT. An item
 * takes along the blank lines and comments just above it (up to its own
 * indentation); lines before the first item stay at the top. Each item is
 * parsed on its own to get its sort key; if any cannot be, nothing is sorted.
 */
function sortSection(
  lines: string[],
  key: 'bands' | 'sources',
  compare: (a: Record<string, unknown>, b: Record<string, unknown>) => number
): void {
  const at = lines.findIndex(l => l.startsWith(`${key}:`));
  if (at === -1) return;
  const end = sectionEnd(lines, at);
  const first = lines.findIndex(
    (l, i) => i > at && i < end && /^\s*- /.test(l)
  );
  if (first === -1) return;
  const indent = indentOf(lines[first]);
  const isItem = (l: string) =>
    indentOf(l) === indent && l.trimStart().startsWith('- ');
  const isLead = (l: string) =>
    l.trim() === '' || (l.trimStart().startsWith('#') && indentOf(l) <= indent);

  const items: {
    lead: string[];
    body: string[];
    value: Record<string, unknown>;
  }[] = [];
  let pendingLead: string[] = [];
  let i = first;
  while (i < end) {
    let next = i + 1;
    while (next < end && !isItem(lines[next])) next++;
    // Blank lines and shallow comments right above the next item belong to it.
    let bodyEnd = next;
    if (next < end) {
      while (bodyEnd > i + 1 && isLead(lines[bodyEnd - 1])) bodyEnd--;
    }
    const body = lines.slice(i, bodyEnd);
    const lead = pendingLead;
    pendingLead = lines.slice(bodyEnd, next);
    let value: unknown;
    try {
      value = yaml.load(
        body.map(l => l.slice(Math.min(indent, indentOf(l)))).join('\n')
      );
    } catch {
      return;
    }
    if (
      !Array.isArray(value) ||
      value.length !== 1 ||
      typeof value[0] !== 'object' ||
      value[0] === null
    ) {
      return;
    }
    items.push({ lead, body, value: value[0] as Record<string, unknown> });
    i = next;
  }

  const blankBetween = items.some(it => it.lead.some(l => l.trim() === ''));
  const sorted = [...items].sort((a, b) => compare(a.value, b.value));
  const out = sorted.flatMap((it, n) => {
    const comments = it.lead.filter(l => l.trim() !== '');
    return [...(n > 0 && blankBetween ? [''] : []), ...comments, ...it.body];
  });
  lines.splice(first, end - first, ...out);
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Bands by name; band sources by band (then url), then listing sources by url. */
function sortBandsYaml(lines: string[]): void {
  sortSection(lines, 'bands', (a, b) => byText(str(a.name), str(b.name)));
  sortSection(lines, 'sources', (a, b) => {
    const la = a.mode === 'band' ? 0 : 1;
    const lb = b.mode === 'band' ? 0 : 1;
    return (
      la - lb ||
      byText(str(a.band), str(b.band)) ||
      byText(str(a.url), str(b.url))
    );
  });
}

/**
 * Insert new bands (and their tour-page sources) into bands.yaml as TEXT, so
 * comments survive, skipping duplicates; sort both lists alphabetically
 * (sortBandsYaml); then prove the result
 * still parses and contains everything that was added. Throws if inserting is
 * not safe (nothing is returned in that case).
 */
export function appendBands(
  text: string,
  entries: NewBand[],
  today: string
): AppendResult {
  const config = parseBandsConfig(text); // throws on invalid YAML/config

  const nameOwner = new Map<string, string>();
  const urlOwner = new Map<string, string>();
  for (const b of config.bands) {
    for (const n of [b.name, ...(b.aliases ?? [])]) {
      nameOwner.set(normalizeName(n), b.name);
    }
    urlOwner.set(b.url, b.name);
  }
  const sourceUrls = new Set(config.sources.map(s => normalizeActUrl(s.url)));

  const added: NewBand[] = [];
  const skipped: AppendResult['skipped'] = [];
  const sourceSkipped: AppendResult['sourceSkipped'] = [];
  const bandBlocks: string[][] = [];
  const sourceBlocks: string[][] = [];

  for (const e of entries) {
    const nameKey = normalizeName(e.name);
    const url = normalizeActUrl(e.url);
    const byName = nameOwner.get(nameKey);
    if (byName !== undefined) {
      skipped.push({ name: e.name, reason: 'name', existing: byName });
      continue;
    }
    const byUrl = urlOwner.get(url);
    if (byUrl !== undefined) {
      skipped.push({ name: e.name, reason: 'url', existing: byUrl });
      continue;
    }
    nameOwner.set(nameKey, e.name);
    urlOwner.set(url, e.name);
    added.push(e);
    bandBlocks.push([
      `  - name: ${q(e.name)}`,
      `    url: ${url}`,
      `    status: active`,
      `    added: ${today}`,
      `    notes: ${q(e.note)}`,
    ]);

    if (e.tourUrl) {
      const tour = normalizeActUrl(e.tourUrl);
      if (sourceUrls.has(tour)) {
        sourceSkipped.push({ name: e.name, tourUrl: e.tourUrl });
      } else {
        sourceUrls.add(tour);
        sourceBlocks.push([
          `  - url: ${e.tourUrl}`,
          `    mode: band`,
          `    band: ${q(e.name)}`,
        ]);
      }
    }
  }

  if (added.length === 0) return { text, added, skipped, sourceSkipped };

  const lines = text.replace(/\s+$/, '').split('\n');
  if (sourceBlocks.length > 0) addToSection(lines, 'sources', sourceBlocks);
  addToSection(lines, 'bands', bandBlocks);
  sortBandsYaml(lines);
  const out = lines.join('\n').replace(/\s+$/, '') + '\n';

  const parsed = parseBandsConfig(out); // throws on invalid result
  const bandUrls = new Set(parsed.bands.map(b => b.url));
  const parsedSources = new Set(
    parsed.sources.map(s => normalizeActUrl(s.url))
  );
  const unsafe = () =>
    new Error(
      'Cannot insert into bands.yaml safely (is "bands:" a block list?). Add the entries by hand.'
    );
  for (const e of added) {
    if (!bandUrls.has(normalizeActUrl(e.url))) throw unsafe();
  }
  for (const b of sourceBlocks) {
    const url = normalizeActUrl(b[0].replace(/^\s*- url:\s*/, ''));
    if (!parsedSources.has(url)) throw unsafe();
  }
  if (
    parsed.bands.length !== config.bands.length + added.length ||
    parsed.sources.length !== config.sources.length + sourceBlocks.length
  ) {
    throw unsafe();
  }
  return { text: out, added, skipped, sourceSkipped };
}
