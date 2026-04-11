# Tokoro Event Crawler - Chrome Extension

A Chrome extension that lets you crawl the current page for events and publish them to Tokoro using the crawler-worker service.

## Features

- **One-Click Crawling**: Click the extension icon to crawl the current page
- **Preview Before Publishing**: See extracted events before confirming publication
- **Hybrid Content Extraction**: Sends both HTML (for JSON-LD) and cleaned text (for LLM)
- **Direct Mode**: Extracts events directly from the current page URL
- **Settings Storage**: API key and worker URL are saved automatically
- **Real-time Status**: See crawl progress and results in the popup

## Installation

### Development Mode (Local Testing)

1. **Open Chrome Extensions Page**:
   - Navigate to `chrome://extensions/`
   - Or click Menu → More Tools → Extensions

2. **Enable Developer Mode**:
   - Toggle the "Developer mode" switch in the top right

3. **Load the Extension**:
   - Click "Load unpacked"
   - Select the `chrome-extension` directory from this repository
   - The extension should now appear in your toolbar

### Production (Chrome Web Store)

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/happenings-event-crawler/lhfbgfaljjaaipfbdlfffbjfajenaphn).

## Setup

1. **Click the Extension Icon** in your Chrome toolbar, then open **Settings**

2. **Enter Your API Key**:
   - Get your API key from the crawler-worker administrator

3. **Configure Crawler Worker URL**:
   - Set to `https://happenings-crawler-worker.YOUR_SUBDOMAIN.workers.dev`

4. **Configure API Worker URL**:
   - Set to `https://happenings-worker.YOUR_SUBDOMAIN.workers.dev`
   - Events are signed locally and published directly to this URL

5. **Share your Public Key**:
   - A keypair is generated automatically on first use and stored in `chrome.storage.sync`
   - Your public key is shown in the Settings panel — share it with the admin to be added to the `ALLOWED_PUBKEYS` allowlist before you can publish events

6. **Settings Auto-Save**: Your configuration is automatically saved

> **Requires Chrome 111+** (Web Crypto API Ed25519 support)

## Usage

### Method 1: Extension Popup

1. Navigate to a page with event information
2. Click the Tokoro extension icon in your toolbar
3. Review the current page URL
4. Click "Crawl This Page"
5. Wait for the crawl to complete (10-30 seconds)
6. View the results (URLs processed, events extracted)
7. Publish events to DB or cancel

### Method 2: Right-Click Context Menu

1. Navigate to a page with event information
2. Right-click anywhere on the page
3. Select "Crawl this page with Tokoro"
4. A notification will show the crawl result

## How Event Extraction Works

The Chrome extension provides **higher-quality event extraction** than standard API crawling by sending pre-rendered, cleaned content to the crawler-worker.

### Two-Step Workflow

#### Step 1: Extract Events

1. **Extract Rendered Content** from the current tab:
   - **Full HTML**: `document.documentElement.outerHTML` (for JSON-LD structured data)
   - **Clean Text**: cleaned page content (no scripts, images, ...)(for LLM extraction)
   - **Page Title**: `document.title`

2. **Send to Crawler Worker**:

   ```javascript
   POST /crawl
   {
     "url": "https://example.com/event",
     "mode": "direct",
     "html": "<html>...</html>",        // Full rendered HTML
     "title": "Event Title"
   }
   ```

3. **Display Extracted Events** in the popup:
   - Show title, date, venue, address, category
   - User can review before publishing

#### Step 2: Sign and Publish Events

1. **Sign each event** locally using the curator's Ed25519 private key (Web Crypto API)
2. **POST each signed event** directly to the API worker (`POST /events`)
3. **Show confirmation** with stats

### Why This Works Better Than Direct Crawling

**Problem with Jina AI Reader (used for standard API calls):**

- Fetches static HTML over HTTP
- Misses dynamically rendered content (JavaScript-loaded events)
- May not capture all structured data

**Chrome Extension Advantage (bypasses Jina AI entirely):**

- **No external fetching**: Provides content directly to the crawler-worker
- Accesses the **rendered DOM** after all JavaScript executes
- Captures JSON-LD that was injected by client-side scripts
- More accurate and faster than external fetching

### What Gets Extracted

The crawler-worker uses a **two-stage hybrid extraction** process:

#### Stage 1: JSON-LD Extraction

Searches the HTML for Schema.org structured data:

```html
<script type="application/ld+json">
  {
    "@type": "Event",
    "name": "Jazz Night",
    "startDate": "2026-03-15T21:00:00",
    "location": { "name": "Blue Note", "address": "Via Borsieri 37, Milano" }
  }
</script>
```

If JSON-LD is complete (has title, date, location, category), **skips LLM entirely** ✅

#### Stage 2: LLM Extraction (Fallback)

If JSON-LD is missing or incomplete:

- Analyzes the clean text content
- Extracts event details using AI (OpenAI/Anthropic)
- Infers missing dates (e.g., "April 20" → "April 20, 2026")
- Validates addresses (requires full street addresses, not just venue names)

#### Stage 3: Merge

If both sources provide data:

- **JSON-LD wins** for structured fields (dates, coordinates, addresses)
- **LLM wins** for classification (category, tags)

## Example Workflow

### Scenario 1: Event Page with JSON-LD

```
1. Visit https://alcatrazmilano.it/eventi/some-event/
2. Click the extension icon
3. Click "Crawl This Page"
4. Extension sends rendered HTML to Crawler Worker
5. Crawler extracts from JSON-LD (skips LLM) ✅
6. Popup shows: "Jazz Night at Alcatraz, March 21, 2026"
7. Click "Publish Events"
8. Extension signs the event locally and POSTs to API worker
9. Success: "1 event published"
```

### Scenario 2: Event Page without JSON-LD

```
1. Visit a simple event page (no structured data)
2. Click the extension icon
3. Click "Crawl This Page"
4. Extension sends rendered HTML to Crawler Worker
5. Crawler uses LLM to extract event details
6. Popup shows extracted event
7. Click "Publish Events"
8. Extension signs the event locally and POSTs to API worker
9. Success: "1 event published"
```

## Permissions

### `activeTab`

The extension accesses the active tab only when the user explicitly opens the popup. `activeTab` is used to read the current page URL (shown in the UI and sent to the crawler service) and to obtain the tab ID needed for injecting a script that extracts the page's rendered HTML. No tab data is accessed passively or in the background.

### `scripting`

The extension's primary function is to extract event data from web pages. To capture the fully rendered page content (including dynamically loaded content), the extension injects a script that reads `document.documentElement.outerHTML` and sends it to the user's configured crawler service. A second use is to locate images under right-click coordinates on pages where images are overlaid by DOM elements (e.g. Instagram), by executing a DOM traversal script at the user's explicit right-click position. Both uses are triggered by direct user action only.

### `storage`

The extension stores user configuration (API key and crawler service URL) in `chrome.storage.sync` so settings persist across browser sessions and devices. `chrome.storage.local` is used to cache extracted events for the current page URL (avoids redundant API calls) and to pass image extraction results from the background service worker to the popup UI. No browsing history or personal data is stored.

### `contextMenus`

Context menus are a core interaction pattern of this extension. Users can right-click any web page or image to trigger event extraction without opening the popup. Three menu items are registered: one for full-page crawling, one for images detected by Chrome's native image context, and one that works on any element to handle sites where images are hidden behind DOM overlays (e.g. Instagram, Facebook). All actions are user-initiated.

### `notifications`

When the user triggers event extraction from the right-click context menu, processing occurs in the background service worker while the popup is closed. Desktop notifications are the only mechanism to communicate the result (success with event counts, or failure with an error message) back to the user. Notifications are only shown in response to direct user-initiated context menu actions.

### `host_permissions`: `https://happenings-crawler-worker.YOUR_SUBDOMAIN.workers.dev/*`

The extension sends extracted page HTML and image data to the user's crawler service for LLM-based event extraction. The default service endpoint is `https://happenings-crawler-worker.YOUR_SUBDOMAIN.workers.dev`. This specific host permission is required by Chrome's MV3 fetch restrictions for cross-origin requests made from extension service workers and popups. Only this single domain is requested — no broad host access (`<all_urls>` or wildcards) is used.

### Content script on all URLs

The extension injects a minimal content script (< 25 lines) on all pages to record the cursor position at right-click time. This data (a single `{x, y}` coordinate) is read by the background service worker when the user selects "Extract event from element" from the context menu, to identify which image element is under the cursor on sites where images are covered by DOM overlays (e.g. Instagram, Facebook). The script runs at `document_start` in the MAIN world (required for position sharing with `executeScript` calls). No page content is read or transmitted by the content script itself.

## Troubleshooting

### "Please enter your API key"

- Open the extension popup and enter your API key in the settings

### "Network error"

- Check your internet connection
- Verify the worker URL is correct
- Ensure the crawler-worker is deployed and accessible

### "Invalid API key"

- Verify your API key is correct
- Contact the administrator to get a valid key

### No events extracted

- The page may not contain event information in a recognizable format
- If events were extracted but dropped during geocoding/normalization, the popup will show "N event(s) found but dropped during normalization. Check console for details." — open the page DevTools console to see the specific drop reasons (missing address, geocoding failure, etc.)
- Check if the page has:
  - Event dates mentioned in the text
  - Venue/address information
  - Schema.org JSON-LD markup
- The LLM may not have enough context to extract an event
- Try clicking "Crawl This Page" again (sometimes dynamic content loads slowly)

## Development

### File Structure

```
chrome-extension/
├── manifest.json       # Extension configuration
├── popup.html          # Popup UI (preview + publish)
├── popup.js            # Main logic: content extraction, API calls, preview rendering
├── background.js       # Service worker (context menu, notifications)
├── icon*.png          # Extension icons
└── README.md          # This file
```

### Key Implementation Details

**Content Extraction (`popup.js:extractRenderedContent`)**:

1. Executes script in page context:
   - Captures `document.documentElement.outerHTML` (full HTML with JSON-LD)
   - Runs cleaning on cloned document
   - Returns both HTML and cleaned text
2. Sends both to crawler-worker for hybrid extraction

**Extract Flow (`popup.js:previewEvents`)**:

- Calls `/crawl` with rendered HTML
- Receives extracted `PreparedEvent[]` (unsigned, geocoded)
- Renders events in the popup UI
- Enables "Publish Events" button

**Publish Flow (`popup.js:publishEvents`)**:

- Signs each event locally using the curator Ed25519 keypair (Web Crypto API)
- POSTs each signed event directly to the API worker (`POST /events`)
- Shows success stats; logs any events dropped during normalization to the page console

### Testing Changes

1. Make your code changes
2. Go to `chrome://extensions/`
3. Click the refresh icon on the extension card
4. Test the updated extension

### Building for Production

1. Update version in `manifest.json`
2. Create a zip file of the extension directory:
   ```bash
   cd chrome-extension
   zip -r happenings-crawler-extension.zip . -x "*.DS_Store" -x "README.md"
   ```
3. Upload to Chrome Web Store

## Security

- **API Key Storage**: Stored securely using Chrome's `chrome.storage.sync` API
- **HTTPS Only**: All API requests use HTTPS
- **Minimal Permissions**: Only requests necessary permissions
- **No External Scripts**: All code is bundled in the extension

## Privacy

- The extension only accesses the current tab's URL when you click the crawl button
- No browsing data is collected or transmitted except the URL you explicitly crawl
- Settings are synced to your Chrome account (encrypted by Google)

## Future Enhancements

- [ ] Add "discover" mode option to find multiple event pages from a listing
- [x] ~~Show extracted events in the popup before publishing~~ (✅ Implemented)
- [ ] Add keyboard shortcut for quick crawling
- [ ] Support batch crawling multiple tabs
- [ ] Add crawl history and logs
- [ ] Custom LLM provider selection
- [ ] Edit extracted events before publishing
- [ ] Save draft events locally

## Support

For issues or questions:

- Check the crawler-worker logs for detailed error messages
- Review the browser console for client-side errors (DevTools → Console)
- Verify the crawler-worker is running and accessible

## License

ISC
