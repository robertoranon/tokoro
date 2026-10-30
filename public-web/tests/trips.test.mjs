// public-web/tests/trips.test.mjs
import { createRequire } from 'module';
import assert from 'node:assert/strict';
const {
  RADII_KM,
  DEFAULT_RADIUS_KM,
  REGION_KM,
  DEFAULT_REGION_KM,
  DEFAULT_MIN_DAYS,
  DEFAULT_MAX_DAYS,
  MAX_TRIP_DAYS,
  HOPS_MAX_RADIUS_KM,
  HOPS_MAX_DAYS,
  urlKey,
  bandKey,
  withDays,
  addDays,
  daysBetween,
  haversineKm,
  validSettings,
  buildStops,
  placeLabel,
  MIN_SCORE,
  planTrips,
  compareTrips,
  computeTrips,
  fmtScore,
} = createRequire(import.meta.url)('../trips.js');

const TODAY = '2030-10-01';
const D = n => addDays(TODAY, n);

function show(id, band, day, lat, lng, over = {}) {
  return {
    id,
    bandName: band,
    bandUrl: `https://${band.toLowerCase()}.example`,
    url: `https://tickets.example/${id}`,
    start: day,
    end: day,
    time: '20:00',
    venue: 'Venue ' + id,
    address: 'Addr ' + id,
    lat,
    lng,
    ...over,
  };
}
function fest(id, name, start, end, lat, lng) {
  return {
    id,
    name,
    festivalUrl: `https://${name.toLowerCase()}.example`,
    url: `https://${name.toLowerCase()}.example/info`,
    start,
    end,
    venue: 'Field ' + id,
    address: 'Town ' + id,
    lat,
    lng,
  };
}
const settings = over => validSettings(over || {});
const build = (o, s) =>
  buildStops({
    shows: [],
    festivals: [],
    followedBands: [],
    followedFestivals: [],
    todayYmd: TODAY,
    settings: settings(s),
    ...o,
  });
const ALPHA = 'https://alpha.example';
const BETA = 'https://beta.example';
const FEST = 'https://fest.example';

// constants
assert.deepEqual(RADII_KM, [25, 50, 100, 250, 500, 1000]);
assert.equal(DEFAULT_RADIUS_KM, 250);
assert.deepEqual(REGION_KM, [100, 250, 500, 1000]);
assert.equal(MAX_TRIP_DAYS, 60);
console.log('✅ constants');

// helpers
assert.equal(urlKey(' https://A.example// '), 'https://a.example');
assert.equal(daysBetween('2030-12-30', '2031-01-02'), 3);
assert.equal(addDays('2030-12-30', 3), '2031-01-02');
assert.ok(
  Math.abs(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 111.2) < 0.5
);
console.log('✅ helpers');

// validSettings
assert.deepEqual(validSettings({}), {
  source: 'both',
  minDays: DEFAULT_MIN_DAYS,
  maxDays: DEFAULT_MAX_DAYS,
  mode: 'base',
  radiusKm: DEFAULT_RADIUS_KM,
  dayPasses: false,
  region: null,
});
assert.deepEqual(
  [validSettings({ minDays: 30, maxDays: 10 })].map(s => [
    s.minDays,
    s.maxDays,
  ])[0],
  [30, 30]
);
assert.equal(validSettings({ minDays: 0 }).minDays, 1);
assert.equal(validSettings({ maxDays: 999 }).maxDays, 60);
assert.equal(validSettings({ minDays: 'abc' }).minDays, 14);
assert.equal(validSettings({ radiusKm: 42 }).radiusKm, 250);
assert.equal(validSettings({ radiusKm: 100 }).radiusKm, 100);
assert.equal(validSettings({ mode: 'x' }).mode, 'base');
assert.equal(validSettings({ mode: 'hops' }).mode, 'hops');
assert.equal(validSettings({ source: 'x' }).source, 'both');
assert.equal(validSettings({ source: 'bands' }).source, 'bands');
assert.equal(validSettings({ dayPasses: true }).dayPasses, true);
assert.equal(
  validSettings({ region: { lat: 95, lng: 0, km: 100 } }).region,
  null
);
assert.deepEqual(
  validSettings({ region: { lat: 50, lng: 8, km: 250 } }).region,
  {
    lat: 50,
    lng: 8,
    km: 250,
  }
);
assert.equal(
  validSettings({ region: { lat: 50, lng: 8, km: 77 } }).region.km,
  DEFAULT_REGION_KM
);
// On the move is capped: radius and length
assert.equal(HOPS_MAX_RADIUS_KM, 500);
assert.equal(HOPS_MAX_DAYS, 15);
{
  const h = validSettings({
    mode: 'hops',
    radiusKm: 1000,
    minDays: 45,
    maxDays: 60,
  });
  assert.deepEqual([h.radiusKm, h.minDays, h.maxDays], [500, 15, 15]);
  assert.equal(validSettings({ mode: 'hops', radiusKm: 100 }).radiusKm, 100);
  assert.equal(validSettings({ mode: 'base', radiusKm: 1000 }).radiusKm, 1000);
}
// withDays: the edited field wins
{
  const s0 = validSettings({});
  assert.deepEqual(
    [withDays(s0, 'maxDays', '10')].map(s => [s.minDays, s.maxDays])[0],
    [10, 10]
  );
  assert.deepEqual(
    [withDays(s0, 'minDays', '30')].map(s => [s.minDays, s.maxDays])[0],
    [30, 30]
  );
  assert.deepEqual(
    [withDays(s0, 'maxDays', 'abc')].map(s => [s.minDays, s.maxDays])[0],
    [14, 21]
  );
  assert.deepEqual(
    [withDays(s0, 'minDays', '')].map(s => [s.minDays, s.maxDays])[0],
    [14, 21]
  );
  const h = validSettings({ mode: 'hops' });
  assert.equal(withDays(h, 'maxDays', '99').maxDays, 15);
}
console.log('✅ validSettings');

// show stops
{
  const shows = [
    show('a1', 'Alpha', D(3), 50, 8),
    show('b1', 'Beta', D(3), 50, 8),
    show('c1', 'Gamma', D(3), 50, 8),
  ];
  const stops = build({ shows, followedBands: [ALPHA, BETA] });
  assert.equal(stops.length, 1);
  assert.deepEqual(stops[0].keys, ['band:' + ALPHA, 'band:' + BETA]);
  assert.deepEqual(stops[0].shows.map(s => s.id).sort(), ['a1', 'b1']);
  assert.equal(stops[0].start, D(3));
  assert.equal(stops[0].end, D(3));
  assert.equal(stops[0].fest, null);
  assert.equal(placeLabel(stops[0]), stops[0].address);
}
{
  // 0.5 km ~ 0.0045 deg lat; 3 km ~ 0.027
  const near = [
    show('a1', 'Alpha', D(3), 50, 8),
    show('b1', 'Beta', D(3), 50.0045, 8),
  ];
  assert.equal(build({ shows: near, followedBands: [ALPHA, BETA] }).length, 1);
  const far = [
    show('a1', 'Alpha', D(3), 50, 8),
    show('b1', 'Beta', D(3), 50.027, 8),
  ];
  assert.equal(build({ shows: far, followedBands: [ALPHA, BETA] }).length, 2);
}
{
  const shows = [show('a1', 'Alpha', D(3), 50, 8, { end: D(5) })];
  const stops = build({ shows, followedBands: [ALPHA] });
  assert.deepEqual(
    stops.map(s => [s.start, s.end]),
    [
      [D(3), D(3)],
      [D(4), D(4)],
      [D(5), D(5)],
    ]
  );
}
{
  const shows = [show('a1', 'Alpha', D(3), 50, 8)];
  assert.equal(
    build({ shows, followedBands: ['HTTPS://Alpha.example/'] }).length,
    1
  );
  assert.equal(build({ shows, followedBands: [] }).length, 0);
}
{
  // bands match as the server stores follows (as on the Tours page)
  assert.equal(
    bandKey('https://Band.example/x/?lang=en#top'),
    'https://band.example/x'
  );
  assert.equal(
    bandKey('https://band.example/ä'),
    'https://band.example/%C3%A4'
  );
  assert.equal(bandKey('mailto:a@b.c'), null);
  assert.equal(bandKey(''), null);
  const shows = [
    show('a1', 'Alpha', D(3), 50, 8, {
      bandUrl: 'https://alpha.example/?lang=en',
    }),
    show('b1', 'Beta', D(4), 50, 8, { bandUrl: 'https://beta.example/ä' }),
  ];
  const stops = build({
    shows,
    followedBands: [ALPHA, 'https://beta.example/%C3%A4'],
  });
  assert.deepEqual(
    stops.map(s => s.keys),
    [['band:' + ALPHA], ['band:https://beta.example/%C3%A4']]
  );
}
{
  // same bill is pairwise: a 0.8 km chain a-b-c (a-c 1.6 km) is two stops,
  // and every show is in exactly one stop that day
  const shows = [
    show('a1', 'Alpha', D(3), 50, 8),
    show('b1', 'Beta', D(3), 50.0072, 8),
    show('c1', 'Gamma', D(3), 50.0144, 8),
  ];
  const stops = build({
    shows,
    followedBands: [ALPHA, BETA, 'https://gamma.example'],
  });
  assert.deepEqual(
    stops.map(s => s.shows.map(x => x.id)),
    [['a1', 'b1'], ['c1']]
  );
  for (const st of stops)
    for (const x of st.shows)
      for (const y of st.shows) assert.ok(haversineKm(x, y) <= 1);
}
console.log('✅ show stops');

// festival stops
{
  const festivals = [fest('f1', 'Fest', D(5), D(7), 50, 8)];
  const shows = [show('a1', 'Alpha', D(6), 50.018, 8)]; // ~2 km
  const args = {
    festivals,
    shows,
    followedBands: [ALPHA],
    followedFestivals: [FEST],
  };
  const both = build(args);
  // festival stop plus the shorter band-only stop
  assert.equal(both.length, 2);
  assert.equal(both[0].start, D(5));
  assert.equal(both[0].end, D(7));
  assert.deepEqual(both[0].keys, ['band:' + ALPHA, 'fest:' + FEST]);
  assert.equal(both[0].fest.id, 'f1');
  assert.equal(placeLabel(both[0]), 'Fest');
  assert.equal(both[1].fest, null);
  assert.deepEqual([both[1].start, both[1].end], [D(6), D(6)]);

  const fonly = build(args, { source: 'festivals' });
  assert.equal(fonly.length, 1);
  assert.deepEqual(fonly[0].keys, ['fest:' + FEST]);
  assert.deepEqual(fonly[0].shows, []);

  const bonly = build(args, { source: 'bands' });
  assert.equal(bonly.length, 1);
  assert.deepEqual(bonly[0].keys, ['band:' + ALPHA]);
  assert.equal(bonly[0].fest, null);

  const passes = build(args, { dayPasses: true });
  assert.deepEqual(
    passes.map(s => [s.start, s.end]),
    [
      [D(5), D(5)],
      [D(6), D(6)],
      [D(7), D(7)],
    ]
  );
  assert.deepEqual(
    passes.map(s => s.keys.length),
    [1, 2, 1]
  );
  // the day-2 band stop is covered by the single-day festival stop
  assert.ok(passes.every(s => s.fest));
}
{
  const long = [fest('f1', 'Fest', D(2), D(41), 50, 8)];
  const stops = build(
    { festivals: long, followedFestivals: [FEST] },
    { maxDays: 21 }
  );
  assert.equal(stops.length, 40);
  assert.ok(stops.every(s => s.start === s.end));
}
{
  const running = [fest('f1', 'Fest', D(-10), D(2), 50, 8)];
  const stops = build({ festivals: running, followedFestivals: [FEST] });
  assert.equal(stops.length, 1);
  assert.equal(stops[0].start, TODAY);
  assert.equal(stops[0].end, D(2));
}
console.log('✅ festival stops');

// region
{
  const shows = [
    show('a1', 'Alpha', D(3), 50, 8),
    show('b1', 'Beta', D(4), 52.7, 8),
  ];
  const args = { shows, followedBands: [ALPHA, BETA] };
  assert.equal(build(args).length, 2);
  const region = { lat: 50, lng: 8, km: 100 };
  const stops = build(args, { region });
  assert.equal(stops.length, 1);
  assert.equal(stops[0].shows[0].id, 'a1');
}
console.log('✅ region');

// determinism
{
  const shows = [
    show('a1', 'Alpha', D(3), 50, 8),
    show('b1', 'Beta', D(3), 50.0045, 8),
    show('a2', 'Alpha', D(4), 51, 9),
  ];
  const args = { shows, followedBands: [ALPHA, BETA] };
  const fwd = build(args);
  const rev = build({ ...args, shows: [...shows].reverse() });
  assert.deepEqual(rev, fwd);
}
console.log('✅ determinism');

// ---- planner ----
const compute = (o, s) =>
  computeTrips({
    shows: [],
    festivals: [],
    followedBands: [],
    followedFestivals: [],
    todayYmd: TODAY,
    settings: s || {},
    ...o,
  });
const bandsOf = names => names.map(n => `https://${n.toLowerCase()}.example`);
const keysOf = trip => [...new Set(trip.stops.flatMap(s => s.keys))].sort();
const sharesDay = (a, b) => a.start <= b.end && b.start <= a.end;
const UDINE = [46.06, 13.23];
const BERLIN = [52.52, 13.405];

// radius modes
{
  const shows = [
    show('a1', 'A', D(1), 46, 13),
    show('b1', 'B', D(2), 46, 14),
    show('c1', 'C', D(3), 46, 15),
    show('d1', 'D', D(4), 46, 16),
  ];
  const args = { shows, followedBands: bandsOf(['A', 'B', 'C', 'D']) };
  const hops = compute(args, { mode: 'hops', radiusKm: 100 });
  assert.equal(hops.length, 1);
  assert.equal(hops[0].score, 4);
  assert.equal(hops[0].bands, 4);
  assert.equal(hops[0].festivals, 0);
  assert.equal(hops[0].centre, null);
  assert.equal(hops[0].area, 'Addr a1 → Addr d1');
  assert.deepEqual(
    hops[0].stops.map(s => s.start),
    [D(1), D(2), D(3), D(4)]
  );
  assert.ok(
    Math.abs(hops[0].travelKm - 3 * haversineKm(shows[0], shows[1])) < 1
  );
  const base = compute(args, { mode: 'base', radiusKm: 100 });
  assert.equal(base[0].score, 3);
  assert.ok(base[0].centre && Number.isFinite(base[0].centre.lat));
  assert.ok(base[0].area.startsWith('around '));
}
{
  const shows = [
    show('a1', 'A', D(1), ...UDINE),
    show('b1', 'B', D(3), 46.06, 13.62), // ~30 km
    show('c1', 'C', D(2), ...BERLIN),
  ];
  const trips = compute(
    { shows, followedBands: bandsOf(['A', 'B', 'C']) },
    { mode: 'base', radiusKm: 100 }
  );
  assert.deepEqual(keysOf(trips[0]), [
    'band:https://a.example',
    'band:https://b.example',
  ]);
}
{
  // hops area: equal labels collapse, a missing label is left out
  const followedBands = bandsOf(['A', 'B']);
  const hops = { mode: 'hops', radiusKm: 100 };
  const same = [
    show('a1', 'A', D(1), ...UDINE, { address: 'Udine' }),
    show('b1', 'B', D(2), 46.07, 13.24, { address: 'Udine' }),
  ];
  assert.equal(compute({ shows: same, followedBands }, hops)[0].area, 'Udine');
  const blank = [
    show('a1', 'A', D(1), ...UDINE, { address: '', venue: '' }),
    show('b1', 'B', D(2), 46.07, 13.24, { address: 'Gorizia' }),
  ];
  assert.equal(
    compute({ shows: blank, followedBands }, hops)[0].area,
    'Gorizia'
  );
}
console.log('✅ radius modes');

// one place per day, distinct bands, span, min padding
{
  const shows = [
    show('a1', 'A', D(1), 46, 13),
    show('b1', 'B', D(1), 46, 13.65), // ~50 km
    show('c1', 'C', D(2), 46, 13.3),
  ];
  for (const mode of ['base', 'hops']) {
    const trips = compute(
      { shows, followedBands: bandsOf(['A', 'B', 'C']) },
      { mode, radiusKm: 250 }
    );
    for (const t of trips) {
      for (let i = 0; i < t.stops.length; i++)
        for (let j = i + 1; j < t.stops.length; j++)
          assert.ok(!sharesDay(t.stops[i], t.stops[j]));
    }
    assert.equal(trips[0].score, 2);
  }
}
{
  const shows = [
    show('a1', 'A', D(1), 46, 13),
    show('a2', 'A', D(2), 46, 13.1),
    show('b1', 'B', D(3), 46, 13.2),
  ];
  const trips = compute({ shows, followedBands: bandsOf(['A', 'B']) });
  assert.equal(trips[0].score, 2);
  assert.equal(trips[0].bands, 2);
}
{
  const shows = [show('a1', 'A', D(1), 46, 13), show('b1', 'B', D(25), 46, 13)];
  const args = { shows, followedBands: bandsOf(['A', 'B']) };
  assert.deepEqual(compute(args, { maxDays: 21 }), []);
  assert.deepEqual(compute(args, { maxDays: 21, mode: 'hops' }), []);
}
{
  const shows = [show('a1', 'A', D(1), 46, 13), show('b1', 'B', D(3), 46, 13)];
  const [t] = compute(
    { shows, followedBands: bandsOf(['A', 'B']) },
    { minDays: 14 }
  );
  assert.equal(t.start, D(1));
  assert.equal(t.firstDay, D(1));
  assert.equal(t.end, addDays(D(1), 13));
  assert.equal(t.lastDay, D(3));
}
console.log('✅ planner rules');

// empty
{
  const shows = [
    show('a1', 'A', D(1), 46, 13),
    show('b1', 'B', D(2), ...BERLIN),
  ];
  const args = { shows, followedBands: bandsOf(['A', 'B']) };
  assert.deepEqual(compute(args, { radiusKm: 100 }), []);
  assert.deepEqual(compute(args, { radiusKm: 100, mode: 'hops' }), []);
  assert.deepEqual(planTrips([], validSettings({})), []);
  assert.deepEqual(planTrips([], validSettings({ mode: 'hops' })), []);
}
{
  // a One base trip whose stops have no name has no area label
  const shows = [
    show('a1', 'Alpha', D(1), 50, 8, { venue: '', address: '' }),
    show('b1', 'Beta', D(2), 50, 8, { venue: '', address: '' }),
  ];
  const trips = compute({ shows, followedBands: [ALPHA, BETA] });
  assert.equal(trips.length, 1);
  assert.equal(trips[0].area, '');
}
console.log('✅ planner empty');

// festival on top
{
  const args = {
    festivals: [fest('f1', 'Fest', D(5), D(7), 50, 8)],
    shows: [show('a1', 'Alpha', D(6), 50.018, 8)],
    followedBands: [ALPHA],
    followedFestivals: [FEST],
  };
  for (const mode of ['base', 'hops']) {
    const trips = compute(args, { mode });
    assert.equal(trips.length, 1);
    assert.equal(trips[0].score, 2);
    assert.equal(trips[0].bands, 1);
    assert.equal(trips[0].festivals, 1);
    assert.deepEqual(compute(args, { mode, source: 'festivals' }), []);
  }
}
console.log('✅ festival on top');

// compareTrips
{
  const mk = (score, firstDay, lastDay, travelKm, ids = ['x']) => ({
    score,
    firstDay,
    lastDay,
    travelKm,
    stops: ids.map(id => ({ id })),
  });
  const span3 = mk(3, D(10), D(12), 50);
  const span5 = mk(3, D(1), D(5), 10);
  assert.ok(compareTrips(span3, span5) < 0);
  assert.ok(compareTrips(mk(4, D(1), D(9), 0), span3) < 0);
  assert.ok(compareTrips(mk(3, D(1), D(3), 50), span3) < 0);
  assert.ok(compareTrips(mk(3, D(10), D(12), 20), span3) < 0);
  assert.ok(
    compareTrips(
      mk(3, D(10), D(12), 50, ['a']),
      mk(3, D(10), D(12), 50, ['b'])
    ) < 0
  );
  assert.equal(compareTrips(span3, mk(3, D(10), D(12), 50)), 0);
  // One base (with a centre): travel does not rank, stop ids do
  const base = (km, ids) => ({ ...mk(3, D(10), D(12), km, ids), centre: {} });
  assert.ok(compareTrips(base(90, ['a']), base(10, ['b'])) < 0);
}
console.log('✅ compareTrips');

// de-duplication
{
  const GORIZIA = [45.94, 13.62];
  const shows = [
    show('a1', 'A', D(1), ...UDINE),
    show('a2', 'A', D(2), ...GORIZIA),
    show('b1', 'B', D(3), ...UDINE),
    show('b2', 'B', D(4), ...GORIZIA),
    show('c1', 'C', D(100), ...BERLIN),
    show('d1', 'D', D(101), ...BERLIN),
  ];
  for (const mode of ['base', 'hops']) {
    const trips = compute(
      { shows, followedBands: bandsOf(['A', 'B', 'C', 'D']) },
      { mode }
    );
    assert.equal(trips.length, 2);
    assert.deepEqual(keysOf(trips[0]), [
      'band:https://a.example',
      'band:https://b.example',
    ]);
    assert.deepEqual(keysOf(trips[1]), [
      'band:https://c.example',
      'band:https://d.example',
    ]);
  }
}
console.log('✅ de-duplication');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// validity + determinism (seeded)
{
  const rnd = mulberry32(42);
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  // 600 km box: ~5.4 deg lat x ~8 deg lng at 48N
  const shows = Array.from({ length: 40 }, (_, i) =>
    show(
      's' + i,
      names[Math.floor(rnd() * names.length)],
      D(Math.floor(rnd() * 60)),
      45 + rnd() * 5.4,
      8 + rnd() * 8
    )
  );
  const args = { shows, followedBands: bandsOf(names) };
  for (const mode of ['base', 'hops']) {
    const s = validSettings({ mode, radiusKm: 100, maxDays: 10, minDays: 3 });
    const trips = compute(args, s);
    assert.ok(trips.length > 0);
    for (const t of trips) {
      for (let i = 0; i < t.stops.length; i++)
        for (let j = i + 1; j < t.stops.length; j++)
          assert.ok(!sharesDay(t.stops[i], t.stops[j]));
      assert.ok(daysBetween(t.firstDay, t.lastDay) + 1 <= s.maxDays);
      if (mode === 'hops') {
        for (let i = 1; i < t.stops.length; i++)
          assert.ok(haversineKm(t.stops[i - 1], t.stops[i]) <= s.radiusKm);
      } else {
        for (const st of t.stops)
          assert.ok(haversineKm(t.centre, st) <= s.radiusKm);
      }
      const keys = keysOf(t);
      assert.equal(t.score, keys.length);
      assert.equal(t.bands + t.festivals, t.score);
      assert.ok(t.score >= MIN_SCORE);
    }
    for (let i = 1; i < trips.length; i++)
      assert.ok(compareTrips(trips[i - 1], trips[i]) <= 0);
    assert.deepEqual(compute(args, s), trips);
  }
}
console.log('✅ planner validity + determinism');

// performance
{
  const rnd = mulberry32(7);
  const shows = [];
  const bands = [];
  for (let b = 0; b < 50; b++) {
    bands.push(`https://band${b}.example`);
    for (let i = 0; i < 20; i++)
      shows.push(
        show(
          `b${b}s${i}`,
          'Band' + b,
          D(Math.floor(rnd() * 548)),
          36 + rnd() * 24,
          -9 + rnd() * 34
        )
      );
  }
  const festivals = [];
  const fests = [];
  for (let f = 0; f < 20; f++) {
    const start = Math.floor(rnd() * 548);
    const len = 2 + Math.floor(rnd() * 4);
    festivals.push(
      fest(
        'f' + f,
        'Fest' + f,
        D(start),
        D(start + len - 1),
        36 + rnd() * 24,
        -9 + rnd() * 34
      )
    );
    fests.push(`https://fest${f}.example`);
  }
  const args = {
    shows,
    festivals,
    followedBands: bands,
    followedFestivals: fests,
  };
  for (const s of [
    { mode: 'base' },
    { mode: 'hops' },
    { mode: 'base', radiusKm: 1000, maxDays: 60 },
    { mode: 'hops', radiusKm: 500, maxDays: 15 },
  ]) {
    const label = JSON.stringify(s);
    const t0 = performance.now();
    const trips = compute(args, s);
    const ms = performance.now() - t0;
    assert.ok(trips.length > 0);
    assert.ok(ms < 2000, `${label} took ${ms.toFixed(0)} ms`);
    console.log(
      `   ${label}: ${ms.toFixed(0)} ms, ${trips.length} trips, best ${trips[0].score}`
    );
  }
}
console.log('✅ planner performance');

// fmtScore
assert.equal(fmtScore({ bands: 7, festivals: 1 }), '7 bands · 1 festival');
assert.equal(fmtScore({ bands: 1, festivals: 0 }), '1 band');
assert.equal(fmtScore({ bands: 0, festivals: 2 }), '2 festivals');
console.log('✅ fmtScore');
