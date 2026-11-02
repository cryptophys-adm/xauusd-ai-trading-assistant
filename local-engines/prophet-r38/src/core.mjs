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
function pivotHighAt(src, end, left, right) {
  const pivot = end - right;
  if (pivot < left || end >= src.length) return null;
  const v = src[pivot];
  if (!finite(v)) return null;
  for (let j = pivot - left; j <= pivot + right; j++) {
    if (j === pivot || !finite(src[j])) continue;
    if (src[j] >= v) return null;
  }
  return { value: v, pivotIndex: pivot };
}
function pivotLowAt(src, end, left, right) {
  const pivot = end - right;
  if (pivot < left || end >= src.length) return null;
  const v = src[pivot];
  if (!finite(v)) return null;
  for (let j = pivot - left; j <= pivot + right; j++) {
    if (j === pivot || !finite(src[j])) continue;
    if (src[j] <= v) return null;
  }
  return { value: v, pivotIndex: pivot };
}
const HTF_WEIGHTS = Object.freeze({ M15: 0.10, H1: 0.15, H4: 0.25, D1: 0.30, W1: 0.20 });
const HTF_MINUTES = Object.freeze({ M15: 15, H1: 60, H4: 240, D1: 1440, W1: 10080 });
function htfCloseTime(bar, timeframe) {
  if (bar.close_time && finite(Date.parse(bar.close_time))) return Date.parse(bar.close_time);
  return Date.parse(bar.open_time) + HTF_MINUTES[timeframe] * 60_000;
}
function buildHtfAlignment(chartBars, chartZ, higherTimeframes = {}, options = {}) {
  const names = Object.keys(HTF_WEIGHTS);
  const closedOnly = options.gmi_closed_only !== false;
  const series = {};
  for (const tf of names) {
    const htfBars = Array.isArray(higherTimeframes[tf]) ? higherTimeframes[tf] : [];
    const closes = htfBars.map(b => b.close);
    series[tf] = { bars: htfBars, z: closes.map((_, i) => i < 50 ? null : kwwAt(closes, i, 50).z) };
  }
  return chartBars.map((chartBar, i) => {
    const chartTime = Date.parse(chartBar.open_time);
    const zByTf = {}, missingTimeframes = [];
    for (const tf of names) {
      const { bars, z } = series[tf];
      let selected = -1;
      const containing = bars.findIndex(b => {
        const start = Date.parse(b.open_time), end = htfCloseTime(b, tf);
        return finite(start) && finite(end) && start <= chartTime && chartTime < end;
      });
      if (containing >= 0) selected = closedOnly ? containing - 1 : containing;
      else {
        for (let j = 0; j < bars.length; j++) if (htfCloseTime(bars[j], tf) <= chartTime) selected = j;
      }
      const value = selected >= 0 ? z[selected] : null;
      zByTf[tf] = finite(value) ? value : null;
      if (!finite(value)) missingTimeframes.push(tf);
    }
    const globalZ = names.reduce((sum, tf) => sum + (finite(zByTf[tf]) ? zByTf[tf] : 0) * HTF_WEIGHTS[tf], 0);
    const z = chartZ[i];
    const alignmentCode = !finite(z) ? 0 : z > 0 && globalZ > 0 ? 1 : z < 0 && globalZ < 0 ? -1 : z === 0 || globalZ === 0 ? 0 : 2;
    return {
      mode: closedOnly ? "previous_closed_htf_bar" : "forming_htf_bar_repaint_risk",
      z_by_timeframe: zByTf,
      weighted_global_z: globalZ,
      alignment_code: alignmentCode,
      alignment_text: alignmentCode === 1 ? "ALIGNED BULLISH" : alignmentCode === -1 ? "ALIGNED BEARISH" : alignmentCode === 2 ? "DIRECTION CONFLICT" : "NEUTRAL / N/A",
      missing_timeframes: missingTimeframes,
      data_status: missingTimeframes.length ? "blocked_missing_or_warmup_htf_history" : "history_ready_for_shadow",
      trusted_evidence_allowed: false
    };
  });
}
function structureStateMachine(bars, oscillator, volumeRatio, hasVolume, atr, options = {}) {
  const legacy = options.legacy_mode === true;
  const stateMaxAge = options.state_max_age ?? 50;
  const pivotLeft = options.pivot_left ?? 5, pivotRight = options.pivot_right ?? 2;
  const bodyFloorAtr = options.body_floor_atr ?? 0.10, wickBodyRatio = options.wick_body_ratio ?? 1.5;
  let lastPhValue = null, lastPricePh = null, lastPhIndex = null;
  let lastPlValue = null, lastPricePl = null, lastPlIndex = null;
  let dState = 0, bState = 0, stateBar = null, bullEventBar = null, bearEventBar = null, subtype = 0;
  const output = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i], osc = oscillator[i], prevOsc = i > 0 ? oscillator[i - 1] : null;
    const crossUp = finite(osc) && finite(prevOsc) && osc > 0 && prevOsc <= 0;
    const crossDown = finite(osc) && finite(prevOsc) && osc < 0 && prevOsc >= 0;
    let bearDiv = false, bullDiv = false, bearDivOriginBar = null, bearDivOriginValue = null, bullDivOriginBar = null, bullDivOriginValue = null;
    const ph = pivotHighAt(oscillator, i, pivotLeft, pivotRight);
    const pl = pivotLowAt(oscillator, i, pivotLeft, pivotRight);
    if ((crossUp || crossDown) && (Math.abs(dState) < 3 || !legacy)) {
      dState = 0; bState = 1;
      if (!legacy) { subtype = 0; stateBar = null; bullEventBar = null; bearEventBar = null; }
    }
    if (ph) {
      const pivotHigh = bars[ph.pivotIndex].high;
      if (lastPricePh !== null && pivotHigh > lastPricePh && lastPhValue !== null && ph.value < lastPhValue && ph.value > 0) {
        dState = -1; bState = 2; bearEventBar = i; bearDiv = true;
        bearDivOriginBar = lastPhIndex; bearDivOriginValue = lastPhValue;
        if (!legacy) bullEventBar = null;
      }
      lastPhValue = ph.value; lastPricePh = pivotHigh; lastPhIndex = ph.pivotIndex;
    }
    if (pl) {
      const pivotLow = bars[pl.pivotIndex].low;
      if (lastPricePl !== null && pivotLow < lastPricePl && lastPlValue !== null && pl.value > lastPlValue && pl.value < 0) {
        dState = 1; bState = 2; bullEventBar = i; bullDiv = true;
        bullDivOriginBar = lastPlIndex; bullDivOriginValue = lastPlValue;
        if (!legacy) bearEventBar = null;
      }
      lastPlValue = pl.value; lastPricePl = pivotLow; lastPlIndex = pl.pivotIndex;
    }
    const body = Math.abs(bar.close - bar.open);
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;
    const upperWick = bar.high - Math.max(bar.open, bar.close);
    const effectiveBody = legacy ? body : Math.max(body, (finite(atr[i]) ? atr[i] : 0) * bodyFloorAtr);
    const bottomRejection = lowerWick > effectiveBody * wickBodyRatio;
    const topRejection = upperWick > effectiveBody * wickBodyRatio;
    const realVolume = legacy ? volumeRatio[i] > 1 : (hasVolume && volumeRatio[i] > 1);
    if (dState === -1) {
      if (lastPricePh !== null && bar.close > lastPricePh) {
        if (topRejection || (legacy ? !realVolume : (hasVolume && !realVolume))) {
          dState = 3; bState = -4; subtype = 1; bearEventBar = i;
          if (!legacy) bullEventBar = null;
        } else {
          dState = -3; bState = 3; subtype = 2; bullEventBar = i;
          if (!legacy) bearEventBar = null;
        }
        stateBar = i;
      } else if (i > 0 && bar.close < bars[i - 1].low && bar.close < bar.open) {
        bState = -3; bearEventBar = i;
        if (!legacy) bullEventBar = null;
      }
    }
    if (dState === 1) {
      if (lastPricePl !== null && bar.close < lastPricePl) {
        if (bottomRejection || (legacy ? !realVolume : (hasVolume && !realVolume))) {
          dState = -3; bState = 3; subtype = 3; bullEventBar = i;
          if (!legacy) bearEventBar = null;
        } else {
          dState = 3; bState = -4; subtype = 4; bearEventBar = i;
          if (!legacy) bullEventBar = null;
        }
        stateBar = i;
      } else if (i > 0 && bar.close > bars[i - 1].high && bar.close > bar.open) {
        bState = 3; bullEventBar = i;
        if (!legacy) bearEventBar = null;
      }
    }
    if (!legacy && (dState === 3 || dState === -3) && stateBar !== null && i - stateBar > stateMaxAge) {
      dState = 0; bState = 1; subtype = 0; stateBar = null; bullEventBar = null; bearEventBar = null;
    }
    output.push({
      d_enc: dState, b_enc: bState, structure_state_bar: stateBar,
      bull_structure_event_bar: bullEventBar, bear_structure_event_bar: bearEventBar,
      subtype_code: subtype, oscillator_pivot_high: ph?.value ?? null, oscillator_pivot_low: pl?.value ?? null,
      bear_divergence_event: bearDiv, bull_divergence_event: bullDiv,
      bear_divergence_origin_bar: bearDivOriginBar, bear_divergence_origin_value: bearDivOriginValue,
      bull_divergence_origin_bar: bullDivOriginBar, bull_divergence_origin_value: bullDivOriginValue,
      last_price_pivot_high: lastPricePh, last_price_pivot_low: lastPricePl
    });
  }
  return output;
}
function confirmationGate(bars, fast, slow, zScore, volumeRatio, hasVolume, structure, intensity, options = {}) {
  const legacy = options.legacy_mode === true;
  const autoWindow = options.auto_window !== false;
  const timeframeMinutes = options.timeframe_minutes ?? 5;
  const confirmationWindow = options.confirmation_window ?? (autoWindow ? (timeframeMinutes <= 1 ? 5 : timeframeMinutes <= 5 ? 4 : 3) : 3);
  const freshBars = options.struct_fresh_bars ?? 6;
  let lastBuyIndex = null, lastSellIndex = null, buyMinZ = null, sellMaxZ = null;
  let buyPassBar = null, sellPassBar = null, buyHqBar = null, sellHqBar = null;
  return bars.map((bar, i) => {
    const confirmedBar = bar.confirmed === true;
    const buyCandidate = confirmedBar && crossover(fast, slow, i) && fast[i] < -0.15;
    const sellCandidate = confirmedBar && crossunder(fast, slow, i) && fast[i] > 0.15;
    if (buyCandidate) {
      lastBuyIndex = i; buyPassBar = null; buyHqBar = null;
      if (!legacy) { lastSellIndex = lastSellIndex; sellPassBar = null; sellHqBar = null; }
      buyMinZ = zScore[i];
      if (!legacy) sellMaxZ = null;
    }
    if (sellCandidate) {
      lastSellIndex = i; sellPassBar = null; sellHqBar = null;
      if (!legacy) { buyPassBar = null; buyHqBar = null; buyMinZ = null; }
      sellMaxZ = zScore[i];
    }
    const barsSinceBuy = lastBuyIndex === null ? null : i - lastBuyIndex;
    const barsSinceSell = lastSellIndex === null ? null : i - lastSellIndex;
    const hasBuy = barsSinceBuy !== null, hasSell = barsSinceSell !== null;
    const sellSupersedesBuy = hasSell && (!hasBuy || barsSinceSell < barsSinceBuy);
    const buySupersedesSell = hasBuy && (!hasSell || barsSinceBuy < barsSinceSell);
    const buyWindow = hasBuy && barsSinceBuy >= 0 && barsSinceBuy <= confirmationWindow && (legacy || !sellSupersedesBuy);
    const sellWindow = hasSell && barsSinceSell >= 0 && barsSinceSell <= confirmationWindow && (legacy || !buySupersedesSell);
    const st = structure[i];
    const bullFresh = st.bull_structure_event_bar !== null && i - st.bull_structure_event_bar <= freshBars;
    const bearFresh = st.bear_structure_event_bar !== null && i - st.bear_structure_event_bar <= freshBars;
    const freshBullDiv = st.d_enc === 1 && bullFresh;
    const freshBearDiv = st.d_enc === -1 && bearFresh;
    const freshBullSweep = st.d_enc === -3 && st.subtype_code === 3 && bullFresh;
    const freshBearSweep = st.d_enc === 3 && st.subtype_code === 1 && bearFresh;
    const bullishStructure = legacy
      ? ((st.b_enc === 3 || st.d_enc === 1 || (st.d_enc === -3 && st.subtype_code === 3)) && st.d_enc !== 3)
      : (bullFresh && (st.d_enc === 1 || (st.b_enc === 3 && st.d_enc !== 0) || (st.d_enc === -3 && (st.subtype_code === 3 || st.subtype_code === 2))));
    const bearishStructure = legacy
      ? ((st.b_enc === -3 || st.d_enc === -1 || (st.d_enc === 3 && st.subtype_code === 4)) && st.d_enc !== -3)
      : (bearFresh && (st.d_enc === -1 || (st.b_enc === -3 && st.d_enc !== 0) || (st.d_enc === 3 && (st.subtype_code === 1 || st.subtype_code === 4))));
    const prev = i > 0 ? bars[i - 1] : null;
    const bullPrice = !!prev && bar.close > bar.open && bar.close > prev.high;
    const bearPrice = !!prev && bar.close < bar.open && bar.close < prev.low;
    const bullEarlyPrice = !!prev && bar.close > bar.open && bar.close > prev.close;
    const bearEarlyPrice = !!prev && bar.close < bar.open && bar.close < prev.close;
    const isVolumeValid = legacy ? volumeRatio[i] >= 0.85 : (hasVolume && volumeRatio[i] >= 0.85);
    const buyQualityPoints = (intensity[i] === 3 ? 1 : 0) + (zScore[i] > 0 ? 1 : 0) + (isVolumeValid ? 1 : 0);
    const sellQualityPoints = (intensity[i] === -3 ? 1 : 0) + (zScore[i] < 0 ? 1 : 0) + (isVolumeValid ? 1 : 0);
    const buyVolumePass = legacy ? buyQualityPoints >= 2 : (!hasVolume || volumeRatio[i] >= 0.85);
    const sellVolumePass = legacy ? sellQualityPoints >= 2 : (!hasVolume || volumeRatio[i] >= 0.85);
    if (buyWindow) buyMinZ = buyMinZ === null || !finite(buyMinZ) ? zScore[i] : Math.min(buyMinZ, zScore[i]);
    if (sellWindow) sellMaxZ = sellMaxZ === null || !finite(sellMaxZ) ? zScore[i] : Math.max(sellMaxZ, zScore[i]);
    const buyDepthPass = finite(buyMinZ) && buyMinZ <= -0.618;
    const sellDepthPass = finite(sellMaxZ) && sellMaxZ >= 0.618;
    const buyBase = confirmedBar && buyWindow && bullPrice && bullishStructure;
    const sellBase = confirmedBar && sellWindow && bearPrice && bearishStructure;
    const buyConfirmedRaw = buyBase && buyVolumePass;
    const sellConfirmedRaw = sellBase && sellVolumePass;
    const buyEarly = confirmedBar && buyWindow && bullEarlyPrice && bullishStructure && buyVolumePass && !buyConfirmedRaw;
    const sellEarly = confirmedBar && sellWindow && bearEarlyPrice && bearishStructure && sellVolumePass && !sellConfirmedRaw;
    const buyHighQualityRaw = legacy ? (buyBase && buyQualityPoints === 3) : (buyConfirmedRaw && hasVolume && volumeRatio[i] >= 1.0 && buyDepthPass);
    const sellHighQualityRaw = legacy ? (sellBase && sellQualityPoints === 3) : (sellConfirmedRaw && hasVolume && volumeRatio[i] >= 1.0 && sellDepthPass);
    if (buyConfirmedRaw && buyPassBar === null) buyPassBar = i;
    if (sellConfirmedRaw && sellPassBar === null) sellPassBar = i;
    if (buyConfirmedRaw && buyHighQualityRaw && buyHqBar === null) buyHqBar = i;
    if (sellConfirmedRaw && sellHighQualityRaw && sellHqBar === null) sellHqBar = i;
    return {
      confirmation_window: confirmationWindow,
      buy_candidate: buyCandidate, sell_candidate: sellCandidate,
      buy_window_active: buyWindow, sell_window_active: sellWindow,
      bullish_price_confirm: bullPrice, bearish_price_confirm: bearPrice,
      bullish_structure_confirm: bullishStructure, bearish_structure_confirm: bearishStructure,
      buy_volume_pass: buyVolumePass, sell_volume_pass: sellVolumePass,
      buy_depth_pass: buyDepthPass, sell_depth_pass: sellDepthPass,
      buy_early_confirmation: buyEarly, sell_early_confirmation: sellEarly,
      buy_confirmed: buyPassBar === i, sell_confirmed: sellPassBar === i,
      buy_high_quality: buyHqBar === i, sell_high_quality: sellHqBar === i,
      buy_passed_current_setup: buyPassBar !== null && lastBuyIndex !== null && buyPassBar >= lastBuyIndex,
      sell_passed_current_setup: sellPassBar !== null && lastSellIndex !== null && sellPassBar >= lastSellIndex,
      buy_min_z_in_window: buyMinZ, sell_max_z_in_window: sellMaxZ,
      gate_status: buyWindow ? (buyPassBar !== null && lastBuyIndex !== null && buyPassBar >= lastBuyIndex ? "BUY_CONFIRMED" : !bullPrice ? "BUY_WAIT_PRICE" : !bullishStructure ? "BUY_WAIT_STRUCTURE" : !buyVolumePass ? "BUY_WAIT_VOLUME" : "BUY_WAIT") : sellWindow ? (sellPassBar !== null && lastSellIndex !== null && sellPassBar >= lastSellIndex ? "SELL_CONFIRMED" : !bearPrice ? "SELL_WAIT_PRICE" : !bearishStructure ? "SELL_WAIT_STRUCTURE" : !sellVolumePass ? "SELL_WAIT_VOLUME" : "SELL_WAIT") : "NO_ACTIVE_SETUP"
    };
  });
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
  const structure = structureStateMachine(bars, fast, volRatio, hasVolume, atr, options);
  const cycles = bars.map((_, i) => {
    const cf = cycleAt(close, high, low, i, fastLen), cm = cycleAt(close, high, low, i, midLen), cs = cycleAt(close, high, low, i, slowLen);
    return cf !== null && cm !== null && cs !== null && cf > 0 && cm > 0 && cs > 0 ? 3 : cf !== null && cm !== null && cs !== null && cf < 0 && cm < 0 && cs < 0 ? -3 : 0;
  });
  const confirmation = confirmationGate(bars, fast, slow, zScore, volRatio, hasVolume, structure, cycles, options);
  const htfAlignment = buildHtfAlignment(bars, zScore, options.higher_timeframes, options);
  for (let i = 0; i < bars.length; i++) {
    const f = fast[i], s = slow[i];
    const buyCandidate = bars[i].confirmed === true && crossover(fast, slow, i) && f < -0.15;
    const sellCandidate = bars[i].confirmed === true && crossunder(fast, slow, i) && f > 0.15;
    const cycle = [cycleAt(close, high, low, i, fastLen), cycleAt(close, high, low, i, midLen), cycleAt(close, high, low, i, slowLen)];
    const intensity = cycle.every((x) => x !== null && x > 0) ? 3 : cycle.every((x) => x !== null && x < 0) ? -3 : 0;
    const d = { ...bars[i], index: i, structure: structure[i], confirmation: confirmation[i], htf_alignment: htfAlignment[i], oscillator: { fast: f, slow: s, core: core[i], raw_composite: raw[i] }, sensors: { kww_zscore_50: zScore[i], hurst_rs_100: hurst[i], efficiency_ratio_14: er[i], volume_anomaly_20: volAnom[i], volume_ratio_20: volRatio[i], atr14: atr[i], cycle_intensity: intensity }, events: { raw_buy_cross_candidate: buyCandidate, raw_sell_cross_candidate: sellCandidate }, calculation_scope: "R38_SOURCE_DERIVED_OSCILLATOR_STRUCTURE_CONFIRMATION_HTF_PARTIAL", parity_status: "not_proven", trusted_evidence_allowed: false };
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
    implementation_scope: "oscillator sensors, divergence/structure state machine, adaptive confirmation gate, and closed-bar HTF alignment diagnostic; excludes OB ranking/lifecycle, entry/TP/SL management, and chart-rendering behavior",
    history_requirements: { M5: 101, chart_oscillator_slow_warmup: Math.max(slowLen, Math.round(smoothLen * 2.2) * 2) + Math.round(Math.sqrt(Math.round(smoothLen * 2.2) * 2)), kww_zscore_50: 50, efficiency_ratio_14: 15, volume_ratio_20: 21 },
    has_volume: hasVolume,
    outputs: result
  };
}
