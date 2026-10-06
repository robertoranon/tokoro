-- Migration: Add act_name and act_url to events table (band tours)
-- Created: 2026-10-06

ALTER TABLE events ADD COLUMN act_name TEXT;
ALTER TABLE events ADD COLUMN act_url  TEXT;

CREATE INDEX idx_act_url ON events (act_url);
