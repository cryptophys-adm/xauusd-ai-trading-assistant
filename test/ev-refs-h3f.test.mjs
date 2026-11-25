// HAIC H3f-refs (owner "2. yes", 2026-11-25): every owner-judgeable output Nexus reads carries `ev_ref`, the ref the
// owner's correction cites (POST /omega/api/correction target.ref). Built on read with cfc-pack's evRef only: no
// D1 or KV write, no change to what the rooms, councils or agents say, every other key unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { REF_RE, PRICE_FIELDS } from "../src/cfc-pack.mjs";
import { parseRef, refCarriesPrice } from "../src/owner-corrections.mjs";
import { ensureThreadSchema, resetThreadSchemaCacheForTests } from "../src/agent-threads.mjs";
import { readWarRoom } from "../src/war-room.mjs";
import { readTimeframeThread } from "../src/timeframe-threads.mjs";
import { deriveRoomRuns, cardRuns, resetRoomRunsSchemaCacheForTests } from "../src/room-runs.mjs";
import { loadDecisionCards, cardLeaks } from "../src/decision-cards.mjs";
import { listSessions, readSession, listProposals, resetSessionSchemaForTests } from "../src/cfc-session.mjs";
import { seedEnv } from "./support/cfc-fixtures.mjs";
import { readCouncilVerdicts, COUNCIL_KEY } from "../src/strategy-council.mjs";

const PRICE = new Set(PRICE_FIELDS);

/** A valid ref of `source` naming `id`: no price-like number and no price field outside its id; the correction route parses it. */
function assertRef(ref, source, id, { field = null } = {}) {
  assert.equal(typeof ref, "string", `a ref for ${source}/${id}`);
  assert.match(ref, REF_RE);
  const m = /^ev:xauusd\/([a-z][a-z0-9_]*)\/([^\s@#]+)(?:@([^\s@#]+))?(?:#(.+))?$/.exec(ref);
  assert.ok(m, ref);
  const [, src, rid, asOf, fld] = m;
  assert.equal(src, source);
  assert.equal(rid, String(id));
  assert.equal(asOf, undefined, "no as_of");
  assert.equal(fld ?? null, field);
  const outside = ref.slice(0, "ev:xauusd/".length + src.length + 1) + (fld ? "#" + fld : "");
  assert.doesNotMatch(outside, /\d{3,}/, `no price-like number outside the id: ${ref}`);
  if (fld) for (const part of fld.split(/[._]/)) assert.ok(!PRICE.has(part), `never a price field: ${ref}`);
  const parsed = parseRef(ref);
  assert.ok(parsed, `the correction route parses ${ref}`);
  assert.equal(refCarriesPrice(parsed), false);
}
const without = (o) => { const { ev_ref, ...rest } = o; return rest; };

// ------------------------------------------------------------ rooms
function roomsDb() {
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

const BAR = "2026-11-15T23:45:00.000Z";
const H1_RUN = "2026-11-16T00:00:00.000Z";
const H1_KEY = "OANDA:XAUUSD:60:" + Date.parse("2026-11-15T23:00:00Z");

async function seededRooms() {
  resetThreadSchemaCacheForTests(); resetRoomRunsSchemaCacheForTests();
  const db = roomsDb();
  await ensureThreadSchema(db);
  const thread = (id, kind, at) => db.raw.prepare("INSERT OR IGNORE INTO agent_threads (id, kind, ref_key, title, post_json, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, ?)").run(id, kind, id, id, at, at);
  const msg = (t, run, step, agent, ts, bar, body, { stance = "WAIT", status = "ok" } = {}) => db.raw.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, agent, bar_time, ts, stance, confidence, body_json, model, status, usage_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, 0.6, ?, 'm', ?, 500)").run(t, run, step, agent, bar, ts, stance, JSON.stringify(body), status);
  const room = (t, run, bar, k, { shadow = false } = {}) => {
    const at = (m) => new Date(Date.parse(String(run).split("#")[0]) + m * 60_000).toISOString();
    msg(t, run, "brief", "system", at(1), bar, { roster: ["technical", "risk"], candle_key: k, bar_time: bar }, { status: "info" });
    msg(t, run, "open:technical", "technical", at(2), bar, { claim: "Momentum holds above the session mean.", bias: "BULLISH", metrics: ["ema"] }, { stance: "BUY" });
    msg(t, run, "open:risk", "risk", at(2), bar, { claim: "Volatility is ordinary.", bias: "NEUTRAL", metrics: ["atr"] });
    if (shadow) msg(t, run, "shadow:fabio_amt", "fabio_amt", at(2), bar, { claim: "A shadow answer.", bias: "NEUTRAL", metrics: ["poc"] });
    msg(t, run, "debate:risk", "risk", at(3), bar, { argument: "The trend has support.", bias: "BULLISH", rebuts: ["technical"], conceded: true, metrics: ["atr"] }, { stance: "BUY" });
    msg(t, run, "conclusion", "moderator", at(4), bar, { summary: "The room leans long.", bias: "BULLISH", reasons: ["Momentum"], dissent: [], majority: { stance: "BUY" } }, { stance: "BUY" });
  };
  thread("warroom:2026-11-15", "warroom", BAR);
  room("warroom:2026-11-15", BAR, BAR, null, { shadow: true });
  thread("tf:H1", "timeframe", H1_RUN);
  room("tf:H1", H1_RUN, H1_RUN, H1_KEY);
  room("tf:H1", H1_RUN + "#2", H1_RUN, H1_KEY); // reconvened: its run_id carries '#', its rows do not
  return db;
}
const idOf = (db, thread, run, step) => db.raw.prepare("SELECT id FROM agent_thread_messages WHERE thread_id = ? AND run_id = ? AND step = ?").get(thread, run, step).id;

const WAR_ROOM_PICK = ["id", "name", "status", "model", "fallback_used", "errors", "stance", "bias", "confidence", "ts", "claim", "argument", "rebuts", "rebuts_names", "conceded", "metrics"];
const TF_PICK = ["id", "name", "status", "stance", "bias", "confidence", "ts", "claim", "argument", "rebuts", "rebuts_names", "conceded", "metrics", "calibration"];
const CONCLUSION_KEYS = ["status", "stance", "bias", "majority_bias", "confidence", "summary", "reasons", "dissent", "majority", "h1_decision", "ts", "model", "fallback_used"];

test("H3F-R1. War Room: openings, debate and the conclusion carry their message row's ref; shadow openings none; other keys unchanged", async () => {
  const db = await seededRooms();
  const room = await readWarRoom(db, { barTime: BAR });
  const t = "warroom:2026-11-15";
  assert.deepEqual(room.openings.map((o) => o.id), ["technical", "risk"]);
  for (const o of room.openings) {
    assert.deepEqual(Object.keys(o), [...WAR_ROOM_PICK, "ev_ref"]);
    assertRef(o.ev_ref, "agent_thread_messages", idOf(db, t, BAR, `open:${o.id}`));
  }
  assert.equal(room.debate.length, 1);
  assert.deepEqual(Object.keys(room.debate[0]), [...WAR_ROOM_PICK, "ev_ref"]);
  assertRef(room.debate[0].ev_ref, "agent_thread_messages", idOf(db, t, BAR, "debate:risk"));
  assert.deepEqual(Object.keys(room.conclusion), [...CONCLUSION_KEYS, "ev_ref"]);
  assertRef(room.conclusion.ev_ref, "agent_thread_messages", idOf(db, t, BAR, "conclusion"));
  assert.equal(room.shadow_openings.length, 1);
  assert.deepEqual(Object.keys(room.shadow_openings[0]), WAR_ROOM_PICK, "a shadow opening is left out");
  assert.equal(new Set([...room.openings, ...room.debate, room.conclusion].map((x) => x.ev_ref)).size, 4, "one ref per message");
  // Read-only: nothing written.
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM agent_thread_messages").get().n, 16);
});

test("H3F-R2. timeframe room: openings, debate and the conclusion carry their row's ref; a reconvened run's ref has no '#'", async () => {
  const db = await seededRooms();
  for (const run of [H1_RUN, H1_RUN + "#2"]) {
    const room = await readTimeframeThread(db, "H1", { runId: run });
    assert.equal(room.reconvened, run.includes("#"));
    for (const o of room.openings) {
      assert.deepEqual(Object.keys(o), [...TF_PICK, "ev_ref"]);
      assertRef(o.ev_ref, "agent_thread_messages", idOf(db, "tf:H1", run, `open:${o.id}`));
    }
    assertRef(room.debate[0].ev_ref, "agent_thread_messages", idOf(db, "tf:H1", run, "debate:risk"));
    assert.deepEqual(Object.keys(room.conclusion), [...CONCLUSION_KEYS.filter((k) => k !== "h1_decision" && k !== "ts"), "ev_ref"]);
    assertRef(room.conclusion.ev_ref, "agent_thread_messages", idOf(db, "tf:H1", run, "conclusion"));
    for (const x of [...room.openings, ...room.debate, room.conclusion]) assert.ok(!x.ev_ref.includes("#"), "the row id, never the run id");
  }
  const latest = await readTimeframeThread(db, "H1", { candleKey: H1_KEY });
  assertRef(latest.conclusion.ev_ref, "agent_thread_messages", idOf(db, "tf:H1", H1_RUN + "#2", "conclusion"));
});

test("H3F-R3. from the run documents (room_runs) the refs are the same; a document step without an id gives null; the decision cards carry none", async () => {
  const db = await seededRooms();
  const now = Date.parse("2026-11-16T00:30:00Z");
  const on = { DB: db, ROOM_RUNS_SHADOW: "on", ROOM_RUNS_READ_CARDS: "on" };
  await deriveRoomRuns(on, { now, backfill: true }); await deriveRoomRuns(on, { now, backfill: true });
  const [doc] = await cardRuns(on, "tf:H1", 1, { now });
  assert.ok(doc?.rows?.length, "the 1H run from its document");
  assert.ok(doc.rows.every((r) => Number.isInteger(r.id)), "document steps keep the message id");
  assert.deepEqual(await readTimeframeThread(db, "H1", { runId: doc.run_id, rows: doc.rows }), await readTimeframeThread(db, "H1", { runId: doc.run_id }));
  const [wr] = await cardRuns(on, "warroom", 1, { now });
  assert.deepEqual(await readWarRoom(db, { barTime: wr.run_id, rows: wr.rows }), await readWarRoom(db, { barTime: BAR }));
  // A step without an id: null, never an invented ref.
  const noId = doc.rows.map(({ id, ...r }) => (r.step === "conclusion" || r.step === "open:risk" ? r : { id, ...r }));
  const room = await readTimeframeThread(db, "H1", { runId: doc.run_id, rows: noId });
  assert.equal(room.conclusion.ev_ref, null);
  assert.equal(room.openings.find((o) => o.id === "risk").ev_ref, null);
  assert.match(room.openings.find((o) => o.id === "technical").ev_ref, REF_RE);
  const wrNoId = await readWarRoom(db, { barTime: wr.run_id, rows: wr.rows.map(({ id, ...r }) => r) });
  assert.ok([...wrNoId.openings, ...wrNoId.debate, wrNoId.conclusion].every((x) => x.ev_ref === null));
  for (const chart of ["15", "60"]) {
    const cards = await loadDecisionCards(on, { chart, limit: 4 });
    assert.ok(cards.length >= 1);
    for (const card of cards) { assert.ok(!JSON.stringify(card).includes("ev_ref") && !JSON.stringify(card).includes("ev:xauusd"), "a card never carries a ref"); assert.deepEqual(cardLeaks(card), []); }
  }
});

// ------------------------------------------------------------ Call for Councils
async function seededCouncil() {
  resetSessionSchemaForTests();
  const env = await seedEnv();
  await listSessions(env); // the schema
  const raw = env.DB.db;
  const options = { summary: "Most want a wider SL+ lock.", options: [
    { option_id: "wider_lock", rank: 1, kind: "repository_task", title: "Lock SL+ one level later", hypothesis: "fewer early exits", change: "later lock", risk: "smaller wins", dissent: null, spec: "build it" },
    { option_id: "no_change", rank: 2, kind: "no_change", title: "No change (the control)", hypothesis: "What runs today stays.", change: "none", risk: "none", dissent: null }
  ] };
  const ins = raw.prepare("INSERT INTO council_sessions (id, topic_key, topic_text, type, question, state, participants, pack_hash, pack_json, calls, options, reason, created_by, created_ms, updated_ms) VALUES (?, 'strategy:zone_pullback:exits', NULL, 'strategy', 'Exits?', ?, '[\"risk\",\"technical\"]', 'h', '{\"refs\":[\"ev:xauusd/signal_ledger/a#r_tp1\"]}', 3, ?, NULL, 'owner', ?, ?)");
  ins.run("cfc_mi0abc_x1y2z3", "awaiting_owner", JSON.stringify(options), 1_000, 1_000);
  ins.run("cfc_mi0abd_q7r8s9", "positions", null, 2_000, 2_000);
  const msg = raw.prepare("INSERT INTO council_messages (session_id, round, seat, stance, opinion, proposal, reply_to, refs, ms) VALUES ('cfc_mi0abc_x1y2z3', ?, ?, ?, ?, ?, '[]', '[]', ?)");
  msg.run("position", "risk", "oppose", "The stops are fine.", null, 1_100);
  msg.run("position", "technical", "support", "Lock later.", "Try a later SL+ lock", 1_200);
  msg.run("owner", "owner", null, "Why not lock at break-even?", null, 1_300);
  raw.prepare("INSERT INTO council_proposals (id, session_id, option_id, kind, title, knob, from_value, value, spec, option_json, state, note, report_id, accepted_by, accepted_ms, updated_ms) VALUES ('cp_mi0abe_k4l5m6', 'cfc_mi0abc_x1y2z3', 'wider_lock', 'repository_task', 'Lock SL+ one level later', NULL, NULL, NULL, 'build it', '{}', 'handoff_pending', NULL, NULL, 'owner', 3000, 3000)").run();
  return { env, raw, options };
}

test("H3F-R4. Call for Councils: sessions, a session, its messages and options, and the proposals carry their refs; other keys unchanged", async () => {
  const { env, raw, options } = await seededCouncil();
  const before = raw.prepare("SELECT (SELECT COUNT(*) FROM council_sessions) + (SELECT COUNT(*) FROM council_messages) + (SELECT COUNT(*) FROM council_proposals) AS n").get().n;
  const listed = await listSessions(env);
  assert.deepEqual(listed.sessions.map((s) => s.id), ["cfc_mi0abd_q7r8s9", "cfc_mi0abc_x1y2z3"]);
  for (const s of listed.sessions) {
    assert.deepEqual(Object.keys(s), ["id", "topic_key", "topic_text", "type", "question", "state", "participants", "calls", "reason", "created_ms", "updated_ms", "pack_refs", "created_at", "pack_stale", "ev_ref"]);
    assertRef(s.ev_ref, "council_sessions", s.id);
  }
  const s = await readSession(env, "cfc_mi0abc_x1y2z3");
  assertRef(s.ev_ref, "council_sessions", "cfc_mi0abc_x1y2z3");
  assert.equal(Object.keys(s).at(-1), "ev_ref");
  assert.deepEqual(Object.keys(without(s)), ["id", "topic_key", "topic_text", "type", "question", "state", "participants", "calls", "options", "reason", "pack_hash", "created_by", "created_ms", "updated_ms", "pack_refs", "pack_stale", "terminal", "messages"]);
  const ids = raw.prepare("SELECT id FROM council_messages WHERE session_id = 'cfc_mi0abc_x1y2z3' ORDER BY id").all().map((r) => r.id);
  assert.deepEqual(s.messages.map((m) => m.id), ids);
  for (const m of s.messages) {
    assert.deepEqual(Object.keys(m), ["id", "round", "seat", "stance", "opinion", "proposal", "reply_to", "refs", "ms", "name", "at", "ev_ref"]);
    assertRef(m.ev_ref, "council_messages", m.id);
  }
  assert.equal(s.options.summary, options.summary);
  assert.deepEqual(s.options.options.map(without), options.options, "each option otherwise as stored");
  for (const o of s.options.options) assertRef(o.ev_ref, "council_sessions", "cfc_mi0abc_x1y2z3", { field: `options.${o.option_id}` });
  const other = await readSession(env, "cfc_mi0abd_q7r8s9");
  assert.equal(other.options, null, "no options yet: nothing added");
  assertRef(other.ev_ref, "council_sessions", "cfc_mi0abd_q7r8s9");
  const { proposals } = await listProposals(env);
  assert.equal(proposals.length, 1);
  assert.deepEqual(Object.keys(proposals[0]), ["id", "session_id", "option_id", "kind", "title", "knob", "from_value", "value", "spec", "state", "note", "report_id", "accepted_by", "accepted_ms", "updated_ms", "accepted_at", "ev_ref"]);
  assertRef(proposals[0].ev_ref, "council_proposals", "cp_mi0abe_k4l5m6");
  // Read-only: the stored rows and the stored options are unchanged.
  assert.equal(raw.prepare("SELECT (SELECT COUNT(*) FROM council_sessions) + (SELECT COUNT(*) FROM council_messages) + (SELECT COUNT(*) FROM council_proposals) AS n").get().n, before);
  assert.equal(raw.prepare("SELECT options FROM council_sessions WHERE id = 'cfc_mi0abc_x1y2z3'").get().options, JSON.stringify(options));
});

test("H3F-R5. a session's options that are not the parsed object with an options array are returned as stored", async () => {
  const { env, raw } = await seededCouncil();
  raw.prepare("UPDATE council_sessions SET options = ? WHERE id = 'cfc_mi0abd_q7r8s9'").run(JSON.stringify({ summary: "no list" }));
  assert.deepEqual((await readSession(env, "cfc_mi0abd_q7r8s9")).options, { summary: "no list" });
  raw.prepare("UPDATE council_sessions SET options = 'not json' WHERE id = 'cfc_mi0abd_q7r8s9'").run();
  assert.equal((await readSession(env, "cfc_mi0abd_q7r8s9")).options, null);
});

// ------------------------------------------------------------ strategy council
test("H3F-R6. strategy council: each verdict carries its strategy_council_runs ref (day/strategy, #proposal), built on read; the KV document is not rewritten", async () => {
  const doc = { version: "cryptophys.strategy-council.v1", day: "2026-11-25", computed_at: "2026-11-25T00:20:00.000Z", acting: false, ceiling: "off", auto: false, max_armed: 3, rules: { learn_days: 60 },
    verdicts: {
      sweep_reversal: { walk_forward: { status: "pass", n: 40, mean_r: 0.45 }, proposal: "arm", reason: "strong walk-forward", applied: "proposal only" },
      range_fade: { walk_forward: { status: "fail", n: 40, mean_r: -0.4 }, proposal: "keep", reason: "the facts allow only keep", applied: null }
    } };
  const stored = JSON.stringify(doc);
  let puts = 0;
  const env = { SIGNAL_CACHE: { get: async (k) => (k === COUNCIL_KEY ? stored : null), put: async () => { puts += 1; } } };
  const read = await readCouncilVerdicts(env);
  assert.equal(puts, 0, "no KV write");
  assert.deepEqual(Object.keys(read), Object.keys(doc));
  assert.deepEqual({ ...read, verdicts: null }, { ...doc, verdicts: null });
  for (const [id, v] of Object.entries(read.verdicts)) {
    assert.deepEqual(without(v), doc.verdicts[id]);
    assert.equal(Object.keys(v).at(-1), "ev_ref");
    assertRef(v.ev_ref, "strategy_council_runs", `2026-11-25/${id}`, { field: "proposal" });
  }
  assert.equal(read.verdicts.sweep_reversal.ev_ref, "ev:xauusd/strategy_council_runs/2026-11-25/sweep_reversal#proposal");
  // No day: null, never an invented ref; no document: null.
  const noDay = await readCouncilVerdicts({ SIGNAL_CACHE: { get: async () => JSON.stringify({ ...doc, day: undefined }) } });
  assert.ok(Object.values(noDay.verdicts).every((v) => v.ev_ref === null));
  assert.equal(await readCouncilVerdicts({ SIGNAL_CACHE: { get: async () => null } }), null);
  assert.equal(await readCouncilVerdicts({}), undefined, "no KV: as before");
});


test("H3F-R7. an option ref the correction route would refuse is null; the others are kept", async () => {
  const { optionRef } = await import("../src/cfc-session.mjs");
  assert.equal(optionRef("cfc_mi0abc_x1y2z3", "no_change"), "ev:xauusd/council_sessions/cfc_mi0abc_x1y2z3#options.no_change");
  for (const bad of ["a-b", "x:y", "tighten_stop", "move_tp", "raise_entry", "level_2650", "keep_100"]) assert.equal(optionRef("cfc_mi0abc_x1y2z3", bad), null, bad);
});
