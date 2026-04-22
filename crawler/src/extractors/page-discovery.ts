// Discover individual event page URLs from a venue homepage using LLM

import { LLMProvider } from '../../../shared/types/llm.js';
import { z } from 'zod';
import { JSDOM, VirtualConsole } from 'jsdom';
import {
  PAGE_DISCOVERY_MAX_TOKENS,
  FESTIVAL_LISTING_MAX_TOKENS,
} from '../../../shared/extractors/extraction-limits.js';

const silentConsole = new VirtualConsole();

const EventLinksSchema = z.object({
  eventUrls: z
    .array(z.string())
    .describe(
      'Array of URLs (can be relative or absolute) to individual event pages'
    ),
});

type EventLinks = z.infer<typeof EventLinksSchema>;

const DISCOVERY_PROMPT = `You are an expert at analyzing venue websites and identifying links to individual event pages.

Given a list of links from a venue website, identify which ones point to INDIVIDUAL event pages.

Rules:
- Only select links to INDIVIDUAL event pages (e.g., /eventi/concert-name/, /events/artist-name-2025-03-15)
- INCLUDE links that have event-specific patterns like artist names, dates, or event IDs
- Do NOT include links to:
  - Event listing/calendar pages (e.g., /events, /calendar, /agenda)
  - Category/genre pages (e.g., /concerts, /music)
  - Navigation/footer links (e.g., /about, /contact, /tickets)
  - External social media links
  - Archive pages
- Return the URLs exactly as provided (they may be relative paths)
- If no individual event pages are found, return an empty array

Return ONLY a valid JSON object with this structure:
{
  "eventUrls": ["/eventi/artist-name/", "/events/show-123"]
}`;

const FESTIVAL_LISTING_PROMPT = `You are an expert at analyzing festival websites and identifying links to program or schedule listing pages.

Given a list of links from a festival homepage, identify which ones point to PROGRAM or SCHEDULE LISTING pages that contain multiple events/performances.

Rules:
- Select links to pages that LIST multiple events, performances, or acts (e.g., /program, /program/music, /lineup, /schedule, /timetable, /day-1)
- INCLUDE links with patterns like: /program/, /lineup/, /schedule/, /timetable/, /artists/, /acts/, /performances/
- Do NOT include links to:
  - Individual artist or performer pages
  - Ticket purchase pages
  - About, contact, or info pages
  - External social media links
  - News or blog pages
- If the homepage itself appears to be a program listing page, return an empty array (the seed page will be processed directly)
- Return the URLs exactly as provided (they may be relative paths)

Return ONLY a valid JSON object with this structure:
{
  "listingUrls": ["/program/music", "/program/day-1"]
}`;

const FestivalListingsSchema = z.object({
  listingUrls: z.array(z.string()),
});

export class PageDiscovery {
  constructor(private llm: LLMProvider) {}

  async discoverEventUrls(html: string, baseUrl: string): Promise<string[]> {
    try {
      console.log(`Discovering event URLs from ${baseUrl}...`);

      // Step 1: Extract all links from the HTML
      const dom = new JSDOM(html, {
        url: baseUrl,
        virtualConsole: silentConsole,
      });
      const links = Array.from(dom.window.document.querySelectorAll('a[href]'));

      // Get unique hrefs and filter out obvious non-event links
      const hrefs = Array.from(
        new Set(
          links
            .map((a: Element) => a.getAttribute('href'))
            .filter(href => {
              if (!href) return false;
              // Filter out anchors, mailto, tel, javascript, etc.
              if (
                href.startsWith('#') ||
                href.startsWith('mailto:') ||
                href.startsWith('tel:') ||
                href.startsWith('javascript:')
              ) {
                return false;
              }
              // Filter out common social media domains
              if (
                href.includes('facebook.com') ||
                href.includes('instagram.com') ||
                href.includes('twitter.com') ||
                href.includes('youtube.com')
              ) {
                return false;
              }
              return true;
            })
        )
      );

      console.log(
        `Extracted ${hrefs.length} candidate links, asking LLM to filter...`
      );

      if (hrefs.length === 0) {
        console.log('No links found on page');
        return [];
      }

      // Step 2: Ask LLM to identify which are individual event pages
      const response = await this.llm.complete(
        [
          { role: 'system', content: DISCOVERY_PROMPT },
          {
            role: 'user',
            content: `Base URL: ${baseUrl}\n\nLinks found on page:\n${hrefs.slice(0, 200).join('\n')}`, // Limit to first 200 links
          },
        ],
        {
          temperature: 0.1,
          maxTokens: PAGE_DISCOVERY_MAX_TOKENS,
          responseFormat: 'json',
        }
      );

      const parsed = JSON.parse(response.content);
      const validated = EventLinksSchema.parse(parsed);

      // Step 3: Convert relative URLs to absolute
      const absoluteUrls = validated.eventUrls
        .map(url => {
          try {
            return new URL(url, baseUrl).href;
          } catch {
            return null;
          }
        })
        .filter((url): url is string => url !== null);

      console.log(`Found ${absoluteUrls.length} event URLs`);
      if (absoluteUrls.length > 0) {
        console.log('Event URLs:', absoluteUrls.slice(0, 10).join('\n  '));
        if (absoluteUrls.length > 10) {
          console.log(`  ... and ${absoluteUrls.length - 10} more`);
        }
      }

      return absoluteUrls;
    } catch (error) {
      console.error('Error discovering event URLs:', error);
      return [];
    }
  }

  async discoverFestivalListingPages(
    html: string,
    baseUrl: string
  ): Promise<string[]> {
    try {
      console.log(`Discovering festival listing pages from ${baseUrl}...`);

      const dom = new JSDOM(html, {
        url: baseUrl,
        virtualConsole: silentConsole,
      });
      const links = Array.from(dom.window.document.querySelectorAll('a[href]'));

      const hrefs = Array.from(
        new Set(
          links
            .map((a: Element) => a.getAttribute('href'))
            .filter(href => {
              if (!href) return false;
              if (
                href.startsWith('#') ||
                href.startsWith('mailto:') ||
                href.startsWith('tel:') ||
                href.startsWith('javascript:')
              )
                return false;
              if (
                href.includes('facebook.com') ||
                href.includes('instagram.com') ||
                href.includes('twitter.com') ||
                href.includes('youtube.com')
              )
                return false;
              return true;
            })
        )
      );

      console.log(
        `Extracted ${hrefs.length} candidate links, asking LLM to filter for listing pages...`
      );

      if (hrefs.length === 0) return [];

      const response = await this.llm.complete(
        [
          { role: 'system', content: FESTIVAL_LISTING_PROMPT },
          {
            role: 'user',
            content: `Base URL: ${baseUrl}\n\nLinks found on page:\n${hrefs.slice(0, 200).join('\n')}`,
          },
        ],
        {
          temperature: 0.1,
          maxTokens: FESTIVAL_LISTING_MAX_TOKENS,
          responseFormat: 'json',
        }
      );

      const parsed = JSON.parse(response.content);
      const validated = FestivalListingsSchema.parse(parsed);

      const seen = new Set<string>();
      const absoluteUrls = validated.listingUrls
        .map(url => {
          try {
            return new URL(url, baseUrl).href;
          } catch {
            return null;
          }
        })
        .filter((url): url is string => {
          if (url === null) return false;
          const normalized = url.replace(/\/$/, '');
          if (seen.has(normalized)) return false;
          seen.add(normalized);
          return true;
        });

      console.log(`Found ${absoluteUrls.length} festival listing page(s)`);
      return absoluteUrls;
    } catch (error) {
      console.error('Error discovering festival listing pages:', error);
      return [];
    }
  }
}
