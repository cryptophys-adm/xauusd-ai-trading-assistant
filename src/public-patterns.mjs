// PT1 (2026-11-27; the owner to CTA: confirmed chart patterns on every chart posted within about 5 minutes, their
// invalidation, and an hourly recap): a cheap path for the public patterns of M15, H1, H4 and D1, busted ones included.
// CTA's fast pass would otherwise call PublicProjection.analysis() every 5 minutes, which reads and builds the whole
// strategy (readStrategyWithCharts) and the latest decision on every call: too heavy for 288 calls a day.
//
//   - Writer (runPatternsStep, in the existing 5-minute ledger step, no new cron). The 5-minute step computes no chart
//     pattern today, so this adds the Projection Agent's pattern detection there, and nothing else of the strategy: it
//     reads the four series the strategy reads (the last 60 bars of OANDA:XAUUSD 15m, 1h, 4h and 1D) and the stored
//     value; a chart's patterns are detected only on a new close of that chart (M15 every 15 minutes, H1 hourly, H4 every
//     4 hours, D1 daily; detectPatterns with the released figures, as buildKeyLevels' chartPatterns does) and projected
//     (publicPatterns, BP1's guards included); the other charts keep their stored patterns. It writes
//     { version, at_close_ms, closed, mode, patterns } to one KV key only when that value changed.
//   - Reader (readPatterns, PublicProjection.patterns()): that one KV key and nothing else. With `sinceCloseMs` equal to
//     the stored at_close_ms it answers { unchanged: true } without the patterns.
// The patterns are publicAnalysis().patterns' shape: no decision, plan, entry, stop, trade target, account or price
// beyond each pattern's own lines and projection.
import { detectPatterns } from "./chart-patterns.mjs";
import { publicPatterns } from "./public-analysis.mjs";
import { chartPatternsMode } from "./projection-agent.mjs";
import { recentReleases } from "./econ-releases.mjs";

export const PATTERNS_VERSION = "cryptophys.public-patterns.v1";
/** The one KV key (SIGNAL_CACHE) the writer writes and the reader reads. */
export const PATTERNS_KEY = "public:patterns:v1";
/** The series the strategy reads (strategy-engine.mjs seriesCandles), by public chart name, and how many bars of each. */
export const PATTERN_SERIES = Object.freeze({ M15: "15m", H1: "1h", H4: "4h", D1: "1D" });
/** The Projection Agent's timeframe of each chart (key-level-agent.mjs chartPatterns), in its order. */
const CHART_TF = Object.freeze({ M15: "15", H1: "60", H4: "240", D1: "D" });
export const seriesKey = (interval) => `market-data:v2:series:OANDA:XAUUSD|${interval}`;
export const PATTERN_BARS = 60;
/** The stored value lives a day; a closed market keeps the last value until the next close rewrites it. */
export const PATTERNS_TTL_S = 86_400;

/** The close time (ms) of a bar as the pattern detector reads it (close_time, else t), or null. */
export function barCloseMs(bar) {
  const ct = Date.parse(String(bar?.close_time ?? ""));
  if (Number.isFinite(ct)) return ct;
  return bar?.t !== null && bar?.t !== "" && Number.isFinite(Number(bar?.t)) ? Number(bar.t) : null;
}
const lastClose = (bars) => (Array.isArray(bars) && bars.length ? barCloseMs(bars.at(-1)) : null);

/** Pure: one chart's public patterns from its bars (the strategy's last PATTERN_BARS), as the analysis shows them. */
export function chartPublicPatterns(chart, bars, { events = [] } = {}) {
  const series = Array.isArray(bars) ? bars.slice(-PATTERN_BARS) : [];
  return publicPatterns(detectPatterns(series, { events }).map((p) => ({ tf: CHART_TF[chart], ...p })));
}

/**
 * Pure: the stored value from each chart's public patterns ({ M15: [...], H1: [...], ... }, absent = none) and closes:
 * the patterns in the Projection Agent's chart order (M15, H1, H4, D1, as publicAnalysis lists them), `closed` each
 * chart's latest close (ms) and `at_close_ms` the latest of them.
 */
function valueOf(byChart, closed, mode) {
  const known = Object.values(closed).filter((t) => t !== null);
  return {
    version: PATTERNS_VERSION, at_close_ms: known.length ? Math.max(...known) : null, closed, mode,
    patterns: mode === "off" ? [] : Object.keys(PATTERN_SERIES).flatMap((c) => byChart[c] ?? []),
  };
}

/**
 * Pure: the public patterns of the four charts' bars ({ M15, H1, H4, D1 }) as the analysis shows them, every chart
 * detected now. `mode` "off" (CHART_PATTERNS_MODE) leaves the patterns out, as the strategy does.
 */
export function patternsOf(bars = {}, { events = [], mode = "on" } = {}) {
  const m = mode === "off" ? "off" : "on";
  const closed = Object.fromEntries(Object.keys(PATTERN_SERIES).map((c) => [c, lastClose(Array.isArray(bars?.[c]) ? bars[c].slice(-PATTERN_BARS) : [])]));
  const byChart = m === "off" ? {} : Object.fromEntries(Object.keys(PATTERN_SERIES).map((c) => [c, chartPublicPatterns(c, bars?.[c], { events })]));
  return valueOf(byChart, closed, m);
}

const readJson = async (kv, key) => { try { return JSON.parse((await kv?.get?.(key)) || "null"); } catch { return null; } };

/**
 * The writer, once per 5-minute ledger run. Reads the four series and the stored value (5 KV reads); when every chart's
 * latest close and the mode are what is stored, it stops there ("same_close"). Otherwise it reads the released figures
 * and detects the patterns of the charts whose close changed only (a mode change or no stored value: every chart),
 * keeps the others' stored patterns, and writes the value only when it differs ("written", else "unchanged"). Returns
 * the charts it detected (`detected`). Never throws.
 */
export async function runPatternsStep(env, { now = Date.now() } = {}) {
  const kv = env?.SIGNAL_CACHE;
  if (!kv?.get || !kv?.put) return { status: "disabled" };
  try {
    const charts = Object.keys(PATTERN_SERIES);
    const raws = await Promise.all([...charts.map((c) => readJson(kv, seriesKey(PATTERN_SERIES[c]))), readJson(kv, PATTERNS_KEY)]);
    const stored = raws.pop();
    const bars = Object.fromEntries(charts.map((c, i) => [c, Array.isArray(raws[i]?.candles) ? raws[i].candles.slice(-PATTERN_BARS) : []]));
    const closed = Object.fromEntries(charts.map((c) => [c, lastClose(bars[c])]));
    if (Object.values(closed).every((t) => t === null)) return { status: "no_bars" };
    const mode = chartPatternsMode(env);
    if (stored?.version === PATTERNS_VERSION && stored.mode === mode && JSON.stringify(stored.closed) === JSON.stringify(closed)) return { status: "same_close", at_close_ms: stored.at_close_ms };
    const reuse = stored?.version === PATTERNS_VERSION && stored.mode === mode && Array.isArray(stored.patterns) && stored.closed && typeof stored.closed === "object";
    const detect = mode === "off" ? [] : charts.filter((c) => !reuse || stored.closed[c] !== closed[c]);
    const events = detect.length ? ((await recentReleases(env, { now }).catch(() => [])) ?? []) : [];
    const byChart = {};
    for (const c of charts) byChart[c] = detect.includes(c) ? chartPublicPatterns(c, bars[c], { events }) : (reuse ? stored.patterns.filter((p) => p?.chart === c) : []);
    const value = valueOf(byChart, closed, mode);
    if (stored && JSON.stringify(stored) === JSON.stringify(value)) return { status: "unchanged", at_close_ms: value.at_close_ms, detected: detect };
    await kv.put(PATTERNS_KEY, JSON.stringify(value), { expirationTtl: PATTERNS_TTL_S });
    return { status: "written", at_close_ms: value.at_close_ms, detected: detect, patterns: value.patterns.length };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 120) };
  }
}

/**
 * The reader (PublicProjection.patterns): the one KV key, nothing else. `sinceCloseMs` equal to the stored at_close_ms
 * answers { version, at_close_ms, unchanged: true }. Without a stored value: no patterns and a null close.
 */
export async function readPatterns(env, { sinceCloseMs = null } = {}) {
  const v = await readJson(env?.SIGNAL_CACHE, PATTERNS_KEY);
  if (!v || v.version !== PATTERNS_VERSION || !Array.isArray(v.patterns)) return { version: PATTERNS_VERSION, at_close_ms: null, closed: null, patterns: [] };
  const since = Number(sinceCloseMs);
  if (sinceCloseMs !== null && sinceCloseMs !== undefined && Number.isFinite(since) && since === v.at_close_ms) {
    return { version: PATTERNS_VERSION, at_close_ms: v.at_close_ms, unchanged: true };
  }
  return { version: PATTERNS_VERSION, at_close_ms: v.at_close_ms, closed: v.closed ?? null, patterns: v.patterns };
}
