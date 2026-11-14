-- Resource audit P0 (owner 2026-11-14: "lebih hemat read/write D1 dan KV"): indexes for the WHERE and
-- ORDER BY clauses that scanned whole tables. Rows read per call in production on 2026-11-14, before:
--   outcome_scores WHERE timeframe = ? AND candle_key = ?          17,389 (decision cards, 40x an hour)
--   agent_thread_messages WHERE ts >= ?                            20,906 (AI calls in the last hour, health)
--   engine_parity_comparisons ORDER BY compared_at DESC LIMIT 5     7,200 (status, parity view)
--   engine_parity_comparisons WHERE candle_key = ?                  3,600 (HUD store)
--   webhook_sources ORDER BY received_at DESC LIMIT 1               9,930 (webhook lane status)
-- omega_intents is created at run time (src/omega-broker.mjs), so its (status, created_ms) index is there.
-- Production applies no migrations (deploy-worker.yml: no D1 token); every index here is also made by the
-- run-time schema of its module (outcome-scoring, agent-threads, parity-registry, webhook-rejections).
-- Indexes only: no query, result or behaviour changes.
CREATE INDEX IF NOT EXISTS idx_outcome_scores_tf_candle ON outcome_scores(timeframe, candle_key);
CREATE INDEX IF NOT EXISTS idx_agent_thread_messages_ts ON agent_thread_messages(ts);
CREATE INDEX IF NOT EXISTS idx_parity_comparisons_at ON engine_parity_comparisons(compared_at);
CREATE INDEX IF NOT EXISTS idx_parity_comparisons_candle ON engine_parity_comparisons(candle_key);
-- webhook_sources comes from schema.sql, which a database built from the migrations alone (the unit tests)
-- does not have: the same definition here is a no-op wherever the table exists (every deployed database).
CREATE TABLE IF NOT EXISTS webhook_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candle_key TEXT NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT DEFAULT (datetime('now')),
  UNIQUE(candle_key, source)
);
CREATE INDEX IF NOT EXISTS idx_webhook_sources_received ON webhook_sources(received_at);
