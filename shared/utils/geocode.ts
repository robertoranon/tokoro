// Geocode addresses using OpenStreetMap Nominatim
// Nominatim usage policy: max 1 request/second

export interface GeocodingResult {
  lat: number;
  lng: number;
  displayName: string;
}

export interface GeoCandidate {
  lat: number;
  lng: number;
  /** Nominatim's ranking score (0..1); missing values count as 0. */
  importance: number;
  displayName: string;
  /** Upper-case ISO 3166-1 alpha-2, or '' when unknown. */
  countryCode: string;
}

/** A point the places on a page cluster around. */
export interface GeoBias {
  lat: number;
  lng: number;
}

let lastGeocodeTime = 0;
let minIntervalMs = 1100;

/** Test hook: the pause between Nominatim requests (default 1100 ms). */
export function setGeocodeMinIntervalMs(ms: number): void {
  minIntervalMs = ms;
}

// Candidate lists per query, for the life of the process. A page's places are
// looked up once to find its centre and again, for free, when its shows are
// normalized. Failed requests are never cached.
const candidateCache = new Map<string, GeoCandidate[]>();

export function clearGeocodeCache(): void {
  candidateCache.clear();
  lastGeocodeTime = 0;
}

interface NominatimRow {
  lat: string;
  lon: string;
  display_name: string;
  importance?: number;
  address?: { country_code?: string };
}

/** The top 5 Nominatim candidates for a query, best first. */
export async function geocodeCandidates(
  query: string
): Promise<GeoCandidate[]> {
  const key = query.trim().toLowerCase();
  const cached = candidateCache.get(key);
  if (cached) return cached;

  const now = Date.now();
  const elapsed = now - lastGeocodeTime;
  if (elapsed < minIntervalMs) {
    await new Promise(resolve => setTimeout(resolve, minIntervalMs - elapsed));
  }
  lastGeocodeTime = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout
  let response: Response;
  try {
    response = await fetch(
      `https://nominatim.openstreetmap.org/search?` +
        `q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1`,
      {
        headers: { 'User-Agent': 'Tokoro Event Crawler' },
        signal: controller.signal,
      }
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`Geocoding failed: ${response.status}`);
  }

  const rows = (await response.json()) as NominatimRow[];
  const candidates = rows.map(r => ({
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
    importance: typeof r.importance === 'number' ? r.importance : 0,
    displayName: r.display_name,
    countryCode: (r.address?.country_code ?? '').toUpperCase(),
  }));
  candidateCache.set(key, candidates);
  return candidates;
}

function haversineKm(a: GeoBias, b: GeoBias): number {
  const R = 6371;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}

/**
 * Without a bias: the first (best-ranked) candidate, as geocoding always did.
 * With one: among the candidates whose importance is within `margin` of the
 * best, the one nearest the bias. A clear winner (a big city against a village
 * of the same name) is never overridden; a tie ("Durham": England and North
 * Carolina at 0.619 each) goes to the place the rest of the page points to.
 */
export function pickCandidate(
  candidates: GeoCandidate[],
  bias?: GeoBias,
  margin = 0.05
): GeoCandidate | undefined {
  if (candidates.length === 0) return undefined;
  if (!bias) return candidates[0];
  const best = Math.max(...candidates.map(c => c.importance));
  const tied = candidates.filter(c => c.importance >= best - margin);
  return tied.reduce((a, b) =>
    haversineKm(a, bias) <= haversineKm(b, bias) ? a : b
  );
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Where a page's places cluster: the median latitude and longitude of the best
 * candidate of each distinct query. The median keeps one outlier (a lone
 * overseas date, or the wrong namesake) from moving it. Queries that fail or
 * return nothing are skipped; with fewer than `minPlaces` usable places there
 * is not enough evidence and the result is undefined.
 */
export async function medianBias(
  queries: string[],
  minPlaces = 3
): Promise<GeoBias | undefined> {
  const seen = new Set<string>();
  const points: GeoBias[] = [];
  for (const q of queries) {
    const key = q.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    try {
      const best = pickCandidate(await geocodeCandidates(q));
      if (best) points.push({ lat: best.lat, lng: best.lng });
    } catch {
      // a failing lookup just does not vote
    }
  }
  if (points.length < minPlaces) return undefined;
  return {
    lat: median(points.map(p => p.lat)),
    lng: median(points.map(p => p.lng)),
  };
}

function toResult(c: GeoCandidate): GeocodingResult {
  return { lat: c.lat, lng: c.lng, displayName: c.displayName };
}

async function tryGeocode(address: string): Promise<GeocodingResult | null> {
  const best = pickCandidate(await geocodeCandidates(address));
  return best ? toResult(best) : null;
}

export async function geocodeAddress(
  address: string,
  venueName?: string,
  options?: { bias?: GeoBias }
): Promise<GeocodingResult | null> {
  try {
    // 1. Try the full address as-is (near-ties resolved towards the bias, if any)
    const candidates = await geocodeCandidates(address);
    const picked = pickCandidate(candidates, options?.bias);
    if (picked) {
      if (options?.bias && picked !== candidates[0]) {
        console.log(
          `↺ ${address}: preferred ${picked.displayName} (nearest the other shows) over ${candidates[0].displayName}`
        );
      }
      return toResult(picked);
    }
    let result: GeocodingResult | null = null;

    // 2. If address has a comma, try dropping the first segment (possible venue prefix)
    if (address.includes(',')) {
      const withoutFirst = address.split(',').slice(1).join(',').trim();
      if (withoutFirst) {
        console.log(
          `Retrying geocoding without first segment: ${withoutFirst}`
        );
        result = await tryGeocode(withoutFirst);
        if (result) return result;
      }
    }

    // 3. If a venue name is known, try "venue name + address" (helps when address is just a city/region)
    if (venueName) {
      const venueWithAddress = `${venueName}, ${address}`;
      console.log(`Retrying geocoding with venue name: ${venueWithAddress}`);
      result = await tryGeocode(venueWithAddress);
      if (result) return result;
    }

    // 4. If a venue name is known, try venue name alone as a last resort
    if (venueName) {
      console.log(`Retrying geocoding with venue name only: ${venueName}`);
      result = await tryGeocode(venueName);
      if (result) return result;
    }

    return null;
  } catch (error) {
    console.error(`Geocoding error for "${address}":`, error);
    return null;
  }
}
