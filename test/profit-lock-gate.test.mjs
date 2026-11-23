// SLG1, one profit-lock gate (owner 2026-11-23, src/profit-lock-gate.mjs): no stop moves into profit until the
// position's MFE on closed bars of its mode's timeframe reaches max(1.0R, k x ATR) (range: max(0.75 x the TP distance,
// 1.0 x ATR(M15))); at the gate the first lock is break-even plus the spread plus 0.1 x ATR(M5). The Omega setting
// profit_lock_gate "on" (default) | "legacy" (today's engine byte for byte); a read-only brake asks the owner once.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  gateFacts, gatesFor, gateBreakEven, gateAtrM5, gateMode, profitLockGateOn, gateReadSince, PROFIT_LOCK_GATE, GATE_LOOKBACK_MIN, GATE_UNMEASURED
} from "../src/profit-lock-gate.mjs";
import { planIntents, positionManagerIntents, manageIntents, settingsFrom, OMEGA_DEFAULTS } from "../src/omega-engine.mjs";
import { positionFacts, positionAction, runPositionManager } from "../src/position-manager.mjs";
import {
  replayOmega4, ENGINE_BEHAVIOUR_HASH, ERA_SWITCHES, eraSwitches, sha256Hex, profitLockBrake, profitLockBrakeMessage, runProfitLockBrake,
  PLG_BRAKE, PLG_SINCE_KEY, PLG_BRAKE_KEY
} from "../src/ledger-omega4.mjs";
import { profitLockGates, gateBars, resetGateBarsCacheForTests, writeSettings, readSettings, applyOmegaPolicy, resetOmegaBrokerSchemaForTests, OMEGA_POLICY_KEY } from "../src/omega-broker.mjs";
import { CORPUS_READ_MAX } from "../src/corpus-oracle.mjs";
import { resetPositionSchemaCacheForTests } from "../src/position-actions.mjs";
import { resetEaExecutionSchemaForTests } from "../src/ea-execution.mjs";
import { engineBehaviourSource } from "./fixtures/engine-behaviour.mjs";
import { handInputs } from "./fixtures/omega-market-path.mjs";
import { M1, M5, M15, C, WARM, key, levels, path, lerp, decision, sellTrade, dec, base, ladderCase, retraceCase } from "./fixtures/omega-v4-replay.mjs";

const OLD_BEHAVIOUR_HASH = "b58968b207cfdeafa4e1ce5ad4363370c9ec1e6aa50ae2d23f3bbe3afed5c09f";
const OPEN = Object.freeze({ open: true, mfe_r: 1.4, mfe_atr: 1.7, mfe_px: 14, need_px: 10, tf: "M15", reason: "reached" });
const SHUT = Object.freeze({ open: false, mfe_r: 0.6, mfe_atr: 0.8, mfe_px: 6, need_px: 10, need: "1R", tf: "M15", reason: "below" });
const hand = new Map(handInputs());
const legacy = (input) => ({ ...input, settings: { ...input.settings, profit_lock_gate: "legacy" } });
const T0 = Date.parse("2026-11-23T10:00:00Z");
// M1 bars { t, h, l } at a flat 4000 with one wick to `wick` in the minute `at`.
const bars = (from, to, { at = null, wick = null, side = "BUY" } = {}) => {
  const out = [];
  for (let t = from; t < to; t += M1) out.push({ t, o: 4000, h: t === at && side === "BUY" ? wick : 4000.1, l: t === at && side === "SELL" ? wick : 3999.9, c: 4000 });
  return out;
};
const BUYP = { ticket: 1, side: "BUY", open_price: 4000, opened_ms: T0 };

test("SLG1-1 the setting: 'on' by default, 'on' | 'legacy' only, carried through other changes; an era switch; Aether's policy never writes it", async () => {
  assert.equal(OMEGA_DEFAULTS.profit_lock_gate, "on");
  assert.equal(profitLockGateOn(OMEGA_DEFAULTS), true);
  assert.equal(profitLockGateOn({ profit_lock_gate: "legacy" }), false);
  assert.equal(settingsFrom({ profit_lock_gate: "legacy" }, OMEGA_DEFAULTS).settings.profit_lock_gate, "legacy");
  assert.equal(settingsFrom({ profit_lock_gate: "off" }, OMEGA_DEFAULTS).error, "profit_lock_gate must be 'on' or 'legacy'");
  assert.equal(settingsFrom({ profit_lock_gate: true }, OMEGA_DEFAULTS).error, "profit_lock_gate must be 'on' or 'legacy'");
  assert.equal(settingsFrom({ risk_pct: 1 }, { ...OMEGA_DEFAULTS, profit_lock_gate: "legacy" }).settings.profit_lock_gate, "legacy", "carried through any other change");
  assert.ok(ERA_SWITCHES.includes("profit_lock_gate"));
  assert.deepEqual(eraSwitches(OMEGA_DEFAULTS), []);
  assert.deepEqual(eraSwitches({ ...OMEGA_DEFAULTS, profit_lock_gate: "legacy" }), ["profit_lock_gate=legacy"]);
  // Aether's policy writes the risk settings back and carries the owner's switch as stored, both ways.
  for (const stored of ["on", "legacy"]) {
    const e = env();
    await writeSettings(e, { body: { profit_lock_gate: stored }, actor: "owner" }, { now: T0 });
    await e.SIGNAL_CACHE.put(OMEGA_POLICY_KEY, JSON.stringify({ risk_pct: 0.4, max_positions: 2, profit_lock_gate: stored === "on" ? "legacy" : "on", doctrine_sha: "b".repeat(64) }));
    const r = await applyOmegaPolicy({ ...e, OMEGA_POLICY_AUTO: "true" }, { now: T0 + 1 });
    assert.equal(r.status, "applied");
    assert.equal((await readSettings(e)).settings.profit_lock_gate, stored);
  }
});

test("SLG1-2 the per-mode thresholds: scalp max(1R, 1.0 ATR M15) on M5, intraday max(1R, 1.5 ATR M15) on M15, swing max(1R, 1.0 ATR H1) on H1, range max(0.75 TP, 1.0 ATR M15)", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(PROFIT_LOCK_GATE).map(([m, r]) => [m, [r.tf, r.r ?? null, r.tp_share ?? null, r.atr_k, r.atr_tf]])), {
    scalp: ["M5", 1, null, 1, "M15"], intraday: ["M15", 1, null, 1.5, "M15"], swing: ["H1", 1, null, 1, "H1"], range: ["M15", null, 0.75, 1, "M15"]
  });
  const now = T0 + 2 * 3600_000;
  const b = bars(T0, now, { at: T0 + 10 * M1, wick: 4006 });
  const g = (mode, meta = {}, atr = {}) => gateFacts({ position: BUYP, meta: { mode, ...meta }, bars: b, atrM15: atr.m15 ?? 4, atrH1: atr.h1 ?? 9, now });
  // MFE 6.00. R 5: scalp needs max(5, 4) = 5 (open); intraday max(5, 6) = 6 (open, at it); swing max(5, 9) = 9 (closed).
  assert.deepEqual([g("scalp", { r_dist: 5 }).need_px, g("scalp", { r_dist: 5 }).open, g("scalp", { r_dist: 5 }).tf], [5, true, "M5"]);
  assert.deepEqual([g("intraday", { r_dist: 5 }).need_px, g("intraday", { r_dist: 5 }).open], [6, true]);
  assert.deepEqual([g("intraday", { r_dist: 5 }, { m15: 4.1 }).need_px, g("intraday", { r_dist: 5 }, { m15: 4.1 }).open], [6.15, false], "1.5 x 4.10 = 6.15 > 6");
  assert.deepEqual([g("swing", { r_dist: 5 }).need_px, g("swing", { r_dist: 5 }).open, g("swing", { r_dist: 5 }).tf], [9, false, "H1"]);
  assert.deepEqual([g("swing", { r_dist: 5 }, { h1: 5.5 }).need_px, g("swing", { r_dist: 5 }, { h1: 5.5 }).open], [5.5, true]);
  // R larger than the ATR term: R decides.
  assert.deepEqual([g("scalp", { r_dist: 7 }).need_px, g("scalp", { r_dist: 7 }).open, g("scalp", { r_dist: 7 }).need], [7, false, "1R"]);
  // Range: 0.75 x the TP distance against 1.0 x ATR(M15); R does not count.
  assert.deepEqual([g("range", { r_dist: 2, tp_dist: 8 }).need_px, g("range", { r_dist: 2, tp_dist: 8 }).open], [6, true]);
  assert.deepEqual([g("range", { r_dist: 2, tp_dist: 10 }).need_px, g("range", { r_dist: 2, tp_dist: 10 }).open], [7.5, false]);
  assert.equal(g("range", { r_dist: 20 }).need_px, 4, "range with the TP unknown: the ATR term only");
  // MFE in R and in ATR, recorded for the audit.
  assert.deepEqual([g("scalp", { r_dist: 5 }).mfe_r, g("scalp", { r_dist: 5 }).mfe_atr, g("scalp", { r_dist: 5 }).mfe_px], [1.2, 1.5, 6]);
  // An unknown mode is intraday.
  assert.equal(gateMode("nonsense"), "intraday");
  assert.equal(g(null, { r_dist: 5 }).tf, "M15");
  // A SELL reads the lows.
  const s = gateFacts({ position: { ...BUYP, side: "SELL" }, meta: { mode: "scalp", r_dist: 5 }, bars: bars(T0, now, { at: T0 + 10 * M1, wick: 3994.5, side: "SELL" }), atrM15: 4, now });
  assert.deepEqual([s.mfe_px, s.open], [5.5, true]);
});

test("SLG1-3 unknown r_dist: the ATR term only", () => {
  const now = T0 + 3600_000;
  const b = bars(T0, now, { at: T0 + 5 * M1, wick: 4005 });
  const g = gateFacts({ position: BUYP, meta: { mode: "intraday", r_dist: null }, bars: b, atrM15: 3, now });
  assert.deepEqual([g.need_px, g.need, g.open, g.mfe_r, g.mfe_atr], [4.5, "1.5 x ATR(M15)", true, null, 1.667]);
  assert.equal(gateFacts({ position: BUYP, meta: { mode: "intraday" }, bars: b, atrM15: 3.4, now }).open, false, "1.5 x 3.40 = 5.10 > 5");
  // In the Position Manager: the facts without a stop distance still carry the gate.
  const f = positionFacts({ position: { ticket: 1, side: "BUY", open_price: 4000, sl: 3995, tp: 4020 }, sym: { bid: 4004, ask: 4004.2, point: 0.01, spread_points: 20 }, openIntent: { tp: 4020, sl: null, strategy: null }, decision: { stance: "BUY", quorum: { long_share: 0.7 } }, gate: g });
  assert.equal(f.gate.open, true);
  assert.equal(f.r_dist_pips, null);
});

test("SLG1-4 the closed-bar requirement: the forming bar's wick never counts, the bar's close opens it; the fill's own minute is left out; nothing measured stays closed", () => {
  const wickAt = T0 + 20 * M1; // inside the M15 bar 10:15-10:30
  const b = bars(T0, T0 + 40 * M1, { at: wickAt, wick: 4006 });
  const meta = { mode: "intraday", r_dist: 5 };
  // At 10:29 the M15 bar holding the wick is still forming: closed. At 10:30 it has closed: open.
  const forming = gateFacts({ position: BUYP, meta, bars: b.filter((x) => x.t < T0 + 29 * M1), atrM15: 3, now: T0 + 29 * M1 });
  assert.deepEqual([forming.open, forming.mfe_px, forming.last_close_ms], [false, 0.1, T0 + 15 * M1]);
  const closed = gateFacts({ position: BUYP, meta, bars: b.filter((x) => x.t < T0 + 30 * M1), atrM15: 3, now: T0 + 30 * M1 });
  assert.deepEqual([closed.open, closed.mfe_px, closed.last_close_ms], [true, 6, T0 + 30 * M1]);
  // Scalp reads M5: the M5 bar 10:20-10:25 closes at 10:25.
  assert.equal(gateFacts({ position: BUYP, meta: { ...meta, mode: "scalp" }, bars: b, atrM15: 3, now: T0 + 25 * M1 }).open, true);
  assert.equal(gateFacts({ position: BUYP, meta: { ...meta, mode: "scalp" }, bars: b, atrM15: 3, now: T0 + 25 * M1 - 1 }).open, false);
  // A fill inside a minute: that minute (its wick may predate the fill) is left out.
  const early = bars(T0, T0 + 20 * M1, { at: T0, wick: 4009 });
  assert.equal(gateFacts({ position: { ...BUYP, opened_ms: T0 + 20_000 }, meta: { mode: "scalp", r_dist: 5 }, bars: early, atrM15: 3, now: T0 + 20 * M1 }).open, false);
  assert.equal(gateFacts({ position: BUYP, meta: { mode: "scalp", r_dist: 5 }, bars: early, atrM15: 3, now: T0 + 20 * M1 }).open, true, "a fill on the minute counts it");
  // Nothing measurable: closed, with the reason.
  assert.deepEqual([gateFacts({ position: BUYP, meta, bars: [], atrM15: 3, now: T0 + 30 * M1 }).open, gateFacts({ position: BUYP, meta, bars: [], atrM15: 3, now: T0 + 30 * M1 }).reason], [false, "no_closed_bar"]);
  assert.equal(gateFacts({ position: BUYP, meta, bars: b, atrM15: null, now: T0 + 40 * M1 }).reason, "no_atr_m15");
  assert.equal(gateFacts({ position: BUYP, meta: { mode: "swing", r_dist: 1 }, bars: b, atrM15: 3, atrH1: null, now: T0 + 2 * 3600_000 }).reason, "no_atr_h1");
  assert.equal(gateFacts({ position: { ...BUYP, opened_ms: null }, meta, bars: b, atrM15: 3, now: T0 + 40 * M1 }).reason, "no_position_data");
  // Bounded to GATE_LOOKBACK_MIN minutes (CORPUS_READ_MAX): an older wick is out of the window.
  assert.equal(GATE_LOOKBACK_MIN, CORPUS_READ_MAX);
  const late = T0 + (GATE_LOOKBACK_MIN + 60) * M1;
  assert.equal(gateFacts({ position: BUYP, meta, bars: bars(T0, late, { at: T0 + 5 * M1, wick: 4009 }), atrM15: 3, now: late }).open, false);
  assert.equal(gateReadSince([BUYP], late), late - GATE_LOOKBACK_MIN * M1);
  assert.equal(gateReadSince([{ ...BUYP, opened_ms: T0 + 30_500 }, BUYP], T0 + 5 * M1), T0);
});

test("SLG1-5 the first lock at the gate: break-even plus the spread plus 0.1 x ATR(M5) (the broker's M5 ATR, else ATR(M15) / sqrt 3)", () => {
  assert.equal(gateBreakEven({ open: 4000, dir: 1, spread: 0.2, atrM5: 2 }), 4000.4);
  assert.equal(gateBreakEven({ open: 4000, dir: -1, spread: 0.2, atrM5: 2 }), 3999.6);
  assert.equal(gateAtrM5({ m5_atr: 2 }, { atr_value: 9 }), 2);
  assert.equal(Math.round(gateAtrM5(null, { atr_value: 3 * Math.sqrt(3) }) * 1e6) / 1e6, 3);
  assert.equal(gateAtrM5(null, {}), 0);
});

// ------------------------------------------------------------------------------------- the five paths, in Omega

const lockOf = (r, re) => r.intents.find((i) => (i.kind === "modify_sl" || i.kind === "modify_sltp") && re.test(String(i.reason)));

test("SLG1-6 Omega's break-even (trailing_stop_r), key-level SL+ and the ladder's lock: blocked before the gate, allowed after it at the gate's first lock", () => {
  // break-even: a BUY from 4095 (stop 4090) at +6 = 1.2R with trailing_stop_r 1.
  const be = hand.get("manage_be");
  assert.equal(lockOf(planIntents(legacy(be)), /^break_even$/).sl, 4095, "legacy: the open price");
  assert.equal(lockOf(planIntents(be), /^break_even$/), undefined, "no gate facts: closed");
  assert.equal(lockOf(planIntents({ ...be, gates: { 501: SHUT } }), /^break_even$/), undefined, "below the gate");
  const beOpen = lockOf(planIntents({ ...be, gates: { 501: OPEN } }), /^break_even$/);
  assert.deepEqual([beOpen.sl, beOpen.mfe_r, beOpen.mfe_atr], [4095.2, 1.4, 1.7], "the gate's first lock (spread 0.20, no M5 ATR), with the MFE it was made at");
  // key-level SL+: a BUY from 4099 past the 4104.5-4105.5 level (strong power).
  const kl = hand.get("manage_key_levels");
  assert.equal(lockOf(planIntents(legacy(kl)), /^sl_key_level_/).sl, 4099.4, "legacy: break-even plus max(2 spreads, the buffer)");
  assert.equal(lockOf(planIntents(kl), /^sl_key_level_/), undefined);
  assert.equal(lockOf(planIntents({ ...kl, gates: { 501: SHUT } }), /^sl_key_level_/), undefined);
  assert.equal(lockOf(planIntents({ ...kl, gates: { 501: OPEN } }), /^sl_key_level_/).sl, 4099.2, "the floor is the gate's first lock");
  // The ladder: a BUY from 4095 at 4101 (one scalp step past the entry), no key levels: TP0.
  const lad0 = hand.get("manage_ladder");
  const lad = { ...lad0, signal: { ...lad0.signal, key_levels: "" }, executor: { ...lad0.executor, positions: [{ ...lad0.executor.positions[0], open_price: 4095, sl: 4090 }], symbol: { ...lad0.executor.symbol, bid: 4101, ask: 4101.2 } } };
  assert.equal(lockOf(planIntents(legacy(lad)), /^ladder_lock_tp0$/).sl, 4095.4);
  assert.equal(lockOf(planIntents(lad), /^ladder_lock_/), undefined);
  assert.equal(lockOf(planIntents({ ...lad, gates: { 501: SHUT } }), /^ladder_lock_/), undefined);
  assert.equal(lockOf(planIntents({ ...lad, gates: { 501: OPEN } }), /^ladder_lock_tp0$/).sl, 4095.2);
  // The partial close of the ladder is no stop: it is not gated.
  assert.ok(planIntents(lad).intents.some((i) => i.kind === "partial_close"));
  // Past TP1 by a step: the ladder goes further (TP1) only after the gate.
  const far = { ...lad, executor: { ...lad.executor, symbol: { ...lad.executor.symbol, bid: 4103.2, ask: 4103.4 } } };
  assert.equal(lockOf(planIntents(far), /^ladder_lock_/), undefined);
  assert.equal(lockOf(planIntents({ ...far, gates: { 501: OPEN } }), /^ladder_lock_tp1$/).sl, 4100);
});

test("SLG1-7 the 5m trail: a stop into profit waits for the gate; a tighter stop still in loss does not", () => {
  const S = { ...OMEGA_DEFAULTS, enabled: true, tp_ladder: false };
  const sym = { bid: 4101, ask: 4101.2, point: 0.01, digits: 2, spread_points: 20, stops_level_points: 0 };
  const p = { ticket: 3, side: "BUY", volume: 0.01, open_price: 4095, sl: 4090, tp: 4120, source: "omega", magic: 920200, intent_id: "open:1:B" };
  const m5 = (low) => ({ m5_source: "broker", m5_close_ms: T0, m5_ready: false, m5_atr: 2, m5_swing_low: low, m5_swing_high: 4103 });
  const trail = (signal, gates) => manageIntents({ positions: [p], sym, settings: S, signal, ...(gates ? { gates } : {}) }).find((i) => i.reason === "trail_5m");
  assert.equal(trail(m5(4098)).sl, 4097.6, "no gates (direct call, legacy): today's trail");
  assert.equal(trail(m5(4098), {}), undefined, "into profit before the gate: held");
  assert.equal(trail(m5(4098), { 3: OPEN }).sl, 4097.6);
  assert.equal(trail(m5(4093), {}).sl, 4092.6, "still in loss: not a lock into profit");
});

// ------------------------------------------------------------------------------------- the five paths, in the PM

const pmSym = (bid) => ({ bid, ask: Math.round((bid + 0.2) * 100) / 100, point: 0.01, digits: 2, spread_points: 20, stops_level_points: 0, atr_value: 4 });
const DEC = { stance: "SELL", quorum: { long_share: 0.05, short_share: 0.9 }, quorum_prev: { long_share: 0.05, short_share: 0.9 }, agent_confidence: { zone_pullback: { long: 0.3, short: 0.8 } }, agent_confidence_prev: { zone_pullback: { long: 0.3, short: 0.8 } }, trading_mode: "intraday" };
const SELLP = { ticket: 101, side: "SELL", open_price: 3880, sl: 3890, tp: 3870, volume: 0.01, intent_id: "open:1:S", magic: 920200, source: "omega" };
const INTENT = { tp: 3870, sl: 3890, entry: 3880, strategy: "zone_pullback", mode: "intraday", r_dist: 10 };
const LV = [{ low: 3850, high: 3852 }, { low: 3860, high: 3862 }];
const STRONG = { momentum: "strengthening", thesis: "intact", reason: "r" };
const pmF = (bid, gate, { over = {}, ladder = false } = {}) => positionFacts({ position: { ...SELLP, ...over }, sym: pmSym(bid), openIntent: INTENT, levels: LV, decision: DEC, ladder, signal: { m5_atr: 2 }, ...(gate === undefined ? {} : { gate }) });
const act = (a) => [a.action, a.rule, a.sl ?? null, a.tp ?? null];

test("SLG1-8 the PM's break-even: blocked before the gate (a hold), at the gate's first lock after it; take_profit_weakening unchanged", () => {
  // +58 pips on a 50-pip band (0.5R intraday), the council strong.
  assert.deepEqual(act(positionAction(pmF(3874, undefined), STRONG)), ["sl", "breakeven", 3879.8, null], "legacy: break-even plus the spread");
  for (const g of [null, SHUT]) {
    const a = positionAction(pmF(3874, g), STRONG);
    assert.deepEqual(act(a), ["hold", "lock_waits_gate", null, null]);
    assert.match(a.why, /waits for the profit-lock gate/);
  }
  assert.equal(pmF(3874, null).gate.reason, "unmeasured", "no gate facts read as closed");
  const open = positionAction(pmF(3874, OPEN), STRONG);
  assert.deepEqual(act(open), ["sl", "breakeven", 3879.6, null], "3880 - 0.20 spread - 0.1 x 2.00 M5 ATR");
  assert.deepEqual([open.mfe_r, open.mfe_atr], [1.4, 1.7]);
  // The fallback without the council: the same gate.
  assert.deepEqual(act(positionAction(pmF(3874, SHUT), null)), ["hold", "lock_waits_gate", null, null]);
  assert.deepEqual(act(positionAction(pmF(3874, OPEN), null)), ["sl", "breakeven", 3879.6, null]);
  // Weakening still takes the profit, gate or not.
  for (const g of [undefined, SHUT, OPEN]) assert.deepEqual(act(positionAction(pmF(3874, g), { momentum: "weakening", thesis: "weakening" })), ["close", "take_profit_weakening", null, null]);
  // cut_loss is untouched by the gate.
  const cutDec = { ...DEC, stance: "BUY" };
  const cut = (g) => positionAction(positionFacts({ position: SELLP, sym: pmSym(3886), openIntent: INTENT, levels: LV, decision: cutDec, ...(g === undefined ? {} : { gate: g }) }), { momentum: "weakening", thesis: "broken" });
  assert.deepEqual(act(cut(SHUT)), act(cut(undefined)));
  assert.equal(cut(SHUT).rule, "cut_loss");
});

test("SLG1-9 the PM's TP1 lock: blocked before the gate, the same lock (TP1) after it; weakening closes either way", () => {
  // 31 pips beyond TP1 (3870): ask 3866.9.
  assert.deepEqual(act(positionAction(pmF(3866.7, undefined), STRONG)), ["sl", "lock_tp1", 3870, null]);
  assert.deepEqual(act(positionAction(pmF(3866.7, SHUT), STRONG)), ["hold", "lock_waits_gate", null, null]);
  assert.deepEqual(act(positionAction(pmF(3866.7, OPEN), STRONG)), ["sl", "lock_tp1", 3870, null]);
  assert.deepEqual(act(positionAction(pmF(3866.7, SHUT), { momentum: "weakening", thesis: "intact" })), ["close", "take_profit_weakening", null, null]);
});

test("SLG1-10 tp2_breakeven: the any-profit trigger is gone (the gate is the trigger); TP2 waits for the gate; at it, the gate's first lock", () => {
  // Inside the band (+28 pips), the target at TP1, a key level beyond it (3862), under the TP ladder (TP1 not locked).
  assert.deepEqual(act(positionAction(pmF(3877, undefined, { ladder: true }), STRONG)), ["tp", "tp2_breakeven", 3879.8, 3862], "legacy: at any profit");
  assert.deepEqual(act(positionAction(pmF(3877, SHUT, { ladder: true }), STRONG)), ["hold", "inside_band", null, null], "before the gate: no TP2 inside the band");
  assert.deepEqual(act(positionAction(pmF(3877, null, { ladder: true }), STRONG)), ["hold", "inside_band", null, null]);
  const at = positionAction(pmF(3877, OPEN, { ladder: true }), STRONG);
  assert.deepEqual(act(at), ["tp", "tp2_breakeven", 3879.6, 3862]);
  assert.equal(at.mfe_r, 1.4);
  // Beyond the band with the stop already past break-even: TP2 (the bare target) waits for the gate too.
  const past = { over: { sl: 3879 }, ladder: false };
  assert.deepEqual(act(positionAction(pmF(3874, undefined, past), STRONG)), ["tp", "tp2_target", null, 3862]);
  assert.deepEqual(act(positionAction(pmF(3874, SHUT, past), STRONG)), ["hold", "tp2_waits_gate", null, null]);
  assert.deepEqual(act(positionAction(pmF(3874, OPEN, past), STRONG)), ["tp", "tp2_target", null, 3862]);
});

test("SLG1-11 Omega's choke point: a PM stop into profit or TP2 that reaches it before the gate is dropped with the gate's reading; after it, applied with the MFE", () => {
  const positions = [SELLP];
  const acts = [
    { id: "pm:101:7000", ticket: 101, action: "sl", rule: "breakeven", sl: 3879.6 },
    { id: "pm:101:7001", ticket: 101, action: "tp", rule: "tp2_breakeven", tp: 3862, sl: 3879.6 }
  ];
  const sym = pmSym(3876.1);
  const legacyR = positionManagerIntents({ positions, sym, actions: acts, sltp: true });
  assert.deepEqual(legacyR.intents.map((i) => i.reason), ["pm_breakeven", "pm_tp2_breakeven"]);
  const shut = positionManagerIntents({ positions, sym, actions: acts, sltp: true, gates: { 101: SHUT } });
  assert.deepEqual(shut.intents, []);
  assert.deepEqual(shut.dropped.map((d) => d.id), ["pm:101:7000", "pm:101:7001"]);
  assert.match(shut.dropped[0].reason, /^the lock waits for the profit-lock gate: MFE 6 \(0\.6R, 0\.8 ATR\) on closed M15 bars against 10 \(1R\)$/);
  assert.match(shut.dropped[1].reason, /^TP2 waits for the profit-lock gate/);
  assert.match(positionManagerIntents({ positions, sym, actions: acts, gates: {} }).dropped[0].reason, /the MFE cannot be measured yet \(unmeasured\)/);
  const open = positionManagerIntents({ positions, sym, actions: acts, sltp: true, gates: { 101: OPEN } });
  assert.deepEqual(open.intents.map((i) => [i.reason, i.sl, i.mfe_r, i.mfe_atr]), [["pm_breakeven", 3879.6, 1.4, 1.7], ["pm_tp2_breakeven", 3879.6, 1.4, 1.7]]);
  // A stop still in loss (not a lock into profit) and a close are never gated.
  const loss = positionManagerIntents({ positions, sym, actions: [{ id: "pm:101:7", ticket: 101, action: "sl", rule: "x", sl: 3885 }, { id: "pm:101:8", ticket: 101, action: "close", rule: "cut_loss" }], gates: {} });
  assert.deepEqual(loss.intents.map((i) => i.kind), ["modify_sl", "close"]);
  // Through the plan: the gate facts by ticket, a missing one closed.
  const executor = { connected: true, received_ms: 1_000, positions, account: { trade_mode: "demo" }, symbol: sym, executor: { version: "1.21" } };
  const plan = (gates) => planIntents({ executor, now: 1_000, engineEnabled: true, settings: { enabled: true, tp_ladder: false }, pmActions: [acts[0]], ...(gates ? { gates } : {}) });
  assert.equal(plan().intents.length, 0);
  assert.equal(plan({ 101: OPEN }).intents[0].reason, "pm_breakeven");
});

test("SLG1-12 the PM runner: profit_lock_gate on reads each position's gate (none: closed); 'legacy' reads none", async () => {
  resetPositionSchemaCacheForTests();
  const e = env();
  e.DB.raw.exec("CREATE TABLE IF NOT EXISTS ai_usage_daily (day TEXT, source TEXT, model TEXT, calls INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, cached_tokens INTEGER, PRIMARY KEY (day, source, model))");
  const call = async () => ({ status: "answered", obj: STRONG });
  const base = { call, executor: { positions: [SELLP], symbol: pmSym(3874) }, openIntents: { "open:1:S": INTENT }, signal: { m5_atr: 2 }, decision: DEC };
  const now = T0;
  const r1 = await runPositionManager(e, { ...base, now });
  assert.deepEqual(r1.positions.map((p) => [p.action, p.rule]), [["hold", "lock_waits_gate"]], "no corpus: the gate cannot be measured, closed");
  const r2 = await runPositionManager(e, { ...base, now: now + 300_000, gates: { 101: OPEN } });
  assert.deepEqual(r2.positions.map((p) => [p.action, p.rule]), [["sl", "breakeven"]]);
  assert.equal(e.DB.raw.prepare("SELECT sl FROM position_actions WHERE rule = 'breakeven'").get().sl, 3879.6);
  await writeSettings(e, { body: { profit_lock_gate: "legacy" }, actor: "owner" }, { now });
  const r3 = await runPositionManager(e, { ...base, now: now + 600_000, gates: { 101: SHUT } });
  assert.deepEqual(r3.positions.map((p) => [p.action, p.rule]), [["sl", "breakeven"]], "legacy: no gate");
  assert.equal(e.DB.raw.prepare("SELECT sl FROM position_actions WHERE rule = 'breakeven' ORDER BY at_ms DESC").get().sl, 3879.8);
});

// ------------------------------------------------------------------------------------------- live MFE and v4

test("SLG1-13 live: the broker's M1 corpus since the earliest fill, the terminal's server and symbol only, the decision's ATR(H1) only for swing", async () => {
  resetGateBarsCacheForTests();
  const now = T0 + 40 * M1;
  const reads = [];
  const corpus = bars(T0 - 30 * M1, now, { at: T0 + 20 * M1, wick: 4006 });
  const read = async (_env, q) => { reads.push(q); return { server: "Broker-Live", symbol: "XAUUSD", bars: corpus.filter((b) => b.t > q.sinceMs) }; };
  const executor = { server: "Broker-Live", symbol: { name: "XAUUSD", atr_value: 3 }, positions: [{ ...BUYP, intent_id: "open:1:B", volume: 0.1 }] };
  const g = await profitLockGates({}, { executor, metaOf: () => ({ mode: "intraday", r_dist: 5 }), now, read, atrH1: null });
  assert.deepEqual([g[1].open, g[1].mfe_px, g[1].tf], [true, 6, "M15"]);
  assert.deepEqual(reads, [{ sinceMs: T0 - 1, limit: CORPUS_READ_MAX }], "from the fill's minute, bounded");
  // Cached within the minute.
  await gateBars({}, now, { positions: executor.positions, read, server: "Broker-Live", symbol: "XAUUSD" });
  assert.equal(reads.length, 1);
  // Another broker's bars are never read as this one's: closed.
  resetGateBarsCacheForTests();
  const other = await profitLockGates({}, { executor: { ...executor, server: "Other-Server" }, metaOf: () => ({ mode: "intraday", r_dist: 5 }), now, read, atrH1: null });
  assert.deepEqual([other[1].open, other[1].reason], [false, "no_closed_bar"]);
  // Swing: the latest decision's ATR(H1) (KV), read only when a swing position is open.
  resetGateBarsCacheForTests();
  const e = { SIGNAL_CACHE: { get: async (k) => (/decision/.test(k) ? JSON.stringify({ decision_key: "k", strategy: { atr_h1: 5.5 } }) : null) } };
  const h1Now = T0 + 2 * 3600_000;
  const sw = await profitLockGates(e, { executor, metaOf: () => ({ mode: "swing", r_dist: 5 }), now: h1Now, read: async (_e, q) => ({ server: "Broker-Live", symbol: "XAUUSD", bars: bars(T0, h1Now, { at: T0 + 20 * M1, wick: 4006 }).filter((b) => b.t > q.sinceMs) }) });
  assert.deepEqual([sw[1].open, sw[1].need_px, sw[1].tf], [true, 5.5, "H1"]);
  assert.deepEqual(await profitLockGates({}, { executor: { positions: [] }, now }), {});
});

/** A SELL at 2000 with a 5.00 stop (scalp) that runs 7 in its favour, then back up through the entry. */
function gateCase() {
  const d0 = decision({ close: C, trade: sellTrade(2000, 2005, 1985), lv: levels([[1940, 1942]]) });
  const d1 = decision({ close: C + M15, stance: "WAIT", decidedAfter: M1, lv: levels([[1940, 1942]]) });
  const price = lerp([[C + 3 * M1, 2000], [C + 13 * M1, 1993], [C + 21 * M1, 1993], [C + 40 * M1, 2003]]);
  return { bars: path(C - WARM, C + 50 * M1, price, 0.05), decisions: [dec(d0), dec(d1)], to: C + 50 * M1 };
}
const firstLock = (trace) => {
  for (const s of trace) {
    for (const it of s.output.intents) {
      if ((it.kind === "modify_sl" || it.kind === "modify_sltp") && it.sl > 0 && it.sl <= 2000) return { ...it, at: s.now, gates: s.input.gates ?? null };
    }
  }
  return null;
};

test("SLG1-14 v4 replays the gate: the same facts as live (gatesFor over the 1m bars since the fill), no lock before it, the first lock at it with its MFE", () => {
  const trace = [], legacyTrace = [];
  const run = replayOmega4({ ...base(), ...gateCase(), trace });
  replayOmega4({ ...base({ settings: { ...OMEGA_DEFAULTS, enabled: true, profit_lock_gate: "legacy" } }), ...gateCase(), trace: legacyTrace });
  const old = firstLock(legacyTrace), lock = firstLock(trace);
  assert.ok(old && lock, JSON.stringify({ old, lock }));
  assert.ok(lock.at > old.at, `the gate holds the first lock (legacy ${new Date(old.at).toISOString()}, gate ${new Date(lock.at).toISOString()})`);
  const ticket = String(lock.ticket);
  assert.equal(lock.gates[ticket].open, true);
  assert.ok(lock.mfe_r >= 1 && lock.mfe_atr > 0, JSON.stringify(lock));
  // Every plan before it with the position open read the gate closed.
  for (const s of trace.filter((x) => x.now < lock.at && x.input.gates?.[ticket])) assert.equal(s.input.gates[ticket].open, false, new Date(s.now).toISOString());
  // Legacy passes no gates at all (the inputs are today's).
  assert.ok(legacyTrace.every((s) => s.input.gates === undefined));
  // The gate facts v4 passed are what the live function gives over the same 1m bars, the closed M5 bars since the fill.
  const step = trace.find((s) => s.now === lock.at);
  const p = step.input.executor.positions[0];
  const m1 = gateCase().bars.map((b) => ({ t: Date.parse(b.open_time), h: b.high, l: b.low })).filter((b) => b.t < step.now);
  const live = gatesFor({ positions: [p], metaOf: () => ({ mode: "scalp", r_dist: 5, tp_dist: 15 }), bars: m1, atrM15: step.input.executor.symbol.atr_value, atrH1: 5, now: step.now });
  assert.deepEqual(live, step.input.gates);
  assert.equal(step.input.gates[ticket].tf, "M5");
  assert.equal(step.input.gates[ticket].last_close_ms % M5, 0);
  // The trade's record: locked at the gate, out at the locked stop in profit.
  const r = run.records[key(C)];
  assert.equal(r.omega4_exit, "sl_plus");
  assert.ok(r.r_omega4 > 0, String(r.r_omega4));
  // The ladder fixture of V3 never reaches the gate (MFE 4.5 of 20): no lock with the gate on.
  const t2 = [];
  replayOmega4({ ...base(), ...ladderCase(), trace: t2 });
  assert.equal(firstLock(t2), null);
});

test("SLG1-18 the gate is the break-even's trigger: open, the first lock goes in inside the band too, without the council; no room waits (lock_waits_room); a stop past the entry is not moved; v4 the same", () => {
  // +20 pips (0.2R), inside the 50-pip band: the target at TP1 with a key level beyond (3862), no ladder.
  for (const council of [STRONG, null, { momentum: "steady", thesis: "weakening", reason: "r" }]) {
    const a = positionAction(pmF(3877.8, OPEN), council);
    assert.deepEqual(act(a), ["sl", "breakeven", 3879.6, null], JSON.stringify(council));
    assert.deepEqual([a.mfe_r, a.mfe_atr], [1.4, 1.7]);
    assert.match(a.why, /inside the band, the profit-lock gate open/);
  }
  // Closed, or legacy: as before (nothing inside the band; legacy TP2 at any profit).
  assert.deepEqual(act(positionAction(pmF(3877.8, SHUT), STRONG)), ["hold", "inside_band", null, null]);
  assert.deepEqual(act(positionAction(pmF(3877.8, undefined), STRONG)), ["tp", "tp2_target", null, 3862]);
  assert.deepEqual(act(positionAction(pmF(3877.8, undefined), null)), ["hold", "tp2_waits_council", null, null]);
  // No room for the stop at the gate's break-even (+3 pips, and 1 pip against): it waits, and the next run tries again.
  for (const bid of [3879.5, 3880.1]) {
    const w = positionAction(pmF(bid, OPEN), STRONG);
    assert.deepEqual(act(w), ["hold", "lock_waits_room", null, null], String(bid));
    assert.match(w.why, /no room for the stop at 3879\.6/);
  }
  assert.deepEqual(act(positionAction(pmF(3877.8, OPEN), STRONG)), ["sl", "breakeven", 3879.6, null], "the price back with room: locked");
  // The stop already past the entry: not moved again (TP2 alone with the council, nothing without it).
  assert.deepEqual(act(positionAction(pmF(3877.8, OPEN, { over: { sl: 3879 } }), STRONG)), ["tp", "tp2_target", null, 3862]);
  assert.deepEqual(act(positionAction(pmF(3877.8, OPEN, { over: { sl: 3879 } }), null)), ["hold", "tp2_waits_council", null, null]);
  assert.deepEqual(act(positionAction(pmF(3877.8, OPEN, { over: { sl: 3879, tp: 3862 } }), null)), ["hold", "inside_band", null, null]);
  // Under the ladder with TP2 due, TP2 and the gate's break-even stay one modification.
  assert.deepEqual(act(positionAction(pmF(3877.8, OPEN, { ladder: true }), STRONG)), ["tp", "tp2_breakeven", 3879.6, 3862]);
  // cut_loss is still first at the cut band (the gate's break-even has no room under the entry).
  const cut = positionAction(positionFacts({ position: SELLP, sym: pmSym(3886), openIntent: INTENT, levels: LV, decision: { ...DEC, stance: "BUY" }, gate: OPEN }), { momentum: "weakening", thesis: "broken" });
  assert.equal(cut.rule, "cut_loss");
  // v4: the peak past the gate, back inside the band at the next run: locked at the gate's first lock, out in profit;
  // the same path before this rule (and legacy) rode it to the full stop.
  const trace = [], legacyTrace = [];
  const run = replayOmega4({ ...base(), ...retraceCase(), trace });
  const old = replayOmega4({ ...base({ settings: { ...OMEGA_DEFAULTS, enabled: true, profit_lock_gate: "legacy" } }), ...retraceCase(), trace: legacyTrace });
  const lock = firstLock(trace);
  assert.ok(lock, "a lock after the retrace");
  assert.equal(lock.reason, "pm_breakeven");
  assert.equal(lock.gates[String(lock.ticket)].open, true);
  assert.ok(lock.mfe_r >= 1, JSON.stringify(lock));
  const step = trace.find((s) => s.now === lock.at);
  assert.ok(step.input.pmActions.some((x) => x.rule === "breakeven"));
  assert.deepEqual([run.records[key(C)].omega4_exit, run.records[key(C)].r_omega4 > 0], ["sl_plus", true]);
  assert.equal(firstLock(legacyTrace), null);
  assert.deepEqual([old.records[key(C)].omega4_exit, old.records[key(C)].r_omega4], ["stop", -1]);
});

test("SLG1-15 legacy is byte for byte the engine before the gate: the old behaviour hash, and gates are never read", async () => {
  // CH1 (2026-11-23): the engine before the gate had no change thresholds either ("off" is today's rules byte for byte).
  assert.equal(await sha256Hex(engineBehaviourSource({ profitLockGate: "legacy", changeThresholds: "" })), OLD_BEHAVIOUR_HASH);
  assert.notEqual(ENGINE_BEHAVIOUR_HASH, OLD_BEHAVIOUR_HASH, "the gate on is a new era (SLG1, a recorded exception)");
  assert.equal(await sha256Hex(engineBehaviourSource()), ENGINE_BEHAVIOUR_HASH);
  // "legacy" ignores any gate facts given.
  for (const [name, input] of handInputs()) {
    const ps = input.executor?.positions ?? [];
    const shut = Object.fromEntries(ps.map((p) => [String(p.ticket), SHUT]));
    assert.deepEqual(planIntents({ ...legacy(input), gates: shut }), planIntents(legacy(input)), name);
  }
  // The PM's pure rules without `gate` are the rules before the gate.
  assert.deepEqual(pmF(3874, undefined).gate, undefined);
  assert.equal(GATE_UNMEASURED.open, false);
});

// ------------------------------------------------------------------------------------------------- the brake

const trade = (i, r, openedMs) => ({ signal_issued_ms: openedMs - 60_000, side: "SELL", opened_ms: openedMs, closed_ms: openedMs + 30 * M1, r });
const SINCE = Date.parse("2026-11-24T00:00:00Z");
const history = ({ pre = 30, preR = 0.3, gated = 30, gatedR = 0.1 } = {}) => [
  ...Array.from({ length: pre }, (_, i) => trade(i, preR, SINCE - (pre - i) * 3600_000)),
  ...Array.from({ length: gated }, (_, i) => trade(i, gatedR, SINCE + (i + 1) * 3600_000))
];

test("SLG1-16 the brake (pure): at least 30 closes under the gate and more than 0.15R below the pre-gate 30; else it holds", () => {
  assert.deepEqual({ ...PLG_BRAKE }, { min_closes: 30, pre_closes: 30, worse_r: 0.15 });
  const worse = profitLockBrake({ trades: history(), sinceMs: SINCE });
  assert.deepEqual([worse.fire, worse.status, worse.gated, worse.pre, worse.mean_gated_r, worse.mean_pre_r, worse.gap_r], [true, "worse", 30, 30, 0.1, 0.3, 0.2]);
  assert.equal(profitLockBrake({ trades: history({ gated: 29 }), sinceMs: SINCE }).status, "insufficient", "29 closes");
  assert.equal(profitLockBrake({ trades: history({ pre: 29 }), sinceMs: SINCE }).status, "insufficient", "no 30 pre-gate closes");
  assert.equal(profitLockBrake({ trades: history({ gatedR: 0.16 }), sinceMs: SINCE }).fire, false, "0.14R below");
  assert.equal(profitLockBrake({ trades: history({ gatedR: 0.5 }), sinceMs: SINCE }).status, "holds");
  // The pre-gate mean is the last 30 before the gate; a position opened before and closed after it is neither.
  const older = [...history(), ...Array.from({ length: 10 }, (_, i) => trade(i, -2, SINCE - 900 * 3600_000 + i * 3600_000)), { ...trade(0, -5, SINCE - 600_000), closed_ms: SINCE + 600_000 }];
  assert.equal(profitLockBrake({ trades: older, sinceMs: SINCE }).mean_pre_r, 0.3);
  assert.match(profitLockBrakeMessage(worse), /profit_lock_gate to 'legacy'.*never switches itself off/);
});

test("SLG1-17 the brake's step: starts the gate's era, sends one line once per era, never changes the setting; 'legacy' clears the era", async () => {
  const e = env();
  await writeSettings(e, { body: { enabled: true }, actor: "owner" }, { now: SINCE - 86_400_000 });
  const settingsBefore = e.DB.raw.prepare("SELECT settings, version FROM omega_settings WHERE id = 1").get();
  const sent = [];
  const send = async (t) => sent.push(t);
  assert.deepEqual(await runProfitLockBrake(e, { now: SINCE, send, trades: history() }), { status: "started", since_ms: SINCE });
  assert.equal(await e.SIGNAL_CACHE.get(PLG_SINCE_KEY), String(SINCE));
  const later = SINCE + 40 * 3600_000;
  assert.equal((await runProfitLockBrake(e, { now: later, send, trades: history({ gated: 29 }) })).status, "insufficient");
  assert.equal(sent.length, 0);
  const fired = await runProfitLockBrake(e, { now: later, send, trades: history() });
  assert.equal(fired.status, "sent");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^XAUUSD OMEGA · Profit-lock gate brake: the 30 closes under the gate average 0\.1R per trade, 0\.2R below the 0\.3R of the 30 closes before it/);
  assert.ok(await e.SIGNAL_CACHE.get(`${PLG_BRAKE_KEY}${SINCE}`));
  // Deduped: the same era never says it again.
  assert.equal((await runProfitLockBrake(e, { now: later + 3600_000, send, trades: history({ gated: 40, gatedR: -1 }) })).status, "sent_before");
  assert.equal(sent.length, 1);
  // It never flips the setting.
  assert.deepEqual(e.DB.raw.prepare("SELECT settings, version FROM omega_settings WHERE id = 1").get(), settingsBefore);
  assert.equal((await readSettings(e)).settings.profit_lock_gate, "on");
  // The owner sets "legacy": the era ends; on again, a new era (and a new line at most).
  await writeSettings(e, { body: { profit_lock_gate: "legacy" }, actor: "owner" }, { now: later + 2 * 3600_000 });
  assert.equal((await runProfitLockBrake(e, { now: later + 2 * 3600_000, send })).status, "legacy");
  assert.equal(await e.SIGNAL_CACHE.get(PLG_SINCE_KEY), null);
  await writeSettings(e, { body: { profit_lock_gate: "on" }, actor: "owner" }, { now: later + 3 * 3600_000 });
  assert.deepEqual(await runProfitLockBrake(e, { now: later + 3 * 3600_000, send }), { status: "started", since_ms: later + 3 * 3600_000 });
  // From the live trades in D1 when none are given (read-only): none here, so it holds as insufficient.
  e.DB.raw.exec("CREATE TABLE IF NOT EXISTS ea_deals (position_ticket INTEGER, side TEXT, volume REAL, entry_price REAL, stop_loss REAL, profit REAL, reason TEXT, opened_ms INTEGER, closed_ms INTEGER, source TEXT, currency TEXT, mode TEXT)");
  assert.equal((await runProfitLockBrake(e, { now: later + 4 * 3600_000, send })).status, "insufficient");
  assert.equal(sent.length, 1);
});

// ---------------------------------------------------------------------------------------------------- helpers

function d1() {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) { params = args.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
function env() {
  resetOmegaBrokerSchemaForTests(); resetPositionSchemaCacheForTests(); resetEaExecutionSchemaForTests();
  const m = new Map();
  return { DB: d1(), SIGNAL_CACHE: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } }, POSITION_MANAGER_MODE: "live", POSITION_COUNCIL_DAILY_USD: "5" };
}
