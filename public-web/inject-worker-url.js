#!/usr/bin/env node
/**
 * Deploy-time script: replaces placeholders in all HTML files.
 *
 * Handles:
 *   __TOKORO_WORKER_URL__    — API worker URL
 *   __DEFAULT_CRAWLER_URL__  — crawler worker URL
 *   __BOOKMARKLET__          — built bookmarklet code (from bookmarklet.src.js + relay URL)
 *
 * This is intentionally separate from build-bookmarklet.js so that running
 * the bookmarklet build locally never clobbers placeholders in source.
 *
 * Usage:
 *   node inject-worker-url.js <worker-url> <crawler-url> <relay-url>
 *
 * Example:
 *   node inject-worker-url.js \
 *     https://tokoro-worker.example.workers.dev \
 *     https://tokoro-crawler-worker.example.workers.dev \
 *     https://tokoro-query.pages.dev/
 */

'use strict';

const fs = require('fs');
const path = require('path');

const workerUrl = process.argv[2];
const crawlerUrl = process.argv[3];
const relayUrl = process.argv[4];
const targetDir = process.argv[5] || __dirname;
const buildVersion = process.argv[6] || 'dev';

if (!workerUrl) {
  console.error('ERROR: worker URL argument required.');
  console.error(
    'Usage: node inject-worker-url.js <worker-url> [<crawler-url>] [<relay-url>] [<target-dir>]'
  );
  process.exit(1);
}

// map.html has no relay UI and therefore no crawler/bookmarklet placeholders
const ALL_FILES = ['index.html', 'it.html', 'map.html', 'publish.html'].map(f =>
  path.join(targetDir, f)
);
const RELAY_FILES = ['index.html', 'it.html'].map(f => path.join(targetDir, f));

// Build bookmarklet if relay URL is provided
let bookmarklet = null;
if (relayUrl) {
  const srcFile = path.join(__dirname, 'bookmarklet.src.js');
  let src = fs.readFileSync(srcFile, 'utf8');
  src = src.replace(/__RELAY_URL__/g, relayUrl);

  function minify(code) {
    code = code.replace(/\/\*[\s\S]*?\*\//g, '');
    code = code.replace(/(?<![:/])\/\/[^\n]*/g, '');
    code = code.replace(/\s+/g, ' ');
    return code.trim();
  }

  bookmarklet = minify(src);
  console.log(`Bookmarklet built: ${bookmarklet.length} chars`);
}

for (const f of ALL_FILES) {
  let content = fs.readFileSync(f, 'utf8');

  const afterWorker = content.replace(/__TOKORO_WORKER_URL__/g, workerUrl);
  if (afterWorker === content) {
    console.warn(
      `Warning: __TOKORO_WORKER_URL__ placeholder not found in ${path.basename(f)}`
    );
  } else {
    content = afterWorker;
    console.log(`Worker URL injected into ${path.basename(f)}`);
  }

  if (crawlerUrl && RELAY_FILES.includes(f)) {
    const afterCrawler = content.replace(
      /__DEFAULT_CRAWLER_URL__/g,
      crawlerUrl
    );
    if (afterCrawler === content) {
      console.warn(
        `Warning: __DEFAULT_CRAWLER_URL__ placeholder not found in ${path.basename(f)}`
      );
    } else {
      content = afterCrawler;
      console.log(`Crawler URL injected into ${path.basename(f)}`);
    }
  }

  if (bookmarklet && RELAY_FILES.includes(f)) {
    const afterBm = content.replace(/__BOOKMARKLET__/g, bookmarklet);
    if (afterBm === content) {
      console.warn(
        `Warning: __BOOKMARKLET__ placeholder not found in ${path.basename(f)}`
      );
    } else {
      content = afterBm;
      console.log(`Bookmarklet injected into ${path.basename(f)}`);
    }
  }

  content = content.replace(/__BUILD_VERSION__/g, buildVersion);

  fs.writeFileSync(f, content, 'utf8');
}
