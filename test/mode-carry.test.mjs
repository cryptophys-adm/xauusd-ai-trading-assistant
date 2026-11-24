// MS1 (2026-11-23): the trading mode travels on a request copy of env (runDecisionEngine never writes env, so a mode
// the selector or a person chose never reads as the server's TRADING_MODE pin later in the isolate); every daily mode
// selector outcome is one recorded event with each mode's evidence; the selector's setups load in one order.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runDecisionEngine, readLatestDecision, resetDecisionSchemaCacheForTests, modeThresholds, tradingMode, setTradingMode, TRADING_MODE_KEY } from "../src/decision-engine.mjs";
import { runModeSelector, ownerModeAction, rangeExitTick, outcomeEvidence, resetModeSchemaForTests, MODE_CONTROL_KEY, MODE_RUN_EVENT, MODE_LEARN_DAYS } from "../src/mode-selector.mjs";
import { strategyMode } from "../src/strategy-engine.mjs";
import { roomTuningState, resetRoomTuningCacheForTests } from "../src/room-tuning.mjs";
import { modeSelectorTick, resetOmegaBrokerSchemaForTests } from "../src/omega-broker.mjs";
import { resetAiUsageSchemaCacheForTests } from "../src/ai-usage.mjs";

const CLOSE = "2026-11-09T13:15:00.000Z";
const NOW = Date.parse(CLOSE) + 70_000;
const DAY = 86_400_000;

function d1() {
  const db = new DatabaseSync(":memory:");
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args.map((v) => (v === undefined ? null : v))),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
function kv() {
  const m = new Map();
  return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } };
}
const row = (key, lean, action = "WAIT") => ({ key, label: key, role: key, available: true, lean, action, confidence: 0.6, summary: `${key} reads the chart.`, at: CLOSE, stale: false });
const global = () => ({ timeframes: [row("D1", 0.5), row("H4", 0.4), row("H1", 0.3), row("M15", 0.35, "BUY"), row("NEWS", 0.2), row("MACRO", 0.1)] });
const ZONES = [
  { low: 3995, high: 3998, price: 3996.5, candidate: true, label: "S1" },
  { low: 3980, high: 3980, price: 3980, candidate: true, label: "S2" },
  { low: 4030, high: 4032, price: 4031, candidate: true, label: "R1" },
  { low: 4050, high: 4050, price: 4050, candidate: true, label: "R2" }
];
const STRATEGY = { decision: "WAIT", state: "SETUP_READY", direction: "LONG", confidence: 0.6, alignment: 0.5, headline: "The long setup is ready.", price: 4000, atr_h1: 10, key_levels: { zones: ZONES }, plan: { at_level: true } };
// The news leans strongly bearish: in swing mode riskChecks vetoes a long on it (composite sentiment), in no other mode.
const loaded = () => ({ inputs: { calendar: { events: [] }, news: { lean: -0.9 } }, strategy: STRATEGY, global: global(), correlations: null, regime: "normal-trending" });
const failingAi = { run: async () => { throw new Error("model down"); } };

async function decisionEnv(over = {}) {
  resetDecisionSchemaCacheForTests(); resetModeSchemaForTests(); resetAiUsageSchemaCacheForTests(); resetRoomTuningCacheForTests();
  const env = { DB: d1(), SIGNAL_CACHE: kv(), AI: failingAi, MODEL_RATE_LIMIT_RETRY_MS: "0", ...over };
  // The room guardrail learned per mode (src/room-tuning.mjs): swing 1.3, intraday 0.7, so the record shows which was read.
  await roomTuningState(env, { useCache: false });
  for (const [mode, active] of [["swing", 1.3], ["intraday", 0.7], ["scalp", 0.6]]) {
    env.DB.raw.prepare("INSERT INTO room_tuning_state (mode, active, previous, source_json, activated_at, history_json, updated_at) VALUES (?, ?, NULL, NULL, ?, '[]', ?)").run(mode, active, CLOSE, CLOSE);
  }
  return env;
}
const OWN = ["TRADING_MODE", "COUNCIL_KNOBS", "ROOM_CORRIDOR_ATR"];

test("MS1-1 the selector's mode (KV) reaches every reader in the decision through a request copy; env is never written", async () => {
  const env = await decisionEnv();
  await env.SIGNAL_CACHE.put(TRADING_MODE_KEY, "swing");
  const keys = Object.keys(env).sort();
  const data = loaded();
  const r = await runDecisionEngine(env, { barClose: CLOSE, now: NOW, clock: () => NOW, loaded: data });
  assert.equal(r.status, "decided", JSON.stringify(r));
  // env: the same keys, none of the decision's own.
  assert.deepEqual(Object.keys(env).sort(), keys);
  for (const k of OWN) assert.equal(Object.hasOwn(env, k), false, `${k} is not written to env`);
  const rec = await readLatestDecision(env);
  const swing = modeThresholds("swing");
  // modeThresholds (buildDecisionRecord's mode and rules).
  assert.equal(rec.trading_mode, "swing");
  assert.deepEqual([rec.rules.quorum_min, rec.rules.min_rrr, rec.rules.lean], [swing.quorum_min, swing.min_rrr, swing.lean]);
  // guardrailsFor: the swing quorum and reward minimums in its checks.
  const checks = Object.fromEntries(rec.guardrails.long.checks.map((c) => [c.id, c.detail]));
  assert.match(checks.reward, new RegExp(`at least ${swing.min_rrr}R needed`));
  assert.match(checks.quorum, /more than 60% needed|meets directional lean/);
  // riskChecks: the swing-only sentiment veto.
  assert.ok(rec.vetoes.long.includes("swing mode: composite sentiment leans strongly against the trade"), JSON.stringify(rec.vetoes));
  // activeRoom (room-tuning): swing's learned room.
  assert.equal(rec.room_atr, 1.3);
  // lensKnobs: both lenses' knobs for swing.
  assert.equal(data.positioning?.knobs?.mode, "swing", JSON.stringify(data.positioning));
  assert.equal(data.liquidity?.knobs?.mode, "swing", JSON.stringify(data.liquidity));
});

test("MS1-2 after a decision the isolate's env carries no pin: tradingMode, readStrategy's mode and every selector path follow KV", async () => {
  const env = await decisionEnv();
  await env.SIGNAL_CACHE.put(TRADING_MODE_KEY, "swing");
  assert.equal((await runDecisionEngine(env, { barClose: CLOSE, now: NOW, clock: () => NOW, loaded: loaded() })).status, "decided");
  // The mode changes in KV after the decision (the selector or a person): every reader follows it.
  await env.SIGNAL_CACHE.put(TRADING_MODE_KEY, "scalp");
  assert.equal(await tradingMode(env), "scalp");
  assert.equal(await strategyMode(env), "scalp", "readStrategy's mode");
  // The selector's daily run, the range exit and the owner's actions are not refused as pinned by the server.
  const events = [];
  const log = async (action, detail) => { events.push({ action, detail }); };
  const run = await runModeSelector(env, { now: NOW, regime: "normal-trending", call: async () => ({ status: "failed" }), log });
  assert.equal(run.status, "unchanged", JSON.stringify(run));
  assert.equal(events.at(-1).detail.mode, "scalp");
  assert.equal((await rangeExitTick(env, { now: NOW, regime: "normal-trending" })).status, "idle");
  const pin = await ownerModeAction(env, { mode: "intraday", actor: "owner@example.com", now: NOW });
  assert.deepEqual([pin.ok, pin.mode], [true, "intraday"]);
  assert.deepEqual((await setTradingMode(env, { mode: "swing", actor: "o" })).ok, true);
  assert.equal(Object.hasOwn(env, "TRADING_MODE"), false);
  // The next decision reads the new mode.
  const next = "2026-11-09T13:30:00.000Z";
  assert.equal((await runDecisionEngine(env, { barClose: next, now: Date.parse(next) + 60_000, clock: () => Date.parse(next) + 60_000, loaded: loaded() })).status, "decided");
  const rec = await readLatestDecision(env);
  assert.deepEqual([rec.trading_mode, rec.room_atr], ["swing", 1.3]);
});

test("MS1-3 the configured TRADING_MODE stays the only server pin: it wins over KV, and env keeps exactly its own value", async () => {
  const env = await decisionEnv({ TRADING_MODE: "scalp" });
  await env.SIGNAL_CACHE.put(TRADING_MODE_KEY, "swing");
  const data = loaded();
  assert.equal((await runDecisionEngine(env, { barClose: CLOSE, now: NOW, clock: () => NOW, loaded: data })).status, "decided");
  assert.equal(env.TRADING_MODE, "scalp");
  for (const k of ["COUNCIL_KNOBS", "ROOM_CORRIDOR_ATR"]) assert.equal(Object.hasOwn(env, k), false);
  const rec = await readLatestDecision(env);
  assert.deepEqual([rec.trading_mode, rec.room_atr, data.positioning?.knobs?.mode], ["scalp", 0.6, "scalp"]);
  assert.equal(rec.vetoes.long.some((v) => /swing mode/.test(v)), false, "no swing-only veto in scalp");
  assert.equal(await strategyMode(env), "scalp");
  const events = [];
  const r = await runModeSelector(env, { now: NOW, log: async (action, detail) => { events.push({ action, detail }); } });
  assert.equal(r.status, "pinned_by_server");
  assert.deepEqual([events.length, events[0].action, events[0].detail.status, events[0].detail.reason, events[0].detail.mode], [1, MODE_RUN_EVENT, "pinned_by_server", "server_trading_mode", "scalp"]);
  assert.equal((await ownerModeAction(env, { mode: "swing", actor: "o", now: NOW })).error, "pinned_by_server");
  assert.equal((await rangeExitTick(env, { now: NOW })).status, "pinned_by_server");
  assert.equal((await setTradingMode(env, { mode: "swing", actor: "o" })).error, "pinned_by_server");
});

// ---------------------------------------------------------------- the selector's daily outcome

function selectorEnv(over = {}) {
  resetModeSchemaForTests(); resetAiUsageSchemaCacheForTests();
  const db = d1();
  // MS2: the plan learner's source and rule_version columns; the seeded setups are live ones of the rule in force.
  db.raw.exec("CREATE TABLE plan_setups (setup_key TEXT PRIMARY KEY, mode TEXT, regime TEXT, entry REAL, stop REAL, status TEXT, opened_at TEXT, results_json TEXT, agent TEXT, decision_key TEXT, side TEXT, source TEXT NOT NULL DEFAULT 'live', rule_version TEXT)");
  return { DB: db, SIGNAL_CACHE: kv(), ...over };
}
const T = Date.parse("2026-11-18T12:00:00Z");
const insert = (e, key, mode, r, openedMs, stop = 5) => e.DB.raw.prepare("INSERT INTO plan_setups (setup_key, mode, regime, entry, stop, status, opened_at, results_json, rule_version) VALUES (?, ?, 'trend', 4000, ?, 'resolved', ?, ?, 'tp1_kz:on')")
  .run(key, mode, 4000 - stop, new Date(openedMs).toISOString(), JSON.stringify({ "e0@s1": { r } }));
const seed = (e, mode, n, r, stop = 5) => { for (let i = 0; i < n; i++) insert(e, `${mode}${String(i).padStart(3, "0")}`, mode, r + (i % 2 ? 0.05 : -0.05), T - 10 * DAY + i * 60_000, stop); };
const seats = (verdict) => async (_e, req) => ({ status: "answered", obj: { verdict, reason: `${verdict} ${req.messages.length}` } });
const collect = () => { const events = []; return { events, log: async (action, detail) => { events.push({ action, detail }); } }; };
const runs = (events) => events.filter((x) => x.action === MODE_RUN_EVENT);
const KEYS = ["action", "day", "evidence", "mode", "proposed", "reason", "regime", "status", "to"];

test("MS1-4 every daily outcome is one recorded event with each mode's evidence (n, mean R, status, scope)", async () => {
  // none: the current mode is the best.
  const e = selectorEnv();
  await e.SIGNAL_CACHE.put(TRADING_MODE_KEY, "intraday");
  seed(e, "intraday", 40, 0.4); seed(e, "swing", 40, 0.1);
  const a = collect();
  const none = await runModeSelector(e, { now: T, regime: "trend", call: seats("approve"), log: a.log });
  assert.equal(none.status, "unchanged");
  assert.equal(runs(a.events).length, 1);
  const ev = runs(a.events)[0].detail;
  assert.deepEqual(Object.keys(ev).sort(), KEYS);
  assert.deepEqual([ev.day, ev.status, ev.action, ev.reason, ev.mode, ev.to, ev.proposed, ev.regime], ["2026-11-18", "unchanged", "none", "current_mode_best", "intraday", null, null, "trend"]);
  assert.deepEqual(Object.keys(ev.evidence), ["scalp", "intraday", "swing", "range"]);
  // MS2: with shadow evidence on (the default) each mode adds its live/shadow split (n_live, n_shadow).
  for (const m of Object.keys(ev.evidence)) assert.deepEqual(Object.keys(ev.evidence[m]).sort(), ["mean_r", "n", "n_live", "n_shadow", "scope", "status"], m);
  assert.deepEqual(ev.evidence.intraday, { n: 40, mean_r: 0.4, status: "pass", scope: "regime", n_live: 40, n_shadow: 0 });
  assert.deepEqual(ev.evidence.scalp, { n: 0, mean_r: null, status: "collecting", scope: "all", n_live: 0, n_shadow: 0 });
  assert.deepEqual(ev.evidence.range, { n: 0, mean_r: null, status: "collecting", scope: "cells", n_live: 0, n_shadow: 0 });
  assert.doesNotMatch(JSON.stringify(ev), /median_stop|price|lot|entry|stop"/);
  // fresh: the same day again records nothing.
  assert.equal((await runModeSelector(e, { now: T + 3_600_000, regime: "trend", log: a.log })).status, "fresh");
  assert.equal(runs(a.events).length, 1);

  // A candidate holding, then a refused proposal, then an approved switch.
  const e2 = selectorEnv();
  await e2.SIGNAL_CACHE.put(TRADING_MODE_KEY, "intraday");
  seed(e2, "swing", 40, 0.4); seed(e2, "intraday", 40, 0.05);
  const b = collect();
  await runModeSelector(e2, { now: T, regime: "trend", call: seats("reject"), log: b.log });
  await runModeSelector(e2, { now: T + DAY, regime: "trend", call: seats("reject"), log: b.log });
  const r2 = await runModeSelector(e2, { now: T + 2 * DAY, regime: "trend", call: seats("approve"), log: b.log });
  assert.equal(r2.status, "changed");
  assert.deepEqual(runs(b.events).map((x) => [x.detail.status, x.detail.action, x.detail.reason, x.detail.to, x.detail.proposed]), [
    ["unchanged", "none", "candidate_holding", null, null],
    ["unchanged", "propose", "council_rejected", null, "swing"],
    ["changed", "propose", "evidence", "swing", "swing"]
  ]);
  assert.equal(b.events.filter((x) => x.action === "mode_changed").length, 1, "the change keeps its own event");

  // pinned: the owner's pin; the evidence is still recorded, and the pinned day changes nothing.
  const p = collect();
  await ownerModeAction(e2, { mode: "intraday", actor: "owner@example.com", now: T + 4 * DAY });
  const pinned = await runModeSelector(e2, { now: T + 5 * DAY, regime: "trend", log: p.log });
  assert.equal(pinned.status, "pinned");
  assert.deepEqual(p.events.map((x) => [x.action, x.detail.status, x.detail.reason, x.detail.mode]), [[MODE_RUN_EVENT, "pinned", "owner_pin", "intraday"]]);
  assert.deepEqual(p.events[0].detail.evidence.swing, { n: 40, mean_r: 0.4, status: "pass", scope: "regime", n_live: 40, n_shadow: 0 });
  assert.equal(await e2.SIGNAL_CACHE.get(TRADING_MODE_KEY), "intraday");

  // pinned_by_server: the configured TRADING_MODE.
  const s = collect();
  const e3 = selectorEnv({ TRADING_MODE: "swing" });
  seed(e3, "swing", 40, 0.4);
  assert.equal((await runModeSelector(e3, { now: T, regime: "trend", log: s.log })).status, "pinned_by_server");
  assert.deepEqual([s.events.length, s.events[0].detail.status, s.events[0].detail.mode, s.events[0].detail.evidence.swing.n], [1, "pinned_by_server", "swing", 40]);

  // failed: the outcome and its reason, no evidence.
  const f = collect();
  const e4 = selectorEnv();
  e4.SIGNAL_CACHE.put = async () => { throw new Error("kv write refused"); };
  const failed = await runModeSelector(e4, { now: T, regime: "trend", log: f.log });
  assert.equal(failed.status, "failed");
  assert.deepEqual([f.events.length, f.events[0].detail.status, f.events[0].detail.reason, f.events[0].detail.evidence], [1, "failed", "kv write refused", null]);
});

test("MS1-5 the record is best effort: a log that throws, or none, never changes the outcome; outcomeEvidence is pure", async () => {
  const e = selectorEnv();
  await e.SIGNAL_CACHE.put(TRADING_MODE_KEY, "intraday");
  seed(e, "intraday", 40, 0.4);
  const r = await runModeSelector(e, { now: T, regime: "trend", log: async () => { throw new Error("no omega_events table"); } });
  assert.equal(r.status, "unchanged");
  const e2 = selectorEnv();
  await e2.SIGNAL_CACHE.put(MODE_CONTROL_KEY, JSON.stringify({ auto: false, pinned: true, baseline: "intraday" }));
  assert.equal((await runModeSelector(e2, { now: T })).status, "pinned");
  assert.equal(outcomeEvidence(null), null);
  assert.deepEqual(outcomeEvidence({ swing: { n: 3, mean_r: 0.2, status: "collecting", scope: "all", median_stop: 7 } }), { scalp: null, intraday: null, swing: { n: 3, mean_r: 0.2, status: "collecting", scope: "all" }, range: null });
});

test("MS1-6 the ledger cron's tick writes the outcome to omega_events (actor agent:mode)", async () => {
  resetOmegaBrokerSchemaForTests();
  const e = selectorEnv();
  await e.SIGNAL_CACHE.put(TRADING_MODE_KEY, "intraday");
  seed(e, "intraday", 40, 0.4);
  const r = await modeSelectorTick(e, { now: T, call: seats("approve") });
  assert.equal(r.status, "unchanged", JSON.stringify(r));
  const rows = e.DB.raw.prepare("SELECT ms, actor, action, detail FROM omega_events WHERE action = ?").all(MODE_RUN_EVENT);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].ms, rows[0].actor], [T, "agent:mode"]);
  const d = JSON.parse(rows[0].detail);
  assert.deepEqual([d.status, d.reason, d.mode, d.evidence.intraday.n], ["unchanged", "current_mode_best", "intraday", 40]);
});

test("MS1-7 the setups load by opened_at, then setup_key: the holdout is the same whatever order the rows were written in", async () => {
  // 40 intraday setups opened at the same minute: keys a000-a027 win 0.5R, a028-a039 lose 0.5R. The holdout (the last
  // 30 %, 12 setups) is a028-a039 in key order; written in reverse, an insertion order would put the winners last.
  const write = (order) => {
    const e = selectorEnv();
    const keys = Array.from({ length: 40 }, (_, i) => i);
    for (const i of order(keys)) insert(e, `a${String(i).padStart(3, "0")}`, "intraday", i < 28 ? 0.5 : -0.5, T - 5 * DAY);
    return e;
  };
  const holdout = async (e) => {
    await e.SIGNAL_CACHE.put(TRADING_MODE_KEY, "intraday");
    const c = collect();
    const r = await runModeSelector(e, { now: T, regime: "trend", log: c.log });
    return [r.evidence.evidence.intraday.holdout_mean_r, r.evidence.evidence.intraday.status];
  };
  const forward = await holdout(write((k) => k));
  const reverse = await holdout(write((k) => [...k].reverse()));
  assert.deepEqual(forward, [-0.5, "fail"]);
  assert.deepEqual(reverse, forward);
  assert.ok(MODE_LEARN_DAYS >= 5);
});
