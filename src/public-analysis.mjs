// The public analysis, real time (owner 2026-11-14, for the Threads account xauusd-ai-cta: "fokus pada hasil
// analytics dan key level. Tidak boleh ada advices buy/sell, kecuali info buy/sell zone"; then "Real-time,
// hanya analisa"). What the content engine may show the moment it forms:
//   - the Key Level Agent's candidate zones (where the key levels of every chart stack), as demand zones
//     (below the price, "area beli") and supply zones (above it, "area jual"), information only;
//   - the Projection Agent's chart patterns on H1, H4 and D1 (forming or confirmed), by their catalogue name,
//     and since PT1 (2026-11-27, the owner to CTA: confirmed patterns on every chart within about 5 minutes, and their
//     invalidation) on M15 too and busted ones too, for patterns only (zones_by_chart and closed stay H1, H4 and D1),
//     with their breakout lines, the line that undoes them and the pattern's measured projection;
//   - the market structure per chart (trend and swing label);
//   - KM1 (owner 2026-11-25): each chart's own key-level map (zones_by_chart H1, H4, D1, the agent's clustering over
//     that chart's levels alone) and the bar close it was read at (closed), for one CTA post per close.
// What it never holds: the system's decision (BUY, SELL, WAIT), the council's reasons, a plan, an entry, a
// stop, a target for a trade, a lot, the account or Omega. Decisions stay in the recap only
// (src/public-projection.mjs, after PUBLIC_DELAY_HOURS: 0 in production since 2026-11-25, owner "Semua sekarang"). Pure; the AI Worker serves it through PublicProjection.analysis().
import { patternInfo } from "./chart-patterns.mjs";

export const PUBLIC_ANALYSIS_VERSION = "cryptophys.public-analysis.v1";
/**
 * The charts whose patterns may be posted, and their public names. PT1 (2026-11-27): "15" is M15, for `patterns` only;
 * every chart-keyed field other than patterns (zones_by_chart, closed: KEY_MAP_CHARTS) is unchanged.
 */
export const ANALYSIS_CHARTS = Object.freeze({ "15": "M15", "60": "H1", "240": "H4", D: "D1", "1D": "D1" });
// A number, or null: null, undefined, "", booleans and non-finite values are no number (Number(null) is 0, which put a
// "Measured projection: 0.00" on a gap pattern without a measure on 2026-11-27, BP1).
const numOrNull = (x) => (x === null || x === undefined || x === "" || typeof x === "boolean" || !Number.isFinite(Number(x)) ? null : Number(x));
const r2 = (x) => { const n = numOrNull(x); return n === null ? null : Math.round(n * 100) / 100; };
/**
 * BP1 (2026-11-27): a confirmed pattern's measured projection, or null. Only a positive price on the side the pattern
 * broke out to (above its upper line going up, below its lower line going down) and within PROJECTION_MAX_HEIGHTS of
 * the pattern's own height from that line; anything else (no measure, 0, the wrong side, absurdly far) is left out.
 */
export const PROJECTION_MAX_HEIGHTS = 10;
export function publicProjectionOf(p) {
  if (p?.status !== "confirmed") return null;
  const t = r2(p.target), up = r2(p.upper), lo = r2(p.lower), dir = Number(p.direction);
  if (t === null || !(t > 0) || up === null || lo === null || !(up > 0) || !(lo > 0) || up < lo) return null;
  const height = up - lo, reach = Math.max(height, 0.01) * PROJECTION_MAX_HEIGHTS;
  if (dir > 0) return t > up && t - up <= reach ? t : null;
  if (dir < 0) return t < lo && lo - t <= reach ? t : null;
  return null;
}
const ROLE = Object.freeze({ support: "demand", resistance: "supply", "at price": "at_price" });

/**
 * The names of the metrics a zone stacks (owner 2026-11-15: "tidak perlu dicantumkan sumber playbook, cukup nama
 * metrics sumbernya"): the zone's heaviest key levels by name, e.g. "4H Camarilla H4", "daily pivot", "1H swing high".
 * Never a price (a round number is "round number"), never trade words (a pattern's "measured target" is its
 * "measured projection"; any other name with one is left out); at most `max`, unique.
 */
// A Fibonacci ratio (one integer digit, three or more decimals: 0.618, 0.705, 1.272) is a ratio, never a price: it is
// written to two decimals (0.62, 0.71, 1.27) before the price strip, which would otherwise take its decimal run and
// leave "Fibonacci 0.". Two decimals never make a run of three or more digits, so no price-shaped number survives.
const FIB_RATIO = /(?<![\d.])\d\.\d{3,}(?![\d.])/g;
/** At most `max` characters, cut at a word boundary (never mid-word), without a dangling ":", "-", "(" or ",". */
export function cutAtWord(s, max) {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  const head = t.slice(0, max + 1);
  const at = head.lastIndexOf(" ");
  return (at > 0 ? head.slice(0, at) : t.slice(0, max)).replace(/[\s:;,(\-–—/]+$/, "");
}

export function zoneMetrics(zone, { max = 3 } = {}) {
  const names = [];
  for (const m of Array.isArray(zone?.members) ? zone.members : []) {
    let n = String(m?.label ?? "").trim();
    if (!n) continue;
    n = n.replace(/^round\s+\d+(\.\d+)?$/i, "round number")
      .replace(/\bmeasured target\b/gi, "measured projection")
      .replace(FIB_RATIO, (r) => (Math.round(Number(r) * 100 + 1e-9) / 100).toFixed(2))
      .replace(/\$?\b\d{3,5}(\.\d+)?\b/g, "").replace(/\s{2,}/g, " ").trim();
    n = cutAtWord(n, 60);
    if (/\b(entry|stop|take[- ]?profit|target|sl|tp\d?)\b/i.test(n)) continue; // a trade word: the name is left out
    if (n && !names.includes(n)) names.push(n);
    if (names.length >= max) break;
  }
  return names;
}

/** "three falling peaks" → "Three Falling Peaks". */
export function titleOf(name) {
  return String(name ?? "").split(/\s+/).filter(Boolean).map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

/** A zone the public may see: its role, band, strength, number of families and metric names. */
const isPublicZone = (z) => numOrNull(z?.low) !== null && numOrNull(z?.high) !== null && Number(z.low) > 0 && Number(z.high) > 0 && ROLE[z.role];
const publicZone = (z) => ({ role: ROLE[z.role], low: r2(z.low), high: r2(z.high), strength: typeof z.strength === "string" ? z.strength : null, sources: Number(z.sources) || null, metrics: zoneMetrics(z) });

/** The charts of zones_by_chart and closed (KM1). */
export const KEY_MAP_CHARTS = Object.freeze(["H1", "H4", "D1"]);
/** A chart's zone is listed when at least this many independent families stack in it (a candidate needs 3). */
export const CHART_ZONE_MIN_SOURCES = 2;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/**
 * KM1 (owner 2026-11-25: "Agent harus punya kemampuan scheduling misal pull keymap dari xauusd per 1h dan 4h dan 1D …
 * Jika waktunya sama berarti digabung"): each chart's own key-level map. `charts` is keyLevelChartsOf's
 * ({ zones: { H1, H4, D1 }, closed: { H1, H4, D1 } }, src/strategy-engine.mjs). Per chart, every zone of at least
 * CHART_ZONE_MIN_SOURCES families (or a candidate), in the zones[] shape plus `candidate` (the agent's candidate rule and
 * cap on that chart alone), sorted as zones[]; `closed` holds bar-close times only.
 */
function chartMaps(charts) {
  const zonesByChart = {}, closed = {};
  for (const chart of KEY_MAP_CHARTS) {
    const list = Array.isArray(charts?.zones?.[chart]) ? charts.zones[chart] : [];
    zonesByChart[chart] = list
      .filter((z) => isPublicZone(z) && (z.candidate === true || Number(z.sources) >= CHART_ZONE_MIN_SOURCES))
      .map((z) => ({ ...publicZone(z), candidate: z.candidate === true }))
      .sort((a, b) => b.high - a.high);
    const t = charts?.closed?.[chart];
    closed[chart] = typeof t === "string" && ISO.test(t) && Number.isFinite(Date.parse(t)) ? new Date(Date.parse(t)).toISOString() : null;
  }
  return { zones_by_chart: zonesByChart, closed };
}

/**
 * The pattern statuses the public sees. PT1 (2026-11-27): "busted" too (a one-sided pattern that closed beyond its other
 * side, chart-patterns.mjs), so CTA can post the invalidation; a busted pattern has no projection (publicProjectionOf).
 */
export const PUBLIC_PATTERN_STATUSES = Object.freeze(["forming", "confirmed", "busted"]);
/**
 * Pure: the Projection Agent's patterns (key_levels.patterns, { tf, id, status, direction, upper, lower, target, ... }) as
 * public patterns: forming, confirmed or busted, on ANALYSIS_CHARTS only, with BP1's projection (publicProjectionOf) and positive
 * lines. publicAnalysis's `patterns`, and the cheap path's (src/public-patterns.mjs, PT1), so both are the same shape.
 */
export function publicPatterns(list) {
  return (Array.isArray(list) ? list : [])
    .filter((p) => ANALYSIS_CHARTS[String(p?.tf)] && PUBLIC_PATTERN_STATUSES.includes(p?.status) && typeof p.id === "string")
    .map((p) => {
      const info = patternInfo(p.id);
      const dir = Number(p.direction) > 0 ? "up" : Number(p.direction) < 0 ? "down" : "undetermined";
      return {
        chart: ANALYSIS_CHARTS[String(p.tf)], pattern: p.id, name: titleOf(info?.name ?? p.id.replace(/_/g, " ")), chapter: info?.n ?? null,
        status: p.status, direction: dir, upper: r2(p.upper), lower: r2(p.lower),
        // The book's measure rule applied to this pattern: an analysis of where the move could reach, never a trade target.
        projection: publicProjectionOf(p),
        // The pattern's two lines as drawn (owner 2026-11-15: "gambar juga garis pattern di chart"): from the start
        // bar's close time to the last bar's, each line's price at both ends (fitted lines slope; others are flat).
        ...(typeof p.line_from === "string" && typeof p.line_to === "string" && r2(p.upper_from) != null && r2(p.lower_from) != null
          ? { lines: { from: p.line_from, to: p.line_to, upper: [r2(p.upper_from), r2(p.upper)], lower: [r2(p.lower_from), r2(p.lower)] } } : {}),
        // PT1c: the breakout's close time, only where the caller derived it (src/public-patterns.mjs); analysis() has none.
        ...(Object.hasOwn(p, "confirmed_at_ms") ? { confirmed_at_ms: p.status !== "forming" && Number.isFinite(p.confirmed_at_ms) ? p.confirmed_at_ms : null } : {}),
        // The breakout came with a weekend or daily-break gap (src/public-patterns.mjs): no confirming close, so null above.
        ...(p.breakout_after_pause === true ? { breakout_after_pause: true } : {})
      };
    })
    .filter((p) => p.upper != null && p.lower != null && p.upper > 0 && p.lower > 0);
}

/**
 * Pure: the Key Level Agent's reading (readStrategy().key_levels) and the latest structure, as public analysis. With
 * `charts` (KM1, PublicProjection.analysis() always passes it) it adds zones_by_chart and closed after the other keys;
 * without, the output is what it was before KM1, byte for byte.
 */
export function publicAnalysis(keyLevels, { structure = null, now = Date.now(), charts = undefined } = {}) {
  const kl = keyLevels && typeof keyLevels === "object" ? keyLevels : {};
  const zones = (Array.isArray(kl.candidates) ? kl.candidates : [])
    .filter(isPublicZone)
    .map(publicZone)
    .sort((a, b) => b.high - a.high);
  const patterns = publicPatterns(kl.patterns);
  const st = {};
  for (const [k, name] of [["h4", "H4"], ["h1", "H1"], ["m15", "15m"]]) {
    const s = structure?.[k];
    if (s && (s.trend || s.label)) st[name] = { trend: ["up", "down", "range"].includes(s.trend) ? s.trend : null, label: typeof s.label === "string" ? s.label.slice(0, 20) : null };
  }
  return { version: PUBLIC_ANALYSIS_VERSION, at: new Date(now).toISOString(), price: r2(kl.price), atr_h1: r2(kl.atr_h1), zones, patterns, structure: st, ...(charts === undefined ? {} : chartMaps(charts)) };
}

/** Keys an analysis may never carry, at any depth: the decision, the plan and private data. */
export const ANALYSIS_FORBIDDEN_KEYS = Object.freeze(["stance", "decision", "trade", "entry", "stop", "stop_loss", "take_profit", "tp1", "tp2", "plan", "plans", "strategy_plans", "lots", "size", "account", "balance", "equity", "omega", "reasons", "summary", "quorum", "confidence"]);
export function analysisLeaks(value, path = "") {
  const out = [];
  if (Array.isArray(value)) value.forEach((v, i) => out.push(...analysisLeaks(v, `${path}[${i}]`)));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) {
    if (ANALYSIS_FORBIDDEN_KEYS.includes(k.toLowerCase())) out.push(`${path}.${k}`);
    out.push(...analysisLeaks(v, `${path}.${k}`));
  }
  return out;
}
