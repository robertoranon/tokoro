// Guards the deploy step: every public HTML page that contains the worker-URL
// placeholder must be rewritten by inject-worker-url.js, otherwise the page
// ships with a literal "__TOKORO_WORKER_URL__" and cannot reach the API.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-test-'));

try {
  const pages = fs.readdirSync(PUBLIC_WEB).filter(f => f.endsWith('.html'));
  for (const f of pages) fs.copyFileSync(path.join(PUBLIC_WEB, f), path.join(tmp, f));

  // args: worker-url crawler-url relay-url target-dir build-version
  execFileSync(
    'node',
    [path.join(PUBLIC_WEB, 'inject-worker-url.js'), 'https://worker.example', '', '', tmp, 'test-build'],
    { stdio: 'pipe' }
  );

  for (const f of pages) {
    const content = fs.readFileSync(path.join(tmp, f), 'utf8');
    assert.ok(
      !content.includes('__TOKORO_WORKER_URL__'),
      `${f} still contains __TOKORO_WORKER_URL__ after injection — add it to ALL_FILES in inject-worker-url.js`
    );
    assert.ok(!content.includes('__BUILD_VERSION__'), `${f} still contains __BUILD_VERSION__`);
  }
  console.log(`✅ inject: no worker/build placeholder left in any of ${pages.length} HTML pages`);

  const festivals = fs.readFileSync(path.join(tmp, 'festivals.html'), 'utf8');
  assert.ok(festivals.includes("const API_URL = 'https://worker.example';"));
  assert.ok(festivals.includes('<!-- build: test-build -->'));
  console.log('✅ inject: festivals.html gets the worker URL and the build version');

  const tours = fs.readFileSync(path.join(tmp, 'tours.html'), 'utf8');
  assert.ok(tours.includes("const API_URL = 'https://worker.example';"));
  assert.ok(tours.includes('<!-- build: test-build -->'));
  console.log('✅ inject: tours.html gets the worker URL and the build version');

  // Leaflet comes from unpkg: every tag that loads it is pinned with SRI.
  const LEAFLET_SRI = {
    'leaflet.js': 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=',
    'leaflet.css': 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=',
  };
  const htmlFiles = [
    ...pages.map(f => path.join(PUBLIC_WEB, f)),
    path.resolve(PUBLIC_WEB, '..', 'web-publisher', 'index.html'),
    path.resolve(PUBLIC_WEB, '..', 'admin', 'admin.html'),
  ];
  let leafletTags = 0;
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    for (const m of html.matchAll(/<(?:link|script)\b[^>]*unpkg\.com\/leaflet[^>]*>/g)) {
      leafletTags++;
      const tag = m[0];
      const name = /leaflet\.(?:js|css)/.exec(tag)[0];
      assert.ok(tag.includes('leaflet@1.9.4/'), `${file}: Leaflet must be pinned to 1.9.4: ${tag}`);
      assert.ok(
        tag.includes(`integrity="${LEAFLET_SRI[name]}"`),
        `${file}: ${name} needs integrity="${LEAFLET_SRI[name]}"`
      );
      assert.ok(/\scrossorigin=""/.test(tag), `${file}: ${name} needs crossorigin=""`);
    }
  }
  assert.ok(leafletTags >= 8, `expected at least 8 Leaflet tags, found ${leafletTags}`);
  console.log(`✅ sri: all ${leafletTags} Leaflet tags carry integrity and crossorigin`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
