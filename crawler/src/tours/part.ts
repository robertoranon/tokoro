import type { TourSource } from './bands-config.js';

/** `--part N/M`: run the Nth of M roughly equal shares of the sources. */
export interface Part {
  index: number; // 1-based
  total: number;
}

/** Parses "N/M"; returns an error message when the value is not valid. */
export function parsePart(value: string): Part | string {
  const m = /^(\d+)\/(\d+)$/.exec(value);
  if (!m) return `--part needs the form N/M (for example 1/3), got "${value}"`;
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (total < 1 || index < 1 || index > total) {
    return `--part N/M needs 1 <= N <= M, got "${value}"`;
  }
  return { index, total };
}

/** FNV-1a (32 bit) with a murmur3 finalizer: deterministic, no dependencies. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * The sources of one part, in their original order. A source's part depends
 * only on its url, so adding or removing other sources never moves it.
 */
export function selectPart(sources: TourSource[], part: Part): TourSource[] {
  return sources.filter(s => (hash(s.url) % part.total) + 1 === part.index);
}
