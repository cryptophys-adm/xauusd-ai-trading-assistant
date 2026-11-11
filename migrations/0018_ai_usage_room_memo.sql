-- Workers AI usage meter and room memo (owner 2026-11-11: "kurangi neuron/hari tanpa mengurangi
-- kapabilitas agent"). Also ensured at runtime by src/ai-usage.mjs and src/room-memo.mjs.
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  model TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  timeouts INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  memo_hits INTEGER NOT NULL DEFAULT 0,
  memo_same INTEGER NOT NULL DEFAULT 0,
  reused INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, model)
);
CREATE TABLE IF NOT EXISTS room_memo (
  kind TEXT NOT NULL,
  step TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  message_id INTEGER,
  model TEXT,
  answer_json TEXT NOT NULL,
  stance TEXT,
  bias TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, step, input_hash)
);
CREATE INDEX IF NOT EXISTS idx_room_memo_created ON room_memo(created_at);
