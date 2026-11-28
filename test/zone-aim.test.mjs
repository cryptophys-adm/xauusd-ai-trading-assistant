// Z2b (docs/RFC_DEMAND_SUPPLY_ZONES.md §6): the execution plans aimed by zone type. tp_typed (TP1's words, TP2 at the
// next decisive opposing key zone; 'qualified' owner-set only), stop_skip (the stop past a decisive opposing-type zone),
// pickStrategy's zone factor, zone_rules, rule_version and MS2's base arm. Every rule runs on copies after the agents'
// consensus and the quorum. Switches: ZONE_PRIORITY (unset "off": none of Z2b), ZONE_AIM_OFF, ZONE_AIM_TP.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as se from "../src/strategy-engine.mjs";
import * as de from "../src/decision-engine.mjs";
import * as ea from "../src/ea-signal.mjs";
import * as pp from "../src/public-projection.mjs";
import * as pa from "../src/public-analysis.mjs";
import * as pl from "../src/plan-learning.mjs";
import { ruleVersionOf, writeShadowPlans } from "../src/mode-shadow.mjs";
import { DEFAULT_AGENT, KEY_TARGET_AGENTS, AGENT_IDS } from "../src/strategy-agents.mjs";
import { ENGINE_CODE_HASH, ENGINE_BEHAVIOUR_HASH, engineCodeSource, sha256Hex } from "../src/ledger-omega4.mjs";
import { gunzipJson } from "../src/strategy-inputs.mjs";
import {
  zoneAim, zoneAimHeld, zoneAimBase, zoneAimMode, zoneAimOffMode, zoneAimTpMode, zoneAimRuleToken, zoneFactorOf, zoneAhead, zoneAheadFails, zoneNeed, aroundSet,
  ZONE_AIM, ZONE_AIM_RULE, ZONE_AIM_TOKENS, ZONE_NEED
} from "../src/zone-types.mjs";
import { zoneScenario, zoneInputs as zoneInputsWithOrb, ZONE_ENV, CLOSE, NOW } from "./support/zone-types-fixture.mjs";
// Track A PR 8: the opening-range edges off (the scenario's live London window would add them), so the pins below stay
// those of their main commits, as zoneScenario does; ORB-10 runs the scenario with them on.
const zoneInputs = (modes, opts) => { const b = zoneInputsWithOrb(modes, opts); return { ...b, modes: { ...(b.modes ?? {}), orbLevels: "off" } }; };
import { d1, kv } from "./fixtures/mode-shadow.mjs";
import { inertOutputs, wranglerVars, withoutDsSources, withoutAtrRangeRatio } from "./support/zone-aim-inert.mjs";
import { CAPTURE_2026_11_20_22 } from "./fixtures/z2-capture-2026-11-20-22.mjs";

const mods = { se, de, ea, pp, pa, pl };
// CDG (2026-11-25): the decision record's atr_range_ratio (a measurement) is stripped before hashing, so the pins taken before it hold.
const sha = (v) => createHash("sha256").update(JSON.stringify(withoutAtrRangeRatio(v))).digest("hex");
const Z2 = Object.freeze({ ZONE_PRIORITY: "on", ZONE_AHEAD_MODE: "trend", ZONE_AIM_OFF: "tp,stop,factor" });
const ON = Object.freeze({ ZONE_PRIORITY: "on", ZONE_AHEAD_MODE: "trend" });
const only = (...off) => ({ ...ON, ZONE_AIM_OFF: off.join(",") });
const KEY = `OANDA:XAUUSD:15:${Date.parse(CLOSE) - 15 * 60_000}`;

// ---------------------------------------------------------------- fixtures
const ds = (type, strength = "medium", freshness = "fresh") => ({ type, strength, score: 1, freshness, touches: 0, sources: [] });
/**
 * A long at 4000 (1H ATR 10) holding a strong demand zone: under it a medium supply zone 0.6 ATR below the entry (today's
 * stop zone, 3990, risk 1 ATR) and a demand zone (the skip's stop, 3980); ahead a medium fresh supply key zone at 1.5R
 * (TP1), an untyped key zone at 2.2R (today's TP2) and a strong supply key zone at 3R (the typed TP2).
 */
const unitZones = ({ next = { low: 3982, high: 3984 }, qualified = null } = {}) => [
  { ...next, price: (next.low + next.high) / 2, candidate: true, label: "s2", ds: ds("demand") },
  { low: 3992, high: 3994, price: 3993, candidate: true, label: "s1", ds: ds("supply") },
  { low: 3998, high: 4000.5, price: 3999, candidate: true, label: "s0", ds: ds("demand", "strong") },
  ...(qualified ? [{ ...qualified, price: (qualified.low + qualified.high) / 2, candidate: false, qualified: true, label: "q1", ds: ds("supply") }] : []),
  { low: 4015, high: 4017, price: 4016, candidate: true, label: "r1", ds: ds("supply") },
  { low: 4022, high: 4023, price: 4022.5, candidate: true, label: "r2", ds: ds("none") },
  { low: 4030, high: 4031, price: 4030.5, candidate: true, label: "r3", ds: ds("supply", "strong") }
];
const unitStrategy = (zones = unitZones(), trend = 0.3) => ({ price: 4000, atr_h1: 10, trend, direction: "LONG", alignment: 0.6, decision: "BUY", confidence: 0.6, plan: { at_level: true }, setup: { type: "none" }, key_levels: { zones } });
const row = (key, lean, action = "WAIT") => ({ key, label: key, role: key, available: true, lean, action, confidence: 0.6, summary: `${key} reads the chart.`, at: CLOSE, stale: false });
const unitLoaded = (zones) => ({ inputs: {}, strategy: unitStrategy(zones), global: { timeframes: [row("D1", 0.5), row("H4", 0.45), row("H1", 0.4), row("M15", 0.35, "BUY"), row("NEWS", 0.2), row("MACRO", 0.1)] }, correlations: null, regime: "normal-trending" });
const UNIT_ENV = Object.freeze({ TRADING_MODE: "intraday" });
const BUY = Object.freeze({ answer: { stance: "BUY", bias: "BULLISH", confidence: 0.7, entry_type: "limit", target: "tp1", summary: "Decision BUY, bias bullish: the witnesses lean bullish.", reasons: ["The witnesses lean bullish."], risks: [], weighed: ["D1"] } });
const SELL = Object.freeze({ answer: { stance: "SELL", bias: "BEARISH", confidence: 0.7, entry_type: "limit", target: "tp1", summary: "Decision SELL, bias bearish: the witnesses lean bearish.", reasons: ["The witnesses lean bearish."], risks: [], weighed: ["D1"] } });
const bearLoaded = () => {
  const inputs = zoneInputs();
  return { inputs, strategy: se.buildStrategy(inputs), global: { timeframes: [row("D1", -0.5), row("H4", -0.45), row("H1", -0.4), row("M15", -0.35, "SELL"), row("NEWS", -0.2), row("MACRO", -0.1)] }, correlations: null, regime: "normal-trending" };
};
const unitAssess = (env, zones) => de.assess(unitLoaded(zones), { now: NOW, env: { ...UNIT_ENV, ...env } });
const pullback = (a, side = "long") => a.guards[side].plans[DEFAULT_AGENT].plan;
/** zoneAim's direct inputs for a plan on the unit strategy. */
const ctxOf = (strategy, aim, extra = {}) => ({ dir: 1, atrH1: strategy.atr_h1, trend: strategy.trend, aim, keyZone: true, typedTargets: true, stopFromZones: true, levels: se.zoneLevels(strategy.key_levels.zones), ...extra });

// ---------------------------------------------------------------- the switches

test("ZA-1 the switches: ZONE_PRIORITY gates all of Z2b; ZONE_AIM_OFF tokens; ZONE_AIM_TP label | qualified; wrangler.jsonc ships every rule off", () => {
  assert.deepEqual(ZONE_AIM_TOKENS, ["tp", "stop", "factor"]);
  assert.equal(zoneAimMode({}), null, "unset ZONE_PRIORITY reads off");
  assert.equal(zoneAimMode({ ZONE_PRIORITY: "off" }), null);
  assert.deepEqual(zoneAimMode({ ZONE_PRIORITY: "on" }), { tp: "label", stop: true, factor: true });
  assert.deepEqual(zoneAimMode({ ZONE_PRIORITY: "on", ZONE_AIM_OFF: " Stop, nonsense factor" }), { tp: "label", stop: false, factor: false });
  assert.deepEqual(zoneAimOffMode({ ZONE_AIM_OFF: "factor,tp" }), ["tp", "factor"]);
  assert.equal(zoneAimMode({ ZONE_PRIORITY: "on", ZONE_AIM_OFF: "tp,stop,factor" }), null, "every rule off: inert");
  assert.equal(zoneAimMode({ ZONE_PRIORITY: "on", KEY_LEVEL_ZONE_TYPES: "off" }), null, "untyped zones");
  assert.equal(zoneAimMode({ ZONE_PRIORITY: "on" }, { zoneTypes: "off" }), null);
  assert.equal(zoneAimMode({ ZONE_PRIORITY: "on", ZONE_AHEAD_MODE: "record" })?.stop, true, "Z2's own mode does not switch Z2b");
  assert.equal(zoneAimTpMode({}), "label");
  assert.equal(zoneAimTpMode({ ZONE_AIM_TP: "QUALIFIED" }), "qualified");
  assert.equal(zoneAimTpMode({ ZONE_AIM_TP: "nonsense" }), "label");
  assert.equal(zoneAimMode({ ZONE_PRIORITY: "on", ZONE_AIM_OFF: "tp", ZONE_AIM_TP: "qualified" }).tp, null);
  assert.equal(ZONE_AIM.factor_own / ZONE_AIM.factor_opposite > 1.41 && ZONE_AIM.factor_own / ZONE_AIM.factor_opposite < 1.42, true);
  assert.deepEqual(ZONE_NEED, { risk: 1, atr: 0.75 }, "the typed-TP floor is Z2's need");
  const w = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(w, /"ZONE_AIM_OFF": "tp,stop,factor",/, "inert at ship (orchestrator ruling 2026-11-25)");
  assert.match(w, /"ZONE_AIM_TP": "label",/);
  assert.match(w, /"ZONE_PRIORITY": "on"/);
  assert.deepEqual([...KEY_TARGET_AGENTS], [DEFAULT_AGENT, "sweep_reversal", "breakout_retest"]);
  assert.ok(KEY_TARGET_AGENTS.every((id) => AGENT_IDS.includes(id)));
});

// ---------------------------------------------------------------- the order: copies after the consensus and the quorum

test("ZA-2 agentsConsensus, the STRATEGY_AGENTS witness, the agents' confidence and the quorum deep-equal Z2's: fully on, tp+stop off, each token off, each rule alone", () => {
  const envs = [ON, only("tp", "stop"), only("tp"), only("stop"), only("factor"), only("stop", "factor"), only("tp", "factor"), { ...ON, ZONE_AIM_TP: "qualified" }];
  for (const [name, assessOf] of [["unit", (env) => unitAssess(env)], ["fixture", (env) => de.assess(bearLoaded(), { now: NOW, env: { ...ZONE_ENV, ...env } })]]) {
    const base = assessOf(Z2);
    for (const env of envs) {
      const a = assessOf(env);
      const tag = `${name} ${JSON.stringify(env)}`;
      assert.deepEqual(a.guards.consensus, base.guards.consensus, tag);
      assert.deepEqual(a.guards.agent_confidence, base.guards.agent_confidence, tag);
      assert.deepEqual(a.cards, base.cards, tag);
      assert.deepEqual(a.cards.find((c) => c.key === "STRATEGY_AGENTS"), base.cards.find((c) => c.key === "STRATEGY_AGENTS"), tag);
      assert.deepEqual(a.quorum, base.quorum, tag);
    }
  }
  // The unit case does move a price (so the invariance above is not vacuous).
  assert.notEqual(unitAssess(only("factor")).guards.long.plan.stop, unitAssess(Z2).guards.long.plan.stop);
});

test("ZA-3 the order in assess and guardrailsFor: the consensus, the quorum, then the guardrails' aimed plan before its checks, then the agents' copies", () => {
  const src = de.assess.toString();
  const at = (s) => { const i = src.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at("agentsConsensus(plans") < at("quorumOf(cards") && at("quorumOf(cards") < at("guardrailsFor(1") && at("guardrailsFor(1") < at("aimedAgentPlans(") && at("aimedAgentPlans(") < at("guards.long.plans = aimed"));
  assert.ok(at("agentConfidences(plans") > at("guards.long.plans = aimed"), "the agents' confidence reads `plans`, the base plans");
  assert.doesNotMatch(src, /agentConfidences\(guards/);
  const g = de.guardrailsFor.toString();
  assert.ok(g.indexOf("zoneAimHeld(") > 0 && g.indexOf("zoneAimHeld(") < g.indexOf('add("levels"'), "aimed before the levels, reward and zone_ahead checks");
  // The strategy engine's builders are untouched by Z2b.
  for (const f of [se.planForDirection, se.buildStrategy, se.ownTimeframePlan, se.tradeLevels]) assert.doesNotMatch(f.toString(), /zoneAim/);
});

// ---------------------------------------------------------------- tp_typed

test("ZA-4 'label': TP1's price deep-equals TP1-KZ's, its note gains the zone's words, TP2 goes to the next decisive opposing key zone", () => {
  const base = unitAssess(Z2), a = unitAssess(only("stop", "factor"));
  const b = pullback(base), p = pullback(a);
  assert.equal(p.tp1, b.tp1);
  assert.deepEqual([p.entry, p.stop, p.risk], [b.entry, b.stop, b.risk]);
  assert.equal(p.tp1_note, `${b.tp1_note} (supply, fresh)`);
  assert.deepEqual([b.tp2, p.tp2], [4022, 4030], "past the untyped key zone to the strong supply one");
  assert.equal(p.tp2_note, "the next strong supply key zone (fresh)");
  assert.deepEqual(p.rrr, { tp1: 1.5, tp2: 3 });
  assert.deepEqual(p.zone_types.tp2, { type: "supply", strength: "strong", freshness: "fresh" });
  assert.deepEqual(p.zone_rules, [{ rule: "tp_typed", base_tp1_r: 1.5, base_stop_atr: 1 }]);
  // The guardrails' own plan too (its targets are the same key zones here).
  assert.equal(a.guards.long.plan.tp2, 4030);
  assert.equal(a.guards.long.plan.tp1, base.guards.long.plan.tp1);
  // No decisive opposing key zone far enough: today's TP2; a non-opposing TP1 keeps its note.
  const zones = unitZones().map((z) => (z.label === "r3" ? { ...z, ds: ds("demand") } : z.label === "r1" ? { ...z, ds: ds("supply", "weak") } : z));
  const q = pullback(unitAssess(only("stop", "factor"), zones)), q0 = pullback(unitAssess(Z2, zones));
  assert.deepEqual(q, q0, "nothing to aim: the plan itself");
  // Agents with their own targets are unchanged; a structural stop is never skipped.
  const own = { entry: 4000, stop: 3990, risk: 10, tp1: 4015, tp1_note: "the middle of the range", tp2: 4022, tp2_note: "the top", rrr: { tp1: 1.5, tp2: 2.2 } };
  const s = unitStrategy();
  assert.equal(zoneAim(own, aroundSet(s.key_levels.zones, s.price), ctxOf(s, zoneAimMode(ON), { typedTargets: false, stopFromZones: false })), own);
});

test("ZA-5 'qualified': a decisive supply qualified zone at 1.3R, nearer than TP1, becomes TP1 (at or beyond ZONE_NEED)", () => {
  const zones = unitZones({ qualified: { low: 4013, high: 4014 } });
  const label = pullback(unitAssess(only("stop", "factor"), zones));
  assert.equal(label.tp1, 4015, "'label' never moves TP1");
  const p = pullback(unitAssess({ ...only("stop", "factor"), ZONE_AIM_TP: "qualified" }, zones));
  assert.equal(p.tp1, 4013);
  assert.equal(p.tp1_note, "the nearest medium supply zone ahead (fresh)");
  assert.deepEqual(p.rrr, { tp1: 1.3, tp2: 3 });
  assert.deepEqual(p.zone_types.tp1, { type: "supply", strength: "medium", freshness: "fresh" });
  assert.deepEqual(p.zone_rules, [{ rule: "tp_typed", base_tp1_r: 1.5, base_stop_atr: 1 }]);
  assert.ok(Math.abs(p.tp1 - p.entry) >= zoneNeed(p.risk, 10));
  assert.equal(ruleVersionOf({ ...ON, ZONE_AIM_TP: "qualified" }), "tp1_kz:on+zone_ahead@1+zone_aim@1:qualified");
});

test("ZA-6 TP1_KEY_ZONE_MODE off with Z2b on: tp_typed is inert (the legacy TP1 and TP2 stay)", () => {
  const env = (e) => ({ ...e, TP1_KEY_ZONE_MODE: "off" });
  const base = unitAssess(env(Z2)), a = unitAssess(env(only("stop", "factor")));
  assert.deepEqual(a.guards.long.plans, base.guards.long.plans);
  assert.deepEqual(a.guards.long.plan, base.guards.long.plan);
  assert.equal(pullback(a).tp2, 4022);
});

test("ZA-7 risk 0.5 ATR with an opposing qualified zone at 1.2R (0.6 ATR): never a typed TP1, and Z2's would_block is true: never both", () => {
  const strategy = unitStrategy([
    { low: 3994, high: 3996, price: 3995, candidate: true, label: "s0", ds: ds("demand") },
    { low: 4006, high: 4007, price: 4006.5, candidate: false, qualified: true, label: "q1", ds: ds("supply") },
    { low: 4020, high: 4021, price: 4020.5, candidate: true, label: "r1", ds: ds("supply") }
  ], 0);
  const plan = { entry: 4000, stop: 3995, risk: 5, tp1: 4020, tp1_note: "the r1 key zone", tp2: 4030, tp2_note: "a projection", rrr: { tp1: 4, tp2: 6 } };
  const around = aroundSet(strategy.key_levels.zones, strategy.price);
  const aimed = zoneAim(plan, around, ctxOf(strategy, zoneAimMode({ ...ON, ZONE_AIM_TP: "qualified" }), { stopFromZones: false }));
  assert.equal(aimed.tp1, 4020, "0.6 ATR is short of need max(0.5 ATR, 0.75 ATR)");
  const oa = zoneAhead(plan, around, { dir: 1, atrH1: 10, trend: 0 });
  assert.deepEqual([oa.room_r, oa.need_r, oa.would_block], [1.2, 1.5, true]);
  assert.equal(zoneAheadFails(oa, "trend"), true);
  // At 0.8 ATR (at or beyond need) such a zone is a typed TP1, and no block.
  const zones = strategy.key_levels.zones.map((z) => (z.label === "q1" ? { ...z, low: 4008, high: 4009 } : z));
  const at = zoneAim(plan, aroundSet(zones, 4000), ctxOf({ ...strategy, key_levels: { zones } }, zoneAimMode({ ...ON, ZONE_AIM_TP: "qualified" }), { stopFromZones: false }));
  assert.equal(at.tp1, 4008);
  assert.deepEqual([at.opposing_ahead.room_r, at.opposing_ahead.need_r, at.opposing_ahead.would_block], [1.6, 1.5, false]);
});

// ---------------------------------------------------------------- stop_skip

test("ZA-8 stop_skip: an opposing medium zone 0.6 ATR below a long's entry is skipped; the risk changes and opposing_ahead's room_r and need_r follow it", () => {
  // tp_typed on too: the guardrails' copy then still pays 1.5R to TP2 (stop alone: 1.1R, held 'rrr').
  const base = unitAssess(Z2), a = unitAssess(only("factor"));
  const b = base.guards.long.plan, p = a.guards.long.plan;
  assert.equal(b.zone_types.stop.type, "supply");
  assert.deepEqual([b.stop, b.risk, p.stop, p.risk], [3990, 10, 3980, 20]);
  assert.equal(p.stop_note, "beyond the 3982.00–3984.00 key zone (s2)");
  assert.deepEqual(p.zone_types.stop, { type: "demand", strength: "medium", freshness: "fresh" });
  assert.deepEqual([p.entry, p.tp1, p.tp2], [b.entry, b.tp1, 4030]);
  assert.deepEqual(p.rrr, { tp1: 0.75, tp2: 1.5 });
  assert.deepEqual(p.zone_rules, [{ rule: "stop_skip", base_tp1_r: 1.5, base_stop_atr: 1 }, { rule: "tp_typed", base_tp1_r: 1.5, base_stop_atr: 1 }]);
  const held = unitAssess(only("tp", "factor")).guards.long.plan;
  assert.deepEqual([held.stop, held.zone_rules], [3990, [{ rule: "stop_skip", held: "rrr" }]], "stop alone: 1.1R to TP2, the base is kept");
  // zoneAhead last, on the final entry and stop.
  const around = aroundSet(unitStrategy().key_levels.zones, 4000);
  assert.deepEqual(p.opposing_ahead, zoneAhead(p, around, { dir: 1, atrH1: 10, trend: 0.3 }));
  assert.deepEqual([b.opposing_ahead.room_r, p.opposing_ahead.room_r], [1.5, 0.75]);
  assert.equal(p.opposing_ahead.need_r, Math.round((zoneNeed(p.risk, 10) / p.risk) * 100) / 100);
  // A tighter base (risk 0.7 ATR, need 0.75 ATR): need_r moves with the skip.
  const tight = unitZones().map((z) => (z.label === "s1" ? { ...z, low: 3994.9, high: 3995.5 } : z));
  const t0 = unitAssess(Z2, tight).guards.long.plan, t1 = unitAssess(only("factor"), tight).guards.long.plan;
  assert.deepEqual([t0.risk, t0.opposing_ahead.need_r, t1.risk, t1.opposing_ahead.need_r], [7.1, 1.06, 20, 1]);
  // The guardrails' reward check reads the aimed plan.
  assert.match(a.guards.long.checks.find((c) => c.id === "reward").detail, /^1\.5R to the best target/);
});

test("ZA-9 stop_skip over the 2.5 ATR cap: the 1.5 ATR fallback applies", () => {
  const zones = unitZones({ next: { low: 3970, high: 3972 } });
  const p = unitAssess(only("factor"), zones).guards.long.plan;
  assert.deepEqual([p.stop, p.risk, p.stop_note], [3985, 15, "1.5 times the 1H average range"]);
  assert.equal(p.zone_types.stop, null);
  assert.deepEqual(p.zone_rules.map((r) => r.rule), ["stop_skip", "tp_typed"]);
  // A demand zone under a long (its own type) is not skipped: today's stop.
  const own = unitZones().map((z) => (z.label === "s1" ? { ...z, ds: ds("demand") } : z));
  assert.deepEqual(unitAssess(only("tp", "factor"), own).guards.long.plan, unitAssess(Z2, own).guards.long.plan);
  // A plan whose stop is not today's zone stop (a fallback, a structural stop) is kept.
  const s = unitStrategy();
  const plan = { entry: 4000, stop: 3988, risk: 12, tp1: 4015, tp1_note: "x", tp2: 4022, tp2_note: "y", rrr: { tp1: 1.25, tp2: 1.83 } };
  assert.equal(zoneAim(plan, aroundSet(s.key_levels.zones, 4000), ctxOf(s, zoneAimMode(only("tp", "factor")))), plan);
});

test("ZA-10 an aimed copy that fails rrr.tp1 >= 1 keeps the base, with zone_rules held 'rrr'; a base that fails the gate is never aimed", () => {
  const base = unitAssess(Z2), a = unitAssess(ON);
  const { zone_rules, ...rest } = pullback(a);
  assert.deepEqual(rest, pullback(base), "the base, unchanged");
  assert.deepEqual(zone_rules, [{ rule: "stop_skip", held: "rrr" }, { rule: "tp_typed", held: "rrr" }]);
  // The guardrails' own plan has no 1R floor: its copy passes 1.5R to TP2 and trades.
  assert.deepEqual([a.guards.long.plan.stop, a.guards.long.plan.tp2], [3980, 4030]);
  const passes = (p) => p.rrr.tp1 >= 1;
  const s = unitStrategy();
  const failing = { ...pullback(base), rrr: { tp1: 0.5, tp2: 2.2 } };
  assert.equal(zoneAimHeld(failing, aroundSet(s.key_levels.zones, 4000), ctxOf(s, zoneAimMode(ON)), passes), failing);
});

// ---------------------------------------------------------------- pickStrategy's factor

test("ZA-11 pickStrategy: all untyped deep-equals Z2's; 1.2 beats an equal untyped plan; 0.85 never outranks an at-level plan", () => {
  const QUORUM = { long_share: 0.7, short_share: 0.2, neutral_share: 0.1, score: 0.5, bias: "BULLISH" };
  const plan = (extra = {}) => ({ entry: 4000, stop: 3990, tp1: 4020, tp2: 4030, rrr: { tp1: 2, tp2: 3 }, risk: 10, at_level: true, entry_note: "e", stop_note: "s", tp1_note: "t1", tp2_note: "t2", ...extra });
  const words = (type, freshness = "fresh", strength = "medium") => ({ zone_types: { entry: { type, strength, freshness }, stop: null, tp1: null, tp2: null } });
  const pick = (plans, zoneFactor, conf = {}) => de.pickStrategy({ side: "long", speakers: Object.keys(plans).map((id) => ({ id, voice: 1 })), plans: Object.fromEntries(Object.entries(plans).map(([id, p]) => [id, { status: "live", plan: p }])), agentConfidence: Object.fromEntries(Object.keys(plans).map((id) => [id, { long: conf[id] ?? 0.6 }])), quorum: QUORUM, strategy: { direction: "LONG", alignment: 0.5 }, armed: [], stance: "BUY", opts: {}, zoneAhead: "trend", ...(zoneFactor ? { zoneFactor: true } : {}) });
  const untyped = { [DEFAULT_AGENT]: plan(), sweep_reversal: plan({ rrr: { tp1: 2.5, tp2: 3 } }) };
  assert.deepEqual(pick(untyped, true), pick(untyped, false), "untyped: no factor key, the same scores");
  // An own-type fresh entry (1.2) beats an equal untyped plan that wins without the factor (its better reward).
  const typed = { [DEFAULT_AGENT]: plan(words("demand")), sweep_reversal: plan({ rrr: { tp1: 2.5, tp2: 3 } }) };
  assert.equal(pick(typed, false).agent, "sweep_reversal");
  const on = pick(typed, true);
  assert.equal(on.agent, DEFAULT_AGENT);
  assert.deepEqual(on.candidates.map((c) => [c.id, c.zone_factor ?? null, c.score]), [[DEFAULT_AGENT, 1.2, 0.53], ["sweep_reversal", null, 0.44]]);
  assert.equal(on.score, 0.53);
  // Eligibility and the WAIT are unchanged by the factor.
  const low = pick({ [DEFAULT_AGENT]: plan(words("demand")) }, true, { [DEFAULT_AGENT]: 0.35 });
  assert.deepEqual([low.agent, low.candidates[0].eligible], [null, false]);
  // 0.85 (opposite type at level) never loses to 1.2 (own type, not at level) at equal confidence, whatever the share and alignment.
  for (const share of [0, 0.25, 0.5, 0.75, 1]) for (const alignment of [0, 0.25, 0.5, 0.75, 1]) {
    const r = de.pickStrategy({ side: "long", speakers: [{ id: "sweep_reversal", voice: 1 }, { id: DEFAULT_AGENT, voice: 1 }], plans: { sweep_reversal: { status: "live", plan: plan({ at_level: true, ...words("supply") }) }, [DEFAULT_AGENT]: { status: "live", plan: plan({ at_level: false, ...words("demand") }) } }, agentConfidence: { sweep_reversal: { long: 0.6 }, [DEFAULT_AGENT]: { long: 0.6 } }, quorum: { ...QUORUM, long_share: share }, strategy: { direction: "LONG", alignment }, armed: [], stance: "BUY", opts: {}, zoneFactor: true });
    assert.equal(r.agent, "sweep_reversal", `share ${share} alignment ${alignment}`);
  }
  assert.equal(zoneFactorOf(plan(words("demand", "worn")), 1), 1, "a worn own-type zone");
  assert.equal(zoneFactorOf(plan(words("demand", "fresh", "weak")), 1), 1, "a weak zone is not decisive");
  assert.equal(zoneFactorOf(plan(words("supply", "tested")), -1), 1.2, "own type of a short");
  assert.equal(zoneFactorOf(plan(), 1), null);
  // decide() passes the factor only while 'factor' is on; there is no PICK_LOCATION switch in this tree to combine with.
  assert.match(de.decide.toString(), /g\.zone_aim\?\.factor \? \{ zoneFactor: true \}/);
  assert.equal(readFileSync(new URL("../src/decision-engine.mjs", import.meta.url), "utf8").includes("PICK_LOCATION"), false);
});

// ---------------------------------------------------------------- the record

test("ZA-12 zone_rules: only rule, base_tp1_r and base_stop_atr, on the trade and strategy_plans; absent when nothing changed; never in the council, a card or public output", () => {
  const loaded = unitLoaded();
  const env = { ...UNIT_ENV, ...only("stop", "factor"), STRATEGY_EXECUTION: "off" };
  const a = de.assess(loaded, { now: NOW, env });
  const rec = de.buildDecisionRecord({ key: KEY, barClose: CLOSE, loaded, assessment: a, council: BUY, now: NOW, env });
  assert.equal(rec.stance, "BUY");
  assert.deepEqual(rec.trade.zone_rules, [{ rule: "tp_typed", base_tp1_r: 1.5, base_stop_atr: 1 }]);
  assert.deepEqual(rec.strategy_plans.long[DEFAULT_AGENT].zone_rules, rec.trade.zone_rules);
  for (const r of rec.trade.zone_rules) assert.deepEqual(Object.keys(r), ["rule", "base_tp1_r", "base_stop_atr"]);
  // The base rebuilt from the entry and the distances (Z5, MS2's base arm).
  assert.deepEqual(zoneAimBase(rec.trade, rec.strategy.atr_h1, 1), { entry: 4000, stop: 3990, tp1: 4015 });
  // Nothing moved: no zone_rules anywhere (the label alone is no rule).
  const none = de.buildDecisionRecord({ key: KEY, barClose: CLOSE, loaded: bearLoaded(), assessment: de.assess(bearLoaded(), { now: NOW, env: { ...ZONE_ENV, ...ON } }), council: SELL, now: NOW, env: { ...ZONE_ENV, ...ON } });
  assert.equal(JSON.stringify(none).includes("zone_rules"), false);
  // The council, the cards, the EA signal's keys and the public output.
  const ev = de.councilEvidence({ barClose: CLOSE, cards: a.cards, quorum: a.quorum, guards: a.guards });
  const text = JSON.stringify([ev, de.councilMessages(ev), a.cards]);
  for (const k of ["zone_rules", "zone_factor", "zone_aim", "base_tp1_r", "base_stop_atr", "stop_skip", "tp_typed"]) assert.equal(text.includes(k), false, k);
  const signal = ea.eaSignalFromDecision({ decision: rec, now: NOW });
  const recap = pp.publicRecap({ decision_key: KEY, bar_close: CLOSE, stance: rec.stance, bias: rec.bias, decision_json: JSON.stringify(rec) });
  for (const out of [signal, ea.managementFields(rec), recap]) assert.equal(JSON.stringify(out).includes("zone_rules"), false);
  const z2 = de.buildDecisionRecord({ key: KEY, barClose: CLOSE, loaded, assessment: de.assess(loaded, { now: NOW, env: { ...env, ...Z2 } }), council: BUY, now: NOW, env: { ...env, ...Z2 } });
  assert.deepEqual(Object.keys(signal).sort(), Object.keys(ea.eaSignalFromDecision({ decision: z2, now: NOW })).sort(), "no new signal key");
  assert.deepEqual(recap, pp.publicRecap({ decision_key: KEY, bar_close: CLOSE, stance: z2.stance, bias: z2.bias, decision_json: JSON.stringify(z2) }));
  assert.deepEqual(pp.recapLeaks(recap), []);
  // The words the rules add carry no price.
  for (const s of [rec.trade.tp2_note ?? "", a.guards.long.plans[DEFAULT_AGENT].plan.tp2_note, a.guards.long.plans[DEFAULT_AGENT].plan.tp1_note.replace(/^.*\) /, "")]) assert.doesNotMatch(s, pp.PRICE_LIKE, s);
});

test("ZA-13 MS2's shadow replay reads zone_rules as recorded and keeps a base arm", async () => {
  const loaded = unitLoaded();
  const env = { ...UNIT_ENV, ...only("stop", "factor"), STRATEGY_EXECUTION: "off" };
  const assessment = de.assess(loaded, { now: NOW, env });
  const rows = de.shadowModeDecisions({ loaded, assessment, council: BUY, env, now: NOW });
  const trading = rows.filter((r) => r.stance === "BUY");
  assert.ok(trading.length >= 1);
  for (const r of trading) {
    const a = de.assess(loaded, { now: NOW, env: { ...env, TRADING_MODE: r.mode }, witnesses: { cards: assessment.cards, quorum: assessment.quorum, market: assessment.market } });
    assert.deepEqual(r.plans[DEFAULT_AGENT].zone_rules, a.guards.long.plans[DEFAULT_AGENT].plan.zone_rules, r.mode);
    assert.deepEqual(r.trade.zone_rules, r.plans[DEFAULT_AGENT].zone_rules);
  }
  // The rows as written: plans_json keeps zone_rules; the base arm comes from them and the entry.
  const record = de.buildDecisionRecord({ key: KEY, barClose: CLOSE, loaded, assessment, council: BUY, now: NOW, env });
  const db = d1();
  const run = { DB: db, ...env };
  assert.equal(await writeShadowPlans(run, { record, rows, now: NOW }), trading.length);
  const stored = db.raw.prepare("SELECT mode, plans_json, rule_version FROM mode_shadow_plans ORDER BY mode").all();
  for (const s of stored) {
    const p = JSON.parse(s.plans_json);
    assert.deepEqual(p.long[DEFAULT_AGENT].zone_rules, trading.find((r) => r.mode === s.mode).plans[DEFAULT_AGENT].zone_rules);
    assert.equal(s.rule_version, "tp1_kz:on+zone_ahead@1+zone_aim@1:no_stop:no_factor");
    const plan = p.long[DEFAULT_AGENT];
    assert.deepEqual(plan.zone_rules, [{ rule: "tp_typed", base_tp1_r: 1.5, base_stop_atr: 1 }], s.mode);
    assert.equal(plan.tp2, 4030, "the aimed TP2 as traded");
    assert.deepEqual(zoneAimBase(plan, record.strategy.atr_h1, 1), { entry: 4000, stop: 3990, tp1: 4015 }, `${s.mode}: the base arm`);
  }
});

test("ZA-14 rule_version gains zone_aim@1 by the existing composition; inert Z2b leaves it as before", () => {
  assert.equal(ZONE_AIM_RULE, "zone_aim@1");
  assert.equal(ruleVersionOf({}), "tp1_kz:on");
  assert.equal(ruleVersionOf(ON), "tp1_kz:on+zone_ahead@1+zone_aim@1", "the live value with wrangler.jsonc's switches");
  assert.equal(ruleVersionOf(Z2), "tp1_kz:on+zone_ahead@1", "Z2's value");
  assert.equal(ruleVersionOf(only("stop")), "tp1_kz:on+zone_ahead@1+zone_aim@1:no_stop");
  assert.equal(ruleVersionOf({ ...ON, ZONE_AHEAD_MODE: "record" }), "tp1_kz:on+zone_aim@1");
  assert.equal(ruleVersionOf({ ...ON, TP1_KEY_ZONE_MODE: "off" }), "tp1_kz:off+zone_ahead@1+zone_aim@1");
  assert.equal(zoneAimRuleToken({ ...ON, KEY_LEVEL_ZONE_TYPES: "off" }), null);
});

// ---------------------------------------------------------------- off pins

// Hashes taken with the same code (pins below) on a git-archive of main 3958d7c, before Z2b: ZONE_PRIORITY unset, and
// ZONE_PRIORITY "on" with ZONE_AHEAD_MODE "trend" (Z2 alone). Re-pinned at ZF1 (2026-11-25, owner "ZF1 tepi kotak"): a box now types
// the cluster its own edge is a member of (src/zone-types.mjs boxTypes), which retypes four of the fixture's zones
// (test/zone-box-edge.test.mjs ZF1-4); scenario, prophet and bear_record move with them. capture_guards (the frozen real
// capture) and bear_shadow do not move.
const MAIN_OFF = Object.freeze({ scenario: "700d9ca09c3e2eaa30388c50a7e13289a54f2f79f391de460fc579a240e5dbf4", prophet: "5ffced8ed75a4ae16eb02bcde7f5be3b05d3cf22e9b835b5c75932c87c7820dd", bear_record: "4a4fefe4e21d1506fa4422699863a3a140804ef283987e64fae37d23439bb8b1", bear_shadow: "446c8ed55cb77c00d009a461acd2c7b0ce9bb780393a16b06f655cdd5bb2ce47", capture_guards: "3ea80a7bb7411e5961688d98fae012b6be293edb6bb57ac1af47c5932a3da62c" });
const MAIN_Z2 = Object.freeze({ scenario: "86de542f6ee55e3259f7c2cdde99cb4dfa56106ccb3076dab831a3fb83e2b911", prophet: "a1ccadd1d543a31746dc3fd7c45272b905030082b8444994513f3ebac40b1344", bear_record: "28abe8118a6100e2586879dfddb7b3410acf76356df25b75f1e9e4afd9444ee9", bear_shadow: "64a260966e20318321db9acc6fe6377b3c4ec1696135e736e6c274f16201e3d1", capture_guards: "d49f7563079ca0dbb6a74d3255893642ea727c540dda37f3829062a7b0f4bde9" });
async function pins(extra) {
  const out = {};
  for (const prophet of [false, true]) {
    const { run, ...rest } = await zoneScenario(mods, { db: d1, kv, env: extra, prophet });
    out[prophet ? "prophet" : "scenario"] = sha(withoutDsSources(rest));
  }
  const loaded = bearLoaded(), env = { ...ZONE_ENV, ...extra };
  const a = de.assess(loaded, { now: NOW, env });
  out.bear_record = sha(withoutDsSources(de.buildDecisionRecord({ key: KEY, barClose: CLOSE, loaded, assessment: a, council: SELL, now: NOW, env })));
  out.bear_shadow = sha(de.shadowModeDecisions({ loaded, assessment: a, council: SELL, env, now: NOW }));
  const slim = await gunzipJson(CAPTURE_2026_11_20_22);
  const strategy = se.buildStrategy(slim);
  const Q = { long_share: 0.8, short_share: 0.1, neutral_share: 0.1, score: 0.6, bias: "BULLISH" };
  out.capture_guards = sha([1, -1].map((dir) => de.guardrailsFor(dir, { cards: [], quorum: Q, strategy, inputs: slim, now: slim.now, env: extra })));
  return out;
}

test("ZA-15 ZONE_PRIORITY off: the scenario, the zone-held SELL, MS2's shadows and the frozen capture's guardrails are byte-identical to main 3958d7c; every Z2b rule off is Z2's output", async () => {
  assert.deepEqual(await pins({}), MAIN_OFF);
  assert.deepEqual(await pins({ ZONE_PRIORITY: "off", ZONE_AIM_OFF: "", ZONE_AIM_TP: "qualified" }), MAIN_OFF);
  assert.deepEqual(await pins(Z2), MAIN_Z2);
});

test("ZA-16 the frozen 2026-11-20 22:00 capture: Z2b moves no price there, labels the long's supply TP1 and keeps Z2's zone_ahead verdicts", async () => {
  const slim = await gunzipJson(CAPTURE_2026_11_20_22);
  const strategy = se.buildStrategy(slim);
  const Q = { long_share: 0.8, short_share: 0.1, neutral_share: 0.1, score: 0.6, bias: "BULLISH" };
  for (const mode of ["scalp", "intraday", "swing"]) for (const dir of [1, -1]) {
    const g = (env) => de.guardrailsFor(dir, { cards: [], quorum: Q, strategy, inputs: slim, now: slim.now, env: { ...env, TRADING_MODE: mode } });
    const a = g(ON), b = g(Z2);
    for (const k of ["entry", "stop", "tp1", "tp2", "risk", "rrr", "opposing_ahead"]) assert.deepEqual(a.plan?.[k], b.plan?.[k], `${mode} ${dir} ${k}`);
    assert.deepEqual(a.checks.map((c) => [c.id, c.pass]), b.checks.map((c) => [c.id, c.pass]));
    assert.equal("zone_rules" in (a.plan ?? {}), false);
    if (a.plan) assert.ok(a.plan.tp1_note.startsWith(b.plan.tp1_note));
    if (mode === "scalp" && dir === 1) assert.match(a.plan.tp1_note.slice(b.plan.tp1_note.length), /^ \(supply, (fresh|tested|worn)\)$/);
  }
});

test("ZA-17 no hashed engine function changes: ENGINE_CODE_HASH recomputes to 0caa6260… (variant B, the lens rollover on the NY clock, moved it, after the DST rollover quarantine, after E1 limit-first, after K1, after Track B PR 19, Track B PR 18, Track B PR 17, Track A PR 5, the Z6 sd marker, Z6, B5 and Z3a); the behaviour hash is ecfe3f90…", async () => {
  assert.equal(await sha256Hex(engineCodeSource()), ENGINE_CODE_HASH);
  assert.equal(ENGINE_CODE_HASH, "0caa626023a8c7838f430273db672b5d28c9b45df8dee3d6bb4ef89eb0454541");
  assert.equal(ENGINE_BEHAVIOUR_HASH, "d0c07f020f44f9694b794aafa73684488aaf55848fdabdf0fa9a67804b916e65");
});

// ---------------------------------------------------------------- shipped inert (orchestrator ruling 2026-11-25)

// Track A PR 7: orb_breakout is off here (its London plan in this scenario is ORB-8's), so the pin stays main 6135237's.
const LIVE_VARS = Object.freeze({ ...wranglerVars(new URL("../wrangler.jsonc", import.meta.url)), STRATEGY_AGENTS_OFF: "orb_breakout" });
// test/support/zone-aim-inert.mjs's outputs under main 6135237's own wrangler.jsonc vars (before Z2b), on a git-archive of it;
// re-pinned at ZF1 (the fixture's typing only, as MAIN_OFF above; capture and the EA signals and management do not move).
const MAIN_6135237_INERT = Object.freeze({"z0_buy": {"messages": "bd4560647bafb488985c6db2929917829706198d71d973a0b4e96922d1fd0710", "guards": "0291df72c0d41c135fa071b1c07c2e00ea89c6e34f7ff5d02aecf1cae01d7351", "trade": "99c810fe11d213c6a51d77ed583d714efff53d183e205eedf9459d4e63ac0cd5", "strategy_plans": "ae13f3e07976a622126f9813b44bb651012c72d27db479c6e0584db00ebc8096", "record": "512ba21772da82a1087cc9ad4b41fddcf48f9170b15298d53e0ac958624eb2e5", "signal": "dcaade6e07a65a73d55d895a61516476098beee5c8d7a62f54febd741ebafaf6", "management": "51e714db2275fd3293b5ea8d205d18b68df9e98172cd8c875625073094ae26a7", "shadow": "5855284a6213033c11e047580bf1b7e97ece0b94c3932bae810b31896039beec", "stance": "BUY"}, "z0_sell": {"messages": "9f12838d0c160f24de3dc265dbfb473bf6322e066d287ae3eb77c8990b115b1f", "guards": "93add1ded930acda3cf5b083a5efc8909a4c0d58e3aa9247a43fed37f54a3c72", "trade": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b", "strategy_plans": "ae13f3e07976a622126f9813b44bb651012c72d27db479c6e0584db00ebc8096", "record": "60857b51c3ccfa7d3005bea77416a71848d3e98322083a65c25fbeaba18d354e", "signal": "da196d1a4940b9ec66441113e06f1a6647725c14f328cb6af880ba9af576edb0", "management": "47d4b9ab1786d3fba184388c51efadaf969b8a14fec397a33d88b05babca1ab2", "shadow": "64a260966e20318321db9acc6fe6377b3c4ec1696135e736e6c274f16201e3d1", "stance": "WAIT"}, "prophet_buy": {"messages": "24a39d659a473fb1ef97515b450ba1bbc8e1f7cf6576f9ffe641f85da83c0a9d", "guards": "ba64c465a7207605e3e52007e0be1828d410faaee90621c301958e739854dcd8", "trade": "d4df1dd3a2070d84f86ad611699774bfd025e1e961e7f2b22fe36d96af32e8bf", "strategy_plans": "eaf36e4376006310eb5e61aca1e81c60ece45635e54f17c1d4e31b7cf377e2ec", "record": "dc5543dbf6233f9c79052f4c8fdf5abb2e27cd9ccb3bdaaccfffa7a15977890f", "signal": "dcaade6e07a65a73d55d895a61516476098beee5c8d7a62f54febd741ebafaf6", "management": "51e714db2275fd3293b5ea8d205d18b68df9e98172cd8c875625073094ae26a7", "shadow": "f0a486bf95a5038fef6af4b0e5334b3bd7f93b6bf445231fd91aad5b828b26dd", "stance": "BUY"}, "prophet_sell": {"messages": "23930fed36f7539719e7a45eeaa9e131fa50ee748e4ce72c2ef6296ead770732", "guards": "4d3e07a79975ee99c1f13f7defac4ef45956658e2cca1766f00e0dd0302073d5", "trade": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b", "strategy_plans": "eaf36e4376006310eb5e61aca1e81c60ece45635e54f17c1d4e31b7cf377e2ec", "record": "263c63eb74658bf6016e905c7376130ab9e56ffbf774e8b8d907664698b1c11c", "signal": "da196d1a4940b9ec66441113e06f1a6647725c14f328cb6af880ba9af576edb0", "management": "47d4b9ab1786d3fba184388c51efadaf969b8a14fec397a33d88b05babca1ab2", "shadow": "64a260966e20318321db9acc6fe6377b3c4ec1696135e736e6c274f16201e3d1", "stance": "WAIT"}, "capture": "d49f7563079ca0dbb6a74d3255893642ea727c540dda37f3829062a7b0f4bde9"});

test("ZA-18 shipped inert: under the live wrangler.jsonc vars (ZONE_PRIORITY on, ZONE_AIM_OFF tp,stop,factor) the council's messages, the plans, the trade, strategy_plans, the record, the EA signal, managementFields and MS2's rows are main 6135237's byte for byte", async () => {
  assert.equal(LIVE_VARS.ZONE_PRIORITY, "on");
  assert.equal(LIVE_VARS.ZONE_AHEAD_MODE, "trend");
  assert.equal(LIVE_VARS.ZONE_AIM_OFF, "tp,stop,factor");
  assert.equal(LIVE_VARS.ZONE_AIM_TP, "label");
  assert.equal(zoneAimMode(LIVE_VARS), null, "every rule off: Z2b is inert");
  const fx = { zoneInputs, CLOSE, NOW, capture: CAPTURE_2026_11_20_22 };
  const got = await inertOutputs({ se, de, ea, gunzipJson }, fx, { ...LIVE_VARS });
  assert.deepEqual(got, MAIN_6135237_INERT);
  // Not vacuous: one rule on changes what the council reads (TP1's words in tp1_note).
  const tp = await inertOutputs({ se, de, ea, gunzipJson }, fx, { ...LIVE_VARS, ZONE_AIM_OFF: "stop,factor" });
  assert.notEqual(tp.z0_buy.messages, MAIN_6135237_INERT.z0_buy.messages);
});

test("ZA-19 rule_version under the live vars: exactly Z2's while inert; the zone_aim token only with a rule on", () => {
  assert.equal(ruleVersionOf(LIVE_VARS), "tp1_kz:on+zone_ahead@1");
  assert.equal(zoneAimRuleToken(LIVE_VARS), null);
  assert.equal(ruleVersionOf({ ...LIVE_VARS, ZONE_AIM_OFF: "stop,factor" }), "tp1_kz:on+zone_ahead@1+zone_aim@1:no_stop:no_factor");
  assert.equal(ruleVersionOf({ ...LIVE_VARS, ZONE_AIM_OFF: "tp,factor" }), "tp1_kz:on+zone_ahead@1+zone_aim@1:no_tp:no_factor");
  assert.equal(ruleVersionOf({ ...LIVE_VARS, ZONE_AIM_OFF: "tp,stop" }), "tp1_kz:on+zone_ahead@1+zone_aim@1:no_tp:no_stop");
  assert.equal(ruleVersionOf({ ...LIVE_VARS, ZONE_AIM_OFF: "" }), "tp1_kz:on+zone_ahead@1+zone_aim@1");
});
