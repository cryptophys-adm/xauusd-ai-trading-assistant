-- RFC_INDICATOR_AGENT_PLATFORM P1: outcome scoring and stuck states. New tables only.
-- The AI Worker also creates them at runtime (ensureOutcomeSchema) for the preview D1.
CREATE TABLE IF NOT EXISTS outcome_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  source TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  candle_key TEXT NOT NULL,
  statement_close TEXT NOT NULL,
  stance TEXT NOT NULL,
  confidence REAL,
  result TEXT NOT NULL,
  direction INTEGER,
  entry REAL,
  atr REAL,
  threshold REAL,
  max_up REAL,
  max_down REAL,
  brier REAL,
  session TEXT,
  scoring_version TEXT NOT NULL,
  scored_at TEXT NOT NULL,
  UNIQUE(subject, timeframe, candle_key)
);
CREATE INDEX IF NOT EXISTS idx_outcome_scores_close ON outcome_scores(statement_close);
CREATE INDEX IF NOT EXISTS idx_outcome_scores_subject ON outcome_scores(subject, statement_close);
CREATE TABLE IF NOT EXISTS outcome_runs (
  timeframe TEXT NOT NULL,
  candle_key TEXT NOT NULL,
  statements INTEGER NOT NULL,
  scored_at TEXT NOT NULL,
  PRIMARY KEY (timeframe, candle_key)
);
CREATE TABLE IF NOT EXISTS stuck_states (
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  first_candle_key TEXT NOT NULL,
  last_candle_key TEXT NOT NULL,
  candles INTEGER NOT NULL,
  price_range REAL NOT NULL,
  atr REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'cleared')),
  detected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (field, first_candle_key)
);
CREATE INDEX IF NOT EXISTS idx_stuck_states_status ON stuck_states(status, updated_at);
