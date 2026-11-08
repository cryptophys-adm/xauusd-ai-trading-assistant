-- Aether phase A7, the shadow knowledge arm (RFC_AETHER_KNOWLEDGE_GUARDIAN §9.4, K6): one extra opening
-- call of a target agent of the 1H room per bar, with an approved learned note added (arm "note"), or
-- the same prompt again without it (arm "aa", the O13 noise check). control_stance is that agent's real
-- opening on the bar. Both are scored here once the horizon closes (never in outcome_scores). Never
-- shown in a room, on the bus, in the crowd line or a decision. Off unless SHADOW_KNOWLEDGE_ENABLED.
-- Kept 60 days. Also ensured at runtime by src/shadow-knowledge.mjs.
CREATE TABLE IF NOT EXISTS shadow_agent_outputs (
  subject TEXT NOT NULL,
  candle_key TEXT NOT NULL,
  agent TEXT NOT NULL,
  item_id TEXT,
  item_version INTEGER,
  arm TEXT NOT NULL,
  statement_close TEXT NOT NULL,
  stance TEXT,
  bias TEXT,
  confidence REAL,
  control_stance TEXT,
  status TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL,
  result TEXT,
  control_result TEXT,
  scoring_version TEXT,
  scored_at TEXT,
  PRIMARY KEY (subject, candle_key)
);
CREATE INDEX IF NOT EXISTS idx_shadow_agent_outputs_created ON shadow_agent_outputs(created_at);
