-- Migration: members, followed bands and band suggestions (tours "My bands")
-- Created: 2026-10-13

CREATE TABLE members (
  pubkey      TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);

CREATE TABLE member_bands (
  pubkey      TEXT NOT NULL,
  act_url     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (pubkey, act_url)
);
CREATE INDEX idx_member_bands_act ON member_bands (act_url);

CREATE TABLE band_suggestions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pubkey        TEXT NOT NULL,
  name          TEXT NOT NULL,
  url           TEXT,
  status        TEXT NOT NULL,
  act_url       TEXT,
  reject_reason TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_suggestions_status ON band_suggestions (status, created_at);
