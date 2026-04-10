/**
 * Worker-compatible crawler implementation
 * Adapts the crawler from ../crawler/src to work in Cloudflare Workers environment
 */

import { Env } from './types';
import { createLLMProvider } from '../../shared/llm/factory';
import { LLMProvider } from '../../shared/types/llm';
import { EventExtractor } from './event-extractor';
import { PageDiscovery } from './page-discovery';
import { EventNormalizer, NormalizeFailure } from './event-normalizer';
import { APIPublisher } from './api-publisher';
import { FetchedPage, ExtractedEvent, NormalizedEvent } from './event-types';
import { CrawlerLogger } from './logger';
import { extractCleanText } from '../../shared/extractors/html-cleaner';
import { isDuplicate } from '../../shared/llm/duplicate-check';
import { DEDUP_DISTANCE_KM, DEDUP_TIME_WINDOW_MS } from '../../shared/dedup-config';

export type CrawlerMode = 'direct' | 'discover' | 'image';

export interface CrawlerConfig {
  env: Env;
  apiUrl?: string;
  mode: CrawlerMode;
  preview?: boolean; // If true, extract events but don't publish
  providedHtml?: string; // Optional HTML provided by Chrome extension (cleaned server-side)
  providedTitle?: string; // Optional page title from Chrome extension
  providedEvents?: any[]; // Optional pre-extracted events from cache (skips extraction)
  imageData?: string; // Base64-encoded image data (for mode=image)
  imageMimeType?: string; // MIME type of the image (for mode=image)
  previewToken?: string; // Token to look up cached preview events for direct publish
}

export interface CrawlResult {
  urls_processed: number;
  events_extracted: number;
  events_published: number;
  events?: NormalizedEvent[]; // Only present in preview mode
  dropped_events?: NormalizeFailure[]; // Events that were extracted but failed normalization
  preview_token?: string; // Token for publishing cached events (preview mode only)
}

/**
 * Worker-compatible crawler
 *
 * Implementation notes:
 * - Uses Jina AI Reader for fetching (no Playwright in Workers)
 * - LLM calls via OpenAI/Anthropic APIs
 * - Geocoding via Nominatim API
 * - Event signing with Ed25519
 */
export class WorkerCrawler {
  private extractor: EventExtractor;
  private discovery: PageDiscovery;
  private normalizer: EventNormalizer;
  private publisher: APIPublisher;
  private logger: CrawlerLogger;
  private llm: LLMProvider;

  constructor(private config: CrawlerConfig) {
    // Initialize logger with R2 bucket
    this.logger = new CrawlerLogger(config.env.CRAWLER_LOGS);

    // Initialize LLM provider
    const llm = createLLMProvider({
      provider: config.env.LLM_PROVIDER,
      apiKey: config.env.LLM_API_KEY!,
      model: config.env.LLM_MODEL,
    });
    this.llm = llm;

    // Initialize components
    this.extractor = new EventExtractor({ llm });
    this.discovery = new PageDiscovery(llm);
    this.normalizer = new EventNormalizer({
      privkey: config.env.CRAWLER_PRIVKEY,
      pubkey: config.env.CRAWLER_PUBKEY,
    });

    // Use service binding if available, otherwise HTTP
    this.publisher = new APIPublisher({
      binding: config.env.TOKORO_API,
      apiUrl: config.apiUrl,
    });
  }

  async crawl(url: string): Promise<CrawlResult> {
    const stats: CrawlResult = {
      urls_processed: 0,
      events_extracted: 0,
      events_published: 0,
    };

    const allEvents: NormalizedEvent[] = []; // Collect all events in preview mode
    const droppedEvents: NormalizeFailure[] = []; // Collect normalization failures

    try {
      this.logger.info('crawl_start', `Starting crawl: ${url}`, { mode: this.config.mode, preview: this.config.preview, model: this.llm.name }, url);

      // If pre-extracted events are provided, skip extraction and publish directly
      if (this.config.providedEvents && this.config.providedEvents.length > 0) {
        this.logger.info('cache_use', `Using ${this.config.providedEvents.length} pre-extracted events from cache`, { count: this.config.providedEvents.length }, url);
        stats.urls_processed = 1;
        stats.events_extracted = this.config.providedEvents.length;

        // Publish the cached events directly
        const published = await this.publisher.publishMultiple(this.config.providedEvents as NormalizedEvent[]);
        stats.events_published = published;

        this.logger.info('publish_complete', 'Publish complete (from cache)', stats, url);
        await this.logger.flush();
        return stats;
      }

      // If a preview token is provided, look up cached events and publish directly
      if (this.config.previewToken) {
        const cached = this.config.env.PREVIEW_CACHE
          ? await this.config.env.PREVIEW_CACHE.get(this.config.previewToken)
          : null;

        if (!cached) {
          throw new Error('Preview token expired or not found. Please re-extract the page.');
        }

        const events: NormalizedEvent[] = JSON.parse(cached);
        this.logger.info('token_use', `Publishing ${events.length} event(s) from preview token`, { count: events.length, token: this.config.previewToken }, url);
        stats.urls_processed = 1;
        stats.events_extracted = events.length;

        const published = await this.publisher.publishMultiple(events);
        stats.events_published = published;

        // Delete the token so it can't be reused
        await this.config.env.PREVIEW_CACHE?.delete(this.config.previewToken);

        this.logger.info('publish_complete', 'Publish complete (from preview token)', stats, url);
        await this.logger.flush();
        return stats;
      }

      // Handle image mode separately
      if (this.config.mode === 'image') {
        if (!this.config.imageData) {
          throw new Error('Image data is required for image mode');
        }

        this.logger.info('image_extraction_start', 'Image extraction mode: processing image', { model: this.llm.name }, url);
        stats.urls_processed = 1;

        // Extract events from the image
        const imageMimeType = this.config.imageMimeType || 'image/jpeg';
        let extractedEvents: ExtractedEvent[] = [];

        try {
          extractedEvents = await this.extractor.extractEventsFromImage(
            this.config.imageData,
            imageMimeType,
            url // Pass the source URL for reference
          );
          stats.events_extracted = extractedEvents.length;

          if (extractedEvents.length === 0) {
            this.logger.warn('no_events_found', 'No events found in image (successful extraction, empty result)', { mimeType: imageMimeType }, url);
            if (this.config.preview) {
              stats.events = [];
            }
            await this.logger.flush();
            return stats;
          }

          this.logger.info('image_extraction_success', `Extracted ${extractedEvents.length} event(s) from image`, { count: extractedEvents.length }, url);
        } catch (error) {
          this.logger.error('extraction_error', 'Image extraction failed', { error: error instanceof Error ? error.message : String(error) }, url);
          await this.logger.flush();
          throw error;
        }

        // Normalize and sign events
        const normalizedEvents: NormalizedEvent[] = [];
        for (const event of extractedEvents) {
          try {
            const result = await this.normalizer.normalize(event);
            if ('event' in result) {
              normalizedEvents.push(result.event);
            } else {
              droppedEvents.push(result.failure);
              this.logger.warn('event_dropped', `Event dropped: ${result.failure.reason}`, result.failure, url);
            }
          } catch (error) {
            const failure = {
              title: event.title,
              reason: error instanceof Error ? error.message : String(error),
              address: event.address,
              venue_name: event.venue_name,
            };
            droppedEvents.push(failure);
            this.logger.warn('event_dropped', `Event dropped (normalization error): ${failure.reason}`, failure, url);
          }
        }

        // Publish to API (or collect for preview)
        if (this.config.preview) {
          allEvents.push(...normalizedEvents);
          stats.events = allEvents;
          stats.dropped_events = droppedEvents.length > 0 ? droppedEvents : undefined;
          this.logger.info('preview_collect', `Collected ${normalizedEvents.length} event(s) from image for preview`, { count: normalizedEvents.length }, url);
          if (this.config.preview && normalizedEvents.length > 0 && this.config.env.PREVIEW_CACHE) {
            const token = crypto.randomUUID();
            await this.config.env.PREVIEW_CACHE.put(
              token,
              JSON.stringify(normalizedEvents),
              { expirationTtl: 3600 }
            );
            stats.preview_token = token;
          }
        } else {
          let publishedCount = 0;
          for (const event of normalizedEvents) {
            const existingId = await this.checkForDuplicate(event);
            if (existingId) {
              this.logger.info('pre_publish_dedup', `⊘ Skipped duplicate (pre-check): ${event.title} (existing: ${existingId})`, {}, event.url || '');
              continue;
            }
            const success = await this.publisher.publishEvent(event);
            if (success) publishedCount++;
          }
          stats.events_published = publishedCount;
          stats.dropped_events = droppedEvents.length > 0 ? droppedEvents : undefined;
          this.logger.info('events_published', `Published ${publishedCount} event(s) from image`, { published: publishedCount, extracted: normalizedEvents.length }, url);
        }

        this.logger.info('image_extraction_complete', 'Image extraction complete', stats, url);
        await this.logger.flush();
        return stats;
      }

      // Step 1: Fetch the page (use provided content or fetch via Jina AI)
      const page = await this.fetchPage(url, this.config.providedHtml, this.config.providedTitle);
      stats.urls_processed++;

      // Step 2: Determine which URLs to process based on mode
      let urlsToProcess: string[];

      if (this.config.mode === 'direct') {
        // Direct mode: only extract from the given URL
        this.logger.info('mode_direct', 'Direct extraction mode: processing URL as-is', undefined, url);
        urlsToProcess = [url];
      } else {
        // Discover mode: try to find individual event page URLs
        this.logger.info('discovery_start', 'Discovering event URLs', undefined, url);
        const eventUrls = await this.discovery.discoverEventUrls(page.html, url);

        if (eventUrls.length > 0) {
          this.logger.info('discovery_success', `Discovered ${eventUrls.length} event page(s)`, { count: eventUrls.length, urls: eventUrls }, url);
          urlsToProcess = eventUrls;
        } else {
          this.logger.warn('discovery_empty', 'No event URLs discovered, treating seed as individual event page', undefined, url);
          urlsToProcess = [url];
        }
      }

      // Step 3: Extract and publish events from each URL
      for (const eventUrl of urlsToProcess) {
        try {
          this.logger.info('url_processing_start', `Processing URL: ${eventUrl}`, undefined, eventUrl);

          // Fetch the event page (or reuse if same URL)
          // Note: Only the first page uses providedHtml; subsequent pages are fetched normally
          const eventPage = eventUrl === url ? page : await this.fetchPage(eventUrl);
          if (eventUrl !== url) {
            stats.urls_processed++;
          }

          // Extract events using LLM (wrap in try-catch to distinguish "no events" from "extraction error")
          let extractedEvents: ExtractedEvent[] = [];
          try {
            extractedEvents = await this.extractor.extractEvents(eventPage);
            stats.events_extracted += extractedEvents.length;

            if (extractedEvents.length === 0) {
              this.logger.warn('no_events_found', 'No events found on page (successful extraction, empty result)', undefined, eventUrl);
              continue;
            }

            this.logger.info('extraction_success', `Extracted ${extractedEvents.length} event(s) from page`, { count: extractedEvents.length }, eventUrl);
          } catch (error) {
            this.logger.error('extraction_error', 'Event extraction failed', { error: error instanceof Error ? error.message : String(error) }, eventUrl);
            throw error;
          }

          // Normalize and sign events
          const normalizedEvents: NormalizedEvent[] = [];
          for (const event of extractedEvents) {
            try {
              const result = await this.normalizer.normalize(event);
              if ('event' in result) {
                normalizedEvents.push(result.event);
              } else {
                droppedEvents.push(result.failure);
                this.logger.warn('event_dropped', `Event dropped: ${result.failure.reason}`, result.failure, eventUrl);
              }
            } catch (error) {
              const failure = {
                title: event.title,
                reason: error instanceof Error ? error.message : String(error),
                address: event.address,
                venue_name: event.venue_name,
              };
              droppedEvents.push(failure);
              this.logger.warn('event_dropped', `Event dropped (normalization error): ${failure.reason}`, failure, eventUrl);
            }
          }

          // Publish to API (or collect for preview)
          if (this.config.preview) {
            // Preview mode: collect events instead of publishing
            allEvents.push(...normalizedEvents);
            this.logger.info('preview_collect', `Collected ${normalizedEvents.length} event(s) for preview`, { count: normalizedEvents.length }, eventUrl);
          } else {
            // Normal mode: publish to API
            let publishedCount = 0;
            for (const event of normalizedEvents) {
              const existingId = await this.checkForDuplicate(event);
              if (existingId) {
                this.logger.info('pre_publish_dedup', `⊘ Skipped duplicate (pre-check): ${event.title} (existing: ${existingId})`, {}, event.url || '');
                continue;
              }
              const success = await this.publisher.publishEvent(event);
              if (success) publishedCount++;
            }
            stats.events_published += publishedCount;
            this.logger.info('events_published', `Published ${publishedCount} event(s) from page`, { published: publishedCount, extracted: normalizedEvents.length }, eventUrl);
          }
        } catch (error) {
          this.logger.error('url_processing_error', `Error processing ${eventUrl}`, { error: error instanceof Error ? error.message : String(error) }, eventUrl);
          // Continue to next URL instead of failing entire crawl
        }
      }

      if (this.config.preview) {
        stats.events = allEvents;
      }
      if (droppedEvents.length > 0) {
        stats.dropped_events = droppedEvents;
      }

      // Store preview events in KV and return a token for publishing
      if (this.config.preview && allEvents.length > 0 && this.config.env.PREVIEW_CACHE) {
        const token = crypto.randomUUID();
        await this.config.env.PREVIEW_CACHE.put(
          token,
          JSON.stringify(allEvents),
          { expirationTtl: 3600 } // 1 hour TTL
        );
        stats.preview_token = token;
        this.logger.info('preview_token_stored', `Stored preview token ${token}`, { count: allEvents.length }, url);
      }

      this.logger.info('crawl_complete', 'Crawl complete', stats, url);
      await this.logger.flush();
      return stats;
    } catch (error) {
      this.logger.error('crawl_error', 'Crawl failed', { error: error instanceof Error ? error.message : String(error) }, url);
      await this.logger.flush();
      throw error;
    }
  }

  /**
   * Pre-publish duplicate check: queries the API for nearby events in the same
   * time window and returns the existing event ID if a duplicate is found.
   */
  private async checkForDuplicate(event: NormalizedEvent): Promise<string | null> {
    try {
      const startTime = new Date(event.start_time);
      const from = new Date(startTime.getTime() - DEDUP_TIME_WINDOW_MS).toISOString().slice(0, 19);
      const to = new Date(startTime.getTime() + DEDUP_TIME_WINDOW_MS).toISOString().slice(0, 19);

      let response: Response;
      if (this.config.env.TOKORO_API) {
        const queryUrl = `https://tokoro-api/events?lat=${event.lat}&lng=${event.lng}&radius=${DEDUP_DISTANCE_KM}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
        response = await this.config.env.TOKORO_API.fetch(new Request(queryUrl));
      } else {
        const baseUrl = this.config.env.TOKORO_API_URL;
        response = await fetch(`${baseUrl}/events?lat=${event.lat}&lng=${event.lng}&radius=${DEDUP_DISTANCE_KM}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      }

      if (!response.ok) return null;
      const data = await response.json() as { events?: Array<{ id: string; title: string; description?: string }> };
      const candidates = data.events || [];

      for (const candidate of candidates) {
        const dup = await isDuplicate(
          { title: event.title, description: event.description || '' },
          { title: candidate.title, description: candidate.description || '' },
          this.llm
        );
        if (dup) return candidate.id;
      }
      return null;
    } catch {
      return null; // fail open: let the worker make the final call
    }
  }

  /**
   * Fetch a page via Jina AI Reader or use provided content from Chrome extension
   */
  private async fetchPage(url: string, providedHtml?: string, providedTitle?: string): Promise<FetchedPage> {
    // If HTML is provided from Chrome extension, clean it server-side
    if (providedHtml) {
      const { text, title: extractedTitle } = extractCleanText(providedHtml);
      const title = providedTitle || extractedTitle || 'Untitled';

      this.logger.info('fetch_chrome_extension', 'Using provided HTML from Chrome extension', { htmlLength: providedHtml.length, textLength: text.length }, url);

      return {
        url,
        html: providedHtml, // For JSON-LD extraction
        text,               // Cleaned text for LLM
        title,
      };
    }

    // Otherwise, fetch via Jina AI Reader
    this.logger.info('fetch_jina_start', 'Fetching page via Jina AI Reader', undefined, url);

    // Fetch clean markdown from Jina AI Reader
    const jinaUrl = `https://r.jina.ai/${url}`;
    const headers: Record<string, string> = {
      'Accept': 'text/plain',
      'X-Timeout': '30',
      'X-Return-Format': 'markdown', // Explicitly request markdown
      'X-With-Links-Summary': 'false', // Disable links summary to get cleaner content
      'X-With-Images-Summary': 'false', // Disable images summary
    };

    // Add API key if available (improves rate limits)
    if (this.config.env.JINA_API_KEY) {
      headers['Authorization'] = `Bearer ${this.config.env.JINA_API_KEY}`;
    }

    const jinaResponse = await fetch(jinaUrl, {
      headers,
      signal: AbortSignal.timeout(30000),
    });

    if (!jinaResponse.ok) {
      const error = `Jina AI Reader failed: ${jinaResponse.status} ${jinaResponse.statusText}`;
      this.logger.error('fetch_jina_error', error, { status: jinaResponse.status }, url);
      throw new Error(error);
    }

    const markdown = await jinaResponse.text();

    this.logger.info('fetch_jina_success', 'Jina AI Reader fetch successful', { contentLength: markdown.length }, url);

    // Extract title from markdown
    const titleMatch = markdown.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

    // Also fetch raw HTML for link discovery
    let html = '';
    try {
      const htmlResponse = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TokoroCrawler/1.0)',
        },
        signal: AbortSignal.timeout(30000),
      });

      if (htmlResponse.ok) {
        html = await htmlResponse.text();
      } else {
        console.warn(`Failed to fetch HTML for ${url}, link discovery may be limited`);
        html = `<html><head><title>${title}</title></head><body></body></html>`;
      }
    } catch (error) {
      console.warn('HTML fetch error:', error);
      html = `<html><head><title>${title}</title></head><body></body></html>`;
    }

    return {
      url,
      html,
      text: markdown,
      title,
    };
  }
}
