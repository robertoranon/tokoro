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
} from './crawler.js';
import { loadEnv, loadCrawlerEnv, buildLLM } from './setup.js';

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

    const validModes = ['direct', 'discover', 'image', 'festival', 'pdf'];
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

async function main() {
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

  const defaultBrowserEngine =
    (process.env.BROWSER_ENGINE as BrowserEngine) || 'chrome';

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const label = job.name ? `"${job.name}"` : `job ${i + 1}`;
    console.log(`\n[${i + 1}/${jobs.length}] Running ${label}`);

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

      await crawler.crawl(job.urls);
      succeeded++;
    } catch (error) {
      console.error(
        `  Error: ${error instanceof Error ? error.message : error}`
      );
      failed++;
    }
  }

  console.log(`\nCompleted: ${succeeded} succeeded, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// Only run when executed directly, not when imported as a module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
