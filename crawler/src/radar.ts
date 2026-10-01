import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  EventCrawler,
  BrowserEngine,
  type RadarEntryResult,
} from './crawler.js';
import { loadEnv, loadCrawlerEnv, buildLLM } from './setup.js';
import {
  parseFestivalsConfig,
  activeFestivals,
  type FestivalsConfig,
} from './radar/festivals-config.js';
import {
  appendRunLog,
  defaultLogsDir,
  readRunRecords,
  findStaleFestivals,
  STALE_WINDOW,
} from './utils/run-log.js';

export interface RadarCounters {
  published: number;
  updated: number;
  unchanged: number;
  skipped_no_dates: number;
  failed: number;
}

export function tallyOutcomes(results: RadarEntryResult[]): RadarCounters {
  const counters: RadarCounters = {
    published: 0,
    updated: 0,
    unchanged: 0,
    skipped_no_dates: 0,
    failed: 0,
  };
  for (const { outcome } of results) counters[outcome]++;
  return counters;
}

/**
 * `npm run radar --debug` (no `--`) makes npm swallow the flag and expose it
 * as npm_config_debug. Treat that as debug too. Only ever errs toward debug.
 */
export function isDebugRequested(
  argv: string[],
  env: Record<string, string | undefined>
): { debug: boolean; fromNpm: boolean } {
  const inArgv = argv.includes('--debug');
  const inNpm = env.npm_config_debug === 'true';
  return { debug: inArgv || inNpm, fromNpm: !inArgv && inNpm };
}

async function main() {
  const startedAt = new Date();
  await loadEnv();

  let festivalsFile = path.join(process.cwd(), 'festivals.yaml');
  const fileIndex = process.argv.indexOf('--festivals');
  if (fileIndex !== -1 && process.argv[fileIndex + 1]) {
    festivalsFile = path.resolve(process.argv[fileIndex + 1]);
  }
  const { debug, fromNpm } = isDebugRequested(process.argv, process.env);
  if (fromNpm) {
    console.warn(
      'Note: --debug was picked up from npm (npm_config_debug). Use "npm run radar -- --debug" next time.'
    );
  }

  // Fail fast on a malformed watchlist, before any crawling.
  let config: FestivalsConfig;
  try {
    config = parseFestivalsConfig(await fs.readFile(festivalsFile, 'utf-8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      console.error(
        `Error: ${festivalsFile} not found. Copy festivals.example.yaml to festivals.yaml and edit it.`
      );
      process.exit(1);
    }
    console.error(
      `Error reading festivals config: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }

  const env = loadCrawlerEnv();
  const active = activeFestivals(config);
  if (active.length === 0) {
    console.warn(`No active festivals in ${festivalsFile} — nothing to do`);
    process.exit(0);
  }
  console.log(
    `Radar: ${active.length} active festival(s), ${config.festivals.length - active.length} paused${debug ? ' (DEBUG: nothing is published)' : ''}`
  );
  console.log(`API: ${env.apiUrl}`);
  if (!debug) {
    console.log(
      `⚠ LIVE RUN — publishing to ${env.apiUrl} (use "npm run radar -- --debug" for a dry run)`
    );
  }

  const defaultBrowser =
    (process.env.BROWSER_ENGINE as BrowserEngine) || 'chrome';
  const results: RadarEntryResult[] = [];

  for (let i = 0; i < active.length; i++) {
    const festival = active[i];
    console.log(
      `\n[${i + 1}/${active.length}] ${festival.name ?? festival.url}`
    );
    try {
      const crawler = new EventCrawler({
        llm: buildLLM(festival.model),
        keypair: { privkey: env.privkey, pubkey: env.pubkey },
        apiUrl: env.apiUrl,
        mode: 'festival-entry',
        fetcher: festival.fetcher ?? 'playwright',
        browserEngine: festival.browser ?? defaultBrowser,
        jinaKey: env.jinaKey,
        braveSearchKey: env.braveSearchKey,
        debug,
        normalize: debug,
      });
      results.push(...(await crawler.crawlFestivalEntries([festival.url])));
    } catch (error) {
      console.error(
        `  Error: ${error instanceof Error ? error.message : error}`
      );
      results.push({ url: festival.url, outcome: 'failed' });
    }
  }

  const counters = tallyOutcomes(results);
  const finishedAt = new Date();
  const durationS =
    Math.round(((finishedAt.getTime() - startedAt.getTime()) / 1000) * 10) / 10;
  const status =
    counters.failed === 0
      ? 'ok'
      : counters.failed === results.length
        ? 'failed'
        : 'partial';

  if (debug) {
    // Debug publishes nothing; the crawler still reports 'published' for
    // entries it extracted, so word the summary accordingly.
    console.log(
      `\nRadar debug run complete (nothing was published): ${counters.published} entries extracted, ${counters.skipped_no_dates} skipped (no dates), ${counters.failed} failed`
    );
  } else {
    console.log(
      `\nRadar complete: ${counters.published} published, ${counters.updated} updated, ${counters.unchanged} unchanged, ${counters.skipped_no_dates} skipped (no dates), ${counters.failed} failed`
    );
  }

  if (!debug) {
    const logsDir = defaultLogsDir();
    await appendRunLog(logsDir, {
      kind: 'radar',
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_s: durationS,
      entries_total: results.length,
      status,
      ...counters,
      entries: results,
    });

    const stale = findStaleFestivals(
      await readRunRecords(logsDir),
      active.map(f => f.url)
    );
    if (stale.length > 0) {
      console.log(
        `\nNo published/updated/unchanged result in the last ${STALE_WINDOW} runs (dead source, or between editions):`
      );
      for (const url of stale) console.log(`  - ${url}`);
    }
  }

  if (counters.failed > 0) process.exit(1);
}

// Only run when executed directly, not when imported as a module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
