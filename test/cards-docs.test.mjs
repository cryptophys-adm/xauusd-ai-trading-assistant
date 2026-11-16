// ADR-0015 P2b reader 5 (owner 2026-11-16): the decision cards read their runs from the run documents, and the room's
// run in progress from the messages; the cards equal those built from the messages alone.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { loadDecisionCards } from "../src/decision-cards.mjs";
import { deriveRoomRuns, cardRuns, resetRoomRunsSchemaCacheForTests } from "../src/room-runs.mjs";
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

const G = "@cf/google/gemma-4-26b-a4b-it";
const H1_OPEN = Date.parse("2026-11-15T23:00:00Z");
const key = (open) => "OANDA:XAUUSD:60:" + open;

async function seeded() {
  resetRoomRunsSchemaCacheForTests();
  const db = d1();
  await ensureThreadSchema(db);
  const thread = (id, kind, at) => db.raw.prepare("INSERT OR IGNORE INTO agent_threads (id, kind, ref_key, title, post_json, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, ?)").run(id, kind, id, id, at, at);
  const msg = (t, run, step, agent, ts, bar, body, { stance = "WAIT", status = "ok", model = G } = {}) => db.raw.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, agent, bar_time, ts, stance, confidence, body_json, model, status, usage_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, 0.6, ?, ?, ?, ?)").run(t, run, step, agent, bar, ts, stance, JSON.stringify(body), model, status, model ? 500 : null);
  const room = (t, run, bar, k, { concluded = true, stance = "BUY" } = {}) => {
    const at = (m) => new Date(Date.parse(String(run).split("#")[0]) + m * 60_000).toISOString();
    msg(t, run, "brief", "system", at(1), bar, { roster: ["technical", "risk"], candle_key: k, bar_time: bar, confirmations: { setup: "ready" } }, { status: "info", model: null });
    msg(t, run, "open:technical", "technical", at(2), bar, { claim: "Momentum holds above the session mean.", bias: "BULLISH", metrics: ["ema"] }, { stance });
    msg(t, run, "open:risk", "risk", at(2), bar, { claim: "Volatility is ordinary.", bias: "NEUTRAL", metrics: ["atr"] });
    msg(t, run, "debate:risk", "risk", at(3), bar, { argument: "The trend has support.", bias: "BULLISH", rebuts: ["technical"], conceded: true, metrics: ["atr"] }, { stance });
    if (concluded) msg(t, run, "conclusion", "moderator", at(4), bar, { summary: "The room leans long.", bias: "BULLISH", reasons: ["Momentum"], dissent: [], majority: { stance } }, { stance });
  };
  for (const bar of ["2026-11-15T23:15:00.000Z", "2026-11-15T23:30:00.000Z", "2026-11-15T23:45:00.000Z"]) {
    const day = "warroom:" + bar.slice(0, 10);
    thread(day, "warroom", bar);
    room(day, bar, bar, null);
  }
  thread("tf:H1", "timeframe", "2026-11-16T00:00:00.000Z");
  room("tf:H1", "2026-11-16T00:00:00.000Z", "2026-11-16T00:00:00.000Z", key(H1_OPEN));
  room("tf:H1", "2026-11-16T00:00:00.000Z#2", "2026-11-16T00:00:00.000Z", key(H1_OPEN), { stance: "WAIT" }); // reconvened: the candle's latest session
  room("tf:H1", "2026-11-16T01:00:00.000Z", "2026-11-16T01:00:00.000Z", key(H1_OPEN + 3_600_000));
  room("tf:H1", "2026-11-16T02:00:00.000Z", "2026-11-16T02:00:00.000Z", key(H1_OPEN + 7_200_000), { concluded: false }); // in progress
  return db;
}

test("decision cards from the run documents equal the cards from the messages, on the 15m and the 1H room", async () => {
  const db = await seeded();
  const now = Date.parse("2026-11-16T02:10:00Z");
  const on = { DB: db, ROOM_RUNS_SHADOW: "on", ROOM_RUNS_READ_CARDS: "on" };
  const off = { DB: db, ROOM_RUNS_SHADOW: "on" };
  assert.equal(await cardRuns(on, "tf:H1", 6, { now }), null, "before the backfill marker: the messages");
  await deriveRoomRuns(on, { now, backfill: true }); await deriveRoomRuns(on, { now, backfill: true });
  const runs = await cardRuns(on, "tf:H1", 6, { now });
  assert.deepEqual(runs.map((r) => [r.run_id, r.rows === null]), [["2026-11-16T02:00:00.000Z", true], ["2026-11-16T01:00:00.000Z", false], ["2026-11-16T00:00:00.000Z#2", false]], "the run in progress first, then one run per candle (its latest session)");
  for (const chart of ["15", "60"]) {
    const fromMessages = await loadDecisionCards(off, { chart, limit: 6 });
    const fromDocs = await loadDecisionCards(on, { chart, limit: 6 });
    assert.ok(fromMessages.length >= 3, `chart ${chart}: cards to compare`);
    assert.deepEqual(fromDocs, fromMessages, `chart ${chart}`);
  }
  assert.equal((await loadDecisionCards(on, { chart: "15", limit: 2 })).length, 2);
});

test("a failed conclusion retried after its document is derived again: the document follows the messages", async () => {
  const db = await seeded();
  const env = { DB: db, ROOM_RUNS_SHADOW: "on" };
  const run = "2026-11-16T01:00:00.000Z";
  db.raw.prepare("UPDATE agent_thread_messages SET status = 'budget_exhausted', stance = NULL WHERE thread_id = 'tf:H1' AND run_id = ? AND step = 'conclusion'").run(run);
  await deriveRoomRuns(env, { now: Date.parse("2026-11-16T01:10:00Z") });
  const docStatus = () => db.raw.prepare("SELECT json_extract(s.value, '$.status') AS st FROM room_runs r, json_each(r.body_json, '$.steps') s WHERE r.room = 'tf:H1' AND r.run_id = ? AND json_extract(s.value, '$.step') = 'conclusion'").get(run).st;
  assert.equal(docStatus(), "budget_exhausted");
  // The retry replaces the failure (writeMessage keeps the id, sets the new ts).
  db.raw.prepare("UPDATE agent_thread_messages SET status = 'ok', stance = 'BUY', ts = '2026-11-16T01:20:00.000Z' WHERE thread_id = 'tf:H1' AND run_id = ? AND step = 'conclusion'").run(run);
  const again = await deriveRoomRuns(env, { now: Date.parse("2026-11-16T01:30:00Z") });
  assert.equal(docStatus(), "ok");
  assert.ok(again.derived >= 1);
  assert.equal((await deriveRoomRuns(env, { now: Date.parse("2026-11-16T01:40:00Z") })).derived, 0, "then nothing left to derive");
});
