import yaml from 'js-yaml';
import type { FetcherType, BrowserEngine } from '../crawler.js';
import { normalizeFestivalUrl } from '../radar/festivals-config.js';

export interface Region {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface BandConfig {
  name: string;
  /** Canonical band site; becomes the show's `act_url` (see normalizeActUrl). */
  url: string;
  aliases?: string[];
  /** undefined → use defaults.region; null → "region: none" (worldwide). */
  region?: Region | null;
  status: 'active' | 'paused';
  added?: string; // YYYY-MM-DD, bookkeeping only
  notes?: string; // curator notes; never sent to the LLM or API
}

interface SourceBase {
  url: string;
  fetcher?: FetcherType;
  browser?: BrowserEngine;
  model?: string;
}
export interface BandSource extends SourceBase {
  mode: 'band';
  band: string; // name of a registry band
}
export interface ListingSource extends SourceBase {
  mode: 'listing';
  only?: string[]; // names of registry bands; default: the whole registry
}
export type TourSource = BandSource | ListingSource;

export interface BandsConfig {
  defaultRegion?: Region;
  bands: BandConfig[];
  sources: TourSource[];
}

const VALID_STATUSES = ['active', 'paused'] as const;
const VALID_MODES = ['band', 'listing'] as const;
const VALID_FETCHERS = ['playwright', 'jina'] as const;
const VALID_BROWSERS = ['chrome', 'obscura'] as const;

const fail = (msg: string): never => {
  throw new Error(`Invalid bands.yaml: ${msg}`);
};

/**
 * Canonical band site URL: same form as a festival_url (scheme + host + path,
 * no query/hash/trailing slash). The API filters `act_url` by exact match, so
 * the crawler must always send this normalized form.
 */
export function normalizeActUrl(raw: string): string {
  return normalizeFestivalUrl(raw);
}

function pick<T extends string>(
  value: unknown,
  valid: readonly T[],
  label: string,
  field: string
): T | undefined {
  if (value === undefined) return undefined;
  if (!valid.includes(value as T)) {
    fail(
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
    fail(`${label} has invalid ${field}: expected a string`);
  }
  return value as string;
}

function stringList(
  value: unknown,
  label: string,
  field: string
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.some(v => typeof v !== 'string' || !v.trim())
  ) {
    fail(`${label} has invalid ${field}: expected a list of non-empty strings`);
  }
  return (value as string[]).map(v => v.trim());
}

// js-yaml parses an unquoted `2026-10-06` into a Date.
function dateString(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === 'string' ? value : undefined;
}

function parseRegion(value: unknown, label: string): Region {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(
      `${label} region must be an object {south, west, north, east} or "none"`
    );
  }
  const r = value as Record<string, unknown>;
  for (const key of ['south', 'west', 'north', 'east']) {
    if (typeof r[key] !== 'number' || !isFinite(r[key] as number)) {
      fail(`${label} region.${key} must be a number`);
    }
  }
  const region = r as unknown as Region;
  if (region.south >= region.north) fail(`${label} region needs south < north`);
  if (region.west >= region.east) fail(`${label} region needs west < east`);
  if (region.south < -90 || region.north > 90)
    fail(`${label} region latitude out of range`);
  if (region.west < -180 || region.east > 180)
    fail(`${label} region longitude out of range`);
  return {
    south: region.south,
    west: region.west,
    north: region.north,
    east: region.east,
  };
}

export function parseBandsConfig(content: string): BandsConfig {
  const raw = yaml.load(content);
  if (!raw || typeof raw !== 'object') {
    return fail('expected a YAML object at root');
  }
  const cfg = raw as Record<string, unknown>;
  if (!('bands' in cfg) && !('sources' in cfg)) {
    return fail('expected "bands" and "sources" sections');
  }
  const rawBands = cfg.bands ?? [];
  const rawSources = cfg.sources ?? [];
  if (!Array.isArray(rawBands)) fail('"bands" must be an array');
  if (!Array.isArray(rawSources)) fail('"sources" must be an array');

  const defaults = (cfg.defaults ?? {}) as Record<string, unknown>;
  if (typeof defaults !== 'object' || Array.isArray(defaults)) {
    fail('"defaults" must be an object');
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
  const defaultRegion =
    defaults.region === undefined || defaults.region === null
      ? undefined
      : parseRegion(defaults.region, 'defaults');

  const names = new Set<string>();
  const bandUrls = new Set<string>();
  const bands = (rawBands as unknown[]).map((item, i): BandConfig => {
    if (!item || typeof item !== 'object')
      fail(`band ${i + 1} must be an object`);
    const b = item as Record<string, unknown>;
    const name = optionalString(b.name, `band ${i + 1}`, 'name');
    if (!name || !name.trim()) fail(`band ${i + 1} must have a "name"`);
    const label = `"${name}"`;
    if (typeof b.url !== 'string' || !b.url) fail(`${label} must have a "url"`);
    let url: string;
    try {
      url = normalizeActUrl(b.url as string);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return fail(`${label} has an invalid url "${b.url}" (${reason})`);
    }
    const nameKey = name!.trim().toLowerCase();
    if (names.has(nameKey)) fail(`duplicate band name ${label}`);
    names.add(nameKey);
    if (bandUrls.has(url)) fail(`duplicate band url ${url}`);
    bandUrls.add(url);

    let region: Region | null | undefined;
    if (b.region === 'none') region = null;
    else if (b.region !== undefined && b.region !== null)
      region = parseRegion(b.region, label);

    return {
      name: name!.trim(),
      url,
      aliases: stringList(b.aliases, label, 'aliases'),
      region,
      status: pick(b.status, VALID_STATUSES, label, 'status') ?? 'active',
      added: dateString(b.added),
      notes: optionalString(b.notes, label, 'notes'),
    };
  });

  const sourceUrls = new Set<string>();
  const sources = (rawSources as unknown[]).map((item, i): TourSource => {
    if (!item || typeof item !== 'object')
      fail(`source ${i + 1} must be an object`);
    const s = item as Record<string, unknown>;
    const label = `source ${i + 1}`;
    if (typeof s.url !== 'string' || !s.url) fail(`${label} must have a "url"`);
    let url: string;
    try {
      url = normalizeActUrl(s.url as string);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return fail(`${label} has an invalid url "${s.url}" (${reason})`);
    }
    // Sources are keyed by url (run log, staleness): the query string of a
    // listing page may matter, so keep the url as written but reject duplicates
    // on the normalized form.
    if (sourceUrls.has(url)) fail(`duplicate source url ${url}`);
    sourceUrls.add(url);

    const mode = pick(s.mode, VALID_MODES, label, 'mode');
    if (!mode) fail(`${label} must have a "mode" (${VALID_MODES.join(' | ')})`);
    const base = {
      url: s.url as string,
      fetcher:
        pick(s.fetcher, VALID_FETCHERS, label, 'fetcher') ?? defaultFetcher,
      browser:
        pick(s.browser, VALID_BROWSERS, label, 'browser') ?? defaultBrowser,
      model: optionalString(s.model, label, 'model') ?? defaultModel,
    };

    if (mode === 'band') {
      const band = optionalString(s.band, label, 'band');
      if (!band) fail(`${label} (mode: band) must name a "band"`);
      if (!names.has(band!.trim().toLowerCase())) {
        fail(`${label} references unknown band "${band}"`);
      }
      return { ...base, mode: 'band', band: band!.trim() };
    }

    const only = stringList(s.only, label, 'only');
    for (const n of only ?? []) {
      if (!names.has(n.toLowerCase()))
        fail(`${label} "only" names unknown band "${n}"`);
    }
    return { ...base, mode: 'listing', only };
  });

  return { defaultRegion, bands, sources };
}

export function activeBands(config: BandsConfig): BandConfig[] {
  return config.bands.filter(b => b.status === 'active');
}

/** A source is skipped when its band-mode band is paused. */
export function activeSources(config: BandsConfig): TourSource[] {
  const paused = new Set(
    config.bands
      .filter(b => b.status === 'paused')
      .map(b => b.name.toLowerCase())
  );
  return config.sources.filter(
    s => !(s.mode === 'band' && paused.has(s.band.toLowerCase()))
  );
}

/** The band's own region, else the default; `region: none` means worldwide. */
export function effectiveRegion(
  config: BandsConfig,
  band: BandConfig
): Region | undefined {
  if (band.region === null) return undefined;
  return band.region ?? config.defaultRegion;
}
