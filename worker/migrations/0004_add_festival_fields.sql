-- Migration: Add festival_name and festival_url to events table
-- Created: 2026-03-19

ALTER TABLE events ADD COLUMN festival_name TEXT;
ALTER TABLE events ADD COLUMN festival_url  TEXT;

CREATE INDEX idx_festival_url ON events (festival_url);
