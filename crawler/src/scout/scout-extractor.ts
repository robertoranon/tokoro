import { z } from 'zod';
import type { LLMProvider } from '../../../shared/types/llm.js';
import type { FetchedPage } from '../types/event.js';
import { getScoutPrompt } from '../../../shared/extractors/scout-prompt.js';
import {
  FESTIVAL_MAX_CONTENT_LENGTH,
  SCOUT_MAX_TOKENS,
} from '../../../shared/extractors/extraction-limits.js';
import { urlKey, type RawCandidate } from './candidates.js';
import type { PageLink } from './links.js';

const MAX_CANDIDATES = 40;

const ItemSchema = z.object({
  name: z.string().min(1),
  url: z.string().optional(),
  dates_hint: z.string().optional(),
  location_hint: z.string().optional(),
  why: z.string().optional(),
});

export interface ScoutExtractorConfig {
  llm: LLMProvider;
  referenceDate?: string; // YYYY-MM-DD, defaults to today
}

export class ScoutExtractor {
  constructor(private config: ScoutExtractorConfig) {}

  async extract(
    page: FetchedPage,
    links: PageLink[],
    ctx: { taste: string; sourceName: string }
  ): Promise<RawCandidate[]> {
    const content = (page.text || '')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .join('\n')
      .slice(0, FESTIVAL_MAX_CONTENT_LENGTH);
    if (!content.trim() && links.length === 0) return [];

    const today =
      this.config.referenceDate || new Date().toISOString().split('T')[0];
    console.log(`Scouting: ${ctx.sourceName} (${page.url})`);

    const response = await this.config.llm.complete(
      [
        { role: 'system', content: getScoutPrompt(ctx.taste) },
        {
          role: 'user',
          content:
            `Source: ${ctx.sourceName}\nPage URL: ${page.url}\nToday's date: ${today}\n\n` +
            `Page content:\n${content}\n\n` +
            `Links found on the page (text | url):\n` +
            links.map(l => `${l.text} | ${l.url}`).join('\n'),
        },
      ],
      { temperature: 0.1, maxTokens: SCOUT_MAX_TOKENS, responseFormat: 'json' }
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.content);
    } catch {
      throw new Error(`LLM returned malformed JSON for source ${page.url}`);
    }

    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? (parsed as { candidates?: unknown }).candidates
        : undefined;
    if (!Array.isArray(list)) return [];

    // A URL is only trusted if the page itself shows it: as a link or in the text.
    const allowed = new Set(
      links.map(l => urlKey(l.url)).filter((k): k is string => k !== undefined)
    );
    const textUrls = page.text.match(/https?:\/\/[^\s)\]>"']+/g) ?? [];
    for (const u of textUrls) {
      const k = urlKey(u);
      if (k !== undefined) allowed.add(k);
    }

    const out: RawCandidate[] = [];
    for (const item of list) {
      if (out.length >= MAX_CANDIDATES) break;
      if (!item || typeof item !== 'object') continue;
      const cleaned = Object.fromEntries(
        Object.entries(item as Record<string, unknown>).filter(
          ([, v]) => v !== null && v !== ''
        )
      );
      const result = ItemSchema.safeParse(cleaned);
      if (!result.success) continue;
      const d = result.data;

      const name = d.name.trim().slice(0, 120);
      if (!name) continue;

      let url: string | undefined;
      if (d.url) {
        const key = urlKey(d.url.trim());
        if (key !== undefined && allowed.has(key)) url = d.url.trim();
        else
          console.log(
            `  ⚠ Dropped url not found on the page for "${name}": ${d.url}`
          );
      }

      out.push({
        name,
        ...(url ? { url } : {}),
        why: (d.why ?? '').trim().slice(0, 300),
        ...(d.dates_hint?.trim()
          ? { dates_hint: d.dates_hint.trim().slice(0, 80) }
          : {}),
        ...(d.location_hint?.trim()
          ? { location_hint: d.location_hint.trim().slice(0, 80) }
          : {}),
      });
    }
    return out;
  }
}
