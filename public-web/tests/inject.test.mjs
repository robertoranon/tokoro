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
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
