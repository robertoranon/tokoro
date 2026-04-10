-- Migration: add blocklist table for banned pubkeys
CREATE TABLE IF NOT EXISTS blocklist (
  pubkey     TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
