# Public Web — Specification

A static single-page application for querying and browsing Tokoro events. No build step; deployed directly to Cloudflare Pages.

---

## FR-1: Event Query

**FR-1.1: Location Input**

- MUST accept a free-text address or raw lat/lng coordinates
- MUST geocode addresses via OpenStreetMap Nominatim API
- MUST fall back to manual lat/lng entry if geocoding fails

**FR-1.2: Query Parameters**

- MUST support filtering by: radius (km), category, time range (from/to)
- MUST default to a configurable location and 100 km radius
- MUST provide preset time-range shortcuts (today, next 7 days, next 30 days, etc.)

**FR-1.3: Results**

- MUST display up to 100 events returned by the API
- MUST show: title, date/time range, venue name, category, tags, URL

---

## FR-2: Date/Time Formatting (`fmtRange`)

All date display uses a shared `fmtRange(start, end)` helper.

**FR-2.1: Input formats**

- MUST handle ISO 8601 strings with time (e.g. `"2026-03-13T23:00:00"`)
- MUST handle ISO 8601 date-only strings (e.g. `"2026-06-10"`, no `T` component)
- MUST handle Unix timestamps in seconds (number)
- MUST return `"Date not specified"` when start is missing or unparseable
- MUST parse date-only strings as local noon (not UTC midnight) to avoid timezone date shift

**FR-2.2: Display rules**

- Date-only start (no `T`), no end → `DD.MM.YYYY` (no time shown)
- Date-only start (no `T`), same calendar day end → `DD.MM.YYYY` (no time shown)
- Start with time, no end → `DD.MM.YYYY HH:MMam/pm`
- Start with time, same calendar day, end with time → `DD.MM.YYYY start–end` (e.g. `13.03.2026 9pm–11pm`)
- Overnight event (end is next calendar day AND end hour < 12:00 AND duration < 24 h) → `DD.MM.YYYY start–end` (same as same-day; e.g. `13.03.2026 11pm–1am`)
- Different days, same year → `DD.MM–DD.MM.YYYY`
- Different years → `DD.MM.YYYY–DD.MM.YYYY`

**Rationale for overnight rule:** concerts and late-night events that end before 6 am are conventionally understood as belonging to the evening they started, not a two-day span.

---

## FR-3: Repeating Event Grouping

Events with the same `title` and `venue_name` are grouped client-side before rendering to surface repeating events (e.g. cinema screenings) as a single card with multiple showtimes.

**FR-3.1: Grouping key**

- MUST normalize key as `lowercase(trim(title)) + "|" + lowercase(trim(venue_name ?? ""))`
- MUST only form a group when ≥2 events share the same key
- MUST leave single events unaffected

**FR-3.2: Group card rendering**

- MUST display title, venue name, category, and tags once (from the earliest instance by `start_time`)
- MUST display each instance's date/time formatted via `fmtRange`, sorted ascending by `start_time`
- MUST render each showtime as `<a href="url">` when the instance has a URL, otherwise plain text
- MUST apply all `fmtRange` rules (including overnight rule) to each showtime

**FR-3.3: Magazine column layout**

- MUST count grouped cards (not raw events) when determining column distribution
- A film with 10 screenings counts as 1 card for column-sizing purposes

---

## FR-4: Festival Grouping

Events sharing the same `festival_url` (≥3 events) are grouped into a festival card rendered separately above regular results.

**FR-4.1: Grouping**

- MUST group events with the same non-empty `festival_url` when ≥3 such events exist
- MUST sort festival items by earliest event `start_time`
- MUST exclude festival-grouped events from the regular results list

**FR-4.2: Festival card rendering**

- MUST display festival name, date range (first–last event), venue(s), and event count
- MUST render sub-event rows in an expandable panel (collapsed by default)
- Each sub-event row MUST show: title, date/time range, venue (if present), description snippet, and link arrow (if URL present)
- Description snippet MUST be truncated to 120 characters with `…` when longer; omitted when empty

---

## FR-5: Publisher UI (`publish.html`)

`publish.html` is a standalone publisher page that supports multiple input modes: manual URL/image extraction, bookmarklet relay (via `window.opener` + `postMessage`), and iOS Shortcut handoff (via URL parameters). On startup it checks for active modes in priority order and falls through to manual input if none match (see FR-5.6).

**FR-5.1: Review UI**

- After extraction, MUST show a review UI listing extracted events with: title, date/time range (`fmtRange`), venue name, address, category
- Each event card MUST include an editable URL field pre-filled with the event URL, or a Google search URL constructed from title + venue + date when no URL is available
- MUST show "Publish All" and "Cancel" action buttons below the event list

**FR-5.2: Publish**

- MUST generate an Ed25519 keypair on first use (Web Crypto API) and store it in `localStorage` under `tokoro_keypair` (`{ pubkey, privkeyB64 }`)
- For each event, MUST sign the `PreparedEvent` using the stored private key
- MUST POST each signed event to the API Worker URL stored in `localStorage` under `tokoro_api_url`
- MUST treat HTTP 409 (duplicate) as success
- MUST show success/error feedback
- MUST switch to the result screen after a fully successful publish

**FR-5.3: Settings form**

- MUST show a settings form at the top of the page with five fields: API Key (password), Crawler Worker URL, API Worker URL, Private Key (editable), Public Key (read-only, derived)
- MUST collapse the form behind a "⚙ Settings" link when API Key, Crawler Worker URL, and API Worker URL are all set; MUST expand when any is missing
- MUST show a "Save" button; the button MUST be hidden when all three required settings are filled and visible when any is missing
- MUST persist API Key, Crawler Worker URL, and API Worker URL to `localStorage` (`tokoro_api_key`, `tokoro_worker_url`, `tokoro_api_url`) when the Save button is clicked
- When the private key field is edited and loses focus, MUST import the PKCS8 key, derive the public key via JWK export, update the public key display, and persist both as `tokoro_keypair` in localStorage

**FR-5.4: Keypair handling**

- When a new keypair is generated (first use or after reset), MUST expand the settings form so the Public Key field is visible, allowing the user to copy it
- MUST populate the Private Key and Public Key fields from the stored keypair on every open

**FR-5.5: Bookmarklet**

- The bookmarklet MUST preprocess page HTML before sending: clone the DOM; strip `script` elements (except `type="application/ld+json"`), `style`, `noscript`, `svg`, and empty elements (no text content and no images); truncate the resulting HTML to 400 000 characters
- The bookmarklet MUST open a popup at `RELAY_URL + '?relay=1'`, then wait up to 20 seconds for a `{ type: 'ready' }` message from that popup before sending page data
- The bookmarklet MUST send `{ type: 'crawl_data', url, html, title }` to the popup via `postMessage`
- The bookmarklet MUST NOT write to `localStorage` or show any UI on the visited page
- The `ready` message MUST contain only `{ type: 'ready' }` — no settings are passed back to the bookmarklet
- The `crawl_data` message MUST contain only `{ type, url, html, title }` — no credentials
- `publish.html` detects relay mode by checking `window.opener`; the `?relay=1` parameter in the popup URL is vestigial and not parsed

**FR-5.6: Startup mode detection**

`publish.html` checks modes in the following priority order on load; the first match wins:

1. **`#events=` hash** — base64-encoded JSON array of already-extracted events; decode and go straight to the review UI
2. **`?crawl=` query param** — URL-safe base64 payload from iOS Shortcut; decode, clear param via `history.replaceState`, hide input UI, ensure keypair exists, then call `runCrawl({url, html, title, mode: 'direct'}, null)`
3. **`#crawl=` hash** — legacy URL-safe base64 payload (same format as `?crawl=`); same handling as above; kept for backward compatibility with older Shortcuts
4. **`window.opener` present** — bookmarklet relay mode: hide input UI, signal `{ type: 'ready' }` to opener after ensuring keypair, then handle incoming `crawl_data` messages
5. **Default** — manual input mode (FR-5.7)

**FR-5.7: Apple Shortcut handoff**

- Apple Shortcuts cannot use `window.open` + `postMessage` (the action runs in an isolated context with no opener) and the "Run JavaScript on Webpage" action has a tight execution budget that the LLM crawl exceeds
- The Shortcut script (`shortcut-bookmarklet.src.js`) MUST call `completion(RELAY_URL + '?crawl=' + base64(JSON({url, title, html})))` — no fetch to the crawler from inside the Shortcut
- The `html` field MUST contain only: (a) `<script type="application/ld+json">` tags verbatim (for server-side structured-data extraction) concatenated with (b) up to 15 000 chars of `document.body.innerText` (for LLM extraction). Sending the full serialised DOM is wasteful because the server strips all tags to plain text anyway, and produces URLs that exceed iOS inter-app URL limits (~70 KB vs ~25 KB worst-case with this approach)
- The base64 payload MUST use URL-safe encoding: `btoa(unescape(encodeURIComponent(json))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')` — using `?crawl=` as a query parameter (iOS strips URL fragments between apps; query params are always preserved)
- The Shortcut script MUST NOT contain any API key

**FR-5.8: Manual input modes**

When opened without an opener or matching URL/hash params, `publish.html` shows a two-tab input UI:

- **URL tab** — user enters a page URL and clicks "Extract Events"; sends `{ url, mode: 'direct' }` to the crawler worker
- **Image tab** — user uploads an image file and optionally enters a source URL; sends `{ mode: 'image', imageData, imageMimeType, url? }` to the crawler worker with the image encoded as base64

---

## NFR

- No build step — plain HTML + inline JS/CSS
- No external JS dependencies
- MUST work when opened directly as a local file (for development)

---

## FR-6: Map View (`map.html`)

A full-viewport map-first page for discovering events spatially.

**FR-6.1: Control Strip**

- MUST provide: location input (geocoded via Nominatim), radius (km), time range preset (Today / Next 7 days / Next 30 days / Next 3 months / Custom), category dropdown, Search button, Search here button
- Custom time range MUST reveal from/to `datetime-local` inputs
- MUST load `shared.js` for `fmtRange`, `escHtml`, `safeUrl`, `formatLocalDateTime`, `buildQueryUrl`, `geocode`

**FR-6.2: Map and Markers**

- MUST render an OpenStreetMap/Leaflet map filling the viewport below the control strip
- MUST place one `L.circleMarker` per event at `event.lat`/`event.lng`, colour-coded by category
- MUST draw a circle overlay showing the queried area
- MUST fit the map view to the queried circle after each search

**FR-6.3: Marker Popup**

- Clicking a marker MUST show a Leaflet popup with: title (linked if `event.url` present), date/time (`fmtRange`), venue name, category badge

**FR-6.4: Search Here Button**

- MUST be disabled on page load; enabled after any map pan or zoom
- When clicked, MUST compute new lat/lng from `map.getCenter()` and radius from `haversine(center, bounds.getNorthEast())`, rounded to nearest 1 km
- MUST update the radius field to the computed value and clear the address field

**FR-6.5: Shareable URL**

- MUST serialise `lat`, `lng`, `radius`, `from`, `to`, `category` to URL query parameters via `history.replaceState` after each search
- On load, MUST read these parameters and auto-run the query if `lat`/`lng` are present

**FR-6.6: Navigation**

- MUST include a "List view" link pointing to `index.html`
- `index.html` and `it.html` MUST include a "Map" link pointing to `map.html`

**FR-6.7: Build integration**

- `build-bookmarklet.js` MUST inject `__TOKORO_WORKER_URL__` into `map.html`
- `deploy-public-web.sh` MUST include `map.html` in git-diff check and cleanup restore
