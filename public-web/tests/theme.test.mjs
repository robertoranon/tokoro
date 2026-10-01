// Guards the "sunny sticker" theme: every page links theme.css after its inline
// <style>, no leftover dark-theme colors, the yellow accent is never a text color,
// and the JS category colors match the --cat-* tokens in theme.css.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const PAGES = [
  'index.html',
  'it.html',
  'map.html',
  'festivals.html',
  'publish.html',
  'privacy-policy.html',
];
const theme = read('theme.css');

// 1. tokens exist
for (const t of [
  'bg',
  'surface',
  'ink',
  'accent',
  'accent-2',
  'link',
  'stroke',
  'line',
]) {
  assert.ok(
    new RegExp(`--${t}\\s*:`).test(theme),
    `theme.css must define --${t}`
  );
}
console.log('✅ theme: tokens defined');

// 2. every page links theme.css after its last inline </style>
for (const p of PAGES) {
  const html = read(p);
  const styleEnd = html.lastIndexOf('</style>');
  const link = html.indexOf('href="theme.css"');
  assert.ok(
    styleEnd >= 0 && link > styleEnd,
    `${p} must link theme.css after its inline <style>`
  );
}
console.log(
  `✅ theme: theme.css linked after inline CSS in ${PAGES.length} pages`
);

// 3. no legacy dark palette anywhere in pages or page scripts
const LEGACY =
  /#(?:111a24|192534|0a1520|142030|0c1a30|243445|e8f4fb|8aafc4|5a7a8e|7f9db0|22d3ee|0891b2|67e8f9|1e2e3e|3a5060)\b|rgba\(\s*34,\s*211,\s*238/i;
for (const f of [...PAGES, 'query.js', 'festivals.js', 'shared.js']) {
  const line = read(f)
    .split('\n')
    .findIndex(l => LEGACY.test(l));
  assert.equal(
    line,
    -1,
    `${f}:${line + 1} still uses a legacy dark-theme color`
  );
}
console.log('✅ theme: no legacy dark-theme colors');

// 4. the yellow accent is a fill, never a text color (unreadable on cream)
const TEXT_ACCENT = /(?<![-\w])color:\s*var\(--accent(?:-hover)?\)/;
for (const p of PAGES) {
  const line = read(p)
    .split('\n')
    .findIndex(l => TEXT_ACCENT.test(l));
  assert.equal(
    line,
    -1,
    `${p}:${line + 1} uses --accent as a text color; use --link`
  );
}
console.log('✅ theme: --accent never used as text color');

// 5. JS CAT_COLORS agree with the --cat-* tokens
const tokens = Object.fromEntries(
  [...theme.matchAll(/--cat-([a-z]+):\s*(#[0-9a-f]{6})/gi)].map(m => [
    m[1],
    m[2].toLowerCase(),
  ])
);
assert.ok(
  Object.keys(tokens).length === 13,
  'theme.css must define 13 --cat-* tokens'
);
for (const f of ['query.js', 'map.html', 'festivals.html']) {
  const m = read(f).match(/const CAT_COLORS = \{([\s\S]*?)\};/);
  assert.ok(m, `${f} must define CAT_COLORS`);
  for (const [, k, v] of m[1].matchAll(/(\w+):\s*'(#[0-9a-f]{6})'/gi)) {
    assert.equal(
      v.toLowerCase(),
      tokens[k],
      `${f} CAT_COLORS.${k} differs from --cat-${k}`
    );
  }
}
console.log(
  '✅ theme: CAT_COLORS match --cat-* tokens in query.js, map.html, festivals.html'
);

// 6. theme.css owns every design token; pages must not redeclare :root
for (const p of PAGES) {
  assert.ok(
    !read(p).includes(':root'),
    `${p} declares :root; design tokens live only in theme.css`
  );
}
console.log('✅ theme: no inline :root token blocks in pages');
