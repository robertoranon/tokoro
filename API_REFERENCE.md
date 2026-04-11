# API Reference

## API Worker

### Events

| Method   | Endpoint                                                            | Description                                 |
| -------- | ------------------------------------------------------------------- | ------------------------------------------- |
| `GET`    | `/events?lat=&lng=&radius=&from=&to=&category=&tags=&festival_url=` | Query events (max 100; all params optional) |
| `GET`    | `/events?…&format=ical`                                             | Same query, returned as an iCal (.ics) feed |
| `POST`   | `/events`                                                           | Publish a signed event                      |
| `PUT`    | `/events/:id`                                                       | Edit an event (new signature required)      |
| `DELETE` | `/events/:id`                                                       | Delete an event (signature required)        |

### Stars

| Method   | Endpoint                  | Description                        |
| -------- | ------------------------- | ---------------------------------- |
| `POST`   | `/stars/:event_id`        | Star an event (signed request)     |
| `DELETE` | `/stars/:event_id`        | Unstar an event (signature required) |
| `GET`    | `/stars?pubkey=`          | Get events starred by a user       |
| `GET`    | `/events/:event_id/stars` | Get users who starred an event     |

### Follows

| Method   | Endpoint              | Description                              |
| -------- | --------------------- | ---------------------------------------- |
| `POST`   | `/follows/:pubkey`    | Follow a user (signed request)           |
| `DELETE` | `/follows/:pubkey`    | Unfollow a user (signature required)     |
| `GET`    | `/follows?follower=`  | Get list of users that a user follows    |
| `GET`    | `/followers?followee=`| Get list of users following a user       |

### Discovery

| Method | Endpoint            | Description                                                        |
| ------ | ------------------- | ------------------------------------------------------------------ |
| `GET`  | `/feed?pubkey=`     | Events starred by people the user follows                          |
| `GET`  | `/discover?pubkey=` | Suggested users with similar event taste (collaborative filtering) |

### iCal feeds

Add `format=ical` to any `/events` query to receive an iCal feed (RFC 5545, `text/calendar`) that can be subscribed to directly from any calendar app. Use `window=30d` (or `7d`, etc.) as a shorthand to set a rolling time window instead of explicit `from`/`to` dates — it defaults to `30d` when `format=ical`.

---

## Crawler Worker

| Method | Endpoint | Description                                                             |
| ------ | -------- | ----------------------------------------------------------------------- |
| `POST` | `/crawl` | Extract events from a URL or image (returns unsigned `PreparedEvent[]`) |

### Extraction modes

| Mode       | Input        | How it works                                                                              |
| ---------- | ------------ | ----------------------------------------------------------------------------------------- |
| `direct`   | URL          | Extracts events from the given URL: parses JSON-LD, falls back to LLM extraction          |
| `discover` | URL          | Finds event sub-pages on the given URL via LLM link analysis, then extracts from each one |
| `image`    | base64 image | Uses multimodal LLM vision to extract events from a flyer or poster                       |

The default mode is `discover`.

**Content fetching:** when the browser extension or bookmarklet sends the page HTML in the request body (`html` field), the Worker cleans and uses it directly. When no HTML is provided (e.g., direct API calls), the Worker fetches the page via Jina AI Reader.

The crawler worker always returns unsigned `PreparedEvent[]` — signing and publishing is handled client-side by the browser tool (Chrome extension, bookmarklet) before sending to the API worker.

The Crawler Worker requires an `Authorization: Bearer <api-key>` header.

---

## Authentication

All write operations (`POST`, `PUT`, `DELETE`) require a valid Ed25519 signature in the request body. The Worker verifies every write against the declared public key; unsigned or invalidly-signed requests are rejected.

Optionally, set `ALLOWED_PUBKEYS` on the API Worker (comma-separated hex pubkeys) to restrict publishing to known curators — if absent, any valid signature is accepted.

---

## Data model

Events are stored in Cloudflare D1 (SQLite):

```sql
CREATE TABLE events (
  id            TEXT PRIMARY KEY,    -- stable across edits
  pubkey        TEXT NOT NULL,       -- author's Ed25519 public key (hex)
  signature     TEXT NOT NULL,       -- Ed25519 signature (hex)
  title         TEXT NOT NULL,
  description   TEXT,
  url           TEXT,                -- event page URL
  venue_name    TEXT,
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  geohash5      TEXT NOT NULL,       -- ~5 km spatial index
  geohash6      TEXT NOT NULL,       -- ~1.2 km spatial index
  start_time    TEXT NOT NULL,       -- ISO 8601, local time at venue (e.g. "2026-03-15T21:00:00")
  end_time      TEXT,
  category      TEXT NOT NULL,       -- music | food | sports | arts | community | …
  tags          TEXT,                -- JSON array of free-form tags
  festival_name TEXT,                -- optional festival grouping label
  festival_url  TEXT,                -- optional festival homepage (used for grouping/filtering)
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);
```

**Timestamp convention:** all times are ISO 8601 without timezone (`YYYY-MM-DDTHH:MM:SS`), representing local time at the venue's location. No UTC conversion — the event coordinates carry the timezone context implicitly.
