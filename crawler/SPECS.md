# Event Crawler — Technical Specification

**Version:** 2.0
**Date:** 2026-04-28
**Status:** Reference implementation exists — this spec enables reimplementation in any language

---

## 1. Overview

This document specifies the complete behavior of the Event Crawler, a LLM-powered semantic crawler and structured data extractor for real-world events published on the web. The crawler:

- Fetches web pages containing event information (using headless browser or API-based HTML fetching)
- Discovers individual event pages from venue listing pages (optional)
- Extracts structured event data using JSON-LD parsing and/or LLM-based extraction
- Extracts events from images (flyers, posters) using multimodal LLM vision capabilities
- Normalizes and validates extracted data
- Geocodes addresses to GPS coordinates
- Signs events using Ed25519 cryptography
- Publishes events to the Tokoro API

This specification is implementation-agnostic and provides sufficient detail to reimplement the crawler in any language (TypeScript, Python, Go, Rust, etc.) with complete test coverage.

---

## 2. High-Level Architecture

```
┌─────────────────────────────┐
│  Input: URLs or Image Paths │
└──────────┬──────────────────┘
           ↓
┌──────────────────────────────────────────────────────┐
│              Crawler Core                            │
│  - Mode: direct | discover | image | festival | pdf  │
│  - Fetcher: playwright | jina (web modes only)       │
│  - Browser: chrome | obscura (playwright only)       │
└──────┬───────────────────────────────────────────────┘
       ↓
   ┌───┴───┐
   │ Mode? │
   └───┬───┘
       │
   ┌───┴──────────────────────────────────────────────┐
   │                            |                     │
   ↓ (web)                  ↓ (image)              ↓ (pdf)
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ HTML Fetcher     │  │ Image Fetcher    │  │ PDF Fetcher      │
│ • Playwright     │  │ • File loader    │  │ • File loader    │
│   - Chrome       │  │ • URL downloader │  │ • URL downloader │
│   - Obscura      │  │ • Base64 encoder │  │ • Text extract   │
│ • Jina AI Reader │  │                  │  │ • Page rendering │
└────────┬─────────┘  │ • Base64 encoder │  │ • Text extract   │
         ↓            └────────┬─────────┘  │ • Page rendering │
┌──────────────────┐           │            └────────┬─────────┘
│  Page Discovery? │           │                     │
│  (discover mode) │           │                     │
│  • Link extract  │           │                     │
│  • LLM filtering │           │                     │
└────────┬─────────┘           │                     │
         ↓                     │                     │
┌──────────────────┐           │                     │
│  Content Extract │           │                     │
│  • JSON-LD Parse │           │                     │
│  • HTML Cleaner  │           │                     │
└────────┬─────────┘           │                     │
         │                     │                     │
         └──────────┬──────────┴─────────────────────┘
                    ↓
        ┌──────────────────────────┐
        │   LLM Event Extractor    │
        │  • Text-based (web)      │
        │  • Image-based (vision)  │
        │  • Date inference        │
        │  • Category assignment   │
        └──────┬───────────────────┘
               ↓
        ┌──────────────────────────┐
        │ Normalization & Signing  │
        │  • Geocoding             │
        │  • Timestamp format      │
        │  • Ed25519 signature     │
        └──────┬───────────────────┘
               ↓
        ┌──────────────────────────┐
        │    API Publisher         │
        │  • POST /events          │
        │  • Duplicate handling    │
        └──────────────────────────┘
```

---

## 3. Data Schema

### 3.1 Extracted Event (Raw LLM Output)

```typescript
interface ExtractedEvent {
  title: string; // Required
  description?: string; // Optional, brief summary
  url?: string; // Event webpage/ticket URL
  venue_name?: string; // Venue name only (e.g., "Blue Note")
  address?: string; // Full street address for geocoding
  lat?: number; // GPS latitude (-90 to 90)
  lng?: number; // GPS longitude (-180 to 180)
  start_time: string | number; // ISO 8601 or Unix timestamp
  end_time?: string | number; // ISO 8601 or Unix timestamp
  category: EventCategory; // See 3.2
  tags?: string[]; // Free-form tags (e.g., ["jazz", "outdoor"])
  festival_name?: string; // Optional: festival name if event is part of a festival
  festival_url?: string; // Optional: festival homepage URL
  day_name?: string; // Optional: English full weekday name (e.g., "Sunday") for year validation
}
```

### 3.2 Event Categories (Predefined)

Must be one of:

```
music | food | sports | art | theater | film | nightlife | community | outdoor | learning | wellness | other
```

### 3.3 Normalized Event (Signed, Ready for API)

```typescript
interface NormalizedEvent {
  pubkey: string; // Ed25519 public key (64 hex chars)
  signature: string; // Ed25519 signature (128 hex chars)
  title: string;
  description?: string;
  url?: string;
  venue_name?: string;
  address?: string;
  lat: number; // Required after geocoding
  lng: number; // Required after geocoding
  start_time: string; // ISO 8601 "YYYY-MM-DDTHH:MM:SS"
  end_time?: string; // ISO 8601 "YYYY-MM-DDTHH:MM:SS"
  category: string;
  tags?: string[];
  festival_name?: string;
  festival_url?: string;
  created_at: string; // ISO 8601 "YYYY-MM-DDTHH:MM:SS"
}
```

---

## 4. Crawler Modes

### 4.1 Direct Mode (`mode: 'direct'`)

**Behavior:**

- Process only the given seed URLs
- Do NOT follow links to discover event pages
- Extract events directly from the provided pages
- Use case: Single event page URLs, or pages already known to contain event data

**Algorithm:**

```
for each seed_url:
  page = fetch(seed_url)
  events = extract_events(page)
  normalized = normalize_events(events)
  publish(normalized)
```

### 4.2 Discover Mode (`mode: 'discover'`)

**Behavior:**

- Treat seed URLs as venue listing/calendar pages
- Use LLM to discover individual event page URLs
- Fetch each discovered event page
- Extract events from individual pages
- Use case: Venue homepages, event calendars, listing pages

**Algorithm:**

```
for each seed_url:
  page = fetch(seed_url)
  event_urls = discover_event_urls(page)  // LLM-based link filtering

  if event_urls.empty():
    # Fallback: treat seed as single event page
    event_urls = [seed_url]

  for each event_url in event_urls:
    event_page = fetch(event_url)
    events = extract_events(event_page)
    normalized = normalize_events(events)
    publish(normalized)
```

### 4.3 Image Mode (`mode: 'image'`)

**Behavior:**

- Process images (flyers, posters, Instagram posts, promotional graphics) instead of web pages
- Extract structured event data using multimodal LLM vision capabilities
- No link discovery — single image extraction only
- Use case: Event flyers, social media images, promotional posters

**Algorithm:**

```
for each image_source:
  image_data = load_image(image_source)  // File path or URL
  base64 = encode_base64(image_data)
  mime_type = detect_mime_type(image_data)
  events = extract_events_from_image(base64, mime_type, image_source)
  normalized = normalize_events(events)
  publish(normalized)
```

**Input Sources:**

- Local file path: `./tests/fixtures/flyer.jpg`
- HTTP(S) URL: `https://example.com/event-poster.png`

**Supported Image Formats:**

- JPEG (`.jpg`, `.jpeg`)
- PNG (`.png`)
- GIF (`.gif`)
- WebP (`.webp`)

**LLM Requirements:**

- Provider must support multimodal vision capabilities
- Supported providers: Anthropic Claude (3.5+), OpenAI GPT-4 Vision (gpt-4o, gpt-4-turbo)
- Ollama models with vision support: `llava`, `bakllava`

### 4.4 Festival Mode (`mode: 'festival'`)

**Behavior:**

- Treat seed URLs as festival homepages
- Derive festival name from page title (fallback: hostname)
- Use LLM to discover program/schedule listing sub-pages (pages that list multiple events/acts)
- Fetch each listing page and extract all individual events directly (no further link following)
- Stamp every extracted event with `festival_name` and `festival_url`
- Collect all events from all listing pages; run LLM deduplication; if `--group-by-day` is set, group into one event per calendar day before publishing
- Use case: Festival homepages (e.g. `https://www.pordenonedocsfest.it`)

**Algorithm:**

```
for each seed_url (festival homepage):
  page = fetch(seed_url)
  festival_name = page.title OR hostname(seed_url)
  festival_url  = origin(seed_url)   // scheme + host
  listing_pages = discoverFestivalListingPages(page)

  if listing_pages.empty():
    listing_pages = [seed_url]  // fallback: process homepage directly

  all_events = []
  for each listing_page in listing_pages:
    page = fetch(listing_page)
    events = extract_events(page)
    for each event:
      event.festival_name = event.festival_name OR festival_name
      event.festival_url  = event.festival_url  OR festival_url
    all_events.append(events)

  log_extracted(all_events)                          // count of raw events
  deduped = deduplicateFestivalEvents(all_events)    // LLM dedup — removes wrappers/semantic dupes

  if config.groupByDay:
    events = groupEventsByDay(deduped, festival_name) // see 4.5
    log_grouped(events)                              // title for each day event
  else:
    events = deduped

  normalized = normalize_events(events)
  publish(normalized)
```

### 4.5 Per-Day Grouping (`--group-by-day`)

When `--group-by-day` is set, events are grouped into one per calendar day after extraction. This applies to all modes. Days with exactly 1 event pass through **unchanged**; only days with more than 1 event produce a day-aggregate event. This is a deterministic (no LLM) step.

**Output event structure per day:**

- **title**: `"{festival_name} – {Weekday}, {Month Day}"` — e.g. `"Pordenone Docs Fest – Wednesday, March 25"`
- **description**: newline-separated list of `"HH:MM Sub-event title (Venue)"` entries, sorted by start time
- **start_time**: `YYYY-MM-DDT00:00:00` (start of day — renders as all-day in iCal)
- **end_time**: `YYYY-MM-DDT23:59:59` (end of day)
- **venue_name / address / lat / lng**: taken from the first sub-event that has them
- **category**: most frequent category among the day's sub-events
- **tags**: deduplicated union of all sub-event tags
- **festival_name / festival_url**: preserved from sub-events

**Within-day deduplication:** sub-events with the same title are collapsed to one before building the description (handles events extracted from multiple listing pages that overlap in content).

**Algorithm:**

```
group events by date(start_time)  // YYYY-MM-DD key

for each date (sorted ascending):
  unique = deduplicate_by_title(events_on_date)
  unique.sort_by(start_time)

  title       = "{festival_name} – {weekday(date)}, {month day(date)}"
  description = unique.map(e => "{HH:MM} {strip_festival_prefix(e.title)} ({e.venue_name})")
                      .join("\n")
  start_time  = "{date}T00:00:00"
  end_time    = "{date}T23:59:59"
  venue_name  = first(unique where venue_name is set).venue_name
  address     = first(unique where address is set).address
  lat, lng    = first(unique where lat,lng are set)
  category    = most_common_category(unique)
  tags        = deduplicate(flatten(unique.map(e => e.tags)))

  yield day_event
```

### 4.6 PDF Mode (`mode: 'pdf'`)

**Behavior:**

- Process PDF files (local paths or HTTPS URLs) instead of web pages
- Attempt text extraction; if the PDF has enough text, send it to the text LLM extractor
- If the PDF has sparse/no extractable text (e.g. a scanned flyer), render pages to PNG images and send each to the vision LLM extractor
- No link discovery — one extraction pass per PDF source
- Use case: Event schedules distributed as PDFs, scanned posters, multi-page programme booklets

**Algorithm:**

```
for each source (file path or URL):
  pdfData = PdfFetcher.loadPdf(source)
  sourceUrl = source starts with 'http' ? source : 'file://' + resolve(source)
  filename  = basename(source)

  if pdfData.type === 'text':
    page = { url: sourceUrl, html: '', text: pdfData.text, title: filename }
    events = extract_events(page)   // text LLM extractor (section 7.3)
  else:
    events = []
    for each pageImage in pdfData.pages:
      pageEvents = extract_events_from_image(pageImage.base64, pageImage.mimeType, sourceUrl)
      log("Page N/total: M event(s)")
      events.append(pageEvents)

  if events.empty():
    log("No events extracted from this PDF")
    continue

  normalized = normalize_events(events)
  publish(normalized)
```

**Routing:** `PdfFetcher.loadPdf` applies a text-density threshold (≥ 200 non-whitespace chars). If met, it returns `type: 'text'`; otherwise it renders pages as PNG images and returns `type: 'images'`.

---

## 5. HTML Fetching

### 5.1 Fetcher Types

#### Playwright Fetcher (Default)

**Purpose:** Fetch JavaScript-rendered pages via a headless browser controlled by Playwright. Supports two browser engines (see below).

**Algorithm:**

1. Initialize browser (see engine options below)
2. Create a new page (Chrome: default context; Obscura: explicit `newContext()` required by CDP)
3. Navigate to URL with `waitUntil: 'load'`, timeout 30 s
4. Wait 2 seconds for dynamic content to render
5. Extract main frame HTML via `page.content()`
6. Collect rendered HTML from all child frames (including cross-origin iframes) via `frame.content()` on each non-main frame — Playwright operates at the browser automation level and bypasses same-origin policy, enabling access to third-party embedded widgets (e.g. Laylo tour widgets, Bandsintown embeds). Each frame content call is raced against a 5-second timeout so a stuck iframe cannot hang the crawl indefinitely.
7. Concatenate main frame HTML with all iframe HTMLs into combined HTML
8. Extract clean text from combined HTML using DOM-based cleaning (see 5.2)
9. Return `FetchedPage` object

**FetchedPage Interface:**

```typescript
interface FetchedPage {
  url: string; // Original URL
  html: string; // Raw HTML content
  readableText: string; // Cleaned text (DOM-based cleaning)
  title: string; // Page title
}
```

**Browser Engines:**

Two engines are supported via `--browser <engine>` (or `BROWSER_ENGINE` env var):

| | Chrome (default) | Obscura |
|---|---|---|
| Launch | `chromium.launch()` | `chromium.connectOverCDP()` |
| Memory | ~200 MB | ~30 MB |
| Startup | ~2 s | instant |
| Page load | ~500 ms | ~85 ms |
| Anti-detect | No | Built-in (stealth mode) |
| Compatibility | Highest | Good; may differ on complex JS apps |

**Chrome engine:**
- Playwright launches a managed Chromium subprocess directly
- No external binary required (Playwright bundles Chromium)

**Obscura engine:**
- Playwright connects via Chrome DevTools Protocol (CDP) to an Obscura server
- Auto-launch: if `OBSCURA_WS_ENDPOINT` is not set, the crawler spawns `obscura serve --port 9222` and polls TCP port 9222 until it accepts connections (up to 10 s timeout) before connecting
- External server: set `OBSCURA_WS_ENDPOINT=ws://host:port` to connect to an already-running instance (no auto-launch)
- Requires the `obscura` binary in `PATH`; download from https://github.com/h4ckf0r0day/obscura/releases
- On close: Playwright disconnects and the crawler kills the spawned `obscura serve` process

**Configuration:**

- Timeout: 30 seconds
- Wait after load: 2 seconds
- User agent: default for the selected engine

#### Jina AI Reader Fetcher (Alternative)

**Purpose:** Fetch pre-cleaned content via Jina AI Reader API (no local browser required)

**API Endpoint:**

```
GET https://r.jina.ai/{url}
Headers:
  Authorization: Bearer {jina_api_key}
  Accept: application/json
```

**Response Format:**

```json
{
  "data": {
    "title": "Page Title",
    "content": "Cleaned markdown/text content",
    "url": "https://example.com"
  }
}
```

**Advantages:**

- No Playwright/Chromium dependencies
- Faster fetching (no browser launch)
- Pre-cleaned content

**Disadvantages:**

- Requires API key and internet access
- External dependency
- May miss dynamic content that Jina doesn't render

### 5.2 HTML Text Cleaning

**Purpose:** Extract main text content from HTML, removing navigation, ads, scripts, and non-content elements.

**Algorithm (DOM-based cleaning using linkedom):**

1. Parse HTML into DOM using linkedom
2. Remove unwanted elements:
   - `script`, `style`, `noscript`
   - `img`, `canvas`, `svg`
   - `link[rel=stylesheet]`, `meta`
3. Remove empty nodes (`div`, `section`, `p`, `span` with no text content)
4. Extract title from `<title>` tag or first `<h1>` element
5. Extract text content from `<body>` element
6. **Remove empty lines** from extracted text to reduce whitespace bloat
7. Return plain text + title

**Implementation Notes:**

- Uses linkedom (npm: `linkedom`) - a lightweight DOM implementation
- Simple approach: removes unwanted elements and extracts body text
- No content scoring or article detection (unlike Mozilla Readability)
- Preserves natural text flow from the DOM structure

### 5.3 Image Content Loading (Image Mode)

**Purpose:** Load images from local files or URLs and convert to base64 for LLM transmission.

**Algorithm:**

1. **Determine source type:**

   ```javascript
   if (source.startsWith('http://') || source.startsWith('https://')) {
     return loadImageFromUrl(source);
   } else {
     return loadImageFromFile(source);
   }
   ```

2. **Load from file:**

   ```javascript
   const buffer = await fs.readFile(filePath);
   const base64 = buffer.toString('base64');
   const mimeType = getMimeTypeFromExtension(filePath);
   return { base64, mimeType, source: filePath };
   ```

3. **Load from URL:**

   ```javascript
   const response = await fetch(imageUrl);
   const arrayBuffer = await response.arrayBuffer();
   const buffer = Buffer.from(arrayBuffer);
   const base64 = buffer.toString('base64');
   const mimeType = response.headers.get('content-type') || 'image/jpeg';
   return { base64, mimeType, source: imageUrl };
   ```

4. **MIME type detection:**
   ```javascript
   function getMimeTypeFromExtension(filePath: string): string {
     const ext = path.extname(filePath).toLowerCase();
     const mimeTypes = {
       '.jpg': 'image/jpeg',
       '.jpeg': 'image/jpeg',
       '.png': 'image/png',
       '.gif': 'image/gif',
       '.webp': 'image/webp'
     };
     return mimeTypes[ext] || 'image/jpeg';
   }
   ```

**Image Data Interface:**

```typescript
interface ImageData {
  base64: string; // Base64-encoded image data
  mimeType: string; // MIME type (e.g., "image/jpeg")
  source: string; // Original file path or URL
}
```

**Error Handling:**

- File not found → Throw error with file path
- Invalid URL → Throw error with URL
- Unsupported format → Throw error with format
- Network failure (URL) → Throw error with network details

**Size Limits:**

- Max image size: 20 MB (LLM provider limits)
- Recommended: Images under 5 MB for faster processing

### 5.4 PDF Content Loading (PDF Mode)

**Purpose:** Load PDFs from local files or HTTPS URLs. Attempt text extraction; if insufficient text, render pages to images for vision LLM processing.

**Algorithm:**

1. **Determine source type:**

   ```javascript
   if (source.startsWith('http://') || source.startsWith('https://')) {
     return loadPdfFromUrl(source);
   } else {
     return loadPdfFromFile(source);
   }
   ```

2. **Extract text using pdfjs-dist:**

   ```javascript
   const pdf = await pdfjsLib.getDocument(pdfPath).promise;
   let fullText = '';
   for (let i = 1; i <= pdf.numPages; i++) {
     const page = await pdf.getPage(i);
     const textContent = await page.getTextContent();
     const pageText = textContent.items.map(item => item.str).join(' ');
     fullText += pageText + '\n';
   }
   return fullText;
   ```

3. **Check text threshold:**

   ```javascript
   const nonWhitespaceCount = fullText.replace(/\s/g, '').length;
   if (nonWhitespaceCount >= 200) {
     return { type: 'text', text: fullText, pageCount };
   } else {
     return {
       type: 'images',
       pages: renderToImages(pdfDoc, source, pageCount),
       pageCount,
     };
   }
   ```

4. **Render pages to PNG images (fallback if text insufficient):**
   - Use `pdfjs-dist` to render each page
   - Use `@napi-rs/canvas` to convert to PNG at 2× scale for readability
   - Cap at 10 pages (warn if PDF has more)
   - Return array of `ImageData` objects (same type used by image mode: `{ base64, mimeType, source }`)

**PdfFetcher Result Type (`PdfData`):**

```typescript
type PdfData =
  | { type: 'text'; text: string; pageCount: number }
  | { type: 'images'; pages: ImageData[]; pageCount: number };

// ImageData is the same type used by image mode:
interface ImageData {
  base64: string; // Base64-encoded PNG
  mimeType: string; // 'image/png'
  source: string; // Original file path or URL (same for all pages)
}
```

**Configuration:**

- Text threshold: 200 non-whitespace characters
- Max pages for rendering: 10 (warning logged if PDF exceeds this)
- Image scale: 2× for enhanced readability
- Output format: PNG

**Error Handling:**

- File not found → Throw error with file path
- Invalid PDF format → Throw error with format details
- URL fetch failure → Throw error with network details
- Text extraction timeout → Fallback to image rendering

**Size Limits:**

- Max PDF size: 50 MB
- Max pages to render: 10

---

## 6. Page Discovery (Discover Mode)

### 6.1 Link Extraction

**Algorithm:**

1. Parse HTML into DOM
2. Extract all `<a href="...">` elements
3. Filter out invalid hrefs:
   - Anchors (`#section`)
   - `mailto:`, `tel:`, `javascript:` schemes
   - Social media domains (`facebook.com`, `instagram.com`, `twitter.com`, `youtube.com`)
4. Deduplicate hrefs
5. Return array of candidate URLs (relative or absolute)

### 6.2 LLM-Based Event Page Filtering

**Purpose:** Identify which links point to individual event pages (vs. listing pages, navigation, etc.)

**LLM Prompt Template:**

```
You are an expert at analyzing venue websites and identifying links to individual event pages.

Given a list of links from a venue website, identify which ones point to INDIVIDUAL event pages.

Rules:
- Only select links to INDIVIDUAL event pages (e.g., /eventi/concert-name/, /events/artist-name-2025-03-15)
- INCLUDE links that have event-specific patterns like artist names, dates, or event IDs
- Do NOT include links to:
  - Event listing/calendar pages (e.g., /events, /calendar, /agenda)
  - Category/genre pages (e.g., /concerts, /music)
  - Navigation/footer links (e.g., /about, /contact, /tickets)
  - External social media links
  - Archive pages
- Return the URLs exactly as provided (they may be relative paths)
- If no individual event pages are found, return an empty array

Return ONLY a valid JSON object with this structure:
{
  "eventUrls": ["/eventi/artist-name/", "/events/show-123"]
}
```

**User Message:**

```
Base URL: {base_url}

Links found on page:
{href1}
{href2}
...
{hrefN}
```

**Expected Response:**

```json
{
  "eventUrls": ["/eventi/concert-name/", "/events/artist-2025-03-15"]
}
```

**Post-Processing:**

1. Parse JSON response
2. Validate schema: `{ eventUrls: string[] }`
3. Convert relative URLs to absolute using base URL
4. Filter out null conversions (malformed URLs)
5. Return array of absolute URLs

**Limit:** Process only first 200 links to avoid token limits

---

## 7. Event Extraction

### 7.1 Extraction Priority

The crawler uses a two-phase extraction strategy (JSON-LD is enabled by default but can be disabled with `--no-jsonld`):

1. **JSON-LD Extraction (Priority 1, optional):** Parse structured data from `<script type="application/ld+json">` tags
2. **LLM Extraction (always runs when JSON-LD is insufficient or disabled):** Use LLM to extract events from cleaned text

**Decision Logic:**

```
if use_jsonld:
  jsonld_events = extract_jsonld(html)
else:
  jsonld_events = []

if jsonld_events.is_sufficient():
  # All required fields present in JSON-LD
  return jsonld_events
else if jsonld_events.is_partial():
  # JSON-LD has some data, LLM fills gaps
  llm_events = extract_with_llm(text)
  merged = merge(jsonld_events[:len(llm_events)], llm_events)
  # Append any JSON-LD events not covered by LLM (e.g. page content was truncated)
  # Extra JSON-LD events must have start_time; category defaults to 'other' if missing
  extra = [e for e in jsonld_events[len(llm_events):] if e.start_time]
  return merged + extra
else:
  # No JSON-LD data (or JSON-LD disabled)
  return extract_with_llm(text)
```

### 7.2 JSON-LD Event Extraction

**Algorithm:**

1. **Locate JSON-LD scripts:**

   ```javascript
   const scripts = document.querySelectorAll(
     'script[type="application/ld+json"]'
   );
   ```

2. **Parse each script:**

   ```javascript
   for (const script of scripts) {
     try {
       const data = JSON.parse(script.textContent);
       if (is_event_schema(data)) {
         events.push(extract_event_fields(data));
       }
     } catch (error) {
       // Skip malformed JSON
     }
   }
   ```

3. **Schema.org Event Types:**
   - `@type: "Event"`
   - `@type: ["Event", "MusicEvent"]`
   - `@type: "MusicEvent" | "SportsEvent" | "TheaterEvent"` (all Event subtypes)

4. **Field Mapping:**

   ```typescript
   {
     title: jsonld.name,
     description: jsonld.description,
     url: jsonld.url,
     venue_name: jsonld.location?.name,
     address: jsonld.location?.address?.streetAddress + ", " + jsonld.location?.address?.addressLocality,
     lat: jsonld.location?.geo?.latitude,
     lng: jsonld.location?.geo?.longitude,
     // start_time/end_time: timezone suffix stripped — stored as local time
     // start_time_utc/end_time_utc: raw string preserved only if it has a timezone offset/Z
     //   AND the time component is NOT midnight (T00:00:00).
     //   Midnight UTC is treated as a date-only placeholder (not a real UTC time) — preserving
     //   it would cause the normalizer to shift the date by the venue's UTC offset (e.g. 2am in UTC+2).
     start_time: strip_timezone(jsonld.startDate),
     end_time: strip_timezone(jsonld.endDate),
     start_time_utc: has_tz(jsonld.startDate) && !is_midnight(jsonld.startDate) ? jsonld.startDate : undefined,
     end_time_utc: has_tz(jsonld.endDate) && !is_midnight(jsonld.endDate) ? jsonld.endDate : undefined,
     category: infer_category(jsonld["@type"]),  // "MusicEvent" → "music"
     tags: Array.isArray(jsonld.keywords) ? jsonld.keywords : (jsonld.keywords ? [jsonld.keywords] : [])
     // Single keyword string is wrapped in array (no comma-splitting)
   }
   ```

**Merge Strategy (when JSON-LD is partial and LLM also runs):**

- JSON-LD takes precedence for: `title`, `url`, `venue_name`, `address`, `lat`, `lng`, `category`
- LLM takes precedence for: `description` (LLM produces concise summaries; JSON-LD descriptions are often full unstructured page text), `start_time`, `end_time` — JSON-LD times are often stored in UTC, making local-time recovery unreliable without venue timezone knowledge
- `tags`: deduplicated union of JSON-LD tags and LLM tags (neither takes exclusive precedence)
- `start_time_utc`/`end_time_utc` from JSON-LD are carried forward for post-geocoding correction (see section 8.2)

5. **Sufficiency Check:**
   - Required fields present: `title`, `start_time`, `category`, `(lat/lng OR address)`
   - If all present: skip LLM extraction
   - If partial: merge with LLM results

**Category Inference from @type:**

```
MusicEvent → music
FoodEvent → food
SportsEvent → sports
VisualArtsEvent, ExhibitionEvent → art
TheaterEvent → theater
ScreeningEvent, MovieEvent → film
DanceEvent, NightlifeEvent → nightlife
SocialEvent, CommunityEvent → community
OutdoorEvent → outdoor
EducationEvent, Workshop → learning
WellnessEvent, HealthEvent → wellness
Event (generic) → other
```

### 7.3 LLM Event Extraction

**LLM System Prompt:**

```
You are an expert at extracting structured event data from web pages.

Extract the following information from the provided web page content:

- **title**: The event title/name (required)
- **description**: A concise summary of the event in at most 3-4 sentences (optional)
- **url**: The event's website or ticket URL (optional, use the page URL if not found)
- **venue_name**: The venue name only (e.g. "Blue Note", "Alcatraz") - NOT the full address
- **address**: The COMPLETE physical street address (CRITICAL for accurate geocoding)
- **lat, lng**: GPS coordinates if explicitly mentioned (optional)
- **start_time**: Start date and time (required) - provide as ISO 8601 string (e.g. "2026-04-20T19:00:00"). **CRITICAL: use the exact local time shown on the page — do NOT convert to UTC or adjust for any timezone offset**
- **day_name**: name of the day of event, if explicitly mentioned (optional)
- **end_time**: End date and time (optional, only if the page explicitly mentions it). Same rule: exact local time, no UTC conversion.
- **category**: Choose ONE from: music, food, sports, art, theater, film, nightlife, community, outdoor, learning, wellness, talks, other
- **tags**: An array of relevant tags (optional, e.g. ["jazz", "outdoor", "free"])
- **festival_name**: If the page is clearly part of a named festival or multi-day event series (e.g. "Flow Festival 2026", "Glastonbury 2026"), populate this on ALL events extracted from the page. If unsure, omit.
- **festival_url**: The festival's canonical homepage URL (e.g. "https://www.flowfestival.com"). Only populate if you are confident of the festival homepage URL — if unsure, omit rather than guess.

DATE EXTRACTION RULES:
- Today's date will be provided in the user message
- If the page URL contains a year (e.g. `/2025/`, `/edition-2024/`, `?year=2023`), use that year **definitively** for all dates on the page — even if it results in past dates. Do NOT advance to the next year when a URL year hint is present. Past events will be filtered automatically.
- If the event date does NOT include a year (and there is no URL year hint), assume it refers to the CURRENT YEAR (the year from today's date)
- If the inferred date (with current-year default, no URL hint) would be in the past (before today), if it would be only a few months in the past from today, assume it is a past event and keep the inferred date, otherwise assume it's next year.
- For example: if today is March 2, 2026 and the event says "April 16", assume April 16, 2026 (not 2025)
- For example: if today is December 2, 2026 and the event says "February 10", assume February 10, 2027 (next occurrence)
- Social media pages often include the time / date of the post (e.g. 5 h for an entry posted 5 hours ago), use that to contextualize the inferred date. For example, for an entry posted 5 hours ago, "Tuesday" indicates next Tuesday from now (minus 5 hours).
- When a day name is shown alongside a date — in any language, abbreviated or full (e.g. `Sun 20 Apr`, `Tuesday 15 March`, `Dom 20 Apr`, `DOMENICA 20 APRILE`, `Samstag 10. Mai`, `Samedi 10 mai`) — always populate the `day_name` field with the English full weekday name (e.g. `"Sunday"`, `"Saturday"`). Translate from any language if needed. Do this even when the year is known or explicit. This field is used for post-processing validation.

ADDRESS EXTRACTION RULES:
- Prefer a COMPLETE street address with street name, number, and city (best for geocoding)
- Search the ENTIRE page content - address info may be in venue details, footer, or contact sections
- If the page only has a venue name and city (no street), return those (e.g. "Blue Note, Milano") — this is fine
- If the page only has a city or region with no venue, return just that (e.g. "Pordenone")
- NEVER invent or guess any part of the address. Only return what is explicitly on the page.
- If absolutely no location information is found, omit the address field entirely

Guidelines:
- **Extract ALL events found on the page** — do NOT limit or filter by date proximity, relevance, or any other criteria. If the page lists 40 events, return all 40. Never stop early.
- **Multi-day range events** (festivals, museum exhibits, fairs, markets): if the page shows a DATE RANGE (e.g. "May 12–22", "open from June 1 to June 30") with no specific per-day schedule, extract as a SINGLE event with start_time set to the first day at T00:00:00 and end_time set to the last day at T23:59:59. If daily opening hours are stated (e.g. "open 10am–6pm daily"), use those hours instead of T00:00:00/T23:59:59. If no closing date is stated, omit end_time.
- **Scheduled multi-day events**: if the page lists specific programs, performances, or schedules for individual days (e.g. "Friday May 12 – The Glowing Socks, Saturday May 13 – Banana Republic"), extract each day as a separate event, using each day's explicit date for start_time. The title should be "{Festival Name} – {Day Name/Date}" (e.g. "Sunshine Fest 2026 – Friday") and the description MUST list ALL performers/acts scheduled for that day (e.g. "The Glowing Socks, Banana Republic, Captain Noodle, ..."). If only some days have schedules while others do not, prefer the single-event approach and mention the scheduled acts in the description.
- If start time is not explicit, make a reasonable guess based on context (concerts often 20:00, sports vary, etc.)
- Only set end_time if explicitly mentioned on the page. Do NOT estimate or guess end times — omit end_time entirely if it is not shown.
- Category should match the primary focus of the event
- Tags should be lowercase and descriptive

Festival context: If the page is a festival program/schedule page, every extracted event should include festival_name and festival_url. Example for a per-day festival schedule page:
[{"title":"Sunshine Fest 2026 – Friday","description":"The Glowing Socks, Banana Republic, Captain Noodle","festival_name":"Sunshine Fest 2026","festival_url":"https://www.sunshinefest.example","start_time":"2026-07-11T00:00:00","category":"music",...},{"title":"Sunshine Fest 2026 – Saturday","description":"Laser Hamster, Void Patrol, The Soggy Biscuits","festival_name":"Sunshine Fest 2026","festival_url":"https://www.sunshinefest.example","start_time":"2026-07-12T00:00:00","category":"music",...}]

Return ONLY a valid JSON object (or array of objects if multiple events) matching this schema. Do not include any explanatory text.

Example output (page shows "Sunday 15 March"):
{
  "title": "The Big Jazz Band",
  "description": "An evening of live jazz featuring local and international artists.",
  "venue_name": "Blue Note",
  "address": "Via Inventata 99, Cittàfinta",
  "start_time": "2026-03-15T21:00:00",
  "end_time": "2026-03-16T00:00:00",
  "day_name": "Sunday",
  "category": "music",
  "tags": ["jazz", "live music", "nightlife"]
}

If you find multiple events on the page, return an array: [event1, event2, ...]
```

**User Message Template:**

```
Today's date: {YYYY-MM-DD}

Page URL: {url}
Page Title: {title}

Content:
{cleaned_text_with_empty_lines_removed_max_30000_chars}
```

**Content Preprocessing:**

Before sending to LLM, the cleaned text undergoes additional preprocessing:

1. Remove all empty lines (lines with only whitespace) to reduce token usage
2. Slice to first 30,000 characters (regular mode) or 50,000 characters (festival mode) — see `shared/extractors/extraction-limits.ts`
3. This allows more actual content to fit within the character limit by eliminating whitespace bloat

**LLM Configuration:**

```typescript
{
  temperature: 0.1,        // Low temperature for consistent extraction
  maxTokens: 10000,        // Default for regular mode (see extraction-limits.ts)
  responseFormat: 'json'   // Force JSON output (if supported by LLM)
}
```

**Response Parsing:**

1. Parse JSON response
2. Handle null (LLM found nothing), single object, or array:
   ```javascript
   if (parsed === null) return [];
   const events = Array.isArray(parsed) ? parsed : [parsed];
   ```
3. Normalize null values to undefined for optional fields
4. Add page URL if event URL missing
5. Validate each event against `ExtractedEventSchema` (Zod)
6. Return array of validated events

**Error Handling:**

- If JSON parse fails: throw error (likely truncated output due to token limit)
- If validation fails: log error with event data, skip event
- If no events extracted: return empty array

### 7.4 Date Inference Logic

**Problem:** Event pages often omit the year (e.g., "April 16" instead of "April 16, 2026")

**Solution:** Assume current year unless date would be in the past, then assume next year. Additionally, use day names shown on the page and year hints in the page URL to validate and correct inferred years.

**LLM-Level Year Hints:**

1. **Page URL year hint:** If the page URL contains a year pattern (e.g., `/2025/`, `/edition-2024/`, `?year=2023`), treat that year as a strong hint for dates that lack an explicit year — stronger than the current-year default.

2. **Day name extraction:** When a day name is shown alongside a date on the page (e.g., `"Sun 20 Apr"`, `"Tuesday 15 March"`, or Italian `"Dom 20 Apr"`), the LLM populates the `day_name` field in the extracted event with the English full weekday name (e.g., `"Sunday"`, `"Tuesday"`). This field is used for post-processing validation.

**LLM Base Year Inference Algorithm:**

```python
def infer_full_date(date_string: str, today: Date) -> Date:
    # Parse date string (e.g., "April 16" or "2026-04-16")
    parsed = parse_date(date_string)

    if parsed.has_year:
        return parsed

    # No year specified - infer from context
    candidate = Date(today.year, parsed.month, parsed.day)

    if candidate < today:
        # Date is in the past — if only a few months in the past, keep as past event
        # If far in the past, assume next year
        if (today - candidate).days > 90:
            return Date(today.year + 1, parsed.month, parsed.day)
        else:
            return candidate  # recent past event, keep as-is
    else:
        # Date is in the future or today - use current year
        return candidate
```

**Example:**

- Today: March 2, 2026
- Input: "April 16" → Output: April 16, 2026 (current year, future date)
- Input: "February 10" → Output: February 10, 2026 (only ~3 weeks in the past — kept as past event)
- Today: December 2, 2026; Input: "February 10" → Output: February 10, 2027 (far in past — next year)

**Social media context:** If the page includes a post timestamp (e.g. "5 h" meaning posted 5 hours ago), use it to anchor relative day references. For example, if posted 5 hours ago and the event says "Tuesday", infer next Tuesday from (now − 5 hours).

**Year inference and validation (post-processing):**

After LLM extraction, if an event has a `day_name` field, post-processing validates the inferred year as follows:

- If the day name matches the actual weekday of the extracted `start_time`'s date: the year is correct. Strip the `day_name` field and return the event.
- If the day name matches the actual weekday of the same date **one year in the future** (`year+1`): the year was off by one. Correct both `start_time` and `end_time` (if present) to the next year, strip `day_name`, and return the event.
- If the day name matches the actual weekday of the same date **one year in the past** (`year-1`): the inferred date is in the past with no valid future interpretation. Log a message and **drop the event**.
- If the day name matches **none of the above** (current year, ±1 year): the day name is unresolvable. Log a message and **drop the event**.

Additionally, **all events with a `start_time` before today are dropped**, regardless of `day_name` presence, after all other corrections are applied.

**Example year correction scenarios:**

- Today: March 29, 2026
- Event: "Sun 20 Apr 2026" extracted with `day_name: "Sunday"`
  - April 20, 2026 = Wednesday (day_name doesn't match)
  - April 20, 2027 = Thursday (doesn't match)
  - April 20, 2025 = Tuesday (past year, drop event)
- Event: "Sun 19 Apr 2026" extracted with `day_name: "Sunday"` (April 19, 2026 is actually a Sunday)
  - Match found in current year. Keep event, strip `day_name`.
- Event: "Sun 20 Apr 2026" extracted with `day_name: "Monday"` (April 20, 2027 is actually a Monday)
  - Match found in year+1. Correct to April 20, 2027, strip `day_name`, return event.

### 7.5 End Time Estimation

**End-time estimation is NOT performed by the LLM.** The extraction prompt explicitly instructs the LLM to omit `end_time` if it is not shown on the page. No post-processing estimation is applied either — if `end_time` is absent from the source, it remains absent in the extracted event.

### 7.6 Image-Based Event Extraction (Image Mode)

**Purpose:** Extract structured event data from images of flyers, posters, and promotional materials using multimodal LLM vision capabilities.

**LLM System Prompt (Image Mode):**

```
You are an expert at extracting structured event data from images of event flyers, posters, and promotional materials.

Analyze the provided image and extract the following information:

- **title**: The event title/name (required)
- **description**: A BRIEF 1-2 sentence summary of the event based on visible information (optional, MUST be concise)
- **url**: The event's website or ticket URL if visible on the image (optional)
- **venue_name**: The venue name only (e.g. "Blue Note", "Alcatraz") - NOT the full address
- **address**: The COMPLETE physical street address if visible (CRITICAL for accurate geocoding)
- **lat, lng**: GPS coordinates if explicitly mentioned (optional, rarely present on flyers)
- **start_time**: Start date and time (required) - provide as ISO 8601 string (e.g. "2026-04-20T19:00:00"). **CRITICAL: use the exact local time shown on the image — do NOT convert to UTC or adjust for any timezone offset**
- **end_time**: End date and time (optional, if shown on the flyer). Same rule: exact local time, no UTC conversion.
- **day_name**: name of the day of event, if explicitly mentioned (optional)
- **category**: Choose ONE from: music, food, sports, art, theater, film, nightlife, community, outdoor, learning, wellness, talks, other
- **tags**: An array of relevant tags based on the event type and visible information (optional, e.g. ["jazz", "outdoor", "free"])

DATE EXTRACTION RULES:
- Today's date will be provided in the user message
- If the event date does NOT include a year, assume it refers to the CURRENT YEAR (the year from today's date)
- If the inferred date would be in the past (before today), if it would be only a few months in the past from today, assume it is a past event and keep the inferred date, otherwise assume it's next year.
- For example: if today is March 2, 2026 and the flyer says "April 16", assume April 16, 2026 (not 2025)
- For example: if today is December 2, 2026 and the flyer says "February 10", assume February 10, 2027 (next occurrence)
- Common date formats on flyers: "April 16", "16/04", "Apr 16", "16.04", etc.
- Look for time information: "21:00", "9:00 PM", "ore 21:00", "doors 8pm", etc.
- When a day name is shown alongside a date — in any language, abbreviated or full (e.g. `Sun 20 Apr`, `Tuesday 15 March`, `Dom 20 Apr`, `DOMENICA 20 APRILE`, `Samstag 10. Mai`, `Samedi 10 mai`) — always populate the `day_name` field with the English full weekday name (e.g. `"Sunday"`, `"Saturday"`). Translate from any language if needed. Do this even when the year is known or explicit. This field is used for post-processing validation.

ADDRESS EXTRACTION RULES:
- Prefer a COMPLETE street address with street name, number, and city (best for geocoding)
- If the image only shows a venue name and city (no street), return those (e.g. "Blue Note, Milano") — this is fine
- If the image only shows a city or region, return just that (e.g. "Pordenone")
- NEVER invent or guess any part of the address. Only return what is explicitly visible.
- If absolutely no address information is visible, omit the address field entirely

FLYER READING TIPS:
- Event flyers often have the main event name in large text at the top or center
- Date and time are usually prominently displayed
- Venue information is typically at the bottom or in smaller text
- Look for recognizable venue logos or branding
- URLs are often at the bottom or in fine print
- Price information, if present, might be useful for tags (e.g. "free")
- Multiple acts/artists may be listed - include the main headliner as title, others in description or tags

Guidelines:
- **Multi-day range events** (festivals, exhibits, fairs): if the image shows a DATE RANGE (e.g. "May 12–22") with no per-day schedule, extract as a SINGLE event with start_time set to the first day at T00:00:00 and end_time set to the last day at T23:59:59. If daily opening hours are visible (e.g. "open 10am–6pm daily"), use those hours instead. If no closing date is visible, omit end_time.
- **Scheduled multi-day events**: if the image shows specific programs or acts per day (e.g. "Friday May 12 – Band X, Saturday May 13 – Band Y"), extract each day as a separate event, using each day's explicit date for start_time. If only some days have schedules, prefer the single-event approach and mention the scheduled acts in the description.
- If the image shows multiple unrelated events (like a weekly schedule), extract each as a separate event
- If start time is not visible, make a reasonable guess based on event type (concerts often 20:00-21:00, sports vary, etc.)
- **end_time**: only set if explicitly visible on the image. Do NOT estimate or guess end times — omit end_time entirely if it is not shown.
- Category should match the primary focus of the event based on visual cues
- Tags should be lowercase and descriptive based on what you see

Return ONLY a valid JSON object (or array of objects if multiple events) matching this schema. Do not include any explanatory text.

Example output for a jazz concert flyer (flyer shows "Sunday 15 March", no end time visible):
{
  "title": "Jazz Night at Blue Note",
  "description": "An evening of live jazz featuring local and international artists.",
  "venue_name": "Blue Note",
  "address": "Via Inventata 99, Cittàfinta",
  "start_time": "2026-03-15T21:00:00",
  "day_name": "Sunday",
  "category": "music",
  "tags": ["jazz", "live music", "nightlife"]
}

If you find multiple events on the flyer/image, return an array: [event1, event2, ...]
```

**User Message Template:**

```
Today's date: {YYYY-MM-DD}

Image source: {image_source}

Please analyze the event flyer/poster image and extract all visible event information.
```

**Multimodal Message Structure:**

```typescript
[
  { role: 'system', content: systemPrompt },
  {
    role: 'user',
    content: [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: imageMimeType, // e.g., "image/jpeg"
          data: imageData, // Base64-encoded image
        },
      },
      {
        type: 'text',
        text: userPromptText,
      },
    ],
  },
];
```

**LLM Configuration:**

```typescript
{
  temperature: 0.1,        // Low temperature for consistent extraction
  maxTokens: 4000,         // IMAGE_MAX_TOKENS (see extraction-limits.ts)
  responseFormat: 'json'   // Force JSON output (if supported)
}
```

**Response Parsing:**

Same as text-based extraction (section 7.3):

1. Parse JSON response
2. Handle single object vs. array
3. Normalize null values to undefined
4. **URL handling:** Only use imageSource as event URL if it's an HTTP(S) URL (not a local file path)
5. Validate against `ExtractedEventSchema`
6. Return validated events

**Error Handling:**

- JSON parse failure → Throw error (truncated output)
- Validation failure → Log error, skip event
- No events extracted → Return empty array
- Unsupported image format → Throw error
- Image too large → Throw error

**Special Considerations:**

- **URL field:** If LLM doesn't extract a URL from the image and imageSource is a local file path (e.g., `./tests/fixtures/flyer.jpg`), leave URL undefined rather than using the file path
- **Address field:** Flyers often have incomplete addresses — accept partial addresses and rely on geocoding
- **Multi-event flyers:** Some promotional materials advertise multiple events — LLM should extract each separately

---

## 8. Normalization

### 8.1 Geocoding

**Purpose:** Convert address strings to GPS coordinates

**External Service:** Nominatim (OpenStreetMap geocoding API)

**API Endpoint:**

```
GET https://nominatim.openstreetmap.org/search
Query Parameters:
  q: {address}
  format: json
  limit: 1
Headers:
  User-Agent: Tokoro-Crawler/1.0
```

**Response Format:**

```json
[
  {
    "lat": "45.4898",
    "lon": "9.1915",
    "display_name": "Via Borsieri 37, Milano, Italy",
    "place_id": 123456
  }
]
```

**Algorithm:**

```python
async def try_geocode(address: str) -> Optional[Coordinates]:
    url = f"https://nominatim.openstreetmap.org/search?q={urlencode(address)}&format=json&limit=1"
    headers = {"User-Agent": "Tokoro-Crawler/1.0"}

    response = await http_get(url, headers=headers)
    data = json.loads(response.body)

    if len(data) == 0:
        return None

    return {
        "lat": float(data[0]["lat"]),
        "lng": float(data[0]["lon"])
    }

async def geocode_address(address: str, venue_name: Optional[str] = None) -> Optional[Coordinates]:
    # 1. Try the full address as-is
    result = await try_geocode(address)
    if result: return result

    # 2. Drop the first segment (possible venue prefix) if address has a comma
    if ',' in address:
        without_first = ','.join(address.split(',')[1:]).strip()
        if without_first:
            result = await try_geocode(without_first)
            if result: return result

    # 3. Try "venue name, address" (helps when address is just a city/region)
    if venue_name:
        result = await try_geocode(f"{venue_name}, {address}")
        if result: return result

    # 4. Try venue name alone as last resort
    if venue_name:
        result = await try_geocode(venue_name)
        if result: return result

    return None
```

**Rate Limiting:**

- Nominatim free tier: Max 1 request/second
- MUST enforce at least 1100ms between consecutive Nominatim requests
- A module-level `lastGeocodeTime` timestamp tracks the last request; each call waits if needed before proceeding
- Cache geocoding results per address

**Geocoding Query Selection:**

- Use `event.address` if present; otherwise fall back to `event.venue_name`
- If neither is present (and no coordinates): reject event immediately (return `null`)
- Pass `event.venue_name` to `geocodeAddress()` as the optional `venueName` parameter to enable the venue-aware fallback cascade

**Fallback:**

- If all geocoding attempts fail and event has no coordinates: reject event (return `null`)
- Log geocoding failures for manual review

### 8.2 Timestamp Normalization

**Purpose:** Convert all timestamps to ISO 8601 format without timezone, representing local time at the venue

**Input Formats:**

- ISO 8601 strings with timezone: `"2026-03-15T21:00:00Z"`, `"2026-03-15T20:00:00+01:00"`
- ISO 8601 strings without timezone: `"2026-03-15T21:00:00"`
- Unix timestamps: `1710532800`

**Output Format:**

```
YYYY-MM-DDTHH:MM:SS
```

**Algorithm:**

```python
def normalize_timestamp(time: Union[str, int]) -> str:
    if isinstance(time, int):
        # Unix timestamp → UTC ISO string, then slice
        return datetime.utcfromtimestamp(time).strftime("%Y-%m-%dT%H:%M:%S")
    else:
        # Strip any timezone suffix (Z or ±HH:MM) — do NOT convert to UTC
        stripped = re.sub(r'(Z|[+-]\d{2}:\d{2})$', '', time)
        return stripped[:19]  # "YYYY-MM-DDTHH:MM:SS"
```

**CRITICAL:** Do NOT route through `Date.toISOString()` or `datetime.isoformat()` with UTC conversion — those would shift the time. Strip the timezone suffix and keep the wall-clock time as-is.

**Timezone-Aware Fallback (post-geocoding):**

After geocoding provides `lat`/`lng`, if the extracted event has `start_time_utc` (a JSON-LD datetime with a real UTC time):

1. Look up the IANA timezone for the venue coordinates (e.g. via `timeapi.io/api/timezone/coordinate`)
2. Convert `start_time_utc` to local time using `Intl.DateTimeFormat` with that timezone
3. If the LLM-extracted `start_time` is a **placeholder** (time portion is `00:00:00`, indicating no explicit time was found), substitute with the JSON-LD-derived local time
4. Similarly fill `end_time` from `end_time_utc` if the LLM produced no end time

This handles sites (e.g. DICE) that store datetimes in UTC in their JSON-LD while showing local time in the visible text.

**Note:** `start_time_utc` is only set when the JSON-LD date has a timezone suffix (Z or ±HH:MM) **and** the time component is not midnight (`T00:00:00`). Midnight UTC is a common "date-only" placeholder used by publishers (e.g. browsers that render `"2026-06-10"` as `"2026-06-10T00:00:00Z"`); treating it as a real UTC time would shift the date incorrectly (e.g. producing 2am for a UTC+2 venue).

**Important:** `start_time_utc`/`end_time_utc` are internal fields — they are never included in the final `NormalizedEvent` sent to the API.

### 8.3 Event Signing (Ed25519)

**Purpose:** Cryptographically sign events to prove authorship and prevent tampering

**Keypair Format:**

- Private key: 64 hexadecimal characters (32 bytes)
- Public key: 64 hexadecimal characters (32 bytes)
- Signature: 128 hexadecimal characters (64 bytes)

**Canonical Event Data (for signing):**

```json
{
  "pubkey": "<64 hex chars>",
  "title": "<string>",
  "description": "<string or empty string>",
  "url": "<string or empty string>",
  "venue_name": "<string or empty string>",
  "address": "<string or empty string>",
  "lat": <number>,
  "lng": <number>,
  "start_time": "<ISO 8601>",
  "end_time": "<ISO 8601 or null>",
  "category": "<category string>",
  "tags": [<array of strings>],
  "created_at": "<ISO 8601>"
}
```

**Signing Algorithm:**

1. **Normalize optional fields:**
   - Convert `undefined` to empty string: `description`, `url`, `venue_name`, `address`
   - Convert `undefined` to empty array: `tags`
   - Convert `undefined` to `null`: `end_time`

2. **Serialize to canonical JSON:**

   ```javascript
   const canonical = JSON.stringify(eventData); // Key order matters!
   ```

   **Critical:** Use the exact key order shown above. Some languages randomize JSON key order.

3. **Hash the canonical JSON:**

   ```javascript
   const encoder = new TextEncoder();
   const data = encoder.encode(canonical);
   const hashBuffer = await crypto.subtle.digest('SHA-256', data);
   const messageHash = hex(hashBuffer); // 64 hex chars
   ```

4. **Sign the hash:**

   ```javascript
   const signature = await ed25519.sign(
     hexToBytes(messageHash),
     hexToBytes(privateKey)
   );
   const signatureHex = bytesToHex(signature); // 128 hex chars
   ```

5. **Attach signature to event:**
   ```javascript
   normalizedEvent.pubkey = publicKey;
   normalizedEvent.signature = signatureHex;
   ```

**Verification (for testing):**

```javascript
const isValid = await ed25519.verify(
  hexToBytes(signature),
  hexToBytes(messageHash),
  hexToBytes(publicKey)
);
```

**Libraries:**

- JavaScript/TypeScript: `@noble/ed25519`
- Python: `cryptography` or `pynacl`
- Go: `crypto/ed25519`
- Rust: `ed25519-dalek`

---

## 9. API Publishing

### 9.1 Tokoro API Endpoint

**Endpoint:**

```
POST {apiUrl}/events
```

**Request Body:**

```json
{
  "pubkey": "<64 hex chars>",
  "signature": "<128 hex chars>",
  "title": "Jazz Night at Blue Note",
  "description": "An evening of live jazz...",
  "url": "https://example.com/event",
  "venue_name": "Blue Note",
  "address": "Via Borsieri 37, Milano",
  "lat": 45.4898,
  "lng": 9.1915,
  "start_time": "2026-03-15T21:00:00",
  "end_time": "2026-03-16T00:00:00",
  "category": "music",
  "tags": ["jazz", "live music"],
  "created_at": "2026-03-01T10:00:00"
}
```

**Success Response (201 Created):**

```json
{
  "id": "<64 hex chars (event ID)>",
  "message": "Event created successfully"
}
```

**Error Responses:**

- **400 Bad Request:** Missing required fields

  ```json
  { "error": "Missing required fields" }
  ```

- **401 Unauthorized:** Invalid signature

  ```json
  { "error": "Invalid signature" }
  ```

- **409 Conflict:** Duplicate event detected

  ```json
  {
    "error": "Duplicate event",
    "message": "A similar event already exists in the database",
    "existing_event_id": "<event_id>"
  }
  ```

- **500 Internal Server Error:** Server error

### 9.2 Pre-Publish Duplicate Check

Before publishing each event, the `APIPublisher` queries the Tokoro API for nearby events in the same ±1 hour time window within a 0.1 km radius, and uses `isDuplicate()` (from `shared/llm/duplicate-check.ts`) to check each candidate. If a duplicate is found, the event is silently skipped (counted as a success — the event already exists).

This check is only performed when an LLM is configured in the publisher. If no LLM is configured (e.g., debug mode), or if the pre-check API call fails, publishing proceeds normally.

**Query:**

```
GET {apiUrl}/events?lat={lat}&lng={lng}&radius=0.1&from={start-1h}&to={start+1h}
```

**`isDuplicate()` pipeline:**

1. Levenshtein title similarity ≥ 0.9 → duplicate (no LLM call)
2. LLM check: returns `{"probability": <0-1>}` — probability ≥ 0.7 → duplicate
3. Any LLM error → false (fail open — let the worker make the final 409 call)

### 9.3 Batch Publishing

**Algorithm:**

```python
async def publish_multiple(events: List[NormalizedEvent]) -> int:
    published_count = 0

    for event in events:
        try:
            response = await http_post(
                f"{api_url}/events",
                headers={"Content-Type": "application/json"},
                body=json.dumps(event)
            )

            if response.status == 201:
                print(f"✅ Published: {event.title}")
                published_count += 1
            elif response.status == 409:
                print(f"⚠️  Duplicate skipped: {event.title}")
            else:
                print(f"❌ Failed ({response.status}): {event.title}")
        except Exception as error:
            print(f"❌ Error publishing {event.title}: {error}")

    return published_count
```

**Rate Limiting:**

- No current rate limit on API

### 9.4 Debug Mode

**Purpose:** Test extraction logic without publishing to the API.

**Behavior:**

Two sub-modes controlled by `debug` and `normalize` flags in `CrawlerConfig`:

| `debug` | `normalize`     | Geocoding + signing | API publish |
| ------- | --------------- | ------------------- | ----------- |
| false   | —               | ✅                  | ✅          |
| true    | false (default) | ❌                  | ❌          |
| true    | true            | ✅                  | ❌          |

When `debug: true, normalize: false` (default debug):

1. **LLM extraction runs normally**
2. **Normalization skipped:** No geocoding, no Ed25519 signing
3. **Raw LLM output printed to console:** The `ExtractedEvent` as returned by the LLM, before any geocoding or signing
4. **Fast:** Avoids Nominatim rate-limiting (1 req/s) — essential for pages with many events

When `debug: true, normalize: true`:

1. **Full extraction + normalization:** Geocoding, timezone lookup, and Ed25519 signing all run
2. **Skip API publishing:** Output the complete `NormalizedEvent` to console instead of POSTing
3. **Faster than normal publish:** Skip rate limiting delays between events

**Output Format (debug without normalize):**

```
================================================================================
DEBUG - Extracted Event (raw, normalization skipped):
================================================================================
{
  "title": "Jazz Night at Blue Note",
  "description": "An evening of live jazz...",
  "venue_name": "Blue Note",
  "address": "Via Borsieri 37, Milano",
  "start_time": "2026-03-15T21:00:00",
  "category": "music",
  "tags": ["jazz", "live music"]
}
================================================================================

[DEBUG] 1 event(s) extracted (normalization skipped)
```

**Output Format (debug with normalize):**

```
================================================================================
DEBUG MODE - Extracted Event:
================================================================================
{
  "pubkey": "abc123...",
  "signature": "def456...",
  "title": "Jazz Night at Blue Note",
  "lat": 45.4898,
  "lng": 9.1915,
  ...
}
================================================================================
```

**Use Cases:**

- `--debug`: Fast check of what the LLM extracts — use on pages with many events (geocoding would be very slow)
- `--debug --normalize`: Validate geocoding results and signatures without touching the database
- Comparing LLM provider outputs
- Developing and testing new extraction prompts

---

## 10. LLM Provider Abstraction

### 10.1 LLM Provider Interface

```typescript
interface LLMProvider {
  name: string;

  /**
   * Generate a completion from the LLM
   */
  complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse>;
}

// Multimodal support: content can be string (text-only) or array of content blocks (text + images)
interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: LLMMessageContent;
}

type LLMMessageContent =
  | string // Simple text content
  | LLMContentBlock[]; // Multimodal content (text + images)

type LLMContentBlock = LLMTextBlock | LLMImageBlock;

interface LLMTextBlock {
  type: 'text';
  text: string;
}

interface LLMImageBlock {
  type: 'image';
  source: {
    type: 'url' | 'base64';
    url?: string; // For URL-based images
    media_type?: string; // MIME type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    data?: string; // Base64-encoded image data
  };
}

interface LLMOptions {
  temperature?: number; // 0.0 to 1.0
  maxTokens?: number; // Max output tokens
  responseFormat?: 'json' | 'text';
}

interface LLMResponse {
  content: string; // LLM output
  model: string; // Model identifier
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}
```

**Multimodal Usage Examples:**

Text-only message (existing behavior):

```typescript
{
  role: 'user',
  content: 'Extract events from this page: ...'
}
```

Multimodal message with image (image mode):

```typescript
{
  role: 'user',
  content: [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: '<base64-encoded-image-data>'
      }
    },
    {
      type: 'text',
      text: 'Today\'s date: 2026-03-06\n\nImage source: flyer.jpg\n\nPlease extract all event information from this image.'
    }
  ]
}
```

### 10.2 Supported Providers

#### OpenAI

**Configuration:**

```typescript
{
  apiKey: string;          // OpenAI API key
  model: string;           // e.g., "gpt-4o", "gpt-4o-mini"
  baseURL?: string;        // Optional custom endpoint
}
```

**API Call:**

```
POST https://api.openai.com/v1/chat/completions
Headers:
  Authorization: Bearer {apiKey}
  Content-Type: application/json
Body:
  {
    "model": "gpt-4o",
    "messages": [...],
    "temperature": 0.1,
    "max_tokens": 2000,
    "response_format": { "type": "json_object" }
  }
```

#### Anthropic

**Configuration:**

```typescript
{
  apiKey: string; // Anthropic API key
  model: string; // e.g., "claude-3-5-sonnet-20241022"
}
```

**API Call:**

```
POST https://api.anthropic.com/v1/messages
Headers:
  x-api-key: {apiKey}
  anthropic-version: 2023-06-01
  Content-Type: application/json
Body:
  {
    "model": "claude-3-5-sonnet-20241022",
    "messages": [...],
    "temperature": 0.1,
    "max_tokens": 2000,
    "system": "<system prompt>"
  }
```

**Note:** Anthropic uses separate `system` field instead of system message in array.

#### Ollama (Local)

**Configuration:**

```typescript
{
  baseURL: string; // e.g., "http://localhost:11434"
  model: string; // e.g., "llama3.2", "mistral"
}
```

**API Call:**

```
POST http://localhost:11434/api/chat
Headers:
  Content-Type: application/json
Body:
  {
    "model": "llama3.2",
    "messages": [...],
    "stream": false,
    "options": {
      "temperature": 0.1,
      "num_predict": 2000
    },
    "format": "json"
  }
```

**Response Format:**

```json
{
  "message": {
    "role": "assistant",
    "content": "{...}"
  },
  "model": "llama3.2",
  "created_at": "...",
  "done": true
}
```

#### OpenRouter (Multi-Provider)

**Configuration:**

```typescript
{
  apiKey: string; // OpenRouter API key
  model: string; // e.g., "anthropic/claude-3.5-sonnet"
}
```

**API Call:**

```
POST https://openrouter.ai/api/v1/chat/completions
Headers:
  Authorization: Bearer {apiKey}
  Content-Type: application/json
Body:
  {
    "model": "anthropic/claude-3.5-sonnet",
    "messages": [...],
    "temperature": 0.1,
    "max_tokens": 2000
  }
```

### 10.3 JSON Mode Support

**Problem:** Not all LLMs support forced JSON output

**Solutions:**

1. **OpenAI:** Use `response_format: { type: "json_object" }`
2. **Anthropic:** No native JSON mode, but reliable with prompt engineering
3. **Ollama:** Use `format: "json"` parameter
4. **Fallback:** Parse JSON from text response, extract from code fences if needed

**Extraction Algorithm:**

````python
def extract_json(response: str) -> dict:
    # Try direct parse
    try:
        return json.loads(response)
    except:
        pass

    # Try extracting from code fence
    match = re.search(r'```json\s*(\{.*?\})\s*```', response, re.DOTALL)
    if match:
        return json.loads(match.group(1))

    # Try finding first JSON object
    match = re.search(r'\{.*\}', response, re.DOTALL)
    if match:
        return json.loads(match.group(0))

    raise ValueError("No JSON found in response")
````

---

## 11. Configuration

### 11.1 Crawler Configuration

```typescript
interface CrawlerConfig {
  // LLM provider
  llm: LLMProvider;

  // Cryptographic keypair for signing events
  keypair: {
    privkey: string; // 64 hex chars
    pubkey: string; // 64 hex chars
  };

  // Tokoro API endpoint
  apiUrl: string; // e.g., "https://worker.tokoro.dev" or "http://localhost:8787"

  // Crawler mode
  mode?: 'direct' | 'discover' | 'image' | 'festival' | 'pdf'; // Default: 'direct'

  // Fetcher type
  fetcher?: 'playwright' | 'jina'; // Default: 'playwright'

  // Browser engine (only relevant when fetcher = 'playwright')
  browserEngine?: 'chrome' | 'obscura'; // Default: 'chrome'

  // Jina API key (required if fetcher = 'jina')
  jinaKey?: string;

  // Debug mode (skip API publishing, output events to console)
  debug?: boolean; // Default: false

  // Normalize in debug mode (run geocoding + signing but skip publishing)
  // Only meaningful when debug is true. Default: false (skip normalization for fast output)
  normalize?: boolean; // Default: false
}
```

### 11.2 Environment Variables

```bash
# LLM Configuration
LLM_PROVIDER=openai                  # openai | anthropic | ollama | openrouter
LLM_API_KEY=sk-...                   # API key (not needed for Ollama)
LLM_MODEL=gpt-4o                     # Model identifier
LLM_BASE_URL=http://localhost:11434  # Optional (for Ollama)

# Crawler Configuration
CRAWLER_MODE=discover                # direct | discover
CRAWLER_FETCHER=playwright           # playwright | jina
BROWSER_ENGINE=chrome                # chrome | obscura (default: chrome; playwright only)
OBSCURA_WS_ENDPOINT=ws://127.0.0.1:9222  # Connect to running Obscura instance (skips auto-launch)
JINA_API_KEY=jina_...                # Jina API key (if using Jina fetcher)

# API Configuration
API_URL=http://localhost:8787        # Tokoro API endpoint

# Cryptographic Keypair
PRIVKEY=abc123...                    # Ed25519 private key (64 hex)
PUBKEY=def456...                     # Ed25519 public key (64 hex)
```

---

## 12. Command-Line Interface

### 12.1 CLI Arguments

```bash
crawler [options] <url1> [url2] [url3] ...
crawler [options] --image <image-path1> [image-path2] ...
```

**Options:**

```
--mode <direct|discover|image|festival|pdf>  Crawler mode (default: discover)
--image                         Shorthand for --mode image (extract from images)
--pdf                           Shorthand for --mode pdf (extract from PDFs)
--fetcher <playwright|jina>     HTML fetcher (default: playwright) - not used in image mode
--browser <chrome|obscura>      Browser engine when using Playwright (default: chrome)
--llm <provider>                LLM provider (openai, anthropic, ollama, openrouter)
--model <model-name>            LLM model identifier (must support vision for image mode)
--api-url <url>                 Tokoro API endpoint
--debug                         Debug mode: print raw LLM output, skip normalization/geocoding and API publishing
--normalize                     (With --debug) run full normalization (geocoding + signing) but skip publishing
--group-by-day                  Group extracted events into one per calendar day (applies to all modes)
--no-jsonld                     Disable JSON-LD extraction; use LLM only (useful when JSON-LD data is wrong)
--help                          Show help
```

**Examples:**

```bash
# Discover events from venue homepage using OpenAI
crawler --llm openai --model gpt-4o https://www.bluenote.it

# Direct extraction from event page using Anthropic
crawler --mode direct --llm anthropic --model claude-3-5-sonnet-20241022 https://example.com/event

# Use Ollama local LLM
crawler --llm ollama --model llama3.2 https://www.bluenote.it

# Use Jina fetcher instead of Playwright
crawler --fetcher jina --llm openai https://www.bluenote.it

# Use Obscura browser engine instead of headless Chrome
crawler --browser obscura https://www.bluenote.it

# Use Chrome explicitly (same as default)
crawler --browser chrome https://www.bluenote.it

# Debug mode: fast — prints raw LLM output, skips geocoding/signing
crawler --debug https://www.bluenote.it

# Debug mode with normalization: geocodes and signs but does not publish
crawler --debug --normalize https://www.bluenote.it

# Combine debug with other flags
crawler --mode discover --fetcher jina --debug https://www.bluenote.it

# Disable JSON-LD extraction (use LLM only, e.g. when the site's JSON-LD has wrong times)
crawler --no-jsonld https://example.com/event

# Group events by day (useful for festival schedules or venue programmes)
crawler --mode festival --group-by-day https://www.flowfestival.com
crawler --mode discover --group-by-day https://venue.example.com

# Extract events from image (local file)
crawler --image tests/fixtures/flyer.jpg

# Extract events from multiple images
crawler --image flyer1.jpg flyer2.png poster.jpeg

# Extract from image URL
crawler --image https://example.com/event-poster.png

# Image mode with specific LLM and debug
crawler --image --llm anthropic --model claude-3-5-sonnet-20241022 --debug flyer.jpg

# Alternative: explicit --mode image
crawler --mode image tests/fixtures/flyer.jpg

# Extract events from PDF (local file)
npm run crawl -- --pdf tests/fixtures/poster.pdf

# Extract events from multiple PDFs
npm run crawl -- --pdf flyer1.pdf poster2.pdf schedule.pdf

# Extract from PDF URL
npm run crawl -- --pdf https://example.com/event-schedule.pdf

# PDF mode with specific LLM and debug
npm run crawl -- --pdf --llm anthropic --model claude-3-5-sonnet-20241022 --debug events.pdf

# Alternative: explicit --mode pdf
npm run crawl -- --mode pdf tests/fixtures/schedule.pdf
```

**Image Mode Requirements:**

- LLM provider must support vision capabilities:
  - OpenAI: `gpt-4o`, `gpt-4-turbo`, `gpt-4o-mini`
  - Anthropic: `claude-3-5-sonnet-20241022`, `claude-3-opus-20240229`
  - Ollama: `llava`, `bakllava`, or other vision-enabled models
- Supported image formats: JPEG, PNG, GIF, WebP
- Image sources: local file paths or HTTP(S) URLs

### 12.2 URL Input from File

```bash
# Read URLs from file (one per line)
crawler --mode discover --llm openai urls.txt
```

**urls.txt format:**

```
https://www.bluenote.it
https://www.alcatrazmilano.it
https://www.example.com/events
```

---

## 13. Logging & Debugging

### 13.1 Console Logging

**Log Levels:**

- `INFO`: General progress (`🚀`, `✅`, `📄`)
- `WARN`: Recoverable issues (`⚠️`)
- `ERROR`: Failed operations (`❌`)

**Log Output Example:**

```
🚀 Starting crawler with 1 seed URL(s)

Fetcher: Playwright + HTML cleaner
LLM Provider: OpenAI (gpt-4o)
API URL: http://localhost:8787
Mode: Discover & extract (follow links)

============================================================
Processing seed: https://www.bluenote.it
============================================================

Fetching https://www.bluenote.it...
Discovering event URLs from https://www.bluenote.it...
Extracted 45 candidate links, asking LLM to filter...
Found 8 event URLs

📋 Discovered 8 event page(s), processing each...

  Processing event page: https://www.bluenote.it/eventi/artist-name/

  Extracting events from: Artist Name - Blue Note
  🔍 Attempting JSON-LD extraction...
  ✅ JSON-LD extraction sufficient! Found 1 event(s), skipping LLM extraction
  Extracted 1 valid event(s) from JSON-LD
  Normalizing event: Artist Name Live
  ✅ Published: Artist Name Live

...

============================================================
✅ Crawl complete!
Total events extracted: 12
Total events published: 10
============================================================
```

### 13.2 Debug Logs (File Output)

**Log Directory:** `./logs/`

**Files Created:**

1. **Raw Extracted Content:**

   ```
   logs/2026-03-06T14-30-15-123Z_www_bluenote_it_eventi_artist.txt
   ```

   Contains:
   - URL
   - Page title
   - Current date (for date inference)
   - Cleaned text content (first 30,000 chars in regular mode, 50,000 in festival mode)

2. **LLM Response:**
   ```
   logs/2026-03-06T14-30-15-123Z_www_bluenote_it_eventi_artist_response.json
   ```
   Contains raw JSON response from LLM

**Purpose:**

- Compare LLM outputs across providers
- Debug extraction failures
- Build test datasets

### 13.3 Error Handling

**Recoverable Errors:**

- Geocoding failure → Skip event, log error
- Validation failure → Skip event, log invalid data
- Duplicate event (409) → Log as warning, continue
- Single page fetch failure → Log error, continue with next URL

**Fatal Errors:**

- LLM API authentication failure → Abort crawler
- Malformed LLM JSON response → Abort crawler (likely token limit issue)
- Invalid keypair → Abort crawler

---

## 14. Test Scenarios

### 14.1 HTML Fetching Tests

**Test 1: Playwright Fetcher**

- Fetch https://example.com
- Verify `FetchedPage` contains `url`, `html`, `readableText`, `title`
- Verify `html` contains `<html>` tag
- Verify `readableText` is clean (no HTML tags)

**Test 2: Jina Fetcher**

- Fetch https://example.com via Jina API
- Verify response format matches `FetchedPage`
- Compare content quality with Playwright

**Test 3: JavaScript-Rendered Page**

- Fetch page with dynamic content (e.g., React SPA)
- Verify Playwright waits for content to load
- Verify Jina fetcher handles dynamic content

### 14.2 Page Discovery Tests

**Test 4: Discover Event URLs from Listing Page**

- Seed URL: Venue homepage with 10 event links
- Verify LLM filters out navigation links
- Verify only individual event page URLs returned
- Verify relative URLs converted to absolute

**Test 5: No Event URLs Found**

- Seed URL: Page with no event links
- Verify crawler falls back to treating seed as event page
- Verify single URL returned (the seed)

**Test 6: Large Number of Links**

- Seed URL: Page with 500+ links
- Verify only first 200 links sent to LLM
- Verify no timeout or token limit errors

### 14.3 Event Extraction Tests

**Test 7: JSON-LD Extraction (Sufficient)**

- HTML with complete Schema.org Event JSON-LD
- Verify LLM extraction skipped
- Verify all fields extracted correctly
- Verify category inferred from `@type`

**Test 8: JSON-LD Partial + LLM Merge**

- JSON-LD with missing address
- Verify LLM extraction runs
- Verify JSON-LD data merged with LLM data
- Verify JSON-LD fields take precedence

**Test 9: LLM Extraction Only**

- Plain HTML with no JSON-LD
- Verify LLM extracts all required fields
- Verify description is concise (<100 words)
- Verify tags are lowercase

**Test 10: Multiple Events on Page**

- Event listing page with 5 events
- Verify LLM returns array of 5 events
- Verify each event validated independently

**Test 11: Date Inference (Current Year)**

- Today: March 2, 2026
- Event date: "April 16" (no year)
- Verify inferred as April 16, 2026

**Test 12: Date Inference (Next Year)**

- Today: March 2, 2026
- Event date: "February 10" (no year)
- Verify inferred as February 10, 2027

**Test 13: No End Time Estimation (Web or Image Mode)**

- Event: Concert, start: 21:00, no end time mentioned anywhere on the page or image
- Verify end_time is omitted entirely (not estimated)
- End time estimation is NOT performed for either web page or image extraction

**Test 14: Address Extraction**

- Page with full street address in footer
- Verify complete address extracted (not just city)
- Verify venue name separate from address

### 14.4 Image Extraction Tests (Image Mode)

**Test 31: Extract from Local Image File**

- Input: Local JPEG file (`tests/fixtures/concert-flyer.jpg`)
- Verify image loaded successfully
- Verify base64 encoding and MIME type detection
- Verify LLM extracts event(s) from image
- Verify URL field is undefined (not the file path)

**Test 32: Extract from Image URL**

- Input: HTTP(S) URL to event poster
- Verify image downloaded and encoded
- Verify MIME type from Content-Type header
- Verify event extraction succeeds
- Verify URL field uses image URL if no URL extracted from image

**Test 33: Multi-Event Flyer**

- Input: Image with multiple events listed (e.g., weekly schedule)
- Verify LLM extracts each event separately
- Verify each event has correct date/time
- Verify all events validated

**Test 34: Flyer with Partial Information**

- Input: Flyer with title and date but no address
- Verify extraction succeeds with available fields
- Verify missing optional fields left undefined
- Verify event can still be normalized if venue name geocodable

**Test 35: Unsupported Image Format**

- Input: Invalid image format (e.g., `.svg`, `.tiff`)
- Verify appropriate error thrown
- Verify error message includes format information

**Test 36: Image Too Large**

- Input: Image exceeding 20 MB
- Verify error thrown before LLM call
- Verify helpful error message about size limit

**Test 37: Vision-Enabled LLM Required**

- Input: Valid image with non-vision LLM (e.g., `gpt-3.5-turbo`)
- Verify error or warning about vision requirements
- Verify graceful failure with informative message

**Test 38: Date Inference from Flyer**

- Input: Flyer with "SAT APR 20" (no year)
- Today: March 2, 2026
- Verify date inferred as April 20, 2026

**Test 39: Multiple Image Formats**

- Input: Array of images (JPEG, PNG, WebP)
- Verify all formats loaded correctly
- Verify MIME type detection for each
- Verify extraction succeeds for all

### 14.5 Normalization Tests

**Test 15: Geocoding Success**

- Address: "Via Borsieri 37, Milano"
- Verify geocoding returns lat ≈ 45.489, lng ≈ 9.191
- Verify coordinates within ±0.01 degrees

**Test 16: Geocoding Failure**

- Address: "Invalid Address XYZ123"
- No venue_name
- Verify event rejected (no coordinates)
- Verify error logged

**Test 16b: Geocoding Fallback Cascade**

- Address: "Alcatraz, Milano" (venue name embedded)
- venue_name: "Alcatraz"
- Verify fallback: try full address → drop first segment → venue+address → venue alone
- Verify at least one attempt returns valid coordinates

**Test 17: Timestamp Normalization**

- Input: `"2026-03-15T21:00:00Z"` (ISO with timezone)
- Output: `"2026-03-15T21:00:00"` (no timezone)
- Input: `1710532800` (Unix timestamp)
- Output: `"2026-03-15T21:00:00"`

**Test 18: Event Signing**

- Create event with known keypair
- Verify signature has 128 hex chars
- Verify signature verifies with public key
- Verify tampering (change title) breaks signature

### 14.5 API Publishing Tests

**Test 19: Successful Publish**

- POST valid signed event to API
- Verify 201 response with event ID
- Verify event retrievable via GET /events

**Test 20: Duplicate Event (409)**

- POST same event twice
- Verify second request returns 409
- Verify existing_event_id in response

**Test 21: Invalid Signature (401)**

- POST event with wrong signature
- Verify 401 response

**Test 22: Missing Required Fields (400)**

- POST event without title
- Verify 400 response

### 14.6 Integration Tests

**Test 23: End-to-End Discover Mode**

- Seed: Venue homepage with 5 event pages
- Verify crawler discovers 5 URLs
- Verify 5 events extracted and published
- Verify no duplicates

**Test 24: End-to-End Direct Mode**

- Seed: Single event page URL
- Verify crawler extracts 1 event
- Verify event published successfully

**Test 25: Multi-Provider LLM Comparison**

- Same seed URL processed with OpenAI, Anthropic, Ollama
- Verify all extract same number of events
- Compare extraction accuracy and field completeness

**Test 26: Jina vs. Playwright Comparison**

- Same URL fetched with both fetchers
- Verify event extraction succeeds with both
- Compare content quality and extraction accuracy

### 14.7 Error Handling Tests

**Test 27: Network Timeout**

- Fetch URL with 60-second load time
- Verify timeout after 30 seconds
- Verify error logged, crawler continues

**Test 28: Invalid HTML**

- Fetch page with malformed HTML
- Verify DOM parser handles gracefully
- Verify extraction attempts continue

**Test 29: LLM Rate Limit**

- Trigger rate limit on LLM API
- Verify retry with backoff
- Verify eventual success or graceful failure

**Test 30: Geocoding Rate Limit**

- Geocode 10 addresses in quick succession
- Verify 1-second delay between requests
- Verify all geocoding succeeds

---

## 15. Implementation Checklist

### 15.1 Core Components

- [x] HTML Fetcher (Playwright)
- [x] HTML Fetcher (Jina API alternative)
- [x] HTML text cleaner (linkedom-based)
- [x] Page discovery (link extraction + LLM filtering)
- [x] JSON-LD event parser
- [x] LLM event extractor
- [x] Date inference logic
- [x] End time estimation
- [x] Event normalizer
- [x] Geocoding (Nominatim)
- [x] Timestamp normalization
- [x] Ed25519 event signing
- [x] API publisher
- [x] PDF fetcher and extractor
- [x] Image fetcher and extractor

### 15.2 LLM Providers

- [x] OpenAI provider
- [x] Anthropic provider
- [x] Ollama provider
- [x] OpenRouter provider
- [x] LLM abstraction interface
- [x] JSON extraction from text responses

### 15.3 Crawler Modes

- [x] Direct mode (no discovery)
- [x] Discover mode (link following)
- [x] Image mode (flyers/posters)
- [x] Festival mode (multi-day event listing)
- [x] PDF mode (local files or URLs)

### 15.4 CLI & Configuration

- [x] Command-line argument parsing
- [x] URL input from file
- [x] Environment variable loading
- [x] Configuration validation

### 15.5 Logging & Debugging

- [x] Console logging (INFO/WARN/ERROR)
- [x] Raw content file logging
- [x] LLM response file logging
- [x] Error stack traces

### 15.6 Testing

- [ ] All 30 test scenarios passing
- [ ] Integration tests for full workflows
- [ ] Multi-provider LLM comparison tests
- [ ] Geocoding accuracy tests

---

## 16. Performance Considerations

### 16.1 Bottlenecks

1. **HTML Fetching (Playwright):**
   - Slowest operation (~5-10 seconds per page)
   - Browser launch overhead

2. **LLM API Calls:**
   - 1-3 seconds per request
   - Rate limits vary by provider

3. **Geocoding:**
   - 1 request/second limit (Nominatim)

### 16.2 Throughput Estimates

**Playwright Fetcher:**

- ~6-12 pages/minute (with 5 concurrent browsers)
- ~360-720 pages/hour

**Jina Fetcher:**

- ~20-30 pages/minute (no browser overhead)
- ~1200-1800 pages/hour

**LLM Extraction:**

- OpenAI: ~20-30 requests/minute (tier-dependent)
- Anthropic: ~5-10 requests/minute (free tier)
- Ollama: Unlimited (local), speed depends on hardware

**Geocoding:**

- Nominatim: ~60 addresses/minute (1 req/sec)

---

## 17. Security Considerations

### 17.1 Private Key Management

**Critical:** Private key must never be exposed in logs, error messages, or API requests

**Best Practices:**

- Load from environment variable or secure key store
- Never commit to version control
- Use separate keypairs for development and production
- Rotate keypairs periodically

### 17.2 API Key Security

**LLM API Keys:**

- Store in environment variables, not code
- Use least-privilege API keys (read-only where possible)
- Monitor usage for anomalies

**Jina API Key:**

- Same security practices as LLM keys

### 17.3 Input Validation

**URL Validation:**

- Reject non-HTTP(S) schemes (`file://`, `javascript:`, etc.)
- Validate URL format before fetching
- Limit URL length (max 2048 chars)

**HTML Size Limits:**

- Max HTML size: 5 MB (prevent memory exhaustion)
- Max cleaned text: 30,000 chars in regular mode, 50,000 chars in festival mode (see `shared/extractors/extraction-limits.ts` for all limits)

### 17.4 Rate Limiting & Abuse Prevention

**Crawler Rate Limiting:**

- No rate limiting or `robots.txt` enforcement is currently applied
- The Jina fetcher sends a standard browser User-Agent header

**API Publishing Rate Limiting:**

- No current rate limit on the Tokoro API; no backoff logic is implemented

---

## 18. Reference Implementation

The reference implementation (TypeScript/Node.js) can be found in:

- `crawler/src/crawler.ts` — Main crawler class
- `crawler/src/extractors/html-fetcher.ts` — Playwright HTML fetcher
- `crawler/src/extractors/jina-fetcher.ts` — Jina AI fetcher
- `crawler/src/extractors/image-fetcher.ts` — Image loader (file/URL to base64)
- `crawler/src/extractors/page-discovery.ts` — LLM-based page discovery
- `crawler/src/extractors/event-extractor.ts` — JSON-LD + LLM extraction (text and image)
- `crawler/src/extractors/jsonld-extractor.ts` — Schema.org JSON-LD parser
- `crawler/src/extractors/html-cleaner.ts` — DOM-based text cleaning
- `crawler/src/utils/normalizer.ts` — Event normalization and signing
- `shared/utils/geocode.ts` — Nominatim geocoding (shared with crawler-worker)
- `crawler/src/utils/api-publisher.ts` — API publishing logic
- `crawler/src/llm/` — LLM provider implementations (with multimodal support)
- `shared/extractors/extraction-prompt.ts` — Shared prompts for text and image extraction

**Key Dependencies:**

- `playwright` — Headless browser automation
- `linkedom` — Lightweight DOM parsing and text extraction
- `jsdom` — DOM parsing (used by Jina fetcher)
- `@noble/ed25519` — Ed25519 signing
- `zod` — Schema validation
- `openai` — OpenAI API client
- `@anthropic-ai/sdk` — Anthropic API client

---

## 19. Appendices

### Appendix A: Example JSON-LD Event

```json
{
  "@context": "https://schema.org",
  "@type": "MusicEvent",
  "name": "Jazz Night at Blue Note",
  "description": "An evening of live jazz featuring local and international artists.",
  "url": "https://www.bluenote.it/eventi/jazz-night",
  "startDate": "2026-03-15T21:00:00",
  "endDate": "2026-03-16T00:00:00",
  "location": {
    "@type": "Place",
    "name": "Blue Note Milano",
    "address": {
      "@type": "PostalAddress",
      "streetAddress": "Via Borsieri 37",
      "addressLocality": "Milano",
      "postalCode": "20159",
      "addressCountry": "IT"
    },
    "geo": {
      "@type": "GeoCoordinates",
      "latitude": 45.4898,
      "longitude": 9.1915
    }
  },
  "performer": {
    "@type": "MusicGroup",
    "name": "The Jazz Ensemble"
  },
  "offers": {
    "@type": "Offer",
    "url": "https://www.bluenote.it/tickets/jazz-night",
    "price": "25.00",
    "priceCurrency": "EUR"
  }
}
```

### Appendix B: Example LLM Extraction Output

**Input:** Web page for concert event

**LLM Response:**

```json
{
  "title": "The Weeknd - After Hours Tour",
  "description": "Global superstar The Weeknd brings his After Hours tour to Milan for one night only.",
  "venue_name": "San Siro Stadium",
  "address": "Piazzale Angelo Moratti, Milano",
  "start_time": "2026-07-15T20:30:00",
  "end_time": "2026-07-15T23:30:00",
  "category": "music",
  "tags": ["pop", "r&b", "concert", "stadium tour"]
}
```

### Appendix C: Geocoding Example

**Request:**

```
GET https://nominatim.openstreetmap.org/search?q=Via+Borsieri+37%2C+Milano&format=json&limit=1
User-Agent: Tokoro-Crawler/1.0
```

**Response:**

```json
[
  {
    "place_id": 123456,
    "licence": "Data © OpenStreetMap contributors, ODbL 1.0.",
    "osm_type": "way",
    "osm_id": 987654,
    "lat": "45.4898015",
    "lon": "9.1915436",
    "display_name": "37, Via Borsieri, Isola, Municipio 9, Milano, Lombardia, 20159, Italia",
    "address": {
      "house_number": "37",
      "road": "Via Borsieri",
      "suburb": "Isola",
      "city": "Milano",
      "state": "Lombardia",
      "postcode": "20159",
      "country": "Italia",
      "country_code": "it"
    },
    "boundingbox": ["45.4897015", "45.4899015", "9.1914436", "9.1916436"]
  }
]
```

---

## Version History

- **2.0.0** (2026-04-28): Pluggable browser engine — Chrome (default) and Obscura
  - New `--browser <chrome|obscura>` CLI flag selects the browser engine used by the Playwright fetcher
  - Chrome (`chromium.launch()`) remains the default for maximum compatibility
  - Obscura (`chromium.connectOverCDP()`) is an opt-in lightweight alternative: ~30 MB RAM, instant startup, built-in anti-fingerprinting; auto-launched by the crawler via `obscura serve`, or connected to a pre-running instance via `OBSCURA_WS_ENDPOINT`
  - New `BROWSER_ENGINE` and `OBSCURA_WS_ENDPOINT` environment variables
  - `CrawlerConfig` gains `browserEngine?: 'chrome' | 'obscura'`

- **1.9.0** (2026-04-27): `--group-by-day` flag
  - Removed always-on per-day grouping from festival mode
  - New `--group-by-day` CLI flag enables opt-in grouping across all modes (festival, direct, discover, image, PDF, text-file)
  - Days with exactly 1 event pass through unchanged; only multi-event days produce day aggregates
  - Re-wired `deduplicateFestivalEvents` LLM pass into festival mode (was previously dead code)
  - Renamed `groupFestivalEventsByDay` → `groupEventsByDay` (now an exported standalone function)
  - Bumped SPECS version to 1.9

- **1.8.0** (2026-04-02): Iframe hang prevention in Playwright fetcher
  - Each `frame.content()` call is now raced against a 5-second timeout so a stuck third-party widget (e.g. Bandcamp player, social media embed) cannot block the crawl indefinitely
  - If a frame times out its HTML is silently skipped; main-frame content is always captured

- **1.7.0** (2026-04-02): Debug mode `--normalize` flag
  - `--debug` now skips normalization by default (no geocoding, no signing) — fast even for pages with 30+ events
  - New `--normalize` flag (only meaningful with `--debug`) runs full geocoding + signing but skips API publishing
  - `CrawlerConfig` gains a `normalize?: boolean` field

- **1.6.0** (2026-04-02): PDF extraction mode
  - New `PdfFetcher` with hybrid text/image extraction: tries text via `pdfjs-dist`; falls back to rendering pages as PNG via `@napi-rs/canvas` when text is sparse (< 200 non-whitespace chars)
  - New `crawlPdfs` method on `EventCrawler` — routes to text extractor or per-page vision extractor depending on PDF content type
  - New `--pdf` CLI flag (shorthand for `--mode pdf`); `--mode pdf` also accepted
  - Max PDF size: 50 MB; max pages rendered to images: 10
  - `CrawlerConfig.mode` now includes `'pdf'`

- **1.5.0** (2026-03-29): Year inference improvements
  - New `correctEventYear` post-processing step: validates the inferred year against the `day_name` field extracted by the LLM; corrects by ±1 year or drops unresolvable events
  - URL year hint is now **definitive** (not just advisory): if the page URL contains a year pattern (e.g. `/2025/`), that year is used for all dates even if it results in past dates — past events are filtered downstream
  - `day_name` prompt rule expanded to cover full and abbreviated day names in any language (e.g. `DOMENICA`, `Samstag`, `Samedi`), with explicit instruction to translate to English full weekday name
  - LLM prompts (text and image) updated: `day_name` field added; `talks` added to category list; URL year hint rule and day_name extraction rule added to DATE EXTRACTION RULES; example outputs include `day_name`
  - Raw LLM events (title, start_time, day_name) are logged before validation to aid debugging

- **1.4.0** (2026-03-28): LLM prompt alignment and end-time estimation removal
  - Web extraction: end_time is now only set if explicitly mentioned on the page — no estimation (completes removal started in 1.1.0)
  - Added festival_name and festival_url fields to text extraction prompt
  - start_time now carries a CRITICAL note to preserve local time and never convert to UTC
  - Date inference updated: past dates within ~90 days are kept as past events; only far-past dates roll to next year
  - Added social media post-timestamp context rule for date inference
  - Added "Extract ALL events" guideline (no filtering by date proximity or relevance)
  - Richer multi-day and festival schedule guidelines in text extraction prompt

- **1.3.0** (2026-03-25): Festival mode per-day grouping
  - All individually-extracted festival events are now grouped into one event per calendar day
  - Day event title: `"{Festival Name} – {Weekday}, {Month Day}"`
  - Day event description: sorted list of `HH:MM Sub-event (Venue)` entries
  - Day events use `T00:00:00`/`T23:59:59` times (render as all-day in iCal)
  - Within-day deduplication by title (handles overlapping listing pages)
  - Replaces the previous LLM deduplication pass with a deterministic grouping step

- **1.2.0** (2026-03-19): Festival mode deduplication
  - Events are now collected from all listing pages before publishing
  - A single LLM deduplication pass removes redundant wrapper events and semantic duplicates
  - Parallel events (different stages, overlapping times) are preserved
  - Extraction and post-filter event lists are logged to console with title and time range

- **1.1.0** (2026-03-12): Image extraction end-time estimation removed
  - For image/flyer extraction, end_time is only set if explicitly visible on the image — no estimation
  - End time estimation rules (+3h for concerts, +2h for sports, etc.) continue to apply to web page extraction only

---

**END OF SPECIFICATION**
