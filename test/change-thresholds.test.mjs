// CH1, change thresholds for the confidence, share and stance triggers (owner 2026-11-23: "supaya tidak terlalu dini,
// perubahan confluence dan confidence perlu threshold atau ambang perubahan"; "Live semua (Rekomendasi)").
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { confidenceTrend, CONFIDENCE_CHANGE_MIN, CONFIDENCE_STABLE_BAND } from "../src/agent-confidence.mjs";
import { CHANGE_TOKENS, CHANGE_THRESHOLDS_ALL, normalizeChangeThresholds, changeTokens, changeRule, measuredFall, decisionHistory, pendingShareFall, stanceAgainstConfirmed, heldTag, SHARE_FALL_MIN, CONFIRM_DECISIONS } from "../src/change-thresholds.mjs";
import { positionFacts, positionAction, runPositionManager, latestDecisions, SHARE_DROP } from "../src/position-manager.mjs";
import { resetPositionSchemaCacheForTests } from "../src/position-actions.mjs";
import { writeSettings, readSettings, applyOmegaPolicy, resetOmegaBrokerSchemaForTests, OMEGA_POLICY_KEY } from "../src/omega-broker.mjs";
import { resetEaExecutionSchemaForTests } from "../src/ea-execution.mjs";
import { OMEGA_DEFAULTS, settingsFrom, strategyExits, pendingDeleteReason } from "../src/omega-engine.mjs";
import { limitKnobs, LIMIT_KNOB_BOUNDS, LIMIT_KNOB_START } from "../src/omega-limit-knobs.mjs";
import { entryFacts, entryChoice, pendingFacts, pendingAction } from "../src/limit-council.mjs";
import { managementFields, decisionRowsBefore, withHistory, resetDecisionHistoryMemoForTests } from "../src/ea-signal.mjs";
import { limitCancelReason } from "../src/ledger-omega-limit.mjs";
import { replayOmega4, eraSwitches, ERA_SWITCHES, ENGINE_BEHAVIOUR_HASH, sha256Hex, changeBrake, changeBrakePmCases, changeBrakeSkipCases, changeBrakeMessage, runChangeThresholdBrake, CH_BRAKE, CH_SINCE_KEY, CH_BRAKE_KEY, CH_BRAKE_MEASURED } from "../src/ledger-omega4.mjs";
import { engineBehaviourSource } from "./fixtures/engine-behaviour.mjs";
import { changeLines, pendingCases, pmDecision, DECISION_SERIES, SELL, symAt, intentOf, C0, M15 } from "./fixtures/change-thresholds.mjs";
import { C, M1, M5, WARM, path, lerp, decision as v4Decision, sellTrade, dec, base as v4Base, conf as v4Conf, levels as v4Levels } from "./fixtures/omega-v4-replay.mjs";

const SLG1_HASH = "94e6f50cb1d0f913fa332d43874b3622e1746dad7bce388eecb438ec73d3088e";
const PRE_SLG1_HASH = "b58968b207cfdeafa4e1ce5ad4363370c9ec1e6aa50ae2d23f3bbe3afed5c09f";
const ALL = changeTokens(OMEGA_DEFAULTS);
const without = (token) => ALL.filter((t) => t !== token);
const WEAK = { momentum: "weakening", thesis: "weakening", reason: "r" };
const BROKEN = { momentum: "weakening", thesis: "broken", reason: "r" };
/** The Position Manager's action of the SELL fixture at `bid` in `mode` over a decision series, with `changes`. */
const act = (series, { mode = "scalp", bid = 3874, council = WEAK, changes = ALL, gap = false, gate = undefined } = {}) =>
  positionAction(positionFacts({ position: SELL, sym: symAt(bid), openIntent: intentOf(mode), levels: [], decision: pmDecision(series, { gap }), ...(gate !== undefined ? { gate } : {}), ...(changes.length ? { changes } : {}) }), council);
const S = (...xs) => xs.map(([stance, short, conf]) => [stance, short, conf]);

test("CH1-1 the switch: every token on by default, a token list or off, in ERA_SWITCHES, never written by Aether", async () => {
  assert.deepEqual([...CHANGE_TOKENS], ["conf", "tpw", "limit", "skip", "stance"]);
  assert.equal(OMEGA_DEFAULTS.change_thresholds, CHANGE_THRESHOLDS_ALL);
  assert.deepEqual([...ALL], ["conf", "tpw", "limit", "skip", "stance"]);
  assert.deepEqual([normalizeChangeThresholds("stance, conf"), normalizeChangeThresholds(""), normalizeChangeThresholds("none"), normalizeChangeThresholds("all"), normalizeChangeThresholds("tpw,x"), normalizeChangeThresholds(3)],
    ["conf,stance", "off", "off", CHANGE_THRESHOLDS_ALL, null, null]);
  // Settings stored before CH1 carry no value: every token on.
  assert.deepEqual([...changeTokens({})], [...ALL]);
  assert.deepEqual([...changeTokens({ change_thresholds: "off" })], []);
  assert.equal(settingsFrom({ change_thresholds: "limit,conf" }).settings.change_thresholds, "conf,limit");
  assert.match(settingsFrom({ change_thresholds: "fast" }).error, /^change_thresholds must be/);
  assert.equal(settingsFrom({ risk_pct: 1 }, { ...OMEGA_DEFAULTS, change_thresholds: "off" }).settings.change_thresholds, "off", "carried as stored");
  assert.ok(ERA_SWITCHES.includes("change_thresholds"));
  assert.deepEqual(eraSwitches(OMEGA_DEFAULTS), []);
  assert.deepEqual(eraSwitches({ ...OMEGA_DEFAULTS, change_thresholds: "off" }), ["change_thresholds=off"]);
  assert.deepEqual(eraSwitches({ ...OMEGA_DEFAULTS, change_thresholds: "conf,limit,skip,stance" }), ["change_thresholds=conf,limit,skip,stance"]);
  assert.deepEqual([{ ...SHARE_FALL_MIN }, { ...CONFIRM_DECISIONS }], [{ scalp: 0.1, intraday: 0.1, range: 0.1, swing: 0.15 }, { scalp: 1, intraday: 2, range: 2, swing: 2 }]);
  assert.deepEqual(changeRule("nonsense"), { mode: "intraday", share_fall: 0.1, confirm: 2, conf_drop: 0.05 });
  assert.equal(changeRule("swing").conf_drop, null, "swing: the share only");
  // Aether's policy writes the risk settings back and carries the owner's switch as stored, both ways.
  for (const stored of [CHANGE_THRESHOLDS_ALL, "off"]) {
    resetOmegaBrokerSchemaForTests(); resetPositionSchemaCacheForTests(); resetEaExecutionSchemaForTests();
    const db = new DatabaseSync(":memory:"), m = new Map();
    const prep = (sql) => { let params = []; const st = { bind(...a) { params = a.map((v) => (v === undefined ? null : v)); return st; }, async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; }, async first() { return db.prepare(sql).get(...params) ?? null; }, async all() { return { results: db.prepare(sql).all(...params) }; } }; return st; };
    const e = { DB: { prepare: prep }, SIGNAL_CACHE: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } } };
    await writeSettings(e, { body: { change_thresholds: stored }, actor: "owner" }, { now: C0 });
    await e.SIGNAL_CACHE.put(OMEGA_POLICY_KEY, JSON.stringify({ risk_pct: 0.4, max_positions: 2, change_thresholds: stored === "off" ? CHANGE_THRESHOLDS_ALL : "off", doctrine_sha: "c".repeat(64) }));
    const r = await applyOmegaPolicy({ ...e, OMEGA_POLICY_AUTO: "true" }, { now: C0 + 1 });
    assert.equal(r.status, "applied");
    assert.equal((await readSettings(e)).settings.change_thresholds, stored);
  }
});

test("CH1-2 conf: a drop or a rise needs 0.05 in every mode (0.049 is stable), off is today's 0.02 band", () => {
  assert.equal(CONFIDENCE_CHANGE_MIN, 0.05);
  const on = { min: CONFIDENCE_CHANGE_MIN };
  assert.deepEqual([confidenceTrend(0.751, 0.8, on), confidenceTrend(0.75, 0.8, on), confidenceTrend(0.65, 0.6, on), confidenceTrend(0.649, 0.6, on), confidenceTrend(null, 0.6, on)], ["stable", "drop", "rising", "stable", "unknown"]);
  // Off: today's band, byte for byte (0.03 is a drop, 0.02 is not).
  assert.equal(CONFIDENCE_STABLE_BAND, 0.02);
  assert.deepEqual([confidenceTrend(0.77, 0.8), confidenceTrend(0.6, 0.62), confidenceTrend(0.63, 0.6)], ["drop", "stable", "rising"]);
  // The Position Manager's facts, the limit council's facts and Omega's close follow it.
  const f = (changes) => positionFacts({ position: SELL, sym: symAt(3874), openIntent: intentOf("scalp"), levels: [], decision: pmDecision(DECISION_SERIES.conf_noise), ...(changes.length ? { changes } : {}) });
  assert.deepEqual([f(ALL).agent_trend, f(without("conf")).agent_trend, f([]).agent_trend], ["stable", "drop", "drop"]);
  const exits = (conf, changes) => strategyExits({ positions: [{ ...SELL, ticket: 5 }], signal: { strategy_execution: true, power: -0.3, power_ms: C0, agent_conf: conf, agent_conf_prev: "zone_pullback:0.3:0.8" }, sym: symAt(3874), agents: {}, now: C0 + M1, changes }).intents.map((i) => i.reason);
  assert.deepEqual([exits("zone_pullback:0.3:0.751", ALL), exits("zone_pullback:0.3:0.75", ALL), exits("zone_pullback:0.3:0.77", without("conf")), exits("zone_pullback:0.3:0.77", null)], [[], ["confidence_drop"], ["confidence_drop"], ["confidence_drop"]]);
  const pend = (changes) => pendingFacts({ order: { ticket: 1, type: "SELL_LIMIT", price_open: 4100 }, meta: { strategy: "zone_pullback" }, decision: pmDecision(DECISION_SERIES.conf_noise), sym: { bid: 4099, ask: 4099.2 }, changes });
  assert.deepEqual([pend(ALL).reasons, pend(without("conf")).reasons.length], [[], 1]);
});

test("CH1-3 tpw, scalp: a share fall of 0.10 or a confidence drop of 0.05 since the decision before (0.099 and 0.049 are not), named in the why", () => {
  const close = act(DECISION_SERIES.share_one_bar_10);
  assert.deepEqual([close.action, close.rule], ["close", "take_profit_weakening"]);
  assert.match(close.why, /the momentum is weakening and the quorum's bearish share fell 90% to 80% \(at least 10 points, scalp\)/);
  const conf = act(DECISION_SERIES.conf_one_bar_05);
  assert.deepEqual([conf.action, conf.rule], ["close", "take_profit_weakening"]);
  assert.match(conf.why, /the zone_pullback confidence dropped 0\.8 to 0\.75 \(at least 0\.05, scalp\)/);
  // Without a measured reason: the rules below it (no gate given: today's break-even), saying the token held the close.
  for (const s of [DECISION_SERIES.share_one_bar_099, DECISION_SERIES.conf_one_bar_049, DECISION_SERIES.steady]) {
    const a = act(s);
    assert.deepEqual([a.action, a.rule], ["sl", "breakeven"]);
    assert.ok(a.why.includes(heldTag("tpw")), a.why);
    assert.doesNotMatch(a.why, /still strong/);
  }
  // Beyond TP1: lock_tp1 instead; under SLG1 with the gate shut, the gate's hold; the beyond-TP1 close with its reason.
  assert.deepEqual(((a) => [a.action, a.rule])(act(DECISION_SERIES.steady, { bid: 3866.8 })), ["sl", "lock_tp1"]);
  assert.deepEqual(((a) => [a.action, a.rule])(act(DECISION_SERIES.steady, { bid: 3866.8, gate: null })), ["hold", "lock_waits_gate"]);
  assert.deepEqual(((a) => [a.action, a.rule])(act(DECISION_SERIES.steady, { bid: 3874, gate: null })), ["hold", "lock_waits_gate"]);
  const beyond = act(DECISION_SERIES.share_one_bar_10, { bid: 3866.8 });
  assert.deepEqual([beyond.action, beyond.rule], ["close", "take_profit_weakening"]);
  assert.match(beyond.why, /beyond TP1, the momentum is weakening and the quorum's bearish share fell 90% to 80%/);
  // Off: today's close on the council's reading alone.
  assert.deepEqual(((a) => [a.action, a.rule, a.why])(act(DECISION_SERIES.steady, { changes: without("tpw") })), ["close", "take_profit_weakening", "+58 pips (+0.58R, band 0.3R scalp) and the momentum is weakening: closed without waiting for TP1"]);
});

test("CH1-4 tpw, intraday and range: the fall confirmed on 2 consecutive closed decisions; a fall that reverts or a gap does not act", () => {
  for (const mode of ["intraday", "range"]) {
    assert.equal(act(DECISION_SERIES.share_one_bar_10, { mode }).rule, "breakeven", `${mode}: one decision is not enough`);
    const two = act(DECISION_SERIES.share_two_bars, { mode });
    assert.deepEqual([two.action, two.rule], ["close", "take_profit_weakening"]);
    assert.match(two.why, /fell from 90% to 78% and 79% on 2 decisions/);
    assert.equal(act(DECISION_SERIES.conf_two_bars, { mode }).rule, "take_profit_weakening");
    assert.equal(act(DECISION_SERIES.share_two_bars_reverted, { mode }).rule, "breakeven", "back above the level less 0.10: no reason");
    assert.equal(act(DECISION_SERIES.share_gap, { mode, gap: true }).rule, "breakeven", "not consecutive decisions");
  }
  // The pure rule at its boundaries (0.099 vs 0.10 on both decisions).
  const fall = (p2, p1, now, mode = "intraday") => measuredFall({ mode, side: "SELL", share: now, share_prev: p1, share_prev2: p2 }).share != null;
  assert.deepEqual([fall(0.9, 0.801, 0.8), fall(0.9, 0.8, 0.801), fall(0.9, 0.8, 0.8)], [false, false, true]);
});

test("CH1-5 tpw, swing: a share fall of 0.15 on 2 decisions (0.149 is not); no confidence reason", () => {
  const at = (s) => act(s, { mode: "swing", bid: 3866.8 });
  assert.deepEqual(((a) => [a.action, a.rule])(at(DECISION_SERIES.share_swing_15)), ["close", "take_profit_weakening"]);
  assert.deepEqual(((a) => [a.action, a.rule])(at(DECISION_SERIES.share_swing_149)), ["sl", "lock_tp1"]);
  assert.deepEqual(((a) => [a.action, a.rule])(at(DECISION_SERIES.conf_two_bars)), ["sl", "lock_tp1"], "the confidence is no reason in swing");
  assert.equal(measuredFall({ mode: "swing", side: "SELL", share: 0.75, share_prev: 0.75, share_prev2: 0.899 }).share, null, "0.149");
});

test("CH1-6 persistence counts closed 15m decisions, not 5-minute runs: two runs on the same decision are one", async () => {
  resetPositionSchemaCacheForTests();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE ai_usage_daily (day TEXT, source TEXT, model TEXT, calls INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, cached_tokens INTEGER, PRIMARY KEY (day, source, model))");
  db.exec("CREATE TABLE engine_decisions (decision_key TEXT PRIMARY KEY, bar_close TEXT, decision_json TEXT)");
  const wrap = (sql) => { let args = []; const s = { bind: (...a) => { args = a; return s; }, run: async () => db.prepare(sql).run(...args), first: async () => db.prepare(sql).get(...args) ?? null, all: async () => ({ results: db.prepare(sql).all(...args) }) }; return s; };
  const env = { DB: { prepare: wrap }, POSITION_MANAGER_MODE: "live", POSITION_COUNCIL_DAILY_USD: "5", SIGNAL_CACHE: { get: async () => null, put: async () => {} } };
  const put = (close, short, conf, prevConf) => db.prepare("INSERT INTO engine_decisions VALUES (?, ?, ?)").run(`k${close}`, new Date(close).toISOString(),
    JSON.stringify({ decision_key: `k${close}`, bar_close: new Date(close).toISOString(), stance: "SELL", quorum: { long_share: 1 - short, short_share: short }, agent_confidence: { zone_pullback: { long: 0.3, short: conf } }, agent_confidence_prev: { zone_pullback: { long: 0.3, short: prevConf } }, trading_mode: "intraday" }));
  put(C0 - 2 * M15, 0.9, 0.8, 0.8);
  put(C0 - M15, 0.9, 0.8, 0.8);
  put(C0, 0.78, 0.8, 0.8); // the fall, on one decision
  const run = (now) => runPositionManager(env, { now, call: async () => ({ status: "answered", obj: WEAK }), executor: { positions: [SELL], symbol: symAt(3874) }, openIntents: { [SELL.intent_id]: intentOf("intraday") }, signal: null, gates: { 101: { open: true, mfe_r: 1.2, mfe_atr: 1.5 } } });
  const r1 = await run(C0 + 3 * M1), r2 = await run(C0 + 8 * M1);
  assert.deepEqual([r1.positions[0].rule, r2.positions[0].rule], ["breakeven", "breakeven"], "two runs on the same decision: not confirmed");
  put(C0 + M15, 0.79, 0.8, 0.8); // the next closed decision still under the level less 0.10
  const r3 = await run(C0 + M15 + 3 * M1);
  assert.deepEqual([r3.positions[0].action, r3.positions[0].rule], ["close", "take_profit_weakening"]);
  // latestDecisions carries the history v4 builds from its decision rows.
  const d = await latestDecisions(env.DB);
  assert.deepEqual(d.decision_history.prev, { close_ms: C0, stance: "SELL", long_share: 1 - 0.78, short_share: 0.78 });
  assert.deepEqual(d.decision_history.prev2, { close_ms: C0 - M15, long_share: 1 - 0.9, short_share: 0.9 });
});

test("CH1-7 the extend gate: unknown reads as the last known trend (the decision before's own), so a missing reading no longer blocks", () => {
  const pos = { ...SELL, ticket: 9 };
  const ext = (signal, changes) => strategyExits({ positions: [pos], signal: { strategy_execution: true, power: -0.3, power_ms: C0, agent_conf: "zone_pullback:0.3:0.8", ...signal }, sym: symAt(3874), agents: {}, now: C0 + M1, changes }).extendOf(pos);
  assert.equal(ext({ agent_conf_prev: "", agent_conf_last: "zone_pullback:0.3:0.8", agent_conf_last_prev: "zone_pullback:0.3:0.79" }, ALL), true, "last known stable");
  assert.equal(ext({ agent_conf_prev: "", agent_conf_last: "zone_pullback:0.3:0.7", agent_conf_last_prev: "zone_pullback:0.3:0.8" }, ALL), false, "last known a drop");
  assert.equal(ext({ agent_conf_prev: "", agent_conf_last: "", agent_conf_last_prev: "" }, ALL), false, "no known state at all: unknown, as today");
  assert.equal(ext({ agent_conf_prev: "", agent_conf_last: "zone_pullback:0.3:0.8", agent_conf_last_prev: "zone_pullback:0.3:0.79" }, without("conf")), false, "off: unknown blocks, today's rule");
  assert.equal(ext({ agent_conf_prev: "zone_pullback:0.3:0.83" }, ALL), true, "a known trend is used as it is (0.03: stable with conf)");
  // The signal's fields from the decision's history (live: the rows before it; v4: its decision rows).
  const rows = [{ decision_key: "a", bar_close: new Date(C0 - M15).toISOString(), stance: "BUY", quorum: { long_share: 0.6, short_share: 0.4 }, agent_confidence: { zone_pullback: { long: 0.5, short: 0.4 } }, agent_confidence_prev: { zone_pullback: { long: 0.55, short: 0.4 } } }];
  const d = { decision_key: "b", bar_close: new Date(C0).toISOString(), quorum: { score: 0.2, long_share: 0.5, short_share: 0.5 } };
  const m = managementFields({ ...d, decision_history: decisionHistory(d, rows[0], null) });
  assert.deepEqual([m.quorum_long_share_prev, m.quorum_short_share_prev, m.decision_prev_ms, m.agent_conf_last, m.agent_conf_last_prev], [0.6, 0.4, C0 - M15, "zone_pullback:0.5:0.4", "zone_pullback:0.55:0.4"]);
  assert.equal("agent_conf_last" in managementFields(d), false, "without a history: none of the fields");
});

test("CH1-8 cut_loss: the share reason stays 0.05 on one bar with no minimum age; only its confidence reason moves to 0.05", () => {
  assert.equal(SHARE_DROP, 0.05);
  const cut = act(S(["SELL", 0.9, 0.8], ["SELL", 0.9, 0.8], ["SELL", 0.84, 0.8]), { mode: "intraday", bid: 3886, council: WEAK });
  assert.deepEqual([cut.action, cut.rule], ["close", "cut_loss"], "a fall of 0.06 still cuts, one bar, every token on");
  assert.match(cut.why, /share fell 90% to 84%/);
  assert.equal(act(S(["SELL", 0.9, 0.8], ["SELL", 0.9, 0.8], ["SELL", 0.86, 0.8]), { mode: "intraday", bid: 3886 }).rule, "hold_to_stop", "0.04 is no reason (more than 0.05, unchanged)");
  assert.equal(act(DECISION_SERIES.conf_one_bar_05, { mode: "swing", bid: 3888 }).rule, "cut_loss", "the confidence reason at 0.05, in swing too");
  const held = act(DECISION_SERIES.conf_noise, { mode: "intraday", bid: 3886 });
  assert.deepEqual([held.action, held.rule], ["hold", "hold_to_stop"]);
  assert.ok(held.why.includes(heldTag("conf")), "the held-back cut is said for the brake");
  assert.equal(act(DECISION_SERIES.conf_noise, { mode: "intraday", bid: 3886, changes: without("conf") }).rule, "cut_loss", "conf off: today's 0.02");
});

test("CH1-9 limit: cancel_share_drop per mode (scalp 0.10; intraday and range 0.10 on 2 decisions; swing 0.15 on 2), live and in the ledger's counterfactual", () => {
  assert.deepEqual(Object.fromEntries(["scalp", "intraday", "swing", "range"].map((m) => [m, limitKnobs(m, null, { changes: ALL }).cancel_share_drop])), { scalp: 0.1, intraday: 0.1, swing: 0.15, range: 0.1 });
  assert.deepEqual(Object.values(LIMIT_KNOB_START).map((k) => k.cancel_share_drop), [0.05, 0.05, 0.05, 0.05], "off: today's start values");
  assert.deepEqual({ ...LIMIT_KNOB_BOUNDS.swing.cancel_share_drop }, { min: 0.03, max: 0.2 });
  const got = Object.fromEntries(pendingCases());
  assert.deepEqual(["one_0099", "one_010", "two_010", "two_reverted", "prev_is_placing"].map((n) => got[`scalp|${n}`]), [null, "quorum_share_drop", "quorum_share_drop", null, "quorum_share_drop"]);
  for (const m of ["intraday", "range"]) assert.deepEqual(["one_010", "one_015", "two_010", "two_reverted", "prev_is_placing"].map((n) => got[`${m}|${n}`]), [null, null, "quorum_share_drop", null, null], m);
  assert.deepEqual(["one_015", "two_010", "two_015"].map((n) => got[`swing|${n}`]), [null, null, "quorum_share_drop"]);
  // Off: today's rule, more than 0.05 on the current decision.
  const off = Object.fromEntries(pendingCases("off"));
  assert.deepEqual(["one_0049", "one_0099", "two_reverted"].map((n) => off[`intraday|${n}`]), [null, "quorum_share_drop", null]);
  // The pure rule at 0.099 vs 0.10, and the ledger's counterfactual mirroring it from the decision's history.
  assert.deepEqual([pendingShareFall({ mode: "scalp", threshold: 0.1, share0: 0.7, share: 0.601 }), pendingShareFall({ mode: "scalp", threshold: 0.1, share0: 0.7, share: 0.6 })], [false, true]);
  const pending = { side: "BUY", mode: "intraday", close_ms: C0, placed_ms: C0 + M1, share0: 0.7, knobs: limitKnobs("intraday", null, { changes: ALL }) };
  const at = (prevShare, share, settings = OMEGA_DEFAULTS) => {
    const prev = { decision_key: "p", close_ms: C0 + M15, stance: "WAIT", quorum: { long_share: prevShare, short_share: 1 - prevShare } };
    const d = { decision_key: "d", close_ms: C0 + 2 * M15, stance: "WAIT", quorum: { long_share: share, short_share: 1 - share } };
    return limitCancelReason({ pending: settings === OMEGA_DEFAULTS ? pending : { ...pending, knobs: limitKnobs("intraday") }, now: C0 + 31 * M1, decision: { ...d, decision_history: decisionHistory(d, prev, null) }, settings });
  };
  assert.deepEqual([at(0.6, 0.6), at(0.6, 0.69), at(0.69, 0.6), at(0.69, 0.64, { ...OMEGA_DEFAULTS, change_thresholds: "off" })], ["quorum_share_drop", null, null, "quorum_share_drop"]);
});

test("CH1-10 skip: under limit too, a skip needs a measured skip reason that holds, by the take_profit_weakening thresholds; one that does not proceeds", () => {
  const request = (mode) => ({ side: "SELL", entry_order: "limit", mode, agent: "zone_pullback", limit: { price: 4100, away_r: 0.2 } });
  const facts = (mode, series, changes = ALL) => entryFacts({ request: request(mode), decision: pmDecision(series), rooms: [], changes });
  const skip = (measured) => ({ answer: "skip", measured, reason: "no" });
  // A skip with no measured reason, or one that does not hold, places the limit.
  assert.deepEqual(((c) => [c.choice, c.rule])(entryChoice(facts("scalp", DECISION_SERIES.steady), skip([]))), ["place_limit", "skip_no_measured_reason"]);
  assert.deepEqual(((c) => [c.choice, c.rule])(entryChoice(facts("scalp", DECISION_SERIES.share_one_bar_099), skip(["quorum_share_drop"]))), ["place_limit", "skip_no_measured_reason"]);
  assert.deepEqual(((c) => [c.choice, c.rule])(entryChoice(facts("scalp", DECISION_SERIES.share_one_bar_10), skip(["quorum_share_drop"]))), ["skip", "council_skip:quorum_share_drop"]);
  assert.deepEqual(((c) => [c.choice, c.rule])(entryChoice(facts("intraday", DECISION_SERIES.share_one_bar_10), skip(["quorum_share_drop"]))), ["place_limit", "skip_no_measured_reason"], "intraday: 2 decisions");
  assert.equal(entryChoice(facts("intraday", DECISION_SERIES.share_two_bars), skip(["quorum_share_drop"])).choice, "skip");
  assert.equal(entryChoice(facts("scalp", DECISION_SERIES.conf_one_bar_049), skip(["confidence_drop"])).choice, "place_limit");
  assert.equal(entryChoice(facts("scalp", DECISION_SERIES.conf_one_bar_05), skip(["confidence_drop"])).choice, "skip");
  assert.equal(entryChoice(facts("swing", DECISION_SERIES.conf_two_bars), skip(["confidence_drop"])).choice, "place_limit", "swing: no confidence reason");
  // Under council, the same thresholds: a skip whose reason does not hold is today's market entry.
  const council = (mode, series) => entryFacts({ request: { ...request(mode), entry_order: "council" }, decision: pmDecision(series), rooms: [], changes: ALL });
  assert.equal(entryChoice(council("scalp", DECISION_SERIES.share_one_bar_099), skip(["quorum_share_drop"])).choice, "enter_market");
  // Off: under limit the skip stands as the council said; under council the share drop is today's more than 0.05.
  assert.deepEqual(((c) => [c.choice, c.rule])(entryChoice(facts("scalp", DECISION_SERIES.steady, without("skip")), skip([]))), ["skip", "council_skip"]);
  const offCouncil = entryFacts({ request: { ...request("scalp"), entry_order: "council" }, decision: pmDecision(DECISION_SERIES.share_one_bar_099), rooms: [], changes: without("skip") });
  assert.equal(entryChoice(offCouncil, skip(["quorum_share_drop"])).choice, "skip");
  assert.deepEqual(entryFacts({ request: request("scalp"), decision: pmDecision(DECISION_SERIES.steady), rooms: [] }).changes, undefined, "no tokens given: today's facts");
});

test("CH1-11 stance: the other side on 2 consecutive closed decisions; a flip that reverts does not act", () => {
  const cut = act(DECISION_SERIES.stance_two, { mode: "intraday", bid: 3886, council: BROKEN });
  assert.deepEqual([cut.action, cut.rule], ["close", "cut_loss"]);
  assert.match(cut.why, /the decision is BUY on 2 decisions/);
  const one = act(DECISION_SERIES.stance_one, { mode: "intraday", bid: 3886, council: BROKEN });
  assert.deepEqual([one.action, one.rule], ["hold", "hold_to_stop"]);
  assert.ok(one.why.includes(heldTag("stance")));
  assert.equal(act(DECISION_SERIES.stance_reverted, { mode: "intraday", bid: 3886, council: BROKEN }).rule, "hold_to_stop", "BUY then SELL again: no reason");
  assert.equal(act(DECISION_SERIES.stance_one, { mode: "intraday", bid: 3886, council: BROKEN, changes: without("stance") }).rule, "cut_loss", "off: one decision, today's rule");
  assert.deepEqual([stanceAgainstConfirmed("SELL", "BUY", "BUY"), stanceAgainstConfirmed("SELL", "BUY", "WAIT"), stanceAgainstConfirmed("SELL", "WAIT", "BUY")], [true, false, false]);
  // The pending council's move and cancel.
  const order = { ticket: 1, type: "SELL_LIMIT", price_open: 4100 };
  const pf = (series, changes = ALL) => pendingFacts({ order, meta: { strategy: "zone_pullback" }, decision: pmDecision(series), sym: { bid: 4099, ask: 4099.2 }, changes });
  const cancel = { answer: "cancel", move_to: null, reason: "turned" };
  assert.deepEqual(((a) => [a.action, a.rule])(pendingAction(pf(DECISION_SERIES.stance_two), cancel)), ["cancel", "council_cancel"]);
  assert.deepEqual(((a) => [a.action, a.rule])(pendingAction(pf(DECISION_SERIES.stance_one), cancel)), ["keep", "keep_no_reason"]);
  assert.deepEqual(((a) => [a.action, a.rule])(pendingAction(pf(DECISION_SERIES.stance_reverted), cancel)), ["keep", "keep_no_reason"]);
  assert.deepEqual(((a) => [a.action, a.rule])(pendingAction(pf(DECISION_SERIES.stance_one, without("stance")), cancel)), ["cancel", "council_cancel"]);
});

test("CH1-12 each token off is today's rule for its trigger byte for byte; all off is the engine before CH1", async () => {
  // All off: SLG1's fingerprint (94e6f50c…) byte for byte; with "legacy" too, the one before SLG1.
  // PM-1M (2026-11-23): with the 1m fast layer off too (the engine before it); RE1 (2026-11-23): and the 1m re-entry.
  assert.equal(await sha256Hex(engineBehaviourSource({ changeThresholds: "", pmFast: "off", reentry: "off" })), SLG1_HASH);
  assert.equal(await sha256Hex(engineBehaviourSource({ changeThresholds: "off", pmFast: "off", reentry: "off" })), SLG1_HASH);
  assert.equal(await sha256Hex(engineBehaviourSource({ changeThresholds: "", profitLockGate: "legacy", pmFast: "off", reentry: "off" })), PRE_SLG1_HASH);
  // One token off: its trigger's outputs are the all-off outputs (the other tokens stay on).
  const parse = (lines, name) => JSON.parse(lines.find((l) => l.startsWith(`${name}=`)).slice(name.length + 1));
  const off = changeLines("off");
  const offPm = new Map(parse(off, "change/pm"));
  const pmOf = (token) => new Map(parse(changeLines(without(token).join(",") || "off"), "change/pm"));
  // tpw: every action in the profit band and beyond TP1 (3874, 3866.8), on the decision series without a stance flip.
  const tpw = pmOf("tpw");
  for (const [k, a] of tpw) if (/\|(3874|3866\.8)\|/.test(k) && !k.startsWith("stance")) assert.deepEqual(a, offPm.get(k), k);
  // stance and conf: every action in the loss band (3886) of their series.
  const stance = pmOf("stance");
  for (const [k, a] of stance) if (/^stance_.*\|3886\|/.test(k)) assert.deepEqual(a, offPm.get(k), k);
  const conf = pmOf("conf");
  for (const [k, a] of conf) if (/^conf_.*\|3886\|/.test(k)) assert.deepEqual(a, offPm.get(k), k);
  assert.deepEqual(parse(changeLines(without("conf").join(",")), "change/exits"), parse(off, "change/exits"));
  assert.deepEqual(pendingCases(without("limit").join(",")), pendingCases("off"));
  // skip: entryFacts' holds and entryChoice as with no token at all.
  for (const series of Object.values(DECISION_SERIES)) {
    for (const mode of ["scalp", "intraday", "swing"]) {
      for (const order of ["limit", "council"]) {
        const request = { side: "SELL", entry_order: order, mode, agent: "zone_pullback", limit: { price: 4100, away_r: 0.2 } };
        const a = entryFacts({ request, decision: pmDecision(series), rooms: [], changes: without("skip").filter((t) => t !== "conf") });
        const b = entryFacts({ request, decision: pmDecision(series), rooms: [] });
        assert.deepEqual(a.holds, b.holds);
        for (const answer of order === "limit" ? ["place", "skip"] : ["skip", "enter_market"]) {
          const c = { answer, measured: ["quorum_share_drop", "confidence_drop"], reason: "r" };
          assert.deepEqual(entryChoice(a, c), entryChoice(b, c));
        }
      }
    }
  }
});

test("CH1-13 v4 replays it as live: the decision rows' history, the stance held on 2 decisions before a cut", async () => {
  // A SELL at 2000 (stop 2020) goes 8 against; the decision turns BUY (no plan) at C + 15, then BUY again or back to SELL.
  const lv = v4Levels([[1940, 1942]]);
  const d0 = v4Decision({ close: C, trade: sellTrade(2000, 2020, 1970), lv });
  const later = (stance2) => [v4Decision({ close: C + M15, stance: "BUY", decidedAfter: M1, lv }), v4Decision({ close: C + 2 * M15, stance: stance2, decidedAfter: M1, lv })];
  const price = lerp([[C + 3 * M1, 2000], [C + 14 * M1, 2008], [C + 60 * M1, 2008]]);
  const bars = path(C - WARM, C + 60 * M1, price, 0.05);
  const councils = {};
  for (let t = C + 15 * M1; t < C + 60 * M1; t += M5) councils[`open:${C}:S|${Math.floor(t / M5)}`] = "weakening, thesis broken: the decision turned";
  // PM-1M (2026-11-23): the 1m fast layer off (the engine before it): its impulse rule would tighten this stop first.
  const run = (stance2, settings = { ...OMEGA_DEFAULTS, enabled: true, pm_fast_1m: "off" }) => replayOmega4({ ...v4Base({ settings }), bars, decisions: [d0, ...later(stance2)].map(dec), to: C + 60 * M1, councils });
  const recOf = (r) => r.records[`OANDA:XAUUSD:15:${C - M15}`];
  const confirmed = recOf(run("BUY")), reverted = recOf(run("SELL")), off = recOf(run("SELL", { ...OMEGA_DEFAULTS, enabled: true, change_thresholds: "off", pm_fast_1m: "off" }));
  const exitAt = (r) => [r.omega4_exit, JSON.parse(r.omega4_json).pm.map((x) => x.rule)];
  assert.deepEqual(exitAt(confirmed), ["pm_cut_loss", ["cut_loss"]]);
  assert.equal(confirmed.omega4_closed_at, new Date(C + 2 * M15 + 3 * M1).toISOString(), "at the first run on the second BUY decision");
  assert.equal(reverted.omega4_status, "open", "a flip that reverts does not cut");
  assert.deepEqual(exitAt(off), ["pm_cut_loss", ["cut_loss"]]);
  assert.equal(off.omega4_closed_at, new Date(C + M15 + 3 * M1).toISOString(), "off: today's cut on the first BUY decision");
  // The history v4 gives the signal and the Position Manager is the live one: the rows before the decision in D1.
  resetDecisionHistoryMemoForTests();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE engine_decisions (decision_key TEXT PRIMARY KEY, bar_close TEXT, decision_json TEXT)");
  for (const d of [d0, ...later("BUY")]) db.prepare("INSERT INTO engine_decisions VALUES (?, ?, ?)").run(d.decision_key, d.bar_close, JSON.stringify(d));
  const wrap = (sql) => { let args = []; const s = { bind: (...a) => { args = a; return s; }, first: async () => db.prepare(sql).get(...args) ?? null, all: async () => ({ results: db.prepare(sql).all(...args) }) }; return s; };
  const env = { DB: { prepare: wrap } };
  const latest = later("BUY")[1];
  assert.equal((await decisionRowsBefore(env, latest)).length, 2);
  const live = await withHistory(env, latest), pm = await latestDecisions(env.DB);
  const trace = [];
  replayOmega4({ ...v4Base({ settings: { ...OMEGA_DEFAULTS, enabled: true, pm_fast_1m: "off" } }), bars, decisions: [d0, ...later("BUY")].map(dec), to: C + 2 * M15 + 5 * M1, councils, trace });
  const sig = trace.at(-1).input.signal;
  assert.deepEqual([sig.quorum_short_share_prev, sig.decision_prev_ms, sig.agent_conf_last, sig.agent_conf_last_prev], [managementFields(live).quorum_short_share_prev, managementFields(live).decision_prev_ms, managementFields(live).agent_conf_last, managementFields(live).agent_conf_last_prev]);
  assert.deepEqual(pm.decision_history, live.decision_history);
  assert.equal(pm.decision_history.prev.stance, "BUY");
});

test("CH1-14 the brake: after 20 cases per token, one line when the held-back cases did worse than acting; never a switch", async () => {
  assert.deepEqual({ ...CH_BRAKE }, { min_cases: 20, pending_ms: 6 * 3600_000 });
  assert.deepEqual([...CH_BRAKE_MEASURED], ["conf", "tpw", "skip", "stance"]);
  const cases = (sup, fired, acted, held) => [...Array.from({ length: sup }, () => ({ kind: "suppressed", acted_r: acted, held_r: held })), ...Array.from({ length: fired }, () => ({ kind: "fired", acted_r: 0.5, held_r: 0.2 }))];
  assert.equal(changeBrake("tpw", cases(5, 14, 0.4, -0.2)).status, "insufficient", "19 cases");
  const worse = changeBrake("tpw", cases(5, 15, 0.4, -0.2));
  assert.deepEqual([worse.fire, worse.status, worse.cases, worse.suppressed, worse.gap_r], [true, "worse", 20, 5, 0.6]);
  assert.equal(changeBrake("tpw", cases(5, 15, 0.4, 0.9)).status, "holds", "holding did better");
  assert.equal(changeBrake("tpw", cases(0, 25, 0, 0)).status, "insufficient", "nothing held back");
  assert.match(changeBrakeMessage(worse), /^XAUUSD OMEGA · Change threshold brake \(tpw\): over 20 cases \(15 acted, 5 held back\).*0\.6R per case worse.*Consider turning 'tpw' off/);
  // The Position Manager's cases: the earliest row per ticket, acting at its pips, holding to its stop or target, in R.
  const tag = `${heldTag("tpw")} close back: no measured change`;
  const rows = [
    { ticket: 1, at_ms: 1000, side: "SELL", pips: 40, price: 3876, action: "sl", rule: "breakeven", why: `x; ${tag}`, orig_sl: 3890, orig_tp: 3870, basis: 0, status: "pending" },
    { ticket: 1, at_ms: 2000, side: "SELL", pips: 45, price: 3875.5, action: "sl", rule: "lock_waits_gate", why: `y; ${tag}`, orig_sl: 3890, orig_tp: 3870, basis: 0, status: "noted" },
    { ticket: 2, at_ms: 1500, side: "SELL", pips: 30, price: 3877, action: "close", rule: "take_profit_weakening", why: "measured", orig_sl: 3890, orig_tp: 3870, basis: 0, status: "applied" }
  ];
  const bars = [{ open_time: 3000, high: 3880, low: 3869, close: 3870 }];
  const pc = changeBrakePmCases({ token: "tpw", rows, bars, rDistPips: { 1: 100, 2: 100 }, now: 10_000 });
  assert.deepEqual(pc, [{ kind: "suppressed", ticket: 1, at_ms: 1000, acted_r: 0.4, held_r: 1 }, { kind: "fired", ticket: 2, at_ms: 1500, acted_r: 0.3, held_r: 1 }]);
  assert.deepEqual(changeBrakePmCases({ token: "tpw", rows, bars, rDistPips: {}, now: 10_000 }), [], "no stop distance: not scored");
  // Skip: a skip held back is scored at its trade's R (0R when none filled after 6 hours), against 0R.
  const sk = changeBrakeSkipCases({ rows: [{ rule: "skip_no_measured_reason", at_ms: 0, facts: JSON.stringify({ issued_ms: 5, side: "BUY" }) }, { rule: "skip_no_measured_reason", at_ms: 0, facts: JSON.stringify({ issued_ms: 6, side: "BUY" }) }, { rule: "council_skip:htf_against", at_ms: 0 }], trades: [{ signal_issued_ms: 5, side: "BUY", r: -1 }], now: CH_BRAKE.pending_ms });
  assert.deepEqual(sk.map((c) => [c.kind, c.held_r]), [["suppressed", -1], ["suppressed", 0], ["fired", null]]);
  // The step: each token's era starts the first time it is seen on; limit is unmeasured; off clears; once per era.
  const kv = new Map(), sent = [];
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE omega_settings (id INTEGER PRIMARY KEY, settings TEXT)");
  db.exec("CREATE TABLE position_actions (id TEXT, ticket INTEGER, bar INTEGER, at_ms INTEGER, side TEXT, pips REAL, price REAL, action TEXT, rule TEXT, sl REAL, tp REAL, why TEXT, council TEXT, orig_sl REAL, orig_tp REAL, basis REAL, status TEXT)");
  db.exec("CREATE TABLE omega_intents (id TEXT, kind TEXT, payload TEXT, result TEXT, status TEXT, created_ms INTEGER)");
  db.exec("CREATE TABLE limit_council (id TEXT, kind TEXT, open_id TEXT, rule TEXT, at_ms INTEGER, facts TEXT)");
  db.exec("CREATE TABLE ea_deals (position_ticket INTEGER, side TEXT, volume REAL, entry_price REAL, stop_loss REAL, profit REAL, reason TEXT, opened_ms INTEGER, closed_ms INTEGER, source TEXT, currency TEXT, mode TEXT)");
  db.prepare("INSERT INTO omega_settings VALUES (1, ?)").run(JSON.stringify({}));
  const wrap = (sql) => { let args = []; const s = { bind: (...a) => { args = a; return s; }, run: async () => db.prepare(sql).run(...args), first: async () => db.prepare(sql).get(...args) ?? null, all: async () => ({ results: db.prepare(sql).all(...args) }) }; return s; };
  const env = { DB: { prepare: wrap }, SIGNAL_CACHE: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } } };
  const T = Date.parse("2026-11-24T00:00:00Z");
  const first = await runChangeThresholdBrake(env, { now: T, send: async (t) => sent.push(t), bars: [] });
  assert.deepEqual(Object.values(first.tokens).map((x) => x.status), ["started", "started", "started", "started", "started"]);
  // 20 tpw cases after the era's start, 5 of them held back and worse held than closed.
  for (let i = 0; i < 20; i++) {
    const held = i < 5;
    db.prepare("INSERT INTO position_actions VALUES (?, ?, 0, ?, 'SELL', ?, ?, ?, ?, NULL, NULL, ?, NULL, 3890, 3870, 0, ?)").run(`r${i}`, 100 + i, T + 1000 + i, 40, 3876, held ? "sl" : "close", held ? "breakeven" : "take_profit_weakening", held ? `b; ${tag}` : "measured", held ? "pending" : "applied");
    db.prepare("INSERT INTO omega_intents VALUES (?, 'open', ?, ?, 'done', ?)").run(`open:${i}`, JSON.stringify({ r_dist: 10, entry: 3880, sl: 3890 }), JSON.stringify({ ticket: 100 + i }), T);
  }
  const lossBars = [{ open_time: T + 60_000, high: 3891, low: 3876, close: 3890 }];
  const second = await runChangeThresholdBrake(env, { now: T + 3600_000, send: async (t) => sent.push(t), bars: lossBars });
  assert.deepEqual([second.tokens.tpw.status, second.tokens.tpw.cases, second.tokens.tpw.suppressed, second.tokens.limit.status], ["sent", 20, 5, "unmeasured"]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Change threshold brake \(tpw\)/);
  assert.equal((await runChangeThresholdBrake(env, { now: T + 7200_000, send: async (t) => sent.push(t), bars: lossBars })).tokens.tpw.status, "sent_before");
  assert.ok(kv.has(`${CH_BRAKE_KEY}tpw:${T}`));
  // The brake never writes the setting; switching the token off clears its era.
  assert.equal(JSON.parse(db.prepare("SELECT settings FROM omega_settings WHERE id = 1").get().settings).change_thresholds, undefined);
  db.prepare("UPDATE omega_settings SET settings = ? WHERE id = 1").run(JSON.stringify({ change_thresholds: "conf,limit,skip,stance" }));
  assert.equal((await runChangeThresholdBrake(env, { now: T + 9000_000, send: async (t) => sent.push(t), bars: lossBars })).tokens.tpw.status, "off");
  assert.equal(kv.has(`${CH_SINCE_KEY}tpw`), false);
  assert.equal(sent.length, 1);
});

test("CH1-15 the behaviour hash: a new era with every token on (the default); the fingerprint covers the change cases", async () => {
  const text = engineBehaviourSource();
  assert.equal(await sha256Hex(text), ENGINE_BEHAVIOUR_HASH);
  assert.notEqual(ENGINE_BEHAVIOUR_HASH, SLG1_HASH, "CH1 on is a new era (a recorded exception)");
  const names = text.split("\n").map((l) => l.slice(0, l.indexOf("=")));
  assert.deepEqual(names.filter((n) => n.startsWith("change/")), ["change/pm", "change/exits", "change/pending"]);
  assert.equal(engineBehaviourSource({ changeThresholds: "off" }).includes("change/pm="), false);
});
