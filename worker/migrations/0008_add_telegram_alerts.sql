-- Migration: Telegram alerts for tours members (new shows, new festival editions)
-- Created: 2026-10-19
-- Existing events get alert_pending = 0, so enabling alerts sends no backlog.

ALTER TABLE events ADD COLUMN alert_pending INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_events_alert_pending ON events (alert_pending);

ALTER TABLE members ADD COLUMN telegram_chat_id TEXT;
ALTER TABLE members ADD COLUMN radar_alerts INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX idx_members_telegram ON members (telegram_chat_id);

CREATE TABLE telegram_link_codes (
  code        TEXT PRIMARY KEY,
  pubkey      TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
