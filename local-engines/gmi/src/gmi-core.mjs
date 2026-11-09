// Local GMI v12.70 verdict engine for every chart: 5m, 15m, 1H, 4H and D1
// (source: pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt).
// Reproduces the series that feed the CTA webhook fields
//   verdict (verdict_state), gate (r10_gate_status), gmi_dir, prophet_dir, conflict
// for a confirmed chart bar, from raw TradingView OHLCV (chart, dyn_ltf intrabars,
// MTF native series). Default indicator inputs are used. Rendering/HUD omitted.
//
// B4 (owner, 2026-11-05; done 2026-11-09 with the owner's go for a full re-approval): this one
// module replaces the three copies it grew from (the H1 core, gmi-core-tf for 5m/15m and
// gmi-core-htf for 4H/D1). The chart timeframe is a parameter:
//   - the chart series is bundle.timeframes[chart];
//   - intrabars follow Pine's dyn_ltf: "1" below 240, "5" on 240 and "15" on daily
//     (`timeframe.isdaily ? "15" : timeframe.period == "240" ? "5" : "1"`), so the
//     footprint reads M1, M5 or M15 bars;
//   - MTF Hurst (15/60/240/D/W): a timeframe equal to the chart is the chart series, one above
//     it is read realtime-at-close, one below it from its closed bars.
// computeGmi(bundle) is the 1H chart. gmi-core-tf.mjs and gmi-core-htf.mjs are kept as one-line
// re-exports, so the producers that import them, and the Prophet and MizanLib identities that
// hash those producers, did not change. Every GMI identity re-earns its 24 parity matches.
//
// Known approximations are listed in GMI_APPROXIMATIONS and must be resolved
// by the parity registry (webhook comparison), never assumed equal.
import {
  isNum, nz, gt, lt, ge, le, eq, ne, sign, max2, sma, sum, ema, change, highest, lowest,
  linregAt, percentrank, pivot, barssince, crossover, crossunder
} from "./pine.mjs";
import {
  kwwCalc, hurstRsLast, entropyCalc, spacetimeWarp, returnDistribution, jurik,
  tdmProfileAt, footprintFromArrays, fabioDecision, obProgressiveUpdate
} from "./mizan.mjs";
import { pineAtr, prophetEfficiencyRatio, replayProphetR37ClosedBars } from "../../../src/prophet-r37-oscillator.mjs";

export const GMI_DEFAULTS = Object.freeze({
  e_len: 50, vp_lookback: 300, vp_rows: 40, reg_period: 150, use_tva_channel: true,
  ob_pivot_len: 5, vol_mult_ob: 1.5, use_dyn_vol: true, sma_len_ob: 20, max_nodes_ob: 60,
  ob_max_age: 120, max_ob_per_direction: 30, ob_close_only: false, mitig_buffer: 0.25, max_wick_atr: 3.0,
  use_vol_veto: true, show_mitigation: true, shared_prophet_alignment: true
});

export const GMI_APPROXIMATIONS = Object.freeze([
  "MTF Hurst (15/60/240/D/W): realtime-at-close semantics; the developing 240/D/W bar is aggregated from chart bars since the last native bar's nominal close.",
  "History depth is the cached window (default 1000 H1 bars) rather than the chart's full history; long-lived var state (QM/RBS/SBR levels) older than the window is not reconstructed.",
  "ta.pivothigh/pivotlow tie handling is strict on both sides.",
  "Fundamental override (request.financial) is treated as unavailable for OANDA:XAUUSD (has_funda = false)."
]);

/** Supported chart timeframes and their period in minutes. */
export const GMI_CHART_MINUTES = Object.freeze({ M5: 5, M15: 15, H1: 60, H4: 240, D1: 1440 });

/** Pine dyn_ltf as a bundle timeframe key: M15 on daily, M5 on 240, M1 below. */
export function intrabarTimeframe(chartMinutes) {
  return chartMinutes >= 1440 ? "M15" : chartMinutes >= 240 ? "M5" : "M1";
}

const NY = "America/New_York";
const nyParts = (ms) => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const get = (t) => Number(p.find((x) => x.type === t)?.value);
  return get("hour") * 60 + get("minute");
};
/** Pine time(tf, "HHMM-HHMM", tz) membership of the bar open time. */
const inSession = (ms, startMin, endMin) => {
  const m = nyParts(ms);
  return startMin <= endMin ? m >= startMin && m < endMin : m >= startMin || m < endMin;
};

function intrabarsByChartBar(chart, m1, chartMs) {
  const out = chart.map(() => []);
  let j = 0;
  const m1s = [...m1].sort((a, b) => a.time - b.time);
  for (let i = 0; i < chart.length; i++) {
    const start = chart[i].time * 1000, end = start + chartMs;
    while (j < m1s.length && m1s[j].time * 1000 < start) j++;
    let k = j;
    while (k < m1s.length && m1s[k].time * 1000 < end) { out[i].push(m1s[k]); k++; }
  }
  return out;
}

/** HTF series as seen by request.security at the chart bar close (realtime, lookahead off). */
function htfCloseSeriesAt(native, chart, chartCloseMs, htfMs) {
  const closed = native.filter((b) => Date.parse(b.close_time) <= chartCloseMs);
  const last = closed.at(-1);
  const partialFrom = last ? Date.parse(last.close_time) : -Infinity;
  const partial = chart.filter((b) => b.time * 1000 >= partialFrom && Date.parse(b.close_time) <= chartCloseMs);
  const closes = closed.map((b) => b.close);
  if (partial.length && (!last || partial[0].time * 1000 < partialFrom + htfMs)) closes.push(partial.at(-1).close);
  return closes;
}

/**
 * computeGmiOnChart(bundle, { chart, mintick }) -> { outputs for the last bar, series diagnostics }.
 * chart: "M5", "M15", "H1", "H4" or "D1". bundle.timeframes: the chart series, M1, M15, H1, H4, D1, W1
 * — closed candles with time (sec).
 */
export function computeGmiOnChart(bundle, { chart: chartTf = "H1", mintick = 0.001, window = 1000, options = {} } = {}) {
  const chartMinutes = GMI_CHART_MINUTES[chartTf];
  if (!chartMinutes) throw Object.assign(new Error(`unsupported GMI chart timeframe: ${chartTf}`), { code: "unsupported_chart_timeframe" });
  const cfg = { ...GMI_DEFAULTS, ...options };
  const chart = (bundle?.timeframes?.[chartTf]?.candles || []).slice(-window);
  const n = chart.length;
  if (n < cfg.vp_lookback + 20) throw Object.assign(new Error(`insufficient chart history: ${n}`), { code: "insufficient_chart_history" });
  const chartMs = chartMinutes * 60 * 1000;
  const open = chart.map((b) => b.open), high = chart.map((b) => b.high), low = chart.map((b) => b.low);
  const close = chart.map((b) => b.close), volume = chart.map((b) => (isNum(b.volume) ? b.volume : null));
  const hlc3 = chart.map((b) => (b.high + b.low + b.close) / 3);
  const t = n - 1;

  // --- ATR / volume basics
  const atr14 = pineAtr(chart, 14);
  const atrVal = atr14.map((a) => (isNum(a) ? Math.max(a, mintick) : null));
  const volSmaRaw = sma(volume, 20);
  const volSma = volSmaRaw.map((v) => (isNum(v) ? Math.max(v, 0.0001) : null));

  // --- Entropy, efficiency, chaos
  const e = entropyCalc(close, cfg.e_len);
  const effRat = prophetEfficiencyRatio(close, 14);
  const noise = e.map((x, i) => (isNum(effRat[i]) ? nz(x) * (1 - effRat[i]) : null));
  const isChaos = e.map((x, i) => ge(x, 0.8) || ge(noise[i], 0.85));

  // --- KWW, spacetime warp, adaptive TVA regression kinetics
  const { ma: maKww, sigma: sigmaKww } = kwwCalc(close, 50);
  const swc = spacetimeWarp(sigmaKww, maKww);
  const dynLen = swc.map((w) => (cfg.use_tva_channel ? Math.trunc(Math.max(10, Math.min(Math.round(cfg.reg_period / Math.max(nz(w, 1.0), 0.1)), 500))) : cfg.reg_period));
  const kTheta = close.map((_, i) => {
    const l0 = linregAt(close, i, dynLen[i], 0), l1 = linregAt(close, i, dynLen[i], 1);
    if (!isNum(l0) || !isNum(l1) || !isNum(atrVal[i])) return null;
    const norm = ((l0 - l1) / Math.max(atrVal[i], 0.0001)) * 10.0;
    return Math.atan(norm) * (180.0 / Math.PI);
  });
  const sTheta = ema(kTheta, 3);
  const sOmega = ema(change(kTheta), 3);
  const sAlpha = ema(change(sOmega), 3);
  const estRevBars = sTheta.map((th, i) => (sign(th) !== null && sign(sOmega[i]) !== null && sign(th) !== sign(sOmega[i]) && ne(sOmega[i], 0) ? Math.abs(th / sOmega[i]) : null));

  // --- Return distribution
  const { adjMean } = returnDistribution(close, maKww, sigmaKww, e);

  // --- Shared Prophet core (GMI's own computation: pro_fast, d_enc, subtype)
  const r37 = replayProphetR37ClosedBars(chart.map((b, i) => ({ bar_index: i, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })), { mintick });
  const proFast = r37.pro_fast;
  const st = r37.structure;

  // --- TDM profile (needed per bar for fakeout memory; computed for the last 10 bars)
  const tdmCache = new Map();
  const tdm = (i) => {
    if (!tdmCache.has(i)) tdmCache.set(i, tdmProfileAt({ high, low, volume, hlc3, entropy: e, close, atr: atrVal }, i, cfg.vp_lookback, cfg.vp_rows, mintick));
    return tdmCache.get(i);
  };

  // --- Footprint (dyn_ltf intrabars: M1, M5 on H4, M15 on D1)
  const intra = intrabarsByChartBar(chart, bundle?.timeframes?.[intrabarTimeframe(chartMinutes)]?.candles || [], chartMs);
  const fp = intra.map(footprintFromArrays);
  const buyVol = fp.map((f) => f.buy), sellVol = fp.map((f) => f.sell);
  const barDelta = fp.map((f) => nz(isNum(f.buy) && isNum(f.sell) ? f.buy - f.sell : null, 0));
  const totVol = fp.map((f) => nz(isNum(f.buy) && isNum(f.sell) ? f.buy + f.sell : null, 0));
  const oscCvd = sum(barDelta, 14);
  const volSurge = volume.map((v, i) => (isNum(volSma[i]) && volSma[i] > 0 && isNum(v) ? v / volSma[i] : 0));
  const isLimitWall = chart.map((b, i) => volSurge[i] > 1.5 && lt(Math.abs(b.close - b.open), isNum(atrVal[i]) ? atrVal[i] * 0.5 : null));
  const bullAbs = chart.map((b, i) => barDelta[i] < 0 && Math.abs(barDelta[i]) > totVol[i] * 0.2 && b.close >= b.open);
  const bearAbs = chart.map((b, i) => barDelta[i] > 0 && barDelta[i] > totVol[i] * 0.2 && b.close <= b.open);
  const bullSqueeze = chart.map((b, i) => i > 0 && bullAbs[i - 1] && b.close > high[i - 1] && barDelta[i] > 0);
  const bearSqueeze = chart.map((b, i) => i > 0 && bearAbs[i - 1] && b.close < low[i - 1] && barDelta[i] < 0);
  const lowest10 = lowest(close, 10), highest10 = highest(close, 10);
  const cvdBullDiv = close.map((c, i) => i > 0 && lt(c, lowest10[i - 1]) && gt(oscCvd[i], nz(oscCvd[i - 1])));
  const cvdBearDiv = close.map((c, i) => i > 0 && gt(c, highest10[i - 1]) && lt(oscCvd[i], nz(oscCvd[i - 1])));
  const fpStatus = chart.map((_, i) => {
    if (!isNum(buyVol[i])) return "NO LTF DATA";
    if (bullSqueeze[i]) return "BULL SQUEEZE";
    if (bearSqueeze[i]) return "BEAR SQUEEZE";
    if (bullAbs[i] && isLimitWall[i]) return "BUY WALL LIMIT";
    if (bearAbs[i] && isLimitWall[i]) return "SELL WALL LIMIT";
    if (bullAbs[i]) return "BULL ABSORPTION";
    if (bearAbs[i]) return "BEAR ABSORPTION";
    if (cvdBullDiv[i]) return "BULLISH CVD DIV";
    if (cvdBearDiv[i]) return "BEARISH CVD DIV";
    if (gt(oscCvd[i], 0)) return "BUY CONTROL";
    if (lt(oscCvd[i], 0)) return "SELL CONTROL";
    return "NEUTRAL";
  });

  // --- Volume veto
  const sma3 = sma(volume, 3);
  const isVolDead = volume.map((v, i) => lt(nz(i > 0 ? sma3[i - 1] : null, v), isNum(volSma[i]) ? volSma[i] * 0.35 : null));
  const vetoActive = isVolDead.map((d) => cfg.use_vol_veto && d);

  // --- Whale zones (5-slot ring) -> in_mitig_bull / in_mitig_bear
  const zones = new Array(5).fill(null);
  let zonePtr = 0;
  const inMitigBull = new Array(n).fill(false), inMitigBear = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const b = chart[i], a = atrVal[i], vs = volSma[i];
    const relVol = isNum(vs) && vs > 0 && isNum(volume[i]) ? volume[i] / vs : 0;
    const isWhale = gt(volume[i], isNum(vs) ? vs * 1.5 : null) && (gt(Math.abs(b.close - b.open), isNum(a) ? a * 0.25 : null) || gt(b.high - b.low, isNum(a) ? a * 0.6 : null));
    if (isWhale) {
      zones[zonePtr] = { top: b.close + a * 0.15, bot: b.close - a * 0.15, support: b.close >= b.open, hp: relVol, active: true, created: i, mitigated: false };
      zonePtr = (zonePtr + 1) % 5;
    }
    for (let z = 0; z < 5; z++) {
      const w = zones[z];
      if (!w) continue;
      if (w.active) {
        if (b.high >= w.bot && b.low <= w.top && i > w.created) w.hp = Math.max(0, w.hp - (isNum(vs) && vs > 0 ? nz(volume[i]) / vs : 1.0));
        if (w.hp <= 0 || (w.support && b.close < w.bot) || (!w.support && b.close > w.top)) {
          w.active = false;
          if (cfg.show_mitigation) w.mitigated = true;
        }
      } else if (w.mitigated) {
        const res = w.support;
        const invalid = (res && b.close > w.top) || (!res && b.close < w.bot);
        if (invalid) w.mitigated = false;
        else {
          if (res && b.high >= w.bot && b.low <= w.top) inMitigBear[i] = true;
          if (!res && b.low <= w.top && b.high >= w.bot) inMitigBull[i] = true;
        }
      }
    }
  }

  // --- Aegis validated order blocks -> in_ob_bull / in_ob_bear
  const P = cfg.ob_pivot_len;
  const volPivot = pivot(volume, P, P, true);
  const rangeHigh = highest(high, P), rangeLow = lowest(low, P);
  const inObBull = new Array(n).fill(false), inObBear = new Array(n).fill(false);
  let dirState = 0;
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const prior = dirState;
    if (i - P >= 0) dirState = gt(high[i - P], rangeHigh[i]) ? 0 : lt(low[i - P], rangeLow[i]) ? 1 : prior;
    if (isNum(volPivot[i])) {
      const j = i - P;
      const refAtr = Math.max(nz(atr14[j], atrVal[i]), mintick);
      const srcAtr = Math.max(nz(atr14[j], atr14[j]), mintick);
      const spanCap = Math.max(srcAtr * cfg.max_wick_atr, mintick);
      const mid = (high[j] + low[j]) / 2;
      const node = { activation: i, start: j, atr: refAtr, top: null, bot: null };
      if (dirState === 0) {
        const top = high[j], bottom = Math.max(mid, high[j] - spanCap);
        node.top = { upper: top, lower: bottom, span: Math.max(top - bottom, mintick), active: true };
      } else if (dirState === 1) {
        const top = Math.min(mid, low[j] + spanCap), bottom = low[j];
        node.bot = { upper: top, lower: bottom, span: Math.max(top - bottom, mintick), active: true };
      }
      nodes.push(node);
      let bulls = nodes.filter((x) => x.bot?.active).length, bears = nodes.filter((x) => x.top?.active).length;
      let k = 0;
      while (k < nodes.length && (bulls > cfg.max_ob_per_direction || bears > cfg.max_ob_per_direction)) {
        const c = nodes[k];
        const pb = c.bot?.active && bulls > cfg.max_ob_per_direction, pr = c.top?.active && bears > cfg.max_ob_per_direction;
        if (pb || pr) { if (c.bot?.active) bulls--; if (c.top?.active) bears--; nodes.splice(k, 1); } else k++;
      }
      while (nodes.length > cfg.max_nodes_ob) nodes.shift();
    }
    for (let k = nodes.length - 1; k >= 0; k--) {
      const node = nodes[k];
      if (i - node.activation > cfg.ob_max_age) { if (node.top) node.top.active = false; if (node.bot) node.bot.active = false; }
      for (const [side, dir] of [["top", -1], ["bot", 1]]) {
        const z = node[side];
        if (!z?.active) continue;
        const u = obProgressiveUpdate(dir, z.upper, z.lower, z.span, node.atr, high[i], low[i], close[i], cfg.mitig_buffer, i > node.activation, cfg.ob_close_only, mintick);
        z.upper = u.top; z.lower = u.bottom;
        if (u.touched && !u.invalid) { if (dir === -1) inObBear[i] = true; else inObBull[i] = true; }
        if (u.invalid) z.active = false;
      }
      if (!node.top?.active && !node.bot?.active) nodes.splice(k, 1);
    }
  }

  // --- GABFX QM / RBS / SBR (tactical trendline pivots 14/14)
  const tlPh = pivot(high, 14, 14, true), tlPl = pivot(low, 14, 14, false);
  const ph1 = [], ph2 = [], pl1 = [], pl2 = [];
  let a1 = null, a2 = null, b1 = null, b2 = null;
  for (let i = 0; i < n; i++) {
    if (isNum(tlPh[i])) { a2 = a1; a1 = tlPh[i]; }
    if (isNum(tlPl[i])) { b2 = b1; b1 = tlPl[i]; }
    ph1.push(a1); ph2.push(a2); pl1.push(b1); pl2.push(b2);
  }
  let qmSell = null, qmBuy = null, rbs = null, sbr = null;
  const gab = [];
  for (let i = 0; i < n; i++) {
    const c = close[i], a = atrVal[i];
    const breakSup = crossunder(close, pl1, i), breakRes = crossover(close, ph1, i);
    if (gt(ph1[i], ph2[i]) && gt(pl1[i], pl2[i]) && breakSup) qmSell = ph2[i];
    if (lt(pl1[i], pl2[i]) && lt(ph1[i], ph2[i]) && breakRes) qmBuy = pl2[i];
    if (breakRes) rbs = ph1[i];
    if (breakSup) sbr = pl1[i];
    if (isNum(qmBuy) && c < qmBuy) qmBuy = null;
    if (isNum(qmSell) && c > qmSell) qmSell = null;
    if (isNum(rbs) && c < rbs) rbs = null;
    if (isNum(sbr) && c > sbr) sbr = null;
    const near = (lvl) => isNum(lvl) && le(Math.abs(c - lvl), a);
    gab.push({ inQmBuy: near(qmBuy), inQmSell: near(qmSell), inRbs: near(rbs), inSbr: near(sbr) });
  }

  // --- JMA kinetics
  const lmas = jurik(35, 2, 2, close), lmal = jurik(75, 2, 2, close);
  const ppo = lmas.map((s, i) => (isNum(s) && isNum(lmal[i]) ? (lmal[i] !== 0 ? ((s - lmal[i]) / lmal[i]) * 100 : 0) : null));
  const pctRank = percentrank(ppo, 200);
  const jmaVel = ema(change(pctRank), 3);
  const theta150 = close.map((_, i) => {
    const l0 = linregAt(close, i, 150, 0), l1 = linregAt(close, i, 150, 1);
    return isNum(l0) && isNum(l1) && isNum(atrVal[i]) ? Math.atan(((l0 - l1) / atrVal[i]) * 10.0) * (180.0 / Math.PI) : null;
  });
  const sThetaTemp = ema(theta150, 3);

  // --- Session flags, fakeouts (need VAH/VAL per bar for the 3-bar memory)
  const lookbackFake = 8;
  const fakeBot = new Array(n).fill(false), fakeTop = new Array(n).fill(false);
  for (let i = Math.max(0, t - lookbackFake); i <= t; i++) {
    const p = tdm(i);
    fakeBot[i] = lt(low[i], p.val) && gt(close[i], p.val);
    fakeTop[i] = gt(high[i], p.vah) && lt(close[i], p.vah);
  }
  const fakeBotSince = barssince(fakeBot), fakeTopSince = barssince(fakeTop);

  // ===== Evaluate the last (confirmed) bar =====
  const i = t;
  const c = close[i], a = atrVal[i];
  const prof = tdm(i);
  const { vah, val, poc, lvn_bull_1: lvnBull1, lvn_bear_1: lvnBear1 } = prof;
  const barCloseMs = Date.parse(chart[i].close_time);

  // htf_state with MTF Hurst (realtime-at-close)
  const tf = bundle.timeframes;
  const hurstOf = (closes) => (closes.length ? hurstRsLast(closes, 50) : null);
  const MIN = 60 * 1000;
  // request.security on a timeframe equal to the chart is the chart series; above the
  // chart it is realtime-at-close; below the chart (15 on H1) the last closed bar.
  const mtfCloses = (key, minutes) => minutes === chartMinutes ? close
    : minutes > chartMinutes ? htfCloseSeriesAt(tf[key]?.candles || [], chart, barCloseMs, minutes * MIN)
      : (tf[key]?.candles || []).filter((b) => Date.parse(b.close_time) <= barCloseMs).map((b) => b.close);
  const h15 = hurstOf(mtfCloses("M15", 15));
  const h60 = hurstOf(mtfCloses("H1", 60));
  const h240 = hurstOf(mtfCloses("H4", 240));
  const hD = hurstOf(mtfCloses("D1", 1440));
  const hW = hurstOf(mtfCloses("W1", 10080));
  const globalH = nz(h15) * 0.10 + nz(h60) * 0.15 + nz(h240) * 0.25 + nz(hD) * 0.30 + nz(hW) * 0.20;
  const zLocal = isNum(maKww[i]) ? (c - maKww[i]) / Math.max(sigmaKww[i], 0.0001) : null;
  const htfState = ge(e[i], 0.80) ? 0 : (gt(zLocal, 0) && globalH > 0.5 && gt(adjMean[i], 0)) ? 1 : -1;

  const subtype = st[i].subtype, dEnc = st[i].d_enc;
  const mtfState = (subtype === 2 || subtype === 3) ? 1 : (subtype === 1 || subtype === 4) ? -1 : 0;
  const fs = fpStatus[i];
  const ltfState = (fs === "BUY WALL LIMIT" || fs === "BULLISH CVD DIV") ? 2 : (fs === "SELL WALL LIMIT" || fs === "BEARISH CVD DIV") ? -2
    : (gt(oscCvd[i], 0) && gt(sOmega[i], 0)) ? 1 : (lt(oscCvd[i], 0) && lt(sOmega[i], 0)) ? -1 : 0;
  const extState = (lt(sOmega[i], -0.5) && lt(sAlpha[i], 0)) ? 1 : gt(proFast[i], 0.45) ? 2 : 0;
  const kinRevLong = isNum(estRevBars[i]) && estRevBars[i] <= 5 && lt(c, val) && gt(sOmega[i], 0);
  const kinRevShort = isNum(estRevBars[i]) && estRevBars[i] <= 5 && gt(c, vah) && lt(sOmega[i], 0);

  let verdict = 0;
  if (kinRevLong) verdict = 3;
  else if (kinRevShort) verdict = -3;
  else if (extState === 1 && htfState === 1) verdict = -1;
  else if (extState === 2 && htfState === 1) verdict = 4;
  else if (htfState === 1 && (mtfState === 1 || ltfState >= 1)) verdict = 3;
  else if (htfState === -1 && (mtfState === -1 || ltfState <= -1)) verdict = -3;

  // Entropy trap
  const sDeDt = ema(change(e), 3);
  const smaAtr = sma(atrVal, 50);
  const isEntropyTrap = lt(a, smaAtr[i]) && gt(sDeDt[i], 0.02);

  const g = gab[i];
  const anyZone = g.inQmBuy || g.inRbs || g.inQmSell || g.inSbr || inMitigBull[i] || inMitigBear[i] || inObBull[i] || inObBear[i];
  const paBuy = (g.inQmBuy || g.inRbs || inMitigBull[i] || inObBull[i]) && (bullSqueeze[i] || bullAbs[i]);
  const paSell = (g.inQmSell || g.inSbr || inMitigBear[i] || inObBear[i]) && (bearSqueeze[i] || bearAbs[i]);

  const barOpenMs = chart[i].time * 1000;
  const isNy = inSession(barOpenMs, 8 * 60, 17 * 60);
  const isLon = inSession(barOpenMs, 3 * 60, 12 * 60);
  const imbBull = gt(c, vah), imbBear = lt(c, val);
  const isBalance = le(c, vah) && ge(c, val);
  const m1Bull = fs === "BULL SQUEEZE" || fs === "BUY WALL LIMIT" || bullAbs[i];
  const m1Bear = fs === "BEAR SQUEEZE" || fs === "SELL WALL LIMIT" || bearAbs[i];
  const m2Bull = fs === "BULL SQUEEZE" || bullAbs[i];
  const m2Bear = fs === "BEAR SQUEEZE" || bearAbs[i];
  const fab = fabioDecision({ close: c, atr: a, isNy, isLondon: isLon || isBalance, imbBull, imbBear, lvnBull: lvnBull1, lvnBear: lvnBear1, m1Bull, m1Bear, fakeoutBotSince: fakeBotSince[i], fakeoutTopSince: fakeTopSince[i], m2Bull, m2Bear });

  // JMA alerts at the last bar
  const tg = Math.max(0.5, Math.min(1.5, 1.0 + nz(sThetaTemp[i], 0) / 100.0));
  const ig = Math.max(0.5, 2.0 - tg);
  const pr = pctRank[i], vel = jmaVel[i];
  let jmaEst = null;
  if (ge(pr, 90) || le(pr, 10)) jmaEst = null;
  else if (gt(vel, 0.1)) jmaEst = (90.0 - pr) / Math.max(vel * tg, 0.01);
  else if (lt(vel, -0.1)) jmaEst = (pr - 10.0) / Math.max(Math.abs(vel) * ig, 0.01);
  const jmaLong = le(pr, 10) || (lt(vel, -0.1) && le(jmaEst, 3));
  const jmaShort = ge(pr, 90) || (gt(vel, 0.1) && le(jmaEst, 3));

  let branch = "initial";
  if (isEntropyTrap) { verdict = 0; branch = "entropy_trap"; }
  else if (anyZone && vetoActive[i]) { verdict = 0; branch = "volume_veto"; }
  else if (paBuy) { verdict = 3; branch = "gabfx_buy"; }
  else if (paSell) { verdict = -3; branch = "gabfx_sell"; }
  else if (fab.m1Buy) { verdict = 3; branch = "fabio_m1_buy"; }
  else if (fab.m1Sell) { verdict = -3; branch = "fabio_m1_sell"; }
  else if (fab.m2Buy) { verdict = 3; branch = "fabio_m2_buy"; }
  else if (fab.m2Sell) { verdict = -3; branch = "fabio_m2_sell"; }
  else if (jmaLong && isBalance) { verdict = 3; branch = "jma_long"; }
  else if (jmaShort && isBalance) { verdict = -3; branch = "jma_short"; }
  else if (kinRevLong) { verdict = 3; branch = "kin_rev_long"; }
  else if (kinRevShort) { verdict = -3; branch = "kin_rev_short"; }

  // R10 shared Prophet x GMI x VP gate (barstate.isconfirmed = true)
  const vpDir = gt(c, vah) ? 1 : lt(c, val) ? -1 : 0;
  const profileValid = isNum(poc) && isNum(vah) && isNum(val) && vah >= poc && poc >= val;
  const divDir = (subtype === 2 || subtype === 3 || dEnc === 1) ? 1 : (subtype === 1 || subtype === 4 || dEnc === -1) ? -1 : 0;
  const pDir = gt(proFast[i], 0) ? 1 : lt(proFast[i], 0) ? -1 : 0;
  const internalConflict = pDir !== 0 && divDir !== 0 && pDir !== divDir;
  const prophetDir = internalConflict ? 0 : pDir !== 0 ? pDir : divDir;
  const gmiDirectional = verdict === 3 || verdict === -3;
  const gmiDir = verdict === 3 ? 1 : verdict === -3 ? -1 : 0;
  const gmiProphetConflict = gmiDirectional && prophetDir !== 0 && gmiDir !== prophetDir;
  const profileProphetConflict = vpDir !== 0 && prophetDir !== 0 && vpDir !== prophetDir;
  const riskHold = subtype === 1;
  const active = cfg.shared_prophet_alignment;
  const evaluable = active && profileValid;
  const conflict = evaluable && (internalConflict || gmiProphetConflict || profileProphetConflict || riskHold);
  const aligned = evaluable && !conflict && gmiDirectional && prophetDir !== 0 && gmiDir === prophetDir && vpDir === prophetDir;
  const gate = !active ? 0 : !profileValid ? -2 : conflict ? -1 : aligned ? 2 : 1;
  if (conflict) verdict = 0;

  return {
    candle: { o: chart[i].open, h: chart[i].high, l: chart[i].low, c, volume: nz(volume[i], 0) },
    open_time: chart[i].open_time,
    comparable: { verdict, gate, gmi_dir: gmiDir, prophet_dir: prophetDir, conflict },
    diagnostics: {
      branch, htf_state: htfState, mtf_state: mtfState, ltf_state: ltfState, ext_state: extState,
      fp_status: fs, entropy: e[i], is_chaos: isChaos[i], global_h: globalH, vah, val, poc,
      s_theta: sTheta[i], s_omega: sOmega[i], s_alpha: sAlpha[i], pct_rank: pr, intrabars: intra[i].length,
      zones: { ...g, in_mitig_bull: inMitigBull[i], in_mitig_bear: inMitigBear[i], in_ob_bull: inObBull[i], in_ob_bear: inObBear[i], veto: vetoActive[i] }
    }
  };
}

/** The 1-hour chart (the H1 decision lane): computeGmiOnChart with chart "H1". */
export function computeGmi(bundle, { mintick = 0.001, window = 1000, options = {} } = {}) {
  return computeGmiOnChart(bundle, { chart: "H1", mintick, window, options });
}
