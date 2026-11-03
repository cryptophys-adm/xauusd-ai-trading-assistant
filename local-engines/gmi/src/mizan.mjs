// Ports of the CryptophysMizanLib exports used by GMI v12.70's verdict path.
// Source: pinescript/ssot/CryptophysMizanLib-uploaded.txt. Each function keeps
// the Pine order of operations; series are arrays oldest -> newest, null = na.
import { isNum, nz, sma, stdev, gt, lt, ge, le, ne } from "./pine.mjs";

const TAU = 14.0;
const BETA = 1.0 / Math.sqrt(3.0);
const KWW_W = (i) => Math.exp(-Math.pow(i / TAU, BETA));

/** kww_calc(src, len) -> { ma, sigma } series. src[i] beyond history -> nz(src[i], src). */
export function kwwCalc(src, len) {
  const weights = Array.from({ length: len }, (_, i) => KWW_W(i));
  const sumW = weights.reduce((a, b) => a + b, 0);
  const ma = [], sigma = [];
  for (let t = 0; t < src.length; t++) {
    const cur = src[t];
    if (!isNum(cur)) { ma.push(null); sigma.push(null); continue; }
    const val = (k) => nz(t - k >= 0 ? src[t - k] : null, cur);
    let spw = 0;
    for (let k = 0; k < len; k++) spw += val(k) * weights[k];
    const m = spw / Math.max(sumW, 0.0001);
    let dev = 0;
    for (let k = 0; k < len; k++) dev += weights[k] * (val(k) - m) ** 2;
    ma.push(m);
    sigma.push(Math.sqrt(dev / Math.max(sumW, 0.0001)));
  }
  return { ma, sigma };
}

/** hurst_rs(src, len) at the last bar of `src` (bar_index = src.length - 1). */
export function hurstRsLast(src, len) {
  const t = src.length - 1;
  if (t < len) return 0.5;
  const at = (k) => src[t - k];
  const ret = (k) => Math.log(at(k) / nz(at(k + 1), at(k)));
  let mean = 0;
  for (let k = 0; k < len; k++) mean += ret(k);
  mean /= len;
  let maxDev = 0, minDev = 0, cum = 0, varRet = 0;
  for (let k = 0; k < len; k++) {
    const r = ret(k);
    cum += r - mean;
    maxDev = Math.max(maxDev, cum);
    minDev = Math.min(minDev, cum);
    varRet += (r - mean) ** 2;
  }
  const R = maxDev - minDev;
  const S = Math.sqrt(varRet / (len - 1));
  const H = S === 0 || R === 0 ? 0.5 : Math.log(R / S) / Math.log(len);
  return Math.max(0, Math.min(1, H));
}

/** entropy_calc(src, len) series. */
export function entropyCalc(src, len) {
  return src.map((_, t) => {
    if (len < 10) return 0.0;
    const at = (k) => (t - k >= 0 ? src[t - k] : null);
    const changes = [];
    for (let k = 1; k <= len - 1; k++) {
      const older = at(k), newer = at(k - 1);
      if (ne(older, 0) && ne(nz(newer), 0)) changes.push(Math.abs((older - newer) / newer));
    }
    if (changes.length < 5) return 0.0;
    const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
    const variance = changes.reduce((a, b) => a + (b - mean) ** 2, 0) / changes.length;
    return Math.min(1.0, Math.sqrt(variance) / (mean + 0.0001));
  });
}

/** spacetime_warp(sigma_kww, ma_kww) series. */
export function spacetimeWarp(sigma, ma) {
  const bw = sigma.map((s, i) => (isNum(s) && isNum(ma[i]) ? (s * 2.0) / Math.max(ma[i], 0.0001) : null));
  const avg = sma(bw, 100);
  return bw.map((b, i) => (isNum(b) && isNum(avg[i]) ? Math.max(0.5, Math.min(b / Math.max(avg[i], 0.0001), 1.618)) : null));
}

/** return_distribution(close, ma, sigma, entropy) -> adjusted mean series. */
export function returnDistribution(close, ma, sigma, entropy) {
  const returns = close.map((c, i) => {
    const prev = nz(i > 0 ? close[i - 1] : null, c);
    return isNum(c) ? (c - prev) / Math.max(prev, 0.0001) : null;
  });
  const base = sma(returns, 50);
  const sd = stdev(returns, 50);
  const adjMean = close.map((c, i) => (isNum(base[i]) && isNum(sd[i]) && isNum(ma[i]) && isNum(sigma[i])
    ? base[i] + ((c - ma[i]) / Math.max(sigma[i], 0.0001)) * sd[i] * 0.1 : null));
  const adjSigma = sd.map((s, i) => (isNum(s) ? s * (1.0 + entropy[i]) : null));
  return { returns, base, adjMean, adjSigma };
}

/** get_jurik(length, phase, power, src) series. */
export function jurik(length, phase, power, src) {
  const phaseRatio = phase < -100 ? 0.5 : phase > 100 ? 2.5 : phase / 100 + 1.5;
  const beta = (0.45 * (length - 1)) / (0.45 * (length - 1) + 2);
  const alpha = Math.pow(beta, power);
  let e0p = 0, e1p = 0, e2p = 0, jp = 0;
  return src.map((s) => {
    if (!isNum(s)) { e0p = 0; e1p = 0; e2p = 0; jp = 0; return null; }
    const e0 = (1 - alpha) * s + alpha * e0p;
    const e1 = (s - e0) * (1 - beta) + beta * e1p;
    const e2 = (e0 + phaseRatio * e1 - jp) * Math.pow(1 - alpha, 2) + Math.pow(alpha, 2) * e2p;
    const j = e2 + jp;
    e0p = e0; e1p = e1; e2p = e2; jp = j;
    return j;
  });
}

/**
 * tdm_profile(...) evaluated at bar t. Returns the fields GMI's verdict path
 * uses: vah, val, poc and the LVN levels. `entropy` is the e series.
 */
export function tdmProfileAt({ high, low, volume, hlc3, entropy, close, atr }, t, lookback, rows, mintick) {
  if (t - lookback + 1 < 0) return { vah: null, val: null, poc: null, lvn_bull_1: null, lvn_bull_2: null, lvn_bear_1: null, lvn_bear_2: null };
  let gmin = Infinity, gmax = -Infinity;
  for (let k = t - lookback + 1; k <= t; k++) {
    if (isNum(low[k])) gmin = Math.min(gmin, low[k]);
    if (isNum(high[k])) gmax = Math.max(gmax, high[k]);
  }
  const step = gmax - gmin === 0 ? mintick : (gmax - gmin) / rows;
  const bins = new Array(rows).fill(0);
  const clampIdx = (x) => Math.max(0, Math.min(rows - 1, Math.floor((x - gmin) / step)));
  for (let k = 0; k < lookback; k++) {
    const j = t - k;
    if (!isNum(low[j]) || !isNum(high[j]) || !isNum(hlc3[j])) continue;
    const v = Math.max(nz(volume[j], 0), 0);
    const lo = clampIdx(low[j]), mid = clampIdx(hlc3[j]), hi = clampIdx(high[j]);
    if (lo === mid && mid === hi) bins[mid] += v;
    else { bins[lo] += v * 0.25; bins[mid] += v * 0.5; bins[hi] += v * 0.25; }
  }
  const smooth = bins.map((_, i) => {
    const g = (k) => (k >= 0 && k < rows ? bins[k] : 0);
    return (g(i - 2) + g(i - 1) * 2 + g(i) * 3 + g(i + 1) * 2 + g(i + 2)) / 9.0;
  });
  let maxV = 0, total = 0, poci = 0;
  for (let i = 0; i < rows; i++) { if (smooth[i] > maxV) { maxV = smooth[i]; poci = i; } total += smooth[i]; }
  const target = total * (0.65 + nz(entropy[t], 0.5) * 0.15);
  let vaVol = maxV, up = poci + 1, down = poci - 1;
  while (vaVol < target && (up < rows || down >= 0)) {
    const upV = up < rows ? smooth[up] : -1.0;
    const dnV = down >= 0 ? smooth[down] : -1.0;
    if (upV >= dnV && upV !== -1.0) { vaVol += upV; up += 1; }
    else if (dnV !== -1.0) { vaVol += dnV; down -= 1; }
  }
  const vah = gmin + Math.min(rows, up) * step;
  const val = gmin + Math.max(0, down + 1) * step;
  const poc = gmin + poci * step + step * 0.5;
  let lb1 = null, lb2 = null, ls1 = null, ls2 = null;
  const c = close[t], a = atr[t];
  for (let i = 1; i <= rows - 2; i++) {
    const v = smooth[i];
    const center = gmin + i * step + step * 0.5;
    if (v < smooth[i - 1] && v < smooth[i + 1] && v < maxV * 0.4) {
      if (le(center, isNum(c) && isNum(a) ? c + a * 0.5 : null)) { lb2 = lb1; lb1 = center; }
      if (ge(center, isNum(c) && isNum(a) ? c - a * 0.5 : null) && ne(center, lb1)) {
        if (ls1 === null) ls1 = center;
        else if (ls2 === null) ls2 = center;
      }
    }
  }
  return { vah, val, poc, lvn_bull_1: lb1, lvn_bull_2: lb2, lvn_bear_1: ls1, lvn_bear_2: ls2 };
}

/** footprint_from_arrays(volume[], close[], open[]) -> { buy, sell } (na when no intrabars). */
export function footprintFromArrays(intrabars) {
  if (!intrabars || intrabars.length === 0) return { buy: null, sell: null };
  let buy = 0, sell = 0;
  for (const b of intrabars) {
    const v = b.volume, c = b.close, o = b.open;
    if (!isNum(v) || !isNum(c) || !isNum(o)) continue;
    if (c > o) buy += v;
    else if (c < o) sell += v;
    else { buy += v * 0.5; sell += v * 0.5; }
  }
  return { buy, sell };
}

/** fabio_decision(...) at bar t; `fakeoutBotSince` / `fakeoutTopSince` are ta.barssince series values. */
export function fabioDecision({ close, atr, isNy, isLondon, imbBull, imbBear, lvnBull, lvnBear, m1Bull, m1Bear, fakeoutBotSince, fakeoutTopSince, m2Bull, m2Bear }) {
  const tol = isNum(atr) ? atr * 2.5 : null;
  const recentBot = le(fakeoutBotSince, 3);
  const recentTop = le(fakeoutTopSince, 3);
  const m1Buy = isNy && imbBull && isNum(lvnBull) && le(Math.abs(close - lvnBull), tol) && m1Bull;
  const m1Sell = isNy && imbBear && isNum(lvnBear) && le(Math.abs(close - lvnBear), tol) && m1Bear;
  const m2Buy = isLondon && recentBot && m2Bull;
  const m2Sell = isLondon && recentTop && m2Bear;
  return { m1Buy: Boolean(m1Buy), m1Sell: Boolean(m1Sell), m2Buy: Boolean(m2Buy), m2Sell: Boolean(m2Sell) };
}

/** ob_progressive_update(...) */
export function obProgressiveUpdate(direction, zoneTop, zoneBottom, initialSpan, atrLocked, high, low, close, bufferAtr, allowUpdate, closeOnly, mintick) {
  let nextTop = zoneTop, nextBottom = zoneBottom;
  const buffer = Math.max(nz(atrLocked, 0) * bufferAtr, 0);
  const touched = allowUpdate && high >= zoneBottom && low <= zoneTop;
  if (allowUpdate) {
    if (direction === -1 && high > zoneBottom && low <= zoneTop) nextBottom = Math.min(zoneTop, Math.max(zoneBottom, high));
    else if (direction === 1 && low < zoneTop && high >= zoneBottom) nextTop = Math.max(zoneBottom, Math.min(zoneTop, low));
  }
  const consumed = nextTop - nextBottom <= mintick;
  const brokenWick = direction === -1 ? high >= nextTop : low <= nextBottom;
  const brokenClose = direction === -1 ? close > nextTop + buffer : close < nextBottom - buffer;
  const invalid = allowUpdate && (consumed || (closeOnly ? brokenClose : brokenWick || brokenClose));
  return { top: nextTop, bottom: nextBottom, touched, invalid };
}

export { gt, lt };
