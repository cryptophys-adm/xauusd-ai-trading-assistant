-- Owner 2026-11-15 ("setujui semua"): the retired H1 bus's table goes. Its 335 rows (2026-11-04 to
-- 2026-11-07) are archived first to R2 xauusd-room-transcripts/archive/d1/bus_messages.ndjson by
-- .github/workflows/archive-bus-messages.yml, which drops the production table only after the archive
-- reads back byte-equal. This migration keeps fresh databases (tests, preview) the same shape.
DROP INDEX IF EXISTS idx_bus_candle;
DROP TABLE IF EXISTS bus_messages;
