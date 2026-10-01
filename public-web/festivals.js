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

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
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

/** The next `n` months starting with the current one: [{ key: 'YYYY-MM', label }]. */
function monthChips(todayYmd, n = 12) {
  const thisYear = Number(todayYmd.slice(0, 4));
  let y = thisYear;
  let m = Number(todayYmd.slice(5, 7));
  const chips = [];
  for (let i = 0; i < n; i++) {
    chips.push({
      key: y + '-' + String(m).padStart(2, '0'),
      label: MONTH_ABBR[m - 1] + (y !== thisYear ? ' ' + y : ''),
    });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return chips;
}

function monthLabel(key) {
  return MONTH_NAMES[Number(key.slice(5, 7)) - 1] + ' ' + key.slice(0, 4);
}

function normalizeText(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/**
 * month: 'YYYY-MM' keeps festivals that OVERLAP that month; category: exact;
 * keyword: accent- and case-insensitive substring over the text fields.
 */
function filterFestivals(
  list,
  { month = '', category = '', keyword = '' } = {}
) {
  const q = normalizeText(keyword).trim();
  const first = month ? month + '-01' : '';
  const last = month ? month + '-31' : ''; // string compare: any day of the month is <= '-31'
  return list.filter(f => {
    if (month && !(f.start <= last && f.end >= first)) return false;
    if (category && f.category !== category) return false;
    if (q) {
      const hay = normalizeText(
        [
          f.name,
          f.title,
          f.description,
          f.venue,
          f.address,
          f.tags.join(' '),
        ].join(' ')
      );
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * [{ key, label, items }]: "Happening now" first (already started), then one
 * group per start month. `cmp` orders the items inside each group.
 */
function groupFestivals(list, todayYmd, cmp = byStartThenName) {
  const nowItems = [];
  const byMonth = new Map();
  for (const f of list) {
    if (f.start <= todayYmd) {
      nowItems.push(f);
    } else {
      const key = f.start.slice(0, 7);
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push(f);
    }
  }
  const groups = [];
  if (nowItems.length)
    groups.push({
      key: 'now',
      label: 'Happening now',
      items: nowItems.sort(cmp),
    });
  for (const key of [...byMonth.keys()].sort()) {
    groups.push({
      key,
      label: monthLabel(key),
      items: byMonth.get(key).sort(cmp),
    });
  }
  return groups;
}

/** "18–21 Jun", "28 Jun – 3 Jul", "18 Jun"; a year is added when it is not the current one. */
function fmtFestivalRange(start, end, todayYmd) {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const thisYear = Number(todayYmd.slice(0, 4));
  const dm = (d, m) => d + ' ' + MONTH_ABBR[m - 1];
  if (sy !== ey) return dm(sd, sm) + ' ' + sy + ' – ' + dm(ed, em) + ' ' + ey;
  const yr = ey !== thisYear ? ' ' + ey : '';
  if (sm === em && sd === ed) return dm(sd, sm) + yr;
  if (sm === em) return sd + '–' + dm(ed, em) + yr;
  return dm(sd, sm) + ' – ' + dm(ed, em) + yr;
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
  return list.map(f => ({ ...f, distanceKm: haversineKm(origin, f) }));
}

function byDistance(a, b) {
  return a.distanceKm - b.distanceKm || byStartThenName(a, b);
}

function fmtDistance(km) {
  return km < 10 ? km.toFixed(1) + ' km' : Math.round(km) + ' km';
}

/** One map pin per distinct location: [{ lat, lng, items }] in first-seen order. */
function groupPins(list) {
  const pins = new Map();
  for (const f of list) {
    const key = f.lat + ',' + f.lng;
    if (!pins.has(key)) pins.set(key, { lat: f.lat, lng: f.lng, items: [] });
    pins.get(key).items.push(f);
  }
  return [...pins.values()];
}

// Points ([lat, lng]) to fit the map to: those inside Europe (lat 34..72,
// lng -25..45, inclusive), or all of them when none is, so one bad coordinate
// cannot zoom the map out to the world.
function fitPoints(points) {
  const inside = points.filter(
    ([lat, lng]) => lat >= 34 && lat <= 72 && lng >= -25 && lng <= 45
  );
  return inside.length ? inside : points;
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
  monthChips,
  monthLabel,
  filterFestivals,
  groupFestivals,
  fmtFestivalRange,
  haversineKm,
  withDistance,
  byDistance,
  fmtDistance,
  groupPins,
  fitPoints,
};

// Node.js / browser compatibility
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined')
  window.TokoroFestivals = Object.assign(window.TokoroFestivals || {}, api);
