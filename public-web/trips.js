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

/*
 * Part 2: the planner. A trip is a set of stops, no two sharing a day, within
 * maxDays and the radius rule of the mode. Several stops may carry the same
 * keys (alternatives); the score is always the number of distinct keys.
 */

const dayNums = new Map();
/** Day number of a "YYYY-MM-DD" string (cached: hot while ranking). */
function dayNum(ymd) {
  let n = dayNums.get(ymd);
  if (n === undefined) {
    const [y, m, d] = ymd.split('-').map(Number);
    n = Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
    dayNums.set(ymd, n);
  }
  return n;
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function idsOf(stops) {
  return stops.map(s => s.id).join('|');
}

/** Sort key of a trip; compareKeys orders these as compareTrips orders trips. */
function rankKey(t) {
  return {
    t,
    score: t.score,
    span: dayNum(t.lastDay) - dayNum(t.firstDay),
    firstDay: t.firstDay,
    travelKm: t.travelKm,
    ids: idsOf(t.stops),
  };
}

function compareKeys(a, b) {
  return (
    b.score - a.score ||
    a.span - b.span ||
    cmpStr(a.firstDay, b.firstDay) ||
    a.travelKm - b.travelKm ||
    cmpStr(a.ids, b.ids)
  );
}

/** Ranking: score desc, span asc, firstDay asc, travelKm asc, stop ids. */
function compareTrips(a, b) {
  return compareKeys(rankKey(a), rankKey(b));
}

/** Raw candidate from chosen stops (any order); full Trip built on accept. */
function candidate(chosen, travelKm, centre, centreStop) {
  const stops = [...chosen].sort(stopOrder);
  const keys = new Set(stops.flatMap(s => s.keys));
  let lastDay = stops[0].end;
  for (const s of stops) if (s.end > lastDay) lastDay = s.end;
  return {
    stops,
    keys,
    score: keys.size,
    firstDay: stops[0].start,
    lastDay,
    travelKm,
    centre,
    centreStop,
  };
}

/** First index in `stops` (sorted by start) with start >= ymd. */
function lowerBound(stops, ymd) {
  let lo = 0;
  let hi = stops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (stops[mid].start < ymd) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Max-heap of non-negative integers (packed greedy priorities). */
function heapPush(h, v) {
  let i = h.length;
  h.push(v);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p] >= v) break;
    h[i] = h[p];
    i = p;
  }
  h[i] = v;
}

function heapPop(h) {
  const top = h[0];
  const v = h.pop();
  if (h.length) {
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= h.length) break;
      if (c + 1 < h.length && h[c + 1] > h[c]) c++;
      if (h[c] <= v) break;
      h[i] = h[c];
      i = c;
    }
    h[i] = v;
  }
  return top;
}

/** `stops` must be in stop order: index order is then date order. */
function baseCandidates(stops, settings) {
  const n = stops.length;
  const d0 = stops.map(s => dayNum(s.start));
  const d1 = stops.map(s => dayNum(s.end));
  const keyIds = new Map();
  const keys = stops.map(s =>
    s.keys.map(k => {
      if (!keyIds.has(k)) keyIds.set(k, keyIds.size);
      return keyIds.get(k);
    })
  );
  // greedy tie order: fewer days, earlier start, id
  const byRank = stops
    .map((_, i) => i)
    .sort(
      (a, b) =>
        d1[a] - d0[a] - (d1[b] - d0[b]) ||
        cmpStr(stops[a].start, stops[b].start) ||
        cmpStr(stops[a].id, stops[b].id)
    );
  const rank = new Int32Array(n);
  byRank.forEach((i, r) => (rank[i] = r));
  const seen = new Uint8Array(keyIds.size);
  const taken = new Uint8Array(settings.maxDays);

  /*
   * Greedy pick in a window (stop indices, days from `firstNum`): most new
   * keys, no shared day. New-key counts only shrink, so a max-heap with lazy
   * re-evaluation picks exactly what a full scan per step would.
   */
  function greedy(window, firstNum) {
    const heap = [];
    for (const i of window)
      heapPush(heap, keys[i].length * n + (n - 1 - rank[i]));
    const chosen = [];
    while (heap.length) {
      const v = heapPop(heap);
      const r = v % n;
      const i = byRank[n - 1 - r];
      let free = true;
      for (let d = d0[i]; free && d <= d1[i]; d++) free = !taken[d - firstNum];
      if (!free) continue;
      let fresh = 0;
      for (const k of keys[i]) if (!seen[k]) fresh++;
      if (fresh === 0) continue;
      if (fresh < (v - r) / n) {
        heapPush(heap, fresh * n + r);
        continue;
      }
      chosen.push(i);
      for (let d = d0[i]; d <= d1[i]; d++) taken[d - firstNum] = 1;
      for (const k of keys[i]) seen[k] = 1;
    }
    taken.fill(0);
    for (const i of chosen) for (const k of keys[i]) seen[k] = 0;
    if (chosen.length === 0) return null;
    chosen.sort((a, b) => a - b);
    const picked = chosen.map(i => stops[i]);
    const keySet = new Set(picked.flatMap(s => s.keys));
    if (keySet.size < MIN_SCORE) return null;
    let lastDay = picked[0].end;
    for (const s of picked) if (s.end > lastDay) lastDay = s.end;
    return { chosen, picked, keySet, lastDay, ids: idsOf(picked) };
  }

  // many centres see the same window: memoise the greedy by window content
  const memo = new Map();
  // and pick the same stops: keep one candidate per stop set (lowest travelKm)
  const out = new Map();
  const dist = new Float64Array(n);
  const centres = new Map();
  stops.forEach((s, i) => {
    const k = s.lat.toFixed(3) + ',' + s.lng.toFixed(3);
    if (!centres.has(k)) centres.set(k, i);
  });
  for (const ci of centres.values()) {
    const cs = stops[ci];
    const centre = { lat: cs.lat, lng: cs.lng };
    const near = [];
    for (let i = 0; i < n; i++) {
      const km = haversineKm(centre, stops[i]);
      if (km <= settings.radiusKm) {
        near.push(i);
        dist[i] = km;
      }
    }
    for (let j = 0; j < near.length; j++) {
      const firstNum = d0[near[j]];
      if (j > 0 && d0[near[j - 1]] === firstNum) continue; // distinct starts
      const lastNum = firstNum + settings.maxDays - 1;
      const window = [];
      let h1 = 0;
      let h2 = 0;
      for (let k = j; k < near.length && d0[near[k]] <= lastNum; k++) {
        const i = near[k];
        if (d1[i] > lastNum) continue;
        window.push(i);
        h1 = (Math.imul(h1, 31) + i + 1) | 0;
        h2 = (Math.imul(h2 ^ i, 0x5bd1e995) + 0x6b43a9b5) | 0;
      }
      // two 32-bit hashes plus length; collisions are verified below
      const key = h1 + ':' + h2 + ':' + window.length;
      let entry = memo.get(key);
      if (!entry || !sameWindow(entry.window, window)) {
        entry = { window, res: greedy(window, firstNum) };
        memo.set(key, entry);
      }
      const res = entry.res;
      if (!res) continue;
      let km = 0;
      for (const i of res.chosen) if (dist[i] > km) km = dist[i];
      const prev = out.get(res.ids);
      if (prev && km >= prev.travelKm) continue;
      out.set(res.ids, {
        stops: res.picked,
        keys: res.keySet,
        score: res.keySet.size,
        firstDay: res.picked[0].start,
        lastDay: res.lastDay,
        travelKm: km,
        centre,
        centreStop: cs,
      });
    }
  }
  return [...out.values()];
}

function sameWindow(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function compareStates(a, b) {
  return b.seen.size - a.seen.size || a.km - b.km || cmpStr(a.ids, b.ids);
}

function hopsCandidates(stops, settings) {
  const out = [];
  const push = st => {
    if (st.seen.size >= MIN_SCORE) out.push(candidate(st.stops, st.km, null));
  };
  for (const s0 of stops) {
    const last = addDays(s0.start, settings.maxDays - 1);
    let beam = [{ stops: [s0], seen: new Set(s0.keys), km: 0, ids: s0.id }];
    push(beam[0]);
    while (beam.length) {
      const next = [];
      for (const st of beam) {
        const tail = st.stops[st.stops.length - 1];
        for (
          let i = lowerBound(stops, addDays(tail.end, 1));
          i < stops.length && stops[i].start <= last;
          i++
        ) {
          const t = stops[i];
          if (t.end > last || !t.keys.some(k => !st.seen.has(k))) continue;
          const hop = haversineKm(tail, t);
          if (hop > settings.radiusKm) continue;
          next.push({
            stops: [...st.stops, t],
            seen: new Set([...st.seen, ...t.keys]),
            km: st.km + hop,
            ids: st.ids + '|' + t.id,
          });
        }
      }
      beam = next.sort(compareStates).slice(0, BEAM_WIDTH);
      beam.forEach(push);
    }
  }
  return out;
}

function toTrip(c, settings) {
  const bands = [...c.keys].filter(k => k.startsWith('band:')).length;
  const festivals = [...c.keys].filter(k => k.startsWith('fest:')).length;
  const padded = addDays(c.firstDay, settings.minDays - 1);
  const first = c.stops[0];
  const last = c.stops[c.stops.length - 1];
  const from = placeLabel(first);
  const to = placeLabel(last);
  // hops: one label when they match or one is missing
  const area = c.centre
    ? 'around ' + placeLabel(c.centreStop)
    : !from || !to || from === to
      ? from || to
      : from + ' → ' + to;
  return {
    start: c.firstDay,
    end: c.lastDay > padded ? c.lastDay : padded,
    firstDay: c.firstDay,
    lastDay: c.lastDay,
    stops: c.stops,
    bands,
    festivals,
    score: bands + festivals,
    travelKm: c.travelKm,
    centre: c.centre,
    area,
  };
}

/** Ranked, de-duplicated trips (at most MAX_TRIPS). `settings` from validSettings. */
function planTrips(stops, settings) {
  const sorted = [...(stops || [])].sort(stopOrder);
  const cands =
    settings.mode === 'hops'
      ? hopsCandidates(sorted, settings)
      : baseCandidates(sorted, settings);
  const ranked = cands.map(rankKey).sort(compareKeys);
  const accepted = [];
  for (const { t: c } of ranked) {
    if (accepted.length >= MAX_TRIPS) break;
    const dup = accepted.some(a => {
      if (c.firstDay > a.lastDay || a.firstDay > c.lastDay) return false;
      let shared = 0;
      for (const k of c.keys) if (a.keys.has(k)) shared++;
      return shared > c.keys.size / 2;
    });
    if (!dup) accepted.push(c);
  }
  return accepted.map(c => toTrip(c, settings));
}

function computeTrips({
  shows,
  festivals,
  followedBands,
  followedFestivals,
  todayYmd,
  settings,
}) {
  const s = validSettings(settings);
  return planTrips(
    buildStops({
      shows,
      festivals,
      followedBands,
      followedFestivals,
      todayYmd,
      settings: s,
    }),
    s
  );
}

/** "7 bands · 1 festival", "1 band", "2 festivals" (zero parts omitted). */
function fmtScore(trip) {
  const parts = [];
  if (trip.bands)
    parts.push(trip.bands + (trip.bands === 1 ? ' band' : ' bands'));
  if (trip.festivals)
    parts.push(
      trip.festivals + (trip.festivals === 1 ? ' festival' : ' festivals')
    );
  return parts.join(' · ');
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
  compareTrips,
  planTrips,
  computeTrips,
  fmtScore,
};

// Node.js / browser / Web Worker compatibility
if (typeof module !== 'undefined') module.exports = api;
else globalThis.TokoroTrips = Object.assign(globalThis.TokoroTrips || {}, api);
