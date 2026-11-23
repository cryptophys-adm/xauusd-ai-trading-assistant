// CH1 (owner 2026-11-23): the change thresholds' cases, deterministic, for the behaviour fingerprint
// (test/fixtures/engine-behaviour.mjs, group "change", written only with the tokens on) and the tests
// (test/change-thresholds.test.mjs). Outputs only; the inputs are built here.
//   pm       positionAction over SELL positions in the profit band, beyond TP1 and in the loss band, per mode, over
//            decisions whose history confirms or does not confirm a share fall, a confidence drop or the stance;
//   exits    strategyExits' confidence_drop close and extend gate, with a confidence trend known and unknown;
//   pending  pendingDeleteReason's quorum_share_drop on the current decision alone and confirmed by the one before.
import { positionFacts, positionAction } from "../../src/position-manager.mjs";
import { strategyExits, pendingDeleteReason, OMEGA_DEFAULTS } from "../../src/omega-engine.mjs";
import { decisionHistory, changeTokens } from "../../src/change-thresholds.mjs";
import { limitKnobs } from "../../src/omega-limit-knobs.mjs";

export const M15 = 15 * 60_000;
export const C0 = Date.parse("2026-11-24T10:00:00Z");
export const symAt = (bid) => ({ bid, ask: Math.round((bid + 0.2) * 100) / 100, point: 0.01, digits: 2, spread_points: 20, stops_level_points: 0 });
export const SELL = { ticket: 101, side: "SELL", open_price: 3880, sl: 3890, tp: 3870, volume: 0.01, intent_id: "open:1:S", magic: 920200, source: "omega" };
export const intentOf = (mode) => ({ tp: 3870, sl: 3890, entry: 3880, strategy: "zone_pullback", mode, r_dist: 10 });
const iso = (ms) => new Date(ms).toISOString();

/**
 * A SELL-side decision row at close `close` with the short share and the zone_pullback short confidence given, and its
 * stance; `confPrev` the confidence stored as its agent_confidence_prev.
 */
export function row({ close, stance = "SELL", short, conf, confPrev = null }) {
  return { decision_key: `XAUUSD:15:${close}`, bar_close: iso(close), close_ms: close, stance, quorum: { long_share: Math.round((1 - short) * 100) / 100, short_share: short },
    agent_confidence: { zone_pullback: { long: 0.3, short: conf } }, agent_confidence_prev: confPrev == null ? null : { zone_pullback: { long: 0.3, short: confPrev } }, trading_mode: "intraday" };
}
/**
 * The Position Manager's decision (as latestDecisions builds it) from three consecutive closes, oldest first:
 * [[stance, short share, confidence], ...]; `gap` breaks the series before the latest.
 */
export function pmDecision(series, { gap = false } = {}) {
  const rows = series.map(([stance, short, conf], i) => row({ close: C0 + (i - series.length + 1) * M15 - (gap && i < series.length - 1 ? M15 : 0), stance, short, conf, confPrev: i > 0 ? series[i - 1][2] : null }));
  const [d, r1, r2] = [rows.at(-1), rows.at(-2) ?? null, rows.at(-3) ?? null];
  const fresh = r1 && d.close_ms - r1.close_ms === M15;
  return { ...d, agent_confidence_prev: fresh ? d.agent_confidence_prev : null, quorum_prev: fresh ? r1.quorum : null, decision_history: decisionHistory(d, r1, r2) };
}

export const DECISION_SERIES = Object.freeze({
  steady: [["SELL", 0.9, 0.8], ["SELL", 0.9, 0.8], ["SELL", 0.9, 0.8]],
  share_one_bar_099: [["SELL", 0.9, 0.8], ["SELL", 0.9, 0.8], ["SELL", 0.801, 0.8]],
  share_one_bar_10: [["SELL", 0.9, 0.8], ["SELL", 0.9, 0.8], ["SELL", 0.8, 0.8]],
  share_two_bars: [["SELL", 0.9, 0.8], ["SELL", 0.78, 0.8], ["SELL", 0.79, 0.8]],
  share_two_bars_reverted: [["SELL", 0.9, 0.8], ["SELL", 0.78, 0.8], ["SELL", 0.85, 0.8]],
  share_swing_149: [["SELL", 0.9, 0.8], ["SELL", 0.751, 0.8], ["SELL", 0.751, 0.8]],
  share_swing_15: [["SELL", 0.9, 0.8], ["SELL", 0.75, 0.8], ["SELL", 0.75, 0.8]],
  conf_one_bar_049: [["SELL", 0.9, 0.8], ["SELL", 0.9, 0.8], ["SELL", 0.9, 0.751]],
  conf_one_bar_05: [["SELL", 0.9, 0.8], ["SELL", 0.9, 0.8], ["SELL", 0.9, 0.75]],
  conf_two_bars: [["SELL", 0.9, 0.8], ["SELL", 0.9, 0.74], ["SELL", 0.9, 0.745]],
  conf_noise: [["SELL", 0.9, 0.8], ["SELL", 0.9, 0.8], ["SELL", 0.9, 0.77]],
  stance_two: [["SELL", 0.9, 0.8], ["BUY", 0.9, 0.8], ["BUY", 0.9, 0.8]],
  stance_one: [["SELL", 0.9, 0.8], ["SELL", 0.9, 0.8], ["BUY", 0.9, 0.8]],
  stance_reverted: [["SELL", 0.9, 0.8], ["BUY", 0.9, 0.8], ["SELL", 0.9, 0.8]],
  share_gap: [["SELL", 0.9, 0.8], ["SELL", 0.78, 0.8], ["SELL", 0.78, 0.8]]
});
export const COUNCILS = Object.freeze([null, { momentum: "weakening", thesis: "weakening", reason: "r" }, { momentum: "holding", thesis: "intact", reason: "r" }, { momentum: "weakening", thesis: "broken", reason: "r" }]);
/** SELL prices: in the loss band (-0.5R+), inside the band, in the profit band, beyond TP1 by 30 pips. */
export const BIDS = Object.freeze([3886, 3879, 3874, 3866.8]);

/** Pure: the fingerprint's lines for the change thresholds with `changeThresholds` (the setting's value). */
export function changeLines(changeThresholds = OMEGA_DEFAULTS.change_thresholds) {
  const changes = changeTokens({ change_thresholds: changeThresholds });
  const lines = [];
  const actions = [];
  for (const [name, series] of Object.entries(DECISION_SERIES)) {
    const decision = pmDecision(series, { gap: name === "share_gap" });
    for (const mode of ["scalp", "intraday", "swing", "range"]) {
      for (const bid of BIDS) {
        const f = positionFacts({ position: SELL, sym: symAt(bid), openIntent: intentOf(mode), levels: [], decision, ...(changes.length ? { changes } : {}) });
        for (const [ci, c] of COUNCILS.entries()) actions.push([`${name}|${mode}|${bid}|${ci}`, positionAction(f, c)]);
      }
    }
  }
  lines.push(`change/pm=${JSON.stringify(actions)}`);
  const exits = [];
  const pos = { ...SELL, ticket: 202 };
  for (const [name, conf, prev, last, lastPrev] of [["drop_05", "zone_pullback:0.3:0.75", "zone_pullback:0.3:0.8", "", ""], ["drop_03", "zone_pullback:0.3:0.77", "zone_pullback:0.3:0.8", "", ""],
    ["unknown_last_stable", "zone_pullback:0.3:0.8", "", "zone_pullback:0.3:0.8", "zone_pullback:0.3:0.79"], ["unknown_last_drop", "zone_pullback:0.3:0.8", "", "zone_pullback:0.3:0.7", "zone_pullback:0.3:0.8"], ["unknown_none", "zone_pullback:0.3:0.8", "", "", ""]]) {
    const signal = { strategy_execution: true, power: -0.3, power_ms: C0, agent_conf: conf, agent_conf_prev: prev, agent_conf_last: last, agent_conf_last_prev: lastPrev };
    const r = strategyExits({ positions: [pos], signal, sym: symAt(3874), agents: { [pos.intent_id]: "zone_pullback" }, now: C0 + 60_000, changes });
    exits.push([name, r.intents, r.extendOf(pos)]);
  }
  lines.push(`change/exits=${JSON.stringify(exits)}`);
  lines.push(`change/pending=${JSON.stringify(pendingCases(changeThresholds))}`);
  return lines;
}

/** Pure: pendingDeleteReason's share cancel over a BUY limit placed at C0 (share 0.7), per mode and decision series. */
export function pendingCases(changeThresholds = OMEGA_DEFAULTS.change_thresholds) {
  const settings = { ...OMEGA_DEFAULTS, enabled: true, entry_order: "limit", change_thresholds: changeThresholds };
  const changes = changeTokens(settings);
  const executor = { connected: true, received_ms: C0, executor: { version: "1.21" },
    account: { trade_mode: "demo", currency: "USD", margin_mode: "hedging", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
    symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20 }, positions: [], orders: [] };
  const order = { ticket: 777, type: "BUY_LIMIT", price_open: 4098, sl: 4090, tp: 4120, placed_ms: C0 + 2 * 60_000 };
  const out = [];
  for (const mode of ["scalp", "intraday", "swing", "range"]) {
    const meta = { mode, share0: 0.7, decision_ms: C0, placed_ms: C0 + 2 * 60_000, profile: "aggressive", knobs: limitKnobs(mode, null, { changes }) };
    for (const [name, prev, now, prevMs] of [["one_0049", -1, 0.651, 0], ["one_0099", -1, 0.601, 0], ["one_010", -1, 0.6, 0], ["one_015", -1, 0.55, 0], ["two_010", 0.6, 0.6, C0 + M15], ["two_015", 0.55, 0.55, C0 + M15], ["two_reverted", 0.6, 0.69, C0 + M15], ["prev_is_placing", 0.6, 0.6, C0]]) {
      const powerMs = prevMs ? prevMs + M15 : C0 + M15;
      const signal = { quorum_long_share: now, quorum_short_share: Math.round((1 - now) * 1000) / 1000, power_ms: powerMs, quorum_long_share_prev: prev, quorum_short_share_prev: prev >= 0 ? Math.round((1 - prev) * 1000) / 1000 : -1, decision_prev_ms: prevMs };
      out.push([`${mode}|${name}`, pendingDeleteReason({ settings, signal, control: { mode: "active" }, executor, account: { spec_status: "validated", profile: "aggressive" }, lossFloor: 9_000, budget: 100, order, meta, now: powerMs + 60_000 })]);
    }
  }
  return out;
}
