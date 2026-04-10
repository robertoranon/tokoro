import type { ExtractedEvent } from '../types/event.js';

const FULL_DAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

/** Normalize a day name string to a full English weekday name, or null if unrecognized. */
function normalizeDayName(raw: string): string | null {
  const lower = raw.toLowerCase().trim();
  return FULL_DAY_NAMES.find(d => d.toLowerCase() === lower) ?? null;
}

/** Return the UTC day of week name for an ISO date string like "2026-04-19T20:00:00". */
function weekdayOf(isoDate: string): string {
  const datePart = isoDate.slice(0, 10);
  const d = new Date(`${datePart}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

/** Replace the 4-digit year in an ISO datetime string. */
function replaceYear(isoDatetime: string, toYear: number): string {
  return `${toYear}${isoDatetime.slice(4)}`;
}

/**
 * Validate the year in an extracted event using its `day_name` field.
 *
 * Requires start_time to be an ISO string; numeric timestamps are returned unchanged.
 *
 * - If `day_name` is absent: return event unchanged (minus day_name field).
 * - If day matches current year: keep, strip day_name.
 * - If day matches year+1: correct start_time/end_time, strip day_name.
 * - If day matches year-1: drop (past event), return null.
 * - If day matches nothing in ±1: drop (unresolvable), return null.
 */
export function correctEventYear(event: ExtractedEvent): ExtractedEvent | null {
  const { day_name, ...rest } = event;

  if (!day_name) {
    return rest as ExtractedEvent;
  }

  // Can only validate year on ISO string timestamps; numeric timestamps skip correction
  if (typeof event.start_time === 'number') {
    console.warn(`⚠ Cannot validate day_name for "${event.title}": start_time is numeric`);
    return rest as ExtractedEvent;
  }

  const normalized = normalizeDayName(day_name);
  if (!normalized) {
    console.warn(`⚠ Unrecognized day_name "${day_name}" for "${event.title}", ignoring`);
    return rest as ExtractedEvent;
  }

  const startIso = String(event.start_time);
  const year = parseInt(startIso.slice(0, 4), 10);
  const actualDay = weekdayOf(startIso);

  if (actualDay === normalized) {
    return rest as ExtractedEvent;
  }

  const yearPlus1Day = weekdayOf(replaceYear(startIso, year + 1));
  if (yearPlus1Day === normalized) {
    const newStart = replaceYear(startIso, year + 1);
    const newEnd = rest.end_time && typeof rest.end_time === 'string'
      ? replaceYear(rest.end_time, year + 1)
      : rest.end_time;
    return { ...rest, start_time: newStart, end_time: newEnd } as ExtractedEvent;
  }

  const yearMinus1Day = weekdayOf(replaceYear(startIso, year - 1));
  if (yearMinus1Day === normalized) {
    console.log(`⚠ Skipping past event (day mismatch, year-1): "${event.title}" (${event.start_time})`);
    return null;
  }

  console.log(`⚠ Skipping event (day name unresolvable): "${event.title}" (${event.start_time}, day_name: ${day_name})`);
  return null;
}
