// ADR-0015 phase 2a (owner 2026-11-15): run documents derived from the stored room messages give outcome scoring
// exactly the statements it reads from the messages today; the hourly comparison records that, in shadow.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { buildRunDoc, statementsFromDocs, deriveRoomRuns, compareRoomRuns, roomRunsStatus, resetRoomRunsSchemaCacheForTests, roomRunsEnabled, roomRunsReadEnabled } from "../src/room-runs.mjs";
import { agentStatements } from "../src/outcome-scoring.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE agent_thread_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, step TEXT NOT NULL, parent_id INTEGER, agent TEXT NOT NULL, bar_time TEXT, ts TEXT NOT NULL, stance TEXT, confidence REAL, body_json TEXT, refs_json TEXT, model TEXT, status TEXT NOT NULL, latency_ms INTEGER, fallback_used INTEGER DEFAULT 0, usage_tokens INTEGER, UNIQUE(thread_id, run_id, step))`);
  db.exec(readFileSync(new URL("../migrations/0021_thread_bar_index.sql", import.meta.url), "utf8"));
  const wrap = (sql, params = []) => ({
    bind: (...a) => wrap(sql, a),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
const NOW = Date.parse("2026-11-13T21:30:00Z");
function put(db, threadId, runId, step, agent, stance, { status = "ok", bar, ts, conf = 0.6, body = {}, model = "m", fb = 0 } = {}) {
  db.raw.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, agent, bar_time, ts, stance, confidence, body_json, model, status, fallback_used, usage_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(threadId, runId, step, agent, bar, ts ?? bar, stance, stance ? conf : null, JSON.stringify(body), step === "brief" ? null : model, status, fb, step === "brief" ? null : 100);
}
function seed(db) {
  // A 15m War Room bar: an opening overridden by its debate, a failed debate that keeps the opening, a shadow seat.
  for (const bar of ["2026-11-13T19:45:00.000Z", "2026-11-13T20:00:00.000Z"]) {
    const t = "warroom:2026-11-13";
    put(db, t, bar, "brief", "system", null, { status: "info", body: { roster: ["prophet", "risk"] } , bar });
    put(db, t, bar, "open:prophet", "prophet", "BUY", { bar, body: { bias: "BULLISH" } });
    put(db, t, bar, "open:risk", "risk", "WAIT", { bar });
    put(db, t, bar, "shadow:projection", "projection", "SELL", { bar });
    put(db, t, bar, "debate:prophet", "prophet", "WAIT", { bar, conf: 0.5 });
    put(db, t, bar, "debate:risk", "risk", null, { bar, status: "invalid_output" });
    put(db, t, bar, "conclusion", "moderator", "WAIT", { bar, conf: 0.7, body: { summary: "Stand aside.", bias: "NEUTRAL" } });
  }
  // A 1H room that re-convened (#hud): the later session wins per agent.
  const key = "OANDA:XAUUSD:60:1794589200000", bar = "2026-11-13T19:00:00.000Z";
  for (const run of [bar, bar + "#hud"]) {
    put(db, "tf:H1", run, "brief", "system", null, { status: "info", bar, ts: "2026-11-13T19:05:00.000Z", body: { candle_key: key } });
    put(db, "tf:H1", run, "open:h1", "h1", run.endsWith("#hud") ? "SELL" : "BUY", { bar, ts: "2026-11-13T19:06:00.000Z" });
    put(db, "tf:H1", run, "conclusion", "moderator", "WAIT", { bar, ts: "2026-11-13T19:07:00.000Z", body: { summary: "Wait.", bias: "BEARISH" } });
  }
}

test("a run document keeps each agent's final position and the conclusion", () => {
  const db = d1(); seed(db);
  const rows = db.raw.prepare("SELECT * FROM agent_thread_messages WHERE thread_id = 'warroom:2026-11-13' AND run_id = '2026-11-13T20:00:00.000Z' ORDER BY id").all();
  const doc = buildRunDoc(rows, { threadId: "warroom:2026-11-13", runId: "2026-11-13T20:00:00.000Z" });
  assert.deepEqual([doc.room, doc.timeframe, doc.status, doc.stance, doc.bias, doc.confidence], ["warroom", "15", "concluded", "WAIT", "NEUTRAL", 0.7]);
  assert.equal(doc.candle_key, `OANDA:XAUUSD:15:${Date.parse("2026-11-13T19:45:00.000Z")}`, "the 15m bar's open");
  const by = Object.fromEntries(doc.body.agents.map((a) => [a.agent, a]));
  assert.deepEqual([by.prophet.stance, by.prophet.step], ["WAIT", "debate:prophet"], "the debate answer wins");
  assert.deepEqual([by.risk.stance, by.risk.step], ["WAIT", "open:risk"], "a failed debate keeps the opening");
  assert.equal(by.projection.seat, "shadow");
  assert.deepEqual([doc.agents_heard, doc.shadow_seats, doc.agents_failed], [2, 1, 0]);
  assert.equal(buildRunDoc(rows.filter((r) => r.step !== "conclusion"), { threadId: "warroom:2026-11-13", runId: "x" }), null, "no conclusion, no document");
});

test("the statements from the documents equal outcome scoring's statements from the messages", async () => {
  resetRoomRunsSchemaCacheForTests();
  const db = d1(); seed(db);
  const env = { DB: db, ROOM_RUNS_SHADOW: "on" };
  assert.deepEqual(await deriveRoomRuns(env, { now: NOW }), { status: "ok", derived: 4, skipped: 0 });
  assert.deepEqual(await deriveRoomRuns(env, { now: NOW }), { status: "ok", derived: 0, skipped: 0 }, "idempotent");
  const docs = db.raw.prepare("SELECT * FROM room_runs").all().map((r) => ({ ...r, body: JSON.parse(r.body_json) }));
  const norm = (m) => Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort((a, b) => a.subject.localeCompare(b.subject))]));
  for (const [tf, room] of [["15", "warroom"], ["60", "tf:H1"]]) {
    const expected = await agentStatements(env, tf, "2026-11-12T00:00:00.000Z", { now: NOW });
    assert.deepEqual(norm(statementsFromDocs(docs.filter((d) => d.room === room))), norm(expected), tf);
  }
  const compared = await compareRoomRuns(env, { now: NOW });
  assert.deepEqual([compared["15"].keys, compared["15"].equal, compared["15"].mismatched, compared["15"].missing], [2, 2, 0, 0]);
  assert.deepEqual([compared["60"].keys, compared["60"].equal], [1, 1]);
  const status = await roomRunsStatus(env);
  assert.equal(status.rooms.find((r) => r.room === "warroom").runs, 2);
  assert.equal(status.compares.length, 2);
});

test("a document missing for a scored bar is reported, and the switch is off unless set", async () => {
  resetRoomRunsSchemaCacheForTests();
  const db = d1(); seed(db);
  const env = { DB: db, ROOM_RUNS_SHADOW: "on" };
  await deriveRoomRuns(env, { now: NOW });
  db.raw.prepare("DELETE FROM room_runs WHERE run_id = '2026-11-13T19:45:00.000Z'").run();
  const compared = await compareRoomRuns(env, { now: NOW });
  assert.deepEqual([compared["15"].equal, compared["15"].missing], [1, 1]);
  assert.equal(roomRunsEnabled({}), false);
  assert.deepEqual(await deriveRoomRuns({ DB: db }), { status: "disabled" });
});

// ADR-0015 P2b, reader 1 (owner 2026-11-16): outcome scoring reads its room statements from the run documents.
const norm = (m) => Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort((a, b) => a.subject.localeCompare(b.subject))]));

test("scoring reads the run documents: the same statements, derived on demand, without reading the messages", async () => {
  resetRoomRunsSchemaCacheForTests();
  const db = d1(); seed(db);
  const SINCE = "2026-11-12T00:00:00.000Z";
  const env = { DB: db, ROOM_RUNS_SHADOW: "on", ROOM_RUNS_READ: "on" };
  assert.equal(roomRunsReadEnabled(env), true);
  assert.equal(roomRunsReadEnabled({ ROOM_RUNS_READ: "on" }), false, "no documents are derived without ROOM_RUNS_SHADOW");
  const before = db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'room_runs'").get().n;
  for (const tf of ["15", "60"]) {
    const fromMessages = await agentStatements({ DB: db }, tf, SINCE, { now: NOW });
    const fromDocs = await agentStatements(env, tf, SINCE, { now: NOW });
    assert.deepEqual(norm(fromDocs), norm(fromMessages), tf);
  }
  assert.equal(before, 0, "nothing was derived before the first read");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM room_runs").get().n, 4, "the read derived the pending runs itself");
  // Proof that the documents are what is read: change a document, and scoring sees the change.
  const doc = db.raw.prepare("SELECT run_id, body_json FROM room_runs WHERE room = 'warroom' AND run_id = '2026-11-13T20:00:00.000Z'").get();
  const body = JSON.parse(doc.body_json); body.conclusion.stance = "SELL";
  db.raw.prepare("UPDATE room_runs SET body_json = ? WHERE room = 'warroom' AND run_id = ?").run(JSON.stringify(body), doc.run_id);
  const read = await agentStatements(env, "15", SINCE, { now: NOW });
  assert.equal(read.get("2026-11-13T20:00:00.000Z").find((s) => s.subject === "agent:moderator").stance, "SELL");
  // The hourly comparison keeps reading the messages, so it flags that edited document.
  const compared = await compareRoomRuns(env, { now: NOW });
  assert.deepEqual([compared["15"].equal, compared["15"].mismatched], [1, 1]);
});

test("ROOM_RUNS_READ off is the rollback; bars before the derive window still come from the messages", async () => {
  resetRoomRunsSchemaCacheForTests();
  const db = d1(); seed(db);
  const off = { DB: db, ROOM_RUNS_SHADOW: "on", ROOM_RUNS_READ: "off" };
  await agentStatements(off, "15", "2026-11-12T00:00:00.000Z", { now: NOW });
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'room_runs'").get().n, 0, "off: the documents are not touched");
  // Five days later the seeded bars are outside the 48 h derive window: a wide window (the D1 lookback) still
  // gets them, from the messages, while newer bars come from the documents.
  const later = NOW + 5 * 86_400_000;
  const env = { DB: db, ROOM_RUNS_SHADOW: "on", ROOM_RUNS_READ: "on" };
  const wide = await agentStatements(env, "15", "2026-11-12T00:00:00.000Z", { now: later });
  const fromMessages = await agentStatements({ DB: db }, "15", "2026-11-12T00:00:00.000Z", { now: later });
  assert.deepEqual(norm(wide), norm(fromMessages));
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM room_runs").get().n, 0, "outside the window nothing is derived");
});
