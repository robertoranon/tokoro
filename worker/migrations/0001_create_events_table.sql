-- Migration: Create events table
-- Created: 2026-03-01
-- Updated: 2026-03-04 - Changed timestamps from INTEGER to TEXT (ISO 8601)

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  signature TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  url TEXT,
  venue_name TEXT,
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

CREATE INDEX IF NOT EXISTS idx_geohash6_time ON events (geohash6, start_time);
CREATE INDEX IF NOT EXISTS idx_geohash5_time ON events (geohash5, start_time);
CREATE INDEX IF NOT EXISTS idx_category_time ON events (category, start_time);
CREATE INDEX IF NOT EXISTS idx_pubkey ON events (pubkey);
