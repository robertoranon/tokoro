# How to Set Up and Use Tokoro

This guide walks through deploying your own Tokoro instance.

## What you actually need

The **required** components for a working setup are:

1. **Worker** — the API backend (events, stars, follows, recommendations)
2. **Crawler Worker** — extracts events from URLs via LLM and publishes them to the API

Everything else is optional depending on how you want to use the system:

| Component        | Required? | When you need it                                                   |
| ---------------- | --------- | ------------------------------------------------------------------ |
| Worker           | **Yes**   | Always                                                             |
| Crawler Worker   | **Yes**   | Always (needed by Chrome extension, bookmarklet, Apple Shortcut)   |
| Chrome Extension | Optional  | To crawl pages from your browser with one click                    |
| Web Publisher    | Optional  | To publish events manually via a form                              |
| Public Web       | Optional  | To browse/query events in a UI                                     |
| Node.js Crawler  | Optional  | To crawl pages from the command line (no browser extension needed) |

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- npm
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is sufficient)
- LLM ( local, remote )

---

## Local configuration file

Several components (public-web, web-publisher, shell scripts) read from a gitignored `config.local.js` at the project root. Create it once you know your Cloudflare subdomain:

```bash
cp config.local.js.example config.local.js
```

Edit `config.local.js` and fill in your values:

```js
const TOKORO_CONFIG = {
  workerUrl: 'https://happenings-worker.YOUR_SUBDOMAIN.workers.dev',
  crawlerWorkerUrl: 'https://happenings-crawler-worker.YOUR_SUBDOMAIN.workers.dev',
  crawlerApiKey: 'your-api-key-here',
  relayUrl: 'https://YOUR_PUBLIC_WEB_URL/',
};
```

For the shell scripts (`scripts/crawl-page.sh`, `scripts/crawl-image.sh`), also create:

```bash
cp scripts/config.local.sh.example scripts/config.local.sh
# then edit scripts/config.local.sh
```

Neither file is committed — they stay on your machine only.

---

## 1. Install Wrangler

Wrangler is Cloudflare's CLI for managing Workers, D1, KV, and secrets.

```bash
npm install -g wrangler
```

Authenticate with your Cloudflare account:

```bash
wrangler login
```

This opens a browser window. Authorize Wrangler, then return to the terminal.

---

## 2. Deploy the API Worker _(required)_

The Worker is the core backend. It handles events, stars, follows, and recommendations.

### 2.1 Install dependencies

```bash
cd worker
npm install
```

### 2.2 Create the D1 database

```bash
wrangler d1 create happenings-db
```

The output will look like:

```
✅ Successfully created DB 'happenings-db'
...
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy the `database_id` and update `worker/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "happenings-db"
database_id = "YOUR_DATABASE_ID_HERE"   # <-- paste here
```

### 2.3 Run database migrations

Apply the schema to the remote (production) database:

```bash
wrangler d1 migrations apply happenings-db --remote
```

To also apply locally (for development):

```bash
wrangler d1 migrations apply happenings-db
```

### 2.4 Create the R2 bucket (for backups)

The Worker uses an R2 bucket to store periodic backups. Create it before deploying:

```bash
wrangler r2 bucket create happenings-backups
```

### 2.5 Set Worker LLM secrets

The Worker uses an LLM for duplicate detection. Set the provider credentials:

```bash
wrangler secret put LLM_API_KEY --config worker/wrangler.toml
# API key for your LLM provider

wrangler secret put LLM_PROVIDER --config worker/wrangler.toml
# Provider name: openai, anthropic, openrouter, or ollama (default: openrouter)
```

`LLM_MODEL` is optional — omit it to use the provider's default model.

`ADMIN_PUBKEY` is set in [Section 4](#4-key-management) after generating the admin keypair.

### 2.6 Deploy the Worker

```bash
npm run deploy
```

The worker will be live at `https://happenings-worker.YOUR_SUBDOMAIN.workers.dev`.

---

## 3. Deploy the Crawler Worker _(required)_

The Crawler Worker extracts events from URLs using an LLM and publishes them to the API. The Chrome extension, bookmarklet, and Apple Shortcut all talk to this service.

### 3.1 Install dependencies

```bash
cd crawler-worker
npm install
```

### 3.2 Create the KV namespace (preview cache)

The Crawler Worker uses a KV namespace to temporarily cache extracted events before publishing (preview mode).

```bash
wrangler kv namespace create PREVIEW_CACHE
```

Copy the `id` from the output and update `crawler-worker/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "PREVIEW_CACHE"
id = "YOUR_KV_NAMESPACE_ID_HERE"   # <-- paste here
```

### 3.3 Set secrets

Secrets are sensitive values that must not be stored in code or config files. Set them via Wrangler:

#### API keys for authenticating crawl requests

Generate one or more API keys (any random string, e.g. `openssl rand -hex 32`). You'll use these in the Chrome extension and Apple Shortcut settings.

```bash
wrangler secret put CRAWLER_API_KEYS --config crawler-worker/wrangler.toml
# Enter a comma-separated list, e.g.: key1abc,key2def
```

#### Ed25519 keypair for signing published events

Events must be signed before being accepted by the API. You need an Ed25519 keypair. The easiest way to generate one is to open `web-publisher/index.html` in a browser — it auto-generates a keypair and displays it in the settings panel.

Then set the secrets:

```bash
wrangler secret put CRAWLER_PRIVKEY --config crawler-worker/wrangler.toml
# Paste the private key (hex string)

wrangler secret put CRAWLER_PUBKEY --config crawler-worker/wrangler.toml
# Paste the public key (hex string)
```

#### LLM provider credentials

The Crawler Worker uses an LLM for event extraction. Supported providers: `openai`, `anthropic`, `openrouter`, `ollama`.

```bash
wrangler secret put LLM_API_KEY --config crawler-worker/wrangler.toml
# Paste your API key (from OpenAI, Anthropic, OpenRouter, etc.)

wrangler secret put LLM_PROVIDER --config crawler-worker/wrangler.toml
# Enter one of: openai, anthropic, openrouter, ollama
```

### 3.4 Verify the API connection

The Crawler Worker connects to the API Worker via a **service binding** (`TOKORO_API → happenings-worker`) already configured in `crawler-worker/wrangler.toml`. As long as both workers are deployed under the same Cloudflare account with their default names, no changes are needed.

The `TOKORO_API_URL` var in `[vars]` is a fallback used when the binding is unavailable (e.g. local development). Update it if you renamed the API Worker or are testing locally:

```toml
[vars]
TOKORO_API_URL = "https://happenings-worker.YOUR_SUBDOMAIN.workers.dev"
```

### 3.5 Deploy the Crawler Worker

```bash
cd crawler-worker
npm run deploy
```

The crawler will be live at `https://happenings-crawler-worker.YOUR_SUBDOMAIN.workers.dev`.

---

## 4. Key management

Every event must be signed by its author. Identity is an Ed25519 keypair — no accounts, no registration. The easiest way to generate a keypair is to open `web-publisher/index.html` in a browser: one is created automatically and stored in localStorage.

### Curator keys (human publishers)

A curator is anyone who publishes events manually via the web publisher or Chrome extension.

1. Open `web-publisher/index.html` in your browser (or your deployed Web Publisher URL).
2. A keypair is generated automatically on first load and stored in the browser's localStorage.
3. The public key is displayed in the settings panel — this is the curator's persistent identity on the platform.
4. The private key never leaves the browser. Each curator's keypair is tied to the browser they used; if they clear localStorage they lose their identity.

To give a curator their public key (e.g. to whitelist them or attribute their events), they just copy it from the settings panel.

### Admin key (moderation)

The admin key authorises blocklist operations via `admin/admin.html`. It is a separate Ed25519 keypair whose public key is set as a Worker secret.

**Generate the keypair:**

Open `web-publisher/index.html` in a browser. Note down **both** the public key and the private key shown in the settings panel — you will need the private key later to sign moderation actions, so store it securely (password manager, etc.).

**Set the public key as a Worker secret:**

```bash
wrangler secret put ADMIN_PUBKEY --config worker/wrangler.toml
# Paste the public key (64-char hex string)
```

**Use the admin panel:**

Open `admin/admin.html` in a browser, go to Settings, and enter:
- **Worker URL**: your deployed API Worker URL
- **Admin Private Key**: the private key from the keypair above
- **Admin Public Key**: the same public key you set as `ADMIN_PUBKEY`

The private key is stored in the browser's localStorage and used locally to sign moderation requests — it is never sent to the server.

---

## 5. Verify the Setup

Check that the API is working:

```bash
curl "https://happenings-worker.YOUR_SUBDOMAIN.workers.dev/events?lat=51.5&lng=-0.09&radius=10"
```

Should return `{"events": []}` (empty list if no events yet).

Test a crawl (the `preview` flag extracts events without publishing, useful for testing):

```bash
curl -X POST "https://happenings-crawler-worker.YOUR_SUBDOMAIN.workers.dev/crawl" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"url": "https://example-venue.com/events", "preview": true}'
```

---

## 6. Install Client Tools _(optional)_

Links to the Chrome extension and bookmarklet are all available in the **public web interface** — open `public-web/index.html` (or your deployed Cloudflare Pages URL) and look for the "Add Events" section.

### Chrome Extension

Install directly from the [Chrome Web Store](https://chromewebstore.google.com/detail/happenings-event-crawler/lhfbgfaljjaaipfbdlfffbjfajenaphn), or load unpacked from `chrome-extension/` in developer mode.

After installing, click the extension icon → **Settings** and set:

- **Crawler Worker URL**: `https://happenings-crawler-worker.YOUR_SUBDOMAIN.workers.dev`
- **API Key**: one of the keys you set in `CRAWLER_API_KEYS`

### Bookmarklet

The bookmarklet works on any browser and opens a sidebar that lets you extract events from the current page.

**The bookmarklet is embedded in `public-web/index.html`** and built from `public-web/bookmarklet.src.js` by `public-web/build-bookmarklet.js`, which reads URLs from `config.local.js`. Make sure `config.local.js` is filled in (see above), then deploy with:

```bash
./scripts/deploy-public-web.sh
```

This builds the bookmarklet (injecting your real URLs), deploys to Cloudflare Pages, and restores the source HTML to its placeholder state. The user then drags the "⚡ Extract Events" link from the page to their bookmarks bar.

---

## 7. Use the Web Publisher _(optional)_

The web publisher is a standalone HTML file for manually composing and publishing events — no server needed.

```bash
open web-publisher/index.html
```

On first open, a keypair is generated and stored in your browser's local storage. Set the Worker URL to your deployed API endpoint in the settings panel.

---

## 8. Use the Public Web Interface _(optional)_

The public web is a static read-only browser for querying events.

```bash
open public-web/index.html
```

Or deploy to Cloudflare Pages (make sure `config.local.js` is filled in first):

```bash
./scripts/deploy-public-web.sh
```

This builds real URLs into the HTML, deploys to Cloudflare Pages (project: `happenings-query`), and restores the source files automatically.

---

## 9. Run the Node.js Crawler Locally _(optional)_

An alternative to the Crawler Worker for running crawls from the command line. Unlike the Crawler Worker, this uses Playwright (a real headless browser) so it works on JavaScript-rendered pages.

```bash
cd crawler
npm install
npx playwright install chromium

cp .env.example .env
# Edit .env: set LLM_PROVIDER, LLM_API_KEY, TOKORO_API_URL, CRAWLER_PRIVKEY, CRAWLER_PUBKEY

echo "https://example.com/events" >> seeds.txt
npm run crawl
```

---

## Troubleshooting

**"Database not found"**
Make sure the `database_id` in `worker/wrangler.toml` matches the one created by `wrangler d1 create`, and that migrations have been applied with `--remote`.

**Signature verification errors**
Ensure `CRAWLER_PUBKEY` and `CRAWLER_PRIVKEY` are a matching Ed25519 keypair. Both must be lowercase hex strings.

**LLM extraction returns no events**
Try `"preview": true` and inspect the response. Check that `LLM_PROVIDER` and `LLM_API_KEY` are set correctly. For `openai`, the key should start with `sk-`.

**KV namespace errors**
Confirm the `id` in `crawler-worker/wrangler.toml` matches the output of `wrangler kv namespace create`.

**CORS errors in browser**
Both Workers return CORS headers. If errors persist, verify the Worker URLs are correct and the Workers are deployed (not just running locally).
