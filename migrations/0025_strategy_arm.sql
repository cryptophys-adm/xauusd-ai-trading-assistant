-- Strategy arm (docs/RFC_STRATEGY_RECOMMENDATION.md §4; owner 2026-11-17, "Ya, benar semua" then "Ya, semua, live"):
-- the arm state singleton, one row per strategy and the append-only audit of every arm and disarm. The same
-- statements are the run-time schema of src/strategy-arm.mjs (production applies no migration, deploy-worker.yml:
-- no D1 token), so this file records the schema and builds it on the preview database. New tables only.
-- ea_deals.strategy (RFC §5 attribution) is added by the run-time schema of src/ea-execution.mjs, as ea_deals.source
-- is: ea_deals itself is made at run time, so a migration cannot alter it.
CREATE TABLE IF NOT EXISTS strategy_arm_state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, armed_count INTEGER NOT NULL, updated_ms INTEGER NOT NULL);
INSERT OR IGNORE INTO strategy_arm_state (id, version, armed_count, updated_ms) VALUES (1, 0, 0, 0);
CREATE TABLE IF NOT EXISTS strategy_arms (strategy_id TEXT PRIMARY KEY, armed INTEGER NOT NULL, armed_at INTEGER, armed_by TEXT,
  disarmed_at INTEGER, disarmed_by TEXT, disarm_reason TEXT, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS strategy_arm_events (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL, strategy_id TEXT NOT NULL,
  action TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, request_id TEXT UNIQUE, armed_count_after INTEGER NOT NULL, at INTEGER NOT NULL);
