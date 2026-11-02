/**
 * Closed-bar translation of the Prophet oscillator dependency slice called by
 * the owner-designated GMI source. This is deliberately separate from the
 * structure state machine and does not compute ATR or GMI verdict inputs.
 *
 * The exact published Mizan /4 dependency still needs provenance verification
 * and TradingView output fixtures before parity can be claimed.
 */
import { replayProphetR37Structure } from "./prophet-r37-kernel.mjs";

const isNum = x => typeof x === "number" && Number.isFinite(x);
const nvl = (x, fallback) => isNum(x) ? x : fallback;

function smaAt(values, end, length) {
  const start = end - length + 1;
  if (start < 0) return null;
  let sum = 0;
  for (let i = start; i <= end; i++) {
    if (!isNum(values[i])) return null;
    sum += values[i];
  }
  return sum / length;
}

function wmaAt(values, end, length) {
  const start = end - length + 1;
  if (start < 0) return null;
  let sum = 0, weights = 0;
  for (let i = start; i <= end; i++) {
    if (!isNum(values[i])) return null;
    const weight = i - start + 1;
    sum += values[i] * weight;
    weights += weight;
  }
  return sum / weights;
}

function hmaSeries(values, length) {
  const half = Math.max(1, Math.floor(length / 2));
  const root = Math.max(1, Math.floor(Math.sqrt(length) + 0.5));
  const diff = values.map((_, i) => {
    const a = wmaAt(values, i, half), b = wmaAt(values, i, length);
    return isNum(a) && isNum(b) ? 2 * a - b : null;
  });
  return diff.map((_, i) => wmaAt(diff, i, root));
}

function rollingHighest(values, end, length) {
  const start = end - length + 1;
  if (start < 0) return null;
  const slice = values.slice(start, end + 1);
  if (slice.some(v => !isNum(v))) return null;
  return Math.max(...slice);
}
function rollingLowest(values, end, length) {
  const start = end - length + 1;
  if (start < 0) return null;
  const slice = values.slice(start, end + 1);
  if (slice.some(v => !isNum(v))) return null;
  return Math.min(...slice);
}

/** Mizan prophet_volume_ratio(volume, 20): current volume / prior-bar SMA, capped at 2. */
export function prophetVolumeRatio(volumes, length = 20) {
  if (!Array.isArray(volumes) || !Number.isSafeInteger(length) || length < 1) throw new TypeError("invalid volume series or SMA length");
  return volumes.map((v, i) => {
    const priorSma = i > 0 ? smaAt(volumes, i - 1, length) : null;
    return isNum(priorSma) && priorSma > 0 ? Math.min(2, nvl(v / priorSma, 1)) : 1;
  });
}

/** Mizan vol_anomaly(volume, 20): prior volume / prior SMA, default 1. */
export function prophetVolumeAnomaly(volumes, length = 20) {
  if (!Array.isArray(volumes) || !Number.isSafeInteger(length) || length < 1) throw new TypeError("invalid volume series or SMA length");
  return volumes.map((v, i) => {
    const currentSma = smaAt(volumes, i, length);
    const priorVolume = i > 0 ? volumes[i - 1] : null;
    const priorSma = i > 0 ? smaAt(volumes, i - 1, length) : null;
    // Pine: nz(ta.sma(volume, len), volume), followed by prior-bar references.
    const denominator = isNum(priorSma) ? priorSma : (i > 0 ? priorVolume : v);
    const numerator = i > 0 ? priorVolume : null;
    return isNum(numerator) && isNum(denominator) ? numerator / Math.max(denominator, 0.0001) : 1;
  });
}

/** Mizan f_vol_cycle(close, high, low, p, anomaly). */
export function prophetVolumeCycle(closes, highs, lows, anomalies, period) {
  if (![closes, highs, lows, anomalies].every(Array.isArray) ||
      !Number.isSafeInteger(period) || period < 1 ||
      ![closes, highs, lows, anomalies].every(a => a.length === closes.length)) {
    throw new TypeError("volume-cycle series must be equal-length arrays and period must be positive");
  }
  return closes.map((close, i) => {
    const high = rollingHighest(highs, i, period), low = rollingLowest(lows, i, period);
    if (![close, high, low, anomalies[i]].every(isNum)) return null;
    const range = high - low;
    const osc = range === 0 ? 0 : (close - low) / range - 0.5;
    return osc * anomalies[i];
  });
}

/** Mizan efficiency_ratio(close, 14). */
export function prophetEfficiencyRatio(closes, length = 14) {
  if (!Array.isArray(closes) || !Number.isSafeInteger(length) || length < 1) throw new TypeError("invalid close series or ER length");
  return closes.map((close, i) => {
    const old = i >= length ? nvl(closes[i - length], close) : close;
    const direction = Math.abs(close - old);
    const start = Math.max(0, i - length + 1);
    let path = 0;
    for (let j = start; j <= i; j++) {
      const prior = j > 0 ? nvl(closes[j - 1], closes[j]) : closes[j];
      path += Math.abs(closes[j] - prior);
    }
    return path === 0 ? 0 : direction / path;
  });
}

/** Mizan calculate_prophet_tensor(raw_comp, ER, 6): returns fast, slow, core. */
export function calculateProphetTensor(rawComp, efficiency, smoothLength = 6) {
  if (!Array.isArray(rawComp) || !Array.isArray(efficiency) || rawComp.length !== efficiency.length ||
      !Number.isSafeInteger(smoothLength) || smoothLength < 1) throw new TypeError("invalid tensor inputs");
  const fastBase = hmaSeries(rawComp, smoothLength);
  const fastChop = hmaSeries(rawComp, smoothLength * 2);
  const slowLength = Math.max(1, Math.floor(smoothLength * 2.2 + 0.5));
  const slowBase = hmaSeries(rawComp, slowLength);
  const slowChop = hmaSeries(rawComp, slowLength * 2);
  const core = hmaSeries(rawComp, Math.max(1, Math.floor(smoothLength * 1.5 + 0.5)));
  const blend = (base, chop, i) => isNum(base[i]) && isNum(chop[i]) && isNum(efficiency[i])
    ? base[i] * efficiency[i] + chop[i] * (1 - efficiency[i]) : null;
  return {
    pro_fast: rawComp.map((_, i) => blend(fastBase, fastChop, i)),
    pro_slow: rawComp.map((_, i) => blend(slowBase, slowChop, i)),
    pro_core: core
  };
}

/**
 * Calculate the source's confirmed-bar oscillator inputs and replay the shared
 * structure kernel. ATR remains an explicit caller input because the exact
 * source expression/settings for atr_val must be pinned separately.
 */
export function replayProphetR37ClosedBars(candles, { atrValues, volumeLength = 20, erLength = 14, smoothLength = 6 } = {}) {
  if (!Array.isArray(candles) || !Array.isArray(atrValues) || atrValues.length !== candles.length) {
    throw new TypeError("candles and equal-length atrValues are required");
  }
  const volumes = candles.map(c => c.volume);
  const closes = candles.map(c => c.close), highs = candles.map(c => c.high), lows = candles.map(c => c.low);
  const volumeRatio = prophetVolumeRatio(volumes, volumeLength);
  const volumeAnomaly = prophetVolumeAnomaly(volumes, volumeLength).map(v => Math.min(2, nvl(v, 1)));
  const raw13 = prophetVolumeCycle(closes, highs, lows, volumeAnomaly, 13);
  const raw34 = prophetVolumeCycle(closes, highs, lows, volumeAnomaly, 34);
  const raw55 = prophetVolumeCycle(closes, highs, lows, volumeAnomaly, 55);
  const rawComp = closes.map((_, i) => [raw13[i], raw34[i], raw55[i]].every(isNum)
    ? raw13[i] * 0.5 + raw34[i] * 0.35 + raw55[i] * 0.15 : null);
  const er = prophetEfficiencyRatio(closes, erLength);
  const tensor = calculateProphetTensor(rawComp, er, smoothLength);
  const hasVolume = volumes.map((_, i) => volumes.slice(0, i + 1).some(v => isNum(v) && v !== 0));
  const structureInput = candles.map((c, i) => ({
    ...c, oscillator: tensor.pro_fast[i], volume_ratio: volumeRatio[i],
    has_volume: hasVolume[i], atr: atrValues[i]
  }));
  return { volumeRatio, volumeAnomaly, rawComp, efficiencyRatio: er, ...tensor,
    structure: replayProphetR37Structure(structureInput) };
}
