'use strict';

/**
 * Pure logic for festivals.html (no DOM). Loaded as a classic script in the
 * browser (window.TokoroFestivals) and via require() in the Node tests.
 *
 * Dates here are venue-local "YYYY-MM-DD" strings. Never feed them to
 * `new Date()`: slice the string and use UTC arithmetic.
 */

const RADAR_TAG = 'festival';

// The worker's no-geo browse path filters `start_time >= from`, not overlap, so
// a festival already under way is only returned if `from` reaches back before
// its start. Radar entries are deleted ~2 days after they end, so a year back
// covers any entry that still exists.
const RADAR_LOOKBACK_DAYS = 366;
const RADAR_LOOKAHEAD_DAYS = 548; // ~18 months
const MAX_PAGES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Add `n` days to a "YYYY-MM-DD" string (UTC arithmetic, no timezone drift). */
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * Radar entries are published by the radar with exactly this shape. The same
 * rule guards the crawler's update match. Festival-mode program events share
 * `has_festival=1` but have clock times and/or no end time, so they fail it.
 */
function isRadarEntry(e) {
  return (
    !!e &&
    Array.isArray(e.tags) &&
    e.tags.includes(RADAR_TAG) &&
    typeof e.start_time === 'string' &&
    typeof e.end_time === 'string' &&
    e.start_time.endsWith('T00:00:00') &&
    e.end_time.endsWith('T23:59:59') &&
    typeof e.lat === 'number' &&
    typeof e.lng === 'number'
  );
}

function byStartThenName(a, b) {
  if (a.start !== b.start) return a.start < b.start ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** API event → the flat festival object the page renders. */
function toFestival(e) {
  return {
    id: e.id,
    name: String(e.festival_name || e.title || '').trim(),
    title: e.title || e.festival_name || '',
    url: e.url || e.festival_url || null,
    start: e.start_time.slice(0, 10),
    end: e.end_time.slice(0, 10),
    category: e.category || 'other',
    tags: (e.tags || []).filter(t => t !== RADAR_TAG),
    description: e.description || '',
    venue: e.venue_name || '',
    address: e.address || '',
    lat: e.lat,
    lng: e.lng,
  };
}

/** Radar entries only, not yet ended (ending today still counts), de-duplicated, sorted. */
function toFestivals(events, todayYmd) {
  const seen = new Set();
  const out = [];
  for (const e of events || []) {
    if (!isRadarEntry(e) || seen.has(e.id)) continue;
    seen.add(e.id);
    const f = toFestival(e);
    if (f.end < todayYmd) continue;
    out.push(f);
  }
  return out.sort(byStartThenName);
}

function radarWindow(todayYmd) {
  return {
    from: addDays(todayYmd, -RADAR_LOOKBACK_DAYS) + 'T00:00:00',
    to: addDays(todayYmd, RADAR_LOOKAHEAD_DAYS) + 'T23:59:59',
  };
}

function buildRadarUrl(apiBase, { from, to, offset }) {
  return (
    apiBase +
    '/events?has_festival=1' +
    '&from=' +
    encodeURIComponent(from) +
    '&to=' +
    encodeURIComponent(to) +
    '&offset=' +
    encodeURIComponent(offset || 0)
  );
}

/**
 * Fetch every page of `GET /events?has_festival=1&…` (100 per page, `has_more`
 * says whether another page exists). Capped at `maxPages` so a flood of
 * festival-mode program events cannot hang the page.
 * @returns {Promise<{ events: object[], truncated: boolean }>}
 */
async function loadRadarEvents(
  fetchFn,
  apiBase,
  { from, to },
  maxPages = MAX_PAGES
) {
  const all = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchFn(buildRadarUrl(apiBase, { from, to, offset }));
    if (!res.ok) throw new Error('Events request failed (' + res.status + ')');
    const data = await res.json();
    const events = data && Array.isArray(data.events) ? data.events : [];
    all.push(...events);
    if (!data || !data.has_more || events.length === 0) {
      return { events: all, truncated: false };
    }
    offset += events.length;
  }
  return { events: all, truncated: true };
}

const api = {
  RADAR_TAG,
  addDays,
  isRadarEntry,
  byStartThenName,
  toFestival,
  toFestivals,
  radarWindow,
  buildRadarUrl,
  loadRadarEvents,
};

// Node.js / browser compatibility
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined')
  window.TokoroFestivals = Object.assign(window.TokoroFestivals || {}, api);
