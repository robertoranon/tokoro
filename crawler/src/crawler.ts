import { HTMLFetcher } from './extractors/html-fetcher.js';
import { JinaFetcher } from './extractors/jina-fetcher.js';
import { ImageFetcher } from './extractors/image-fetcher.js';
import { PdfFetcher } from './extractors/pdf-fetcher.js';
import * as path from 'path';
import { EventExtractor } from './extractors/event-extractor.js';
import { PageDiscovery } from './extractors/page-discovery.js';
import { EventNormalizer, KeyPair } from './utils/normalizer.js';
import { APIPublisher } from './utils/api-publisher.js';
import { LLMProvider } from '../../shared/types/llm.js';
import { ExtractedEvent } from './types/event.js';
import {
  DEFAULT_MAX_CONTENT_LENGTH,
  FESTIVAL_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_TOKENS,
  FESTIVAL_MAX_TOKENS,
  PAGE_DISCOVERY_MAX_TOKENS,
} from '../../shared/extractors/extraction-limits.js';

// Domains where Playwright is reliably blocked (bot detection, sign-in walls, etc.)
// For these, the Jina fetcher is used automatically even when playwright is the default.
const JINA_PREFERRED_DOMAINS = new Set(['bandsintown.com']);

export type CrawlerMode = 'direct' | 'discover' | 'image' | 'festival' | 'pdf';
export type FetcherType = 'playwright' | 'jina';

export interface CrawlerConfig {
  llm: LLMProvider;
  keypair: KeyPair;
  apiUrl: string;
  mode?: CrawlerMode; // defaults to 'discover'
  fetcher?: FetcherType; // defaults to 'playwright'
  jinaKey?: string;
  debug?: boolean; // if true, output events to console only (skip API publishing)
  normalize?: boolean; // if true (with debug), run full normalization; if false (default with debug), skip geocoding/signing
  referenceDate?: string; // optional reference date for LLM (format: YYYY-MM-DD, defaults to today)
  useJsonLd?: boolean; // whether to attempt JSON-LD extraction before LLM (default: true)
  maxTokens?: number; // override output token budget (default: auto-scaled from content length)
}

export class EventCrawler {
  private fetcher: HTMLFetcher | JinaFetcher;
  private jinaFallback: JinaFetcher | null;
  private imageFetcher: ImageFetcher;
  private pdfFetcher: PdfFetcher;
  private discovery: PageDiscovery;
  private extractor: EventExtractor;
  private normalizer: EventNormalizer;
  private publisher: APIPublisher;

  constructor(private config: CrawlerConfig) {
    const fetcherType = config.fetcher || 'playwright';
    this.fetcher =
      fetcherType === 'jina'
        ? new JinaFetcher(config.jinaKey)
        : new HTMLFetcher();
    // Keep a Jina instance ready for domain-based routing when playwright is primary
    this.jinaFallback =
      fetcherType === 'playwright' ? new JinaFetcher(config.jinaKey) : null;
    this.imageFetcher = new ImageFetcher();
    this.pdfFetcher = new PdfFetcher();
    this.discovery = new PageDiscovery(config.llm);
    const isFestival = (config.mode || 'discover') === 'festival';
    this.extractor = new EventExtractor({
      llm: config.llm,
      referenceDate: config.referenceDate,
      useJsonLd: config.useJsonLd,
      maxContentLength: isFestival
        ? FESTIVAL_MAX_CONTENT_LENGTH
        : DEFAULT_MAX_CONTENT_LENGTH,
      maxTokens:
        config.maxTokens ??
        (isFestival ? FESTIVAL_MAX_TOKENS : DEFAULT_MAX_TOKENS),
    });
    this.normalizer = new EventNormalizer(config.keypair);
    this.publisher = new APIPublisher(config.apiUrl, config.debug, config.llm);
  }

  private fetcherForUrl(url: string): HTMLFetcher | JinaFetcher {
    if (this.jinaFallback) {
      try {
        const hostname = new URL(url).hostname.replace(/^www\./, '');
        if (JINA_PREFERRED_DOMAINS.has(hostname)) {
          return this.jinaFallback;
        }
      } catch {
        // malformed URL — fall through to default fetcher
      }
    }
    return this.fetcher;
  }

  async crawl(urls: string[]): Promise<void> {
    const mode = this.config.mode || 'direct';
    const fetcherType = this.config.fetcher || 'playwright';

    const modeDescriptions = {
      discover: 'Discover & extract (follow links)',
      direct: 'Direct extraction (cleaned content)',
      image: 'Image extraction (from flyers/posters)',
      festival:
        'Festival extraction (discover listing pages, extract all events)',
      pdf: 'PDF extraction (from local files or URLs)',
    };

    console.log(`\n🚀 Starting crawler with ${urls.length} image(s)/URL(s)\n`);
    if (mode !== 'image') {
      console.log(
        `Fetcher: ${fetcherType === 'jina' ? 'Jina AI Reader' : 'Playwright + HTML cleaner'}`
      );
    }
    console.log(`API URL: ${this.config.apiUrl}`);
    console.log(`Mode: ${modeDescriptions[mode]}`);
    if (this.config.debug) {
      console.log(`Debug Mode: ON (events will be output to console only)\n`);
    } else {
      console.log();
    }

    // Handle image mode separately
    if (mode === 'image') {
      return this.crawlImages(urls);
    }

    // Handle PDF mode separately
    if (mode === 'pdf') {
      return this.crawlPdfs(urls);
    }

    // Festival mode has its own flow
    if (mode === 'festival') {
      return this.crawlFestival(urls);
    }

    try {
      await this.fetcher.initialize();

      let totalEvents = 0;
      let totalPublished = 0;

      for (const seedUrl of urls) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Processing seed: ${seedUrl}`);
        console.log(`${'='.repeat(60)}\n`);

        try {
          // Fetch the seed page
          const seedPage = await this.fetcherForUrl(seedUrl).fetchPage(seedUrl);

          // Determine which URLs to process based on mode
          let urlsToProcess: string[];

          if (mode === 'direct') {
            // Direct mode: only extract from the given URLs, don't follow links
            console.log(`📄 Direct extraction mode: processing URL as-is\n`);
            urlsToProcess = [seedUrl];
          } else {
            // Discover mode: try to find individual event page URLs
            const eventUrls = await this.discovery.discoverEventUrls(
              seedPage.html,
              seedUrl
            );

            if (eventUrls.length > 0) {
              console.log(
                `📋 Discovered ${eventUrls.length} event page(s), processing each...\n`
              );
              urlsToProcess = eventUrls;
            } else {
              console.log(
                `ℹ️  No event URLs discovered, treating seed as individual event page\n`
              );
              urlsToProcess = [seedUrl];
            }
          }

          // Phase 2: Extract events from each discovered URL
          for (const eventUrl of urlsToProcess) {
            try {
              console.log(`\n  Processing event page: ${eventUrl}`);

              // Fetch the event page (or reuse seed page if it's the same URL)
              const page =
                eventUrl === seedUrl
                  ? seedPage
                  : await this.fetcherForUrl(eventUrl).fetchPage(eventUrl);

              // Extract events using LLM
              const rawEvents = await this.extractor.extractEvents(page);

              if (rawEvents.length === 0) {
                console.log('  ⚠ No events extracted from this page');
                continue;
              }

              // Force the event URL to the page we actually crawled — the LLM may pick up
              // a homepage link from navigation instead of the actual event page URL.
              const extractedEvents = rawEvents.map(e => ({
                ...e,
                url: eventUrl,
              }));

              totalEvents += extractedEvents.length;

              if (this.config.debug && !this.config.normalize) {
                this.printRawEvents(extractedEvents);
              } else {
                // Normalize and sign events
                const normalizedEvents = [];
                for (const event of extractedEvents) {
                  const normalized = await this.normalizer.normalize(event);
                  if (normalized) {
                    normalizedEvents.push(normalized);
                  }
                }

                // Publish to API
                if (normalizedEvents.length > 0) {
                  const published =
                    await this.publisher.publishMultiple(normalizedEvents);
                  totalPublished += published;
                }
              }
            } catch (error) {
              console.error(
                `\n  ❌ Error processing event page ${eventUrl}:`,
                error
              );
            }
          }
        } catch (error) {
          console.error(`\n❌ Error processing seed ${seedUrl}:`, error);
        }
      }

      console.log(`\n${'='.repeat(60)}`);
      console.log(`✅ Crawl complete!`);
      console.log(`Total events extracted: ${totalEvents}`);
      console.log(`Total events published: ${totalPublished}`);
      console.log(`${'='.repeat(60)}\n`);
    } finally {
      await this.fetcher.close();
    }
  }

  /**
   * Extract events from pre-fetched text files (debug mode)
   * Skips all HTTP fetching and passes text content directly to the LLM extractor
   */
  async crawlTextFile(filePath: string, text: string): Promise<void> {
    const filename = path.basename(filePath);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing text file: ${filePath}`);
    console.log(`${'='.repeat(60)}\n`);

    const page = {
      url: `file://${filePath}`,
      html: '',
      text,
      title: filename,
    };

    const extractedEvents = await this.extractor.extractEvents(page);

    if (extractedEvents.length === 0) {
      console.log('  ⚠ No events extracted from this file');
      return;
    }

    if (this.config.debug && !this.config.normalize) {
      this.printRawEvents(extractedEvents);
    } else {
      const normalizedEvents = [];
      for (const event of extractedEvents) {
        const normalized = await this.normalizer.normalize(event);
        if (normalized) {
          normalizedEvents.push(normalized);
        }
      }

      if (normalizedEvents.length > 0) {
        await this.publisher.publishMultiple(normalizedEvents);
      }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ Text file extraction complete!`);
    console.log(`Total events extracted: ${extractedEvents.length}`);
    console.log(`${'='.repeat(60)}\n`);
  }

  private async crawlFestival(urls: string[]): Promise<void> {
    console.log(
      `\n🎪 Festival mode: discovering listing pages and extracting all events\n`
    );

    try {
      await this.fetcher.initialize();

      let totalPublished = 0;

      for (const seedUrl of urls) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Festival homepage: ${seedUrl}`);
        console.log(`${'='.repeat(60)}\n`);

        try {
          // Fetch homepage
          const homePage = await this.fetcherForUrl(seedUrl).fetchPage(seedUrl);

          // Derive festival identity from the homepage
          const festivalName = homePage.title || new URL(seedUrl).hostname;
          const festivalUrl = new URL(seedUrl).origin;

          console.log(`Festival: "${festivalName}" (${festivalUrl})\n`);

          // Discover program/listing sub-pages
          const listingPages =
            await this.discovery.discoverFestivalListingPages(
              homePage.html,
              seedUrl
            );

          // If no listing pages found, treat the homepage itself as the listing page
          const pagesToProcess =
            listingPages.length > 0 ? listingPages : [seedUrl];

          if (listingPages.length === 0) {
            console.log(
              `ℹ️  No listing sub-pages found, extracting directly from homepage\n`
            );
          } else {
            console.log(
              `📋 Found ${listingPages.length} listing page(s), extracting events...\n`
            );
          }

          // Collect all events across all listing pages before publishing
          const allStampedEvents = [];

          for (const listingUrl of pagesToProcess) {
            try {
              console.log(`\n  Processing listing page: ${listingUrl}`);

              const page =
                listingUrl === seedUrl
                  ? homePage
                  : await this.fetcherForUrl(listingUrl).fetchPage(listingUrl);

              const extractedEvents = await this.extractor.extractEvents(page);

              if (extractedEvents.length === 0) {
                console.log('  ⚠ No events extracted from this page');
                continue;
              }

              // Stamp festival metadata on every event
              const stamped = extractedEvents.map(e => ({
                ...e,
                festival_name: e.festival_name || festivalName,
                festival_url: e.festival_url || festivalUrl,
              }));

              allStampedEvents.push(...stamped);
            } catch (error) {
              console.error(
                `\n  ❌ Error processing listing page ${listingUrl}:`,
                error
              );
            }
          }

          if (allStampedEvents.length === 0) {
            console.log('\n⚠ No events extracted from any listing page');
            continue;
          }

          console.log(
            `\n📦 Extracted ${allStampedEvents.length} raw event(s) across all pages`
          );

          // Group into one event per day
          const groupedEvents = this.groupFestivalEventsByDay(
            allStampedEvents,
            festivalName
          );

          console.log(
            `\n✅ Grouped into ${groupedEvents.length} day event(s):`
          );
          for (const e of groupedEvents) {
            console.log(`  • "${e.title}"`);
          }

          if (this.config.debug && !this.config.normalize) {
            this.printRawEvents(groupedEvents);
          } else {
            const normalizedEvents = [];
            for (const event of groupedEvents) {
              const normalized = await this.normalizer.normalize(event);
              if (normalized) normalizedEvents.push(normalized);
            }

            if (normalizedEvents.length > 0) {
              const published =
                await this.publisher.publishMultiple(normalizedEvents);
              totalPublished += published;
            }
          }
        } catch (error) {
          console.error(`\n❌ Error processing festival ${seedUrl}:`, error);
        }
      }

      console.log(`\n${'='.repeat(60)}`);
      console.log(`✅ Festival crawl complete!`);
      console.log(`Total events published: ${totalPublished}`);
      console.log(`${'='.repeat(60)}\n`);
    } finally {
      await this.fetcher.close();
    }
  }

  /**
   * Group individually-extracted festival events into one event per calendar day.
   * Each day event has a description listing all sub-events with their times and venues.
   */
  private groupFestivalEventsByDay(
    events: ExtractedEvent[],
    fallbackFestivalName: string
  ): ExtractedEvent[] {
    // Group by date (YYYY-MM-DD)
    const byDate = new Map<string, ExtractedEvent[]>();
    for (const event of events) {
      const date = String(event.start_time).slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(event);
    }

    const grouped: ExtractedEvent[] = [];

    for (const [date, dayEvents] of [...byDate.entries()].sort()) {
      // Sort by start_time within the day
      dayEvents.sort((a, b) =>
        String(a.start_time).localeCompare(String(b.start_time))
      );

      // Deduplicate by title within the day
      const seen = new Set<string>();
      const unique = dayEvents.filter(e => {
        if (seen.has(e.title)) return false;
        seen.add(e.title);
        return true;
      });

      const festival_name =
        unique.find(e => e.festival_name)?.festival_name ??
        fallbackFestivalName;
      const festival_url = unique.find(e => e.festival_url)?.festival_url;

      // Build title: "Festival Name – Weekday DD Month"
      // Use noon UTC to avoid date-shift issues with local timezone
      const dayDate = new Date(`${date}T12:00:00Z`);
      const weekday = dayDate.toLocaleDateString('en-US', {
        weekday: 'long',
        timeZone: 'UTC',
      });
      const dayLabel = dayDate.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
      });
      const title = `${festival_name} – ${weekday}, ${dayLabel}`;

      // Build description: "HH:MM Sub-event title (Venue)" per line
      const descLines = unique.map(e => {
        const time = String(e.start_time).slice(11, 16);
        // Strip "Festival Name – " or "Festival Name DayX – " prefix from sub-event titles
        const subTitle = e.title.replace(/^.+?–\s*/, '');
        const venue = e.venue_name ? ` (${e.venue_name})` : '';
        return `${time} ${subTitle}${venue}`;
      });

      // Pick venue/address/coords from first event that has them
      const withVenue = unique.find(e => e.venue_name);
      const withAddress = unique.find(e => e.address);
      const withCoords = unique.find(e => e.lat != null && e.lng != null);

      // Most common category
      const catCounts = new Map<string, number>();
      for (const e of unique)
        catCounts.set(e.category, (catCounts.get(e.category) ?? 0) + 1);
      const category = [...catCounts.entries()].sort(
        (a, b) => b[1] - a[1]
      )[0][0] as ExtractedEvent['category'];

      // Merged tags (deduplicated)
      const allTags = [...new Set(unique.flatMap(e => e.tags ?? []))];

      grouped.push({
        title,
        description: descLines.join('\n'),
        url: festival_url ?? unique[0].url,
        venue_name: withVenue?.venue_name,
        address: withAddress?.address,
        lat: withCoords?.lat,
        lng: withCoords?.lng,
        start_time: `${date}T00:00:00`,
        end_time: `${date}T23:59:59`,
        category,
        tags: allTags.length > 0 ? allTags : undefined,
        festival_name,
        festival_url,
      });
    }

    return grouped;
  }

  /**
   * Use the LLM to remove redundant wrapper events and semantic duplicates from a festival
   * event list, while preserving legitimate parallel events (different stages, performances).
   */
  private async deduplicateFestivalEvents(
    events: ExtractedEvent[]
  ): Promise<ExtractedEvent[]> {
    if (events.length <= 1) return events;

    console.log(`\n🔍 Running LLM deduplication on ${events.length} events...`);

    const eventSummaries = events.map((e, i) => ({
      index: i,
      title: e.title,
      start_time: e.start_time,
      end_time: e.end_time ?? null,
      venue_name: e.venue_name ?? null,
      description: e.description ? e.description.slice(0, 200) : null,
    }));

    const systemPrompt = `You are a festival event deduplication assistant. Given a list of events extracted from a festival website, identify which events should be removed because they are either:

1. Redundant wrapper events: a general/overview event (e.g. "Flow Festival 2026", "Weekend Festival") whose date range spans the entire festival while more specific individual day or session events already exist in the list. These add no value when the specific events are present.

2. Semantic duplicates: the same event extracted twice under slightly different names (e.g. "Sunday" and "Family Sunday" referring to the same festival day event, or "Opening Night" and "Festival Opening").

Do NOT remove:
- Events running in parallel at the same time but at different stages or with different lineups — these are distinct events even if they overlap.
- Events that are genuinely different experiences even if they share some time overlap.

When in doubt, keep the event.

Return a JSON object with exactly two keys:
- "remove": array of integer indices to remove (empty array if nothing to remove)
- "reasons": object mapping index (as string) to a short reason explaining the removal`;

    const userPrompt = `Festival events to deduplicate:

${JSON.stringify(eventSummaries, null, 2)}

Return JSON: {"remove": [], "reasons": {}}`;

    const response = await this.config.llm.complete(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        temperature: 0.1,
        maxTokens: PAGE_DISCOVERY_MAX_TOKENS,
        responseFormat: 'json',
      }
    );

    let result: { remove: number[]; reasons: Record<string, string> };
    try {
      result = JSON.parse(response.content);
    } catch {
      console.warn(
        '⚠️  Failed to parse deduplication response, keeping all events'
      );
      return events;
    }

    if (!Array.isArray(result.remove) || result.remove.length === 0) {
      console.log('✅ No duplicates or redundant events found');
      return events;
    }

    const removeSet = new Set(result.remove);

    console.log(`🗑️  Removing ${result.remove.length} event(s):`);
    for (const idx of result.remove) {
      const reason =
        result.reasons?.[idx] ??
        result.reasons?.[String(idx)] ??
        'duplicate/redundant';
      console.log(`  - [${idx}] "${events[idx]?.title}": ${reason}`);
    }

    return events.filter((_, i) => !removeSet.has(i));
  }

  private printRawEvents(events: ExtractedEvent[]): void {
    for (const event of events) {
      console.log('\n' + '='.repeat(80));
      console.log('DEBUG - Extracted Event (raw, normalization skipped):');
      console.log('='.repeat(80));
      console.log(JSON.stringify(event, null, 2));
      console.log('='.repeat(80) + '\n');
    }
    console.log(
      `\n[DEBUG] ${events.length} event(s) extracted (normalization skipped)`
    );
  }

  /**
   * Crawl images to extract events from flyers/posters
   */
  private async crawlImages(imagePaths: string[]): Promise<void> {
    let totalEvents = 0;
    let totalPublished = 0;

    for (const imagePath of imagePaths) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Processing image: ${imagePath}`);
      console.log(`${'='.repeat(60)}\n`);

      try {
        // Load the image
        const imageData = await this.imageFetcher.loadImage(imagePath);

        // Extract events from the image
        const extractedEvents = await this.extractor.extractEventsFromImage(
          imageData.base64,
          imageData.mimeType,
          imageData.source
        );

        if (extractedEvents.length === 0) {
          console.log('  ⚠ No events extracted from this image');
          continue;
        }

        totalEvents += extractedEvents.length;

        if (this.config.debug && !this.config.normalize) {
          this.printRawEvents(extractedEvents);
        } else {
          // Normalize and sign events
          const normalizedEvents = [];
          for (const event of extractedEvents) {
            const normalized = await this.normalizer.normalize(event);
            if (normalized) {
              normalizedEvents.push(normalized);
            }
          }

          // Publish to API
          if (normalizedEvents.length > 0) {
            const published =
              await this.publisher.publishMultiple(normalizedEvents);
            totalPublished += published;
          }
        }
      } catch (error) {
        console.error(`\n❌ Error processing image ${imagePath}:`, error);
      }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ Image extraction complete!`);
    console.log(`Total events extracted: ${totalEvents}`);
    console.log(`Total events published: ${totalPublished}`);
    console.log(`${'='.repeat(60)}\n`);
  }

  /**
   * Extract events from PDF files (local paths or URLs).
   * Routes to text extractor if PDF has enough text, otherwise renders pages
   * as images for the vision LLM.
   */
  private async crawlPdfs(sources: string[]): Promise<void> {
    let totalEvents = 0;
    let totalPublished = 0;

    for (const source of sources) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Processing PDF: ${source}`);
      console.log(`${'='.repeat(60)}\n`);

      try {
        const pdfData = await this.pdfFetcher.loadPdf(source);

        const rawName = source.startsWith('http')
          ? new URL(source).pathname
          : source;
        const filename = path.basename(rawName);

        const sourceUrl = source.startsWith('http')
          ? source
          : `file://${path.resolve(source)}`;

        let extractedEvents: ExtractedEvent[];

        if (pdfData.type === 'text') {
          console.log(
            `\n  📄 Text mode: ${pdfData.text.length} chars from ${pdfData.pageCount} page(s)`
          );
          const page = {
            url: sourceUrl,
            html: '',
            text: pdfData.text,
            title: filename,
          };
          extractedEvents = await this.extractor.extractEvents(page);
        } else {
          console.log(
            `\n  🖼️  Image mode: ${pdfData.pages.length} page(s) to process`
          );
          extractedEvents = [];
          for (let pageNum = 0; pageNum < pdfData.pages.length; pageNum++) {
            const pageImage = pdfData.pages[pageNum];
            const pageEvents = await this.extractor.extractEventsFromImage(
              pageImage.base64,
              pageImage.mimeType,
              sourceUrl
            );
            console.log(
              `  Page ${pageNum + 1}/${pdfData.pages.length}: ${pageEvents.length} event(s)`
            );
            extractedEvents.push(...pageEvents);
          }
        }

        if (extractedEvents.length === 0) {
          console.log('  ⚠ No events extracted from this PDF');
          continue;
        }

        totalEvents += extractedEvents.length;

        const normalizedEvents = [];
        for (const event of extractedEvents) {
          const normalized = await this.normalizer.normalize(event);
          if (normalized) normalizedEvents.push(normalized);
        }

        if (normalizedEvents.length > 0) {
          const published =
            await this.publisher.publishMultiple(normalizedEvents);
          totalPublished += published;
        }
      } catch (error) {
        console.error(`\n❌ Error processing PDF ${source}:`, error);
      }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ PDF extraction complete!`);
    console.log(`Total events extracted: ${totalEvents}`);
    console.log(`Total events published: ${totalPublished}`);
    console.log(`${'='.repeat(60)}\n`);
  }
}
