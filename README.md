# Tokoro

An open-source toolbox for building event publish & discovery web sites, apps, and feeds.

Tokoro gives you everything you need to run your own event platform: a serverless backend API, an LLM-powered web crawler that extracts structured event data from any venue or festival page, browser tools for one-click publishing, and a static read-only event browser — all wired together with a simple cryptographic identity model that requires no user accounts.

---

## Design principles

**No accounts.** Identity is an Ed25519 keypair generated locally on device. Every event is signed by its author / curator and the backend verifies signatures before accepting writes. No email, no password, no registration flow.

**Decentralized.** Anyone can run their own instance. Events are signed with a stable public key, so authorship is verifiable across instances and over time.

**LLM-powered ingestion.** Various tools to extract structured event data (title, dates, location, category, tags) from ordinary venue web pages and image flyers using any OpenAI-compatible LLM — local or hosted.

**Geospatial.** Events are indexed by geohash at two precision levels (~1.2 km and ~5 km). Proximity queries are fast against SQLite with no geospatial extensions needed.

**Runs on Cloudflare free tier.** The primary backend stack is Cloudflare Workers + D1 (SQLite). The crawler is also a Worker. Both fit comfortably within Cloudflare's free tier for moderate traffic.

---

## Components

```
                     ┌────────────────────────────────────────────┐
                     │            Client tools                    │
                     │  Chrome Ext · Bookmarklet · Apple Shortcut │
                     └───────────┬────────────────────────────────┘
                                 │ POST /crawl
                     ┌───────────▼─────────────────────────────┐
                     │         Crawler Worker                  │
                     │  Fetch → LLM extract → sign → publish   │
                     └───────────┬─────────────────────────────┘
                                 │ POST /events
              ┌──────────────────▼────────────────────────────┐
              │                Worker API                     │
              │  Events · Stars · Follows · Feed · Discover   │
              │          Cloudflare Workers + D1              │
              └──────────────────┬────────────────────────────┘
                                 │ GET /events
              ┌──────────────────▼────────────────────────────┐
              │             Public Web / Your App             │
              │  Query by location, time, category, tags      │
              └───────────────────────────────────────────────┘
```

| Component                                 | What it does                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| [**Worker**](worker/)                     | Cloudflare Worker + D1 backend — events, stars, follows, recommendations          |
| [**Crawler Worker**](crawler-worker/)     | Serverless LLM crawler — extract & publish events from any URL or image           |
| [**Chrome Extension**](chrome-extension/) | One-click crawl from the browser toolbar or right-click menu                      |
| [**Bookmarklet**](public-web/)            | Same capability in any browser, no extension install needed                       |
| [**Apple Shortcut**](apple-shortcut/)     | Share Sheet integration for Safari on iOS/iPadOS/macOS                            |
| [**Web Publisher**](web-publisher/)       | Static HTML form for manually composing and publishing events                     |
| [**Public Web**](public-web/)             | Example event browser — query by location, date, category; embeds the bookmarklet |
| [**Admin Panel**](admin/)                 | Static HTML moderation UI — browse and delete events with admin key auth          |
| [**Node.js Crawler**](crawler/)           | CLI crawler using Playwright / Jina AI Reader                                     |

---

## Quick start

The minimum working setup is **Worker + Crawler Worker**. Everything else is optional.

### Prerequisites

- [Node.js](https://nodejs.org/) v18+ and npm
- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is sufficient)
- An LLM API key (OpenAI, Anthropic, OpenRouter) or a local Ollama instance

### 1. Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. Install shared dependencies

```bash
cd shared
npm install
```

### 3. Deploy the API Worker

```bash
cd worker
npm install

# Copy the example config and fill in your values
cp wrangler.toml.example wrangler.toml

# Create the D1 database
wrangler d1 create happenings-db
# Paste the returned database_id into worker/wrangler.toml

# Run migrations
wrangler d1 migrations apply happenings-db --remote

# Deploy
npm run deploy
# → https://happenings-worker.YOUR_SUBDOMAIN.workers.dev
```

### 4. Deploy the Crawler Worker

```bash
cd crawler-worker
npm install

# Create the KV namespace for preview caching
wrangler kv namespace create PREVIEW_CACHE
# Copy the id into crawler-worker/wrangler.toml

# Set secrets
wrangler secret put CRAWLER_API_KEYS   # comma-separated API keys for your clients
wrangler secret put CRAWLER_PRIVKEY    # Ed25519 private key (hex) — generate via web-publisher/index.html
wrangler secret put CRAWLER_PUBKEY     # Ed25519 public key (hex)
wrangler secret put LLM_PROVIDER       # openai | anthropic | openrouter | ollama
wrangler secret put LLM_API_KEY        # your LLM API key

# Point to your API Worker
# Edit crawler-worker/wrangler.toml: TOKORO_API_URL = "https://happenings-worker.YOUR_SUBDOMAIN.workers.dev"

npm run deploy
# → https://happenings-crawler-worker.YOUR_SUBDOMAIN.workers.dev
```

### 5. Verify

```bash
# Should return {"events": []}
curl "https://happenings-worker.YOUR_SUBDOMAIN.workers.dev/events?lat=51.5&lng=-0.09&radius=10"

# Extract events without publishing (preview mode)
curl -X POST "https://happenings-crawler-worker.YOUR_SUBDOMAIN.workers.dev/crawl" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"url": "https://example-venue.com/events", "mode": "discover", "preview": true}'
```

### 6. Open the public web interface

Configure and build the public web page so it points to your deployed workers:

```bash
cp config.local.js.example config.local.js
# Edit config.local.js: fill in workerUrl, crawlerWorkerUrl, crawlerApiKey, and relayUrl
node public-web/build-bookmarklet.js
```

Then open `public-web/index.html` in your browser. It queries your Worker API and displays events near the default location.

**To publish events from any page (bookmarklet):** scroll to the footer of the public web page and drag the **⚡ Extract Events** link to your bookmarks bar. Clicking it on any event page opens a sidebar that sends the page to your Crawler Worker, shows a preview, and lets you publish with one click.

**To manually compose and publish an event:** open `web-publisher/index.html` directly in your browser (no server needed). A keypair is generated automatically on first load — set your Worker URL and API key in the settings panel, fill in the event form, and hit Publish.

For the full setup guide including optional components, key management, and troubleshooting, see [HOW-TO-USE.md](HOW-TO-USE.md).

---

## API reference

### Events

| Method   | Endpoint                                                            | Description                                 |
| -------- | ------------------------------------------------------------------- | ------------------------------------------- |
| `GET`    | `/events?lat=&lng=&radius=&from=&to=&category=&tags=&festival_url=` | Query events (max 100; all params optional) |
| `GET`    | `/events?…&format=ical`                                             | Same query, returned as an iCal (.ics) feed |
| `POST`   | `/events`                                                           | Publish a signed event                      |
| `PUT`    | `/events/:id`                                                       | Edit an event (new signature required)      |
| `DELETE` | `/events/:id`                                                       | Delete an event (signature required)        |

### Discovery

| Method | Endpoint            | Description                                                        |
| ------ | ------------------- | ------------------------------------------------------------------ |
| `GET`  | `/feed?pubkey=`     | Events starred by people the user follows                          |
| `GET`  | `/discover?pubkey=` | Suggested users with similar event taste (collaborative filtering) |

### Crawler Worker

| Method | Endpoint | Description                                               |
| ------ | -------- | --------------------------------------------------------- |
| `POST` | `/crawl` | Extract and optionally publish events from a URL or image |

Add `format=ical` to any `/events` query to receive an iCal feed (RFC 5545, `text/calendar`) that can be subscribed to directly from any calendar app. Use `window=30d` (or `7d`, etc.) as a shorthand to set a rolling time window instead of explicit `from`/`to` dates — it defaults to `30d` when `format=ical`.

All write operations require a valid Ed25519 signature in the request body. The crawler worker requires an `X-API-Key` header.

---

## Data model

Events are stored in Cloudflare D1 (SQLite):

```sql
CREATE TABLE events (
  id            TEXT PRIMARY KEY,    -- stable across edits
  pubkey        TEXT NOT NULL,       -- author's Ed25519 public key (hex)
  signature     TEXT NOT NULL,       -- Ed25519 signature (hex)
  title         TEXT NOT NULL,
  description   TEXT,
  url           TEXT,                -- event page URL
  venue_name    TEXT,
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  geohash5      TEXT NOT NULL,       -- ~5 km spatial index
  geohash6      TEXT NOT NULL,       -- ~1.2 km spatial index
  start_time    TEXT NOT NULL,       -- ISO 8601, local time at venue (e.g. "2026-03-15T21:00:00")
  end_time      TEXT,
  category      TEXT NOT NULL,       -- music | food | sports | arts | community | …
  tags          TEXT,                -- JSON array of free-form tags
  festival_name TEXT,                -- optional festival grouping label
  festival_url  TEXT,                -- optional festival homepage (used for grouping/filtering)
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);
```

**Timestamp convention:** all times are ISO 8601 without timezone (`YYYY-MM-DDTHH:MM:SS`), representing local time at the venue's location. No UTC conversion — the event coordinates carry the timezone context implicitly.

---

## Identity and signing

Users and automated publishers (crawlers, bots) identify themselves with an Ed25519 keypair. The public key is the persistent identity. The private key never leaves the device.

**To generate a keypair:** open `web-publisher/index.html` in any browser — a keypair is generated automatically on first load and stored in `localStorage`. The public and private keys are shown in the settings panel.

The Worker verifies every write against the declared public key. Unsigned or invalidly-signed events are rejected.

---

## Crawler modes

The Crawler Worker supports three extraction modes:

| Mode       | Input        | How it works                                                                              |
| ---------- | ------------ | ----------------------------------------------------------------------------------------- |
| `direct`   | URL          | Extracts events from the given URL: parses JSON-LD, falls back to LLM extraction          |
| `discover` | URL          | Finds event sub-pages on the given URL via LLM link analysis, then extracts from each one |
| `image`    | base64 image | Uses multimodal LLM vision to extract events from a flyer or poster                       |

The default mode is `discover`.

**Content fetching:** when the browser extension or bookmarklet sends the page HTML in the request body (`html` field), the Worker cleans and uses it directly. When no HTML is provided (e.g., direct API calls), the Worker fetches the page via Jina AI Reader.

All modes support **preview mode** (`"preview": true`) — events are extracted and cached but not published, letting the user review and confirm before committing.

The Node.js CLI crawler (`crawler/`) can use Playwright instead of Jina AI Reader, to work on JavaScript-rendered pages that Jina cannot handle.

---

## Optional components

### Chrome Extension

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/happenings-event-crawler/lhfbgfaljjaaipfbdlfffbjfajenaphn) or load unpacked from `chrome-extension/`. After installing, set your Crawler Worker URL and API key in the extension settings.

### Bookmarklet

Drag the "⚡ Extract Events" link from the public web interface to your bookmarks bar. Works in any browser. The bookmarklet opens a sidebar on the current page and relays its content to the Crawler Worker.

### Apple Shortcut

Available as a link from the public web interface. Adds a "Tokoro" option to the Safari Share Sheet on iPhone, iPad, and Mac.

### Web Publisher

Open `web-publisher/index.html` directly in a browser — no server needed. Includes a map-based location picker, address geocoding, category/tag selection, and keypair management.

### Public Web

The included public web (`public-web/`) is a **reference implementation** of an event discovery interface built on the API — not a required component. Use it as-is, fork it, or replace it entirely with your own app (mobile, web, feed, whatever fits your use case). It demonstrates geo+time queries, event grouping by venue and festival, date formatting, and the bookmarklet integration.

Open `public-web/index.html` locally or deploy to Cloudflare Pages with:

```bash
cp config.local.js.example config.local.js  # fill in your URLs
./scripts/deploy-public-web.sh
```

### Admin Panel

A static HTML moderation interface (`admin/admin.html`). Open it directly in a browser — no server needed. Lets an operator browse all events and delete them using a signed admin keypair. See the [key management section of the setup guide](HOW-TO-USE.md#4-key-management) for how to generate the admin keypair and configure the Worker secret.

---

## Documentation

- [Setup Guide](HOW-TO-USE.md)
- [Worker Specification](worker/SPECS.md)
- [Crawler Specification](crawler/SPECS.md)
- [Crawler Worker Specification](crawler-worker/SPECS.md)
- [Chrome Extension Specification](chrome-extension/SPECS.md)
- [Apple Shortcut Specification](apple-shortcut/SPECS.md)
- [Public Web Specification](public-web/SPECS.md)

---

## License

MIT
