# API Reference

## API Worker

### Events

| Method   | Endpoint                                                            | Description                                 |
| -------- | ------------------------------------------------------------------- | ------------------------------------------- |
| `GET`    | `/events?lat=&lng=&radius=&from=&to=&category=&tags=&festival_url=&has_festival=1&act_url=&has_act=1` | Query events (max 100; all params optional; `has_festival=1` returns only festival entries; `has_act=1` returns only band shows, `has_act=0` excludes them; `include_held=1` also returns events held by an open conflict) |
| `GET`    | `/events?…&format=ical`                                             | Same query, returned as an iCal (.ics) feed |
| `POST`   | `/events`                                                           | Publish a signed event                      |
| `PUT`    | `/events/:id`                                                       | Edit own event (re-signed; `created_at` immutable; no dedup) |
| `DELETE` | `/events/:id`                                                       | Delete an event (signature required)        |
| `POST`   | `/events/:id/act`                                                   | Attach act_name/act_url to an existing event that has none (signed, allowlisted key) |

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

### Members (tours page)

Admin-issued members follow tracked bands and suggest new ones on `tours.html`. These endpoints are signed with headers (see [Member and admin request signatures](#member-and-admin-request-signatures)); member keys are never in `ALLOWED_PUBKEYS`, so members cannot publish.

| Method   | Endpoint                          | Description                                                                 |
| -------- | --------------------------------- | --------------------------------------------------------------------------- |
| `GET`    | `/member/me`                      | The member's name, followed band URLs and own suggestions (newest first)    |
| `POST`   | `/member/bands/:act_url_b64`      | Follow a band; `:act_url_b64` is the base64url band site URL (idempotent)   |
| `DELETE` | `/member/bands/:act_url_b64`      | Unfollow a band (idempotent)                                                |
| `POST`   | `/member/suggestions`             | Suggest a band `{name, url?}` → `201 {id}`; same pending name again → `200 {id, duplicate: true}` |

### Admin (members and suggestions)

Signed by `ADMIN_PUBKEY` (`503` when it is not configured).

| Method   | Endpoint                                   | Description                                                                 |
| -------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `GET`    | `/admin/members`                           | Members with `band_count`, newest first                                     |
| `POST`   | `/admin/members`                           | Create a member `{pubkey, name}` → `201` (`409` if the pubkey exists)       |
| `POST`   | `/admin/members/:pubkey/revoke`            | Revoke a member (their requests get `403`)                                  |
| `DELETE` | `/admin/members/:pubkey`                   | Delete a member with their follows and suggestions                          |
| `GET`    | `/admin/suggestions?status=&detail=1`      | Suggestions grouped by normalized band name, most requested first; `status` = `pending` (default), `rejected` or `linked`; `detail=1` adds member names |
| `POST`   | `/admin/suggestions/reject`                | Reject pending suggestions `{ids, reason?}` → `{updated}`                   |
| `POST`   | `/admin/suggestions/link`                  | Link suggestions to a tracked band `{ids, act_url}` and follow it for each suggester → `{updated}` |
| `GET`    | `/admin/band-followers`                    | `[{act_url, followers}]`, most followed first (counts only; active members only) |

Bodies, status codes and error messages: [`worker/SPECS.md`](worker/SPECS.md) sections 7.11-7.14.

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

All write operations (`POST`, `PUT`, `DELETE`) require a valid Ed25519 signature in the request body (the member and admin member/suggestion endpoints use headers instead, see below). The Worker verifies every write against the declared public key; unsigned or invalidly-signed requests are rejected.

Optionally, set `ALLOWED_PUBKEYS` on the API Worker (comma-separated hex pubkeys) to restrict publishing to known curators — if absent, any valid signature is accepted.

### Member and admin request signatures

The member and admin member/suggestion endpoints carry their signature in headers, and reads are signed too:

| Header        | Value                                    |
| ------------- | ---------------------------------------- |
| `X-Pubkey`    | signer public key (64 hex chars)         |
| `X-Signature` | Ed25519 signature (128 hex chars)        |
| `X-Timestamp` | Unix time in seconds                     |

The signed message is `SHA-256("<domain>:<payload>:<timestamp>")`. The timestamp must be within ±300 s of the server clock; otherwise the response is `401` with `server_time` (the server's Unix time) so the client can correct its clock and retry. Each action has its own domain, so a signature cannot be reused for another action:

| Domain                    | Used by                                                         | Payload                                 |
| ------------------------- | --------------------------------------------------------------- | --------------------------------------- |
| `member-read`             | `GET /member/me`                                                | `/member/me`                            |
| `band-follow`             | `POST /member/bands/:act_url_b64`                               | normalized band URL                     |
| `band-unfollow`           | `DELETE /member/bands/:act_url_b64`                             | normalized band URL                     |
| `band-suggest`            | `POST /member/suggestions`                                      | raw JSON body                           |
| `admin-read`              | `GET /admin/members`, `/admin/suggestions`, `/admin/band-followers` | request path with its query string as sent (e.g. `/admin/suggestions?detail=1`) |
| `admin-member`            | `POST /admin/members`                                           | raw JSON body                           |
| `admin-member-revoke`     | `POST /admin/members/:pubkey/revoke`                            | target pubkey (lower-case)              |
| `admin-member-delete`     | `DELETE /admin/members/:pubkey`                                 | target pubkey (lower-case)              |
| `admin-suggestion-reject` | `POST /admin/suggestions/reject`                                | raw JSON body                           |
| `admin-suggestion-link`   | `POST /admin/suggestions/link`                                  | raw JSON body                           |

A normalized band URL is scheme + host[:port] + path, lower-case scheme and host, without query, fragment or trailing slash (http/https only), at most 500 characters (a suggestion `url` or link `act_url` that is longer after normalization → `400`). CORS allows the three headers.

Endpoints with a JSON body (`POST /member/suggestions`, `POST /admin/members`, `POST /admin/suggestions/reject`, `POST /admin/suggestions/link`) accept at most 8 KB and check the cheap things before reading it: a `Content-Length` above 8 KB → `413 {"error": "Payload too large"}` (before any auth check); for the admin endpoints, `503` when the admin is not configured; malformed headers or a timestamp outside the window → `401`; a body that turns out larger than 8 KB → `413`; then the signature (`401`) and the member/admin check (`403`).

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
  act_name      TEXT,                -- optional band name (unsigned)
  act_url       TEXT,                -- optional band canonical site (grouping/filtering key; unsigned)
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);
```

Members, their followed bands and their suggestions are stored in `members`, `member_bands` and `band_suggestions` (schema in [`worker/SPECS.md`](worker/SPECS.md) section 2.1).

**Timestamp convention:** all times are ISO 8601 without timezone (`YYYY-MM-DDTHH:MM:SS`), representing local time at the venue's location. No UTC conversion — the event coordinates carry the timezone context implicitly.
