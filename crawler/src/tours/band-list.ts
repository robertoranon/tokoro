import { normalizeName } from './tour-shows.js';

export interface BandInput {
  name: string;
  /** Optional official-site URL given by the curator ("Name | https://site"). */
  hint?: string;
}

export interface BandList {
  bands: BandInput[];
  /** Lines dropped because the same band appeared earlier (first wins). */
  duplicates: string[];
  /** Lines that could not be used (bad hint URL, no name). */
  invalid: string[];
}

/**
 * One band per line. Blank lines and lines starting with '#' are ignored.
 * "Name | https://site" gives the official site (the search step is skipped).
 */
export function parseBandList(text: string): BandList {
  const bands: BandInput[] = [];
  const duplicates: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const bar = line.indexOf('|');
    const name = (bar === -1 ? line : line.slice(0, bar)).trim();
    const hint = bar === -1 ? '' : line.slice(bar + 1).trim();

    const key = normalizeName(name);
    if (!name || key === '') {
      invalid.push(line);
      continue;
    }
    if (hint) {
      try {
        const u = new URL(hint);
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
          throw new Error();
      } catch {
        invalid.push(line);
        continue;
      }
    }
    if (seen.has(key)) {
      duplicates.push(name);
      continue;
    }
    seen.add(key);
    bands.push(hint ? { name, hint } : { name });
  }
  return { bands, duplicates, invalid };
}
