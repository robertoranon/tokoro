#!/usr/bin/env node
/**
 * Deploy-time script: replaces __TOKORO_WORKER_URL__ and __DEFAULT_CRAWLER_URL__
 * in all HTML files.
 *
 * This is intentionally separate from build-bookmarklet.js so that running
 * the bookmarklet build locally never clobbers placeholders in source.
 *
 * Usage:
 *   node inject-worker-url.js <worker-url> <crawler-url>
 *
 * Example:
 *   node inject-worker-url.js \
 *     https://happenings-worker.example.workers.dev \
 *     https://happenings-crawler-worker.example.workers.dev
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const workerUrl  = process.argv[2];
const crawlerUrl = process.argv[3];

if (!workerUrl) {
  console.error('ERROR: worker URL argument required.');
  console.error('Usage: node inject-worker-url.js <worker-url> [<crawler-url>]');
  process.exit(1);
}

const HTML_FILES = ['index.html', 'it.html', 'map.html'].map(f => path.join(__dirname, f));

for (const f of HTML_FILES) {
  let content = fs.readFileSync(f, 'utf8');

  const afterWorker = content.replace(/__TOKORO_WORKER_URL__/g, workerUrl);
  if (afterWorker === content) {
    console.warn(`Warning: __TOKORO_WORKER_URL__ placeholder not found in ${path.basename(f)}`);
  } else {
    content = afterWorker;
    console.log(`Worker URL injected into ${path.basename(f)}`);
  }

  if (crawlerUrl) {
    const afterCrawler = content.replace(/__DEFAULT_CRAWLER_URL__/g, crawlerUrl);
    if (afterCrawler === content) {
      console.warn(`Warning: __DEFAULT_CRAWLER_URL__ placeholder not found in ${path.basename(f)}`);
    } else {
      content = afterCrawler;
      console.log(`Crawler URL injected into ${path.basename(f)}`);
    }
  }

  fs.writeFileSync(f, content, 'utf8');
}
