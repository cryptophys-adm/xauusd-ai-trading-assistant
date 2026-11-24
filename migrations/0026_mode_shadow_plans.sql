-- MS2 shadow per-mode evidence (docs/RFC_ACCOUNT_PROFILES.md §7; src/mode-shadow.mjs): one row per 15m decision and per
-- trading mode not in force whose deterministic pass would trade (its side, its plans, the target rule). The same
-- statements are the run-time schema of src/mode-shadow.mjs (production applies no migration, deploy-worker.yml: no D1
-- token), so this file records the schema and builds it on the preview database. New table only.
-- plan_setups.source and plan_setups.rule_version are added by the run-time schema of src/plan-learning.mjs, as
-- plan_setups.pattern and .htf are: plan_setups itself is made at run time, so a migration cannot alter it.
CREATE TABLE IF NOT EXISTS mode_shadow_plans (
    decision_key TEXT NOT NULL, bar_close TEXT NOT NULL, decided_at TEXT NOT NULL, mode TEXT NOT NULL, side TEXT NOT NULL,
    agent TEXT, plans_json TEXT NOT NULL, atr_h1 REAL, regime TEXT, rule_version TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY (decision_key, mode)
  );
CREATE INDEX IF NOT EXISTS idx_mode_shadow_plans_close ON mode_shadow_plans(bar_close);
