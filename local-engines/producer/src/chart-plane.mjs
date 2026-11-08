// Chart plane of GMI v12.70 (owner decision 2026-11-08, PR 1 of the key-level plan): every price
// object GMI draws on the chart, computed as numbers at a closed chart bar, so agents can read
// what the screen shows. Source: pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt and
// CryptophysMizanLib (kww_calc, spacetime_warp, return_distribution, calculate_cone, tdm_profile,
// fvg_detect, fvg_mass_*, ext_profile_*). Default indicator inputs.
//
//   bands       Z-KWW MA, +-1 and +-1.618 sigma (section 4); Dynamic EMA 114; VWAP (hlc3, reset
//               at the trading day); the adaptive TVA regression channel (2 deviations).
//   liquidity   Aether FVG open targets with their mass (the SMR reservoir, 20 per side, 0.995
//               decay); the Spacetime Whale Map (5 zones, HP, mitigation blocks); GABFX QM BUY/SELL
//               and RBS/SBR (tactical pivots 14/14); the TDM profile POC/VAH/VAL, LVN and HVN.
//   projection  the SMC Fibonacci grid (struct high/low, 15 ratios warped by the spacetime warp);
//               the probability cone (p90/p10, 50 bars, 1.618 z); the tactical trendlines (the
//               last two pivots 14/14, extended right); PA support/resistance (pivots 10/10).
//   session     True Openings (year, month, week, day, Asia, London, NY AM, NY PM); the macro
//               baselines (day and week open, previous day and week high/low); the external
//               session volume profile (Daily, 30 rows, 70 % value area) of the current session
//               and, beside it, the previous one.
//
// Semantics and limits (none of these is a TradingView alert field, so all are unverified for
// parity; they are context for the Key Level Agent, never a decision on their own):
//   - Path-dependent state (whale zones, QM/RBS/SBR, struct high/low, FVG targets) is replayed over
//     the same window as the engines (1000 chart bars); state older than the window is absent.
//   - True Openings are read from the 15m bars (H1 bars for the month, the D1 trading date for
//     the year), so they are the true open at the stated New York time on every chart; Pine
//     tests the chart's own bars, which on 1H and above can land on the bar that contains it.
//   - The session profile reads the chart's lower timeframe as GMI does (1m for 15m and 1H, 5m
//     for 4H, 15m for D1); the New York calendar day is the session.
// This module imports the hashed engines' helpers but is not part of any implementation hash.
import { isNum, nz, sma, ema, linregAt, pivot, crossover, crossunder, gt, lt } from "../../gmi/src/pine.mjs";
import { kwwCalc, spacetimeWarp, entropyCalc, returnDistribution } from "../../gmi/src/mizan.mjs";
import { pineAtr } from "../../../src/prophet-r37-oscillator.mjs";

export const CHART_PLANE_VERSION = "cryptophys.chart-plane.v1";
export const FIB_RATIOS = Object.freeze([2.618, 1.618, 1.272, 1.0, 0.886, 0.786, 0.618, 0.5, 0.382, 0.275, 0.236, 0.0, -0.236, -0.618, -0.886]);
const DEFAULTS = Object.freeze({ ema_len: 114, reg_period: 150, reg_dev: 2.0, vp_lookback: 300, vp_rows: 40, e_len: 50, cone_bars: 50, cone_z: 1.618, ext_resolution: 30, ext_va: 70 });
const LTF = Object.freeze({ M5: "M1", M15: "M1", H1: "M1", H4: "M5", D1: "M15" });
const NY = "America/New_York";
const HOUR = 3_600_000;

const r3 = (x) => (isNum(x) ? Math.round(x * 1000) / 1000 : null);
const r4 = (x) => (isNum(x) ? Math.round(x * 10000) / 10000 : null);
const candlesOf = (frame) => (Array.isArray(frame?.candles) ? frame.candles : []);

const nyFmt = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** New York calendar parts of a timestamp. */
export function nyParts(ms) {
  const p = Object.fromEntries(nyFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), dow: p.weekday, minutes: Number(p.hour) * 60 + Number(p.minute), date: `${p.year}-${p.month}-${p.day}` };
}

// ---------------------------------------------------------------- bands

/** Session VWAP of hlc3 from `start` (the trading day's first bar) to `t`. */
function vwapAt(bars, t, startMs) {
  let pv = 0, v = 0;
  for (let i = t; i >= 0; i--) {
    if (Date.parse(bars[i].open_time) < startMs) break;
    const vol = bars[i].volume;
    if (!isNum(vol)) return null;
    pv += ((bars[i].high + bars[i].low + bars[i].close) / 3) * vol;
    v += vol;
  }
  return v > 0 ? pv / v : null;
}

/** The TVA channel GMI renders at the last bar (f_render_visual_c). */
function tvaChannel(close, t, period, dev) {
  const mid = linregAt(close, t, period, 0), prev = linregAt(close, t, period, 1);
  if (!isNum(mid) || !isNum(prev)) return null;
  const slope = mid - prev, n1 = period - 1;
  let s = 0;
  for (let i = 0; i <= n1; i++) s += (nz(close[t - i]) - (mid - slope * i)) ** 2;
  const d = dev * Math.sqrt(s / Math.max(n1, 1));
  return { mid: r3(mid), upper: r3(mid + d), lower: r3(mid - d), period, slope_per_bar: r4(slope) };
}

// ---------------------------------------------------------------- liquidity

/** Aether FVG targets left open after bar t (the SMR reservoir of GMI section 4). */
export function fvgTargets({ open, high, low, close, volume, atr, volSma }, t) {
  const bT = [], bM = [], sT = [], sM = [];
  for (let i = 0; i <= t; i++) {
    const a = atr[i];
    const anom = isNum(volume[i - 1]) && isNum(volSma[i]) ? volume[i - 1] / volSma[i] : 1.0;
    const bull = i >= 2 && low[i] > high[i - 2] && close[i - 1] > open[i - 1];
    const bear = i >= 2 && high[i] < low[i - 2] && close[i - 1] < open[i - 1];
    if (bull && anom >= 0.8 && isNum(a)) { bT.push(high[i - 2]); bM.push(anom * ((low[i] - high[i - 2]) / Math.max(a, 0.0001))); if (bT.length > 20) { bT.shift(); bM.shift(); } }
    if (bear && anom >= 0.8 && isNum(a)) { sT.push(low[i - 2]); sM.push(anom * ((low[i - 2] - high[i]) / Math.max(a, 0.0001))); if (sT.length > 20) { sT.shift(); sM.shift(); } }
    for (let k = bT.length - 1; k >= 0; k--) {
      if (low[i] <= bT[k]) { bT.splice(k, 1); bM.splice(k, 1); }
      else { const m = bM[k] * 0.995; if (m < 0.05) { bT.splice(k, 1); bM.splice(k, 1); } else bM[k] = m; }
    }
    for (let k = sT.length - 1; k >= 0; k--) {
      if (high[i] >= sT[k]) { sT.splice(k, 1); sM.splice(k, 1); }
      else { const m = sM[k] * 0.995; if (m < 0.05) { sT.splice(k, 1); sM.splice(k, 1); } else sM[k] = m; }
    }
  }
  const out = (T, M) => T.map((p, k) => ({ price: r3(p), mass: r3(M[k]) })).sort((x, y) => Math.abs(x.price - close[t]) - Math.abs(y.price - close[t]));
  return { bull: out(bT, bM), bear: out(sT, sM) };
}

/** The Spacetime Whale Map after bar t (GMI section 7, show_mitigation on). */
export function whaleZones({ open, high, low, close, volume, atr, volSma }, t) {
  const zones = new Array(5).fill(null);
  let ptr = 0;
  for (let i = 0; i <= t; i++) {
    const a = atr[i], vs = volSma[i], vol = volume[i];
    const isWhaleVol = isNum(vol) && isNum(vs) && vol > vs * 1.5;
    const isWhaleSpr = isNum(a) && (Math.abs(close[i] - open[i]) > a * 0.25 || high[i] - low[i] > a * 0.6);
    if (isWhaleVol && isWhaleSpr) {
      zones[ptr] = { top: close[i] + a * 0.15, bot: close[i] - a * 0.15, support: close[i] >= open[i], hp: isNum(vs) && vs > 0 ? vol / vs : 0, active: true, mitigated: false, created: i };
      ptr = (ptr + 1) % 5;
    }
    for (const z of zones) {
      if (!z) continue;
      if (z.active) {
        if (high[i] >= z.bot && low[i] <= z.top && i > z.created) z.hp = Math.max(0, z.hp - (isNum(vs) && vs > 0 && isNum(vol) ? vol / vs : 1.0));
        if (z.hp <= 0 || (z.support && close[i] < z.bot) || (!z.support && close[i] > z.top)) { z.active = false; z.mitigated = true; }
      } else if (z.mitigated) {
        if ((z.support && close[i] > z.top) || (!z.support && close[i] < z.bot)) z.mitigated = false;
      }
    }
  }
  return zones.filter((z) => z && (z.active || z.mitigated)).map((z) => ({
    // A broken support becomes a mitigation block that resists from above (and the reverse).
    role: z.active ? (z.support ? "support" : "resistance") : (z.support ? "resistance" : "support"),
    state: z.active ? "active" : "mitigation", top: r3(z.top), bottom: r3(z.bot), hp: z.active ? r3(z.hp) : null, age_bars: t - z.created
  })).sort((x, y) => Math.abs((x.top + x.bottom) / 2 - close[t]) - Math.abs((y.top + y.bottom) / 2 - close[t]));
}

/** GABFX QM / RBS / SBR after bar t (GMI section 10, tactical pivots 14/14). */
export function gabfxLevels({ high, low, close }, t) {
  const tlPh = pivot(high, 14, 14, true), tlPl = pivot(low, 14, 14, false);
  const ph1 = [], ph2 = [], pl1 = [], pl2 = [];
  let a1 = null, a2 = null, b1 = null, b2 = null;
  for (let i = 0; i <= t; i++) {
    if (isNum(tlPh[i])) { a2 = a1; a1 = tlPh[i]; }
    if (isNum(tlPl[i])) { b2 = b1; b1 = tlPl[i]; }
    ph1.push(a1); ph2.push(a2); pl1.push(b1); pl2.push(b2);
  }
  let qmSell = null, qmBuy = null, rbs = null, sbr = null;
  for (let i = 0; i <= t; i++) {
    const c = close[i];
    const breakSup = crossunder(close, pl1, i), breakRes = crossover(close, ph1, i);
    if (gt(ph1[i], ph2[i]) && gt(pl1[i], pl2[i]) && breakSup) qmSell = ph2[i];
    if (lt(pl1[i], pl2[i]) && lt(ph1[i], ph2[i]) && breakRes) qmBuy = pl2[i];
    if (breakRes) rbs = ph1[i];
    if (breakSup) sbr = pl1[i];
    if (isNum(qmBuy) && c < qmBuy) qmBuy = null;
    if (isNum(qmSell) && c > qmSell) qmSell = null;
    if (isNum(rbs) && c < rbs) rbs = null;
    if (isNum(sbr) && c > sbr) sbr = null;
  }
  return { qm_buy: r3(qmBuy), qm_sell: r3(qmSell), rbs: r3(rbs), sbr: r3(sbr) };
}

/** Mizan tdm_profile at bar t: POC, VAH, VAL, LVN (2 per side) and HVN. */
export function tdmProfile({ high, low, volume, close, atr, entropy }, t, lookback, rows, mintick) {
  if (t - lookback + 1 < 0) return null;
  let gmin = Infinity, gmax = -Infinity;
  for (let k = t - lookback + 1; k <= t; k++) { if (isNum(low[k])) gmin = Math.min(gmin, low[k]); if (isNum(high[k])) gmax = Math.max(gmax, high[k]); }
  const step = gmax - gmin === 0 ? mintick : (gmax - gmin) / rows;
  const bins = new Array(rows).fill(0);
  const idx = (x) => Math.max(0, Math.min(rows - 1, Math.floor((x - gmin) / step)));
  for (let k = 0; k < lookback; k++) {
    const j = t - k;
    if (!isNum(low[j]) || !isNum(high[j]) || !isNum(close[j])) continue;
    const v = Math.max(nz(volume[j], 0), 0), hlc3 = (high[j] + low[j] + close[j]) / 3;
    const lo = idx(low[j]), mid = idx(hlc3), hi = idx(high[j]);
    if (lo === mid && mid === hi) bins[mid] += v;
    else { bins[lo] += v * 0.25; bins[mid] += v * 0.5; bins[hi] += v * 0.25; }
  }
  const g = (k) => (k >= 0 && k < rows ? bins[k] : 0);
  const smooth = bins.map((_, i) => (g(i - 2) + g(i - 1) * 2 + g(i) * 3 + g(i + 1) * 2 + g(i + 2)) / 9.0);
  let maxV = 0, total = 0, poci = 0;
  for (let i = 0; i < rows; i++) { if (smooth[i] > maxV) { maxV = smooth[i]; poci = i; } total += smooth[i]; }
  if (!(total > 0)) return null;
  const target = total * (0.65 + nz(entropy[t], 0.5) * 0.15);
  let vaVol = maxV, up = poci + 1, down = poci - 1;
  while (vaVol < target && (up < rows || down >= 0)) {
    const upV = up < rows ? smooth[up] : -1.0, dnV = down >= 0 ? smooth[down] : -1.0;
    if (upV >= dnV && upV !== -1.0) { vaVol += upV; up += 1; } else if (dnV !== -1.0) { vaVol += dnV; down -= 1; }
  }
  const c = close[t], a = atr[t];
  let lb1 = null, lb2 = null, ls1 = null, ls2 = null, hvnBull = null, hvnBear = null;
  for (let i = 1; i <= rows - 2; i++) {
    const v = smooth[i], price = gmin + i * step, center = price + step * 0.5;
    if (v < smooth[i - 1] && v < smooth[i + 1] && v < maxV * 0.4 && isNum(a)) {
      if (center <= c + a * 0.5) { lb2 = lb1; lb1 = center; }
      if (center >= c - a * 0.5 && center !== lb1) { if (ls1 === null) ls1 = center; else if (ls2 === null) ls2 = center; }
    }
    if (v > smooth[i - 1] && v > smooth[i + 1] && v > maxV * 0.6) {
      if (price < c) hvnBull = price;
      if (price > c) hvnBear = price;
    }
  }
  return {
    poc: r3(gmin + poci * step + step * 0.5), vah: r3(gmin + Math.min(rows, up) * step), val: r3(gmin + Math.max(0, down + 1) * step),
    lvn_bull: [lb1, lb2].filter(isNum).map(r3), lvn_bear: [ls1, ls2].filter(isNum).map(r3), hvn_bull: r3(hvnBull), hvn_bear: r3(hvnBear)
  };
}

// ---------------------------------------------------------------- projection

/** ta.highestbars / ta.lowestbars (offset <= 0 of the extreme of the last `len` bars, newest wins ties). */
function extremeBars(src, i, len, high) {
  let best = null, off = 0;
  for (let k = 0; k < len && i - k >= 0; k++) {
    const v = src[i - k];
    if (!isNum(v)) continue;
    if (best === null || (high ? v > best : v < best)) { best = v; off = -k; }
  }
  return off;
}

/** The SMC Fibonacci structure (GMI section 13) after bar t. */
export function fibStructure({ high, low, close }, t) {
  let sh = null, sl = null, shIdx = 0, slIdx = 0, dir = 0;
  for (let i = 0; i <= t; i++) {
    if (i === 0) { sh = high[0]; sl = low[0]; continue; }
    const maxOff = (() => { const maxBar = -Math.abs(extremeBars(high, i, 10, true)); let idx = 0; for (let k = 0; k <= 9; k++) if (high[i - k - 1] > high[i - k - 2] && high[i - k] <= high[i - k - 1] && -(k + 1) >= maxBar) idx = -(k + 1); return idx === 0 ? maxBar : idx; })();
    const minOff = (() => { const minBar = -Math.abs(extremeBars(low, i, 10, false)); let idx = 0; for (let k = 0; k <= 9; k++) if (low[i - k - 1] < low[i - k - 2] && low[i - k] >= low[i - k - 1] && -(k + 1) >= minBar) idx = -(k + 1); return idx === 0 ? minBar : idx; })();
    const c = close[i], c1 = close[i - 1], c2 = close[i - 2], c3 = close[i - 3];
    const lBroken = (c < sl && c1 >= sl && c2 >= sl && c3 >= sl && i - 3 > slIdx) || (dir === 2 && c < sl);
    const hBroken = (c > sh && c1 <= sh && c2 <= sh && c3 <= sh && i - 3 > shIdx) || (dir === 1 && c > sh);
    if (lBroken) { dir = 1; shIdx = i + maxOff; slIdx = i; sh = high[Math.max(0, shIdx)]; sl = low[i]; }
    else if (hBroken) { dir = 2; shIdx = i; slIdx = i + minOff; sh = high[i]; sl = low[Math.max(0, slIdx)]; }
    else if (high[i] > sh && (dir === 0 || dir === 2)) { if (!(i - 3 > shIdx)) { sh = high[i]; shIdx = i; } }
    else if (low[i] < sl && (dir === 0 || dir === 1)) { if (!(i - 3 > slIdx)) { sl = low[i]; slIdx = i; } }
  }
  return { dir, high: sh, low: sl, high_index: shIdx, low_index: slIdx };
}

/** The 15 Fibonacci prices GMI renders, warped by the spacetime warp. */
export function fibGrid(structure, warp) {
  if (!structure || !isNum(structure.high) || !isNum(structure.low)) return null;
  const range = Math.abs(structure.high - structure.low), w = nz(warp, 1.0);
  const levels = {};
  for (const f of FIB_RATIOS) {
    const wf = 0.5 + (f - 0.5) * w;
    levels[String(f)] = r3(structure.dir === 2 ? structure.low + range * wf : structure.high - range * wf);
  }
  // dir 2: the last break was up, the grid runs from the struct low; otherwise from the high.
  return { direction: structure.dir === 2 ? "up" : structure.dir === 1 ? "down" : "none", high: r3(structure.high), low: r3(structure.low), warp: r4(w), levels };
}

/** The tactical trendlines and PA lines at bar t. */
function lines({ high, low }, t, timeOf) {
  const ph = pivot(high, 14, 14, true), pl = pivot(low, 14, 14, false);
  const last2 = (arr) => { const out = []; for (let i = t; i >= 0 && out.length < 2; i--) if (isNum(arr[i])) out.push({ x: i - 14, y: arr[i] }); return out; };
  const line = ([p1, p2]) => {
    if (!p1 || !p2 || p1.x === p2.x) return null;
    const slope = (p1.y - p2.y) / (p1.x - p2.x);
    return { from: { time: timeOf(p2.x), price: r3(p2.y) }, to: { time: timeOf(p1.x), price: r3(p1.y) }, price_now: r3(p1.y + slope * (t - p1.x)), slope_per_bar: r4(slope) };
  };
  const paH = pivot(high, 10, 10, true), paL = pivot(low, 10, 10, false);
  const lastOf = (arr) => { for (let i = t; i >= 0; i--) if (isNum(arr[i])) return r3(arr[i]); return null; };
  return { trendlines: { resistance: line(last2(ph)), support: line(last2(pl)) }, pa: { resistance: lastOf(paH), support: lastOf(paL) } };
}

// ---------------------------------------------------------------- session

/** True Openings (GMI section 14.5) as of `closeMs`. */
export function trueOpenings({ m15 = [], h1 = [], d1 = [] }, closeMs) {
  const upto = (bars) => bars.filter((b) => Date.parse(b.close_time) <= closeMs);
  const at = (bars, test) => { for (let i = bars.length - 1; i >= 0; i--) { const ms = Date.parse(bars[i].open_time); if (test(nyParts(ms), ms)) return r3(bars[i].open); } return null; };
  const m = upto(m15), h = upto(h1);
  const first = (bars, test) => { // the first bar of the latest run where `test` holds (Pine: cond and not cond[1])
    for (let i = bars.length - 1; i >= 0; i--) {
      const p = nyParts(Date.parse(bars[i].open_time));
      if (!test(p)) continue;
      let j = i;
      while (j > 0 && test(nyParts(Date.parse(bars[j - 1].open_time)))) j--;
      return r3(bars[j].open);
    }
    return null;
  };
  const yearBars = upto(d1);
  const trading = (b) => nyParts(Date.parse(b.open_time) + 7 * HOUR); // OANDA's day opens at 17:00 New York
  let year = null;
  for (let i = yearBars.length - 1; i >= 0; i--) { const p = trading(yearBars[i]); if (p.month === 4 && p.dow === "Mon" && p.day <= 7) { year = r3(yearBars[i].open); break; } }
  return {
    year,
    month: first(h, (p) => p.dow === "Mon" && p.day >= 8 && p.day <= 14),
    week: at(m, (p) => p.dow === "Mon" && p.minutes === 18 * 60),
    day: at(m, (p) => p.minutes === 0),
    asia: at(m, (p) => p.minutes === 19 * 60 + 30),
    london: at(m, (p) => p.minutes === 60 + 30),
    ny_am: at(m, (p) => p.minutes === 7 * 60 + 30),
    ny_pm: at(m, (p) => p.minutes === 13 * 60 + 30)
  };
}

/** Day and week open, previous day and week high and low (GMI macro baselines). */
export function macroBaselines({ fine = [], d1 = [], w1 = [] }, openMs, closeMs) {
  const lastClosed = (bars) => { let f = null; for (const b of bars) if (Date.parse(b.close_time) <= openMs) f = b; return f; };
  const pd = lastClosed(d1), pw = lastClosed(w1);
  const openSince = (b) => { if (!b) return null; const s = Date.parse(b.close_time); const f = fine.find((x) => Date.parse(x.open_time) >= s && Date.parse(x.close_time) <= closeMs); return f ? r3(f.open) : null; };
  return { day_open: openSince(pd), week_open: openSince(pw), prev_day_high: r3(pd?.high), prev_day_low: r3(pd?.low), prev_week_high: r3(pw?.high), prev_week_low: r3(pw?.low) };
}

const overlap = (y11, y12, y21, y22, height, vol) => (Math.max(Math.min(Math.max(y11, y12), Math.max(y21, y22)) - Math.max(Math.min(y11, y12), Math.min(y21, y22)), 0) * vol) / Math.max(height, 0.0001);

/** Mizan ext_profile_* over one session's intrabars: POC, VAH, VAL. */
export function sessionProfile(intrabars, { resolution = DEFAULTS.ext_resolution, vaPct = DEFAULTS.ext_va } = {}) {
  const bars = intrabars.filter((b) => [b.open, b.high, b.low, b.close].every(isNum));
  if (!bars.length) return null;
  const hi = Math.max(...bars.map((b) => b.high)), lo = Math.min(...bars.map((b) => b.low));
  if (!(hi > lo) || resolution < 2) return null;
  const gap = (hi - lo) / resolution;
  const bounds = Array.from({ length: resolution }, (_, i) => hi - gap * i);
  const green = new Array(resolution).fill(0), red = new Array(resolution).fill(0);
  for (const b of bars) {
    const v = nz(b.volume, 0), bodyTop = Math.max(b.close, b.open), bodyBot = Math.min(b.close, b.open), isGreen = b.close >= b.open;
    const topWick = b.high - bodyTop, botWick = bodyBot - b.low, body = bodyTop - bodyBot;
    const totalRange = 2 * topWick + 2 * botWick + body;
    const bodyVol = totalRange > 0 ? (body * v) / totalRange : 0, topVol = totalRange > 0 ? (2 * topWick * v) / totalRange : 0, botVol = totalRange > 0 ? (2 * botWick * v) / totalRange : 0;
    for (let i = 0; i < resolution; i++) {
      const zt = bounds[i], zb = zt - gap;
      const wicks = overlap(zb, zt, bodyTop, b.high, topWick, topVol) / 2 + overlap(zb, zt, bodyBot, b.low, botWick, botVol) / 2;
      const bodyAdd = overlap(zb, zt, bodyBot, bodyTop, body, bodyVol);
      green[i] += (isGreen ? bodyAdd : 0) + wicks;
      red[i] += (isGreen ? 0 : bodyAdd) + wicks;
    }
  }
  let maxV = 0, li = 0;
  for (let i = 0; i < resolution; i++) { const s = red[i] + green[i]; if (s > maxV) { maxV = s; li = i; } }
  if (!(maxV > 0) || li >= resolution - 1) return { high: r3(hi), low: r3(lo), poc: null, vah: null, val: null, bars: bars.length };
  const poc = bounds[li] - (bounds[li] - bounds[li + 1]) / 2;
  const sumV = red.reduce((a, x) => a + x, 0) + green.reduce((a, x) => a + x, 0);
  let vah = hi, val = lo, count = 0, pi = null;
  for (let i = 0; i <= resolution - 2; i++) if (bounds[i] >= poc && bounds[i + 1] < poc) pi = i;
  if (pi !== null) {
    count = red[pi] + green[pi];
    for (let i = 1; i <= resolution; i++) {
      if (pi + i < resolution) { count += red[pi + i] + green[pi + i]; if (count >= sumV * (vaPct / 100)) break; val = bounds[pi + i] - gap; }
      if (pi - i >= 0) { count += red[pi - i] + green[pi - i]; if (count >= sumV * (vaPct / 100)) break; vah = bounds[pi - i]; }
    }
  }
  return { high: r3(hi), low: r3(lo), poc: r3(poc), vah: r3(vah), val: r3(val), bars: bars.length };
}

/** The Daily session profile (New York calendar day) of the latest session and of the one before. */
function sessionProfiles(intrabars) {
  if (!intrabars.length) return { current: null, previous: null };
  const byDate = new Map();
  for (const b of intrabars) { const d = nyParts(Date.parse(b.open_time)).date; if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(b); }
  const dates = [...byDate.keys()];
  const of = (d) => (d ? { session: d, ...sessionProfile(byDate.get(d)) } : null);
  return { current: of(dates.at(-1)), previous: dates.length > 1 ? of(dates.at(-2)) : null };
}

// ---------------------------------------------------------------- plane

/**
 * buildChartPlane(bundle, { chart, chartBars, mintick }): the chart plane at the last bar of
 * `chartBars` (closed bars of the chart, the engines' window). Returns null when the window is too
 * short for the profile; a family that cannot be computed is null, never invented.
 */
export function buildChartPlane(bundle, { chart, chartBars, mintick = 0.001 } = {}) {
  const n = chartBars?.length ?? 0;
  if (n < DEFAULTS.vp_lookback + 20) return null;
  const t = n - 1, last = chartBars[t];
  const openMs = Date.parse(last.open_time), closeMs = Date.parse(last.close_time);
  const open = chartBars.map((b) => b.open), high = chartBars.map((b) => b.high), low = chartBars.map((b) => b.low), close = chartBars.map((b) => b.close);
  const volume = chartBars.map((b) => (isNum(b.volume) ? b.volume : null));
  const atr = pineAtr(chartBars, 14).map((a) => (isNum(a) ? Math.max(a, mintick) : null));
  const volSma = sma(volume, 20).map((v) => (isNum(v) ? Math.max(v, 0.0001) : null));
  const { ma, sigma } = kwwCalc(close, 50);
  const warp = spacetimeWarp(sigma, ma);
  const entropy = entropyCalc(close, DEFAULTS.e_len);
  const series = { open, high, low, close, volume, atr, volSma, entropy };
  const tf = bundle?.timeframes || {};
  const upto = (bars) => bars.filter((b) => Date.parse(b.close_time) <= closeMs);
  const safe = (fn) => { try { return fn(); } catch { return null; } };

  const m = ma[t], s = sigma[t], c = close[t];
  const dayStart = (() => { let f = null; for (const b of candlesOf(tf.D1)) if (Date.parse(b.close_time) <= openMs) f = b; return f ? Date.parse(f.close_time) : null; })();
  const period = Math.trunc(Math.max(10, Math.min(Math.round(DEFAULTS.reg_period / Math.max(nz(warp[t], 1.0), 0.1)), 500)));
  const emaV = ema(close, DEFAULTS.ema_len)[t];
  const bands = {
    kww: isNum(m) && isNum(s) ? { ma: r3(m), plus_1: r3(m + s), minus_1: r3(m - s), plus_1618: r3(m + 1.618 * s), minus_1618: r3(m - 1.618 * s), zscore: r4((c - m) / Math.max(s, 0.0001)) } : null,
    ema_114: r3(emaV),
    vwap: dayStart !== null ? r3(vwapAt(chartBars, t, dayStart)) : null,
    tva: safe(() => tvaChannel(close, t, period, DEFAULTS.reg_dev))
  };

  const liquidity = {
    fvg: safe(() => fvgTargets(series, t)),
    whale_zones: safe(() => whaleZones(series, t)),
    gabfx: safe(() => gabfxLevels(series, t)),
    profile: safe(() => tdmProfile(series, t, DEFAULTS.vp_lookback, DEFAULTS.vp_rows, mintick))
  };

  const { adjMean, adjSigma } = returnDistribution(close, ma, sigma, entropy);
  const mu = adjMean[t], sg = adjSigma[t];
  const cone = isNum(mu) && isNum(sg) ? (() => {
    const muT = mu - sg ** 2 / 2, k = DEFAULTS.cone_bars;
    return { bars: k, p90: r3(c * Math.exp(muT * k + DEFAULTS.cone_z * sg * Math.sqrt(k))), p10: r3(c * Math.exp(muT * k - DEFAULTS.cone_z * sg * Math.sqrt(k))) };
  })() : null;
  const timeOf = (i) => (i >= 0 && i < n ? chartBars[i].open_time : null);
  const projection = {
    fib: safe(() => fibGrid(fibStructure(series, t), warp[t])),
    cone,
    ...(safe(() => lines(series, t, timeOf)) ?? { trendlines: null, pa: null })
  };

  const fine = upto(candlesOf(tf.M15).length ? candlesOf(tf.M15) : chartBars);
  const ltf = upto(candlesOf(tf[LTF[chart] ?? "M1"]));
  const session = {
    opens: safe(() => trueOpenings({ m15: candlesOf(tf.M15), h1: candlesOf(tf.H1), d1: candlesOf(tf.D1) }, closeMs)),
    baselines: safe(() => macroBaselines({ fine, d1: candlesOf(tf.D1), w1: candlesOf(tf.W1) }, openMs, closeMs)),
    profile: safe(() => ({ intrabars: LTF[chart] ?? "M1", ...sessionProfiles(ltf.filter((b) => Date.parse(b.open_time) >= closeMs - 3 * 24 * HOUR)) }))
  };

  return { version: CHART_PLANE_VERSION, close: r3(c), atr: r3(atr[t]), bands, liquidity, projection, session };
}
