import {
  activeFestivals,
  normalizeFestivalUrl,
  type FestivalsConfig,
} from './festivals-config.js';

export interface TrackedFestivals {
  /** YYYY-MM-DD, when the list was exported. */
  generated: string;
  festivals: { name: string; url: string }[];
}

/**
 * The public list of festivals on the radar: active entries only, and only
 * name and homepage url. Notes, fetcher and other curator data stay out.
 */
export function buildTrackedFestivals(
  config: FestivalsConfig,
  today: string
): TrackedFestivals {
  const seen = new Set<string>();
  const festivals: { name: string; url: string }[] = [];
  for (const f of activeFestivals(config)) {
    const url = normalizeFestivalUrl(f.url);
    if (seen.has(url)) continue;
    seen.add(url);
    festivals.push({ name: f.name || new URL(url).hostname, url });
  }
  festivals.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
  return { generated: today, festivals };
}

/**
 * Members follow a festival by its url, so the url must not change from one
 * edition to the next. Flags active entries whose url contains a year.
 */
export function yearInUrlWarnings(config: FestivalsConfig): string[] {
  return activeFestivals(config)
    .filter(f => /(19|20)\d\d/.test(f.url))
    .map(
      f =>
        `Warning: ${f.url} contains a year; use an address that stays the same from one edition to the next, or members will lose track of this festival.`
    );
}
