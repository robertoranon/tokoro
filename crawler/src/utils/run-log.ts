import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

/** A line of logs/runs.jsonl. `kind` is absent on records written before radar existed. */
export interface RunRecord {
  kind?: 'jobs' | 'radar' | 'scout';
  entries?: Array<{ url: string; outcome: string }>;
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
 * The "silently dead source" report (spec §3): festivals whose last `window`
 * radar runs (that included them) produced no published/updated/unchanged
 * outcome. Needs a full window of history for that festival before flagging.
 */
export function findStaleFestivals(
  records: RunRecord[],
  activeUrls: string[],
  window = STALE_WINDOW
): string[] {
  const radarRuns = records.filter(r => r.kind === 'radar');
  return activeUrls.filter(url => {
    const outcomes = radarRuns
      .map(r => r.entries?.find(e => e.url === url)?.outcome)
      .filter((o): o is string => o !== undefined)
      .slice(-window);
    return outcomes.length >= window && !outcomes.some(o => HEALTHY.has(o));
  });
}
