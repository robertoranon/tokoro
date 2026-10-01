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

// --- add new test sections above this line ---

console.log('\nAll festivals tests passed');
