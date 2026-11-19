// The room guardrail per trading mode, tuned by the learning protocol (owner 2026-11-19: "guardrail room biarkan
// protocol learning dan knowledge yang melakukan adjustment secara dinamis", then "sesuai rekomendasimu": bounds 0.5 to
// 1.5 times the 1H average range, the value in force an operational doctrine fact). src/room-tuning.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ROOM_MIN, ROOM_MAX, ROOM_DEFAULT, ROOM_MODES, clampRoom, neighbourRooms, roomPasses, withRoom, compareRooms, roomAutoDecision,
  roomRollbackDecision, applyRoomTuning, activeRoom, roomTuningMessage, roomTuningReport, loadRoomDecisions, roomMode,
  resetRoomTuningCacheForTests, ROOM_REPORT_VERSION
} from "../src/room-tuning.mjs";
import { roomAtrOf, SQUEEZE_RULE } from "../src/strategy-engine.mjs";
import { EXTENDED_WITNESS_WEIGHTS, assess, buildDecisionRecord, decisionKeyFor, resetDecisionSchemaCacheForTests } from "../src/decision-engine.mjs";
import { nexusFacts } from "../src/doctrine-facts.mjs";

const M15 = 900_000, DAY = 86_400_000;
const T0 = Date.parse("2026-11-02T00:00:00Z");

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args.map((v) => (v === undefined ? null : v))),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
test.beforeEach(() => { resetRoomTuningCacheForTests(); resetDecisionSchemaCacheForTests(); });

const IDS = ["market_open", "fresh", "quorum", "no_veto", "levels", "reward", "room"];
/**
 * A scalp decision the room alone held back: the long passes every other check (the daily room leans bullish, more
 * than 45% of the weight), the corridor is 0.8 of the 1H range (failed at 1); the short has no plan and no quorum.
 */
const decision = (i, over = {}) => ({
  key: `OANDA:XAUUSD:15:${T0 + i * M15}`, close_ms: T0 + (i + 1) * M15, mode: "scalp", decided_ms: T0 + (i + 1) * M15 + 60_000,
  witnesses: [{ key: "D1", available: true, stale: false, lean: 0.5, at: null }, { key: "H4", available: true, stale: false, lean: 0.5, at: null }, { key: "NEWS", available: true, stale: false, lean: -0.5, at: null }],
  checks: { long: IDS.map((id) => ({ id, pass: id !== "room" })), short: IDS.map((id) => ({ id, pass: !["levels", "quorum", "room"].includes(id) })) },
  room: { measured: true, ratio: 0.8 }, room_atr: 1, recorded_room: false,
  ...over
});
// The synthetic market: every BUY is right, every WAIT misses the move.
const outcome = (_key, _close, stance) => (stance === "BUY" ? "hit" : "missed_opportunity");

test("RT1 the bounds hold: 0.5 to 1.5 in every mode, steps of 0.25, the default 1; the guard reads only a bounded value", () => {
  assert.deepEqual([ROOM_MIN, ROOM_MAX, ROOM_DEFAULT], [0.5, 1.5, 1]);
  assert.deepEqual([...ROOM_MODES], ["scalp", "intraday", "swing", "range"]);
  assert.deepEqual([clampRoom(0.1), clampRoom(3), clampRoom("0.75"), clampRoom("x")], [0.5, 1.5, 0.75, null]);
  assert.deepEqual(neighbourRooms(1).map((a) => a.value), [1.25, 0.75]);
  assert.deepEqual(neighbourRooms(0.5).map((a) => a.value), [0.75], "never below the floor: the guard is never switched off");
  assert.deepEqual(neighbourRooms(1.5).map((a) => a.value), [1.25]);
  assert.deepEqual([roomAtrOf(undefined), roomAtrOf(null), roomAtrOf(0), roomAtrOf(9), roomAtrOf(0.75)], [1, 1, 0.5, 1.5, 0.75]);
  assert.deepEqual([SQUEEZE_RULE.min_atr, SQUEEZE_RULE.max_atr], [ROOM_MIN, ROOM_MAX]);
  assert.deepEqual([roomMode("SCALP"), roomMode("range"), roomMode(null), roomMode("weird")], ["scalp", "range", "intraday", "intraday"]);
});

test("RT2 the replay: the room check is recomputed from the stored corridor, unmeasured stays failed, every other check keeps its record", () => {
  assert.equal(roomPasses({ measured: true, ratio: 0.7 }, 1), false);
  assert.equal(roomPasses({ measured: true, ratio: 0.7 }, 0.75), false);
  assert.equal(roomPasses({ measured: true, ratio: 0.75 }, 0.75), true);
  assert.equal(roomPasses({ measured: true, ratio: null }, 1.5), true, "no zone on one side: room to move");
  assert.equal(roomPasses({ measured: false, ratio: null }, 0.5), false, "fail-closed when the room could not be measured");
  const d = decision(0, { room: { measured: true, ratio: 0.8 } });
  assert.equal(withRoom(d, 0.75).checks.long.find((c) => c.id === "room").pass, true);
  assert.equal(withRoom(d, 1).checks.short.find((c) => c.id === "room").pass, false);
  assert.equal(withRoom(d, 0.75).checks.long.find((c) => c.id === "reward").pass, true);
  assert.equal(withRoom(decision(0, { checks: { long: [{ id: "quorum", pass: true }], short: [{ id: "quorum", pass: false }] } }), 1), null, "a decision from before the guard is not replayed");
});

test("RT3 per mode: discovery, Holm and holdout find the looser scalp room; other modes are untouched; cooldown and rollback history hold", () => {
  const scalp = Array.from({ length: 400 }, (_, i) => decision(i));
  const intraday = Array.from({ length: 50 }, (_, i) => decision(1000 + i, { mode: "intraday" }));
  const now = T0 + 1100 * M15;
  const replay = compareRooms({ decisions: [...scalp, ...intraday], outcome, weights: EXTENDED_WITNESS_WEIGHTS, now });
  assert.equal(replay.modes.scalp.decisions, 400);
  assert.equal(replay.modes.scalp.accuracy, 0, "the control WAITs miss");
  assert.deepEqual(replay.modes.scalp.fidelity, { checks: 400, matched: 400, share: 1 });
  const down = replay.candidates.find((c) => c.id === "room:scalp:0.75");
  assert.equal(down.discovery.bars, 300);
  assert.equal(down.holdout.bars, 100);
  assert.ok(down.discovery.p_holm < 0.05);
  assert.match(down.verdict, /^better_than_active/);
  assert.equal(replay.candidates.find((c) => c.id === "room:scalp:1.25").verdict, "not_better", "a tighter room changes nothing here");
  assert.ok(replay.candidates.filter((c) => c.mode === "intraday").every((c) => c.verdict === "collecting"), "50 intraday decisions judge nothing");
  const state = { active: 1, previous: null, history: [] };
  const d = roomAutoDecision(state, replay, "scalp", { now });
  assert.deepEqual([d.action, d.value], ["activate", 0.75]);
  assert.equal(roomAutoDecision(state, replay, "intraday", { now }).action, "none");
  assert.match(roomAutoDecision({ ...state, history: [{ kind: "activated", at: new Date(now - 2 * DAY).toISOString() }] }, replay, "scalp", { now }).reason, /7 days/);
  assert.equal(roomAutoDecision({ ...state, history: [{ kind: "rolled_back", from: 0.75, at: new Date(now - 30 * DAY).toISOString() }] }, replay, "scalp", { now }).action, "none", "a value rolled back before is never activated again");
});

test("RT4 the reverse shadow: a previous value that does better over 100 decisions of the mode wins back", () => {
  // Active 0.75 (BUY, now wrong), previous 1 (WAIT, now right).
  const decisions = Array.from({ length: 150 }, (_, i) => decision(i, { room: { measured: true, ratio: 0.8 } }));
  const wrongBuys = (_k, _c, stance) => (stance === "BUY" ? "miss" : "hit");
  const replay = compareRooms({ decisions, outcome: wrongBuys, weights: EXTENDED_WITNESS_WEIGHTS, active: { scalp: 0.75 }, previous: { scalp: 1 }, activatedAt: { scalp: new Date(T0).toISOString() }, now: T0 + 151 * M15 });
  assert.equal(replay.modes.scalp.reverse.rooms, 150);
  assert.equal(replay.modes.scalp.reverse.previous_better, 150);
  assert.equal(roomRollbackDecision({ previous: 1 }, replay.modes.scalp).rollback, true);
  assert.equal(roomRollbackDecision({ previous: 1 }, { reverse: { ...replay.modes.scalp.reverse, rooms: 60 } }).rollback, false);
  assert.equal(roomRollbackDecision({ previous: null }, replay.modes.scalp).rollback, false);
});

test("RT5 applied in D1: the scalp value moves, the others stay; the engine reads it; Telegram; rollback; frozen changes nothing", async () => {
  const env = { DB: fakeD1() };
  const now = T0 + 1100 * M15;
  const replay = compareRooms({ decisions: Array.from({ length: 400 }, (_, i) => decision(i)), outcome, weights: EXTENDED_WITNESS_WEIGHTS, now });
  assert.deepEqual(await activeRoom(env, "scalp", { now }), { mode: "scalp", value: 1, source: "default", activated_at: null });
  const applied = await applyRoomTuning(env, { replay, now });
  assert.equal(applied.status, "changed");
  assert.deepEqual(applied.changes.map((c) => [c.mode, c.from, c.to]), [["scalp", 1, 0.75]]);
  resetRoomTuningCacheForTests();
  assert.equal((await activeRoom(env, "scalp", { now })).value, 0.75);
  assert.equal((await activeRoom(env, "scalp", { now })).source, "auto_tuned");
  assert.equal((await activeRoom(env, "intraday", { now })).value, 1);
  const line = roomTuningMessage(applied.changes[0]);
  assert.match(line, /^Auto-tuning \(room guardrail, scalp\): the key zones around price must now be at least 0\.75 times the 1H average range apart \(was 1; bounds 0\.5 to 1\.5\)/);
  assert.doesNotMatch(line, /\d{4}\.\d/, "no price");
  // Again at once: the cooldown holds.
  assert.equal((await applyRoomTuning(env, { replay, now: now + 60_000 })).status, "unchanged");
  // Frozen: every mode back at 1, nothing changes.
  const frozen = { ...env, ROOM_TUNING_MODE: "default" };
  assert.equal((await activeRoom(frozen, "scalp", { now })).value, 1);
  assert.equal((await applyRoomTuning(frozen, { replay, now })).status, "frozen");
  // Rollback: the reverse shadow says the previous 1 was better.
  const back = { modes: { scalp: { reverse: { rooms: 150, previous_better: 120, active_better: 10, p_value: 0.0001 } } }, candidates: [] };
  const rolled = await applyRoomTuning(env, { replay: back, now: now + 20 * DAY });
  assert.deepEqual(rolled.changes.map((c) => [c.status, c.mode, c.from, c.to]), [["rolled_back", "scalp", 0.75, 1]]);
  resetRoomTuningCacheForTests();
  assert.equal((await activeRoom(env, "scalp", { now })).value, 1);
  // A corrupt stored value never reaches the guard.
  env.DB.raw.prepare("UPDATE room_tuning_state SET active = 9 WHERE mode = 'scalp'").run();
  resetRoomTuningCacheForTests();
  assert.equal((await activeRoom(env, "scalp", { now })).value, 1.5, "held inside the bounds");
  assert.deepEqual(await activeRoom({}, "swing"), { mode: "swing", value: 1, source: "default", activated_at: null }, "no database: the rule's 1");
});

test("RT6 the live guard and the record use the mode's value; the decisions load back from D1 with their corridor", async () => {
  const zone = (low, high) => ({ low, high, price: (low + high) / 2, candidate: true });
  const CLOSE = "2026-11-10T10:00:00.000Z", NOW = Date.parse(CLOSE) + 60_000;
  const r = (key, lean, action = "WAIT") => ({ key, label: key, role: key, available: true, lean, action, confidence: 0.6, summary: `${key} reads the chart.`, at: CLOSE, stale: false });
  // 7 apart against a 1H range of 10: squeezed at 1, room enough at 0.5.
  const loaded = { inputs: { calendar: { events: [] }, m15Bars: [] }, strategy: { decision: "WAIT", state: "SETUP_READY", direction: "LONG", confidence: 0.6, alignment: 0.5, headline: "h", price: 4000, atr_h1: 10, key_levels: { zones: [zone(3990, 3997), zone(4004, 4010)] }, plan: { at_level: true } },
    global: { timeframes: [r("D1", 0.5), r("H4", 0.4), r("H1", 0.3), r("M15", 0.35, "BUY"), r("NEWS", 0.2), r("MACRO", 0.1)] }, correlations: null, regime: "normal-trending" };
  const roomOf = (env) => assess(loaded, { now: NOW, env }).guards.long.checks.find((c) => c.id === "room");
  assert.equal(roomOf({}).pass, false);
  assert.equal(roomOf({ ROOM_CORRIDOR_ATR: 0.5 }).pass, true);
  assert.match(roomOf({ ROOM_CORRIDOR_ATR: 0.5 }).detail, /0\.7 times the 1H average range; at least 0\.5 needed/);
  assert.match(roomOf({ ROOM_CORRIDOR_ATR: 1.25 }).detail, /less than 1\.25 times the 1H average range \(12\.50\)/);
  assert.equal(roomOf({ ROOM_CORRIDOR_ATR: 0.1 }).pass, true, "0.1 is held at the floor 0.5: 0.7 passes");
  assert.equal(roomOf({ ROOM_CORRIDOR_ATR: 0.1 }).detail.includes("at least 0.5 needed"), true);
  const env = { ROOM_CORRIDOR_ATR: 0.5 };
  const rec = buildDecisionRecord({ key: decisionKeyFor(CLOSE), barClose: CLOSE, loaded, assessment: assess(loaded, { now: NOW, env }), council: null, now: NOW, env });
  assert.deepEqual([rec.room_atr, rec.squeeze.squeezed, rec.squeeze.corridor_atr], [0.5, false, 0.7]);
  // Back from D1: the projection the replay reads.
  const db = fakeD1();
  db.raw.exec("CREATE TABLE engine_decisions (decision_key TEXT PRIMARY KEY, bar_close TEXT NOT NULL, decided_at TEXT NOT NULL, stance TEXT NOT NULL, confidence REAL, source TEXT NOT NULL, decision_json TEXT NOT NULL)");
  db.raw.prepare("INSERT INTO engine_decisions VALUES (?, ?, ?, ?, ?, ?, ?)").run(rec.decision_key ?? decisionKeyFor(CLOSE), CLOSE, rec.decided_at ?? CLOSE, rec.stance, 0.5, "test", JSON.stringify({ ...rec, trading_mode: "scalp" }));
  const [d] = await loadRoomDecisions(db, "2026-11-01T00:00:00.000Z");
  assert.equal(d.mode, "scalp");
  assert.deepEqual(d.room, { measured: true, ratio: 0.7 });
  assert.equal(d.room_atr, 0.5);
  assert.equal(d.recorded_room, true);
  assert.equal(roomPasses(d.room, d.room_atr), d.recorded_room, "the replay reproduces the recorded check");
});

test("RT7 the report for Aether and the doctrine facts carry values only", async () => {
  const replay = compareRooms({ decisions: Array.from({ length: 10 }, (_, i) => decision(i)), outcome, weights: EXTENDED_WITNESS_WEIGHTS, now: T0 + 20 * M15 });
  const report = roomTuningReport({ ...replay, mode: "auto", window_days: 21, history: {} }, { now: T0 });
  assert.equal(report.version, ROOM_REPORT_VERSION);
  assert.equal(report.timeframe, "room");
  assert.deepEqual(report.active.params, { scalp: 1, intraday: 1, swing: 1, range: 1 });
  assert.deepEqual(report.bounds, { min: 0.5, max: 1.5, step: 0.25, default: 1 });
  assert.ok(report.candidates.every((c) => Object.keys(c.params).length === 1));
  assert.doesNotMatch(JSON.stringify(report), /"(price|entry|stop|tp|volume|lot)"/);
  const facts = await nexusFacts({ TRADING_MODE: "scalp" });
  assert.equal(facts["decision.room_min_atr"], 1);
  assert.deepEqual(facts["decision.room_min_atr_by_mode"], { scalp: 1, intraday: 1, swing: 1, range: 1 });
  assert.deepEqual(facts["decision.room_bounds_atr"], [0.5, 1.5]);
  assert.equal(facts["decision.room_tuning"], "auto");
});
