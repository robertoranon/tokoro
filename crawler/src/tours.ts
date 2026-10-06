import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  EventCrawler,
  BrowserEngine,
  type TourSourceResult,
} from './crawler.js';
import { loadEnv, loadCrawlerEnv, buildLLM } from './setup.js';
import {
  parseBandsConfig,
  activeSources,
  activeBands,
  type BandsConfig,
} from './tours/bands-config.js';
import { tallyShows } from './tours/tour-source.js';
import { selectRetrySources } from './tours/retry.js';
import {
  appendRunLog,
  defaultLogsDir,
  readRunRecords,
  findStaleSources,
  STALE_WINDOW,
} from './utils/run-log.js';
import { isDebugRequested } from './utils/debug-flag.js';

export { isDebugRequested };

/** The logs/runs.jsonl record for one tours run (spec §2.4). */
export function buildTourRunRecord(
  results: TourSourceResult[],
  startedAt: Date,
  finishedAt: Date
) {
  const counters = tallyShows(results.flatMap(r => r.shows));
  const failedSources = results.filter(r => r.outcome === 'failed').length;
  const status =
    failedSources === 0
      ? 'ok'
      : failedSources === results.length
        ? 'failed'
        : 'partial';
  return {
    kind: 'tours' as const,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_s:
      Math.round(((finishedAt.getTime() - startedAt.getTime()) / 1000) * 10) /
      10,
    sources_total: results.length,
    status,
    ...counters,
    entries: results.map(r => {
      const failedShows = r.shows.filter(x => x.outcome === 'failed').length;
      return failedShows > 0
        ? { url: r.url, outcome: r.outcome, failed_shows: failedShows }
        : { url: r.url, outcome: r.outcome };
    }),
  };
}

async function main() {
  const startedAt = new Date();
  await loadEnv();

  let bandsFile = path.join(process.cwd(), 'bands.yaml');
  const fileIndex = process.argv.indexOf('--bands');
  if (fileIndex !== -1 && process.argv[fileIndex + 1]) {
    bandsFile = path.resolve(process.argv[fileIndex + 1]);
  }
  const { debug, fromNpm } = isDebugRequested(process.argv, process.env);
  if (fromNpm) {
    console.warn(
      'Note: --debug was picked up from npm (npm_config_debug). Use "npm run tours -- --debug" next time.'
    );
  }

  // Fail fast on a malformed watchlist, before any crawling.
  let config: BandsConfig;
  try {
    config = parseBandsConfig(await fs.readFile(bandsFile, 'utf-8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      console.error(
        `Error: ${bandsFile} not found. Copy bands.example.yaml to bands.yaml and edit it.`
      );
      process.exit(1);
    }
    console.error(
      `Error reading bands config: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }

  const env = loadCrawlerEnv();
  let sources = activeSources(config);
  if (sources.length === 0) {
    console.warn(`No active sources in ${bandsFile} — nothing to do`);
    process.exit(0);
  }
  if (process.argv.includes('--retry-failed')) {
    // Only the sources that failed (or had failed shows) in the last live run.
    const selection = selectRetrySources(
      sources,
      await readRunRecords(defaultLogsDir())
    );
    if (selection.noPreviousRun) {
      console.error(
        'Error: --retry-failed needs a previous live tours run, but logs/runs.jsonl has none (debug runs are not logged).'
      );
      process.exit(1);
    }
    for (const url of selection.missing) {
      console.warn(
        `Skipping ${url}: failed last time but is no longer an active source`
      );
    }
    if (selection.sources.length === 0) {
      console.log(
        `Nothing to retry: no source failed in the last tours run (${selection.basedOn ?? 'unknown time'}).`
      );
      process.exit(0);
    }
    console.log(
      `Retrying ${selection.sources.length} of ${sources.length} source(s) that failed in the run of ${selection.basedOn ?? 'unknown time'}`
    );
    sources = selection.sources;
  }
  console.log(
    `Tours: ${sources.length} source(s), ${activeBands(config).length} active band(s)${debug ? ' (DEBUG: nothing is published)' : ''}`
  );
  console.log(`API: ${env.apiUrl}`);
  if (!debug) {
    console.log(
      `⚠ LIVE RUN — publishing to ${env.apiUrl} (use "npm run tours -- --debug" for a dry run)`
    );
  }

  const defaultBrowser =
    (process.env.BROWSER_ENGINE as BrowserEngine) || 'chrome';
  const results: TourSourceResult[] = [];

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    console.log(`\n[${i + 1}/${sources.length}] ${source.url}`);
    try {
      const crawler = new EventCrawler({
        llm: buildLLM(source.model),
        keypair: { privkey: env.privkey, pubkey: env.pubkey },
        apiUrl: env.apiUrl,
        mode: 'direct',
        fetcher: source.fetcher ?? 'playwright',
        browserEngine: source.browser ?? defaultBrowser,
        jinaKey: env.jinaKey,
        braveSearchKey: env.braveSearchKey,
        debug,
        normalize: debug,
      });
      results.push(...(await crawler.crawlTourSources([source], config)));
    } catch (error) {
      console.error(
        `  Error: ${error instanceof Error ? error.message : error}`
      );
      results.push({ url: source.url, outcome: 'failed', shows: [] });
    }
  }

  const finishedAt = new Date();
  const record = buildTourRunRecord(results, startedAt, finishedAt);

  if (debug) {
    console.log(
      `\nTours debug run complete (nothing was published): ${record.published} shows extracted, ${record.unmatched} unmatched, ${record.skipped_past} past, ${record.skipped_out_of_region} out of region, ${record.failed} failed`
    );
  } else {
    console.log(
      `\nTours complete: ${record.published} published, ${record.updated} updated, ${record.unchanged} unchanged, ${record.unmatched} unmatched, ${record.skipped_past} past, ${record.skipped_out_of_region} out of region, ${record.failed} failed`
    );
  }

  if (!debug) {
    const logsDir = defaultLogsDir();
    await appendRunLog(logsDir, record);
    const stale = findStaleSources(
      await readRunRecords(logsDir),
      sources.map(s => s.url),
      'tours'
    );
    if (stale.length > 0) {
      console.log(
        `\nNo published/updated/unchanged result in the last ${STALE_WINDOW} runs (dead source, or a band with no upcoming shows):`
      );
      for (const url of stale) console.log(`  - ${url}`);
    }
  }

  if (record.failed > 0 || record.status === 'failed') process.exit(1);
}

// Only run when executed directly, not when imported as a module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
