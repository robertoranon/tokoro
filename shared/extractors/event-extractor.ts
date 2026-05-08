import { LLMProvider } from '../types/llm';
import {
  ExtractedEvent,
  ExtractedEventSchema,
  FetchedPage,
} from '../types/event';
import {
  extractJsonLd,
  mergeJsonLdWithLlm,
  JsonLdParser,
} from './jsonld-extractor';
import {
  getEventExtractionPrompt,
  getEventExtractionUserPrompt,
  getImageEventExtractionPrompt,
  getImageEventExtractionUserPrompt,
} from './extraction-prompt';
import {
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_TOKENS,
  IMAGE_MAX_TOKENS,
  MODEL_MAX_OUTPUT_TOKENS,
} from './extraction-limits';
import { correctEventYear } from './year-inference.js';

export interface EventExtractorConfig {
  llm: LLMProvider;
  jsonLdParser?: JsonLdParser; // Optional custom JSON-LD parser (JSDOM vs regex)
  referenceDate?: string; // Optional reference date to use instead of today (format: YYYY-MM-DD)
  filterPastEvents?: boolean; // Whether to drop events before referenceDate/today (default: true)
  useJsonLd?: boolean; // Whether to attempt JSON-LD extraction before LLM (default: true)
  maxContentLength?: number; // Max chars of page content to send to LLM (default: DEFAULT_MAX_CONTENT_LENGTH)
  maxTokens?: number; // Max output tokens for LLM event extraction (default: DEFAULT_MAX_TOKENS)
  debugLog?: string[]; // Optional collector for pipeline log entries (for worker response debug field)
}

/** Compact single-line error formatter — no stack traces. */
function formatError(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    Array.isArray((error as any).issues)
  ) {
    return (error as any).issues
      .map(
        (i: any) =>
          `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`
      )
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

export class EventExtractor {
  private llm: LLMProvider;
  private jsonLdParser?: JsonLdParser;
  private referenceDate?: string;
  private filterPastEvents: boolean;
  private useJsonLd: boolean;
  private maxContentLength: number;
  private maxTokens: number;
  private debugLog?: string[];

  constructor(config: EventExtractorConfig) {
    this.llm = config.llm;
    this.jsonLdParser = config.jsonLdParser;
    this.referenceDate = config.referenceDate;
    this.filterPastEvents = config.filterPastEvents ?? true;
    this.useJsonLd = config.useJsonLd ?? true;
    this.maxContentLength =
      config.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.debugLog = config.debugLog;
  }

  private log(msg: string): void {
    console.log(msg);
    this.debugLog?.push(msg);
  }

  async extractEvents(page: FetchedPage): Promise<ExtractedEvent[]> {
    this.log(`Extracting events from: ${page.title} (${page.url})`);

    // Get current date for date inference (use referenceDate if provided)
    const todayISO =
      this.referenceDate || new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD

    this.log(`Reference date: ${todayISO}`);

    // Step 1: Try JSON-LD extraction first (unless disabled)
    let jsonldResult: ReturnType<typeof extractJsonLd>;
    if (this.useJsonLd) {
      this.log('JSON-LD: scanning...');
      jsonldResult = extractJsonLd(page.html, page.url, this.jsonLdParser);
      this.log(
        `JSON-LD: found ${jsonldResult.events.length} event(s), sufficient=${jsonldResult.isSufficient}`
      );
      for (const e of jsonldResult.events) {
        this.log(
          `  JSON-LD event: title="${(e as any).title}" start_time=${(e as any).start_time} address="${(e as any).address}" category=${(e as any).category}`
        );
      }
    } else {
      this.log('JSON-LD: disabled');
      jsonldResult = { events: [], isSufficient: false, source: 'jsonld' };
    }

    if (jsonldResult.isSufficient && jsonldResult.events.length > 0) {
      this.log(
        `JSON-LD sufficient — skipping LLM, validating ${jsonldResult.events.length} event(s)`
      );

      // Validate JSON-LD events
      const validated: ExtractedEvent[] = [];
      for (const event of jsonldResult.events) {
        try {
          const validEvent = ExtractedEventSchema.parse(event);
          validated.push(validEvent);
        } catch (error) {
          const msg = `JSON-LD validation error for "${(event as any).title}": ${formatError(error)}`;
          console.error(msg);
          this.debugLog?.push(msg);
        }
      }

      if (validated.length > 0) {
        this.log(`JSON-LD: ${validated.length} valid event(s)`);
        const filtered = this.filterPastEvents
          ? validated.filter(e => {
              const startDateStr = String(e.start_time).slice(0, 10);
              if (startDateStr < todayISO) {
                this.log(`Dropped (past): "${e.title}" start=${e.start_time}`);
                return false;
              }
              return true;
            })
          : validated;
        if (filtered.length > 0) {
          this.log(`JSON-LD path: returning ${filtered.length} event(s)`);
          return filtered;
        }
        this.log('JSON-LD: all events in the past — falling back to LLM');
      }
    }

    // Step 2: Fall back to LLM extraction if JSON-LD is insufficient
    if (jsonldResult.events.length > 0) {
      this.log(
        'JSON-LD incomplete (missing address/coords or category) — falling back to LLM with JSON-LD enrichment'
      );
    } else {
      this.log('No JSON-LD data — using LLM extraction');
    }

    // Remove empty lines to reduce whitespace bloat before slicing
    const contentWithoutEmptyLines = (page.text || '')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .join('\n');

    const contentSlice = contentWithoutEmptyLines.slice(
      0,
      this.maxContentLength
    );
    this.log(
      `LLM input: ${contentSlice.length} chars (model=${this.llm.name})`
    );

    const adaptiveMaxTokens = Math.min(
      Math.max(this.maxTokens, contentSlice.length),
      MODEL_MAX_OUTPUT_TOKENS
    );
    const systemPrompt = getEventExtractionPrompt({
      maxContentLength: this.maxContentLength,
    });
    const userPrompt = getEventExtractionUserPrompt(
      page,
      todayISO,
      contentSlice
    );

    const response = await this.llm.complete(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        temperature: 0.1,
        maxTokens: adaptiveMaxTokens,
        responseFormat: 'json',
      }
    );

    this.log(
      `LLM response (${response.content.length} chars): ${response.content}`
    );

    // Parse and validate the response
    let parsed;
    try {
      parsed = JSON.parse(response.content);
    } catch (error) {
      const msg = `LLM returned malformed JSON: ${formatError(error)}`;
      console.error(msg);
      this.debugLog?.push(msg);
      throw new Error(
        `LLM returned malformed JSON (possibly truncated due to token limit). Consider shortening the description or using a model with larger output capacity.`
      );
    }

    // Handle null (LLM found nothing), single event, or array of events.
    // Treat null as empty array so the JSON-LD fallback below can still run.
    const events =
      parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
    if (parsed === null) {
      this.log('LLM returned null — no events found');
    } else {
      this.log(`LLM raw events: ${events.length}`);
      for (const e of events) {
        this.log(
          `  LLM event: title="${e.title}" start=${e.start_time} day_name=${e.day_name ?? '(none)'} address="${e.address ?? ''}" category=${e.category}`
        );
      }
    }

    // Validate each event and optionally merge with JSON-LD data
    const validated: ExtractedEvent[] = [];
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      try {
        if (!event.url) event.url = page.url;
        if (event.description === null) event.description = undefined;
        if (event.venue_name === null) event.venue_name = undefined;
        if (event.address === null) event.address = undefined;
        if (event.end_time === null) event.end_time = undefined;
        if (event.lat === null) event.lat = undefined;
        if (event.lng === null) event.lng = undefined;
        if (event.tags === null) event.tags = undefined;
        if (event.festival_name === null) event.festival_name = undefined;
        if (event.festival_url === null) event.festival_url = undefined;

        let validEvent = ExtractedEventSchema.parse(event);

        if (jsonldResult.events.length > 0 && jsonldResult.events[i]) {
          this.log(`Merging LLM event[${i}] with JSON-LD data`);
          validEvent = mergeJsonLdWithLlm(jsonldResult.events[i], validEvent);
        }

        validated.push(validEvent);
      } catch (error) {
        const msg = `Schema validation failed for "${event.title}": ${formatError(error)}`;
        console.error(msg);
        this.debugLog?.push(msg);
      }
    }

    this.log(`After validation: ${validated.length} event(s)`);

    // Append any JSON-LD events not covered by the LLM (e.g. cut off by content length limit)
    if (jsonldResult.events.length > events.length) {
      const extra = jsonldResult.events.slice(events.length);
      this.log(
        `JSON-LD supplement: ${extra.length} extra event(s) not in LLM output`
      );
      for (const jsonldEvent of extra) {
        try {
          const eventData: any = { ...jsonldEvent };
          if (!eventData.url) eventData.url = page.url;
          if (!eventData.category) eventData.category = 'other';
          if (eventData.description === null) eventData.description = undefined;
          if (eventData.venue_name === null) eventData.venue_name = undefined;
          if (eventData.address === null) eventData.address = undefined;
          if (eventData.end_time === null) eventData.end_time = undefined;
          if (eventData.lat === null) eventData.lat = undefined;
          if (eventData.lng === null) eventData.lng = undefined;
          if (eventData.tags === null) eventData.tags = undefined;
          if (eventData.festival_name === null)
            eventData.festival_name = undefined;
          if (eventData.festival_url === null)
            eventData.festival_url = undefined;
          const validEvent = ExtractedEventSchema.parse(eventData);
          validated.push(validEvent);
        } catch (error) {
          const msg = `JSON-LD supplement validation error for "${(jsonldEvent as any).title}": ${formatError(error)}`;
          console.error(msg);
          this.debugLog?.push(msg);
        }
      }
      this.log(`After JSON-LD supplement: ${validated.length} event(s)`);
    }

    // Apply day_name year correction and past-event filter
    const corrected: ExtractedEvent[] = [];
    for (const event of validated) {
      const fixed = correctEventYear(event);
      if (fixed === null) {
        this.log(
          `Dropped (year correction): "${event.title}" start=${event.start_time} day_name=${event.day_name}`
        );
        continue;
      }

      if (this.filterPastEvents) {
        const startDateStr = String(fixed.start_time).slice(0, 10);
        if (startDateStr < todayISO) {
          this.log(
            `Dropped (past): "${fixed.title}" start=${fixed.start_time}`
          );
          continue;
        }
      }

      corrected.push(fixed);
    }

    // Safety-net: if LLM extraction produced 0 results (e.g. misread date,
    // wrong year, or returned null) but JSON-LD captured the event, emit the
    // JSON-LD version directly — it has explicit, reliable dates.
    if (corrected.length === 0 && jsonldResult.events.length > 0) {
      console.log(
        `⚠️  LLM yielded 0 events after filtering; retrying with JSON-LD data`
      );
      for (const jsonldEvent of jsonldResult.events) {
        try {
          const eventData: any = { ...jsonldEvent };
          if (!eventData.url) eventData.url = page.url;
          if (!eventData.category) eventData.category = 'other';
          if (eventData.description === null) eventData.description = undefined;
          if (eventData.venue_name === null) eventData.venue_name = undefined;
          if (eventData.address === null) eventData.address = undefined;
          if (eventData.end_time === null) eventData.end_time = undefined;
          if (eventData.lat === null) eventData.lat = undefined;
          if (eventData.lng === null) eventData.lng = undefined;
          if (eventData.tags === null) eventData.tags = undefined;
          if (eventData.festival_name === null)
            eventData.festival_name = undefined;
          if (eventData.festival_url === null)
            eventData.festival_url = undefined;
          const validEvent = ExtractedEventSchema.parse(eventData);
          // JSON-LD dates are explicit — skip year correction, apply date filter only
          const startDateStr = String(validEvent.start_time).slice(0, 10);
          if (this.filterPastEvents && startDateStr < todayISO) {
            this.log(
              `Dropped (past, JSON-LD fallback): "${validEvent.title}" start=${validEvent.start_time}`
            );
            continue;
          }
          corrected.push(validEvent);
        } catch (error) {
          const msg = `JSON-LD fallback validation error for "${(jsonldEvent as any).title}": ${formatError(error)}`;
          console.error(msg);
          this.debugLog?.push(msg);
        }
      }
      this.log(`JSON-LD safety-net: ${corrected.length} event(s) recovered`);
    }

    this.log(`Final: ${corrected.length} event(s) returned`);
    return corrected;
  }

  /**
   * Extract events from an image (flyer, poster, etc.)
   */
  async extractEventsFromImage(
    imageData: string,
    imageMimeType: string,
    imageSource?: string
  ): Promise<ExtractedEvent[]> {
    console.log(`Extracting events from image (${imageMimeType})`);

    // Get current date for date inference (use referenceDate if provided)
    const todayISO =
      this.referenceDate || new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD

    // Build multimodal message with image and text
    const systemPrompt = getImageEventExtractionPrompt();
    const userPromptText = getImageEventExtractionUserPrompt(
      imageSource,
      todayISO
    );

    const response = await this.llm.complete(
      [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: imageMimeType,
                data: imageData,
              },
            },
            {
              type: 'text',
              text: userPromptText,
            },
          ],
        },
      ],
      {
        temperature: 0.1,
        maxTokens: IMAGE_MAX_TOKENS,
        responseFormat: 'json',
      }
    );

    console.log(
      `LLM Response (${this.llm.name}):`,
      response.content.slice(0, 200) + '...'
    );

    // Parse and validate the response
    let parsed;
    try {
      parsed = JSON.parse(response.content);
    } catch (error) {
      console.error(
        `❌ Failed to parse LLM response as JSON: ${formatError(error)}`
      );
      throw new Error(
        `LLM returned malformed JSON (possibly truncated due to token limit). Consider using a model with larger output capacity.`
      );
    }

    // Handle both single event and array of events
    const events = Array.isArray(parsed) ? parsed : [parsed];

    // Validate each event
    const validated: ExtractedEvent[] = [];
    for (const event of events) {
      try {
        // Add the image source URL if event URL is missing and source is a valid URL
        if (!event.url && imageSource) {
          // Only use imageSource as URL if it's actually an HTTP(S) URL
          if (
            imageSource.startsWith('http://') ||
            imageSource.startsWith('https://')
          ) {
            event.url = imageSource;
          }
          // For local files or non-URL sources, leave URL undefined - the LLM should extract it from the image if present
        }

        // Sanitize null values to undefined for optional fields
        if (event.description === null) event.description = undefined;
        if (event.venue_name === null) event.venue_name = undefined;
        if (event.address === null) event.address = undefined;
        if (event.end_time === null) event.end_time = undefined;
        if (event.lat === null) event.lat = undefined;
        if (event.lng === null) event.lng = undefined;
        if (event.tags === null) event.tags = undefined;
        if (event.url === null) event.url = undefined;
        if (event.festival_name === null) event.festival_name = undefined;
        if (event.festival_url === null) event.festival_url = undefined;

        const validEvent = ExtractedEventSchema.parse(event);
        validated.push(validEvent);
      } catch (error) {
        console.error(
          `  ⚠️  Validation error for "${event.title}": ${formatError(error)}`
        );
      }
    }

    console.log(`Extracted ${validated.length} valid event(s) from image`);

    return validated;
  }
}
