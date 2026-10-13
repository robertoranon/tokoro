# Tokoro Worker — Technical Specification

**Version:** 1.0
**Date:** 2026-03-06 (member endpoints added 2026-10-13)
**Status:** Reference implementation exists — this spec enables reimplementation in any language

---

## 1. Overview

This document specifies the complete behavior of the Tokoro Worker, a serverless API backend that:
- Serves HTTPS API requests for querying and publishing events
- Verifies Ed25519 cryptographic signatures for all write operations
- Stores event data in SQLite (Cloudflare D1)
- Executes geospatial queries using geohash-based indexing
- Automatically expires past events via scheduled cron triggers
- Stores admin-issued members, the bands they follow and the bands they suggest for the tours page (header-signed requests, section 3.6)

This specification is implementation-agnostic and provides sufficient detail to reimplement the worker in any language (TypeScript, Python, Go, Rust, etc.) with complete test coverage.

---

## 2. Data Schema

### 2.1 Database Tables

The worker interacts with five SQLite tables: `events`, `blocklist`, and the three member tables (`members`, `member_bands`, `band_suggestions`).

#### Events Table

```sql
CREATE TABLE events (
  id          TEXT PRIMARY KEY,       -- SHA-256 hash of canonical event data
  pubkey      TEXT NOT NULL,          -- Ed25519 public key (64 hex chars)
  signature   TEXT NOT NULL,          -- Ed25519 signature (128 hex chars)
  title       TEXT NOT NULL,
  description TEXT,
  url         TEXT,                   -- event website or page URL
  venue_name  TEXT,                   -- optional venue name for grouping
  address     TEXT,                   -- physical address (optional)
  lat         REAL NOT NULL,          -- latitude (-90 to 90)
  lng         REAL NOT NULL,          -- longitude (-180 to 180)
  geohash5    TEXT NOT NULL,          -- geohash at precision 5 (~5km cells)
  geohash6    TEXT NOT NULL,          -- geohash at precision 6 (~1.2km cells)
  start_time  TEXT NOT NULL,          -- ISO 8601 format "YYYY-MM-DDTHH:MM:SS"
  end_time    TEXT,                   -- ISO 8601 format, nullable
  category    TEXT NOT NULL,          -- predefined category
  tags        TEXT,                   -- JSON array of strings (e.g. ["jazz", "outdoor"])
  festival_name TEXT,                   -- optional festival name (e.g. "Flow Festival 2026")
  festival_url  TEXT,                   -- optional festival homepage URL (used as festival ID)
  act_name      TEXT,                   -- optional band name (unsigned metadata, band tours)
  act_url       TEXT,                   -- optional band canonical site URL (unsigned metadata; grouping/filter key)
  created_at  TEXT NOT NULL,          -- ISO 8601 format
  updated_at  TEXT                    -- ISO 8601 format, updated on edit
);

CREATE INDEX idx_geohash6_time ON events (geohash6, start_time);
CREATE INDEX idx_geohash5_time ON events (geohash5, start_time);
CREATE INDEX idx_category_time ON events (category, start_time);
CREATE INDEX idx_festival_url ON events (festival_url);
CREATE INDEX idx_act_url ON events (act_url);
```

#### Blocklist Table

```sql
CREATE TABLE blocklist (
  pubkey     TEXT PRIMARY KEY,        -- Ed25519 public key (64 hex chars)
  created_at TEXT NOT NULL            -- ISO 8601 format
);
```

Blocked pubkeys are checked on write paths. Any request whose `pubkey` appears in the blocklist is rejected with `403 Forbidden`. Protected paths:
- `POST /events`
- `DELETE /events/:id`

#### Member Tables

Members (admin-issued keys for the tours page) are stored in `members`, `member_bands` and `band_suggestions`; member keys are never part of `ALLOWED_PUBKEYS` and cannot publish.

```sql
CREATE TABLE members (
  pubkey      TEXT PRIMARY KEY,       -- member public key (64 hex chars, lower-case)
  name        TEXT NOT NULL,          -- display name chosen by the admin (1-60 chars)
  created_at  TEXT NOT NULL,          -- ISO 8601 format
  revoked_at  TEXT                    -- ISO 8601 format; non-null = revoked
);

CREATE TABLE member_bands (
  pubkey      TEXT NOT NULL,          -- member public key
  act_url     TEXT NOT NULL,          -- normalized band site URL (section 3.6)
  created_at  TEXT NOT NULL,          -- ISO 8601 format
  PRIMARY KEY (pubkey, act_url)
);
CREATE INDEX idx_member_bands_act ON member_bands (act_url);

CREATE TABLE band_suggestions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pubkey        TEXT NOT NULL,        -- suggesting member
  name          TEXT NOT NULL,        -- band name, trimmed, 1-120 chars
  url           TEXT,                 -- optional band site, normalized (section 3.6)
  status        TEXT NOT NULL,        -- 'pending' | 'rejected' | 'linked'
  act_url       TEXT,                 -- set when status = 'linked'
  reject_reason TEXT,                 -- optional, max 200 chars
  created_at    TEXT NOT NULL         -- ISO 8601 format
);
CREATE INDEX idx_suggestions_status ON band_suggestions (status, created_at);
```

`member_bands.act_url` is not checked against the list of tracked bands (the worker does not know it). A row for a band that is no longer tracked is harmless; clients ignore URLs that are not in their tracked list. The tables have no foreign keys: deleting a member deletes its rows explicitly (section 7.12).

### 2.2 Timestamp Format Convention

**Critical:** All timestamps use ISO 8601 format **without timezone**: `"YYYY-MM-DDTHH:MM:SS"` (e.g., `"2026-03-15T21:00:00"`)

- Timestamps represent **local time at the venue's location** (implicit timezone)
- The venue's coordinates (lat/lng) define the timezone context
- This avoids timezone conversion complexity while maintaining human readability
- Example: An event at 9pm in Berlin stores as `"2026-03-15T21:00:00"`, same as 9pm in Tokyo

### 2.3 Event Categories

Predefined categories (single selection required):

```
Music, Food, Sports, Art, Theater, Film, Nightlife, Community, Outdoor, Learning, Wellness, Other
```

### 2.4 Coordinate Constraints

- `lat`: -90.0 to 90.0 (inclusive)
- `lng`: -180.0 to 180.0 (inclusive)
- Valid coordinate precision: up to 6 decimal places (sufficient for ~0.1m accuracy)

---

## 3. Cryptographic Signature Verification

### 3.1 Ed25519 Signature Algorithm

All write operations (POST, DELETE) require Ed25519 signature verification:

1. **Public key format**: 64 hexadecimal characters (32 bytes)
2. **Signature format**: 128 hexadecimal characters (64 bytes)
3. **Hash function**: SHA-512 (for Ed25519) and SHA-256 (for message hashing)

### 3.2 Event Signature Verification (POST /events)

**Canonical Event Data Format:**

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

**Verification Steps:**

1. Extract the canonical event data (excluding `signature` field)
2. Convert optional fields to empty string if missing: `description`, `url`, `venue_name`, `address`
3. Convert `tags` to empty array `[]` if missing
4. Serialize to canonical JSON string (deterministic key order as shown above)
5. Compute SHA-256 hash of the canonical JSON string → `message_hash` (64 hex chars)
6. Convert `message_hash`, `signature`, and `pubkey` from hex to bytes
7. Verify: `ed25519.verify(signature_bytes, message_hash_bytes, pubkey_bytes)`

**Critical:** The JSON serialization MUST be deterministic. Use the exact key order shown above.

### 3.3 Delete Signature Verification (DELETE /events/:id)

**Signed Message:** The event ID itself (64 hex chars, SHA-256 hash)

**Verification Steps:**

1. Extract `event_id` from URL path
2. Extract `pubkey` and `signature` from request body
3. Convert `event_id`, `signature`, and `pubkey` from hex to bytes
4. Verify: `ed25519.verify(signature_bytes, event_id_bytes, pubkey_bytes)`

### 3.4 Admin Blocklist Signature Verification (POST/DELETE /admin/blocklist)

**Signed Message:** `SHA-256("blocklist:" + target_pubkey)`

The prefix `"blocklist:"` is a **domain separator** that prevents reuse of event delete signatures for blocklist operations.

**Verification Steps:**

1. Extract `target_pubkey` from request body (or URL path for DELETE)
2. Compute: `message = SHA-256(encode_utf8("blocklist:" + target_pubkey))`
3. Extract `pubkey` and `signature` from request body
4. Verify: `ed25519.verify(signature_bytes, message_bytes, pubkey_bytes)`
5. Additionally verify that `pubkey === ADMIN_PUBKEY`

### 3.5 Act Signature Verification (POST /events/:id/act)

**Signed Message:** `SHA-256("act:" + event_id + "\n" + act_name + "\n" + act_url)` (UTF-8, `\n` is a single line feed)

The prefix `"act:"` is a **domain separator**: an act signature can never be replayed as an event, delete or blocklist signature (those sign a canonical JSON hash, the bare event ID, or a `"blocklist:"`-prefixed string). Binding the event ID, name and URL into the message means a signature authorizes exactly one (event, act) pair.

**Verification Steps:**

1. Take `event_id` from the URL path; take `pubkey`, `signature`, `act_name` and `act_url` from the request body, **exactly as sent** (no trimming or normalization before signing or verifying)
2. Compute `message = SHA-256(encode_utf8("act:" + event_id + "\n" + act_name + "\n" + act_url))`
3. Verify: `ed25519.verify(signature_bytes, message_bytes, pubkey_bytes)`; any decoding error counts as a failed verification

The reference implementation pins this format with a fixed cross-package test vector so the crawler (the signer) and the worker cannot drift apart.

### 3.6 Member and Admin Request Signatures

The member endpoints (`/member/*`) and the admin member/suggestion endpoints (`/admin/members*`, `/admin/suggestions*`, `/admin/band-followers`) authenticate with headers instead of body fields. Reads are signed too, because member data is private.

**Headers:**

| Header | Format |
|---|---|
| `X-Pubkey` | signer public key, 64 hex chars (case-insensitive; lower-cased before use) |
| `X-Signature` | Ed25519 signature, 128 hex chars |
| `X-Timestamp` | Unix time in seconds, 1-12 decimal digits |

**Signed Message:** `SHA-256(encode_utf8(domain + ":" + payload + ":" + timestamp))`, where `timestamp` is the `X-Timestamp` header string. The domain separates operations, so a signature for one action can never be used for another; the timestamp limits replay to the acceptance window.

**Verification Steps:**

1. If any header is missing or malformed → `401 {"error": "Missing or malformed authentication headers"}`.
2. If `|server_now_seconds - timestamp| > 300` → `401 {"error": "Timestamp out of range", "server_time": <server Unix seconds>}`. Clients use `server_time` to correct a wrong device clock and retry once.
3. Verify `ed25519.verify(signature_bytes, message_bytes, pubkey_bytes)`; a failed verification or any decoding error → `401 {"error": "Invalid signature"}`.
4. Authorization:
   - Member endpoints: the pubkey must exist in `members` with `revoked_at IS NULL`, else `403 {"error": "Forbidden", "message": "Not an active member"}`.
   - Admin endpoints: if `ADMIN_PUBKEY` is not configured → `503 {"error": "Admin not configured"}` (checked **before** steps 1-3); the pubkey must equal `ADMIN_PUBKEY` (case-insensitive), else `403 {"error": "Unauthorized"}`.

**Endpoints with a body** (`POST /member/suggestions`, `POST /admin/members`, `POST /admin/suggestions/reject`, `POST /admin/suggestions/link`) are signed over the raw body, so the body must be read before step 3. To avoid buffering bodies for unauthenticated requests, the order of checks is:

1. `Content-Length` header present and greater than 8192 bytes → `413 {"error": "Payload too large"}` (before any other check).
2. Admin endpoints only: `ADMIN_PUBKEY` not configured → `503`.
3. Steps 1-2 above (header format, timestamp window) → `401`, **without reading the body**.
4. Read the body; more than 8192 bytes (UTF-8) → `413 {"error": "Payload too large"}`.
5. Step 3 above (signature over the body) → `401`, then step 4 (authorization) → `403`.
6. Body parsing and validation → `400`.

**Domains and payloads:**

| Domain | Endpoint | Payload |
|---|---|---|
| `member-read` | `GET /member/me` | the literal string `/member/me` |
| `band-follow` | `POST /member/bands/:act_url_b64` | the normalized `act_url` (decoded from the path, then `normalizeActUrl`) |
| `band-unfollow` | `DELETE /member/bands/:act_url_b64` | the normalized `act_url` |
| `band-suggest` | `POST /member/suggestions` | the raw JSON request body, byte for byte |
| `admin-read` | `GET /admin/members`, `GET /admin/suggestions`, `GET /admin/band-followers` | the request path without query string (e.g. `/admin/suggestions` also for `?detail=1`) |
| `admin-member` | `POST /admin/members` | the raw JSON request body |
| `admin-member-revoke` | `POST /admin/members/:pubkey/revoke` | the target pubkey from the path, lower-cased |
| `admin-member-delete` | `DELETE /admin/members/:pubkey` | the target pubkey from the path, lower-cased |
| `admin-suggestion-reject` | `POST /admin/suggestions/reject` | the raw JSON request body |
| `admin-suggestion-link` | `POST /admin/suggestions/link` | the raw JSON request body |

**Normalization rules** (shared by the worker and the public-web client `member.js`; both MUST behave identically):

- `normalizeActUrl(raw)`: trim; parse as a URL; only `http:` and `https:` are accepted (anything else, unparsable input or a non-string → invalid). Result is `scheme + "//" + host[:port] + path`, with the query, the fragment and all trailing slashes removed. Scheme and host are lower-cased and a default port is dropped (standard URL parsing). Example: `HTTPS://Band.Example/Tour/?x=1#top` → `https://band.example/Tour`; `https://band.example/` → `https://band.example`.
- `normalizeName(raw)`: Unicode NFD, remove combining marks, lower-case, then remove every character that is not a letter or a digit. Example: `Sigur Rós!` → `sigurros`.
- `act_url_b64` in paths is base64url (alphabet `A-Z a-z 0-9 - _`, no padding) of the UTF-8 URL; anything outside the alphabet or not valid UTF-8 is invalid.

---

## 4. Geospatial Query Algorithm

### 4.1 Geohash Algorithm

Events are indexed using geohash strings at two precisions:

- **geohash5**: Precision 5 (~4.9km × 4.9km cells)
- **geohash6**: Precision 6 (~1.2km × 1.2km cells)

**Geohash Encoding:**

- Uses base32 alphabet: `0123456789bcdefghjkmnpqrstuvwxyz`
- Interleaves longitude and latitude bits
- Reference implementation: [geohash.org algorithm](http://geohash.org/)

**Required Functions:**

1. `encode(lat: float, lng: float, precision: int) -> string`
   - Returns geohash string at specified precision

2. `neighbors(geohash: string) -> string[]`
   - Returns 8 neighboring geohashes (N, S, E, W, NE, NW, SE, SW)
   - Total coverage: 9 cells (center + 8 neighbors)

### 4.2 Dynamic Precision Selection

Choose geohash precision based on search radius to optimize query performance:

| Search Radius (km) | Precision | Cell Size | Coverage Area (9 cells) |
|--------------------|-----------|-----------|--------------------------|
| ≤ 5                | 6         | ~1.2km    | ~3.6km radius            |
| 5 < r ≤ 15         | 5         | ~4.9km    | ~15km radius             |
| 15 < r ≤ 50        | 4         | ~39km     | ~117km radius            |
| 50 < r ≤ 200       | 3         | ~156km    | ~468km radius            |
| > 200              | 2         | ~1250km   | ~3750km radius           |

### 4.3 Geospatial Query Execution

**Input Parameters:**
- `lat`, `lng`: Query center coordinates
- `radius`: Search radius in kilometers
- `from`, `to`: Time range (ISO 8601 format)
- `category` (optional): Filter by category

**Algorithm:**

1. **Determine precision** using table in 4.2
2. **Encode center point**: `center_hash = geohash_encode(lat, lng, precision)`
3. **Get neighbors**: `hashes = [center_hash] + neighbors(center_hash)` (9 hashes total)
4. **Build SQL query:**

   **For precision 5:**
   ```sql
   SELECT * FROM events
   WHERE geohash5 IN (?, ?, ?, ?, ?, ?, ?, ?, ?)
   AND start_time >= ?
   AND start_time <= ?
   [AND category = ?]
   ORDER BY start_time ASC
   LIMIT 100
   ```

   **For precision 6:**
   ```sql
   SELECT * FROM events
   WHERE geohash6 IN (?, ?, ?, ?, ?, ?, ?, ?, ?)
   AND start_time >= ?
   AND start_time <= ?
   [AND category = ?]
   ORDER BY start_time ASC
   LIMIT 100
   ```

   **For precision 2, 3, 4 (prefix matching on geohash5):**
   ```sql
   SELECT * FROM events
   WHERE (geohash5 LIKE ? OR geohash5 LIKE ? OR ... [9 conditions])
   AND start_time >= ?
   AND start_time <= ?
   [AND category = ?]
   ORDER BY start_time ASC
   LIMIT 100
   ```
   (Use `hash + '%'` for LIKE patterns)

5. **Post-filter by actual distance:**
   - For each result, compute Haversine distance from query center
   - Keep only events where `distance <= radius`

6. **Parse tags field:** Convert JSON string to array for each event

### 4.4 Haversine Distance Formula

```
R = 6371  # Earth's radius in km

dLat = toRadians(lat2 - lat1)
dLng = toRadians(lng2 - lng1)

a = sin(dLat/2)² + cos(toRadians(lat1)) * cos(toRadians(lat2)) * sin(dLng/2)²
c = 2 * atan2(sqrt(a), sqrt(1-a))
distance = R * c
```

Returns distance in kilometers.

---

## 5. Duplicate Event Detection

### 5.1 Two-Stage Pipeline

Before inserting a new event, the worker queries for candidate events in the same geohash6 cell within a ±2 hour window, then runs each candidate through a two-stage pipeline:

**Stage 1 — Fast gates (no LLM call):**

1. **Location gate**: haversine distance > 500 metres → not a duplicate (skip to next candidate)
2. **Time gate**: `|start_time delta|` > 1 hour → not a duplicate (skip to next candidate)
3. **Levenshtein fast path**: title similarity ≥ 0.9 → **DUPLICATE** (return immediately, no LLM call needed)

**Stage 2 — LLM check (if `LLM_API_KEY` is configured):**

4. Call the configured LLM with the title, description, **and geo+time context** (distance in metres, start-time delta in minutes). Providing this context is critical: the LLM must know the events are already co-located and concurrent so it can properly weigh title differences (e.g. same festival name with different subtitles). The LLM returns a JSON response of the form `{"probability": <float>}`.
   - Probability ≥ 0.7 → **DUPLICATE**
   - Any LLM error (network failure, malformed response, etc.) → fall through to structural fallback

**Fallback (if `LLM_API_KEY` is not configured, or on LLM error):**

5. **Structural match** — flag as DUPLICATE if either:
   - Levenshtein similarity ≥ 0.8, **or**
   - Common-prefix ratio ≥ 0.45 (prefix length / shorter-title length). Catches "Name - Subtitle A" vs "Name - Subtitle B" patterns that score low on Levenshtein.

**Algorithm:**

```python
def are_events_similar(event1, event2, llm_provider=None) -> bool:
    # Stage 1a: Location gate
    distance_km = haversine_distance(event1.lat, event1.lng, event2.lat, event2.lng)
    if distance_km > 0.5:
        return False

    # Stage 1b: Time gate
    time_diff_seconds = abs(parse_iso8601(event1.start_time) - parse_iso8601(event2.start_time))
    if time_diff_seconds > 3600:  # 1 hour
        return False

    # Stage 1c: Levenshtein fast path (high-confidence match, skip LLM)
    similarity = string_similarity(event1.title, event2.title)
    if similarity >= 0.9:
        return True

    # Structural match used as fallback (no LLM, or on LLM error)
    prefix_ratio = common_prefix_ratio(event1.title, event2.title)
    structural_match = similarity >= 0.8 or prefix_ratio >= 0.45

    # Stage 2: LLM check — include geo+time context so the model knows
    # these events are already co-located and concurrent
    if llm_provider is not None:
        try:
            time_delta_minutes = time_diff_seconds / 60
            result = llm_provider.check_duplicate(event1, event2,
                context={"distance_km": distance_km, "time_delta_minutes": time_delta_minutes})
            return result["probability"] >= 0.7
        except Exception:
            return structural_match  # fall back to structural checks on error

    return structural_match
```

### 5.2 String Similarity (Levenshtein Distance)

```python
def string_similarity(str1: str, str2: str) -> float:
    """Returns similarity ratio between 0.0 and 1.0 (1.0 = identical)"""
    s1 = str1.lower()
    s2 = str2.lower()

    # Compute Levenshtein distance
    distance = levenshtein_distance(s1, s2)

    # Convert to similarity ratio
    max_len = max(len(s1), len(s2))
    if max_len == 0:
        return 1.0

    return 1.0 - (distance / max_len)

def levenshtein_distance(s1: str, s2: str) -> int:
    """Standard dynamic programming implementation"""
    len1, len2 = len(s1), len(s2)
    matrix = [[0] * (len2 + 1) for _ in range(len1 + 1)]

    for i in range(len1 + 1):
        matrix[i][0] = i
    for j in range(len2 + 1):
        matrix[0][j] = j

    for i in range(1, len1 + 1):
        for j in range(1, len2 + 1):
            cost = 0 if s1[i-1] == s2[j-1] else 1
            matrix[i][j] = min(
                matrix[i-1][j] + 1,      # deletion
                matrix[i][j-1] + 1,      # insertion
                matrix[i-1][j-1] + cost  # substitution
            )

    return matrix[len1][len2]
```

### 5.3 Common-Prefix Ratio

```python
def common_prefix_ratio(a: str, b: str) -> float:
    """
    Returns the length of the shared leading prefix divided by the shorter
    string's length (both lowercased).  Catches "Main Title - Subtitle A" vs
    "Main Title - Subtitle B" patterns that Levenshtein scores poorly because
    the suffixes differ entirely.

    Example: "Shagoo Shagoo - Festa di Apertura" vs
             "Shagoo Shagoo - Music Festival Bucolico Indipendente"
      → common prefix "shagoo shagoo - " = 16 chars
      → shorter title = 33 chars → ratio = 0.485 ≥ 0.45 → structural match
    """
    s1, s2 = a.lower(), b.lower()
    i = 0
    while i < len(s1) and i < len(s2) and s1[i] == s2[i]:
        i += 1
    return i / min(len(s1), len(s2)) if min(len(s1), len(s2)) > 0 else 0.0
```

### 5.5 Duplicate Check Query

Before inserting an event, query the geohash6 cell of the new event **and its 8 neighbors** (9 cells total). This avoids missing duplicates whose coordinates land just across a cell boundary.

```sql
SELECT id, title, description, lat, lng, start_time
FROM events
WHERE geohash6 IN (?, ?, ?, ?, ?, ?, ?, ?, ?)   -- center + 8 neighbors
AND start_time BETWEEN ? AND ?
```

Where:
- `geohash6` cells = `[center_cell] + neighbors(center_cell)` (9 hashes)
- Time range: `[event.start_time - 2 hours, event.start_time + 2 hours]`

Then apply `are_events_similar()` to each result.

**Rejection Response (HTTP 409 Conflict):**

```json
{
  "error": "Duplicate event",
  "message": "A similar event already exists in the database",
  "existing_event_id": "<event_id>"
}
```

### 5.6 Environment Variables and Secrets

**Allowlist:**

| Variable | Description | Default |
|---|---|---|
| `ALLOWED_PUBKEYS` | Comma-separated Ed25519 public keys (hex) permitted to publish events via `POST /events`. When set, any pubkey not in the list is rejected with `403 Forbidden`. When absent, any valid signature is accepted. Should always include the crawler CLI's `CRAWLER_PUBKEY` for automated publishing. Set via `wrangler secret put ALLOWED_PUBKEYS`. | — (all valid signatures accepted) |

**LLM duplicate detection:**

| Variable | Description | Default |
|---|---|---|
| `LLM_API_KEY` | API key for the LLM provider. If not set, LLM duplicate detection is disabled and the structural fallback (Levenshtein ≥ 0.8 or common-prefix ratio ≥ 0.45) is used. Set via `wrangler secret put LLM_API_KEY`. | — |
| `LLM_PROVIDER` | LLM provider name: `openai`, `anthropic`, or `openrouter`. Set via `wrangler secret put LLM_PROVIDER`. | see `shared/llm/defaults.ts` |
| `LLM_MODEL` | Optional model override. If not set, the default in `shared/llm/defaults.ts` is used. Set via `wrangler secret put LLM_MODEL`. | — |

---

## 6. Event ID Generation

Event IDs are deterministic SHA-256 hashes of canonical event data.

**Canonical Event Data (for ID generation):**

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
  "category": "<string>",
  "tags": [<array>],
  "created_at": "<ISO 8601>"
}
```

**Algorithm:**

```python
def generate_event_id(event_data: dict) -> str:
    # Normalize optional fields
    normalized = {
        "pubkey": event_data["pubkey"],
        "title": event_data["title"],
        "description": event_data.get("description", ""),
        "url": event_data.get("url", ""),
        "venue_name": event_data.get("venue_name", ""),
        "address": event_data.get("address", ""),
        "lat": event_data["lat"],
        "lng": event_data["lng"],
        "start_time": event_data["start_time"],
        "end_time": event_data.get("end_time"),
        "category": event_data["category"],
        "tags": event_data.get("tags", []),
        "created_at": event_data["created_at"]
    }

    # Serialize to canonical JSON
    canonical_json = json.dumps(normalized, sort_keys=False, separators=(',', ':'))

    # Compute SHA-256 hash
    hash_bytes = sha256(canonical_json.encode('utf-8'))
    return hash_bytes.hex()  # 64 hex characters
```

**Critical:** The JSON serialization MUST use the exact key order shown above.

---

## 7. API Endpoints Specification

### 7.1 CORS Headers

All responses MUST include:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-Pubkey, X-Signature, X-Timestamp
```

`X-Pubkey`, `X-Signature` and `X-Timestamp` carry the authentication of the member and admin member/suggestion endpoints (section 3.6).

OPTIONS requests return `200 OK` with CORS headers and empty body.

### 7.2 GET / (API Information)

**Request:**
```
GET /
```

**Response (200 OK):** A JSON object listing the available endpoints and their parameters. The listing includes the member endpoints (`GET /member/me`, `POST|DELETE /member/bands/:act_url_b64`, `POST /member/suggestions`); the admin endpoints are not listed.

### 7.3 GET /stats

**Request:**
```
GET /stats
```

**Response (200 OK):**

```json
{
  "total_events": 1234,
  "last_event_at": "2026-04-15T20:00:00"
}
```

Returns the total event count and the `created_at` timestamp of the most recently added event.

### 7.4 GET /events (Query Events)

**Request:**
```
GET /events?lat=45.464&lng=9.189&radius=10&from=2026-03-06T00:00:00&to=2026-03-13T23:59:59&category=Music
```

**Query Parameters:**

| Parameter      | Required | Type   | Default              | Description                          |
|----------------|----------|--------|----------------------|--------------------------------------|
| `lat`          | See note | float  | —                    | Latitude (-90 to 90)                 |
| `lng`          | See note | float  | —                    | Longitude (-180 to 180)              |
| `radius`       | No       | float  | 10                   | Search radius in km                  |
| `from`         | No       | string | now                  | ISO 8601 start time                  |
| `to`           | No       | string | now + 7 days         | ISO 8601 end time                    |
| `category`     | No       | string | —                    | Filter by category                   |
| `festival_url` | No       | string | —                    | Filter by festival (returns all events linked to this festival URL) |
| `has_festival` | No       | string | —                    | `1` restricts results to events with a non-empty `festival_url` (radar entries). Any other value is ignored. |
| `act_url`      | No       | string | —                    | Filter to one band by canonical site URL (one trailing slash stripped; exact match) |
| `has_act`      | No       | string | —                    | `1` keeps only band shows (non-empty `act_url`); `0` excludes them. Any other value is ignored. |
| `q`            | No       | string | —                    | Keyword; filters to events whose title, description, or tags contain the value (case-insensitive substring match); absent or empty means no text filter |
| `pubkey`       | No       | string | —                    | Filter by author public key (64 hex chars) |
| `format`       | No       | string | —                    | `ical` to return iCal feed instead of JSON |
| `window`       | No       | string | —                    | Rolling time window, e.g. `30d`, `7d`; sets `from=now`, `to=now+window`; overrides `from`/`to` when both present; defaults to `30d` when `format=ical` |
| `offset`       | No       | int    | 0                    | Pagination offset for no-geo queries |

**Parameter requirements:**
- `lat` and `lng` must always be provided together.
- When neither `lat`/`lng` nor `pubkey` is provided, the endpoint returns all events (admin/browse use case) with pagination via `offset`, up to 100 results per page, ordered by `start_time ASC`. Optional `from`, `to`, and `category` filters apply.
- When `pubkey` is provided **without** `lat`/`lng`, all events by that author are returned (no geo filtering), ordered by `start_time ASC`, up to 100 results.
- `pubkey` can be combined with geo params (`lat`/`lng`/`radius`) and time/category filters.
- `festival_url` and `has_festival` compose with every path (geo, pubkey-only, and no-geo browse) and with all other filters (AND semantics). The `pubkey` + `festival_url` combination is the radar crawler's update lookup.
- `act_url` and `has_act` compose with every path and with all other filters (AND semantics). The tour crawler's lookup is `pubkey` + `act_url`. `has_act=0` is passed by the general browse pages so band shows stay out of their results. `idx_act_url` covers `act_url` lookups; no index is needed for `has_act`.
- `has_festival` needs no dedicated index at radar scale (hundreds of rows); `idx_festival_url` already covers `festival_url` lookups. If `has_festival` ever slows, the remedy is a partial index: `CREATE INDEX idx_festival_time ON events (festival_url, start_time) WHERE festival_url IS NOT NULL`.

**Time overlap semantics:** Returns all events that overlap with the `[from, to]` window. Specifically:
- Events with an `end_time`: included if `start_time <= to` AND `end_time >= from`
- Events without an `end_time`: included if `start_time` falls within `[from, to]`

This ensures ongoing multi-day events (e.g. a festival that started before `from` but ends after it) appear in results.

**Response (200 OK):**

```json
{
  "events": [
    {
      "id": "<64 hex chars>",
      "pubkey": "<64 hex chars>",
      "signature": "<128 hex chars>",
      "title": "Jazz Night at Blue Note",
      "description": "Live jazz performance...",
      "url": "https://example.com/event",
      "venue_name": "Blue Note Milano",
      "address": "Via Borsieri 37, Milano",
      "lat": 45.4898,
      "lng": 9.1915,
      "geohash5": "u0nd8",
      "geohash6": "u0nd8h",
      "start_time": "2026-03-15T21:00:00",
      "end_time": "2026-03-15T23:30:00",
      "category": "Music",
      "tags": ["jazz", "live music"],
      "created_at": "2026-03-01T10:30:00",
      "updated_at": null
    }
  ]
}
```

**iCal Response (200 OK, when `format=ical`):**

Returns `Content-Type: text/calendar; charset=utf-8` with a `VCALENDAR` body (RFC 5545).

Field mapping:

| Tokoro field | iCal property | Notes |
|---|---|---|
| `title` | `SUMMARY` | Prefixed with `festival_name + ": "` if present |
| `description` | `DESCRIPTION` | |
| `start_time` | `DTSTART` | Floating local time (no TZID) |
| `end_time` | `DTEND` | Omitted if missing |
| `venue_name` + `address` | `LOCATION` | Joined with `", "` |
| `lat` + `lng` | `GEO` | Format: `GEO:lat;lng` |
| `url` | `URL` | |
| `id` | `UID` | Suffixed with `@tokoro` |
| `created_at` | `DTSTAMP` | |
| `category` | `CATEGORIES` | |

Calendar metadata: `PRODID:-//Tokoro//Events//EN`, `X-WR-CALNAME` set to a human-readable query summary.

**All-day events:** Events whose duration (`end_time − start_time`) is ≥ 7 hours are emitted as all-day events using `DTSTART;VALUE=DATE` / `DTEND;VALUE=DATE` (iCal exclusive-end convention: DTEND = day after end date). This applies to full-day festivals, conferences, and similar long-running events.

**Error Responses:**

- `400 Bad Request`: Invalid `lat`/`lng` values (when geo params are provided but not parseable as floats)

### 7.5 POST /events (Create Event)

**Request:**

```json
POST /events

{
  "pubkey": "<64 hex chars>",
  "signature": "<128 hex chars>",
  "title": "Jazz Night at Blue Note",
  "description": "Live jazz performance...",
  "url": "https://example.com/event",
  "venue_name": "Blue Note Milano",
  "address": "Via Borsieri 37, Milano",
  "lat": 45.4898,
  "lng": 9.1915,
  "start_time": "2026-03-15T21:00:00",
  "end_time": "2026-03-15T23:30:00",
  "category": "Music",
  "tags": ["jazz", "live music"],
  "created_at": "2026-03-01T10:30:00"
}
```

Optional unsigned metadata fields `festival_name`, `festival_url`, `act_name` and `act_url` may also be supplied. They are stored as given, are not part of the signed canonical object, and are not included in the event id.

**Processing Steps:**

1. Validate required fields: `pubkey`, `signature`, `title`, `lat`, `lng`, `start_time`, `category`
2. Check if `pubkey` is in the `blocklist` table — return `403 Forbidden` if blocked
3. Check `ALLOWED_PUBKEYS` allowlist — return `403 Forbidden` if pubkey is not in the list (skip if not configured)
4. Verify Ed25519 signature (see section 3.2)
5. Generate geohash5 and geohash6 from coordinates
6. Check for duplicate events (see section 5)
7. Generate event ID (see section 6)
8. Convert `tags` array to JSON string for storage
9. Insert into database

**Response (201 Created):**

```json
{
  "id": "<64 hex chars>",
  "message": "Event created successfully"
}
```

**Error Responses:**

- `400 Bad Request`: Missing required fields
  ```json
  { "error": "Missing required fields" }
  ```

- `401 Unauthorized`: Invalid signature
  ```json
  { "error": "Invalid signature" }
  ```

- `403 Forbidden`: Pubkey is blocklisted, or pubkey not in `ALLOWED_PUBKEYS` allowlist
  ```json
  { "error": "Forbidden" }
  // or, for allowlist rejection:
  { "error": "Forbidden", "message": "Public key not in allowlist" }
  ```

- `409 Conflict`: Duplicate event detected
  ```json
  {
    "error": "Duplicate event",
    "message": "A similar event already exists in the database",
    "existing_event_id": "<event_id>"
  }
  ```

### 7.6 DELETE /events/:id (Delete Event)

**Request:**

```json
DELETE /events/<event_id>

{
  "pubkey": "<64 hex chars>",
  "signature": "<128 hex chars>"
}
```

**Processing Steps:**

1. Verify delete signature (see section 3.3)
2. Check if `pubkey` is in the `blocklist` table — return `403 Forbidden` if blocked
3. Check if event exists
4. **Admin bypass:** If `pubkey === ADMIN_PUBKEY`, skip ownership check and proceed to deletion. Otherwise, verify event belongs to `pubkey`.
5. Delete event from database

**Admin delete behavior:**
- `ADMIN_PUBKEY` is a Cloudflare Worker secret (set via `wrangler secret put ADMIN_PUBKEY`).
- Value: the admin's Ed25519 public key (64 hex chars).
- Signature verification still runs for admin deletes (admin must sign the event ID with their private key, as per section 3.3).
- When `ADMIN_PUBKEY` is not configured, admin bypass is unavailable but normal user deletes still work.
- If `ADMIN_PUBKEY` is not set and an admin-only feature is invoked, return `503 Service Unavailable`.

**Response (200 OK):**

```json
{
  "message": "Event deleted successfully"
}
```

**Error Responses:**

- `400 Bad Request`: Missing pubkey or signature
- `401 Unauthorized`: Invalid signature
- `403 Forbidden`: Unauthorized (event doesn't belong to this pubkey, or pubkey is blocklisted)
- `404 Not Found`: Event not found

### 7.7 PUT /events/:id (Edit Own Event)

**Request:** same JSON body as `POST /events` — the full event including `pubkey`, `signature`, and `created_at`. The signature is computed over the same canonical event data as POST (section 3.2), so editing requires re-signing.

**Verification order:**

1. Event lookup by `:id` → `404 Not Found` if absent.
2. Field validation (same required fields as POST, plus `created_at`) → `400`.
3. `body.pubkey` must equal the stored event's `pubkey` → `403 Forbidden` otherwise. No admin bypass (admin edit is not a feature; admin delete exists).
4. `body.created_at` must equal the stored `created_at` → `400` (`created_at` is immutable and signed; a mismatch means the client signed the wrong canonical data).
5. Blocklist and allowlist checks, as on POST → `403`.
6. Ed25519 signature verification → `401 Unauthorized`.

**Behavior:** all mutable columns are updated (`signature`, `title`, `description`, `url`, `venue_name`, `address`, `lat`, `lng`, `geohash5`/`geohash6` recomputed, `start_time`, `end_time`, `category`, `tags`, `festival_name`, `festival_url`, `act_name`, `act_url`); `updated_at` is set server-side to the current time. `id` and `created_at` never change. `festival_name`, `festival_url`, `act_name` and `act_url` are unsigned metadata and are not included in the event id. **No duplicate detection runs on PUT** — the event already exists and is being edited by its owner.

**Success Response (200):**

```json
{ "id": "<event id>", "message": "Event updated successfully" }
```

### 7.7.1 POST /events/:id/act (Attach an act to an existing event)

**Purpose:** lets the band-tours crawler link a show to its band (`act_name`, `act_url`) when the duplicate check rejected the show's own publication because an equivalent event already exists. The event may belong to a different key; `act_name` and `act_url` are unsigned metadata, so tagging does not touch the owner's signed data. (Numbered 7.7.1 to avoid renumbering the sections that follow.)

**Request:**

```json
POST /events/<event_id>/act

{
  "pubkey": "<64 hex chars>",
  "signature": "<128 hex chars>",
  "act_name": "<band name>",
  "act_url": "<band page URL>"
}
```

The signature is described in section 3.5. The CORS methods in section 7.1 already include `POST`; no change was needed.

**Validation (no I/O, all `400 Bad Request`):**

1. Body must be a JSON object (`Invalid JSON` if it cannot be parsed, `Invalid body` if not an object)
2. `pubkey` is 64 hex characters and `signature` is 128 hex characters (`Missing or malformed pubkey or signature`)
3. `act_name` is a string that is non-empty after trimming, at most 200 characters
4. `act_url` is a non-empty string of at most 500 characters that parses as an absolute `http:` or `https:` URL
5. Values are used exactly as sent (not trimmed or rewritten), because the signature covers those exact strings

**Check order:**

1. Body validation → `400`
2. `pubkey` in the `blocklist` table → `403 {"error": "Forbidden"}`
3. If `ALLOWED_PUBKEYS` is configured and `pubkey` is not in it (comparison trimmed and case-insensitive) → `403 {"error": "Forbidden", "message": "Public key not in allowlist"}`
4. Act signature verification → `401 {"error": "Invalid signature"}`
5. Event lookup by `:id` → `404 {"error": "Event not found"}`
6. Decision on the event's current `act_url` (compared after trimming and ignoring one trailing `/`):
   - empty or null → adopt
   - equal to the request's `act_url` → already adopted
   - different → `409 {"error": "Event already belongs to another act"}`

Signature verification precedes the event lookup, so an unauthenticated caller cannot probe which event IDs exist.

**Success Responses (200):**

```json
{ "id": "<event id>", "adopted": true }
```

```json
{ "id": "<event id>", "adopted": false, "already": true }
```

The second form is returned when the event already carries the same act (repeat requests are idempotent and write nothing).

**What changes:** only `act_name` and `act_url` are written. The endpoint never overwrites an existing act. `signature`, `created_at` and `updated_at` are left untouched, and the event remains valid because these fields are not part of the signed event data.

**Trust model:** any allowlisted key may tag any untagged event, regardless of who published it, so the allowlist is the access control. `ALLOWED_PUBKEYS` MUST be set in production; when it is not set, any non-blocklisted key with a valid signature can attach an act to any event that has none.

### 7.8 GET /admin/blocklist (List Blocklisted Pubkeys)

**Request:**
```
GET /admin/blocklist
```

Unauthenticated. Returns the full blocklist.

> **Note:** This endpoint is intentionally unauthenticated. The blocklist is not sensitive data — the admin page uses it to display currently blocked keys without requiring the admin private key for read operations.

**Response (200 OK):**

```json
[
  {
    "pubkey": "<64 hex chars>",
    "created_at": "2026-03-25T12:00:00"
  }
]
```

### 7.9 POST /admin/blocklist (Add Pubkey to Blocklist)

**Request:**

```json
POST /admin/blocklist

{
  "pubkey": "<ADMIN_PUBKEY — 64 hex chars>",
  "signature": "<128 hex chars>",
  "target_pubkey": "<pubkey to block — 64 hex chars>"
}
```

**Processing Steps:**

1. Verify that `pubkey === ADMIN_PUBKEY`; if `ADMIN_PUBKEY` is not configured, return `503`.
2. Verify Ed25519 signature over `SHA-256("blocklist:" + target_pubkey)` (see section 3.4).
3. Reject with `400 Bad Request` if `target_pubkey === ADMIN_PUBKEY` (cannot block the admin key).
4. Insert `(target_pubkey, now)` into `blocklist` table (idempotent — no error if already present).

**Response (201 Created):**

```json
{ "message": "Pubkey blocked", "pubkey": "<target_pubkey>" }
```

**Error Responses:**

- `400 Bad Request`: Missing fields, or `target_pubkey === ADMIN_PUBKEY`
- `401 Unauthorized`: Invalid signature
- `403 Forbidden`: `pubkey` is not `ADMIN_PUBKEY`
- `503 Service Unavailable`: `ADMIN_PUBKEY` secret not configured

### 7.10 DELETE /admin/blocklist/:pubkey (Remove Pubkey from Blocklist)

**Request:**

```json
DELETE /admin/blocklist/<target_pubkey>

{
  "pubkey": "<ADMIN_PUBKEY — 64 hex chars>",
  "signature": "<128 hex chars>"
}
```

**Processing Steps:**

1. Verify that `pubkey === ADMIN_PUBKEY`; if `ADMIN_PUBKEY` is not configured, return `503`.
2. Verify Ed25519 signature over `SHA-256("blocklist:" + :pubkey)` (the URL path param, see section 3.4).
3. Delete the row from `blocklist` where `pubkey = :pubkey` (idempotent — no error if not present).

**Response (200 OK):**

```json
{ "message": "Pubkey unblocked", "pubkey": "<pubkey>" }
```

**Error Responses:**

- `400 Bad Request`: Missing fields
- `401 Unauthorized`: Invalid signature
- `403 Forbidden`: `pubkey` is not `ADMIN_PUBKEY`
- `503 Service Unavailable`: `ADMIN_PUBKEY` secret not configured

### 7.11 Member Endpoints

Members are people the admin has given a personal key (section 7.12) so they can follow tracked bands on the tours page and suggest new ones. All three endpoints are signed as described in section 3.6 and require an active member (`403` for an unknown or revoked key). The request paths are matched exactly; any other method or path under `/member/` returns `404 {"error": "Not found"}`.

#### 7.11.1 GET /member/me

**Request:** `GET /member/me`, signed with domain `member-read` over `/member/me`.

**Response (200 OK):** everything the page needs in one call.

```json
{
  "name": "Anna",
  "bands": ["https://band.example", "https://other.example/live"],
  "suggestions": [
    {
      "id": 12,
      "name": "Some Band",
      "url": "https://someband.example",
      "status": "pending",
      "act_url": null,
      "reject_reason": null,
      "created_at": "2026-10-13T10:00:00"
    }
  ]
}
```

- `bands`: the member's followed normalized band URLs, oldest follow first (ties by URL).
- `suggestions`: all of the member's suggestions in any status, newest first (`id` descending).

**Error Responses:** `401` (section 3.6), `403 {"error": "Forbidden", "message": "Not an active member"}`.

#### 7.11.2 POST /member/bands/:act_url_b64 (Follow) and DELETE /member/bands/:act_url_b64 (Unfollow)

`:act_url_b64` is the base64url-encoded band site URL (section 3.6).

**Processing Steps:**

1. Decode the path parameter and apply `normalizeActUrl`. If decoding fails or the URL is not http(s) → `400 {"error": "Invalid band url"}` (checked before authentication).
2. Verify the request (section 3.6) with domain `band-follow` (POST) or `band-unfollow` (DELETE) over the normalized URL.
3. POST inserts `(pubkey, act_url, now)` into `member_bands` if not present; DELETE removes the row if present. Both are idempotent.

**Response (200 OK):**

```json
{ "act_url": "<normalized url>" }
```

**Error Responses:** `400` (invalid band URL), `401`, `403`.

#### 7.11.3 POST /member/suggestions (Suggest a Band)

**Request:**

```json
POST /member/suggestions

{ "name": "Some Band", "url": "https://someband.example" }
```

`url` is optional. The request is signed with domain `band-suggest` over the raw body.

**Processing Steps:**

1. Verify the request (section 3.6, including the order of checks for endpoints with a body: `413` for a body over 8 KB); authentication happens before the body is parsed.
2. Parse the body: not JSON → `400 {"error": "Invalid JSON"}`; not a JSON object → `400 {"error": "Invalid body"}`.
3. `name` is trimmed; if it is empty, longer than 120 characters, or contains no letter or digit (`normalizeName` is empty) → `400 {"error": "name is required (1-120 characters)"}`.
4. If `url` is present and not `null` or `""`, it is normalized with `normalizeActUrl`; if invalid, or longer than 500 characters once normalized → `400 {"error": "url must be an http(s) URL (max 500 characters)"}`. The normalized form is stored.
5. If the same member already has a **pending** suggestion whose `normalizeName` equals this one, return `200 {"id": <existing id>, "duplicate": true}` and store nothing. Different members may suggest the same band. There is no cap on the number of suggestions.
6. Otherwise insert a row with `status = 'pending'` and `created_at = now`.

**Response (201 Created):**

```json
{ "id": 12 }
```

**Error Responses:** `400`, `401`, `403`, `413`.

### 7.12 Admin Member Endpoints

All admin endpoints in sections 7.12-7.14 are signed as described in section 3.6 by `ADMIN_PUBKEY` (`503` when it is not configured, `403 {"error": "Unauthorized"}` for any other valid key). The endpoints with a body (create member, reject, link) follow the order of checks of section 3.6 and answer `413` for a body over 8 KB. The member's private key is generated on the admin page and never sent to the worker; only the public key and a display name are stored.

#### 7.12.1 GET /admin/members (List Members)

Signed with domain `admin-read` over `/admin/members`.

**Response (200 OK):** newest member first (ties by name).

```json
[
  {
    "pubkey": "<64 hex chars>",
    "name": "Anna",
    "created_at": "2026-10-13T10:00:00",
    "revoked_at": null,
    "band_count": 3
  }
]
```

#### 7.12.2 POST /admin/members (Create Member)

**Request:** signed with domain `admin-member` over the raw body.

```json
POST /admin/members

{ "pubkey": "<member public key — 64 hex chars>", "name": "Anna" }
```

**Processing Steps:**

1. Verify the request (section 3.6).
2. Body not a JSON object → `400 {"error": "Invalid JSON"}`.
3. `pubkey` is lower-cased; not 64 hex chars → `400 {"error": "pubkey must be 64 hex characters"}`.
4. `name` is trimmed; empty or longer than 60 characters → `400 {"error": "name is required (1-60 characters)"}`.
5. `pubkey === ADMIN_PUBKEY` → `400 {"error": "Cannot register the admin key as a member"}`.
6. Pubkey already in `members` (active or revoked) → `409 {"error": "Member already exists"}`.
7. Insert `(pubkey, name, now)`.

**Response (201 Created):**

```json
{ "pubkey": "<64 hex chars>", "name": "Anna" }
```

#### 7.12.3 POST /admin/members/:pubkey/revoke (Revoke Member)

Signed with domain `admin-member-revoke` over the lower-cased `:pubkey`. Sets `revoked_at = now` if the member is not already revoked (a second revoke keeps the first time). A revoked member gets `403` on every member endpoint; its follows and suggestions are kept.

**Response (200 OK):** `{ "message": "Member revoked", "pubkey": "<pubkey>" }`

**Error Responses:** `401`, `403`, `404 {"error": "Member not found"}`, `503`.

#### 7.12.4 DELETE /admin/members/:pubkey (Delete Member)

Signed with domain `admin-member-delete` over the lower-cased `:pubkey`. Deletes the member's rows from `member_bands`, then `band_suggestions`, then `members`. The three deletes run as separate statements, not in one transaction: if the request fails half-way, some rows may be gone while the member remains; repeating the delete completes it (each statement is idempotent).

**Response (200 OK):** `{ "message": "Member deleted", "pubkey": "<pubkey>" }`

**Error Responses:** `401`, `403`, `404 {"error": "Member not found"}`, `503`.

### 7.13 Admin Suggestion Endpoints

#### 7.13.1 GET /admin/suggestions (Grouped Suggestions)

**Request:** `GET /admin/suggestions?status=<pending|rejected|linked>&detail=1`, signed with domain `admin-read` over `/admin/suggestions` (the query string is not signed).

- `status`: default `pending`; any other value than the three statuses → `400 {"error": "Invalid status"}`.
- `detail=1`: adds the names of the members who made the suggestions. Without it, only counts are returned.

**Grouping:** suggestions with the given status are grouped by `normalizeName(name)`.

**Response (200 OK):**

```json
[
  {
    "key": "someband",
    "name_variants": ["Some Band", "some band"],
    "urls": ["https://someband.example"],
    "members": 2,
    "ids": [12, 15],
    "created_at": "2026-10-13T10:00:00",
    "member_names": ["Anna", "Ben"]
  }
]
```

- `name_variants`: the distinct spellings, most frequent first (ties alphabetical).
- `urls`: the distinct normalized URLs given by members (may be empty).
- `members`: number of distinct members in the group.
- `ids`: all suggestion ids in the group, ascending.
- `created_at`: the earliest suggestion in the group.
- `member_names`: only with `detail=1`.
- Order: most members first, then oldest `created_at`, then `key`.

#### 7.13.2 POST /admin/suggestions/reject (Reject Suggestions)

**Request:** signed with domain `admin-suggestion-reject` over the raw body.

```json
POST /admin/suggestions/reject

{ "ids": [12, 15], "reason": "Not touring in Europe" }
```

**Processing Steps:**

1. `ids` must be a non-empty array of at most 200 positive integers (a body that is not a JSON object also fails here) → else `400 {"error": "ids must be a non-empty list of ids"}`.
2. `reason` is optional and trimmed; longer than 200 characters → `400 {"error": "reason is limited to 200 characters"}`. An empty reason is stored as `NULL`.
3. Each **pending** suggestion among `ids` becomes `status = 'rejected'` with `reject_reason`. Unknown ids and suggestions in another status are skipped.

**Response (200 OK):** `{ "updated": <number of suggestions changed> }`

#### 7.13.3 POST /admin/suggestions/link (Link Suggestions to a Tracked Band)

For suggestions that name a band already tracked under another name or URL.

**Request:** signed with domain `admin-suggestion-link` over the raw body.

```json
POST /admin/suggestions/link

{ "ids": [12, 15], "act_url": "https://band.example" }
```

**Processing Steps:**

1. `ids` validated as in 7.13.2.
2. `act_url` normalized with `normalizeActUrl`; invalid, or longer than 500 characters once normalized → `400 {"error": "act_url must be an http(s) URL (max 500 characters)"}`.
3. For each id that exists and is not already `linked` (pending **or rejected**): set `status = 'linked'` and `act_url`, and follow `act_url` for the suggesting member (insert into `member_bands` if not present). Unknown and already linked ids are skipped.

The follow and the status change run as separate statements (follow first, then `linked`), not in one transaction, and the ids are processed one by one. If the request fails half-way, the suggestions not yet marked `linked` are still pending or rejected, so repeating the same request completes them (the follow is idempotent).

**Response (200 OK):** `{ "updated": <number of suggestions linked> }`

### 7.14 GET /admin/band-followers (Follower Counts)

Signed with domain `admin-read` over `/admin/band-followers`. A demand signal: counts only, never member names.

Only follows of active members count: follows of revoked members (`revoked_at` set) are left out, and a band followed only by revoked members does not appear. (`band_count` in `GET /admin/members` still counts every follow of each member, revoked or not.)

**Response (200 OK):** most followed first (ties by URL).

```json
[ { "act_url": "https://band.example", "followers": 3 } ]
```

---

## 8. Scheduled Tasks (Cron Triggers)

### 8.1 Event Expiration Cleanup

**Schedule:** Daily at 02:00 UTC

**Algorithm:**

Compute a cutoff timestamp of `now - 2 days`. Delete all events whose end time (or start time, if no end time) is before the cutoff:

```sql
DELETE FROM events
WHERE (end_time IS NOT NULL AND end_time < ?)
   OR (end_time IS NULL AND start_time < ?)
```

Where both `?` bind to the cutoff ISO 8601 string (e.g. `"2026-04-08T02:00:00"`).

The 2-day grace period ensures events that have just ended remain visible briefly after their conclusion.

### 8.2 Daily Database Backup

**Schedule:** Daily at 02:00 UTC

**Purpose:** Snapshot the `events` table and the member tables (`members`, `member_bands`, `band_suggestions`) to Cloudflare R2 for disaster recovery. The member tables hold private data (member names, followed bands, suggestions); they go into the same bucket as the events, which MUST NOT be publicly readable. No private key is ever stored: the server only knows public keys.

**Binding requirement:** An R2 bucket must be bound as `BACKUP_BUCKET` in `wrangler.toml`. If the binding is absent at runtime, the backup step is silently skipped (no error is thrown).

**Algorithm:**

1. Query all rows from each of the tables `events`, `members`, `member_bands` and `band_suggestions`.
2. Serialise the result as a JSON object `{ timestamp, tables: { events, members, member_bands, band_suggestions } }` (each value is the array of rows of that table, `[]` when empty) and write it to R2 under the key `backups/backup-YYYY-MM-DD.json`, where the date is the current UTC date. All four tables share one object per day, so the retention below applies to them together. Backups written before the member tables existed contain only `tables.events`; consumers MUST treat a missing table as empty.
3. List all objects under the `backups/` prefix in the bucket.
4. Sort the listed keys in ascending chronological order (oldest first).
5. Delete the oldest keys beyond the 7 most recent (time-based retention).
6. After pruning by count, check total storage used. If it exceeds 10 GB, delete the oldest remaining backup and repeat until under the limit.

**Example R2 key:** `backups/backup-2026-03-26.json`

**Retention policy:** At most 7 daily snapshots are kept. Additionally, if total R2 storage exceeds 10 GB, the oldest snapshots are removed until the storage cap is satisfied.

---

## 9. Error Handling

### 9.1 HTTP Status Codes

| Code | Usage                                                        |
|------|--------------------------------------------------------------|
| 200  | Successful GET/DELETE                                        |
| 201  | Successful POST (resource created)                           |
| 400  | Bad Request (invalid parameters, missing fields)             |
| 401  | Unauthorized (signature verification failed; for signed member/admin requests also missing headers or a timestamp outside ±300 s) |
| 403  | Forbidden (resource doesn't belong to user, blocklisted, not an active member, or not the admin) |
| 404  | Not Found                                                    |
| 409  | Conflict (duplicate event, or member already exists)         |
| 413  | Payload Too Large (body over 8 KB on a signed member/admin endpoint) |
| 500  | Internal Server Error                                        |
| 503  | Service Unavailable (ADMIN_PUBKEY secret not configured)     |

### 9.2 Error Response Format

```json
{
  "error": "<error type>",
  "message": "<detailed message>",
  "details": { /* optional context */ }
}
```

### 9.3 Validation Rules

**Required Field Validation:**

- `POST /events`: `pubkey`, `signature`, `title`, `lat`, `lng`, `start_time`, `category`, `created_at`
- `DELETE /events/:id`: `pubkey`, `signature`
- Member and admin member/suggestion endpoints: headers `X-Pubkey`, `X-Signature`, `X-Timestamp` (section 3.6)

**Coordinate Validation:**

- `lat`: -90.0 ≤ lat ≤ 90.0
- `lng`: -180.0 ≤ lng ≤ 180.0

**Timestamp Validation:**

- Must match ISO 8601 format: `YYYY-MM-DDTHH:MM:SS`
- Regex: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$`

**Category Validation:**

- Must be one of: `Music`, `Food`, `Sports`, `Art`, `Theater`, `Film`, `Nightlife`, `Community`, `Outdoor`, `Learning`, `Wellness`, `Other`

**Public Key/Signature Format:**

- `pubkey`: 64 hexadecimal characters (lowercase or uppercase)
- `signature`: 128 hexadecimal characters

**Member Data Validation:**

- Member name: trimmed, 1-60 characters
- Suggestion name: trimmed, 1-120 characters, at least one letter or digit
- Suggestion URL and `act_url`: http(s) only, stored normalized (section 3.6), at most 500 characters after normalization
- Request body of the signed member/admin endpoints: at most 8192 bytes (`413 {"error": "Payload too large"}`, section 3.6)
- Reject reason: trimmed, at most 200 characters
- Suggestion `ids`: non-empty array of at most 200 positive integers

---

## 10. Test Scenarios

### 10.1 Cryptographic Tests

**Test 1: Valid Event Signature Verification**
- Generate Ed25519 keypair
- Create event data
- Sign canonical event JSON with private key
- Verify signature passes verification

**Test 2: Invalid Signature Rejection**
- Modify signature by 1 byte
- Verify signature fails verification

**Test 3: Tampered Data Detection**
- Sign event data
- Modify event title
- Verify signature fails (data integrity check)

**Test 4: Delete Signature Verification**
- Generate event ID
- Sign event ID with private key
- Verify delete signature passes

### 10.2 Geospatial Query Tests

**Test 5: Query Events in Milan (radius 10km)**
- Seed database with events in Milan, Rome, Paris
- Query: `lat=45.464, lng=9.189, radius=10`
- Verify only Milan events returned

**Test 6: Query with Large Radius (100km)**
- Query: `lat=45.464, lng=9.189, radius=100`
- Verify precision 4 geohash used
- Verify events within 100km returned

**Test 7: Time Range Filtering**
- Seed events from March 1-31, 2026
- Query: `from=2026-03-15T00:00:00, to=2026-03-20T23:59:59`
- Verify only events in range returned

**Test 8: Category Filtering**
- Seed events with categories: Music, Food, Sports
- Query: `category=Music`
- Verify only Music events returned

**Test 9: Haversine Distance Accuracy**
- Event at (45.4642, 9.1900) — Milan Duomo
- Query center at (45.4808, 9.2083) — Milano Centrale
- Expected distance: ~2.5 km
- Verify calculated distance within ±100m

### 10.3 Duplicate Detection Tests

**Test 10: Exact Duplicate Rejection**
- Post event A
- Post identical event B
- Verify event B rejected with 409 status

**Test 11: Similar Event Rejection (same venue, slight time difference)**
- Post event at 21:00
- Post event at 21:30 (same title, venue)
- Verify second event rejected

**Test 12: Different Events Acceptance (same venue, different time)**
- Post event at 21:00 on March 15
- Post event at 21:00 on March 22 (same title, venue)
- Verify both events accepted (>1 hour apart)

**Test 13: Different Venues Acceptance (same time)**
- Post event "Jazz Night" at venue A
- Post event "Jazz Night" at venue B (200m away)
- Verify both events accepted (>100m apart)

### 10.4 CRUD Operation Tests

**Test 14: Create Event**
- POST valid signed event
- Verify 201 response with event ID
- Verify event retrievable via GET

**Test 15: Edit Own Event**
- Create event with pubkey A
- PUT update with new signature from pubkey A
- Verify 200 response
- Verify `updated_at` field set

**Test 16: Edit Other's Event (should fail)**
- Create event with pubkey A
- PUT update with signature from pubkey B
- Verify 403 Forbidden

**Test 17: Delete Own Event**
- Create event with pubkey A
- DELETE with signature from pubkey A
- Verify 200 response
- Verify event no longer retrievable

**Test 18: Delete Other's Event (should fail)**
- Create event with pubkey A
- DELETE with signature from pubkey B
- Verify 403 Forbidden

### 10.5 Edge Cases

**Test 19: Event at International Date Line**
- Event at lng=180.0
- Verify geohash calculated correctly
- Verify neighbor calculation doesn't fail

**Test 20: Event at North/South Pole**
- Event at lat=90.0
- Event at lat=-90.0
- Verify geohash and distance calculations

**Test 21: Maximum Result Limit**
- Seed 200 events in query area
- Verify only 100 returned (LIMIT)

**Test 22: Empty Query Results**
- Query area with no events
- Verify empty array returned (not error)

**Test 23: Expired Event Cleanup**
- Create event with end_time in past
- Run cron cleanup task
- Verify event deleted

### 10.6 Member and Admin Request Tests

The reference implementation covers these in `worker/src/band-keys.test.ts`, `member-auth.test.ts`, `members.test.ts`, `admin-members.test.ts`, `members-routes.test.ts` and `contract.test.ts`. Handler tests run real SQL against an in-memory SQLite stand-in for D1 (`worker/test-support/d1.ts`, built on `node:sqlite`) with test keys from `worker/test-support/sign.ts`.

**Normalization (`band-keys`):** `normalizeActUrl` lower-cases scheme and host, drops query, hash, trailing slashes and a default port, keeps a non-default port, trims whitespace, rejects non-http(s) input and non-strings; `normalizeName` ignores case, accents and punctuation and returns `""` for names without letters or digits; base64url round-trips Unicode, has no padding, rejects characters outside the alphabet and invalid UTF-8.

**Signed requests (`member-auth`):** a fresh, correctly signed request is accepted (also with an upper-case `X-Pubkey`); a signature for another domain, another payload or another key is rejected; a timestamp outside ±300 s is rejected with `server_time`; missing or malformed headers are rejected.

**Member endpoints (`members`):** `/member/me` returns name, bands and suggestions of an active member; `403` for unknown and revoked keys; `401` without valid auth; follow stores the normalized URL and is idempotent; unfollow is idempotent; `400` for a path that is not base64url or not an http(s) URL; each member has their own list; a suggestion is created pending and listed in `/member/me`; a duplicate pending name from the same member returns the existing id; two members may suggest the same name; invalid input → `400`.

**Admin endpoints (`admin-members`):** `503` without `ADMIN_PUBKEY`; `403` for a valid signature from another key; `401` for a bad signature; create, list, revoke and delete a member; a revoke signature cannot be used to delete; `409` for an existing pubkey, `400` for bad input, `404` for an unknown member; delete cascades to follows and suggestions; grouping by normalized name, counting distinct members, ordering by demand, member names only with `detail=1`; reject with a reason; link marks `linked`, stores the normalized `act_url` and follows it for the suggester; reject/link bodies are validated; follower counts are ordered and contain no names.

**Through the Worker (`members-routes`):** the lifecycle create → follow → suggest → link → revoke through the main fetch handler; a member key is rejected by the allowlist on `POST /events` and `POST /events/:id/act`; CORS preflight allows the new headers; the unauthenticated blocklist read and the `404` for unknown routes are unchanged.

**Contract (`contract`):** the real browser client (`public-web/member.js`) and admin client (`admin/members-admin.js`) run the whole flow against the Worker with their own signing code; a member client with a wrong device clock recovers through the `server_time` retry; the client and worker normalization functions give identical results on the same inputs.

### 10.7 Performance Tests

**Test 24: Query Performance with 10k Events**
- Seed 10,000 events globally
- Query with precision 6 (tight radius)
- Verify response time <500ms

---

## 11. Implementation Checklist

### 11.1 Core Functionality
- [x] Ed25519 signature verification (events, admin)
- [x] Header-signed, timestamped, domain-separated member/admin requests (section 3.6)
- [x] Geohash encoding and neighbor calculation
- [x] Haversine distance calculation
- [x] Event ID generation (SHA-256)
- [x] Duplicate event detection (Levenshtein + optional LLM)
- [x] iCal feed generation (RFC 5545)
- [x] ISO 8601 timestamp parsing and formatting
- [x] JSON canonical serialization

### 11.2 API Endpoints
- [x] GET / (API info)
- [x] GET /stats
- [x] GET /events (geospatial, pubkey, no-geo paginated, iCal format)
- [x] POST /events (create with duplicate detection)
- [x] PUT /events/:id (edit own event; ownership + created_at immutability enforced)
- [x] DELETE /events/:id (delete; admin bypass if pubkey === ADMIN_PUBKEY)
- [x] GET /admin/blocklist
- [x] POST /admin/blocklist
- [x] DELETE /admin/blocklist/:pubkey
- [x] GET /member/me
- [x] POST|DELETE /member/bands/:act_url_b64
- [x] POST /member/suggestions
- [x] GET|POST /admin/members, POST /admin/members/:pubkey/revoke, DELETE /admin/members/:pubkey
- [x] GET /admin/suggestions, POST /admin/suggestions/reject, POST /admin/suggestions/link
- [x] GET /admin/band-followers

### 11.3 Database Operations
- [x] Event insertion with geohash
- [x] Event deletion
- [x] Geospatial queries (precision 2-6)
- [x] Blocklist check on write paths (POST /events, DELETE /events/:id)
- [x] Blocklist CRUD (GET, insert, delete)
- [x] Member tables (`members`, `member_bands`, `band_suggestions`), delete cascade done explicitly

### 11.4 Validation & Error Handling
- [ ] Required field validation
- [ ] Coordinate range validation
- [ ] Timestamp format validation
- [ ] Category validation
- [ ] Signature format validation
- [ ] HTTP status codes (400, 401, 403, 404, 409, 500)
- [ ] CORS headers

### 11.5 Scheduled Tasks
- [x] Cron trigger: delete expired events (2-day grace period, runs at 02:00 UTC)
- [x] Cron trigger: back up events table to R2 (`BACKUP_BUCKET`) with 7-snapshot and 10 GB retention

### 11.6 Testing
- [ ] All 24 test scenarios passing
- [ ] Integration tests for full workflows
- [ ] Load testing for 10k events

---

## 12. Reference Implementation Notes

The reference implementation (TypeScript/Cloudflare Workers) can be found in:
- `worker/src/index.ts` — Main router and event handlers
- `worker/src/crypto.ts` — Ed25519 signature verification
- `worker/src/geohash.ts` — Geohash encoding and neighbors
- `worker/src/http.ts` — CORS headers and JSON response helper
- `worker/src/band-keys.ts` — `normalizeActUrl`, `normalizeName`, base64url helpers
- `worker/src/member-auth.ts` — signed-request message and verification (section 3.6)
- `worker/src/members.ts` — member endpoints (section 7.11)
- `worker/src/admin-members.ts` — admin member and suggestion endpoints (sections 7.12-7.14)
- `worker/migrations/0007_add_members.sql` — member tables

Key dependencies:
- `@noble/ed25519` — Ed25519 signature library
- `ngeohash` — Geohash library (reference only; implement from scratch per spec)

---

## 13. Portability Notes

### 13.1 Database Migration Path

If migrating from Cloudflare D1 to another SQLite-compatible database:
- Schema is portable (standard SQLite SQL)
- Timestamp format (ISO 8601 strings) works across all SQLite variants
- Geohash indexes are standard text indexes

---

## 14. Security Considerations

### 14.1 Attack Vectors & Mitigations

**Signature Replay Attack:**
- Mitigation: Include `created_at` in signed event data
- Event ID is derived from content hash, so re-submitting identical events hits duplicate detection

**Event Flooding:**
- Blocklist: blocked pubkeys cannot POST events
- Per-pubkey rate limiting is not currently implemented

**Duplicate Event Spam:**
- Mitigation: Duplicate detection algorithm (section 5)
- Reject similar events within 1-hour window

**SQL Injection:**
- Mitigation: Use parameterized queries (prepared statements) for ALL database operations
- Never concatenate user input into SQL strings

**XSS (via event descriptions):**
- Mitigation: Client-side sanitization (out of scope for API)
- API stores raw text; clients MUST escape HTML

**CORS Security:**
- Allow all origins (`*`)

**Replay of member/admin requests:**
- Limited to 300 s by the signed timestamp; each action has its own domain, so a captured signature cannot be used for another action (for example a revoke signature cannot delete).

**Stolen personal link:**
- The personal link carries the member's private key. Anyone holding it can act as the member, but a member can only follow bands and make suggestions. Revoke (or delete) the member to cut it off.

**Member keys cannot publish:**
- Member keys are never added to `ALLOWED_PUBKEYS`; `POST /events` and `POST /events/:id/act` reject them.

**Private member data:**
- A member's list and suggestions are only returned to a signed request from that member (`/member/me`) or the admin. Admin suggestion lists show counts; member names only with `detail=1`. Follower counts never include names.
- Clients MUST render suggestion text as text, never as HTML.

---

## 15. Compliance & Data Retention

### 15.1 Data Retention Policy

- **Events**: Automatically deleted when `end_time` + grace period passes

### 15.2 User Data Deletion (GDPR "Right to Erasure")

To delete all data for a user (identified by `pubkey`):

```sql
-- Delete events published by user
DELETE FROM events WHERE pubkey = ?;
```

For a member, `DELETE /admin/members/:pubkey` (section 7.12.4) removes the member, their followed bands and their suggestions.

**Note:** Implement as authenticated endpoint `/users/:pubkey/delete` (requires signature).

---

## 16. Appendices

### Appendix A: Ed25519 Test Vectors

**Test Vector 1: Event Signature**

```json
{
  "pubkey": "5a8e1f2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f",
  "signature": "<computed from private key>",
  "title": "Test Event",
  "description": "",
  "url": "",
  "venue_name": "",
  "address": "",
  "lat": 45.464,
  "lng": 9.189,
  "start_time": "2026-03-15T21:00:00",
  "end_time": null,
  "category": "Music",
  "tags": [],
  "created_at": "2026-03-01T10:00:00"
}
```

**Canonical Message Hash (SHA-256):**
```
<computed from canonical JSON>
```

**Expected Signature:**
```
<signature computed with test private key>
```

### Appendix B: Geohash Test Cases

| Latitude | Longitude | Precision 5 | Precision 6 |
|----------|-----------|-------------|-------------|
| 45.464   | 9.189     | u0nd8       | u0nd8h      |
| 51.5074  | -0.1278   | gcpvj       | gcpvj0      |
| 40.7128  | -74.0060  | dr5ru       | dr5ru6      |

### Appendix C: Jaccard Similarity Examples

**Example 1:**
- User A: events [1, 2, 3, 4, 5]
- User B: events [3, 4, 5, 6, 7]
- Shared: [3, 4, 5] → 3
- Union: [1, 2, 3, 4, 5, 6, 7] → 7
- Jaccard: 3/7 ≈ 0.43

**Example 2:**
- User A: events [1, 2, 3]
- User C: events [8, 9, 10]
- Shared: [] → 0
- Union: [1, 2, 3, 8, 9, 10] → 6
- Jaccard: 0/6 = 0.0

---

**END OF SPECIFICATION**
