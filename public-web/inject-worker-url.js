#!/usr/bin/env node
/**
 * Deploy-time script: replaces __TOKORO_WORKER_URL__ in all HTML files.
 *
 * This is intentionally separate from build-bookmarklet.js so that running
 * the bookmarklet build locally never clobbers the placeholder in source.
 *
 * Usage:
 *   node inject-worker-url.js <worker-url>
 *
 * Example:
 *   node inject-worker-url.js https://happenings-worker.example.workers.dev
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const workerUrl = process.argv[2];
if (!workerUrl) {
  console.error('ERROR: worker URL argument required.');
  console.error('Usage: node inject-worker-url.js <worker-url>');
  process.exit(1);
}

const HTML_FILES = ['index.html', 'it.html', 'map.html'].map(f => path.join(__dirname, f));

for (const f of HTML_FILES) {
  const content = fs.readFileSync(f, 'utf8');
  const updated = content.replace(/__TOKORO_WORKER_URL__/g, workerUrl);
  if (updated === content) {
    console.warn(`Warning: __TOKORO_WORKER_URL__ placeholder not found in ${path.basename(f)}`);
  } else {
    fs.writeFileSync(f, updated, 'utf8');
    console.log(`Worker URL injected into ${path.basename(f)}`);
  }
}
