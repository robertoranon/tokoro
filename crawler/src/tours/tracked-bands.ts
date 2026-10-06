import { activeBands, type BandsConfig } from './bands-config.js';

export interface TrackedBands {
  /** YYYY-MM-DD, when the list was exported. */
  generated: string;
  bands: { name: string; url: string }[];
}

/**
 * The public list of bands the tours crawler follows: active bands only, and
 * only name and site url. Notes, aliases, regions and status are curator
 * data and stay out of anything published.
 */
export function buildTrackedBands(
  config: BandsConfig,
  today: string
): TrackedBands {
  const bands = activeBands(config)
    .map(b => ({ name: b.name, url: b.url }))
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
  return { generated: today, bands };
}
