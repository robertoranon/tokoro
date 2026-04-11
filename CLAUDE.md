# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Tokoro is a project that helps in discovering physical, real-world events based on time and location. Users can add events, follow other users with similar taste, and discover events through collaborative filtering. The system consists of these main components:

1. **Chrome Extension** - Allows a user to request crawling a web page or one of its images to discover and publish events to the API
2. **Cloudflare Worker (TypeScript)** - Serverless API backend handling events, social graph, and recommendations
3. **Web Publisher (Static HTML/JS)** - Browser-based event publishing interface hosted on Cloudflare Pages
4. **Public Web (Static HTML/JS)** - Read-only event query/browse interface hosted on Cloudflare Pages. Includes bookmarklet code that performs web page crawling as the Chrome extension.
5. **Crawler and Crawler-Worker (TypeScript)** - LLM-powered semantic crawler for extracting structured event data from web pages and its combination with the worker (for easier integration into free Cloudflare services)
6. **Shared** - Common utilities and TypeScript types shared across components

**IMPORTANT:**: each of these components has a SPECS.md file describing the specification in a language-agnostic fashion. You **NEED TO READ** it to understand how the component works. Remember to keep each spec in sync with code changes.

## Architecture

### Backend: Cloudflare Worker + D1

The backend is a single TypeScript Cloudflare Worker that:

- Verifies Ed25519 event signatures
- Executes geo-indexed SQL queries against D1 (SQLite)
- Handles event expiration via scheduled cron triggers
- Computes collaborative filtering recommendations

API Endpoints:

**Events**

- `GET /events?lat=&lng=&radius=&from=&to=&category=&tags=&festival_url=` - Query events (max 100 results; `festival_url` filters to a specific festival)
- `POST /events` - Publish signed event
- `PUT /events/:id` - Edit own event (new signature required)
- `DELETE /events/:id` - Delete own event (signature required)

**Stars** (Event Interactions)

- `POST /stars/:event_id` - Star an event (signed request)
- `DELETE /stars/:event_id` - Unstar an event (signature required)
- `GET /stars?pubkey=` - Get events starred by a user
- `GET /events/:event_id/stars` - Get users who starred an event

**Follows** (Social Graph)

- `POST /follows/:pubkey` - Follow a user (signed request)
- `DELETE /follows/:pubkey` - Unfollow a user (signature required)
- `GET /follows?follower=` - Get list of users that a user follows
- `GET /followers?followee=` - Get list of users following a user

**Discovery & Feed**

- `GET /feed?pubkey=` - Get events starred by people the user follows
- `GET /discover?pubkey=` - Get suggested users based on similar starred events

### Data Model

Data is stored in Cloudflare D1 (SQLite) across three tables:

**Timestamp Format Convention:**

- All timestamps use ISO 8601 format without timezone: `"YYYY-MM-DDTHH:MM:SS"` (e.g., `"2026-03-15T21:00:00"`)
- Timestamps represent **local time at the venue's location** (implicit timezone)
- The venue's coordinates (lat/lng) define the timezone context
- This avoids timezone conversion complexity while maintaining human readability
- Example: An event at 9pm in Berlin stores as `"2026-03-15T21:00:00"`, same as 9pm in Tokyo

```sql
-- Events with geohash-based spatial indexing
CREATE TABLE events (
  id          TEXT PRIMARY KEY,       -- stable ID across edits
  pubkey      TEXT NOT NULL,          -- author's public key (hex)
  signature   TEXT NOT NULL,          -- Ed25519 signature (updated on edit)
  title       TEXT NOT NULL,
  description TEXT,
  url         TEXT,                   -- event website or page URL
  venue_name  TEXT,                   -- optional venue name for grouping
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  geohash5    TEXT NOT NULL,          -- ~5km precision
  geohash6    TEXT NOT NULL,          -- ~1.2km precision
  start_time  TEXT NOT NULL,          -- ISO 8601 format (e.g. "2026-03-15T21:00:00")
  end_time    TEXT,                   -- ISO 8601 format
  category    TEXT NOT NULL,          -- predefined category (music, food, sports, etc.)
  tags        TEXT,                   -- JSON array of free-form tags (e.g. ["jazz", "outdoor"])
  festival_name TEXT,                 -- optional festival this event belongs to (unsigned metadata)
  festival_url  TEXT,                 -- optional festival homepage URL (unsigned metadata; used for grouping/filtering)
  created_at  TEXT NOT NULL,          -- ISO 8601 format
  updated_at  TEXT                    -- ISO 8601 format, updated on edit
);

CREATE INDEX idx_geohash6_time ON events (geohash6, start_time);
CREATE INDEX idx_geohash5_time ON events (geohash5, start_time);
CREATE INDEX idx_category_time ON events (category, start_time);
```

### User Identity

Users generate Ed25519 keypairs locally on device (no signup, no auth backend). Every event is signed with the user's private key. The Worker verifies signatures before accepting writes. Public key serves as persistent user identity.

### Geospatial Query Strategy

Events are tagged with geohash strings at two precisions (5 and 6). Queries filter by geohash prefix to retrieve events in geographic cells, with final bounding-box filtering in the Worker for precise radius. This avoids client-side filtering and leverages SQLite indexes efficiently.
