-- Signal Ledger (owner request 2026-11-07): every directional signal followed to its outcome in R.
-- Advisory only: R multiples, never money or position size. Also ensured at runtime by
-- src/signal-ledger.mjs.
CREATE TABLE IF NOT EXISTS signal_ledger (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  candle_key TEXT,
  opened_at TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  entry REAL NOT NULL, stop REAL NOT NULL, tp1 REAL NOT NULL, tp2 REAL,
  confidence REAL, note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'open', 'closed', 'cancelled')),
  filled_at TEXT, closed_at TEXT, exit_reason TEXT, exit_price REAL,
  r_tp1 REAL, r_tp2 REAL, open_r REAL, mfe_r REAL, mae_r REAL, bars_held INTEGER, ambiguous INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signal_ledger_opened ON signal_ledger(opened_at);
CREATE INDEX IF NOT EXISTS idx_signal_ledger_status ON signal_ledger(status);
