#!/usr/bin/env node
/**
 * Build script for the Tokoro bookmarklet.
 *
 * Reads bookmarklet.src.js, substitutes placeholders, minifies the result,
 * and injects it into the <script type="text/x-bookmarklet"> tag in index.html
 * and it.html.
 *
 * NOTE: This script does NOT replace __TOKORO_WORKER_URL__ in the HTML files.
 * That is a deploy-time step handled by inject-worker-url.js.
 *
 * Usage:
 *   node build-bookmarklet.js
 *
 * Requires config.local.js at the project root (copy from config.local.js.example).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Configuration ────────────────────────────────────────────────────────────
let config;
try {
  config = require('../config.local.js');
} catch (e) {
  console.error('ERROR: config.local.js not found.');
  console.error(
    'Copy config.local.js.example to config.local.js and fill in your values.'
  );
  process.exit(1);
}

const RELAY_URL = config.relayUrl;
const DEFAULT_WORKER = config.crawlerWorkerUrl;
const API_URL = config.workerUrl;
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: API_URL is used only for bookmarklet placeholder substitution below.
// __TOKORO_WORKER_URL__ in the HTML files is injected separately by inject-worker-url.js.

const SRC_FILE = path.join(__dirname, 'bookmarklet.src.js');

// Read source
let src = fs.readFileSync(SRC_FILE, 'utf8');

// Substitute placeholders
src = src.replace(/__RELAY_URL__/g, RELAY_URL);
src = src.replace(/__DEFAULT_WORKER__/g, DEFAULT_WORKER);
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
console.log(
  `Bookmarklet built: ${minified.length} chars (inject via inject-worker-url.js)`
);

// Build shortcut bookmarklet (output file only, not injected into HTML)
const SHORTCUT_SRC = path.join(__dirname, 'shortcut-bookmarklet.src.js');
const SHORTCUT_OUT = path.join(__dirname, 'shortcut-bookmarklet.js');

let shortcutSrc = fs.readFileSync(SHORTCUT_SRC, 'utf8');
shortcutSrc = shortcutSrc.replace(/__RELAY_URL__/g, RELAY_URL);
const minifiedShortcut = minify(shortcutSrc);
fs.writeFileSync(SHORTCUT_OUT, minifiedShortcut, 'utf8');
console.log(
  `Shortcut bookmarklet built: ${minifiedShortcut.length} chars written to shortcut-bookmarklet.js`
);
