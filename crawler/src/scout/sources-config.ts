import yaml from 'js-yaml';
import type { FetcherType, BrowserEngine } from '../crawler.js';

export interface ScoutSource {
  name: string;
  /** Kept verbatim (including any query string) — listing pages may need it. */
  url: string;
  fetcher?: FetcherType;
  browser?: BrowserEngine;
  model?: string;
}

export interface ScoutConfig {
  /** The curator's relevance filter, injected into the scout prompt. */
  taste: string;
  sources: ScoutSource[];
}

const FETCHERS = ['playwright', 'jina'] as const;
const BROWSERS = ['chrome', 'obscura'] as const;

function bad(message: string): never {
  throw new Error(`Invalid scout-sources.yaml: ${message}`);
}

function pick<T extends string>(
  value: unknown,
  valid: readonly T[],
  label: string,
  field: string
): T | undefined {
  if (value === undefined) return undefined;
  if (!valid.includes(value as T)) {
    bad(
      `${label} has invalid ${field} "${value}". Must be: ${valid.join(', ')}`
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
    bad(`${label} has invalid ${field}: expected a string`);
  }
  return value;
}

export function parseScoutConfig(content: string): ScoutConfig {
  const raw = yaml.load(content);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    bad('expected a YAML object at root');
  }
  const cfg = raw as Record<string, unknown>;

  const taste =
    typeof cfg.taste === 'string' ? cfg.taste.trim().replace(/\s+/g, ' ') : '';
  if (!taste) bad('"taste" must be a non-empty string');

  // `sources:` with no value (null) is an empty list; a missing key is an error.
  if (cfg.sources !== null && !Array.isArray(cfg.sources)) {
    bad('"sources" must be an array');
  }

  const seen = new Set<string>();
  const sources = ((cfg.sources as unknown[] | null) ?? []).map(
    (item, i): ScoutSource => {
      if (!item || typeof item !== 'object') {
        bad(`source ${i + 1} must be an object`);
      }
      const s = item as Record<string, unknown>;
      const label =
        typeof s.name === 'string' && s.name
          ? `"${s.name}"`
          : `source ${i + 1}`;

      if (typeof s.url !== 'string' || !s.url)
        bad(`${label} must have a "url"`);
      let parsed: URL;
      try {
        parsed = new URL(s.url as string);
      } catch {
        return bad(`${label} has an invalid url "${s.url}"`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        bad(`${label} url must be http(s): "${s.url}"`);
      }
      if (seen.has(s.url as string)) bad(`duplicate source url ${s.url}`);
      seen.add(s.url as string);

      return {
        name: optionalString(s.name, label, 'name') || parsed.hostname,
        url: s.url as string,
        fetcher: pick(s.fetcher, FETCHERS, label, 'fetcher'),
        browser: pick(s.browser, BROWSERS, label, 'browser'),
        model: optionalString(s.model, label, 'model'),
      };
    }
  );

  return { taste, sources };
}
