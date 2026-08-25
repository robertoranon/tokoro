# Graph Report - tokoro  (2026-08-25)

## Corpus Check
- 162 files · ~309,708 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1172 nodes · 2049 edges · 165 communities (60 shown, 105 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 104 edges (avg confidence: 0.84)
- Token cost: 672,121 input · 0 output

## Community Hubs (Navigation)
- Event Extraction Pipeline (JSON-LD/LLM)
- Duplicate Detection & Worker Core
- Crawler Test Reporting & Review
- Crawler Orchestration & Scheduling
- WhatsApp Bot Integration
- Crawler Worker Dependencies
- Worker Dependencies
- Public Web Query & Rendering
- LLM Provider Abstraction
- HTML Fetching & Benchmarking
- Event Normalization & Geocoding
- Telegram Bot Integration
- Chrome Extension Manifest
- Chrome Extension Popup UI
- Image & PDF Fetching
- Crawler Package Dependencies
- Crawler TypeScript Config
- Crawler Worker TypeScript Config
- Bot Query Parsing & Formatting
- Feature Ideas Backlog
- Crawler Fetcher Tests
- Worker TypeScript Config
- Page Discovery & Geocode Fallback
- Crawler-Worker Adapter & Normalization
- Crawler NPM Scripts
- Crawler Config Types & Publishing
- Page Discovery Token Limits
- Worker API, Duplicates & Backups
- Crawler Worker Auth & Routing
- Mobile Publisher & Signing
- Shared Package Dependencies
- Event Lifecycle: Crawl to Signed Publish
- Crawler Dev Dependencies
- Bookmarklet Build Script
- Crawler Worker Logger
- API & Architecture Docs Overview
- Project Setup & Component READMEs
- Specs
- Overall Structure
- Package
- Index
- Package
- Readme
- Specs
- Inject Worker Url
- Background
- Package
- Specs
- Group Events.Test.Mjs
- Admin
- Jobs.Yaml
- Readme
- Readme
- Readme
- Readme
- Readability Extractor
- Deploy Public Web.Sh
- Admin
- Admin
- Api Reference
- Api Reference
- Api Reference
- Api Reference
- Api Reference
- Api Reference
- Readme
- Package
- Readme
- Readme
- Specs
- Specs
- Ci.Sh
- Nick Cave Tour
- Set Reference.Sh
- Specs
- Shared.Test.Mjs
- Signing.Test.Mjs
- Backup Local.Sh
- Crawl Image.Sh
- Crawl Page.Sh
- Install Hooks.Sh
- Push Force.Sh
- Release Extension Developer.Sh
- Release Extension Webstore.Sh
- Restore From Backup.Sh
- Setup.Sh
- Crawler Worker POST /crawl (API reference summary)
- iCal feed support (format=ical, window=30d)
- Chrome Extension Icon (128px)
- Chrome Extension Icon (16x16, letter H mark on teal backgrou
- Chrome Extension Icon (48px) - Green 'H' Mark
- Extension popup UI (settings, crawl button, preview)
- Stage 2: LLM extraction fallback (README)
- Stage 3: merge JSON-LD + LLM results
- Chrome permissions rationale (activeTab, scripting, storage,
- FR-11: Background Service Worker
- FR-1: User Settings Management
- FR-3: Content Extraction (rendered HTML capture)
- FR-4: Event Preview Workflow
- FR-5: Event Caching (chrome.storage.local)
- FR-6: Event Publishing Workflow (sign + POST /events)
- FR-8: Context Menu Integration (page crawl)
- FR-9: Image Extraction (context menu)
- MAIN world content script for element-based image extraction
- Chrome Manifest V3 migration requirements
- Backend architecture: Cloudflare Worker + D1
- Geospatial Query Strategy (geohash5/geohash6 prefix filterin
- graphify knowledge graph usage rules
- Chrome browser engine (Playwright default)
- Debug mode (--debug, --normalize flags)
- Jina AI Reader fetcher strategy
- Playwright fetcher strategy
- API publishing (POST /events, batch loop)
- Pre-publish duplicate check (Levenshtein + LLM probability)
- End time estimation policy (never guessed)
- Predefined event categories enum
- ExtractedEvent data schema (raw LLM output)
- DOM-based HTML text cleaning (linkedom)
- Image-based (vision) event extraction
- Image content loading (file/URL to base64)
- NormalizedEvent data schema (signed, ready for API)
- Page discovery (link extraction + LLM filtering)
- PDF content loading (pdfjs-dist, text threshold)
- PDF mode algorithm (text vs image-render routing)
- Per-day grouping (--group-by-day) algorithm
- Timestamp normalization (strip TZ, no UTC conversion)
- Event poster: MESSA, Massimo Silverio, Blak Saagan +6 @ CS R
- Ultraboo(t)th Berlin Festival Poster
- Aquavitae Concert Poster: Yazz Ahmed & Band
- DB benchmark tool (db-benchmark.ts, playwright vs jina recal
- Crawler Worker architecture flow (README)
- POST /crawl endpoint (crawler-worker README)
- POST /extract-text debug endpoint
- Stage 2: LLM extraction (crawler-worker README)
- Telegram bot: crawl/publish + NL /events query
- Environment secrets & wrangler.toml service binding
- Telegram /events natural-language query discovery
- POST /telegram webhook (bot crawl + publish flow)
- GET/POST /whatsapp webhook (bot crawl + publish flow)
- Curator keys: per-tool Ed25519 keypair generation
- Debugging via wrangler tail
- Install and authenticate Wrangler CLI
- Key management overview (curator + admin keys)
- config.local.js single source of truth for URLs/keys
- Public Web interface deployment (optional)
- Verify the setup (health check, register identity, publish)
- Web Publisher manual composing (optional)
- Public Web App Icon (192px)
- Admin Panel component summary
- Apple Shortcut component summary
- Bookmarklet component summary
- Chrome Extension component summary
- Crawler Worker component summary
- Node.js Crawler component summary
- Public Web component summary
- Telegram Bot component summary
- Web Publisher component summary
- Worker component summary

## God Nodes (most connected - your core abstractions)
1. `ExtractedEvent` - 42 edges
2. `LLMProvider` - 41 edges
3. `TestEvaluator` - 21 edges
4. `createLLMProvider()` - 21 edges
5. `EventCrawler` - 20 edges
6. `Tokoro Ideas Backlog` - 20 edges
7. `FetchedPage` - 19 edges
8. `TestResult` - 18 edges
9. `scripts` - 16 edges
10. `HTMLFetcher` - 16 edges

## Surprising Connections (you probably didn't know these)
- `signEvent()` --shares_data_with--> `Canonical Event Data Format & Ed25519 Signature Verification`  [INFERRED]
  public-web/signing.js → worker/SPECS.md
- `Server-side HTML cleaning (extractCleanText)` --references--> `extractCleanText()`  [EXTRACTED]
  docs/diving-deeper/tracing-an-event.md → shared/extractors/html-cleaner.ts
- `map.html — Map View` --semantically_similar_to--> `Geospatial Query Algorithm / Dynamic Geohash Precision Selection`  [INFERRED] [semantically similar]
  public-web/map.html → worker/SPECS.md
- `publish.html — Mobile Publisher` --semantically_similar_to--> `web-publisher/index.html — Event Publisher (legacy manual form)`  [INFERRED] [semantically similar]
  public-web/publish.html → web-publisher/index.html
- `Tracing an Event from Browser to Database` --references--> `verifyEventSignature()`  [EXTRACTED]
  docs/diving-deeper/tracing-an-event.md → worker/src/crypto.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **CLAUDE.md mandates reading each component's SPECS.md** — claude_project_overview, chrome_extension_specs_overview, crawler_worker_specs_overview, crawler_specs_overview [EXTRACTED 1.00]
- **Extract (crawler-worker) -> sign+publish (client) pipeline** — crawler_worker_specs_crawl_endpoint, chrome_extension_specs_preparedevent, chrome_extension_specs_fr6_publishing_workflow, chrome_extension_specs_signedevent [INFERRED 0.85]
- **Crawler extraction test fixtures (event pages and images)** — crawler_tests_readme_overview, crawler_tests_cleaned_pages_abetone_fixture, crawler_tests_fixtures_alcatraz_autechre_event_fixture, crawler_tests_fixtures_alcatraz_fat_freddys_drop_event_fixture, crawler_tests_fixtures_fareast_2026_events_fixture, crawler_tests_fixtures_ig_quod_fixture, crawler_tests_fixtures_naon_event_fixture, crawler_tests_fixtures_nick_cave_tour_fixture [INFERRED 0.85]
- **End-to-end Ed25519 Event Signing Pipeline** — docs_diving_deeper_tracing_an_event_canonical_json_key_order, worker_specs_canonical_event_signing, public_web_signing_signevent, worker_src_crypto_verifyeventsignature [INFERRED 0.85]
- **Two-Stage Duplicate Event Detection (Levenshtein + LLM)** — docs_diving_deeper_tracing_an_event_ninecell_duplicate_check, worker_specs_duplicate_event_detection, worker_readme_duplicate_detection_script [INFERRED 0.85]
- **Dark Theme CSS Variable Rollout Across public-web Pages** — docs_design_2026_05_07_dark_theme_design, public_web_index, public_web_it, public_web_map, public_web_publish [EXTRACTED 1.00]

## Communities (165 total, 105 thin omitted)

### Community 0 - "Event Extraction Pipeline (JSON-LD/LLM)"
Cohesion: 0.06
Nodes (33): EventExtractor, extractJsonLd(), jsdomJsonLdParser(), TestEvaluator, EventExtractor, EventExtractorConfig, formatError(), DEFAULT_MAX_CONTENT_LENGTH (+25 more)

### Community 1 - "Duplicate Detection & Worker Core"
Cohesion: 0.06
Nodes (67): COMMON_PREFIX_RATIO, DEDUP_DISTANCE_KM, DEDUP_SQL_BUFFER_MS, DEDUP_TIME_WINDOW_MS, LEVENSHTEIN_FALLBACK, LEVENSHTEIN_FAST_PATH, LLM_PROBABILITY_THRESHOLD, buildPrompt() (+59 more)

### Community 2 - "Crawler Test Reporting & Review"
Cohesion: 0.10
Nodes (18): compareReports(), ComparisonEntry, findLatestSnapshots(), formatDelta(), loadSnapshot(), main(), ResultKey, statusIcon() (+10 more)

### Community 3 - "Crawler Orchestration & Scheduling"
Cohesion: 0.12
Nodes (17): accumulateResult(), CrawlResult, EventCrawler, groupEventsByDay(), JinaFetcher, generateKeypair(), loadSeedUrls(), main() (+9 more)

### Community 4 - "WhatsApp Bot Integration"
Cohesion: 0.13
Nodes (27): bytesToHex(), deletePendingEvents(), hexToBytes(), KV_TTL_SECONDS, loadPendingEvents(), publishEvent(), signEvent(), storePendingEvents() (+19 more)

### Community 5 - "Crawler Worker Dependencies"
Cohesion: 0.06
Nodes (32): author, dependencies, @anthropic-ai/sdk, @noble/ed25519, openai, zod, description, devDependencies (+24 more)

### Community 6 - "Worker Dependencies"
Cohesion: 0.06
Nodes (32): ngeohash, vitest, dependencies, ngeohash, @noble/ed25519, openai, devDependencies, @cloudflare/workers-types (+24 more)

### Community 7 - "Public Web Query & Rendering"
Cohesion: 0.11
Nodes (22): buildICalUrl(), buildShareUrl(), CAT_COLORS, catColor(), copyICalUrl(), effectiveDays(), listEvents(), _loadedEvents (+14 more)

### Community 8 - "LLM Provider Abstraction"
Cohesion: 0.14
Nodes (15): AnthropicConfig, AnthropicProvider, LLMConfig, OllamaConfig, OllamaProvider, OpenAIConfig, OpenAIProvider, LLMContentBlock (+7 more)

### Community 9 - "HTML Fetching & Benchmarking"
Cohesion: 0.11
Nodes (22): HTMLFetcher, BenchmarkReport, buildReport(), CliArgs, computeStats(), CSV_HEADER, csvEscape(), DbEvent (+14 more)

### Community 10 - "Event Normalization & Geocoding"
Cohesion: 0.14
Nodes (12): APIPublisher, encode(), EventNormalizer, NormalizerConfig, EventNormalizer, NormalizedEvent, geocodeAddress(), GeocodingResult (+4 more)

### Community 11 - "Telegram Bot Integration"
Cohesion: 0.16
Nodes (23): buildKvKey(), CallbackData, encodeCallback(), escapeHtml(), formatEventDetail(), formatEventLine(), formatEventSummary(), handleCallbackQuery() (+15 more)

### Community 12 - "Chrome Extension Manifest"
Cohesion: 0.07
Nodes (27): action, default_icon, default_popup, background, service_worker, content_scripts, 128, 16 (+19 more)

### Community 13 - "Chrome Extension Popup UI"
Cohesion: 0.22
Nodes (25): applyImageExtractionResult(), applyPageCrawlResult(), bytesToHex(), cacheExtractedEvents(), cancelPreview(), displayEventPreview(), extractRenderedContent(), formatDateRange() (+17 more)

### Community 14 - "Image & PDF Fetching"
Cohesion: 0.14
Nodes (5): ImageData, ImageFetcher, isTextDense(), PdfData, PdfFetcher

### Community 15 - "Crawler Package Dependencies"
Cohesion: 0.09
Nodes (23): dependencies, @anthropic-ai/sdk, js-yaml, jsdom, @llamaindex/liteparse, @napi-rs/canvas, @noble/ed25519, node-fetch (+15 more)

### Community 16 - "Crawler TypeScript Config"
Cohesion: 0.09
Nodes (22): compilerOptions, declaration, declarationMap, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution (+14 more)

### Community 17 - "Crawler Worker TypeScript Config"
Cohesion: 0.09
Nodes (22): compilerOptions, allowJs, checkJs, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, lib, module (+14 more)

### Community 18 - "Bot Query Parsing & Formatting"
Cohesion: 0.14
Nodes (21): ApiEvent, CAT_EMOJI, escapeHtml(), fetchEvents(), fmtDateRange(), formatResults(), getNextSundayEnd(), I18nKey (+13 more)

### Community 19 - "Feature Ideas Backlog"
Cohesion: 0.11
Nodes (20): Tokoro Ideas Backlog, Add to Calendar Buttons, tokoro CLI for querying, Curator Profile Pages (/profile?pubkey=), Discover View (GET /discover?pubkey=), Embeddable Calendar Widget (iframe), Event Images (image_url field), Multi-instance Federation (+12 more)

### Community 20 - "Crawler Fetcher Tests"
Cohesion: 0.22
Nodes (8): captureFixture(), CaptureOptions, loadEnv(), main(), loadEnv(), main(), TestFixtureMetadata, createLLMProvider()

### Community 21 - "Worker TypeScript Config"
Cohesion: 0.11
Nodes (18): compilerOptions, allowSyntheticDefaultImports, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, resolveJsonModule (+10 more)

### Community 22 - "Page Discovery & Geocode Fallback"
Cohesion: 0.15
Nodes (5): PageDiscovery, CrawlerEnv, extractAddressFromSearchPage(), PageDiscovery, LLMProvider

### Community 23 - "Crawler-Worker Adapter & Normalization"
Cohesion: 0.20
Nodes (11): CrawlerConfig, CrawlerMode, CrawlResult, WorkerCrawler, NormalizeFailure, CrawlRequest, CrawlResponse, Env (+3 more)

### Community 24 - "Crawler NPM Scripts"
Cohesion: 0.12
Nodes (16): scripts, build, crawl, crawl-jobs, dev, test, test:capture, test:ci (+8 more)

### Community 25 - "Crawler Config Types & Publishing"
Cohesion: 0.19
Nodes (11): CrawlerConfig, CrawlerMode, FetcherType, JINA_PREFERRED_DOMAINS, BrowserEngine, PdfParserType, SchedulerJob, PublishOutcome (+3 more)

### Community 26 - "Page Discovery Token Limits"
Cohesion: 0.15
Nodes (13): EventLinks, EventLinksSchema, FestivalListingsSchema, silentConsole, EventLinks, EventLinksSchema, DEFAULT_MAX_TOKENS, FESTIVAL_LISTING_MAX_TOKENS (+5 more)

### Community 27 - "Worker API, Duplicates & Backups"
Cohesion: 0.17
Nodes (16): Nine-cell geohash neighborhood duplicate check, Event Editing UI (PUT /events/:id), Diving Deeper topic: Controlling who can publish, Diving Deeper topic: Expiring past events & managing duplicates, Tokoro Worker - Backend API README, ALLOWED_PUBKEYS allowlist, API Endpoints (GET/POST /events, DELETE, /admin/blocklist), events + blocklist D1 schema (+8 more)

### Community 28 - "Crawler Worker Auth & Routing"
Cohesion: 0.30
Nodes (13): AuthResult, unauthorizedResponse(), validateApiKey(), CORS_HEADERS, fetch(), handleCrawl(), handleExtractText(), handlePreviewFetch() (+5 more)

### Community 29 - "Mobile Publisher & Signing"
Cohesion: 0.22
Nodes (14): Diving Deeper topic: Publishing via iOS Shortcut, publish.html — Mobile Publisher, ?preview=TOKEN handoff (tryPreview), Tokoro Public Web Query Interface README, build-bookmarklet.js / inject-worker-url.js build process, scripts/deploy-public-web.sh deploy flow, Mobile Publishing (publish.html) entry modes, shortcut-bookmarklet.js Apple Shortcut build artifact (+6 more)

### Community 30 - "Shared Package Dependencies"
Cohesion: 0.13
Nodes (14): dependencies, @anthropic-ai/sdk, openai, zod, exports, ./extractors/*, ./llm/*, ./types/* (+6 more)

### Community 31 - "Event Lifecycle: Crawl to Signed Publish"
Cohesion: 0.14
Nodes (14): Tracing an Event from Browser to Database, CrawlRequest { url, mode, html?, title? }, CrawlResponse { success, events, dropped_events?, cleaned_text? }, Two geohash precisions for radius queries, Event ID = SHA-256 of canonical JSON, EventNormalizer.normalize(event), ExtractedEvent (JSON-LD + LLM merge), Iframe capture raced against 5s timeout (+6 more)

### Community 32 - "Crawler Dev Dependencies"
Cohesion: 0.15
Nodes (13): devDependencies, prettier, tsx, @types/js-yaml, @types/jsdom, @types/node, typescript, prettier (+5 more)

### Community 33 - "Bookmarklet Build Script"
Cohesion: 0.15
Nodes (11): fs, minified, minifiedShortcut, path, NOTE: API_URL is used only for bookmarklet placeholder substitution below., NOTE: This script does NOT replace __TOKORO_WORKER_URL__ in the HTML files., SHORTCUT_OUT, SHORTCUT_SRC (+3 more)

### Community 35 - "API & Architecture Docs Overview"
Cohesion: 0.18
Nodes (9): fetchEvents(replace), API Worker Events endpoints (GET/POST/PUT/DELETE /events), PreparedEvent data structure (from crawler-worker), SignedEvent data structure (posted to API worker), Events API endpoints (CLAUDE.md), POST /crawl (full spec: request/response contract), Apple Shortcut setup (Safari Share Sheet), Required components table (Worker, Crawler Worker, Public Web) (+1 more)

### Community 36 - "Project Setup & Component READMEs"
Cohesion: 0.18
Nodes (11): API Reference (document overview), Chrome extension README overview, Tokoro Event Crawler README overview, seeds.txt seed URL list (Alcatraz Milano calendar), Crawler Worker README overview, Install Chrome Extension client tool, Deploy the API Worker (D1, R2, LLM secrets), Deploy the Crawler Worker (KV, secrets) (+3 more)

### Community 37 - "Specs"
Cohesion: 0.40
Nodes (10): Dark Theme Design — public-web, index.html — Public Web Query Interface (EN), it.html — Public Web Query Interface (IT), map.html — Map View, Public Web — Specification, FR-1: Event Query, FR-2: Date/Time Formatting (fmtRange), FR-3: Repeating Event Grouping (+2 more)

### Community 38 - "Overall Structure"
Cohesion: 0.20
Nodes (10): Stateless crawler worker / client-side signing design, Scheduled Crawling Watchlist, Overall Structure — Getting Started Outline, Diving Deeper topic: Installing and using the Chrome extension, Diving Deeper topic: Crawl modes, fetchers, browser engines, Diving Deeper topic: Debugging extraction & geocoding failures, Diving Deeper topic: Selecting/configuring an LLM provider, Diving Deeper topic: Running the standalone crawler (+2 more)

### Community 39 - "Package"
Cohesion: 0.20
Nodes (9): lint-staged, devDependencies, lint-staged, prettier, wrangler, prettier, wrangler, lint-staged (+1 more)

### Community 40 - "Index"
Cohesion: 0.25
Nodes (8): Canonical JSON fixed key order for signature integrity, Diving Deeper topic: Working with local timestamps, Diving Deeper topic: Signing events with Ed25519, web-publisher/index.html — Event Publisher (legacy manual form), handleSubmit(e), hashEventData(eventData), Canonical Event Data Format & Ed25519 Signature Verification, Timestamp Format Convention (ISO 8601, no timezone, venue-local)

### Community 41 - "Package"
Cohesion: 0.25
Nodes (7): author, description, license, main, name, type, version

### Community 42 - "Readme"
Cohesion: 0.33
Nodes (6): Stage 1: JSON-LD extraction (README), JSON-LD event extraction algorithm, Alcatraz Milano Autechre event page (JSON-LD MusicEvent fixture), Alcatraz Milano Fat Freddy's Drop event page (JSON-LD Event fixture), Birra di Naon jazzAON event page (JSON-LD Event fixture, Luca Dell'Anna Trio), Stage 1: JSON-LD extraction (crawler-worker README)

### Community 43 - "Specs"
Cohesion: 0.33
Nodes (6): Chrome Extension Specification (document overview), Tokoro project overview (6 components), Ed25519 event signing (canonical JSON + SHA-256), Event Crawler Technical Specification overview, Crawler Worker Technical Specification overview, Tokoro project introduction/pitch

### Community 44 - "Inject Worker Url"
Cohesion: 0.33
Nodes (4): ALL_FILES, fs, path, RELAY_FILES

### Community 45 - "Background"
Cohesion: 0.50
Nodes (3): findImageAtLastPosition(), handleImageCrawl(), imageUrlToBase64()

### Community 46 - "Package"
Cohesion: 0.40
Nodes (5): crawler, events, keywords, extraction, llm

### Community 47 - "Specs"
Cohesion: 0.50
Nodes (4): Date inference logic (year hints, day-name validation), LLM event extraction (system prompt + parsing), abetone.txt: cleaned Instagram post text (abetonemusicbar, Sp46 gig), ig-quod.txt: cleaned Instagram post text (quod.design, Paola Pizzino gig)

### Community 49 - "Admin"
Cohesion: 0.67
Nodes (3): saveSettings(workerUrl, privKey, pubKey), Settings modal (Worker URL, admin priv/pub key), Admin key: moderation keypair via admin/admin.html

### Community 50 - "Jobs.Yaml"
Cohesion: 0.67
Nodes (3): jobs.yaml active scheduler config (Le Serre, Kino Siska, CSS Udine, Capitol Pordenone, La prima estate), jobs.example.yaml scheduler config template, Scheduled crawls via jobs.yaml + cron

### Community 51 - "Readme"
Cohesion: 0.67
Nodes (3): Direct mode (crawler README), Direct mode algorithm (crawler SPECS), Direct mode (crawler-worker)

### Community 52 - "Readme"
Cohesion: 0.67
Nodes (3): Discover mode (crawler README), Discover mode algorithm (crawler SPECS), Discover mode (crawler-worker)

### Community 53 - "Readme"
Cohesion: 0.67
Nodes (3): Image mode (crawler README), Image mode algorithm (crawler SPECS), Image mode (crawler-worker)

### Community 54 - "Readme"
Cohesion: 0.67
Nodes (3): Regression testing via pre-push hook + reference.json, Far East Film Festival 2026 events listing page (EventON plugin, WordPress) fixture, Crawler test suite README overview

## Ambiguous Edges - Review These
- `Troubleshooting common errors` → `LLM provider configuration (openai/anthropic/openrouter; no Ollama)`  [AMBIGUOUS]
  HOW-TO-USE.md · relation: conceptually_related_to
- `fetchEvents(replace)` → `POST /crawl (full spec: request/response contract)`  [AMBIGUOUS]
  admin/admin.html · relation: conceptually_related_to
- `Event Editing UI (PUT /events/:id)` → `REST API Endpoints (events, admin/blocklist)`  [AMBIGUOUS]
  docs/ideas.md · relation: conceptually_related_to
- `web-publisher/index.html — Event Publisher (legacy manual form)` → `Timestamp Format Convention (ISO 8601, no timezone, venue-local)`  [AMBIGUOUS]
  web-publisher/index.html · relation: conceptually_related_to

## Knowledge Gaps
- **417 isolated node(s):** `manifest_version`, `name`, `version`, `minimum_chrome_version`, `description` (+412 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **105 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Troubleshooting common errors` and `LLM provider configuration (openai/anthropic/openrouter; no Ollama)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `fetchEvents(replace)` and `POST /crawl (full spec: request/response contract)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Event Editing UI (PUT /events/:id)` and `REST API Endpoints (events, admin/blocklist)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `web-publisher/index.html — Event Publisher (legacy manual form)` and `Timestamp Format Convention (ISO 8601, no timezone, venue-local)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `LLMProvider` connect `Page Discovery & Geocode Fallback` to `Event Extraction Pipeline (JSON-LD/LLM)`, `Duplicate Detection & Worker Core`, `Crawler Test Reporting & Review`, `LLM Provider Abstraction`, `HTML Fetching & Benchmarking`, `Event Normalization & Geocoding`, `Crawler Fetcher Tests`, `Crawler-Worker Adapter & Normalization`, `Crawler Config Types & Publishing`, `Page Discovery Token Limits`?**
  _High betweenness centrality (0.059) - this node is a cross-community bridge._
- **Why does `createLLMProvider()` connect `Crawler Fetcher Tests` to `Duplicate Detection & Worker Core`, `Crawler Test Reporting & Review`, `Crawler Orchestration & Scheduling`, `LLM Provider Abstraction`, `HTML Fetching & Benchmarking`, `Bot Query Parsing & Formatting`, `Page Discovery & Geocode Fallback`, `Crawler-Worker Adapter & Normalization`, `Crawler Worker Auth & Routing`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Why does `Tokoro Worker — Technical Specification` connect `Worker API, Duplicates & Backups` to `Index`, `Duplicate Detection & Worker Core`, `Event Lifecycle: Crawl to Signed Publish`?**
  _High betweenness centrality (0.043) - this node is a cross-community bridge._