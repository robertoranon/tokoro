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
6. Set the project name (e.g., `happenings-query`)
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

| Config key         | Placeholder                | Script                   | Purpose                                                        |
| ------------------ | -------------------------- | ------------------------ | -------------------------------------------------------------- |
| `relayUrl`         | `__RELAY_URL__`            | `build-bookmarklet.js`   | URL of this Pages site — used by the bookmarklet to open the relay popup |
| `workerUrl`        | `__TOKORO_WORKER_URL__`    | `inject-worker-url.js`   | API Worker URL used by the query page and as default in relay settings |
| `crawlerWorkerUrl` | `__DEFAULT_CRAWLER_URL__`  | `inject-worker-url.js`   | Default Crawler Worker URL pre-filled in relay settings on first use |

Users can override all URLs and the API key at runtime via the relay popup's settings form; values are saved to the relay's `localStorage` and remembered across all sites. The settings form collapses automatically when API Key, Crawler Worker URL, and API Worker URL are all configured.

## Local Testing

Simply open `index.html` in a web browser. No build step required.

## Bookmarklet Publisher

The bookmarklet is a minimal trigger: it preprocesses the current page's HTML, opens the relay popup (`happenings-query.pages.dev?relay=1`), and hands off the page content via `postMessage`. It writes nothing to `localStorage` and shows no UI on the visited page.

All settings — API Key, Crawler Worker URL, API Worker URL, and Ed25519 keypair — live in the relay popup's `localStorage` (scoped to `happenings-query.pages.dev`), so they persist across every site the bookmarklet is used on.

On first use the relay generates an Ed25519 keypair, stores it under `happenings_keypair`, and shows a dismissable amber notice prompting the curator to share their public key with the DB maintainer. The public and private keys are visible (and the private key editable for backup/restore) in the relay's Settings form.

To allow a new curator to publish, obtain their public key from the relay's Settings form and add it to the `ALLOWED_PUBKEYS` secret on the API worker.

## CORS Requirements

Make sure your Cloudflare Worker has CORS headers enabled to allow requests from the Cloudflare Pages domain.
