import { JSDOM } from 'jsdom';
import type { FetchedPage } from './html-fetcher.js';

/**
 * JinaFetcher uses Jina AI Reader API to fetch and clean web pages
 * - No browser overhead (faster than Playwright)
 * - Clean markdown output for LLM extraction
 * - Falls back to raw HTML fetch for link discovery
 *
 * Jina AI Reader: https://jina.ai/reader
 * Free tier: 1M tokens/month
 */
export class JinaFetcher {
  private baseUrl = 'https://r.jina.ai';
  private timeout = 30000; // 30 seconds
  private apiKey: string | undefined;

  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  async initialize() {
    // No initialization needed for Jina (stateless HTTP)
    console.log('Using Jina AI Reader fetcher');
  }

  async close() {
    // No cleanup needed
  }

  async fetchPage(url: string): Promise<FetchedPage> {
    console.log(`Fetching ${url} via Jina AI Reader...`);

    try {
      // Fetch clean markdown from Jina AI Reader
      const jinaUrl = `${this.baseUrl}/${encodeURIComponent(url)}`;

      const headers: Record<string, string> = {
        Accept: 'text/plain',
        'X-Timeout': String(this.timeout / 1000), // Jina expects seconds
        'X-Return-Format': 'markdown', // Explicitly request markdown
        'X-With-Links-Summary': 'false', // Disable links summary to get cleaner content
        'X-With-Images-Summary': 'false', // Disable images summary
      };

      // Add API key if available (improves rate limits)
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      console.log(`Jina request headers:`, headers);

      const jinaResponse = await fetch(jinaUrl, {
        headers,
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!jinaResponse.ok) {
        throw new Error(
          `Jina AI Reader failed: ${jinaResponse.status} ${jinaResponse.statusText}`
        );
      }

      const markdown = await jinaResponse.text();

      console.log(`Jina response length: ${markdown.length} chars`);
      console.log(`Jina response preview:`, markdown.slice(0, 500));

      // Extract title from markdown (usually first # heading)
      const titleMatch = markdown.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

      // Also fetch raw HTML for link discovery
      // (needed by PageDiscovery to extract <a> tags)
      let html = '';
      try {
        const htmlResponse = await fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          signal: AbortSignal.timeout(this.timeout),
        });

        if (htmlResponse.ok) {
          html = await htmlResponse.text();
        } else {
          console.warn(
            `Failed to fetch HTML for ${url}, link discovery may be limited`
          );
          // Create minimal HTML wrapper so JSDOM doesn't fail
          html = `<html><head><title>${title}</title></head><body></body></html>`;
        }
      } catch (error) {
        console.warn(`HTML fetch error for ${url}:`, error);
        html = `<html><head><title>${title}</title></head><body></body></html>`;
      }

      return {
        url,
        html,
        text: markdown,
        title,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to fetch ${url} via Jina AI: ${error.message}`);
      }
      throw error;
    }
  }

  async fetchMultiple(urls: string[]): Promise<FetchedPage[]> {
    const results: FetchedPage[] = [];

    for (const url of urls) {
      try {
        const page = await this.fetchPage(url);
        results.push(page);
      } catch (error) {
        console.error(`Failed to fetch ${url}:`, error);
      }
    }

    return results;
  }
}
