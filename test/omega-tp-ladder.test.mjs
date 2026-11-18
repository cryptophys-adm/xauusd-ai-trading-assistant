// The TP ladder (owner 2026-11-18, relayed and confirmed: "a, langsung live, termasuk agent juga bisa dinamis mengatur
// TP sebagian secara progresive"; every mode). TP1..TPn, the stop locked at TPx-1 once price is 30 pips past TPx,
// progressive partials of 25% to 50% within the broker's volume step and minimum. Exposure only goes down.
import test from "node:test";
import assert from "node:assert/strict";
import { ladderRungs, ladderPlan, partialShare, manageIntents, settingsFrom, OMEGA_DEFAULTS, GOLD_PIP, INTENT_ID_MAX } from "../src/omega-engine.mjs";

const NOW = Date.parse("2026-11-18T10:00:00Z");
const SYM = { name: "GOLD", digits: 2, point: 0.01, spread_points: 15, stops_level_points: 0, volume_min: 0.01, volume_step: 0.01, bid: 4010, ask: 4010.15, tick_size: 0.01, tick_value: 1 };
const S = { ...OMEGA_DEFAULTS, enabled: true };
const LONG = { ticket: 101, side: "BUY", volume: 0.08, open_price: 4000, sl: 3990, tp: 4030, source: "omega", magic: 920200, intent_id: "open:1:B" };
const SHORT = { ticket: 202, side: "SELL", volume: 0.08, open_price: 4000, sl: 4010, tp: 3970, source: "omega", magic: 920200, intent_id: "open:2:S" };
const at = (bid) => ({ ...SYM, bid, ask: bid + 0.15 });
const power = (p) => ({ power: p, power_ms: NOW - 60_000 });

test("TL1 the rungs: key levels between the entry and the target (near edge), then the target; thirds without one; mirrored for a short", () => {
  const levels = [{ low: 4008, high: 4009 }, { low: 4018, high: 4019 }, { low: 4040, high: 4041 }, { low: 3990, high: 3992 }];
  assert.deepEqual(ladderRungs({ position: LONG, levels, buffer: 0.3 }), [4008, 4018, 4030]);
  assert.deepEqual(ladderRungs({ position: LONG, levels: null, buffer: 0.3 }).map((x) => Math.round(x * 100) / 100), [4010, 4020, 4030]);
  assert.deepEqual(ladderRungs({ position: SHORT, levels: [{ low: 3988, high: 3991 }, { low: 3978, high: 3981 }], buffer: 0.3 }), [3991, 3981, 3970]);
  assert.deepEqual(ladderRungs({ position: { ...LONG, tp: 0 }, levels }), [], "no target, no ladder");
});

test("TL2 the stop locks at TPx-1 once price is 30 pips past TPx: TP0 is the entry; never looser, never inside the broker's distance", () => {
  assert.equal(GOLD_PIP * S.ladder_lock_pips, 3);
  // TP1 = 4010: 4012.9 is 29 pips past: nothing; 4013 is 30 past: the stop goes to the entry plus the buffer.
  assert.equal(ladderPlan({ position: LONG, sym: at(4012.9), settings: S, now: NOW }).sl, null);
  const first = ladderPlan({ position: LONG, sym: at(4013), settings: S, now: NOW });
  assert.deepEqual([first.sl, first.sl_rung], [4000.3, 0]);
  // 30 pips past TP2 (4020): the stop goes to TP1.
  const second = ladderPlan({ position: LONG, sym: at(4023.5), settings: S, now: NOW });
  assert.deepEqual([second.sl, second.sl_rung], [4010, 1]);
  assert.equal(ladderPlan({ position: { ...LONG, sl: 4012 }, sym: at(4023.5), settings: S, now: NOW }).sl, null, "a tighter stop is kept");
  const short = ladderPlan({ position: SHORT, sym: at(3976.5), settings: S, now: NOW });
  assert.deepEqual([short.sl, short.sl_rung], [3990, 1], "the short locks at its TP1");
  assert.equal(ladderPlan({ position: LONG, sym: { ...at(4013), stops_level_points: 1500 }, settings: S, now: NOW }).sl, null, "too close to price for the broker");
});

test("TL3 the partials: 25% with a strong power, 50% when it fades, in between otherwise; the broker's step and minimum; one per rung, at most three", () => {
  assert.deepEqual(["strong", "normal", "weak", "reversed"].map((b) => partialShare(b, S)), [0.25, 0.375, 0.5, 0.5]);
  const strong = ladderPlan({ position: LONG, sym: at(4011), signal: power(0.7), settings: S, now: NOW });
  assert.deepEqual(strong.partial, { volume: 0.02, rung: 1, share: 0.25, band: "strong" });
  const weak = ladderPlan({ position: LONG, sym: at(4011), signal: power(0.1), settings: S, now: NOW });
  assert.equal(weak.partial.volume, 0.04);
  assert.equal(ladderPlan({ position: LONG, sym: at(4011), signal: power(0.1), settings: S, partialsDone: 1, now: NOW }).partial, null, "TP1 was banked already");
  assert.equal(ladderPlan({ position: LONG, sym: at(4021), settings: S, partialsDone: 1, now: NOW }).partial.rung, 2);
  assert.equal(ladderPlan({ position: LONG, sym: at(4031), settings: { ...S, ladder_max_partials: 2 }, partialsDone: 2, now: NOW }).partial, null, "the cap");
  assert.equal(ladderPlan({ position: { ...LONG, volume: 0.01 }, sym: at(4011), settings: S, now: NOW }).partial, null, "0.01 cannot be split");
  assert.equal(ladderPlan({ position: { ...LONG, volume: 0.03 }, sym: at(4011), signal: power(0.7), settings: S, now: NOW }).partial, null, "25% of 0.03 is below the minimum");
  assert.equal(ladderPlan({ position: { ...LONG, volume: 0.02 }, sym: at(4011), signal: power(0.1), settings: S, now: NOW }).partial.volume, 0.01, "half of 0.02 leaves the minimum open");
  assert.equal(ladderPlan({ position: LONG, sym: at(4009), settings: S, now: NOW }).partial, null, "no rung reached");
});

test("TL4 manageIntents: the ladder runs by default, its ids fit the bridge, the partial count comes from the recent ids; no single scale-out", () => {
  const out = manageIntents({ positions: [LONG], sym: at(4013.5), settings: S, signal: power(0.1), now: NOW });
  const pl = out.find((i) => i.kind === "partial_close");
  assert.deepEqual([pl.id, pl.volume, pl.reason], ["pl:101:1", 0.04, "ladder_tp1_50pct"]);
  const ms = out.find((i) => i.kind === "modify_sl");
  assert.deepEqual([ms.sl, ms.tp, ms.reason], [4000.3, 4030, "ladder_lock_tp0"]);
  assert.ok(out.every((i) => i.id.length <= INTENT_ID_MAX));
  assert.ok(!out.some((i) => i.reason === "tp1_scale_out"));
  const later = manageIntents({ positions: [{ ...LONG, volume: 0.04, sl: 4000.3 }], sym: at(4013.5), settings: S, signal: power(0.1), recentIntentIds: ["pl:101:1", "ms:101:lad:400030"], now: NOW });
  assert.deepEqual(later, [], "TP1 banked and locked: nothing more until TP2");
  assert.ok(manageIntents({ positions: [{ ...LONG, source: "manual", magic: 0, intent_id: null }], sym: at(4013.5), settings: S, now: NOW }).length === 0, "never a manual position");
  const off = manageIntents({ positions: [LONG], sym: at(4013.5), settings: { ...S, tp_ladder: false }, now: NOW });
  assert.ok(!off.some((i) => String(i.id).startsWith("pl:")), "off: the legacy management");
});

test("TL5 the owner's knobs: bounds, min not above max, the switch is a boolean", () => {
  assert.equal(settingsFrom({ partial_min_pct: 30, partial_max_pct: 60, ladder_lock_pips: 20 }).settings.partial_max_pct, 60);
  assert.match(settingsFrom({ partial_min_pct: 5 }).error, /partial_min_pct must be a number from 10 to 50/);
  assert.match(settingsFrom({ partial_min_pct: 50, partial_max_pct: 40 }).error, /must not be above/);
  assert.match(settingsFrom({ ladder_lock_pips: 200 }).error, /ladder_lock_pips/);
  assert.match(settingsFrom({ tp_ladder: "yes" }).error, /tp_ladder must be true or false/);
  assert.equal(settingsFrom({ tp_ladder: false }).settings.tp_ladder, false);
  assert.deepEqual([OMEGA_DEFAULTS.tp_ladder, OMEGA_DEFAULTS.partial_min_pct, OMEGA_DEFAULTS.partial_max_pct, OMEGA_DEFAULTS.ladder_lock_pips, OMEGA_DEFAULTS.ladder_max_partials], [true, 25, 50, 30, 3]);
});
