// Offline smoke test for tours.html.
// Run from the repo root:  node public-web/tests/tours.smoke.mjs
// Needs Playwright's Chromium (installed with the crawler). Uses only 127.0.0.1.
// Optional: TOURS_SMOKE_MAP=1 also checks the Leaflet map (needs internet for the CDN).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = require('../tours.js');

let chromium;
try {
  ({ chromium } = require('../../crawler/node_modules/playwright'));
} catch (e) {
  console.log('SKIP: Playwright not found (run npm ci in crawler/)');
  process.exit(0);
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    if (detail !== undefined) console.log('      ', detail);
    failures++;
  }
}

// ── test data, relative to the machine's local "today" (same as the page's) ───
const p2 = n => String(n).padStart(2, '0');
const nowD = new Date();
const today = `${nowD.getFullYear()}-${p2(nowD.getMonth() + 1)}-${p2(nowD.getDate())}`;
const day = n => T.addDays(today, n);
const show = (id, band, off, place, lat, lng, over = {}) => ({
  id,
  title: band + ' live',
  act_name: band,
  act_url: `https://${band.toLowerCase()}.example`,
  url: `https://tickets.example/${id}`,
  description: '',
  venue_name: 'Club ' + id,
  address: place,
  lat,
  lng,
  start_time: day(off) + 'T21:00:00',
  end_time: null,
  category: 'music',
  tags: ['band-tour'],
  ...over,
});
const EVENTS = [
  show('a1', 'Alpha', 12, 'Udine', 46.06, 13.23),
  show('a2', 'Alpha', 20, 'Ljubljana', 46.05, 14.5),
  show('a3', 'Alpha', 30, 'Udine', 46.07, 13.24),
  show('b1', 'Beta', 40, 'Berlin', 52.52, 13.4),
  show('past', 'Alpha', -3, 'Udine', 46.06, 13.23), // past → hidden
  show('plain', 'Alpha', 15, 'Udine', 46.06, 13.23, {
    act_url: null,
    act_name: null,
    title: 'Plain concert',
  }), // not a tour show → hidden
];

// ── one local server: static page files + fake paged API ──────────────────────
const state = { requests: [], failApi: false };
let base = '';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
const PAGE_SIZE = 100;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/events') {
    state.requests.push(req.url);
    if (state.failApi) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    const offset = Number(url.searchParams.get('offset') || 0);
    const slice = EVENTS.slice(offset, offset + PAGE_SIZE);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        events: slice,
        offset,
        count: slice.length,
        has_more: offset + PAGE_SIZE < EVENTS.length,
      })
    );
    return;
  }
  const name = url.pathname.replace(/^\//, '');
  if (!['tours.html', 'shared.js', 'tours.js'].includes(name)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  try {
    let body = await fs.readFile(path.join(ROOT, name), 'utf8');
    body = body
      .replace(/__TOKORO_WORKER_URL__/g, base)
      .replace(/__BUILD_VERSION__/g, 'smoke');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('missing');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
base = `http://127.0.0.1:${server.address().port}`;

// ── helpers ───────────────────────────────────────────────────────────────────
async function newPage(browser, { allowExternal = false } = {}) {
  const context = await browser.newContext();
  if (!allowExternal) {
    await context.route(
      u =>
        !/^http:\/\/127\.0\.0\.1[:/]/.test(u.href) &&
        !u.href.startsWith('about:'),
      r => r.abort()
    );
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  return { page, context, errors };
}
const names = page =>
  page.$$eval('.band-card__name', els =>
    els.map(e => e.textContent.replace(/[▾▴]/g, '').trim())
  );
const status = page => page.textContent('#statusLine');
// Poll until the band names equal `expected` (the keyword input is debounced); returns the final names.
async function settleNames(page, expected) {
  try {
    await page.waitForFunction(
      exp =>
        JSON.stringify(
          [...document.querySelectorAll('.band-card__name')].map(e =>
            e.textContent.replace(/[▾▴]/g, '').trim()
          )
        ) === JSON.stringify(exp),
      expected,
      { timeout: 5000 }
    );
  } catch {}
  return names(page);
}
const isOpen = (page, band) =>
  page.locator('.band-card', { hasText: band }).evaluate(el => el.open);

let browser;
try {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    if (
      /Executable doesn't exist|browserType\.launch|playwright install/i.test(
        String(e)
      )
    ) {
      console.log('SKIP: no browser available for Playwright');
      server.close();
      process.exit(0);
    }
    throw e;
  }

  {
    const { page, context, errors } = await newPage(browser);
    await page.route('**/nominatim.openstreetmap.org/**', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify([
          { lat: '46.0637', lon: '13.2353', display_name: 'Udine' },
        ]),
      })
    );
    await page.goto(base + '/tours.html');
    await page.waitForSelector('.band-card');

    // 1. request shape
    const first = state.requests[0] || '';
    check(
      'first request has has_act=1 and no lat=, and goes to the fake API',
      first.includes('has_act=1') &&
        !first.includes('lat=') &&
        state.requests.length === 1,
      state.requests
    );

    // 2. loaded
    const st = await status(page);
    check(
      '2 band cards, status "2 of 2 bands" and "4 shows"',
      (await page.locator('.band-card').count()) === 2 &&
        st.includes('2 of 2 bands') &&
        st.includes('4 shows'),
      st
    );

    // 3. order
    check(
      'bands ordered by next show (Alpha, then Beta)',
      JSON.stringify(await names(page)) === JSON.stringify(['Alpha', 'Beta']),
      await names(page)
    );

    // 4. collapsed, expand
    check(
      'cards start collapsed',
      (await page.locator('.band-card[open]').count()) === 0
    );
    await page
      .locator('.band-card', { hasText: 'Alpha' })
      .locator('.band-card__summary')
      .click();
    const alphaShows = page
      .locator('.band-card', { hasText: 'Alpha' })
      .locator('.band-show');
    check(
      'opening Alpha shows 3 shows, each with date, place and "Show page" link',
      (await alphaShows.count()) === 3 &&
        (await alphaShows.locator('.band-show__date').count()) === 3 &&
        (await alphaShows.locator('.band-show__place').count()) === 3 &&
        (await alphaShows
          .locator('a.band-show__link', { hasText: 'Show page' })
          .count()) === 3
    );

    // 5. keyword
    await page.fill('#keywordFilter', 'beta');
    const betaOnly = await settleNames(page, ['Beta']);
    check(
      'keyword "beta" leaves 1 card and "1 of 2 bands"',
      JSON.stringify(betaOnly) === JSON.stringify(['Beta']) &&
        (await status(page)).includes('1 of 2 bands'),
      [betaOnly, await status(page)]
    );
    await page.fill('#keywordFilter', '');
    const both = await settleNames(page, ['Alpha', 'Beta']);
    check('clearing the keyword restores 2 cards', both.length === 2, both);

    // 6. date range
    await page.fill('#toDate', day(35));
    const early = await settleNames(page, ['Alpha']);
    check(
      '"to" date before Beta\'s show hides Beta',
      JSON.stringify(early) === JSON.stringify(['Alpha']),
      early
    );
    await page.fill('#toDate', '');
    await settleNames(page, ['Alpha', 'Beta']);

    // 7. open state survives a re-render
    await page.fill('#keywordFilter', 'alph');
    await settleNames(page, ['Alpha']);
    check(
      'Alpha is still open after a filter re-render',
      (await isOpen(page, 'Alpha')) === true
    );
    await page.fill('#keywordFilter', '');
    await settleNames(page, ['Alpha', 'Beta']);

    // 8. place filter
    await page.selectOption('#radiusFilter', '25');
    await page.fill('#placeInput', 'Udine');
    await page.press('#placeInput', 'Enter');
    const near = await settleNames(page, ['Alpha']);
    const udineShows = page
      .locator('.band-card', { hasText: 'Alpha' })
      .locator('.band-show');
    const placeTexts = await udineShows
      .locator('.band-show__place')
      .allTextContents();
    check(
      'place filter: only Alpha, only its two Udine shows, with "km away"',
      JSON.stringify(near) === JSON.stringify(['Alpha']) &&
        (await udineShows.count()) === 2 &&
        placeTexts.every(t => t.includes('Udine') && t.includes('km away')),
      [near, placeTexts]
    );

    // 10. no page errors
    check('no uncaught page errors', errors.length === 0, errors);
    await context.close();
  }

  // 9. API error → retry
  {
    state.failApi = true;
    const { page, context } = await newPage(browser);
    await page.goto(base + '/tours.html');
    await page.waitForSelector('#retryBtn');
    check(
      'API 500: error state with a retry button',
      (await page.locator('.error-state').count()) === 1 &&
        (await page.locator('.band-card').count()) === 0
    );
    state.failApi = false;
    await page.click('#retryBtn');
    await page.waitForSelector('.band-card');
    check(
      'retry after recovery renders the cards',
      (await page.locator('.band-card').count()) === 2
    );
    await context.close();
  }

  // 11. optional: the Leaflet map (needs internet)
  if (process.env.TOURS_SMOKE_MAP === '1') {
    const { page, context } = await newPage(browser, { allowExternal: true });
    await page.goto(base + '/tours.html');
    await page.waitForSelector('.band-card');
    await page
      .locator('.band-card', { hasText: 'Alpha' })
      .locator('.band-card__summary')
      .click();
    await page.click('[data-show-on-map]');
    check(
      'map: "Show on map" reveals the map panel',
      await page.isVisible('#mapPanel')
    );
    await page.click('#hideMapBtn');
    check('map: "Hide map" hides it again', await page.isHidden('#mapPanel'));
    await context.close();
  } else {
    console.log(
      'SKIP  map checks (set TOURS_SMOKE_MAP=1 with internet access to run them)'
    );
  }
} finally {
  if (browser) await browser.close();
  server.close();
}

console.log(
  failures === 0 ? '\nAll tours smoke checks passed' : `\n${failures} FAILURES`
);
process.exit(failures === 0 ? 0 : 1);
