import { z } from 'zod';

// Zod schema for extracted event data
export const ExtractedEventSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  url: z.string().url().optional(),
  venue_name: z.string().optional(),
  address: z.string().optional(),

  // Location - will be geocoded from address if not provided
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),

  // Times (ISO strings or timestamps)
  start_time: z.string().or(z.number()),
  end_time: z.string().or(z.number()).optional(),

  // Raw JSON-LD datetimes with timezone info (e.g. "2026-03-13T19:30:00Z").
  // Populated during JSON-LD extraction; used after geocoding to derive accurate local time.
  // Never sent to the API — stripped during normalization.
  start_time_utc: z.string().optional(),
  end_time_utc: z.string().optional(),

  // Day name extracted by LLM when visible on the page (e.g. "Sunday", "Tuesday").
  // Used for post-processing year validation. Never sent to the API — stripped during normalization.
  day_name: z.string().optional(),

  // Classification
  category: z.enum([
    'music',
    'food',
    'sports',
    'art',
    'theater',
    'film',
    'nightlife',
    'community',
    'outdoor',
    'learning',
    'wellness',
    'talks',
    'other',
  ]),
  tags: z.array(z.string()).optional(),
  festival_name: z.string().optional(),
  festival_url: z.string().url().optional(),
});

export type ExtractedEvent = z.infer<typeof ExtractedEventSchema>;

// Normalized event ready for API submission
export interface NormalizedEvent {
  pubkey: string;
  signature: string;
  title: string;
  description?: string;
  url?: string;
  venue_name?: string;
  address?: string;
  lat: number;
  lng: number;
  start_time: string; // ISO 8601 format (e.g. "2026-03-15T21:00:00")
  end_time?: string; // ISO 8601 format
  category: string;
  tags?: string[];
  festival_name?: string;
  festival_url?: string;
  created_at: string; // ISO 8601 format
}

// Event data normalised and ready for client-side signing.
// All geocoding and timestamp normalisation is complete.
// The client adds pubkey and signature before posting to the API.
export interface PreparedEvent {
  title: string;
  description?: string;
  url?: string;
  venue_name?: string;
  address?: string;
  lat: number;
  lng: number;
  start_time: string; // ISO 8601 local time (e.g. "2026-03-15T21:00:00")
  end_time?: string;
  category: string;
  tags?: string[];
  festival_name?: string;
  festival_url?: string;
  created_at: string; // ISO 8601, set at normalisation time
}

// Fetched page data (standardized across crawler and crawler-worker)
export interface FetchedPage {
  url: string;
  html: string;
  text: string; // Readable text content (from DOM extraction or markdown conversion)
  title: string;
}
