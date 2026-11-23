// The market path's fixtures (docs/RFC_OMEGA_LIMIT_ENTRY.md stage 3): planIntents with entry_order "market" must give
// exactly what it gave before stage 3. Two groups, generated here deterministically:
//   hand    one input per gate and per sizing branch of the market path, with and without positions and pending orders;
//   replay  every planIntents call of v4's replay (replayOmega4's trace) over a few hours of BUY and SELL decisions, with
//           the TP ladder, the Position Manager's councils and the profile caps.
// test/omega-limit-stage3.test.mjs hashes the outputs and compares them with the hashes taken before stage 3.
import { planIntents, OMEGA_DEFAULTS } from "../../src/omega-engine.mjs";
import { replayOmega4, decisionFromRow } from "../../src/ledger-omega4.mjs";

const ISSUED = Date.parse("2026-11-20T11:00:00Z");
const NOW = ISSUED + 5 * 60_000;
const SIGNAL = { side: "BUY", action: "ENTER_MARKET", entry: 4100, stop: 4095, tp1: 4110, issued_ms: ISSUED, expires_ms: ISSUED + 3_600_000, blackout: false, kill: false, paused: false };
const EXECUTOR = {
  connected: true, received_ms: NOW - 2_000,
  account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20 },
  positions: [], orders: []
};
const ON = { ...OMEGA_DEFAULTS, enabled: true, tp_ladder: false };
const ORDER = { ticket: 777, symbol: "XAUUSD", type: "BUY_LIMIT", volume_initial: 0.1, volume_current: 0.1, price_open: 4098, sl: 4093, tp: 4108, comment: "open:1:B", magic: 920200, source: "omega", placed_ms: NOW - 60_000 };
const POS = { ticket: 501, symbol: "XAUUSD", side: "BUY", volume: 0.2, open_price: 4095, sl: 4090, tp: 4110, intent_id: "open:9:B", magic: 920200, source: "omega", opened_ms: NOW - 3_600_000 };
const ex = (over = {}) => ({ ...EXECUTOR, ...over, account: { ...EXECUTOR.account, ...(over.account ?? {}) }, symbol: { ...EXECUTOR.symbol, ...(over.symbol ?? {}) } });
const sig = (over = {}) => ({ ...SIGNAL, ...over });
const KL = { feed_basis: 0.5, feed_basis_known: true, key_levels: "4090:4091,4104:4105,4112:4113", power: 0.6, power_ms: ISSUED };

/** The hand fixtures: [name, planIntents input]. */
export function handInputs() {
  const base = { signal: SIGNAL, control: { mode: "active" }, settings: ON, executor: EXECUTOR, now: NOW, engineEnabled: true };
  const cases = [
    ["open", {}],
    ["sell", { signal: sig({ side: "SELL", entry: 4101, stop: 4106, tp1: 4091 }) }],
    ["kill", { control: { mode: "killed", at: "2026-11-20T11:01:00.000Z" }, executor: ex({ positions: [POS] }) }],
    ["kill_env", { signal: sig({ kill: true }), executor: ex({ orders: [ORDER] }) }],
    ["engine_off_pending", { settings: { ...ON, enabled: false }, executor: ex({ orders: [ORDER] }) }],
    ["engine_env_off", { engineEnabled: false }],
    ["stale", { executor: ex({ received_ms: NOW - 120_000 }) }],
    ["pending_market_deleted", { executor: ex({ orders: [ORDER, { ...ORDER, ticket: 778, sl: 0 }] }) }],
    ["pending_limit_setting_ignored", { settings: { ...ON, entry_order: "market" }, executor: ex({ orders: [ORDER] }) }],
    ["opposite", { executor: ex({ positions: [{ ...POS, side: "SELL", sl: 4100, tp: 4080 }] }) }],
    ["mean_reversal", { signal: sig({ action: "EXIT" }), executor: ex({ positions: [POS] }) }],
    ["no_side", { signal: sig({ side: "NONE" }) }],
    ["no_side_cell", { signal: sig({ side: "NONE", awaiting_reason: "htf_against" }) }],
    ["expired", { now: ISSUED + 3_600_001, executor: ex({ received_ms: ISSUED + 3_599_000 }) }],
    ["too_old", { now: ISSUED + 11 * 60_000, executor: ex({ received_ms: ISSUED + 11 * 60_000 - 1000 }) }],
    ["blackout", { signal: sig({ blackout: true }) }],
    ["paused", { control: { mode: "paused" } }],
    ["live_not_armed", { executor: ex({ account: { trade_mode: "real" } }) }],
    ["already_opened", { recentIntentIds: [`open:${ISSUED}:B`] }],
    ["max_positions", { executor: ex({ positions: [{ ...POS, side: "BUY", sl: 4096 }] }) }],
    ["same_side_unprotected", { settings: { ...ON, max_positions: 3 }, executor: ex({ positions: [POS] }) }],
    ["same_side_protected", { settings: { ...ON, max_positions: 3 }, executor: ex({ positions: [{ ...POS, sl: 4096 }] }) }],
    ["spread", { executor: ex({ symbol: { spread_points: 90 } }) }],
    ["rollover", { now: Date.parse("2026-11-20T22:00:00Z"), signal: sig({ issued_ms: Date.parse("2026-11-20T21:55:00Z"), expires_ms: Date.parse("2026-11-20T23:00:00Z") }), executor: ex({ received_ms: Date.parse("2026-11-20T22:00:00Z") - 1000 }) }],
    ["symbol_unverified", { executor: ex({ symbol: { currency_profit: "EUR" } }) }],
    ["price_mismatch", { executor: ex({ symbol: { bid: 3000, ask: 3000.2 } }) }],
    ["tick_value", { executor: ex({ symbol: { tick_value_problem: "tick_value_mismatch" } }) }],
    ["money", { executor: ex({ account: { money: { problem: "money_unverified" } } }) }],
    ["spec_unvalidated", { account: { spec_status: "pending", profile: "conservative" } }],
    ["review_pending", { account: { spec_status: "validated", profile: "conservative", review_pending: true } }],
    ["ea_outdated", { eaGate: true, executor: ex({ executor: { version: "1.12" } }) }],
    ["bad_input", { executor: ex({ account: { equity: null } }) }],
    ["daily_loss", { executor: ex({ account: { equity: 9_800 } }) }],
    ["daily_budget", { executor: ex({ account: { equity: 9_801 } }) }],
    ["budget_cap", { executor: ex({ account: { equity: 9_850 } }) }],
    ["wrong_side", { signal: sig({ stop: 4105 }) }],
    ["stops_level", { executor: ex({ symbol: { stops_level_points: 600 } }) }],
    ["limit_waiting", { signal: sig({ action: "ENTER_LIMIT", entry: 4098 }) }],
    ["limit_past", { signal: sig({ action: "ENTER_LIMIT", entry: 4106, tp1: 4116 }) }],
    ["limit_in", { signal: sig({ action: "ENTER_LIMIT", entry: 4100.5 }) }],
    ["stop_breached", { signal: sig({ stop: 4101.5, entry: 4103, tp1: 4110 }) }],
    ["adaptive", { executor: ex({ symbol: { atr_value: 8, atr_points: 800 } }) }],
    ["adaptive_scalp", { signal: sig({ trading_mode: "scalp" }), executor: ex({ symbol: { atr_value: 8, atr_points: 800 } }) }],
    ["tight_5m", { signal: sig({ m5_source: "broker", m5_atr: 2, m5_swing_low: 4098, m5_swing_high: 4104, m5_close_ms: NOW - 60_000 }) }],
    ["vol_low", { executor: ex({ symbol: { atr_value: 1, atr_points: 100 } }) }],
    ["profile_safe", { account: { spec_status: "validated", profile: "safe" } }],
    ["profile_aggr_min_lot", { account: { spec_status: "validated", profile: "aggressive" }, executor: ex({ account: { equity: 300, day_start_balance: 300, balance: 300 } }) }],
    ["volume_below_min", { executor: ex({ account: { equity: 50, day_start_balance: 50, balance: 50 } }) }],
    ["open_risk_cap", { account: { spec_status: "validated", profile: "conservative" }, settings: { ...ON, max_positions: 3, max_daily_loss_pct: 10 }, executor: ex({ account: { equity: 100_000, day_start_balance: 100_000, balance: 100_000 }, positions: [{ ...POS, side: "SELL", sl: 4140, volume: 1.4, ticket: 9, magic: 0, source: "manual", intent_id: null }] }) }],
    ["open_risk_capped", { account: { spec_status: "validated", profile: "conservative" }, settings: { ...ON, max_positions: 3, risk_pct: 2, max_daily_loss_pct: 10 }, executor: ex({ account: { equity: 100_000, day_start_balance: 100_000, balance: 100_000 }, positions: [{ ...POS, side: "SELL", sl: 4140, volume: 1.2, ticket: 9, magic: 0, source: "manual", intent_id: null }] }) }],
    ["probation", { signal: sig({ probation: true, risk_scale: 0.5, trade_agent: "zone_pullback", htf_context: "against" }), account: { spec_status: "validated", profile: "aggressive" } }],
    ["probation_busy", { signal: sig({ probation: true }), settings: { ...ON, max_positions: 3 }, executor: ex({ positions: [{ ...POS, sl: 4096 }] }), positionMeta: { "open:9:B": { probation: true } } }],
    ["agent_grid", { signal: sig({ trade_agent: "zone_pullback", agent_conf: "zone_pullback:0.7:0.2", grid_cell: "c1", grid_slice: "s1", trading_mode: "intraday", trigger_source: "broker" }) }],
    ["reentry", { reentry: { side: "BUY", exit_ms: NOW, exit_price: 4100 } }],
    ["arm_strategy", { signal: sig({ arm_mode: "armed", trade_agent: "zone_pullback" }), settings: { ...ON, max_positions: 3 }, executor: ex({ positions: [{ ...POS, sl: 4096 }] }), agents: { "open:9:B": "zone_pullback" } }],
    ["manage_be", { settings: { ...ON, trailing_stop_r: 1, max_positions: 3 }, signal: sig({ side: "NONE" }), executor: ex({ symbol: { bid: 4101, ask: 4101.2 }, positions: [{ ...POS, open_price: 4095, sl: 4090 }] }) }],
    ["manage_key_levels", { signal: sig({ ...KL }), settings: { ...ON, max_positions: 3 }, executor: ex({ symbol: { bid: 4106, ask: 4106.2 }, positions: [{ ...POS, open_price: 4099, sl: 4094 }] }) }],
    ["manage_ladder", { signal: sig({ ...KL, side: "NONE" }), settings: { ...ON, tp_ladder: true }, executor: ex({ symbol: { bid: 4106, ask: 4106.2 }, positions: [{ ...POS, open_price: 4099, sl: 4094 }] }), positionMeta: { "open:9:B": { mode: "scalp", r_dist: 5 } } }],
    ["manage_ladder_candles", { signal: sig({ ...KL, side: "NONE" }), settings: { ...ON, tp_ladder: true }, executor: ex({ symbol: { bid: 4106, ask: 4106.2 }, positions: [{ ...POS, open_price: 4099, sl: 4094 }] }), positionMeta: { "open:9:B": { mode: "intraday", r_dist: 5 } }, candles: { M15: { o: 4101, c: 4105, close_ms: NOW - 60_000 } } }],
    ["strategy_exit", { signal: sig({ ...KL, strategy_execution: true, power: -0.4, power_ms: NOW - 60_000 }), executor: ex({ positions: [POS] }) }],
    ["pm_actions", { executor: ex({ positions: [POS] }), pmActions: [{ id: `pm:501:${Math.floor(NOW / 300_000)}`, ticket: 501, action: "sl", rule: "breakeven", sl: 4095.2 }, { id: "pm:999:1", ticket: 999, action: "close", rule: "cut_loss" }] }],
    ["pm_tp2", { executor: ex({ positions: [{ ...POS, sl: 4096 }], executor: { version: "1.21" } }), signal: sig({ ...KL, side: "NONE" }), settings: { ...ON, tp_ladder: true }, pmActions: [{ id: "pm:501:7", ticket: 501, action: "tp", rule: "tp2_target", tp: 4120, sl: 4096 }] }],
    ["stops_commanded", { executor: ex({ positions: [POS] }), signal: sig({ ...KL, side: "NONE" }), stops: { 501: [4097] }, settings: { ...ON, trailing_stop_r: 0.5 } }],
    ["pending_kept_counts_in_market", { settings: { ...ON, max_positions: 3 }, executor: ex({ orders: [{ ...ORDER, comment: "x" }] }) }]
  ];
  return cases.map(([name, over]) => [name, { ...base, ...over }]);
}

// ---------------------------------------------------------------------------- the replay group

const M1 = 60_000, M15 = 15 * M1;
const C = Date.parse("2026-11-19T12:00:00Z");
const key = (close) => `OANDA:XAUUSD:15:${close - M15}`;
function path(from, to, price, wiggle = 0.05) {
  const out = [];
  for (let t = from; t < to; t += M1) {
    const o = price(t), c = price(t + M1);
    out.push({ open_time: new Date(t).toISOString(), close_time: new Date(t + M1).toISOString(), open: o, high: Math.max(o, c) + wiggle, low: Math.min(o, c) - wiggle, close: c });
  }
  return out;
}
const lerp = (pts) => (t) => {
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const [a, pa] = pts[i - 1], [b, pb] = pts[i]; return Math.round((pa + ((pb - pa) * (t - a)) / (b - a)) * 1000) / 1000; }
  return pts.at(-1)[1];
};
const conf = (long, short) => ({ zone_pullback: { long, short } });
function decision({ close, stance, trade = null, score = 0, shares = [0.5, 0.5], lv = [], mode = "intraday", c = conf(0.6, 0.6), cp = conf(0.6, 0.6) }) {
  return {
    decision_key: key(close), bar_close: new Date(close).toISOString(), decided_at: new Date(close + 2 * M1).toISOString(), stance, confidence: 0.7,
    trade, guardrails: { long: { entry_trigger: { fired: false, note: "waiting" } }, short: { entry_trigger: { fired: false, note: "waiting" } } },
    quorum: { score, long_share: shares[0], short_share: shares[1] }, key_levels: lv, agent_confidence: c, agent_confidence_prev: cp,
    trading_mode: mode, strategy_execution: true, context: { regime_1h: "normal-trending" }, strategy: { atr_h1: 5 }
  };
}
const trade = (side, entry, stop, tp) => ({ side, action: "ENTER_LIMIT", entry, stop, tp, tp1: tp, target: "tp1", agent: "zone_pullback" });
const dec = (d) => decisionFromRow({ decision_json: JSON.stringify(d) });

/** The replay scenarios: { name, opts } for replayOmega4 (each runs with a trace). */
export function replayScenarios() {
  const LV = [{ low: 1985, high: 1986 }, { low: 2010, high: 2011 }, { low: 2024, high: 2025 }];
  const pts = [[C - 5 * 3600_000, 2000], [C, 2000], [C + 10 * M1, 2003], [C + 40 * M1, 2016], [C + 70 * M1, 2026], [C + 95 * M1, 2012], [C + 130 * M1, 1994], [C + 170 * M1, 1984], [C + 200 * M1, 1999], [C + 240 * M1, 2008]];
  const decisions = [
    decision({ close: C, stance: "BUY", trade: trade("BUY", 2002, 1996, 2014), score: 0.5, shares: [0.7, 0.2], lv: LV }),
    decision({ close: C + M15, stance: "WAIT", score: 0.3, shares: [0.6, 0.3], lv: LV }),
    decision({ close: C + 2 * M15, stance: "WAIT", score: 0.2, shares: [0.5, 0.3], lv: LV, c: conf(0.5, 0.5), cp: conf(0.7, 0.4) }),
    decision({ close: C + 5 * M15, stance: "SELL", trade: trade("SELL", 2020, 2028, 2004), score: -0.5, shares: [0.2, 0.7], lv: LV, mode: "scalp" }),
    decision({ close: C + 6 * M15, stance: "WAIT", score: -0.1, shares: [0.4, 0.5], lv: LV }),
    decision({ close: C + 8 * M15, stance: "SELL", trade: trade("SELL", 1995, 2003, 1986), score: -0.6, shares: [0.1, 0.8], lv: LV, mode: "swing" }),
    decision({ close: C + 11 * M15, stance: "BUY", trade: trade("BUY", 1986, 1980, 1999), score: 0.4, shares: [0.7, 0.2], lv: LV }),
    decision({ close: C + 13 * M15, stance: "WAIT", score: 0.1, shares: [0.5, 0.4], lv: LV })
  ];
  const councils = {};
  return [
    { name: "aggressive", opts: { bars: path(C - 5 * 3600_000, C + 250 * M1, lerp(pts)), decisions: decisions.map(dec), from: C, settings: { ...OMEGA_DEFAULTS, enabled: true }, profileAt: () => "aggressive", councils } },
    { name: "safe_no_ladder", opts: { bars: path(C - 5 * 3600_000, C + 250 * M1, lerp(pts)), decisions: decisions.map(dec), from: C, settings: { ...OMEGA_DEFAULTS, enabled: true, tp_ladder: false, trailing_stop_r: 1 }, profileAt: () => "safe", councils } },
    // The live settings may hold entry_order "limit" or "council": v4 stays a market replay whatever the setting says.
    { name: "limit_setting_is_market", opts: { bars: path(C - 5 * 3600_000, C + 250 * M1, lerp(pts)), decisions: decisions.map(dec), from: C, settings: { ...OMEGA_DEFAULTS, enabled: true, entry_order: "limit" }, profileAt: () => "aggressive", councils } }
  ];
}

/**
 * Every output of the two groups, in order ({ group, name, output }). `profitLockGate` (SLG1, 2026-11-23) sets
 * profit_lock_gate on every input: "legacy" is the code before the gate byte for byte.
 */
export function marketOutputs({ plan = planIntents, profitLockGate = null } = {}) {
  const gate = (settings) => (profitLockGate ? { ...settings, profit_lock_gate: profitLockGate } : settings);
  const out = [];
  for (const [name, input] of handInputs()) out.push({ group: "hand", name, output: plan({ ...input, settings: gate(input.settings) }) });
  for (const s of replayScenarios()) {
    const trace = [];
    const run = replayOmega4({ ...s.opts, settings: gate(s.opts.settings), trace, plan });
    out.push({ group: "replay", name: s.name, calls: trace.length, output: trace.map((t) => t.output), records: run.records });
  }
  return out;
}
