# Tokoro Worker - Backend API

Backend API for Tokoro event discovery app.

## Quick Start

### Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Deploy to Cloudflare
npm run deploy

# Watch logs
npm run tail
```

## Setup (First Time)

### 1. Authenticate with Cloudflare

```bash
wrangler login
```

This will open a browser window to authenticate.

### 2. Create D1 Database

```bash
wrangler d1 create happenings-db
```

Copy the `database_id` from the output and update it in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "happenings-db"
database_id = "YOUR_DATABASE_ID_HERE"
```

### 3. Run Database Migrations

```bash
# Local database
wrangler d1 migrations apply happenings-db

# Production database
wrangler d1 migrations apply happenings-db --remote
```

### 4. Deploy

```bash
wrangler deploy
```

Your worker will be deployed to `https://happenings-worker.YOUR_SUBDOMAIN.workers.dev`

## API Endpoints

### GET /

Returns API documentation with all available endpoints.

```bash
curl https://happenings-worker.YOUR_SUBDOMAIN.workers.dev
```

### GET /stats

Returns total event count and the most recently created event.

```bash
curl https://happenings-worker.YOUR_SUBDOMAIN.workers.dev/stats
```

### GET /events

Query events by location and time.

**Parameters:**

- `lat` (required*): Latitude
- `lng` (required*): Longitude
- `radius` (optional): Radius in km (default: 10)
- `from` (optional): Start datetime ISO 8601 `YYYY-MM-DDTHH:MM:SS` (default: now)
- `to` (optional): End datetime ISO 8601 `YYYY-MM-DDTHH:MM:SS` (default: 7 days from now)
- `window` (optional): Relative time window, e.g. `7d` — sets `from=now` and `to=now+window`; overrides `from`/`to`
- `category` (optional): Filter by event category
- `festival_url` (optional): Filter to events belonging to a specific festival
- `pubkey` (optional): Filter to events published by a specific public key
- `format` (optional): `ical` returns an iCalendar feed (default window: 30 days)
- `offset` (optional): Pagination offset for no-geo queries (default: 0)

*`lat`/`lng` are optional when using `pubkey` alone or for admin browsing (no-geo path); results are paginated with `offset`.

**Example:**

```bash
curl "https://happenings-worker.YOUR_SUBDOMAIN.workers.dev/events?lat=51.505&lng=-0.09&radius=10"
```

### POST /events

Publish a new event (requires Ed25519 signature).

**Body:**

```json
{
  "pubkey": "ed25519_public_key_hex",
  "signature": "ed25519_signature_hex",
  "title": "Jazz Night at Blue Note",
  "description": "Live jazz music",
  "url": "https://example.com",
  "venue_name": "Blue Note Jazz Club",
  "address": "123 Main St, New York, NY",
  "lat": 40.7128,
  "lng": -74.006,
  "start_time": "2026-05-01T21:00:00",
  "end_time": "2026-05-01T23:00:00",
  "category": "music",
  "tags": ["jazz", "live"],
  "festival_name": "NYC Jazz Week",
  "festival_url": "https://nycjazzweek.com",
  "created_at": "2026-04-10T12:00:00"
}
```

All timestamps use ISO 8601 format without timezone: `"YYYY-MM-DDTHH:MM:SS"` representing **local time at the venue**.

**Categories:** music, food, sports, art, theater, film, nightlife, community, outdoor, learning, wellness, other

**Response:**

```json
{
  "id": "event_id_sha256_hash",
  "message": "Event created successfully"
}
```

### DELETE /events/:id

Delete an event (requires signature from event publisher or admin).

**Body:**

```json
{
  "pubkey": "ed25519_public_key_hex",
  "signature": "signature_of_event_id_hex"
}
```

### GET /admin/blocklist

Returns the list of blocked public keys. Requires `ADMIN_PUBKEY` to be configured.

### POST /admin/blocklist

Block a public key (admin only). Signs `SHA-256("blocklist:" + target_pubkey)`.

**Body:**

```json
{
  "pubkey": "admin_pubkey_hex",
  "signature": "ed25519_signature_hex",
  "target_pubkey": "pubkey_to_block_hex"
}
```

### DELETE /admin/blocklist/:pubkey

Unblock a public key (admin only). Same signature scheme as POST.

**Body:**

```json
{
  "pubkey": "admin_pubkey_hex",
  "signature": "ed25519_signature_hex"
}
```

## Authentication & Security

Events are authenticated using Ed25519 public key cryptography:

1. **No backend accounts**: Users generate keypairs in their browser/app
2. **Event signing**: Events are signed with SHA-256(canonical_json) + Ed25519
3. **Signature verification**: Worker verifies signatures before accepting events
4. **Ownership**: Only the original publisher (matching pubkey) or admin can delete events

### Allowlist (optional)

Set `ALLOWED_PUBKEYS` as a Worker secret to restrict publishing to known curators. The value is a comma-separated list of Ed25519 public keys (64-char hex):

```bash
wrangler secret put ALLOWED_PUBKEYS --cwd worker
# Enter comma-separated list, e.g.: aabbcc...,ddeeff...
```

If the secret is absent, any valid signature is accepted. If set, events signed by unlisted keys are rejected with HTTP 403.

**Canonical Event Data (for signing):**

```json
{
  "pubkey": "...",
  "title": "...",
  "description": "...",
  "url": "...",
  "venue_name": "...",
  "address": "...",
  "lat": 0.0,
  "lng": 0.0,
  "start_time": "YYYY-MM-DDTHH:MM:SS",
  "end_time": "YYYY-MM-DDTHH:MM:SS",
  "category": "...",
  "tags": [],
  "created_at": "YYYY-MM-DDTHH:MM:SS"
}
```

Note: `festival_name` and `festival_url` are unsigned metadata — they are stored but not included in the signing structure.

## Spatial Indexing

Events use geohash-based spatial indexing for efficient location queries. The worker selects geohash precision dynamically based on the requested radius:

| Radius | Precision | Cell size |
|--------|-----------|-----------|
| ≤ 5 km | 6 | ~1.2 km |
| ≤ 15 km | 5 | ~4.9 km |
| ≤ 50 km | 4 | ~39 km |
| ≤ 200 km | 3 | ~156 km |
| > 200 km | 2 | ~1250 km |

Queries always include the center cell plus its 8 neighbors to avoid missing events near cell boundaries. Precisions 2–4 use prefix matching on the `geohash5` column; precisions 5 and 6 use indexed exact lookups. A final haversine distance filter is applied in the worker after the SQL query.

## Project Structure

```
worker/
├── src/
│   ├── index.ts       # Main worker with API routes
│   ├── crypto.ts      # Ed25519 signature verification
│   └── geohash.ts     # Geohash encoding and neighbors
├── migrations/
│   ├── 0001_create_events_table.sql
│   ├── 0002_add_address_field.sql
│   ├── 0003_convert_timestamps_to_text.sql
│   ├── 0004_add_festival_fields.sql
│   └── 0005_add_blocklist.sql
├── scripts/
│   └── check-duplicate.ts  # Duplicate detection diagnostics
├── wrangler.toml      # Cloudflare Workers config
├── package.json
└── tsconfig.json
```

## Testing

### Duplicate Detection Diagnostics

`scripts/check-duplicate.ts` applies the exact same duplicate-detection pipeline as the worker `POST /events` handler and explains step by step why two events are or aren't considered duplicates.

```bash
# Local DB
npm run check-duplicate -- --local <event-id-1> <event-id-2>

# Remote DB
npm run check-duplicate -- --remote <event-id-1> <event-id-2>

# Remote DB with LLM (set env vars before running)
LLM_API_KEY=sk-... npm run check-duplicate -- --remote <event-id-1> <event-id-2>
```

Optional env vars for LLM:

| Variable | Default |
|---|---|
| `LLM_API_KEY` | — (no LLM, Levenshtein fallback) |
| `LLM_PROVIDER` | `openrouter` |
| `LLM_MODEL` | `google/gemini-2.5-flash-lite` |

The script logs each check in order and stops at the first failure:

1. **Geohash6 neighborhood** — B's cell must be in A's 9-cell search area (center + 8 neighbors)
2. **Distance** — haversine ≤ 100 m
3. **Time difference** — |start_time A − start_time B| ≤ 60 min
4. **Levenshtein fast-path** — title similarity ≥ 0.9 (no LLM needed)
5. **LLM similarity** — probability ≥ 0.7, or Levenshtein ≥ 0.8 fallback when `LLM_API_KEY` is absent

The method used (LLM provider/model or Levenshtein-only) is always printed so the result can be interpreted in context.

### Using the Web Publisher

The easiest way to test is using the web publisher:

```bash
# From project root
open web-publisher/index.html
```

### Using curl

```bash
# Query events (no auth required)
curl "https://happenings-worker.YOUR_SUBDOMAIN.workers.dev/events?lat=51.505&lng=-0.09&radius=10"

# POST events require proper Ed25519 signatures
# Use the web publisher for this
```

## Database Schema

```sql
CREATE TABLE events (
  id            TEXT PRIMARY KEY,     -- SHA-256 hash of canonical event data
  pubkey        TEXT NOT NULL,        -- Ed25519 public key
  signature     TEXT NOT NULL,        -- Ed25519 signature
  title         TEXT NOT NULL,
  description   TEXT,
  url           TEXT,
  venue_name    TEXT,
  address       TEXT,
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  geohash5      TEXT NOT NULL,        -- ~4.9km precision
  geohash6      TEXT NOT NULL,        -- ~1.2km precision
  start_time    TEXT NOT NULL,        -- ISO 8601 local time (e.g. "2026-03-15T21:00:00")
  end_time      TEXT,                 -- ISO 8601 local time
  category      TEXT NOT NULL,
  tags          TEXT,                 -- JSON array
  festival_name TEXT,                 -- optional festival name (unsigned metadata)
  festival_url  TEXT,                 -- optional festival homepage URL (unsigned metadata)
  created_at    TEXT NOT NULL,        -- ISO 8601 local time
  updated_at    TEXT                  -- ISO 8601 local time, set on edit
);

CREATE INDEX idx_geohash6_time  ON events (geohash6, start_time);
CREATE INDEX idx_geohash5_time  ON events (geohash5, start_time);
CREATE INDEX idx_category_time  ON events (category, start_time);
CREATE INDEX idx_festival_url   ON events (festival_url);

CREATE TABLE blocklist (
  pubkey     TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
```

## Troubleshooting

### "Database not found" error

Make sure you've:

1. Created the D1 database with `wrangler d1 create`
2. Updated the `database_id` in `wrangler.toml`
3. Run the migrations with `wrangler d1 migrations apply`

### Signature verification failing

Common issues:

- Client and server must sign the exact same canonical JSON structure
- Field order matters in the canonical representation
- Empty strings vs null can cause mismatches — use `""` not `null` for optional string fields when signing
- Make sure SHA-512 is configured for @noble/ed25519 in browser/worker

See `src/crypto.ts` for the exact signing structure.

### CORS errors

The worker includes CORS headers for all responses. If you're still seeing CORS errors:

- Check that the worker is deployed and accessible
- Verify the WORKER_URL in the web publisher matches your deployment
- Check browser console for specific error details

### Migration errors

If migrations fail:

```bash
# Check migration status
wrangler d1 migrations list happenings-db

# Force apply if needed
wrangler d1 migrations apply happenings-db --remote
```

## Database Backup

The worker automatically backs up the `events` table to Cloudflare R2 daily at 2am UTC. The 7 most recent backups are kept; older ones are deleted. If total storage exceeds 10 GB, the oldest backup is removed until under the limit. If the R2 bucket is not configured, the backup is silently skipped.

### Setup (first time)

```bash
# Create the R2 bucket
wrangler r2 bucket create happenings-backups
```

The example `wrangler.toml` already includes the binding. Deploy after creating the bucket:

```bash
npm run deploy
```

### Manual local backup (SQL dump)

```bash
# From project root — saves backup-YYYY-MM-DD.sql to current directory
./scripts/backup-local.sh

# Or to a specific directory
./scripts/backup-local.sh ~/my-backups
```

### Restore from R2 backup

Download a backup file from R2:

```bash
wrangler r2 object get happenings-backups/backups/backup-2026-03-26.json --file backup.json
```

Then restore it:

```bash
# From project root
./scripts/restore-from-backup.sh backup.json
```

> **Warning:** The restore script uses `INSERT OR IGNORE` — it adds rows but does not clear the table first. To do a clean restore, run this first:
>
> ```bash
> wrangler d1 execute happenings-db --command "DELETE FROM events" --remote
> ```

### List backups in R2

```bash
wrangler r2 object list happenings-backups --prefix backups/
```

## Deployment Checklist

- [x] Database created and migrations applied (local & remote)
- [x] Worker deployed to production
- [x] Signature verification tested and working
- [x] CORS configured
- [x] API documentation endpoint working
- [x] Geohash indexing verified
- [x] End-to-end testing completed
- [x] R2 backup bucket created

## Next Steps

- [ ] Deploy web publisher to Cloudflare Pages
- [ ] Add event update functionality
- [ ] Implement collaborative filtering (stars, follows)
- [ ] Add event recommendations
- [ ] iOS app development

## Support

For issues or questions, see the main [project README](../README.md).
