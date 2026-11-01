CREATE TABLE IF NOT EXISTS analysis_runs (
  candle_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('analyzing', 'complete', 'degraded', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  error_code TEXT,
  result_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_status_updated ON analysis_runs(status, updated_at);
