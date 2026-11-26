// Z6 fixtures (test/zone-sd.test.mjs): Omega's management and the Position Manager over a signal with and without the
// supply and demand box levels ("/sd" tokens). Written against modules passed in ({ oe: omega-engine, pm:
// position-manager }), so the same code runs on this tree and on main before Z6 (the pinned hash in the test was taken
// with it on a git-archive of main e7c055b, over the signal without box levels).

export const NOW = Date.parse("2026-11-26T10:20:00Z");
export const POWER_MS = Date.parse("2026-11-26T10:15:00Z");
export const SYM = Object.freeze({ name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 3920, ask: 3920.2, spread_points: 20 });
// The kept levels (feed = broker, basis 0), typed as the decision records them: L1 3905-3907 demand, L2 3913-3914 none,
// L3 3915-3916.5 demand below a long from 3900; L4 3926-3928 supply, L5 3936-3938 supply above.
export const KEPT = "3905:3907,3913:3914,3915:3916.5,3926:3928,3936:3938";
export const KEPT_TYPES = "demand/medium/tested,none/-/worn,demand/strong/fresh,supply/strong/fresh,supply/medium/tested";
// The box levels the signal appends (Z6): a wide demand box 3908-3917.4 under price (its top above L3's), and a supply
// box 3931-3933 between L4 and L5.
export const BOXES = "3908:3917.4,3931:3933";
export const BOX_TYPES = "demand/strong/fresh/sd,supply/medium/fresh/sd";
export const SIGNAL_PLAIN = Object.freeze({ side: "NONE", key_levels: KEPT, key_level_types: KEPT_TYPES, feed_basis: 0, feed_basis_known: true, power: 0.3, power_ms: POWER_MS, m5_atr: 3 });
export const SIGNAL_SD = Object.freeze({ ...SIGNAL_PLAIN, key_levels: `${KEPT},${BOXES}`, key_level_types: `${KEPT_TYPES},${BOX_TYPES}` });
export const LONG = Object.freeze({ ticket: 7, side: "BUY", volume: 0.04, open_price: 3900, sl: 3890, tp: 3945, source: "omega", magic: 920200, intent_id: "open:1:B" });
export const SHORT = Object.freeze({ ticket: 8, side: "SELL", volume: 0.04, open_price: 3940, sl: 3950, tp: 3902, source: "omega", magic: 920200, intent_id: "open:2:S" });
export const META = Object.freeze({ "open:1:B": { mode: "intraday", r_dist: 10 }, "open:2:S": { mode: "intraday", r_dist: 10 } });
export const PM_DECISION = Object.freeze({ stance: "BUY", trading_mode: "intraday", quorum: { score: 0.3, long_share: 0.6, short_share: 0.3 }, agent_confidence: { trend_pullback: { long: 0.7, short: 0.2 } }, agent_confidence_prev: { trend_pullback: { long: 0.7, short: 0.2 } } });

/**
 * The management outputs: manageIntents for a long and a short at several prices and powers, with zone_mgmt "off" and
 * "omega" (`settings` added to each), and the Position Manager's facts, action and council messages, over `signal`.
 */
export function managementScenario({ oe, pm }, { signal, settings = {} } = {}) {
  const out = [];
  for (const zone_mgmt of ["off", "omega"]) {
    for (const power of [0.3, 0.6, 0.1]) {
      for (const bid of [3918, 3919.2, 3921, 3929.5, 3934, 3944]) {
        const sym = { ...SYM, bid, ask: bid + 0.2 };
        const sig = { ...signal, power };
        const S = { ...oe.OMEGA_DEFAULTS, tp_ladder: true, ...settings, zone_mgmt };
        out.push([zone_mgmt, power, bid, oe.manageIntents({ positions: [LONG, SHORT], sym, settings: S, signal: sig, now: NOW, positionMeta: META })]);
      }
    }
  }
  const sdOn = (settings.zone_sd ?? oe.OMEGA_DEFAULTS.zone_sd) === "on";
  const levels = pm.brokerLevels(signal, sdOn ? { sd: true } : {});
  for (const bid of [3918, 3921, 3934]) {
    const sym = { ...SYM, bid, ask: bid + 0.2 };
    const f = pm.positionFacts({ position: LONG, sym, openIntent: { tp: 3926, entry: 3900, sl: 3890, strategy: "trend_pullback", mode: "intraday", r_dist: 10 }, levels, decision: PM_DECISION, ladder: true, signal });
    out.push(["pm", bid, f, pm.positionAction(f, { momentum: "holding", thesis: "intact" }), pm.positionCouncilMessages(f, { m5: signal, levels })]);
  }
  out.push(["levels", oe.brokerKeyLevels(signal), oe.brokerKeyLevels(signal, { typed: true }), levels]);
  return out;
}
