-- CL1 PR2 (src/provider-router.mjs): one row per provider attempt of a routed live call (Beam, Claude Haiku, or a skip
-- with its reason). Counts, latency, tokens, USD, outcome and reason only: no prompt and no answer text. Kept 30 days
-- (the hourly rollback check prunes it). The run-time schema (ensureSchema in the module) creates the same table.
CREATE TABLE IF NOT EXISTS router_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  day TEXT NOT NULL,
  role TEXT NOT NULL,
  grp TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  asked INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  reason TEXT,
  latency_ms INTEGER,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  usd_micros INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_router_calls_at ON router_calls (at_ms);
CREATE INDEX IF NOT EXISTS idx_router_calls_role ON router_calls (role, provider, at_ms);
