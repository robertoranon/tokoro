// HTMLFetcher retries a bot-protection page once with a standard (non-headless)
// user-agent. Runs the real fetcher with real headless Chromium against a local
// server that blocks like Cloudflare does; no internet needed.
// Run from crawler/: npm run test:fetcher
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HTMLFetcher } from '../src/extractors/html-fetcher.js';
import { looksBlocked } from '../src/utils/block-page.js';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

const BLOCK_PAGE = `<!doctype html><html><head><title>Attention Required! | Cloudflare</title></head>
<body><h1>Sorry, you have been blocked</h1><p>You are unable to access this site.</p></body></html>`;

const TOUR_PAGE = `<!doctype html><html><head><title>Test Band - Live Tour Dates</title></head>
<body><h1>Tour dates</h1><ul><li>12 Nov 2030 Udine Club X</li><li>20 Nov 2030 Ljubljana Kino</li></ul></body></html>`;

// A long, legitimate page that happens to quote block phrases.
const LONG_PAGE = `<!doctype html><html><head><title>Access denied news</title></head><body>${'<p>Tour dates and news about the band.</p>'.repeat(200)}<p>Sorry, you have been blocked from commenting.</p></body></html>`;

const requests: Record<string, string[]> = {};

const server = http.createServer((req, res) => {
  const path = req.url ?? '/';
  const ua = String(req.headers['user-agent'] ?? '');
  (requests[path] ??= []).push(ua);
  const headless = ua.includes('HeadlessChrome');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (path === '/ua-gated') {
    res.statusCode = headless ? 403 : 200;
    res.end(headless ? BLOCK_PAGE : TOUR_PAGE);
  } else if (path === '/always-blocked') {
    res.statusCode = 403;
    res.end(BLOCK_PAGE);
  } else if (path === '/long') {
    res.end(LONG_PAGE);
  } else {
    res.end(TOUR_PAGE);
  }
});

async function main() {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetcher = new HTMLFetcher('chrome');
  await fetcher.initialize();
  try {
    console.log('\n=== a normal page is fetched once ===\n');
    {
      const p = await fetcher.fetchPage(`${base}/normal`);
      assert(p.text.includes('Udine'), 'content returned');
      assert(requests['/normal'].length === 1, 'exactly one request, no retry');
    }

    console.log(
      '\n=== a block keyed on the headless user-agent is retried ===\n'
    );
    {
      const p = await fetcher.fetchPage(`${base}/ua-gated`);
      const ua = requests['/ua-gated'];
      assert(ua.length === 2, 'two requests: the block, then the retry');
      assert(
        ua[0].includes('HeadlessChrome'),
        'first request carries the headless marker'
      );
      assert(
        !ua[1].includes('HeadlessChrome') && ua[1].includes('Chrome/'),
        'retry sends a standard Chrome user-agent'
      );
      assert(!looksBlocked(p.title, p.text), 'the retry result is returned');
      assert(p.text.includes('Ljubljana'), 'with the real content');
    }

    console.log(
      '\n=== a page that stays blocked is retried once, then returned as is ===\n'
    );
    {
      const p = await fetcher.fetchPage(`${base}/always-blocked`);
      assert(requests['/always-blocked'].length === 2, 'one retry, not a loop');
      assert(
        looksBlocked(p.title, p.text),
        'still recognisable as blocked, for the caller to handle'
      );
    }

    console.log('\n=== a long page quoting block phrases is content ===\n');
    {
      const p = await fetcher.fetchPage(`${base}/long`);
      assert(requests['/long'].length === 1, 'not retried');
      assert(p.text.includes('Tour dates and news'), 'content returned');
    }
  } finally {
    await fetcher.close();
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
