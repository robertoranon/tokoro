-- Migration: Convert timestamps from INTEGER (Unix) to TEXT (ISO 8601)
-- Created: 2026-03-04
--
-- This migration converts existing INTEGER timestamps to TEXT ISO 8601 format
-- for better human readability during debugging.

-- SQLite doesn't support ALTER COLUMN TYPE directly, so we need to:
-- 1. Create new TEXT columns
-- 2. Convert and copy data
-- 3. Drop old columns
-- 4. Rename new columns

-- Add temporary TEXT columns
ALTER TABLE events ADD COLUMN start_time_text TEXT;
ALTER TABLE events ADD COLUMN end_time_text TEXT;
ALTER TABLE events ADD COLUMN created_at_text TEXT;
ALTER TABLE events ADD COLUMN updated_at_text TEXT;

-- Convert Unix timestamps to ISO 8601 format (YYYY-MM-DDTHH:MM:SS)
UPDATE events SET start_time_text = datetime(start_time, 'unixepoch');
UPDATE events SET end_time_text = datetime(end_time, 'unixepoch') WHERE end_time IS NOT NULL;
UPDATE events SET created_at_text = datetime(created_at, 'unixepoch');
UPDATE events SET updated_at_text = datetime(updated_at, 'unixepoch') WHERE updated_at IS NOT NULL;

-- Recreate the table with TEXT timestamp columns
-- Note: We need to recreate to change column types and maintain indexes
CREATE TABLE events_new (
  id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  signature TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  url TEXT,
  venue_name TEXT,
  address TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  geohash5 TEXT NOT NULL,
  geohash6 TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT,
  category TEXT NOT NULL,
  tags TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- Copy data from old table to new table
INSERT INTO events_new
SELECT
  id, pubkey, signature, title, description, url, venue_name, address,
  lat, lng, geohash5, geohash6,
  start_time_text, end_time_text, category, tags,
  created_at_text, updated_at_text
FROM events;

-- Drop old table
DROP TABLE events;

-- Rename new table
ALTER TABLE events_new RENAME TO events;

-- Recreate indexes
CREATE INDEX idx_geohash6_time ON events (geohash6, start_time);
CREATE INDEX idx_geohash5_time ON events (geohash5, start_time);
CREATE INDEX idx_category_time ON events (category, start_time);
CREATE INDEX idx_pubkey ON events (pubkey);
