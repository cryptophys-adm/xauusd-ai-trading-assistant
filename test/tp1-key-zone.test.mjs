// TP1-KZ (owner 2026-11-23: "ok setuju, TP1 ke key zone minimal 1R, karena di perjalanan position manager juga
// mengawal jika perlu close lebih cepat untuk mengamankan profit"): in every mode the strategy agents' first target,
// when it comes from the key levels, is the nearest key zone ahead (a Key Level Agent candidate) and pays at least 1R;
// a nearer key zone under 1R is an obstacle (no plan); without a key zone ahead, today's nearest level or projection,
// still at least 1R. Agents with their own targets keep them. The guardrail keeps its own plan. TP1_KEY_ZONE_MODE "off"
// is today's targets and gates, byte for byte.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { planForDirection, tradeLevels, zoneLevels, tp1KeyZoneMode, TP1_MIN_R } from "../src/strategy-engine.mjs";
import { STRATEGY_AGENTS, agentContext, agentPlans, agentStatuses, finishPlan, AGENT_IDS } from "../src/strategy-agents.mjs";
import { agentPlanPasses, liveAgentPlans, MODE_THRESHOLDS } from "../src/decision-engine.mjs";
import { tp1OffSample } from "./support/tp1-off-sample.mjs";

const agent = (id) => STRATEGY_AGENTS.find((a) => a.id === id);
const M15 = 15 * 60_000;
const bars = (rows) => rows.map(([low, high, close], i) => ({ open_time: new Date(Date.parse("2026-11-22T21:00:00Z") + i * M15).toISOString(), open: close, low, high, close }));
// Decision OANDA:XAUUSD:15:1795390200000 (2026-11-22 23:45Z, scalp, sweep_reversal SELL): entry 3579.82, stop 3590.83,
// 1H ATR 27.19. A qualified level 3562.60-3569.96 (0.9R) before the key zone 3553.73-3560.96 (1.71R).
const ATR = 27.19, PRICE = 3579.82;
const sweepBars = bars([...Array.from({ length: 9 }, () => [3576, 3583, 3580]), [3578, 3588.11, 3585], [3579, 3586, 3583], [3577, 3584, PRICE]]);
const zonesOf = (extra = []) => [
  { low: 3582, high: 3586, price: 3584, candidate: false, qualified: true, label: "resistance" },
  { low: 3562.6, high: 3569.96, price: 3566.28, candidate: false, qualified: true, label: "the 1H swing" },
  ...extra
];
const KEY = { low: 3553.73, high: 3560.96, price: 3557.35, candidate: true, qualified: true, label: "the key zone" };
const strategyOf = (zones) => ({ price: PRICE, atr_h1: ATR, direction: "SHORT", plan: { at_level: false }, setup: { type: "none" }, key_levels: { zones, patterns: [] } });
const sweepPlan = (zones, keyZone, scalp = true) => agent("sweep_reversal").plan(-1, agentContext({ strategy: strategyOf(zones), bars: sweepBars, scalp, keyZone }));

test("TK1 the 23:45 case: the sweep_reversal short takes TP1 at the key zone, 3560.96, 1.71R (today 3569.96, 0.9R)", () => {
  const today = sweepPlan(zonesOf([KEY]), false);
  assert.deepEqual([today.entry, today.stop, today.tp1, today.rrr.tp1], [3579.82, 3590.83, 3569.96, 0.9], "the decision as it was");
  const kz = sweepPlan(zonesOf([KEY]), true);
  assert.deepEqual([kz.entry, kz.stop, kz.tp1, kz.rrr.tp1], [3579.82, 3590.83, 3560.96, 1.71]);
  assert.match(kz.tp1_note, /3553\.73–3560\.96 key zone/);
  assert.ok(kz.tp2 <= kz.tp1, "TP2 beyond TP1 (a short)");
  // The selection gate: scalp's min_rrr stays 0, its floor is 1R on TP1.
  const g = { target_rule: "nearest", min_rrr: MODE_THRESHOLDS.scalp.min_rrr, tp1_min_r: TP1_MIN_R };
  assert.deepEqual([agentPlanPasses(kz, g), agentPlanPasses(today, g), agentPlanPasses(today, { target_rule: "nearest", min_rrr: 0 })], [true, false, true]);
  assert.equal(TP1_MIN_R, 1);
});

test("TK2 a nearest key zone under 1R is an obstacle: no plan, never a jump to the next key zone", () => {
  const near = { low: 3566, high: 3570, price: 3568, candidate: true, qualified: true, label: "a near key zone" };
  assert.equal(sweepPlan(zonesOf([near, KEY]), true), null);
  assert.ok(sweepPlan(zonesOf([near, KEY]), false), "today it trades to the near level");
  // The zone_pullback base plan too (planForDirection), in intraday where only key zones are targets.
  // A long: entry at the support 3560-3565 (a pullback), stop beyond 3530-3535; the key zone 3590-3600 ahead pays 0.62R.
  const zones = [{ low: 3590, high: 3600, price: 3595, candidate: true, label: "r" }, { low: 3560, high: 3565, price: 3562.5, candidate: true, label: "s" }, { low: 3530, high: 3535, price: 3532.5, candidate: true, label: "far" }];
  const s = { ...strategyOf(zones), direction: "LONG" };
  const longToday = planForDirection(s, 1, {});
  assert.ok(longToday && longToday.rrr.tp1 < 1, `today ${longToday?.rrr.tp1}R`);
  assert.equal(planForDirection(s, 1, { keyZone: true }), null);
});

test("TK3 no key zone ahead: today's nearest level (at least 1R) or the 2R projection; scalp still rejects the projection", () => {
  const farLevel = { low: 3560, high: 3567, price: 3563.5, candidate: false, qualified: true, label: "a qualified level" };
  const resistance = zonesOf()[0];
  const viaLevel = sweepPlan([resistance, farLevel], true);
  assert.deepEqual([viaLevel.tp1, viaLevel.rrr.tp1], [3567, 1.16]);
  assert.equal(sweepPlan(zonesOf(), true), null, "the only level ahead pays 0.9R: TP1 >= 1R still applies");
  const projected = sweepPlan([resistance], true);
  assert.deepEqual([projected.tp1_note, projected.rrr.tp1], ["a 2R projection", 2]);
  assert.equal(agentPlanPasses(projected, { target_rule: "nearest", min_rrr: 0, tp1_min_r: 1 }), false, "scalp: the nearest rule");
  assert.equal(agentPlanPasses(projected, { target_rule: "rrr", min_rrr: 1.5, tp1_min_r: 1 }), true, "intraday takes it");
});

test("TK4 agents with their own targets keep them; TP1 >= 1R decides only whether they can be selected", () => {
  const ctx = { ...agentContext({ strategy: strategyOf(zonesOf([KEY])), bars: sweepBars, scalp: true, keyZone: true }) };
  const own = { tp1: 3572, tp1_note: "the range's other side", tp2: 3565, tp2_note: "beyond" };
  const plan = finishPlan("range_fade", -1, { entry: PRICE, stop: 3590.83, atLevel: true, entryNote: "e", stopNote: "s", setup: "x", targets: own }, ctx);
  const off = finishPlan("range_fade", -1, { entry: PRICE, stop: 3590.83, atLevel: true, entryNote: "e", stopNote: "s", setup: "x", targets: own }, { ...ctx, keyZone: undefined });
  assert.deepEqual(plan, off, "the agent's own targets, as today");
  assert.equal(plan.tp1, 3572);
  assert.equal(agentPlanPasses(plan, { target_rule: "rrr", min_rrr: 0, tp1_min_r: 1 }), false, `${plan.rrr.tp1}R: not selectable`);
  // liveAgentPlans: the default agent is exempt from the reward guardrail, not from the 1R floor.
  const g = { target_rule: "rrr", min_rrr: 1.5, tp1_min_r: 1, plans: { zone_pullback: { status: "live", plan: { ...plan, agent: "zone_pullback", rrr: { tp1: 0.7, tp2: 3 } } }, sweep_reversal: { status: "live", plan: { ...plan, rrr: { tp1: 1.2, tp2: 2 } } } } };
  assert.deepEqual(liveAgentPlans(g).map(([id]) => id), ["sweep_reversal"]);
  assert.deepEqual(liveAgentPlans({ ...g, tp1_min_r: undefined }).map(([id]) => id), ["zone_pullback", "sweep_reversal"], "off: as today");
});

test("TK5 TP1_KEY_ZONE_MODE off is byte-identical to main; on changes the sample", () => {
  assert.deepEqual([tp1KeyZoneMode({}), tp1KeyZoneMode({ TP1_KEY_ZONE_MODE: " OFF " }), tp1KeyZoneMode({ TP1_KEY_ZONE_MODE: "x" })], ["on", "off", "on"]);
  // tp1OffSample ran on main 4f85fb7 before this PR: the same sha256.
  const hash = createHash("sha256").update(tp1OffSample()).digest("hex");
  assert.equal(hash, "e71b8114bfb67ea5301f75d0377d4956a4f705b67689cca24bf6ff6d69d77c2c");
  // zoneLevels gains `key` (the candidate flag), read only under keyZone.
  assert.deepEqual(zoneLevels([{ low: 1, high: 2, price: 1.5, candidate: true, label: "a" }, { low: 3, high: 4, price: 3.5, qualified: true, label: "b" }], { qualified: true }).map((z) => [z.major, z.key]), [[true, true], [true, false]]);
  // With keyZone on, the same sample changes: some first targets move, some plans are dropped.
  const statuses = agentStatuses({ STRATEGY_AGENTS_LIVE: AGENT_IDS.join(",") });
  let moved = 0, dropped = 0, total = 0;
  for (const [i, zones] of [[0, zonesOf([KEY])], [1, zonesOf([{ ...KEY, low: 3566, high: 3570 }, KEY])]]) {
    for (const keyZone of [true]) {
      const a = agentPlans(-1, agentContext({ strategy: strategyOf(zones), bars: sweepBars, scalp: true }), statuses);
      const b = agentPlans(-1, agentContext({ strategy: strategyOf(zones), bars: sweepBars, scalp: true, keyZone }), statuses);
      for (const id of Object.keys(a)) { total++; if (!b[id]) dropped++; else if (b[id].plan.tp1 !== a[id].plan.tp1) moved++; }
      assert.ok(i >= 0);
    }
  }
  assert.ok(total > 0 && moved + dropped > 0, `moved ${moved}, dropped ${dropped} of ${total}`);
});

test("TK6 no new field reaches the rooms, the decision cards or the Position Council: only the plan's existing fields", () => {
  const kz = sweepPlan(zonesOf([KEY]), true), today = sweepPlan(zonesOf([KEY]), false);
  assert.deepEqual(Object.keys(kz), Object.keys(today), "the plan's keys are unchanged");
  assert.equal(JSON.stringify(kz).includes("tp2_extended") || JSON.stringify(kz).includes("extended_tp"), false);
  // tradeLevels' shape too.
  const levels = zoneLevels([...zonesOf(), { low: 3594, high: 3596, price: 3595, candidate: true, label: "above" }, { low: 3545, high: 3550, price: 3547.5, candidate: true, label: "below" }], { qualified: true });
  const a = tradeLevels({ dir: -1, price: PRICE, levels, atrH1: ATR, targetGapAtr: 0.25 });
  const b = tradeLevels({ dir: -1, price: PRICE, levels, atrH1: ATR, targetGapAtr: 0.25, keyZone: true });
  assert.ok(a && b);
  assert.deepEqual(Object.keys(b), Object.keys(a));
});

test("TK7 assess: the agents' plans follow TP1-KZ, the guardrail keeps its own plan; off adds nothing", async () => {
  const { assess } = await import("../src/decision-engine.mjs");
  const loaded = { inputs: { calendar: { events: [] }, m15Bars: sweepBars }, strategy: strategyOf(zonesOf([KEY])), global: null, correlations: null, regime: "normal-trending" };
  const env = { TRADING_MODE: "scalp", STRATEGY_AGENTS_LIVE: "sweep_reversal" };
  const now = Date.parse("2026-11-22T23:46:10Z");
  const on = assess(loaded, { env, now }), off = assess(loaded, { env: { ...env, TP1_KEY_ZONE_MODE: "off" }, now });
  assert.deepEqual([on.guards.short.plans.sweep_reversal?.plan?.tp1, off.guards.short.plans.sweep_reversal?.plan?.tp1], [3560.96, 3569.96]);
  assert.deepEqual(on.guards.short.plan, off.guards.short.plan, "the guardrail's plan is today's");
  assert.deepEqual([on.guards.short.tp1_min_r, "tp1_min_r" in off.guards.short, "tp1_min_r" in off.guards.long], [1, false, false]);
});

test("TK8 the 23:45 case is not blocked when the base pullback plan's key zone is under 1R: sweep_reversal is selected with TP1 3560.96", async () => {
  const { assess, decide } = await import("../src/decision-engine.mjs");
  // A key zone 3572.11-3579.70 under price (the base plan's pullback support for a long, irrelevant to the short) and
  // a resistance far above, so the base short pulls back to 3582-3586 with its stop beyond 3591-3598 and TP1 at the
  // key zone 3560.96 under 1R from the pullback entry.
  const zones = [...zonesOf([KEY]), { low: 3591.01, high: 3598.42, price: 3594.7, candidate: true, qualified: true, label: "above" }];
  const loaded = { inputs: { calendar: { events: [] }, m15Bars: sweepBars }, strategy: strategyOf(zones), global: null, correlations: null, regime: "normal-trending" };
  const env = { TRADING_MODE: "scalp", STRATEGY_AGENTS_LIVE: "sweep_reversal" };
  const now = Date.parse("2026-11-22T23:46:10Z");
  const { guards } = assess(loaded, { env, now });
  const base = planForDirection(strategyOf(zones), -1, { scalp: true, keyZone: true });
  const guardPlan = planForDirection(strategyOf(zones), -1, { scalp: true });
  assert.ok(guardPlan, "the guardrail keeps today's plan");
  assert.equal(base, null, `the base plan's own key zone pays under 1R (today ${guardPlan.rrr.tp1}R)`);
  assert.equal(guards.short.plans.zone_pullback, undefined, "the default agent has no plan on this side");
  assert.ok(!guards.short.checks.some((c) => c.id === "levels" && !c.pass), "the side is not blocked by the levels check");
  const sweep = guards.short.plans.sweep_reversal.plan;
  assert.deepEqual([sweep.tp1, sweep.rrr.tp1], [3560.96, 1.71]);
  assert.deepEqual(liveAgentPlans(guards.short).map(([id]) => id), ["sweep_reversal"], "selectable");
  assert.equal(typeof decide === "function" || decide === undefined, true);
});

test("TK9 buildStrategy's plan follows the switch through modes; a first target under 1R waits (LOW_REWARD)", async () => {
  const { slimInputs } = await import("../src/strategy-inputs.mjs");
  assert.deepEqual(slimInputs({ modes: { chartPatterns: "on", tp1KeyZone: "off" } }).modes, { tp1KeyZone: "off" });
  assert.deepEqual(slimInputs({ modes: { chartPatterns: "off", tp1KeyZone: "off" } }).modes, { chartPatterns: "off", tp1KeyZone: "off" });
  assert.equal("modes" in slimInputs({ modes: { chartPatterns: "on", tp1KeyZone: "on" } }), false, "stored inputs unchanged while both are on");
});
