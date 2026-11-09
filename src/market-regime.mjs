// The market regime of a closed bar, from that timeframe's own bars only (owner decisions
// 2026-11-09: the weighting adapts to volatility and market dynamics, each timeframe independent).
//
//   volatility  the 14-bar ATR as a share of the close, ranked against the previous REGIME_LOOKBACK
//               bars: low (bottom third), normal, high (top third);
//   dynamics    the 20-bar efficiency ratio |close(t) - close(t-20)| / sum |close(i) - close(i-1)|:
//               trending at or above TREND_ER, ranging below it.
// A regime is "<volatility>-<dynamics>", for example "high-trending". A bar without enough history
// has no regime (null), and the weighting then uses the agent's whole record.

export const REGIME_LOOKBACK = 100;
export const ATR_PERIOD = 14;
export const ER_PERIOD = 20;
export const TREND_ER = 0.35;
export const REGIMES = Object.freeze(["low-trending", "low-ranging", "normal-trending", "normal-ranging", "high-trending", "high-ranging"]);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Pure: the ATR share of the close for every bar (null until ATR_PERIOD bars exist). */
export function atrShares(bars) {
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  const tr = bars.map((b, i) => {
    const prev = i ? bars[i - 1].close : b.open;
    return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  });
  for (let i = 0; i < bars.length; i++) {
    sum += tr[i];
    if (i >= ATR_PERIOD) sum -= tr[i - ATR_PERIOD];
    if (i >= ATR_PERIOD - 1 && isNum(bars[i].close) && bars[i].close > 0) out[i] = sum / ATR_PERIOD / bars[i].close;
  }
  return out;
}

/** Pure: the regime of bar i, or null without enough history. */
export function regimeAt(bars, i, shares = atrShares(bars)) {
  if (i < ER_PERIOD || !isNum(shares[i])) return null;
  const window = shares.slice(Math.max(0, i - REGIME_LOOKBACK), i).filter(isNum);
  if (window.length < 30) return null;
  const rank = window.filter((x) => x < shares[i]).length / window.length;
  const vol = rank < 1 / 3 ? "low" : rank > 2 / 3 ? "high" : "normal";
  let path = 0;
  for (let j = i - ER_PERIOD + 1; j <= i; j++) path += Math.abs(bars[j].close - bars[j - 1].close);
  const er = path > 0 ? Math.abs(bars[i].close - bars[i - ER_PERIOD].close) / path : 0;
  return `${vol}-${er >= TREND_ER ? "trending" : "ranging"}`;
}

/** Pure: close time (ms) -> regime for every bar of a series that has one. */
export function regimeMap(bars) {
  const clean = (bars || []).filter((b) => [b?.open, b?.high, b?.low, b?.close].every(isNum) && b.close_time).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  const shares = atrShares(clean);
  const out = new Map();
  for (let i = 0; i < clean.length; i++) {
    const r = regimeAt(clean, i, shares);
    if (r) out.set(Date.parse(clean[i].close_time), r);
  }
  return out;
}

/** The series of each room timeframe in the market-data cache. */
export const REGIME_SERIES = Object.freeze({ "15": "15m", "60": "1h", "240": "4h", "1D": "1D" });

/** Loads a timeframe's cached bars and returns its regime map (empty on any failure). */
export async function loadRegimeMap(env, timeframe) {
  try {
    const record = JSON.parse((await env?.SIGNAL_CACHE?.get?.(`market-data:v2:series:OANDA:XAUUSD|${REGIME_SERIES[timeframe]}`)) || "null");
    return regimeMap(Array.isArray(record?.candles) ? record.candles : []);
  } catch { return new Map(); }
}

/** The regime of the latest bar that closed at or before `closeMs`, or null. */
export function regimeAtClose(map, closeMs) {
  if (map.has(closeMs)) return map.get(closeMs);
  let best = null, bestT = -Infinity;
  for (const [t, r] of map) if (t <= closeMs && t > bestT) { best = r; bestT = t; }
  return best;
}
