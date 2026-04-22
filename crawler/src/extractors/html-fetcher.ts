import { chromium, Browser, Page } from 'playwright';
import { extractCleanText } from '../../../shared/extractors/html-cleaner.js';
import { FetchedPage } from '../types/event.js';

// Re-export FetchedPage for convenience
export type { FetchedPage };

export class HTMLFetcher {
  private browser: Browser | null = null;

  async initialize() {
    this.browser = await chromium.launch({
      headless: true,
    });
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async fetchPage(url: string): Promise<FetchedPage> {
    if (!this.browser) {
      await this.initialize();
    }

    const page = await this.browser!.newPage();

    try {
      console.log(`Fetching ${url}...`);

      // Navigate and wait for page to load
      // Use 'load' instead of 'networkidle' for sites with continuous background requests
      await page.goto(url, {
        waitUntil: 'load',
        timeout: 30000,
      });

      // Wait a bit for any dynamic content to render
      await page.waitForTimeout(2000);

      // Get the full HTML from the main frame
      const html = await page.content();

      // Also collect rendered HTML from cross-origin iframes (e.g. Laylo, Bandsintown widgets)
      // Use a per-frame timeout so a stuck iframe (never resolves or rejects) can't hang the crawl.
      const frameHtmls = await Promise.all(
        page
          .frames()
          .filter(f => f !== page.mainFrame())
          .map(f =>
            Promise.race([
              f.content().catch(() => ''),
              new Promise<string>(resolve =>
                setTimeout(() => resolve(''), 5000)
              ),
            ])
          )
      );
      const combinedHtml =
        frameHtmls.length > 0
          ? html + '\n' + frameHtmls.filter(Boolean).join('\n')
          : html;

      const { title, text } = extractCleanText(combinedHtml);
      return {
        url,
        html: combinedHtml,
        text,
        title,
      };
    } finally {
      await page.close();
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

  /**
   * Process already-fetched HTML using DOM-based text cleaning
   * Useful for testing with saved HTML fixtures
   */
  static processHtml(
    html: string,
    url: string
  ): Pick<FetchedPage, 'text' | 'title'> {
    const { title, text } = extractCleanText(html);

    return { text, title };
  }
}
