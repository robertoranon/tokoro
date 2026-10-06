import { chromium, Browser, BrowserContext } from 'playwright';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { createConnection } from 'net';
import { extractCleanText } from '../../../shared/extractors/html-cleaner.js';
import { FetchedPage } from '../types/event.js';
import { looksBlocked } from '../utils/block-page.js';

export type { FetchedPage };
export type BrowserEngine = 'obscura' | 'chrome';

export class HTMLFetcher {
  private browser: Browser | null = null;
  private obscuraProcess: ChildProcess | null = null;
  private engine: BrowserEngine;
  private wsEndpoint: string;
  private autoLaunch: boolean;
  /** undefined = not looked up yet; null = nothing to substitute. */
  private standardUa: string | null | undefined;

  constructor(engine: BrowserEngine = 'chrome') {
    this.engine = engine;
    this.wsEndpoint = process.env.OBSCURA_WS_ENDPOINT || 'ws://127.0.0.1:9222';
    this.autoLaunch = engine === 'obscura' && !process.env.OBSCURA_WS_ENDPOINT;
  }

  async initialize() {
    if (this.engine === 'obscura') {
      if (this.autoLaunch) {
        this.startObscuraProcess();
        await this.waitForPort();
      }
      this.browser = await chromium.connectOverCDP({
        endpointURL: this.wsEndpoint,
      });
    } else {
      this.browser = await chromium.launch({ headless: true });
    }
  }

  private startObscuraProcess() {
    const portStr = (() => {
      try {
        return new URL(this.wsEndpoint).port || '9222';
      } catch {
        return '9222';
      }
    })();

    const which = spawnSync(
      process.platform === 'win32' ? 'where' : 'which',
      ['obscura'],
      { encoding: 'utf8' }
    );
    if (which.status !== 0) {
      throw new Error(
        'Obscura binary not found in PATH.\n' +
          'Download from: https://github.com/h4ckf0r0day/obscura/releases\n' +
          'Or set OBSCURA_WS_ENDPOINT=ws://host:port to connect to a running instance.\n' +
          'Or pass --browser chrome to use headless Chrome instead.'
      );
    }

    this.obscuraProcess = spawn('obscura', ['serve', '--port', portStr], {
      stdio: 'ignore',
    });
  }

  private async waitForPort(timeoutMs = 10000) {
    const url = (() => {
      try {
        return new URL(this.wsEndpoint);
      } catch {
        return null;
      }
    })();
    const port = url ? parseInt(url.port || '9222', 10) : 9222;
    const host = url?.hostname || '127.0.0.1';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await new Promise<boolean>(resolve => {
        const sock = createConnection(port, host);
        sock.on('connect', () => {
          sock.destroy();
          resolve(true);
        });
        sock.on('error', () => resolve(false));
      });
      if (ready) return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(
      `Obscura did not start on ${host}:${port} within ${timeoutMs}ms`
    );
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    if (this.obscuraProcess) {
      this.obscuraProcess.kill();
      this.obscuraProcess = null;
    }
  }

  /**
   * The browser's own user-agent with the "HeadlessChrome" marker removed
   * (same platform and version), or null when it carries no such marker.
   * Bot protection such as Cloudflare rejects the marker, not the browser.
   */
  private async standardUserAgent(): Promise<string | null> {
    if (this.standardUa !== undefined) return this.standardUa;
    let ua: string | null = null;
    try {
      const context = await this.browser!.newContext();
      try {
        const page = await context.newPage();
        const raw = await page.evaluate(() => navigator.userAgent);
        ua = raw.includes('HeadlessChrome')
          ? raw.replace('HeadlessChrome', 'Chrome')
          : null;
      } finally {
        await context.close();
      }
    } catch {
      ua = null;
    }
    this.standardUa = ua;
    return ua;
  }

  /**
   * Fetch a page. If the result looks like a bot-protection block page, retry
   * once with a standard (non-headless) user-agent; pages that load normally
   * are fetched exactly once.
   */
  async fetchPage(url: string): Promise<FetchedPage> {
    const first = await this.fetchOnce(url);
    if (!looksBlocked(first.title, first.text)) return first;

    const ua = await this.standardUserAgent();
    if (!ua) return first;
    console.log(
      `↻ ${url} looks like a bot-protection page — retrying with a standard browser user-agent`
    );
    const second = await this.fetchOnce(url, ua);
    if (looksBlocked(second.title, second.text)) {
      console.log('  Still blocked after the retry');
      return first;
    }
    console.log('  Retry succeeded');
    return second;
  }

  private async fetchOnce(
    url: string,
    userAgent?: string
  ): Promise<FetchedPage> {
    if (!this.browser) {
      await this.initialize();
    }

    // CDP connections require an explicit context; launched browsers have a
    // default one. A custom user-agent also needs its own context.
    let context: BrowserContext | null = null;
    if (this.engine === 'obscura' || userAgent) {
      context = await this.browser!.newContext(userAgent ? { userAgent } : {});
    }
    const page = context
      ? await context.newPage()
      : await this.browser!.newPage();

    try {
      console.log(`Fetching ${url}...`);

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
      // Use a per-frame timeout so a stuck iframe can't hang the crawl.
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
      if (context) await context.close();
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
