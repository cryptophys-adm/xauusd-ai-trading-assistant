-- Range shadow b (src/range-shadow.mjs): the intraday range episodes, one row per run of ranging 1H closes (opened at
-- the 4th consecutive ranging close, ended at the first non-ranging close or a missing hour), keyed by its first ranging
-- close. The same statement is the run-time schema of src/range-shadow.mjs (production applies no migration,
-- deploy-worker.yml: no D1 token), so this file records the schema and builds it on the preview database. New table only.
-- The range_both setups are plan_setups rows (source 'range_both'): plan_setups is made at run time, so no migration.
CREATE TABLE IF NOT EXISTS range_episodes (
    start_ms INTEGER PRIMARY KEY, opened_ms INTEGER NOT NULL, end_ms INTEGER, hours INTEGER NOT NULL,
    status TEXT NOT NULL, updated_at TEXT NOT NULL
  );
