-- Call for Councils, CFC-A1 (orchestrator brief 2026-11-28): the suggestion lifecycle open -> approved | rejected |
-- expired, with its expiry (48 hours after last seen, at most 7 days after made) and who decided, when, with which
-- session and request key. SQLite cannot change a CHECK in place, so the v1 table (status open | dismissed) is rebuilt:
-- the v2 table, the rows copied (dismissed as rejected), the swap, the indexes. The run-time schema of
-- src/cfc-triggers.mjs (ensureCfcSchema, CFC_MIGRATE_V2_SQL) does the same once, in one batch; production applies no
-- migration. This file records the schema.
DROP TABLE IF EXISTS cfc_suggestions_v2;
CREATE TABLE IF NOT EXISTS cfc_suggestions_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_key TEXT NOT NULL,
  type TEXT NOT NULL,
  rule TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  signal_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'expired')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT,
  decided_at TEXT,
  decided_by TEXT,
  session_id TEXT,
  decision_key TEXT
);
INSERT INTO cfc_suggestions_v2 (id, topic_key, type, rule, fingerprint, signal_json, status, created_at, last_seen_at, expires_at, decided_at, decided_by)
  SELECT id, topic_key, type, rule, fingerprint, signal_json, CASE WHEN status = 'dismissed' THEN 'rejected' ELSE 'open' END, created_at, last_seen_at,
    MIN(strftime('%Y-%m-%dT%H:%M:%fZ', last_seen_at, '+48 hours'), strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+7 days')),
    CASE WHEN status = 'dismissed' THEN last_seen_at END, CASE WHEN status = 'dismissed' THEN 'legacy' END
  FROM cfc_suggestions;
DROP TABLE cfc_suggestions;
ALTER TABLE cfc_suggestions_v2 RENAME TO cfc_suggestions;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cfc_suggestions_open ON cfc_suggestions(topic_key) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_cfc_suggestions_created ON cfc_suggestions(created_at);
CREATE INDEX IF NOT EXISTS idx_cfc_suggestions_fingerprint ON cfc_suggestions(fingerprint, created_at);
