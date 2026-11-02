// Deterministic subset of The Prophet v7.02 R38 source calculations.
// Source: pinescript/ssot/The-Prophet-v7.02-R38.txt
// This module deliberately does not claim full R38 engine parity.
const EPS = 0.0001;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const finite = (x) => Number.isFinite(x);
const values = (bars, field) => bars.map((bar) => bar[field]);

function smaAt(src, end, len) {
  if (end + 1 < len) return null;
  const window = src.slice(end - len + 1, end + 1);
  if (window.some((x) => !finite(x))) return null;
  return window.reduce((a, b) => a + b, 0) / len;
}
function wmaAt(src, end, len) {
  if (end + 1 < len) return null;
  const window = src.slice(end - len + 1, end + 1);
  if (window.some((x) => !finite(x))) return null;
  let sum = 0, weights = 0;
  for (let i = 0; i < len; i++) {
    const w = i + 1;
    sum += window[i] * w;
    weights += w;
  }
  return sum / weights;
}
function hmaAt(src, end, len) {
  const half = Math.max(1, Math.floor(len / 2));
  const root = Math.max(1, Math.round(Math.sqrt(len)));
  const diff = [];
  for (let i = 0; i <= end; i++) {
    const a = wmaAt(src, i, half), b = wmaAt(src, i, len);
    diff.push(a === null || b === null ? null : 2 * a - b);
  }
  return wmaAt(diff, end, root);
}
function wmaSeries(src, len) {
  return src.map((_, end) => wmaAt(src, end, len));
}
function hmaSeries(src, len) {
  const half = Math.max(1, Math.floor(len / 2));
  const root = Math.max(1, Math.round(Math.sqrt(len)));
  const a = wmaSeries(src, half), b = wmaSeries(src, len);
  const diff = src.map((_, i) => a[i] === null || b[i] === null ? null : 2 * a[i] - b[i]);
  return wmaSeries(diff, root);
}
function kwwAt(src, end, len) {
  if (!finite(src[end])) return { mean: null, sigma: null, z: null };
  const tau = 14.0, beta = 1 / Math.sqrt(3);
  let sumW = 0, sumPW = 0;
  for (let i = 0; i < len; i++) {
    const raw = src[end - i];
    const x = finite(raw) ? raw : src[end];
    const w = Math.exp(-Math.pow(i / tau, beta));
    sumW += w;
    sumPW += x * w;
  }
  const mean = sumPW / Math.max(sumW, EPS);
  let sumDev = 0;
  for (let i = 0; i < len; i++) {
    const raw = src[end - i];
    const x = finite(raw) ? raw : src[end];
    const w = Math.exp(-Math.pow(i / tau, beta));
    sumDev += w * Math.pow(x - mean, 2);
  }
  const sigma = Math.sqrt(sumDev / Math.max(sumW, EPS));
  return { mean, sigma, z: (src[end] - mean) / Math.max(sigma, EPS) };
}
function efficiencyAt(src, end, len) {
  if (end + 1 < len + 1) return null;
  const net = Math.abs(src[end] - src[end - len]);
  let path = 0;
  for (let i = end - len + 1; i <= end; i++) path += Math.abs(src[i] - src[i - 1]);
  return path === 0 ? 0 : net / path;
}
function hurstAt(src, end, len) {
  // Pine loop order is current bar toward older bars: src[i] / nz(src[i+1], src[i]).
  if (end < len) return 0.5;
  const ret = [];
  for (let offset = 0; offset < len; offset++) {
    const current = src[end - offset];
    const older = src[end - offset - 1];
    ret.push(Math.log(current / (finite(older) && older !== 0 ? older : current)));
  }
  const mean = ret.reduce((a, b) => a + b, 0) / len;
  let cum = 0, max = 0, min = 0, varSum = 0;
  for (const r of ret) {
    cum += r - mean;
    max = Math.max(max, cum);
    min = Math.min(min, cum);
    varSum += Math.pow(r - mean, 2);
  }
  const range = max - min, sd = Math.sqrt(varSum / (len - 1));
  const h = sd === 0 || range === 0 ? 0.5 : Math.log(range / sd) / Math.log(len);
  return clamp(h, 0, 1);
}
function volumeAnomalyAt(volume, end, len) {
  // MizanLib source: previous bar's volume / previous bar's SMA.
  if (end < 1) return 1.0;
  const previousSma = smaAt(volume, end - 1, len);
  const previousVolume = volume[end - 1];
  return previousSma === null || !finite(previousVolume) ? 1.0 : previousVolume / Math.max(previousSma, EPS);
}
function prophetVolumeRatioAt(volume, end, len) {
  // Pine: current volume divided by previous bar's SMA(volume, len).
  const prevAvg = end > 0 ? smaAt(volume, end - 1, len) : null;
  return Math.min(2.0, prevAvg !== null && prevAvg > 0 ? (volume[end] / prevAvg || 1.0) : 1.0);
}
function cycleAt(close, high, low, end, len) {
  if (end + 1 < len) return null;
  const h = Math.max(...high.slice(end - len + 1, end + 1));
  const l = Math.min(...low.slice(end - len + 1, end + 1));
  return h === l ? 0 : (close[end] - l) / (h - l) - 0.5;
}
function atrSeries(bars, len = 14) {
  const tr = [], out = [];
  for (let i = 0; i < bars.length; i++) {
    const prevClose = i > 0 ? bars[i - 1].close : bars[i].close;
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose)));
    if (i + 1 < len) out.push(null);
    else if (i + 1 === len) out.push(tr.slice(0, len).reduce((a, b) => a + b, 0) / len);
    else out.push((out[i - 1] * (len - 1) + tr[i]) / len); // Pine ta.atr uses Wilder RMA.
  }
  return out;
}
function crossover(a, b, i) {
  return i > 0 && finite(a[i]) && finite(b[i]) && finite(a[i - 1]) && finite(b[i - 1]) && a[i] > b[i] && a[i - 1] <= b[i - 1];
}
function crossunder(a, b, i) {
  return i > 0 && finite(a[i]) && finite(b[i]) && finite(a[i - 1]) && finite(b[i - 1]) && a[i] < b[i] && a[i - 1] >= b[i - 1];
}

/**
 * Reproduces the source-defined Prophet oscillator sensors for a closed OHLCV
 * series. Outputs are a deterministic partial calculation, not a complete R38
 * signal/OB/risk engine. Callers must supply bars in chronological order.
 */
export function calculateProphetR38Core(bars, options = {}) {
  if (!Array.isArray(bars) || bars.length === 0) throw new TypeError("bars must be a non-empty chronological OHLCV array");
  for (const [i, b] of bars.entries()) {
    if (![b.open, b.high, b.low, b.close].every(finite) || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close) || b.high < b.low) {
      throw new TypeError(`invalid OHLC at index ${i}`);
    }
    if (b.volume !== null && b.volume !== undefined && (!finite(b.volume) || b.volume < 0)) throw new TypeError(`invalid volume at index ${i}`);
    if (i > 0 && finite(Date.parse(bars[i - 1].open_time)) && finite(Date.parse(b.open_time)) && Date.parse(bars[i - 1].open_time) >= Date.parse(b.open_time)) throw new TypeError("bars must be strictly chronological");
  }
  const fastLen = options.fast_len ?? 13, midLen = options.mid_len ?? 34, slowLen = options.slow_len ?? 55, smoothLen = options.smooth_len ?? 6;
  for (const [name, n] of Object.entries({ fast_len: fastLen, mid_len: midLen, slow_len: slowLen, smooth_len: smoothLen })) {
    if (!Number.isInteger(n) || n < 1) throw new TypeError(`${name} must be a positive integer`);
  }
  const close = values(bars, "close"), high = values(bars, "high"), low = values(bars, "low");
  const volume = bars.map((b) => finite(b.volume) ? b.volume : null);
  const hasVolume = volume.some((v) => finite(v) && v > 0);
  const result = [];
  const atr = atrSeries(bars, 14);
  const raw = [], fast = [], slow = [], core = [], zScore = [], hurst = [], er = [], volAnom = [], volRatio = [];
  for (let i = 0; i < bars.length; i++) {
    const erNow = efficiencyAt(close, i, 14);
    const legacyAnom = volumeAnomalyAt(volume, i, 20);
    const ratio = prophetVolumeRatioAt(volume, i, 20);
    const useRatio = options.legacy_mode ? legacyAnom : ratio;
    const volumeFactor = finite(useRatio) ? Math.min(2.0, useRatio) : 1.0;
    const cf = cycleAt(close, high, low, i, fastLen);
    const cm = cycleAt(close, high, low, i, midLen);
    const cs = cycleAt(close, high, low, i, slowLen);
    const rawComp = cf === null || cm === null || cs === null ? null :
      (cf * volumeFactor * 0.5) + (cm * volumeFactor * 0.35) + (cs * volumeFactor * 0.15);
    raw.push(rawComp);
    er.push(erNow);
    volAnom.push(legacyAnom);
    volRatio.push(ratio);
    const kww = kwwAt(close, i, 50);
    zScore.push(kww.z);
    hurst.push(hurstAt(close, i, 100));
    fast.push(null); slow.push(null); core.push(null);
  }
  const baseFast = hmaSeries(raw, smoothLen);
  const chopFast = hmaSeries(raw, smoothLen * 2);
  const baseSlow = hmaSeries(raw, Math.round(smoothLen * 2.2));
  const chopSlow = hmaSeries(raw, Math.round(smoothLen * 2.2) * 2);
  const tensorCore = hmaSeries(raw, Math.round(smoothLen * 1.5));
  for (let i = 0; i < bars.length; i++) {
    if (er[i] !== null && baseFast[i] !== null && chopFast[i] !== null) fast[i] = baseFast[i] * er[i] + chopFast[i] * (1 - er[i]);
    if (er[i] !== null && baseSlow[i] !== null && chopSlow[i] !== null) slow[i] = baseSlow[i] * er[i] + chopSlow[i] * (1 - er[i]);
    core[i] = tensorCore[i];
  }
  for (let i = 0; i < bars.length; i++) {
    const f = fast[i], s = slow[i];
    const buyCandidate = bars[i].confirmed === true && crossover(fast, slow, i) && f < -0.15;
    const sellCandidate = bars[i].confirmed === true && crossunder(fast, slow, i) && f > 0.15;
    const cycle = [cycleAt(close, high, low, i, fastLen), cycleAt(close, high, low, i, midLen), cycleAt(close, high, low, i, slowLen)];
    const intensity = cycle.every((x) => x !== null && x > 0) ? 3 : cycle.every((x) => x !== null && x < 0) ? -3 : 0;
    const d = { ...bars[i], index: i, oscillator: { fast: f, slow: s, core: core[i], raw_composite: raw[i] }, sensors: { kww_zscore_50: zScore[i], hurst_rs_100: hurst[i], efficiency_ratio_14: er[i], volume_anomaly_20: volAnom[i], volume_ratio_20: volRatio[i], atr14: atr[i], cycle_intensity: intensity }, events: { raw_buy_cross_candidate: buyCandidate, raw_sell_cross_candidate: sellCandidate }, calculation_scope: "R38_SOURCE_DERIVED_OSCILLATOR_PARTIAL", parity_status: "not_proven", trusted_evidence_allowed: false };
    result.push(d);
  }
  return {
    schema_version: "cryptophys.prophet-r38-core.v1",
    source: {
      path: "pinescript/ssot/The-Prophet-v7.02-R38.txt",
      source_git_blob_sha: "04deedcfbe09ec31379367c0388417ed499e508d",
      source_sha256: null,
      source_hash_status: "sha256_not_independently_verified",
      declared_version: "The Prophet v7.02 R38",
      imported_library: "cryptophys/CryptophysMizanLib/4"
    },
    implementation_scope: "oscillator sensors and raw closed-bar crossover candidates only; excludes full structure state machine, HTF alignment, confirmation windows, OB ranking, entry/TP/SL management, and all chart-rendering behavior",
    history_requirements: { M5: 101, chart_oscillator_slow_warmup: Math.max(slowLen, Math.round(smoothLen * 2.2) * 2) + Math.round(Math.sqrt(Math.round(smoothLen * 2.2) * 2)), kww_zscore_50: 50, efficiency_ratio_14: 15, volume_ratio_20: 21 },
    has_volume: hasVolume,
    outputs: result
  };
}
