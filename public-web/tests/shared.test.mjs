// public-web/tests/shared.test.mjs
import { createRequire } from 'module';
const { fmtRange, escHtml, safeUrl, buildQueryUrl, formatLocalDateTime } =
  createRequire(import.meta.url)('../shared.js');
import assert from 'node:assert/strict';

// ── fmtRange ──────────────────────────────────────────────────────────────────
{ assert.equal(fmtRange(null, null), 'Date not specified');
  console.log('✅ fmtRange: null start → "Date not specified"'); }

{ assert.equal(fmtRange('2026-03-15', null), '15.03.2026');
  console.log('✅ fmtRange: date-only, no end → DD.MM.YYYY'); }

{ assert.equal(fmtRange('2026-03-15T21:00:00', null), '15.03.2026 9pm');
  console.log('✅ fmtRange: datetime, no end → DD.MM.YYYY Hpm'); }

{ assert.equal(fmtRange('2026-03-15T21:00:00', '2026-03-15T23:00:00'), '15.03.2026 9pm–11pm');
  console.log('✅ fmtRange: same-day with time → DD.MM.YYYY start–end'); }

{ // overnight: ends next day before noon, duration < 24 h
  assert.equal(fmtRange('2026-03-15T23:00:00', '2026-03-16T01:00:00'), '15.03.2026 11pm–1am');
  console.log('✅ fmtRange: overnight treated as same evening'); }

{ assert.equal(fmtRange('2026-03-15T18:00:00', '2026-03-20T23:00:00'), '15.03–20.03.2026');
  console.log('✅ fmtRange: different days same year → DD.MM–DD.MM.YYYY'); }

{ assert.equal(fmtRange('2026-12-30T18:00:00', '2027-01-02T23:00:00'), '30.12.2026–02.01.2027');
  console.log('✅ fmtRange: different years → DD.MM.YYYY–DD.MM.YYYY'); }

// ── escHtml ───────────────────────────────────────────────────────────────────
{ assert.equal(escHtml('<b>"hi"</b>'), '&lt;b&gt;&quot;hi&quot;&lt;/b&gt;');
  console.log('✅ escHtml: escapes < > "'); }

{ assert.equal(escHtml(null), '');
  assert.equal(escHtml(''), '');
  console.log('✅ escHtml: null/empty → ""'); }

// ── safeUrl ───────────────────────────────────────────────────────────────────
{ assert.equal(safeUrl('https://example.com'), 'https://example.com');
  assert.equal(safeUrl('http://example.com'), 'http://example.com');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl(null), null);
  console.log('✅ safeUrl: allows http(s), rejects others, null'); }

// ── buildQueryUrl ─────────────────────────────────────────────────────────────
{ const url = buildQueryUrl('https://api.example.com', {
    lat: '46.0637', lng: '13.2353', radius: '100',
    from: '2026-04-15T00:00:00', to: '2026-04-22T23:59:59',
  });
  assert.ok(url.startsWith('https://api.example.com/events?'));
  assert.ok(url.includes('lat=46.0637'));
  assert.ok(url.includes('lng=13.2353'));
  assert.ok(url.includes('radius=100'));
  assert.ok(!url.includes('category'));
  console.log('✅ buildQueryUrl: basic params, no category'); }

{ const url = buildQueryUrl('https://api.example.com', {
    lat: '46.0637', lng: '13.2353', radius: '50',
    from: '2026-04-15T00:00:00', to: '2026-04-22T23:59:59',
    category: 'music',
  });
  assert.ok(url.includes('category=music'));
  console.log('✅ buildQueryUrl: includes category when provided'); }

// ── formatLocalDateTime ───────────────────────────────────────────────────────
{ const d = new Date(2026, 2, 15, 21, 30, 5); // local: 2026-03-15T21:30:05
  assert.equal(formatLocalDateTime(d), '2026-03-15T21:30:05');
  console.log('✅ formatLocalDateTime: formats correctly'); }

console.log('\n✅ All shared.js tests passed');
