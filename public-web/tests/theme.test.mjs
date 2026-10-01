// Guards the "bold per-page colour" theme: every page links theme.css after its
// inline <style>, no leftover dark-theme colors, and the JS category colors
// match the --cat-* tokens in theme.css.
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
  'ink',
  'paper',
  'blue',
  'lime',
  'violet',
  'orange',
  'yellow',
  'page',
  'stroke',
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

// 7. each page declares its colour and loads the new fonts
const PAGE_KEY = {
  'index.html': 'browse',
  'it.html': 'browse',
  'festivals.html': 'festivals',
  'map.html': 'map',
  'publish.html': 'publish',
  'privacy-policy.html': 'privacy',
};
for (const [p, key] of Object.entries(PAGE_KEY)) {
  const html = read(p);
  assert.ok(
    new RegExp(`<body[^>]*data-page="${key}"`).test(html),
    `${p} must have <body data-page="${key}">`
  );
  assert.ok(html.includes('family=Archivo'), `${p} must load Archivo`);
  assert.ok(html.includes('family=Poppins'), `${p} must load Poppins`);
  assert.ok(!html.includes('Figtree'), `${p} still references Figtree`);
  assert.ok(html.includes('class="ticker"'), `${p} must include the ticker`);
  assert.ok(html.includes('class="site-bar"'), `${p} must include the nav bar`);
}
for (const key of new Set(Object.values(PAGE_KEY))) {
  assert.ok(
    theme.includes(`body[data-page='${key}']`),
    `theme.css must set --page for ${key}`
  );
}
console.log('✅ theme: pages declare data-page, fonts, ticker and nav bar');

// 8. motion safety and shape rules
assert.ok(
  theme.includes('prefers-reduced-motion'),
  'theme.css must honour prefers-reduced-motion'
);
for (const m of theme.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?\n\})/g)) {
  if (m[2].includes('opacity')) {
    assert.ok(
      /to\s*\{[^}]*opacity/.test(m[2]),
      `@keyframes ${m[1]} animates opacity in "from" only; add it to "to"`
    );
  }
}
assert.ok(!/box-shadow:[^;]*blur/.test(theme), 'no soft shadows');
console.log('✅ theme: reduced-motion honoured, keyframes safe');

// 9. the radar is a separate site section: no cross links either way
for (const p of PAGES) {
  const links = [...read(p).matchAll(/<a[^>]+href="([^"]+)"/g)].map(m => m[1]);
  if (p === 'festivals.html') {
    const out = links.filter(h =>
      /(?:^|\/)(?:index|it|map|publish|privacy-policy)\.html/.test(h)
    );
    assert.deepEqual(out, [], `festivals.html must not link out: ${out}`);
  } else {
    assert.ok(
      !links.some(h => /(?:^|\/)festivals\.html/.test(h)),
      `${p} must not link to festivals.html`
    );
  }
}
console.log('✅ theme: radar page is not cross-linked with the other pages');

// 10. no magenta page backgrounds, and each page has its own ticker text
assert.ok(!/magenta|#ff29ff/i.test(theme), 'magenta is not used');
const tickers = PAGES.map(p => {
  const m = read(p).match(/<div class="ticker__track">([\s\S]*?)<\/div>/);
  assert.ok(m, `${p} must have ticker text`);
  assert.ok(
    !/Follow people|Publish a festival/i.test(m[1]),
    `${p} ticker uses retired phrases`
  );
  return m[1].replace(/\s+/g, ' ');
});
for (const a of ['index.html', 'map.html', 'festivals.html']) {
  const others = ['index.html', 'map.html', 'festivals.html'].filter(
    b => b !== a
  );
  for (const b of others)
    assert.notEqual(
      tickers[PAGES.indexOf(a)],
      tickers[PAGES.indexOf(b)],
      `${a} and ${b} must have different tickers`
    );
}
console.log('✅ theme: no magenta; Browse, Map and Radar tickers differ');
