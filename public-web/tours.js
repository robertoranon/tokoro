'use strict';

/**
 * Pure logic for tours.html (no DOM). Loaded as a classic script in the
 * browser (window.TokoroTours) and via require() in the Node tests.
 *
 * Dates here are venue-local "YYYY-MM-DD" strings. Never feed them to
 * `new Date()` without UTC arithmetic: slice the string.
 */

const TOUR_TAG = 'band-tour';
const TOUR_LOOKAHEAD_DAYS = 548; // ~18 months
const MAX_PAGES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Add `n` days to a "YYYY-MM-DD" string (UTC arithmetic, no timezone drift). */
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url || '');
  }
}

// A show is "new" for this many days after the crawler first published it.
const NEW_DAYS = 7;

/**
 * Published within the last `days` days. `created_at` is set by the crawler
 * when it first publishes a show (an update keeps it) and is UTC without a
 * zone suffix. A slightly future value (clock skew) counts as new; a far-future
 * or unparseable one does not.
 */
function isNewShow(show, nowMs, days = NEW_DAYS) {
  const raw = show && typeof show.createdAt === 'string' ? show.createdAt : '';
  if (!raw) return false;
  const t = Date.parse(/(?:z|[+-]\d{2}:\d{2})$/i.test(raw) ? raw : raw + 'Z');
  if (!isFinite(t)) return false;
  const age = nowMs - t;
  return age >= -DAY_MS && age < days * DAY_MS;
}

/** An API event published by the tours crawler: has an act_url, a real date, numeric coordinates. */
function isTourShow(e) {
  return (
    !!e &&
    typeof e.act_url === 'string' &&
    e.act_url !== '' &&
    typeof e.start_time === 'string' &&
    /^\d{4}-\d{2}-\d{2}/.test(e.start_time) &&
    typeof e.lat === 'number' &&
    typeof e.lng === 'number'
  );
}

/** API event → the flat show object the page renders. */
function toShow(e) {
  const time =
    e.start_time.length >= 16 && !e.start_time.endsWith('T00:00:00')
      ? e.start_time.slice(11, 16)
      : '';
  return {
    id: e.id,
    bandName: String(e.act_name || '').trim() || hostOf(e.act_url),
    bandUrl: e.act_url,
    title: e.title || '',
    url: e.url || null,
    start: e.start_time.slice(0, 10),
    time,
    venue: e.venue_name || '',
    address: e.address || '',
    description: e.description || '',
    createdAt: e.created_at || '',
    tags: (e.tags || []).filter(t => t !== TOUR_TAG),
    lat: e.lat,
    lng: e.lng,
  };
}

function byDateThenId(a, b) {
  if (a.start !== b.start) return a.start < b.start ? -1 : 1;
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  return String(a.id).localeCompare(String(b.id));
}

/** Tour shows only, today or later, de-duplicated by id, sorted by date. */
function toShows(events, todayYmd) {
  const seen = new Set();
  const out = [];
  for (const e of events || []) {
    if (!isTourShow(e) || seen.has(e.id)) continue;
    seen.add(e.id);
    const s = toShow(e);
    if (s.start < todayYmd) continue;
    out.push(s);
  }
  return out.sort(byDateThenId);
}

function tourWindow(todayYmd) {
  return {
    from: todayYmd + 'T00:00:00',
    to: addDays(todayYmd, TOUR_LOOKAHEAD_DAYS) + 'T23:59:59',
  };
}

function buildToursUrl(apiBase, { from, to, offset }) {
  return (
    apiBase +
    '/events?has_act=1' +
    '&from=' +
    encodeURIComponent(from) +
    '&to=' +
    encodeURIComponent(to) +
    '&offset=' +
    encodeURIComponent(offset || 0)
  );
}

/**
 * Fetch every page of `GET /events?has_act=1&…` (100 per page, `has_more`
 * says whether another page exists). Capped at `maxPages` so a runaway data
 * set cannot hang the page.
 * @returns {Promise<{ events: object[], truncated: boolean }>}
 */
async function loadTourEvents(
  fetchFn,
  apiBase,
  { from, to },
  maxPages = MAX_PAGES
) {
  const all = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchFn(buildToursUrl(apiBase, { from, to, offset }));
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

function normalizeText(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
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

function withDistance(list, origin) {
  return list.map(s => ({ ...s, distanceKm: haversineKm(origin, s) }));
}

function fmtDistance(km) {
  return km < 10 ? km.toFixed(1) + ' km' : Math.round(km) + ' km';
}

/**
 * keyword: accent- and case-insensitive substring over band name, title, venue,
 * address and tags; from/to: inclusive "YYYY-MM-DD" on the show date;
 * origin + radiusKm: keep shows within the radius.
 */
function filterShows(
  list,
  {
    keyword = '',
    from = '',
    to = '',
    origin = null,
    radiusKm = 0,
    newOnly = false,
    nowMs = Date.now(),
  } = {}
) {
  const q = normalizeText(keyword).trim();
  return list.filter(s => {
    if (newOnly && !isNewShow(s, nowMs)) return false;
    if (from && s.start < from) return false;
    if (to && s.start > to) return false;
    if (origin && radiusKm > 0 && haversineKm(origin, s) > radiusKm)
      return false;
    if (q) {
      const hay = normalizeText(
        [s.bandName, s.title, s.venue, s.address, s.tags.join(' ')].join(' ')
      );
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * [{ key, name, url, shows, next }] one per act_url; shows by date, bands by
 * their next show then name.
 */
function groupByBand(shows, nowMs) {
  const byKey = new Map();
  for (const s of shows) {
    if (!byKey.has(s.bandUrl)) {
      byKey.set(s.bandUrl, {
        key: s.bandUrl,
        name: s.bandName,
        url: s.bandUrl,
        shows: [],
      });
    }
    byKey.get(s.bandUrl).shows.push(s);
  }
  const bands = [...byKey.values()];
  for (const b of bands) {
    b.shows.sort(byDateThenId);
    b.next = b.shows[0];
    // Shows first published recently; 0 when no clock is given.
    b.newCount =
      nowMs === undefined ? 0 : b.shows.filter(x => isNewShow(x, nowMs)).length;
  }
  return bands.sort((a, b) =>
    a.next.start !== b.next.start
      ? a.next.start < b.next.start
        ? -1
        : 1
      : a.name.localeCompare(b.name)
  );
}

/** Badge text for a band: "NEW" for one new show, "NEW · 3" for several, "" for none. */
function fmtNewBadge(count) {
  if (!count || count < 1) return '';
  return count === 1 ? 'NEW' : 'NEW · ' + count;
}

/** "Tue 12 Nov", "Tue 12 Nov, 21:00"; a year is added when it is not the current one. */
function fmtShowDate(start, time, todayYmd) {
  const [y, m, d] = start.split('-').map(Number);
  const weekday = WEEKDAY_ABBR[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const thisYear = Number(todayYmd.slice(0, 4));
  const year = y !== thisYear ? ' ' + y : '';
  return (
    weekday +
    ' ' +
    d +
    ' ' +
    MONTH_ABBR[m - 1] +
    year +
    (time ? ', ' + time : '')
  );
}

function fmtNext(band, todayYmd) {
  return 'Next: ' + fmtShowDate(band.next.start, band.next.time, todayYmd);
}

/** One map pin per distinct location: [{ lat, lng, items }] in first-seen order. */
function groupPins(list) {
  const pins = new Map();
  for (const s of list) {
    const key = s.lat + ',' + s.lng;
    if (!pins.has(key)) pins.set(key, { lat: s.lat, lng: s.lng, items: [] });
    pins.get(key).items.push(s);
  }
  return [...pins.values()];
}

// Points ([lat, lng]) to fit the map to: those inside Europe (lat 34..72,
// lng -25..45, inclusive), or all of them when none is, so one far-away show
// cannot zoom the map out to the world.
function fitPoints(points) {
  const inside = points.filter(
    ([lat, lng]) => lat >= 34 && lat <= 72 && lng >= -25 && lng <= 45
  );
  return inside.length ? inside : points;
}

// ── Saved queries ─────────────────────────────────────────────────────────────
// A query is saved as a shareable link: the filters travel in the URL and the
// page restores them on load (same idea as the events page's "Copy link").

const RADII_KM = [25, 50, 100, 250, 500]; // the radius <select> options
const DEFAULT_RADIUS_KM = 100;
const MAX_KEYWORD_LENGTH = 200;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function validYmd(v) {
  if (typeof v !== 'string' || !YMD.test(v)) return '';
  const d = new Date(v + 'T12:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : '';
}

/**
 * Filters → query string (no leading "?"). Empty filters are omitted; the
 * radius and the place label only travel together with an origin.
 */
function buildTourQuery({
  keyword = '',
  from = '',
  to = '',
  origin = null,
  radius = DEFAULT_RADIUS_KM,
  place = '',
  newOnly = false,
} = {}) {
  const p = new URLSearchParams();
  const q = String(keyword).trim();
  if (q) p.set('q', q);
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  if (newOnly) p.set('new', '1');
  if (origin && isFinite(origin.lat) && isFinite(origin.lng)) {
    p.set('lat', Number(origin.lat).toFixed(4));
    p.set('lng', Number(origin.lng).toFixed(4));
    p.set('radius', String(radius));
    if (place) p.set('place', place);
  }
  return p.toString();
}

/** Query string (with or without "?") → validated filters; bad values are dropped. */
function parseTourQuery(search) {
  const p = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const lat = p.has('lat') ? Number(p.get('lat')) : NaN;
  const lng = p.has('lng') ? Number(p.get('lng')) : NaN;
  const origin =
    isFinite(lat) &&
    isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
      ? { lat, lng }
      : null;
  const radius = Number(p.get('radius'));
  return {
    keyword: (p.get('q') || '').trim().slice(0, MAX_KEYWORD_LENGTH),
    from: validYmd(p.get('from')),
    to: validYmd(p.get('to')),
    origin,
    radius: RADII_KM.includes(radius) ? radius : DEFAULT_RADIUS_KM,
    place: origin ? (p.get('place') || '').slice(0, 120) : '',
    newOnly: p.get('new') === '1',
  };
}

// ── Tracked bands ─────────────────────────────────────────────────────────────

/** Validate tracked-bands.json: { generated, bands: [{ name, url }] } → same shape with only good bands, or null. */
function parseTracked(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.bands))
    return null;
  const bands = [];
  for (const b of json.bands) {
    if (!b || typeof b.name !== 'string' || typeof b.url !== 'string') continue;
    const name = b.name.trim();
    if (!name || !/^https?:\/\//i.test(b.url)) continue;
    bands.push({ name, url: b.url });
  }
  return {
    generated: typeof json.generated === 'string' ? json.generated : '',
    bands,
  };
}

const siteKey = u =>
  String(u || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();

/**
 * Rows for the tracked-bands pane: every tracked band plus any band that has
 * shows but is not in the file (for example removed since the last deploy),
 * each with its number of upcoming shows, alphabetically. Bands are matched by
 * site url (case-insensitive, trailing slash ignored); the same site listed
 * twice appears once.
 */
function mergeTracked(tracked, shows) {
  const counts = new Map();
  const fromShows = new Map();
  for (const s of shows || []) {
    const k = siteKey(s.bandUrl);
    counts.set(k, (counts.get(k) || 0) + 1);
    if (!fromShows.has(k))
      fromShows.set(k, { name: s.bandName, url: s.bandUrl });
  }
  const rows = new Map();
  for (const b of tracked || []) {
    const k = siteKey(b.url);
    if (!k || rows.has(k)) continue;
    rows.set(k, {
      name: b.name,
      url: b.url,
      upcoming: counts.get(k) || 0,
      tracked: true,
    });
  }
  for (const [k, b] of fromShows) {
    if (!rows.has(k))
      rows.set(k, {
        name: b.name,
        url: b.url,
        upcoming: counts.get(k),
        tracked: false,
      });
  }
  return [...rows.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
}

const api = {
  TOUR_TAG,
  addDays,
  isTourShow,
  toShow,
  toShows,
  tourWindow,
  buildToursUrl,
  loadTourEvents,
  filterShows,
  groupByBand,
  fmtShowDate,
  fmtNext,
  haversineKm,
  withDistance,
  fmtDistance,
  groupPins,
  fitPoints,
  NEW_DAYS,
  isNewShow,
  fmtNewBadge,
  parseTracked,
  mergeTracked,
  RADII_KM,
  DEFAULT_RADIUS_KM,
  buildTourQuery,
  parseTourQuery,
};

// Node.js / browser compatibility
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined')
  window.TokoroTours = Object.assign(window.TokoroTours || {}, api);
