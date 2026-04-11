#!/usr/bin/env node
/**
 * Build script for the Tokoro bookmarklet.
 *
 * Reads bookmarklet.src.js, substitutes placeholders, minifies the result,
 * and injects it into the <script type="text/x-bookmarklet"> tag in index.html
 * and it.html. Also injects the worker API URL into both HTML files.
 *
 * Usage:
 *   node build-bookmarklet.js
 *
 * Requires config.local.js at the project root (copy from config.local.js.example).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Configuration ────────────────────────────────────────────────────────────
let config;
try {
  config = require('../config.local.js');
} catch (e) {
  console.error('ERROR: config.local.js not found.');
  console.error('Copy config.local.js.example to config.local.js and fill in your values.');
  process.exit(1);
}

const RELAY_URL        = config.relayUrl;
const DEFAULT_WORKER   = config.crawlerWorkerUrl;
const DEFAULT_API_KEY  = config.crawlerApiKey;
const API_URL          = config.workerUrl;
// ─────────────────────────────────────────────────────────────────────────────

const SRC_FILE   = path.join(__dirname, 'bookmarklet.src.js');
const HTML_FILE  = path.join(__dirname, 'index.html');
const IT_HTML    = path.join(__dirname, 'it.html');

// Read source
let src = fs.readFileSync(SRC_FILE, 'utf8');

// Substitute placeholders
src = src.replace(/__RELAY_URL__/g, RELAY_URL);
src = src.replace(/__DEFAULT_WORKER__/g, DEFAULT_WORKER);
src = src.replace(/__DEFAULT_API_KEY__/g, DEFAULT_API_KEY);
src = src.replace(/__DEFAULT_API_URL__/g, API_URL);

// Minify: strip comments, collapse whitespace
function minify(code) {
  // Remove block comments /* ... */
  code = code.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove line comments // ... (negative lookbehind avoids matching http://)
  code = code.replace(/(?<![:/])\/\/[^\n]*/g, '');
  // Collapse all whitespace (newlines, tabs, multiple spaces) to a single space
  code = code.replace(/\s+/g, ' ');
  return code.trim();
}

const minified = minify(src);

// Inject bookmarklet into index.html and it.html
const OPEN_TAG  = '<script type="text/x-bookmarklet" id="bm-src">';
const CLOSE_TAG = '</script>';

for (const f of [HTML_FILE, IT_HTML]) {
  let html = fs.readFileSync(f, 'utf8');

  const openIdx  = html.indexOf(OPEN_TAG);
  const closeIdx = html.indexOf(CLOSE_TAG, openIdx + OPEN_TAG.length);

  if (openIdx === -1 || closeIdx === -1) {
    console.error(`ERROR: Could not find <script type="text/x-bookmarklet" id="bm-src"> in ${path.basename(f)}`);
    process.exit(1);
  }

  html =
    html.slice(0, openIdx + OPEN_TAG.length) +
    '\n    ' + minified + '\n  ' +
    html.slice(closeIdx);

  fs.writeFileSync(f, html, 'utf8');
  console.log(`Bookmarklet built: ${minified.length} chars injected into ${path.basename(f)}`);
}

// Inject API_URL placeholder into both HTML files
for (const f of [HTML_FILE, IT_HTML]) {
  let content = fs.readFileSync(f, 'utf8');
  const updated = content.replace(/__TOKORO_WORKER_URL__/g, API_URL);
  if (updated === content) {
    console.warn(`Warning: __TOKORO_WORKER_URL__ placeholder not found in ${path.basename(f)}`);
  } else {
    fs.writeFileSync(f, updated, 'utf8');
    console.log(`Worker URL injected into ${path.basename(f)}`);
  }
}
