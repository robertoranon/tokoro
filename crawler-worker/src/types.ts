/**
 * Environment bindings for the Crawler Worker
 */
export interface Env {
  // Service Bindings
  TOKORO_API?: Fetcher; // Direct binding to the Tokoro API worker

  // R2 Bindings (optional - if not configured, logs only go to console)
  CRAWLER_LOGS?: R2Bucket; // R2 bucket for storing crawler operation logs (optional)

  // KV Bindings
  PREVIEW_CACHE?: KVNamespace; // KV store for caching preview events by token

  // Secrets (set via wrangler secret put)
  CRAWLER_API_KEYS: string; // Comma-separated list of allowed API keys
  CRAWLER_PRIVKEY: string; // Ed25519 private key (hex) for signing events
  CRAWLER_PUBKEY: string; // Ed25519 public key (hex)
  LLM_API_KEY?: string; // API key for LLM provider (OpenAI, Anthropic, etc.)
  LLM_PROVIDER?: string; // LLM provider name (openai, anthropic, openrouter)
  LLM_MODEL?: string; // Optional model override
  JINA_API_KEY?: string; // Jina AI Reader API key (optional, increases rate limits)

  // Variables (can be set in wrangler.toml)
  TOKORO_API_URL?: string; // Default API URL for publishing events (fallback if binding unavailable)
}

/**
 * Fetcher interface for service bindings
 */
export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

/**
 * Request body for the /crawl endpoint
 */
export interface CrawlRequest {
  url: string; // URL to crawl (for web pages) or image source URL (for images)
  mode?: 'direct' | 'discover' | 'image'; // Crawl mode (default: discover, use 'image' for image extraction)
  apiUrl?: string; // Optional override for the API URL
  preview?: boolean; // If true, extract events but don't publish (return events in response)
  html?: string; // Optional rendered HTML from Chrome extension (cleaned server-side)
  textContent?: string; // Deprecated: ignored; HTML is now cleaned server-side
  title?: string; // Optional page title from Chrome extension
  events?: any[]; // Optional pre-extracted events from cache (skips extraction, goes straight to publishing)
  preview_token?: string; // Token from a previous preview response (skips extraction, publishes cached events)
  imageData?: string; // Base64-encoded image data (for mode=image)
  imageMimeType?: string; // MIME type of the image (e.g., "image/jpeg", "image/png")
}

/**
 * Request body for the /extract-text endpoint (debug: LLM-only extraction, no JSON-LD)
 */
export interface ExtractTextRequest {
  text: string; // Clean text content to extract events from
  url?: string; // Optional source URL (used as fallback event URL)
  title?: string; // Optional page title
  referenceDate?: string; // Optional reference date for date inference (YYYY-MM-DD, default: today)
}

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
    events_published: number;
  };
  events?: any[]; // Extracted and normalized events (only present in preview mode)
  preview_token?: string; // Token for publishing cached preview events (only present in preview mode)
  dropped_events?: Array<{ title: string; reason: string; address?: string; venue_name?: string }>; // Events dropped during normalization
  cleaned_text?: string; // Cleaned text used for LLM extraction (only when html was provided by client)
}
