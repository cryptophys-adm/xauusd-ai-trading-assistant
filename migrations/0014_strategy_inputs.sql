-- Aether phase A8 (owner go 2026-11-08): the strategy engine's inputs, once per closed H1 bar, so
-- its thresholds can be replayed (RFC_AETHER_KNOWLEDGE_GUARDIAN §9.1, §9.4). The inputs are slimmed
-- to what buildStrategy reads and gzip-compressed (base64). outcomes_json holds the outcome of each
-- stance (BUY, SELL, WAIT) over the next 4 hours on the 15m bars. Kept 60 days. Nothing here reaches
-- a room, a prompt or a decision, and it is never sent to the platform or to Aether. Also ensured at
-- runtime by src/strategy-inputs.mjs.
CREATE TABLE IF NOT EXISTS strategy_inputs (
  candle_key TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  score_close TEXT,
  version TEXT NOT NULL,
  inputs_gz TEXT NOT NULL,
  live_decision TEXT,
  live_state TEXT,
  outcomes_json TEXT,
  scored_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_strategy_inputs_captured ON strategy_inputs(captured_at);
