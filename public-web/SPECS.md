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
- MUST support filtering by keyword (`q`): matches events whose title, description, or tags contain the value as a substring; empty value disables the filter
- MUST default to a configurable location and 100 km radius
- MUST provide preset time-range shortcuts (today, next 7 days, next 30 days, etc.)
- MUST always send `has_act=0` on the geo queries of the browse page, the map page (both via `buildQueryUrl`) and the iCal subscription URL, so band shows (events with an `act_url`, listed on `tours.html`) never appear in their results

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
- MUST show a "Download backup" button in the settings form that downloads a JSON file `tokoro-backup-<first 8 hex chars of pubkey>.json` containing `{ tokoro_backup: 1, exported_at, api_key, worker_url, api_url, keypair }` (values read from `localStorage`)
- MUST show a "Restore backup" button that opens a file picker; on selecting a file with `tokoro_backup: 1`, MUST validate the private key by deriving its public key (as in FR-5.3), persist the keypair and any non-empty settings to `localStorage`, refresh the form, and show a success status; MUST show an error status and change nothing if the file is not a valid backup or the key is invalid

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

1. **`?preview=TOKEN`** — iOS Shortcut handoff: fetch `{url, html, title}` from crawler-worker KV store using the token, then call `runCrawl({url, html, title, mode: 'direct'}, null)`
2. **`window.opener` present** — bookmarklet relay mode: hide input UI, signal `{ type: 'ready' }` to opener after ensuring keypair, then handle incoming `crawl_data` messages
3. **Default** — manual input mode (FR-5.7)

**FR-5.7: Apple Shortcut handoff**

iOS Shortcuts' "Open URL" action silently strips long query parameter values, making it impossible to pass the HTML payload directly in the URL.

The solution is a two-step relay via the crawler-worker's KV store:

1. The Shortcut script (`shortcut-bookmarklet.src.js`) `fetch()`es `POST /preview` on the crawler-worker with `{url, title, html}` (JSON-LD + up to 15 000 chars of `innerText`). No API key required — the endpoint is unauthenticated.
2. The crawler-worker stores the payload in `PREVIEW_CACHE` KV with a 30-minute TTL and returns `{token}` (a UUID).
3. The script calls `completion(RELAY_URL + '?preview=' + token)` — a ~80-char URL that survives iOS's limit.
4. `publish.html` detects `?preview=TOKEN`, fetches the payload from `GET /preview/:token`, and calls `runCrawl`.

- The Shortcut script MUST NOT contain any API key
- `__CRAWLER_WORKER_URL__` in the source is replaced by `build-bookmarklet.js` from `config.crawlerWorkerUrl`

**FR-5.8: Manual input modes**

When opened without an opener or matching URL/hash params, `publish.html` shows a two-tab input UI:

- **URL tab** — user enters a page URL and clicks "Extract Events"; sends `{ url, mode: 'direct' }` to the crawler worker
- **Image tab** — user uploads an image file and optionally enters a source URL; sends `{ mode: 'image', imageData, imageMimeType, url? }` to the crawler worker with the image encoded as base64

---

## NFR

- No build step — plain HTML + inline JS/layout CSS + one shared static stylesheet (`theme.css`, a relative link, so pages still work from a local file)
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

- MUST render a Leaflet map using the abstract Esri World Light Gray basemap (no terrain shading, no API key) filling the viewport below the control strip
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

---

## FR-7: Festival Radar (`festivals.html`)

A read-only browse page for the festivals on the radar (entries published by the crawler's `npm run radar`). It is independent of the other pages: no shared navigation, no changes to them.

**FR-7.1: Data**

- MUST fetch `GET {API}/events?has_festival=1&from=<today − 366 days>&to=<today + 548 days (~18 months)>&offset=N` (no-geo browse), following `has_more` until exhausted, capped at 30 pages (then show a notice)
- MUST reach back one year with `from`: the no-geo path filters `start_time >= from` (not overlap), so a festival already under way would otherwise be hidden; the worker deletes radar entries ~2 days after they end, so nothing older exists
- MUST show only **radar entries**: `tags` contains `festival`, `start_time` ends `T00:00:00`, `end_time` ends `T23:59:59`, numeric `lat`/`lng`. Festival-mode program events share `has_festival=1` and MUST NOT appear
- MUST hide festivals that ended before today (a festival ending today stays)
- MUST treat dates as venue-local `YYYY-MM-DD` strings (no `Date` parsing)

**FR-7.2: Filters**

- MUST offer month chips (All + the next 12 months, starting with the current one); a festival matches a month if its date range **overlaps** it; clicking the active chip clears it
- MUST offer an art-form filter (music / art / performance / other; "performance" is the `theater` category) and a keyword field (accent- and case-insensitive match over name, title, description, tags, venue, address); filters combine with AND
- MUST offer an opt-in "Near me" toggle using browser geolocation: it **sorts** by distance and shows the distance on each card; it MUST NOT filter by location; if location is unavailable or denied it MUST revert with a notice and keep the full list

**FR-7.3: Timeline list**

- MUST group festivals under "Happening now" (already started) and then one heading per start month, ordered by start date then name (by distance when "Near me" is on)
- MUST show per card: date range (`18–21 Jun`, year only if not the current one), title, category (raw category value), venue/address, description (clamped to 3 lines), up to 6 tags, and an outbound link to the festival's own site
- MUST show friendly empty states ("Nothing on the radar yet." when there are no entries; "Nothing on the radar yet for {month}" when only a month is selected; "No festivals match your filters." otherwise) and a retryable error state when the API fails; if the deploy step has not replaced the API placeholder it shows a "not configured" error instead of fetching

**FR-7.4: Map**

- MUST show a Leaflet map fitted to the visible festivals, one pin per distinct location, coloured by art form (of the first festival at that location), popup with title, dates and link; each card has a "Show on map" action
- MUST re-fit the map only when the set of visible festivals changes (not on every keystroke; the keyword input is debounced), and MUST ignore outlier coordinates outside Europe (lat 34..72, lng -25..45) for the fit while still drawing every pin; if no point is inside that box it fits all points
- MUST disable one-finger map dragging on touch devices so the page stays scrollable (zoom buttons, pinch zoom, tapping pins and "Show on map" still work)
- MUST keep working without the map: if Leaflet fails to load the map panel is hidden, the "Show on map" actions are omitted and the list is fully functional

**FR-7.5: Safety and build**

- MUST escape all API text with `escHtml` and link only through `safeUrl`
- MUST use functional CSS class names (content blockers hide names such as `share-*`/`ad-*`)
- MUST be listed in `inject-worker-url.js` (`ALL_FILES`) so the deploy step replaces `__TOKORO_WORKER_URL__` and `__BUILD_VERSION__`; `tests/inject.test.mjs` enforces this for every HTML page
- Logic lives in `festivals.js` (pure, unit-tested in `tests/festivals.test.mjs`); `tests/festivals.smoke.mjs` runs the page offline in headless Chromium against a fake API

**Known limitations:** as program events accumulate, `has_festival=1` returns more pages than radar entries (a worker-side `radar` filter would remove that); one pin per location (secondary places of a multi-place festival are in the description text only); the page does not paginate the rendered list.

---

## FR-8: Band Tours (`tours.html`)

A read-only, band-first browse page for the shows published by the crawler's `npm run tours`. It is independent of the other pages: logo-only nav, no links to or from them, its own ticker and the teal page colour.

**FR-8.1: Data**

- MUST fetch `GET {API}/events?has_act=1&from=<today>T00:00:00&to=<today + 548 days (~18 months)>T23:59:59&offset=N` (no-geo browse), following `has_more` until exhausted, capped at 30 pages (then show a notice)
- MUST show only events with a non-empty `act_url`, a real `YYYY-MM-DD` start date and numeric `lat`/`lng`; MUST hide shows dated before today (a show today stays) and de-duplicate by event id
- MUST treat dates as venue-local `YYYY-MM-DD` strings (no `Date` parsing); the `band-tour` tag is not displayed

**FR-8.2: Grouping**

- MUST group shows client-side by `act_url`; the band name is `act_name`, or the host of `act_url` (without `www.`) when empty
- MUST order bands by their next show date, then name; shows within a band by date, then time

**FR-8.3: Band cards**

- MUST render one collapsed `<details>` card per band; the summary shows the band name, the number of upcoming shows and "Next: Tue 12 Nov, 21:00" (year added only if not the current one; time omitted when the start is midnight)
- MUST show in the body every show (weekday, date, time when not midnight, venue and address joined with " · ", a "Show page" link when the event has a URL, and the distance when an area origin is set) and a "Band website" link; the API has no city field, so the address stands in for it
- MUST keep open cards open when filters change or the list re-renders

**FR-8.4: Filters**

- MUST offer a keyword field (accent- and case-insensitive substring over band name, title, venue, address and tags; debounced) and from/to date inputs (inclusive, on the show date); filters combine with AND
- MUST offer an area filter: a place typed into the input and geocoded with `geocode()` on Enter (Nominatim), or a "Near me" toggle using browser geolocation, plus a radius select (25 / 50 / 100 / 250 / 500 km, default 100); with an origin set, shows farther than the radius are hidden and each show gets its distance
- MUST, when geocoding or geolocation fails, show a notice and keep all shows visible

**FR-8.4a: Saved queries**

- MUST offer a "Copy link" button that copies a link to the page carrying the current filters, so a query can be saved or shared (the events page's "Copy link" works the same way). Query parameters: `q` (keyword), `from`, `to` (`YYYY-MM-DD`), and, only when an area filter is active, `lat`, `lng` (rounded to 4 decimals), `radius` and `place` (the typed place name; absent for "Near me"). Empty filters are omitted, so a page with no filters copies the bare page url. If the clipboard is unavailable the link is shown in a prompt.
- MUST restore the filters from these parameters on load and apply them: the inputs are filled, an area filter is active (a typed place shows as that text, otherwise as `lat, lng`), and the list is filtered once the shows have loaded. Invalid values are ignored without error: a date that is not a real calendar date, a latitude/longitude outside the valid range or missing one of the pair, a radius that is not one of the select's options (default 100), a keyword longer than 200 characters (truncated).
- Open band cards and the mapped band are not saved.

**FR-8.5: Map**

- MUST offer an optional Leaflet map: hidden until "Show on map" is pressed on a band; it then shows one pin per distinct location of that band's visible shows (popup: band, date, venue and address) and fits to them (Europe outliers ignored for the fit, as on the radar)
- MUST contain the "Hide map" button inside the map panel (a flex column: map above, button row below); the map panel hides itself when the mapped band no longer matches the filters
- MUST keep working without the map: if Leaflet fails to load, the "Show on map" actions are omitted

**FR-8.6: States**

- MUST show a loading status, "No upcoming shows yet." when there are no shows, "No shows match your filters." when filters hide everything, a retryable error state when the API fails, and a "not configured" error instead of fetching when the API placeholder was not replaced; a status line reports "N of M bands · K shows"

**FR-8.7: Safety and build**

- MUST escape all API text with `escHtml` and link only through `safeUrl`; MUST use functional CSS class names (`.band-card`, `.band-show`, `.result-actions`)
- MUST be listed in `inject-worker-url.js` (`ALL_FILES`); `tests/inject.test.mjs` enforces this
- Logic lives in `tours.js` (pure, unit-tested in `tests/tours.test.mjs`); `tests/tours.smoke.mjs` runs the page offline in headless Chromium against a fake API (set `TOURS_SMOKE_MAP=1` to add the Leaflet checks, which need internet for the Leaflet CDN)

**Known limitations:** which band cards are open is not part of a saved link; the no-geo path returns 100 shows per page, so a very large data set takes several requests; one band per `act_url`; the page does not paginate the rendered list.

---

## Visual style (bold per-page colour)

All pages share `theme.css`, linked after each page's inline `<style>`. Pages keep layout CSS only; design tokens (`:root` variables) and colour, type and line work live in `theme.css`. Each `<body>` carries `data-page` (browse and it = blue, festivals = orange, map = lime, publish = violet, privacy = yellow, tours = teal `#00d6b4`), which sets `--page`, the full-bleed page colour.

- **Look:** full-bleed page colour, white cards with 2px black borders, black blocks with white text, square corners, no soft shadows. Hover lifts a card with a hard 5px black offset shadow.
- **Type:** Archivo 800-900 (expanded, uppercase) for headings and the wordmark; Poppins 400-600 for body text.
- **Chrome:** a yellow scrolling ticker above a sticky black nav bar (logo, Browse / Map, yellow Publish button). Each page has its own ticker text. The festival radar and the band tours page are separate sections: each nav bar holds only its own logo ("Tokoro Radar", "Tokoro Tours"), and no other page links to either or from either. Magenta is not used. The page `<header>` acts as the hero: a large title with an outlined `<em>`, plus an intro line. The map page uses a compact header so the map keeps the viewport.
- **Colour rules:** text is black on every saturated background; white text appears only on black. Yellow is a fill and the focus halo. Black on violet is about 4.5:1.
- **Categories:** the 13 `--cat-*` tokens are unchanged. The `CAT_COLORS` maps in `query.js`, `map.html` and `festivals.html` must equal them. `.cat-tab` is the category label on a card edge (`.tab` belongs to the publish page's own tabs).
- **Motion:** ticker scroll, hero and card rise-in, card hover lift. All of it is disabled under `prefers-reduced-motion`. Keyframes must set opacity in `to`, or elements stay hidden.
- **Maps:** Basemap is Esri World Light Gray (base + reference layers, no API key; CARTO basemaps now require one). Leaflet options cannot use CSS variables, so marker colours are literals: black ring (`#000000`), weight 3, full fill opacity; the search-radius circle is black. `.leaflet-container` is `isolation: isolate` so map controls never overlap the sticky bar.
- **Guard:** `tests/theme.test.mjs` enforces the tokens, the `theme.css` link order, per-page `data-page`, fonts, ticker and nav bar, no legacy dark colours, no inline `:root`, category-colour parity, reduced-motion support, safe keyframes and no soft shadows.
