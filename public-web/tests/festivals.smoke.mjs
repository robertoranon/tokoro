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
  ...over,
});
const EVENTS = [
  radar('old', 'Ended Fest', -9, -1), // ended yesterday → hidden
  { ...radar('prog', 'Concert', 3, 3), tags: [], start_time: ymd(3) + 'T21:00:00', end_time: null }, // program event → hidden
  radar('art', 'Aurora Art Weekend', 40, 42, { category: 'art', description: 'Installations in a Café courtyard', lat: 46.07, lng: 13.24, tags: ['festival', 'installation'] }),
  radar('run', 'Running Fest', -5, 3, { lat: 45.7, lng: 13.7 }),
  radar('cc', 'Tagged Concert', 4, 4, { start_time: ymd(4) + 'T21:00:00', end_time: ymd(4) + 'T23:00:00' }), // tagged concert → hidden
  radar('thr', 'Berlin Stage Days', 41, 44, { category: 'theater', lat: 52.52, lng: 13.4 }),
  radar('mus', 'Soon Sound', 10, 12, { lat: 46.5, lng: 11.3 }),
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
const state = { requests: [], failApi: false };
let base = '';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const PAGE_SIZE = 2;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/events') {
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
    const slice = EVENTS.slice(offset, offset + PAGE_SIZE);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events: slice, offset, count: slice.length, has_more: offset + PAGE_SIZE < EVENTS.length }));
    return;
  }
  const name = url.pathname.replace(/^\//, '');
  if (!['festivals.html', 'shared.js', 'festivals.js'].includes(name)) {
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

  // ── 6. optional: the Leaflet map (needs internet) ────────────────────────────
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
