import { z } from 'zod';
import type { LLMProvider } from '../../../shared/types/llm.js';
import type { FetchedPage } from '../types/event.js';
import { getScoutPrompt } from '../../../shared/extractors/scout-prompt.js';
import {
  FESTIVAL_MAX_CONTENT_LENGTH,
  SCOUT_MAX_TOKENS,
} from '../../../shared/extractors/extraction-limits.js';
import { urlKey, candidateKeys, type RawCandidate } from './candidates.js';
import type { PageLink } from './links.js';

const MAX_CANDIDATES = 40;

// Only `name` is mandatory; wrong-typed optional fields are treated as absent.
const optStr = z.string().optional().catch(undefined);
const ItemSchema = z.object({
  name: z.string().min(1),
  url: optStr,
  dates_hint: optStr,
  location_hint: optStr,
  why: optStr,
});

/** Parse an LLM reply as JSON, tolerating a code fence or surrounding prose. */
function parseReply(raw: string): unknown {
  const trimmed = raw
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to substring extraction
  }
  const starts = [trimmed.indexOf('{'), trimmed.indexOf('[')].filter(
    i => i >= 0
  );
  if (starts.length > 0) {
    const start = Math.min(...starts);
    const close = trimmed[start] === '{' ? '}' : ']';
    const end = trimmed.lastIndexOf(close);
    if (end > start) return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error('no JSON found');
}

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
      parsed = parseReply(response.content);
    } catch {
      throw new Error(`LLM returned malformed JSON for source ${page.url}`);
    }

    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? (parsed as { candidates?: unknown }).candidates
        : undefined;
    if (!Array.isArray(list)) {
      console.warn(`Scout reply for ${page.url} had no "candidates" list`);
      return [];
    }

    // A URL is only trusted if the page itself shows it: as a link or in the text.
    const allowed = new Set(
      links.map(l => urlKey(l.url)).filter((k): k is string => k !== undefined)
    );
    const textUrls = page.text.match(/https?:\/\/[^\s)\]>"']+/gi) ?? [];
    for (const u of textUrls) {
      const k = urlKey(u.replace(/[.,;:!?]+$/, ''));
      if (k !== undefined) allowed.add(k);
    }

    // The page itself and the bare root of its host are never festival urls.
    const pageKey = urlKey(page.url);
    const pageHost = pageKey?.split('/')[0];
    const isSelfOrRoot = (k: string) => k === pageKey || k === pageHost;

    const seen = new Set<string>();
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
        const trimmedUrl = d.url.trim();
        const key = /\s/.test(trimmedUrl) ? undefined : urlKey(trimmedUrl);
        if (key !== undefined && allowed.has(key) && !isSelfOrRoot(key)) {
          url = trimmedUrl;
        } else
          console.log(
            `  ⚠ Dropped url not found on the page for "${name}": ${d.url}`
          );
      }

      const keys = candidateKeys({ name, url });
      if (keys.some(k => seen.has(k))) continue;
      keys.forEach(k => seen.add(k));

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
