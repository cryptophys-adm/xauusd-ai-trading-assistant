// The window helpers behind the bounded room reads (owner 2026-11-15, docs/RFC_ROOM_CELLS.md §6).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { warRoomThreadIds, warRoomThreadFilter, barTimeFloor, MAX_DAY_THREADS } from "../src/thread-windows.mjs";

test("the War Room's daily thread ids cover the window, with a day of slack after it", () => {
  assert.deepEqual(warRoomThreadIds("2026-11-12T18:00:00.000Z", Date.parse("2026-11-13T20:00:00Z")),
    ["warroom:2026-11-12", "warroom:2026-11-13", "warroom:2026-11-14"]);
  assert.equal(warRoomThreadIds("bad", Date.now()), null);
  assert.equal(warRoomThreadIds("2026-11-12T00:00:00Z", Date.parse("2026-11-10T00:00:00Z")), null, "a clock before the window");
  assert.equal(warRoomThreadIds("2026-01-01T00:00:00Z", Date.parse("2026-11-13T00:00:00Z")), null, `over ${MAX_DAY_THREADS} days`);
});

test("the filter names the threads, or falls back to the whole warroom range", () => {
  const f = warRoomThreadFilter("2026-11-13T00:00:00Z", Date.parse("2026-11-13T12:00:00Z"), "m");
  assert.equal(f.sql, "m.thread_id IN (?, ?)");
  assert.deepEqual(f.binds, ["warroom:2026-11-13", "warroom:2026-11-14"]);
  assert.deepEqual(warRoomThreadFilter("2025-01-01T00:00:00Z", Date.parse("2026-11-13T00:00:00Z")), { sql: "thread_id >= 'warroom:' AND thread_id < 'warroom;'", binds: [] });
  assert.equal(barTimeFloor("2026-11-13T00:30:00.000Z"), "2026-11-12T00:30:00.000Z");
});

test("migration 0021 adds the (thread_id, bar_time) index the named threads are searched by", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE agent_thread_messages (id INTEGER PRIMARY KEY, thread_id TEXT, run_id TEXT, step TEXT, bar_time TEXT, status TEXT)");
  db.exec(readFileSync(new URL("../migrations/0021_thread_bar_index.sql", import.meta.url), "utf8"));
  const f = warRoomThreadFilter("2026-11-13T00:00:00Z", Date.parse("2026-11-13T12:00:00Z"));
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT run_id FROM agent_thread_messages WHERE ${f.sql} AND bar_time >= ? AND status = 'ok'`).all(...f.binds, "2026-11-13T06:00:00Z");
  assert.match(plan.map((r) => r.detail).join(" "), /idx_agent_thread_messages_thread_bar \(thread_id=\? AND bar_time>\?\)/);
});
