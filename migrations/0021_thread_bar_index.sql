-- Owner 2026-11-15 (docs/RFC_ROOM_CELLS.md §6, the interim option): a room's messages by bar. Outcome scoring
-- (agentStatements) and the weighting replay (loadRooms) now name the War Room's daily threads of their window and
-- bound bar_time, so this index is searched once per thread instead of every warroom row being read
-- (13,842-14,056 rows per call in production on 2026-11-15). Also made by the run-time schema of
-- src/agent-threads.mjs (production applies no migration). Index only.
CREATE INDEX IF NOT EXISTS idx_agent_thread_messages_thread_bar ON agent_thread_messages(thread_id, bar_time);
