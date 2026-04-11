# Tokoro Crawler Worker

A Cloudflare Worker that extracts structured event data from URLs and images, returning unsigned `PreparedEvent[]` for client-side signing and publishing.

## Features

- **API Key Authentication**: Secure access control using bearer tokens
- **Three Crawl Modes**:
  - `direct`: Extract events directly from the provided URL
  - `discover`: Find individual event pages and extract from each
  - `image`: Extract events from an image (e.g. a poster or flyer)
- **Worker-native**: Runs on Cloudflare's edge network (zero infrastructure)
- **Hybrid Event Extraction**: Two-stage extraction process (JSON-LD + LLM)
- **Geocoding**: Automatically resolves addresses to coordinates
- **Client Integration**: Accepts pre-rendered content from the Chrome extension or bookmarklet for better extraction
- **Pure extraction**: Returns unsigned `PreparedEvent[]` — signing and publishing are handled by the client

## Architecture

```
Client (Chrome extension, bookmarklet, or API caller)
  ↓ POST /crawl (with optional HTML or image data)
Crawler Worker
  ↓ fetch via Jina AI Reader (or use provided content)
  ↓ Stage 1: Extract JSON-LD structured data
  ↓ Stage 2: LLM extraction (if JSON-LD insufficient, or image mode)
  ↓ Merge results (JSON-LD for structured fields, LLM for classification)
  ↓ geocode addresses (failures captured as dropped_events)
  ↓ return PreparedEvent[] (unsigned, geocoded)
Client
  ↓ sign each event with curator Ed25519 keypair
  ↓ POST /events to Tokoro API Worker
Tokoro API Worker
  ↓ verify signature
  ↓ store in D1
```

## How Event Extraction Works

The crawler uses a **hybrid two-stage extraction approach** that combines structured data parsing with AI-powered extraction:

### Stage 1: JSON-LD Extraction (`jsonld-extractor.ts`)

First, the crawler searches for **Schema.org JSON-LD structured data** embedded in the HTML:

```html
<script type="application/ld+json">
  {
    "@type": "Event",
    "name": "Jazz Night at Blue Note",
    "startDate": "2026-03-15T21:00:00",
    "location": {
      "@type": "Place",
      "name": "Blue Note",
      "address": "Via Borsieri 37, Milano"
    }
  }
</script>
```

**What it extracts:**

- Event title, description, URL
- Venue name and full address
- GPS coordinates (if present)
- Start/end dates (ISO 8601 format)
- Event type → category mapping (MusicEvent → music, SportsEvent → sports, etc.)

**When it's sufficient:**
If JSON-LD contains all required fields (title, start_time, address/coordinates, category), the crawler **skips LLM extraction entirely**, saving time and API costs.

### Stage 2: LLM Extraction (`event-extractor.ts`)

If JSON-LD is missing or incomplete, the crawler uses an LLM (OpenAI/Anthropic) to extract event data from the page text:

**LLM receives:**

- Page URL and title
- Clean text content (markdown from Jina AI, or server-side cleaned text when HTML is provided by the Chrome extension or bookmarklet)
- Today's date (for inferring missing years in dates)

**What the LLM extracts:**

- All event fields (title, description, venue, address, dates, category, tags)
- **Date inference**: If "April 20" appears without a year, assumes current year (or next year if date would be in the past)
- **Category classification**: Chooses from predefined categories (music, sports, theater, etc.)
- **Address validation**: Requires complete street addresses (not just city names)

### Stage 3: Merging Results

When both JSON-LD and LLM extraction produce results, the crawler **merges them strategically**:

- **JSON-LD takes precedence for structured data**: dates, coordinates, addresses (more reliable)
- **LLM takes precedence for classification**: category, tags (better context understanding)

### Content Sources

The crawler can fetch content from two sources:

1. **Jina AI Reader** (default for API requests):
   - Fetches clean markdown from any URL
   - Good for programmatic crawling
   - May miss some dynamic content
   - Requires external HTTP request

2. **Chrome extension or bookmarklet** (when `html` is provided):
   - **Bypasses Jina AI completely** (no external fetching)
   - Sends **full HTML** which the worker cleans server-side
   - Better extraction quality (rendered DOM, cleaned article text)
   - Faster (no network roundtrip for page fetching)

### Example Flow

**Scenario 1: Perfect JSON-LD (no LLM needed)**

```
1. Fetch HTML
2. Find JSON-LD: ✅ All required fields present
3. Validate and return → Skip LLM extraction
4. Geocode address → return PreparedEvent
```

**Scenario 2: Incomplete JSON-LD (LLM enrichment)**

```
1. Fetch HTML
2. Find JSON-LD: ⚠️  Has title + date, missing address and category
3. Run LLM extraction
4. Merge: JSON-LD dates + LLM address/category
5. Geocode → return PreparedEvent
```

**Scenario 3: No JSON-LD (pure LLM)**

```
1. Fetch HTML (no JSON-LD found)
2. Run LLM extraction
3. Extract all fields from text
4. Geocode → return PreparedEvent
```

## Setup

### 1. Install Dependencies

```bash
cd crawler-worker
npm install
```

### 2. Configure Secrets

Set the required secrets using Wrangler:

```bash
# Create and set API keys (comma-separated for multiple clients)
wrangler secret put CRAWLER_API_KEYS
# Example: my-secret-key-1,another-secret-key-2

# Set LLM provider credentials
wrangler secret put LLM_API_KEY
# Your OpenAI/Anthropic API key

wrangler secret put LLM_PROVIDER
# One of: openai, anthropic, openrouter

wrangler secret put LLM_MODEL
# Optional model override, e.g. google/gemini-3.1-flash-lite-preview

wrangler secret put JINA_API_KEY
# Optional: Jina AI Reader API key — increases rate limits
```

> **Important:** `.dev.vars` is only used for local development (`npm run dev`). It has **no effect on the deployed worker**. Whenever you change the LLM model (or any other secret), you must run `wrangler secret put` to update the value in Cloudflare, then redeploy with `npm run deploy`. A common mistake is updating `.dev.vars` and assuming the deployed worker picks up the change — it does not.

## Development

### Local Development Setup

1. **Create `.dev.vars` file** for local secrets:

```bash
cp .dev.vars.example .dev.vars
```

2. **Fill in your secrets** in `.dev.vars`:

```bash
# API Keys (comma-separated)
CRAWLER_API_KEYS=test-key-1,test-key-2

# LLM Configuration
LLM_PROVIDER=openai
LLM_API_KEY=your_openai_api_key
```

3. **Run locally**:

```bash
npm run dev
```

This starts the Worker at `http://localhost:8787` (default wrangler dev port).

### Test the API

```bash
# Health check
curl http://localhost:8787/

# Submit a crawl job
curl -X POST http://localhost:8787/crawl \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/events",
    "mode": "discover"
  }'
```

## Deployment

Deploy to Cloudflare Workers:

```bash
npm run deploy
```

Your Worker will be available at:

- Dev: `https://happenings-crawler-worker.<your-subdomain>.workers.dev`
- Production: Configure a custom domain in Cloudflare dashboard

## API Reference

### `GET /`

Health check and API information.

**Response:**

```json
{
  "name": "Tokoro Crawler Worker",
  "version": "1.0.0",
  "endpoints": { ... }
}
```

### `POST /extract-text`

Debug endpoint: runs LLM-only event extraction from plain text, bypassing JSON-LD entirely. Useful for testing the LLM prompt in isolation against the deployed worker.

**Headers:**

- `Authorization: Bearer <api_key>` (required)
- `Content-Type: application/json`

**Request Body:**

```json
{
  "text": "Clean text content to extract events from",
  "url": "https://example.com/event",
  "title": "Page title",
  "referenceDate": "2026-03-10"
}
```

**Fields:**

- `text` (string, required): Clean text content (e.g. from a `.txt` file)
- `url` (string, optional): Source URL, used as fallback event URL
- `title` (string, optional): Page title passed to the LLM
- `referenceDate` (string, optional): Reference date for date inference (`YYYY-MM-DD`, defaults to today)

**Response:**

```json
{
  "model": "google/gemini-3.1-flash-lite-preview",
  "events": [
    {
      "title": "Concerto acustico Sp46",
      "start_time": "2026-03-12T19:00:00",
      "category": "music",
      ...
    }
  ]
}
```

**Example using a local file:**

```bash
curl -X POST https://happenings-crawler-worker.<subdomain>.workers.dev/extract-text \
  -H "Authorization: Bearer <api_key>" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --rawfile text ./tests/cleaned-pages/mypage.txt \
    '{text: $text, url: "https://example.com/", title: "My Page"}')"
```

---

### `POST /crawl`

Submit a URL to crawl and extract events. Returns unsigned `PreparedEvent[]` — the client signs and publishes them to the API worker.

**Headers:**

- `Authorization: Bearer <api_key>` (required)
- `Content-Type: application/json`

**Request Body:**

```json
{
  "url": "https://example.com/events",
  "mode": "discover",
  "html": "<html>...</html>",
  "title": "Event Title",
  "imageData": "<base64-encoded-image>",
  "imageMimeType": "image/jpeg"
}
```

**Fields:**

- `url` (string, required): URL to crawl, or the source URL of an image (for `mode: "image"`)
- `mode` (string, optional): `direct`, `discover`, or `image` (default: `discover`)
- `html` (string, optional): Pre-rendered HTML from Chrome extension or bookmarklet (cleaned server-side)
- `title` (string, optional): Page title from Chrome extension or bookmarklet
- `imageData` (string, optional): Base64-encoded image data (required when `mode` is `"image"`)
- `imageMimeType` (string, optional): MIME type of the image, e.g. `"image/jpeg"` (for `mode: "image"`)

**Response (Success):**

```json
{
  "success": true,
  "message": "Crawl completed successfully",
  "stats": {
    "urls_processed": 5,
    "events_extracted": 12
  },
  "events": [
    {
      "title": "Jazz Night",
      "start_time": "2026-03-15T21:00:00",
      "venue_name": "Blue Note",
      "address": "Via Borsieri 37, Milano",
      "lat": 45.4869,
      "lng": 9.1885,
      "category": "music",
      "tags": ["jazz", "live"],
      "created_at": "2026-04-10T12:00:00"
    }
  ],
  "dropped_events": [
    {
      "title": "Some Event",
      "reason": "Geocoding failed for \"Unknown Venue\"",
      "address": "Unknown Venue",
      "venue_name": "Unknown Venue"
    }
  ]
}
```

`events` contains geocoded, unsigned `PreparedEvent` objects ready for client-side signing. `dropped_events` is omitted when there are none.

**Response (Error):**

```json
{
  "success": false,
  "error": "Crawl failed",
  "message": "Failed to fetch https://example.com/events via Jina AI: 404"
}
```

**Examples:**

```bash
# Health check
curl https://happenings-crawler-worker.<subdomain>.workers.dev/

# Discover mode — find event sub-pages and extract from each
curl -s -X POST https://happenings-crawler-worker.<subdomain>.workers.dev/crawl \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/events",
    "mode": "discover"
  }' | jq .

# Direct mode — single page, no link discovery
curl -s -X POST https://happenings-crawler-worker.<subdomain>.workers.dev/crawl \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/specific-event-page",
    "mode": "direct"
  }' | jq .

# Pass HTML source inline (worker cleans it server-side)
curl -s -X POST https://happenings-crawler-worker.<subdomain>.workers.dev/crawl \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg url "https://example.com/events" \
    --arg html "$(cat page.html)" \
    '{url: $url, mode: "direct", html: $html}'
  )" | jq .

# Image mode — extract events from a poster/flyer image
curl -s -X POST https://happenings-crawler-worker.<subdomain>.workers.dev/crawl \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg url "https://example.com/flyer.jpg" \
    --arg imageData "$(base64 -i flyer.jpg)" \
    '{url: $url, mode: "image", imageData: $imageData, imageMimeType: "image/jpeg"}'
  )" | jq .
```

## Authentication

The Worker uses API key authentication via the `Authorization` header:

```
Authorization: Bearer your-api-key-here
```

API keys are configured via the `CRAWLER_API_KEYS` secret (comma-separated for multiple keys).

### Managing API Keys

```bash
# Add/update API keys
wrangler secret put CRAWLER_API_KEYS
# Enter: key1,key2,key3

# Rotate keys: add new keys, update clients, then remove old keys
```

## Security

- **API Keys**: Store API keys securely and rotate them regularly
- **Rate Limiting**: Consider adding Cloudflare Rate Limiting rules
- **CORS**: Currently allows all origins (`*`), restrict in production if needed
- **Secrets**: Never commit secrets to version control

## Limitations

- **Timeout**: Worker execution limited to 30 seconds (may not complete for very large sites)
- **Fetcher**: Uses Jina AI Reader (no Playwright/browser in Workers)
- **LLM Provider**: Requires external API (OpenAI, Anthropic, OpenRouter)

## Implementation Status

✅ **Complete:**

- Full crawler logic implemented
- API key authentication
- LLM-powered event extraction
- Page discovery with link analysis
- Geocoding and event normalization
- Returns unsigned `PreparedEvent[]` for client-side signing

## Future Enhancements

- [ ] Add Durable Objects for long-running crawls (>30s)
- [ ] Add queue support for async processing
- [ ] Implement retry logic for failed requests
- [ ] Add observability (metrics, logging, Sentry)
- [ ] Support batch crawl requests
- [ ] Add rate limiting per API key
- [ ] Implement crawl result caching

## Troubleshooting

### "Invalid API key" error

Make sure:

1. The `Authorization` header is present
2. The format is `Bearer <key>` (case-insensitive)
3. The key matches one in `CRAWLER_API_KEYS`

### Crawl fails with "Jina AI Reader failed"

- Check if the URL is accessible
- Verify Jina AI Reader is not rate limiting you
- Try with a different URL

## Cost

Free tier limits (Cloudflare Workers):

- 100,000 requests/day
- 10ms CPU time per request
- No egress charges

Additional costs:

- LLM API calls (OpenAI, Anthropic, etc.)
- Jina AI Reader (1M tokens/month free tier)
- Nominatim geocoding (free, but respect rate limits)

## License

ISC
