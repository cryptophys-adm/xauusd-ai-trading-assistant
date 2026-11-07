-- Aether phase A7 (RFC_AETHER_KNOWLEDGE_GUARDIAN §0.6 pull, §9.4): the latest learned pack pulled from
-- cryptophys-aether (KnowledgeIngress.learnedPack, over the AETHER binding). One row. It holds only items
-- a person approved for shadow testing; approved parameter candidates in TUNING_GRID run as shadow
-- versions. Nothing here reaches a room, a prompt or a decision. Also ensured at runtime by
-- src/aether-pack.mjs.
CREATE TABLE IF NOT EXISTS aether_learned_pack (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  pack_json TEXT NOT NULL,
  first_seen_json TEXT NOT NULL,
  pulled_at TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
