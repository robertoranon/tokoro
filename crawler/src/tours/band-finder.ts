import type { LLMProvider } from '../../../shared/types/llm.js';
import type { FetchedPage } from '../types/event.js';
import { extractLinks } from '../scout/links.js';
import { normalizeActUrl } from './bands-config.js';
import { DEFAULT_MAX_CONTENT_LENGTH } from '../../../shared/extractors/extraction-limits.js';
import { looksLikeShowListing, saysNoEvents } from './page-signals.js';
import type { BandInput } from './band-list.js';
import type { SearchFn, SearchResult } from '../utils/brave-search.js';

export type { SearchResult };

export interface FinderDeps {
  llm: LLMProvider;
  /** Absent when no search key is configured. */
  search?: SearchFn;
  fetchPage: (url: string) => Promise<FetchedPage>;
}

export type FindOutcome =
  | {
      status: 'found';
      name: string;
      siteUrl: string;
      tourUrl: string;
      note: string;
    }
  | { status: 'no_tour_page'; name: string; siteUrl: string; note: string }
  | { status: 'no_site'; name: string }
  | { status: 'not_searched'; name: string }
  | { status: 'error'; name: string; error: string };

// Never a band's own site (the LLM is told, and this is enforced afterwards).
const DENIED_DOMAINS = [
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'vimeo.com',
  'linktr.ee',
  'spotify.com',
  'bandcamp.com',
  'soundcloud.com',
  'deezer.com',
  'tidal.com',
  'apple.com',
  'itunes.com',
  'amazon.com',
  'beatport.com',
  'wikipedia.org',
  'wikidata.org',
  'discogs.com',
  'musicbrainz.org',
  'rateyourmusic.com',
  'allmusic.com',
  'last.fm',
  'genius.com',
  'setlist.fm',
  'songkick.com',
  'bandsintown.com',
  'ticketmaster.com',
  'ticketmaster.it',
  'ticketmaster.de',
  'ticketmaster.co.uk',
  'ticketone.it',
  'eventbrite.com',
  'dice.fm',
  'ra.co',
  'viagogo.com',
  'stubhub.com',
];

/** True for social/streaming/ticketing/encyclopedia hosts and unparseable urls. */
export function isDeniedHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  return DENIED_DOMAINS.some(d => host === d || host.endsWith(`.${d}`));
}

const SITE_PROMPT = `You identify a music band's official website from web search results.

Given the band name and a numbered list of search results (title, url, snippet), return the url of the band's OWN official website: its own domain, with news, music or tour information.

Rules:
- Return a url EXACTLY as it appears in the list, never invent or edit one.
- Reject social networks, streaming services, Bandcamp, Wikipedia and other encyclopedias, ticket sellers, concert aggregators and fan pages.
- If no result is clearly the band's own official website, return null. A wrong answer is worse than none.

Return ONLY a JSON object: {"url": "<url from the list>" | null}`;

const TOUR_PROMPT = `You find the tour / live / concerts page of a music band's official website.

You get the band name, the homepage links (anchor text and url) and the start of the homepage text.

Return:
- "tour_url": the url, EXACTLY as listed, of the page that lists the band's upcoming concert dates (tour, live, concerts, dates, shows, gigs, events, agenda, calendar). null if none is linked.
- "homepage_lists_shows": true only if the homepage text itself already lists dated upcoming concerts.

Do not return news, shop, press, contact or music pages.

Return ONLY a JSON object: {"tour_url": "<url from the list>" | null, "homepage_lists_shows": true | false}`;

async function askJson(
  llm: LLMProvider,
  system: string,
  user: string
): Promise<Record<string, unknown>> {
  const res = await llm.complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0, maxTokens: 400, responseFormat: 'json' }
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.content);
  } catch {
    throw new Error('LLM returned malformed JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM returned an unexpected shape');
  }
  return parsed as Record<string, unknown>;
}

const sameUrl = (a: string, b: string) => {
  try {
    return normalizeActUrl(a) === normalizeActUrl(b);
  } catch {
    return a === b;
  }
};

async function pickSite(
  name: string,
  results: SearchResult[],
  llm: LLMProvider
): Promise<string | undefined> {
  if (results.length === 0) return undefined;
  const list = results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join('\n');
  const answer = (
    await askJson(llm, SITE_PROMPT, `Band: ${name}\n\nSearch results:\n${list}`)
  ).url;
  if (typeof answer !== 'string' || !answer) return undefined;
  // Only a url that was actually in the results, and never a denied host.
  const hit = results.find(r => r.url === answer || sameUrl(r.url, answer));
  if (!hit || isDeniedHost(hit.url)) return undefined;
  return normalizeActUrl(hit.url);
}

export async function findBand(
  input: BandInput,
  deps: FinderDeps
): Promise<FindOutcome> {
  const { name } = input;
  try {
    let siteUrl: string;
    let how: string;
    if (input.hint) {
      siteUrl = normalizeActUrl(input.hint);
      how = 'site given';
    } else {
      if (!deps.search) return { status: 'not_searched', name };
      const results = await deps.search(`"${name}" official site`);
      const site = await pickSite(name, results, deps.llm);
      if (!site) return { status: 'no_site', name };
      siteUrl = site;
      how = 'site from search';
    }

    const home = await deps.fetchPage(siteUrl);
    const links = extractLinks(home);
    // The scout runs once per band, so the LLM gets the whole page.
    const listing = links.map(l => `${l.text} → ${l.url}`).join('\n');
    const pageText = (home.text || '')
      .replace(/\s+/g, ' ')
      .slice(0, DEFAULT_MAX_CONTENT_LENGTH);
    const answer = await askJson(
      deps.llm,
      TOUR_PROMPT,
      `Band: ${name}\nHomepage: ${home.url}\n\nLinks:\n${listing}\n\nHomepage text:\n${pageText}`
    );

    const chosen =
      typeof answer.tour_url === 'string' && answer.tour_url
        ? links.find(
            l =>
              l.url === answer.tour_url ||
              sameUrl(l.url, answer.tour_url as string)
          )
        : undefined;

    // 1. A tour/live link on the band's own site. It is accepted even when
    //    the page cannot be loaded right now (blocked, JavaScript-only, slow):
    //    a link the site itself offers as its tour page is more likely right
    //    than not, and the tours crawler reports a source that stays empty.
    if (chosen) {
      let verified = false;
      try {
        const tour = await deps.fetchPage(chosen.url);
        verified = (tour.text || '').trim() !== '';
      } catch {
        verified = false;
      }
      return {
        status: 'found',
        name,
        siteUrl,
        tourUrl: chosen.url,
        note: verified
          ? `bands-scout: ${how}, tour page from site links`
          : `bands-scout: ${how}, tour page from site links (not verified: the page did not load during the scan)`,
      };
    }

    // 2. The homepage itself lists the shows (decided by the LLM, or by the
    //    page text: several dates plus tour wording, wherever they are).
    if (
      answer.homepage_lists_shows === true ||
      looksLikeShowListing(home.text || '')
    ) {
      return {
        status: 'found',
        name,
        siteUrl,
        tourUrl: siteUrl,
        note: `bands-scout: ${how}; the homepage lists the shows`,
      };
    }

    // 3. The homepage says there are no upcoming events: it is still where
    //    they will appear, so it is the page to check.
    if (saysNoEvents(home.text || '')) {
      return {
        status: 'found',
        name,
        siteUrl,
        tourUrl: siteUrl,
        note: `bands-scout: ${how}; the homepage says no events are scheduled right now`,
      };
    }

    return {
      status: 'no_tour_page',
      name,
      siteUrl,
      note: `bands-scout: ${how}; no tour page found — add a source by hand`,
    };
  } catch (error) {
    return {
      status: 'error',
      name,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
