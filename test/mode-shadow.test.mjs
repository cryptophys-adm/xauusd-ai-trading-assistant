// MS2 (2026-11-23): shadow per-mode evidence and the probation switch. At every 15m decision the deterministic part of
// the decision runs again for each mode not in force (mode_shadow_plans); the plan learner derives shadow setups from it
// (plan_setups.source = 'shadow', control arm only); only the mode selector reads them, as live ∪ shadow of the rule in
// force; a switch to a mode with too few live setups is a probation (half the risk on Omega's new orders) that fails back
// to the baseline or passes. MODE_SHADOW_EVIDENCE and MODE_PROBATION "off" are today's behaviour byte for byte.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as de from "../src/decision-engine.mjs";
import * as pl from "../src/plan-learning.mjs";
import * as ms from "../src/mode-selector.mjs";
import * as au from "../src/ai-usage.mjs";
import * as rt from "../src/room-tuning.mjs";
import { modeShadowEvidence, modeProbationMode, ruleVersionOf, MODE_PROBATION_RULES, ensureModeShadowSchema } from "../src/mode-shadow.mjs";
import { planIntents } from "../src/omega-engine.mjs";
import { modeNow } from "../src/lens-steps.mjs";
import { runGridAdapt, readGridChoices } from "../src/grid-adapt.mjs";
import { runStrategyCouncil, resetCouncilSchemaForTests, COUNCIL_KEY } from "../src/strategy-council.mjs";
import { buildEvidencePack } from "../src/cfc-pack.mjs";
import { readTriggerInputs } from "../src/cfc-triggers.mjs";
import { runKnobProposals } from "../src/council-knob-tuning.mjs";
import { computeRecommendations } from "../src/strategy-recommendation.mjs";
import { handInputs } from "./fixtures/omega-market-path.mjs";
import { resetLedgerSchemaCacheForTests } from "../src/signal-ledger.mjs";
import { resetStrategyArmSchemaCacheForTests } from "../src/strategy-arm.mjs";
import { resetSessionSchemaForTests } from "../src/cfc-session.mjs";
import { d1, kv, failingAi, ENV_BASE, loaded, CLOSE, NOW, risingBars, offScenario, insertSetup } from "./fixtures/mode-shadow.mjs";

const { assess, shadowModeDecisions, runDecisionEngine, TRADING_MODE_KEY } = de;
const { runPlanLearning, PLAN_ARMS, CONTROL_ARM, PLAN_LEARNING_KEY, ensurePlanLearningSchema } = pl;
const { runModeSelector, ownerModeAction, modeStatus, modeEvidenceStatus, unionSetups, rangeShadowEvidence, probationStep, liveRecordOf, modeProbationRisk, modeReport, MODE_CONTROL_KEY } = ms;
const M1 = 60_000, M15 = 15 * M1, HOUR = 60 * M1, DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const sha = (x) => createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex");
const reset = () => { de.resetDecisionSchemaCacheForTests(); pl.resetPlanLearningSchemaCacheForTests(); ms.resetModeSchemaForTests(); au.resetAiUsageSchemaCacheForTests(); rt.resetRoomTuningCacheForTests(); resetCouncilSchemaForTests(); resetLedgerSchemaCacheForTests(); resetStrategyArmSchemaCacheForTests(); resetSessionSchemaForTests(); };
const decisionEnv = async (over = {}, mode = "intraday") => { reset(); const env = { DB: d1(), SIGNAL_CACHE: kv(), AI: failingAi, ...ENV_BASE, ...over }; await env.SIGNAL_CACHE.put(TRADING_MODE_KEY, mode); return env; };
const decideBar = (env, l = loaded()) => runDecisionEngine(env, { barClose: CLOSE, now: NOW, clock: () => NOW + 5_000, loaded: l });
const shadowRows = (env) => { try { return env.DB.raw.prepare("SELECT * FROM mode_shadow_plans ORDER BY mode").all(); } catch { return []; } };
const pure = (live, { l = loaded(), council = null, over = {} } = {}) => {
  const env = { ...ENV_BASE, TRADING_MODE: live, ...over };
  const assessment = assess(l, { now: NOW, env });
  return { assessment, out: shadowModeDecisions({ loaded: l, assessment, council, env, now: NOW }) };
};
const answer = (stance, confidence = 0.7, extra = {}) => ({ answer: { stance, bias: "BULLISH", confidence, entry_type: "limit", target: "tp1", summary: `Decision ${stance}, bias bullish: test.`, reasons: ["test"], risks: [], weighed: [], ...extra } });

test("MSH-1 the switches (on by default, \"off\" by value) and the rule version the target rule writes", () => {
  assert.deepEqual([modeShadowEvidence({}), modeShadowEvidence({ MODE_SHADOW_EVIDENCE: " OFF " }), modeShadowEvidence({ MODE_SHADOW_EVIDENCE: "on" })], ["on", "off", "on"]);
  assert.deepEqual([modeProbationMode({}), modeProbationMode({ MODE_PROBATION: "off" })], ["on", "off"]);
  assert.deepEqual([ruleVersionOf({}), ruleVersionOf({ TP1_KEY_ZONE_MODE: "off" })], ["tp1_kz:on", "tp1_kz:off"]);
  assert.deepEqual({ ...MODE_PROBATION_RULES }, { min_live_setups: 31, fail_setups: 15, risk_scale: 0.5 });
});

test("MSH-2 a decision under intraday writes shadow plans for the modes that would trade (scalp, range), none for swing (vetoed); none at all on a WAIT; the live record is the same", async () => {
  const env = await decisionEnv();
  const out = await decideBar(env);
  assert.deepEqual([out.status, out.stance], ["decided", "BUY"]);
  const rows = shadowRows(env);
  assert.deepEqual(rows.map((r) => [r.mode, r.side, r.agent, r.rule_version, r.regime, r.atr_h1]), [["range", "BUY", "range_fade", "tp1_kz:on", "normal-ranging", 10], ["scalp", "BUY", "zone_pullback", "tp1_kz:on", "normal-ranging", 10]]);
  assert.ok(rows.every((r) => r.decision_key === "OANDA:XAUUSD:15:1794229200000" && r.bar_close === CLOSE && r.decided_at === iso(NOW + 5_000)));
  const scalp = JSON.parse(rows.find((r) => r.mode === "scalp").plans_json);
  assert.deepEqual(Object.keys(scalp.long).sort(), ["range_fade", "zone_pullback"], "every agent's plan on the decided side, as the live record keeps them");
  assert.deepEqual(scalp.trade, { entry: 4000, stop: 3993, tp: 4030, action: "ENTER_LIMIT", at_level: true });
  // The live record does not change with the shadow pass: the same decision with shadow evidence off.
  const off = await decisionEnv({ MODE_SHADOW_EVIDENCE: "off" });
  await decideBar(off);
  const rec = (e) => e.DB.raw.prepare("SELECT decision_key, bar_close, decided_at, stance, confidence, source, decision_json FROM engine_decisions").all();
  assert.deepEqual(rec(off), rec(env));
  assert.equal(shadowRows(off).length, 0, "off: no table, no row");
  // A WAIT bar (the strategy engine waits and the council fails): no mode would trade.
  const wait = await decisionEnv();
  assert.equal((await decideBar(wait, loaded({ decision: "WAIT" }))).stance, "WAIT");
  assert.deepEqual(shadowRows(wait), []);
  // The pure pass names every mode that is not in force and why one waits.
  const { out: sh } = pure("intraday");
  assert.deepEqual(sh.map((x) => [x.mode, x.stance, x.reason]), [["scalp", "BUY", null], ["swing", "WAIT", "no_veto"], ["range", "BUY", null]]);
});

test("MSH-3 range only from the range strategies, and only while the 1H regime ranges", () => {
  const { out } = pure("intraday");
  const range = out.find((x) => x.mode === "range");
  assert.deepEqual([range.stance, range.agent, Object.keys(range.plans)], ["BUY", "range_fade", ["range_fade"]], "the default agent's plan is not offered in range");
  // Trending: no range pass at all.
  const trending = pure("intraday", { l: loaded({ regime: "normal-trending" }) }).out.find((x) => x.mode === "range");
  assert.deepEqual([trending.stance, trending.reason, trending.plans], ["WAIT", "range_breakout", null]);
  // No range strategy sees its setup (range_fade not live, so it does not speak): range waits; scalp still trades.
  const none = pure("intraday", { over: { STRATEGY_AGENTS_LIVE: "" } }).out;
  assert.deepEqual(none.map((x) => [x.mode, x.stance]), [["scalp", "BUY"], ["swing", "WAIT"], ["range", "WAIT"]]);
  // With the strategy agents' execution and TP1-KZ off the guardrail's own plan (the default agent's) would trade: range
  // turns it into WAIT. With TP1-KZ on that plan is not offered at all (no default agent's plan in range): WAIT too.
  const noExec = pure("intraday", { over: { STRATEGY_EXECUTION: "off", STRATEGY_AGENTS_LIVE: "", TP1_KEY_ZONE_MODE: "off" } }).out.find((x) => x.mode === "range");
  assert.deepEqual([noExec.stance, noExec.reason], ["WAIT", "range_mode_agent"]);
  assert.deepEqual(pure("intraday", { over: { STRATEGY_EXECUTION: "off", STRATEGY_AGENTS_LIVE: "" } }).out.find((x) => x.mode === "range").stance, "WAIT");
  // From range itself: the other modes are shadowed, range is not.
  assert.deepEqual(pure("range").out.map((x) => x.mode), ["scalp", "intraday", "swing"]);
});

test("MSH-4 the shadow stance follows the live council: its BUY or SELL, its WAIT where the live gates were open, its confidence", () => {
  // Live swing vetoes the long (bearish news); the council waits. Scalp and intraday open the long: they trade it.
  const swing = pure("swing", { council: answer("WAIT", 0.7) });
  assert.equal(swing.assessment.guards.long.allowed, false);
  assert.deepEqual(swing.out.map((x) => [x.mode, x.stance]), [["scalp", "BUY"], ["intraday", "BUY"], ["range", "BUY"]]);
  // Live intraday had the long open and the council chose to wait: its judgement stands in every mode.
  const intraday = pure("intraday", { council: answer("WAIT", 0.7) });
  assert.equal(intraday.assessment.guards.long.allowed, true);
  assert.deepEqual(intraday.out.map((x) => x.stance), ["WAIT", "WAIT", "WAIT"]);
  // The council's BUY under a confidence the floor refuses is WAIT in every mode; above it, the modes' own gates decide.
  assert.deepEqual(pure("intraday", { council: answer("BUY", 0.3) }).out.map((x) => [x.stance, x.reason]), [["WAIT", "confidence"], ["WAIT", "no_veto"], ["WAIT", "confidence"]]);
  assert.deepEqual(pure("intraday", { council: answer("BUY", 0.7) }).out.map((x) => x.stance), ["BUY", "WAIT", "BUY"]);
  // The council's SELL: no mode has a short here.
  assert.ok(pure("intraday", { council: answer("SELL", 0.7) }).out.every((x) => x.stance === "WAIT"));
});

test("MSH-5 the plan learner derives shadow setups (their own keys, source, rule version, the control arm only); the learned state is the live setups'", async () => {
  const env = await decisionEnv();
  await decideBar(env);
  const later = Date.parse(CLOSE) + 3 * HOUR;
  const run = await runPlanLearning(env, { now: later, bars: risingBars(Date.parse(CLOSE)) });
  assert.deepEqual([run.status, run.added, run.resolved, run.shadow], ["ok", 2, 2, { added: 3, extended: 0, resolved: 3, unavailable: 0 }]);
  const rows = env.DB.raw.prepare("SELECT setup_key, mode, agent, source, rule_version, status, results_json FROM plan_setups ORDER BY setup_key").all();
  const shadow = rows.filter((r) => r.source === "shadow");
  assert.deepEqual(shadow.map((r) => [r.setup_key, r.mode, r.agent]), [
    ["shadow:range:OANDA:XAUUSD:15:1794229200000:BUY:range_fade", "range", "range_fade"],
    ["shadow:scalp:OANDA:XAUUSD:15:1794229200000:BUY", "scalp", "zone_pullback"],
    ["shadow:scalp:OANDA:XAUUSD:15:1794229200000:BUY:range_fade", "scalp", "range_fade"]
  ]);
  assert.ok(shadow.every((r) => r.rule_version === "tp1_kz:on" && r.status === "resolved" && Object.keys(JSON.parse(r.results_json)).join() === CONTROL_ARM), "the control arm only");
  assert.ok(rows.filter((r) => r.source === "live").every((r) => r.rule_version === "tp1_kz:on" && Object.keys(JSON.parse(r.results_json)).length === PLAN_ARMS.length), "live: every arm, the rule in force");
  const state = JSON.parse(await env.SIGNAL_CACHE.get(PLAN_LEARNING_KEY));
  assert.equal(state.setups.resolved, 2, "the state counts live setups only");
  assert.deepEqual(state.agents.map((a) => [a.agent, a.setups]), [["range_fade", 1], ["zone_pullback", 1]]);
  // Nothing twice; and with the switch off nothing shadow is derived (a fresh run on the same plans).
  assert.equal((await runPlanLearning(env, { now: later + 5 * M1, bars: risingBars(Date.parse(CLOSE)) })).status, "unchanged");
  const e2 = await decisionEnv();
  await decideBar(e2);
  const off = await runPlanLearning({ ...e2, MODE_SHADOW_EVIDENCE: "off" }, { now: later, bars: risingBars(Date.parse(CLOSE)) });
  assert.equal(off.shadow, undefined);
  assert.equal(e2.DB.raw.prepare("SELECT COUNT(*) AS n FROM plan_setups WHERE source = 'shadow'").get().n, 0);
  assert.equal(shadowRows(e2).length, 2, "the shadow plans stay stored; off only stops their use");
});

// ---------------------------------------------------------------- every other reader filters source = 'live'

/** A recording sqlite D1; `neutral` turns the live filter into 1 = 1 (to prove the filter is what keeps shadow out). */
function rdb({ neutral = false } = {}) {
  const base = d1(), reads = [];
  const fix = (sql) => (neutral ? sql.replaceAll("source = 'live'", "1 = 1") : sql);
  const isRead = (sql) => /^\s*SELECT/i.test(sql) && /FROM plan_setups/.test(sql);
  const wrap = (sql, params = []) => ({
    bind: (...a) => wrap(sql, a.map((v) => (v === undefined ? null : v))),
    run: () => base.prepare(fix(sql)).bind(...params).run(),
    first: async () => { const r = await base.prepare(fix(sql)).bind(...params).first(); if (isRead(sql)) reads.push({ sql, rows: r ? [r] : [] }); return r; },
    all: async () => { const r = await base.prepare(fix(sql)).bind(...params).all(); if (isRead(sql)) reads.push({ sql, rows: r.results }); return r; }
  });
  return { prepare: (sql) => wrap(sql), batch: async (sts) => { for (const s of sts) await s.run(); }, raw: base.raw, reads };
}
const RNOW = Date.parse("2026-11-20T12:00:00Z");
const allArms = (control, best, marker) => Object.fromEntries([...PLAN_ARMS.map((a) => [a.id, { s: "target", r: a.id === CONTROL_ARM ? control : a.id === "e0@s0.5" ? best : control - 0.05, f: 1 }]), ...(marker ? [["marker", "shadow"]] : [])]);
/** 12 live setups (zone_pullback, intraday) and, with `shadow`, 120 strong shadow setups on the same bars (zone_pullback and range_fade, scalp). */
async function seedReaders(db, { shadow }) {
  await ensurePlanLearningSchema(db);
  await de.ensureDecisionSchema(db);
  const ins = db.raw.prepare("INSERT INTO plan_setups (setup_key, decision_key, agent, pattern, opened_at, decided_at, last_seen_at, decisions, side, entry, stop, tp1, atr_h1, mode, action, at_level, regime, context, status, resolved_at, results_json, version, updated_at, htf, source, rule_version) VALUES (?, ?, ?, NULL, ?, ?, ?, 1, ?, 4000, ?, ?, 10, ?, 'ENTER_LIMIT', 1, ?, ?, 'resolved', ?, ?, 'cryptophys.plan-learning.v2', ?, ?, ?, 'tp1_kz:on')");
  for (let i = 0; i < 60; i++) {
    const at = RNOW - 20 * DAY + i * 4 * HOUR, key = `OANDA:XAUUSD:15:${at - M15}`;
    if (i < 12) {
      ins.run(`${key}:BUY`, key, "zone_pullback", iso(at), iso(at), iso(at), "BUY", 3990, 4015, "intraday", "normal-trending", "intraday|normal-trending", iso(at + HOUR), JSON.stringify(allArms(0.1, 0.1)), iso(at + HOUR), null, "live");
      db.raw.prepare("INSERT OR IGNORE INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, 'BUY', 0.6, 'council', ?)").run(key, iso(at), iso(at), JSON.stringify({ stance: "BUY", trade: { side: "BUY", entry: 4000, stop: 3990, tp: 4015 }, trading_mode: "intraday", rules: { quorum_min: 0.5, min_rrr: 1.5 }, quorum: { long_share: 0.6, short_share: 0.2 } }));
    }
    if (!shadow) continue;
    ins.run(`shadow:scalp:${key}:BUY`, key, "zone_pullback", iso(at), iso(at), iso(at), "BUY", 3990, 4015, "scalp", "low-ranging", "scalp|low-ranging", iso(at + HOUR), JSON.stringify(allArms(0.6, 1.2, true)), iso(at + HOUR), null, "shadow");
    ins.run(`shadow:range:${key}:SELL:range_fade`, key, "range_fade", iso(at), iso(at), iso(at), "SELL", 4010, 3985, "range", "low-ranging", "range|low-ranging", iso(at + HOUR), JSON.stringify(allArms(0.6, 1.2, true)), iso(at + HOUR), "with", "shadow");
  }
}
/** The reader's output on live setups alone, on live + shadow, and on live + shadow without the filter. */
async function readerCase(run, { checked = () => true } = {}) {
  const outs = [];
  for (const [shadow, neutral] of [[false, false], [true, false], [true, true]]) {
    reset();
    const db = rdb({ neutral });
    await seedReaders(db, { shadow });
    const env = { DB: db, SIGNAL_CACHE: kv(), GRID_ADAPT_MODE: "live", STRATEGY_AGENTS_LIVE: "range_fade" };
    outs.push({ out: await run(env), reads: db.reads });
  }
  const [live, both, unfiltered] = outs;
  assert.ok(both.reads.length > 0, "the reader read plan_setups");
  const reads = both.reads.filter((r) => checked(r.sql));
  assert.ok(reads.length > 0, "the reader's evidence reads");
  for (const r of reads) assert.match(r.sql, /source = 'live'/, r.sql);
  for (const r of reads) assert.doesNotMatch(JSON.stringify(r.rows), /marker|shadow:/, r.sql);
  assert.deepEqual(both.out, live.out, "shadow rows change nothing");
  return { live: live.out, unfiltered: unfiltered.out };
}

test("MSH-6a grid-adapt reads live setups only", async () => {
  const { live, unfiltered } = await readerCase(async (env) => ({ run: await runGridAdapt(env, { now: RNOW, force: true }), doc: await readGridChoices(env) }));
  assert.equal(live.run.status, "computed");
  assert.notDeepEqual(unfiltered, live, "without the filter the shadow slices would be adopted");
});

test("MSH-6b the plan learner's own reads (learner, referee, agents' records, range cells, counts) are live only", async () => {
  const { live, unfiltered } = await readerCase(async (env) => {
    const out = await runPlanLearning(env, { now: RNOW, bars: [] });
    const st = JSON.parse(await env.SIGNAL_CACHE.get(PLAN_LEARNING_KEY));
    return { status: out.status, setups: st.setups, learned: st.learned, walk_forward: st.walk_forward, agents: st.agents, cells: st.cells };
  // The learner's own reads (the state's rows and counts, the first-run check); the write path's reads (the keys already
  // stored, the replay queues, the HTF tagging) see every row by design.
  }, { checked: (sql) => /status = 'resolved'|MIN\(opened_at\)|LIMIT 1/.test(sql) });
  assert.deepEqual([live.setups.resolved, live.agents.map((a) => a.agent), live.cells], [12, ["zone_pullback"], []]);
  assert.notDeepEqual(unfiltered.cells, live.cells, "without the filter the shadow range setups would pass a cell");
});

test("MSH-6c the strategy council's walk-forward reads live setups only", async () => {
  const call = async () => ({ status: "answered", obj: { proposal: "keep", reason: "keep" } });
  const { live, unfiltered } = await readerCase(async (env) => { await runStrategyCouncil(env, { now: RNOW, call, force: true }); return JSON.parse(await env.SIGNAL_CACHE.get(COUNCIL_KEY)).verdicts; });
  assert.deepEqual(Object.keys(live), ["zone_pullback"]);
  assert.notDeepEqual(unfiltered, live);
});

test("MSH-6d the CFC evidence pack reads live setups only", async () => {
  const { live, unfiltered } = await readerCase(async (env) => { const p = await buildEvidencePack(env, "strategy:zone_pullback", { now: RNOW }); return p.sections?.setups ?? p; });
  assert.notDeepEqual(unfiltered, live);
});

test("MSH-6e the CFC triggers read live setups only", async () => {
  const { live, unfiltered } = await readerCase(async (env) => (await readTriggerInputs(env, { now: RNOW })).strategy.setups);
  assert.equal(live.length, 12);
  assert.notDeepEqual(unfiltered, live);
});

test("MSH-6f the council knob tuning reads live setups only (a shadow setup on the same bar and side never replaces the live one)", async () => {
  const { live } = await readerCase(async (env) => runKnobProposals(env, { now: RNOW, force: true, publish: async () => ({ outcome: "disabled" }) }));
  assert.notEqual(live.status, "failed", JSON.stringify(live));
});

test("MSH-6g the strategy recommendation cards read live setups only", async () => {
  const { live, unfiltered } = await readerCase(async (env) => { await computeRecommendations(env, { now: RNOW, force: true }); const d = JSON.parse(await env.SIGNAL_CACHE.get("strategy-recommendations:v1") ?? "null") ?? JSON.parse([...env.SIGNAL_CACHE.m.values()].find((v) => String(v).includes("strategy-recommendations")) ?? "null"); return { context: d?.context, cards: d?.cards?.map((c) => ({ id: c.id, record: c.record ?? null, r: c.r_distribution ?? c.rDist ?? null })) }; });
  assert.equal(live.context, "intraday|normal-trending");
  assert.notDeepEqual(unfiltered, live);
});

// ---------------------------------------------------------------- the selector: live ∪ shadow, the rule in force

const T = Date.parse("2026-11-18T12:00:00Z");
function selEnv(over = {}) {
  reset();
  const env = { DB: d1(), SIGNAL_CACHE: kv(), ...over };
  return env;
}
async function seedSel(env, list) {
  await ensurePlanLearningSchema(env.DB);
  let i = 0;
  for (const s of list) {
    const k = i++;
    const opened = s.openedMs ?? T - 10 * DAY + k * M1;
    insertSetup(env.DB, { key: s.key ?? `${s.source ?? "live"}:${s.mode}:${String(k).padStart(4, "0")}`, mode: s.mode, r: s.r, openedMs: opened, agent: s.agent ?? "zone_pullback", side: s.side ?? "BUY", regime: s.regime ?? "trend" });
    env.DB.raw.prepare("UPDATE plan_setups SET source = ?, rule_version = ?, decision_key = COALESCE(?, decision_key), htf = ? WHERE setup_key = ?").run(s.source ?? "live", s.rv === undefined ? "tp1_kz:on" : s.rv, s.decision_key ?? null, s.htf ?? null, s.key ?? `${s.source ?? "live"}:${s.mode}:${String(k).padStart(4, "0")}`);
  }
}
const many = (n, o) => Array.from({ length: n }, (_, i) => ({ ...o, r: o.r + (i % 2 ? 0.05 : -0.05) }));
const seats = (verdict) => async () => ({ status: "answered", obj: { verdict, reason: `${verdict} on the evidence` } });
const collect = () => { const events = [], lines = []; return { events, lines, log: async (action, detail) => { events.push({ action, detail }); }, notify: async (t) => { lines.push(t); } }; };

test("MSH-7 the rule_version cut: only setups of the rule in force count (older or unknown ones do not)", async () => {
  const s = [
    ...many(40, { mode: "swing", r: 0.4, rv: "tp1_kz:off" }),
    ...many(40, { mode: "intraday", r: 0.4, rv: null })
  ];
  const u = unionSetups(s.map((x) => ({ ...x, source: "live", rule_version: x.rv, decision_key: "k", agent: "a" })), { ruleVersion: "tp1_kz:on" });
  assert.equal(u.length, 0);
  const e = selEnv();
  await e.SIGNAL_CACHE.put(TRADING_MODE_KEY, "intraday");
  await seedSel(e, s);
  const r = await runModeSelector(e, { now: T, regime: "trend", call: seats("approve") });
  assert.deepEqual([r.evidence.evidence.swing.n, r.evidence.evidence.intraday.n, r.decision.reason], [0, 0, "evidence_collecting"]);
  // With TP1-KZ off the "tp1_kz:off" setups are the rule in force; the unknown ones never count.
  const e2 = selEnv({ TP1_KEY_ZONE_MODE: "off" });
  await e2.SIGNAL_CACHE.put(TRADING_MODE_KEY, "intraday");
  await seedSel(e2, s);
  const r2 = await runModeSelector(e2, { now: T, regime: "trend", call: seats("approve") });
  assert.deepEqual([r2.evidence.evidence.swing.n, r2.evidence.evidence.swing.status, r2.evidence.evidence.intraday.n], [40, "pass", 0]);
  // Off: no cut, as before MS2 (the stored rows count whatever their rule).
  const e3 = selEnv({ MODE_SHADOW_EVIDENCE: "off" });
  await e3.SIGNAL_CACHE.put(TRADING_MODE_KEY, "intraday");
  await seedSel(e3, s);
  assert.deepEqual((await runModeSelector(e3, { now: T, regime: "trend", call: seats("approve") })).evidence.evidence.swing.n, 40);
});

test("MSH-8 a switch on shadow evidence through the council: swing has only shadow setups; live wins a duplicate; the split is recorded; the switch is a probation", async () => {
  const e = selEnv();
  await e.SIGNAL_CACHE.put(TRADING_MODE_KEY, "intraday");
  await seedSel(e, [...many(40, { mode: "intraday", r: 0.05 }), ...many(40, { mode: "swing", r: 0.4, source: "shadow" })]);
  // A shadow duplicate of a live setup (same mode, bar and agent) is dropped; a live one stays.
  const dup = unionSetups([{ mode: "swing", decision_key: "k1", agent: "a", source: "live", rule_version: "v", r: 1 }, { mode: "swing", decision_key: "k1", agent: "a", source: "shadow", rule_version: "v", r: -1 }, { mode: "swing", decision_key: "k2", agent: "a", source: "shadow", rule_version: "v", r: 2 }], { ruleVersion: "v" });
  assert.deepEqual(dup.map((x) => [x.decision_key, x.source]), [["k1", "live"], ["k2", "shadow"]]);
  const c = collect();
  const run = (now, verdict) => runModeSelector(e, { now, regime: "trend", call: seats(verdict), log: c.log, notify: c.notify });
  const r1 = await run(T, "approve");
  assert.deepEqual([r1.decision.reason, r1.evidence.evidence.swing.n_live, r1.evidence.evidence.swing.n_shadow, r1.evidence.evidence.swing.status], ["candidate_holding", 0, 40, "pass"]);
  const r2 = await run(T + DAY, "approve");
  assert.deepEqual([r2.status, r2.applied.to, r2.applied.actor], ["changed", "swing", "council"]);
  assert.equal(await e.SIGNAL_CACHE.get(TRADING_MODE_KEY), "swing");
  const run1 = c.events.find((x) => x.action === "mode_selector_run").detail;
  assert.deepEqual(run1.evidence.swing, { n: 40, mean_r: 0.4, status: "pass", scope: "regime", n_live: 0, n_shadow: 40 });
  // 0 live swing setups: a probation, in the control (KV), the change row's evidence and the Telegram line.
  const ctl = JSON.parse(await e.SIGNAL_CACHE.get(MODE_CONTROL_KEY));
  assert.deepEqual([ctl.probation.mode, ctl.probation.from, ctl.probation.baseline, ctl.probation.started_ms, ctl.probation.live_setups, ctl.probation.risk_scale], ["swing", "intraday", "intraday", T + DAY, 0, 0.5]);
  const row = e.DB.raw.prepare("SELECT * FROM omega_mode_changes ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual(JSON.parse(row.evidence).probation, { started: true, live_setups: 0, risk_scale: 0.5 });
  assert.match(c.lines.at(-1), /Trading mode Intraday → Swing \(council.*On probation: half the risk on new orders until it has 31 live setups and a walk-forward pass\./s);
  assert.equal((await modeStatus(e)).probation.mode, "swing");
  // The status route's view: per mode and regime, live against shadow, and the probation.
  const st = await modeEvidenceStatus(e, { now: T + DAY });
  assert.deepEqual([st.shadow_evidence, st.probation_mode, st.rule_version], ["on", "on", "tp1_kz:on"]);
  assert.deepEqual(st.modes.swing.regimes.trend, { n: 40, mean_r: 0.4, live: { n: 0, mean_r: null }, shadow: { n: 40, mean_r: 0.4 } });
  assert.deepEqual(st.modes.intraday.live, { n: 40, mean_r: 0.05 });
  assert.deepEqual([st.probation.mode, st.probation.n, st.probation.since_n, st.probation.rules.fail_setups], ["swing", 0, 0, 15]);
  assert.doesNotMatch(JSON.stringify(st), /price|lot|entry|stop"/);
});

/** A selector on swing under probation since `started` (baseline intraday), with these setups. */
async function onProbation(list, { started = T - 5 * DAY } = {}) {
  const e = selEnv();
  await e.SIGNAL_CACHE.put(TRADING_MODE_KEY, "swing");
  await e.SIGNAL_CACHE.put(MODE_CONTROL_KEY, JSON.stringify({ auto: true, pinned: false, baseline: "intraday", last_switch: { from: "intraday", to: "swing", actor: "council", reason: "evidence", at_ms: started, id: 1 }, probation: { mode: "swing", from: "intraday", baseline: "intraday", started_ms: started, live_setups: 0, risk_scale: 0.5, change_id: 1 } }));
  await seedSel(e, list);
  return e;
}
const since = (n, r, started = T - 5 * DAY) => Array.from({ length: n }, (_, i) => ({ mode: "swing", r, openedMs: started + (i + 1) * HOUR }));

test("MSH-9 probation: back to the baseline at 15 live setups with a mean under 0R (probation_failed, one change row, one line, the event, mode.v1); 14 hold", async () => {
  // 100 good shadow setups keep the walk-forward from failing, so the live record alone decides.
  const shadowGood = many(100, { mode: "swing", r: 0.5, source: "shadow", openedMs: T - 20 * DAY });
  const hold = await onProbation([...shadowGood.map((x, i) => ({ ...x, openedMs: T - 20 * DAY + i * M1 })), ...since(14, -0.3)]);
  const h = await runModeSelector(hold, { now: T, regime: "trend", call: seats("reject") });
  assert.equal(h.probation.step, "hold");
  assert.equal(await hold.SIGNAL_CACHE.get(TRADING_MODE_KEY), "swing");
  const e = await onProbation([...shadowGood.map((x, i) => ({ ...x, openedMs: T - 20 * DAY + i * M1 })), ...since(15, -0.3)]);
  const c = collect();
  const r = await runModeSelector(e, { now: T, regime: "trend", call: async () => { throw new Error("no council on a fail-safe move"); }, log: c.log, notify: c.notify });
  assert.deepEqual([r.status, r.applied.to, r.applied.reason, r.applied.actor, r.probation.step, r.probation.reason], ["changed", "intraday", "probation_failed", "selector", "fail", "live_mean_below_zero"]);
  assert.equal(await e.SIGNAL_CACHE.get(TRADING_MODE_KEY), "intraday");
  const rows = e.DB.raw.prepare("SELECT * FROM omega_mode_changes").all();
  assert.deepEqual(rows.map((x) => [x.from_mode, x.to_mode, x.actor, x.reason]), [["swing", "intraday", "selector", "probation_failed"]]);
  assert.deepEqual([c.lines.length, c.lines[0]], [1, "XAUUSD SYSTEM · Trading mode Swing → Intraday (selector, its probation failed: back to the baseline). New orders only; open positions keep theirs."]);
  assert.deepEqual(c.events.filter((x) => x.action === "mode_changed").map((x) => x.detail.reason), ["probation_failed"]);
  assert.equal(modeReport(rows).body.items[0].reason, "probation_failed");
  const ctl = JSON.parse(await e.SIGNAL_CACHE.get(MODE_CONTROL_KEY));
  assert.deepEqual([ctl.probation, ctl.baseline, ctl.last_switch.reason], [undefined, "intraday", "probation_failed"]);
});

test("MSH-10 probation: back to the baseline when its walk-forward fails", async () => {
  const e = await onProbation([...many(30, { mode: "swing", r: -0.2, source: "shadow", openedMs: T - 20 * DAY }).map((x, i) => ({ ...x, openedMs: T - 20 * DAY + i * M1 })), ...since(5, 0.2)]);
  const r = await runModeSelector(e, { now: T, regime: "trend", call: seats("approve") });
  assert.equal(r.evidence.evidence.swing.status, "fail");
  assert.deepEqual([r.applied.to, r.applied.reason, r.probation.reason], ["intraday", "probation_failed", "walk_forward_fail"]);
  // The step is pure.
  assert.deepEqual(probationStep({ probation: null }), { action: "none" });
  assert.equal(probationStep({ probation: { mode: "swing" }, mode: "intraday" }).action, "clear");
});

test("MSH-11 probation: it passes (cleared, full risk) at 31 live setups and a walk-forward pass; 30 hold", async () => {
  const held = await onProbation(since(30, 0.4));
  assert.equal((await runModeSelector(held, { now: T, regime: "trend", call: seats("reject") })).probation.step, "hold");
  const e = await onProbation(since(31, 0.4));
  const c = collect();
  const r = await runModeSelector(e, { now: T, regime: "trend", call: seats("reject"), log: c.log, notify: c.notify });
  assert.deepEqual([r.status, r.probation.step, r.probation.live_setups, r.evidence.evidence.swing.status], ["unchanged", "pass", 31, "pass"]);
  assert.equal(JSON.parse(await e.SIGNAL_CACHE.get(MODE_CONTROL_KEY)).probation, undefined);
  assert.equal(await e.SIGNAL_CACHE.get(TRADING_MODE_KEY), "swing");
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM omega_mode_changes").get().n, 0, "not a mode change");
  assert.deepEqual(c.lines, ["XAUUSD SYSTEM · Trading mode Swing: probation passed (31 live setups, walk-forward pass). Full risk on new orders."]);
  assert.deepEqual(c.events.filter((x) => x.action === "mode_probation_passed").length, 1);
  assert.equal(await modeProbationRisk(e, { trading_mode: "swing" }), null);
  // The live record: the mode's own live setups, overall and since a time.
  assert.deepEqual(liveRecordOf([{ mode: "swing", r: 1, opened_ms: 5 }, { mode: "swing", r: -1, opened_ms: 10 }, { mode: "swing", r: 3, source: "shadow", opened_ms: 10 }], "swing", { sinceMs: 10 }), { n: 2, since_n: 1, since_mean_r: -1 });
});

test("MSH-12 the probation's risk: 0.5 of the risk on Omega's new orders of the probation's mode, never over the profile cap, never an open position", async () => {
  const e = await onProbation([]);
  assert.deepEqual(await modeProbationRisk(e, { trading_mode: "swing" }), { mode: "swing", scale: 0.5 });
  assert.equal(await modeProbationRisk(e, { trading_mode: "intraday" }), null, "another mode's signal");
  assert.equal(await modeProbationRisk({ ...e, MODE_PROBATION: "off" }, { trading_mode: "swing" }), null, "off: no scale");
  const cases = Object.fromEntries(handInputs());
  const open = (input, modeRisk) => planIntents({ ...input, signal: { ...input.signal, trading_mode: "swing" }, ...(modeRisk ? { modeRisk } : {}) }).intents.find((it) => it.kind === "open");
  const probation = { mode: "swing", scale: 0.5 };
  const full = open(cases.open), half = open(cases.open, probation);
  assert.ok(full.volume > 0);
  assert.equal(half.volume, Math.floor(full.volume * 0.5 * 100) / 100);
  assert.deepEqual([half.mode_probation, full.mode_probation], [0.5, undefined]);
  assert.deepEqual(open(cases.open, { mode: "intraday", scale: 0.5 }), full, "a signal of another mode: full risk");
  // Within the profile cap: a small Safe account where only the minimum lot fits stays within the cap, and one where
  // the minimum lot risks more than the cap opens nothing, with or without the scale (the cap itself is not scaled).
  const small = (equity) => ({ ...cases.open, account: { spec_status: "validated", profile: "safe" }, executor: { ...cases.open.executor, account: { ...cases.open.executor.account, balance: equity, equity, day_start_balance: equity } } });
  // A 5-point stop: 0.01 lot risks $5. At $2,000 Safe's risk (0.5%) sizes 0.02 lot, the probation 0.01; at $400 only the minimum
  // lot fits (1.25%, within the 2% cap) with or without the scale; at $200 it would risk 2.5%: nothing, either way.
  assert.deepEqual([open(small(2000)).volume, open(small(2000), probation).volume], [0.02, 0.01]);
  assert.deepEqual([open(small(400)).volume, open(small(400), probation).volume], [0.01, 0.01]);
  assert.deepEqual([open(small(200)), open(small(200), probation)], [undefined, undefined]);
  // An open position is never touched: every intent but the new entry is the same.
  for (const [name, input] of handInputs()) {
    const a = planIntents({ ...input, signal: input.signal ? { ...input.signal, trading_mode: "swing" } : input.signal });
    const b = planIntents({ ...input, signal: input.signal ? { ...input.signal, trading_mode: "swing" } : input.signal, modeRisk: probation });
    const strip = (p) => p.intents.filter((it) => it.kind !== "open" && it.kind !== "place_limit");
    assert.deepEqual(strip(b), strip(a), name);
  }
});

test("MSH-13 the owner's veto, pin and Auto are unchanged and clear the probation", async () => {
  const e = selEnv();
  await e.SIGNAL_CACHE.put(TRADING_MODE_KEY, "intraday");
  await seedSel(e, [...many(40, { mode: "intraday", r: 0.05 }), ...many(40, { mode: "swing", r: 0.4, source: "shadow" })]);
  await runModeSelector(e, { now: T, regime: "trend", call: seats("approve") });
  await runModeSelector(e, { now: T + DAY, regime: "trend", call: seats("approve") });
  assert.equal(JSON.parse(await e.SIGNAL_CACHE.get(MODE_CONTROL_KEY)).probation.mode, "swing");
  const auto = await ownerModeAction(e, { action: "auto", actor: "owner@example.com", now: T + DAY + 1 });
  assert.equal(auto.ok, true);
  assert.equal(JSON.parse(await e.SIGNAL_CACHE.get(MODE_CONTROL_KEY)).probation.mode, "swing", "Auto keeps the mode and its probation");
  const v = await ownerModeAction(e, { action: "veto", actor: "owner@example.com", now: T + DAY + 60_000 });
  assert.deepEqual([v.ok, v.mode, v.pinned], [true, "intraday", true]);
  const ctl = JSON.parse(await e.SIGNAL_CACHE.get(MODE_CONTROL_KEY));
  assert.deepEqual([ctl.probation, ctl.baseline, ctl.pinned], [undefined, "intraday", true]);
  assert.equal((await modeStatus(e)).probation, null);
  assert.equal(await modeProbationRisk(e, { trading_mode: "swing" }), null);
  // The owner's pin of a mode is the owner's choice: no probation.
  await ownerModeAction(e, { mode: "scalp", actor: "owner@example.com", now: T + 2 * DAY });
  assert.equal(JSON.parse(await e.SIGNAL_CACHE.get(MODE_CONTROL_KEY)).probation, undefined);
  // Probation off: the same switch is no probation.
  const off = selEnv({ MODE_PROBATION: "off" });
  await off.SIGNAL_CACHE.put(TRADING_MODE_KEY, "intraday");
  await seedSel(off, [...many(40, { mode: "intraday", r: 0.05 }), ...many(40, { mode: "swing", r: 0.4, source: "shadow" })]);
  const lines = [];
  await runModeSelector(off, { now: T, regime: "trend", call: seats("approve") });
  const r = await runModeSelector(off, { now: T + DAY, regime: "trend", call: seats("approve"), notify: async (t) => lines.push(t) });
  assert.equal(r.applied.to, "swing");
  assert.equal(JSON.parse(await off.SIGNAL_CACHE.get(MODE_CONTROL_KEY)).probation, undefined);
  assert.doesNotMatch(lines.join("\n"), /probation/i);
  assert.equal((await modeStatus(off)).probation, undefined);
});

test("MSH-14 range's selector evidence: its strategies' cells over live (any mode) and shadow range setups, live first, the rule in force", () => {
  const s = (source, mode, decision_key, r, extra = {}) => ({ source, mode, decision_key, agent: "range_fade", side: "SELL", htf: "with", entry: 4010, stop: 4015, r, rule_version: "v", ...extra });
  const list = [
    ...Array.from({ length: 20 }, (_, i) => s("live", "intraday", `L${i}`, 0.3)),
    ...Array.from({ length: 20 }, (_, i) => s("shadow", "range", `S${i}`, 0.3)),
    s("shadow", "range", "L0", -5), // the live setup of that bar and agent wins
    s("shadow", "scalp", "X", -5), // not a range shadow setup
    s("live", "intraday", "Y", -5, { rule_version: "old" })
  ];
  const ev = rangeShadowEvidence(list, { ruleVersion: "v" });
  assert.deepEqual([ev.status, ev.n, ev.mean_r, ev.best_cell, ev.n_live, ev.n_shadow, ev.scope], ["pass", 40, 0.3, "range_fade|SELL|with", 20, 20, "cells"]);
  assert.equal(rangeShadowEvidence(list.slice(0, 20), { ruleVersion: "v" }).status, "collecting", "20 live alone collect");
});

test("MSH-15 off is byte-identical: the decision record, the plan setups and state, and the selector's outcome equal main's (hashes taken on main fdc6c38)", async () => {
  const off = await offScenario({ de, pl, ms, au, rt }, { MODE_SHADOW_EVIDENCE: "off", MODE_PROBATION: "off" });
  assert.deepEqual(off.decided, { status: "decided", stance: "BUY", source: "fallback" });
  assert.deepEqual(off.selector.runs.map((r) => r.status), ["unchanged", "unchanged", "changed"]);
  assert.deepEqual({ decision: sha(off.decision_json), plan_rows: sha(off.plan_rows), plan_state: sha(off.plan_state), selector: sha(off.selector), learning: off.learning }, {
    decision: "a681ace74f98e5e51860a731ccce60f4e6a54111dc9ab83724935341bc3533f4",
    plan_rows: "663c461aa4ea51a3a8e201fbc690743c5ba34e602cc0c32e7260c40af111e8ac",
    plan_state: "2fa572e5ba680b30248fc0a1e125bd8ccc0f4257b0eb9f47760a98746b1a406f",
    selector: "5f17a243940b818b803c566632af458bebd87b56420d86faff09e5e78d11fa31",
    learning: { status: "ok", added: 2, extended: 0, resolved: 2, unavailable: 0, setups: 2, verdict: "collecting", global_pick: "e0@s1" }
  });
  // The decision record is the same with both on: only the shadow table is new.
  const on = await offScenario({ de, pl, ms, au, rt });
  assert.equal(sha(on.decision_json), sha(off.decision_json));
});

test("MSH-16 lens-steps modeNow: the configured TRADING_MODE, else KV trading:mode, else intraday (MS1 ruling 7)", async () => {
  const store = kv();
  assert.equal(await modeNow({ SIGNAL_CACHE: store }), "intraday");
  await store.put("trading:mode", " Swing ");
  assert.equal(await modeNow({ SIGNAL_CACHE: store }), "swing");
  assert.equal(await modeNow({ SIGNAL_CACHE: store, TRADING_MODE: "scalp" }), "scalp", "the server's pin wins");
  await store.put("trading:mode", "range");
  assert.equal(await modeNow({ SIGNAL_CACHE: store }), "range");
  await store.put("trading:mode", "nonsense");
  assert.equal(await modeNow({ SIGNAL_CACHE: store, TRADING_MODE: "bogus" }), "intraday");
  assert.equal(await modeNow({ SIGNAL_CACHE: { get: async () => { throw new Error("kv down"); } } }), "intraday");
});

test("MSH-17 the shadow pass's CPU per decision (three modes, the realistic fixture): measured and small", (t) => {
  const env = { ...ENV_BASE, TRADING_MODE: "intraday" };
  const l = loaded();
  const assessment = assess(l, { now: NOW, env });
  const N = 200;
  for (let i = 0; i < 20; i++) shadowModeDecisions({ loaded: l, assessment, council: answer("BUY"), env, now: NOW });
  let t0 = performance.now();
  for (let i = 0; i < N; i++) assess(l, { now: NOW, env });
  const liveMs = (performance.now() - t0) / N;
  t0 = performance.now();
  for (let i = 0; i < N; i++) shadowModeDecisions({ loaded: l, assessment, council: answer("BUY"), env, now: NOW });
  const shadowMs = (performance.now() - t0) / N;
  t.diagnostic(`live assess ${liveMs.toFixed(3)} ms, shadow pass (3 modes) ${shadowMs.toFixed(3)} ms per decision`);
  assert.ok(shadowMs < 50, `${shadowMs} ms`);
});

test("MSH-18 the shadow table's schema is idempotent and the migration records it", async () => {
  const db = d1();
  await ensureModeShadowSchema(db);
  await ensureModeShadowSchema(db);
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync(new URL("../migrations/0026_mode_shadow_plans.sql", import.meta.url), "utf8");
  const fresh = d1();
  fresh.raw.exec(sql);
  const cols = (x) => x.raw.prepare("PRAGMA table_info(mode_shadow_plans)").all().map((c) => [c.name, c.type, c.notnull, c.pk]);
  assert.deepEqual(cols(fresh), cols(db));
});

test("MSH-19 the retention: a shadow row older than 90 days is dropped, a newer one kept, bounded per run (ruling 4)", async () => {
  const { pruneModeShadowPlans, MODE_SHADOW_KEEP_DAYS, MODE_SHADOW_PRUNE_MAX } = await import("../src/mode-shadow.mjs");
  assert.equal(MODE_SHADOW_KEEP_DAYS, 90);
  assert.ok(MODE_SHADOW_PRUNE_MAX > 0);
  const db = d1();
  await ensureModeShadowSchema(db);
  const D = 86_400_000, at = (ms) => new Date(ms).toISOString();
  const put = (key, closeMs) => db.raw.prepare("INSERT INTO mode_shadow_plans (decision_key, bar_close, decided_at, mode, side, agent, plans_json, atr_h1, regime, rule_version, created_at) VALUES (?, ?, ?, 'swing', 'BUY', 'zone_pullback', '{}', 10, 'trend', 'tp1_kz:on', ?)").run(key, at(closeMs), at(closeMs), at(closeMs));
  put("old-91d", NOW - 91 * D);
  put("old-120d", NOW - 120 * D);
  put("new-89d", NOW - 89 * D);
  put("new-1d", NOW - D);
  const keys = () => db.raw.prepare("SELECT decision_key FROM mode_shadow_plans ORDER BY decision_key").all().map((r) => r.decision_key);
  // Bounded: at most `max` rows a run, the oldest first.
  assert.deepEqual(await pruneModeShadowPlans({ DB: db }, { now: NOW, max: 1 }), { status: "ok", pruned: 1 });
  assert.deepEqual(keys(), ["new-1d", "new-89d", "old-91d"]);
  assert.deepEqual(await pruneModeShadowPlans({ DB: db }, { now: NOW }), { status: "ok", pruned: 1 });
  assert.deepEqual(keys(), ["new-1d", "new-89d"]);
  assert.deepEqual(await pruneModeShadowPlans({ DB: db }, { now: NOW }), { status: "ok", pruned: 0 });
  assert.deepEqual(await pruneModeShadowPlans({}), { status: "unavailable" });
  // The sweep calls it in the cron's retention line, beside the other prunes.
  const { readFileSync } = await import("node:fs");
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /await pruneShadowKnowledge\(env\); await pruneModelArena\(env\); await pruneModeShadowPlans\(env\);/);
});
