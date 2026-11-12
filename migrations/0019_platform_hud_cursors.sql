CREATE TABLE IF NOT EXISTS platform_hud_cursors (
  agent_id TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  last_key TEXT,
  last_stance TEXT,
  last_bias TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, timeframe)
);
