// RE1's fixtures (src/reentry-1m.mjs): exits for the eligibility, closed broker M1 bars for the trigger and each guard,
// re-entry triggers through planIntents' opening checks, and a v4 replay where a break-even stop is re-entered.
// Generated here deterministically; test/reentry-1m.test.mjs asserts on them and test/fixtures/engine-behaviour.mjs
// hashes their outputs into ENGINE_BEHAVIOUR_HASH (with reentry_1m on only). Opaque tickets only; no account, no login.
import { reentryCheck, reentrySetup, reentryId } from "../../src/reentry-1m.mjs";
import { planIntents, OMEGA_DEFAULTS } from "../../src/omega-engine.mjs";
import { replayOmega4 } from "../../src/ledger-omega4.mjs";
import { base, C, M1, WARM, path, lerp, decision, dec, levels, sellTrade } from "./omega-v4-replay.mjs";

export const T0 = Date.parse("2026-11-24T09:00:00Z"); // a Tuesday morning
const r2 = (v) => Math.round(v * 100) / 100;
export const SYM = Object.freeze({ point: 0.01, digits: 2, spread_points: 20 });

/** Bars from closes (each opens at the close before), wicks of `wick`, the spread in points on each. */
export function barsFrom(closes, { start = T0, from = closes[0], wick = 0.3, spread = 20 } = {}) {
  const out = [];
  let px = from;
  closes.forEach((c, i) => { const o = r2(px); out.push({ t: start + i * M1, o, h: r2(Math.max(o, c) + wick), l: r2(Math.min(o, c) - wick), c, s: spread }); px = c; });
  return out;
}
/** A SELL's path: 40 bars around 1996.5, the exit bar up through the lock (40), a pullback (41-43), then back down. */
export const EXIT_I = 40;
export function sellCloses(tail = [1999.0, 1999.0]) {
  const pre = Array.from({ length: EXIT_I }, (_, i) => (i % 2 ? 1996.8 : 1996.2));
  return [...pre, 1999.6, 2000.2, 2000.6, 2000.0, ...tail];
}
export const sellBars = (tail) => barsFrom(sellCloses(tail));
export const nowAfter = (list, ms = 2000) => list.at(-1).t + M1 + ms;
/** The setup a SELL break-even stop leaves: entry 2000, the original stop 2010 (R 10), TP1 1980, the lock 1999.5. */
export const sellSetup = (over = {}) => ({
  ticket: 202, side: "SELL", entry: 2000, lock: 1999.5, lock_rule: "pm_breakeven", exit_ms: T0 + EXIT_I * M1 + 40_000, exit_price: 1999.7, orig_sl: 2010, tp1: 1980, r_dist: 10,
  mode: "intraday", issued_ms: T0 - 10 * M1, strategy: "zone_pullback", risk_money: 50, realized: 0.5, ...over
});
/** A BUY mirror: bars around 2003.5, the exit bar down through the lock 2000.5, a pullback, then back up. */
export function buyBars(tail = [2001.0, 2001.0]) {
  const pre = Array.from({ length: EXIT_I }, (_, i) => (i % 2 ? 2003.2 : 2003.8));
  return barsFrom([...pre, 2000.4, 1999.8, 1999.4, 2000.0, ...tail]);
}
export const buySetup = (over = {}) => ({ ...sellSetup(), side: "BUY", lock: 2000.5, exit_price: 2000.3, orig_sl: 1990, tp1: 2020, ticket: 101, ...over });
export const SELL_SIGNAL = Object.freeze({ side: "SELL", blackout: false });
export const BUY_SIGNAL = Object.freeze({ side: "BUY", blackout: false });

/** Shift bars so the last one opens at `iso`. */
export const at = (list, iso) => { const shift = Date.parse(iso) - list.at(-1).t; return list.map((b) => ({ ...b, t: b.t + shift })); };
export const shiftSetup = (setup, list, shifted) => { const d = shifted.at(-1).t - list.at(-1).t; return { ...setup, exit_ms: setup.exit_ms + d, issued_ms: setup.issued_ms + d }; };

/** Every case of the pure check, [name, input] (reentryCheck's arguments). */
export function checkCases() {
  const b = sellBars(), now = nowAfter(b), s = sellSetup();
  const go = { setup: s, signal: SELL_SIGNAL, bars: b, now, sym: SYM };
  const bb = buyBars();
  const shifted = (iso) => { const x = at(b, iso); return { ...go, bars: x, now: nowAfter(x), setup: shiftSetup(s, b, x) }; };
  const late = b.map((x, i) => (i === b.length - 3 ? { ...x, r: x.t + M1 + 120_000 } : { ...x, r: x.t + M1 + 1500 }));
  return [
    ["trigger", go],
    ["trigger_buy", { setup: buySetup(), signal: BUY_SIGNAL, bars: bb, now: nowAfter(bb), sym: SYM }],
    ["no_setup", { ...go, setup: null }],
    ["window", { ...go, setup: sellSetup({ issued_ms: now - 241 * M1 }) }],
    ["used", { ...go, used: true }],
    ["superseded", { ...go, superseded: true }],
    ["decision_wait", { ...go, signal: { side: "NONE" } }],
    ["decision_other_side", { ...go, signal: BUY_SIGNAL }],
    ["stop_touched", { ...go, setup: sellSetup({ orig_sl: 2001 }) }],
    ["tp1_reached", { ...go, setup: sellSetup({ tp1: 1999.2 }) }],
    ["too_soon", { ...go, bars: b.slice(0, -1), now: nowAfter(b.slice(0, -1)) }],
    ["no_trigger", (() => { const x = sellBars([1999.0, 1999.6]); return { ...go, bars: x, now: nowAfter(x) }; })()],
    ["stop_wide", { ...go, setup: sellSetup({ r_dist: 2 }) }],
    ["reward", { ...go, setup: sellSetup({ tp1: 1998 }) }],
    ["setup_loss_cap", { ...go, setup: sellSetup({ realized: -50 }) }],
    ["setup_loss_part", { ...go, setup: sellSetup({ realized: -20 }) }],
    ["spread", { ...go, sym: { ...SYM, spread_points: 61 } }],
    ["spread_spike", { ...go, bars: b.map((x) => ({ ...x, s: 10 })), sym: { ...SYM, spread_points: 25 } }],
    ["spread_unmeasured", { ...go, bars: b.map((x) => ({ ...x, s: null })) }],
    ["release_window", { ...go, signal: { ...SELL_SIGNAL, blackout: true, blackout_reason: "US CPI" } }],
    ["rollover", shifted("2026-11-24T21:58:00Z")],
    ["reopen_daily", shifted("2026-11-24T23:12:00Z")],
    ["reopen_passed", shifted("2026-11-24T23:16:00Z")],
    ["reopen_weekly", shifted("2026-11-22T23:13:00Z")],
    ["market_paused", shifted("2026-11-24T22:30:00Z")],
    ["reconnect", { ...go, bars: late }],
    ["stale", { ...go, now: now + 91_000 }],
    ["warmup", { ...go, bars: b.filter((_, i) => i !== b.length - 12) }],
    ["no_stream", { ...go, bars: [] }]
  ];
}

/** Exits through reentrySetup, [name, input]: which stops are profit-lock stops. */
export function setupCases() {
  const open = { entry: 2000, sl: 2010, tp: 1980, r_dist: 10, volume: 0.05, mode: "intraday", signal_issued_ms: T0 - 10 * M1, strategy: "zone_pullback" };
  const x = { ticket: 202, side: "SELL", intentId: "open:1:S", entry: 2000, stopHit: true, stop: 1999.5, stopRule: "pm_breakeven", exitMs: T0 + EXIT_I * M1 + 40_000, exitPrice: 1999.7, open, realized: 0.5, moneyPerPriceLot: 100 };
  return [
    ["pm_breakeven", x],
    ["break_even", { ...x, stopRule: "break_even", stop: 2000 }],
    ["ladder_lock_tp0", { ...x, stopRule: "ladder_lock_tp0", stop: 1999.6 }],
    ["ladder_lock_tp1", { ...x, stopRule: "ladder_lock_tp1", stop: 1990 }],
    ["sl_key_level", { ...x, stopRule: "sl_key_level_strong", stop: 1998 }],
    ["pm_fast_tp", { ...x, stopRule: "pm_fast_tp", stop: 1995 }],
    ["initial_stop", { ...x, stop: 2010, stopRule: null }],
    ["trail_in_profit", { ...x, stopRule: "trail_5m", stop: 1998 }],
    ["fast_cut", { ...x, stopRule: "pm_fast_cut", stop: 2004 }],
    ["lock_rule_in_loss", { ...x, stopRule: "break_even", stop: 2000.5 }],
    ["cut_loss", { ...x, stopHit: false }],
    ["take_profit_weakening", { ...x, stopHit: false, realized: 30 }],
    ["own_reentry", { ...x, intentId: "re:101:29900000" }],
    ["delegated", { ...x, intentId: "deleg:202" }],
    ["no_plan", { ...x, open: { ...open, tp: null } }]
  ];
}

// planIntents with a trigger: the opening checks every entry has.
const P_NOW = Date.parse("2026-11-24T09:46:02Z");
const P_ISSUED = P_NOW - 40 * M1;
export const P_SIGNAL = Object.freeze({ side: "SELL", action: "ENTER_MARKET", entry: 2000, stop: 2010, tp1: 1980, issued_ms: P_ISSUED, expires_ms: P_ISSUED + 15 * M1, decided_ms: P_ISSUED + 2 * M1, blackout: false, kill: false, paused: false, trade_agent: "zone_pullback", agent_conf: "zone_pullback:0.6:0.8", trading_mode: "intraday" });
export const P_EXECUTOR = Object.freeze({
  connected: true, received_ms: P_NOW - 2_000,
  account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 1999.0, ask: 1999.2, spread_points: 20 },
  positions: [], orders: []
});
export const P_TRIGGER = Object.freeze({ status: "trigger", code: "trigger", id: reentryId(202, P_NOW - 62_000), side: "SELL", ticket: 202, sl: 2001.5, tp: 1980, lock: 1999.5, lock_rule: "pm_breakeven", extreme: 2001.1, atr: 1.2, spread_points: 20, entry: 1999.0,
  max_risk: 50, max_stop_dist: 10, mode: "intraday", issued_ms: P_ISSUED, strategy: "zone_pullback", bar_ms: P_NOW - 62_000, why: "a fixture trigger" });
const ON = { ...OMEGA_DEFAULTS, enabled: true, tp_ladder: false };
const pex = (over = {}) => ({ ...P_EXECUTOR, ...over, account: { ...P_EXECUTOR.account, ...(over.account ?? {}) }, symbol: { ...P_EXECUTOR.symbol, ...(over.symbol ?? {}) } });
const OTHER = (i, over = {}) => ({ ticket: 900 + i, symbol: "XAUUSD", side: "BUY", volume: 0.01, open_price: 1990, sl: 1985, tp: 2010, intent_id: null, magic: 0, source: "manual", opened_ms: P_NOW - 3_600_000, ...over });

/** planIntents inputs with a re-entry trigger, [name, input]. */
export function planCases() {
  const base0 = { signal: P_SIGNAL, control: { mode: "active" }, settings: ON, executor: P_EXECUTOR, now: P_NOW, engineEnabled: true, reentry1m: P_TRIGGER };
  const cases = [
    ["open", {}],
    ["off", { settings: { ...ON, reentry_1m: "off" } }],
    ["no_trigger", { reentry1m: null }],
    ["fresh_signal_first", { signal: { ...P_SIGNAL, issued_ms: P_NOW - 3 * M1, expires_ms: P_NOW + 12 * M1, decided_ms: P_NOW - M1 } }],
    ["other_side", { reentry1m: { ...P_TRIGGER, side: "BUY" } }],
    ["already_opened", { recentIntentIds: [P_TRIGGER.id] }],
    ["kill", { control: { mode: "killed", at: "2026-11-24T09:40:00.000Z" } }],
    ["paused", { control: { mode: "paused" } }],
    ["engine_off", { settings: { ...ON, enabled: false } }],
    ["engine_env_off", { engineEnabled: false }],
    ["live_not_armed", { executor: pex({ account: { trade_mode: "real" } }) }],
    ["tick_value_mismatch", { executor: pex({ symbol: { tick_value_problem: "tick_value_mismatch" } }) }],
    ["spread", { executor: pex({ symbol: { spread_points: 90 } }) }],
    ["blackout", { signal: { ...P_SIGNAL, blackout: true } }],
    ["rollover", { now: Date.parse("2026-11-24T22:00:00Z"), signal: { ...P_SIGNAL, issued_ms: Date.parse("2026-11-24T21:00:00Z"), expires_ms: Date.parse("2026-11-24T21:15:00Z") }, executor: pex({ received_ms: Date.parse("2026-11-24T22:00:00Z") - 1000 }) }],
    ["max_positions", { executor: pex({ positions: [OTHER(1)] }) }],
    ["platform_cap", { settings: { ...ON, max_positions: 5 }, executor: pex({ positions: [OTHER(1), OTHER(2), OTHER(3)] }) }],
    ["platform_room", { settings: { ...ON, max_positions: 5 }, executor: pex({ positions: [OTHER(1), OTHER(2)] }) }],
    ["reentry_cooldown", { reentry: { side: "SELL", exit_ms: P_NOW - 30_000, exit_price: 1999.4, ticket: 77 } }],
    ["daily_loss_limit", { executor: pex({ account: { equity: 9_800 } }) }],
    ["daily_risk_budget", { executor: pex({ account: { equity: 9_801 } }) }],
    ["stop_wide_live", { executor: pex({ symbol: { bid: 1991, ask: 1991.2 } }), reentry1m: { ...P_TRIGGER, max_stop_dist: 10, tp: 1970 } }],
    ["reward_live", { reentry1m: { ...P_TRIGGER, tp: 1997 } }],
    ["stops_level", { executor: pex({ symbol: { stops_level_points: 300 } }) }],
    ["risk_capped", { reentry1m: { ...P_TRIGGER, max_risk: 30 } }],
    ["risk_cap_min_lot", { reentry1m: { ...P_TRIGGER, max_risk: 1 } }],
    ["volume_below_min", { executor: pex({ account: { equity: 50, day_start_balance: 50, balance: 50 } }) }],
    ["original_cap", { settings: { ...ON, risk_pct: 2 } }],
    ["profile_cap", { settings: { ...ON, risk_pct: 2 }, account: { spec_status: "validated", profile: "safe" }, reentry1m: { ...P_TRIGGER, max_risk: 200 } }],
    ["profile_min_lot_cap", { account: { spec_status: "validated", profile: "aggressive" }, executor: pex({ account: { equity: 300, day_start_balance: 300, balance: 300 } }), reentry1m: { ...P_TRIGGER, max_risk: 1.5 } }],
    ["spec_unvalidated", { account: { spec_status: "pending", profile: "conservative" } }],
    ["limit_mode", { settings: { ...ON, entry_order: "limit" }, executor: pex({ executor: { version: "1.21" } }) }]
  ];
  return cases.map(([name, over]) => [name, { ...base0, ...over }]);
}

/** v4: a SELL whose break-even stop is hit, then price turns back down through the lock: one re-entry, run to TP1. */
export function reentryCase() {
  const d0 = decision({ close: C, trade: sellTrade(2000, 2005, 1985), lv: levels([[1940, 1942]]) });
  const price = lerp([[C + 3 * M1, 2000], [C + 5 * M1, 1999], [C + 6 * M1, 1993], [C + 7 * M1, 1999], [C + 40 * M1, 1999], [C + 46 * M1, 2001], [C + 52 * M1, 1998], [C + 90 * M1, 1984]]);
  return { bars: path(C - WARM, C + 100 * M1, price, 0.05), decisions: [dec(d0)], to: C + 100 * M1 };
}
export const reentryReplayScenarios = () => [{ name: "breakeven_reentry", opts: { ...base(), ...reentryCase() } }];

/** The fingerprint's lines (test/fixtures/engine-behaviour.mjs), with the re-entry on (its default). */
export function reentryLines() {
  const lines = [];
  lines.push(`re/setup=${JSON.stringify(setupCases().map(([name, input]) => [name, reentrySetup(input)]))}`);
  lines.push(`re/check=${JSON.stringify(checkCases().map(([name, input]) => [name, reentryCheck(input)]))}`);
  lines.push(`re/plan=${JSON.stringify(planCases().map(([name, input]) => [name, planIntents(input)]))}`);
  for (const s of reentryReplayScenarios()) {
    const trace = [];
    const run = replayOmega4({ ...s.opts, trace });
    lines.push(`re/v4/${s.name}/trace=${JSON.stringify(trace.map((t) => [t.now, t.output]))}`);
    lines.push(`re/v4/${s.name}/records=${JSON.stringify(run.records)}`);
  }
  return lines;
}
