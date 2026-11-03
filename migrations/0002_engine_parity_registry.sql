-- Autonomous provenance registry for local-computation engines.
-- The AI Worker also creates these tables idempotently at runtime (CREATE TABLE IF NOT EXISTS),
-- so this migration is a record of the schema, not a deployment prerequisite.
CREATE TABLE IF NOT EXISTS engine_parity_registry (
  engine TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  implementation_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'approved', 'revoked')),
  consecutive_matches INTEGER NOT NULL DEFAULT 0,
  total_matches INTEGER NOT NULL DEFAULT 0,
  total_mismatches INTEGER NOT NULL DEFAULT 0,
  total_incomplete INTEGER NOT NULL DEFAULT 0,
  mizan_source_hash TEXT,
  mizan_implementation_hash TEXT,
  last_candle_key TEXT,
  last_result TEXT,
  last_detail TEXT,
  first_seen_at TEXT NOT NULL,
  approved_at TEXT,
  revoked_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (engine, source_hash, implementation_hash)
);
CREATE TABLE IF NOT EXISTS engine_parity_comparisons (
  engine TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  implementation_hash TEXT NOT NULL,
  candle_key TEXT NOT NULL,
  result TEXT NOT NULL,
  detail TEXT,
  compared_at TEXT NOT NULL,
  PRIMARY KEY (engine, source_hash, implementation_hash, candle_key)
);
