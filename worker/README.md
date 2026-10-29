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
wrangler d1 create tokoro-db
```

Copy the `database_id` from the output and update it in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "tokoro-db"
database_id = "YOUR_DATABASE_ID_HERE"
```

### 3. Run Database Migrations

```bash
# Local database
wrangler d1 migrations apply tokoro-db

# Production database
wrangler d1 migrations apply tokoro-db --remote
```

**Member bands (`0007_add_members.sql`):** apply this migration to the remote database **before** deploying a Worker version that includes the member endpoints (`/member/*`, `/admin/members*`, `/admin/suggestions*`, `/admin/band-followers`):

```bash
wrangler d1 execute tokoro-db --remote --file=migrations/0007_add_members.sql
```

The new routes are additive; existing clients are unaffected.

**Member festivals (`0010_add_member_festivals.sql`):** creates `member_festivals` and `festival_suggestions`. Apply it to the remote database **before** deploying a Worker version that includes the festival member endpoints:

```bash
wrangler d1 execute tokoro-db --remote --file=migrations/0010_add_member_festivals.sql
```

Deploy order: migration, then the API worker, then the crawler-worker (Telegram bot), then the public web (`scripts/deploy-public-web.sh`, which also exports `tracked-festivals.json`). The changes are additive; existing clients are unaffected.

### 4. Deploy

```bash
wrangler deploy
```

Your worker will be deployed to `https://tokoro-worker.YOUR_SUBDOMAIN.workers.dev`

## API Endpoints

### GET /

Returns API documentation with all available endpoints.

```bash
curl https://tokoro-worker.YOUR_SUBDOMAIN.workers.dev
```

### GET /stats

Returns total event count and the most recently created event.

```bash
curl https://tokoro-worker.YOUR_SUBDOMAIN.workers.dev/stats
```

### GET /events

Query events by location and time.

**Parameters:**

- `lat` (required\*): Latitude
- `lng` (required\*): Longitude
- `radius` (optional): Radius in km (default: 10)
- `from` (optional): Start datetime ISO 8601 `YYYY-MM-DDTHH:MM:SS` (default: now)
- `to` (optional): End datetime ISO 8601 `YYYY-MM-DDTHH:MM:SS` (default: 7 days from now)
- `window` (optional): Relative time window, e.g. `7d` — sets `from=now` and `to=now+window`; overrides `from`/`to`
- `category` (optional): Filter by event category
- `festival_url` (optional): Filter to events belonging to a specific festival
- `pubkey` (optional): Filter to events published by a specific public key
- `format` (optional): `ical` returns an iCalendar feed (default window: 30 days)
- `offset` (optional): Pagination offset for no-geo queries (default: 0)

\*`lat`/`lng` are optional when using `pubkey` alone or for admin browsing (no-geo path); results are paginated with `offset`.

**Example:**

```bash
curl "https://tokoro-worker.YOUR_SUBDOMAIN.workers.dev/events?lat=51.505&lng=-0.09&radius=10"
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

### Members (tours "My bands")

The admin can issue personal links to a small group of members. A member can follow tracked bands and suggest new ones on `tours.html`; the admin reviews the suggestions. Member keys are never in `ALLOWED_PUBKEYS`, so members cannot publish.

These endpoints are authenticated with headers, not body fields: `X-Pubkey`, `X-Signature`, `X-Timestamp` (Unix seconds). The signature is over `SHA-256("<domain>:<payload>:<timestamp>")`, accepted within ±300 s; a `401` caused by clock skew includes `server_time`. Every action has its own domain (see `SPECS.md` section 3.6).

| Endpoint | Who | Purpose |
| --- | --- | --- |
| `GET /member/me` | member | name, followed bands, own suggestions |
| `POST /member/bands/:act_url_b64` | member | follow a band (base64url site URL) |
| `DELETE /member/bands/:act_url_b64` | member | unfollow a band |
| `POST /member/suggestions` | member | suggest a band `{name, url?}` |
| `POST /member/telegram/link-code` | member | one-time code and `t.me` link to connect a Telegram chat |
| `POST /telegram/link`, `/telegram/settings`, `/telegram/unlink` | bot | redeem a link code, toggle radar alerts, disconnect a chat |
| `GET /admin/members` | admin | list members with followed-band counts |
| `POST /admin/members` | admin | create a member `{pubkey, name}` |
| `POST /admin/members/:pubkey/revoke` | admin | revoke a member's link |
| `DELETE /admin/members/:pubkey` | admin | delete a member, their follows and suggestions |
| `GET /admin/suggestions?status=&detail=1` | admin | suggestions grouped by normalized name |
| `POST /admin/suggestions/reject` | admin | reject `{ids, reason?}` |
| `POST /admin/suggestions/link` | admin | link `{ids, act_url}` to a tracked band and follow it for the suggesters |
| `GET /admin/band-followers` | admin | follower count per band |

Request and response bodies, status codes and error messages: `SPECS.md` sections 7.11-7.15.

### Telegram alerts (setup)

Linked members get a daily digest at 08:00 UTC (second cron in `wrangler.toml`) with new shows of the bands they follow and, if they send `/radar on` to the bot, new festival editions (`SPECS.md` section 7.15). The bot side (linking commands) runs in `crawler-worker`, which must have `TELEGRAM_WEBHOOK_SECRET` set (see `crawler-worker/README.md`).

Set on this worker, from `worker/`:

```bash
wrangler secret put TELEGRAM_BOT_TOKEN      # same token as the crawler-worker bot
wrangler secret put TELEGRAM_BOT_USERNAME   # bot username without @ (getMe → result.username)
wrangler secret put TELEGRAM_BOT_PUBKEY     # the crawler-worker's BOT_PUBKEY (hex)
wrangler secret put PUBLIC_WEB_URL          # e.g. https://tokoro-query.pages.dev, for the digest links
```

Optional admin chat: set `ADMIN_TELEGRAM_CHAT_ID` to receive one message per new conflict (any band) and every digest alert (all bands and festival editions, not only followed ones). Create a Telegram group with only you and the bot (the bot stays silent in groups unless addressed as `@bot events ...`). The bot has a webhook, so `getUpdates` answers 409 and cannot be used to find the chat id. Instead add @RawDataBot (or @getidsbot) to the group for a moment, read the `chat.id` it replies with (a negative number, `-100…` for supergroups), then remove it. If the group is later converted to a supergroup its id changes, so check the id after setting the group up. To test, call `https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>&text=test`.

```bash
wrangler secret put ADMIN_TELEGRAM_CHAT_ID  # e.g. 123456789
wrangler secret put ADMIN_PAGE_URL          # optional, linked from conflict notices
```

Unset, nothing is sent to an admin. A `403` from the admin chat is only logged (it is not a member).

Until these are set, the digest job does nothing and the Telegram endpoints answer `503`. Wrangler cannot read secret values back, so keep the bot token and `BOT_PUBKEY` somewhere safe. The bot's `BOT_PUBKEY` is also the author key of every event the bot publishes.

When piping values into `wrangler secret put` from zsh (the macOS default shell), use `read -r "VAR?prompt: "` instead of bash's `read -p`, and do not use `USERNAME` as a variable name: zsh reserves it for your login name.

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

| Radius   | Precision | Cell size |
| -------- | --------- | --------- |
| ≤ 5 km   | 6         | ~1.2 km   |
| ≤ 15 km  | 5         | ~4.9 km   |
| ≤ 50 km  | 4         | ~39 km    |
| ≤ 200 km | 3         | ~156 km   |
| > 200 km | 2         | ~1250 km  |

Queries always include the center cell plus its 8 neighbors to avoid missing events near cell boundaries. Precisions 2–4 use prefix matching on the `geohash5` column; precisions 5 and 6 use indexed exact lookups. A final haversine distance filter is applied in the worker after the SQL query.

## Project Structure

```
worker/
├── src/
│   ├── index.ts          # Main worker with API routes
│   ├── crypto.ts         # Ed25519 signature verification
│   ├── geohash.ts        # Geohash encoding and neighbors
│   ├── http.ts           # CORS headers and JSON responses
│   ├── band-keys.ts      # Band URL/name normalization, base64url
│   ├── member-auth.ts    # Header-signed member/admin requests
│   ├── members.ts        # /member/* endpoints
│   ├── admin-members.ts  # Admin member and suggestion endpoints
│   └── *.test.ts         # vitest suites
├── test-support/
│   ├── d1.ts             # In-memory D1 stand-in (node:sqlite) for handler tests
│   └── sign.ts           # Test keys and auth headers
├── migrations/
│   ├── 0001_create_events_table.sql
│   ├── 0002_add_address_field.sql
│   ├── 0003_convert_timestamps_to_text.sql
│   ├── 0004_add_festival_fields.sql
│   ├── 0005_add_blocklist.sql
│   ├── 0006_add_act_fields.sql
│   └── 0007_add_members.sql
├── scripts/
│   └── check-duplicate.ts  # Duplicate detection diagnostics
├── wrangler.toml      # Cloudflare Workers config
├── package.json
└── tsconfig.json
```

## Testing

### Unit and integration tests

```bash
npx vitest run   # or: npm test
```

The member suites (`band-keys`, `member-auth`, `members`, `admin-members`, `members-routes`, `contract`) run real SQL against an in-memory D1 stand-in (`test-support/d1.ts`, needs a Node version with `node:sqlite`). `contract.test.ts` also loads `public-web/member.js` and `admin/members-admin.js`, so the browser clients are tested against the Worker.

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

| Variable       | Default                          |
| -------------- | -------------------------------- |
| `LLM_API_KEY`  | — (no LLM, Levenshtein fallback) |
| `LLM_PROVIDER` | see `shared/llm/defaults.ts`     |
| `LLM_MODEL`    | see `shared/llm/defaults.ts`     |

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
curl "https://tokoro-worker.YOUR_SUBDOMAIN.workers.dev/events?lat=51.505&lng=-0.09&radius=10"

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

The member tables (`members`, `member_bands`, `band_suggestions`) are defined in `migrations/0007_add_members.sql` and documented in `SPECS.md` section 2.1.

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
wrangler d1 migrations list tokoro-db

# Force apply if needed
wrangler d1 migrations apply tokoro-db --remote
```

## Database Backup

The worker automatically backs up the `events` table, the member tables (`members`, `member_bands`, `band_suggestions`) and the `blocklist` to Cloudflare R2 daily at 2am UTC, as one JSON object per day (`{ timestamp, tables: { events, members, member_bands, band_suggestions, blocklist } }`). The blocklist is included so a restore does not unblock banned keys. The member tables are private (member names, followed bands, suggestions): keep the bucket private, as for the events. No private key is ever backed up (the server only has public keys). `scripts/backup-local.sh` (a full `wrangler d1 export`) also covers every table. The 7 most recent backups are kept; older ones are deleted. If total storage exceeds 10 GB, the oldest backup is removed until under the limit. If the R2 bucket is not configured, the backup is silently skipped.

### Setup (first time)

```bash
# Create the R2 bucket
wrangler r2 bucket create tokoro-backups
```

The example `wrangler.toml` already includes the binding. Deploy after creating the bucket:

```bash
npm run deploy
```

### Manual local backup (SQL dump)

Exports the production (remote) database to a local file.

```bash
# From project root — saves backup-YYYY-MM-DD.sql to current directory
./scripts/backup-local.sh

# Or to a specific directory
./scripts/backup-local.sh ~/my-backups
```

### Restore from R2 backup

Download a backup file from R2:

```bash
wrangler r2 object get tokoro-backups/backups/backup-2026-03-26.json --file backup.json --remote
```

Then restore it into the production database (events, member tables and blocklist; older backups restore just the tables they contain, e.g. only the events, or everything but the blocklist):

```bash
# From project root
./scripts/restore-from-backup.sh backup.json
```

> **Warning:** The restore script uses `INSERT OR IGNORE` — it adds rows but does not clear the tables first. To do a clean restore, run this first:
>
> ```bash
> wrangler d1 execute tokoro-db --command "DELETE FROM events; DELETE FROM members; DELETE FROM member_bands; DELETE FROM band_suggestions; DELETE FROM blocklist" --remote
> ```

### List backups in R2

Wrangler has no command to list objects. Backups are named `backups/backup-YYYY-MM-DD.json` (the last 7 days), so fetch one by date, or browse the bucket in the Cloudflare dashboard (R2 → `tokoro-backups`).

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
