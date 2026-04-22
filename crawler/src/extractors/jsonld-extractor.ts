import { JSDOM } from 'jsdom';
import {
  extractJsonLd as extractJsonLdBase,
  JsonLdParser,
} from '../../../shared/extractors/jsonld-extractor.js';

/**
 * JSDOM-based parser for JSON-LD extraction (used in crawler environment)
 */
const jsdomJsonLdParser: JsonLdParser = (html: string): string[] => {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const scripts = document.querySelectorAll(
    'script[type="application/ld+json"]'
  );
  return Array.from(scripts)
    .map(script => script.textContent)
    .filter((text): text is string => text !== null);
};

/**
 * Extracts all JSON-LD data from HTML using JSDOM
 */
export function extractJsonLd(html: string, url: string) {
  return extractJsonLdBase(html, url, jsdomJsonLdParser);
}

// Re-export other utilities from shared
export {
  mergeJsonLdWithLlm,
  type JsonLdExtractionResult,
} from '../../../shared/extractors/jsonld-extractor.js';
