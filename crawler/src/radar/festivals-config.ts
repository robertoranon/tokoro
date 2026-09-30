import yaml from 'js-yaml';
import type { FetcherType, BrowserEngine } from '../crawler.js';

export interface FestivalEntryConfig {
  /** Canonical homepage; becomes the entry's `festival_url` (see normalizeFestivalUrl). */
  url: string;
  name?: string;
  status: 'active' | 'paused';
  added?: string; // YYYY-MM-DD, bookkeeping only
  notes?: string; // curator notes; never sent to the LLM or API
  fetcher?: FetcherType;
  browser?: BrowserEngine;
  model?: string;
}

export interface FestivalsConfig {
  festivals: FestivalEntryConfig[];
}

const VALID_STATUSES = ['active', 'paused'] as const;
const VALID_FETCHERS = ['playwright', 'jina'] as const;
const VALID_BROWSERS = ['chrome', 'obscura'] as const;

/**
 * Canonical form of a festival homepage URL: scheme + host + path, no query,
 * no hash, no trailing slash. The API stores and filters `festival_url` by
 * exact string match (after stripping one trailing slash), so the crawler must
 * always send this normalized form.
 */
export function normalizeFestivalUrl(raw: string): string {
  const u = new URL(raw); // throws on garbage
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Unsupported protocol in "${raw}"`);
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

function pick<T extends string>(
  value: unknown,
  valid: readonly T[],
  label: string,
  field: string
): T | undefined {
  if (value === undefined) return undefined;
  if (!valid.includes(value as T)) {
    throw new Error(
      `Invalid festivals.yaml: ${label} has invalid ${field} "${value}". Must be: ${valid.join(', ')}`
    );
  }
  return value as T;
}

function optionalString(
  value: unknown,
  label: string,
  field: string
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid festivals.yaml: ${label} has invalid ${field}: expected a string`
    );
  }
  return value;
}

// js-yaml parses an unquoted `2026-07-22` into a Date.
function dateString(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === 'string' ? value : undefined;
}

export function parseFestivalsConfig(content: string): FestivalsConfig {
  const raw = yaml.load(content);
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid festivals.yaml: expected a YAML object at root');
  }
  const cfg = raw as Record<string, unknown>;
  if (cfg.festivals === null) return { festivals: [] };
  if (!Array.isArray(cfg.festivals)) {
    throw new Error('Invalid festivals.yaml: "festivals" must be an array');
  }

  const defaults = (cfg.defaults ?? {}) as Record<string, unknown>;
  if (typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new Error('Invalid festivals.yaml: "defaults" must be an object');
  }
  const defaultFetcher = pick(
    defaults.fetcher,
    VALID_FETCHERS,
    'defaults',
    'fetcher'
  );
  const defaultBrowser = pick(
    defaults.browser,
    VALID_BROWSERS,
    'defaults',
    'browser'
  );
  const defaultModel = optionalString(defaults.model, 'defaults', 'model');

  const seen = new Set<string>();
  const festivals = cfg.festivals.map((item, i): FestivalEntryConfig => {
    if (!item || typeof item !== 'object') {
      throw new Error(
        `Invalid festivals.yaml: entry ${i + 1} must be an object`
      );
    }
    const f = item as Record<string, unknown>;
    const name = optionalString(f.name, `entry ${i + 1}`, 'name');
    const label = name ? `"${name}"` : `entry ${i + 1}`;

    if (typeof f.url !== 'string' || !f.url) {
      throw new Error(`Invalid festivals.yaml: ${label} must have a "url"`);
    }
    let url: string;
    try {
      url = normalizeFestivalUrl(f.url);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Invalid festivals.yaml: ${label} has an invalid url "${f.url}" (${reason})`
      );
    }
    if (seen.has(url)) {
      throw new Error(`Invalid festivals.yaml: duplicate url ${url}`);
    }
    seen.add(url);

    return {
      url,
      name,
      status: pick(f.status, VALID_STATUSES, label, 'status') ?? 'active',
      added: dateString(f.added),
      notes: optionalString(f.notes, label, 'notes'),
      fetcher:
        pick(f.fetcher, VALID_FETCHERS, label, 'fetcher') ?? defaultFetcher,
      browser:
        pick(f.browser, VALID_BROWSERS, label, 'browser') ?? defaultBrowser,
      model: optionalString(f.model, label, 'model') ?? defaultModel,
    };
  });

  return { festivals };
}

export function activeFestivals(
  config: FestivalsConfig
): FestivalEntryConfig[] {
  return config.festivals.filter(f => f.status === 'active');
}
