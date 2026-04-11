/**
 * Worker-compatible crawler implementation — extraction only.
 * Extracts, geocodes, and normalises events. Never publishes.
 * Clients receive PreparedEvent[] and handle signing + publishing.
 */

import { Env } from './types';
import { createLLMProvider } from '../../shared/llm/factory';
import { LLMProvider } from '../../shared/types/llm';
import { EventExtractor } from './event-extractor';
import { PageDiscovery } from './page-discovery';
import { EventNormalizer, NormalizeFailure } from './event-normalizer';
import { FetchedPage, ExtractedEvent, PreparedEvent } from './event-types';
import { CrawlerLogger } from './logger';
import { extractCleanText } from '../../shared/extractors/html-cleaner';

export type CrawlerMode = 'direct' | 'discover' | 'image';

export interface CrawlerConfig {
  env: Env;
  mode: CrawlerMode;
  providedHtml?: string;
  providedTitle?: string;
  imageData?: string;
  imageMimeType?: string;
}

export interface CrawlResult {
  urls_processed: number;
  events_extracted: number;
  events: PreparedEvent[];
  dropped_events?: NormalizeFailure[];
}

export class WorkerCrawler {
  private extractor: EventExtractor;
  private discovery: PageDiscovery;
  private normalizer: EventNormalizer;
  private logger: CrawlerLogger;
  private llm: LLMProvider;

  constructor(private config: CrawlerConfig) {
    this.logger = new CrawlerLogger(config.env.CRAWLER_LOGS);
    const llm = createLLMProvider({
      provider: config.env.LLM_PROVIDER,
      apiKey: config.env.LLM_API_KEY!,
      model: config.env.LLM_MODEL,
    });
    this.llm = llm;
    this.extractor = new EventExtractor({ llm });
    this.discovery = new PageDiscovery(llm);
    this.normalizer = new EventNormalizer();
  }

  async crawl(url: string): Promise<CrawlResult> {
    const result: CrawlResult = {
      urls_processed: 0,
      events_extracted: 0,
      events: [],
    };
    const droppedEvents: NormalizeFailure[] = [];

    try {
      this.logger.info('crawl_start', `Starting crawl: ${url}`, { mode: this.config.mode, model: this.llm.name }, url);

      if (this.config.mode === 'image') {
        if (!this.config.imageData) throw new Error('Image data is required for image mode');

        this.logger.info('image_extraction_start', 'Image extraction mode', { model: this.llm.name }, url);
        result.urls_processed = 1;

        const imageMimeType = this.config.imageMimeType || 'image/jpeg';
        const extractedEvents = await this.extractor.extractEventsFromImage(
          this.config.imageData,
          imageMimeType,
          url
        );
        result.events_extracted = extractedEvents.length;

        for (const event of extractedEvents) {
          const normalized = await this.normalizeEvent(event, url, droppedEvents);
          if (normalized) result.events.push(normalized);
        }

        this.logger.info('image_extraction_complete', 'Image extraction complete', result, url);
        await this.logger.flush();
        if (droppedEvents.length > 0) result.dropped_events = droppedEvents;
        return result;
      }

      const page = await this.fetchPage(url, this.config.providedHtml, this.config.providedTitle);
      result.urls_processed++;

      let urlsToProcess: string[];
      if (this.config.mode === 'direct') {
        this.logger.info('mode_direct', 'Direct extraction mode', undefined, url);
        urlsToProcess = [url];
      } else {
        this.logger.info('discovery_start', 'Discovering event URLs', undefined, url);
        const eventUrls = await this.discovery.discoverEventUrls(page.html, url);
        if (eventUrls.length > 0) {
          this.logger.info('discovery_success', `Discovered ${eventUrls.length} event page(s)`, { count: eventUrls.length }, url);
          urlsToProcess = eventUrls;
        } else {
          this.logger.warn('discovery_empty', 'No event URLs discovered, treating seed as individual event page', undefined, url);
          urlsToProcess = [url];
        }
      }

      for (const eventUrl of urlsToProcess) {
        try {
          this.logger.info('url_processing_start', `Processing URL: ${eventUrl}`, undefined, eventUrl);
          const eventPage = eventUrl === url ? page : await this.fetchPage(eventUrl);
          if (eventUrl !== url) result.urls_processed++;

          const extractedEvents = await this.extractor.extractEvents(eventPage);
          result.events_extracted += extractedEvents.length;

          if (extractedEvents.length === 0) {
            this.logger.warn('no_events_found', 'No events found on page', undefined, eventUrl);
            continue;
          }

          this.logger.info('extraction_success', `Extracted ${extractedEvents.length} event(s)`, { count: extractedEvents.length }, eventUrl);

          for (const event of extractedEvents) {
            const normalized = await this.normalizeEvent(event, eventUrl, droppedEvents);
            if (normalized) result.events.push(normalized);
          }
        } catch (error) {
          this.logger.error('url_processing_error', `Error processing ${eventUrl}`, { error: error instanceof Error ? error.message : String(error) }, eventUrl);
        }
      }

      if (droppedEvents.length > 0) result.dropped_events = droppedEvents;
      this.logger.info('crawl_complete', 'Crawl complete', result, url);
      await this.logger.flush();
      return result;
    } catch (error) {
      this.logger.error('crawl_error', 'Crawl failed', { error: error instanceof Error ? error.message : String(error) }, url);
      await this.logger.flush();
      throw error;
    }
  }

  private async normalizeEvent(
    event: ExtractedEvent,
    url: string,
    droppedEvents: NormalizeFailure[]
  ): Promise<PreparedEvent | null> {
    try {
      const result = await this.normalizer.normalize(event);
      if ('event' in result) return result.event;
      droppedEvents.push(result.failure);
      this.logger.warn('event_dropped', `Event dropped: ${result.failure.reason}`, result.failure, url);
      return null;
    } catch (error) {
      const failure = {
        title: event.title,
        reason: error instanceof Error ? error.message : String(error),
        address: event.address,
        venue_name: event.venue_name,
      };
      droppedEvents.push(failure);
      this.logger.warn('event_dropped', `Event dropped (normalisation error): ${failure.reason}`, failure, url);
      return null;
    }
  }

  private async fetchPage(url: string, providedHtml?: string, providedTitle?: string): Promise<FetchedPage> {
    if (providedHtml) {
      const { text, title: extractedTitle } = extractCleanText(providedHtml);
      const title = providedTitle || extractedTitle || 'Untitled';
      this.logger.info('fetch_chrome_extension', 'Using provided HTML from Chrome extension', { htmlLength: providedHtml.length, textLength: text.length }, url);
      return { url, html: providedHtml, text, title };
    }

    this.logger.info('fetch_jina_start', 'Fetching page via Jina AI Reader', undefined, url);
    const jinaUrl = `https://r.jina.ai/${url}`;
    const headers: Record<string, string> = {
      'Accept': 'text/plain',
      'X-Timeout': '30',
      'X-Return-Format': 'markdown',
      'X-With-Links-Summary': 'false',
      'X-With-Images-Summary': 'false',
    };
    if (this.config.env.JINA_API_KEY) {
      headers['Authorization'] = `Bearer ${this.config.env.JINA_API_KEY}`;
    }

    const jinaResponse = await fetch(jinaUrl, { headers, signal: AbortSignal.timeout(30000) });
    if (!jinaResponse.ok) {
      const error = `Jina AI Reader failed: ${jinaResponse.status} ${jinaResponse.statusText}`;
      this.logger.error('fetch_jina_error', error, { status: jinaResponse.status }, url);
      throw new Error(error);
    }

    const markdown = await jinaResponse.text();
    this.logger.info('fetch_jina_success', 'Jina AI Reader fetch successful', { contentLength: markdown.length }, url);

    const titleMatch = markdown.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

    let html = '';
    try {
      const htmlResponse = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TokoroCrawler/1.0)' },
        signal: AbortSignal.timeout(30000),
      });
      html = htmlResponse.ok ? await htmlResponse.text() : `<html><head><title>${title}</title></head><body></body></html>`;
    } catch {
      html = `<html><head><title>${title}</title></head><body></body></html>`;
    }

    return { url, html, text: markdown, title };
  }
}
