-- Call for Councils, phase P1 (owner 2026-11-16: "tahap P1 mulai"; docs/RFC_CALL_FOR_COUNCILS.md §1.2): the
-- topics the deterministic flags suggest (src/cfc-triggers.mjs), one row per suggestion. One open suggestion per
-- topic key (the partial unique index); the fingerprint (topic key and rule) has a 7-day cooldown. Also made by
-- the run-time schema of src/cfc-triggers.mjs (production applies no migration). New table only.
CREATE TABLE IF NOT EXISTS cfc_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_key TEXT NOT NULL,
  type TEXT NOT NULL,
  rule TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  signal_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cfc_suggestions_open ON cfc_suggestions(topic_key) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_cfc_suggestions_created ON cfc_suggestions(created_at);
CREATE INDEX IF NOT EXISTS idx_cfc_suggestions_fingerprint ON cfc_suggestions(fingerprint, created_at);
