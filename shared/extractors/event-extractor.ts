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
} from './extraction-limits';
import { correctEventYear } from './year-inference.js';

export interface EventExtractorConfig {
  llm: LLMProvider;
  jsonLdParser?: JsonLdParser; // Optional custom JSON-LD parser (JSDOM vs regex)
  referenceDate?: string; // Optional reference date to use instead of today (format: YYYY-MM-DD)
  useJsonLd?: boolean; // Whether to attempt JSON-LD extraction before LLM (default: true)
  maxContentLength?: number; // Max chars of page content to send to LLM (default: DEFAULT_MAX_CONTENT_LENGTH)
  maxTokens?: number; // Max output tokens for LLM event extraction (default: DEFAULT_MAX_TOKENS)
}

/** Compact single-line error formatter — no stack traces. */
function formatError(error: unknown): string {
  if (error && typeof error === 'object' && Array.isArray((error as any).issues)) {
    return (error as any).issues
      .map((i: any) => `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`)
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

export class EventExtractor {
  private llm: LLMProvider;
  private jsonLdParser?: JsonLdParser;
  private referenceDate?: string;
  private useJsonLd: boolean;
  private maxContentLength: number;
  private maxTokens: number;

  constructor(config: EventExtractorConfig) {
    this.llm = config.llm;
    this.jsonLdParser = config.jsonLdParser;
    this.referenceDate = config.referenceDate;
    this.useJsonLd = config.useJsonLd ?? true;
    this.maxContentLength = config.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async extractEvents(page: FetchedPage): Promise<ExtractedEvent[]> {
    console.log(`Extracting events from: ${page.title}`);

    // Get current date for date inference (use referenceDate if provided)
    const todayISO =
      this.referenceDate || new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD

    // Step 1: Try JSON-LD extraction first (unless disabled)
    let jsonldResult: ReturnType<typeof extractJsonLd>;
    if (this.useJsonLd) {
      console.log('🔍 Attempting JSON-LD extraction...');
      jsonldResult = extractJsonLd(page.html, page.url, this.jsonLdParser);
    } else {
      console.log('ℹ️  JSON-LD extraction disabled');
      jsonldResult = { events: [], isSufficient: false, source: 'jsonld' };
    }

    if (jsonldResult.isSufficient && jsonldResult.events.length > 0) {
      console.log(
        `✅ JSON-LD extraction sufficient! Found ${jsonldResult.events.length} event(s), skipping LLM extraction`
      );

      // Validate JSON-LD events
      const validated: ExtractedEvent[] = [];
      for (const event of jsonldResult.events) {
        try {
          const validEvent = ExtractedEventSchema.parse(event);
          validated.push(validEvent);
        } catch (error) {
          console.error(`  ⚠️  JSON-LD validation error for "${(event as any).title}": ${formatError(error)}`);
        }
      }

      if (validated.length > 0) {
        console.log(
          `Extracted ${validated.length} valid event(s) from JSON-LD`
        );
        const filtered = validated.filter(e => {
          const startDateStr = String(e.start_time).slice(0, 10);
          if (startDateStr < todayISO) {
            console.log(`⚠ Skipping past event: "${e.title}" (${e.start_time})`);
            return false;
          }
          return true;
        });
        // correctEventYear not called: JSON-LD events always have explicit years,
        // and the LLM never populates day_name on this code path.
        return filtered;
      }
    }

    // Step 2: Fall back to LLM extraction if JSON-LD is insufficient
    if (jsonldResult.events.length > 0) {
      console.log(
        `⚠️  JSON-LD extraction incomplete (missing required fields), falling back to LLM extraction with JSON-LD enrichment`
      );
    } else {
      console.log(`ℹ️  No JSON-LD data found, using LLM extraction`);
    }

    // Remove empty lines to reduce whitespace bloat before slicing
    const contentWithoutEmptyLines = (page.text || '')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .join('\n');

    const contentSlice = contentWithoutEmptyLines.slice(0, this.maxContentLength);
    const systemPrompt = getEventExtractionPrompt({ maxContentLength: this.maxContentLength });
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
        maxTokens: this.maxTokens,
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
      console.error(`❌ Failed to parse LLM response as JSON: ${formatError(error)}`);
      throw new Error(
        `LLM returned malformed JSON (possibly truncated due to token limit). Consider shortening the description or using a model with larger output capacity.`
      );
    }

    // Handle null (LLM found nothing), single event, or array of events
    if (parsed === null) {
      console.log(`Extracted 0 valid event(s) from LLM`);
      return [];
    }
    const events = Array.isArray(parsed) ? parsed : [parsed];

    console.log(`LLM raw events:`);
    for (const e of events) {
      console.log(`  - "${e.title}" start=${e.start_time} day_name=${e.day_name ?? '(none)'}`);
    }

    // Validate each event and optionally merge with JSON-LD data
    const validated: ExtractedEvent[] = [];
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      try {
        // Add the page URL if event URL is missing
        if (!event.url) {
          event.url = page.url;
        }

        // Sanitize null values to undefined for optional fields
        // Zod's .optional() allows undefined or string, but not null
        if (event.description === null) event.description = undefined;
        if (event.venue_name === null) event.venue_name = undefined;
        if (event.address === null) event.address = undefined;
        if (event.end_time === null) event.end_time = undefined;
        if (event.lat === null) event.lat = undefined;
        if (event.lng === null) event.lng = undefined;
        if (event.tags === null) event.tags = undefined;

        let validEvent = ExtractedEventSchema.parse(event);

        // Merge with JSON-LD data if available (JSON-LD takes precedence for structured fields)
        if (jsonldResult.events.length > 0 && jsonldResult.events[i]) {
          console.log(`🔄 Merging LLM event with JSON-LD data`);
          validEvent = mergeJsonLdWithLlm(jsonldResult.events[i], validEvent);
        }

        validated.push(validEvent);
      } catch (error) {
        console.error(`  ⚠️  Validation error for "${event.title}": ${formatError(error)}`);
      }
    }

    console.log(`Extracted ${validated.length} valid event(s) from LLM`);

    // Append any JSON-LD events not covered by the LLM (e.g. cut off by content length limit)
    if (jsonldResult.events.length > events.length) {
      const extra = jsonldResult.events.slice(events.length);
      console.log(`📎 JSON-LD has ${extra.length} extra event(s) not extracted by LLM, appending...`);
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
          const validEvent = ExtractedEventSchema.parse(eventData);
          validated.push(validEvent);
        } catch (error) {
          console.error(`  ⚠️  Validation error for extra JSON-LD event "${(jsonldEvent as any).title}": ${formatError(error)}`);
        }
      }
      console.log(`Total after JSON-LD supplement: ${validated.length} event(s)`);
    }

    // Apply day_name year correction and past-event filter
    const corrected: ExtractedEvent[] = [];
    for (const event of validated) {
      const fixed = correctEventYear(event);
      if (fixed === null) continue; // dropped by year correction

      const startDateStr = String(fixed.start_time).slice(0, 10);
      if (startDateStr < todayISO) {
        console.log(`⚠ Skipping past event: "${fixed.title}" (${fixed.start_time})`);
        continue;
      }

      corrected.push(fixed);
    }

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
      console.error(`❌ Failed to parse LLM response as JSON: ${formatError(error)}`);
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

        const validEvent = ExtractedEventSchema.parse(event);
        validated.push(validEvent);
      } catch (error) {
        console.error(`  ⚠️  Validation error for "${event.title}": ${formatError(error)}`);
      }
    }

    console.log(`Extracted ${validated.length} valid event(s) from image`);

    return validated;
  }
}
