// The moving GMI lines of the chart layers (owner decision 2026-11-08, PR 3 of the key-level
// plan), computed in the browser over the chart's own closed bars, with the formulas of
// CryptophysMizanLib and GMI v12.70 (local-engines/gmi/src/mizan.mjs, pine.mjs):
//   Z-KWW   kww_calc(close, 50): stretched-exponential weights exp(-(i/14)^(1/sqrt 3)), mean and
//           sigma; GMI draws the mean, +-1 sigma and +-1.618 sigma.
//   EMA 114 ta.ema seeded with the SMA of its first 114 bars.
//   VWAP    ta.vwap(hlc3), reset at the trading day (17:00 New York, OANDA's day open).
// The chart holds 400 bars, so an EMA starts from its first 114 and may differ from TradingView's
// by a little on the oldest bars; the last values match the HUD snapshot's chart plane.

export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number | null };
export type Point = { time: number; value: number };

const TAU = 14.0, BETA = 1.0 / Math.sqrt(3.0);
const kwwWeight = (i: number) => Math.exp(-Math.pow(i / TAU, BETA));

/** KWW mean and sigma per bar (kww_calc; values before the first bar repeat the current close, as Pine's nz). */
export function kww(close: number[], len = 50): { ma: number[]; sigma: number[] } {
  const w = Array.from({ length: len }, (_, i) => kwwWeight(i));
  const sumW = w.reduce((a, b) => a + b, 0);
  const ma: number[] = [], sigma: number[] = [];
  for (let t = 0; t < close.length; t++) {
    const val = (k: number) => (t - k >= 0 ? close[t - k] : close[t]);
    let s = 0;
    for (let k = 0; k < len; k++) s += val(k) * w[k];
    const m = s / Math.max(sumW, 0.0001);
    let d = 0;
    for (let k = 0; k < len; k++) d += w[k] * (val(k) - m) ** 2;
    ma.push(m);
    sigma.push(Math.sqrt(d / Math.max(sumW, 0.0001)));
  }
  return { ma, sigma };
}

/** ta.ema: alpha 2/(len+1), seeded with the SMA of the first `len` values; NaN before that. */
export function ema(src: number[], len: number): number[] {
  const a = 2 / (len + 1), out: number[] = [];
  let prev = NaN;
  for (let i = 0; i < src.length; i++) {
    if (Number.isNaN(prev)) {
      if (i >= len - 1) { let s = 0; for (let k = i - len + 1; k <= i; k++) s += src[k]; prev = s / len; }
    } else prev = a * src[i] + (1 - a) * prev;
    out.push(prev);
  }
  return out;
}

const nyHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" });
/** The trading day of a bar: its New York date, with 17:00 and later counted as the next day. */
export function tradingDay(timeSec: number): string {
  const p = Object.fromEntries(nyHour.formatToParts(new Date((timeSec + 7 * 3600) * 1000)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** ta.vwap(hlc3) reset at each trading day; NaN where a bar has no volume. */
export function sessionVwap(bars: Bar[]): number[] {
  const out: number[] = [];
  let day = "", pv = 0, v = 0;
  for (const b of bars) {
    const d = tradingDay(b.time);
    if (d !== day) { day = d; pv = 0; v = 0; }
    if (b.volume == null) { out.push(NaN); continue; }
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    v += b.volume;
    out.push(v > 0 ? pv / v : NaN);
  }
  return out;
}

/** Series points for a chart line, skipping the values that are not numbers yet. */
export const points = (bars: Bar[], values: number[]): Point[] =>
  bars.map((b, i) => ({ time: b.time, value: values[i] })).filter((p) => Number.isFinite(p.value));

/** The bands of a bar series: KWW mean, +-1 and +-1.618 sigma, EMA 114, VWAP. */
export function bandSeries(bars: Bar[]) {
  const close = bars.map((b) => b.close);
  const { ma, sigma } = kww(close, 50);
  const at = (k: number) => ma.map((m, i) => m + k * sigma[i]);
  return {
    kwwMean: points(bars, ma), kwwUp1: points(bars, at(1)), kwwDn1: points(bars, at(-1)),
    kwwUp1618: points(bars, at(1.618)), kwwDn1618: points(bars, at(-1.618)),
    ema114: points(bars, ema(close, 114)), vwap: points(bars, sessionVwap(bars))
  };
}
