'use strict';

/**
 * Pure logic for the trip planner (no DOM). Loaded as a classic script in the
 * browser (window.TokoroTrips), inside a Web Worker (self.TokoroTrips) and via
 * require() in the Node tests. Standalone: it does not depend on tours.js or
 * festivals.js, so the helpers below are local copies.
 *
 * Dates are venue-local "YYYY-MM-DD" strings. Never feed them to `new Date()`
 * without UTC arithmetic.
 *
 * Part 1: the stops model. A stop is a place and a day range where at least
 * one followed band or festival is on.
 */

const RADII_KM = [25, 50, 100, 250, 500, 1000];
const DEFAULT_RADIUS_KM = 250;
const REGION_KM = [100, 250, 500, 1000];
const DEFAULT_REGION_KM = 500;
const DEFAULT_MIN_DAYS = 14;
const DEFAULT_MAX_DAYS = 21;
const MAX_TRIP_DAYS = 60;
const MAX_TRIPS = 5;
const MIN_SCORE = 2;
const SAME_PLACE_KM = 1; // shows this close on one day share a stop
const FESTIVAL_PLACE_KM = 5; // a show this close to a festival joins its stop
const BEAM_WIDTH = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const SOURCES = ['both', 'bands', 'festivals'];
const MODES = ['base', 'hops'];

/** Normalised site URL for matching: trimmed, lower-cased, no trailing slash. */
function urlKey(url) {
  return String(url || '')
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '');
}

/** Add `n` days to a "YYYY-MM-DD" string (UTC arithmetic, no timezone drift). */
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Whole days from `a` to `b` (b - a). */
function daysBetween(a, b) {
  const t = ymd => {
    const [y, m, d] = ymd.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((t(b) - t(a)) / DAY_MS);
}

function haversineKm(a, b) {
  const R = 6371;
  const rad = x => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}

function clampInt(raw, fallback, min, max) {
  const n = Number(raw);
  if (raw === null || raw === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Coerce untrusted settings (URL, storage) into a complete valid object. */
function validSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const minDays = clampInt(r.minDays, DEFAULT_MIN_DAYS, 1, MAX_TRIP_DAYS);
  const maxDays = Math.max(
    minDays,
    clampInt(r.maxDays, DEFAULT_MAX_DAYS, 1, MAX_TRIP_DAYS)
  );
  let region = null;
  const g = r.region;
  if (g && typeof g === 'object') {
    const lat = Number(g.lat);
    const lng = Number(g.lng);
    if (
      g.lat !== null &&
      g.lng !== null &&
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    ) {
      const km = REGION_KM.includes(Number(g.km))
        ? Number(g.km)
        : DEFAULT_REGION_KM;
      region = { lat, lng, km };
    }
  }
  return {
    source: SOURCES.includes(r.source) ? r.source : 'both',
    minDays,
    maxDays,
    mode: MODES.includes(r.mode) ? r.mode : 'base',
    radiusKm: RADII_KM.includes(Number(r.radiusKm))
      ? Number(r.radiusKm)
      : DEFAULT_RADIUS_KM,
    dayPasses: r.dayPasses === true,
    region,
  };
}

/** Days a show is on, clipped to today onwards (a range show spans start..end). */
function showDays(show, todayYmd) {
  const end = show.end && show.end >= show.start ? show.end : show.start;
  const days = [];
  for (let d = show.start; d <= end; d = addDays(d, 1)) {
    if (d >= todayYmd) days.push(d);
  }
  return days;
}

function validPoint(o) {
  return o && Number.isFinite(o.lat) && Number.isFinite(o.lng);
}

function stopOrder(a, b) {
  return (
    (a.start < b.start ? -1 : a.start > b.start ? 1 : 0) ||
    (a.end < b.end ? -1 : a.end > b.end ? 1 : 0) ||
    a.lat - b.lat ||
    a.lng - b.lng ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Build the stops for the followed bands and festivals.
 * `settings` is the output of validSettings.
 */
function buildStops({
  shows,
  festivals,
  followedBands,
  followedFestivals,
  todayYmd,
  settings,
}) {
  const bandSet = new Set((followedBands || []).map(urlKey));
  const festSet = new Set((followedFestivals || []).map(urlKey));
  const useBands = settings.source !== 'festivals';
  const useFests = settings.source !== 'bands';

  const followedShows = (shows || []).filter(
    s => bandSet.has(urlKey(s.bandUrl)) && validPoint(s)
  );
  // [day, show] pairs: a show is available on every day it runs
  const available = [];
  for (const s of followedShows) {
    for (const d of showDays(s, todayYmd)) available.push({ d, s });
  }
  // fixed order so a stop's anchor (its lat/lng) does not depend on input order
  available.sort((x, y) =>
    x.d !== y.d
      ? x.d < y.d
        ? -1
        : 1
      : x.s.id < y.s.id
        ? -1
        : x.s.id > y.s.id
          ? 1
          : 0
  );

  const festStops = [];
  if (useFests) {
    for (const f of festivals || []) {
      if (!festSet.has(urlKey(f.festivalUrl)) || !validPoint(f)) continue;
      const rawEnd = f.end && f.end >= f.start ? f.end : f.start;
      if (rawEnd < todayYmd) continue;
      const start = f.start < todayYmd ? todayYmd : f.start;
      const length = daysBetween(start, rawEnd) + 1;
      const ranges =
        !settings.dayPasses && length <= settings.maxDays
          ? [[start, rawEnd]]
          : Array.from({ length }, (_, i) => {
              const d = addDays(start, i);
              return [d, d];
            });
      for (const [a, b] of ranges) {
        const inside = new Map();
        if (useBands) {
          for (const { d, s } of available) {
            if (d >= a && d <= b && haversineKm(f, s) <= FESTIVAL_PLACE_KM)
              inside.set(s.id, s);
          }
        }
        const keys = ['fest:' + urlKey(f.festivalUrl)];
        for (const s of inside.values()) keys.push('band:' + urlKey(s.bandUrl));
        festStops.push({
          id: `fest:${f.id}:${a}:${b}`,
          start: a,
          end: b,
          lat: f.lat,
          lng: f.lng,
          venue: f.venue || '',
          address: f.address || '',
          fest: f,
          shows: [...inside.values()],
          keys: [...new Set(keys)].sort(),
        });
      }
    }
  }

  const showStops = [];
  if (useBands) {
    const seen = new Set();
    for (const { d, s } of available) {
      const group = available
        .filter(o => o.d === d && haversineKm(s, o.s) <= SAME_PLACE_KM)
        .map(o => o.s);
      const ids = [...new Set(group.map(g => g.id))].sort();
      const id = `show:${d}:${ids.join(',')}`;
      if (seen.has(id)) continue;
      seen.add(id);
      // already part of a single-day festival stop (a multi-day festival stop
      // leaves the shorter band-only stop as a legitimate option)
      const covered = festStops.some(
        f =>
          f.start === f.end &&
          f.start === d &&
          ids.every(i => f.shows.some(x => x.id === i))
      );
      if (covered) continue;
      const byId = new Map(group.map(g => [g.id, g]));
      const list = ids.map(i => byId.get(i));
      showStops.push({
        id,
        start: d,
        end: d,
        lat: s.lat,
        lng: s.lng,
        venue: s.venue || '',
        address: s.address || '',
        fest: null,
        shows: list,
        keys: [...new Set(list.map(g => 'band:' + urlKey(g.bandUrl)))].sort(),
      });
    }
  }

  const region = settings.region;
  return [...festStops, ...showStops]
    .filter(st => st.keys.length > 0)
    .filter(st => !region || haversineKm(region, st) <= region.km)
    .sort(stopOrder);
}

/** Display name of a stop's place: festival name, else address, else venue. */
function placeLabel(stop) {
  return (stop.fest && stop.fest.name) || stop.address || stop.venue || '';
}

const api = {
  RADII_KM,
  DEFAULT_RADIUS_KM,
  REGION_KM,
  DEFAULT_REGION_KM,
  DEFAULT_MIN_DAYS,
  DEFAULT_MAX_DAYS,
  MAX_TRIP_DAYS,
  MAX_TRIPS,
  MIN_SCORE,
  SAME_PLACE_KM,
  FESTIVAL_PLACE_KM,
  BEAM_WIDTH,
  urlKey,
  addDays,
  daysBetween,
  haversineKm,
  validSettings,
  buildStops,
  placeLabel,
};

// Node.js / browser / Web Worker compatibility
if (typeof module !== 'undefined') module.exports = api;
else globalThis.TokoroTrips = Object.assign(globalThis.TokoroTrips || {}, api);
