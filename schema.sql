-- Matches the schema inspected in the existing xauusd-signals D1 database.
CREATE TABLE IF NOT EXISTS webhook_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candle_key TEXT NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT DEFAULT (datetime('now')),
  UNIQUE(candle_key, source)
);
CREATE INDEX IF NOT EXISTS idx_wh_candle ON webhook_sources(candle_key);
CREATE INDEX IF NOT EXISTS idx_wh_source ON webhook_sources(source);

CREATE TABLE IF NOT EXISTS ai_syntheses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candle_key TEXT NOT NULL,
  ticker TEXT NOT NULL,
  timeframe TEXT,
  timestamp TEXT,
  prophet_metrics TEXT,
  gmi_metrics TEXT,
  ai_analysis TEXT,
  ai_model TEXT,
  neurons_used INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_syn_candle ON ai_syntheses(candle_key);

CREATE TABLE IF NOT EXISTS trade_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candle_key TEXT NOT NULL,
  decision TEXT NOT NULL,
  confidence REAL,
  entry_price REAL,
  stop_loss REAL,
  take_profit REAL,
  risk_reward REAL,
  position_size_pct REAL,
  reasoning TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dec_candle ON trade_decisions(candle_key);


-- Standalone fundamental news analysis, independent of indicator webhooks.
CREATE TABLE IF NOT EXISTS news_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_key TEXT NOT NULL UNIQUE,
  fetched_at TEXT NOT NULL,
  analyzed_at TEXT NOT NULL,
  article_count INTEGER NOT NULL,
  evidence_json TEXT NOT NULL,
  analyst_output TEXT NOT NULL,
  counselor_output TEXT NOT NULL,
  reasoner_output TEXT NOT NULL,
  recommendation_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_news_analyses_analyzed_at ON news_analyses(analyzed_at);
