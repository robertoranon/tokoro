// Diagnostic (live network): does a site accept the crawler's headless-browser
// fetcher, or does it serve a bot-block page? Not part of any test suite.
//
// Run from crawler/:
//   npm run probe:fetch -- https://example.com/a https://example.com/b
//   npm run probe:fetch                      # defaults to a Bandsintown artist page
//
// Exit code 1 if any URL looked blocked or failed to load.
import { HTMLFetcher } from '../src/extractors/html-fetcher.js';
import { looksBlocked } from '../src/utils/block-page.js';

const DEFAULT_URLS = ['https://www.bandsintown.com/a/754-the-fratellis'];

const DATE_LIKE =
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}\b|\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/gi;

async function main() {
  const urls = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const targets = urls.length > 0 ? urls : DEFAULT_URLS;
  const fetcher = new HTMLFetcher('chrome');
  let bad = 0;
  await fetcher.initialize();
  try {
    for (const url of targets) {
      const started = Date.now();
      try {
        const page = await fetcher.fetchPage(url);
        const blocked = looksBlocked(page.title, page.text);
        const dates = (page.text.match(DATE_LIKE) ?? []).length;
        console.log(
          `${blocked ? 'BLOCKED' : 'OK     '} ${url}\n` +
            `         title="${page.title}" text=${page.text.length} chars, ` +
            `date-like mentions=${dates}, ${Date.now() - started} ms`
        );
        if (blocked) {
          bad++;
          console.log(
            `         ${page.text.slice(0, 160).replace(/\s+/g, ' ')}`
          );
        }
      } catch (error) {
        bad++;
        console.log(
          `ERROR   ${url}\n         ${error instanceof Error ? error.message : error}`
        );
      }
    }
  } finally {
    await fetcher.close();
  }
  if (bad > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
