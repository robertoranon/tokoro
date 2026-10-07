import type { TourSourceResult } from '../crawler.js';

/** Longest failure reason kept in results and the run log. */
export const MAX_REASON = 160;
/** Longest show title kept in the run log's `failures`. */
export const MAX_TITLE = 80;
/** Failed shows listed per source (run log and end-of-run report). */
export const MAX_FAILURES = 10;
const MAX_URL = 70;

/** `text`, cut to `max` characters (the last one an ellipsis) when longer. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/** A short, safe failure reason from anything thrown. */
export function errorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncate(message || 'unknown error', MAX_REASON);
}

/** host + path (no scheme, query or fragment), at most 70 chars. */
function shortUrl(url: string): string {
  let short = url;
  try {
    const u = new URL(url);
    short = u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    // not a URL: keep it as is
  }
  return truncate(short, MAX_URL);
}

/**
 * The end-of-run "Failures (why):" section: one block per source with a
 * source error or failed shows. Identical reasons shared by 3 or more shows of
 * a source become one line with a count; at most 10 lines per source.
 */
export function formatFailures(results: TourSourceResult[]): string[] {
  const lines: string[] = [];
  for (const r of results) {
    const failed = r.shows.filter(s => s.outcome === 'failed');
    if (!r.error && failed.length === 0) continue;
    lines.push(`  - ${shortUrl(r.url)}`);
    if (r.error) lines.push(`    ${r.error}`);

    const byReason = new Map<string, string[]>();
    for (const s of failed) {
      const reason = s.reason ?? 'unknown reason';
      byReason.set(reason, [...(byReason.get(reason) ?? []), s.title]);
    }
    // In order of first appearance: a group of 3+ is one entry.
    const entries: { line: string; shows: number }[] = [];
    const grouped = new Set<string>();
    for (const s of failed) {
      const reason = s.reason ?? 'unknown reason';
      const titles = byReason.get(reason)!;
      if (titles.length >= 3) {
        if (grouped.has(reason)) continue;
        grouped.add(reason);
        entries.push({
          line: `    · ${titles.length} shows: ${reason}`,
          shows: titles.length,
        });
      } else {
        entries.push({
          line: `    · ${truncate(s.title, MAX_TITLE)}: ${reason}`,
          shows: 1,
        });
      }
    }
    for (const e of entries.slice(0, MAX_FAILURES)) lines.push(e.line);
    const rest = entries.slice(MAX_FAILURES).reduce((n, e) => n + e.shows, 0);
    if (rest > 0) lines.push(`    … and ${rest} more`);
  }
  return lines.length > 0 ? ['Failures (why):', ...lines] : [];
}
