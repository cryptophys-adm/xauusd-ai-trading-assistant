CREATE TABLE IF NOT EXISTS bus_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  candle_key TEXT NOT NULL,
  round INTEGER NOT NULL,
  agent TEXT NOT NULL,
  ts TEXT NOT NULL,
  insight TEXT NOT NULL,
  confidence REAL,
  refs_json TEXT,
  model TEXT,
  status TEXT,
  latency_ms INTEGER,
  fallback_used INTEGER DEFAULT 0,
  usage_tokens INTEGER,
  UNIQUE(candle_key, run_id, round, agent)
);
CREATE INDEX IF NOT EXISTS idx_bus_candle ON bus_messages(candle_key);
