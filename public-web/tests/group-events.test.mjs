import { createRequire } from 'module';
const { groupEvents, groupFestivals } = createRequire(import.meta.url)('../group-events.js');
import assert from 'node:assert/strict';

// Helper to make a minimal event
function evt(id, title, venue, start, url) {
  return { id, title, venue_name: venue, start_time: start, end_time: null, category: 'film', tags: [], url };
}

function fevt(id, title, festUrl, festName, start) {
  return { id, title, festival_url: festUrl, festival_name: festName,
           venue_name: null, start_time: start, end_time: null,
           category: 'music', tags: [], url: null };
}

// ── Test 1: two events with same title+venue form a group ─────────────────────
{
  const events = [
    evt('a', 'The Brutalist', 'Cinemazero', '2026-03-20T21:00:00', 'https://ex.com/1'),
    evt('b', 'The Brutalist', 'Cinemazero', '2026-03-21T18:00:00', 'https://ex.com/2'),
  ];
  const result = groupEvents(events);
  assert.equal(result.length, 1, 'two same-title+venue events should form one group');
  assert.equal(result[0].type, 'group');
  assert.equal(result[0].instances.length, 2);
  console.log('✅ two same-title+venue events form a group');
}

// ── Test 2: single event stays as-is (no group) ───────────────────────────────
{
  const events = [
    evt('a', 'The Brutalist', 'Cinemazero', '2026-03-20T21:00:00', 'https://ex.com/1'),
  ];
  const result = groupEvents(events);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'single');
  console.log('✅ single event stays as single');
}

// ── Test 3: different titles at same venue → no group ─────────────────────────
{
  const events = [
    evt('a', 'Dune',         'Cinemazero', '2026-03-20T21:00:00', 'https://ex.com/1'),
    evt('b', 'The Brutalist','Cinemazero', '2026-03-20T18:00:00', 'https://ex.com/2'),
  ];
  const result = groupEvents(events);
  assert.equal(result.length, 2);
  assert.equal(result[0].type, 'single');
  assert.equal(result[1].type, 'single');
  console.log('✅ different titles at same venue stay separate');
}

// ── Test 4: same title at different venues → no group ─────────────────────────
{
  const events = [
    evt('a', 'Dune', 'Cinemazero',   '2026-03-20T21:00:00', 'https://ex.com/1'),
    evt('b', 'Dune', 'Visionario', '2026-03-20T18:00:00', 'https://ex.com/2'),
  ];
  const result = groupEvents(events);
  assert.equal(result.length, 2);
  console.log('✅ same title at different venues stay separate');
}

// ── Test 5: grouping is case-insensitive ──────────────────────────────────────
{
  const events = [
    evt('a', 'the brutalist', 'cinemazero', '2026-03-20T21:00:00', 'https://ex.com/1'),
    evt('b', 'The Brutalist', 'Cinemazero', '2026-03-21T18:00:00', 'https://ex.com/2'),
  ];
  const result = groupEvents(events);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'group');
  console.log('✅ grouping is case-insensitive');
}

// ── Test 6: instances within a group are sorted ascending by start_time ───────
{
  const events = [
    evt('a', 'The Brutalist', 'Cinemazero', '2026-03-22T18:00:00', 'https://ex.com/1'),
    evt('b', 'The Brutalist', 'Cinemazero', '2026-03-20T21:00:00', 'https://ex.com/2'),
    evt('c', 'The Brutalist', 'Cinemazero', '2026-03-21T18:00:00', 'https://ex.com/3'),
  ];
  const result = groupEvents(events);
  assert.equal(result.length, 1);
  const times = result[0].instances.map(i => i.start_time);
  assert.deepEqual(times, ['2026-03-20T21:00:00', '2026-03-21T18:00:00', '2026-03-22T18:00:00']);
  console.log('✅ group instances sorted ascending by start_time');
}

// ── Test 7: group carries shared metadata from first (earliest) instance ──────
{
  const events = [
    evt('a', 'The Brutalist', 'Cinemazero', '2026-03-22T18:00:00', 'https://ex.com/late'),
    evt('b', 'The Brutalist', 'Cinemazero', '2026-03-20T21:00:00', 'https://ex.com/early'),
  ];
  const result = groupEvents(events);
  assert.equal(result[0].event.id, 'b', 'group metadata comes from earliest instance');
  console.log('✅ group metadata comes from earliest instance');
}

// ── Test 8: mixed — some grouped, some not ────────────────────────────────────
{
  const events = [
    evt('a', 'The Brutalist', 'Cinemazero', '2026-03-20T21:00:00', 'https://ex.com/1'),
    evt('b', 'The Brutalist', 'Cinemazero', '2026-03-21T18:00:00', 'https://ex.com/2'),
    evt('c', 'Jazz Night',    'Blue Note',  '2026-03-20T21:00:00', 'https://ex.com/3'),
  ];
  const result = groupEvents(events);
  assert.equal(result.length, 2);
  const types = result.map(r => r.type);
  assert.ok(types.includes('group'));
  assert.ok(types.includes('single'));
  console.log('✅ mixed: group and single coexist');
}

// ── groupFestivals: 3+ events → festival item ─────────────────────────────────
{
  const events = [
    fevt('a', 'Act 1', 'https://flowfestival.com', 'Flow Festival 2026', '2026-08-14T18:00:00'),
    fevt('b', 'Act 2', 'https://flowfestival.com', 'Flow Festival 2026', '2026-08-15T20:00:00'),
    fevt('c', 'Act 3', 'https://flowfestival.com', 'Flow Festival 2026', '2026-08-16T19:00:00'),
  ];
  const { festivalItems, remainingEvents } = groupFestivals(events);
  assert.equal(festivalItems.length, 1, '3 events with same festival_url → one festival item');
  assert.equal(festivalItems[0].type, 'festival');
  assert.equal(festivalItems[0].festival_name, 'Flow Festival 2026');
  assert.equal(festivalItems[0].festival_url, 'https://flowfestival.com');
  assert.equal(festivalItems[0].events.length, 3);
  assert.equal(remainingEvents.length, 0);
  console.log('✅ groupFestivals: 3+ events form a festival item');
}

// ── groupFestivals: 2 events → NOT a festival (threshold) ────────────────────
{
  const events = [
    fevt('a', 'Act 1', 'https://flowfestival.com', 'Flow Festival 2026', '2026-08-14T18:00:00'),
    fevt('b', 'Act 2', 'https://flowfestival.com', 'Flow Festival 2026', '2026-08-15T20:00:00'),
  ];
  const { festivalItems, remainingEvents } = groupFestivals(events);
  assert.equal(festivalItems.length, 0, '2 events → not a festival');
  assert.equal(remainingEvents.length, 2);
  console.log('✅ groupFestivals: 2 events stay as remainingEvents (below threshold)');
}

// ── groupFestivals: events without festival_url go to remainingEvents ─────────
{
  const events = [
    fevt('a', 'Act 1', 'https://flowfestival.com', 'Flow Festival 2026', '2026-08-14T18:00:00'),
    fevt('b', 'Act 2', 'https://flowfestival.com', 'Flow Festival 2026', '2026-08-15T20:00:00'),
    fevt('c', 'Act 3', 'https://flowfestival.com', 'Flow Festival 2026', '2026-08-16T19:00:00'),
    { id: 'd', title: 'Jazz Night', festival_url: null, festival_name: null,
      venue_name: 'Blue Note', start_time: '2026-08-15T21:00:00',
      end_time: null, category: 'music', tags: [], url: null },
  ];
  const { festivalItems, remainingEvents } = groupFestivals(events);
  assert.equal(festivalItems.length, 1);
  assert.equal(remainingEvents.length, 1);
  assert.equal(remainingEvents[0].id, 'd');
  console.log('✅ groupFestivals: non-festival events go to remainingEvents');
}

// ── groupFestivals: festival events sorted by start_time ─────────────────────
{
  const events = [
    fevt('a', 'Act 3', 'https://flowfestival.com', 'Flow', '2026-08-16T19:00:00'),
    fevt('b', 'Act 1', 'https://flowfestival.com', 'Flow', '2026-08-14T18:00:00'),
    fevt('c', 'Act 2', 'https://flowfestival.com', 'Flow', '2026-08-15T20:00:00'),
  ];
  const { festivalItems } = groupFestivals(events);
  const times = festivalItems[0].events.map(e => e.start_time);
  assert.deepEqual(times, [
    '2026-08-14T18:00:00',
    '2026-08-15T20:00:00',
    '2026-08-16T19:00:00',
  ]);
  console.log('✅ groupFestivals: events inside festival sorted by start_time');
}

// ── groupFestivals: multiple festivals sorted by earliest event ───────────────
{
  const events = [
    fevt('a', 'Act', 'https://fest-b.com', 'Fest B', '2026-09-01T18:00:00'),
    fevt('b', 'Act', 'https://fest-b.com', 'Fest B', '2026-09-02T18:00:00'),
    fevt('c', 'Act', 'https://fest-b.com', 'Fest B', '2026-09-03T18:00:00'),
    fevt('d', 'Act', 'https://fest-a.com', 'Fest A', '2026-08-01T18:00:00'),
    fevt('e', 'Act', 'https://fest-a.com', 'Fest A', '2026-08-02T18:00:00'),
    fevt('f', 'Act', 'https://fest-a.com', 'Fest A', '2026-08-03T18:00:00'),
  ];
  const { festivalItems } = groupFestivals(events);
  assert.equal(festivalItems.length, 2);
  assert.equal(festivalItems[0].festival_url, 'https://fest-a.com', 'earlier festival comes first');
  assert.equal(festivalItems[1].festival_url, 'https://fest-b.com');
  console.log('✅ groupFestivals: multiple festivals sorted by earliest event');
}

// ── groupFestivals: falls back to festival_url when festival_name is absent ───
{
  const events = [
    { id: 'a', title: 'Act 1', festival_url: 'https://fest.com', festival_name: null,
      venue_name: null, start_time: '2026-08-14T18:00:00', end_time: null,
      category: 'music', tags: [], url: null },
    { id: 'b', title: 'Act 2', festival_url: 'https://fest.com', festival_name: null,
      venue_name: null, start_time: '2026-08-15T18:00:00', end_time: null,
      category: 'music', tags: [], url: null },
    { id: 'c', title: 'Act 3', festival_url: 'https://fest.com', festival_name: null,
      venue_name: null, start_time: '2026-08-16T18:00:00', end_time: null,
      category: 'music', tags: [], url: null },
  ];
  const { festivalItems } = groupFestivals(events);
  assert.equal(festivalItems[0].festival_name, 'https://fest.com', 'falls back to url when festival_name is null');
  console.log('✅ groupFestivals: festival_name falls back to festival_url when absent');
}

console.log('\n✅ All tests passed');
