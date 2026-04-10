import { ExtractedEvent, NormalizedEvent } from './event-types';
import { geocodeAddress } from '../../shared/utils/geocode';
import { lookupTimezone, convertToLocalTime, isPlaceholderTime } from '../../shared/utils/timezone';
import * as ed from '@noble/ed25519';

// Configure SHA-512 for Workers (use Web Crypto API)
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

export interface NormalizeFailure {
  title: string;
  reason: string;
  address?: string;
  venue_name?: string;
}

export class EventNormalizer {
  constructor(private keypair: KeyPair) {}

  async normalize(event: ExtractedEvent): Promise<{ event: NormalizedEvent } | { failure: NormalizeFailure }> {
    console.log(`Normalizing event: ${event.title}`);

    // Geocode if coordinates missing
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

    // Derive accurate local times from JSON-LD UTC strings when available,
    // falling back to LLM-extracted times (preferred when they're explicit).
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

    const created_at = new Date().toISOString().slice(0, 19); // "YYYY-MM-DDTHH:MM:SS"

    // Create event data for signing
    const eventData = {
      pubkey: this.keypair.pubkey,
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
      this.hexToBytes(this.keypair.privkey)
    );

    return {
      event: {
        ...eventData,
        signature: this.bytesToHex(signature),
      },
    };
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
