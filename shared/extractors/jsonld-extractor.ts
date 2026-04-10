import { ExtractedEvent } from '../types/event';
import {
  extractEventFromJsonLd,
  isSufficientData,
  mergeJsonLdWithLlm as mergeJsonLdWithLlmBase,
  JsonLdExtractionResult,
} from './jsonld-helpers';

export type { JsonLdExtractionResult };

/**
 * HTML Parser strategy for extracting JSON-LD scripts
 * Different environments can provide different implementations (JSDOM, regex, etc.)
 */
export type JsonLdParser = (html: string) => string[];

/**
 * Default regex-based parser (works in all environments including Workers)
 */
export function regexJsonLdParser(html: string): string[] {
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const matches = html.matchAll(scriptRegex);
  return Array.from(matches).map(match => match[1]).filter(Boolean);
}

/**
 * Extracts all JSON-LD data from HTML
 *
 * @param html The HTML content to parse
 * @param url The page URL (used as fallback for event URLs)
 * @param parser Optional custom parser function (defaults to regex-based parser)
 */
export function extractJsonLd(
  html: string,
  url: string,
  parser: JsonLdParser = regexJsonLdParser
): JsonLdExtractionResult<ExtractedEvent> {
  const events: Partial<ExtractedEvent>[] = [];

  try {
    const jsonldScripts = parser(html);
    console.log(`Found ${jsonldScripts.length} JSON-LD script(s) in HTML`);

    for (const jsonldText of jsonldScripts) {
      try {
        const jsonld = JSON.parse(jsonldText);

        // Handle both single objects and arrays
        const items = Array.isArray(jsonld) ? jsonld : [jsonld];

        for (const item of items) {
          // Handle @graph arrays (common in Schema.org markup)
          if (item['@graph'] && Array.isArray(item['@graph'])) {
            for (const graphItem of item['@graph']) {
              const event = extractEventFromJsonLd(graphItem, url);
              if (event) {
                console.log(`Extracted event from JSON-LD @graph:`, event.title);
                events.push(event);
              }
            }
          } else {
            const event = extractEventFromJsonLd(item, url);
            if (event) {
              console.log(`Extracted event from JSON-LD:`, event.title);
              events.push(event);
            }
          }
        }
      } catch (error) {
        console.warn('Failed to parse JSON-LD script:', error);
      }
    }
  } catch (error) {
    console.error('Failed to extract JSON-LD:', error);
  }

  // Check if we have sufficient data to skip LLM extraction
  const allSufficient = events.length > 0 && events.every(isSufficientData);

  console.log(`JSON-LD extraction: found ${events.length} event(s), sufficient: ${allSufficient}`);

  return {
    events,
    isSufficient: allSufficient,
    source: 'jsonld',
  };
}

/**
 * Helper to merge JSON-LD data with LLM-extracted data
 * JSON-LD takes precedence for structured fields (dates, coordinates, address)
 * LLM can fill in missing fields (category, tags, descriptions)
 */
export function mergeJsonLdWithLlm(
  jsonldEvent: Partial<ExtractedEvent>,
  llmEvent: ExtractedEvent
): ExtractedEvent {
  return mergeJsonLdWithLlmBase(jsonldEvent, llmEvent);
}
