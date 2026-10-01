// public-web/tests/festivals.test.mjs
import { createRequire } from 'module';
import assert from 'node:assert/strict';
const {
  isRadarEntry,
  toFestival,
  toFestivals,
  addDays,
  radarWindow,
  buildRadarUrl,
  loadRadarEvents,
  monthChips,
  monthLabel,
  filterFestivals,
  groupFestivals,
  fmtFestivalRange,
  byStartThenName,
  haversineKm,
  withDistance,
  byDistance,
  fmtDistance,
  groupPins,
  fitPoints,
} = createRequire(import.meta.url)('../festivals.js');

const ev = over => ({
  id: 'e1',
  title: 'Terraforma 2026',
  festival_name: 'Terraforma',
  festival_url: 'https://terra.example',
  url: 'https://terra.example/en',
  description: 'Forest setting',
  venue_name: 'Villa Arconati',
  address: 'Bollate',
  lat: 45.5,
  lng: 9.1,
  start_time: '2026-10-20T00:00:00',
  end_time: '2026-10-23T23:59:59',
  category: 'music',
  tags: ['electronic', 'festival'],
  ...over,
});

// ── isRadarEntry ──────────────────────────────────────────────────────────────
{ assert.equal(isRadarEntry(ev({})), true);
  console.log('✅ isRadarEntry: a radar entry is recognized'); }

{ // festival-mode program event: no festival tag, no end_time
  assert.equal(isRadarEntry(ev({ tags: [], end_time: null, start_time: '2026-10-21T21:00:00' })), false);
  console.log('✅ isRadarEntry: program event is not a radar entry'); }

{ // a concert that an LLM tagged "festival" and gave an end time
  assert.equal(isRadarEntry(ev({ start_time: '2026-10-21T21:00:00', end_time: '2026-10-21T23:00:00' })), false);
  console.log('✅ isRadarEntry: tagged concert with clock times is not a radar entry'); }

{ assert.equal(isRadarEntry(ev({ tags: ['electronic'] })), false);
  assert.equal(isRadarEntry(ev({ tags: null })), false);
  assert.equal(isRadarEntry(ev({ end_time: null })), false);
  assert.equal(isRadarEntry(ev({ lat: '45.5' })), false);
  assert.equal(isRadarEntry(null), false);
  console.log('✅ isRadarEntry: missing tag / tags / end_time, non-numeric coordinates, null'); }

// ── toFestival ────────────────────────────────────────────────────────────────
{ const f = toFestival(ev({}));
  assert.equal(f.name, 'Terraforma');
  assert.equal(f.title, 'Terraforma 2026');
  assert.equal(f.start, '2026-10-20');
  assert.equal(f.end, '2026-10-23');
  assert.deepEqual(f.tags, ['electronic']);
  assert.equal(f.url, 'https://terra.example/en');
  assert.equal(f.venue, 'Villa Arconati');
  assert.equal(f.address, 'Bollate');
  assert.equal(f.category, 'music');
  console.log('✅ toFestival: maps fields, drops the "festival" tag, YYYY-MM-DD dates'); }

{ const f = toFestival(ev({ festival_name: null, url: null, description: null, venue_name: null, address: null, category: null }));
  assert.equal(f.name, 'Terraforma 2026');
  assert.equal(f.url, 'https://terra.example');
  assert.equal(f.description, '');
  assert.equal(f.venue, '');
  assert.equal(f.category, 'other');
  console.log('✅ toFestival: fallbacks (name→title, url→festival_url, empty strings, category other)'); }

// ── toFestivals ───────────────────────────────────────────────────────────────
{ const today = '2026-10-21';
  const list = toFestivals(
    [
      ev({ id: 'b', festival_name: 'Beta', start_time: '2026-11-05T00:00:00', end_time: '2026-11-07T23:59:59' }),
      ev({ id: 'run', festival_name: 'Running', start_time: '2026-10-19T00:00:00', end_time: '2026-10-21T23:59:59' }),
      ev({ id: 'old', festival_name: 'Ended', start_time: '2026-10-15T00:00:00', end_time: '2026-10-20T23:59:59' }),
      ev({ id: 'prog', tags: [], end_time: null, start_time: '2026-10-22T21:00:00' }),
      ev({ id: 'run', festival_name: 'Running (duplicate id)' }),
      ev({ id: 'a', festival_name: 'Alpha', start_time: '2026-11-05T00:00:00', end_time: '2026-11-06T23:59:59' }),
    ],
    today
  );
  assert.deepEqual(list.map(f => f.name), ['Running', 'Alpha', 'Beta']);
  console.log('✅ toFestivals: radar entries only, ended dropped (ends today stays), duplicate ids ignored, sorted by start then name'); }

{ assert.deepEqual(toFestivals(null, '2026-10-21'), []);
  assert.deepEqual(toFestivals([], '2026-10-21'), []);
  console.log('✅ toFestivals: null / empty input → []'); }

// ── addDays / radarWindow / buildRadarUrl ─────────────────────────────────────
{ assert.equal(addDays('2026-12-30', 5), '2027-01-04');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2027-02-28', 1), '2027-03-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  console.log('✅ addDays: month, year and leap-year boundaries'); }

{ assert.deepEqual(radarWindow('2026-10-15'), {
    from: '2025-10-14T00:00:00',
    to: '2028-04-15T23:59:59',
  });
  console.log('✅ radarWindow: 366 days back (running festivals), ~18 months ahead'); }

{ const u = new URL(buildRadarUrl('https://api.example', { from: '2025-10-14T00:00:00', to: '2028-04-15T23:59:59', offset: 200 }));
  assert.equal(u.origin + u.pathname, 'https://api.example/events');
  assert.equal(u.searchParams.get('has_festival'), '1');
  assert.equal(u.searchParams.get('from'), '2025-10-14T00:00:00');
  assert.equal(u.searchParams.get('to'), '2028-04-15T23:59:59');
  assert.equal(u.searchParams.get('offset'), '200');
  assert.equal(u.searchParams.get('lat'), null);
  console.log('✅ buildRadarUrl: no-geo browse query with has_festival=1, window and offset'); }

// ── loadRadarEvents ───────────────────────────────────────────────────────────
function fakeFetch(pages) {
  const calls = [];
  const fn = async url => {
    const u = new URL(url);
    calls.push(Number(u.searchParams.get('offset')));
    const page = pages[calls.length - 1] ?? { status: 200, body: { events: [], has_more: false } };
    return { ok: page.status === 200, status: page.status, json: async () => page.body };
  };
  return { fn, calls };
}
const win = { from: 'f', to: 't' };

{ const { fn, calls } = fakeFetch([
    { status: 200, body: { events: [{ id: 1 }, { id: 2 }], has_more: true } },
    { status: 200, body: { events: [{ id: 3 }, { id: 4 }], has_more: true } },
    { status: 200, body: { events: [{ id: 5 }], has_more: false } },
  ]);
  const r = await loadRadarEvents(fn, 'https://api.example', win);
  assert.deepEqual(r.events.map(e => e.id), [1, 2, 3, 4, 5]);
  assert.equal(r.truncated, false);
  assert.deepEqual(calls, [0, 2, 4]);
  console.log('✅ loadRadarEvents: follows has_more, offset advances by the page size, concatenates'); }

{ const { fn } = fakeFetch(Array.from({ length: 5 }, () => ({ status: 200, body: { events: [{ id: 1 }, { id: 2 }], has_more: true } })));
  const r = await loadRadarEvents(fn, 'https://api.example', win, 3);
  assert.equal(r.events.length, 6);
  assert.equal(r.truncated, true);
  console.log('✅ loadRadarEvents: stops at maxPages and reports truncated'); }

{ const { fn, calls } = fakeFetch([{ status: 200, body: { events: [], has_more: true } }]);
  const r = await loadRadarEvents(fn, 'https://api.example', win);
  assert.equal(r.events.length, 0);
  assert.equal(r.truncated, false);
  assert.equal(calls.length, 1);
  console.log('✅ loadRadarEvents: an empty page ends the loop even if has_more is true'); }

{ const { fn } = fakeFetch([{ status: 500, body: {} }]);
  await assert.rejects(() => loadRadarEvents(fn, 'https://api.example', win), /500/);
  console.log('✅ loadRadarEvents: HTTP error rejects with the status'); }

{ const { fn } = fakeFetch([{ status: 200, body: { nope: 1 } }]);
  const r = await loadRadarEvents(fn, 'https://api.example', win);
  assert.deepEqual(r.events, []);
  console.log('✅ loadRadarEvents: unexpected body shape → no events (no crash)'); }

// ── month chips / labels ──────────────────────────────────────────────────────
{ assert.deepEqual(monthChips('2026-10-15', 4), [
    { key: '2026-10', label: 'Oct' },
    { key: '2026-11', label: 'Nov' },
    { key: '2026-12', label: 'Dec' },
    { key: '2027-01', label: 'Jan 2027' },
  ]);
  assert.equal(monthChips('2026-01-31').length, 12);
  assert.equal(monthChips('2026-01-31')[11].key, '2026-12');
  console.log('✅ monthChips: starts at the current month, year suffix only for other years, 12 by default'); }

{ assert.equal(monthLabel('2026-10'), 'October 2026');
  assert.equal(monthLabel('2027-01'), 'January 2027');
  console.log('✅ monthLabel: long month name and year'); }

// ── filterFestivals ───────────────────────────────────────────────────────────
const fest = over => ({
  id: 'x', name: 'Name', title: 'Name 2026', url: null, start: '2026-10-20', end: '2026-10-23',
  category: 'music', tags: [], description: '', venue: '', address: '', lat: 45, lng: 13, ...over,
});
const sample = [
  fest({ id: 'a', name: 'Aurora', start: '2026-10-28', end: '2026-11-02', category: 'art', description: 'Installations in a Café courtyard', tags: ['installation'] }),
  fest({ id: 'b', name: 'Beta', start: '2026-11-05', end: '2026-11-07', category: 'music', venue: 'Teatro Sociale', tags: ['jazz'] }),
  fest({ id: 'c', name: 'Gamma', title: 'Gamma Days 2026', start: '2026-12-01', end: '2026-12-03', category: 'theater', address: 'Zürich' }),
];

{ assert.equal(filterFestivals(sample, {}).length, 3);
  assert.equal(filterFestivals(sample, { month: '', category: '', keyword: '' }).length, 3);
  console.log('✅ filterFestivals: no filters → everything'); }

{ assert.deepEqual(filterFestivals(sample, { month: '2026-11' }).map(f => f.id), ['a', 'b']);
  assert.deepEqual(filterFestivals(sample, { month: '2026-10' }).map(f => f.id), ['a']);
  assert.deepEqual(filterFestivals(sample, { month: '2026-12' }).map(f => f.id), ['c']);
  assert.deepEqual(filterFestivals(sample, { month: '2027-03' }), []);
  console.log('✅ filterFestivals: month = overlap (a festival spanning two months shows in both)'); }

{ assert.deepEqual(filterFestivals(sample, { category: 'music' }).map(f => f.id), ['b']);
  assert.deepEqual(filterFestivals(sample, { category: 'other' }), []);
  console.log('✅ filterFestivals: category'); }

{ assert.deepEqual(filterFestivals(sample, { keyword: 'cafe' }).map(f => f.id), ['a']);
  assert.deepEqual(filterFestivals(sample, { keyword: 'CAFÉ' }).map(f => f.id), ['a']);
  assert.deepEqual(filterFestivals(sample, { keyword: 'jazz' }).map(f => f.id), ['b']);
  assert.deepEqual(filterFestivals(sample, { keyword: 'teatro' }).map(f => f.id), ['b']);
  assert.deepEqual(filterFestivals(sample, { keyword: 'zurich' }).map(f => f.id), ['c']);
  assert.deepEqual(filterFestivals(sample, { keyword: 'days 2026' }).map(f => f.id), ['c']);
  assert.deepEqual(filterFestivals(sample, { keyword: '   ' }).length, 3);
  assert.deepEqual(filterFestivals(sample, { keyword: 'nothing like this' }), []);
  console.log('✅ filterFestivals: keyword is accent- and case-insensitive over name, title, description, tags, venue, address'); }

{ assert.deepEqual(filterFestivals(sample, { month: '2026-11', category: 'art', keyword: 'cafe' }).map(f => f.id), ['a']);
  assert.deepEqual(filterFestivals(sample, { month: '2026-12', category: 'art' }), []);
  console.log('✅ filterFestivals: filters combine with AND'); }

// ── groupFestivals ────────────────────────────────────────────────────────────
{ const today = '2026-10-21';
  const list = [
    fest({ id: 'run', name: 'Running', start: '2026-10-19', end: '2026-10-22' }),
    fest({ id: 'oct2', name: 'Zeta', start: '2026-10-30', end: '2026-10-31' }),
    fest({ id: 'oct1', name: 'Alpha', start: '2026-10-30', end: '2026-10-31' }),
    fest({ id: 'dec', name: 'Dec', start: '2026-12-02', end: '2026-12-04' }),
    fest({ id: 'jan', name: 'Jan', start: '2027-01-09', end: '2027-01-10' }),
    fest({ id: 'today', name: 'Starts today', start: '2026-10-21', end: '2026-10-21' }),
  ];
  const g = groupFestivals(list, today);
  assert.deepEqual(g.map(x => x.key), ['now', '2026-10', '2026-12', '2027-01']);
  assert.deepEqual(g.map(x => x.label), ['Happening now', 'October 2026', 'December 2026', 'January 2027']);
  assert.deepEqual(g[0].items.map(f => f.id), ['run', 'today']);
  assert.deepEqual(g[1].items.map(f => f.id), ['oct1', 'oct2']);
  console.log('✅ groupFestivals: "Happening now" first (started on/before today), then months by start; start-then-name order inside'); }

{ const list = [fest({ id: 'p', name: 'P', start: '2026-11-02', end: '2026-11-03' }), fest({ id: 'q', name: 'Q', start: '2026-11-09', end: '2026-11-10' })];
  const g = groupFestivals(list, '2026-10-21', (a, b) => (a.id < b.id ? 1 : -1));
  assert.deepEqual(g[0].items.map(f => f.id), ['q', 'p']);
  assert.deepEqual(groupFestivals([], '2026-10-21'), []);
  console.log('✅ groupFestivals: custom comparator, empty list'); }

// ── fmtFestivalRange ──────────────────────────────────────────────────────────
{ const t = '2026-01-01';
  assert.equal(fmtFestivalRange('2026-06-18', '2026-06-21', t), '18–21 Jun');
  assert.equal(fmtFestivalRange('2026-06-28', '2026-07-03', t), '28 Jun – 3 Jul');
  assert.equal(fmtFestivalRange('2026-06-18', '2026-06-18', t), '18 Jun');
  assert.equal(fmtFestivalRange('2027-06-18', '2027-06-21', t), '18–21 Jun 2027');
  assert.equal(fmtFestivalRange('2027-06-28', '2027-07-03', t), '28 Jun – 3 Jul 2027');
  assert.equal(fmtFestivalRange('2026-12-30', '2027-01-02', t), '30 Dec 2026 – 2 Jan 2027');
  console.log('✅ fmtFestivalRange: same day, same month, two months, other year, across years'); }

// ── distance ──────────────────────────────────────────────────────────────────
{ const trieste = { lat: 45.65, lng: 13.78 };
  assert.equal(haversineKm(trieste, trieste), 0);
  assert.ok(Math.abs(haversineKm({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 }) - 344) < 3);
  const list = [fest({ id: 'far', lat: 52.52, lng: 13.4 }), fest({ id: 'near', lat: 45.7, lng: 13.7 }), fest({ id: 'mid', lat: 46.07, lng: 13.24 })];
  const withD = withDistance(list, trieste);
  assert.ok(withD.every(f => typeof f.distanceKm === 'number'));
  assert.equal(list[0].distanceKm, undefined);
  assert.deepEqual([...withD].sort(byDistance).map(f => f.id), ['near', 'mid', 'far']);
  console.log('✅ distance: haversine, withDistance (non-mutating), byDistance'); }

{ const a = { ...fest({ id: 'a', start: '2026-10-01' }), distanceKm: 5 };
  const b = { ...fest({ id: 'b', start: '2026-09-01' }), distanceKm: 5 };
  assert.deepEqual([a, b].sort(byDistance).map(f => f.id), ['b', 'a']);
  console.log('✅ byDistance: ties fall back to start date'); }

{ assert.equal(fmtDistance(8.34), '8.3 km');
  assert.equal(fmtDistance(0.04), '0.0 km');
  assert.equal(fmtDistance(62.7), '63 km');
  assert.equal(fmtDistance(1234.4), '1234 km');
  console.log('✅ fmtDistance: one decimal under 10 km, rounded above'); }

// ── groupPins ─────────────────────────────────────────────────────────────────
{ const pins = groupPins([
    fest({ id: '1', lat: 45.1, lng: 9.2 }),
    fest({ id: '2', lat: 46.0, lng: 13.2 }),
    fest({ id: '3', lat: 45.1, lng: 9.2 }),
  ]);
  assert.equal(pins.length, 2);
  assert.deepEqual(pins[0].items.map(f => f.id), ['1', '3']);
  assert.equal(pins[0].lat, 45.1);
  assert.deepEqual(groupPins([]), []);
  console.log('✅ groupPins: co-located festivals share one pin, first-seen order'); }

// ── fitPoints ─────────────────────────────────────────────────────────────────
{ const eu = [[45, 9], [52.5, 13.4]];
  assert.deepEqual(fitPoints([...eu, [0, 0]]), eu);
  const far = [[0, 0], [-33, 151]];
  assert.deepEqual(fitPoints(far), far);
  assert.deepEqual(fitPoints([]), []);
  const edge = [[34, -25], [72, 45], [34, 45], [72, -25]];
  assert.deepEqual(fitPoints([...edge, [33.9, 0], [50, 45.1]]), edge);
  console.log('✅ fitPoints: Europe box only, all points if none inside, boundaries inclusive'); }

// --- add new test sections above this line ---

console.log('\nAll festivals tests passed');
