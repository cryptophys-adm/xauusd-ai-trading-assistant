-- Agent compliance (RFC_AETHER_KNOWLEDGE_GUARDIAN phase A1): deterministic rule checks of the stored
-- room messages, one row per (message, check). Read-only over the rooms; never changes a message or
-- a decision. Also ensured at runtime by src/compliance.mjs.
CREATE TABLE IF NOT EXISTS compliance_checks (
  message_id INTEGER NOT NULL,
  check_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  chart TEXT NOT NULL,
  bar_time TEXT,
  agent TEXT NOT NULL,
  step TEXT NOT NULL,
  detail TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (message_id, check_id)
);
CREATE INDEX IF NOT EXISTS idx_compliance_checks_bar ON compliance_checks(bar_time);
CREATE TABLE IF NOT EXISTS compliance_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_message_id INTEGER NOT NULL
);
