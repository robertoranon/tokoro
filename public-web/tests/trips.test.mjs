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
  urlKey,
  addDays,
  daysBetween,
  haversineKm,
  validSettings,
  buildStops,
  placeLabel,
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
  assert.equal(both.length, 1);
  assert.equal(both[0].start, D(5));
  assert.equal(both[0].end, D(7));
  assert.deepEqual(both[0].keys, ['band:' + ALPHA, 'fest:' + FEST]);
  assert.equal(both[0].fest.id, 'f1');
  assert.equal(placeLabel(both[0]), 'Fest');

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
