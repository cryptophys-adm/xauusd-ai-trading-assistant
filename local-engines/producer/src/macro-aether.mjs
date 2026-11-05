// Macro & Aether Sensors HUD of GMI v12.70 (owner decision 2026-11-05: every TradingView
// metric becomes agent data). Source: pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt
// (HUD rows near line 2324, inputs near lines 259, 385, 408, 449, 520-623) and
// CryptophysMizanLib (macro_kinematics, macro_penalty, fvg_detect, fvg_mass_*, q_gravity,
// tdm_profile gravity).
//
// Rows computed here, at the last closed chart bar:
//   CONSOL. GRAVITY   tdm_profile gravity_net: inverse-square pull of the smoothed volume
//                     profile above and below the close, in percent.
//   Z3 KINETIC SPREAD the KWW band width (2 x 1.618 sigma) and its percent of the lower band.
//   MACRO CYCLE       macro_penalty(ROC14 > 0 of the DXY and USDT 4h closes as seen on the chart
//                     timeframe, i.e. 14 chart bars back): RISK ON or OFF.
//                     XAUUSD has no EPS/FCF, so the fundamental override never applies.
//   EST. MACRO SHIFT  macro_kinematics on DXY and USDT 4h: the averaged angle and angular
//                     velocity, and the bars to a reversal when their signs differ.
//   ASSET GRAVITY     RSI14 of TVC:USOIL at the chart timeframe: (RSI - 50) / 50.
//   Q-GRAVITY PULL    q_gravity over the open FVG targets: the EMA5 of 0.618 x net pull.
//   MACRO SMR (SMRI)  the FVG reservoir (filled bull gaps in, filled bear gaps out, 0.995
//                     decay) scaled to its 500-bar range, then EMA3.
// MTF HURST and MTF Z-SCORE stay in hud-snapshot.mjs (global_hurst, weighted_global_z).
//
// Semantics and limits:
//   - Pine reads DXY, USDT and USOIL with request.security, lookahead off. On a closed chart bar
//     that is the last closed bar of the other series at the chart bar's close; that is what is
//     used here. TradingView's realtime bar can still see a developing 4h bar, so the macro rows
//     may lag TradingView's display by up to one 4h bar until that bar closes.
//   - The FVG reservoir is path dependent (arrays capped at 20 targets). It is replayed over the
//     same 1000-bar window as the engines; the window start can differ from the chart's.
//   - Nothing here is a TradingView alert field, so every row is unverified for parity.
//
// This module is not part of any approved implementation hash.
import { isNum, nz, sma, ema, change, highest, lowest, linregAt } from "../../gmi/src/pine.mjs";
import { kwwCalc, entropyCalc } from "../../gmi/src/mizan.mjs";
import { pineAtr } from "../../../src/prophet-r37-oscillator.mjs";

const round = (x, d = 4) => (isNum(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const closedAt = (candles, closeMs) => (Array.isArray(candles) ? candles : []).filter((c) => Date.parse(c.close_time) <= closeMs);

/** ta.roc(src, len) = 100 * (src - src[len]) / src[len]. */
export function roc(src, len) {
  return src.map((v, i) => (i >= len && isNum(v) && isNum(src[i - len]) && src[i - len] !== 0 ? (100 * (v - src[i - len])) / src[i - len] : null));
}

/** ta.rma: alpha = 1/len, seeded with ta.sma. */
function rma(src, len) {
  const seed = sma(src, len);
  const out = [];
  let prev = null;
  for (let i = 0; i < src.length; i++) {
    const v = !isNum(prev) ? seed[i] : isNum(src[i]) ? (src[i] + (len - 1) * prev) / len : null;
    out.push(isNum(v) ? v : null);
    prev = out[i];
  }
  return out;
}

/** ta.rsi(src, len). */
export function rsi(src, len = 14) {
  const ch = change(src);
  const up = rma(ch.map((c) => (isNum(c) ? Math.max(c, 0) : null)), len);
  const dn = rma(ch.map((c) => (isNum(c) ? -Math.min(c, 0) : null)), len);
  return src.map((_, i) => {
    if (!isNum(up[i]) || !isNum(dn[i])) return null;
    if (dn[i] === 0) return 100;
    if (up[i] === 0) return 0;
    return 100 - 100 / (1 + up[i] / dn[i]);
  });
}

/** MizanLib macro_kinematics(close) -> { theta, omega } series. */
export function macroKinematics(closes) {
  const r = roc(closes, 14);
  const angle = closes.map((_, i) => {
    const now = linregAt(r, i, 14, 0), prev = linregAt(r, i, 14, 1);
    return isNum(now) && isNum(prev) ? Math.atan((now - prev) * 10) * (180 / Math.PI) : null;
  });
  return { theta: ema(angle, 3), omega: ema(change(angle), 3) };
}

/** MizanLib macro_penalty(dxy_roc_up, usdt_roc_up). */
export function macroPenalty(dxyUp, usdtUp) {
  const score = (dxyUp ? -1 : 1) + (usdtUp ? -1 : 1);
  return score === 2 ? 1.0 : score === -2 ? 0.5 : 0.8;
}

/** The EST. MACRO SHIFT row from the averaged DXY/USDT theta and omega. */
export function macroShift(theta, omega) {
  const t = nz(theta), w = nz(omega);
  if (Math.sign(t) !== Math.sign(w) && w !== 0) return { state: "reversal_due", bars_4h: Math.ceil(Math.abs(t / w)) };
  if (w === 0) return { state: "stagnant", bars_4h: null };
  if (t > 0 && w > 0) return { state: "accelerating_dollar_up", bars_4h: null }; // Pine: ACCELERATING (red)
  if (t < 0 && w < 0) return { state: "accelerating_dollar_down", bars_4h: null }; // Pine: ACCELERATING (green)
  return { state: "neutral", bars_4h: null };
}

/** tdm_profile gravity_net (percent) at bar t, on the same smoothed bins as the value area. */
export function consolidationGravity({ high, low, volume, hlc3, close, atr }, t, lookback = 300, rows = 40, mintick = 0.001) {
  if (t - lookback + 1 < 0 || !isNum(atr[t]) || !isNum(close[t])) return null;
  let gmin = Infinity, gmax = -Infinity;
  for (let k = t - lookback + 1; k <= t; k++) {
    if (isNum(low[k])) gmin = Math.min(gmin, low[k]);
    if (isNum(high[k])) gmax = Math.max(gmax, high[k]);
  }
  const step = gmax - gmin === 0 ? mintick : (gmax - gmin) / rows;
  const bins = new Array(rows).fill(0);
  const idx = (x) => Math.max(0, Math.min(rows - 1, Math.floor((x - gmin) / step)));
  for (let k = 0; k < lookback; k++) {
    const j = t - k;
    if (!isNum(low[j]) || !isNum(high[j]) || !isNum(hlc3[j])) continue;
    const v = Math.max(nz(volume[j], 0), 0);
    const lo = idx(low[j]), mid = idx(hlc3[j]), hi = idx(high[j]);
    if (lo === mid && mid === hi) bins[mid] += v;
    else { bins[lo] += v * 0.25; bins[mid] += v * 0.5; bins[hi] += v * 0.25; }
  }
  const smooth = bins.map((_, i) => {
    const g = (k) => (k >= 0 && k < rows ? bins[k] : 0);
    return (g(i - 2) + g(i - 1) * 2 + g(i) * 3 + g(i + 1) * 2 + g(i + 2)) / 9.0;
  });
  let up = 0, down = 0;
  const c = close[t], a = atr[t];
  for (let i = 1; i <= rows - 2; i++) {
    const v = smooth[i];
    const center = gmin + i * step + step * 0.5;
    if (v > 0) {
      const pull = v / Math.max(Math.abs(c - center) / a, 0.1) ** 2;
      if (center > c) up += pull;
      else if (center < c) down += pull;
    }
  }
  const total = up + down;
  return total > 0 ? ((up - down) / total) * 100 : 0;
}

/** The FVG targets, the SMR reservoir (SMRI) and Q-gravity, replayed bar by bar. */
export function fvgReservoir({ open, high, low, close, volume, atr }) {
  const n = close.length;
  const volSma = sma(volume, 20).map((v) => (isNum(v) ? Math.max(v, 0.0001) : null));
  const bT = [], bM = [], sT = [], sM = [];
  const reservoir = [], rawG = [];
  let res = 0;
  for (let i = 0; i < n; i++) {
    const a = atr[i];
    const anom = isNum(volume[i - 1]) && isNum(volSma[i]) ? volume[i - 1] / volSma[i] : 1.0;
    const bull = i >= 2 && low[i] > high[i - 2] && close[i - 1] > open[i - 1];
    const bear = i >= 2 && high[i] < low[i - 2] && close[i - 1] < open[i - 1];
    if (bull && anom >= 0.8 && isNum(a)) {
      bT.push(high[i - 2]); bM.push((anom * ((low[i] - high[i - 2]) / Math.max(a, 0.0001))) * 1.0);
      if (bT.length > 20) { bT.shift(); bM.shift(); }
    }
    if (bear && anom >= 0.8 && isNum(a)) {
      sT.push(low[i - 2]); sM.push((anom * ((low[i - 2] - high[i]) / Math.max(a, 0.0001))) * 1.0);
      if (sT.length > 20) { sT.shift(); sM.shift(); }
    }
    let cIn = 0, cOut = 0;
    for (let k = bT.length - 1; k >= 0; k--) {
      if (low[i] <= bT[k]) { cIn += bM[k]; bT.splice(k, 1); bM.splice(k, 1); }
      else { const m = bM[k] * 0.995; if (m < 0.05) { bT.splice(k, 1); bM.splice(k, 1); } else bM[k] = m; }
    }
    for (let k = sT.length - 1; k >= 0; k--) {
      if (high[i] >= sT[k]) { cOut += sM[k]; sT.splice(k, 1); sM.splice(k, 1); }
      else { const m = sM[k] * 0.995; if (m < 0.05) { sT.splice(k, 1); sM.splice(k, 1); } else sM[k] = m; }
    }
    res = res * 0.995 + cIn - cOut;
    reservoir.push(res);
    // q_gravity on the targets left after this bar.
    let fUp = 0, fDn = 0;
    const c = close[i], aa = Math.max(nz(a, 0), 0.0001);
    for (let k = 0; k < sT.length; k++) if (sT[k] > c) fUp += nz(sM[k]) / Math.max((sT[k] - c) / aa, 0.1) ** 2;
    for (let k = 0; k < bT.length; k++) if (bT[k] < c) fDn += nz(bM[k]) / Math.max((c - bT[k]) / aa, 0.1) ** 2;
    const tot = fUp + fDn;
    rawG.push((tot > 0 ? (fUp - fDn) / tot : 0) * 0.618);
  }
  const resMax = highest(reservoir, 500), resMin = lowest(reservoir, 500);
  const smriRaw = reservoir.map((r, i) => {
    const hi = nz(resMax[i], r), lo = nz(resMin[i], r);
    return hi - lo === 0 ? 50.0 : ((r - lo) / Math.max(hi - lo, 0.0001)) * 100;
  });
  const smriEma = ema(smriRaw, 3);
  const gEma = ema(rawG, 5);
  return {
    smri: smriRaw.map((v, i) => nz(smriEma[i], v)),
    g_scale: rawG.map((v, i) => nz(gEma[i], v)),
    open_targets: { bull: bT.length, bear: sT.length }
  };
}

/**
 * computeMacroAether({ chartBars, external, mintick }) -> the Macro & Aether fields at the
 * last chart bar (null where the inputs are missing, never invented).
 */
export function computeMacroAether({ chartBars, external = {}, chartKey = "H1", mintick = 0.001 }) {
  const bars = chartBars;
  const t = bars.length - 1;
  if (t < 0) return null;
  const closeMs = Date.parse(bars[t].close_time);
  const open = bars.map((b) => b.open), high = bars.map((b) => b.high), low = bars.map((b) => b.low), close = bars.map((b) => b.close);
  const volume = bars.map((b) => (isNum(b.volume) ? b.volume : null));
  const hlc3 = bars.map((b) => (b.high + b.low + b.close) / 3);
  const atr = pineAtr(bars, 14).map((a) => (isNum(a) ? Math.max(a, mintick) : null));

  const { ma, sigma } = kwwCalc(close, 50);
  const upper = isNum(ma[t]) && isNum(sigma[t]) ? ma[t] + 1.618 * sigma[t] : null;
  const lower = isNum(ma[t]) && isNum(sigma[t]) ? ma[t] - 1.618 * sigma[t] : null;
  const width = isNum(upper) && isNum(lower) ? upper - lower : null;

  const cg = consolidationGravity({ high, low, volume, hlc3, close, atr }, t, 300, 40, mintick);

  const macroCloses = (sym) => closedAt(external?.[sym]?.H4?.candles, closeMs).map((c) => c.close);
  const dxy = macroCloses("TVC:DXY"), usdt = macroCloses("CRYPTOCAP:USDT");
  // Pine: dxy_close = request.security(DXY, "240", close) is a CHART-timeframe series, so
  // ta.roc(dxy_close, 14) compares the 4h close seen at this chart bar with the one seen
  // 14 chart bars earlier (not 14 four-hour bars).
  const seenAt = (sym, ms) => closedAt(external?.[sym]?.H4?.candles, ms).at(-1)?.close ?? null;
  const chartRoc = (sym) => {
    if (t < 14) return null;
    const now = seenAt(sym, closeMs), then = seenAt(sym, Date.parse(bars[t - 14].close_time));
    return isNum(now) && isNum(then) && then !== 0 ? (100 * (now - then)) / then : null;
  };
  let macroCycle = null, macroShiftRow = null;
  if (dxy.length >= 30 && usdt.length >= 30) {
    const rd = chartRoc("TVC:DXY"), ru = chartRoc("CRYPTOCAP:USDT");
    if (isNum(rd) && isNum(ru)) {
      const pen = macroPenalty(rd > 0, ru > 0);
        macroCycle = { state: pen === 1.0 ? "risk_on" : "risk_off", penalty: pen, roc_dxy: round(rd), roc_usdt: round(ru) };
    }
    const kd = macroKinematics(dxy), ku = macroKinematics(usdt);
    const theta = (nz(kd.theta.at(-1)) + nz(ku.theta.at(-1))) / 2, omega = (nz(kd.omega.at(-1)) + nz(ku.omega.at(-1))) / 2;
    macroShiftRow = { ...macroShift(theta, omega), theta: round(theta), omega: round(omega) };
  }

  const oil = closedAt(external?.["TVC:USOIL"]?.[chartKey]?.candles, closeMs).map((c) => c.close);
  const rsiOil = oil.length >= 15 ? rsi(oil, 14).at(-1) : null;
  const grav = isNum(rsiOil) ? (rsiOil - 50) / 50 : null;

  const fvg = fvgReservoir({ open, high, low, close, volume, atr });
  const smri = fvg.smri[t], g = fvg.g_scale[t];

  return {
    consolidation_gravity_pct: round(cg, 2),
    consolidation_gravity: isNum(cg) ? (cg > 5 ? "bullish_pull" : cg < -5 ? "bearish_pull" : "balanced") : null,
    kinetic_spread: round(width, 3),
    kinetic_spread_pct: isNum(width) && isNum(lower) && lower > 0 ? round((width / lower) * 100, 2) : null,
    macro_cycle: macroCycle?.state ?? null,
    macro_penalty: macroCycle?.penalty ?? null,
    roc_dxy: macroCycle?.roc_dxy ?? null,
    roc_usdt: macroCycle?.roc_usdt ?? null,
    macro_shift: macroShiftRow?.state ?? null,
    macro_shift_bars_4h: macroShiftRow?.bars_4h ?? null,
    oil_rsi: round(rsiOil, 2),
    asset_gravity: isNum(grav) ? (grav > 0.15 ? "bias_price_down" : grav < -0.15 ? "bias_price_up" : "neutral") : null,
    asset_gravity_vec: round(grav),
    q_gravity_pct: round(isNum(g) ? g * 100 : null, 2),
    q_gravity: isNum(g) ? (g > 0.1 ? "pull_up" : g < -0.1 ? "pull_down" : "balanced") : null,
    smri: round(smri, 1),
    smr_phase: isNum(smri) ? (smri >= 85 ? "mark_up" : smri <= 15 ? "mark_down" : "equilibrium") : null,
    open_fvg_targets: fvg.open_targets
  };
}
