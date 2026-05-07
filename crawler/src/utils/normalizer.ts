import { ExtractedEvent, NormalizedEvent } from '../types/event.js';
import {
  geocodeAddress,
  GeocodingResult,
} from '../../../shared/utils/geocode.js';
import { encode as encodeGeohash } from './geohash.js';
import {
  lookupTimezone,
  convertToLocalTime,
  isPlaceholderTime,
} from '../../../shared/utils/timezone.js';
import * as ed from '@noble/ed25519';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { LLMProvider } from '../../../shared/types/llm.js';
import type { FetchedPage } from '../types/event.js';

// Configure SHA-512 for Node.js
if (typeof crypto !== 'undefined' && crypto.subtle) {
  ed.etc.sha512Async = async (...m) => {
    const buffer = await crypto.subtle.digest('SHA-512', m[0] as BufferSource);
    return new Uint8Array(buffer);
  };
}

export interface KeyPair {
  privkey: string; // hex
  pubkey: string; // hex
}

const SEARCH_RESULT_MAX_CHARS = 4000;

export async function extractAddressFromSearchPage(
  page: FetchedPage,
  venueName: string,
  llm: LLMProvider
): Promise<string> {
  const text = page.text.slice(0, SEARCH_RESULT_MAX_CHARS);
  const response = await llm.complete(
    [
      {
        role: 'system',
        content:
          'Extract a geocodable street address for the given venue from the web search results. ' +
          'Return only the address string. Return an empty string if no address is found.',
      },
      {
        role: 'user',
        content: `Venue: ${venueName}\n\nSearch results:\n${text}`,
      },
    ],
    { temperature: 0, maxTokens: 200 }
  );
  return response.content.trim();
}

export interface NormalizerConfig {
  keypair: KeyPair;
  llm?: LLMProvider;
  fetchPage?: (url: string) => Promise<FetchedPage>;
}

export class EventNormalizer {
  constructor(private config: NormalizerConfig) {}

  async normalize(event: ExtractedEvent): Promise<NormalizedEvent | null> {
    console.log(`Normalizing event: ${event.title}`);

    // Geocode if coordinates missing
    let lat = event.lat;
    let lng = event.lng;

    if (lat === undefined || lng === undefined) {
      const geocodeQuery = event.address || event.venue_name;
      if (!geocodeQuery) {
        console.error(
          'Event has no coordinates, no address, and no venue name for geocoding'
        );
        return null;
      }

      console.log(`Geocoding address: ${geocodeQuery}`);
      let geocoded = await geocodeAddress(geocodeQuery, event.venue_name);

      if (!geocoded) {
        geocoded = await this.geocodeFromSearch(event.venue_name);
      }

      if (!geocoded) {
        console.error('Geocoding failed');
        return null;
      }

      lat = geocoded.lat;
      lng = geocoded.lng;
      console.log(`Geocoded to: ${lat}, ${lng}`);
    }

    // Derive accurate local times from JSON-LD UTC strings when available,
    // falling back to LLM-extracted times (preferred when they're explicit).
    let start_time = this.normalizeTimestamp(event.start_time);
    let end_time = event.end_time
      ? this.normalizeTimestamp(event.end_time)
      : undefined;

    if (event.start_time_utc) {
      const timezone = await lookupTimezone(lat, lng);
      if (timezone) {
        const jsonldLocal = convertToLocalTime(event.start_time_utc, timezone);
        if (jsonldLocal && isPlaceholderTime(start_time)) {
          console.log(
            `⏰ Using JSON-LD-derived local time: ${jsonldLocal} (LLM placeholder: ${start_time}, tz: ${timezone})`
          );
          start_time = jsonldLocal;
        }
        if (event.end_time_utc && !end_time) {
          const jsonldEndLocal = convertToLocalTime(
            event.end_time_utc,
            timezone
          );
          if (jsonldEndLocal) end_time = jsonldEndLocal;
        }
      }
    }

    const created_at = new Date().toISOString().slice(0, 19); // "YYYY-MM-DDTHH:MM:SS"

    // Create event data for signing
    const eventData = {
      pubkey: this.config.keypair.pubkey,
      title: event.title,
      description: event.description || '',
      url: event.url || '',
      venue_name: event.venue_name || '',
      address: event.address || '',
      lat,
      lng,
      start_time,
      end_time,
      category: event.category,
      tags: event.tags || [],
      created_at,
    };

    // Sign the event
    const messageHash = await this.hashEventData(eventData);
    const signature = await ed.signAsync(
      this.hexToBytes(messageHash),
      this.hexToBytes(this.config.keypair.privkey)
    );

    const normalized: NormalizedEvent = {
      ...eventData,
      signature: this.bytesToHex(signature),
    };
    if (event.festival_name) normalized.festival_name = event.festival_name;
    if (event.festival_url) normalized.festival_url = event.festival_url;
    return normalized;
  }

  private async geocodeFromSearch(
    venueName: string | undefined
  ): Promise<GeocodingResult | null> {
    if (!venueName || !this.config.llm || !this.config.fetchPage) return null;

    console.log(`Geocoding fallback: searching Google for "${venueName}"`);
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(venueName + ' address')}`;

    let page: FetchedPage;
    try {
      page = await this.config.fetchPage(searchUrl);
    } catch (err) {
      console.error('Geocoding fallback: search fetch failed', err);
      return null;
    }

    try {
      const logsDir = path.join(process.cwd(), 'logs');
      await fs.mkdir(logsDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const slug = venueName.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
      const logPath = path.join(
        logsDir,
        `${timestamp}_geocode_search_${slug}.txt`
      );
      await fs.writeFile(
        logPath,
        `=== GEOCODING SEARCH FALLBACK ===\nVenue: ${venueName}\nURL: ${searchUrl}\n\n=== SEARCH RESULT ===\n${page.text}\n`,
        'utf-8'
      );
      console.log(`📝 Search response logged to: ${logPath}`);
    } catch (err) {
      console.warn('Failed to write geocoding search log:', err);
    }

    let address: string;
    try {
      address = await extractAddressFromSearchPage(
        page,
        venueName,
        this.config.llm
      );
    } catch (err) {
      console.error('Geocoding fallback: LLM address extraction failed', err);
      return null;
    }
    if (!address) {
      console.error('Geocoding fallback: LLM returned no address');
      return null;
    }

    console.log(`Geocoding fallback: retrying geocoding with "${address}"`);
    return geocodeAddress(address, venueName);
  }

  private normalizeTimestamp(time: string | number): string {
    if (typeof time === 'number') {
      return new Date(time * 1000).toISOString().slice(0, 19);
    }

    // Strip any timezone suffix and slice to "YYYY-MM-DDTHH:MM:SS".
    // Avoid routing through Date.toISOString() which converts to UTC.
    const stripped = time.replace(/(Z|[+-]\d{2}:\d{2})$/, '');
    if (isNaN(new Date(stripped).getTime())) {
      throw new Error(`Invalid timestamp: ${time}`);
    }
    return stripped.slice(0, 19);
  }

  private async hashEventData(eventData: any): Promise<string> {
    const canonical = JSON.stringify(eventData);
    const encoder = new TextEncoder();
    const data = encoder.encode(canonical);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
  }
}
