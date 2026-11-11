// Auto-tuning of the Decision Engine's witness weights (owner 2026-11-11: "harusnya bobot itu dinamis
// sesuai dengan auto tune yang ada di aether"). src/witness-tuning.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  WITNESS_KEYS, TUNED_WITNESSES, WITNESS_MIN, WITNESS_MAX, witnessWeightsProblems, witnessWeightsId, shiftWeights, neighbourWeights,
  weightsChange, replayDecision, compareWitnessWeights, witnessAutoDecision, witnessRollbackDecision, applyWitnessTuning,
  activeWitnessTuning, witnessTuningState, witnessTuningMessage, witnessTuningReport, loadDecisions, readWitnessTuning,
  resetWitnessTuningCacheForTests, WITNESS_REPORT_VERSION
} from "../src/witness-tuning.mjs";
import { EXTENDED_WITNESS_WEIGHTS, WITNESS_WEIGHTS, assess, resetDecisionSchemaCacheForTests } from "../src/decision-engine.mjs";
import { WITNESS_PRIORS } from "../src/witness-weighting.mjs";
import { nexusFacts } from "../src/doctrine-facts.mjs";

const M15 = 900_000, DAY = 86_400_000;
const T0 = Date.parse("2026-11-02T00:00:00Z");
const ON = { GLOBAL_DECISION_WEIGHTED: "true" };

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
test.beforeEach(() => { resetWitnessTuningCacheForTests(); resetDecisionSchemaCacheForTests(); });

const sum = (w) => Object.values(w).reduce((a, b) => a + b, 0);
const PASS = (ids) => ids.map((id) => ({ id, pass: true }));
const IDS = ["market_open", "fresh", "quorum", "confirmation", "no_veto", "levels", "reward"];
/**
 * A decision where the daily room leans bullish against News Daily and the Macro room: under B-11 the
 * long holds 57% of the weight (BUY); with News Daily's weight up it falls under half (the short
 * has no key-level plan, so WAIT). A recorded "confirmation" check no longer gates (owner 2026-11-11).
 */
const decision = (i, over = {}) => ({
  key: `OANDA:XAUUSD:15:${T0 + i * M15}`, close_ms: T0 + (i + 1) * M15, mode: "intraday", decided_ms: T0 + (i + 1) * M15 + 60_000,
  witnesses: [{ key: "D1", available: true, stale: false, lean: 0.5, at: null }, { key: "NEWS", available: true, stale: false, lean: -0.5, at: null }, { key: "MACRO", available: true, stale: false, lean: -0.5, at: null }, { key: "SESSION", available: false, stale: false, lean: null, at: null }],
  checks: { long: PASS(IDS), short: IDS.map((id) => ({ id, pass: id !== "levels" && id !== "quorum" })) },
  recorded_weights: { ...EXTENDED_WITNESS_WEIGHTS }, recorded_quorum: { long: true, short: false },
  ...over
});
// The truth of the synthetic market: every BUY misses, every WAIT is right.
const outcome = (_key, _close, stance) => (stance === "WAIT" ? "hit" : "miss");

test("W1. the B-11 set is the prior; every tuned set keeps 12 witnesses inside 0.02-0.28 and sums to 1", () => {
  assert.deepEqual({ ...WITNESS_PRIORS }, { ...EXTENDED_WITNESS_WEIGHTS });
  assert.deepEqual(witnessWeightsProblems(EXTENDED_WITNESS_WEIGHTS), []);
  assert.equal(WITNESS_KEYS.length, 12);
  assert.ok(!TUNED_WITNESSES.includes("SESSION"), "the session is context only, its weight is not tuned");
  const arms = neighbourWeights(EXTENDED_WITNESS_WEIGHTS);
  assert.ok(arms.length >= 18 && arms.length <= 22, `${arms.length} arms`);
  for (const a of arms) {
    assert.deepEqual(witnessWeightsProblems(a.weights), [], a.change);
    assert.ok(Math.abs(sum(a.weights) - 1) <= 0.001);
    assert.equal(a.weights.SESSION, EXTENDED_WITNESS_WEIGHTS.SESSION);
    assert.ok(Object.values(a.weights).every((w) => w >= WITNESS_MIN && w <= WITNESS_MAX));
    assert.doesNotMatch(a.change, /_/);
  }
  const up = shiftWeights(EXTENDED_WITNESS_WEIGHTS, "NEWS", 1.5);
  assert.equal(up.NEWS, 0.12);
  assert.ok(up.D1 < 0.16 && up.D1 > 0.15, "the others are rescaled");
  assert.equal(shiftWeights(EXTENDED_WITNESS_WEIGHTS, "SESSION", 1.5), null);
  assert.equal(shiftWeights({ ...EXTENDED_WITNESS_WEIGHTS, D1: 0.24, H4: 0.08 }, "D1", 1.5), null, "0.36 is out of bounds");
  assert.match(witnessWeightsProblems({ ...EXTENDED_WITNESS_WEIGHTS, D1: 0.3, H4: 0.02 }).join(), /out_of_bounds:D1/);
  assert.match(witnessWeightsProblems({ ...EXTENDED_WITNESS_WEIGHTS, D1: 0.2 }).join(), /sum_not_1/);
  assert.match(witnessWeightsProblems({ D1: 1 }).join(), /missing:H4/);
  assert.equal(witnessWeightsId(EXTENDED_WITNESS_WEIGHTS), witnessWeightsId({ ...EXTENDED_WITNESS_WEIGHTS }));
  assert.notEqual(witnessWeightsId(up), witnessWeightsId(EXTENDED_WITNESS_WEIGHTS));
  assert.equal(weightsChange(EXTENDED_WITNESS_WEIGHTS), "none: the B-11 weights");
  assert.match(weightsChange(up), /^News Daily up from 8% to 12%/);
});

test("W2. the replay recomputes the quorum check under other weights; every other check keeps its record", () => {
  const d = decision(0);
  assert.equal(replayDecision(d, EXTENDED_WITNESS_WEIGHTS).stance, "BUY");
  const up = shiftWeights(EXTENDED_WITNESS_WEIGHTS, "NEWS", 1.5);
  const r = replayDecision(d, up);
  assert.equal(r.quorum.long, false);
  assert.equal(r.quorum.short, true, "the short now holds the quorum");
  assert.equal(r.stance, "WAIT", "but it has no key-level plan, so WAIT");
  const oldRecord = decision(0, { checks: { long: IDS.map((id) => ({ id, pass: id !== "confirmation" })), short: decision(0).checks.short } });
  assert.equal(replayDecision(oldRecord, EXTENDED_WITNESS_WEIGHTS).stance, "BUY", "an older record's failed confirmation no longer gates");
  const blocked = decision(0, { checks: { long: IDS.map((id) => ({ id, pass: id !== "reward" })), short: decision(0).checks.short } });
  assert.equal(replayDecision(blocked, EXTENDED_WITNESS_WEIGHTS).stance, "WAIT", "a failed recorded check still blocks");
  assert.equal(replayDecision(decision(0, { checks: { long: [], short: [] } }), EXTENDED_WITNESS_WEIGHTS), null);
  assert.equal(replayDecision(decision(0, { mode: "swing" }), EXTENDED_WITNESS_WEIGHTS).stance, "WAIT", "swing needs 60%");
});

test("W3. discovery, Holm and holdout: the better set is found, activated once, and the cooldown holds", () => {
  const decisions = Array.from({ length: 400 }, (_, i) => decision(i));
  const now = T0 + 401 * M15;
  const replay = compareWitnessWeights({ decisions, outcome, now });
  assert.equal(replay.rooms, 400);
  assert.equal(replay.control.accuracy, 0, "every control BUY misses");
  assert.deepEqual(replay.replay_fidelity, { checks: 800, matched: 800, share: 1 });
  const news = replay.candidates.find((c) => c.changed === "NEWS" && c.direction === "up");
  assert.equal(news.discovery.bars, 300);
  assert.equal(news.holdout.bars, 100);
  assert.ok(news.discovery.p_holm < 0.05);
  assert.match(news.verdict, /^better_than_active/);
  const same = replay.candidates.find((c) => c.changed === "H4" && c.direction === "up");
  assert.equal(same.verdict, "not_better", "a weight no witness of these decisions uses changes nothing");
  const state = { weights: EXTENDED_WITNESS_WEIGHTS, id: witnessWeightsId(EXTENDED_WITNESS_WEIGHTS), history: [] };
  const d = witnessAutoDecision(state, replay, { now });
  assert.equal(d.action, "activate");
  assert.deepEqual(witnessWeightsProblems(d.weights), []);
  assert.ok(replay.candidates.find((c) => c.id === d.id).verdict.startsWith("better_than_active"));
  const soon = witnessAutoDecision({ ...state, history: [{ kind: "activated", at: new Date(now - 2 * DAY).toISOString() }] }, replay, { now });
  assert.equal(soon.action, "none");
  assert.match(soon.reason, /7 days/);
  const banned = witnessAutoDecision({ ...state, history: replay.candidates.filter((c) => c.verdict.startsWith("better")).map((c) => ({ kind: "rolled_back", from: c.id, at: new Date(now - 30 * DAY).toISOString() })) }, replay, { now });
  assert.equal(banned.action, "none", "a set rolled back before is never activated again");
  const few = compareWitnessWeights({ decisions: decisions.slice(0, 250), outcome, now });
  assert.ok(few.candidates.every((c) => c.verdict === "collecting"), "below 200 discovery decisions nothing is judged");
});

test("W4. the reverse shadow rolls back a set the previous one beats after 100 decisions", () => {
  const prev = shiftWeights(EXTENDED_WITNESS_WEIGHTS, "NEWS", 1.5);
  const decisions = Array.from({ length: 150 }, (_, i) => decision(i));
  const activatedAt = new Date(T0).toISOString();
  const replay = compareWitnessWeights({ decisions, outcome, active: EXTENDED_WITNESS_WEIGHTS, previous: prev, activatedAt, now: T0 + 151 * M15 });
  assert.equal(replay.reverse.rooms, 150);
  assert.equal(replay.reverse.previous_better, 150);
  const back = witnessRollbackDecision({ previous: prev }, replay);
  assert.equal(back.rollback, true);
  assert.equal(witnessRollbackDecision({ previous: prev }, { reverse: { ...replay.reverse, rooms: 60 } }).rollback, false);
  assert.equal(witnessRollbackDecision({ previous: null }, replay).rollback, false);
});

test("W5. applied in D1: activation, the engine's weights, Telegram, rollback; frozen and off modes change nothing", async () => {
  const env = { ...ON, DB: fakeD1() };
  const decisions = Array.from({ length: 400 }, (_, i) => decision(i));
  const now = T0 + 401 * M15;
  assert.equal((await activeWitnessTuning(env, { now })).source, "default");
  const replay = compareWitnessWeights({ decisions, outcome, now });
  const applied = await applyWitnessTuning(env, { replay, now });
  assert.equal(applied.status, "activated", JSON.stringify(applied));
  const active = await activeWitnessTuning(env, { now: now + 1 });
  assert.equal(active.source, "auto_tuned");
  assert.equal(active.id, applied.id);
  assert.deepEqual(witnessWeightsProblems(active.weights), []);
  const line = witnessTuningMessage(applied);
  assert.match(line, /^Auto-tuning \(Decision Engine witnesses\): new weights active\. Change: /);
  assert.doesNotMatch(line, /_|\d{4}\.\d/);
  assert.equal((await applyWitnessTuning(env, { replay, now: now + DAY })).status, "unchanged", "the 7-day cooldown");

  const state = await witnessTuningState(env, { now, useCache: false });
  assert.deepEqual(state.previous, { ...EXTENDED_WITNESS_WEIGHTS });
  const worse = { reverse: { rooms: 120, previous_better: 40, active_better: 5, p_value: 0.0001 } };
  const back = await applyWitnessTuning(env, { replay: worse, now: now + 8 * DAY });
  assert.equal(back.status, "rolled_back");
  assert.equal((await activeWitnessTuning(env, { now: now + 9 * DAY })).source, "default");
  assert.match(witnessTuningMessage(back), /rolled back to the previous set/);

  assert.equal((await applyWitnessTuning({ ...env, WITNESS_TUNING_MODE: "default" }, { replay, now })).status, "frozen");
  assert.equal((await activeWitnessTuning({ ...env, WITNESS_TUNING_MODE: "default" })).source, "default");
  assert.equal((await applyWitnessTuning({ DB: env.DB }, { replay, now })).status, "frozen", "GLOBAL_DECISION_WEIGHTED off");
  assert.deepEqual((await activeWitnessTuning({ DB: env.DB })).weights, { ...WITNESS_WEIGHTS });
});

test("W6. the engine weighs its witnesses with the tuned set and records where it came from", async () => {
  const tuned = { weights: shiftWeights(EXTENDED_WITNESS_WEIGHTS, "NEWS", 1.5), id: "ww:test", source: "auto_tuned" };
  const loaded = { inputs: { calendar: { events: [] } }, strategy: null, global: { timeframes: [] } };
  const a = assess(loaded, { now: T0, env: ON, witnessWeights: tuned });
  assert.equal(a.witness_weights_source, "auto_tuned");
  assert.equal(a.cards.find((c) => c.key === "NEWS").weight, 0.12);
  assert.equal(a.witness_weights.NEWS, 0.12);
  const b = assess(loaded, { now: T0, env: ON });
  assert.equal(b.witness_weights_source, "default");
  assert.deepEqual(b.witness_weights, { ...EXTENDED_WITNESS_WEIGHTS });
  assert.equal(b.cards.find((c) => c.key === "NEWS").weight, 0.08, "no hand-made regime multipliers");
  assert.equal(assess(loaded, { now: T0, env: {} }).witness_weights_source, "base");
  const facts = await nexusFacts({ ...ON });
  assert.deepEqual(facts["decision.witness_weights"], { ...EXTENDED_WITNESS_WEIGHTS });
  assert.equal(facts["decision.witness_tuning"], "auto");
});

test("W7. loading projects only the witnesses and checks from D1; the report carries no price", async () => {
  const env = { ...ON, DB: fakeD1(), SIGNAL_CACHE: { async get() { return null; } } };
  await loadDecisions(env.DB, "2026-01-01T00:00:00Z");
  const rec = (i) => ({
    decision_key: `OANDA:XAUUSD:15:${T0 + i * M15}`, trading_mode: "intraday", decided_at: new Date(T0 + (i + 1) * M15 + 60_000).toISOString(), weights: EXTENDED_WITNESS_WEIGHTS,
    witnesses: [{ key: "D1", available: true, stale: false, lean: 0.5, at: null, summary: "long text" }, { key: "NEWS", available: true, stale: false, lean: -0.5, at: null }],
    guardrails: { long: { allowed: true, checks: PASS(IDS).map((c) => ({ ...c, detail: "x" })) }, short: { allowed: false, checks: IDS.map((id) => ({ id, pass: false, detail: "y" })) } },
    trade: { entry: 4000, stop: 3990 }
  });
  for (const i of [0, 1, 2]) {
    const r = rec(i);
    env.DB.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, 'BUY', 0.6, 'council', ?)").run(r.decision_key, new Date(T0 + (i + 1) * M15).toISOString(), r.decided_at, JSON.stringify(r));
  }
  const list = await loadDecisions(env.DB, new Date(T0).toISOString());
  assert.equal(list.length, 3);
  assert.deepEqual(list[0].witnesses[0], { key: "D1", available: true, stale: false, lean: 0.5, at: null });
  assert.deepEqual(list[0].recorded_quorum, { long: true, short: false });
  assert.equal(list[0].checks.long.length, 7);
  assert.equal(list[0].close_ms, T0 + M15);
  const replay = await readWitnessTuning(env, { now: T0 + 4 * M15, useCache: false });
  assert.equal(replay.rooms, 3);
  assert.equal(replay.control.scored_rooms, 0, "no bars, nothing scored");
  assert.equal(replay.active.source, "default");
  const report = witnessTuningReport(replay, { now: T0 });
  assert.equal(report.version, WITNESS_REPORT_VERSION);
  assert.equal(report.timeframe, "engine");
  assert.deepEqual(report.active.params, { ...EXTENDED_WITNESS_WEIGHTS });
  assert.doesNotMatch(JSON.stringify(report), /"(price|entry|stop|tp|tp1|tp2|sl|lot|size|volume|level)"/);
});
