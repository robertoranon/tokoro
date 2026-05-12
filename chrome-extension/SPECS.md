# Chrome Extension Specification

## Overview

A Chrome browser extension that extracts event information from web pages and images, and publishes them directly to the Tokoro API worker. The extension provides a two-step workflow: extract events (via the crawler-worker), then sign and publish them (directly to the API worker using the curator's own Ed25519 keypair).

## Functional Requirements

### FR-1: User Settings Management

**FR-1.1: API Key Storage**

- MUST provide an input field for the user to enter their API key
- MUST store the API key persistently using `chrome.storage.sync`
- MUST mask the API key input field (password type)
- MUST validate that API key is not empty before allowing crawl operations
- MUST auto-save settings when input changes
- MUST load saved settings when popup opens

**FR-1.2: Worker URL Configuration**

- MUST provide an input field for the crawler-worker base URL
- MUST have default value: `https://tokoro-crawler-worker.YOUR_SUBDOMAIN.workers.dev`
- MUST store the worker URL persistently using `chrome.storage.sync`
- MUST validate that worker URL is not empty before allowing crawl operations
- MUST auto-save settings when input changes

**FR-1.3: API Worker URL Configuration**

- MUST provide an input field for the API worker base URL (`apiUrl`)
- MUST have placeholder: `https://tokoro-worker.YOUR_SUBDOMAIN.workers.dev`
- MUST store the API worker URL persistently using `chrome.storage.sync`
- MUST validate that API worker URL is not empty before allowing publish operations
- MUST auto-save settings when input changes

**FR-1.4: Curator Keypair**

- MUST generate an Ed25519 keypair on first popup open using the Web Crypto API (`crypto.subtle.generateKey('Ed25519', ...)`)
- MUST store the keypair persistently in `chrome.storage.sync` as `{ pubkey: <hex>, privkeyB64: <pkcs8-base64> }`
- MUST display the curator's public key (64-char hex) in the settings panel
- MUST NOT expose the private key in any UI element
- The keypair is generated once per browser profile and reused for all future publishes

**FR-1.5: Settings Persistence**

- MUST sync settings across all Chrome browsers where user is signed in
- MUST persist settings after browser restart
- MUST load settings within 100ms of popup opening

### FR-2: Current Page Detection

**FR-2.1: URL Display**

- MUST display the current active tab's URL in the popup
- MUST update URL when popup is opened on a different tab
- MUST truncate or wrap long URLs to fit in the popup (320px width)
- MUST show "Loading..." while URL is being fetched

**FR-2.2: Tab Querying**

- MUST query the active tab in the current window
- MUST handle cases where no active tab exists gracefully
- MUST use Chrome Manifest V3 APIs (`chrome.tabs.query`)

### FR-3: Content Extraction

**FR-3.1: Rendered Content Capture**

- MUST capture rendered HTML from the main frame using `chrome.scripting.executeScript` with `allFrames: false`
- MUST also attempt to capture cross-origin iframes using a second `executeScript` call with `allFrames: true`, raced against a 5-second timeout — if the iframe call hangs (e.g. a stuck third-party widget), the crawl proceeds with main-frame content only
- MUST strip scripts (except JSON-LD), styles, noscript, and svg elements before sending
- MUST combine main frame HTML with iframe HTML and truncate combined result to 400,000 characters
- MUST extract page title from `document.title` (main frame only)
- HTML cleaning (removing scripts, styles, etc.) is performed server-side by the crawler-worker

**FR-3.2: Extraction Logging**

- MUST log HTML length to extension console with prefix `[Popup]`

### FR-4: Event Preview Workflow

**FR-4.1: Extraction Request**

- MUST send POST request to `${workerUrl}/crawl` with:
  - Header: `Authorization: Bearer ${apiKey}`
  - Header: `Content-Type: application/json`
  - Body:
    ```json
    {
      "url": "<current-tab-url>",
      "mode": "direct",
      "html": "<extracted-html>",
      "title": "<page-title>"
    }
    ```
- MUST disable the "Crawl This Page" button during request
- MUST change button text to "Extracting..." during request
- MUST show status message: "Extracting events from page..."

**FR-4.2: Extraction Response Handling**

- MUST parse JSON response from crawler-worker
- MUST handle successful response (status 200, `data.success === true`)
- MUST extract `data.events` array from response (`PreparedEvent[]` — unsigned, geocoded)
- MUST handle error response gracefully
- MUST log full response to browser console with prefix `[Tokoro] --- CRAWLER-WORKER RESPONSE ---`
- MUST log full response to extension console with prefix `[Popup] --- CRAWLER-WORKER RESPONSE ---`

**FR-4.3: Event Display**

- MUST display each extracted event in a preview card
- MUST show the following fields for each event:
  - Title (or "Untitled Event" if missing)
  - Start time formatted as human-readable date (or "Date not specified")
  - Venue name (or "Venue not specified")
  - Address (or "Address not specified")
  - Category (or "other")
- MUST format dates using `formatDateRange(start, end)` helper with rules:
  - Date-only string (no `T`, e.g. `"2026-06-10"`) → `DD.MM.YYYY` with no time shown
  - With time → `DD.MM.YYYY HH:MMam/pm` (e.g. `10.06.2026 9pm`)
  - Same calendar day with both times → `DD.MM.YYYY start–end` (e.g. `10.06.2026 9pm–11pm`)
  - Different days, same year → `DD.MM–DD.MM.YYYY`
  - Different years → `DD.MM.YYYY–DD.MM.YYYY`
- MUST handle both Unix timestamp (seconds) and ISO 8601 string formats
- MUST parse date-only strings as local noon (not UTC midnight) to avoid timezone date shift
- MUST return "Date not specified" for missing or unparseable dates

**FR-4.4: Preview Section Display**

- MUST hide preview section by default
- MUST show preview section only when events are extracted
- MUST display event count in status message: "Found N event(s). Review below:"
- MUST show "No events found on this page" if extraction returns empty array AND no events were dropped
- MUST show "N event(s) found but dropped during normalization. Check console for details." if extraction returns empty array but `dropped_events` is non-empty
- MUST enable "Publish Events" button when events are shown
- MUST enable "Cancel" button when events are shown

**FR-4.5: Error Handling**

- MUST display error message if API returns non-200 status
- MUST display error message from `data.message`, `data.error`, or "Unknown error"
- MUST display "Network error: <error-message>" for network failures
- MUST re-enable button after error
- MUST hide preview section on error

### FR-5: Event Caching

**FR-5.1: Cache Storage**

- MUST cache extracted events locally using `chrome.storage.local`
- MUST use cache key format: `cached_events_${url}`
- MUST store both events array and timestamp in cache
- MUST cache events immediately after successful preview extraction
- MUST log cache operations to console with prefix `[Popup]`

**FR-5.2: Cache Loading**

- MUST check for cached events on popup initialization
- MUST load cached events if found for the current URL
- MUST display cached events automatically in preview section
- MUST show status message: "Found N previously extracted event(s). Review and publish, or re-crawl:"
- MUST set `isFromCache` flag to `true` when loading from cache
- MUST change button text to "Re-crawl This Page" when showing cached events

**FR-5.3: Cache Invalidation**

- MUST allow user to re-crawl page to refresh cached events
- MUST update cache with new events after re-crawl
- MUST clear `isFromCache` flag after successful re-crawl
- MUST automatically clear cached events for a URL when that tab navigates or reloads (via `chrome.tabs.onUpdated` with `status === 'loading'`)
- MUST log cache clearing to console with prefix `[Tokoro]`

### FR-6: Event Publishing Workflow

**FR-6.1: Publish Request**

- For each selected `PreparedEvent`, MUST sign the event using the curator's stored Ed25519 keypair and POST directly to the API worker:
  - Build `eventData` canonical object with fields: `{ pubkey, title, description, url, venue_name, address, lat, lng, start_time, end_time, category, tags, created_at }` (using `''` for missing string fields, `[]` for missing tags array)
  - Compute `SHA-256(JSON.stringify(eventData))` → hash
  - Sign hash with Ed25519 private key (pkcs8 format) using `crypto.subtle.sign`
  - POST `{ ...eventData, signature: <hex>, festival_name?, festival_url? }` to `${apiUrl}/events`
  - Header: `Content-Type: application/json`
  - No API key required — the signature authenticates the request
- MUST publish one event per POST request (loop, not batch)
- MUST treat HTTP 409 (duplicate) as success

**FR-6.2: Publish UI State**

- MUST disable "Publish Events" button during request
- MUST disable "Cancel" button during request
- MUST change "Publish Events" button text to "Publishing..." during request
- MUST show status message: "Publishing events..." during request

**FR-6.3: Publish Response Handling**

- MUST count successful publishes (2xx or 409) and failures per event
- MUST log per-event failures to the browser console

**FR-6.4: Publish Success**

- MUST display success message: "Events published successfully!"
- MUST display statistics: `{ urls_processed: 1, events_extracted: N, events_published: M }`
- MUST hide preview section and clear state if at least one event was published
- MUST re-enable buttons

**FR-6.5: Publish Error Handling**

- MUST display partial-failure message: "Published N, failed M. Check console for details."
- MUST re-enable buttons after completion
- MUST reset button text after completion

### FR-7: Preview Cancellation

**FR-7.1: Cancel Action**

- MUST clear `extractedEvents` state when cancel button is clicked
- MUST hide preview section
- MUST show status message: "Preview cancelled"
- MUST clear `pending_page_crawl` from `chrome.storage.local`
- MUST clear `pending_image_extraction` from `chrome.storage.local` if `isFromImage === true`
- MUST allow user to start new preview workflow

### FR-8: Context Menu Integration

**FR-8.1: Context Menu Item**

- MUST create context menu item on extension installation
- MUST use menu item ID: `crawlThisPage`
- MUST use menu item title: "Crawl this page with Tokoro"
- MUST show menu item only in page contexts (not on selections, images, etc.)

**FR-8.2: Context Menu Action**

- MUST retrieve API key and worker URL from storage when clicked
- MUST open popup if settings are missing
- MUST open popup immediately with loading state if settings exist:
  - MUST write `pending_page_crawl: { loading: true, pageUrl, timestamp }` to `chrome.storage.local`
  - MUST call `chrome.action.openPopup()` immediately
  - MUST capture rendered HTML using a two-step approach: main frame first (`allFrames: false`), then iframes with `allFrames: true` raced against a 5-second timeout
  - MUST strip scripts (except JSON-LD), styles, noscript, and svg elements before sending
  - MUST combine main frame HTML with iframe HTML and truncate to 400,000 characters
  - MUST then send crawl request in the background:
    ```json
    {
      "url": "<tab-url>",
      "mode": "direct",
      "html": "<combined-rendered-html>",
      "title": "<page-title>"
    }
    ```
  - On success: MUST update `pending_page_crawl: { loading: false, events, pageUrl, timestamp }`
  - On failure: MUST update `pending_page_crawl: { loading: false, error, pageUrl, timestamp }`

**FR-8.3: Context Menu Feedback**

- Results are displayed in the popup UI (not via notifications)
- The popup detects the `pending_page_crawl` state on open and via `chrome.storage.onChanged` listener
- When `pending_page_crawl` contains `events`, the popup displays them for review before publishing (same preview/confirm flow as the popup button)

### FR-9: Image Extraction (Context Menu)

**FR-9.1: Image Context Menu Items**

- MUST create image context menu item on extension installation
- MUST use menu item ID: `crawlThisImage`
- MUST use menu item title: "Extract event from this image"
- MUST show menu item only in image contexts (right-click on images)
- MUST create element extraction context menu item on extension installation
- MUST use menu item ID: `extractFromElement`
- MUST use menu item title: "Extract event from element"
- MUST show menu item in page, image, and link contexts
- MUST work around div overlays (e.g., Instagram) that prevent image detection

**FR-9.2: Image to Base64 Conversion**

- MUST fetch image using `fetch(imageUrl)` in service worker
- MUST convert response to Blob
- MUST use FileReader API to convert Blob to base64 data URL
- MUST extract base64 data (removing `data:image/xxx;base64,` prefix)
- MUST extract MIME type from Blob (e.g., `image/jpeg`, `image/png`)
- MUST log image fetch and conversion steps to console with prefix `[Tokoro]`

**FR-9.3: Image Extraction Workflow**

- MUST open popup immediately with loading state before starting extraction:
  - MUST write `pending_image_extraction: { loading: true, imageSource, pageUrl, timestamp }` to `chrome.storage.local`
  - MUST call `chrome.action.openPopup()` immediately
- MUST then convert image to base64 and call API in the background
- MUST send POST request to `${workerUrl}/crawl` with:
  - Header: `Authorization: Bearer ${apiKey}`
  - Header: `Content-Type: application/json`
  - Body:
    ```json
    {
      "url": "<image-url>",
      "mode": "image",
      "imageData": "<base64-encoded-image>",
      "imageMimeType": "<mime-type>"
    }
    ```
- The `url` field MUST be the image URL (not the page URL) in this background request
- On success: MUST update `pending_image_extraction` with full extraction data
- On failure: MUST update `pending_image_extraction` with `loading: false, error` field

**FR-9.4: Image Extraction Storage**

- MUST write `pending_image_extraction` to `chrome.storage.local` in two phases:
  - **Phase 1 (loading)**: `{ loading: true, imageSource, pageUrl, timestamp }` — written immediately before opening popup
  - **Phase 2 (complete)**: `{ loading: false, events, imageSource, pageUrl, imageData, imageMimeType, timestamp }` — written after successful extraction
  - **Phase 2 (error)**: `{ loading: false, error, imageSource, pageUrl, timestamp }` — written on failure
- MUST automatically open extension popup (Phase 1) before async processing begins
- MUST NOT use notifications for image extraction feedback (popup handles display)

**FR-9.5: Image Extraction Error Handling**

- MUST write error to `pending_image_extraction.error` on extraction failure
- MUST write error to `pending_image_extraction.error` on network/image load failure
- Popup reads the error and displays it in the UI

**FR-9.6: Element-Based Image Extraction (works around div overlays)**

- MUST inject content script on all pages to capture right-click position
- MUST run content script in MAIN world (not ISOLATED) to share variables with executeScript
- MUST store click position in `window.tokoroExtension.lastContextMenuPosition`
- MUST listen for contextmenu events to store click coordinates
- WHEN `extractFromElement` menu item is clicked:
  - MUST execute script in MAIN world to access stored position
  - MUST search clicked element for img tags
  - MUST search clicked element for CSS background-image
  - MUST walk up DOM tree (max 5 levels) looking for images
  - MUST search sibling elements for images
  - MUST return first found image URL
  - IF no image found: MUST show error notification "No Image Found"
  - IF image found: MUST proceed with normal image extraction workflow
- MUST work on sites with div overlays (e.g., Instagram)
- MUST log image search steps to console with prefix `[Tokoro]`
- MUST use `world: "MAIN"` in both content script registration and executeScript calls

### FR-10: Image Preview in Popup

**FR-10.1: Pending Image Extraction Detection**

- MUST check `chrome.storage.local` for both `pending_image_extraction` and `pending_page_crawl` on popup init
- MUST prioritize `pending_image_extraction` over `pending_page_crawl` and cached page events
- MUST handle the `loading: true` state:
  - MUST display status: "Extracting event data from image..."
  - MUST disable crawl button while loading
  - MUST listen for storage updates via `chrome.storage.onChanged` and apply result when loading completes
- MUST handle stale pending data (older than 2 minutes): clear and fall back to cached page events
- MUST validate pending image data completeness (events array, imageData, imageMimeType) before applying
- MUST clear invalid or incomplete pending image data automatically

**FR-10.2: Image Extraction Display**

- MUST display extracted events from image in preview section
- MUST set `isFromImage = true` flag
- MUST set `imageSource` to original image URL
- MUST set `imagePageUrl` to page URL from `pending.pageUrl` (used as event URL)
- MUST store image data in `window.pendingImageData` for publishing
- MUST show status message: "Found N event(s) from image. Review and publish:"
- MUST change button text to "Extract From Image Again" instead of "Re-crawl This Page"
- MUST log full crawler-worker response to page console with prefix `[Tokoro] --- CRAWLER-WORKER RESPONSE ---`
- MUST log full crawler-worker response to extension console with prefix `[Popup] --- CRAWLER-WORKER RESPONSE ---`
- MUST log extracted events to page console with prefix `[Tokoro] --- EXTRACTED EVENTS ---`
- MUST log extracted events to extension console with prefix `[Popup] --- EXTRACTED EVENTS ---`
- MUST log dropped events as warnings to page console (same format as page crawl)

**FR-10.3: Image Event Publishing**

- WHEN `isFromImage === true`, image events are published using the same FR-6.1 sign+POST flow as page events
- Events extracted from images are already `PreparedEvent[]` with geocoded coordinates
- MUST clear `pending_image_extraction` from storage after successful publish
- MUST clear `window.pendingImageData` after publish
- MUST clear `imagePageUrl` after publish

**FR-10.4: Cancel Image Preview**

- MUST clear `pending_image_extraction` from storage when cancel button is clicked
- MUST clear `window.pendingImageData`
- MUST reset `isFromImage` flag to false
- MUST reset button text to "Crawl This Page"

### FR-11: Background Service Worker

**FR-11.1: Installation Logging**

- MUST log to console when extension is installed: "Tokoro Event Crawler extension installed"

**FR-11.2: Event Listeners**

- MUST register `chrome.runtime.onInstalled` listener
- MUST register `chrome.contextMenus.onClicked` listener
- MUST register `chrome.tabs.onUpdated` listener
- MUST use Manifest V3 service worker pattern

**FR-11.4: Background-to-Popup Communication**

- Background service worker communicates results to the popup via `chrome.storage.local`
- For image crawls: writes to `pending_image_extraction` (two-phase: loading → result/error)
- For page crawls: writes to `pending_page_crawl` (two-phase: loading → result/error)
- Popup registers a `chrome.storage.onChanged` listener to react to updates in real time
- MUST NOT use notifications for feedback on image or page crawl results

**FR-11.3: Cache Clearing on Navigation**

- WHEN `chrome.tabs.onUpdated` fires with `changeInfo.status === 'loading'` AND `tab.url` is present:
  - MUST remove `cached_events_${tab.url}` from `chrome.storage.local`
  - MUST log cleared URL to console with prefix `[Tokoro]`
- This ensures the popup always shows a fresh state after the user navigates to a new page or reloads

## Data Structures

### PreparedEvent (from crawler-worker)

Represents an event returned by the crawler-worker — geocoded, normalised, unsigned. The extension signs these before publishing.

```typescript
interface PreparedEvent {
  title: string;
  description?: string;
  url?: string;
  venue_name?: string;
  address?: string;
  lat: number;              // always present (geocoded)
  lng: number;              // always present (geocoded)
  start_time: string;       // ISO 8601 local time, e.g. "2026-03-15T21:00:00"
  end_time?: string;
  category: string;
  tags?: string[];
  festival_name?: string;
  festival_url?: string;
  created_at: string;       // ISO 8601, set at normalisation time
}
```

### SignedEvent (posted to API worker)

```typescript
interface SignedEvent {
  pubkey: string;           // curator's Ed25519 public key (64-char hex)
  signature: string;        // Ed25519 signature of SHA-256(canonical JSON) (hex)
  title: string;
  description: string;      // '' if absent
  url: string;              // '' if absent
  venue_name: string;       // '' if absent
  address: string;          // '' if absent
  lat: number;
  lng: number;
  start_time: string;
  end_time?: string;
  category: string;
  tags: string[];           // [] if absent
  created_at: string;
  festival_name?: string;   // unsigned metadata, appended after signing
  festival_url?: string;    // unsigned metadata, appended after signing
}
```

### Extracted Content

Represents content extracted from the current page.

```typescript
interface ExtractedContent {
  html: string; // Full rendered HTML from document.documentElement.outerHTML
  title: string; // Page title from document.title
}
```

### Crawler Worker Request (extraction)

```typescript
interface CrawlRequest {
  url: string;          // Current page URL
  mode: 'direct' | 'image';
  html?: string;        // Full rendered HTML; cleaned server-side by crawler-worker
  title?: string;       // Page title
  imageData?: string;   // Base64-encoded image (mode=image)
  imageMimeType?: string;
}
```

### Crawler Worker Response

```typescript
interface CrawlResponse {
  success: boolean;
  message?: string;
  error?: string;
  events?: PreparedEvent[];   // Always present on success
  stats?: {
    urls_processed: number;
    events_extracted: number;
  };
  dropped_events?: Array<{ title: string; reason: string; address?: string; venue_name?: string }>;
}
```

### API Worker Request (publish)

One `SignedEvent` per `POST /events` request. See `SignedEvent` above.

### API Worker Response (publish)

- `201 Created` — event accepted
- `409 Conflict` — duplicate event (treated as success)
- `403 Forbidden` — pubkey not in allowlist or blocklisted

### Cache Entry

```typescript
interface CacheEntry {
  events: ExtractedEvent[]; // Extracted events
  timestamp: number; // Unix timestamp in milliseconds (Date.now())
}
```

### Storage Schema

**Sync Storage** (`chrome.storage.sync`)

```typescript
{
  apiKey: string;     // User's API key for crawler-worker authentication
  workerUrl: string;  // Base URL for crawler-worker API (extraction)
  apiUrl: string;     // Base URL for API worker (publishing)
  pubkey: string;     // Curator's Ed25519 public key (64-char hex)
  privkeyB64: string; // Curator's Ed25519 private key (pkcs8, base64-encoded)
}
```

**Local Storage** (`chrome.storage.local`)

```typescript
{
  [`cached_events_${url}`]: CacheEntry;  // Cached PreparedEvents for specific URL
  pending_image_extraction?: {           // Pending image extraction (two-phase)
    loading: boolean;                    // true while background processing is in progress
    events?: PreparedEvent[];            // Extracted events (set when loading: false)
    imageSource: string;                 // Original image URL
    pageUrl: string;                     // Page URL where the image was found
    imageData?: string;                  // Base64-encoded image data (set when loading: false)
    imageMimeType?: string;              // MIME type (set when loading: false)
    error?: string;                      // Error message (set on failure)
    timestamp: number;                   // Unix timestamp in milliseconds
  };
  pending_page_crawl?: {                 // Pending context-menu page crawl (two-phase)
    loading: boolean;                    // true while background crawl is in progress
    events?: PreparedEvent[];            // Extracted events (set on success)
    error?: string;                      // set on failure
    pageUrl: string;                     // URL being crawled
    timestamp: number;                   // Unix timestamp in milliseconds
  };
}
```

## Non-Functional Requirements

### NFR-1: Performance

- MUST extract page content within 500ms
- MUST render popup within 100ms of opening
- MUST load settings from storage within 100ms
- MUST complete API requests within 30 seconds (timeout)
- MUST handle pages with >1MB of HTML content

### NFR-2: Usability

- MUST fit popup in 320px width
- MUST make all text readable (minimum 11px font size)
- MUST provide clear status messages for all operations
- MUST disable buttons during long-running operations
- MUST show loading indicators for async operations

### NFR-3: Reliability

- MUST handle network failures gracefully
- MUST handle malformed API responses gracefully
- MUST handle pages without event data gracefully
- MUST recover from content extraction errors
- MUST not crash when extension storage is full
- MUST not alter the visible page during content extraction

### NFR-4: Security

- MUST store API key using Chrome's encrypted storage (`chrome.storage.sync`)
- MUST only send data to configured worker URL
- MUST only access current tab when user initiates action
- MUST validate all user inputs
- MUST use HTTPS for all API requests
- MUST mask API key in UI (password field)

### NFR-5: Compatibility

- MUST work with Chrome Manifest V3
- MUST work on Chrome version 88+
- MUST work on Chromium-based browsers (Edge, Brave, Opera)
- MUST handle pages with complex DOM structures
- MUST handle pages with JavaScript-rendered content

### NFR-6: Logging

- MUST log all API requests and responses to browser console
- MUST prefix browser console logs with `[Tokoro]`
- MUST prefix extension console logs with `[Popup]`
- MUST log content extraction length
- MUST log cache operations
- MUST log errors with stack traces

## Edge Cases and Error Scenarios

### EC-1: Empty or Missing Settings

- WHEN user has not configured API key
- THEN show error: "Please enter your API key"
- AND do not proceed with crawl operation

### EC-2: Invalid Page Content

- WHEN page has no extractable content (empty body)
- THEN send empty `html` string
- AND let crawler-worker handle the error

### EC-3: Malformed API Response

- WHEN API returns non-JSON response
- THEN catch JSON parse error
- AND show error: "Network error: Unexpected token..."

### EC-4: API Timeout

- WHEN API request takes >30 seconds
- THEN abort request
- AND show error: "Network error: timeout"

### EC-5: No Events Extracted

- WHEN API returns empty events array AND no `dropped_events`
- THEN show message: "No events found on this page"
- AND hide preview section
- WHEN API returns empty events array AND `dropped_events` is non-empty
- THEN show message: "N event(s) found but dropped during normalization. Check console for details."
- AND log each dropped event to the page console with its reason

### EC-6: Page with No Active Tab

- WHEN `chrome.tabs.query` returns empty array
- THEN show error: "No active tab found"
- AND disable crawl button

### EC-7: Content Extraction Failure

- WHEN `chrome.scripting.executeScript` throws error
- THEN catch error
- AND show error: "Failed to extract page content"

### EC-8: Storage Quota Exceeded

- WHEN `chrome.storage.local.set` fails with quota error
- THEN log warning to console
- AND continue without caching (non-critical failure)

### EC-9: Invalid Date Formats

- WHEN event has unparseable `start_time`
- THEN show "Invalid date" in preview
- AND still allow publishing (let API validate)

### EC-10: Mixed Cached and Fresh Events

- WHEN user loads cached events, then re-crawls
- THEN replace cached events with fresh events
- AND update cache with new events
- AND set `isFromCache = false`

### EC-11: Multiple Rapid Button Clicks

- WHEN user clicks "Crawl This Page" multiple times rapidly
- THEN ignore subsequent clicks while first request is pending
- AND keep button disabled until request completes

### EC-12: Page URL Changes During Crawl

- WHEN user navigates to different page while crawl is in progress
- THEN complete the in-progress request
- AND do not show results (URL mismatch)
- AND log warning to console

## Test Requirements

### Unit Tests

**UT-1: Content Extraction**

- MUST test HTML extraction returns full `outerHTML`
- MUST test cleaning removes scripts, styles, images
- MUST test cleaning removes empty elements
- MUST test fallback to original content on error
- MUST test title extraction priority order

**UT-2: Date Formatting**

- MUST test formatting ISO 8601 strings
- MUST test formatting Unix timestamps (seconds)
- MUST test handling invalid dates
- MUST test handling missing dates
- MUST test locale-specific formatting

**UT-3: Cache Operations**

- MUST test saving events to cache
- MUST test loading events from cache
- MUST test cache key generation
- MUST test cache with multiple URLs
- MUST test cache overwrite

**UT-4: Settings Management**

- MUST test saving API key
- MUST test saving worker URL
- MUST test loading saved settings
- MUST test handling missing settings
- MUST test auto-save on input change

### Integration Tests

**IT-1: Preview Workflow**

- MUST test complete preview flow from button click to event display
- MUST test preview with valid API response
- MUST test preview with empty events array
- MUST test preview with API error
- MUST test preview with network error

**IT-2: Publish Workflow**

- MUST test publish sends `events` array directly (no re-extraction)
- MUST test publish success
- MUST test publish error
- MUST test publish network error
- MUST test dropped events are logged to page console on publish

**IT-3: Cache Integration**

- MUST test loading cached events on popup open
- MUST test re-crawl updates cache
- MUST test cache is cleared on tab navigation/reload

**IT-4: Context Menu**

- MUST test context menu creation on install
- MUST test context menu click triggers crawl
- MUST test notification on success
- MUST test notification on error

### End-to-End Tests

**E2E-1: First-Time User Flow**

1. Install extension
2. Open popup
3. Enter API key and worker URL
4. Navigate to event page
5. Click "Crawl This Page"
6. Verify events appear in preview
7. Click "Publish Events"
8. Verify success message with stats

**E2E-2: Cached Events Flow**

1. Open popup on previously crawled page
2. Verify cached events are displayed
3. Click "Publish Events"
4. Verify publish request uses cached events
5. Verify success message

**E2E-3: Re-crawl Flow**

1. Open popup on previously crawled page
2. Verify cached events are displayed
3. Click "Re-crawl This Page"
4. Verify fresh events replace cached events
5. Verify cache is updated

**E2E-4: Error Recovery Flow**

1. Enter invalid API key
2. Click "Crawl This Page"
3. Verify error message
4. Enter valid API key
5. Click "Crawl This Page"
6. Verify success

**E2E-5: Cancel Preview Flow**

1. Extract events
2. View preview
3. Click "Cancel"
4. Verify preview section hidden
5. Verify can start new preview

## Implementation Notes

### Chrome Manifest V3 Migration

The extension MUST use Manifest V3 APIs:

- Use `chrome.scripting.executeScript` instead of `chrome.tabs.executeScript`
- Use service worker for background script (not persistent page)
- Use `action` instead of `browser_action`
- Declare `host_permissions` separately from `permissions`

### Content Script Execution Context

The content script MUST run in the MAIN world (not ISOLATED) for the element-based extraction feature:

- **MAIN world**: Shares JavaScript context with the web page. Required so `chrome.scripting.executeScript` can access variables set by the content script.
- **ISOLATED world**: Default for content scripts. Isolated from page scripts for security, but cannot share variables with executeScript.
- The content script stores click position in `window.tokoroExtension` to share with executeScript.
- Both the content script and executeScript MUST specify `world: "MAIN"` to access shared variables.
- **Trade-off**: Running in MAIN world means the content script can be affected by page scripts, but it's needed for this feature to work.

### Content Security Policy

The extension MUST NOT:

- Evaluate arbitrary strings as code (`eval`, `new Function`)
- Load remote scripts
- Use inline scripts in HTML

### Performance Optimization

- SHOULD debounce rapid button clicks
- SHOULD abort in-flight requests when popup is closed
- SHOULD limit cache size (e.g., max 100 entries)
- SHOULD prune old cache entries (e.g., >7 days old)

### Future Enhancements

These are explicitly OUT OF SCOPE for this specification but may be considered later:

- Edit extracted events before publishing
- Save draft events locally
- Batch crawl multiple tabs
- Keyboard shortcuts
- Custom LLM provider selection
- "Discover" mode for finding multiple event pages
- Crawl history and logs

## Appendix: API Contract

This extension depends on two APIs:

**Crawler Worker — POST /crawl** (extraction only)

- Accepts `html`, `title` for direct content extraction (HTML cleaned server-side)
- Accepts `imageData`, `imageMimeType` for image extraction
- Always returns `events: PreparedEvent[]` (unsigned, geocoded)
- See `crawler-worker/SPECS.md` for full contract

**API Worker — POST /events** (publish)

- Accepts one `SignedEvent` per request
- Returns 201 Created, 409 Conflict (duplicate), or 403 Forbidden (not allowlisted)
- See `worker/SPECS.md` for full contract

## Appendix: Chrome Extension Permissions

### Required Permissions

- **activeTab**: Access URL and DOM of current tab when user clicks extension icon
- **scripting**: Execute content extraction script in page context
- **storage**: Persist API key, worker URL, and cached events
- **contextMenus**: Add right-click menu item
- **notifications**: Show notification after context menu crawl

### Host Permissions

- `https://tokoro-crawler-worker.YOUR_SUBDOMAIN.workers.dev/*`: Allow requests to default crawler-worker
- SHOULD support wildcard for custom worker URLs (requires dynamic permissions)

## Appendix: File Structure

```
chrome-extension/
├── manifest.json       # Extension configuration (Manifest V3)
├── popup.html          # Popup UI (320px width)
├── popup.js            # Main logic (content extraction, API calls, preview)
├── background.js       # Service worker (context menu, notifications, image extraction)
├── content-script.js   # Content script (captures right-click position, finds images under overlays)
├── icon16.png          # Extension icon (16x16)
├── icon48.png          # Extension icon (48x48)
├── icon128.png         # Extension icon (128x128)
├── README.md           # User-facing documentation
└── SPECS.md            # This specification document
```

## Version History

- **1.8.0** (2026-04-10): Curator keypair + direct publish
  - Extension generates its own Ed25519 keypair on first use (Web Crypto API, stored in `chrome.storage.sync`)
  - Events are signed locally by the curator and POSTed directly to the API worker (no longer published via crawler-worker)
  - Added `apiUrl` setting (API worker URL) and pubkey display in settings panel
  - Added `minimum_chrome_version: "111"` (Web Crypto Ed25519 requirement)
  - Removed `preview` mode, `preview_token`, and `events`-array publish flow
- **1.7.1** (2026-04-02): Fix indefinite hang on pages with stuck iframes
  - Main frame and iframe extraction are now separated: main frame uses `allFrames: false` (always fast), iframes use `allFrames: true` raced against a 5-second timeout
  - A stuck third-party widget (e.g. Bandcamp player, social media embed) can no longer hang the entire extraction
- **1.7.0** (2026-03-27): Preview confirmation for context menu crawls; iframe capture for popup button
  - Context menu "Crawl this page" now shows events for confirmation before publishing (same flow as popup button)
  - Popup button "Crawl This Page" now captures cross-origin iframes via `allFrames: true` (same as context menu)
- **1.6.0** (2026-03-27): Capture cross-origin iframe content in context menu crawls
  - Context menu "Crawl this page" now collects rendered HTML from all frames (including cross-origin iframes such as Laylo, Bandsintown widgets) via `chrome.scripting.executeScript` with `allFrames: true`
  - Combined HTML is sent as the `html` field to the crawler-worker, enabling event extraction from third-party embedded widgets
- **1.5.0** (2026-03-17): Open popup immediately with loading state for context menu crawls
  - Context menu "Crawl this page" now opens popup immediately, then crawls in background; result shown in popup via `pending_page_crawl` storage key
  - Context menu image extraction now opens popup immediately with loading state; result shown via `pending_image_extraction` storage key with `loading` field
  - Popup listens to `chrome.storage.onChanged` for live updates from background
  - Removed notifications for page and image crawl results; popup is the sole feedback surface
- **1.4.1** (2026-03-13): Fix event URL for image-crawled events
  - When crawling an image, the event `url` is now set to the page URL where the image was found, not the image URL itself
  - `pageUrl` (tab.url) is now stored in `pending_image_extraction` and used as the event source URL
- **1.4.0** (2026-03-12): Image preview debug logging and bug fixes
  - Image preview now logs full crawler-worker response and extracted events to both popup and page consoles (same as page crawl)
  - Image preview now logs dropped events as warnings to page console
  - Fixed bug: "Extract From Image Again" was re-crawling the page instead of the image
  - Fixed error when publishing events from images
- **1.3.0** (2026-03-10): Improved publish flow and normalization error reporting
  - Publish Events now sends already-extracted events directly (no re-crawl)
  - Unified publish flow: `events` array is always sent regardless of source (cache, fresh, image)
  - UI shows informative message when events are dropped during normalization
  - Dropped events are logged to the page console on both preview and publish
  - Background service worker automatically clears event cache when tab navigates or reloads
- **1.2.0** (2026-03-06): Added element-based extraction to work around div overlays
  - New context menu item "Extract event from element"
  - Content script to capture right-click position
  - Smart image detection that works through div overlays (e.g., Instagram)
  - Walks DOM tree to find images even when hidden by overlays
  - Supports both img tags and CSS background-image
- **1.1.0** (2026-03-06): Added image extraction support
  - Image context menu ("Extract event from this image")
  - Image to base64 conversion in service worker
  - Preview-before-publish workflow for image-extracted events
  - Pending image extraction storage
  - Image mode publishing with base64 data
- **1.0.0**: Initial specification based on existing implementation
  - Web page crawling with preview
  - Event caching
  - Settings management
  - Context menu for pages
