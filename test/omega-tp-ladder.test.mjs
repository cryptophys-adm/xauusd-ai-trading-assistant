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

test("RE1 the same-side re-entry guard: a closed 15m bar after a weakening exit, then a 0.5×ATR pullback or the agent's confidence back", async () => {
  const { reentryGate, planIntents } = await import("../src/omega-engine.mjs");
  const exitMs = Date.parse("2026-11-18T10:02:37Z");
  const reentry = { side: "SELL", exit_price: 3774.92, exit_ms: exitMs, entry_conf: 0.7 };
  const sym = { bid: 3775.5, ask: 3775.65, digits: 2, atr_value: 4 };
  // The 10:15 signal (bar 10:00-10:15) opened before the exit: cooldown.
  assert.equal(reentryGate({ side: "SELL", reentry, signal: { issued_ms: Date.parse("2026-11-18T10:15:00Z") }, sym }).code, "reentry_cooldown");
  // The 10:30 signal's bar opened after it: now the pullback (need ≥ 3776.92) or the confidence.
  const later = { issued_ms: Date.parse("2026-11-18T10:30:00Z"), trade_agent: "zone_pullback", agent_conf: "zone_pullback:0.1:0.5" };
  const g = reentryGate({ side: "SELL", reentry, signal: later, sym });
  assert.equal(g.code, "reentry_needs_pullback");
  assert.match(g.detail, /need ≥ 3776\.92/);
  assert.equal(reentryGate({ side: "SELL", reentry, signal: later, sym: { ...sym, bid: 3777 } }), null, "pulled back");
  assert.equal(reentryGate({ side: "SELL", reentry, signal: { ...later, agent_conf: "zone_pullback:0.1:0.75" }, sym }), null, "confidence recovered");
  assert.equal(reentryGate({ side: "BUY", reentry, signal: later, sym }), null, "the other side is free");
  assert.equal(reentryGate({ side: "SELL", reentry: null, signal: later, sym }), null);
  // In the planner: the note and no open.
  const exec = { connected: true, trade_allowed: true, received_ms: Date.parse("2026-11-18T10:30:05Z"), account: { trade_mode: "demo", currency: "USD", balance: 1000, equity: 1000, day_start_balance: 1000 }, symbol: { name: "GOLD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_step: 0.01, volume_max: 50, stops_level_points: 0, bid: 3775.5, ask: 3775.65, spread_points: 15, atr_value: 4 }, positions: [] };
  const signal = { side: "SELL", action: "ENTER_MARKET", entry: 3775.5, stop: 3785, tp1: 3760, issued_ms: Date.parse("2026-11-18T10:30:00Z"), expires_ms: Date.parse("2026-11-18T10:40:00Z"), blackout: false, kill: false, paused: false };
  const p = planIntents({ signal, control: { mode: "active" }, settings: { ...S, max_positions: 3 }, executor: exec, now: Date.parse("2026-11-18T10:30:06Z"), engineEnabled: true, reentry });
  assert.equal(p.notes.at(-1).code, "reentry_needs_pullback");
  assert.ok(!p.intents.some((i) => i.kind === "open"));
});
