/**
 * Shared JSON-LD extraction helpers
 * Used by both crawler and crawler-worker to extract event data from JSON-LD structured data
 */

import { stripHtmlTags } from './html-cleaner.js';

export interface JsonLdEvent {
  '@type'?: string | string[];
  name?: string;
  description?: string;
  url?: string;
  location?: {
    '@type'?: string;
    name?: string;
    address?: string | {
      '@type'?: string;
      streetAddress?: string;
      addressLocality?: string;
      addressRegion?: string;
      postalCode?: string;
      addressCountry?: string;
    };
    geo?: {
      '@type'?: string;
      latitude?: number | string;
      longitude?: number | string;
    };
  };
  startDate?: string;
  endDate?: string;
  eventStatus?: string;
  eventAttendanceMode?: string;
  organizer?: any;
  performer?: any;
  keywords?: string | string[];
}

export interface JsonLdExtractionResult<T> {
  events: Partial<T>[];
  isSufficient: boolean;
  source: 'jsonld';
}

/**
 * Maps Schema.org Event @type to event categories
 */
export function mapEventTypeToCategory(type: string | string[] | undefined): string | undefined {
  if (!type) return undefined;

  const typeStr = Array.isArray(type) ? type.join(' ').toLowerCase() : type.toLowerCase();

  if (typeStr.includes('music') || typeStr.includes('concert')) return 'music';
  if (typeStr.includes('sport')) return 'sports';
  if (typeStr.includes('theater') || typeStr.includes('theatre')) return 'theater';
  if (typeStr.includes('film') || typeStr.includes('movie') || typeStr.includes('screening')) return 'film';
  if (typeStr.includes('food') || typeStr.includes('festival') && typeStr.includes('food')) return 'food';
  if (typeStr.includes('art') || typeStr.includes('exhibition')) return 'art';
  if (typeStr.includes('education') || typeStr.includes('course') || typeStr.includes('workshop')) return 'learning';
  if (typeStr.includes('conference') || typeStr.includes('lecture') || typeStr.includes('talk') || typeStr.includes('seminar')) return 'talks';
  if (typeStr.includes('business')) return 'community';
  if (typeStr.includes('social')) return 'nightlife';

  return undefined; // Will need LLM to determine category
}

/**
 * Formats a Schema.org address object into a single string
 */
export function formatAddress(address: any): string | undefined {
  if (typeof address === 'string') {
    return address;
  }

  if (typeof address === 'object' && address !== null) {
    const parts: string[] = [];

    if (address.streetAddress) parts.push(address.streetAddress);
    if (address.addressLocality) parts.push(address.addressLocality);
    if (address.addressRegion) parts.push(address.addressRegion);
    if (address.postalCode) parts.push(address.postalCode);
    if (address.addressCountry) {
      const country = address.addressCountry;
      parts.push(typeof country === 'string' ? country : (country.name ?? ''));
    }

    return parts.length > 0 ? parts.join(', ') : undefined;
  }

  return undefined;
}

/**
 * Converts Schema.org date string to ISO 8601 format without timezone (local time at venue).
 * Strips timezone offset rather than converting to UTC, so "19:30:00+01:00" → "19:30:00".
 */
export function normalizeDate(dateStr: string | undefined): string | undefined {
  if (!dateStr) return undefined;

  try {
    // Strip any timezone offset/Z suffix to preserve local time as-is.
    // e.g. "2026-03-13T19:30:00+01:00" → "2026-03-13T19:30:00"
    //      "2026-03-13T19:30:00Z"       → "2026-03-13T19:30:00"
    //      "2026-03-13T19:30:00"        → "2026-03-13T19:30:00"
    const stripped = dateStr.replace(/(Z|[+-]\d{2}:\d{2})$/, '');

    // Validate the result is a recognisable datetime
    if (isNaN(new Date(stripped).getTime())) return undefined;

    return stripped;
  } catch {
    return undefined;
  }
}

/**
 * Checks if extracted JSON-LD data is sufficient to skip LLM extraction
 * Required fields: title, start_time, (address OR lat/lng), category
 */
export function isSufficientData(event: any): boolean {
  const hasTitle = !!event.title && event.title.length > 0;
  const hasStartTime = !!event.start_time;
  const hasLocation = (!!event.address && event.address.length > 0) ||
                      (typeof event.lat === 'number' && typeof event.lng === 'number');
  const hasCategory = !!event.category;

  return hasTitle && hasStartTime && hasLocation && hasCategory;
}

/**
 * Extracts event data from a single JSON-LD object
 */
export function extractEventFromJsonLd(jsonld: JsonLdEvent, pageUrl: string): any {
  // Check if this is an Event type
  const type = jsonld['@type'];
  if (!type) return null;

  const typeStr = Array.isArray(type) ? type.join(' ') : type;
  if (!typeStr.toLowerCase().includes('event')) return null;

  const event: any = {};

  // Basic fields
  if (jsonld.name) {
    event.title = stripHtmlTags(jsonld.name);
  }

  if (jsonld.description) {
    event.description = stripHtmlTags(jsonld.description);
  }

  if (jsonld.url) {
    event.url = jsonld.url;
  } else {
    event.url = pageUrl;
  }

  // Location
  if (jsonld.location) {
    const location = jsonld.location;

    if (location.name) {
      event.venue_name = location.name;
    }

    if (location.address) {
      event.address = formatAddress(location.address);
    }

    if (location.geo) {
      const lat = typeof location.geo.latitude === 'string'
        ? parseFloat(location.geo.latitude)
        : location.geo.latitude;
      const lng = typeof location.geo.longitude === 'string'
        ? parseFloat(location.geo.longitude)
        : location.geo.longitude;

      if (typeof lat === 'number' && !isNaN(lat)) {
        event.lat = lat;
      }
      if (typeof lng === 'number' && !isNaN(lng)) {
        event.lng = lng;
      }
    }
  }

  // Dates
  if (jsonld.startDate) {
    event.start_time = normalizeDate(jsonld.startDate);
    // Preserve raw UTC string so the normalizer can convert to accurate local time after geocoding.
    // Skip midnight UTC ("T00:00:00Z" / "T00:00:00+00:00") — those are date-only placeholders,
    // not real UTC times, and converting them would produce wrong local times (e.g. 2am in UTC+2).
    if (/Z$|[+-]\d{2}:\d{2}$/.test(jsonld.startDate)) {
      const stripped = jsonld.startDate.replace(/(Z|[+-]\d{2}:\d{2})$/, '');
      if (!/T00:00(:00(\.\d+)?)?$/.test(stripped)) {
        event.start_time_utc = jsonld.startDate;
      }
    }
  }

  if (jsonld.endDate) {
    event.end_time = normalizeDate(jsonld.endDate);
    if (/Z$|[+-]\d{2}:\d{2}$/.test(jsonld.endDate)) {
      const stripped = jsonld.endDate.replace(/(Z|[+-]\d{2}:\d{2})$/, '');
      if (!/T00:00(:00(\.\d+)?)?$/.test(stripped)) {
        event.end_time_utc = jsonld.endDate;
      }
    }
  }

  // Category (attempt to map from @type)
  const category = mapEventTypeToCategory(type);
  if (category) {
    event.category = category;
  }

  // Tags from keywords
  if (jsonld.keywords) {
    const kw = Array.isArray(jsonld.keywords) ? jsonld.keywords : [jsonld.keywords];
    const tags = kw.map(k => k.trim()).filter(Boolean);
    if (tags.length > 0) {
      event.tags = tags;
    }
  }

  // Only return if we have at least a title
  return event.title ? event : null;
}

/**
 * Validates if a date string is in the future (not before today)
 * Returns true if the date is today or later
 */
export function isValidEventDate(dateStr: string | number | undefined): boolean {
  if (!dateStr) return false;

  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return false;

    // Reject dates before today (start of day)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date.getTime() >= today.getTime();
  } catch {
    return false;
  }
}

/**
 * Helper to merge JSON-LD data with LLM-extracted data
 * JSON-LD takes precedence for structured fields (dates, coordinates, address)
 * LLM can fill in missing fields (category, tags, descriptions)
 */
export function mergeJsonLdWithLlm<T extends Record<string, any>>(
  jsonldEvent: Partial<T>,
  llmEvent: T
): T {
  return {
    ...llmEvent,
    // Prefer JSON-LD for structured data
    title: jsonldEvent.title || llmEvent.title,
    description: llmEvent.description || jsonldEvent.description,
    url: jsonldEvent.url || llmEvent.url,
    venue_name: jsonldEvent.venue_name || llmEvent.venue_name,
    address: jsonldEvent.address || llmEvent.address,
    lat: jsonldEvent.lat ?? llmEvent.lat,
    lng: jsonldEvent.lng ?? llmEvent.lng,

    // Prefer LLM for times (it reads human-visible text correctly).
    // Carry JSON-LD UTC strings forward so the normalizer can derive local time after geocoding
    // and use it as a fallback when the LLM returned a placeholder.
    start_time: llmEvent.start_time,
    end_time: llmEvent.end_time,
    start_time_utc: jsonldEvent.start_time_utc,
    end_time_utc: jsonldEvent.end_time_utc,

    // Prefer LLM for classification (more context-aware)
    category: jsonldEvent.category || llmEvent.category,
    tags: [...new Set([...(jsonldEvent.tags ?? []), ...(llmEvent.tags ?? [])])],
  };
}
