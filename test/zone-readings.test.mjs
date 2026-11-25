// Z5 (docs/RFC_DEMAND_SUPPLY_ZONES.md §7): the zone readings, the counterfactual tables (their own, never plan_setups),
// the decision-side zone breaker and Omega attribution (src/zone-readings.mjs), its switch ZONE_READINGS (FS1), the
// Decision Engine's zone_rules_held and GET /api/zones.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import * as de from "../src/decision-engine.mjs";
import * as pl from "../src/plan-learning.mjs";
import * as ms from "../src/mode-selector.mjs";
import * as au from "../src/ai-usage.mjs";
import * as rt from "../src/room-tuning.mjs";
import * as zr from "../src/zone-readings.mjs";
import { ruleVersionOf } from "../src/mode-shadow.mjs";
import { suspendedAgents, agentVoice } from "../src/strategy-agents.mjs";
import { runGridAdapt, readGridChoices } from "../src/grid-adapt.mjs";
import { runStrategyCouncil, resetCouncilSchemaForTests, COUNCIL_KEY } from "../src/strategy-council.mjs";
import { buildEvidencePack } from "../src/cfc-pack.mjs";
import { readTriggerInputs } from "../src/cfc-triggers.mjs";
import { runKnobProposals } from "../src/council-knob-tuning.mjs";
import { computeRecommendations } from "../src/strategy-recommendation.mjs";
import { resetLedgerSchemaCacheForTests } from "../src/signal-ledger.mjs";
import { resetStrategyArmSchemaCacheForTests } from "../src/strategy-arm.mjs";
import { resetSessionSchemaForTests } from "../src/cfc-session.mjs";
import { eaSignalFromDecision, managementFields } from "../src/ea-signal.mjs";
import { switchByKey } from "../src/feature-switches.mjs";
import { FEATURE_SWITCH_OVERRIDE_KEY } from "../src/feature-switches.mjs";
import { d1, kv, failingAi, ENV_BASE, loaded, CLOSE, NOW } from "./fixtures/mode-shadow.mjs";

const M1 = 60_000, M15 = 15 * M1, HOUR = 60 * M1, DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const {
  zoneReadings, runZoneReadings, runZoneCounterfactuals, runZoneReadingsStep, ensureZoneReadingsSchema, resetZoneReadingsSchemaForTests, zoneBreakerHolds,
  runZoneBreaker, applyZoneHolds, readZoneHolds, zoneReadingsMode, blockShare, alarmLines, omegaZoneAttribution, zonesView,
  ZONE_BREAKER_KEY, ZONE_READINGS_CURSOR_KEY, ZONE_READINGS_SERIES_KEY, ZONE_BREAKER, ZONE_READING_RULES
} = zr;
const reset = () => { de.resetDecisionSchemaCacheForTests(); pl.resetPlanLearningSchemaCacheForTests(); ms.resetModeSchemaForTests(); au.resetAiUsageSchemaCacheForTests(); rt.resetRoomTuningCacheForTests(); resetCouncilSchemaForTests(); resetLedgerSchemaCacheForTests(); resetStrategyArmSchemaCacheForTests(); resetSessionSchemaForTests(); resetZoneReadingsSchemaForTests(); };
const tables = (db) => db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
const ZONE_TABLES = ["zone_blocked_setups", "zone_readings", "zone_rule_arms"];

// ---------------------------------------------------------------- the readings' fixture: 15m bars, ATR(1H) 10

const T0 = Date.parse("2026-11-20T08:00:00Z");
const keyOf = (openMs) => `OANDA:XAUUSD:15:${openMs}`;
/** 15m bars from T0: `spec[i]` = [open, high, low, close]. */
const barsOf = (spec) => spec.map(([o, h, l, c], i) => ({ open_time: iso(T0 + i * M15), close_time: iso(T0 + (i + 1) * M15), open: o, high: h, low: l, close: c }));
/** A demand zone 3995-3998 met from above (the bar before closes at 4005); the decision bar (index 1) dips to 3996. */
const DEMAND = { low: 3995, high: 3998, zone_type: "demand", zone_strength: "medium", zone_freshness: "fresh", zone_rank: "candidate" };
const UNTYPED = { low: 3995, high: 3998 };
const lead = [[4006, 4007, 4004, 4005], [4004, 4005, 3996, 4000]];
const flat = (n, c = 4000) => Array.from({ length: n }, () => [c, c + 1, c - 1, c]);
const decisionAt = (barIndex, key_levels, extra = {}) => ({ decision_key: keyOf(T0 + barIndex * M15), bar_close: iso(T0 + (barIndex + 1) * M15), key_levels, atr_h1: 10, mode: "intraday", regime: "normal-trending", ...extra });

test("ZR-1 readings: held (0.5 ATR beyond the near edge first), broke (0.1 ATR beyond the far edge first), neither; MFE/MAE in ATR, words only", () => {
  const held = zoneReadings([decisionAt(1, [DEMAND])], barsOf([...lead, [4000, 4002, 3999, 4001], [4001, 4004, 4000, 4003.5], ...flat(6)]));
  assert.equal(held.readings.length, 1);
  assert.deepEqual(held.readings[0], {
    reading_key: `${keyOf(T0 + M15)}#0`, decision_key: keyOf(T0 + M15), bar_close: iso(T0 + 2 * M15), zone_type: "demand", zone_strength: "medium", zone_freshness: "fresh", zone_rank: "candidate",
    ds_sources: null, approach: "from_above", outcome: "held", mfe_atr: 0.6, mae_atr: 0, bars: 2, mode: "intraday", regime: "normal-trending"
  });
  const broke = zoneReadings([decisionAt(1, [DEMAND])], barsOf([...lead, [3998, 3999, 3993, 3994], ...flat(7)]));
  assert.deepEqual([broke.readings[0].outcome, broke.readings[0].bars, broke.readings[0].mae_atr], ["broke", 1, 0.5]);
  const neither = zoneReadings([decisionAt(1, [DEMAND])], barsOf([...lead, ...flat(8, 4001)]));
  assert.deepEqual([neither.readings[0].outcome, neither.readings[0].bars], ["neither", 8]);
  // A zone the decision bar did not touch is not read; an untyped zone reads its direction from the approach.
  assert.equal(zoneReadings([decisionAt(1, [{ ...DEMAND, low: 3980, high: 3982 }])], barsOf([...lead, ...flat(8)])).readings.length, 0);
  const u = zoneReadings([decisionAt(1, [UNTYPED])], barsOf([...lead, [4000, 4004, 3999, 4003.5], ...flat(7)])).readings[0];
  assert.deepEqual([u.zone_type, u.approach, u.outcome], [null, "from_above", "held"]);
  // No price in a reading: words, ATR, counts and times only.
  for (const r of [...held.readings, ...broke.readings, ...neither.readings]) for (const [k, v] of Object.entries(r)) if (typeof v === "number") assert.ok(["mfe_atr", "mae_atr", "bars"].includes(k), k);
});

test("ZR-2 the 8-bar boundary: a held close on the 8th bar counts, on the 9th it is neither; fewer than 8 closed bars without an outcome wait", () => {
  const at8 = zoneReadings([decisionAt(1, [DEMAND])], barsOf([...lead, ...flat(7, 4001), [4001, 4004, 4000, 4003.5]]));
  assert.deepEqual([at8.readings[0].outcome, at8.readings[0].bars], ["held", 8]);
  const at9 = zoneReadings([decisionAt(1, [DEMAND])], barsOf([...lead, ...flat(8, 4001), [4001, 4004, 4000, 4003.5]]));
  assert.deepEqual([at9.readings[0].outcome, at9.readings[0].bars], ["neither", 8]);
  const early = zoneReadings([decisionAt(1, [DEMAND]), decisionAt(2, [DEMAND])], barsOf([...lead, ...flat(5, 4001)]));
  assert.deepEqual([early.readings.length, early.done, early.pending], [0, [], keyOf(T0 + M15)]);
  // An outcome before the 8th bar is final at once.
  const fast = zoneReadings([decisionAt(1, [DEMAND])], barsOf([...lead, [4000, 4004, 3999, 4003.5]]));
  assert.deepEqual([fast.readings[0].outcome, fast.pending], ["held", null]);
  // A decision bar the series has not reached yet waits; one older than the series is skipped.
  assert.equal(zoneReadings([decisionAt(30, [DEMAND])], barsOf([...lead, ...flat(8)])).pending, keyOf(T0 + 30 * M15));
});

test("ZR-3 dedupe: one reading per (0.1 ATR bucket, approach) per 2 hours", () => {
  const spec = [...lead, ...flat(40, 4001)];
  spec[9] = [4005, 4006, 4004, 4005]; spec[10] = [4004, 4005, 3996, 4000];
  const out = zoneReadings([decisionAt(1, [DEMAND, { ...DEMAND, low: 3995.1, high: 3998.1 }]), decisionAt(2, [DEMAND]), decisionAt(10, [DEMAND])], barsOf(spec));
  // The second zone falls in the first one's bucket; the next bar's reading is inside 2 hours; bar 10 is 2h15m later.
  assert.deepEqual(out.readings.map((r) => r.reading_key), [`${keyOf(T0 + M15)}#0`, `${keyOf(T0 + 10 * M15)}#0`]);
  // Another approach is another reading.
  const other = zoneReadings([decisionAt(1, [DEMAND]), decisionAt(3, [DEMAND])], barsOf([...lead, [4000, 4001, 3996, 3997], [3997, 3998, 3996, 3997], ...flat(10, 4001)]));
  assert.deepEqual(other.readings.map((r) => r.approach), ["from_above", "inside"]);
});

/** A sqlite D1 + KV with stored decisions (records with key_levels, ATR, mode, regime) and the 15m series in KV. */
async function readingsEnv(over = {}) {
  reset();
  const env = { DB: d1(), SIGNAL_CACHE: kv(), ...over };
  await de.ensureDecisionSchema(env.DB);
  const spec = [...lead, ...flat(20, 4001)];
  spec[3] = [4001, 4004, 4000, 4003.5];
  await env.SIGNAL_CACHE.put(ZONE_READINGS_SERIES_KEY, JSON.stringify({ candles: barsOf(spec) }));
  for (const i of [1, 2, 3]) {
    const d = decisionAt(i, [DEMAND]);
    env.DB.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, 'WAIT', 0.5, 'council', ?)")
      .run(d.decision_key, d.bar_close, d.bar_close, JSON.stringify({ stance: "WAIT", key_levels: d.key_levels, strategy: { atr_h1: 10 }, trading_mode: "intraday", context: { regime_1h: "normal-trending" } }));
  }
  return env;
}
const RNOW = T0 + 24 * M15;

test("ZR-4 the run: behind its cursor, written once; a rerun writes nothing, and nothing either without the cursor (INSERT OR IGNORE); the schema twice is a no-op", async () => {
  const env = await readingsEnv();
  const first = await runZoneReadings(env, { now: RNOW });
  assert.deepEqual([first.status, first.decisions, first.written], ["ok", 3, 1], JSON.stringify(first));
  const n = () => env.DB.raw.prepare("SELECT COUNT(*) AS n FROM zone_readings").get().n;
  assert.equal(n(), 1);
  assert.equal(JSON.parse(await env.SIGNAL_CACHE.get(ZONE_READINGS_CURSOR_KEY)).bar_close, iso(T0 + 4 * M15));
  assert.equal((await runZoneReadings(env, { now: RNOW })).status, "idle");
  await env.SIGNAL_CACHE.put(ZONE_READINGS_CURSOR_KEY, "null");
  assert.equal((await runZoneReadings(env, { now: RNOW })).written, 0);
  assert.equal(n(), 1);
  const row = env.DB.raw.prepare("SELECT * FROM zone_readings").get();
  // No decision-time rule version recorded for these decisions (before Z5's table): NULL, left out of the evidence.
  assert.deepEqual([row.outcome, row.approach, row.version, row.rule_version], ["held", "from_above", zr.ZONE_READINGS_VERSION, null]);
  assert.deepEqual((await zr.breakerEvidence(env.DB, ruleVersionOf(env))).readings, []);
  // The schema: twice, the same tables and columns.
  const cols = (db) => ZONE_TABLES.map((t) => db.raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => [c.name, c.type, c.notnull, c.pk]));
  const before = cols(env.DB);
  resetZoneReadingsSchemaForTests();
  await ensureZoneReadingsSchema(env.DB);
  await ensureZoneReadingsSchema(env.DB);
  assert.deepEqual(cols(env.DB), before);
  // zone_blocked_setups has every plan_setups column.
  await pl.ensurePlanLearningSchema(env.DB);
  const names = (t) => env.DB.raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).sort();
  assert.deepEqual(names("zone_blocked_setups"), names("plan_setups"));
});

test("ZR-5 ZONE_READINGS off: nothing written (no table, no cursor, no breaker state), the breaker idle, no hold reaches a decision", async () => {
  const env = await readingsEnv({ ZONE_READINGS: "off" });
  await env.SIGNAL_CACHE.put(ZONE_BREAKER_KEY, JSON.stringify({ held: { zone_ahead: { by: ["block"] } } }));
  const keys = [...env.SIGNAL_CACHE.m.keys()].sort();
  assert.deepEqual(await runZoneReadingsStep(env, { now: RNOW }), { status: "disabled" });
  assert.deepEqual(await runZoneBreaker(env, { now: RNOW, force: true, send: async () => { throw new Error("no line"); } }), { status: "disabled" });
  assert.deepEqual(ZONE_TABLES.filter((t) => tables(env.DB).includes(t)), []);
  assert.deepEqual([...env.SIGNAL_CACHE.m.keys()].sort(), keys);
  assert.equal(await readZoneHolds(env), null);
  assert.deepEqual(applyZoneHolds({ ZONE_READINGS: "off", ZONE_PRIORITY: "on" }, { zone_ahead: { by: ["block"] } }).held, []);
  assert.equal(zoneReadingsMode({}), "on");
  assert.equal(zoneReadingsMode({ ZONE_READINGS: " OFF " }), "off");
});

// ---------------------------------------------------------------- the counterfactual tables

/** A WAIT decision Z2's check alone held back (its slim plan), and a BUY whose zone_pullback plan Z2b's tp rule moved. */
function seedCounterfactualDecisions(db, at) {
  const ins = db.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, 0.6, 'council', ?)");
  const k1 = keyOf(at - M15), k2 = keyOf(at + 2 * HOUR - M15);
  ins.run(k1, iso(at), iso(at), "WAIT", JSON.stringify({ stance: "WAIT", zone_blocked: { side: "long", agent: "zone_pullback", plan: { entry: 4000, stop: 3990, tp1: 4015, tp2: 4030, at_level: true, rrr: { tp1: 1.5 } }, opposing_ahead: { room_atr: 0.5 } }, strategy: { atr_h1: 10 }, trading_mode: "intraday", context: { regime_1h: "normal-trending" } }));
  ins.run(k2, iso(at + 2 * HOUR), iso(at + 2 * HOUR), "BUY", JSON.stringify({ stance: "BUY", trade: { side: "BUY", entry: 4030, stop: 4020, tp: 4045 }, strategy_plans: { long: { zone_pullback: { status: "live", entry: 4030, stop: 4020, tp1: 4045, tp2: 4060, at_level: true, zone_rules: [{ rule: "tp_typed", base_tp1_r: 3, base_stop_atr: 1 }] } }, short: {} }, strategy: { atr_h1: 10 }, trading_mode: "intraday", context: { regime_1h: "normal-trending" } }));
}
const rising = (from, n = 600) => Array.from({ length: n }, (_, i) => ({ open_time: iso(from + i * M1), close_time: iso(from + (i + 1) * M1), open: 4000 + i * 0.25, high: 4000.5 + i * 0.25, low: 3999.5 + i * 0.25, close: 4000.25 + i * 0.25 }));

test("ZR-6 the counterfactuals: zone_blocked WAITs scored with plan learning's outcome step; a Z2b arm's acted plan against its rebuilt base; plan_setups untouched", async () => {
  reset();
  const env = { DB: d1(), SIGNAL_CACHE: kv() };
  await de.ensureDecisionSchema(env.DB);
  await pl.ensurePlanLearningSchema(env.DB);
  const at = Date.parse("2026-11-20T10:00:00Z");
  seedCounterfactualDecisions(env.DB, at);
  await zr.recordDecisionRule({ ...env, TP1_KEY_ZONE_MODE: "off" }, { decisionKey: keyOf(at - M15), barClose: iso(at), now: at });
  const now = at + 12 * HOUR;
  const out = await runZoneCounterfactuals(env, { now, bars: rising(at) });
  assert.equal(out.status, "ok", JSON.stringify(out));
  const b = env.DB.raw.prepare("SELECT * FROM zone_blocked_setups").all();
  assert.equal(b.length, 1);
  // The rule version is the decision's own (recorded at decision time under other rules than this run's env).
  assert.deepEqual([b[0].side, b[0].status, b[0].source, b[0].rule_version, JSON.parse(b[0].results_json)["e0@s1"].s], ["BUY", "resolved", "zone_blocked", "tp1_kz:off", "target"]);
  // The same step as plan learning's control arm on the same setup.
  assert.deepEqual(JSON.parse(b[0].results_json), pl.setupOutcome(pl.setupFromRow({ ...b[0], status: "open", results_json: null }), rising(at), { now }).results);
  const a = env.DB.raw.prepare("SELECT * FROM zone_rule_arms").all();
  assert.deepEqual(a.map((x) => [x.agent, x.rule, x.status, x.base_stop, x.base_tp1, x.rule_version]), [["zone_pullback", "tp_typed", "resolved", 4020, 4060, null]], "no decision-time row: NULL");
  assert.ok(a[0].acted_r > 0 && a[0].base_r > a[0].acted_r, JSON.stringify(a[0]));
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM plan_setups").get().n, 0, "plan_setups is never written");
  // A rerun adds nothing.
  assert.deepEqual([(await runZoneCounterfactuals(env, { now, bars: rising(at) })).added], [0]);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM zone_blocked_setups").get().n + env.DB.raw.prepare("SELECT COUNT(*) AS n FROM zone_rule_arms").get().n, 2);
});

// ---------------------------------------------------------------- the 14 plan_setups readers stay as they are

const allArms = (control, best) => Object.fromEntries(pl.PLAN_ARMS.map((a) => [a.id, { s: "target", r: a.id === pl.CONTROL_ARM ? control : a.id === "e0@s0.5" ? best : control - 0.05, f: 1 }]));
const SNOW = Date.parse("2026-11-20T12:00:00Z");
async function seedReaders(db, { zones }) {
  await pl.ensurePlanLearningSchema(db);
  await de.ensureDecisionSchema(db);
  const ins = db.raw.prepare("INSERT INTO plan_setups (setup_key, decision_key, agent, pattern, opened_at, decided_at, last_seen_at, decisions, side, entry, stop, tp1, atr_h1, mode, action, at_level, regime, context, status, resolved_at, results_json, version, updated_at, htf, source, rule_version) VALUES (?, ?, ?, NULL, ?, ?, ?, 1, ?, 4000, ?, ?, 10, ?, 'ENTER_LIMIT', 1, ?, ?, 'resolved', ?, ?, 'cryptophys.plan-learning.v2', ?, ?, 'live', 'tp1_kz:on')");
  for (let i = 0; i < 40; i++) {
    const at = SNOW - 20 * DAY + i * 4 * HOUR, key = keyOf(at - M15);
    ins.run(`${key}:BUY`, key, "zone_pullback", iso(at), iso(at), iso(at), "BUY", 3990, 4015, "intraday", "normal-trending", "intraday|normal-trending", iso(at + HOUR), JSON.stringify(allArms(i % 3 ? 0.2 : -0.4, 0.3)), iso(at + HOUR), null);
    db.raw.prepare("INSERT OR IGNORE INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, 'BUY', 0.6, 'council', ?)").run(key, iso(at), iso(at), JSON.stringify({ stance: "BUY", trade: { side: "BUY", entry: 4000, stop: 3990, tp: 4015 }, trading_mode: "intraday", rules: { quorum_min: 0.5, min_rrr: 1.5 }, quorum: { long_share: 0.6, short_share: 0.2 } }));
    if (!zones) continue;
    // The same bars, strongly different counterfactual outcomes, in their own tables.
    await ensureZoneReadingsSchema(db);
    db.raw.prepare("INSERT INTO zone_blocked_setups (setup_key, decision_key, agent, opened_at, decided_at, last_seen_at, decisions, side, entry, stop, tp1, atr_h1, mode, action, at_level, regime, context, status, resolved_at, results_json, version, updated_at, source, rule_version) VALUES (?, ?, 'zone_pullback', ?, ?, ?, 1, 'SELL', 4000, 4010, 3985, 10, 'scalp', 'ENTER_LIMIT', 1, 'low-ranging', 'scalp|low-ranging', 'resolved', ?, ?, 'cryptophys.plan-learning.v2', ?, 'zone_blocked', 'tp1_kz:on')")
      .run(`${key}:SELL`, key, iso(at), iso(at), iso(at), iso(at + HOUR), JSON.stringify(allArms(2.5, 3)), iso(at + HOUR));
    db.raw.prepare("INSERT INTO zone_rule_arms (arm_key, setup_key, decision_key, agent, rule, side, opened_at, decided_at, last_seen_at, decisions, entry, stop, tp1, base_stop, base_tp1, atr_h1, status, acted_r, base_r, rule_version, version, updated_at) VALUES (?, ?, ?, 'range_fade', 'tp_typed', 'BUY', ?, ?, ?, 1, 4000, 3990, 4015, 3990, 4030, 10, 'resolved', 3, -1, 'tp1_kz:on', 'v', ?)")
      .run(`${key}:BUY|tp_typed`, `${key}:BUY`, key, iso(at), iso(at), iso(at), iso(at + HOUR));
  }
}
const seats = (verdict) => async () => ({ status: "answered", obj: { verdict, reason: `${verdict} on the evidence` } });
async function readerOutputs(zones) {
  const out = {};
  const fresh = async () => { reset(); const env = { DB: d1(), SIGNAL_CACHE: kv(), GRID_ADAPT_MODE: "live", STRATEGY_AGENTS_LIVE: "range_fade" }; await seedReaders(env.DB, { zones }); return env; };
  let env = await fresh();
  await pl.runPlanLearning(env, { now: SNOW, bars: [] });
  const st = JSON.parse(await env.SIGNAL_CACHE.get(pl.PLAN_LEARNING_KEY));
  out.agentRecords = st.agents; out.suspendedAgents = suspendedAgents(st.agents); out.agentVoice = st.agents.map((r) => agentVoice(r));
  out.learned = st.learned; out.walk_forward = st.walk_forward;
  env = await fresh(); await env.SIGNAL_CACHE.put(de.TRADING_MODE_KEY, "intraday");
  out.modeSelector = (await ms.runModeSelector(env, { now: SNOW, regime: "trend", call: seats("approve") })).evidence ?? null;
  env = await fresh(); out.gridAdapt = { run: await runGridAdapt(env, { now: SNOW, force: true }), doc: await readGridChoices(env) };
  env = await fresh(); out.knobTuning = await runKnobProposals(env, { now: SNOW, force: true, publish: async () => ({ outcome: "disabled" }) });
  env = await fresh(); await runStrategyCouncil(env, { now: SNOW, call: async () => ({ status: "answered", obj: { proposal: "keep", reason: "keep" } }), force: true }); out.strategyCouncil = JSON.parse(await env.SIGNAL_CACHE.get(COUNCIL_KEY));
  env = await fresh(); await computeRecommendations(env, { now: SNOW, force: true }); out.recommendations = JSON.parse(await env.SIGNAL_CACHE.get("strategy-recommendations:v1") ?? "null");
  env = await fresh(); out.cfcPack = (await buildEvidencePack(env, "strategy:zone_pullback", { now: SNOW }));
  env = await fresh(); out.cfcTriggers = await readTriggerInputs(env, { now: SNOW });
  out.planSetups = env.DB.raw.prepare("SELECT COUNT(*) AS n FROM plan_setups").get().n;
  out.zoneRows = tables(env.DB).includes("zone_blocked_setups") ? env.DB.raw.prepare("SELECT COUNT(*) AS n FROM zone_blocked_setups").get().n : 0;
  return out;
}

test("ZR-7 with zone_blocked_setups and zone_rule_arms populated, every plan_setups reader's output deep-equals today's, and the plan_setups row count is unchanged", async () => {
  const today = await readerOutputs(false);
  const withZones = await readerOutputs(true);
  assert.equal(withZones.zoneRows, 40, "the counterfactual rows are there");
  const { zoneRows: _a, ...a } = today, { zoneRows: _b, ...b } = withZones;
  // Timestamps aside (each run stamps its own clock, the same fixed `now`), byte for byte.
  assert.deepEqual(b, a);
  assert.equal(b.planSetups, 40);
  assert.ok(a.agentRecords.length && a.cfcTriggers.strategy.setups.length === 40, "the readers read the seeded setups");
  // Statically: no module but zone-readings names a counterfactual table, and zone-readings never names plan_setups in SQL.
  const { readFileSync, readdirSync } = await import("node:fs");
  const src = new URL("../src/", import.meta.url);
  for (const f of readdirSync(src).filter((n) => n.endsWith(".mjs") && n !== "zone-readings.mjs")) assert.doesNotMatch(readFileSync(new URL(f, src), "utf8"), /(FROM|INTO|UPDATE|JOIN|TABLE(?: IF NOT EXISTS)?)\s+(zone_blocked_setups|zone_rule_arms|zone_readings)\b/i, f);
  assert.doesNotMatch(readFileSync(new URL("zone-readings.mjs", src), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""), /FROM plan_setups|INTO plan_setups|UPDATE plan_setups/);
});

// ---------------------------------------------------------------- the breaker

const readingRows = (n, type, approach, heldShare) => Array.from({ length: n }, (_, i) => ({ zone_type: type, approach, outcome: i < Math.round(n * heldShare) ? "held" : i % 2 ? "broke" : "neither" }));

test("ZR-8 (a) typing trips at min_group (60 per group) when own-type holds less than untyped, not below 60, not when it holds more", () => {
  const trip = zoneBreakerHolds({ readings: [...readingRows(60, "demand", "from_above", 0.3), ...readingRows(60, null, "from_below", 0.5)] });
  assert.deepEqual(Object.keys(trip.held), ["zone_ahead", "tp", "stop", "factor"]);
  assert.deepEqual(trip.held.zone_ahead.by, ["typing"]);
  assert.deepEqual([trip.checks.typing.own_n, trip.checks.typing.untyped_n, trip.checks.typing.edge], [60, 60, -0.2]);
  assert.deepEqual(zoneBreakerHolds({ readings: [...readingRows(59, "demand", "from_above", 0.3), ...readingRows(61, null, "from_below", 0.5)] }).held, {});
  assert.deepEqual(zoneBreakerHolds({ readings: [...readingRows(60, "supply", "from_below", 0.6), ...readingRows(60, "none", "from_above", 0.5)] }).held, {});
  // An opposite-type meeting (demand met from below) is neither group; the window is the latest 300.
  assert.deepEqual(zoneBreakerHolds({ readings: [...readingRows(60, "demand", "from_below", 0), ...readingRows(60, null, "from_above", 0.5)] }).checks.typing.own_n, 0);
  assert.equal(zoneBreakerHolds({ readings: readingRows(400, null, "from_above", 0.5) }).checks.typing.untyped_n, ZONE_BREAKER.window);
});

test("ZR-9 (b) block trips at 30 resolved zone_blocked setups with a mean above +0.10R (zone_ahead to record), not at 29; (c) holds only the losing rule", () => {
  const rs = (n, r) => Array.from({ length: n }, (_, i) => ({ r: r + (i % 2 ? 0.02 : -0.02) }));
  assert.deepEqual(zoneBreakerHolds({ blocked: rs(30, 0.12) }).held, { zone_ahead: { by: ["block"] } });
  assert.deepEqual(zoneBreakerHolds({ blocked: rs(29, 0.12) }).held, {});
  assert.deepEqual(zoneBreakerHolds({ blocked: rs(30, 0.1) }).held, {}, "+0.10R is not above +0.10R");
  const arms = [...Array.from({ length: 30 }, () => ({ rule: "tp_typed", acted_r: 0.1, base_r: 0.3 })), ...Array.from({ length: 30 }, () => ({ rule: "stop_skip", acted_r: 0.4, base_r: 0.2 }))];
  assert.deepEqual(zoneBreakerHolds({ arms }).held, { tp: { by: ["rule:tp_typed"] } });
  assert.deepEqual(zoneBreakerHolds({ arms: arms.slice(1) }).held, {}, "29 tp arms");
});

/** A D1 recording every statement, for the breaker's write check. */
function recordingDb() {
  const base = d1(), sql = [];
  const wrap = (q, p = []) => ({ bind: (...a) => wrap(q, a), run: () => { sql.push(q); return base.prepare(q).bind(...p).run(); }, first: () => { sql.push(q); return base.prepare(q).bind(...p).first(); }, all: () => { sql.push(q); return base.prepare(q).bind(...p).all(); } });
  return { prepare: (q) => wrap(q), batch: async (s) => { for (const x of s) await x.run(); }, raw: base.raw, sql };
}
function seedBlocked(db, n, r, rv) {
  for (let i = 0; i < n; i++) db.raw.prepare("INSERT OR REPLACE INTO zone_blocked_setups (setup_key, decision_key, opened_at, decided_at, last_seen_at, side, entry, stop, tp1, atr_h1, context, status, results_json, version, updated_at, rule_version) VALUES (?, 'k', ?, ?, ?, 'BUY', 4000, 3990, 4015, 10, 'c', 'resolved', ?, 'v', 'u', ?)")
    .run(`s${i}`, iso(T0 + i * HOUR), iso(T0 + i * HOUR), iso(T0 + i * HOUR), JSON.stringify({ "e0@s1": { r, s: "target", f: 1 } }), rv);
}

test("ZR-10 the tick: one 'XAUUSD ZONES' line per change, hourly; a 7-day hold that outlasts its evidence, then released on recovery or kept while it trips; an owner rule change releases at once; state in KV only, never omega_settings, an FS1 override or any Omega/PM state", async () => {
  reset();
  const db = recordingDb();
  const env = { DB: db, SIGNAL_CACHE: kv(), ZONE_PRIORITY: "on", ZONE_AHEAD_MODE: "trend", ZONE_AIM_OFF: "tp,stop,factor" };
  await env.SIGNAL_CACHE.put(FEATURE_SWITCH_OVERRIDE_KEY, JSON.stringify({ ZONE_PRIORITY: { value: "on", actor: "owner", at: "2026-11-25T09:00:00.000Z" } }));
  const lines = [];
  const send = async (t) => { lines.push(t); };
  const state = async () => JSON.parse(await env.SIGNAL_CACHE.get(ZONE_BREAKER_KEY));
  assert.equal(ZONE_BREAKER.hold_ms, 7 * DAY, "SV1b's 7 days");
  // Empty tables (none exist yet): no hold, no line, no error.
  assert.deepEqual(await runZoneBreaker(env, { now: RNOW, send }), { status: "unchanged", held: [], told: 0, alarmed: 0 });
  assert.deepEqual(lines, []);
  await ensureZoneReadingsSchema(db);
  const rv = ruleVersionOf(env);
  seedBlocked(db, 30, 0.15, rv);
  assert.equal((await runZoneBreaker(env, { now: RNOW + 10 * M1, send })).status, "fresh", "hourly");
  const t1 = RNOW + HOUR;
  const trip = await runZoneBreaker(env, { now: t1, send });
  assert.deepEqual([trip.status, trip.held, lines.length], ["changed", ["zone_ahead"], 1]);
  assert.match(lines[0], /^XAUUSD ZONES: the breaker holds the zone_ahead check \(to record\) on the decision side for at least 7 days: the trades the check held back made 0\.15R per setup over 30\./);
  assert.doesNotMatch(lines[0], /\d{4}\.\d/, "no price");
  assert.deepEqual((await state()).held, { zone_ahead: { by: ["block"], since: iso(t1), until: iso(t1 + 7 * DAY), rule_version: rv } });
  // Before `until`, the hold stands though the evidence no longer trips (+0.05R): no line, no flicker.
  seedBlocked(db, 30, 0.05, rv);
  for (const dt of [3 * HOUR, DAY, 6 * DAY]) assert.deepEqual((await runZoneBreaker(env, { now: t1 + dt, send })).held, ["zone_ahead"], `+${dt / HOUR}h`);
  assert.equal(lines.length, 1);
  // After `until` on the same rule version: released once recovered, one line.
  const rel = await runZoneBreaker(env, { now: t1 + 7 * DAY + HOUR, send });
  assert.deepEqual([rel.status, rel.held, lines.length], ["changed", [], 2]);
  assert.match(lines[1], /^XAUUSD ZONES: the breaker releases the zone_ahead check \(to record\): its record recovered after the 7-day hold\.$/);
  // A new hold; after its `until` it is kept while it still trips (no line).
  seedBlocked(db, 30, 0.15, rv);
  const t2 = t1 + 8 * DAY;
  await runZoneBreaker(env, { now: t2, send });
  assert.equal(lines.length, 3);
  assert.deepEqual((await runZoneBreaker(env, { now: t2 + 7 * DAY + HOUR, send })).held, ["zone_ahead"]);
  assert.equal(lines.length, 3);
  assert.equal((await state()).held.zone_ahead.since, iso(t2), "kept as it was");
  // The owner changes a zone switch (a new rule version): released at once, before any `until`, "the rules changed".
  const t3 = t2 + 15 * DAY;
  seedBlocked(db, 30, 0.15, rv);
  await runZoneBreaker(env, { now: t3, send });
  const bumped = { ...env, ZONE_AIM_OFF: "stop,factor" };
  assert.notEqual(ruleVersionOf(bumped), rv);
  assert.deepEqual((await runZoneBreaker(bumped, { now: t3 + HOUR, send })).held, []);
  assert.match(lines.at(-1), /^XAUUSD ZONES: the breaker releases the zone_ahead check \(to record\): the rules changed \(the owner changed a zone switch\), and the owner's change wins\.$/);
  const n = lines.length;
  // Fresh holds read the owner's current rule version only: the old version's evidence does not trip it again.
  assert.deepEqual((await runZoneBreaker(bumped, { now: t3 + 2 * HOUR, send })).held, []);
  assert.equal(lines.length, n);
  // A new hold whose line fails is not stored, and is told at the next tick.
  await runZoneBreaker(env, { now: t3 + 3 * HOUR, send: async () => { throw new Error("telegram down"); } });
  assert.deepEqual((await state()).held, {});
  await runZoneBreaker(env, { now: t3 + 4 * HOUR, send });
  assert.equal(lines.length, n + 1);
  // Writes: only its own tables' schema (run by the test) and SELECTs; KV: its own key besides the seeded override.
  for (const q of db.sql) assert.match(q.trim(), /^(SELECT|CREATE (TABLE|INDEX) IF NOT EXISTS (idx_)?zone_)/, q);
  assert.ok(!db.sql.some((q) => /omega_settings|position_actions SET|INSERT INTO (omega|position)/i.test(q)));
  assert.deepEqual([...env.SIGNAL_CACHE.m.keys()].sort(), [FEATURE_SWITCH_OVERRIDE_KEY, ZONE_BREAKER_KEY].sort());
  assert.equal(JSON.parse(await env.SIGNAL_CACHE.get(FEATURE_SWITCH_OVERRIDE_KEY)).ZONE_PRIORITY.value, "on", "the owner's FS1 value is unchanged");
  assert.ok(!tables(db).includes("omega_settings"));
});

test("ZR-10b zoneHoldStep and applyZoneHolds: a hold on another rule version than the owner's is never applied", () => {
  const rv = "tp1_kz:on+zone_ahead@1", h = { by: ["block"], since: iso(RNOW), until: iso(RNOW + 7 * DAY), rule_version: rv };
  assert.deepEqual(zr.zoneHoldStep({ zone_ahead: h }, {}, { now: RNOW + DAY, ruleVersion: rv }), { held: { zone_ahead: h }, changes: [] });
  assert.deepEqual(zr.zoneHoldStep({ zone_ahead: h }, {}, { now: RNOW + 8 * DAY, ruleVersion: rv }).changes.map((c) => c.kind), ["recovered"]);
  assert.deepEqual(zr.zoneHoldStep({ zone_ahead: h }, { zone_ahead: { by: ["block"] } }, { now: RNOW + 8 * DAY, ruleVersion: rv }).held, { zone_ahead: h });
  assert.deepEqual(zr.zoneHoldStep({ zone_ahead: h }, { zone_ahead: { by: ["block"] } }, { now: RNOW + DAY, ruleVersion: "tp1_kz:off" }).changes.map((c) => c.kind), ["rules_changed"]);
  const owner = { ZONE_PRIORITY: "on", ZONE_AHEAD_MODE: "trend", ZONE_AIM_OFF: "tp,stop,factor" };
  assert.equal(ruleVersionOf(owner), rv);
  assert.deepEqual(applyZoneHolds(owner, { zone_ahead: h }).held, [{ rule: "zone_ahead", by: ["block"] }]);
  assert.deepEqual(applyZoneHolds(owner, { zone_ahead: { ...h, rule_version: "tp1_kz:on" } }).held, [], "the owner's change wins at once");
});

test("ZR-11 a hold acts as its own switch off for the run only: ZONE_AHEAD_MODE to record, tokens into ZONE_AIM_OFF; nothing is turned on; ZONE_PRIORITY off still overrides", () => {
  const owner = Object.freeze({ ZONE_PRIORITY: "on", ZONE_AHEAD_MODE: "trend", ZONE_AIM_OFF: "factor" });
  const all = { zone_ahead: { by: ["typing"] }, tp: { by: ["typing"] }, stop: { by: ["typing"] }, factor: { by: ["typing"] } };
  const out = applyZoneHolds(owner, all);
  assert.deepEqual([out.env.ZONE_AHEAD_MODE, out.env.ZONE_AIM_OFF], ["record", "tp,stop,factor"]);
  assert.deepEqual(out.held, [{ rule: "zone_ahead", by: ["typing"] }, { rule: "tp", by: ["typing"] }, { rule: "stop", by: ["typing"] }], "factor was already off: nothing to hold");
  assert.deepEqual(owner, { ZONE_PRIORITY: "on", ZONE_AHEAD_MODE: "trend", ZONE_AIM_OFF: "factor" }, "the owner's env is never written");
  // Already off, or 'record'/'off' by the owner, or ZONE_PRIORITY off: nothing held, env itself.
  for (const e of [{ ZONE_PRIORITY: "off", ZONE_AHEAD_MODE: "trend", ZONE_AIM_OFF: "" }, { ZONE_PRIORITY: "on", ZONE_AHEAD_MODE: "record", ZONE_AIM_OFF: "tp,stop,factor" }, { ZONE_PRIORITY: "on", ZONE_AHEAD_MODE: "off", ZONE_AIM_OFF: "tp,stop,factor" }]) {
    const r = applyZoneHolds(e, all);
    assert.equal(r.env, e);
    assert.deepEqual(r.held, []);
  }
  assert.equal(applyZoneHolds(owner, null).env, owner);
  // 'all' (owner-set) is held to 'record' too; a hold never moves 'trend' to 'all' or a token on.
  assert.equal(applyZoneHolds({ ZONE_PRIORITY: "on", ZONE_AHEAD_MODE: "all" }, { zone_ahead: { by: ["block"] } }).env.ZONE_AHEAD_MODE, "record");
  assert.equal(applyZoneHolds({ ZONE_PRIORITY: "on", ZONE_AIM_OFF: "" }, { tp: { by: ["rule:tp_typed"] } }).env.ZONE_AIM_OFF, "tp");
  // The registry: ZONE_READINGS in the zones group, on by default and in the config, no mode-evidence restart, not an emergency stop.
  const e = switchByKey("ZONE_READINGS");
  assert.deepEqual([e.group, e.worker, e.default_value, e.config_value, e.restarts_mode_evidence, e.emergency_stop, e.era_switch], ["zones", "ai", "on", "on", false, false, false]);
});

// ---------------------------------------------------------------- the Decision Engine: byte-identical, zone_rules_held

const decisionEnv = async (over = {}) => { reset(); const env = { DB: d1(), SIGNAL_CACHE: kv(), AI: failingAi, ...ENV_BASE, ...over }; await env.SIGNAL_CACHE.put(de.TRADING_MODE_KEY, "intraday"); return env; };
const decide = async (env) => { await de.runDecisionEngine(env, { barClose: CLOSE, now: NOW, clock: () => NOW + 5_000, loaded: loaded() }); return env.DB.raw.prepare("SELECT decision_json FROM engine_decisions").get().decision_json; };

test("ZR-12 decisions: ZONE_READINGS off (a held state in KV ignored), on with nothing held, and main (no variable) are byte-identical; a hold is recorded as zone_rules_held and acts as the owner's 'record'", async () => {
  const Z = { ZONE_PRIORITY: "on", ZONE_AHEAD_MODE: "trend" };
  const main = await decide(await decisionEnv(Z));
  assert.match(main, /"id":"zone_ahead"/, "the check is in the guardrails");
  const onEmpty = await decide(await decisionEnv({ ...Z, ZONE_READINGS: "on" }));
  const offHeld = await decisionEnv({ ...Z, ZONE_READINGS: "off" });
  await offHeld.SIGNAL_CACHE.put(ZONE_BREAKER_KEY, JSON.stringify({ held: { zone_ahead: { by: ["block"] } } }));
  assert.equal(onEmpty, main);
  assert.equal(await decide(offHeld), main);
  // An empty breaker state (tables empty: no hold) changes nothing either.
  const onState = await decisionEnv(Z);
  await onState.SIGNAL_CACHE.put(ZONE_BREAKER_KEY, JSON.stringify({ held: {}, checks: {} }));
  assert.equal(await decide(onState), main);
  // Held: the run reads ZONE_AHEAD_MODE "record"; the record equals the owner's own "record" decision plus zone_rules_held.
  const held = await decisionEnv(Z);
  await held.SIGNAL_CACHE.put(ZONE_BREAKER_KEY, JSON.stringify({ held: { zone_ahead: { by: ["block"] } } }));
  const h = JSON.parse(await decide(held));
  const ownerRecord = JSON.parse(await decide(await decisionEnv({ ...Z, ZONE_AHEAD_MODE: "record" })));
  assert.deepEqual(h.zone_rules_held, [{ rule: "zone_ahead", by: ["block"] }]);
  const { zone_rules_held, ...rest } = h;
  assert.deepEqual(rest, ownerRecord);
  assert.equal(held.ZONE_AHEAD_MODE, "trend", "the owner's env is unchanged");
  // The EA signal and managementFields never read zone_rules_held.
  const sig = (d) => eaSignalFromDecision({ decision: d, now: NOW + 10_000, marketPrice: 4000, marketMs: NOW });
  assert.deepEqual(sig(h), sig(rest));
  assert.deepEqual(managementFields(h), managementFields(rest));
});

test("ZR-13 the ledger step's CPU: the readings and counterfactuals add a small, bounded cost (200 decisions a run at most, D1-side json_extract)", async (t) => {
  // A catch-up run: 200 decisions with 12 zones each on 300 15m bars, against one plan-learner run on 40 setups.
  const spec = Array.from({ length: 300 }, (_, i) => { const c = 4000 + 10 * Math.sin(i / 7); return [c, c + 3, c - 3, c + 1]; });
  const bars = barsOf(spec);
  const zones = Array.from({ length: 12 }, (_, i) => ({ low: 3985 + i * 2.5, high: 3986.5 + i * 2.5, zone_type: i % 3 === 0 ? "demand" : i % 3 === 1 ? "supply" : "none", zone_strength: "medium", zone_rank: "candidate" }));
  const decisions = Array.from({ length: 200 }, (_, i) => decisionAt(i + 1, zones));
  for (let i = 0; i < 5; i++) zoneReadings(decisions, bars);
  let t0 = performance.now();
  const N = 20;
  for (let i = 0; i < N; i++) zoneReadings(decisions, bars);
  const catchUp = (performance.now() - t0) / N;
  t0 = performance.now();
  for (let i = 0; i < N * 50; i++) zoneReadings(decisions.slice(-3), bars);
  const steady = (performance.now() - t0) / (N * 50);
  t.diagnostic(`readings: ${catchUp.toFixed(2)} ms for a 200-decision catch-up, ${steady.toFixed(3)} ms for a steady 3-decision run`);
  assert.ok(catchUp < 50, `${catchUp} ms`);
  assert.ok(steady < 2, `${steady} ms`);
  // Empty tables, nothing behind the cursor: the step is two cheap reads and no write.
  const env = await readingsEnv();
  await runZoneReadingsStep(env, { now: RNOW });
  const before = env.DB.raw.prepare("SELECT COUNT(*) AS n FROM zone_readings").get().n;
  const again = await runZoneReadingsStep(env, { now: RNOW });
  assert.deepEqual([again.readings.status, again.counterfactuals.status], ["idle", "idle"]);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM zone_readings").get().n, before);
});

// ---------------------------------------------------------------- alarms, Omega attribution

test("ZR-14 alarms: zone_ahead alone in more than 40% of the last 96 decisions where the council wanted a side; under 'all' the share always; Omega's advisory at 15 closes below 0R", () => {
  const rows = (n, blocked) => Array.from({ length: n }, (_, i) => ({ wanted: "SELL", blocked_side: i < blocked ? "short" : null }));
  assert.deepEqual(blockShare(rows(96, 39)), { n: 96, blocked: 39, share: 0.406 });
  assert.deepEqual(Object.keys(alarmLines({ share: blockShare(rows(96, 39)) })), ["zone_ahead_share"]);
  assert.deepEqual(alarmLines({ share: blockShare(rows(96, 38)) }), {}, "39.6% is not above 40%");
  assert.deepEqual(alarmLines({ share: blockShare(rows(95, 60)) }), {}, "fewer than 96");
  assert.deepEqual(blockShare([{ wanted: "BUY", blocked_side: "short" }]).blocked, 0, "the other side is not the wanted side");
  assert.deepEqual(Object.keys(alarmLines({ share: blockShare(rows(10, 0)), mode: "all" })), ["all_mode_share"]);
  const om = alarmLines({ omega: { closes: 15, mean_r: -0.2, advisory: true } });
  assert.match(om.omega_attribution, /^XAUUSD ZONES: Omega's zone-attributed trades closed 15 times at -0\.2R .*the owner may set zone_mgmt lower\. No action taken\.$/);
  for (const t of Object.values({ ...alarmLines({ share: blockShare(rows(96, 50)), mode: "all" }), ...om })) assert.match(t, /^XAUUSD ZONES/);
});

test("ZR-15 Omega attribution: SELECT only, by the intent's reason or level_source and the PM's zone rules, in R; nothing without tables", async () => {
  reset();
  const db = recordingDb();
  assert.deepEqual(await omegaZoneAttribution(db, { now: RNOW }), { closes: 0, mean_r: null, by: [], advisory: false });
  db.raw.exec("CREATE TABLE omega_intents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)");
  db.raw.exec("CREATE TABLE position_actions (id TEXT PRIMARY KEY, ticket INTEGER NOT NULL, bar INTEGER NOT NULL, at_ms INTEGER NOT NULL, side TEXT NOT NULL, pips REAL, price REAL, action TEXT NOT NULL, rule TEXT NOT NULL, sl REAL, tp REAL, why TEXT, council TEXT, orig_sl REAL, orig_tp REAL, basis REAL, status TEXT NOT NULL)");
  db.raw.exec("CREATE TABLE ea_deals (id INTEGER PRIMARY KEY AUTOINCREMENT, deal_ticket INTEGER NOT NULL, position_ticket INTEGER, mode TEXT NOT NULL, side TEXT NOT NULL, volume REAL NOT NULL, entry_price REAL, exit_price REAL, stop_loss REAL, take_profit REAL, profit REAL NOT NULL, commission REAL NOT NULL DEFAULT 0, swap REAL NOT NULL DEFAULT 0, reason TEXT NOT NULL, signal_id TEXT, opened_ms INTEGER, closed_ms INTEGER NOT NULL, currency TEXT, received_at TEXT NOT NULL, source TEXT)");
  for (let t = 1; t <= 16; t++) {
    db.raw.prepare("INSERT INTO omega_intents VALUES (?, 'open', ?, 'done', ?, ?, ?)").run(`o${t}`, JSON.stringify({ entry: 4000, sl: 3990, volume: 0.1, r_dist: 10, signal_issued_ms: RNOW - DAY + t * HOUR, side: "BUY", level_source: t % 2 ? "zone" : "key_level" }), JSON.stringify({ ticket: 900 + t }), RNOW - DAY, RNOW - DAY);
    if (t % 2 === 0) db.raw.prepare("INSERT INTO position_actions VALUES (?, ?, 1, ?, 'BUY', 0, 0, 'modify_sl', 'zone_trail', 0, 0, '', '', 0, 0, 0, 'done')").run(`a${t}`, 900 + t, RNOW - DAY);
    db.raw.prepare("INSERT INTO ea_deals (deal_ticket, position_ticket, mode, side, volume, profit, reason, opened_ms, closed_ms, currency, received_at, source) VALUES (?, ?, 'real', 'BUY', 0.1, ?, 'sl', ?, ?, 'USD', 'x', 'omega')").run(5000 + t, 900 + t, -5, RNOW - DAY, RNOW - 1000);
  }
  const out = await omegaZoneAttribution(db, { now: RNOW });
  assert.deepEqual([out.closes, out.advisory, out.by.map((b) => [b.source, b.n])], [16, true, [["intent:level_source_zone", 8], ["pm:zone_trail", 8]]]);
  assert.ok(out.mean_r < 0);
  for (const q of db.sql) assert.match(q.trim(), /^SELECT/, q);
  assert.doesNotMatch(JSON.stringify(out), /ticket|900|4000|account|profit/);
});

// ---------------------------------------------------------------- GET /api/zones

async function bundle(entry) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "z5-"));
  const file = join(dir, "worker.mjs");
  const out = await build({ entryPoints: [join(root, entry)], bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent", alias: { "cloudflare:workers": join(root, "test/support/cloudflare-workers-stub.mjs") } });
  await writeFile(file, out.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  await rm(dir, { recursive: true, force: true });
  return mod.default;
}
const KEY_RE = /account|login|email|user|ticket|server|password|identity|sub\b|entry|stop\b|tp1|price/i;
function keysOf(x, out = []) { if (Array.isArray(x)) x.forEach((v) => keysOf(v, out)); else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) { out.push(k); keysOf(v, out); } return out; }

test("ZR-16 GET /api/zones: the shape on empty tables ([] everywhere, SELECT only, no table created); words, ATR and R, no account or identity key; POST 405; ZONE_READINGS off 404", async () => {
  const worker = await bundle("src/index.ts");
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  reset();
  const env = { DB: recordingDb(), SIGNAL_CACHE: kv() };
  const r = await worker.fetch(new Request("https://worker.test/api/zones"), env, ctx);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const body = await r.json();
  const { generated_at, ...shape } = body;
  assert.match(generated_at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(shape, { status: "ok", schema: "cryptophys.zones-view.v1", window_days: 30, prior: 20, readings: [], zone_blocked: [], rule_arms: [], breaker: null, stances: [], omega_attribution: [], omega_advisory: { closes: 0, mean_r: null, advisory: false } });
  assert.ok(!env.DB.sql.some((q) => !/^\s*SELECT/i.test(q) && /zone_|omega_|position_|ea_deals/.test(q)), "SELECT only on the zone, Omega and deal tables");
  assert.deepEqual(ZONE_TABLES.filter((t) => tables(env.DB).includes(t)), []);
  // Populated: readings shrunk with the prior, the cohort, the arms, the breaker and the stances; no account or price key.
  reset();
  const full = await readingsEnv();
  await runZoneReadings(full, { now: RNOW });
  const at = Date.parse("2026-11-20T10:00:00Z");
  seedCounterfactualDecisions(full.DB, at);
  await runZoneCounterfactuals(full, { now: at + 12 * HOUR, bars: rising(at) });
  await full.SIGNAL_CACHE.put(ZONE_BREAKER_KEY, JSON.stringify({ checked_at: iso(RNOW), rule_version: "tp1_kz:on", held: { zone_ahead: { by: ["block"] } }, checks: { block: { n: 30, mean_r: 0.15 } } }));
  const v = await zonesView(full, { now: at + 13 * HOUR });
  assert.deepEqual(v.readings.map((g) => [g.zone_type, g.approach, g.zone_strength, g.n, g.held_rate, g.held_rate_shrunk]), [["demand", "from_above", "medium", 1, 1, 1]]);
  assert.deepEqual(v.zone_blocked.map((g) => [g.side, g.n, g.fill_rate]), [["BUY", 1, 1]]);
  assert.deepEqual(v.rule_arms.map((g) => [g.rule, g.n]), [["tp_typed", 1]]);
  assert.deepEqual(v.breaker.held, [{ rule: "zone_ahead", by: ["block"] }]);
  assert.deepEqual(v.stances.map((s) => s.stance), ["BUY", "WAIT"]);
  assert.deepEqual(keysOf(v).filter((k) => KEY_RE.test(k)), []);
  assert.doesNotMatch(JSON.stringify(v), /399\d|40[0-6]\d\.|@/);
  // POST 405 (through Nexus's proxy too: it never leaves Nexus), off 404.
  assert.equal((await worker.fetch(new Request("https://worker.test/api/zones", { method: "POST", body: "{}" }), env, ctx)).status, 405);
  const nexus = await bundle("workers/xauusd-nexus-dashboard/src/index.ts");
  const seen = [];
  const AI_WORKER = { async fetch(req) { seen.push(req.method); return worker.fetch(req, env, ctx); } };
  assert.equal((await nexus.fetch(new Request("https://nexus.test/api/zones"), { AI_WORKER })).status, 200);
  assert.equal((await nexus.fetch(new Request("https://nexus.test/api/zones", { method: "POST", body: "{}" }), { AI_WORKER })).status, 405);
  assert.deepEqual(seen, ["GET"]);
  const off = await worker.fetch(new Request("https://worker.test/api/zones"), { ...env, ZONE_READINGS: "off" }, ctx);
  assert.equal(off.status, 404);
  assert.deepEqual(await off.json(), { status: "not_found", reason: "zone_readings_off" });
  // A read failure other than a missing table: 500.
  const broken = { DB: { prepare: () => { throw new Error("D1_ERROR: boom"); } }, SIGNAL_CACHE: kv() };
  const e = await worker.fetch(new Request("https://worker.test/api/zones"), broken, ctx);
  assert.equal(e.status, 500);
  assert.deepEqual(await e.json(), { status: "error", error: "zones_unavailable" });
});

// ---------------------------------------------------------------- the decision-time rule version; holds never stamp one

/** 15m bars around the fixture's decision bar (CLOSE): the bar before closes at 4005, the decision bar dips to 3996, 8 bars at 4004. */
function fixtureBars() {
  const close = Date.parse(CLOSE), bar = (open, [o, h, l, c]) => ({ open_time: iso(open), close_time: iso(open + M15), open: o, high: h, low: l, close: c });
  return [bar(close - 2 * M15, [4006, 4007, 4004, 4005]), bar(close - M15, [4004, 4002, 3996, 4000]), ...Array.from({ length: 8 }, (_, i) => bar(close + i * M15, [4004, 4005, 4003, 4004]))];
}
const ZON = { ZONE_PRIORITY: "on", ZONE_AHEAD_MODE: "trend", ZONE_AIM_OFF: "tp,stop,factor" };

test("ZR-17 rule_version at the decision's time: the decision writes zone_decision_rules (the record unchanged); a reading written after the rules changed carries the decision-time version; off writes none", async () => {
  const env = await decisionEnv(ZON);
  const json = await decide(env);
  const owner = ruleVersionOf(env);
  assert.equal(owner, "tp1_kz:on+zone_ahead@1");
  const rows = env.DB.raw.prepare("SELECT decision_key, bar_close, rule_version FROM zone_decision_rules").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ decision_key: keyOf(Date.parse(CLOSE) - M15), bar_close: CLOSE, rule_version: owner }]);
  assert.doesNotMatch(json, /rule_version/, "never in the decision record");
  // The owner flips a zone switch before the readings run: the reading keeps the decision's version.
  const later = { ...env, ZONE_AHEAD_MODE: "all" };
  assert.notEqual(ruleVersionOf(later), owner);
  const out = await runZoneReadings(later, { now: Date.parse(CLOSE) + 3 * HOUR, bars15: fixtureBars() });
  assert.ok(out.written >= 1, JSON.stringify(out));
  assert.deepEqual([...new Set(env.DB.raw.prepare("SELECT rule_version FROM zone_readings").all().map((r) => r.rule_version))], [owner]);
  // The evidence of the owner's version reads it; another version's does not.
  assert.ok((await zr.breakerEvidence(env.DB, owner)).readings.length >= 1);
  assert.deepEqual((await zr.breakerEvidence(env.DB, ruleVersionOf(later))).readings, []);
  // ZONE_READINGS off: no decision-time row (no table).
  const off = await decisionEnv({ ...ZON, ZONE_READINGS: "off" });
  assert.equal(await decide(off), json, "the record is the same either way");
  assert.ok(!tables(off.DB).includes("zone_decision_rules"));
});

test("ZR-18 a hold never changes a stored rule_version: with a hold applied, the decision's mode_shadow_plans rows, the plan learner's live stamp and the zone tables carry the owner's (the mode evidence does not restart)", async () => {
  const env = await decisionEnv(ZON);
  const owner = ruleVersionOf(env);
  await env.SIGNAL_CACHE.put(ZONE_BREAKER_KEY, JSON.stringify({ held: { zone_ahead: { by: ["block"], since: iso(NOW - HOUR), until: iso(NOW + 7 * DAY), rule_version: owner } } }));
  const rec = JSON.parse(await decide(env));
  assert.deepEqual(rec.zone_rules_held, [{ rule: "zone_ahead", by: ["block"] }], "the hold acted");
  assert.notEqual(ruleVersionOf({ ...env, ZONE_AHEAD_MODE: "record" }), owner, "the held run's own rules would read another version");
  const shadow = env.DB.raw.prepare("SELECT rule_version FROM mode_shadow_plans").all();
  assert.ok(shadow.length > 0);
  assert.deepEqual([...new Set(shadow.map((r) => r.rule_version))], [owner]);
  assert.equal(env.DB.raw.prepare("SELECT rule_version FROM zone_decision_rules").get().rule_version, owner);
  await pl.runPlanLearning(env, { now: Date.parse(CLOSE) + 3 * HOUR, bars: [] });
  const live = env.DB.raw.prepare("SELECT rule_version FROM plan_setups WHERE source = 'live'").all();
  assert.ok(live.length > 0);
  assert.deepEqual([...new Set(live.map((r) => r.rule_version))], [owner]);
  await runZoneReadings(env, { now: Date.parse(CLOSE) + 3 * HOUR, bars15: fixtureBars() });
  assert.deepEqual([...new Set(env.DB.raw.prepare("SELECT rule_version FROM zone_readings").all().map((r) => r.rule_version))], [owner]);
  assert.equal(env.ZONE_AHEAD_MODE, "trend", "the owner's env is unchanged");
});

test("ZR-19 FS1: the GET rows show the breaker's holds (zone_hold on ZONE_AHEAD_MODE, a token map on ZONE_AIM_OFF); null without one, on another rule version or unreadable; the row's value stays the owner's", async () => {
  const { featureSwitchesPayload, resetFeatureSwitchMemoForTests } = await import("../src/feature-switch-store.mjs");
  const base = { ...ZON, ZONE_AIM_OFF: "stop,factor" };
  const owner = ruleVersionOf(base);
  const rows = async (env) => { resetFeatureSwitchMemoForTests?.(); const p = await featureSwitchesPayload(env, { now: NOW }); return Object.fromEntries(p.switches.filter((r) => r.key === "ZONE_AHEAD_MODE" || r.key === "ZONE_AIM_OFF").map((r) => [r.key, r])); };
  const none = await rows({ ...base, SIGNAL_CACHE: kv() });
  assert.deepEqual([none.ZONE_AHEAD_MODE.zone_hold, none.ZONE_AIM_OFF.zone_hold], [null, null]);
  const h = (by) => ({ by, since: iso(NOW - HOUR), until: iso(NOW + 7 * DAY - HOUR), rule_version: owner });
  const store = kv();
  await store.put(ZONE_BREAKER_KEY, JSON.stringify({ held: { zone_ahead: h(["typing"]), tp: h(["rule:tp_typed"]) } }));
  const held = await rows({ ...base, SIGNAL_CACHE: store });
  assert.deepEqual(held.ZONE_AHEAD_MODE.zone_hold, { since: iso(NOW - HOUR), until: iso(NOW + 7 * DAY - HOUR), by: ["typing"] });
  assert.deepEqual(held.ZONE_AIM_OFF.zone_hold, { tp: { since: iso(NOW - HOUR), until: iso(NOW + 7 * DAY - HOUR), by: ["rule:tp_typed"] } });
  // The rows are the owner's otherwise, value included.
  for (const k of ["ZONE_AHEAD_MODE", "ZONE_AIM_OFF"]) { const { zone_hold: _a, ...a } = held[k], { zone_hold: _b, ...b } = none[k]; assert.deepEqual(a, b, k); }
  assert.deepEqual([held.ZONE_AHEAD_MODE.value, held.ZONE_AIM_OFF.value], ["trend", ["tp"]]);
  // Another rule version (the owner changed a zone switch): not shown. Unreadable: null.
  assert.deepEqual((await rows({ ...base, ZONE_AHEAD_MODE: "all", SIGNAL_CACHE: store })).ZONE_AHEAD_MODE.zone_hold, null);
  const broken = { m: new Map(), async get(k) { if (k === ZONE_BREAKER_KEY) throw new Error("kv down"); return null; }, async put() {} };
  const b = await rows({ ...base, SIGNAL_CACHE: broken });
  assert.deepEqual([b.ZONE_AHEAD_MODE.zone_hold, b.ZONE_AIM_OFF.zone_hold], [null, null]);
});

test("ZR-ds (Z1b) a new zone_readings row carries the recorded level's ds_sources; an old row stays NULL (no backfill, INSERT OR IGNORE, no UPDATE)", async () => {
  // The reading of a level that carries its source labels.
  const labelled = { ...DEMAND, ds_sources: ["prophet_zone@1H", "whale@15m", "gmi_ob@1H(dup)"] };
  const r = zoneReadings([decisionAt(1, [labelled])], barsOf([...lead, [4000, 4002, 3999, 4001], [4001, 4004, 4000, 4003.5], ...flat(6)])).readings[0];
  assert.equal(r.ds_sources, "prophet_zone@1H,whale@15m,gmi_ob@1H(dup)");
  const label = (env) => env.DB.raw.prepare("UPDATE engine_decisions SET decision_json = json_set(decision_json, '$.key_levels', json(?))").run(JSON.stringify([labelled]));
  const rows = (env) => env.DB.raw.prepare("SELECT reading_key, ds_sources FROM zone_readings ORDER BY reading_key").all().map((x) => ({ ...x }));
  // A run over labelled decisions: the new row carries the labels.
  const fresh = await readingsEnv();
  label(fresh);
  await runZoneReadings(fresh, { now: RNOW });
  assert.deepEqual(rows(fresh).map((x) => x.ds_sources), ["prophet_zone@1H,whale@15m,gmi_ob@1H(dup)"]);
  // The same run where that reading was already written before Z1b (NULL): it stays NULL.
  const old = await readingsEnv();
  await zr.ensureZoneReadingsSchema(old.DB);
  const d = decisionAt(1, [DEMAND]);
  old.DB.raw.prepare("INSERT INTO zone_readings (reading_key, decision_key, bar_close, zone_type, approach, outcome, mfe_atr, mae_atr, bars, version) VALUES (?, ?, ?, 'demand', 'from_above', 'held', 0.6, 0, 2, ?)")
    .run(`${d.decision_key}#0`, d.decision_key, d.bar_close, zr.ZONE_READINGS_VERSION);
  label(old);
  await runZoneReadings(old, { now: RNOW });
  assert.deepEqual(rows(old), [{ reading_key: `${d.decision_key}#0`, ds_sources: null }], "not backfilled");
  // The writer has no UPDATE of zone_readings.
  const src = (await import("node:fs")).readFileSync(new URL("../src/zone-readings.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /UPDATE\s+zone_readings/i);
});
