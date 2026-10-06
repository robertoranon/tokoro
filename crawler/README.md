# Tokoro Event Crawler

LLM-powered semantic crawler for extracting structured event data from web pages.

## Features

- **Festival Entry Mode / Radar**: One date-range entry per festival homepage (name, dates, place, short description, link), published or updated weekly from a curated `festivals.yaml` watchlist
- **Band Tours**: Watches band sites and venue listings for new shows of the bands in a curated `bands.yaml`, published weekly with `act_name`/`act_url`
- **Festival Mode**: Crawl entire festival programs — discovers all listing/schedule pages and stamps every event with festival metadata
- **Two-Phase Discovery**: Automatically discovers individual event pages from venue homepages
- **Multiple Fetcher Options**: Choose between Playwright (JS rendering) or Jina AI Reader (fast, lightweight)
- **Pluggable Browser Engine**: Playwright can drive headless Chrome (default) or [Obscura](https://github.com/h4ckf0r0day/obscura) (lightweight Rust-based CDP browser with built-in anti-detection)
- **Multi-LLM Support**: Easy switching between OpenRouter, OpenAI, Anthropic, and local Ollama
- **Smart Extraction**: Uses LLMs to extract event details from any web page format with intelligent address parsing
- **Geocoding**: Automatically geocodes addresses to coordinates using OpenStreetMap
- **Event Signing**: Signs events with Ed25519 keypairs
- **API Integration**: Publishes directly to Tokoro API
- **Scheduler**: Run a list of crawl jobs automatically via system cron using a simple YAML config

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

The default provider and model (used when `LLM_PROVIDER` / `LLM_MODEL` are unset) are defined in `shared/llm/defaults.ts`. To override, set in `.env`:

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

#### Festival Entry Mode and the radar watchlist

- **Best for**: keeping a "planning radar" of festivals — one entry per festival for the festival as a whole, not its program
- **Process**: Fetch homepage → LLM extracts one entry (dates from an info page if the homepage has none) → look up the existing entry → publish, update (`PUT`) or leave unchanged
- **Usage (single URL)**: `npm run crawl -- --mode festival-entry <url>` (add `--debug` to print the extracted entry instead of publishing; no API call is made)
- **Usage (watchlist)**: `cp festivals.example.yaml festivals.yaml`, list your festivals, then `npm run radar` (`npm run radar -- --debug` tries it without publishing anything and writes no run log). Always include the `--`: without it npm swallows the flag, but the runner detects npm's `npm_config_debug` and still runs in debug mode
- **Validation**: `festivals.yaml` is validated up front; any error (bad URL, duplicate URL, wrong field type, unknown `status`) exits 1 before anything is crawled. No active festivals: warning, exit 0
- **Several places**: a festival in several towns or venues still gets one entry with one point (its principal site); the other places are appended to the description as `Also takes place in: A, B.`
- **Year evidence**: extracted dates are only trusted if their year appears in the page's URL, title or text, or a weekday confirmed it; otherwise they are dropped (so a stale homepage cannot produce a phantom next-year entry) and the festival is looked up on info pages or ends as `skipped_no_dates`
- **Outcomes** per festival: `published`, `updated`, `unchanged`, `skipped_no_dates` (no dates announced, or the edition already ended), `skipped_series` (the page lists separate events with gaps over 7 days between them, so it is a series rather than one festival; set `status: paused` for it), `failed`. The run exits 1 if any festival failed
- **Staleness report**: each run appends to `logs/runs.jsonl` and prints active festivals with no `published`/`updated`/`unchanged` result in their last 4 runs (dead source, or between editions)
- **Updates**: an existing entry is only re-published (`PUT`) when something that matters to the radar changed: dates, category, a move of more than ~500 m, or a previously empty description now filled. Wording differences between runs are ignored, since LLM output varies
- **Safety**: an existing entry is only ever updated if it looks like a radar entry (tagged `festival` and with the radar date shape: start `T00:00:00`, end `T23:59:59`), so program events from Festival Mode under the same `festival_url` are never overwritten
- **Scheduling**: `0 10 * * 1  cd /path/to/tokoro/crawler && /absolute/path/to/npm run radar >> logs/radar.log 2>&1` (cron's PATH usually lacks npm: find it with `which npm`; `logs/` is gitignored)
- **Tests**: `npm run test:radar` (offline); `npm run smoke:radar` (needs `wrangler dev`)

#### Scout: finding new festivals for the watchlist

- **What it does**: crawls discovery pages (aggregators, magazine roundups, label/venue news), asks the LLM which festivals match your taste profile, and writes proposals to `candidates.yaml`. It never publishes anything and does not need the Tokoro signing keys
- **Setup**: `cp scout-sources.example.yaml scout-sources.yaml`, write your `taste`, list your sources
- **Try it**: `npm run scout -- --debug` (note the `--`) prints candidates and writes nothing; `npm run scout` writes `candidates.yaml` and `scout-state.json`
- **Review**: set each candidate's `status` to `approved` or `rejected` in `candidates.yaml` (fill in a missing `url` for approved ones), then `npm run scout-promote` adds approved festivals to `festivals.yaml` (comments preserved) and remembers rejected ones so they never come back. `candidates.yaml` is rewritten whenever a scout run adds candidates (it re-reads and merges the file first, so your edits survive), so comments in it are lost; use the `notes` field for your own remarks (other unknown fields are rejected)
- **Scheduling**: weekly (every Thursday; edit the crontab line for a less frequent schedule): `0 10 * * 4  cd /path/to/tokoro/crawler && /absolute/path/to/npm run scout >> logs/scout.log 2>&1`
- **Dedup and promote**: urls are compared by host + path + meaningful query (tracking parameters ignored); an approved candidate whose url has a query string (usually an aggregator page) is not promoted until you replace it with the festival's own site. Names already known are given to the LLM so it does not return them again
- **Tests**: `npm run test:scout` (offline)

#### Band tours

- **What it does**: follows a curated set of bands. It reads band sites (every show on the page) and venue/aggregator listings (only shows whose bill names one of your bands, matched by name or alias), and publishes each upcoming show as an event with `act_name`/`act_url`. Changed shows (time, a move of more than ~500 m, a newly filled description or url) are updated; nothing is ever deleted, so vanished shows stay until they expire
- **Setup**: `cp bands.example.yaml bands.yaml`, list your bands (`name` and `url` required), then your sources (`mode: band` for a band's own page, `mode: listing` for a venue page). A default `region` drops shows outside a bounding box (`region: none` on a band overrides it)
- **Try it**: `npm run tours -- --debug` (note the `--`) extracts, geocodes and prints the shows as signed events, publishing nothing and writing no run log. `npm run tours` is a live run; use `--bands <path>` for another file. Deploy the worker with the act fields first
- **Outcomes** per show: `published`, `updated`, `unchanged`, `unmatched`, `skipped_past`, `skipped_out_of_region`, `failed`. The run exits 1 if any show failed. A show that cannot be geocoded is `failed` and retried next run
- **Staleness report**: each run appends a `kind: "tours"` record to `logs/runs.jsonl` and prints sources with no `published`/`updated`/`unchanged` result in their last 4 runs
- **Scheduling**: `0 10 * * 3  cd /path/to/tokoro/crawler && /absolute/path/to/npm run tours >> logs/tours.log 2>&1` (Wednesdays; cron's PATH usually lacks npm: find it with `which npm`)
- **Tests**: `npm run test:tours` (offline); `npm run smoke:tours` (needs `wrangler dev`)
- **Building bands.yaml from a list**: instead of writing entries by hand, put one band per line in a text file (`#` comments allowed; `Name | https://site` gives the official site and skips the search) and let `npm run bands-scout` find each band's site and tour page and add the missing `bands` and `sources` entries. It needs `BRAVE_SEARCH_API_KEY` (for bands without a site given) plus your usual LLM settings. Bands already in `bands.yaml` (by name or alias) are skipped without any search, existing comments are kept, and nothing is written with `--dry-run`. Review the result: aliases, regions and listing sources are still by hand. Details in `SPECS.md` section 4.11. Tests: `npm run test:bands-scout` (offline)

  ```bash
  printf 'Band A\nBand B | https://bandb.example\n' > list.txt
  npm run bands-scout -- list.txt --dry-run   # preview, writes nothing
  npm run bands-scout -- list.txt             # add the entries to bands.yaml
  ```

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

### Scheduled Crawls

Run a fixed list of crawl jobs automatically using your system's cron scheduler (crontab, launchd).

**1. Edit `jobs.yaml`** in the `crawler/` directory:

```yaml
cron: "0 9 * * *"   # informational — paste this into your crontab

jobs:
  - name: "Blue Note Jazz"
    urls:
      - https://bluenotejazz.com/events
    mode: discover
    fetcher: jina

  - name: "Local Festival"
    urls:
      - https://somefestival.com
    mode: festival
    fetcher: playwright
    browser: chrome
    model: claude-3-5-sonnet-20241022
```

Each job accepts the same options as the CLI (`mode`, `fetcher`, `browser`, `model`, `date`, `max_tokens`, `no_jsonld`, `group_by_day`, `pdf_parser`, `debug`, `normalize`). Only `urls` is required. Jobs run sequentially; a failure in one job is logged and skipped — the rest still run.

**2. Run manually to test:**

```bash
npm run crawl-jobs
# or point to a custom config file:
npm run crawl-jobs -- --jobs /path/to/my-jobs.yaml
```

**3. Add a crontab entry** (paste the `cron` value from `jobs.yaml`):

```bash
crontab -e
# Add:
0 9 * * *  cd /path/to/tokoro/crawler && npm run crawl-jobs
```

The process exits with code 1 if any job fails, so cron monitoring tools can alert on failures.

### Debug Mode

Use debug mode to test extraction without publishing to the API.

By default, `--debug` skips normalization (geocoding + signing) for fast feedback on the raw LLM output. Use `--normalize` together with `--debug` to run full normalization without publishing.

| Flags | Geocoding | Signing | API publish |
|---|---|---|---|
| _(none)_ | ✅ | ✅ | ✅ |
| `--debug` | ❌ | ❌ | ❌ |
| `--debug --normalize` | ✅ | ✅ | ❌ |

- **Usage**: `npm run crawl -- --debug <url>`
- **Always include the `--`**: `npm run crawl --debug <url>` (without it) makes npm swallow the flag, which used to mean a real publish. The CLI now detects npm's `npm_config_debug`, prints a notice and still runs in debug mode. Live runs print a `LIVE RUN` line naming the API URL before crawling.
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
├── setup.ts       # Shared env/keypair/LLM setup
├── index.ts       # CLI entry point (npm run crawl)
└── scheduler.ts   # Scheduler entry point (npm run crawl-jobs)
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
