/**
 * Environment bindings for the Crawler Worker
 */
export interface Env {
  // R2 Bindings (optional)
  CRAWLER_LOGS?: R2Bucket;

  // Secrets (set via wrangler secret put)
  CRAWLER_API_KEYS: string; // Comma-separated list of allowed API keys
  LLM_API_KEY?: string;
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  JINA_API_KEY?: string;
}

/**
 * Request body for the /crawl endpoint
 */
export interface CrawlRequest {
  url: string;
  mode?: 'direct' | 'discover' | 'image';
  html?: string;       // Rendered HTML from Chrome extension (cleaned server-side)
  textContent?: string; // Deprecated: ignored
  title?: string;
  imageData?: string;
  imageMimeType?: string;
}

/**
 * Request body for the /extract-text endpoint
 */
export interface ExtractTextRequest {
  text: string;
  url?: string;
  title?: string;
  referenceDate?: string;
}

import { PreparedEvent } from './event-types';

/**
 * Response from the /crawl endpoint
 */
export interface CrawlResponse {
  success: boolean;
  message?: string;
  error?: string;
  stats?: {
    urls_processed: number;
    events_extracted: number;
  };
  events?: PreparedEvent[];
  dropped_events?: Array<{ title: string; reason: string; address?: string; venue_name?: string }>;
  cleaned_text?: string;
}
