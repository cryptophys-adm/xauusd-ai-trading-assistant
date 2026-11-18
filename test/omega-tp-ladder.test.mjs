// The TP ladder (owner 2026-11-18, relayed and confirmed: "a, langsung live, termasuk agent juga bisa dinamis mengatur
// TP sebagian secara progresive"; every mode). TP1..TPn, the stop locked at TPx-1 once price is 30 pips past TPx,
// progressive partials of 25% to 50% within the broker's volume step and minimum. Exposure only goes down.
import test from "node:test";
import assert from "node:assert/strict";
import { ladderRungs, ladderPlan, partialShare, manageIntents, settingsFrom, OMEGA_DEFAULTS, GOLD_PIP, INTENT_ID_MAX } from "../src/omega-engine.mjs";

const NOW = Date.parse("2026-11-18T10:00:00Z");
const SYM = { name: "GOLD", digits: 2, point: 0.01, spread_points: 15, stops_level_points: 0, volume_min: 0.01, volume_step: 0.01, bid: 4010, ask: 4010.15, tick_size: 0.01, tick_value: 1 };
const S = { ...OMEGA_DEFAULTS, enabled: true };
const LONG = { ticket: 101, side: "BUY", volume: 0.08, open_price: 4000, sl: 3990, tp: 4030, source: "omega", magic: 920200, intent_id: "open:1:B", opened_ms: NOW - 3_600_000 };
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

test("TL2 the lock (owner 2026-11-18): a step past the entry → break-even, a step past TPx → TPx; scalp 30 pips; never looser, never inside the broker's distance", () => {
  assert.equal(GOLD_PIP * S.ladder_lock_pips, 3);
  // Entry 4000, TP1 4010: 4002.9 is 29 pips past the entry: nothing; 4003 is 30 past: break-even plus the buffer.
  assert.equal(ladderPlan({ position: LONG, sym: at(4002.9), settings: S, now: NOW }).sl, null);
  const be = ladderPlan({ position: LONG, sym: at(4003), settings: S, now: NOW });
  assert.deepEqual([be.sl, be.sl_rung], [4000.3, 0]);
  // 30 pips past TP1 (4010): the stop goes to TP1; 30 past TP2 (4020): to TP2.
  assert.deepEqual([ladderPlan({ position: LONG, sym: at(4013), settings: S, now: NOW }).sl, ladderPlan({ position: LONG, sym: at(4013), settings: S, now: NOW }).sl_rung], [4010, 1], "past TP1: the stop locks TP1");
  assert.deepEqual([ladderPlan({ position: LONG, sym: at(4023.5), settings: S, now: NOW }).sl, ladderPlan({ position: LONG, sym: at(4023.5), settings: S, now: NOW }).sl_rung], [4020, 2], "past TP2: to TP2");
  assert.equal(ladderPlan({ position: LONG, sym: at(4033.5), settings: S, now: NOW }).sl, 4030, "past TP3 (the target): to TP3") ;
  assert.equal(ladderPlan({ position: { ...LONG, sl: 4021 }, sym: at(4023.5), settings: S, now: NOW }).sl, null, "a tighter stop is kept");
  assert.equal(ladderPlan({ position: SHORT, sym: at(3986.5), settings: S, now: NOW }).sl, 3990, "the short, past its TP1, locks at its TP1");
  assert.equal(ladderPlan({ position: LONG, sym: { ...at(4013), stops_level_points: 1500 }, settings: S, now: NOW }).sl, null, "too close to price for the broker");
});

test("TL2b per mode and on closed candles: intraday 0.5R, swing 0.3R; the trigger is the mode's closed candle in the trade's direction; no candle, no lock", async () => {
  const { ladderStep } = await import("../src/omega-engine.mjs");
  assert.deepEqual(ladderStep(null, S), { mode: "scalp", step: 3, unit: "pips" });
  assert.deepEqual(ladderStep({ mode: "intraday", r_dist: 10 }, S), { mode: "intraday", step: 5, unit: "R" });
  assert.deepEqual(ladderStep({ mode: "swing", r_dist: 10 }, S), { mode: "swing", step: 3, unit: "R" });
  assert.equal(ladderStep({ mode: "swing" }, S).step, null, "no R: no step");
  const meta = { mode: "intraday", r_dist: 10 };
  // Live price 4016 but the closed M15 candle closed at 4006 (green): past the entry by 0.6R -> break-even only.
  const on = ladderPlan({ position: LONG, sym: at(4016), settings: S, now: NOW, meta, candles: { M15: { o: 4001, c: 4006, close_ms: NOW - 60_000 } } });
  assert.deepEqual([on.sl, on.sl_rung], [4000.3, 0]);
  assert.equal(ladderPlan({ position: LONG, sym: at(4016), settings: S, now: NOW, meta, candles: { M15: { o: 4008, c: 4006, close_ms: NOW - 60_000 } } }).sl, null, "a red candle against a long confirms nothing");
  assert.equal(ladderPlan({ position: LONG, sym: at(4016), settings: S, now: NOW, meta, candles: {} }).sl, null, "no candle: no new lock");
  assert.equal(ladderPlan({ position: LONG, sym: at(4016), settings: S, now: NOW, meta: { mode: "scalp" }, candles: { M5: { o: 4010, c: 4013.5, close_ms: NOW - 60_000 } } }).sl, 4010, "scalp on M5: 30 pips past TP1 -> TP1");
  const { lastClosedCandle } = await import("../src/omega-broker.mjs");
  const t0 = Date.parse("2026-11-18T10:00:00Z");
  const bars = Array.from({ length: 15 }, (_, i) => ({ t: t0 + i * 60_000, o: 4000 + i, h: 4001 + i, l: 3999 + i, c: 4000.5 + i }));
  assert.deepEqual(lastClosedCandle(bars, 15, t0 + 16 * 60_000), { o: 4000, c: 4014.5, close_ms: t0 + 15 * 60_000 });
  assert.equal(lastClosedCandle(bars.slice(0, 10), 15, t0 + 16 * 60_000), null, "incomplete");
  assert.equal(lastClosedCandle(bars.slice(0, 14), 15, t0 + 16 * 60_000), null, "14 of 15 minutes, the final one missing");
  // A candle that closed before the entry confirms nothing.
  assert.equal(ladderPlan({ position: { ...LONG, opened_ms: NOW }, sym: at(4016), settings: S, now: NOW, meta, candles: { M15: { o: 4001, c: 4006, close_ms: NOW - 60_000 } } }).sl, null);
  // Another broker's corpus is never used; the cache keys on the server and symbol.
  const { ladderCandles, resetCandleCacheForTests } = await import("../src/omega-broker.mjs");
  resetCandleCacheForTests();
  const read = async () => ({ server: "OtherBroker-Live", symbol: "XAUUSD", bars });
  const c = await ladderCandles({}, t0 + 16 * 60_000, { read, server: "FxPro-MT5 Demo", symbol: "GOLD" });
  assert.deepEqual([c.M5, c.M15, c.H1], [null, null, null]);
  resetCandleCacheForTests();
  const c2 = await ladderCandles({}, t0 + 16 * 60_000, { read: async () => ({ server: "FxPro-MT5 Demo", symbol: "GOLD", bars }), server: "FxPro-MT5 Demo", symbol: "GOLD" });
  assert.ok(c2.M15, "same broker and symbol: its own candle");
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
  assert.deepEqual([ms.sl, ms.tp, ms.reason], [4010, 4030, "ladder_lock_tp1"]);
  assert.ok(out.every((i) => i.id.length <= INTENT_ID_MAX));
  assert.ok(!out.some((i) => i.reason === "tp1_scale_out"));
  const later = manageIntents({ positions: [{ ...LONG, volume: 0.04, sl: 4010 }], sym: at(4013.5), settings: S, signal: power(0.1), recentIntentIds: ["pl:101:1", "ms:101:lad:401000"], now: NOW });
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

test("TL6 Amendment 4: the take-profit moves outward only while the stop locks a profit at or beyond TP1", async () => {
  const { ladderTp1Locked } = await import("../src/omega-engine.mjs");
  assert.equal(ladderTp1Locked({ position: LONG, sym: SYM }), false, "stop below the entry");
  assert.equal(ladderTp1Locked({ position: { ...LONG, sl: 4010 }, sym: SYM }), true, "stop at TP1 (4010)");
  assert.equal(ladderTp1Locked({ position: LONG, sym: SYM, plannedSl: 4010 }), true, "a lock planned in this sync counts");
  assert.equal(ladderTp1Locked({ position: { ...SHORT, sl: 3990 }, sym: SYM }), true);
  // An extended target on the signal: dropped before the lock, kept after it.
  const signal = { tp2: 4060, side: "BUY" };
  const early = manageIntents({ positions: [LONG], sym: at(4005), settings: S, signal, side: "BUY", now: NOW });
  assert.ok(!early.some((i) => i.kind === "modify_tp"), "no outward move before TP1 is locked");
  const late = manageIntents({ positions: [{ ...LONG, sl: 4010.5 }], sym: at(4025), settings: S, signal, side: "BUY", now: NOW });
  assert.ok(late.some((i) => i.kind === "modify_tp" && i.tp === 4060), "outward once the stop locks TP1");
});

test("TL7 Amendment 4: the Position Manager's outward TP2 waits for the TP1 lock too", async () => {
  const { planIntents } = await import("../src/omega-engine.mjs");
  const exec = (pos) => ({ connected: true, trade_allowed: true, received_ms: NOW - 1000, account: { trade_mode: "demo", currency: "USD", balance: 1000, equity: 1000, day_start_balance: 1000 }, symbol: { ...at(4012), currency_profit: "USD", contract_size: 100, volume_max: 50 }, positions: [pos] });
  const act = [{ id: "pm:101:t:1", ticket: 101, action: "tp", rule: "tp2_target", tp: 4045 }];
  const base = { signal: null, control: { mode: "active" }, settings: { ...S, max_positions: 3 }, now: NOW, engineEnabled: true, pmActions: act };
  const early = planIntents({ ...base, executor: exec(LONG) });
  assert.ok(!early.intents.some((i) => i.kind === "modify_tp"), "stop below TP1: no outward move");
  const locked = planIntents({ ...base, executor: exec({ ...LONG, sl: 4010.2 }) });
  assert.ok(locked.intents.some((i) => i.kind === "modify_tp" && i.tp === 4045), "stop at TP1: the move runs");
});

test("RE1 the same-side re-entry guard: only until the next M5 candle closes after a weakening or cut-loss exit", async () => {
  const { reentryGate, planIntents, settingsFrom } = await import("../src/omega-engine.mjs");
  const exitMs = Date.parse("2026-11-18T10:02:37Z");
  const reentry = { side: "SELL", exit_price: 3774.92, exit_ms: exitMs, entry_conf: 0.7 };
  // The exit fell in the 10:00-10:05 candle: blocked until it closes at 10:05, free from then on.
  const g = reentryGate({ side: "SELL", reentry, now: Date.parse("2026-11-18T10:04:59Z") });
  assert.equal(g.code, "reentry_cooldown");
  assert.match(g.detail, /free at 10:05 UTC/);
  assert.equal(reentryGate({ side: "SELL", reentry, now: Date.parse("2026-11-18T10:05:00Z") }), null, "the candle closed");
  // No pullback, no confidence test any more: a SELL right after 10:05 at the same price is free.
  assert.equal(reentryGate({ side: "SELL", reentry: { ...reentry, entry_conf: 0.99 }, now: Date.parse("2026-11-18T10:05:01Z") }), null);
  assert.equal(reentryGate({ side: "BUY", reentry, now: exitMs + 1000 }), null, "the other side is free");
  assert.equal(reentryGate({ side: "SELL", reentry: null, now: exitMs + 1000 }), null);
  // Two bars: free at 10:10. Zero: off.
  assert.match(reentryGate({ side: "SELL", reentry, settings: { reentry_cooldown_bars: 2 }, now: Date.parse("2026-11-18T10:07:00Z") }).detail, /2 closed M5 candles .*free at 10:10 UTC/);
  assert.equal(reentryGate({ side: "SELL", reentry, settings: { reentry_cooldown_bars: 0 }, now: exitMs + 1000 }), null);
  assert.match(settingsFrom({ reentry_cooldown_bars: 1.5 }).error, /reentry_cooldown_bars/, "whole candles only");
  // In the planner: the note and no open while the candle is still open.
  const exec = { connected: true, trade_allowed: true, received_ms: Date.parse("2026-11-18T10:03:05Z"), account: { trade_mode: "demo", currency: "USD", balance: 1000, equity: 1000, day_start_balance: 1000 }, symbol: { name: "GOLD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_step: 0.01, volume_max: 50, stops_level_points: 0, bid: 3775.5, ask: 3775.65, spread_points: 15, atr_value: 4 }, positions: [] };
  const signal = { side: "SELL", action: "ENTER_MARKET", entry: 3775.5, stop: 3785, tp1: 3760, issued_ms: Date.parse("2026-11-18T10:00:00Z"), expires_ms: Date.parse("2026-11-18T10:10:00Z"), blackout: false, kill: false, paused: false };
  const p = planIntents({ signal, control: { mode: "active" }, settings: { ...S, max_positions: 3 }, executor: exec, now: Date.parse("2026-11-18T10:03:06Z"), engineEnabled: true, reentry });
  assert.equal(p.notes.at(-1).code, "reentry_cooldown");
  assert.ok(!p.intents.some((i) => i.kind === "open"));
});
