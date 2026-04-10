// Discover individual event page URLs from a venue homepage using LLM

import { LLMProvider } from '../../shared/types/llm';
import { z } from 'zod';
import { PAGE_DISCOVERY_MAX_TOKENS } from '../../shared/extractors/extraction-limits';

const EventLinksSchema = z.object({
  eventUrls: z.array(z.string()).describe('Array of URLs (can be relative or absolute) to individual event pages'),
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

export class PageDiscovery {
  constructor(private llm: LLMProvider) {}

  async discoverEventUrls(html: string, baseUrl: string): Promise<string[]> {
    try {
      console.log(`Discovering event URLs from ${baseUrl}...`);

      // Step 1: Extract all links from the HTML using regex
      const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
      const matches = html.matchAll(linkRegex);
      const allHrefs = Array.from(matches).map(match => match[1]);

      // Get unique hrefs and filter out obvious non-event links
      const hrefs = Array.from(new Set(
        allHrefs.filter(href => {
          if (!href) return false;
          // Filter out anchors, mailto, tel, javascript, etc.
          if (href.startsWith('#') || href.startsWith('mailto:') ||
              href.startsWith('tel:') || href.startsWith('javascript:')) {
            return false;
          }
          // Filter out common social media domains
          if (href.includes('facebook.com') || href.includes('instagram.com') ||
              href.includes('twitter.com') || href.includes('youtube.com')) {
            return false;
          }
          return true;
        })
      ));

      console.log(`Extracted ${hrefs.length} candidate links, asking LLM to filter...`);

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
            content: `Base URL: ${baseUrl}\n\nLinks found on page:\n${hrefs.slice(0, 200).join('\n')}` // Limit to first 200 links
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
      const absoluteUrls = validated.eventUrls.map(url => {
        try {
          return new URL(url, baseUrl).href;
        } catch {
          return null;
        }
      }).filter((url): url is string => url !== null);

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
}
