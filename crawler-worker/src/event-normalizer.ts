import { ExtractedEvent, PreparedEvent } from './event-types';
import { geocodeAddress } from '../../shared/utils/geocode';
import { lookupTimezone, convertToLocalTime, isPlaceholderTime } from '../../shared/utils/timezone';

export interface NormalizeFailure {
  title: string;
  reason: string;
  address?: string;
  venue_name?: string;
}

export class EventNormalizer {
  async normalize(event: ExtractedEvent): Promise<{ event: PreparedEvent } | { failure: NormalizeFailure }> {
    console.log(`Normalizing event: ${event.title}`);

    let lat = event.lat;
    let lng = event.lng;

    if (lat === undefined || lng === undefined) {
      const geocodeQuery = event.address || event.venue_name;
      if (!geocodeQuery) {
        const failure: NormalizeFailure = {
          title: event.title,
          reason: 'No coordinates, no address, and no venue name — cannot geocode',
        };
        console.error('❌ Event dropped:', failure.reason, '| title:', event.title);
        return { failure };
      }

      console.log(`Geocoding address: ${geocodeQuery}`);
      const geocoded = await geocodeAddress(geocodeQuery, event.venue_name);

      if (!geocoded) {
        const failure: NormalizeFailure = {
          title: event.title,
          reason: `Geocoding failed for "${geocodeQuery}"`,
          address: event.address,
          venue_name: event.venue_name,
        };
        console.error('❌ Event dropped:', failure.reason);
        return { failure };
      }

      lat = geocoded.lat;
      lng = geocoded.lng;
      console.log(`Geocoded to: ${lat}, ${lng}`);
    }

    let start_time = this.normalizeTimestamp(event.start_time);
    let end_time = event.end_time ? this.normalizeTimestamp(event.end_time) : undefined;

    if (event.start_time_utc) {
      const timezone = await lookupTimezone(lat, lng);
      if (timezone) {
        const jsonldLocal = convertToLocalTime(event.start_time_utc, timezone);
        if (jsonldLocal && isPlaceholderTime(start_time)) {
          console.log(`⏰ Using JSON-LD-derived local time: ${jsonldLocal} (LLM placeholder: ${start_time}, tz: ${timezone})`);
          start_time = jsonldLocal;
        }
        if (event.end_time_utc && !end_time) {
          const jsonldEndLocal = convertToLocalTime(event.end_time_utc, timezone);
          if (jsonldEndLocal) end_time = jsonldEndLocal;
        }
      }
    }

    const created_at = new Date().toISOString().slice(0, 19);

    return {
      event: {
        title: event.title,
        description: event.description,
        url: event.url,
        venue_name: event.venue_name,
        address: event.address,
        lat,
        lng,
        start_time,
        end_time,
        category: event.category,
        tags: event.tags,
        festival_name: event.festival_name,
        festival_url: event.festival_url,
        created_at,
      },
    };
  }

  private normalizeTimestamp(time: string | number): string {
    if (typeof time === 'number') {
      return new Date(time * 1000).toISOString().slice(0, 19);
    }
    const stripped = time.replace(/(Z|[+-]\d{2}:\d{2})$/, '');
    if (isNaN(new Date(stripped).getTime())) {
      throw new Error(`Invalid timestamp: ${time}`);
    }
    return stripped.slice(0, 19);
  }
}
