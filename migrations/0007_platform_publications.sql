-- RFC_INDICATOR_AGENT_PLATFORM P4: one cursor per platform agent, so each meaningful
-- event is reported to the Cryptophys Platform kernel once. Also ensured at runtime
-- by src/platform-reports.mjs.
CREATE TABLE IF NOT EXISTS platform_publications (
  agent_id TEXT PRIMARY KEY,
  last_key TEXT,
  last_stance TEXT,
  published_at TEXT,
  outcome TEXT,
  reason TEXT,
  report_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
