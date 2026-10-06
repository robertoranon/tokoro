import type { LLMProvider } from '../../../shared/types/llm.js';
import type { FetchedPage } from '../types/event.js';
import { getTourShowsPrompt } from '../../../shared/extractors/tour-prompt.js';
import { getEventExtractionUserPrompt } from '../../../shared/extractors/extraction-prompt.js';
import {
  FESTIVAL_MAX_CONTENT_LENGTH,
  TOUR_MAX_TOKENS,
} from '../../../shared/extractors/extraction-limits.js';
import { parseTourShows, type TourShowDraft } from '../tours/tour-shows.js';

export interface TourExtractorConfig {
  llm: LLMProvider;
  referenceDate?: string; // YYYY-MM-DD, defaults to today
}

/** One LLM call per page → every show on it. JSON-LD is deliberately not used:
 *  band and venue pages rarely carry it, and it lacks the bill (performers). */
export class TourExtractor {
  constructor(private config: TourExtractorConfig) {}

  async extract(page: FetchedPage): Promise<TourShowDraft[]> {
    const todayISO =
      this.config.referenceDate || new Date().toISOString().split('T')[0];
    console.log(`Extracting tour shows from: ${page.title} (${page.url})`);

    const content = (page.text || '')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .join('\n')
      .slice(0, FESTIVAL_MAX_CONTENT_LENGTH);
    if (!content.trim()) return [];

    const response = await this.config.llm.complete(
      [
        { role: 'system', content: getTourShowsPrompt() },
        {
          role: 'user',
          content: getEventExtractionUserPrompt(page, todayISO, content),
        },
      ],
      { temperature: 0.1, maxTokens: TOUR_MAX_TOKENS, responseFormat: 'json' }
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.content);
    } catch {
      throw new Error(
        `LLM returned malformed JSON for tour shows (${page.url})`
      );
    }
    return parseTourShows(parsed, page.url);
  }
}
