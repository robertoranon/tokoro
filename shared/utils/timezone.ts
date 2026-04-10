/**
 * Timezone lookup and local-time conversion utilities.
 * Uses only fetch + Intl — works in Node.js and Cloudflare Workers.
 */

/**
 * Look up the IANA timezone name for a coordinate via timeapi.io (free, no key required).
 * Returns undefined on any failure.
 */
export async function lookupTimezone(lat: number, lng: number): Promise<string | undefined> {
  try {
    const response = await fetch(
      `https://timeapi.io/api/timezone/coordinate?latitude=${lat}&longitude=${lng}`
    );
    if (!response.ok) return undefined;
    const data = await response.json() as { timeZone?: string };
    return data.timeZone ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Convert a datetime string that includes a UTC offset or Z suffix to the local wall-clock
 * time in the given IANA timezone.
 * Returns an ISO 8601 string without timezone ("YYYY-MM-DDTHH:MM:SS"), or undefined on failure.
 *
 * Example: convertToLocalTime("2026-03-13T19:30:00Z", "Europe/Rome") → "2026-03-13T20:30:00"
 */
export function convertToLocalTime(datetimeWithTz: string, ianaTimezone: string): string | undefined {
  try {
    const date = new Date(datetimeWithTz);
    if (isNaN(date.getTime())) return undefined;

    // sv-SE locale produces "YYYY-MM-DD HH:MM:SS" — easy to reshape
    const formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone: ianaTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    const parts = formatter.formatToParts(date);
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
  } catch {
    return undefined;
  }
}

/**
 * Returns true if the time portion of an ISO string is midnight (00:00:00),
 * which typically means the LLM couldn't find an explicit start time and used a placeholder.
 */
export function isPlaceholderTime(timeStr: string): boolean {
  return /T00:00(:\d{2})?$/.test(timeStr);
}
