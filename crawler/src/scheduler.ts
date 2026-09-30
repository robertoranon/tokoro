import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import {
  EventCrawler,
  CrawlerMode,
  FetcherType,
  BrowserEngine,
  PdfParserType,
  CrawlResult,
} from './crawler.js';
import { loadEnv, loadCrawlerEnv, buildLLM } from './setup.js';
import { appendRunLog, defaultLogsDir } from './utils/run-log.js';

export interface SchedulerJob {
  name?: string;
  urls: string[];
  mode?: CrawlerMode;
  fetcher?: FetcherType;
  browser?: BrowserEngine;
  model?: string;
  date?: string;
  max_tokens?: number;
  no_jsonld?: boolean;
  group_by_day?: boolean;
  pdf_parser?: PdfParserType;
  debug?: boolean;
  normalize?: boolean;
}

export interface SchedulerConfig {
  cron?: string;
  jobs: SchedulerJob[];
}

export function parseJobsConfig(content: string): SchedulerConfig {
  const raw = yaml.load(content);
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid jobs.yaml: expected a YAML object at root');
  }
  const cfg = raw as Record<string, unknown>;
  if (!Array.isArray(cfg.jobs)) {
    throw new Error('Invalid jobs.yaml: "jobs" must be an array');
  }
  for (const job of cfg.jobs) {
    if (!job || typeof job !== 'object') {
      throw new Error('Invalid jobs.yaml: each job must be an object');
    }
    const j = job as Record<string, unknown>;
    const label = j.name ? `"${j.name}"` : 'unnamed';
    if (!Array.isArray(j.urls) || (j.urls as unknown[]).length === 0) {
      throw new Error(
        `Invalid jobs.yaml: job ${label} must have a non-empty "urls" array`
      );
    }

    const validModes = [
      'direct',
      'discover',
      'image',
      'festival',
      'pdf',
      'festival-entry',
    ];
    if (j.mode !== undefined && !validModes.includes(j.mode as string)) {
      throw new Error(
        `Invalid jobs.yaml: job ${label} has invalid mode "${j.mode}". Must be: ${validModes.join(', ')}`
      );
    }

    const validFetchers = ['playwright', 'jina'];
    if (
      j.fetcher !== undefined &&
      !validFetchers.includes(j.fetcher as string)
    ) {
      throw new Error(
        `Invalid jobs.yaml: job ${label} has invalid fetcher "${j.fetcher}". Must be: ${validFetchers.join(', ')}`
      );
    }

    const validBrowsers = ['chrome', 'obscura'];
    if (
      j.browser !== undefined &&
      !validBrowsers.includes(j.browser as string)
    ) {
      throw new Error(
        `Invalid jobs.yaml: job ${label} has invalid browser "${j.browser}". Must be: ${validBrowsers.join(', ')}`
      );
    }

    const validPdfParsers = ['pdfjs', 'liteparse'];
    if (
      j.pdf_parser !== undefined &&
      !validPdfParsers.includes(j.pdf_parser as string)
    ) {
      throw new Error(
        `Invalid jobs.yaml: job ${label} has invalid pdf_parser "${j.pdf_parser}". Must be: ${validPdfParsers.join(', ')}`
      );
    }
  }
  return cfg as unknown as SchedulerConfig;
}

interface JobRunRecord {
  name: string;
  status: 'ok' | 'failed';
  published: number;
  duplicate: number;
  failed: number;
}

async function main() {
  const startedAt = new Date();

  await loadEnv();

  let jobsFile = path.join(process.cwd(), 'jobs.yaml');
  const jobsIndex = process.argv.indexOf('--jobs');
  if (jobsIndex !== -1 && process.argv[jobsIndex + 1]) {
    jobsFile = path.resolve(process.argv[jobsIndex + 1]);
  }

  let config: SchedulerConfig;
  try {
    const content = await fs.readFile(jobsFile, 'utf-8');
    config = parseJobsConfig(content);
  } catch (error) {
    console.error(
      `Error reading jobs config: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }

  const env = loadCrawlerEnv();
  const { jobs } = config;

  console.log(`Running ${jobs.length} job${jobs.length === 1 ? '' : 's'}...`);

  let succeeded = 0;
  let failed = 0;
  const jobRecords: JobRunRecord[] = [];
  const totals: CrawlResult = { published: 0, duplicate: 0, failed: 0 };

  const defaultBrowserEngine =
    (process.env.BROWSER_ENGINE as BrowserEngine) || 'chrome';

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const label = job.name ? `"${job.name}"` : `job ${i + 1}`;
    console.log(`\n[${i + 1}/${jobs.length}] Running ${label}`);

    let jobResult: CrawlResult = { published: 0, duplicate: 0, failed: 0 };
    let jobStatus: 'ok' | 'failed' = 'ok';

    try {
      const llm = buildLLM(job.model);

      const crawler = new EventCrawler({
        llm,
        keypair: { privkey: env.privkey, pubkey: env.pubkey },
        apiUrl: env.apiUrl,
        mode: job.mode ?? 'direct',
        fetcher: job.fetcher ?? 'playwright',
        browserEngine: job.browser ?? defaultBrowserEngine,
        jinaKey: env.jinaKey,
        debug: job.debug,
        normalize: job.normalize,
        referenceDate: job.date,
        useJsonLd: !job.no_jsonld,
        maxTokens: job.max_tokens,
        groupByDay: job.group_by_day,
        pdfParser: job.pdf_parser,
      });

      jobResult = await crawler.crawl(job.urls);
      succeeded++;
    } catch (error) {
      console.error(
        `  Error: ${error instanceof Error ? error.message : error}`
      );
      failed++;
      jobStatus = 'failed';
    }

    jobRecords.push({
      name: job.name ?? `job ${i + 1}`,
      status: jobStatus,
      published: jobResult.published,
      duplicate: jobResult.duplicate,
      failed: jobResult.failed,
    });
    totals.published += jobResult.published;
    totals.duplicate += jobResult.duplicate;
    totals.failed += jobResult.failed;
  }

  const finishedAt = new Date();
  const durationS =
    Math.round(((finishedAt.getTime() - startedAt.getTime()) / 1000) * 10) / 10;
  const status = failed === 0 ? 'ok' : succeeded === 0 ? 'failed' : 'partial';

  console.log(`\nCompleted: ${succeeded} succeeded, ${failed} failed`);
  console.log(
    `Events: ${totals.published} published, ${totals.duplicate} duplicates skipped, ${totals.failed} failed`
  );

  await appendRunLog(defaultLogsDir(), {
    kind: 'jobs',
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_s: durationS,
    jobs_total: jobs.length,
    succeeded,
    failed,
    status,
    events_published: totals.published,
    events_duplicate: totals.duplicate,
    events_failed: totals.failed,
    jobs: jobRecords,
  });

  if (failed > 0) process.exit(1);
}

// Only run when executed directly, not when imported as a module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
