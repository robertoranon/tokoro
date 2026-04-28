# Tokoro Event Crawler

LLM-powered semantic crawler for extracting structured event data from web pages.

## Features

- **Festival Mode**: Crawl entire festival programs — discovers all listing/schedule pages and stamps every event with festival metadata
- **Two-Phase Discovery**: Automatically discovers individual event pages from venue homepages
- **Multiple Fetcher Options**: Choose between Playwright (JS rendering) or Jina AI Reader (fast, lightweight)
- **Pluggable Browser Engine**: Playwright can drive headless Chrome (default) or [Obscura](https://github.com/h4ckf0r0day/obscura) (lightweight Rust-based CDP browser with built-in anti-detection)
- **Multi-LLM Support**: Easy switching between OpenRouter, OpenAI, Anthropic, and local Ollama
- **Smart Extraction**: Uses LLMs to extract event details from any web page format with intelligent address parsing
- **Geocoding**: Automatically geocodes addresses to coordinates using OpenStreetMap
- **Event Signing**: Signs events with Ed25519 keypairs
- **API Integration**: Publishes directly to Tokoro API

## Future work

Improve geocoding by using information outside the given page (e.g. google searching the venue name)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Install Playwright browsers:

```bash
npx playwright install chromium
```

2b. *(Optional)* Install [Obscura](https://github.com/h4ckf0r0day/obscura) for a faster, stealth-capable alternative to headless Chrome:

```bash
# macOS Apple Silicon
curl -LO https://github.com/h4ckf0r0day/obscura/releases/latest/download/obscura-aarch64-macos.tar.gz
tar xzf obscura-aarch64-macos.tar.gz && sudo mv obscura /usr/local/bin/

# macOS Intel
curl -LO https://github.com/h4ckf0r0day/obscura/releases/latest/download/obscura-x86_64-macos.tar.gz
tar xzf obscura-x86_64-macos.tar.gz && sudo mv obscura /usr/local/bin/

# Linux x86_64
curl -LO https://github.com/h4ckf0r0day/obscura/releases/latest/download/obscura-x86_64-linux.tar.gz
tar xzf obscura-x86_64-linux.tar.gz && sudo mv obscura /usr/local/bin/
```

3. Generate a crawler keypair:

```bash
npm run crawl -- --generate-keypair
```

4. Create `.env` file and fill in your keypair and LLM provider settings:

```bash
cp .env.example .env
# Edit .env: set CRAWLER_PRIVKEY, CRAWLER_PUBKEY (from step 3), LLM_PROVIDER, LLM_API_KEY
```

5. Sync `TOKORO_API_URL` from the repo's `config.local.js` (single source of truth for URLs):

```bash
cd .. && ./scripts/setup.sh
```

## Usage

### Crawl specific URLs

```bash
npm run crawl https://alcatrazmilano.it/eventi/tinariwen/
```

### Crawl from seeds file

Edit `seeds.txt` to add URLs, then:

```bash
npm run crawl
```

### Switch LLM providers

In `.env`, set:

```bash
# For OpenRouter (recommended - access to many models)
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=your_key_here
OPENROUTER_MODEL=meta-llama/llama-3.1-8b-instruct:free
# See https://openrouter.ai/models for available models

# For OpenAI
LLM_PROVIDER=openai
OPENAI_API_KEY=your_key_here

# For Anthropic Claude
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_key_here

# For Ollama (local)
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1
```

You can also override the OpenRouter model on a per-run basis:

```bash
# Use a specific model for this crawl (overrides .env)
npm run crawl -- --model google/gemini-2.0-flash-exp:free https://venue.com/events

# Test different models for comparison
npm run crawl -- --model anthropic/claude-3.5-sonnet https://venue.com/events
```

### Choose Fetcher Strategy

The crawler supports two fetching strategies:

#### Playwright (Default) + HTML cleaner

- **Best for**: JavaScript-heavy sites, SPAs, dynamic content
- **Pros**: Renders JavaScript, handles modern web apps, custom HTML cleaning code (remove tags + useless content)
- **Cons**: Slower, higher resource usage (requires Chromium)
- **Usage**: `npm run crawl -- --fetcher playwright <url>` (or omit flag for default)

#### Jina AI Reader

- **Best for**: Static HTML sites, faster crawling, lower resource usage
- **Pros**: theoretically faster, no browser overhead, cleaner markdown output
- **Cons**: Some limitations when rendering JavaScript (Very complex sites with unusual loading sequences might still require tweaking e.g., waiting for selectors or longer timeouts), requires API access
- **Free tier**: 1M tokens/month from Jina AI
- **Usage**: `npm run crawl -- --fetcher jina <url>`

**Example:**

```bash
# Fast crawling with Jina AI Reader
npm run crawl -- --fetcher jina https://example.com/events

# Full JavaScript rendering with Playwright
npm run crawl -- --fetcher playwright https://modern-spa.com/events

# Combine with other flags
npm run crawl -- --fetcher jina --mode direct https://example.com/event/123
```

### Choose Browser Engine (Playwright only)

When using the Playwright fetcher, you can choose which headless browser engine drives it:

#### Chrome (Default)

- **Engine**: Full headless Chromium via Playwright
- **Best for**: Maximum compatibility; complex JS-heavy pages
- **Pros**: Most faithful rendering, highest compatibility
- **Cons**: ~200 MB RAM, ~500 ms page load, ~2 s startup
- **Usage**: `npm run crawl -- <url>` (default) or `npm run crawl -- --browser chrome <url>`

#### Obscura (Opt-in)

- **Engine**: Lightweight Rust-based browser with V8 JS, exposes Chrome DevTools Protocol
- **Best for**: High-volume crawling, bot-detection-prone sites
- **Pros**: ~30 MB RAM, ~85 ms page load, instant startup, built-in anti-fingerprinting and tracker blocking
- **Cons**: May render JS-heavy pages differently from Chrome; requires [separate install](https://github.com/h4ckf0r0day/obscura/releases); auto-launched by the crawler on first use
- **Usage**: `npm run crawl -- --browser obscura <url>`
- **Persistent default**: set `BROWSER_ENGINE=obscura` in `.env`
- **Pre-running Obscura**: set `OBSCURA_WS_ENDPOINT=ws://127.0.0.1:9222` to connect to an already-running `obscura serve` instance instead of auto-launching

```bash
# Use Obscura for a single crawl
npm run crawl -- --browser obscura https://example.com/events

# Use Chrome explicitly
npm run crawl -- --browser chrome https://example.com/events
```

### Choose Crawler Mode

The crawler supports four operational modes:

#### 1. Direct Mode (Default)

- **Best for**: Single event pages or when you have direct URLs
- **Process**: Fetch URL → Clean HTML → LLM extracts
- **Usage**: `npm run crawl -- --mode direct <url>`

#### 2. Discover Mode

- **Best for**: Venue homepages or calendar pages that link to individual event pages (one event per page)
- **Process**: Fetch homepage → LLM discovers individual event page URLs → Fetch each event page → Clean HTML → LLM extracts
- **Key behavior**: follows links to individual event pages; each page typically yields one event
- **Usage**: `npm run crawl -- --mode discover <url>`

#### 3. Festival Mode

- **Best for**: Festival homepages (e.g. flowfestival.com, glastonbury.co.uk) where the program is spread across schedule/listing sub-pages
- **Process**: Fetch homepage → LLM discovers program/schedule listing pages → Fetch each listing page → LLM extracts all events directly (no further link following) → stamp every event with `festival_name` and `festival_url` → LLM deduplication pass removes wrapper events and semantic duplicates
- **Key behavior**: does NOT follow links to individual event pages; instead extracts all events in bulk from each listing page; use `--group-by-day` to collapse per-day into a single aggregate event
- **Usage**: `npm run crawl -- --mode festival <url>`

All extracted events automatically receive `festival_name` (from the page title) and `festival_url` (the homepage origin), which enables festival-scoped queries via `GET /events?festival_url=...`.

After collection, a deduplication LLM call removes two classes of noise:
- **Redundant wrapper events**: a general "Festival 2026" event spanning all days when individual day events already exist
- **Semantic duplicates**: the same event extracted twice under slightly different names (e.g. "Sunday" vs "Family Sunday")

Legitimate parallel events (different stages or acts running at the same time) are preserved.

#### 4. Image Mode

- **Best for**: Event flyers, posters, social media images
- **Process**: Load image → Multimodal LLM extracts event data
- **Usage**: `npm run crawl -- --image <file-or-url>` or `npm run crawl -- --mode image <file-or-url>`

**Examples:**

```bash
# Direct mode: extract from a specific event page (default)
npm run crawl https://venue.com/events/concert-name

# Discover mode: find and follow event links
npm run crawl -- --mode discover https://venue.com/events

# Festival mode: crawl an entire festival program
npm run crawl -- --mode festival https://www.flowfestival.com

# Image mode: extract from a flyer
npm run crawl -- --image path/to/flyer.jpg
```

### Debug Mode

Use debug mode to test extraction without publishing to the API.

By default, `--debug` skips normalization (geocoding + signing) for fast feedback on the raw LLM output. Use `--normalize` together with `--debug` to run full normalization without publishing.

| Flags | Geocoding | Signing | API publish |
|---|---|---|---|
| _(none)_ | ✅ | ✅ | ✅ |
| `--debug` | ❌ | ❌ | ❌ |
| `--debug --normalize` | ✅ | ✅ | ❌ |

- **Usage**: `npm run crawl -- --debug <url>`
- **Usage (with normalization)**: `npm run crawl -- --debug --normalize <url>`

**Example:**

```bash
# Debug mode: fast — prints raw LLM output, skips geocoding/signing
npm run crawl -- --debug https://venue.com/events/concert-name

# Debug mode with normalization: geocodes and signs but does not publish
npm run crawl -- --debug --normalize https://venue.com/events/concert-name

# Combine with other flags
npm run crawl -- --mode discover --fetcher jina --debug https://venue.com/events
```

**Output (without `--normalize`):** Each extracted event is printed as raw JSON from the LLM, before geocoding or signing.

**Output (with `--normalize`):** Each event is printed as fully normalized JSON including coordinates, geohash, signature, and timestamps.

### Reference Date Override

By default, the LLM receives today's date to help infer event dates (e.g., "next Friday" → actual date). You can override this for testing or reprocessing historical captures:

- **Best for**: Testing with past snapshots, reproducing extraction results, debugging date inference
- **Usage**: `npm run crawl -- --date <YYYY-MM-DD> <url>`

**Example:**

```bash
# Use a specific reference date for extraction
npm run crawl -- --date 2026-03-02 https://venue.com/events

# Combine with other flags
npm run crawl -- --date 2026-03-02 --mode direct --debug https://venue.com/events
```

This is particularly useful when testing with saved HTML snapshots from a specific date, ensuring the LLM interprets relative dates (like "tomorrow" or "next week") correctly based on when the page was captured.

## How It Works

The crawler operates in different phases depending on the mode:

### Discover Mode Workflow

1. **Fetch venue homepage**: Uses selected fetcher (Playwright or Jina AI)
2. **Extract links**: Parses all `<a href>` elements from the page
3. **Filter links**: Removes obvious non-event links (social media, mailto, etc.)
4. **LLM classification**: Asks LLM to identify which links point to individual event pages
5. **For each discovered URL**:
   - Fetch page with selected fetcher
   - Clean content (clean HTML or Jina markdown)
   - LLM extracts event data
6. **Normalize, sign, and publish** each event

### Direct Mode Workflow

1. **Fetch URL**: Uses selected fetcher
2. **Clean content**: clean HTML or Jina markdown
3. **LLM extracts**: Structured event data from cleaned content
4. **Normalize, sign, and publish**

### Festival Mode Workflow

1. **Fetch festival homepage**: Uses selected fetcher
2. **Derive festival identity**: Name from page title, URL from origin (e.g. `https://www.flowfestival.com`)
3. **Discover listing pages**: LLM identifies program/schedule sub-pages (e.g. `/program/music`, `/lineup`)
4. **For each listing page**:
   - Fetch page
   - LLM extracts all events directly (no further link following)
   - Stamp every event with `festival_name` and `festival_url`
5. **Log all collected events** (title + time range) before filtering
6. **LLM deduplication**: Remove wrapper events and semantic duplicates; log what was removed and why
7. **Log final kept events** after filtering
8. **Normalize, sign, and publish** all kept events

**Smart Address Extraction**: All modes prompt the LLM to extract complete street addresses (e.g., "Via Valtellina 25, Milano") rather than just venue names or city names, ensuring accurate geocoding.

## Architecture

```
src/
├── llm/           # LLM provider abstraction
├── extractors/    # HTML fetching & event extraction
├── utils/         # Geocoding, signing, publishing
├── types/         # TypeScript types & Zod schemas
├── crawler.ts     # Main crawler orchestration
└── index.ts       # CLI entry point
```

## Configuration

See `.env.example` for all available options.

### Command-Line Options Summary

```bash
npm run crawl -- [options] <url>

Options:
  --mode <mode>           Crawler mode: direct, discover, image, festival, or pdf (default: direct)
  --fetcher <fetcher>     Fetcher strategy: playwright or jina (default: playwright)
  --browser <engine>      Browser engine when using Playwright: chrome or obscura (default: chrome)
  --model <model>         Override LLM model (OpenRouter models only)
  --date <YYYY-MM-DD>     Reference date for LLM date inference (default: today)
  --max-tokens <N>        Override output token budget for LLM extraction
  --group-by-day          Collapse extracted events into one aggregate event per calendar day
  --no-jsonld             Disable JSON-LD extraction; use LLM only
  --debug                 Print raw LLM output, skip normalization/geocoding and API publishing
  --normalize             (With --debug) run full normalization (geocoding + signing) but skip publishing
  --image                 Shorthand for --mode image
  --pdf                   Shorthand for --mode pdf
  --text-file <path>      Skip fetching; pass text file directly to LLM (prompt testing)
  --generate-keypair      Generate new Ed25519 keypair

Examples:
  npm run crawl https://venue.com/events
  npm run crawl -- --mode discover --fetcher jina https://venue.com/events
  npm run crawl -- --mode festival https://www.flowfestival.com
  npm run crawl -- --browser obscura https://venue.com/events
  npm run crawl -- --model google/gemini-2.0-flash-exp:free https://venue.com/events
  npm run crawl -- --date 2026-03-02 --debug https://venue.com/events
  npm run crawl -- --image path/to/flyer.jpg
  npm run crawl -- --pdf path/to/schedule.pdf
```

## Testing

Start with a single event page URL to test:

```bash
npm run crawl https://alcatrazmilano.it/eventi/tinariwen/
```

Check your local worker to see if the event was published:

```bash
curl "http://localhost:8787/events?lat=45.494495&lng=9.182627&radius=10"
```

## Regression Testing

A pre-push hook runs crawler extraction tests automatically when `shared/` files change.

### Setup (run once after cloning)

```bash
./scripts/install-hooks.sh
```

### Manual commands (run from `crawler/`)

| Command | Effect |
|---------|--------|
| `npm run test:ci` | Run tests and compare against reference snapshot |
| `npm run test:set-reference` | Promote the latest test run as the new reference baseline |

### What happens on push

- If no `shared/` files changed: push proceeds normally (no tests run)
- If `shared/` files changed: tests run and are compared to `crawler/tests/snapshots/reference.json`
  - **No regressions**: push proceeds; `reference.json` updated automatically if results improved
  - **Regressions detected**: push is blocked and a diff table is printed

### Options when blocked

1. Fix the regression → `git push`
2. Accept current results as new baseline → `cd crawler && npm run test:set-reference` → commit `reference.json` → `git push`
3. Force push (bypass tests) → `./scripts/push-force.sh`
