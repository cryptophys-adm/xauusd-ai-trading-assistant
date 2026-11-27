// M15P (2026-11-27; the owner to CTA: post the confirmed M15 chart patterns "langsung ketika pattern 15m confirmed tanpa
// menunggu jadwal 1H"): a cheap path for the public M15 patterns. CTA's fast pass would otherwise call
// PublicProjection.analysis() every 5 minutes, which reads and builds the whole strategy (readStrategyWithCharts) and
// the latest decision on every call: too heavy for 288 calls a day.
//
//   - Writer (runM15PatternsStep, in the existing 5-minute ledger step, no new cron): when the latest 15m bar's close
//     time differs from the stored one, it detects the Projection Agent's patterns on the 15m bars only (the same bars
//     and released figures the strategy reads for its M15 patterns: the last 60 of the OANDA:XAUUSD 15m series and
//     recentReleases), projects them with publicPatterns (src/public-analysis.mjs, BP1's guards included) and writes
//     { version, at_close_ms, patterns } to one KV key, only when that value changed. No strategy is built.
//   - Reader (readM15Patterns, PublicProjection.m15Patterns()): that one KV key and nothing else. With `sinceCloseMs`
//     equal to the stored close it answers { unchanged: true } without the patterns.
// The patterns are the same public shape as publicAnalysis().patterns (chart "M15"): no decision, plan, entry, stop,
// target, account or price beyond each pattern's own lines and projection, exactly as the H1 patterns.
import { detectPatterns } from "./chart-patterns.mjs";
import { publicPatterns } from "./public-analysis.mjs";
import { chartPatternsMode } from "./projection-agent.mjs";
import { recentReleases } from "./econ-releases.mjs";

export const M15_PATTERNS_VERSION = "cryptophys.public-m15-patterns.v1";
/** The one KV key (SIGNAL_CACHE) the writer writes and the reader reads. */
export const M15_PATTERNS_KEY = "public:m15-patterns:v1";
/** The 15m series the strategy reads (strategy-engine.mjs seriesCandles(env, "15m")), and how many of its bars. */
export const M15_SERIES_KEY = "market-data:v2:series:OANDA:XAUUSD|15m";
export const M15_PATTERN_BARS = 60;
/** The stored value lives a day; a stale market keeps the last value until the next close rewrites it. */
export const M15_PATTERNS_TTL_S = 86_400;

/** The close time (ms) of a bar as the pattern detector reads it (close_time, else t), or null. */
export function barCloseMs(bar) {
  const ct = Date.parse(String(bar?.close_time ?? ""));
  if (Number.isFinite(ct)) return ct;
  return Number.isFinite(Number(bar?.t)) && bar?.t !== null && bar?.t !== "" ? Number(bar.t) : null;
}

/**
 * Pure: the public M15 patterns of the 15m bars (the strategy's last M15_PATTERN_BARS), as the analysis shows them:
 * detectPatterns on the 15m bars with the released figures, tagged tf "15", then publicPatterns. `mode` "off"
 * (CHART_PATTERNS_MODE) leaves the patterns out, as the strategy does.
 */
export function m15PatternsOf(bars, { events = [], mode = "on" } = {}) {
  const series = Array.isArray(bars) ? bars.slice(-M15_PATTERN_BARS) : [];
  const at_close_ms = series.length ? barCloseMs(series.at(-1)) : null;
  const found = mode === "off" ? [] : detectPatterns(series, { events });
  const patterns = publicPatterns(found.map((p) => ({ tf: "15", chart: "15m", ...p })));
  return { version: M15_PATTERNS_VERSION, at_close_ms, mode: mode === "off" ? "off" : "on", patterns };
}

const readJson = async (kv, key) => { try { return JSON.parse((await kv?.get?.(key)) || "null"); } catch { return null; } };

/**
 * The writer, once per 5-minute ledger run. Reads the 15m series and the stored value (2 KV reads); when the latest
 * close and the mode are what is stored, it stops there ("same_close"). Otherwise it reads the released figures,
 * computes the M15 patterns and writes them only when the value differs ("written", else "unchanged"). Never throws.
 */
export async function runM15PatternsStep(env, { now = Date.now() } = {}) {
  const kv = env?.SIGNAL_CACHE;
  if (!kv?.get || !kv?.put) return { status: "disabled" };
  try {
    const raw = await readJson(kv, M15_SERIES_KEY);
    const bars = Array.isArray(raw?.candles) ? raw.candles.slice(-M15_PATTERN_BARS) : [];
    const closeMs = bars.length ? barCloseMs(bars.at(-1)) : null;
    if (closeMs === null) return { status: "no_bars" };
    const mode = chartPatternsMode(env);
    const stored = await readJson(kv, M15_PATTERNS_KEY);
    if (stored?.version === M15_PATTERNS_VERSION && stored.at_close_ms === closeMs && stored.mode === mode) return { status: "same_close", at_close_ms: closeMs };
    const events = mode === "off" ? [] : ((await recentReleases(env, { now }).catch(() => [])) ?? []);
    const value = m15PatternsOf(bars, { events, mode });
    if (stored && JSON.stringify(stored) === JSON.stringify(value)) return { status: "unchanged", at_close_ms: closeMs };
    await kv.put(M15_PATTERNS_KEY, JSON.stringify(value), { expirationTtl: M15_PATTERNS_TTL_S });
    return { status: "written", at_close_ms: closeMs, patterns: value.patterns.length };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 120) };
  }
}

/**
 * The reader (PublicProjection.m15Patterns): the one KV key, nothing else. `sinceCloseMs` equal to the stored close
 * answers { version, at_close_ms, unchanged: true }. Without a stored value: no patterns and a null close.
 */
export async function readM15Patterns(env, { sinceCloseMs = null } = {}) {
  const v = await readJson(env?.SIGNAL_CACHE, M15_PATTERNS_KEY);
  if (!v || v.version !== M15_PATTERNS_VERSION || !Array.isArray(v.patterns)) return { version: M15_PATTERNS_VERSION, at_close_ms: null, patterns: [] };
  const since = Number(sinceCloseMs);
  if (sinceCloseMs !== null && sinceCloseMs !== undefined && Number.isFinite(since) && since === v.at_close_ms) {
    return { version: M15_PATTERNS_VERSION, at_close_ms: v.at_close_ms, unchanged: true };
  }
  return { version: M15_PATTERNS_VERSION, at_close_ms: v.at_close_ms, patterns: v.patterns };
}
