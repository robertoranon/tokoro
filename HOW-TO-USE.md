# How to Set Up and Use Tokoro

This guide walks through deploying your own Tokoro instance.

## What you actually need

The **required** components for a working setup are:

1. **Worker** — the API backend (events, stars, follows, recommendations)
2. **Crawler Worker** — extracts events from URLs via LLM and publishes them to the API
3. **Public Web** — hosts the bookmarklet and serves as the publishing relay; also lets you browse and query events to verify the system is working

One could do without the public web if using the Chrome extension, which does not need a publishing relay, but anyway for convenience and easy testing, it is recommended to deploy it to Cloudflare Pages as part of initial setup.

After that, how you publish events depends on your preference:

| Component        | Required? | When you need it                                                     |
| ---------------- | --------- | -------------------------------------------------------------------- |
| Worker           | **Yes**   | Always                                                               |
| Crawler Worker   | **Yes**   | Always (needed by bookmarklet, Chrome extension, Apple Shortcut)     |
| Public Web       | **Yes**   | Required for setup (bookmarklet source + relay); useful for browsing |
| Bookmarklet      | **Yes**   | Primary way to extract and publish events from any browser           |
| Chrome Extension | Optional  | Alternative to bookmarklet — one-click crawl with a dedicated UI     |
| Web Publisher    | Optional  | To publish events manually via a form (no crawling)                  |
| Node.js Crawler  | Optional  | To crawl pages from the command line (no browser extension needed)   |

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
  workerUrl: 'https://tokoro-worker.YOUR_SUBDOMAIN.workers.dev',
  crawlerWorkerUrl: 'https://tokoro-crawler-worker.YOUR_SUBDOMAIN.workers.dev',
  crawlerApiKey: 'your-api-key-here',
  relayUrl: 'https://YOUR_PUBLIC_WEB_URL/',
};
```

`config.local.js` is the single source of truth for URLs and keys. All scripts (`deploy-public-web.sh`, `crawl-page.sh`, `crawl-image.sh`) read from it directly. Run `scripts/setup.sh` once after editing it to propagate values to dependent config files (e.g. `crawler/.env`).

This file is gitignored — it stays on your machine only.

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
wrangler d1 create tokoro-db
```

The output will look like:

```
✅ Successfully created DB 'tokoro-db'
...
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy the `database_id` and update `worker/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "tokoro-db"
database_id = "YOUR_DATABASE_ID_HERE"   # <-- paste here
```

### 2.3 Run database migrations

Run these from the project root (the `--config` flag points wrangler to `worker/wrangler.toml`):

Apply the schema to the remote (production) database:

```bash
wrangler d1 migrations apply tokoro-db --remote --config worker/wrangler.toml
```

To also apply locally (for development):

```bash
wrangler d1 migrations apply tokoro-db --config worker/wrangler.toml
```

**Upgrading an existing installation:** before deploying a Worker version that includes the member features (section 10), add the member tables to the remote database:

```bash
wrangler d1 execute tokoro-db --remote --file=worker/migrations/0007_add_members.sql --config worker/wrangler.toml
```

### 2.4 Create the R2 bucket (for backups)

The Worker uses an R2 bucket to store periodic backups. Create it before deploying:

```bash
wrangler r2 bucket create tokoro-backups
```

### 2.5 Set Worker LLM secrets

The Worker uses an LLM for duplicate detection. Set the provider credentials:

```bash
wrangler secret put LLM_API_KEY --config worker/wrangler.toml
# API key for your LLM provider

wrangler secret put LLM_PROVIDER --config worker/wrangler.toml
# Provider name: openai, anthropic, openrouter, or ollama (default: see shared/llm/defaults.ts, currently openrouter)
```

`LLM_MODEL` is optional — omit it to use the provider's default model.

`ADMIN_PUBKEY` is set in [Section 4](#4-key-management) after generating the admin keypair.

`ALLOWED_PUBKEYS` is set in [Section 4](#4-key-management) once you have curator public keys to allowlist.

### 2.6 Deploy the Worker

Use the globally installed wrangler (not the local one in `node_modules`) to avoid version issues:

```bash
wrangler deploy --config worker/wrangler.toml
```

The worker will be live at `https://tokoro-worker.YOUR_SUBDOMAIN.workers.dev`.

---

## 3. Deploy the Crawler Worker _(required)_

The Crawler Worker extracts events from URLs using an LLM and returns them as unsigned `PreparedEvent[]`. The Chrome extension, bookmarklet, and Apple Shortcut all talk to this service — they sign extracted events locally and publish directly to the API worker.

### 3.1 Install dependencies

```bash
cd crawler-worker
npm install
```

### 3.2 Create the KV namespace

The Crawler Worker uses a KV namespace for preview caching. Create it and update `crawler-worker/wrangler.toml`:

```bash
wrangler kv namespace create PREVIEW_CACHE
```

The output will look like:

```
✅ Successfully created namespace 'PREVIEW_CACHE'
{ binding = "PREVIEW_CACHE", id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
```

Copy the `id` and update `crawler-worker/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "PREVIEW_CACHE"
id = "YOUR_KV_NAMESPACE_ID_HERE"   # <-- paste here
```

### 3.3 Update the API URL

Open `crawler-worker/wrangler.toml` and replace the placeholder with your actual subdomain:

```toml
[vars]
TOKORO_API_URL = "https://tokoro-worker.YOUR_SUBDOMAIN.workers.dev"
```

### 3.4 Set secrets

Secrets are sensitive values that must not be stored in code or config files. Set them via Wrangler:

#### API keys for authenticating crawl requests

Generate one or more API keys (any random string, e.g. `openssl rand -hex 32`). You'll use these in the Chrome extension and bookmarklet settings.

```bash
wrangler secret put CRAWLER_API_KEYS --config crawler-worker/wrangler.toml
# Enter a comma-separated list, e.g.: key1abc,key2def
```

#### LLM provider credentials

The Crawler Worker uses an LLM for event extraction. Supported providers: `openai`, `anthropic`, `openrouter`, `ollama`.

```bash
wrangler secret put LLM_API_KEY --config crawler-worker/wrangler.toml
# Paste your API key (from OpenAI, Anthropic, OpenRouter, etc.)

wrangler secret put LLM_PROVIDER --config crawler-worker/wrangler.toml
# Enter one of: openai, anthropic, openrouter, ollama
```

#### Crawler signing keypair (optional)

If you want the crawler worker to publish events directly to the API (rather than returning unsigned events for the client to sign), set an Ed25519 keypair. Generate one by opening `web-publisher/index.html` and noting the keys shown in settings.

```bash
wrangler secret put CRAWLER_PRIVKEY --config crawler-worker/wrangler.toml
wrangler secret put CRAWLER_PUBKEY --config crawler-worker/wrangler.toml
```

Then add `CRAWLER_PUBKEY` to `ALLOWED_PUBKEYS` on the API worker (see Section 4).

### 3.5 Deploy the Crawler Worker

```bash
wrangler deploy --config crawler-worker/wrangler.toml
```

The crawler will be live at `https://tokoro-crawler-worker.YOUR_SUBDOMAIN.workers.dev`.

---

## 4. Key management

Every event must be signed by its author. Identity is an Ed25519 keypair — no accounts, no registration. The easiest way to generate a keypair is to open `web-publisher/index.html` in a browser: one is created automatically and stored in localStorage.

### Curator keys (human publishers)

A curator is anyone who publishes events — via the web publisher, Chrome extension, or bookmarklet.

Each curator generates their own Ed25519 keypair locally on first use:

- **Web publisher**: open `web-publisher/index.html` — keypair auto-generated in localStorage; pubkey shown in settings panel
- **Chrome extension**: open the popup — keypair auto-generated in `chrome.storage.sync`; pubkey shown in settings
- **Bookmarklet relay**: open the relay popup — keypair auto-generated in localStorage of `tokoro-query.pages.dev`

The private key never leaves the browser. Each curator's keypair is tied to their browser/device.

To activate a curator, obtain their public key (64-char hex) and add it to the `ALLOWED_PUBKEYS` secret on the API worker:

```bash
wrangler secret put ALLOWED_PUBKEYS --cwd worker
# Enter comma-separated list: <existing_pubkeys>,<new_curator_pubkey>
```

Always include the crawler CLI's `CRAWLER_PUBKEY` in `ALLOWED_PUBKEYS` if you use automated publishing via `crawler/`.

### Admin key (moderation)

The admin key authorises moderation in `admin/admin.html` (deleting events, managing members and their band suggestions) and the blocklist API endpoints. It is a separate Ed25519 keypair whose public key is set as a Worker secret.

**Generate the keypair:**

Open `web-publisher/index.html` in a browser. Note down **both** the public key and the private key shown in the settings panel — you will need the private key later to sign moderation actions, so store it securely (password manager, etc.).

**Set the public key as a Worker secret:**

```bash
wrangler secret put ADMIN_PUBKEY --config worker/wrangler.toml
# Paste the public key (64-char hex string)
```

**Use the admin panel:**

Open `admin/admin.html` in a browser. The Worker URL is pre-filled from `config.local.js` (if you have set it up). Go to Settings and enter:

- **Worker URL**: your deployed API Worker URL (pre-filled from `config.local.js`)
- **Admin Private Key**: the private key from the keypair above
- **Admin Public Key**: the same public key you set as `ADMIN_PUBKEY`
- **Public site URL** (only needed for members, see section 10): the address where your public web is hosted, e.g. `https://tokoro-query.pages.dev`. It can be pre-filled from `publicWebUrl` in `config.local.js`

The admin page has three tabs: **Events** (search and delete events), **Members** and **Suggestions** (section 10).

The private key is stored in the browser's localStorage and used locally to sign moderation requests — it is never sent to the server.

---

## 5. Verify the Setup

### 5.1 Check the API worker

```bash
curl "https://tokoro-worker.YOUR_SUBDOMAIN.workers.dev/events?lat=51.5&lng=-0.09&radius=10"
```

Should return `{"events": []}` (empty list — no events yet).

### 5.2 Deploy the public web and install the bookmarklet

Before deploying, make sure `config.local.js` is filled in (see the Local configuration file section above). The public web deploys to a Cloudflare Pages project named `tokoro-query`, so set `relayUrl` to:

```js
relayUrl: 'https://tokoro-query.pages.dev/',
```

Then deploy from the project root:

```bash
./scripts/deploy-public-web.sh
```

Open `https://tokoro-query.pages.dev` in your browser. Find the **Add Events** section and drag the **⚡ Extract Events** link to your bookmarks bar.

### 5.3 Register your publishing identity

Navigate to any webpage and click the **⚡ Extract Events** bookmarklet. A relay popup opens (the public web page running in a small window).

On first use, a keypair is generated and your **public key** is displayed with a notice that publishing must be activated. Copy that public key, then run:

```bash
wrangler secret put ALLOWED_PUBKEYS --config worker/wrangler.toml
# Enter your public key (64-char hex). To add multiple keys: key1,key2
```

### 5.4 Extract and publish an event

Navigate to a page listing real-world events (a venue website, festival page, etc.) and click the bookmarklet again. The crawler extracts events from the page and shows them in the relay popup. Review them and click **Publish**.

### 5.5 Verify the event appears

Go to `https://tokoro-query.pages.dev`, enter the coordinates near the event's venue and search. The published event should appear in the results.

---

## 6. Install Client Tools _(optional)_

Links to the Chrome extension, bookmarklet, and Apple Shortcut are all available in the **public web interface** — open `public-web/index.html` (or your deployed Cloudflare Pages URL) and look for the "Add Events" section.

### Chrome Extension

Install directly from the [Chrome Web Store](https://chromewebstore.google.com/detail/tokoro-event-crawler/lhfbgfaljjaaipfbdlfffbjfajenaphn), or load unpacked from `chrome-extension/` in developer mode.

After installing, click the extension icon → **Settings** and set:

- **Crawler Worker URL**: `https://tokoro-crawler-worker.YOUR_SUBDOMAIN.workers.dev`
- **API Worker URL**: `https://tokoro-worker.YOUR_SUBDOMAIN.workers.dev`
- **API Key**: one of the keys you set in `CRAWLER_API_KEYS`

Your public key is displayed in the settings panel — share it with your admin to be added to the `ALLOWED_PUBKEYS` allowlist before you can publish events.

### Apple Shortcut (iOS)

The Apple Shortcut lets you publish events directly from Safari's Share Sheet without switching apps.

**Setup:**

1. Build the shortcut script (requires `config.local.js`):
   ```bash
   node public-web/build-bookmarklet.js
   ```
   This produces `public-web/shortcut-bookmarklet.js`, with your Crawler Worker and relay URLs baked in.

2. Open the **Shortcuts** app on your iPhone or iPad.
3. Tap **+** to create a new shortcut.
4. Add action: **Run JavaScript on Web Page**.
5. Paste the full contents of `public-web/shortcut-bookmarklet.js` into the script field.
6. Tap the shortcut name → enable **Show in Share Sheet**.
7. Name it **Tokoro** and save.

**Distributing the shortcut to others:**

Once the shortcut works on your device, share it via iCloud so others can install it with one tap:

1. In the Shortcuts app, long-press the shortcut → **Share** → **Copy iCloud Link**.
2. Add that link to `config.local.js` as `shortcutUrl`:
   ```js
   shortcutUrl: 'https://www.icloud.com/shortcuts/YOUR_LINK_ID',
   ```
3. Redeploy the public web (`./scripts/deploy-public-web.sh`). The **Add to Shortcuts →** button will appear on the public web page for iOS visitors.

> **Note:** The shortcut script contains your Crawler Worker and relay URLs. If those URLs change, rebuild the script, recreate the shortcut, and share a new iCloud link.

**Usage:** In Safari on any event page, tap **Share** → **Tokoro**. The publish page opens in a new tab pre-loaded with the extracted events, ready to review and publish.

**First time:** Open `https://YOUR_PUBLIC_WEB_URL/publish.html` in Safari, configure your API key and worker URLs in Settings, then tap **Share → Add to Home Screen** to install it as a PWA for quick access.

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

This builds real URLs into the HTML, deploys to Cloudflare Pages (project: `tokoro-query`), and restores the source files automatically.

---

## 9. Run the Node.js Crawler Locally _(optional)_

A local CLI alternative to the Crawler Worker. Unlike the serverless Crawler Worker, this runs on your machine and supports Playwright (a real headless browser) for JavaScript-rendered pages. It signs and publishes events directly to the API.

### Setup

```bash
cd crawler
npm install
npx playwright install chromium

# Generate a signing keypair
npm run crawl -- --generate-keypair

cp .env.example .env
# Edit crawler/.env: set LLM_PROVIDER, LLM_API_KEY, CRAWLER_PRIVKEY, CRAWLER_PUBKEY
# Then sync TOKORO_API_URL from config.local.js:
cd .. && ./scripts/setup.sh
```

Add the generated public key to `ALLOWED_PUBKEYS` on the API worker (see Section 4).

### Basic usage

```bash
# Crawl a specific URL
npm run crawl https://venue.com/events/concert-name

# Crawl from seeds file
echo "https://venue.com/events" >> seeds.txt
npm run crawl
```

### Crawler modes

| Mode | Best for | Command |
|------|----------|---------|
| `direct` (default) | Single event pages | `npm run crawl https://venue.com/event/123` |
| `discover` | Venue homepages with links to individual events | `npm run crawl -- --mode discover https://venue.com/events` |
| `festival` | Festival homepages — crawls entire programme, deduplicates | `npm run crawl -- --mode festival https://www.flowfestival.com` |
| `image` | Event flyers or posters | `npm run crawl -- --image path/to/flyer.jpg` |

### Fetcher strategies

| Fetcher | Best for | Command |
|---------|----------|---------|
| `playwright` (default) | JavaScript-heavy sites, SPAs | `npm run crawl -- --fetcher playwright <url>` |
| `jina` | Static HTML sites, faster crawling | `npm run crawl -- --fetcher jina <url>` |

### Debug mode

Use `--debug` to test extraction without publishing:

```bash
# Print raw LLM output, skip geocoding/signing/publishing
npm run crawl -- --debug https://venue.com/events

# Geocode and sign but do not publish
npm run crawl -- --debug --normalize https://venue.com/events
```

### Other options

```bash
# Override the LLM model for this run
npm run crawl -- --model google/gemini-2.0-flash-exp:free https://venue.com/events

# Set reference date for date inference (useful when testing with saved pages)
npm run crawl -- --date 2026-03-02 https://venue.com/events
```

See [`crawler/README.md`](crawler/README.md) for the full options reference.

---

## 10. Members and My bands (tours page)

The band-tours page (`tours.html`) is public. On top of that, you can give a few people a **personal link**. Someone who has opened their link (a **member**) can:

- follow bands with the ♡ button (♥ means "following"),
- switch the page between **All bands** and **My bands**,
- suggest new bands for you to add.

Members cannot publish or change events. You manage everything from the admin page (`admin/admin.html`).

### Before you start (once)

1. Make sure the Worker has the member tables (see "Upgrading an existing installation" in section 2.3) and is deployed.
2. In the admin page, open **Settings** and fill in **Public site URL**: the address where your tours page lives, for example `https://tokoro-query.pages.dev`. Personal links are built from it.

### Add a member

1. Open the **Members** tab.
2. Type the person's name (up to 60 characters) and press **Create personal link**.
3. A link and a QR code appear. Press **Copy link** and send it to the person, or let them scan the QR code with their phone.
4. **Send it now: the link cannot be shown again.** Tip: keep a copy in your password manager, in case the member loses it.

Treat the link like a house key: anyone who has it can use it as that member (follow bands and make suggestions in their name).

### What the member does

- **Open the link once on each device** (phone, laptop). The page says "Hi, <name>", and from then on that device remembers them: next time they just open the tours page normally. The link disappears from the address bar as soon as the page opens.
- **Follow bands:** tap ♡ on a band card, or on any band in the **Tracked bands** list (also bands that have no upcoming shows right now). **My bands** shows only the bands they follow; **All bands** shows everything. The page remembers the choice.
- **Bands without upcoming shows:** in **My bands**, the followed bands that have no upcoming shows are listed under "Following · no upcoming shows", with a link to their website and their ♥ to unfollow. The search box also filters this list by name; "New only" hides it.
- **Suggest a band:** open **Suggest a band**, type the name and, if they know it, the band's website, then press **Suggest**. Under the form they see their suggestions with a status:
  - **Waiting** — you have not decided yet;
  - **Added** — the band is now on the tours page (and it is followed for them automatically);
  - **Not added** — you rejected it (with your reason, if you gave one).

If the page says "This personal link is no longer active", the member was revoked or deleted.

### Review suggestions

Open the **Suggestions** tab. It lists the waiting suggestions grouped by band (spellings that differ only in capitals, accents or punctuation are grouped), most requested first. **Show who asked** adds the members' names. Below, **Most followed bands** shows how many members follow each band.

Tick one or more bands, then:

- **Add them to the tours page:**
  1. Press **Copy list for bands-scout**.
  2. Paste the list into a text file in the `crawler` folder, for example `bands.txt`.
  3. In the `crawler` folder run `npm run bands-scout -- bands.txt --dry-run` to preview, then `npm run bands-scout -- bands.txt` to add the bands to `crawler/bands.yaml` (details in [`crawler/README.md`](crawler/README.md)).
  4. Check the new entries in `bands.yaml`. If your tours run on GitHub Actions, copy the updated `bands.yaml` to the private data repo too.
  5. Redeploy the public web (`./scripts/deploy-public-web.sh`). This refreshes the list of tracked bands; only then do members see **Added**, and the band is followed for them.

  The suggestions stay in the Suggestions tab until you link or reject them. Once the band is on the tours page you can clear them with **Link selected to an existing band** (below).
- **Reject selected:** type an optional reason (members see it) and confirm.
- **Link selected to an existing band:** use this when the band is already tracked under another name or website (the page cannot match it on its own), or to clear suggestions you have already added. Paste the band's website as written in `bands.yaml` (its `url`). The members who suggested it follow the band right away and see **Added**.

### Revoke or delete a member

In the **Members** tab:

- **Revoke** stops the link from working. The member's list and suggestions are kept, but nobody can use them. There is no "undo": to let the person back in, create a new member.
- **Delete** removes the member together with their list and their suggestions.

### A member lost their link

A lost link cannot be recovered or shown again (the server never stores it). Create a new member for the same person, send the new link, and delete the old member. Their old list is lost, so they need to follow their bands again. A device on which they already opened the old link keeps working until you delete or revoke the old member.

---

## Debugging

If a worker misbehaves, stream its live logs while hitting the endpoint:

```bash
# Terminal 1 — tail logs
wrangler tail tokoro-worker --config worker/wrangler.toml

# Terminal 2 — trigger a request
curl "https://tokoro-worker.YOUR_SUBDOMAIN.workers.dev/events?lat=51.5&lng=-0.09&radius=10"
```

The tail session shows exceptions, console output, and request details in real time. Use `tokoro-crawler-worker` and `crawler-worker/wrangler.toml` for the Crawler Worker.

---

## Troubleshooting

**`error code: 1042`**
The Cloudflare edge is not routing requests to your worker — the workers.dev route is inactive. Redeploy using the globally installed wrangler (not `npm run deploy`, which uses the local version in `node_modules` and may fail silently on some versions):

```bash
wrangler deploy --config worker/wrangler.toml
```

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
