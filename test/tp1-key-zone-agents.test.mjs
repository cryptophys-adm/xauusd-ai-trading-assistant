// TP1-KZ2 (owner 2026-11-23, "setuju", relayed by the orchestrator): TP1-KZ applies to every agent with its own targets
// (the pattern families, inside the pattern, the range fade). Under TP1_KEY_ZONE_MODE "on" the first target is the nearest
// key zone beyond the gap, at least TP1_MIN_R (1R), exactly as the default agent's; the agent's measured target moves to
// TP2 when it lies beyond that TP1. "off" is the agents' own targets, byte for byte.
import test from "node:test";
import assert from "node:assert/strict";
import { STRATEGY_AGENTS, agentContext, finishPlan, ownTargetsUnderKeyZone } from "../src/strategy-agents.mjs";
import { planForDirection } from "../src/strategy-engine.mjs";
import { agentPlanPasses } from "../src/decision-engine.mjs";

const agent = (id) => STRATEGY_AGENTS.find((a) => a.id === id);
const M15 = 15 * 60_000;
const flatBars = (n, low, high, close) => Array.from({ length: n }, (_, i) => ({ open_time: new Date(Date.parse("2026-11-23T08:00:00Z") + i * M15).toISOString(), open: close, low, high, close }));

// Decision OANDA:XAUUSD:15:1795434300000 (2026-11-23 12:00Z, scalp, pattern_lines BUY): the 1H symmetrical triangle broken
// upward at 3593.97, the 1H ATR 23.69, price 3619.14; the plan's stop at the 0.25 ATR minimum (3588.05, risk 5.92) and TP1 the
// measured target 3894.34 (50.72R). The record keeps the key levels' bands, not which were Key Level Agent candidates: the two
// candidates here (3618.01-3625 and 3650-3656.35) are illustrative; the other bands are qualified levels.
const ATR = 23.69, PRICE = 3619.14;
const BANDS = [[3569.96, 3575.02], [3578.19, 3582.67], [3586.15, 3592.85], [3593.97, 3600.58], [3602.58, 3608.51], [3610.84, 3617.66], [3618.01, 3625], [3625.57, 3631.58], [3634.47, 3637.07], [3641.62, 3647.74], [3650, 3656.35], [3674.23, 3678.67]];
const CANDIDATES = new Set([3618.01, 3650]);
const zonesOf = (candidates = CANDIDATES) => BANDS.map(([low, high]) => ({ low, high, price: (low + high) / 2, candidate: candidates.has(low), qualified: true, label: candidates.has(low) ? "a key zone" : "a level" }));
const TRIANGLE = { tf: "60", chart: "1H", id: "triangle_symmetrical", name: "symmetrical triangle", status: "confirmed", direction: 1, upper: 3593.97, lower: 3592, height: 300.37, target: 3894.34, bars_ago: 2 };
const strategyOf = (zones, patterns) => ({ price: PRICE, atr_h1: ATR, direction: "LONG", plan: { at_level: false }, setup: { type: "none" }, key_levels: { zones, patterns } });
const linesPlan = ({ zones = zonesOf(), pattern = TRIANGLE, keyZone = true } = {}) =>
  agent("pattern_lines").plan(1, agentContext({ strategy: strategyOf(zones, [pattern]), bars: flatBars(40, 3610, 3622, PRICE), scalp: true, keyZone }));

test("KZ2-1 the 12:00Z case: off is the plan as recorded; on takes TP1 at the key zone and the measured target as TP2", () => {
  const off = linesPlan({ keyZone: false });
  assert.deepEqual([off.entry, off.stop, off.risk, off.tp1, off.tp2, off.rrr.tp1], [3593.97, 3588.05, 5.92, 3894.34, 4044.53, 50.72], "the decision as it was");
  assert.match(off.tp1_note, /symmetrical triangle: measured target$/);
  const on = linesPlan();
  assert.deepEqual([on.entry, on.stop, on.risk, on.tp1, on.tp2, on.rrr.tp1, on.rrr.tp2], [3593.97, 3588.05, 5.92, 3618.01, 3894.34, 4.06, 50.72]);
  assert.match(on.tp1_note, /3618\.01–3625\.00 key zone/);
  assert.equal(on.tp2_note, "1H symmetrical triangle: measured target");
  assert.equal(on.pattern, "triangle_symmetrical");
  assert.equal(agentPlanPasses(on, { target_rule: "nearest", min_rrr: 0, tp1_min_r: 1 }), true, "scalp: a real level, at least 1R");
});

test("KZ2-2 the nearest key zone pays under 1R: no plan (LOW_REWARD), never a jump to the next one; off still trades", () => {
  // A wider stop: the triangle's lower line at 3580 (risk 16.34); the key zone 3602.58 then pays 0.53R.
  const wide = { ...TRIANGLE, lower: 3580 };
  const near = new Set([3602.58, 3650]);
  assert.equal(linesPlan({ zones: zonesOf(near), pattern: wide }), null);
  assert.ok(linesPlan({ zones: zonesOf(near), pattern: wide, keyZone: false }), "off: the measured target, as before");
  // No key zone at all: the nearest level ahead, still at least 1R (here 3602.58 at 0.53R): no plan.
  assert.equal(linesPlan({ zones: zonesOf(new Set()), pattern: wide }), null);
});

test("KZ2-3 pattern_peaks the same: TP1 at a key zone of at least 1R, the measured target to TP2, or named in TP2's note when short", () => {
  const pattern = { tf: "15", chart: "15m", id: "double_bottom_adam_adam", name: "double bottom (Adam & Adam)", status: "confirmed", direction: 1, upper: 3999.5, lower: 3990, height: 9.5, target: 4009, bars_ago: 1 };
  const z = (low, high, candidate) => ({ low, high, price: (low + high) / 2, candidate, qualified: true, label: candidate ? "a key zone" : "a level" });
  const plan = (zones, keyZone = true) => agent("pattern_peaks").plan(1, agentContext({ strategy: { price: 4000, atr_h1: 10, direction: "LONG", plan: { at_level: true }, setup: { type: "none" }, key_levels: { zones, patterns: [pattern] } }, bars: flatBars(12, 3999, 4003, 4001), keyZone }));
  const off = plan([z(3980, 3980, true), z(4008, 4010, true)], false);
  assert.deepEqual([off.entry, off.stop, off.tp1, off.tp2], [4000, 3993.75, 4009, 4013.75], "off: as before");
  // A key zone at 4008 (1.28R): TP1 there, the measured target 4009 beyond it becomes TP2.
  const near = plan([z(3980, 3980, true), z(4008, 4010, true)]);
  assert.deepEqual([near.tp1, near.rrr.tp1, near.tp2, near.tp2_note], [4008, 1.28, 4009, "15m double bottom (Adam & Adam): measured target"]);
  // A key zone at 4006 (0.96R): no plan.
  assert.equal(plan([z(3980, 3980, true), z(4006, 4007, true), z(4030, 4032, true)]), null);
  // A key zone at 4030 (4.8R), beyond the measured target: TP1 there; the agent's own TP2 (4013.75) is short of it too, so TP2
  // is the key zones' next target, and its note keeps the measured target.
  const far = plan([z(3980, 3980, true), z(4030, 4032, true), z(4050, 4050, true)]);
  assert.deepEqual([far.tp1, far.rrr.tp1, far.tp2], [4030, 4.8, 4050]);
  assert.match(far.tp2_note, /double bottom \(Adam & Adam\): measured target \(4009\.00\) lies short of the first key zone$/);
});

test("KZ2-4 the default agent is unchanged: its plan is planForDirection's own under the switch", () => {
  const strategy = strategyOf(zonesOf(), [TRIANGLE]);
  for (const keyZone of [true, false]) {
    const p = agent("zone_pullback").plan(1, agentContext({ strategy, bars: flatBars(40, 3610, 3622, PRICE), scalp: true, keyZone }));
    const base = planForDirection(strategy, 1, { scalp: true, keyZone });
    assert.deepEqual(p ? { ...p, agent: undefined, setup: undefined } : null, base ? { ...base, agent: undefined, setup: undefined } : null);
  }
});

test("KZ2-5 off is byte-identical: the measured marker never reaches a plan; ownTargetsUnderKeyZone's rules", () => {
  const ctx = { atr: 10, levels: [], scalp: false };
  const own = { tp1: 4009, tp1_note: "m", tp2: 4013.75, tp2_note: "h" };
  const args = { entry: 4000, stop: 3993.75, atLevel: true, entryNote: "e", stopNote: "s", setup: "x" };
  assert.deepEqual(JSON.stringify(finishPlan("pattern_peaks", 1, { ...args, targets: { ...own, measured: { price: 4009, note: "m" } } }, ctx)), JSON.stringify(finishPlan("pattern_peaks", 1, { ...args, targets: own }, ctx)));
  const kz = { tp1: 4008, tp1_note: "kz", tp2: 4050, tp2_note: "kz2" };
  assert.equal(ownTargetsUnderKeyZone(1, own, null), null, "no key-zone target: no plan");
  assert.deepEqual(ownTargetsUnderKeyZone(1, { ...own, measured: { price: 4009, note: "m" } }, kz), { tp1: 4008, tp1_note: "kz", tp2: 4009, tp2_note: "m" });
  assert.deepEqual(ownTargetsUnderKeyZone(1, own, kz), { tp1: 4008, tp1_note: "kz", tp2: 4013.75, tp2_note: "h" }, "no measured target: the own TP2 beyond TP1");
  assert.deepEqual(ownTargetsUnderKeyZone(-1, { tp1: 3990, tp1_note: "a", tp2: 3985, tp2_note: "b" }, { tp1: 3980, tp1_note: "kz", tp2: 3960, tp2_note: "kz2" }), { tp1: 3980, tp1_note: "kz", tp2: 3960, tp2_note: "kz2" }, "a short: the own TP2 short of TP1");
});
