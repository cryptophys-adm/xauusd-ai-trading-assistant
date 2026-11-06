-- Health alerts (gap 2, owner decision 2026-11-06): one row per operational problem, opened once,
-- resolved when it no longer holds, and reported to the Cryptophys Platform kernel once per state
-- change. Also ensured at runtime by src/health-alerts.mjs.
CREATE TABLE IF NOT EXISTS health_alerts (
  alert_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail TEXT,
  one_shot INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  reported_open_at TEXT,
  reported_resolved_at TEXT,
  report_outcome TEXT,
  updated_at TEXT NOT NULL
);
