-- Phase 3 agent threads (docs/RFC_NEXUS_AGENT_SOCIAL.md). New tables only: never ALTER 0003.
CREATE TABLE IF NOT EXISTS agent_threads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  title TEXT NOT NULL,
  post_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_threads_kind ON agent_threads(kind, created_at);
CREATE TABLE IF NOT EXISTS agent_thread_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step TEXT NOT NULL,
  parent_id INTEGER,
  agent TEXT NOT NULL,
  bar_time TEXT,
  ts TEXT NOT NULL,
  stance TEXT,
  confidence REAL,
  body_json TEXT NOT NULL,
  refs_json TEXT,
  model TEXT,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  fallback_used INTEGER DEFAULT 0,
  usage_tokens INTEGER,
  UNIQUE(thread_id, run_id, step)
);
CREATE INDEX IF NOT EXISTS idx_agent_thread_messages_thread ON agent_thread_messages(thread_id, id);
