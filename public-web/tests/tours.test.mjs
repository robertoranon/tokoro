// public-web/tests/tours.test.mjs
import { createRequire } from 'module';
import assert from 'node:assert/strict';
const {
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
  buildTourQuery,
  parseTourQuery,
  DEFAULT_RADIUS_KM,
  isNewShow,
  NEW_DAYS,
  fmtNewBadge,
  parseTracked,
  mergeTracked,
} = createRequire(import.meta.url)('../tours.js');

const TODAY = '2030-10-01';
const ev = over => ({
  id: 'e1',
  title: 'Test Band live',
  act_name: 'Test Band',
  act_url: 'https://testband.example',
  url: 'https://tickets.example/1',
  description: 'With Opener.',
  venue_name: 'Club X',
  address: 'Via Roma 1, Udine',
  lat: 46.06,
  lng: 13.23,
  start_time: '2030-11-12T21:00:00',
  end_time: null,
  category: 'music',
  tags: ['band-tour', 'rock'],
  created_at: '2030-09-20T08:00:00',
  ...over,
});

// ── addDays / tourWindow / buildToursUrl ─────────────────────────────────────
{
  assert.equal(addDays('2030-12-30', 3), '2031-01-02');
  assert.equal(addDays('2030-03-01', -1), '2030-02-28');
  console.log('✅ addDays: crosses month and year, no timezone drift');
}

{
  const w = tourWindow(TODAY);
  assert.equal(w.from, '2030-10-01T00:00:00');
  assert.equal(w.to, addDays(TODAY, 548) + 'T23:59:59');
  console.log('✅ tourWindow: from today, ~18 months ahead');
}

{
  const url = buildToursUrl('https://api.example', {
    from: '2030-10-01T00:00:00',
    to: '2032-04-01T23:59:59',
    offset: 100,
  });
  assert.ok(url.startsWith('https://api.example/events?has_act=1'));
  assert.ok(url.includes('from=2030-10-01T00%3A00%3A00'));
  assert.ok(url.includes('offset=100'));
  assert.ok(
    buildToursUrl('https://api.example', { from: 'a', to: 'b' }).includes(
      'offset=0'
    )
  );
  console.log('✅ buildToursUrl: has_act=1, encoded window, offset');
}

// ── isTourShow / toShow ──────────────────────────────────────────────────────
{
  assert.equal(isTourShow(ev({})), true);
  assert.equal(isTourShow(ev({ act_url: null })), false);
  assert.equal(isTourShow(ev({ act_url: '' })), false);
  assert.equal(isTourShow(ev({ start_time: 'garbage' })), false);
  assert.equal(isTourShow(ev({ lat: '46' })), false);
  assert.equal(isTourShow(null), false);
  console.log(
    '✅ isTourShow: needs act_url, a real date and numeric coordinates'
  );
}

{
  const s = toShow(ev({}));
  assert.equal(s.bandName, 'Test Band');
  assert.equal(s.bandUrl, 'https://testband.example');
  assert.equal(s.start, '2030-11-12');
  assert.equal(s.time, '21:00');
  assert.equal(s.venue, 'Club X');
  assert.equal(s.url, 'https://tickets.example/1');
  assert.deepEqual(s.tags, ['rock']);
  console.log('✅ toShow: flat show, band-tour tag hidden');
}

{
  assert.equal(toShow(ev({ start_time: '2030-11-12T00:00:00' })).time, '');
  assert.equal(toShow(ev({ act_name: null })).bandName, 'testband.example');
  assert.equal(
    toShow(ev({ act_name: '  ', act_url: 'https://www.x.example/b' })).bandName,
    'x.example'
  );
  assert.equal(toShow(ev({ url: null })).url, null);
  console.log(
    '✅ toShow: midnight = no time; band name falls back to the host'
  );
}

// ── toShows ──────────────────────────────────────────────────────────────────
{
  const out = toShows(
    [
      ev({ id: 'b', start_time: '2030-11-13T21:00:00' }),
      ev({ id: 'a', start_time: '2030-11-12T21:00:00' }),
      ev({ id: 'a' }), // duplicate id
      ev({ id: 'p', start_time: '2030-09-30T21:00:00' }), // past
      ev({ id: 't', start_time: '2030-10-01T00:00:00' }), // today stays
      ev({ id: 'n', act_url: null }), // not a tour show
    ],
    TODAY
  );
  assert.deepEqual(
    out.map(s => s.id),
    ['t', 'a', 'b']
  );
  assert.deepEqual(toShows(null, TODAY), []);
  console.log(
    '✅ toShows: de-duplicates, drops past and non-tour events, sorts by date'
  );
}

// ── filterShows ──────────────────────────────────────────────────────────────
{
  const shows = toShows(
    [
      ev({
        id: '1',
        act_name: 'Sigur Rós',
        act_url: 'https://sigur.example',
        title: 'Sigur Rós',
        start_time: '2030-11-12T21:00:00',
      }),
      ev({
        id: '2',
        start_time: '2030-12-05T21:00:00',
        venue_name: 'Kino Šiška',
        address: 'Ljubljana',
        lat: 46.06,
        lng: 14.5,
      }),
      ev({
        id: '3',
        act_name: 'Other Band',
        act_url: 'https://other.example',
        title: 'Other Band',
        start_time: '2031-01-20T20:00:00',
        lat: 45.43,
        lng: 12.33,
      }),
    ],
    TODAY
  );
  const ids = list => list.map(s => s.id);
  assert.deepEqual(ids(filterShows(shows, {})), ['1', '2', '3']);
  assert.deepEqual(ids(filterShows(shows, { keyword: 'sigur ros' })), ['1']);
  assert.deepEqual(ids(filterShows(shows, { keyword: 'kino siska' })), ['2']);
  assert.deepEqual(ids(filterShows(shows, { keyword: 'test band' })), ['2']);
  assert.deepEqual(ids(filterShows(shows, { from: '2030-12-01' })), ['2', '3']);
  assert.deepEqual(ids(filterShows(shows, { to: '2030-12-05' })), ['1', '2']);
  assert.deepEqual(
    ids(filterShows(shows, { from: '2030-12-05', to: '2030-12-05' })),
    ['2']
  );
  const origin = { lat: 46.06, lng: 13.23 }; // Udine
  // Show 2 is ~98 km east of Udine, show 3 ~99 km south-west.
  assert.deepEqual(ids(filterShows(shows, { origin, radiusKm: 10 })), ['1']);
  assert.deepEqual(ids(filterShows(shows, { origin, radiusKm: 60 })), ['1']);
  assert.deepEqual(ids(filterShows(shows, { origin, radiusKm: 150 })), [
    '1',
    '2',
    '3',
  ]);
  console.log(
    '✅ filterShows: keyword (accent-insensitive, band name included), date range, radius'
  );
}

// ── groupByBand ──────────────────────────────────────────────────────────────
{
  const shows = toShows(
    [
      ev({ id: '1', start_time: '2030-11-20T21:00:00' }),
      ev({ id: '2', start_time: '2030-11-12T21:00:00' }),
      ev({
        id: '3',
        act_name: 'Aaa Band',
        act_url: 'https://aaa.example',
        start_time: '2030-11-12T21:00:00',
      }),
      ev({
        id: '4',
        act_name: 'Late Band',
        act_url: 'https://late.example',
        start_time: '2030-10-15T21:00:00',
      }),
    ],
    TODAY
  );
  const bands = groupByBand(shows);
  assert.deepEqual(
    bands.map(b => b.name),
    ['Late Band', 'Aaa Band', 'Test Band']
  );
  const test = bands[2];
  assert.equal(test.key, 'https://testband.example');
  assert.equal(test.url, 'https://testband.example');
  assert.deepEqual(
    test.shows.map(s => s.id),
    ['2', '1']
  );
  assert.equal(test.next.id, '2');
  assert.deepEqual(groupByBand([]), []);
  console.log(
    '✅ groupByBand: one group per act_url, bands by next show then name, shows by date'
  );
}

// ── formatting ───────────────────────────────────────────────────────────────
{
  assert.equal(fmtShowDate('2030-11-12', '', TODAY), 'Tue 12 Nov');
  assert.equal(fmtShowDate('2030-11-12', '21:00', TODAY), 'Tue 12 Nov, 21:00');
  assert.equal(fmtShowDate('2031-01-02', '', TODAY), 'Thu 2 Jan 2031');
  console.log(
    '✅ fmtShowDate: weekday, day, month, year only when not current, time when known'
  );
}

{
  const band = groupByBand(toShows([ev({})], TODAY))[0];
  assert.equal(fmtNext(band, TODAY), 'Next: Tue 12 Nov, 21:00');
  console.log('✅ fmtNext');
}

// ── distance / pins ──────────────────────────────────────────────────────────
{
  const udine = { lat: 46.0637, lng: 13.2353 };
  const venice = { lat: 45.4408, lng: 12.3155 };
  const km = haversineKm(udine, venice);
  assert.ok(km > 90 && km < 110, 'Udine–Venice ≈ 100 km, got ' + km);
  assert.equal(haversineKm(udine, udine), 0);
  console.log('✅ haversineKm');
}

{
  assert.equal(fmtDistance(3.14), '3.1 km');
  assert.equal(fmtDistance(42.6), '43 km');
  const shows = toShows([ev({})], TODAY);
  assert.equal(
    typeof withDistance(shows, { lat: 46, lng: 13 })[0].distanceKm,
    'number'
  );
  console.log('✅ fmtDistance / withDistance');
}

{
  const shows = toShows(
    [
      ev({ id: '1' }),
      ev({ id: '2', start_time: '2030-11-13T21:00:00' }),
      ev({ id: '3', lat: 45.43, lng: 12.33 }),
    ],
    TODAY
  );
  const pins = groupPins(shows);
  assert.equal(pins.length, 2);
  assert.equal(pins[0].items.length, 2);
  console.log('✅ groupPins: one pin per distinct location');
}

{
  assert.deepEqual(
    fitPoints([
      [46, 13],
      [-33, 151],
    ]),
    [[46, 13]]
  );
  assert.deepEqual(fitPoints([[-33, 151]]), [[-33, 151]]);
  console.log(
    '✅ fitPoints: ignores points outside Europe unless none is inside'
  );
}


// ── saved queries (shareable link) ───────────────────────────────────────────
{ const q = buildTourQuery({
    keyword: 'sigur',
    from: '2030-11-01',
    to: '2030-12-31',
    origin: { lat: 46.06371234, lng: 13.23531234 },
    radius: 50,
    place: 'Udine',
  });
  const p = new URLSearchParams(q);
  assert.equal(p.get('q'), 'sigur');
  assert.equal(p.get('from'), '2030-11-01');
  assert.equal(p.get('to'), '2030-12-31');
  assert.equal(p.get('lat'), '46.0637');
  assert.equal(p.get('lng'), '13.2353');
  assert.equal(p.get('radius'), '50');
  assert.equal(p.get('place'), 'Udine');
  assert.ok(!q.startsWith('?'));
  console.log('✅ buildTourQuery: filters → query string (coordinates rounded to 4 decimals)'); }

{ assert.equal(buildTourQuery({}), '');
  assert.equal(buildTourQuery({ keyword: '  ', from: '', to: '' }), '');
  const noOrigin = new URLSearchParams(buildTourQuery({ keyword: 'a', radius: 250, place: 'Udine' }));
  assert.equal(noOrigin.get('q'), 'a');
  assert.ok(!noOrigin.has('radius') && !noOrigin.has('place') && !noOrigin.has('lat'));
  const noPlace = new URLSearchParams(buildTourQuery({ origin: { lat: 1, lng: 2 }, radius: 100 }));
  assert.ok(!noPlace.has('place'));
  console.log('✅ buildTourQuery: empty filters are omitted; radius and place only travel with an origin'); }

{ const r = parseTourQuery('?q=sigur&from=2030-11-01&to=2030-12-31&lat=46.0637&lng=13.2353&radius=50&place=Udine');
  assert.deepEqual(r, {
    keyword: 'sigur',
    from: '2030-11-01',
    to: '2030-12-31',
    origin: { lat: 46.0637, lng: 13.2353 },
    radius: 50,
    place: 'Udine',
    newOnly: false,
  });
  assert.deepEqual(parseTourQuery('q=a'), { keyword: 'a', from: '', to: '', origin: null, radius: DEFAULT_RADIUS_KM, place: '', newOnly: false });
  assert.deepEqual(parseTourQuery(''), { keyword: '', from: '', to: '', origin: null, radius: DEFAULT_RADIUS_KM, place: '', newOnly: false });
  console.log('✅ parseTourQuery: query string → filters, with or without the leading ?'); }

{ const bad = parseTourQuery('?from=bad&to=2030-13-45&lat=999&lng=13&radius=7&place=X');
  assert.equal(bad.from, '');
  assert.equal(bad.to, '');
  assert.equal(bad.origin, null);
  assert.equal(bad.radius, DEFAULT_RADIUS_KM);
  assert.equal(bad.place, '', 'place is ignored without a valid origin');
  assert.equal(parseTourQuery('?lat=46').origin, null);
  assert.equal(parseTourQuery('?lat=a&lng=b').origin, null);
  assert.equal(parseTourQuery('?lat=46&lng=13&radius=100000').radius, DEFAULT_RADIUS_KM);
  assert.equal(parseTourQuery('?q=' + 'x'.repeat(500)).keyword.length, 200, 'keyword is capped');
  console.log('✅ parseTourQuery: invalid dates, coordinates, radii are dropped; keyword capped'); }

{ const state = {
    keyword: 'Sigur Rós & friends',
    from: '2030-11-01',
    to: '',
    origin: { lat: 46.0637, lng: 13.2353 },
    radius: 250,
    place: 'Udine, Italy',
    newOnly: false,
  };
  assert.deepEqual(parseTourQuery('?' + buildTourQuery(state)), state);
  console.log('✅ saved query: round trip, including special characters'); }


// ── "new" shows (first published in the last NEW_DAYS days) ──────────────────
{ const NOW = Date.parse('2030-10-10T12:00:00Z');
  const showAt = created => toShows([ev({ id: 'n', created_at: created })], TODAY)[0];
  assert.equal(NEW_DAYS, 7);
  assert.equal(showAt('2030-10-09T08:00:00').createdAt, '2030-10-09T08:00:00', 'toShow keeps created_at');
  assert.equal(isNewShow(showAt('2030-10-09T08:00:00'), NOW), true, 'yesterday is new');
  assert.equal(isNewShow(showAt('2030-10-03T12:00:01'), NOW), true, 'just under 7 days is new');
  assert.equal(isNewShow(showAt('2030-10-03T11:59:59'), NOW), false, 'just over 7 days is not');
  assert.equal(isNewShow(showAt('2030-09-01T00:00:00'), NOW), false, 'old');
  assert.equal(isNewShow(showAt('2030-10-10T12:30:00'), NOW), true, 'a slightly future created_at (clock skew) is new');
  assert.equal(isNewShow(showAt('2030-10-20T00:00:00'), NOW), false, 'a far-future created_at is not trusted');
  assert.equal(isNewShow({ createdAt: '' }, NOW), false);
  assert.equal(isNewShow({ createdAt: 'garbage' }, NOW), false);
  assert.equal(isNewShow({}, NOW), false);
  assert.equal(isNewShow(showAt('2030-10-08T12:00:00'), NOW, 1), false, 'the window can be passed in');
  // created_at is UTC: "2030-10-03T11:59:59" is 7 days minus 1 s before NOW's 12:00:00Z only if read as UTC
  console.log('✅ isNewShow: created in the last 7 days, read as UTC; bad or far-future values are not new'); }

{ const NOW = Date.parse('2030-10-10T12:00:00Z');
  const shows = toShows(
    [
      ev({ id: 'new1', created_at: '2030-10-09T08:00:00', start_time: '2030-11-12T21:00:00' }),
      ev({ id: 'old1', created_at: '2030-09-01T08:00:00', start_time: '2030-11-13T21:00:00' }),
      ev({ id: 'old2', act_name: 'Other Band', act_url: 'https://other.example', created_at: '2030-09-01T08:00:00' }),
      ev({ id: 'new2', act_name: 'Third Band', act_url: 'https://third.example', created_at: '2030-10-09T09:00:00', start_time: '2030-12-01T21:00:00' }),
      ev({ id: 'new3', act_name: 'Third Band', act_url: 'https://third.example', created_at: '2030-10-09T09:00:00', start_time: '2030-12-02T21:00:00' }),
    ],
    TODAY
  );
  const ids = list => list.map(s => s.id);
  assert.deepEqual(ids(filterShows(shows, { newOnly: true, nowMs: NOW })), ['new1', 'new2', 'new3']);
  assert.deepEqual(ids(filterShows(shows, { newOnly: false, nowMs: NOW })).length, 5);
  assert.deepEqual(ids(filterShows(shows, { newOnly: true, nowMs: NOW, keyword: 'third' })), ['new2', 'new3'], 'new-only combines with the other filters');
  console.log('✅ filterShows: newOnly keeps only new shows'); }

{ const NOW = Date.parse('2030-10-10T12:00:00Z');
  const shows = toShows(
    [
      ev({ id: 'a', created_at: '2030-10-09T08:00:00', start_time: '2030-11-12T21:00:00' }),
      ev({ id: 'b', created_at: '2030-09-01T08:00:00', start_time: '2030-11-13T21:00:00' }),
      ev({ id: 'c', act_name: 'Other Band', act_url: 'https://other.example', created_at: '2030-09-01T08:00:00' }),
      ev({ id: 'd', act_name: 'Third Band', act_url: 'https://third.example', created_at: '2030-10-09T09:00:00', start_time: '2030-12-01T21:00:00' }),
      ev({ id: 'e', act_name: 'Third Band', act_url: 'https://third.example', created_at: '2030-10-09T09:00:00', start_time: '2030-12-02T21:00:00' }),
    ],
    TODAY
  );
  const bands = groupByBand(shows, NOW);
  const byName = Object.fromEntries(bands.map(b => [b.name, b]));
  assert.equal(byName['Test Band'].newCount, 1);
  assert.equal(byName['Other Band'].newCount, 0);
  assert.equal(byName['Third Band'].newCount, 2);
  assert.deepEqual(bands.map(b => b.name), groupByBand(shows).map(b => b.name), 'new bands are not reordered');
  assert.equal(groupByBand(shows)[0].newCount, 0, 'without a clock nothing is new');
  console.log('✅ groupByBand: newCount per band; order unchanged'); }

{ assert.equal(new URLSearchParams(buildTourQuery({ newOnly: true })).get('new'), '1');
  assert.equal(buildTourQuery({ newOnly: false }), '');
  assert.equal(parseTourQuery('?new=1').newOnly, true);
  assert.equal(parseTourQuery('?new=0').newOnly, false);
  assert.equal(parseTourQuery('?new=yes').newOnly, false);
  assert.equal(parseTourQuery('').newOnly, false);
  const state = { keyword: 'a', from: '', to: '', origin: null, radius: DEFAULT_RADIUS_KM, place: '', newOnly: true };
  assert.deepEqual(parseTourQuery('?' + buildTourQuery(state)), state);
  console.log('✅ saved query: the New-only toggle travels in the link'); }

{ assert.equal(fmtNewBadge(0), '');
  assert.equal(fmtNewBadge(undefined), '');
  assert.equal(fmtNewBadge(1), 'NEW');
  assert.equal(fmtNewBadge(3), 'NEW · 3');
  console.log('✅ fmtNewBadge: NEW, or NEW · n for several, nothing for none'); }

// ── tracked bands ────────────────────────────────────────────────────────────
{ assert.equal(parseTracked(null), null);
  assert.equal(parseTracked({}), null);
  assert.equal(parseTracked({ bands: 'x' }), null);
  assert.equal(parseTracked([]), null);
  const ok = parseTracked({
    generated: '2030-10-07',
    bands: [
      { name: ' Alpha ', url: 'https://alpha.example' },
      { name: 'No url' },
      { name: '', url: 'https://empty.example' },
      { name: 'Bad scheme', url: 'javascript:alert(1)' },
      null,
      { name: 'Beta', url: 'http://beta.example/live' },
    ],
  });
  assert.equal(ok.generated, '2030-10-07');
  assert.deepEqual(ok.bands.map(b => b.name), ['Alpha', 'Beta']);
  assert.equal(parseTracked({ bands: [] }).generated, '');
  console.log('✅ parseTracked: validates the file; keeps only well-formed http(s) bands, trimmed'); }

{ const shows = toShows(
    [
      ev({ id: '1', start_time: '2030-11-12T21:00:00' }),
      ev({ id: '2', start_time: '2030-11-13T21:00:00' }),
      ev({ id: '3', act_name: 'Beta', act_url: 'https://beta.example', start_time: '2030-11-14T21:00:00' }),
      ev({ id: '4', act_name: 'Stranger', act_url: 'https://stranger.example', start_time: '2030-11-15T21:00:00' }),
    ],
    TODAY
  );
  const tracked = [
    { name: 'Zed', url: 'https://zed.example' },
    { name: 'Test Band', url: 'https://testband.example/' }, // trailing slash in the file
    { name: 'Beta', url: 'https://BETA.example' }, // case in the host
  ];
  const rows = mergeTracked(tracked, shows);
  assert.deepEqual(rows.map(r => r.name), ['Beta', 'Stranger', 'Test Band', 'Zed'], 'alphabetical, tracked bands plus bands that only have shows');
  const by = Object.fromEntries(rows.map(r => [r.name, r]));
  assert.equal(by['Test Band'].upcoming, 2);
  assert.equal(by['Beta'].upcoming, 1);
  assert.equal(by['Zed'].upcoming, 0);
  assert.equal(by['Stranger'].upcoming, 1);
  assert.equal(by['Stranger'].tracked, false);
  assert.equal(by['Zed'].tracked, true);
  assert.equal(by['Test Band'].url, 'https://testband.example/', 'the link is the url from the file');
  assert.deepEqual(mergeTracked(null, shows).map(r => r.name), ['Beta', 'Stranger', 'Test Band'], 'without a file: bands from the shows');
  assert.deepEqual(mergeTracked([], []), []);
  assert.deepEqual(mergeTracked([{ name: 'A', url: 'https://a.example' }, { name: 'A again', url: 'https://a.example/' }], []).map(r => r.name), ['A'], 'the same site twice appears once');
  console.log('✅ mergeTracked: matches shows to tracked bands by site (case, trailing slash), adds the others, sorted'); }

// ── loadTourEvents ───────────────────────────────────────────────────────────
{
  const pages = [
    { events: [ev({ id: '1' }), ev({ id: '2' })], has_more: true },
    { events: [ev({ id: '3' })], has_more: false },
  ];
  const urls = [];
  let i = 0;
  const fetchFn = async url => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => pages[i++] };
  };
  const { events, truncated } = await loadTourEvents(
    fetchFn,
    'https://api.example',
    tourWindow(TODAY)
  );
  assert.equal(events.length, 3);
  assert.equal(truncated, false);
  assert.ok(
    urls[1].includes('offset=2'),
    'second page starts after the first page’s events'
  );

  const endless = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ events: [ev({})], has_more: true }),
  });
  const capped = await loadTourEvents(
    endless,
    'https://api.example',
    tourWindow(TODAY),
    3
  );
  assert.equal(capped.truncated, true);
  assert.equal(capped.events.length, 3);

  await assert.rejects(
    loadTourEvents(
      async () => ({ ok: false, status: 500 }),
      'https://api.example',
      tourWindow(TODAY)
    ),
    /500/
  );
  console.log(
    '✅ loadTourEvents: follows has_more, caps pages, rejects on HTTP errors'
  );
}

console.log('\nAll tours.js tests passed.');
