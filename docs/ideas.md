# Tokoro — Ideas Backlog

Brainstormed ideas for future features, improvements, and directions. Not prioritised; not committed.

---

## Social features (backend already implemented, no frontend)

- **Stars UI** — let users star/save events from the public web; the API already supports `POST /stars/:event_id` and `DELETE /stars/:event_id`
- **Follows UI** — follow other curators; the API already supports `POST /follows/:pubkey` and `DELETE /follows/:pubkey`
- **Feed view** — a "following" tab showing events starred by people you follow (`GET /feed?pubkey=`)
- **Discover view** — surface recommended curators based on overlapping starred events (`GET /discover?pubkey=`)
- **Curator profile pages** — a public URL (`/profile?pubkey=...`) showing a curator's published events, starred events, and follower count; makes identity meaningful beyond just a hex string

---

## Discovery & browsing

- **Tag-based filtering** — tags are stored on every event but currently invisible; add tag chips and a tag filter to the search UI (no backend changes needed — tags are already in the API response)
- **Venue pages** — a dedicated URL grouping all past and future events at a specific venue, with a subscribe-via-iCal link
- **"What's on tonight" widget** — a radically stripped-down single-page view: one tap, your location, events in the next 24h; designed to be bookmarked or installed as a PWA homescreen shortcut
- **Text search** — full-text search across event titles and descriptions (would require a backend index)

---

## Sharing & export

- **"Add to Calendar" buttons** — one-click Google Calendar / Apple Calendar / Outlook links on each event card; currently missing
- **RSS/Atom feed** — same concept as the existing iCal feed but for news readers; subscribe to "Music events in Berlin" as an RSS feed
- **Shareable event cards with OG images** — when sharing a link like `?event_id=...`, render a proper social preview image (title, date, venue) instead of a generic page title
- **Embeddable widget** — a small `<iframe>` calendar snippet that venues or bloggers can paste into their own site

---

## Automation & power-user tools

- **Scheduled crawling watchlist** — curators register a list of URLs (e.g. a venue's event page) that get re-crawled automatically on a cron schedule; new events publish without manual intervention
- **Webhooks** — notify an external endpoint (Slack, Discord, n8n, Make) when new events appear in a geographic area or match a filter
- **`tokoro` CLI for querying** — a small shell tool (`tokoro query --lat 45.4 --lng 9.1 --radius 10 --today`) for scripting, piping into other tools, and building bots

---

## Data model

- **Event images** — add an optional `image_url` field to events; would make cards much richer visually and enable proper OG images
- **Event editing UI** — the API already supports `PUT /events/:id` with a new signature, but no frontend lets curators edit a published event

---

## Developer / operator tooling

- **Public stats page** — live dashboard: total events, events by category, most active cities, most prolific curators; makes the network's health visible
- **Multi-instance federation** — a protocol for separate Tokoro instances to discover and pull events from each other, so the network is more than one silo

---

## Out of scope (noted for completeness)

Ideas explicitly called out as future enhancements in the Chrome extension spec:

- Edit extracted events before publishing
- Save draft events locally
- Batch crawl multiple tabs
- Keyboard shortcuts in the extension
- Custom LLM provider selection per-request
- "Discover" mode for finding multiple event pages
- Crawl history and logs
