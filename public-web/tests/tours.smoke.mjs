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
// created_at is UTC without a zone suffix, like the crawler writes it.
const createdAgo = days =>
  new Date(Date.now() - days * 86400000).toISOString().slice(0, 19);
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
  created_at: createdAgo(30), // old unless a test says otherwise
  ...over,
});
const EVENTS = [
  show('a1', 'Alpha', 12, 'Udine', 46.06, 13.23, { created_at: createdAgo(2) }), // new
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
// tracked: undefined → 404; a string → served verbatim as JSON
const state = { requests: [], failApi: false, tracked: undefined };
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
  if (url.pathname === '/tracked-bands.json') {
    if (state.tracked === undefined) {
      res.writeHead(404);
      res.end('not found');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(state.tracked);
    }
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

  // 12. saved queries: "Copy link" and restoring from the link
  {
    const { page, context, errors } = await newPage(browser);
    // Capture what the page copies (the real clipboard needs permissions).
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async t => {
            window.__copied = t;
          },
        },
        configurable: true,
      });
    });
    await page.goto(base + '/tours.html');
    await settleNames(page, ['Alpha', 'Beta']);
    await page.fill('#keywordFilter', 'alph');
    await settleNames(page, ['Alpha']);
    await page.click('#copyLinkBtn');
    const copied = await page.evaluate(() => window.__copied);
    check(
      'copy link: the link carries the keyword',
      typeof copied === 'string' &&
        copied.startsWith(base + '/tours.html?') &&
        new URL(copied).searchParams.get('q') === 'alph',
      copied
    );
    check(
      'copy link: the button confirms',
      (await page.textContent('#copyLinkBtn')).includes('copied')
    );

    // A page with no filters copies the bare page url.
    await page.fill('#keywordFilter', '');
    await settleNames(page, ['Alpha', 'Beta']);
    await page.click('#copyLinkBtn');
    check(
      'copy link: no filters → no query string',
      (await page.evaluate(() => window.__copied)) === base + '/tours.html'
    );

    // Opening the saved link restores the filters.
    await page.goto(copied);
    const restored = await settleNames(page, ['Alpha']);
    check(
      'saved link: the keyword is restored and applied',
      JSON.stringify(restored) === JSON.stringify(['Alpha']) &&
        (await page.inputValue('#keywordFilter')) === 'alph',
      restored
    );

    // A saved place (origin + radius + label).
    await page.goto(
      base + '/tours.html?lat=46.0637&lng=13.2353&radius=25&place=Udine'
    );
    const udine = await settleNames(page, ['Alpha']);
    check(
      'saved link: place, radius and origin restored (only Alpha is within 25 km of Udine)',
      JSON.stringify(udine) === JSON.stringify(['Alpha']) &&
        (await page.inputValue('#placeInput')) === 'Udine' &&
        (await page.inputValue('#radiusFilter')) === '25',
      udine
    );

    // A saved range that excludes everything shows the empty state.
    await page.goto(base + '/tours.html?to=2000-01-01');
    await page.waitForSelector('.empty-state');
    check(
      'saved link: a saved date range is applied',
      (await page.textContent('.empty-state')).includes('No shows match') &&
        (await page.inputValue('#toDate')) === '2000-01-01'
    );

    // Garbage parameters are ignored, not fatal.
    await page.goto(
      base + '/tours.html?from=zzz&to=2030-99-99&lat=999&lng=1&radius=7&q='
    );
    const garbage = await settleNames(page, ['Alpha', 'Beta']);
    check(
      'saved link: invalid parameters are ignored',
      JSON.stringify(garbage) === JSON.stringify(['Alpha', 'Beta']) &&
        (await page.inputValue('#radiusFilter')) === '100',
      garbage
    );
    check('saved links: no uncaught page errors', errors.length === 0, errors);
    await context.close();
  }

  // 13. "new" badges: shows first published in the last 7 days
  {
    const { page, context, errors } = await newPage(browser);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async t => {
            window.__copied = t;
          },
        },
        configurable: true,
      });
    });
    await page.goto(base + '/tours.html');
    await settleNames(page, ['Alpha', 'Beta']);
    const badges = await page.$$eval('.band-card', cards =>
      cards.map(c => ({
        name: c
          .querySelector('.band-card__name')
          .textContent.replace(/[▾▴]/g, '')
          .trim(),
        badge: c.querySelector('.band-card__badge')?.textContent.trim() ?? null,
      }))
    );
    check(
      'new: only the band with a recently published show has the NEW badge',
      JSON.stringify(badges) ===
        JSON.stringify([
          { name: 'Alpha', badge: 'NEW' },
          { name: 'Beta', badge: null },
        ]),
      badges
    );
    check(
      'new: bands are not reordered because of the badge',
      JSON.stringify(await names(page)) === JSON.stringify(['Alpha', 'Beta'])
    );

    await page.click('.band-card:has-text("Alpha") .band-card__summary');
    const marked = await page
      .locator('.band-card:has-text("Alpha") .band-show')
      .evaluateAll(els => els.map(e => !!e.querySelector('.band-show__new')));
    check(
      'new: inside the card only the new show is marked',
      JSON.stringify(marked) === JSON.stringify([true, false, false]),
      marked
    );

    // the "New only" toggle
    check(
      'new: the toggle starts off',
      (await page.getAttribute('#newOnlyToggle', 'aria-pressed')) === 'false'
    );
    await page.click('#newOnlyToggle');
    const onlyNew = await settleNames(page, ['Alpha']);
    const shownShows = await page
      .locator('.band-card:has-text("Alpha") .band-show')
      .count();
    check(
      'new only: just the band and show that are new remain',
      JSON.stringify(onlyNew) === JSON.stringify(['Alpha']) &&
        shownShows === 1 &&
        (await page.getAttribute('#newOnlyToggle', 'aria-pressed')) === 'true',
      [onlyNew, shownShows]
    );
    check(
      'new only: the status line counts what is shown',
      /1 of 2 bands/.test(await status(page)) &&
        /1 show\b/.test(await status(page)),
      await status(page)
    );

    // saved link
    await page.click('#copyLinkBtn');
    const copied = await page.evaluate(() => window.__copied);
    check(
      'new only: Copy link carries new=1',
      new URL(copied).searchParams.get('new') === '1',
      copied
    );
    await page.goto(copied);
    const restoredNew = await settleNames(page, ['Alpha']);
    check(
      'new only: the saved link restores the toggle and the filter',
      JSON.stringify(restoredNew) === JSON.stringify(['Alpha']) &&
        (await page.getAttribute('#newOnlyToggle', 'aria-pressed')) === 'true',
      restoredNew
    );

    // toggle off again
    await page.click('#newOnlyToggle');
    const back = await settleNames(page, ['Alpha', 'Beta']);
    check(
      'new only: turning it off shows everything again',
      JSON.stringify(back) === JSON.stringify(['Alpha', 'Beta']),
      back
    );
    check('new: no uncaught page errors', errors.length === 0, errors);
    await context.close();
  }

  // 14. tracked-bands pane
  {
    const trackedFile = bands =>
      JSON.stringify({ generated: '2030-10-07', bands });
    const rowsOf = page =>
      page.$$eval('#trackedList li', lis =>
        lis.map(li => ({
          name: li.querySelector('a').textContent.replace(/↗/, '').trim(),
          href: li.querySelector('a').getAttribute('href'),
          target: li.querySelector('a').getAttribute('target'),
          count: li.querySelector('.tracked-band__count').textContent.trim(),
        }))
      );

    // all three tracked bands, one without shows
    state.tracked = trackedFile([
      { name: 'Gamma', url: 'https://gamma.example' },
      { name: 'Alpha', url: 'https://alpha.example' },
      { name: 'Beta', url: 'https://beta.example/' },
    ]);
    let { page, context, errors } = await newPage(browser);
    await page.goto(base + '/tours.html');
    await settleNames(page, ['Alpha', 'Beta']);
    check(
      'tracked: the pane is collapsed and counts the tracked bands',
      (await page.isVisible('#trackedPane')) &&
        (await page.evaluate(
          () => document.querySelector('#trackedPane').open
        )) === false &&
        (await page.textContent('#trackedSummary')).includes(
          'Tracked bands (3)'
        ),
      await page.textContent('#trackedSummary')
    );
    await page.click('#trackedSummary');
    const rows = await rowsOf(page);
    check(
      'tracked: alphabetical rows with links to the band sites and upcoming counts',
      JSON.stringify(rows.map(r => [r.name, r.count])) ===
        JSON.stringify([
          ['Alpha', '3 upcoming shows'],
          ['Beta', '1 upcoming show'],
          ['Gamma', 'no upcoming shows'],
        ]) &&
        rows[0].href === 'https://alpha.example' &&
        rows.every(r => r.target === '_blank'),
      rows
    );
    await page.fill('#keywordFilter', 'beta');
    await settleNames(page, ['Beta']);
    check(
      'tracked: the pane ignores the filters',
      (await rowsOf(page)).length === 3
    );
    check('tracked: no uncaught page errors', errors.length === 0, errors);
    await context.close();

    // a band with shows that the file does not list is added
    state.tracked = trackedFile([
      { name: 'Alpha', url: 'https://alpha.example' },
    ]);
    ({ page, context } = await newPage(browser));
    await page.goto(base + '/tours.html');
    await settleNames(page, ['Alpha', 'Beta']);
    await page.click('#trackedSummary');
    check(
      'tracked: a band that has shows but is not in the file is still listed',
      JSON.stringify((await rowsOf(page)).map(r => r.name)) ===
        JSON.stringify(['Alpha', 'Beta']) &&
        (await page.textContent('#trackedSummary')).includes('(2)')
    );
    await context.close();

    // no file: the pane lists the bands that have shows
    state.tracked = undefined;
    ({ page, context, errors } = await newPage(browser));
    await page.goto(base + '/tours.html');
    await settleNames(page, ['Alpha', 'Beta']);
    check(
      'tracked: without the file the pane lists the bands that have shows',
      (await page.textContent('#trackedSummary')).includes('(2)'),
      await page.textContent('#trackedSummary')
    );
    check(
      'tracked: a missing file is not an error',
      errors.length === 0,
      errors
    );
    await context.close();

    // garbage file: treated as missing
    state.tracked = 'this is not json';
    ({ page, context, errors } = await newPage(browser));
    await page.goto(base + '/tours.html');
    await settleNames(page, ['Alpha', 'Beta']);
    check(
      'tracked: an invalid file is ignored',
      (await page.textContent('#trackedSummary')).includes('(2)') &&
        errors.length === 0,
      errors
    );
    await context.close();
    state.tracked = undefined;
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
