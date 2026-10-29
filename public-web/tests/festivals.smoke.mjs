// Offline smoke test for festivals.html.
// Run from the repo root:  node public-web/tests/festivals.smoke.mjs
// Needs Playwright's Chromium (installed with the crawler). Uses only 127.0.0.1.
// Optional: FESTIVALS_SMOKE_MAP=1 also checks the Leaflet map (needs internet for the CDN).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const F = require('../festivals.js');
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

// ── test data, relative to the machine's local "today" (same as the browser's) ──
const ymd = off => {
  const d = new Date();
  d.setDate(d.getDate() + off);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const today = ymd(0);
const radar = (id, name, startOff, endOff, over = {}) => ({
  id,
  title: name + ' 2026',
  festival_name: name,
  festival_url: `https://${id}.example`,
  url: `https://${id}.example`,
  description: 'A festival',
  venue_name: 'Venue ' + id,
  address: 'Town ' + id,
  lat: 45.6,
  lng: 13.2,
  start_time: ymd(startOff) + 'T00:00:00',
  end_time: ymd(endOff) + 'T23:59:59',
  category: 'music',
  tags: ['festival', 'electronic'],
  created_at: '2025-01-01T00:00:00',
  updated_at: null,
  ...over,
});
const utcAgo = days => new Date(Date.now() - days * 86400000).toISOString().slice(0, 19);
const EVENTS = [
  radar('old', 'Ended Fest', -9, -1), // ended yesterday → hidden
  { ...radar('prog', 'Concert', 3, 3), tags: [], start_time: ymd(3) + 'T21:00:00', end_time: null }, // program event → hidden
  radar('art', 'Aurora Art Weekend', 40, 42, { category: 'art', description: 'Installations in a Café courtyard', lat: 46.07, lng: 13.24, tags: ['festival', 'installation'] }),
  radar('run', 'Running Fest', -5, 3, { lat: 45.7, lng: 13.7 }),
  radar('cc', 'Tagged Concert', 4, 4, { start_time: ymd(4) + 'T21:00:00', end_time: ymd(4) + 'T23:00:00' }), // tagged concert → hidden
  radar('thr', 'Berlin Stage Days', 41, 44, { category: 'theater', lat: 52.52, lng: 13.4, updated_at: utcAgo(1) }), // → updated pill
  radar('mus', 'Soon Sound', 10, 12, { lat: 46.5, lng: 11.3, created_at: utcAgo(2), festival_url: 'https://mus.example/Soon/' }), // → new pill
  radar('ny', 'Far Future Fest', 400, 402, { lat: 48.2, lng: 16.37 }),
  radar('xss', 'Safe <b>Name</b>', 20, 21, { description: '<img src=x onerror="window.__xss=1">', category: 'other', lat: 41.9, lng: 12.5 }),
];
// What the page must show, in DOM order (group order = start order):
const EXPECTED_TITLES = [
  'Running Fest 2026',
  'Soon Sound 2026',
  'Safe <b>Name</b> 2026',
  'Aurora Art Weekend 2026',
  'Berlin Stage Days 2026',
  'Far Future Fest 2026',
];

// ── one local server: static page files + fake paged API ──────────────────────
const TRACKED_DEFAULT = JSON.stringify({
  generated: '2030-01-02',
  festivals: [
    { name: 'Quiet Valley', url: 'https://quiet.example' }, // not on the radar
    { name: 'Aurora Art Weekend', url: 'https://art.example/' }, // on the radar (trailing slash)
  ],
});
// file rows: Aurora, Quiet Valley; radar rows not in the file: 5 more
const TRACKED_COUNT = 7;
const state = {
  requests: [],
  failApi: false,
  events: null, // null → EVENTS
  tracked: TRACKED_DEFAULT, // undefined → 404
  memberRequests: [], // "METHOD /path" of every /member/* request
  memberMe: null, // null → 403
  staticRequests: [], // every static file request
  festivalDelayMs: 0, // artificial delay on /member/festivals/*
};
let base = '';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const PAGE_SIZE = 2;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/member/')) {
    state.memberRequests.push(req.method + ' ' + url.pathname);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (url.pathname === '/member/me') {
      if (!state.memberMe) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end('{"error":"Forbidden"}');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state.memberMe));
      }
      return;
    }
    if (url.pathname.startsWith('/member/festivals/') && state.festivalDelayMs)
      await new Promise(r => setTimeout(r, state.festivalDelayMs));
    if (url.pathname === '/member/telegram/link-code') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'abc', bot_url: 'https://t.me/tokoro_bot?start=abc' }));
      return;
    }
    if (url.pathname === '/member/festival-suggestions') {
      const b = JSON.parse(raw);
      state.memberMe.festival_suggestions.unshift({
        id: 100 + state.memberMe.festival_suggestions.length,
        name: b.name,
        url: b.url || null,
        status: 'pending',
        festival_url: null,
        reject_reason: null,
        created_at: '2030-01-01T00:00:00',
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return;
  }
  if (url.pathname === '/tracked-festivals.json') {
    if (state.tracked === undefined) {
      res.writeHead(404);
      res.end('not found');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(state.tracked);
    }
    return;
  }
  if (url.pathname === '/events') {
    const EVENTS_NOW = state.events || EVENTS;
    state.requests.push({
      has_festival: url.searchParams.get('has_festival'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      offset: Number(url.searchParams.get('offset') || 0),
    });
    if (state.failApi) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    const offset = Number(url.searchParams.get('offset') || 0);
    const slice = EVENTS_NOW.slice(offset, offset + PAGE_SIZE);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events: slice, offset, count: slice.length, has_more: offset + PAGE_SIZE < EVENTS_NOW.length }));
    return;
  }
  state.staticRequests.push(url.pathname);
  const name = url.pathname.replace(/^\//, '');
  if (!['festivals.html', 'shared.js', 'festivals.js', 'member.js'].includes(name)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  try {
    let body = await fs.readFile(path.join(ROOT, name), 'utf8');
    body = body.replace(/__TOKORO_WORKER_URL__/g, base).replace(/__BUILD_VERSION__/g, 'smoke');
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
async function newPage(browser, { geolocation, allowExternal = false } = {}) {
  const context = await browser.newContext({
    ...(geolocation ? { geolocation, permissions: ['geolocation'] } : {}),
  });
  if (!allowExternal) {
    await context.route(u => !/^http:\/\/127\.0\.0\.1[:/]/.test(u.href) && !u.href.startsWith('about:'), r => r.abort());
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  return { page, context, errors };
}
const titles = page => page.$$eval('.fest-card__title', els => els.map(e => e.textContent.trim()));
// Poll until the card titles equal `expected` (the keyword input is debounced); returns the final titles.
async function settleTitles(page, expected) {
  try {
    await page.waitForFunction(exp => JSON.stringify([...document.querySelectorAll('.fest-card__title')].map(e => e.textContent.trim())) === JSON.stringify(exp), expected, { timeout: 5000 });
  } catch {}
  return titles(page);
}
const groupLabels = page => page.$$eval('.month-group__title', els => els.map(e => e.textContent.trim()));

let browser;
try {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    if (/Executable doesn't exist|browserType\.launch|playwright install/i.test(String(e))) {
      console.log('SKIP: no browser available for Playwright');
      server.close();
      process.exit(0);
    }
    throw e;
  }

  // ── 1. load, paging, radar-only, grouping ──────────────────────────────────
  {
    const { page, context, errors } = await newPage(browser, { geolocation: { latitude: 45.65, longitude: 13.78 } });
    await page.goto(base + '/festivals.html');
    await page.waitForSelector('.fest-card');

    check('shows exactly the radar entries that are not over, in start order', JSON.stringify(await titles(page)) === JSON.stringify(EXPECTED_TITLES), await titles(page));
    const labels = await groupLabels(page);
    check('first group is "Happening now"', labels[0] === 'Happening now', labels);
    check('no program event, tagged concert or ended festival is shown', (await page.content()).indexOf('Tagged Concert') === -1 && (await page.content()).indexOf('Ended Fest') === -1);
    check('all API pages were fetched', JSON.stringify(state.requests.map(r => r.offset)) === JSON.stringify([0, 2, 4, 6, 8]), state.requests.map(r => r.offset));
    check('request asks for has_festival=1 with a window reaching back before the running festival', state.requests[0].has_festival === '1' && state.requests[0].from < ymd(-5) + 'T00:00:00', state.requests[0]);
    check('map panel is hidden when Leaflet cannot load, the list still works', await page.isHidden('#mapPanel'));
    check('status line counts the festivals', /6/.test(await page.textContent('#statusLine')), await page.textContent('#statusLine'));
    check('HTML in names/descriptions is escaped, nothing executed', (await page.evaluate(() => window.__xss)) === undefined && (await page.locator('img[src="x"]').count()) === 0 && (await titles(page)).includes('Safe <b>Name</b> 2026'));
    check('every card shows a formatted date range and a safe outbound link', (await page.locator('.fest-card__date').count()) === 6 && (await page.locator('.fest-card a[href^="https://"][rel~="noopener"]').count()) >= 6);
    const pills = await page.$$eval('.fest-card', cards => cards.map(c => [c.querySelector('.fest-card__title').textContent.trim(), c.querySelector('.fest-card__fresh')?.textContent.trim() ?? ''] ).filter(([, p]) => p));
    check('freshness pills: "new" on a recent entry, "updated" on a recently changed one, none elsewhere', JSON.stringify(pills) === JSON.stringify([['Soon Sound 2026', 'new'], ['Berlin Stage Days 2026', 'updated']]), pills);

    // ── 2. filters ───────────────────────────────────────────────────────────
    await page.selectOption('#categoryFilter', 'art');
    check('category filter: art → only the art festival', JSON.stringify(await titles(page)) === JSON.stringify(['Aurora Art Weekend 2026']), await titles(page));
    await page.selectOption('#categoryFilter', '');

    await page.fill('#keywordFilter', 'cafe');
    const cafeTitles = await settleTitles(page, ['Aurora Art Weekend 2026']);
    check('keyword is accent-insensitive ("cafe" finds "Café")', JSON.stringify(cafeTitles) === JSON.stringify(['Aurora Art Weekend 2026']), cafeTitles);
    await page.fill('#keywordFilter', '');
    await settleTitles(page, EXPECTED_TITLES);

    const chipOf = off => F.addDays(today, off).slice(0, 7);
    await page.click(`.chip[data-month="${chipOf(41)}"]`);
    check('month chip filters by overlap and marks itself pressed', (await titles(page)).includes('Berlin Stage Days 2026') && !(await titles(page)).includes('Running Fest 2026') && (await page.getAttribute(`.chip[data-month="${chipOf(41)}"]`, 'aria-pressed')) === 'true', await titles(page));
    await page.click(`.chip[data-month="${chipOf(41)}"]`);
    check('clicking the active chip again clears the month filter', (await titles(page)).length === 6);

    // keyboard: focus must stay on the chip after it is pressed
    const kSel = `.chip[data-month="${chipOf(41)}"]`;
    await page.focus(kSel);
    await page.keyboard.press('Enter');
    const afterOn = await page.evaluate(() => ({ key: document.activeElement.getAttribute('data-month'), pressed: document.activeElement.getAttribute('aria-pressed') }));
    check('keyboard: focus stays on the month chip after Enter and it is pressed', afterOn.key === chipOf(41) && afterOn.pressed === 'true', afterOn);
    await page.keyboard.press('Enter');
    const afterOff = await page.evaluate(() => ({ key: document.activeElement.getAttribute('data-month'), pressed: document.activeElement.getAttribute('aria-pressed') }));
    check('keyboard: second Enter un-presses the chip and focus stays', afterOff.key === chipOf(41) && afterOff.pressed === 'false', afterOff);

    const emptyKey = chipOf(300);
    await page.click(`.chip[data-month="${emptyKey}"]`);
    check('empty month shows "nothing on the radar yet for <month>"', (await page.textContent('#festList')).includes('Nothing on the radar yet for ' + F.monthLabel(emptyKey)), await page.textContent('#festList'));
    await page.click('.chip[data-month=""]');
    check('"All" chip restores everything', (await titles(page)).length === 6);

    // ── 3. near me ───────────────────────────────────────────────────────────
    await page.click('#nearToggle');
    await page.waitForSelector('.fest-card__distance');
    check('near me: distances shown on every card', (await page.locator('.fest-card__distance').count()) === 6);
    const running = await page.locator('.fest-card', { hasText: 'Running Fest 2026' }).locator('.fest-card__distance').textContent();
    check('near me: nearby festival is ~8 km away', /8\.\d km/.test(running), running);
    check('near me: list is sorted, not filtered (still 6)', (await titles(page)).length === 6 && (await page.getAttribute('#nearToggle', 'aria-pressed')) === 'true');
    await page.click('#nearToggle');
    check('near me: toggling off removes distances', (await page.locator('.fest-card__distance').count()) === 0);
    check('no uncaught page errors', errors.length === 0, errors);
    await context.close();
  }

  // ── 4. geolocation denied → toggle reverts with a notice ─────────────────────
  {
    const { page, context } = await newPage(browser, {});
    await page.goto(base + '/festivals.html');
    await page.waitForSelector('.fest-card');
    await page.click('#nearToggle');
    await page.waitForFunction(() => /unavailable/i.test(document.getElementById('noticeLine').textContent));
    check('near me denied: notice shown, toggle reverts, full list kept', (await page.getAttribute('#nearToggle', 'aria-pressed')) === 'false' && (await titles(page)).length === 6);
    await context.close();
  }

  // ── 5. API error → message + retry ───────────────────────────────────────────
  {
    state.failApi = true;
    const { page, context } = await newPage(browser, {});
    await page.goto(base + '/festivals.html');
    await page.waitForSelector('#retryBtn');
    check('API error: friendly message and a retry button', /could not load/i.test(await page.textContent('#statusLine')) || /could not load/i.test(await page.textContent('#festList')));
    await page.fill('#keywordFilter', 'x');
    await page.waitForTimeout(400); // longer than the input debounce
    check('typing while the error is shown keeps the error and retry button', (await page.locator('#retryBtn').count()) === 1 && /could not load/i.test(await page.textContent('#festList')));
    await page.fill('#keywordFilter', '');
    await page.waitForTimeout(400);
    state.failApi = false;
    await page.click('#retryBtn');
    await page.waitForSelector('.fest-card');
    check('retry loads the radar', (await titles(page)).length === 6);
    await context.close();
  }


  // ── 6. visitors: the Tracked festivals pane, and nothing member-related ──────
  {
    state.memberRequests.length = 0;
    state.staticRequests.length = 0;
    const { page, context, errors } = await newPage(browser, {});
    await page.goto(base + '/festivals.html');
    await page.waitForSelector('.fest-card');
    await page.waitForSelector('#trackedPane:not([hidden])');
    check('visitor: Tracked festivals pane with its count', (await page.textContent('#trackedPane > summary')).trim() === `Tracked festivals (${TRACKED_COUNT})`, await page.textContent('#trackedPane > summary'));
    check('visitor: tracked rows have no heart', (await page.locator('#trackedList li').count()) === TRACKED_COUNT && (await page.locator('#trackedList .follow-btn').count()) === 0);
    const rowText = await page.textContent('#trackedList');
    check('visitor: tracked rows say "on the radar" / "no dates yet"', /Quiet Valley[^]*no dates yet/.test(rowText) && /Aurora Art Weekend[^]*on the radar/.test(rowText), rowText);
    check('visitor: rows link to the festival site', (await page.locator('#trackedList a[href^="https://quiet.example"][rel~="noopener"]').count()) === 1);
    check('visitor: "List updated" note', (await page.textContent('#trackedPane')).includes('List updated 2030-01-02'));
    check('visitor: no hearts on cards', (await page.locator('#festList .follow-btn').count()) === 0);
    check('visitor: no member bar, no suggest pane, no Telegram button', (await page.isHidden('#memberBar')) && (await page.isHidden('#suggestPane')) && (await page.isHidden('#telegramBtn')));
    check('visitor: member.js is not downloaded', !state.staticRequests.includes('/member.js'), state.staticRequests);
    check('visitor: no /member requests', state.memberRequests.length === 0, state.memberRequests);
    check('visitor: no page errors', errors.length === 0, errors);
    await context.close();
  }

  // ── 7. tracked-festivals.json missing → radar festivals; none at all → hidden ─
  {
    state.tracked = undefined;
    const { page, context } = await newPage(browser, {});
    await page.goto(base + '/festivals.html');
    await page.waitForSelector('.fest-card');
    await page.waitForSelector('#trackedPane:not([hidden])');
    check('missing tracked file: pane lists the radar festivals', (await page.locator('#trackedList li').count()) === 6 && (await page.textContent('#trackedPane > summary')).includes('(6)'), await page.textContent('#trackedList'));
    await context.close();

    state.events = [];
    const empty = await newPage(browser, {});
    await empty.page.goto(base + '/festivals.html');
    await empty.page.waitForSelector('.empty-state');
    await empty.page.waitForTimeout(200);
    check('missing tracked file and no radar festivals: pane hidden', await empty.page.isHidden('#trackedPane'));
    await empty.context.close();
    state.events = null;
    state.tracked = TRACKED_DEFAULT;
  }

  // ── 8. members ───────────────────────────────────────────────────────────────
  {
    const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64url');
    const b64 = u => Buffer.from(M.normalizeActUrl(u)).toString('base64url');
    state.memberMe = {
      name: 'Anna',
      bands: [],
      suggestions: [],
      festivals: ['https://mus.example/soon'], // the radar entry is https://mus.example/Soon/
      festival_suggestions: [
        { id: 1, name: 'quiet valley', url: null, status: 'pending', festival_url: null, reject_reason: null, created_at: 'x' },
        { id: 2, name: 'Megafest', url: null, status: 'rejected', festival_url: null, reject_reason: 'Too big', created_at: 'x' },
      ],
    };
    state.memberRequests.length = 0;
    state.staticRequests.length = 0;
    const { page, context, errors } = await newPage(browser, {});
    await page.goto(base + '/festivals.html#k=' + seed);
    await page.waitForSelector('.fest-card');
    await page.waitForSelector('#memberBar:not([hidden])');
    check('member: a link loads member.js', state.staticRequests.includes('/member.js'), state.staticRequests);
    check('member: link fragment removed from the address bar', !page.url().includes('#k='), page.url());
    check('member: greeting names the member', (await page.textContent('#memberHello')).includes('Anna'));
    check('member: hearts on every card', (await page.locator('#festList .follow-btn').count()) === 6);
    await page.waitForSelector('#trackedList .follow-btn', { state: 'attached' });
    check('member: hearts on every tracked row', (await page.locator('#trackedList .follow-btn').count()) === (await page.locator('#trackedList li').count()));
    check(
      'member: a followed festival matches across case and trailing slash',
      (await page.getAttribute('#festList .follow-btn[data-follow="https://mus.example/Soon/"]', 'aria-pressed')) === 'true' &&
        (await page.getAttribute('#festList .follow-btn[data-follow="https://run.example"]', 'aria-pressed')) === 'false'
    );
    check('member: heart label', (await page.getAttribute('#festList .follow-btn[data-follow="https://run.example"]', 'aria-label')) === 'Follow this festival');

    // auto-follow of the pending suggestion matching a tracked festival
    const quietFollow = 'POST /member/festivals/' + b64('https://quiet.example');
    for (let i = 0; i < 50 && !state.memberRequests.includes(quietFollow); i++) await new Promise(r => setTimeout(r, 100));
    check('member: matched suggestion is followed automatically, once', state.memberRequests.filter(r => r === quietFollow).length === 1, state.memberRequests);
    check('member: auto-follow remembered on this device', JSON.parse(await page.evaluate(() => localStorage.getItem('tokoro_member_festival_autofollowed'))).includes(1));
    const sugg = await page.textContent('#suggestList');
    check('member: matched suggestion shows Added, rejected one its reason', sugg.includes('Added') && sugg.includes('Not added — Too big'), sugg);
    await page.waitForFunction(() => document.querySelector('#trackedList [data-follow="https://quiet.example"]')?.getAttribute('aria-pressed') === 'true');
    check('member: auto-followed tracked row shows a filled heart', true);

    // ♡ in All festivals: request sent, nothing re-rendered
    state.memberRequests.length = 0;
    await page.evaluate(() => {
      window.__runCard = document.querySelector('#festList [data-follow="https://run.example"]').closest('.fest-card');
    });
    await page.click('#festList [data-follow="https://run.example"]');
    await page.waitForFunction(() => {
      const b = document.querySelector('#festList [data-follow="https://run.example"]');
      return b.getAttribute('aria-pressed') === 'true' && !b.hasAttribute('aria-disabled');
    });
    check('member: ♡ sends POST /member/festivals/<b64>', state.memberRequests.includes('POST /member/festivals/' + b64('https://run.example')), state.memberRequests);
    check('member: ♡ in All festivals re-renders nothing', await page.evaluate(() => window.__runCard === document.querySelector('#festList [data-follow="https://run.example"]').closest('.fest-card')));

    // in-flight guard: a second click while the request is pending is ignored
    state.memberRequests.length = 0;
    state.festivalDelayMs = 400;
    const busy = await page.evaluate(() => {
      const sel = '#festList [data-follow="https://art.example"]';
      document.querySelector(sel).click();
      document.querySelector(sel).click();
      const b = document.querySelector(sel);
      return { aria: b.getAttribute('aria-disabled'), disabled: b.hasAttribute('disabled') };
    });
    check('member: an in-flight heart is aria-disabled, not disabled', busy.aria === 'true' && !busy.disabled, busy);
    await page.waitForSelector('#festList [data-follow="https://art.example"]:not([aria-disabled])');
    state.festivalDelayMs = 0;
    check('member: rapid double click sends one request', state.memberRequests.filter(r => r.startsWith('POST /member/festivals/')).length === 1, state.memberRequests);
    await page.click('#festList [data-follow="https://art.example"]'); // unfollow again
    await page.waitForFunction(() => document.querySelector('#festList [data-follow="https://art.example"]:not([aria-disabled])')?.getAttribute('aria-pressed') === 'false');

    await page.click('#myFestivalsBtn');
    check('member: My festivals keeps only followed festivals', JSON.stringify(await titles(page)) === JSON.stringify(['Running Fest 2026', 'Soon Sound 2026']), await titles(page));
    check('member: My festivals choice is remembered', (await page.evaluate(() => localStorage.getItem('tokoro_member_festival_view'))) === 'mine');
    await page.click('#allFestivalsBtn');
    check('member: All festivals shows everyone again', (await titles(page)).length === 6);

    // suggest
    await page.click('#suggestPane > summary');
    await page.fill('#suggestName', 'Brand New Fest');
    await page.click('#suggestForm button[type=submit]');
    await page.waitForFunction(() => document.getElementById('suggestList').textContent.includes('Brand New Fest'));
    check('member: suggestion sent with a thank-you', (await page.textContent('#suggestMsg')).includes('Thanks! We will take a look.') && state.memberRequests.includes('POST /member/festival-suggestions'), await page.textContent('#suggestMsg'));
    check('member: new suggestion is Waiting', /Brand New Fest\s*Waiting/.test(await page.textContent('#suggestList')), await page.textContent('#suggestList'));
    check('member: Telegram button shown', await page.isVisible('#telegramBtn'));
    check('member: no page errors', errors.length === 0, errors);
    await context.close();

    // stored seed only (e.g. activated on Tours), Telegram button
    state.memberMe = { name: 'Anna', bands: [], suggestions: [], festivals: [], festival_suggestions: [] };
    state.memberRequests.length = 0;
    {
      const p = await newPage(browser, {});
      await p.context.route('https://t.me/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: 'telegram' }));
      await p.page.addInitScript(s => localStorage.setItem('tokoro_member', s), seed);
      await p.page.goto(base + '/festivals.html');
      await p.page.waitForSelector('.fest-card');
      await p.page.waitForSelector('#memberBar:not([hidden])', { timeout: 5000 }).catch(() => {});
      check('stored seed: member bar without a link', await p.page.isVisible('#memberBar'));
      await p.page.click('#myFestivalsBtn');
      check(
        'My festivals with nothing followed: empty state',
        (await p.page.textContent('#festList')).includes('You are not following any festival yet. Switch to All festivals and tap ♡ on a festival.'),
        await p.page.textContent('#festList')
      );
      await p.page.click('#telegramBtn');
      await p.page.waitForURL('https://t.me/**');
      check('telegram: click requests a link code', state.memberRequests.includes('POST /member/telegram/link-code'), state.memberRequests);
      await p.context.close();
    }

    // followed festival without a radar entry
    state.memberMe = { name: 'Anna', bands: [], suggestions: [], festivals: ['https://gone.example'], festival_suggestions: [] };
    {
      const p = await newPage(browser, {});
      await p.page.addInitScript(s => {
        localStorage.setItem('tokoro_member', s);
        localStorage.setItem('tokoro_member_festival_view', 'mine');
      }, seed);
      await p.page.goto(base + '/festivals.html');
      await p.page.waitForSelector('#memberBar:not([hidden])');
      await p.page.waitForSelector('#trackedList [data-follow="https://gone.example"]', { state: 'attached' });
      check(
        'My festivals, followed festival off the radar: empty state',
        (await p.page.textContent('#festList')).includes('None of your festivals has dates on the radar right now. They are listed under Tracked festivals.'),
        await p.page.textContent('#festList')
      );
      const row = p.page.locator('#trackedList li', { has: p.page.locator('[data-follow="https://gone.example"]') });
      check('followed-only festival: tracked row labelled with the hostname, filled heart', (await row.textContent()).includes('gone.example') && (await row.locator('.follow-btn').getAttribute('aria-pressed')) === 'true', await row.textContent());
      await p.context.close();
    }
    state.memberMe = null;
  }

  // ── 9. optional: the Leaflet map (needs internet) ────────────────────────────
  if (process.env.FESTIVALS_SMOKE_MAP === '1') {
    const { page, context } = await newPage(browser, { allowExternal: true });
    await page.goto(base + '/festivals.html');
    await page.waitForSelector('.fest-card');
    await page.waitForSelector('.leaflet-container', { timeout: 15000 });
    check('map: Leaflet container and one pin per distinct location', (await page.locator('path.leaflet-interactive').count()) >= 5);
    await page.locator('.fest-card', { hasText: 'Soon Sound 2026' }).locator('[data-show-on-map]').click();
    await page.waitForSelector('.leaflet-popup', { timeout: 5000 });
    check('map: "Show on map" opens the festival popup', (await page.textContent('.leaflet-popup')).includes('Soon Sound'));
    await context.close();
  } else {
    console.log('SKIP  map checks (set FESTIVALS_SMOKE_MAP=1 with internet access to run them)');
  }
} finally {
  if (browser) await browser.close();
  server.close();
}

console.log(failures === 0 ? '\nAll festivals smoke checks passed' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
