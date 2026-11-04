CREATE TABLE IF NOT EXISTS bus_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candle_key TEXT NOT NULL,
  round INTEGER NOT NULL,
  agent TEXT NOT NULL,
  ts TEXT NOT NULL,
  insight TEXT NOT NULL,
  confidence REAL,
  refs_json TEXT,
  model TEXT
);
CREATE INDEX IF NOT EXISTS idx_bus_candle ON bus_messages(candle_key);
