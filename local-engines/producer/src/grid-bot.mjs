// The Grid Bot Protocol HUD (GMI v12.70, hud_tdm section 6), ported from the Pine source
// (backlog, owner 2026-11-05; ported 2026-11-07). Not part of any approved implementation hash: it
// imports the ported Pine helpers and reproduces, on the chart's closed bars,
//
//   Mizan lib.cshi_engine(open, high, low, close, atr_val, eff_rat_loc, e):
//     spread_toxicity = wick > 0 ? body / max(range, 0.0001) : 1.0;  smooth_spread = ta.ema(., 5)
//     price_velocity  = |close - nz(close[1], close)| / max(atr, 0.0001); smooth_velocity = ta.ema(., 5)
//     viability_score = smooth_spread * 0.4 + smooth_velocity * 0.4 + (1 - efficiency) * 0.2
//     grid   = nz(ta.percentrank(viability_score, 100), 50)
//     muddy  = entropy >= 0.80 and 45 <= grid <= 85
//     viable = muddy or 50 <= grid <= 85
//   GMI grid_status: muddy -> MUDDY WATERS (ON), grid > 85 -> TOXIC CHOP (OFF),
//     50 <= grid <= 85 -> OPTIMAL (ON), else TRENDING / DEAD (OFF)
//
// with atr_val = max(ta.atr(14), mintick), eff_rat_loc = lib.efficiency_ratio(close, 14) and e the
// GMI entropy of the bar. The grid range, trigger, count and TP/SL rows are H1 decision reasoning
// output (RFC_HUD_AGENTS §7), not HUD fields. No comparator exists yet: the HUD reads as not yet
// calibrated until a Pine candidate carries these fields.
import { ema, percentrank } from "../../gmi/src/pine.mjs";
import { pineAtr, prophetEfficiencyRatio } from "../../../src/prophet-r37-oscillator.mjs";

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const round = (x, d = 2) => (finite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

/** The CSHI series of lib.cshi_engine: viability score and grid percent rank per bar. */
export function cshiSeries(bars, { mintick = 0.001 } = {}) {
  const close = bars.map((b) => b.close);
  const atr = pineAtr(bars, 14).map((a) => (finite(a) ? Math.max(a, mintick) : null));
  const eff = prophetEfficiencyRatio(close, 14);
  const spread = bars.map((b) => {
    const body = Math.abs(b.close - b.open), range = b.high - b.low, wick = range - body;
    return wick > 0 ? body / Math.max(range, 0.0001) : 1.0;
  });
  const velocity = bars.map((b, i) => (finite(atr[i]) ? Math.abs(b.close - (i > 0 ? bars[i - 1].close : b.close)) / Math.max(atr[i], 0.0001) : null));
  const smoothSpread = ema(spread, 5), smoothVelocity = ema(velocity, 5);
  const viability = bars.map((_, i) => (finite(smoothSpread[i]) && finite(smoothVelocity[i]) && finite(eff[i]) ? smoothSpread[i] * 0.4 + smoothVelocity[i] * 0.4 + (1 - eff[i]) * 0.2 : null));
  const grid = percentrank(viability, 100).map((g) => (finite(g) ? g : 50));
  return { viability, grid };
}

export const DEPLOY_STATUS = Object.freeze(["muddy_waters_on", "toxic_chop_off", "optimal_on", "trending_off"]);

/** The HUD fields of the last closed bar; null without the bar's GMI entropy. */
export function gridBotFields(bars, { entropy, mintick = 0.001 } = {}) {
  if (!finite(entropy) || bars.length < 2) return null;
  const { viability, grid } = cshiSeries(bars, { mintick });
  const g = grid.at(-1);
  const muddy = entropy >= 0.8 && g >= 45 && g <= 85;
  const viable = muddy || (g >= 50 && g <= 85);
  const status = muddy ? "muddy_waters_on" : g > 85 ? "toxic_chop_off" : g >= 50 && g <= 85 ? "optimal_on" : "trending_off";
  return { cshi_viability: round(g, 1), viability_score: round(viability.at(-1), 4), deploy_status: status, grid_viable: viable, muddy_waters: muddy, entropy: round(entropy, 3) };
}
