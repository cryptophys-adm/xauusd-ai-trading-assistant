// P6 of RFC_INDICATOR_AGENT_PLATFORM (owner decision 4, 2026-11-07: Supertrend first): the
// TradingView built-in ta.supertrend(factor, atrPeriod), reproduced on closed bars. Not part of any
// approved implementation hash. Reference: Pine v6 `ta.supertrend` documentation:
//
//   src = hl2
//   atr = ta.atr(atrPeriod)                         // Wilder RMA of the true range
//   upperBand = src + factor * atr, lowerBand = src - factor * atr
//   lowerBand := lowerBand > prevLowerBand or close[1] < prevLowerBand ? lowerBand : prevLowerBand
//   upperBand := upperBand < prevUpperBand or close[1] > prevUpperBand ? upperBand : prevUpperBand
//   direction := na(atr[1]) ? 1 : prevSuperTrend == prevUpperBand ? (close > upperBand ? -1 : 1) : (close < lowerBand ? 1 : -1)
//   superTrend := direction == -1 ? lowerBand : upperBand
//
// TradingView's direction -1 is an uptrend. The output here uses 1 for bullish, -1 for bearish.

export const SUPERTREND_DEFAULTS = Object.freeze({ factor: 3, atrPeriod: 10 });

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const round = (x, d = 4) => (finite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

/** Wilder's ATR (ta.atr): RMA of the true range, seeded with the simple mean of the first `period` values. */
export function rmaAtr(bars, period) {
  const out = new Array(bars.length).fill(null);
  let prev = null, sum = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], pc = i > 0 ? bars[i - 1].close : null;
    const tr = pc == null ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    if (i < period) {
      sum += tr;
      if (i === period - 1) { prev = sum / period; out[i] = prev; }
    } else {
      prev = (prev * (period - 1) + tr) / period;
      out[i] = prev;
    }
  }
  return out;
}

/** The whole Supertrend series: { line, direction (1 bullish, -1 bearish), atr } per bar. */
export function supertrendSeries(bars, { factor = SUPERTREND_DEFAULTS.factor, atrPeriod = SUPERTREND_DEFAULTS.atrPeriod } = {}) {
  const atr = rmaAtr(bars, atrPeriod);
  const out = [];
  let prevUpper = null, prevLower = null, prevST = null, prevTvDir = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!finite(atr[i])) { out.push({ line: null, direction: null, atr: null }); continue; }
    const src = (b.high + b.low) / 2;
    let upper = src + factor * atr[i], lower = src - factor * atr[i];
    const pl = finite(prevLower) ? prevLower : 0, pu = finite(prevUpper) ? prevUpper : 0;
    const prevClose = i > 0 ? bars[i - 1].close : null;
    lower = lower > pl || (prevClose != null && prevClose < pl) ? lower : pl;
    upper = upper < pu || (prevClose != null && prevClose > pu) ? upper : pu;
    let tvDir;
    if (!finite(atr[i - 1])) tvDir = 1;
    else if (prevST === prevUpper) tvDir = b.close > upper ? -1 : 1;
    else tvDir = b.close < lower ? 1 : -1;
    const st = tvDir === -1 ? lower : upper;
    out.push({ line: st, direction: tvDir === -1 ? 1 : -1, atr: atr[i] });
    prevUpper = upper; prevLower = lower; prevST = st; prevTvDir = tvDir;
  }
  void prevTvDir;
  return out;
}

/** The HUD fields of the last closed bar: direction, line, flip, bars since the flip, distance in ATR. */
export function supertrendFields(bars, opts = {}) {
  const s = supertrendSeries(bars, opts);
  const last = s.at(-1);
  if (!last || last.direction == null) return null;
  let since = 0;
  for (let i = s.length - 2; i >= 0 && s[i].direction === last.direction; i--) since++;
  const close = bars.at(-1).close;
  return {
    direction: last.direction, line: round(last.line, 3), flipped: s.at(-2)?.direction != null && s.at(-2).direction !== last.direction,
    bars_since_flip: since, distance_atr: round((close - last.line) / last.atr, 2),
    factor: opts.factor ?? SUPERTREND_DEFAULTS.factor, atr_period: opts.atrPeriod ?? SUPERTREND_DEFAULTS.atrPeriod
  };
}
