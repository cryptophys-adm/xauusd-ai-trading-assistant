// B11a (Track B; RFC_INDICATOR_ADOPTION stages 1, 2 and 6; owner 2026-11-19 "adopsi semuanya", 2026-11-22 (a)-(c)):
// the Prophet R38 adoption record's comparable values, the fields of the v2 alert (source prophet_r38_adopt_hud,
// pinescript/candidates/The-Prophet-v7.02-R38.hud.v2.txt lines 1172-1324), for one closed bar of 15m, 1H, 4H or 1D.
//
// An adapter outside the hashed Prophet core: local-engines/prophet-r38/src/core.mjs is part of every parity identity
// and is not edited. It runs no core of its own: it reads the chart's core run that the publishers' setup state already
// made this tick (prophet-setup.mjs chartProphetCore: the producers' input, the last 1000 bars, confirmed, the native
// higher timeframes; about 2 s in node, so it is never run twice for one bar). What the core keeps internal is rebuilt here from its
// per-bar outputs, as Pine computes it:
//   - the latched entry references (Pine 407-420) and the setup activity (424-425), bar by bar;
//   - the TARGET KEY latch (Pine 826-834, 1040-1060). It needs the active OB zones at every bar, which the core only
//     returns at the last bar, so the zone lifecycle (creation, mitigation, age and count limits) is duplicated from
//     core.mjs orderBlockEngine in obZoneSeries below. A test holds the duplicate to the core: its zones at the last
//     bar equal the core's active_order_block_zones;
//   - the momentum codes, the counter-trend watch, the oscillator projection and the exit reason code.
// The manual position inputs are at their defaults (Pine 43-44: "NO POSITION", entry 0), so pos, entry_ok, tp_struct,
// tp_reached, reversal and mom_weak are constants and exit_code takes the no-position branch (11-18, or 0).
// Numbers are rounded as the alert prints them ("#.########"); na is null (the alert prints NaN; the group's
// nullEqual reads both as missing). Nothing here reads a record: it only builds one (B11a: no reader).
import { prophetR38TEnc } from "../h1-producer.mjs";
import { SETUP_CHARTS, chartProphetCore, hasChartProphetCore } from "../prophet-setup.mjs";
import { ENGINE_PROVENANCE } from "../provenance.generated.mjs";

export const PROPHET_ADOPT_VERSION = "cryptophys.adopt.prophet.v1";
export const PROPHET_ADOPT_SOURCE = "prophet_r38_adopt_hud";
/** The v2 alert's charts (15/60/240/1D) and Pine's timeframe.period for each. */
export const PROPHET_ADOPT_CHARTS = Object.freeze(["M15", "H1", "H4", "D1"]);
/** Pine inputs at their defaults (The-Prophet-v7.02-R38.hud.v2.txt): struct_fresh_bars, the projection, tm_rr_basis. */
export const PROPHET_ADOPT_RULES = Object.freeze({ struct_fresh_bars: 6, projection_lookback: 5, projection_horizon: 4, rr_basis: "EDGE" });
/** Every field of the alert's five groups, in payload order (src/parity-registry.mjs prophet_adopt_*). */
export const PROPHET_ADOPT_FIELDS = Object.freeze([
  "cshi", "cshi_tier", "er", "vol_anom",
  "early_buy", "early_sell", "bull_div", "bear_div", "bull_div_age", "bull_div_osc", "bear_div_age", "bear_div_osc", "pro_fast", "pro_slow", "pro_core",
  "buy_ob_score", "sell_ob_score", "buy_ob_hv", "sell_ob_hv", "bull_tp_score", "bear_tp_score", "ob_bull_n", "ob_bear_n", "ob_filter",
  "buy_stop", "sell_stop", "buy_risk", "sell_risk", "buy_reward", "sell_reward", "buy_rr", "sell_rr", "buy_ready", "sell_ready",
  "mom", "mom_delta", "mom_ctx", "cross_up", "cross_dn", "ct_bull", "ct_bear", "proj_main", "proj_alt", "proj_slope",
  "buy_entry_ref", "sell_entry_ref", "buy_entry", "sell_entry", "pos", "entry_ok", "tp_struct", "tp_reached", "reversal", "mom_weak",
  "exit_code", "exit_key", "tk_latched", "tk_dir", "tk_reached", "tk_just_hit", "tk_last_hit", "tk_hit"
]);

const TICKERID = "OANDA:XAUUSD";
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const num = (x) => (finite(x) ? Math.round(x * 1e8) / 1e8 : null);
const int = (x) => (finite(x) ? Math.trunc(x) : null);
const flag = (b) => (b ? 1 : 0);
const bars = (frame) => (Array.isArray(frame?.candles) ? frame.candles : []);

// ---------------------------------------------------------------- the OB zone lifecycle (duplicate of core.mjs)

function smaAt(src, end, len) {
  if (end + 1 < len) return null;
  const w = src.slice(end - len + 1, end + 1);
  if (w.some((x) => !Number.isFinite(x))) return null;
  return w.reduce((a, b) => a + b, 0) / len;
}
function pivotHighAt(src, end, left, right) {
  const pivot = end - right;
  if (pivot < left || end >= src.length) return null;
  const v = src[pivot];
  if (!Number.isFinite(v)) return null;
  for (let j = pivot - left; j <= pivot + right; j++) {
    if (j === pivot || !Number.isFinite(src[j])) continue;
    if (src[j] >= v) return null;
  }
  return { value: v, pivotIndex: pivot };
}

/**
 * Pure: the core's active OB zones after each bar's update, as orderBlockEngine (core.mjs) builds them with its default
 * options: [{ dir, top, bottom, born, highVolume }] per bar. `atr` and `er` are the core's own per-bar sensors.
 */
export function obZoneSeries(series, { atr, er, mintick = 0.01, options = {} } = {}) {
  const pivotLen = options.ob_length ?? 5, maxActive = options.ob_max_active ?? 30, maxAge = options.ob_max_age ?? 120;
  const maxZoneAtr = options.ob_zone_max_atr ?? 3.0, mitigationBufferAtr = options.ob_mitigation_buffer_atr ?? 0.25;
  const highVolMultiplier = options.ob_high_volume_multiplier ?? 1.5, dynamicVolume = options.ob_dynamic_volume !== false;
  const closeOnly = options.ob_mitigation === "Close";
  const volume = series.map((b) => (finite(b.volume) ? b.volume : null));
  const zones = [], out = [];
  let prior = 0;
  for (let i = 0; i < series.length; i++) {
    const bar = series[i], atrNow = atr[i];
    if (i >= pivotLen) {
      const recent = series.slice(i - pivotLen + 1, i + 1);
      if (series[i - pivotLen].high > Math.max(...recent.map((b) => b.high))) prior = 0;
      else if (series[i - pivotLen].low < Math.min(...recent.map((b) => b.low))) prior = 1;
    }
    const vp = pivotHighAt(volume, i, pivotLen, pivotLen);
    const newBull = vp !== null && prior === 1, newBear = vp !== null && prior === 0;
    if ((newBull || newBear) && Number.isFinite(atrNow)) {
      const p = vp.pivotIndex, src = series[p], srcAtr = Number.isFinite(atr[p]) ? atr[p] : atrNow;
      const mid = (src.high + src.low) / 2, cap = Math.max(srcAtr * maxZoneAtr, mintick), dir = newBull ? 1 : -1;
      const top = dir === -1 ? src.high : Math.min(mid, src.low + cap);
      const bottom = dir === -1 ? Math.max(mid, src.high - cap) : src.low;
      const sma = smaAt(volume, p, 20), noise = Number.isFinite(er[p]) ? 1 - er[p] : 0;
      const mult = dynamicVolume ? Math.max(1, highVolMultiplier * (1 - noise * 0.3)) : highVolMultiplier;
      zones.unshift({ dir, top, bottom, born: i, atrLocked: Math.max(srcAtr, mintick), highVolume: sma !== null && Number.isFinite(volume[p]) && volume[p] > sma * mult });
    }
    for (let j = zones.length - 1; j >= 0; j--) {
      const z = zones[j];
      if (i > z.born) {
        const buffer = Math.max(z.atrLocked * mitigationBufferAtr, 0);
        if (z.dir === -1 && bar.high > z.bottom && bar.low <= z.top) z.bottom = Math.min(z.top, Math.max(z.bottom, bar.high));
        else if (z.dir === 1 && bar.low < z.top && bar.high >= z.bottom) z.top = Math.max(z.bottom, Math.min(z.top, bar.low));
        const consumed = z.top - z.bottom <= mintick;
        const wick = z.dir === -1 ? bar.high >= z.top : bar.low <= z.bottom;
        const closeBreak = z.dir === -1 ? bar.close > z.top + buffer : bar.close < z.bottom - buffer;
        if (consumed || (closeOnly ? closeBreak : (wick || closeBreak)) || i - z.born > maxAge) zones.splice(j, 1);
      } else if (i - z.born > maxAge) zones.splice(j, 1);
    }
    for (const dir of [1, -1]) {
      let count = zones.filter((z) => z.dir === dir).length;
      for (let j = zones.length - 1; j >= 0 && count > maxActive; j--) if (zones[j].dir === dir) { zones.splice(j, 1); count--; }
    }
    out.push(zones.map((z) => ({ dir: z.dir, top: z.top, bottom: z.bottom, born: z.born, highVolume: z.highVolume })));
  }
  return out;
}

// ---------------------------------------------------------------- the per-bar state the alert latches

const OB_FILTER = Object.freeze({ "BULL OB PASS": 1, "BEAR OB PASS": -1, BLOCK_NO_ACTIVE_BULL_OB: 2, BLOCK_NO_ACTIVE_BEAR_OB: -2, BLOCK_NO_QUALIFIED_BULL_OB: 3, BLOCK_NO_QUALIFIED_BEAR_OB: -3 });

/** Pure: Pine's hud_momentum_strength_txt as the alert's code (2, 1, -2, -1, 0; null when the delta is na). */
export function momentumCode(fast, slow, delta) {
  if (!finite(delta) || !finite(fast) || !finite(slow)) return null;
  if (fast > slow && delta > 0) return 2;
  if (fast > slow && delta < 0) return 1;
  if (fast < slow && delta < 0) return -2;
  if (fast < slow && delta > 0) return -1;
  return 0;
}

/** Pure: ta.linreg(src, len, offset) over the `len` values ending at the last one (least squares, offset back). */
function linreg(window, offset) {
  const n = window.length, xs = window.map((_, k) => k);
  const mx = (n - 1) / 2, my = window.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let k = 0; k < n; k++) { sxy += (xs[k] - mx) * (window[k] - my); sxx += (xs[k] - mx) ** 2; }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return my - slope * mx + slope * (n - 1 - offset);
}
const stdev = (w) => { const m = w.reduce((a, b) => a + b, 0) / w.length; return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length); };

/**
 * Pure: the alert's values for the last bar of a core run (`outputs` from calculateProphetR38Core over `series`).
 * Returns { comparable } with every PROPHET_ADOPT_FIELDS key, or null without outputs.
 */
export function prophetAdoptValues(series, outputs, { mintick = 0.001 } = {}) {
  if (!Array.isArray(outputs) || !outputs.length || outputs.length !== series.length) return null;
  const n = outputs.length, i = n - 1, R = PROPHET_ADOPT_RULES;
  const atr = outputs.map((o) => o.sensors?.atr14), er = outputs.map((o) => o.sensors?.efficiency_ratio_14);
  const fast = outputs.map((o) => o.oscillator?.fast);
  const zonesAt = obZoneSeries(series, { atr, er, mintick });
  // Entry latches (Pine 407-420), the latest setup (424-425) and the TARGET KEY latch (826-834, 1040-1060), bar by bar.
  let latchedBuy = null, latchedSell = null, lastBuy = null, lastSell = null;
  let tk = null, tkLastHit = null, tkReached = false, tkDir = 0, tkJustHit = false;
  for (let k = 0; k < n; k++) {
    const c = outputs[k].confirmation || {}, ob = outputs[k].order_blocks || {}, inten = outputs[k].sensors?.cycle_intensity;
    if (c.buy_candidate) { latchedBuy = null; latchedSell = null; lastBuy = k; }
    if (c.sell_candidate) { latchedSell = null; latchedBuy = null; lastSell = k; }
    const buyRaw = c.buy_window_active && c.bullish_price_confirm && c.bullish_structure_confirm && c.buy_volume_pass;
    const sellRaw = c.sell_window_active && c.bearish_price_confirm && c.bearish_structure_confirm && c.sell_volume_pass;
    if ((c.buy_early_confirmation || buyRaw) && latchedBuy === null) latchedBuy = series[k].close;
    if ((c.sell_early_confirmation || sellRaw) && latchedSell === null) latchedSell = series[k].close;
    const biasDir = inten === 3 ? 1 : inten === -3 ? -1 : 0;
    if (biasDir !== tkDir) { tk = null; tkLastHit = null; tkReached = false; tkDir = biasDir; }
    if (tk !== null && !zonesAt[k].some((z) => z.dir === -tkDir && tkDir !== 0 && tk >= z.bottom && tk <= z.top)) { tk = null; tkReached = false; }
    const conflict = ob.forecast_context_conflict === true;
    const raw = conflict ? null : inten === 3 ? ob.best_bullish_ob_target?.price ?? null : inten === -3 ? ob.best_bearish_ob_target?.price ?? null : null;
    tkJustHit = tk !== null && !tkReached && ((tkDir === 1 && series[k].high >= tk) || (tkDir === -1 && series[k].low <= tk));
    if (tkJustHit) { tkLastHit = tk; tk = null; tkReached = true; }
    if (tk === null && finite(raw) && !tkJustHit && !conflict) { tk = raw; tkReached = false; }
  }
  const o = outputs[i], c = o.confirmation || {}, st = o.structure || {}, s = o.sensors || {}, osc = o.oscillator || {}, ob = o.order_blocks || {};
  const inten = s.cycle_intensity;
  const volAnom = finite(s.volume_ratio_20) ? s.volume_ratio_20 : 1.0;
  const cshi = (Math.min(2.0, volAnom) / 2.0) * 0.40 + (finite(s.hurst_rs_100) ? s.hurst_rs_100 : 0.5) * 0.35 + (finite(s.efficiency_ratio_14) ? s.efficiency_ratio_14 : NaN) * 0.25;
  const cshiTier = !finite(cshi) ? 0 : cshi >= 0.65 ? 3 : cshi >= 0.50 ? 2 : cshi >= 0.38 ? 1 : 0;
  const delta = i > 0 && finite(fast[i]) && finite(fast[i - 1]) ? fast[i] - fast[i - 1] : null;
  const mom = momentumCode(osc.fast, osc.slow, delta);
  const momCtx = inten === -3 && (mom === 2 || mom === 1) ? 1 : inten === 3 && (mom === -2 || mom === -1) ? -1 : inten === 0 ? 2 : 0;
  const fresh = (bar) => bar !== null && bar !== undefined && i - bar <= R.struct_fresh_bars;
  const ctBull = inten === -3 && ((st.d_enc === 1 && fresh(st.bull_structure_event_bar)) || (st.d_enc === -3 && st.subtype_code === 3 && fresh(st.bull_structure_event_bar)));
  const ctBear = inten === 3 && ((st.d_enc === -1 && fresh(st.bear_structure_event_bar)) || (st.d_enc === 3 && st.subtype_code === 1 && fresh(st.bear_structure_event_bar)));
  const cross = (level, up) => i > 0 && finite(fast[i]) && finite(fast[i - 1]) && (up ? fast[i] > level && fast[i - 1] <= level : fast[i] < level && fast[i - 1] >= level);
  // The projection (Pine 531-540).
  const w = fast.slice(-R.projection_lookback);
  let projSlope = null, projMain = null, projAlt = null;
  if (w.length === R.projection_lookback && w.every(finite)) {
    projSlope = linreg(w, 0) - linreg(w, 1);
    const step = Math.max(Math.abs(projSlope), (stdev(w) / R.projection_horizon) * 0.15);
    const neutral = Math.abs(projSlope) < 0.000001;
    projMain = neutral ? osc.fast + step * R.projection_horizon : osc.fast + projSlope * R.projection_horizon;
    projAlt = neutral ? osc.fast - step * R.projection_horizon : osc.fast - Math.sign(projSlope) * step * R.projection_horizon;
  }
  // The order blocks (Pine 935-1027): the best blocks and targets come from the core.
  const bb = ob.best_buy_ob, bs = ob.best_sell_ob, bt = ob.best_bullish_ob_target, st2 = ob.best_bearish_ob_target;
  const hv = (dir, best) => { if (!best) return null; const z = zonesAt[i].find((x) => x.dir === dir && x.top === best.top && x.bottom === best.bottom); return z ? (z.highVolume ? 1 : 0) : null; };
  const buyRef = bb ? (R.rr_basis === "EDGE" ? bb.top : bb.level) : null, sellRef = bs ? (R.rr_basis === "EDGE" ? bs.bottom : bs.level) : null;
  const buyRisk = finite(buyRef) && finite(ob.buy_stop_level) ? buyRef - ob.buy_stop_level : null;
  const sellRisk = finite(sellRef) && finite(ob.sell_stop_level) ? ob.sell_stop_level - sellRef : null;
  const buyReward = bt && finite(buyRef) ? bt.price - buyRef : null, sellReward = st2 && finite(sellRef) ? sellRef - st2.price : null;
  // The setup and the exit reason (no position: Pine 1067's second branch).
  const latestBuy = lastBuy !== null && (lastSell === null || i - lastBuy < i - lastSell);
  const latestSell = lastSell !== null && (lastBuy === null || i - lastSell < i - lastBuy);
  const buySetup = latestBuy && c.buy_window_active && inten === 3, sellSetup = latestSell && c.sell_window_active && inten === -3;
  const tEnc = prophetR38TEnc({ dEnc: st.d_enc, bEnc: st.b_enc, proFast: osc.fast, zScore: s.kww_zscore_50, hurst: s.hurst_rs_100, inten, kaufmanEr: s.efficiency_ratio_14, volAnom });
  const exitCode = (c.sell_confirmed || (inten === -3 && mom === -2)) ? 11 : (c.buy_confirmed || (inten === 3 && mom === 2)) ? 12
    : ctBull ? 13 : ctBear ? 14 : inten === -3 && (mom === 2 || mom === 1) ? 15 : inten === 3 && (mom === -2 || mom === -1) ? 16
    : tEnc === 5 ? 17 : (mom === 1 || mom === -1) ? 18 : 0;
  const exitKey = inten === 3 ? (bb ? bb.bottom : null) : inten === -3 ? (bs ? bs.top : null) : null;
  const tkHit = (ob.buy_trade_ready === true && tkJustHit && finite(tkLastHit) && bt && tkLastHit === bt.price)
    || (ob.buy_trade_ready !== true && ob.sell_trade_ready === true && tkJustHit && finite(tkLastHit) && st2 && tkLastHit === st2.price);
  const comparable = {
    cshi: num(cshi), cshi_tier: cshiTier, er: num(s.efficiency_ratio_14), vol_anom: num(volAnom),
    early_buy: flag(c.buy_early_confirmation), early_sell: flag(c.sell_early_confirmation),
    bull_div: flag(st.bull_divergence_event), bear_div: flag(st.bear_divergence_event),
    bull_div_age: finite(st.bull_divergence_origin_bar) ? i - st.bull_divergence_origin_bar : null, bull_div_osc: num(st.bull_divergence_origin_value),
    bear_div_age: finite(st.bear_divergence_origin_bar) ? i - st.bear_divergence_origin_bar : null, bear_div_osc: num(st.bear_divergence_origin_value),
    pro_fast: num(osc.fast), pro_slow: num(osc.slow), pro_core: num(osc.core),
    buy_ob_score: num(bb?.score), sell_ob_score: num(bs?.score), buy_ob_hv: hv(1, bb), sell_ob_hv: hv(-1, bs),
    bull_tp_score: num(bt?.score), bear_tp_score: num(st2?.score), ob_bull_n: int(ob.active_bull_ob_count), ob_bear_n: int(ob.active_bear_ob_count),
    ob_filter: OB_FILTER[ob.ob_filter_status] ?? 0,
    buy_stop: num(ob.buy_stop_level), sell_stop: num(ob.sell_stop_level), buy_risk: num(buyRisk), sell_risk: num(sellRisk),
    buy_reward: num(buyReward), sell_reward: num(sellReward), buy_rr: num(ob.buy_rr), sell_rr: num(ob.sell_rr),
    buy_ready: flag(ob.buy_trade_ready), sell_ready: flag(ob.sell_trade_ready),
    mom, mom_delta: num(delta), mom_ctx: momCtx, cross_up: flag(cross(-0.35, true)), cross_dn: flag(cross(0.35, false)),
    ct_bull: flag(ctBull), ct_bear: flag(ctBear), proj_main: num(projMain), proj_alt: num(projAlt), proj_slope: num(projSlope),
    buy_entry_ref: num(latchedBuy), sell_entry_ref: num(latchedSell),
    buy_entry: buySetup && latchedBuy !== null ? num(latchedBuy) : null, sell_entry: sellSetup && latchedSell !== null ? num(latchedSell) : null,
    pos: 0, entry_ok: 0, tp_struct: null, tp_reached: 0, reversal: 0, mom_weak: 0,
    exit_code: exitCode, exit_key: num(exitKey),
    tk_latched: num(tk), tk_dir: tkDir, tk_reached: flag(tkReached), tk_just_hit: flag(tkJustHit), tk_last_hit: num(tkLastHit), tk_hit: flag(tkHit)
  };
  return { comparable };
}

/**
 * The adoption record's parts for one chart of a bundle, from the chart's core run (prophet-setup.mjs chartProphetCore:
 * the producers' own input, run once per bundle). `reuseOnly` (the publisher's mode) builds only from a run already
 * made this tick, never a new one: { candle_key, timeframe, candle_time, candle, comparable }, or null. Throws an Error
 * with a code on an unsupported chart.
 */
export function buildProphetAdopt(bundle, chart = "H1", { mintick = 0.001, reuseOnly = false } = {}) {
  const spec = SETUP_CHARTS[chart];
  if (!spec || !PROPHET_ADOPT_CHARTS.includes(chart)) throw Object.assign(new Error(`unsupported chart: ${chart}`), { code: "unsupported_chart" });
  if (reuseOnly && !hasChartProphetCore(bundle, chart, { mintick })) return null;
  const core = chartProphetCore(bundle, chart, { mintick });
  if (!core) return null;
  const values = prophetAdoptValues(core.input, core.r38.outputs, { mintick });
  if (!values) return null;
  const last = core.input.at(-1);
  return {
    candle_key: core.candle_key,
    timeframe: spec.period,
    candle_time: new Date(Date.parse(last.open_time)).toISOString(),
    candle: { o: last.open, h: last.high, l: last.low, c: last.close, volume: finite(last.volume) ? last.volume : 0 },
    comparable: values.comparable
  };
}

/**
 * The prophet_adopt local record of one chart's latest closed bar (cryptophys.local-calculation.v1), or null without
 * bars or an identity. values.comparable carries the alert's fields under its source; only the prophet_adopt_* groups
 * of src/parity-registry.mjs compare them, each against the same fields of the alert.
 */
export function buildProphetAdoptRecord(bundle, chart = "H1", { now = Date.now(), mintick = 0.001, reuseOnly = false } = {}) {
  const p = ENGINE_PROVENANCE.prophet_adopt;
  if (!p) return null;
  const built = buildProphetAdopt(bundle, chart, { mintick, reuseOnly });
  if (!built) return null;
  return {
    schema_version: "cryptophys.local-calculation.v1", symbol: TICKERID, timeframe: built.timeframe,
    candle_key: built.candle_key, candle_time: built.candle_time, computed_at: new Date(now).toISOString(),
    engine: "prophet_adopt",
    calculation_version: `${PROPHET_ADOPT_VERSION}@${p.implementation_hash.slice(0, 12)}`,
    values: {
      candle: built.candle,
      comparable: { [PROPHET_ADOPT_SOURCE]: built.comparable },
      scope_note: "Adoption record (B11a): compared group by group (prophet_adopt_*) with the v2 alert. No agent, council, Key Level, Position Manager or Omega reads it."
    },
    provenance: { source: "local-engines/producer adopt prophet", source_hash: p.source_hash, implementation_hash: p.implementation_hash, files: p.files }
  };
}
