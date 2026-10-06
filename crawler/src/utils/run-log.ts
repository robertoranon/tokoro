import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

/** A line of logs/runs.jsonl. `kind` is absent on records written before radar existed. */
export interface RunRecord {
  kind?: 'jobs' | 'radar' | 'scout' | 'tours';
  entries?: Array<{ url: string; outcome: string; failed_shows?: number }>;
  [key: string]: unknown;
}

/** crawler/logs (this file lives in crawler/src/utils). */
export function defaultLogsDir(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'logs'
  );
}

export async function appendRunLog(
  logsDir: string,
  record: object
): Promise<void> {
  await fs.mkdir(logsDir, { recursive: true });
  const logPath = path.join(logsDir, 'runs.jsonl');
  await fs.appendFile(logPath, JSON.stringify(record) + '\n', 'utf-8');
}

/** Oldest → newest. Unparseable lines are skipped; a missing file is empty. */
export async function readRunRecords(logsDir: string): Promise<RunRecord[]> {
  let content: string;
  try {
    content = await fs.readFile(path.join(logsDir, 'runs.jsonl'), 'utf-8');
  } catch {
    return [];
  }
  const records: RunRecord[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as RunRecord);
    } catch {
      // ignore a corrupt line
    }
  }
  return records;
}

/** Number of recent radar runs examined by the stale-source report. */
export const STALE_WINDOW = 4;

const HEALTHY = new Set(['published', 'updated', 'unchanged']);

/**
 * The "silently dead source" report (spec §3): sources whose last `window`
 * runs of `kind` (that included them) produced no published/updated/unchanged
 * outcome. Needs a full window of history for that source before flagging.
 */
export function findStaleSources(
  records: RunRecord[],
  activeUrls: string[],
  kind: 'radar' | 'tours',
  window = STALE_WINDOW
): string[] {
  const runs = records.filter(r => r.kind === kind);
  return activeUrls.filter(url => {
    const outcomes = runs
      .map(r => r.entries?.find(e => e.url === url)?.outcome)
      .filter((o): o is string => o !== undefined)
      .slice(-window);
    return (
      outcomes.length >= window &&
      !outcomes.some(o => HEALTHY.has(o) || o === 'skipped_series')
    );
  });
}

/** Radar festivals that look dead (see findStaleSources). */
export function findStaleFestivals(
  records: RunRecord[],
  activeUrls: string[],
  window = STALE_WINDOW
): string[] {
  return findStaleSources(records, activeUrls, 'radar', window);
}
