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

export const PATTERN_CALIBRATION_VERSION = "cryptophys.pattern-calibration.v1";
export const PATTERN_CALIBRATION_KEY = "chart-patterns:calibration:v1";
export const CALIBRATION = Object.freeze({ window: 60, horizon: 30, horizon_max: 120, min_sample: 20, prior: 10, factor_min: 0.5, factor_max: 1.5 });
/** The charts replayed: the Key Level Agent's timeframe labels and their cached series. */
export const CALIBRATION_SERIES = Object.freeze([["15", "15m"], ["60", "1h"], ["240", "4h"], ["D", "1D"]]);

const num = (x) => typeof x === "number" && Number.isFinite(x);
const r3 = (x) => Math.round(x * 1000) / 1000;
const hi = (b) => b.high ?? b.h, lo = (b) => b.low ?? b.l, cl = (b) => b.close ?? b.c;

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
      out.push({ key, tf, id: p.id, status: p.status, direction: p.direction, at: bars[i].close_time ?? null, outcome });
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
  return { base_rate: base != null ? r3(base) : null, resolved: resolved.length, pending: occurrences.length - resolved.length, patterns };
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
  return { version: PATTERN_CALIBRATION_VERSION, computed_at: new Date(now).toISOString(), rules: { ...CALIBRATION }, charts, ...calibrationFrom(occurrences) };
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

/** The stored calibration, or null (mode off, none yet, unreadable). */
export async function readPatternCalibration(env) {
  if (patternCalibrationMode(env) === "off") return null;
  try { return JSON.parse((await env?.SIGNAL_CACHE?.get?.(PATTERN_CALIBRATION_KEY)) || "null"); } catch { return null; }
}
