-- Migration: same-band/same-day conflicts between events at different places
-- Created: 2026-10-28
-- Conflicting events are hidden from public listings with events.held = 1.
-- Existing events get held = 0, so nothing is hidden until detection runs.

ALTER TABLE events ADD COLUMN held INTEGER NOT NULL DEFAULT 0;

CREATE TABLE conflicts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  act_url     TEXT,
  day         TEXT,
  status      TEXT,
  created_at  TEXT,
  resolved_at TEXT
);

CREATE TABLE conflict_events (
  conflict_id INTEGER,
  event_id    TEXT,
  PRIMARY KEY (conflict_id, event_id)
);

CREATE TABLE conflict_proposals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conflict_id INTEGER,
  event_id    TEXT,
  action      TEXT,
  reason      TEXT,
  created_at  TEXT,
  UNIQUE (event_id, action)
);

CREATE INDEX idx_conflicts_act_day ON conflicts (act_url, day);
CREATE INDEX idx_conflict_events_event ON conflict_events (event_id);
CREATE INDEX idx_events_act_start ON events (act_url, start_time);
