// Geocode addresses using OpenStreetMap Nominatim
// Nominatim usage policy: max 1 request/second

export interface GeocodingResult {
  lat: number;
  lng: number;
  displayName: string;
}

let lastGeocodeTime = 0;

async function tryGeocode(address: string): Promise<GeocodingResult | null> {
  const now = Date.now();
  const elapsed = now - lastGeocodeTime;
  if (elapsed < 1100) {
    await new Promise(resolve => setTimeout(resolve, 1100 - elapsed));
  }
  lastGeocodeTime = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?` +
      `q=${encodeURIComponent(address)}&format=json&limit=1`,
    {
      headers: {
        'User-Agent': 'Tokoro Event Crawler',
      },
      signal: controller.signal,
    }
  );

  clearTimeout(timeout);

  if (!response.ok) {
    throw new Error(`Geocoding failed: ${response.status}`);
  }

  const results = await response.json() as Array<{
    lat: string;
    lon: string;
    display_name: string;
  }>;

  if (results.length === 0) {
    return null;
  }

  const result = results[0];
  return {
    lat: parseFloat(result.lat),
    lng: parseFloat(result.lon),
    displayName: result.display_name,
  };
}

export async function geocodeAddress(
  address: string,
  venueName?: string
): Promise<GeocodingResult | null> {
  try {
    // 1. Try the full address as-is
    let result = await tryGeocode(address);
    if (result) return result;

    // 2. If address has a comma, try dropping the first segment (possible venue prefix)
    if (address.includes(',')) {
      const withoutFirst = address.split(',').slice(1).join(',').trim();
      if (withoutFirst) {
        console.log(`Retrying geocoding without first segment: ${withoutFirst}`);
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
