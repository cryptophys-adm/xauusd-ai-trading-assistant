// Chart-pattern weight calibration (owner 2026-11-12: "ya kerjakan kalibrasi bobot pola chart"). The
// Projection Agent's pattern levels started with default weights (src/chart-patterns.mjs patternLevels:
// a broken line 0.8, the measured target 0.7, busted 0.6, the other line 0.5). Here every pattern is
// measured on gold itself, by replaying the same detector the Key Level Agent runs (the last 60 closed bars of
// each chart) at every closed bar of the cached series (15m about three weeks, 1H about six weeks,
// 4H and daily months), and following each breakout for twice the pattern's width in bars of its chart
// (at least 30, at most 120: a wide pattern projects a far target):
//   target   price reached the measured target first;
//   failed   a close beyond the pattern's other line came first (the pattern busted), or both in one
//            bar (counted as failed: conservative);
//   expired  neither within the horizon (counted as a miss).
// A pattern's success rate is shrunk toward the rate of all patterns (a Beta prior worth PRIOR
// outcomes) and its factor is that rate over the base rate, within [0.5, 1.5]; it applies only from
// MIN_SAMPLE resolved breakouts of that pattern, else the factor is 1 (the default weights). The
// factor scales the broken-line, target and other-line weights of a confirmed or busted pattern; a
// forming pattern keeps its breakout lines at the default.
// Deterministic and recomputed every hour from the bars alone (about half a second of CPU), so there
// is no state to drift. Event patterns need the release history and keep their default weights.
// Switch: PATTERN_CALIBRATION_MODE = "auto" (default) | "off" (the default weights; nothing written).
import { detectPatterns } from "./chart-patterns.mjs";

export const PATTERN_CALIBRATION_VERSION = "cryptophys.pattern-calibration.v2";
export const PATTERN_CALIBRATION_KEY = "chart-patterns:calibration:v1";
export const CALIBRATION = Object.freeze({ window: 60, horizon: 30, horizon_max: 120, min_sample: 20, prior: 10, factor_min: 0.5, factor_max: 1.5 });
/** The charts replayed: the Key Level Agent's timeframe labels and their cached series. */
export const CALIBRATION_SERIES = Object.freeze([["15", "15m"], ["60", "1h"], ["240", "4h"], ["D", "1D"]]);

const num = (x) => typeof x === "number" && Number.isFinite(x);
const r3 = (x) => Math.round(x * 1000) / 1000;
const hi = (b) => b.high ?? b.h, lo = (b) => b.low ?? b.l, cl = (b) => b.close ?? b.c;

/**
 * Track A PR 4 (v2): the same pooled block and factors as v1, plus by_tf (each chart's own record: how many bars a
 * breakout took to reach its target, and each pattern's split and rate on that chart) and open (each chart's
 * breakouts still pending, with the pattern frozen at its breakout). Switch: PATTERN_HORIZON_MODE = "on" (default) |
 * "off", read only by readPatternCalibration, which then strips by_tf and open.
 */
export const HORIZON_DEFAULT_BARS = 30;
export function patternHorizonMode(env) {
  return String(env?.PATTERN_HORIZON_MODE ?? "on").trim().toLowerCase() === "off" ? "off" : "on";
}

export function patternCalibrationMode(env) {
  return String(env?.PATTERN_CALIBRATION_MODE ?? "auto").trim().toLowerCase() === "off" ? "off" : "auto";
}

/**
 * Pure: every breakout the detector reports while replaying `bars` (closed, oldest first), with its
 * outcome on the bars after. One breakout of a pattern and direction on a chart is followed at a time:
 * while it is unresolved, the detector reporting the same pattern again (its lines refit bar by bar)
 * is the same breakout, not a new one.
 */
export function replayOccurrences(bars, { tf, window = CALIBRATION.window, horizon = CALIBRATION.horizon, horizonMax = CALIBRATION.horizon_max } = {}) {
  const out = [], busyUntil = new Map();
  const n = Array.isArray(bars) ? bars.length : 0;
  for (let i = window - 1; i < n; i++) {
    const from = i - window + 1;
    let found = [];
    try { found = detectPatterns(bars.slice(from, i + 1)); } catch { found = []; }
    for (const p of found) {
      if (p.status === "forming" || !p.direction || !num(p.target) || p.id.startsWith("event_")) continue;
      const base = `${tf}|${p.id}|${p.direction}`;
      if ((busyUntil.get(base) ?? -1) >= i) continue;
      const key = `${base}|${i}`;
      const other = p.direction > 0 ? p.lower : p.upper;
      const h = Math.min(horizonMax, Math.max(horizon, 2 * Math.max(0, (p.end_bar ?? 0) - (p.start_bar ?? 0))));
      let outcome = "pending", end = n - 1;
      for (let j = i + 1; j < n && j <= i + h; j++) {
        const failed = num(other) && (p.direction > 0 ? cl(bars[j]) < other : cl(bars[j]) > other);
        const hit = p.direction > 0 ? hi(bars[j]) >= p.target : lo(bars[j]) <= p.target;
        if (failed) { outcome = "failed"; end = j; break; }
        if (hit) { outcome = "target"; end = j; break; }
      }
      if (outcome === "pending" && i + h <= n - 1) { outcome = "expired"; end = i + h; }
      busyUntil.set(base, end);
      // bars: from the breakout bar to the bar that resolved it (or to the last bar while pending); h: its horizon.
      const row = { key, tf, id: p.id, status: p.status, direction: p.direction, at: bars[i].close_time ?? null, outcome, bars: end - i, h };
      // A pending breakout keeps the pattern as it was at the breakout, so later bars can re-check it.
      if (outcome === "pending") Object.assign(row, { name: p.name ?? null, upper: num(p.upper) ? p.upper : null, lower: num(p.lower) ? p.lower : null, target: p.target, height: num(p.height) ? p.height : null, breakout_close: bars[i].close_time ?? null });
      out.push(row);
    }
  }
  return out;
}

/** Pure: the calibration of resolved occurrences: the base rate and each pattern's factor. */
export function calibrationFrom(occurrences, { min_sample = CALIBRATION.min_sample, prior = CALIBRATION.prior, factor_min = CALIBRATION.factor_min, factor_max = CALIBRATION.factor_max } = {}) {
  const resolved = occurrences.filter((o) => o.outcome !== "pending");
  const wins = resolved.filter((o) => o.outcome === "target").length;
  const base = resolved.length ? wins / resolved.length : null;
  const by = new Map();
  for (const o of resolved) {
    const s = by.get(o.id) ?? { n: 0, target: 0, failed: 0, expired: 0 };
    s.n += 1; s[o.outcome] += 1;
    by.set(o.id, s);
  }
  const patterns = {};
  for (const [id, s] of [...by.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const rate = s.target / s.n;
    const posterior = base != null && base > 0 ? (s.target + prior * base) / (s.n + prior) : null;
    const factor = posterior != null ? Math.min(factor_max, Math.max(factor_min, posterior / base)) : 1;
    const active = s.n >= min_sample && posterior != null;
    patterns[id] = { n: s.n, target: s.target, failed: s.failed, expired: s.expired, rate: r3(rate), factor: active ? r3(factor) : 1, active };
  }
  return { base_rate: base != null ? r3(base) : null, resolved: resolved.length, pending: occurrences.length - resolved.length, patterns, by_tf: chartRecords(resolved, { min_sample, prior }) };
}

/** Pure: n, median and p90 (nearest rank) of a list of bar counts, or null for none. */
export function barsSummary(list) {
  const v = list.filter(num).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = (q) => v[Math.max(0, Math.ceil(q * v.length) - 1)];
  return { n: v.length, median: rank(0.5), p90: rank(0.9) };
}

/**
 * Pure: each chart's own record from its resolved breakouts: the chart's rate, the bars to target (target outcomes
 * only), and per pattern the target/failed/expired split, the raw rate and the rate shrunk toward the chart's rate
 * (a prior worth `prior` outcomes), active from `min_sample` resolved breakouts on that chart.
 */
function chartRecords(resolved, { min_sample, prior }) {
  const out = {};
  for (const [tf] of CALIBRATION_SERIES) {
    const rows = resolved.filter((o) => o.tf === tf);
    if (!rows.length) continue;
    const rate = rows.filter((o) => o.outcome === "target").length / rows.length;
    const patterns = {};
    const ids = [...new Set(rows.map((o) => o.id))];
    for (const id of ids) {
      const own = rows.filter((o) => o.id === id);
      const target = own.filter((o) => o.outcome === "target");
      const s = { n: own.length, target: target.length, failed: own.filter((o) => o.outcome === "failed").length, expired: own.filter((o) => o.outcome === "expired").length };
      patterns[id] = { ...s, raw_rate: r3(s.target / s.n), rate: r3((s.target + prior * rate) / (s.n + prior)), active: s.n >= min_sample, bars_to_target: barsSummary(target.map((o) => o.bars)) };
    }
    const ordered = Object.fromEntries(Object.entries(patterns).sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1)));
    out[tf] = { resolved: rows.length, rate: r3(rate), bars_to_target: barsSummary(rows.filter((o) => o.outcome === "target").map((o) => o.bars)), patterns: ordered };
  }
  return out;
}

/**
 * Pure: how many bars a pattern's breakout on a chart is followed for: the pattern's own p90 bars to target on that
 * chart when it is active there, else the chart's p90 when it has at least `min_sample` targets, else
 * HORIZON_DEFAULT_BARS; never above `h` (the replay's own horizon for that pattern) when it is given.
 */
export function horizonFor(calibration, tf, id, h = null, { min_sample = CALIBRATION.min_sample } = {}) {
  const chart = calibration?.by_tf?.[tf];
  const own = chart?.patterns?.[id];
  let bars = HORIZON_DEFAULT_BARS;
  if (own?.active && num(own.bars_to_target?.p90)) bars = own.bars_to_target.p90;
  else if (num(chart?.bars_to_target?.p90) && (chart.bars_to_target.n ?? 0) >= min_sample) bars = chart.bars_to_target.p90;
  return num(h) ? Math.min(h, bars) : bars;
}

/** Pure: a pattern's weight factor from a stored calibration (1 without an active one). */
export function patternFactor(calibration, id) {
  const p = calibration?.patterns?.[id];
  return p?.active && num(p.factor) ? p.factor : 1;
}

/** Pure: the whole calibration of the charts' series ({ "15": bars, "60": bars, ... }). */
export function calibratePatterns(seriesByTf, { now = Date.now() } = {}) {
  const occurrences = [], charts = {};
  for (const [tf] of CALIBRATION_SERIES) {
    const bars = (seriesByTf?.[tf] || []).filter((b) => num(hi(b)) && num(lo(b)) && num(cl(b)));
    const occ = replayOccurrences(bars, { tf });
    charts[tf] = { bars: bars.length, from: bars[0]?.open_time ?? null, to: bars.at(-1)?.close_time ?? null, breakouts: occ.length };
    occurrences.push(...occ);
  }
  // Each chart's breakouts still pending, with the pattern frozen at its breakout (Track A PR 4).
  const open = Object.fromEntries(CALIBRATION_SERIES.map(([tf]) => [tf, occurrences.filter((o) => o.tf === tf && o.outcome === "pending")
    .map(({ id, name, direction, status, upper, lower, target, height, breakout_close, bars, h }) => ({ id, name, direction, status, upper, lower, target, height, breakout_close, bars_since_breakout: bars, h }))]));
  return { version: PATTERN_CALIBRATION_VERSION, computed_at: new Date(now).toISOString(), rules: { ...CALIBRATION }, charts, ...calibrationFrom(occurrences), open };
}

async function seriesOf(env, interval) {
  try {
    const r = JSON.parse((await env.SIGNAL_CACHE?.get?.(`market-data:v2:series:OANDA:XAUUSD|${interval}`)) || "null");
    return Array.isArray(r?.candles) ? r.candles : [];
  } catch { return []; }
}

/** Hourly: recompute the calibration from the cached series and keep it in KV. Never throws. */
export async function runPatternCalibration(env, { now = Date.now() } = {}) {
  if (patternCalibrationMode(env) === "off") return { status: "disabled" };
  if (!env?.SIGNAL_CACHE) return { status: "unavailable" };
  try {
    const series = Object.fromEntries(await Promise.all(CALIBRATION_SERIES.map(async ([tf, interval]) => [tf, await seriesOf(env, interval)])));
    const cal = calibratePatterns(series, { now });
    await env.SIGNAL_CACHE.put(PATTERN_CALIBRATION_KEY, JSON.stringify(cal), { expirationTtl: 3 * 86_400 });
    const active = Object.values(cal.patterns).filter((p) => p.active).length;
    return { status: "ok", base_rate: cal.base_rate, resolved: cal.resolved, patterns: Object.keys(cal.patterns).length, active };
  } catch (e) { return { status: "failed", error: String(e?.message ?? e).slice(0, 200) }; }
}

/**
 * The stored calibration, or null (mode off, none yet, unreadable). PATTERN_HORIZON_MODE "off" strips the v2 fields
 * (by_tf and open), so every reader sees the v1 calibration.
 */
export async function readPatternCalibration(env) {
  if (patternCalibrationMode(env) === "off") return null;
  let cal;
  try { cal = JSON.parse((await env?.SIGNAL_CACHE?.get?.(PATTERN_CALIBRATION_KEY)) || "null"); } catch { return null; }
  if (cal && typeof cal === "object" && patternHorizonMode(env) === "off") { const { by_tf: _b, open: _o, ...v1 } = cal; return v1; }
  return cal;
}
