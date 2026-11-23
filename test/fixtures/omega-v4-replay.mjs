// The v4 replay's fixtures (test/ledger-omega-v4.test.mjs V2-V6): a few hours of 1m bars and Decision Engine records
// through replayOmega4, with the TP ladder's lock, the Position Manager's break-even fallback, a cut loss on the
// council's recorded verdict and the re-entry cooldown, and TP2 with the break-even stop. Generated here
// deterministically; test/fixtures/engine-behaviour.mjs also hashes their traces into ENGINE_BEHAVIOUR_HASH.
import { decisionFromRow } from "../../src/ledger-omega4.mjs";
import { OMEGA_DEFAULTS } from "../../src/omega-engine.mjs";

export const M1 = 60_000, M5 = 5 * M1, M15 = 15 * M1;
export const C = Date.parse("2026-11-19T12:00:00Z"); // a 15m close
export const WARM = 5 * 3600_000;
export const key = (close) => `OANDA:XAUUSD:15:${close - M15}`;
export const levels = (pairs) => pairs.map(([low, high]) => ({ low, high }));

/** 1m feed bars from `from` to `to` following price(t) (each bar opens at the price before and closes at price(t + 1m)). */
export function path(from, to, price, wiggle = 0.1) {
  const out = [];
  for (let t = from; t < to; t += M1) {
    const o = price(t), c = price(t + M1);
    out.push({ open_time: new Date(t).toISOString(), close_time: new Date(t + M1).toISOString(), open: o, high: Math.max(o, c) + wiggle, low: Math.min(o, c) - wiggle, close: c });
  }
  return out;
}
/** A piecewise-linear price through [ms, price] points (flat before the first and after the last). */
export const lerp = (pts) => (t) => {
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const [a, pa] = pts[i - 1], [b, pb] = pts[i]; return Math.round((pa + ((pb - pa) * (t - a)) / (b - a)) * 1000) / 1000; }
  return pts.at(-1)[1];
};
export const conf = (short, long = 0.6) => ({ zone_pullback: { long, short } });
/** A Decision Engine record as engine_decisions.decision_json holds it (the fields the live functions read, and more). */
export function decision({ close, stance = "SELL", decidedAfter = 2 * M1, trade = null, score = -0.3, shares = [0.2, 0.8], lv = [], c = conf(0.85), cp = conf(0.85), mode = "scalp" }) {
  return {
    decision_key: key(close), bar_close: new Date(close).toISOString(), decided_at: new Date(close + decidedAfter).toISOString(), stance, confidence: 0.7,
    trade, guardrails: { long: { entry_trigger: { fired: false, note: "waiting" } }, short: { entry_trigger: { fired: false, note: "waiting" } } },
    quorum: { score, long_share: shares[0], short_share: shares[1] }, key_levels: lv, agent_confidence: c, agent_confidence_prev: cp,
    trading_mode: mode, strategy_execution: false, context: { regime_1h: "ranging" }, strategy: { atr_h1: 5 }, summary: "not read by the replay"
  };
}
export const sellTrade = (entry, stop, tp) => ({ side: "SELL", action: "ENTER_LIMIT", entry, stop, tp, tp1: tp, target: "tp1", agent: "zone_pullback", rrr: Math.abs(entry - tp) / Math.abs(stop - entry) });
export const dec = (d) => decisionFromRow({ decision_json: JSON.stringify(d) });
export const base = (overrides = {}) => ({ settings: { ...OMEGA_DEFAULTS, enabled: true }, profileAt: () => "aggressive", from: C, ...overrides });

/** V2, V3: a SELL that reaches the TP ladder's lock on a closed M5 candle, then a WAIT. */
export function ladderCase() {
  const d0 = decision({ close: C, trade: sellTrade(2000, 2020, 1970), lv: levels([[1940, 1942]]) });
  const d1 = decision({ close: C + M15, stance: "WAIT", decidedAfter: M1, lv: levels([[1940, 1942]]) });
  const price = lerp([[C + 3 * M1, 2000], [C + 10 * M1, 1995.5], [C + 16 * M1, 1995.5], [C + 30 * M1, 2003]]);
  return { bars: path(C - WARM, C + 40 * M1, price), decisions: [dec(d0), dec(d1)], to: C + 40 * M1 };
}

/** V4: stop 5, 2 in profit at 3 minutes past the 5m close with no council answer (the break-even fallback), then back. */
export function breakevenCase() {
  const d0 = decision({ close: C, trade: sellTrade(2000, 2005, 1990), lv: levels([[1940, 1942]]) });
  const price = lerp([[C + 3 * M1, 2000], [C + 7 * M1, 1998], [C + 9 * M1, 1998], [C + 20 * M1, 2001]]);
  return { bars: path(C - WARM, C + 30 * M1, price, 0.05), decisions: [dec(d0)], to: C + 30 * M1 };
}

/** V5: a SELL 9 against, a measured reason and the council's recorded "thesis broken" (a cut), then a second SELL. */
export function cutLossCase() {
  const d0 = decision({ close: C, trade: sellTrade(2000, 2020, 1970), lv: levels([[1940, 1942]]) });
  const d1 = decision({ close: C + M15, decidedAfter: M1, trade: sellTrade(2008, 2028, 1978), lv: levels([[1940, 1942]]), c: conf(0.7), cp: conf(0.85) });
  const price = lerp([[C + 3 * M1, 2000], [C + 16 * M1, 2009], [C + 40 * M1, 2009]]);
  const cutBar = Math.floor((C + 18 * M1) / M5);
  return {
    bars: path(C - WARM, C + 40 * M1, price, 0.05), decisions: [dec(d0), dec(d1)], to: C + 40 * M1,
    councils: { [`open:${C}:S|${cutBar}`]: "weakening, thesis broken: the agent's confidence fell and price broke the zone" },
    settings: { ...OMEGA_DEFAULTS, enabled: true, max_signal_age_ms: 5 * M1, reentry_cooldown_bars: 2 }
  };
}

/** V6: in profit inside the band under the TP ladder, the council's "strengthening, thesis intact": TP2 with break-even. */
export function tp2Case() {
  const lv = levels([[1975, 1977], [1940, 1942]]);
  const d0 = decision({ close: C, trade: sellTrade(2000, 2020, 1985), lv });
  const d1 = decision({ close: C + M15, stance: "WAIT", decidedAfter: M1, lv });
  const price = lerp([[C + 3 * M1, 2000], [C + 7 * M1, 1998], [C + 9 * M1, 1998], [C + 40 * M1, 1976.5]]);
  const bar = Math.floor((C + 8 * M1) / M5);
  return { bars: path(C - WARM, C + 50 * M1, price, 0.05), decisions: [dec(d0), dec(d1)], to: C + 50 * M1, councils: { [`open:${C}:S|${bar}`]: "strengthening, thesis intact: agents and quorum behind it" } };
}

/** The replay scenarios as replayOmega4 options ({ name, opts }), as V2-V6 run them. */
/** SLG1-18: a SELL at 2000 with a 5.00 stop (scalp) whose one-minute wick reaches 7 in its favour, then sits at +1 (0.2R, inside the
 * 0.3R band) until it runs back up through the stop: the gate opens on the wick's closed M5 bar, the price is back inside
 * the band at the Position Manager's next run. */
export function retraceCase() {
  const d0 = decision({ close: C, trade: sellTrade(2000, 2005, 1985), lv: levels([[1940, 1942]]) });
  const d1 = decision({ close: C + M15, stance: "WAIT", decidedAfter: M1, lv: levels([[1940, 1942]]) });
  const price = lerp([[C + 3 * M1, 2000], [C + 5 * M1, 1999], [C + 6 * M1, 1993], [C + 7 * M1, 1999], [C + 40 * M1, 1999], [C + 55 * M1, 2006]]);
  return { bars: path(C - WARM, C + 60 * M1, price, 0.05), decisions: [dec(d0), dec(d1)], to: C + 60 * M1 };
}

export function v4ReplayScenarios() {
  const { settings: cutSettings, ...cut } = cutLossCase();
  return [
    { name: "ladder", opts: { ...base(), ...ladderCase() } },
    { name: "breakeven_fallback", opts: { ...base(), ...breakevenCase() } },
    { name: "cut_loss", opts: { ...base({ settings: cutSettings }), ...cut } },
    { name: "cut_loss_silent", opts: { ...base({ settings: cutSettings }), ...cut, councils: {} } },
    { name: "tp2_breakeven", opts: { ...base(), ...tp2Case() } }
  ];
}
