// ADR-0015 P2b reader 4 (owner 2026-11-16): neuron allocation's calls and tokens read the run documents for the War
// Room and the 1H/4H/D1 rooms, and the messages only for the other rooms' active threads.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { callRowsFromDocs } from "../src/neuron-allocation.mjs";
import { deriveRoomRuns, resetRoomRunsSchemaCacheForTests } from "../src/room-runs.mjs";
import { ensureThreadSchema } from "../src/agent-threads.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  const wrap = (sql, params = []) => ({
    bind: (...a) => wrap(sql, a.map((v) => (v === undefined ? null : v))),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}

const ROOM_SQL = `CASE WHEN thread_id >= 'warroom:' AND thread_id < 'warroom;' THEN 'M15' WHEN thread_id = 'tf:H1' THEN 'H1' WHEN thread_id = 'tf:H4' THEN 'H4' WHEN thread_id = 'tf:D1' THEN 'D1' WHEN thread_id >= 'newsdaily:' AND thread_id < 'newsdaily;' THEN 'News Daily' WHEN thread_id >= 'macro:' AND thread_id < 'macro;' THEN 'Macro' ELSE 'Other' END`;
const sorted = (rows) => rows.map((r) => [r.day, r.room, r.agent, r.model, Number(r.calls), Number(r.tokens)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

test("calls and tokens from the documents plus the other rooms' threads equal the scan of every message", async () => {
  resetRoomRunsSchemaCacheForTests();
  const db = d1();
  await ensureThreadSchema(db);
  const thread = (id, kind, at) => db.raw.prepare("INSERT OR IGNORE INTO agent_threads (id, kind, ref_key, title, post_json, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, ?)").run(id, kind, id, id, at, at);
  const msg = (t, run, step, agent, ts, model, tokens, status = "ok", bar = ts) => db.raw.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, agent, bar_time, ts, stance, confidence, body_json, model, status, usage_tokens) VALUES (?, ?, ?, ?, ?, ?, 'WAIT', 0.5, '{}', ?, ?, ?)").run(t, run, step, agent, bar, ts, model, status, tokens);
  const G = "@cf/google/gemma-4-26b-a4b-it", O = "@cf/openai/gpt-oss-120b";
  for (const [bar, day] of [["2026-11-15T23:15:00.000Z", "warroom:2026-11-15"], ["2026-11-16T00:15:00.000Z", "warroom:2026-11-16"]]) {
    thread(day, "warroom", bar);
    msg(day, bar, "brief", "system", bar, null, null, "info");
    msg(day, bar, "open:prophet", "prophet", bar, G, 900);
    msg(day, bar, "open:risk", "risk", bar, G, 0, "invalid_output");
    msg(day, bar, "debate:prophet", "prophet", bar, G, 400);
    msg(day, bar, "conclusion", "moderator", bar, O, 1200);
  }
  thread("tf:H1", "timeframe", "2026-11-16T00:00:00.000Z");
  msg("tf:H1", "2026-11-16T00:00:00.000Z", "brief", "system", "2026-11-16T00:01:00.000Z", null, null, "info", "2026-11-16T00:00:00.000Z");
  msg("tf:H1", "2026-11-16T00:00:00.000Z", "open:h1", "h1", "2026-11-16T00:02:00.000Z", G, 700, "ok", "2026-11-16T00:00:00.000Z");
  msg("tf:H1", "2026-11-16T00:00:00.000Z", "conclusion", "moderator", "2026-11-16T00:03:00.000Z", O, 1100, "ok", "2026-11-16T00:00:00.000Z");
  thread("news:a1", "news", "2026-11-16T00:10:00.000Z");
  msg("news:a1", "a1", "r1:news", "news", "2026-11-16T00:10:00.000Z", G, 500);
  thread("macro:XAUUSD", "macro", "2026-11-16T00:20:00.000Z");
  msg("macro:XAUUSD", "m1", "open:macro", "macro", "2026-11-16T00:20:00.000Z", G, 650);
  thread("newsdaily:2026-11-16", "newsdaily", "2026-11-16T00:30:00.000Z");
  msg("newsdaily:2026-11-16", "d1", "brief", "news_daily", "2026-11-16T00:30:00.000Z", O, 2000);
  const now = Date.parse("2026-11-16T01:00:00Z"), since = "2026-11-15";
  const scan = db.raw.prepare(`SELECT substr(ts, 1, 10) AS day, ${ROOM_SQL} AS room, agent, model, COUNT(*) AS calls, SUM(usage_tokens) AS tokens FROM agent_thread_messages WHERE ts >= ? AND usage_tokens > 0 GROUP BY day, room, agent, model`).all(since);
  const env = { DB: db, ROOM_RUNS_SHADOW: "on", ROOM_RUNS_READ_ALLOCATION: "on" };
  assert.equal(await callRowsFromDocs(env, since, { now }), null, "before the backfill marker: the old query");
  await deriveRoomRuns(env, { now, backfill: true }); await deriveRoomRuns(env, { now, backfill: true });
  const fromDocs = await callRowsFromDocs(env, since, { now });
  assert.deepEqual(sorted(fromDocs), sorted(scan));
  assert.ok(fromDocs.some((r) => r.room === "Macro") && fromDocs.some((r) => r.room === "News Daily") && fromDocs.some((r) => r.room === "Other"));
  assert.equal(await callRowsFromDocs({ DB: db, ROOM_RUNS_SHADOW: "on" }, since, { now }), null, "flag off: the old query");
});
