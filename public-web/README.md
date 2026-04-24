# Tokoro Public Web Query Interface

A simple web interface for querying events from the Tokoro API.

## Features

- Search events by location (address or coordinates)
- Filter by category and time range
- Geocoding support via OpenStreetMap Nominatim API
- Mobile-responsive design

## Deployment to Cloudflare Pages

### Option 1: Deploy script (Recommended)

From the repo root:

```bash
./scripts/deploy-public-web.sh
```

This builds the bookmarklet, injects the real worker and crawler URLs into the HTML files, deploys to Cloudflare Pages, then restores the source files to their placeholder state so the repo stays clean. Use `--dry-run` to preview without deploying.

### Option 2: Via Cloudflare Dashboard

1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Go to **Pages** in the left sidebar
3. Click **Create a project**
4. Choose **Direct Upload**
5. Upload the contents of the `public-web` directory
6. Set the project name (e.g., `tokoro-query`)
7. Click **Deploy**

### Option 3: Git Integration

1. Push this repository to GitHub/GitLab
2. In Cloudflare Dashboard, go to **Pages** → **Create a project**
3. Choose **Connect to Git**
4. Select your repository
5. Configure build settings:
   - **Build command:** (leave empty)
   - **Build output directory:** `public-web`
6. Click **Save and Deploy**

## Configuration

All URLs and keys are configured via `config.local.js` at the project root. Copy the example file and fill in your values:

```bash
cp config.local.js.example config.local.js
```

Then run `build-bookmarklet.js` (see below) to inject the values into the HTML files.

The default search location is **Udine, Italy** with a **100 km radius**. To change the default, edit the `value` attributes of the `queryLat`, `queryLng`, and `queryRadius` inputs in `index.html`.

## Building the Bookmarklet

Two build scripts prepare the HTML files before deployment:

- **`build-bookmarklet.js`** — reads `config.local.js`, substitutes bookmarklet placeholders (`__RELAY_URL__`), minifies, and writes the result into `index.html` and `it.html`.
- **`inject-worker-url.js`** — replaces URL placeholders in all three HTML files. Takes two CLI arguments:

```bash
node inject-worker-url.js <worker-url> [<crawler-url>]
```

Both scripts are run automatically by `scripts/deploy-public-web.sh` (see below). You only need to run them manually if you're not using that script.

| Config key         | Placeholder               | Script                 | Purpose                                                                  |
| ------------------ | ------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| `relayUrl`         | `__RELAY_URL__`           | `build-bookmarklet.js` | URL of this Pages site — used by the bookmarklet to open the relay popup |
| `workerUrl`        | `__TOKORO_WORKER_URL__`   | `inject-worker-url.js` | API Worker URL used by the query page and as default in relay settings   |
| `crawlerWorkerUrl` | `__DEFAULT_CRAWLER_URL__` | `inject-worker-url.js` | Default Crawler Worker URL pre-filled in relay settings on first use     |

Users can override all URLs and the API key at runtime via the relay popup's settings form; values are saved to the relay's `localStorage` and remembered across all sites. The settings form collapses automatically when API Key, Crawler Worker URL, and API Worker URL are all configured.

## Local Testing

Simply open `index.html` in a web browser. No build step required.

## Bookmarklet Publisher

The bookmarklet is a minimal trigger: it preprocesses the current page's HTML, opens the relay popup (`tokoro-query.pages.dev?relay=1`), and hands off the page content via `postMessage`. It writes nothing to `localStorage` and shows no UI on the visited page.

All settings — API Key, Crawler Worker URL, API Worker URL, and Ed25519 keypair — live in the relay popup's `localStorage` (scoped to `tokoro-query.pages.dev`), so they persist across every site the bookmarklet is used on.

On first use the relay generates an Ed25519 keypair, stores it under `tokoro_keypair`, and shows a dismissable amber notice prompting the curator to share their public key with the DB maintainer. The public and private keys are visible (and the private key editable for backup/restore) in the relay's Settings form.

To allow a new curator to publish, obtain their public key from the relay's Settings form and add it to the `ALLOWED_PUBKEYS` secret on the API worker.

## CORS Requirements

Make sure your Cloudflare Worker has CORS headers enabled to allow requests from the Cloudflare Pages domain.

---

## Mobile Publishing (`publish.html`)

A mobile-first publishing page deployed alongside the query interface. No build step — plain HTML + JS.

### Entry modes (detected on load, highest priority first)

1. **Hash-events** — `location.hash` starts with `#events=`: base64-decode → JSON-parse → `PreparedEvent[]` → Review UI directly. Hash is cleared from URL via `history.replaceState`.
2. **Relay** — `window.opener` is present: hide input UI, post `{ type: 'ready' }` to opener after keypair is ready, listen for `{ type: 'crawl_data', url, html, title }`, run crawl on receipt.
3. **Manual** (default): URL tab and Image tab.

### Manual modes

**URL tab** — paste any event page URL; crawl request goes to `workerUrl/crawl` with `{ url, mode: 'direct' }` (Jina AI Reader fallback server-side, no HTML required).

**Image tab** — pick a JPEG/PNG from Photos or Camera; optional source URL. Request goes to `workerUrl/crawl` with `{ imageData, imageMimeType, url?, mode: 'image' }`. Events extracted without a source URL get a Google search URL auto-constructed from the event title, venue, and date in the review card.

### Settings

Uses the same `localStorage` keys as `index.html`: `tokoro_api_key`, `tokoro_worker_url`, `tokoro_api_url`, `tokoro_keypair`. Settings configured in either page are immediately available in the other (same Cloudflare Pages domain).

### PWA

`publish.manifest.json` enables "Add to Home Screen" on iOS with `display: standalone`. No service worker required.

---

## Shared Signing Utilities (`signing.js`)

Exports via `window.*`:

- `bytesToHex(bytes)` — `Uint8Array` → lowercase hex string
- `loadOrCreateKeypair()` — loads `tokoro_keypair` from `localStorage`; generates a new Ed25519 keypair and saves it if absent. Returns `{ pubkey, privkeyB64, isNew }`.
- `signEvent(preparedEvent, keypair)` — builds canonical event object, SHA-256 hashes it, signs with Ed25519, returns signed event object ready to POST to the API worker.

Used by both `index.html` relay and `publish.html`.

---

## Apple Shortcut (`shortcut-bookmarklet.js`)

A build artifact produced by `build-bookmarklet.js` from `shortcut-bookmarklet.src.js`. Embeds the same DOM-cleaning logic as the bookmarklet, but opens `publish.html` instead of the relay popup.

Build it with:

```bash
node public-web/build-bookmarklet.js
```

Output: `public-web/shortcut-bookmarklet.js` (gitignored). Embed the contents verbatim in an Apple Shortcut action "Run JavaScript on Web Page" — see HOW-TO-USE.md for setup instructions.
