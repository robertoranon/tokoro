# Tokoro Crawler Worker — Technical Specification

**Version:** 1.0
**Date:** 2026-03-06
**Status:** Reference implementation exists — this spec enables reimplementation in any language

---

## 1. Overview

This document specifies the complete behavior of the Tokoro Crawler Worker, a serverless API service that extracts events from URLs and returns them as `PreparedEvent[]` for client-side signing and publishing.

The Crawler Worker is a **pure extraction service**. It does not sign events, does not publish to the API, and has no knowledge of keypairs. Clients (Chrome extension, bookmarklet relay) receive `PreparedEvent[]`, sign each event with their own Ed25519 private key, and POST directly to the API worker.

The Crawler Worker:

- Runs as a Cloudflare Worker (or compatible serverless platform)
- Exposes an authenticated HTTP API for submitting crawl jobs
- Accepts rendered HTML from browser clients (Chrome extension, bookmarklet) and cleans it server-side; falls back to Jina AI Reader when no HTML is provided
- Extracts structured event data using JSON-LD parsing and/or LLM-based extraction
- Extracts events from images (flyers, posters) using multimodal LLM vision capabilities
- Normalizes and geocodes events, returning `PreparedEvent[]` in the response
- Does **not** sign events, does not publish to the API

This specification is implementation-agnostic and provides sufficient detail to reimplement the service in any language or serverless platform (Cloudflare Workers, AWS Lambda, Google Cloud Functions, etc.) with complete test coverage.

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────┐
│   HTTP Client / Chrome Ext / Bookmarklet │
│   (sends authenticated POST /crawl)      │
└──────────────┬───────────────────────────┘
               ↓
┌──────────────────────────────────────┐
│        Crawler Worker API            │
│  • API Key Authentication            │
│  • Request Validation                │
│  • CORS Headers                      │
└──────────────┬───────────────────────┘
               ↓
┌──────────────────────────────────────┐
│      Worker Crawler Core             │
│  • Mode: direct | discover | image  │
└──────────────┬───────────────────────┘
               ↓
┌──────────────────────────────────────┐
│   HTML/Content Fetching Layer        │
│  • HTML-in-request (primary)        │
│  • Jina AI Reader API (fallback)    │
│  • Raw HTML fetch (for link disc.)  │
│  • Image data (base64, from client) │
└──────────────┬───────────────────────┘
               ↓
┌──────────────────────────────────────┐
│     Page Discovery (discover mode)   │
│  • Extract links from HTML           │
│  • LLM filters event page URLs       │
│  • Convert relative → absolute URLs  │
└──────────────┬───────────────────────┘
               ↓
┌──────────────────────────────────────┐
│       Event Extraction               │
│  1. JSON-LD Event Parser             │
│  2. LLM-Based Extraction             │
└──────────────┬───────────────────────┘
               ↓
┌──────────────────────────────────────┐
│    Normalization & Geocoding         │
│  • Geocoding (Nominatim)             │
│  • Timestamp normalization           │
│  • Returns PreparedEvent[]           │
└──────────────────────────────────────┘
               ↓
  (returned in response — client signs
   and POSTs directly to API worker)
```

---

## 3. API Specification

### 3.1 Base URL

```
https://<worker-name>.<account-subdomain>.workers.dev
```

Example:

```
https://happenings-crawler-worker.YOUR_SUBDOMAIN.workers.dev
```

### 3.2 Authentication

All API requests (except GET /) require authentication via Bearer token in the `Authorization` header.

**Header Format:**

```
Authorization: Bearer <api_key>
```

**Valid API Keys:**

- Configured via `CRAWLER_API_KEYS` environment variable (comma-separated list)
- Example: `CRAWLER_API_KEYS="key1,key2,key3"`

**Unauthorized Response (401):**

```json
{
  "error": "Unauthorized",
  "message": "Missing Authorization header"
}
```

### 3.3 CORS Headers

All responses include CORS headers:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
```

OPTIONS requests return `200 OK` with CORS headers and empty body.

### 3.4 GET / (API Information)

**Request:**

```
GET /
```

**Response (200 OK):**

```json
{
  "name": "Tokoro Crawler Worker",
  "version": "2.0.0",
  "description": "Event extraction service. Returns PreparedEvent[] for client-side signing.",
  "endpoints": {
    "GET /": {
      "description": "API info and health check"
    },
    "POST /crawl": {
      "description": "Extract events from a URL (requires API key). Returns PreparedEvent[] — client signs and publishes.",
      "headers": {
        "Authorization": "Bearer <api_key>"
      },
      "body": {
        "url": "URL to crawl (required)",
        "mode": "Crawl mode: \"direct\", \"discover\", or \"image\" (default: discover)",
        "html": "Optional rendered HTML from Chrome extension (cleaned server-side)",
        "title": "Optional page title from Chrome extension",
        "imageData": "Base64-encoded image data (required for mode=image)",
        "imageMimeType": "MIME type of image (e.g. image/jpeg, image/png) (optional for mode=image)"
      },
      "example": {
        "url": "https://example.com/events",
        "mode": "discover"
      }
    },
    "POST /extract-text": {
      "description": "Debug: LLM-only extraction from plain text (requires API key). Skips fetching and HTML cleaning.",
      "headers": {
        "Authorization": "Bearer <api_key>"
      },
      "body": {
        "text": "Clean text content (required)",
        "url": "Optional source URL",
        "title": "Optional page title",
        "referenceDate": "Optional reference date YYYY-MM-DD"
      }
    },
    "POST /preview": {
      "description": "Store page data temporarily for iOS Shortcut handoff. No auth required. Returns a UUID token valid for 30 minutes.",
      "body": {
        "url": "Page URL (required)",
        "html": "Page HTML or text content (optional)",
        "title": "Page title (optional)"
      }
    },
    "GET /preview/:token": {
      "description": "Retrieve previously stored page data by token. No auth required."
    }
  }
}
```

### 3.5 POST /crawl (Submit Crawl Job)

**Request:**

```http
POST /crawl
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "url": "https://example.com/events",
  "mode": "discover",
  "html": "<html>...</html>",
  "title": "Event Page"
}
```

**Request Body Parameters:**

| Parameter       | Type    | Required | Default    | Description                                                                                        |
| --------------- | ------- | -------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `url`           | string  | Yes      | —          | URL to crawl (or image source URL for mode=image)                                                  |
| `mode`          | string  | No       | `discover` | Crawl mode: `direct`, `discover`, or `image`                                                       |
| `html`          | string  | No       | —          | Rendered HTML from Chrome extension (cleaned server-side)                                          |
| `title`         | string  | No       | —          | Page title from Chrome extension                                                                   |
| `imageData`     | string  | Cond.    | —          | Base64-encoded image data (required when mode=image)                                               |
| `imageMimeType` | string  | Cond.    | —          | MIME type (image/jpeg, image/png, etc.) (required for image)                                       |

**Success Response (200 OK):**

```json
{
  "success": true,
  "message": "Extraction complete",
  "stats": {
    "urls_processed": 3,
    "events_extracted": 5
  },
  "events": [
    {
      "title": "Jazz Night",
      "description": "Live jazz performance",
      "venue_name": "Blue Note",
      "address": "Via Borsieri 37, Milano",
      "lat": 45.4898,
      "lng": 9.1915,
      "start_time": "2026-03-15T21:00:00",
      "end_time": "2026-03-16T00:00:00",
      "category": "music",
      "tags": ["jazz", "live music"],
      "created_at": "2026-03-01T10:00:00",
      "festival_name": "Flow Festival 2026",
      "festival_url": "https://www.flowfestival.com"
    }
  ],
  "dropped_events": [
    {
      "title": "Some Event",
      "reason": "Geocoding failed for \"Unknown Venue\"",
      "address": "Unknown Venue",
      "venue_name": "Unknown Venue"
    }
  ],
  "cleaned_text": "..." 
}
```

`events` is always present on success (may be empty). `dropped_events` is omitted when empty. `cleaned_text` is included only when `html` was provided in the request (contains the server-side cleaned text used for LLM extraction). `festival_name` and `festival_url` are optional — they appear only when the LLM detects the page is part of a named festival.

Events in the response are `PreparedEvent` objects (geocoded, normalised, unsigned). The client is responsible for signing each event with their Ed25519 private key and POSTing to `POST /events` on the API worker.

**Error Responses:**

- **400 Bad Request:** Invalid request body or parameters

  ```json
  {
    "error": "Invalid request body",
    "message": "Request body must be valid JSON"
  }
  ```

- **401 Unauthorized:** Missing or invalid API key

  ```json
  {
    "error": "Unauthorized",
    "message": "Invalid API key"
  }
  ```

- **500 Internal Server Error:** Crawl failed (fatal error, not a per-event normalization failure)
  ```json
  {
    "success": false,
    "error": "Crawl failed",
    "message": "Failed to fetch https://example.com via Jina AI: 404"
  }
  ```
  Note: Geocoding failures are no longer fatal — they result in individual events being added to `dropped_events` rather than aborting the entire crawl.

---

## 4. Crawler Modes

### 4.1 Direct Mode (`mode: "direct"`)

**Behavior:**

- Process only the given URL
- Do NOT follow links to discover event pages
- Extract events directly from the provided URL

**Use Cases:**

- Single event page URLs
- Pages known to contain event data
- Chrome extension extracting from current tab

**Algorithm:**

```
page = providedHtml ? clean(providedHtml) : fetch(url) via Jina AI Reader
events = extract_events(page)
for each event in events:
  result = normalize(event)  // returns { event } | { failure }
  if result.event: add to PreparedEvent[]
  if result.failure: add to dropped_events
return PreparedEvent[] with stats and dropped_events (if any)
```

### 4.2 Discover Mode (`mode: "discover"`)

**Behavior:**

- Treat URL as venue listing/calendar page
- Use LLM to discover individual event page URLs
- Fetch each discovered event page
- Extract events from individual pages

**Use Cases:**

- Venue homepages
- Event calendars
- Listing pages with links to individual events

**Algorithm:**

```
page = providedHtml ? clean(providedHtml) : fetch(url) via Jina AI Reader
event_urls = discover_event_urls(page)  // LLM-based link filtering

if event_urls.empty():
  # Fallback: treat seed as single event page
  event_urls = [url]

for each event_url in event_urls:
  event_page = fetch(event_url)
  events = extract_events(event_page)
  for each event in events:
    result = normalize(event)  // returns { event } | { failure }
    if result.event: add to PreparedEvent[]
    if result.failure: add to dropped_events
return PreparedEvent[] with stats and dropped_events (if any)
```

### 4.3 Image Mode (`mode: "image"`)

**Behavior:**

- Process base64-encoded image data (no URL fetching)
- Extract events from image using multimodal LLM vision capabilities
- Support flyers, posters, Instagram images, promotional graphics

**Use Cases:**

- Event flyers and posters
- Social media image posts
- Screenshots of event information
- User-uploaded event images

**Algorithm:**

```
# Validate image data provided
if not imageData or not imageMimeType:
  return error("imageData and imageMimeType required for image mode")

# Extract events using multimodal LLM (vision + text)
events = extract_events_from_image(imageData, imageMimeType, url)
for each event in events:
  result = normalize(event)  // returns { event } | { failure }
  if result.event: add to PreparedEvent[]
  if result.failure: add to dropped_events
return PreparedEvent[] with stats and dropped_events (if any)
```

**Supported Image Formats:**

- image/jpeg
- image/png
- image/gif
- image/webp

**Image Requirements:**

- Maximum size: 5 MB (recommended)
- Base64-encoded
- Clear, readable text
- Event information visible (dates, times, venue, title)

**End Time Behavior for Image Extraction:**

- `end_time` is only set if explicitly visible on the image/flyer
- End time estimation (e.g., +3 hours for concerts, +2 hours for sports) does NOT apply to image extraction
- This differs from web page extraction, where end time is estimated when missing

---

## 5. Content Fetching Strategies

### 5.1 Chrome Extension / Bookmarklet Content (Preferred)

**When Available:**

- Chrome extension or bookmarklet provides `html` and `title` in request body
- HTML is the fully-rendered DOM (after JavaScript execution), with no client-side cleaning

**Advantages:**

- No rate limits (content already fetched by browser)
- JavaScript-rendered content included
- Accurate representation of user's view

**Server-Side HTML Cleaning:**

When `html` is provided, the worker cleans it using `shared/extractors/html-cleaner.ts`:

1. Remove content tags and their contents: `script`, `style`, `noscript`, `iframe`, `canvas`, `svg`
2. Remove void tags: `img`, `meta`
3. Remove `link[rel=stylesheet]`
4. Strip all remaining HTML tags
5. Decode HTML entities
6. Remove empty lines and collapse excess whitespace

The cleaned text is used for LLM extraction; the original `html` is retained for JSON-LD extraction.

**Usage:**

```javascript
if (providedHtml) {
  const { text, title: extractedTitle } = extractCleanText(providedHtml);
  return {
    url,
    html: providedHtml, // For JSON-LD extraction
    text, // Cleaned text for LLM
    title: providedTitle || extractedTitle || 'Untitled',
  };
}
```

### 5.2 Jina AI Reader (Fallback)

**When Chrome Extension / Bookmarklet Content Not Available:**

**API Endpoint:**

```
GET https://r.jina.ai/{encoded_url}
```

**Request Headers:**

```
Accept: text/plain
X-Timeout: 30
X-Return-Format: markdown
X-With-Links-Summary: false
X-With-Images-Summary: false
Authorization: Bearer {jina_api_key}  (optional, improves rate limits)
```

**Response:**

- Markdown-formatted clean text
- Title extracted from first `# Heading`
- No HTML tags or JavaScript

**Additional Raw HTML Fetch:**

- Fetch raw HTML separately for link discovery
- Used in discover mode to extract `<a href>` tags
- Not used for event extraction (Jina markdown is cleaner)

**Algorithm:**

```python
async def fetch_page(url: str) -> FetchedPage:
    # Fetch clean markdown from Jina
    jina_url = f"https://r.jina.ai/{url}"
    jina_response = await fetch(jina_url, headers={
        "Accept": "text/plain",
        "X-Return-Format": "markdown",
        "Authorization": f"Bearer {jina_api_key}"  # optional
    })
    markdown = await jina_response.text()

    # Extract title from first heading
    title = extract_title_from_markdown(markdown) or "Untitled"

    # Fetch raw HTML for link discovery
    html_response = await fetch(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; TokoroCrawler/1.0)"
    })
    html = await html_response.text()

    return {
        "url": url,
        "html": html,           # For link discovery and JSON-LD
        "text": markdown,       # For LLM extraction
        "title": title
    }
```

**Rate Limiting:**

- Free tier: ~200 requests/hour
- With API key: Higher limits (varies by plan)
- Implement retry with exponential backoff on 429 responses

### 5.3 Image Content (Image Mode)

**When Image Mode Enabled:**

- Request includes `imageData` (base64) and `imageMimeType`
- Skip HTML/text fetching entirely
- Pass image directly to multimodal LLM

**Advantages:**

- Extract events from visual promotional materials
- No need for structured web pages
- Works with social media images, screenshots, photos
- Handles complex layouts that are difficult to parse as HTML

**Image Preprocessing:**

- No preprocessing required
- LLM processes image directly
- Base64 encoding handled by client (Chrome extension, bookmarklet, or API caller)

**Usage:**

```javascript
if (mode === 'image') {
  if (!imageData || !imageMimeType) {
    throw new Error('imageData and imageMimeType required for image mode');
  }

  // Extract events using multimodal LLM
  const events = await extractor.extractEventsFromImage(
    imageData,
    imageMimeType,
    url // Image source URL (optional, for reference)
  );

  return events;
}
```

**Chrome Extension Integration:**

- User right-clicks on image
- Extension converts image URL to base64 using FileReader API
- Extension sends POST /crawl with mode=image, imageData, imageMimeType
- Worker extracts events and returns PreparedEvent[]
- Extension signs each event and POSTs directly to the API worker

**LLM Requirements:**

- Must support multimodal input (vision + text)
- Supported providers: Anthropic Claude (claude-3-5-sonnet or later), OpenAI GPT-4o/GPT-4 Turbo
- Not supported: Ollama (no vision support in Workers), OpenRouter (varies by model)

---

## 6. Event Extraction

Event extraction follows the same algorithm as the standalone crawler (see `../crawler/SPECS.md` section 7).

**Key Components:**

1. **JSON-LD Extraction (enabled by default):** Parse structured data from `<script type="application/ld+json">` tags
2. **LLM Extraction:** Use LLM to extract events from text content
3. **Merge Strategy:** Combine JSON-LD and LLM data when both available — LLM takes precedence for `description` (concise summaries) and times; JSON-LD `start_time_utc`/`end_time_utc` preserved for post-geocoding timezone correction

**Important Differences from Standalone Crawler:**

- Uses Jina markdown text instead of Readability-cleaned HTML
- No Playwright (not available in Workers environment)
- Shorter text content (Jina is more concise)
- JSON-LD extraction is always enabled (no `--no-jsonld` flag; this is a serverless API, not a CLI)

See `../crawler/SPECS.md` sections 7.1-7.5 for detailed extraction algorithms.

---

## 7. Event Normalization

Normalization follows the same algorithms as the standalone crawler (see `../crawler/SPECS.md` section 8), **excluding signing** — the crawler-worker is extraction-only. Clients receive `PreparedEvent[]` and are responsible for Ed25519 signing before publishing.

**Key Steps:**

1. **Geocoding:** Convert address to GPS coordinates using Nominatim
2. **Timestamp Normalization:** Strip timezone suffix from ISO strings (do NOT convert to UTC); see `../crawler/SPECS.md` section 8.2 for the timezone-aware fallback using `start_time_utc`

See `../crawler/SPECS.md` sections 8.1-8.2 for detailed algorithms.

### 7.1 NormalizeFailure

When normalization fails for an individual event (e.g., geocoding failure, missing address), the normalizer returns a `NormalizeFailure` instead of a `NormalizedEvent`. The failure is added to `dropped_events` and does NOT abort the rest of the crawl.

```typescript
interface NormalizeFailure {
  title: string; // Event title for identification
  reason: string; // Human-readable reason for failure
  address?: string; // The address that failed geocoding (if applicable)
  venue_name?: string; // The venue name (if applicable)
}
```

**Failure cases:**

- No coordinates, no address, and no venue name (cannot geocode)
- Geocoding returned no results for the given address
- Timestamp cannot be parsed

**Return type of `EventNormalizer.normalize()`:**

```typescript
async normalize(event: ExtractedEvent): Promise<{ event: NormalizedEvent } | { failure: NormalizeFailure }>
```

Callers MUST handle both cases. Normalization exceptions (unexpected errors) are also caught per-event by the crawler adapter and converted to `NormalizeFailure` entries.

---

## 8. Publishing (Client Responsibility)

The crawler worker is a **pure extraction service** — it does not sign or publish events. After receiving `PreparedEvent[]` in the response, clients are responsible for:

1. **Signing:** For each event, compute `SHA-256(canonical JSON)`, sign the hash with their Ed25519 private key, and include `pubkey` and `signature` in the event body.
2. **Publishing:** POST each signed event directly to `POST /events` on the API worker.

See `worker/SPECS.md` sections 3.2 and 7.4 for the signing and publish API contract.

---

## 9. LLM Provider Configuration

### 9.1 Environment Variables

```bash
LLM_PROVIDER=openai          # openai | anthropic | openrouter
LLM_API_KEY=sk-...           # API key for the provider
LLM_MODEL=gpt-4o             # Optional model override
```

### 9.2 Provider Selection

```python
def createLLMProvider(env: Env) -> LLMProvider:
    provider = env.LLM_PROVIDER or "openai"
    api_key = env.LLM_API_KEY
    model = env.LLM_MODEL  # Optional override

    if provider == "openai":
        return OpenAIProvider(api_key, model or "gpt-4o")
    elif provider == "anthropic":
        return AnthropicProvider(api_key, model or "claude-3-5-sonnet-20241022")
    elif provider == "openrouter":
        return OpenRouterProvider(api_key, model or "anthropic/claude-3.5-sonnet")
    else:
        raise ValueError(f"Unknown LLM provider: {provider}")
```

### 9.3 Supported Providers

See `../crawler/SPECS.md` section 10 for detailed provider specifications.

**Key Differences in Workers Environment:**

- OpenAI: Same API, works natively in Workers
- Anthropic: Same API, works natively in Workers
- OpenRouter: Same API, works natively in Workers
- **Ollama: NOT SUPPORTED** (requires local server, not available in Workers)

---

## 10. Environment Configuration

### 10.1 Secrets (Set via `wrangler secret put`)

| Secret             | Required | Description                                              |
| ------------------ | -------- | -------------------------------------------------------- |
| `CRAWLER_API_KEYS` | Yes      | Comma-separated list of allowed API keys                 |
| `LLM_API_KEY`      | Yes      | API key for LLM provider (OpenAI, Anthropic, etc.)       |
| `LLM_PROVIDER`     | No       | LLM provider name (default: `openai`)                    |
| `LLM_MODEL`        | No       | Model identifier (default: provider-specific)            |
| `JINA_API_KEY`     | No       | Jina AI Reader API key (optional, increases rate limits) |

> **Note:** `CRAWLER_PRIVKEY` and `CRAWLER_PUBKEY` are no longer used by the crawler worker. Event signing is done client-side. Only the standalone Node.js crawler CLI (`crawler/`) still needs a keypair.

**Setting Secrets:**

```bash
# Set API keys for authentication
wrangler secret put CRAWLER_API_KEYS
# Enter: key1,key2,key3

# Set LLM provider credentials
wrangler secret put LLM_API_KEY
# Enter: sk-... (OpenAI) or sk-ant-... (Anthropic)

wrangler secret put LLM_PROVIDER
# Enter: openai

# Optional: Set Jina API key for higher rate limits
wrangler secret put JINA_API_KEY
# Enter: jina_...
```

### 10.2 Wrangler Configuration

No `[vars]`, `[[services]]`, or `[[kv_namespaces]]` bindings are required. The crawler worker is self-contained — it does not connect to the API worker.

Optional R2 bucket for log storage:

```toml
# [[r2_buckets]]
# binding = "CRAWLER_LOGS"
# bucket_name = "happenings-crawler-logs"
```

---

## 11. Error Handling

### 11.1 Request Validation Errors (400)

**Missing URL:**

```json
{
  "error": "Missing required field",
  "message": "The \"url\" field is required"
}
```

**Invalid URL:**

```json
{
  "error": "Invalid URL",
  "message": "The \"url\" field must be a valid URL"
}
```

**Invalid Mode:**

```json
{
  "error": "Invalid mode",
  "message": "The \"mode\" field must be \"direct\", \"discover\", or \"image\""
}
```

### 11.2 Authentication Errors (401)

**Missing Authorization Header:**

```json
{
  "error": "Unauthorized",
  "message": "Missing Authorization header"
}
```

**Invalid API Key:**

```json
{
  "error": "Unauthorized",
  "message": "Invalid API key"
}
```

### 11.3 Crawl Errors (500)

**Jina AI Fetch Failed:**

```json
{
  "success": false,
  "error": "Crawl failed",
  "message": "Jina AI Reader failed: 403 Forbidden"
}
```

**LLM API Error:**

```json
{
  "success": false,
  "error": "Crawl failed",
  "message": "OpenAI API error: Rate limit exceeded"
}
```

### 11.4 Recoverable Errors

**During Crawl Execution:**

- Single page fetch failure → Log error, continue with next URL
- Geocoding failure → Skip event (added to `dropped_events`), continue with next event
- Validation failure → Skip event (added to `dropped_events`), continue with next event

**Overall Crawl Status:**

- If at least one event normalized: Return success with stats
- If zero events normalized but extraction succeeded: Return success with zero stats and empty `events` array
- If extraction failed entirely: Return error (500)

---

## 12. Client Integration (Chrome Extension & Bookmarklet)

Both the Chrome extension and the bookmarklet use the same `/crawl` API. The Chrome extension can also do image extraction (right-click on image); the bookmarklet does page crawling only.

### 12.1 Typical Workflow (Page Crawling — Chrome Extension or Bookmarklet)

1. **User navigates to event page in browser**
2. **Extension captures rendered content:**
   - `document.documentElement.outerHTML` → `html`
   - `document.title` → `title`
3. **Extension sends POST /crawl request:**
   ```json
   {
     "url": "https://example.com/event",
     "mode": "direct",
     "html": "<html>...</html>",
     "title": "Event Page - Venue Name"
   }
   ```
4. **Worker cleans HTML server-side (strips scripts, styles, etc.) then extracts and geocodes events**
5. **Worker returns `PreparedEvent[]` in response**
6. **Extension displays events to user for confirmation**
7. **User confirms → Extension signs each event and POSTs directly to the API worker**

### 12.2 Chrome Extension Workflow (Image Extraction — Chrome Extension Only)

1. **User right-clicks on image (flyer, poster, Instagram image, etc.)**
2. **User selects "Extract event from this image" context menu item**
3. **Extension captures image:**
   - Fetch image from `info.srcUrl`
   - Convert to Blob
   - Read as base64 using FileReader API
   - Extract MIME type from Blob
4. **Extension sends POST /crawl request:**
   ```json
   {
     "url": "https://example.com/image.jpg",
     "mode": "image",
     "imageData": "iVBORw0KGgoAAAANSUhEUgAA...",
     "imageMimeType": "image/jpeg"
   }
   ```
5. **Worker extracts events using multimodal LLM (vision) and geocodes them**
6. **Worker returns `PreparedEvent[]` in response**
7. **Extension stores events in chrome.storage.local and opens popup**
8. **Popup displays events to user for confirmation**
9. **User reviews extracted events and clicks "Publish"**
10. **Extension signs each event and POSTs directly to the API worker**

**Image Conversion (Background Service Worker):**

```javascript
async function imageUrlToBase64(imageUrl) {
  const response = await fetch(imageUrl);
  const blob = await response.blob();

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // Extract base64 data (remove data:image/xxx;base64, prefix)
      const base64 = reader.result.split(',')[1];
      const mimeType = blob.type;
      resolve({ base64, mimeType });
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
```

### 12.3 Advantages of Extension / Bookmarklet-Provided Content

**No Jina Rate Limits:**

- Content already fetched by browser
- No external API calls needed

**JavaScript Execution:**

- Extension captures fully rendered DOM
- Dynamic content included (SPAs, lazy loading)

**User Context:**

- User is already viewing the page
- High confidence that content is relevant

### 12.4 Client Request Pattern

```javascript
// Step 1: Extract events from the current page
const response = await fetch(`${workerUrl}/crawl`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    url: currentUrl,
    mode: 'direct',
    html: document.documentElement.outerHTML,
    title: document.title,
  }),
});

const { events } = await response.json();

// Step 2: Show events to user for confirmation...

// Step 3: User confirms — sign and publish each event to the API worker
for (const event of events) {
  const canonical = { pubkey, title: event.title, ... /* all fields */ };
  const hash = await sha256(JSON.stringify(canonical));
  const signature = await ed25519.sign(hash, privateKey);

  await fetch(`${apiUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...canonical, signature }),
  });
}
```

---

## 13. Deployment

### 13.1 Cloudflare Workers Deployment

**Prerequisites:**

- Cloudflare account
- Wrangler CLI installed (`npm install -g wrangler`)
- Logged in to Wrangler (`wrangler login`)

**Configuration (wrangler.toml):**

```toml
name = "tokoro-crawler-worker"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
workers_dev = true

# Optional: R2 bucket for structured log storage
# [[r2_buckets]]
# binding = "CRAWLER_LOGS"
# bucket_name = "tokoro-crawler-logs"
```

**Set Secrets:**

```bash
wrangler secret put CRAWLER_API_KEYS  # comma-separated allowed API keys
wrangler secret put LLM_API_KEY       # OpenAI / Anthropic / OpenRouter key
wrangler secret put LLM_PROVIDER      # openai | anthropic | openrouter
wrangler secret put LLM_MODEL         # optional model override
wrangler secret put JINA_API_KEY      # optional, increases Jina rate limits
```

**Deploy:**

```bash
# Deploy to production
wrangler deploy

# Deploy to dev (preview)
wrangler dev
```

**Test:**

```bash
# Health check
curl https://tokoro-crawler-worker.your-account.workers.dev/

# Submit crawl job
curl -X POST https://tokoro-crawler-worker.your-account.workers.dev/crawl \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/events",
    "mode": "discover"
  }'
```

---

## 14. Test Scenarios

### 14.1 Authentication Tests

**Test 1: Valid API Key**

- POST /crawl with valid `Authorization: Bearer <key>`
- Verify 200 response

**Test 2: Missing Authorization Header**

- POST /crawl without `Authorization` header
- Verify 401 response with error message

**Test 3: Invalid API Key**

- POST /crawl with wrong API key
- Verify 401 response

**Test 4: Malformed Authorization Header**

- POST /crawl with `Authorization: InvalidFormat`
- Verify 401 response

### 14.2 Request Validation Tests

**Test 5: Missing URL**

- POST /crawl without `url` field
- Verify 400 response: "Missing required field"

**Test 6: Invalid URL Format**

- POST /crawl with `url: "not-a-url"`
- Verify 400 response: "Invalid URL"

**Test 7: Invalid Mode**

- POST /crawl with `mode: "invalid"`
- Verify 400 response: "Invalid mode"

**Test 8: Invalid JSON**

- POST /crawl with malformed JSON body
- Verify 400 response: "Invalid request body"

### 14.3 Crawl Execution Tests

**Test 9: Direct Mode with Jina Fetch**

- POST /crawl with valid URL, `mode: "direct"`
- Verify events extracted and returned in `events` field
- Verify stats: `urls_processed = 1`

**Test 10: Discover Mode with Multiple Event URLs**

- POST /crawl with venue homepage, `mode: "discover"`
- Verify LLM discovers multiple event URLs
- Verify each URL fetched and processed
- Verify stats: `urls_processed > 1`

**Test 11: Chrome Extension Content**

- POST /crawl with `html` and `title` provided
- Verify Jina fetch skipped
- Verify HTML is cleaned server-side and resulting text used for extraction
- Verify `cleaned_text` field present in response

**Test 12: Image Mode with Base64 Data**

- POST /crawl with `mode: "image"`, `imageData`, `imageMimeType`
- Verify image processed by multimodal LLM
- Verify events extracted from image
- Verify HTML/text fetching skipped
- Verify stats: `urls_processed = 1`

**Test 13: Image Mode Missing Parameters**

- POST /crawl with `mode: "image"` but missing `imageData`
- Verify 400 error: "imageData required when mode is image"

**Test 14: Image Mode Invalid Format**

- POST /crawl with unsupported image format (e.g., `image/bmp`)
- Verify LLM error or graceful degradation

### 14.4 Event Extraction Tests

**Test 15: JSON-LD Extraction**

- POST /crawl with URL containing valid Schema.org JSON-LD
- Verify events extracted from JSON-LD
- Verify LLM extraction skipped

**Test 16: LLM Extraction**

- POST /crawl with URL containing plain text event info
- Verify LLM extracts events correctly
- Verify date inference works (current year assumption)

**Test 17: Multiple Events on Page**

- POST /crawl with URL containing 5 events
- Verify all 5 events extracted
- Verify stats: `events_extracted = 5`

### 14.5 Error Handling Tests

**Test 18: Jina Fetch Failure**

- POST /crawl with URL that Jina cannot fetch (403 Forbidden)
- Verify worker returns 500 error
- Verify error message includes Jina status

**Test 19: Geocoding Failure**

- POST /crawl with event containing invalid address
- Verify geocoding fails
- Verify event added to `dropped_events` (not returned in `events`)
- Verify `events_extracted` reflects raw count before geocoding

**Test 20: LLM API Rate Limit**

- Trigger rate limit on LLM API
- Verify worker returns 500 error
- Verify error message indicates rate limit

**Test 21: Multiple Pages, One Fails**

- POST /crawl in discover mode with 3 event URLs
- Make one URL fail (404)
- Verify other 2 pages processed successfully
- Verify stats: `urls_processed = 3`, `events_extracted > 0`

### 14.6 Integration Tests

**Test 22: End-to-End Direct Mode**

- POST /crawl with single event page URL
- Verify event extracted, geocoded, and returned in `events`
- Verify returned `PreparedEvent` has all required fields (lat, lng, start_time, etc.)

**Test 23: End-to-End Discover Mode**

- POST /crawl with venue homepage
- Verify multiple events discovered and returned in `events`

**Test 24: Chrome Extension Page Crawl Workflow**

- POST /crawl with `html`, `title`, and `mode: "direct"`
- Verify events returned in `events` field
- Verify `cleaned_text` field present

**Test 25: Chrome Extension Image Extraction Workflow**

- POST /crawl with `mode: "image"`, `imageData`, `imageMimeType`
- Verify events extracted from image and returned in `events`

---

## 15. Implementation Checklist

### 15.1 Core HTTP API

- [ ] GET / endpoint (API info)
- [ ] POST /crawl endpoint
- [ ] POST /extract-text endpoint (debug)
- [ ] OPTIONS handling (CORS preflight)
- [ ] CORS headers on all responses
- [ ] JSON request/response handling

### 15.2 Authentication

- [ ] API key validation from Authorization header
- [ ] Bearer token parsing
- [ ] Comma-separated key list support
- [ ] 401 unauthorized responses

### 15.3 Request Validation

- [ ] Required field validation (url)
- [ ] URL format validation
- [ ] Mode validation (direct/discover/image)
- [ ] JSON parsing error handling

### 15.4 Content Fetching

- [ ] Jina AI Reader API integration
- [ ] Raw HTML fetch for link discovery
- [ ] Chrome extension content support (html, title — cleaned server-side)
- [ ] Image content support (base64, mime type)

### 15.5 Event Extraction

- [ ] JSON-LD event parser
- [ ] LLM event extractor
- [ ] Page discovery (LLM-based link filtering)
- [ ] Date inference logic
- [ ] End time estimation

### 15.6 Event Normalization

- [ ] Geocoding (Nominatim)
- [ ] Timestamp normalization (ISO 8601)

### 15.7 LLM Providers

- [ ] OpenAI provider
- [ ] Anthropic provider
- [ ] OpenRouter provider
- [ ] LLM factory (provider selection)

### 15.8 Modes

- [ ] Direct mode (no discovery)
- [ ] Discover mode (link following)
- [ ] Image mode (base64 image extraction)

### 15.9 Error Handling

- [ ] Request validation errors (400)
- [ ] Authentication errors (401)
- [ ] Crawl errors (500)
- [ ] Recoverable error handling (continue on failure, dropped_events)

### 15.10 Testing

- [ ] All 25 test scenarios passing
- [ ] Chrome extension integration tests (page crawl + image extraction)
- [ ] Multimodal LLM vision tests (image mode)

---

## 16. Performance Considerations

### 16.1 Cloudflare Workers Limits

**CPU Time:**

- Free tier: 10ms per request
- Paid tier: 50ms per request
- **Issue:** LLM API calls can take 1-3 seconds
- **Solution:** Use async fetch, counts as I/O (not CPU time)

**Memory:**

- 128 MB limit
- **Issue:** Large HTML pages can exceed limit
- **Solution:** Limit content to 15,000 chars for LLM

**Request Duration:**

- Maximum: 30 seconds (with Cloudflare timeout)
- **Issue:** Multiple LLM calls + geocoding can exceed
- **Solution:** Limit discover mode to 5-10 event pages

**Concurrent Requests:**

- Unlimited (scales automatically)
- **Note:** Each request is independent, no shared state

### 16.2 External API Rate Limits

**Jina AI Reader:**

- Free tier: ~200 requests/hour
- With API key: Higher limits (varies by plan)
- **Mitigation:** Prefer Chrome extension content when available

**LLM APIs:**

- OpenAI: 5-60 requests/minute (tier-dependent)
- Anthropic: 5-50 requests/minute (tier-dependent)
- **Mitigation:** Handle 429 responses with retry + exponential backoff

**Nominatim Geocoding:**

- 1 request/second limit
- **Mitigation:** `shared/utils/geocode.ts` enforces ≥1100ms between consecutive requests using a module-level timestamp

### 16.3 Optimization Strategies

**Cache Geocoding Results:**

- Store geocoded addresses in KV or D1
- Avoid re-geocoding same address

**Batch Requests:**

- Not currently supported by external APIs

---

## 17. Security Considerations

### 17.1 API Key Management

**Best Practices:**

- Store API keys in Wrangler secrets (not wrangler.toml)
- Use separate keys for development and production
- Rotate keys periodically
- Never log API keys in console or errors

**Key Distribution:**

- Chrome extension: Embed key in extension (protected by Chrome Web Store)
- Internal tools: Store in environment variables
- External partners: Generate unique keys per partner for tracking

### 17.2 Input Validation

**URL Validation:**

- Reject non-HTTP(S) schemes (`file://`, `javascript:`)
- Limit URL length (max 2048 chars)
- Validate domain (optional: whitelist/blacklist)

**Content Size Limits:**

- Max request body: 100 MB (Cloudflare limit)
- Max HTML: 5 MB (prevent memory exhaustion)
- Max text content: 15,000 chars (prevent token limit)

### 17.3 CORS

All origins are currently allowed (`Access-Control-Allow-Origin: *`). This is appropriate since the API uses bearer token authentication.

---

## 18. Reference Implementation

The reference implementation (TypeScript/Cloudflare Workers) can be found in:

- `src/index.ts` — Main HTTP handler and routing
- `src/auth.ts` — API key authentication
- `src/crawler-adapter.ts` — Worker crawler implementation (extraction + geocoding)
- `src/event-extractor.ts` — JSON-LD + LLM extraction
- `src/page-discovery.ts` — LLM-based page discovery
- `src/event-normalizer.ts` — Geocoding and timestamp normalization (uses `shared/utils/geocode.ts`)
- `src/types.ts` — TypeScript interfaces

**Key Dependencies:**

- `openai` — OpenAI API client
- `@anthropic-ai/sdk` — Anthropic API client
- `zod` — Schema validation

---

## 19. Appendices

### Appendix A: Example Chrome Extension Request

```javascript
// Step 1: Extract rendered content — no client-side cleaning needed
const html = document.documentElement.outerHTML;
const title = document.title;

// Step 2: Send to crawler worker; worker cleans the HTML server-side and extracts events
const response = await fetch('https://tokoro-crawler-worker.your-account.workers.dev/crawl', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer chrome-extension-api-key',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    url: window.location.href,
    mode: 'direct',
    html: html,
    title: title,
  }),
});

const { events } = await response.json();
console.log('Extracted events:', events);

// Step 3: Show events to user for confirmation...

// Step 4: User confirms — sign and publish each PreparedEvent directly to the API worker
for (const event of events) {
  const canonical = buildCanonicalEvent({ pubkey, ...event });
  const hash = await sha256(JSON.stringify(canonical));
  const signature = toHex(await ed25519.sign(hash, privateKey));

  await fetch(`${apiWorkerUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...canonical, signature }),
  });
}
```

### Appendix B: Example Error Responses

**Geocoding Failure:**

```json
{
  "success": false,
  "error": "Crawl failed",
  "message": "Normalization error: Geocoding failed for address: 'Milano' - Error: No results found for address"
}
```

**LLM Rate Limit:**

```json
{
  "success": false,
  "error": "Crawl failed",
  "message": "LLM API error: 429 Too Many Requests - Rate limit exceeded"
}
```

**Jina Fetch Failure:**

```json
{
  "success": false,
  "error": "Crawl failed",
  "message": "Jina AI Reader failed: 403 Forbidden"
}
```

---

**END OF SPECIFICATION**
