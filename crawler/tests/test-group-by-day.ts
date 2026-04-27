import { groupEventsByDay } from '../src/crawler.js';
import type { ExtractedEvent } from '../src/types/event.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

function makeEvent(
  overrides: Partial<ExtractedEvent> & { start_time: string }
): ExtractedEvent {
  return {
    title: 'Test Event',
    category: 'music',
    ...overrides,
  };
}

console.log('\n=== groupEventsByDay tests ===\n');

console.log('Empty array → empty array');
{
  const result = groupEventsByDay([], 'My Festival');
  assert(result.length === 0, 'returns empty array');
}

console.log(
  '\nSingle event on a day → passes through unchanged (no title rewrite)'
);
{
  const event = makeEvent({
    title: 'Jazz Night',
    start_time: '2026-07-11T20:00:00',
    venue_name: 'Blue Note',
  });
  const result = groupEventsByDay([event], 'My Festival');
  assert(result.length === 1, 'one event returned');
  assert(
    result[0].title === 'Jazz Night',
    `title unchanged, got "${result[0].title}"`
  );
  assert(
    result[0].start_time === '2026-07-11T20:00:00',
    `start_time unchanged, got "${result[0].start_time}"`
  );
  assert(result[0].venue_name === 'Blue Note', 'venue_name unchanged');
}

console.log(
  '\nTwo events on same day → aggregate event with namePrefix in title'
);
{
  const e1 = makeEvent({
    title: 'Morning Set',
    start_time: '2026-07-11T10:00:00',
    venue_name: 'Stage A',
  });
  const e2 = makeEvent({
    title: 'Evening Set',
    start_time: '2026-07-11T20:00:00',
    venue_name: 'Stage B',
  });
  const result = groupEventsByDay([e1, e2], 'Flow Festival');
  assert(result.length === 1, 'one aggregate event returned');
  // 2026-07-11 is a Saturday
  assert(
    result[0].title === 'Flow Festival – Saturday, July 11',
    `aggregate title correct, got "${result[0].title}"`
  );
  assert(
    result[0].start_time === '2026-07-11T00:00:00',
    'start_time is start of day'
  );
  assert(
    result[0].end_time === '2026-07-11T23:59:59',
    'end_time is end of day'
  );
  assert(
    result[0].description?.includes('10:00'),
    'description contains 10:00'
  );
  assert(
    result[0].description?.includes('20:00'),
    'description contains 20:00'
  );
}

console.log(
  '\nEvents across two days → one aggregate event per day (both multi-event)'
);
{
  const e1 = makeEvent({ title: 'Act A', start_time: '2026-07-11T10:00:00' });
  const e2 = makeEvent({ title: 'Act B', start_time: '2026-07-11T20:00:00' });
  const e3 = makeEvent({ title: 'Act C', start_time: '2026-07-12T10:00:00' });
  const e4 = makeEvent({ title: 'Act D', start_time: '2026-07-12T18:00:00' });
  const result = groupEventsByDay([e1, e2, e3, e4], 'Flow Festival');
  assert(result.length === 2, `two aggregate events, got ${result.length}`);
  assert(result[0].start_time === '2026-07-11T00:00:00', 'first day correct');
  assert(result[1].start_time === '2026-07-12T00:00:00', 'second day correct');
}

console.log(
  '\nDay 1 single event + Day 2 two events → day 1 unchanged, day 2 aggregated'
);
{
  const e1 = makeEvent({
    title: 'Solo Show',
    start_time: '2026-07-11T20:00:00',
  });
  const e2 = makeEvent({ title: 'Act A', start_time: '2026-07-12T10:00:00' });
  const e3 = makeEvent({ title: 'Act B', start_time: '2026-07-12T18:00:00' });
  const result = groupEventsByDay([e1, e2, e3], 'Flow Festival');
  assert(result.length === 2, `two results, got ${result.length}`);
  assert(
    result[0].title === 'Solo Show',
    `day 1 title unchanged, got "${result[0].title}"`
  );
  assert(
    result[1].title === 'Flow Festival – Sunday, July 12',
    `day 2 aggregated, got "${result[1].title}"`
  );
}

console.log('\nWithin-day deduplication by title for multi-event days');
{
  const e1 = makeEvent({
    title: 'Jazz Night',
    start_time: '2026-07-11T20:00:00',
  });
  const e2 = makeEvent({
    title: 'Jazz Night',
    start_time: '2026-07-11T20:00:00',
  }); // duplicate
  const e3 = makeEvent({
    title: 'Rock Show',
    start_time: '2026-07-11T22:00:00',
  });
  const result = groupEventsByDay([e1, e2, e3], 'My Fest');
  assert(result.length === 1, 'one aggregate event');
  assert(result[0].title === 'My Fest – Saturday, July 11', `title aggregated`);
  const descLines = result[0].description?.split('\n') ?? [];
  assert(
    descLines.length === 2,
    `description has 2 lines (deduped), got ${descLines.length}`
  );
}

console.log('\nfestival_name / festival_url preserved on aggregate event');
{
  const e1 = makeEvent({
    title: 'Act A',
    start_time: '2026-07-11T10:00:00',
    festival_name: 'Flow 2026',
    festival_url: 'https://flowfestival.com',
  });
  const e2 = makeEvent({
    title: 'Act B',
    start_time: '2026-07-11T20:00:00',
    festival_name: 'Flow 2026',
    festival_url: 'https://flowfestival.com',
  });
  const result = groupEventsByDay([e1, e2], 'Flow 2026');
  assert(result[0].festival_name === 'Flow 2026', 'festival_name preserved');
  assert(
    result[0].festival_url === 'https://flowfestival.com',
    'festival_url preserved'
  );
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
