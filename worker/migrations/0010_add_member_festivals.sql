-- Migration: followed festivals and festival suggestions (festivals "My festivals")
-- Created: 2026-10-29

CREATE TABLE member_festivals (
  pubkey       TEXT NOT NULL,
  festival_url TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (pubkey, festival_url)
);
CREATE INDEX idx_member_festivals_url ON member_festivals (festival_url);

CREATE TABLE festival_suggestions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pubkey        TEXT NOT NULL,
  name          TEXT NOT NULL,
  url           TEXT,
  status        TEXT NOT NULL,
  festival_url  TEXT,
  reject_reason TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_festival_suggestions_status ON festival_suggestions (status, created_at);
