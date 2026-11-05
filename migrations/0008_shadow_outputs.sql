-- RFC_INDICATOR_AGENT_PLATFORM P3: per-bar outputs of shadow indicator versions (controls
-- and candidates). The first computation of a bar is final. Also ensured at runtime by
-- src/shadow-versions.mjs.
CREATE TABLE IF NOT EXISTS shadow_outputs (
  version_id TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  candle_key TEXT NOT NULL,
  close_time TEXT NOT NULL,
  stance TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (version_id, candle_key)
);
CREATE INDEX IF NOT EXISTS idx_shadow_outputs_close ON shadow_outputs(version_id, close_time);
