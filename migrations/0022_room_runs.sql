-- ADR-0015 phase 2a in shadow (owner 2026-11-15; docs/RFC_ROOM_CELLS.md §4-§5): room run documents and their
-- hourly comparison with the statements outcome scoring reads from agent_thread_messages. Also made by the run-time
-- schema of src/room-runs.mjs (production applies no migration). New tables only.
CREATE TABLE IF NOT EXISTS room_runs (
  room TEXT NOT NULL,
  run_id TEXT NOT NULL,
  timeframe TEXT,
  candle_key TEXT,
  bar_close TEXT,
  status TEXT NOT NULL,
  stance TEXT,
  bias TEXT,
  confidence REAL,
  agents_heard INTEGER NOT NULL DEFAULT 0,
  agents_failed INTEGER NOT NULL DEFAULT 0,
  shadow_seats INTEGER NOT NULL DEFAULT 0,
  model_calls INTEGER NOT NULL DEFAULT 0,
  fallbacks INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER,
  opened_at TEXT,
  concluded_at TEXT,
  transcript_key TEXT,
  doc_version TEXT NOT NULL,
  body_json TEXT NOT NULL,
  derived_at TEXT NOT NULL,
  PRIMARY KEY (room, run_id)
);
CREATE INDEX IF NOT EXISTS idx_room_runs_bar ON room_runs(room, bar_close);
CREATE INDEX IF NOT EXISTS idx_room_runs_candle ON room_runs(candle_key);
CREATE TABLE IF NOT EXISTS room_runs_compare (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checked_at TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  keys INTEGER NOT NULL,
  equal INTEGER NOT NULL,
  missing INTEGER NOT NULL,
  mismatched INTEGER NOT NULL,
  sample_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_room_runs_compare_at ON room_runs_compare(timeframe, checked_at);
