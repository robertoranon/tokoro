# Graph Report - tokoro  (2026-10-01)

## Corpus Check
- 166 files · ~350,250 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1431 nodes · 2772 edges · 177 communities (70 shown, 107 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 130 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `832a71f7`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- shared/extractors/event-extractor.ts
- worker/src/index.ts
- TestResult
- pdf-fetcher.ts
- whatsapp.ts
- crawler-worker/package.json
- scripts
- query.js
- llm.ts
- LLMProvider
- test-scout.ts
- telegram.ts
- manifest.json
- popup.js
- radar.ts
- dependencies
- compilerOptions
- compilerOptions
- query-shared.ts
- Tokoro Ideas Backlog
- crawler.ts
- compilerOptions
- festivals.js
- crawler-adapter.ts
- scripts
- EventCrawler
- normalizer.ts
- Tokoro Worker — Technical Specification
- crawler-worker/src/index.ts
- Tokoro Public Web Query Interface README
- shared/package.json
- Tracing an Event from Browser to Database
- devDependencies
- build-bookmarklet.js
- CrawlerLogger
- POST /crawl (full spec: request/response contract)
- Documentation section (links to other docs)
- index.html — Public Web Query Interface (EN)
- Overall Structure — Getting Started Outline
- devDependencies
- web-publisher/index.html — Event Publisher (legacy manual form)
- crawler/package.json
- JSON-LD event extraction algorithm
- Tokoro project overview (6 components)
- inject-worker-url.js
- background.js
- keywords
- LLM event extraction (system prompt + parsing)
- group-events.test.mjs
- Settings modal (Worker URL, admin priv/pub key)
- Scheduled crawls via jobs.yaml + cron
- Direct mode algorithm (crawler SPECS)
- Discover mode algorithm (crawler SPECS)
- Image mode algorithm (crawler SPECS)
- Crawler test suite README overview
- readability-extractor.ts
- deploy-public-web.sh
- buildRows(events, tbody)
- handleDelete(ev, rowEl)
- Ed25519 write authentication + ALLOWED_PUBKEYS
- events table SQL schema (API reference copy)
- API Worker Discovery/Feed endpoints
- API Worker Follows endpoints
- API Worker Stars endpoints
- Timestamp convention: ISO 8601 local time, no TZ
- Two-step workflow: extract then sign+publish
- test-runner.ts
- Obscura browser engine (opt-in, CDP)
- Festival mode (crawler README)
- Geocoding via Nominatim with fallback cascade
- Jina AI Reader fetcher algorithm
- ci.sh
- Nick Cave Tour Dates listing page fixture
- set-reference.sh
- LLM provider configuration (openai/anthropic/openrouter; no Ollama)
- shared.test.mjs
- signing.test.mjs
- backup-local.sh
- crawl-image.sh
- crawl-page.sh
- install-hooks.sh
- push-force.sh
- release-extension-developer.sh
- release-extension-webstore.sh
- restore-from-backup.sh
- setup.sh
- Crawler Worker POST /crawl (API reference summary)
- iCal feed support (format=ical, window=30d)
- Chrome Extension Icon (128px)
- Chrome Extension Icon (16x16, letter H mark on teal background)
- Chrome Extension Icon (48px) - Green 'H' Mark
- Extension popup UI (settings, crawl button, preview)
- Stage 2: LLM extraction fallback (README)
- Stage 3: merge JSON-LD + LLM results
- Chrome permissions rationale (activeTab, scripting, storage, contextMenus, notifications, host_permissions)
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
- Geospatial Query Strategy (geohash5/geohash6 prefix filtering)
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
- Event poster: MESSA, Massimo Silverio, Blak Saagan +6 @ CS Rivolta, Venezia - Sab 14 Marzo 2026
- Ultraboo(t)th Berlin Festival Poster
- Aquavitae Concert Poster: Yazz Ahmed & Band
- DB benchmark tool (db-benchmark.ts, playwright vs jina recall)
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
- test-radar.ts
- NormalizedEvent
- smoke-put.ts
- api-publisher.ts
- db-benchmark.ts
- TestRunner
- compare.ts
- publish.html — Mobile Publisher
- HTMLFetcher
- report.ts
- festivals.test.mjs
- inject.test.mjs

## God Nodes (most connected - your core abstractions)
1. `LLMProvider` - 47 edges
2. `ExtractedEvent` - 43 edges
3. `FetchedPage` - 28 edges
4. `EventCrawler` - 26 edges
5. `scripts` - 24 edges
6. `main()` - 22 edges
7. `createLLMProvider()` - 22 edges
8. `TestEvaluator` - 21 edges
9. `Tokoro Ideas Backlog` - 20 edges
10. `TestResult` - 18 edges

## Surprising Connections (you probably didn't know these)
- `Server-side HTML cleaning (extractCleanText)` --references--> `extractCleanText()`  [EXTRACTED]
  docs/diving-deeper/tracing-an-event.md → shared/extractors/html-cleaner.ts
- `publish.html — Mobile Publisher` --semantically_similar_to--> `web-publisher/index.html — Event Publisher (legacy manual form)`  [INFERRED] [semantically similar]
  public-web/publish.html → web-publisher/index.html
- `map.html — Map View` --semantically_similar_to--> `Geospatial Query Algorithm / Dynamic Geohash Precision Selection`  [INFERRED] [semantically similar]
  public-web/map.html → worker/SPECS.md
- `signEvent()` --shares_data_with--> `Canonical Event Data Format & Ed25519 Signature Verification`  [INFERRED]
  public-web/signing.js → worker/SPECS.md
- `Tracing an Event from Browser to Database` --references--> `verifyEventSignature()`  [EXTRACTED]
  docs/diving-deeper/tracing-an-event.md → worker/src/crypto.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Dark Theme CSS Variable Rollout Across public-web Pages** — docs_design_2026_05_07_dark_theme_design, public_web_index, public_web_it, public_web_map, public_web_publish [EXTRACTED 1.00]
- **CLAUDE.md mandates reading each component's SPECS.md** — claude_project_overview, chrome_extension_specs_overview, crawler_worker_specs_overview, crawler_specs_overview [EXTRACTED 1.00]
- **Two-Stage Duplicate Event Detection (Levenshtein + LLM)** — docs_diving_deeper_tracing_an_event_ninecell_duplicate_check, worker_specs_duplicate_event_detection, worker_readme_duplicate_detection_script [INFERRED 0.85]
- **End-to-end Ed25519 Event Signing Pipeline** — docs_diving_deeper_tracing_an_event_canonical_json_key_order, worker_specs_canonical_event_signing, public_web_signing_signevent, worker_src_crypto_verifyeventsignature [INFERRED 0.85]
- **Crawler extraction test fixtures (event pages and images)** — crawler_tests_readme_overview, crawler_tests_cleaned_pages_abetone_fixture, crawler_tests_fixtures_alcatraz_autechre_event_fixture, crawler_tests_fixtures_alcatraz_fat_freddys_drop_event_fixture, crawler_tests_fixtures_fareast_2026_events_fixture, crawler_tests_fixtures_ig_quod_fixture, crawler_tests_fixtures_naon_event_fixture, crawler_tests_fixtures_nick_cave_tour_fixture [INFERRED 0.85]
- **Extract (crawler-worker) -> sign+publish (client) pipeline** — crawler_worker_specs_crawl_endpoint, chrome_extension_specs_preparedevent, chrome_extension_specs_fr6_publishing_workflow, chrome_extension_specs_signedevent [INFERRED 0.85]

## Communities (177 total, 107 thin omitted)

### Community 0 - "shared/extractors/event-extractor.ts"
Cohesion: 0.06
Nodes (42): extractJsonLd(), jsdomJsonLdParser(), EventLinks, EventLinksSchema, FestivalInfoPagesSchema, FestivalListingsSchema, silentConsole, EventLinks (+34 more)

### Community 1 - "worker/src/index.ts"
Cohesion: 0.06
Nodes (73): COMMON_PREFIX_RATIO, DEDUP_DISTANCE_KM, DEDUP_SQL_BUFFER_MS, DEDUP_TIME_WINDOW_MS, LEVENSHTEIN_FALLBACK, LEVENSHTEIN_FAST_PATH, LLM_PROBABILITY_THRESHOLD, defaultModelFor() (+65 more)

### Community 2 - "TestResult"
Cohesion: 0.29
Nodes (4): HumanReviewer, main(), HumanReviewSession, TestResult

### Community 3 - "pdf-fetcher.ts"
Cohesion: 0.14
Nodes (5): ImageData, ImageFetcher, isTextDense(), PdfData, PdfFetcher

### Community 4 - "whatsapp.ts"
Cohesion: 0.15
Nodes (24): deletePendingEvents(), loadPendingEvents(), publishEvent(), storePendingEvents(), handlePublishAll(), ButtonData, encodeButtonId(), formatEventDetail() (+16 more)

### Community 5 - "crawler-worker/package.json"
Cohesion: 0.06
Nodes (32): author, dependencies, @anthropic-ai/sdk, @noble/ed25519, openai, zod, description, devDependencies (+24 more)

### Community 6 - "scripts"
Cohesion: 0.06
Nodes (32): ngeohash, vitest, dependencies, ngeohash, @noble/ed25519, openai, devDependencies, @cloudflare/workers-types (+24 more)

### Community 7 - "query.js"
Cohesion: 0.11
Nodes (22): buildICalUrl(), buildShareUrl(), CAT_COLORS, catColor(), copyICalUrl(), effectiveDays(), listEvents(), _loadedEvents (+14 more)

### Community 8 - "llm.ts"
Cohesion: 0.07
Nodes (33): captureFixture(), CaptureOptions, loadEnv(), main(), loadEnv(), main(), dirs, files (+25 more)

### Community 9 - "LLMProvider"
Cohesion: 0.19
Nodes (7): FestivalEntryExtractorConfig, ExtractionResult, matchDbEvent(), UrlFetchResult, TestEvaluator, ExtractedEvent, LLMProvider

### Community 10 - "test-scout.ts"
Cohesion: 0.06
Nodes (72): dateString(), FestivalsConfig, optionalString(), parseFestivalsConfig(), pick(), VALID_BROWSERS, VALID_FETCHERS, VALID_STATUSES (+64 more)

### Community 11 - "telegram.ts"
Cohesion: 0.16
Nodes (22): buildKvKey(), CallbackData, encodeCallback(), escapeHtml(), formatEventDetail(), formatEventLine(), formatEventSummary(), handleCallbackQuery() (+14 more)

### Community 12 - "manifest.json"
Cohesion: 0.07
Nodes (27): action, default_icon, default_popup, background, service_worker, content_scripts, 128, 16 (+19 more)

### Community 13 - "popup.js"
Cohesion: 0.22
Nodes (25): applyImageExtractionResult(), applyPageCrawlResult(), bytesToHex(), cacheExtractedEvents(), cancelPreview(), displayEventPreview(), extractRenderedContent(), formatDateRange() (+17 more)

### Community 14 - "radar.ts"
Cohesion: 0.20
Nodes (20): generateKeypair(), loadSeedUrls(), main(), printUsage(), activeFestivals(), main(), RadarCounters, tallyOutcomes() (+12 more)

### Community 15 - "dependencies"
Cohesion: 0.08
Nodes (25): dependencies, @anthropic-ai/sdk, js-yaml, jsdom, linkedom, @llamaindex/liteparse, @napi-rs/canvas, @noble/ed25519 (+17 more)

### Community 16 - "compilerOptions"
Cohesion: 0.09
Nodes (22): compilerOptions, declaration, declarationMap, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution (+14 more)

### Community 17 - "compilerOptions"
Cohesion: 0.09
Nodes (22): compilerOptions, allowJs, checkJs, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, lib, module (+14 more)

### Community 18 - "query-shared.ts"
Cohesion: 0.14
Nodes (21): ApiEvent, CAT_EMOJI, escapeHtml(), fetchEvents(), fmtDateRange(), formatResults(), getNextSundayEnd(), I18nKey (+13 more)

### Community 19 - "Tokoro Ideas Backlog"
Cohesion: 0.11
Nodes (20): Tokoro Ideas Backlog, Add to Calendar Buttons, tokoro CLI for querying, Curator Profile Pages (/profile?pubkey=), Discover View (GET /discover?pubkey=), Embeddable Calendar Widget (iframe), Event Images (image_url field), Multi-instance Federation (+12 more)

### Community 20 - "crawler.ts"
Cohesion: 0.18
Nodes (16): CrawlerConfig, CrawlerMode, CrawlResult, FetcherType, JINA_PREFERRED_DOMAINS, RadarEntryResult, BrowserEngine, PdfParserType (+8 more)

### Community 21 - "compilerOptions"
Cohesion: 0.11
Nodes (18): compilerOptions, allowSyntheticDefaultImports, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, resolveJsonModule (+10 more)

### Community 22 - "festivals.js"
Cohesion: 0.06
Nodes (31): addDays(), api, buildRadarUrl(), byDistance(), byStartThenName(), filterFestivals(), groupFestivals(), haversineKm() (+23 more)

### Community 23 - "crawler-adapter.ts"
Cohesion: 0.15
Nodes (16): bytesToHex(), hexToBytes(), KV_TTL_SECONDS, signEvent(), CrawlerConfig, CrawlerMode, CrawlResult, WorkerCrawler (+8 more)

### Community 24 - "scripts"
Cohesion: 0.08
Nodes (24): scripts, build, crawl, crawl-jobs, dev, radar, scout, scout-promote (+16 more)

### Community 25 - "EventCrawler"
Cohesion: 0.36
Nodes (3): accumulateResult(), EventCrawler, groupEventsByDay()

### Community 26 - "normalizer.ts"
Cohesion: 0.11
Nodes (13): PageDiscovery, encode(), EventNormalizer, extractAddressFromSearchPage(), NormalizerConfig, EventNormalizer, PageDiscovery, geocodeAddress() (+5 more)

### Community 27 - "Tokoro Worker — Technical Specification"
Cohesion: 0.17
Nodes (16): Nine-cell geohash neighborhood duplicate check, Event Editing UI (PUT /events/:id), Diving Deeper topic: Controlling who can publish, Diving Deeper topic: Expiring past events & managing duplicates, Tokoro Worker - Backend API README, ALLOWED_PUBKEYS allowlist, API Endpoints (GET/POST /events, DELETE, /admin/blocklist), events + blocklist D1 schema (+8 more)

### Community 28 - "crawler-worker/src/index.ts"
Cohesion: 0.30
Nodes (13): AuthResult, unauthorizedResponse(), validateApiKey(), CORS_HEADERS, fetch(), handleCrawl(), handleExtractText(), handlePreviewFetch() (+5 more)

### Community 29 - "Tokoro Public Web Query Interface README"
Cohesion: 0.28
Nodes (9): Diving Deeper topic: Publishing via iOS Shortcut, ?preview=TOKEN handoff (tryPreview), Tokoro Public Web Query Interface README, build-bookmarklet.js / inject-worker-url.js build process, scripts/deploy-public-web.sh deploy flow, Mobile Publishing (publish.html) entry modes, shortcut-bookmarklet.js Apple Shortcut build artifact, FR-5.7: Apple Shortcut KV-relay handoff (+1 more)

### Community 30 - "shared/package.json"
Cohesion: 0.13
Nodes (14): dependencies, @anthropic-ai/sdk, openai, zod, exports, ./extractors/*, ./llm/*, ./types/* (+6 more)

### Community 31 - "Tracing an Event from Browser to Database"
Cohesion: 0.14
Nodes (14): Tracing an Event from Browser to Database, CrawlRequest { url, mode, html?, title? }, CrawlResponse { success, events, dropped_events?, cleaned_text? }, Two geohash precisions for radius queries, Event ID = SHA-256 of canonical JSON, EventNormalizer.normalize(event), ExtractedEvent (JSON-LD + LLM merge), Iframe capture raced against 5s timeout (+6 more)

### Community 32 - "devDependencies"
Cohesion: 0.15
Nodes (13): devDependencies, prettier, tsx, @types/js-yaml, @types/jsdom, @types/node, typescript, prettier (+5 more)

### Community 33 - "build-bookmarklet.js"
Cohesion: 0.15
Nodes (11): fs, minified, minifiedShortcut, path, NOTE: API_URL is used only for bookmarklet placeholder substitution below., NOTE: This script does NOT replace __TOKORO_WORKER_URL__ in the HTML files., SHORTCUT_OUT, SHORTCUT_SRC (+3 more)

### Community 35 - "POST /crawl (full spec: request/response contract)"
Cohesion: 0.18
Nodes (9): fetchEvents(replace), API Worker Events endpoints (GET/POST/PUT/DELETE /events), PreparedEvent data structure (from crawler-worker), SignedEvent data structure (posted to API worker), Events API endpoints (CLAUDE.md), POST /crawl (full spec: request/response contract), Apple Shortcut setup (Safari Share Sheet), Required components table (Worker, Crawler Worker, Public Web) (+1 more)

### Community 36 - "Documentation section (links to other docs)"
Cohesion: 0.18
Nodes (11): API Reference (document overview), Chrome extension README overview, Tokoro Event Crawler README overview, seeds.txt seed URL list (Alcatraz Milano calendar), Crawler Worker README overview, Install Chrome Extension client tool, Deploy the API Worker (D1, R2, LLM secrets), Deploy the Crawler Worker (KV, secrets) (+3 more)

### Community 37 - "index.html — Public Web Query Interface (EN)"
Cohesion: 0.40
Nodes (10): Dark Theme Design — public-web, index.html — Public Web Query Interface (EN), it.html — Public Web Query Interface (IT), map.html — Map View, Public Web — Specification, FR-1: Event Query, FR-2: Date/Time Formatting (fmtRange), FR-3: Repeating Event Grouping (+2 more)

### Community 38 - "Overall Structure — Getting Started Outline"
Cohesion: 0.20
Nodes (10): Stateless crawler worker / client-side signing design, Scheduled Crawling Watchlist, Overall Structure — Getting Started Outline, Diving Deeper topic: Installing and using the Chrome extension, Diving Deeper topic: Crawl modes, fetchers, browser engines, Diving Deeper topic: Debugging extraction & geocoding failures, Diving Deeper topic: Selecting/configuring an LLM provider, Diving Deeper topic: Running the standalone crawler (+2 more)

### Community 39 - "devDependencies"
Cohesion: 0.20
Nodes (9): lint-staged, devDependencies, lint-staged, prettier, wrangler, prettier, wrangler, lint-staged (+1 more)

### Community 40 - "web-publisher/index.html — Event Publisher (legacy manual form)"
Cohesion: 0.33
Nodes (5): Diving Deeper topic: Working with local timestamps, web-publisher/index.html — Event Publisher (legacy manual form), handleSubmit(e), hashEventData(eventData), Timestamp Format Convention (ISO 8601, no timezone, venue-local)

### Community 41 - "crawler/package.json"
Cohesion: 0.25
Nodes (7): author, description, license, main, name, type, version

### Community 42 - "JSON-LD event extraction algorithm"
Cohesion: 0.33
Nodes (6): Stage 1: JSON-LD extraction (README), JSON-LD event extraction algorithm, Alcatraz Milano Autechre event page (JSON-LD MusicEvent fixture), Alcatraz Milano Fat Freddy's Drop event page (JSON-LD Event fixture), Birra di Naon jazzAON event page (JSON-LD Event fixture, Luca Dell'Anna Trio), Stage 1: JSON-LD extraction (crawler-worker README)

### Community 43 - "Tokoro project overview (6 components)"
Cohesion: 0.33
Nodes (6): Chrome Extension Specification (document overview), Tokoro project overview (6 components), Ed25519 event signing (canonical JSON + SHA-256), Event Crawler Technical Specification overview, Crawler Worker Technical Specification overview, Tokoro project introduction/pitch

### Community 44 - "inject-worker-url.js"
Cohesion: 0.33
Nodes (4): ALL_FILES, fs, path, RELAY_FILES

### Community 45 - "background.js"
Cohesion: 0.50
Nodes (3): findImageAtLastPosition(), handleImageCrawl(), imageUrlToBase64()

### Community 46 - "keywords"
Cohesion: 0.40
Nodes (5): crawler, events, keywords, extraction, llm

### Community 47 - "LLM event extraction (system prompt + parsing)"
Cohesion: 0.50
Nodes (4): Date inference logic (year hints, day-name validation), LLM event extraction (system prompt + parsing), abetone.txt: cleaned Instagram post text (abetonemusicbar, Sp46 gig), ig-quod.txt: cleaned Instagram post text (quod.design, Paola Pizzino gig)

### Community 49 - "Settings modal (Worker URL, admin priv/pub key)"
Cohesion: 0.67
Nodes (3): saveSettings(workerUrl, privKey, pubKey), Settings modal (Worker URL, admin priv/pub key), Admin key: moderation keypair via admin/admin.html

### Community 50 - "Scheduled crawls via jobs.yaml + cron"
Cohesion: 0.67
Nodes (3): jobs.yaml active scheduler config (Le Serre, Kino Siska, CSS Udine, Capitol Pordenone, La prima estate), jobs.example.yaml scheduler config template, Scheduled crawls via jobs.yaml + cron

### Community 51 - "Direct mode algorithm (crawler SPECS)"
Cohesion: 0.67
Nodes (3): Direct mode (crawler README), Direct mode algorithm (crawler SPECS), Direct mode (crawler-worker)

### Community 52 - "Discover mode algorithm (crawler SPECS)"
Cohesion: 0.67
Nodes (3): Discover mode (crawler README), Discover mode algorithm (crawler SPECS), Discover mode (crawler-worker)

### Community 53 - "Image mode algorithm (crawler SPECS)"
Cohesion: 0.67
Nodes (3): Image mode (crawler README), Image mode algorithm (crawler SPECS), Image mode (crawler-worker)

### Community 54 - "Crawler test suite README overview"
Cohesion: 0.67
Nodes (3): Regression testing via pre-push hook + reference.json, Far East Film Festival 2026 events listing page (EventON plugin, WordPress) fixture, Crawler test suite README overview

### Community 68 - "test-runner.ts"
Cohesion: 0.13
Nodes (7): EventExtractor, JinaFetcher, EntryResolverDeps, fetchAndExtract(), loadEnv(), main(), FetchedPage

### Community 165 - "test-radar.ts"
Cohesion: 0.11
Nodes (30): FestivalEntryExtractor, analyzeEventDays(), appendOtherPlaces(), applyYearCorrection(), DatedDraft, EventDaysAnalysis, FestivalEntryDraft, FestivalEntryDraftSchema (+22 more)

### Community 166 - "NormalizedEvent"
Cohesion: 0.20
Nodes (13): asMs(), differs(), EDITION_WINDOW_DAYS, ExistingEntry, isRadarEntry(), matchEdition(), RadarPublisher, text() (+5 more)

### Community 167 - "smoke-put.ts"
Cohesion: 0.73
Nodes (5): bytesToHex(), check(), hexToBytes(), main(), signEvent()

### Community 168 - "api-publisher.ts"
Cohesion: 0.32
Nodes (3): APIPublisher, PublishOutcome, PublishResult

### Community 169 - "db-benchmark.ts"
Cohesion: 0.18
Nodes (17): BenchmarkReport, buildReport(), CliArgs, computeStats(), CSV_HEADER, csvEscape(), DbEvent, FetcherMode (+9 more)

### Community 170 - "TestRunner"
Cohesion: 0.33
Nodes (3): TestRunner, TestFixtureMetadata, TestReport

### Community 171 - "compare.ts"
Cohesion: 0.36
Nodes (8): compareReports(), ComparisonEntry, findLatestSnapshots(), formatDelta(), loadSnapshot(), main(), ResultKey, statusIcon()

### Community 172 - "publish.html — Mobile Publisher"
Cohesion: 0.42
Nodes (8): Canonical JSON fixed key order for signature integrity, Diving Deeper topic: Signing events with Ed25519, publish.html — Mobile Publisher, signing.js shared signing utilities, bytesToHex(), loadOrCreateKeypair(), signEvent(), Canonical Event Data Format & Ed25519 Signature Verification

### Community 175 - "festivals.test.mjs"
Cohesion: 0.29
Nodes (3): {
  isRadarEntry,
  toFestival,
  toFestivals,
  addDays,
  radarWindow,
  buildRadarUrl,
  loadRadarEvents,
  monthChips,
  monthLabel,
  filterFestivals,
  groupFestivals,
  fmtFestivalRange,
  byStartThenName,
  haversineKm,
  withDistance,
  byDistance,
  fmtDistance,
  groupPins,
  fitPoints,
}, sample, win

## Ambiguous Edges - Review These
- `Event Editing UI (PUT /events/:id)` → `REST API Endpoints (events, admin/blocklist)`  [AMBIGUOUS]
  docs/ideas.md · relation: conceptually_related_to
- `fetchEvents(replace)` → `POST /crawl (full spec: request/response contract)`  [AMBIGUOUS]
  admin/admin.html · relation: conceptually_related_to
- `web-publisher/index.html — Event Publisher (legacy manual form)` → `Timestamp Format Convention (ISO 8601, no timezone, venue-local)`  [AMBIGUOUS]
  web-publisher/index.html · relation: conceptually_related_to
- `LLM provider configuration (openai/anthropic/openrouter; no Ollama)` → `Troubleshooting common errors`  [AMBIGUOUS]
  HOW-TO-USE.md · relation: conceptually_related_to

## Knowledge Gaps
- **475 isolated node(s):** `manifest_version`, `name`, `version`, `minimum_chrome_version`, `description` (+470 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **107 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Event Editing UI (PUT /events/:id)` and `REST API Endpoints (events, admin/blocklist)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `fetchEvents(replace)` and `POST /crawl (full spec: request/response contract)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `web-publisher/index.html — Event Publisher (legacy manual form)` and `Timestamp Format Convention (ISO 8601, no timezone, venue-local)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `LLM provider configuration (openai/anthropic/openrouter; no Ollama)` and `Troubleshooting common errors`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `LLMProvider` connect `LLMProvider` to `shared/extractors/event-extractor.ts`, `worker/src/index.ts`, `test-runner.ts`, `test-radar.ts`, `api-publisher.ts`, `db-benchmark.ts`, `test-scout.ts`, `llm.ts`, `TestRunner`, `radar.ts`, `crawler.ts`, `crawler-adapter.ts`, `normalizer.ts`?**
  _High betweenness centrality (0.076) - this node is a cross-community bridge._
- **Why does `Tokoro Worker — Technical Specification` connect `Tokoro Worker — Technical Specification` to `web-publisher/index.html — Event Publisher (legacy manual form)`, `worker/src/index.ts`, `publish.html — Mobile Publisher`, `Tracing an Event from Browser to Database`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **Why does `createLLMProvider()` connect `llm.ts` to `worker/src/index.ts`, `test-runner.ts`, `db-benchmark.ts`, `TestRunner`, `radar.ts`, `query-shared.ts`, `crawler-adapter.ts`, `crawler-worker/src/index.ts`?**
  _High betweenness centrality (0.042) - this node is a cross-community bridge._