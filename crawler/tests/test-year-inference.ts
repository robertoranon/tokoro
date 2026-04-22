import { correctEventYear } from '../../shared/extractors/year-inference.js';
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

function makeEvent(overrides: Partial<ExtractedEvent>): ExtractedEvent {
  return {
    title: 'Test Event',
    start_time: '2026-04-19T20:00:00', // April 19, 2026 is a Sunday
    category: 'music',
    ...overrides,
  };
}

console.log('\n=== correctEventYear tests ===\n');

// Helper: April 19 2026 = Sunday, April 19 2025 = Saturday, April 19 2027 = Monday
// Helper: April 20 2025 = Sunday, April 20 2026 = Monday

console.log('No day_name: event returned unchanged');
{
  const event = makeEvent({ start_time: '2025-04-20T20:00:00' });
  const result = correctEventYear(event);
  assert(result !== null, 'event not dropped');
  assert(result?.start_time === '2025-04-20T20:00:00', 'start_time unchanged');
  assert(!('day_name' in (result ?? {})), 'day_name stripped');
}

console.log('\nday_name matches current year: keep, strip day_name');
{
  const event = makeEvent({
    start_time: '2026-04-19T20:00:00',
    day_name: 'Sunday',
  });
  const result = correctEventYear(event);
  assert(result !== null, 'event kept');
  assert(result?.start_time === '2026-04-19T20:00:00', 'start_time unchanged');
  assert(!('day_name' in (result ?? {})), 'day_name stripped');
}

console.log('\nday_name matches year+1: correct to next year');
{
  // April 19 2027 = Monday
  const event = makeEvent({
    start_time: '2026-04-19T20:00:00',
    day_name: 'Monday',
  });
  const result = correctEventYear(event);
  assert(result !== null, 'event kept');
  assert(
    result?.start_time === '2027-04-19T20:00:00',
    `start_time corrected to 2027, got ${result?.start_time}`
  );
  assert(!('day_name' in (result ?? {})), 'day_name stripped');
}

console.log('\nday_name matches year+1: end_time also corrected');
{
  const event = makeEvent({
    start_time: '2026-04-19T20:00:00',
    end_time: '2026-04-19T23:00:00',
    day_name: 'Monday', // matches 2027
  });
  const result = correctEventYear(event);
  assert(
    result?.end_time === '2027-04-19T23:00:00',
    `end_time corrected to 2027, got ${result?.end_time}`
  );
}

console.log('\nday_name matches year-1: drop (past event)');
{
  // April 19 2025 = Saturday
  const event = makeEvent({
    start_time: '2026-04-19T20:00:00',
    day_name: 'Saturday',
  });
  const result = correctEventYear(event);
  assert(result === null, 'event dropped (year-1 match)');
}

console.log('\nday_name matches nothing in ±1: drop (unresolvable)');
{
  // No year has April 19 on a Wednesday within ±1 of 2026
  const event = makeEvent({
    start_time: '2026-04-19T20:00:00',
    day_name: 'Wednesday',
  });
  const result = correctEventYear(event);
  assert(result === null, 'event dropped (unresolvable)');
}

console.log('\nday_name case-insensitive');
{
  const event = makeEvent({
    start_time: '2026-04-19T20:00:00',
    day_name: 'sunday',
  });
  const result = correctEventYear(event);
  assert(result !== null, 'event kept with lowercase day_name');
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
