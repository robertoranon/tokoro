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
const M = require('../member.js');

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
const state = {
  requests: [],
  failApi: false,
  tracked: undefined,
  memberRequests: [], // every /member/* request: "METHOD /path"
  memberMe: null, // null → 403; else the /member/me body
  memberAccept: null, // null → any pubkey; else a Set: other X-Pubkey values get 403
  memberMeStatus: 0, // non-zero → /member/me answers with this status
  bandDelayMs: 0, // artificial delay on /member/bands/*
  serverFollowed: new Set(), // band urls followed through POST/DELETE /member/bands/*
};
let base = '';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
const PAGE_SIZE = 100;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/member/')) {
    state.memberRequests.push(req.method + ' ' + url.pathname);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const pk = String(req.headers['x-pubkey'] || '');
    if (state.memberAccept && !state.memberAccept.has(pk)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"error":"Forbidden"}');
      return;
    }
    if (url.pathname.startsWith('/member/bands/')) {
      if (state.bandDelayMs)
        await new Promise(r => setTimeout(r, state.bandDelayMs));
      const bandUrl = Buffer.from(
        url.pathname.slice('/member/bands/'.length),
        'base64url'
      ).toString();
      if (req.method === 'POST') state.serverFollowed.add(bandUrl);
      else state.serverFollowed.delete(bandUrl);
    }
    if (url.pathname === '/member/me') {
      if (state.memberMeStatus) {
        res.writeHead(state.memberMeStatus, {
          'Content-Type': 'application/json',
        });
        res.end('{"error":"Server error"}');
      } else if (!state.memberMe) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end('{"error":"Forbidden"}');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state.memberMe));
      }
      return;
    }
    if (url.pathname === '/member/suggestions') {
      const b = JSON.parse(raw);
      state.memberMe.suggestions.unshift({
        id: 100 + state.memberMe.suggestions.length,
        name: b.name,
        url: b.url || null,
        status: 'pending',
        act_url: null,
        reject_reason: null,
        created_at: '2030-01-01T00:00:00',
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return;
  }
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
  if (!['tours.html', 'shared.js', 'tours.js', 'member.js'].includes(name)) {
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

    // API down but the file is available: bands listed without counts
    try {
      state.tracked = trackedFile([
        { name: 'Alpha', url: 'https://alpha.example' },
        { name: 'Gamma', url: 'https://gamma.example' },
      ]);
      state.failApi = true;
      ({ page, context, errors } = await newPage(browser));
      await page.goto(base + '/tours.html');
      await page.waitForSelector('.error-state');
      check(
        'tracked: with the shows failing, the pane still counts the tracked bands',
        (await page.textContent('#trackedSummary')).includes(
          'Tracked bands (2)'
        ),
        await page.textContent('#trackedSummary')
      );
      await page.click('#trackedSummary');
      const rows = await rowsOf(page);
      check(
        'tracked: with the shows failing, rows are listed without counts',
        JSON.stringify(rows.map(r => r.name)) ===
          JSON.stringify(['Alpha', 'Gamma']) && rows.every(r => r.count === ''),
        rows
      );
      check(
        'tracked: no uncaught page errors (API down)',
        errors.length === 0,
        errors
      );
      await context.close();
    } finally {
      state.failApi = false;
      state.tracked = undefined;
    }
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
  // ── visitors: nothing member-related appears or is requested ──────────────
  {
    state.memberRequests.length = 0;
    const { page, context } = await newPage(browser);
    await page.goto(base + '/tours.html');
    await page.waitForSelector('.band-card');
    check('visitor: no member bar', await page.isHidden('#memberBar'));
    check('visitor: no suggest pane', await page.isHidden('#suggestPane'));
    check('visitor: no follow buttons', (await page.locator('.follow-btn').count()) === 0);
    check('visitor: no /member requests', state.memberRequests.length === 0, state.memberRequests);
    const noteBox = await page.evaluate(() => {
      const r = document.getElementById('memberNote').getBoundingClientRect();
      return { h: r.height, hidden: document.getElementById('memberNote').hidden };
    });
    check('visitor: the empty member note takes no space', (await page.isHidden('#memberNote')) && noteBox.h === 0, noteBox);
    await context.close();
  }

  // ── members ────────────────────────────────────────────────────────────────
  {
    const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    state.tracked = JSON.stringify({
      generated: '2030-01-01',
      bands: [
        { name: 'Alpha', url: 'https://alpha.example' },
        { name: 'Beta', url: 'https://beta.example' },
        { name: 'Gamma Ray', url: 'https://gammaray.example' },
      ],
    });
    state.memberMe = {
      name: 'Anna',
      bands: ['https://alpha.example'],
      suggestions: [
        { id: 1, name: 'gamma ray', url: null, status: 'pending', act_url: null, reject_reason: null, created_at: 'x' },
        { id: 2, name: 'Nobody', url: null, status: 'rejected', act_url: null, reject_reason: 'Not touring', created_at: 'x' },
      ],
    };
    state.memberRequests.length = 0;
    const { page, context, errors } = await newPage(browser);
    await page.goto(base + '/tours.html#k=' + seed);
    await page.waitForSelector('.band-card');
    await page.waitForSelector('#memberBar:not([hidden])');
    check('member: greeting names the member', (await page.textContent('#memberHello')).includes('Anna'));
    check('member: link fragment removed from the address bar', !page.url().includes('#k='), page.url());
    check(
      'member: seed stored for next visits',
      (await page.evaluate(() => localStorage.getItem('tokoro_member'))) === seed
    );
    check('member: follow buttons shown', (await page.locator('.follow-btn').count()) === 2);
    check('member: Alpha is followed', (await page.locator('.band-card', { hasText: 'Alpha' }).locator('.follow-btn').getAttribute('aria-pressed')) === 'true');

    await page.click('#myBandsBtn');
    check('member: My bands shows only followed bands', (await names(page)).join(',') === 'Alpha', await names(page));
    await page.click('#allBandsBtn');
    check('member: All bands shows everyone again', (await names(page)).length === 2);

    // The pending "gamma ray" suggestion matches a tracked band: the page
    // follows it on load (before the request log is reset below).
    const gammaFollow =
      'POST /member/bands/' +
      Buffer.from('https://gammaray.example').toString('base64url');
    for (let i = 0; i < 50 && !state.memberRequests.includes(gammaFollow); i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    const autoFollowed = state.memberRequests.includes(gammaFollow);
    const initRequests = [...state.memberRequests];

    state.memberRequests.length = 0;
    await page.locator('.band-card', { hasText: 'Beta' }).locator('.follow-btn').click();
    await page.waitForFunction(() => document.querySelectorAll('.follow-btn[aria-pressed="true"]').length === 2);
    check('member: following sends a follow request', state.memberRequests.some(r => r.startsWith('POST /member/bands/')), state.memberRequests);

    await page.click('#myBandsBtn');
    check('member: My bands now has both', (await names(page)).length === 2);
    check('member: My bands choice is remembered', (await page.evaluate(() => localStorage.getItem('tokoro_member_view'))) === 'mine');

    check('member: suggestion matching a tracked band is shown as Added', (await page.textContent('#suggestList')).includes('Added'));
    check('member: rejected suggestion shows its reason', (await page.textContent('#suggestList')).includes('Not touring'));
    check('member: matched suggestion was followed automatically', autoFollowed, initRequests);

    await page.click('#suggestPane > summary'); // the pane starts collapsed
    await page.fill('#suggestName', 'Brand New Band');
    await page.click('#suggestForm button[type=submit]');
    await page.waitForFunction(() => document.getElementById('suggestList').textContent.includes('Brand New Band'));
    check('member: new suggestion is listed as Waiting', (await page.textContent('#suggestList')).includes('Waiting'));

    // Rapid toggling (A4): two clicks while the first request is in flight
    // send one request; the final state matches the server.
    await page.click('#allBandsBtn');
    await settleNames(page, ['Alpha', 'Beta']);
    state.serverFollowed = new Set(['https://alpha.example']);
    state.bandDelayMs = 400;
    state.memberRequests.length = 0;
    await page.evaluate(() => {
      const sel = '[data-follow="https://alpha.example"]';
      document.querySelector(sel).click();
      document.querySelector(sel).click();
    });
    await new Promise(r => setTimeout(r, 1200));
    state.bandDelayMs = 0;
    const alphaReqs = state.memberRequests.filter(r => r.includes(Buffer.from('https://alpha.example').toString('base64url')));
    const alphaPressed = await page.getAttribute('[data-follow="https://alpha.example"]', 'aria-pressed');
    check('member: rapid double click sends one request', alphaReqs.length === 1, state.memberRequests);
    check(
      'member: after rapid clicks the button matches the server',
      alphaPressed === String(state.serverFollowed.has('https://alpha.example')),
      [alphaPressed, [...state.serverFollowed]]
    );

    // A new suggestion that matches a tracked band is followed at once (A5).
    state.memberRequests.length = 0;
    const alphaFollow = 'POST /member/bands/' + Buffer.from('https://alpha.example').toString('base64url');
    await page.fill('#suggestName', 'Alpha');
    await page.click('#suggestForm button[type=submit]');
    try {
      await page.waitForFunction(
        () => document.querySelector('[data-follow="https://alpha.example"]')?.getAttribute('aria-pressed') === 'true',
        null,
        { timeout: 5000 }
      );
    } catch {}
    check('member: a new suggestion matching a tracked band sends a follow', state.memberRequests.includes(alphaFollow), state.memberRequests);
    check(
      'member: ...and its heart shows pressed',
      (await page.getAttribute('[data-follow="https://alpha.example"]', 'aria-pressed')) === 'true'
    );
    check('member: no page errors', errors.length === 0, errors);
    await context.close();

    // a later visit needs no link
    const second = await newPage(browser);
    await second.page.addInitScript(s => localStorage.setItem('tokoro_member', s), seed);
    await second.page.goto(base + '/tours.html');
    await second.page.waitForSelector('#memberBar:not([hidden])');
    check('member: stored seed works without the link', true);
    await second.context.close();

    // revoked or unknown: back to the visitor view, nothing stored
    state.memberMe = null;
    const gone = await newPage(browser);
    await gone.page.addInitScript(s => localStorage.setItem('tokoro_member', s), seed);
    await gone.page.goto(base + '/tours.html');
    await gone.page.waitForSelector('.band-card');
    await gone.page.waitForFunction(() => document.getElementById('memberNote').textContent.length > 0);
    check('revoked: visitor view', await gone.page.isHidden('#memberBar'));
    check('revoked: stored seed cleared', (await gone.page.evaluate(() => localStorage.getItem('tokoro_member'))) === null);
    check(
      'revoked: the member note is visible with its text',
      (await gone.page.isVisible('#memberNote')) &&
        (await gone.page.textContent('#memberNote')).includes('no longer active'),
      await gone.page.textContent('#memberNote')
    );
    await gone.context.close();

    // A dead link must not wipe a working stored seed (A2).
    const badSeed = Buffer.from(Array.from({ length: 32 }, (_, i) => 200 - i)).toString('base64url');
    const goodPk = (await M.importMember(seed)).pubkey;
    state.memberMe = { name: 'Anna', bands: [], suggestions: [] };
    state.memberAccept = new Set([goodPk]);
    try {
      const dead = await newPage(browser);
      await dead.page.goto(base + '/member.js'); // same origin, to seed localStorage once
      await dead.page.evaluate(s => localStorage.setItem('tokoro_member', s), seed);
      await dead.page.goto(base + '/tours.html');
      await dead.page.waitForSelector('#memberBar:not([hidden])');
      check('dead link: the stored seed works on its own', true);
      await dead.page.goto(base + '/member.js');
      await dead.page.goto(base + '/tours.html#k=' + badSeed);
      await dead.page.waitForSelector('.band-card');
      await dead.page.waitForFunction(() => document.getElementById('memberNote').textContent.length > 0);
      check('dead link: visitor view for this visit', await dead.page.isHidden('#memberBar'));
      check(
        'dead link: the working stored seed is kept',
        (await dead.page.evaluate(() => localStorage.getItem('tokoro_member'))) === seed
      );
      await dead.page.goto(base + '/tours.html');
      await dead.page.waitForSelector('#memberBar:not([hidden])', { timeout: 5000 }).catch(() => {});
      check('dead link: the next visit without the link is a member again', await dead.page.isVisible('#memberBar'));
      await dead.context.close();
    } finally {
      state.memberAccept = null;
    }

    // Offline / server error on the first open: the link is kept (A3).
    state.memberMeStatus = 500;
    try {
      const off = await newPage(browser);
      await off.page.goto(base + '/tours.html#k=' + seed);
      await off.page.waitForSelector('.band-card');
      let stored = null;
      try {
        await off.page.waitForFunction(() => localStorage.getItem('tokoro_member') !== null, null, { timeout: 5000 });
        stored = await off.page.evaluate(() => localStorage.getItem('tokoro_member'));
      } catch {}
      check('5xx on first open: the link seed is stored', stored === seed, stored);
      check('5xx on first open: visitor view', await off.page.isHidden('#memberBar'));
      state.memberMeStatus = 0;
      await off.page.reload();
      await off.page.waitForSelector('#memberBar:not([hidden])', { timeout: 5000 }).catch(() => {});
      check('5xx on first open: a reload once the server is back shows the member view', await off.page.isVisible('#memberBar'));
      await off.context.close();
    } finally {
      state.memberMeStatus = 0;
    }
    // An unverified link must not replace a different stored seed.
    state.memberMeStatus = 503;
    try {
      const other = Buffer.from(Array.from({ length: 32 }, (_, i) => 100 + i)).toString('base64url');
      const keep = await newPage(browser);
      await keep.page.addInitScript(s => {
        if (!sessionStorage.getItem('seeded')) {
          localStorage.setItem('tokoro_member', s);
          sessionStorage.setItem('seeded', '1');
        }
      }, seed);
      state.memberRequests.length = 0;
      await keep.page.goto(base + '/tours.html#k=' + other);
      await keep.page.waitForSelector('.band-card');
      for (let i = 0; i < 50 && !state.memberRequests.includes('GET /member/me'); i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      await new Promise(r => setTimeout(r, 500)); // let initMember finish
      const stored = await keep.page.evaluate(() => localStorage.getItem('tokoro_member'));
      check(
        '5xx with a stored seed: a different link seed does not replace it',
        state.memberRequests.includes('GET /member/me') && stored === seed,
        [stored, state.memberRequests]
      );
      check('5xx with a stored seed: visitor view', await keep.page.isHidden('#memberBar'));
      await keep.context.close();
    } finally {
      state.memberMeStatus = 0;
    }
    {
      const net = await newPage(browser);
      await net.page.route('**/member/me', r => r.abort());
      await net.page.goto(base + '/tours.html#k=' + seed);
      await net.page.waitForSelector('.band-card');
      let stored = null;
      try {
        await net.page.waitForFunction(() => localStorage.getItem('tokoro_member') !== null, null, { timeout: 5000 });
        stored = await net.page.evaluate(() => localStorage.getItem('tokoro_member'));
      } catch {}
      check('offline first open: the link seed is stored, visitor view', stored === seed && (await net.page.isHidden('#memberBar')), stored);
      await net.context.close();
    }
  }
} finally {
  if (browser) await browser.close();
  server.close();
}

console.log(
  failures === 0 ? '\nAll tours smoke checks passed' : `\n${failures} FAILURES`
);
process.exit(failures === 0 ? 0 : 1);
