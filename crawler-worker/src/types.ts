/**
 * Environment bindings for the Crawler Worker
 */
export interface Env {
  // R2 Bindings (optional)
  CRAWLER_LOGS?: R2Bucket;

  // KV Bindings
  PREVIEW_CACHE?: KVNamespace;

  // Service Bindings
  API_WORKER?: Fetcher;

  // Secrets (set via wrangler secret put)
  CRAWLER_API_KEYS: string;
  LLM_API_KEY?: string;
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  JINA_API_KEY?: string;

  // Telegram bot secrets
  TELEGRAM_BOT_TOKEN?: string;
  BOT_PRIVKEY?: string; // Ed25519 private key, hex-encoded
  BOT_PUBKEY?: string; // Ed25519 public key, hex-encoded
  API_WORKER_URL?: string; // Base URL of Tokoro API worker (no trailing slash)

  // WhatsApp bot secrets (optional — only needed when using /whatsapp endpoint)
  WHATSAPP_TOKEN?: string; // Permanent system user token from Meta Business
  WHATSAPP_PHONE_ID?: string; // Numeric phone number ID from Meta dashboard
  WHATSAPP_VERIFY_TOKEN?: string; // Secret string used to verify the webhook with Meta
}

/**
 * Request body for the /crawl endpoint
 */
export interface CrawlRequest {
  url?: string;
  mode?: 'direct' | 'discover' | 'image';
  html?: string; // Rendered HTML from Chrome extension (cleaned server-side)
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
  dropped_events?: Array<{
    title: string;
    reason: string;
    address?: string;
    venue_name?: string;
  }>;
  cleaned_text?: string;
  debug?: {
    jsonld_events_found: number;
    jsonld_sufficient: boolean;
    cleaned_text_length: number;
    pipeline_log: string[];
  };
}
