-- Aether phase A5 (RFC_AETHER_KNOWLEDGE_GUARDIAN §0.6): the ledger of decision cards pushed to
-- cryptophys-aether through the AETHER Service Binding, one row per card with the hash of the content
-- last sent. A card is pushed again only when its content changes. Also ensured at runtime by
-- src/aether-push.mjs.
CREATE TABLE IF NOT EXISTS aether_card_pushes (
  card_id TEXT PRIMARY KEY,
  chart TEXT NOT NULL,
  content_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
  detail TEXT,
  pushed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aether_card_pushes_at ON aether_card_pushes(pushed_at);
