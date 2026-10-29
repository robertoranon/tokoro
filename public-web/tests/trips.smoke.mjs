// Offline smoke test for trips.html.
// Run from the repo root:  node public-web/tests/trips.smoke.mjs
// Needs Playwright's Chromium (installed with the crawler). Uses only 127.0.0.1.
// Optional: TRIPS_SMOKE_MAP=1 also checks the Leaflet map (needs internet for the CDN).
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
const bandUrl = band => `https://${band.toLowerCase()}.example`;
const show = (id, band, off, place, lat, lng) => ({
  id,
  title: band + ' live',
  act_name: band,
  act_url: bandUrl(band),
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
  created_at: '2030-01-01T00:00:00',
});
const EVENTS = [
  show('a1', 'Alpha', 12, 'Udine', 46.06, 13.23),
  show('b1', 'Beta', 14, 'Udine', 46.07, 13.24),
  show('g1', 'Gamma', 16, 'Udine', 46.05, 13.22),
  show('d1', 'Delta', 13, 'Berlin', 52.52, 13.4),
  {
    id: 'f1',
    title: 'Fest Uno',
    festival_name: 'Fest Uno',
    festival_url: 'https://festuno.example',
    url: 'https://festuno.example',
    description: '',
    venue_name: 'Park',
    address: 'Gorizia',
    lat: 45.94,
    lng: 13.62,
    start_time: day(40) + 'T00:00:00',
    end_time: day(42) + 'T23:59:59',
    category: 'music',
    tags: ['festival'],
    created_at: '2030-01-01T00:00:00',
  },
];
const FOLLOW_ALL = ['Alpha', 'Beta', 'Gamma', 'Delta'].map(bandUrl);

// ── one local server: static page files + fake paged API ──────────────────────
const state = {
  requests: [], // every /events request url
  memberRequests: [],
  memberMe: null, // null → 403; else the /member/me body
  staticRequests: [],
};
let base = '';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const PAGE_SIZE = 100;
const STATIC = [
  'trips.html',
  'shared.js',
  'tours.js',
  'festivals.js',
  'trips.js',
  'trips-worker.js',
  'member.js',
  'theme.css',
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/member/')) {
    state.memberRequests.push(req.method + ' ' + url.pathname);
    for await (const _ of req);
    if (url.pathname === '/member/me' && state.memberMe) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.memberMe));
      return;
    }
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end('{"error":"Forbidden"}');
    return;
  }
  if (url.pathname === '/events') {
    state.requests.push(req.url);
    let list = EVENTS;
    if (url.searchParams.get('has_act') === '1')
      list = list.filter(e => e.act_url);
    if (url.searchParams.get('has_festival') === '1')
      list = list.filter(e => e.festival_url);
    const offset = Number(url.searchParams.get('offset') || 0);
    const slice = list.slice(offset, offset + PAGE_SIZE);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        events: slice,
        offset,
        count: slice.length,
        has_more: offset + PAGE_SIZE < list.length,
      })
    );
    return;
  }
  state.staticRequests.push(url.pathname);
  const name = url.pathname.replace(/^\//, '');
  if (!STATIC.includes(name)) {
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
const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString(
  'base64url'
);
async function newPage(
  browser,
  { allowExternal = false, storedSeed = null } = {}
) {
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
  if (storedSeed)
    await page.addInitScript(
      s => localStorage.setItem('tokoro_member', s),
      storedSeed
    );
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
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  return { page, context, errors };
}
const statusText = page => page.textContent('#status');
async function waitStatus(page, re) {
  try {
    await page.waitForFunction(
      src =>
        new RegExp(src).test(document.getElementById('status').textContent),
      re.source,
      { timeout: 8000 }
    );
  } catch {}
  return statusText(page);
}
const firstSummary = page =>
  page.locator('#tripList details summary').first().textContent();
const listText = page => page.textContent('#tripList');
const MEMBERS_NOTE =
  'The trip planner is for members. Open your personal link.';

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

  // 1. no link, no stored seed
  {
    state.requests.length = 0;
    const { page, context, errors } = await newPage(browser);
    const res = await page.goto(base + '/trips.html');
    check('page is served', res && res.ok(), res && res.status());
    await page.waitForLoadState('networkidle');
    await page
      .waitForFunction(
        () => document.getElementById('memberNote').textContent.length > 0,
        null,
        {
          timeout: 5000,
        }
      )
      .catch(() => {});
    check(
      'no link: members note shown',
      (await page.isVisible('#memberNote')) &&
        (await page.textContent('#memberNote')).trim() === MEMBERS_NOTE,
      await page.textContent('#memberNote').catch(() => null)
    );
    check('no link: planner hidden', await page.isHidden('#planner'));
    check(
      'no link: no /events request',
      state.requests.length === 0,
      state.requests
    );
    check('no link: no page errors', errors.length === 0, errors);
    await context.close();
  }

  // 2. inactive link
  {
    state.memberMe = null;
    state.requests.length = 0;
    const { page, context } = await newPage(browser);
    await page.goto(base + '/trips.html#k=' + seed);
    await page
      .waitForFunction(
        () => document.getElementById('memberNote').textContent.length > 0,
        null,
        {
          timeout: 5000,
        }
      )
      .catch(() => {});
    const note = await page.textContent('#memberNote');
    check(
      'inactive link: "no longer active" note',
      note.includes(
        'This personal link is no longer active. Ask for a new one.'
      ),
      note
    );
    check('inactive link: planner hidden', await page.isHidden('#planner'));
    check(
      'inactive link: no /events request',
      state.requests.length === 0,
      state.requests
    );
    await context.close();
  }

  // 3. member following nothing
  {
    state.memberMe = {
      name: 'Anna',
      bands: [],
      festivals: [],
      suggestions: [],
    };
    const { page, context, errors } = await newPage(browser);
    await page.goto(base + '/trips.html#k=' + seed);
    const st = await waitStatus(page, /Follow some/);
    check(
      'following nothing: "Follow some…" status',
      st === 'Follow some bands or festivals on Tours or Festivals first.',
      st
    );
    check(
      'following nothing: planner visible',
      await page.isVisible('#planner')
    );
    check('following nothing: no page errors', errors.length === 0, errors);
    await context.close();
  }

  // 4. member following a band without shows (no festivals field: old server)
  {
    state.memberMe = {
      name: 'Anna',
      bands: ['https://nobody.example'],
      suggestions: [],
    };
    const { page, context, errors } = await newPage(browser);
    await page.goto(base + '/trips.html#k=' + seed);
    const st = await waitStatus(page, /No trip/);
    check(
      'follows without data: "No trip found…" status',
      st ===
        'No trip found with these settings. Try a larger radius or a longer trip.',
      st
    );
    check('follows without data: no page errors', errors.length === 0, errors);
    await context.close();
  }

  // 5. member with results
  state.memberMe = {
    name: 'Anna',
    bands: FOLLOW_ALL,
    festivals: ['https://festuno.example/'],
    suggestions: [],
  };
  let quickText = '';
  {
    state.requests.length = 0;
    const { page, context, errors } = await newPage(browser);
    await page.goto(base + '/trips.html#k=' + seed);
    await page
      .waitForSelector('#tripList details', { timeout: 8000 })
      .catch(() => {});
    check(
      'member: link fragment removed from the address bar',
      !page.url().includes('#k='),
      page.url()
    );
    check(
      'member: seed stored as tokoro_member',
      (await page.evaluate(() => localStorage.getItem('tokoro_member'))) ===
        seed
    );
    check(
      'member: both sources loaded (has_act and has_festival)',
      state.requests.some(u => u.includes('has_act=1')) &&
        state.requests.some(u => u.includes('has_festival=1')),
      state.requests
    );
    const count = await page.locator('#tripList details').count();
    check('member: at least one trip', count >= 1, count);
    check(
      'member: status counts the trips',
      /^\d+ trips?$/.test(await statusText(page)),
      await statusText(page)
    );
    const sum = count ? await firstSummary(page) : '';
    check('member: first trip sees 3 bands', sum.includes('3 bands'), sum);
    if (count) {
      await page.locator('#tripList details summary').first().click();
      const stops = page
        .locator('#tripList details')
        .first()
        .locator('.trip-stop');
      check(
        'member: opening it lists three itinerary days',
        (await stops.count()) === 3,
        await stops.count()
      );
      const stopText = await page
        .locator('#tripList details')
        .first()
        .textContent();
      check(
        'member: itinerary shows names, venue · address and links',
        ['Alpha', 'Beta', 'Gamma', 'Club a1 · Udine'].every(s =>
          stopText.includes(s)
        ) &&
          (await page
            .locator('#tripList details')
            .first()
            .locator('a[href="https://tickets.example/a1"]')
            .count()) === 1,
        stopText
      );
    }

    // quick radius changes: only the last settings win
    await page.selectOption('#radius', '25');
    await page.selectOption('#radius', '1000');
    try {
      await page.waitForFunction(
        () => {
          const s = document.querySelector('#tripList details summary');
          return s && s.textContent.includes('4 bands');
        },
        null,
        { timeout: 8000 }
      );
    } catch {}
    await new Promise(r => setTimeout(r, 1000)); // a stale reply would land now
    quickText = await listText(page);
    check(
      'radius 1000: the first trip sees 4 bands',
      quickText.includes('4 bands'),
      quickText
    );

    // region: within 500 km of Udine leaves Berlin out; "Anywhere" brings it back
    const firstHas = async text => {
      try {
        await page.waitForFunction(
          t => {
            const s = document.querySelector('#tripList details summary');
            return s && s.textContent.includes(t);
          },
          text,
          { timeout: 8000 }
        );
      } catch {}
      return (await firstSummary(page)) || '';
    };
    await page.fill('#regionPlace', 'Udine');
    await page.press('#regionPlace', 'Enter');
    let rsum = await firstHas('3 bands');
    check(
      'region Udine 500 km: Berlin is left out',
      rsum.includes('3 bands'),
      rsum
    );
    await page.click('#regionClear');
    rsum = await firstHas('4 bands');
    check('region cleared: Berlin is back', rsum.includes('4 bands'), rsum);
    await page.route('**/nominatim.openstreetmap.org/**', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: '[]',
      })
    );
    await page.fill('#regionPlace', 'Nowhere');
    await page.press('#regionPlace', 'Enter');
    await new Promise(r => setTimeout(r, 800));
    check(
      'region not found: notice shown, region off',
      (await page.textContent('#noticeLine')).includes('Could not find') &&
        (await firstSummary(page)).includes('4 bands'),
      await page.textContent('#noticeLine')
    );
    await page.click('#regionClear');

    // "On the move" mode
    await page.click('#modeHops');
    await new Promise(r => setTimeout(r, 400));
    await waitStatus(page, /^\d+ trips?$/);
    check(
      'hops mode: toggles pressed and trips found',
      (await page.getAttribute('#modeHops', 'aria-pressed')) === 'true' &&
        (await page.getAttribute('#modeBase', 'aria-pressed')) === 'false' &&
        (await page.locator('#tripList details').count()) >= 1,
      await statusText(page)
    );

    // source festivals: no band request
    const actBefore = state.requests.filter(u =>
      u.includes('has_act=1')
    ).length;
    await page.selectOption('#source', 'festivals');
    const st = await waitStatus(page, /No trip/);
    check(
      'source festivals: one festival alone is no trip',
      st.startsWith('No trip found'),
      st
    );
    check(
      'source festivals: no has_act request after the change',
      state.requests.filter(u => u.includes('has_act=1')).length === actBefore,
      state.requests
    );
    check('member: no page errors', errors.length === 0, errors);
    await context.close();
  }

  // 6. fresh load at 1000 matches the quick changes
  {
    const { page, context } = await newPage(browser, { storedSeed: seed });
    await page.goto(base + '/trips.html');
    await page
      .waitForSelector('#tripList details', { timeout: 8000 })
      .catch(() => {});
    await page.selectOption('#radius', '1000');
    try {
      await page.waitForFunction(
        () => {
          const s = document.querySelector('#tripList details summary');
          return s && s.textContent.includes('4 bands');
        },
        null,
        { timeout: 8000 }
      );
    } catch {}
    await new Promise(r => setTimeout(r, 500));
    const fresh = await listText(page);
    check(
      'quick radius changes: final list equals a fresh load at 1000',
      fresh === quickText,
      [fresh, quickText]
    );
    check('stored seed: works without the link', true);
    await context.close();
  }

  // 7. worker unavailable: computed on the main thread
  {
    const { page, context, errors } = await newPage(browser, {
      storedSeed: seed,
    });
    await page.route('**/trips-worker.js', r => r.abort());
    await page.goto(base + '/trips.html');
    await page
      .waitForSelector('#tripList details', { timeout: 8000 })
      .catch(() => {});
    const count = await page.locator('#tripList details').count();
    check(
      'worker blocked: results still appear',
      count >= 1,
      await statusText(page)
    );
    check('worker blocked: no page errors', errors.length === 0, errors);
    await context.close();
  }

  // 8. optional: the Leaflet map (needs internet)
  if (process.env.TRIPS_SMOKE_MAP === '1') {
    const { page, context } = await newPage(browser, {
      allowExternal: true,
      storedSeed: seed,
    });
    await page.goto(base + '/trips.html');
    await page.waitForSelector('#tripList details');
    await page.locator('#tripList details summary').first().click();
    await page
      .waitForSelector('#map .trip-pin', { timeout: 8000 })
      .catch(() => {});
    check(
      'map: the opened trip is drawn with 3 numbered pins',
      (await page.locator('#map .trip-pin').count()) === 3
    );
    check(
      'map: base mode draws the radius circle',
      (await page.locator('#map path.leaflet-interactive').count()) >= 1
    );
    await context.close();
  } else {
    console.log(
      'SKIP  map checks (set TRIPS_SMOKE_MAP=1 with internet access to run them)'
    );
  }
} finally {
  if (browser) await browser.close();
  server.close();
}

console.log(
  failures === 0 ? '\nAll trips smoke checks passed' : `\n${failures} FAILURES`
);
process.exit(failures === 0 ? 0 : 1);
