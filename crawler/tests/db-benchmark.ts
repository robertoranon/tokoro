#!/usr/bin/env node

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { HTMLFetcher } from '../src/extractors/html-fetcher.js';
import { JinaFetcher } from '../src/extractors/jina-fetcher.js';
import { EventExtractor } from '../src/extractors/event-extractor.js';
import { TestEvaluator } from './evaluator.js';
import { TestFixtureMetadata } from './types.js';
import { createLLMProvider } from '../../shared/llm/factory.js';
import { ExtractedEvent } from '../src/types/event.js';
import { LLMProvider } from '../../shared/types/llm.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DbEvent {
  id: string;
  title: string;
  url: string;
  start_time: string;
  category: string;
  venue_name: string | null;
}

type FetcherMode = 'playwright' | 'jina' | 'both';

interface CliArgs {
  limit: number;
  db: string;
  output: string;
  wranglerConfig: string;
  idsFile?: string;
  fetcher: FetcherMode;
}

interface ExtractionResult {
  fetcher: 'playwright' | 'jina';
  extractedEvents: ExtractedEvent[];
  match: boolean;
  fieldCompleteness: number;
  executionMs: number;
  error?: string;
}

// ─── CLI args ────────────────────────────────────────────────────────────────

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    limit: 50,
    db: 'tokoro-db',
    output: path.join(process.cwd(), 'tests', 'benchmark-results'),
    wranglerConfig: path.join(process.cwd(), '..', 'worker', 'wrangler.toml'),
    fetcher: 'both',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      const n = parseInt(args[++i], 10);
      if (isNaN(n) || n <= 0)
        throw new Error(`--limit must be a positive integer, got: ${args[i]}`);
      result.limit = n;
    } else if (args[i] === '--db' && args[i + 1]) result.db = args[++i];
    else if (args[i] === '--output' && args[i + 1])
      result.output = path.resolve(args[++i]);
    else if (args[i] === '--config' && args[i + 1])
      result.wranglerConfig = path.resolve(args[++i]);
    else if (args[i] === '--ids' && args[i + 1])
      result.idsFile = path.resolve(args[++i]);
    else if (args[i] === '--fetcher' && args[i + 1]) {
      const v = args[++i];
      if (v !== 'playwright' && v !== 'jina' && v !== 'both') {
        throw new Error(
          `--fetcher must be one of: playwright, jina, both. Got: ${v}`
        );
      }
      result.fetcher = v;
    }
  }
  return result;
}

// ─── .env loader ─────────────────────────────────────────────────────────────

async function loadEnv(): Promise<void> {
  try {
    const envPath = path.join(process.cwd(), '.env');
    const content = await fs.readFile(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length) {
          process.env[key.trim()] = valueParts.join('=').trim();
        }
      }
    }
  } catch {
    console.warn('No .env file found, using environment variables');
  }
}

// ─── D1 query ─────────────────────────────────────────────────────────────────

function queryD1(db: string, configPath: string, limit: number): DbEvent[] {
  const sql = `SELECT id, title, url, start_time, category, venue_name FROM events WHERE url IS NOT NULL AND url != '' ORDER BY start_time DESC LIMIT ${limit}`;
  const result = spawnSync(
    'wrangler',
    [
      'd1',
      'execute',
      db,
      '--command',
      sql,
      '--json',
      '--remote',
      '--config',
      configPath,
    ],
    { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
  );
  if (result.error) {
    throw new Error(`wrangler not found on PATH: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed:\n${result.stderr}`);
  }
  const jsonMatch = result.stdout.match(/\[[\s\S]*\]/);
  if (!jsonMatch)
    throw new Error(`No JSON in wrangler output:\n${result.stdout}`);
  const parsed = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed) || !parsed[0]?.results) {
    throw new Error(`Unexpected wrangler response shape:\n${result.stdout}`);
  }
  return parsed[0].results as DbEvent[];
}

function queryD1ByIds(
  db: string,
  configPath: string,
  ids: string[]
): DbEvent[] {
  const placeholders = ids.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
  const sql = `SELECT id, title, url, start_time, category, venue_name FROM events WHERE url IS NOT NULL AND url != '' AND id IN (${placeholders})`;
  const result = spawnSync(
    'wrangler',
    [
      'd1',
      'execute',
      db,
      '--command',
      sql,
      '--json',
      '--remote',
      '--config',
      configPath,
    ],
    { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
  );
  if (result.error) {
    throw new Error(`wrangler not found on PATH: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed:\n${result.stderr}`);
  }
  const jsonMatch = result.stdout.match(/\[[\s\S]*\]/);
  if (!jsonMatch)
    throw new Error(`No JSON in wrangler output:\n${result.stdout}`);
  const parsed = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed) || !parsed[0]?.results) {
    throw new Error(`Unexpected wrangler response shape:\n${result.stdout}`);
  }
  return parsed[0].results as DbEvent[];
}

// ─── Extraction helpers ───────────────────────────────────────────────────────

interface UrlFetchResult {
  extractedEvents: ExtractedEvent[];
  executionMs: number;
  error?: string;
}

async function fetchAndExtract(
  url: string,
  fetcher: 'playwright' | 'jina',
  htmlFetcher: HTMLFetcher,
  jinaFetcher: JinaFetcher,
  extractor: EventExtractor
): Promise<UrlFetchResult> {
  const start = Date.now();
  try {
    const page =
      fetcher === 'playwright'
        ? await htmlFetcher.fetchPage(url)
        : await jinaFetcher.fetchPage(url);
    const extractedEvents = await extractor.extractEvents(page);
    return { extractedEvents, executionMs: Date.now() - start };
  } catch (err: any) {
    return {
      extractedEvents: [],
      executionMs: Date.now() - start,
      error: err?.message ?? String(err),
    };
  }
}

async function matchDbEvent(
  dbEvent: DbEvent,
  fetchResult: UrlFetchResult,
  fetcher: 'playwright' | 'jina',
  evaluator: TestEvaluator,
  llm: LLMProvider
): Promise<ExtractionResult> {
  if (fetchResult.error) {
    return {
      fetcher,
      extractedEvents: [],
      match: false,
      fieldCompleteness: 0,
      executionMs: fetchResult.executionMs,
      error: fetchResult.error,
    };
  }
  const mockMetadata: TestFixtureMetadata = {
    url: dbEvent.url,
    capturedAt: new Date().toISOString(),
    expectedEvents: [
      {
        title: dbEvent.title,
        start_time: dbEvent.start_time,
        venue_name: dbEvent.venue_name ?? undefined,
        url: dbEvent.url,
        // lat/lng intentionally omitted: listing pages don't embed coordinates,
        // so we can't expect the extractor to reproduce them. Venue name match
        // is sufficient to infer whether geocoding can be reused or not.
      },
    ],
    minExpectedEvents: 1,
    maxExpectedEvents: 1,
  };
  try {
    const metrics = await evaluator.calculateMetrics(
      fetchResult.extractedEvents,
      mockMetadata,
      llm
    );
    return {
      fetcher,
      extractedEvents: fetchResult.extractedEvents,
      match: metrics.expectedEventsFound > 0,
      fieldCompleteness: metrics.fieldCompleteness,
      executionMs: fetchResult.executionMs,
    };
  } catch (err: any) {
    return {
      fetcher,
      extractedEvents: fetchResult.extractedEvents,
      match: false,
      fieldCompleteness: 0,
      executionMs: fetchResult.executionMs,
      error: err?.message ?? String(err),
    };
  }
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────

const CSV_HEADER = [
  'event_id',
  'fetcher',
  'db_title',
  'db_url',
  'db_start_time',
  'db_category',
  'db_venue',
  'match',
  'events_extracted',
  'best_match_title',
  'best_match_start_time',
  'best_match_venue',
  'field_completeness',
  'execution_ms',
  'error',
].join(',');

function csvEscape(
  value: string | number | boolean | null | undefined
): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (
    s.includes(',') ||
    s.includes('"') ||
    s.includes('\n') ||
    s.includes('\r')
  ) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function pickBestMatch(
  dbTitle: string,
  extractedEvents: ExtractionResult['extractedEvents']
): ExtractionResult['extractedEvents'][0] | undefined {
  if (extractedEvents.length === 0) return undefined;
  if (extractedEvents.length === 1) return extractedEvents[0];
  const norm = (s: string) => s.toLowerCase().trim();
  const target = norm(dbTitle);
  // Prefer exact containment, fall back to first
  const match = extractedEvents.find(
    e => norm(e.title).includes(target) || target.includes(norm(e.title))
  );
  return match ?? extractedEvents[0];
}

function toCsvRow(dbEvent: DbEvent, result: ExtractionResult): string {
  const best = pickBestMatch(dbEvent.title, result.extractedEvents);
  return [
    dbEvent.id,
    result.fetcher,
    dbEvent.title,
    dbEvent.url,
    dbEvent.start_time,
    dbEvent.category,
    dbEvent.venue_name ?? '',
    result.match,
    result.extractedEvents.length,
    best?.title ?? '',
    best?.start_time ?? '',
    best?.venue_name ?? '',
    result.fieldCompleteness.toFixed(3),
    result.executionMs,
    result.error ?? '',
  ]
    .map(csvEscape)
    .join(',');
}

// ─── Report types and helpers ─────────────────────────────────────────────────

interface FetcherStats {
  attempted: number;
  matched: number;
  errors: number;
  recall: number;
  errorRate: number;
  avgEventsExtracted: number;
  avgFieldCompleteness: number;
  avgExecutionMs: number;
}

interface BenchmarkReport {
  generatedAt: string;
  sampleSize: {
    eventsAttempted: number;
  };
  playwright?: FetcherStats;
  jina?: FetcherStats;
  comparison?: {
    recallDelta: number; // playwright - jina
    playwrightOnlyMatches: number;
    jinaOnlyMatches: number;
  };
}

function computeStats(results: ExtractionResult[]): FetcherStats {
  const attempted = results.length;
  const matched = results.filter(r => r.match).length;
  const errors = results.filter(r => !!r.error).length;
  const matchedResults = results.filter(r => r.match);
  return {
    attempted,
    matched,
    errors,
    recall: attempted > 0 ? matched / attempted : 0,
    errorRate: attempted > 0 ? errors / attempted : 0,
    avgEventsExtracted:
      attempted > 0
        ? results.reduce((s, r) => s + r.extractedEvents.length, 0) / attempted
        : 0,
    avgFieldCompleteness:
      matchedResults.length > 0
        ? matchedResults.reduce((s, r) => s + r.fieldCompleteness, 0) /
          matchedResults.length
        : 0,
    avgExecutionMs:
      attempted > 0
        ? results.reduce((s, r) => s + r.executionMs, 0) / attempted
        : 0,
  };
}

function buildReport(
  allResults: Array<{
    dbEvent: DbEvent;
    playwright?: ExtractionResult;
    jina?: ExtractionResult;
  }>
): BenchmarkReport {
  const pwResults = allResults
    .map(r => r.playwright)
    .filter((r): r is ExtractionResult => r !== undefined);
  const jinaResults = allResults
    .map(r => r.jina)
    .filter((r): r is ExtractionResult => r !== undefined);

  const pwStats = pwResults.length > 0 ? computeStats(pwResults) : undefined;
  const jinaStats =
    jinaResults.length > 0 ? computeStats(jinaResults) : undefined;

  const comparison =
    pwStats && jinaStats
      ? {
          recallDelta: pwStats.recall - jinaStats.recall,
          playwrightOnlyMatches: allResults.filter(
            r => r.playwright?.match && !r.jina?.match
          ).length,
          jinaOnlyMatches: allResults.filter(
            r => !r.playwright?.match && r.jina?.match
          ).length,
        }
      : undefined;

  return {
    generatedAt: new Date().toISOString(),
    sampleSize: { eventsAttempted: allResults.length },
    playwright: pwStats,
    jina: jinaStats,
    comparison,
  };
}

function printReport(report: BenchmarkReport): void {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const ms = (n: number) => `${Math.round(n)}ms`;

  console.log('\n' + '═'.repeat(60));
  console.log('BENCHMARK REPORT');
  console.log('═'.repeat(60));
  console.log(`Sample: ${report.sampleSize.eventsAttempted} events\n`);

  for (const [name, stats] of [
    ['playwright', report.playwright],
    ['jina', report.jina],
  ] as const) {
    if (!stats) continue;
    console.log(`${name.toUpperCase()}`);
    console.log(
      `  Recall:               ${pct(stats.recall)} (${stats.matched}/${stats.attempted})`
    );
    console.log(
      `  Error rate:           ${pct(stats.errorRate)} (${stats.errors} errors)`
    );
    console.log(
      `  Avg events extracted: ${stats.avgEventsExtracted.toFixed(1)}`
    );
    console.log(
      `  Avg field completeness (matched): ${pct(stats.avgFieldCompleteness)}`
    );
    console.log(`  Avg execution time:   ${ms(stats.avgExecutionMs)}`);
    console.log();
  }

  if (report.comparison) {
    console.log('COMPARISON');
    const delta = report.comparison.recallDelta;
    const winner = delta > 0 ? 'playwright' : delta < 0 ? 'jina' : 'tie';
    console.log(
      `  Recall delta (playwright − jina): ${delta >= 0 ? '+' : ''}${pct(delta)}`
    );
    if (winner !== 'tie') console.log(`  Winner: ${winner}`);
    console.log(
      `  Playwright matched, jina didn't: ${report.comparison.playwrightOnlyMatches}`
    );
    console.log(
      `  Jina matched, playwright didn't: ${report.comparison.jinaOnlyMatches}`
    );
  }
  console.log('═'.repeat(60) + '\n');
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await loadEnv();
  const args = parseArgs();

  console.log('\n🔍 Crawler DB Benchmark\n');
  console.log(`  DB:      ${args.db}`);
  console.log(`  Limit:   ${args.limit} events`);
  console.log(`  Fetcher: ${args.fetcher}`);
  console.log(`  Output:  ${args.output}\n`);

  console.log('Querying D1...');
  let events: DbEvent[];
  if (args.idsFile) {
    const idsContent = await fs.readFile(args.idsFile, 'utf-8');
    const ids = idsContent
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);
    if (ids.length === 0)
      throw new Error(`No event IDs found in ${args.idsFile}`);
    console.log(`  Using ${ids.length} IDs from ${args.idsFile}`);
    events = queryD1ByIds(args.db, args.wranglerConfig, ids);
  } else {
    events = queryD1(args.db, args.wranglerConfig, args.limit);
  }
  console.log(`Fetched ${events.length} events with URLs\n`);

  await fs.mkdir(args.output, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const csvPath = path.join(args.output, `benchmark-${timestamp}.csv`);
  await fs.writeFile(csvPath, CSV_HEADER + '\n', 'utf-8');
  console.log(`CSV: ${csvPath}\n`);

  const llm = createLLMProvider({
    provider: (process.env.LLM_PROVIDER || 'openrouter') as any,
    apiKey:
      process.env.OPENROUTER_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY,
    model: process.env.OPENROUTER_MODEL || process.env.LLM_MODEL,
  });

  const htmlFetcher = new HTMLFetcher();
  const jinaFetcher = new JinaFetcher(process.env.JINA_API_KEY);
  const evaluator = new TestEvaluator();
  const extractor = new EventExtractor({ llm, filterPastEvents: false });

  // Group DB events by URL to avoid redundant fetches
  const urlToEvents = new Map<string, DbEvent[]>();
  for (const ev of events) {
    const arr = urlToEvents.get(ev.url) ?? [];
    arr.push(ev);
    urlToEvents.set(ev.url, arr);
  }
  const uniqueUrls = [...urlToEvents.keys()];
  console.log(
    `Unique URLs: ${uniqueUrls.length} (covering ${events.length} events)\n`
  );

  const runPlaywright =
    args.fetcher === 'playwright' || args.fetcher === 'both';
  const runJina = args.fetcher === 'jina' || args.fetcher === 'both';

  // Phase 1: fetch and extract from each unique URL
  console.log('Phase 1: Fetching and extracting events from unique URLs...\n');
  const urlFetchResults = new Map<
    string,
    { playwright?: UrlFetchResult; jina?: UrlFetchResult }
  >();

  try {
    if (runPlaywright) await htmlFetcher.initialize();
    for (let i = 0; i < uniqueUrls.length; i++) {
      const url = uniqueUrls[i];
      const dbEventsForUrl = urlToEvents.get(url)!;
      console.log(`\n[${i + 1}/${uniqueUrls.length}] ${url}`);
      if (dbEventsForUrl.length > 1) {
        console.log(
          `  (covers ${dbEventsForUrl.length} DB events: ${dbEventsForUrl.map(e => e.title).join(', ')})`
        );
      }

      const entry: { playwright?: UrlFetchResult; jina?: UrlFetchResult } = {};

      if (runPlaywright) {
        const pw = await fetchAndExtract(
          url,
          'playwright',
          htmlFetcher,
          jinaFetcher,
          extractor
        );
        console.log(
          `  playwright: ${pw.extractedEvents.length} events extracted, ${pw.executionMs}ms${pw.error ? ' ERROR: ' + pw.error : ''}`
        );
        entry.playwright = pw;
      }

      if (runJina) {
        const jina = await fetchAndExtract(
          url,
          'jina',
          htmlFetcher,
          jinaFetcher,
          extractor
        );
        console.log(
          `  jina:       ${jina.extractedEvents.length} events extracted, ${jina.executionMs}ms${jina.error ? ' ERROR: ' + jina.error : ''}`
        );
        entry.jina = jina;
      }

      urlFetchResults.set(url, entry);
    }
  } finally {
    if (runPlaywright) {
      await htmlFetcher
        .close()
        .catch((err: any) =>
          console.warn('Warning: browser close error:', err?.message ?? err)
        );
    }
  }

  // Phase 2: match each DB event against its URL's cached extraction results
  console.log('\nPhase 2: Matching DB events against extracted events...\n');
  const allResults: Array<{
    dbEvent: DbEvent;
    playwright?: ExtractionResult;
    jina?: ExtractionResult;
  }> = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const fetchResults = urlFetchResults.get(ev.url)!;
    console.log(`\n[${i + 1}/${events.length}] ${ev.title}`);

    const entry: {
      dbEvent: DbEvent;
      playwright?: ExtractionResult;
      jina?: ExtractionResult;
    } = { dbEvent: ev };

    if (runPlaywright && fetchResults.playwright) {
      const pw = await matchDbEvent(
        ev,
        fetchResults.playwright,
        'playwright',
        evaluator,
        llm
      );
      console.log(
        `  playwright: ${pw.match ? '✓ match' : '✗ no match'} (${pw.extractedEvents.length} events)${pw.error ? ' ERROR: ' + pw.error : ''}`
      );
      entry.playwright = pw;
      await fs.appendFile(csvPath, toCsvRow(ev, pw) + '\n', 'utf-8');
    }

    if (runJina && fetchResults.jina) {
      const jina = await matchDbEvent(
        ev,
        fetchResults.jina,
        'jina',
        evaluator,
        llm
      );
      console.log(
        `  jina:       ${jina.match ? '✓ match' : '✗ no match'} (${jina.extractedEvents.length} events)${jina.error ? ' ERROR: ' + jina.error : ''}`
      );
      entry.jina = jina;
      await fs.appendFile(csvPath, toCsvRow(ev, jina) + '\n', 'utf-8');
    }

    allResults.push(entry);
  }

  const report = buildReport(allResults);
  printReport(report);

  const jsonPath = path.join(args.output, `benchmark-${timestamp}.json`);
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`Report saved to: ${jsonPath}`);
  console.log(`CSV saved to:    ${csvPath}\n`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
