import type { LLMProvider } from '../../../shared/types/llm.js';
import type { FetchedPage } from '../types/event.js';
import { getFestivalEntryPrompt } from '../../../shared/extractors/festival-entry-prompt.js';
import { getEventExtractionUserPrompt } from '../../../shared/extractors/extraction-prompt.js';
import {
  DEFAULT_MAX_CONTENT_LENGTH,
  FESTIVAL_ENTRY_MAX_TOKENS,
} from '../../../shared/extractors/extraction-limits.js';
import {
  parseFestivalEntry,
  applyYearCorrection,
  normalizeRadarDates,
  type FestivalEntryDraft,
} from '../radar/festival-entry.js';

export interface FestivalEntryExtractorConfig {
  llm: LLMProvider;
  referenceDate?: string; // YYYY-MM-DD, defaults to today
}

/** One LLM call per page → at most one draft. JSON-LD is deliberately not used:
 *  it describes individual events, not the festival as a whole. */
export class FestivalEntryExtractor {
  constructor(private config: FestivalEntryExtractorConfig) {}

  async extract(page: FetchedPage): Promise<FestivalEntryDraft | null> {
    const todayISO =
      this.config.referenceDate || new Date().toISOString().split('T')[0];
    console.log(`Extracting festival entry from: ${page.title} (${page.url})`);

    const content = (page.text || '')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .join('\n')
      .slice(0, DEFAULT_MAX_CONTENT_LENGTH);

    const response = await this.config.llm.complete(
      [
        { role: 'system', content: getFestivalEntryPrompt() },
        {
          role: 'user',
          content: getEventExtractionUserPrompt(page, todayISO, content),
        },
      ],
      {
        temperature: 0.1,
        maxTokens: FESTIVAL_ENTRY_MAX_TOKENS,
        responseFormat: 'json',
      }
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.content);
    } catch {
      throw new Error(
        `LLM returned malformed JSON for festival entry (${page.url})`
      );
    }

    const draft = parseFestivalEntry(parsed, page.url);
    if (!draft) return null;
    return normalizeRadarDates(applyYearCorrection(draft));
  }
}
