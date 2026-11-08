-- Aether phase A8, part 4 (RFC_AETHER_KNOWLEDGE_GUARDIAN §9.4): the decision of each strategy-threshold
-- arm (src/strategy-replay.mjs) on each hour stored in strategy_inputs, computed once in the sweep by
-- the pure buildStrategy. Scored with the hour's stored outcomes; never reaches a room or a decision.
-- Also ensured at runtime by src/strategy-replay.mjs.
CREATE TABLE IF NOT EXISTS strategy_replays (
  candle_key TEXT NOT NULL,
  arm_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  state TEXT,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (candle_key, arm_id)
);
