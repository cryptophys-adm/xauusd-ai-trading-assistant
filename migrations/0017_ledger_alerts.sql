-- Alerts to the owner (backlog 11.2, owner decision 2026-11-08: Telegram): one row per Signal Ledger
-- event sent (setup, entry, exit, closed, cancelled), so each is sent once. status "seeded" marks the
-- events that existed before the first run (recorded, not sent). Also ensured at runtime by
-- src/ledger-alerts.mjs.
CREATE TABLE IF NOT EXISTS ledger_alerts (
  signal_id TEXT NOT NULL,
  event TEXT NOT NULL,
  status TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (signal_id, event)
);
