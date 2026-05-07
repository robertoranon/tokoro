import * as fs from 'fs/promises';
import * as path from 'path';
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
  }
  return cfg as unknown as SchedulerConfig;
}
