// The public analysis, real time (owner 2026-11-14, for the Threads account xauusd-ai-cta: "fokus pada hasil
// analytics dan key level. Tidak boleh ada advices buy/sell, kecuali info buy/sell zone"; then "Real-time,
// hanya analisa"). What the content engine may show the moment it forms:
//   - the Key Level Agent's candidate zones (where the key levels of every chart stack), as demand zones
//     (below the price, "area beli") and supply zones (above it, "area jual"), information only;
//   - the Projection Agent's chart patterns on H1, H4 and D1 (forming or confirmed), by their catalogue name,
//     with their breakout lines, the line that undoes them and the pattern's measured projection;
//   - the market structure per chart (trend and swing label).
// What it never holds: the system's decision (BUY, SELL, WAIT), the council's reasons, a plan, an entry, a
// stop, a target for a trade, a lot, the account or Omega. Decisions stay in the delayed recap only
// (src/public-projection.mjs, 24 hours). Pure; the AI Worker serves it through PublicProjection.analysis().
import { patternInfo } from "./chart-patterns.mjs";

export const PUBLIC_ANALYSIS_VERSION = "cryptophys.public-analysis.v1";
/** The charts whose patterns may be posted, and their public names. */
export const ANALYSIS_CHARTS = Object.freeze({ "60": "H1", "240": "H4", D: "D1", "1D": "D1" });
const r2 = (x) => (Number.isFinite(Number(x)) ? Math.round(Number(x) * 100) / 100 : null);
const ROLE = Object.freeze({ support: "demand", resistance: "supply", "at price": "at_price" });

/** "three falling peaks" → "Three Falling Peaks". */
export function titleOf(name) {
  return String(name ?? "").split(/\s+/).filter(Boolean).map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

/** Pure: the Key Level Agent's reading (readStrategy().key_levels) and the latest structure, as public analysis. */
export function publicAnalysis(keyLevels, { structure = null, now = Date.now() } = {}) {
  const kl = keyLevels && typeof keyLevels === "object" ? keyLevels : {};
  const zones = (Array.isArray(kl.candidates) ? kl.candidates : [])
    .filter((z) => Number.isFinite(Number(z?.low)) && Number.isFinite(Number(z?.high)) && ROLE[z.role])
    .map((z) => ({ role: ROLE[z.role], low: r2(z.low), high: r2(z.high), strength: typeof z.strength === "string" ? z.strength : null, sources: Number(z.sources) || null }))
    .sort((a, b) => b.high - a.high);
  const patterns = (Array.isArray(kl.patterns) ? kl.patterns : [])
    .filter((p) => ANALYSIS_CHARTS[String(p?.tf)] && ["forming", "confirmed"].includes(p?.status) && typeof p.id === "string")
    .map((p) => {
      const info = patternInfo(p.id);
      const dir = Number(p.direction) > 0 ? "up" : Number(p.direction) < 0 ? "down" : "undetermined";
      return {
        chart: ANALYSIS_CHARTS[String(p.tf)], pattern: p.id, name: titleOf(info?.name ?? p.id.replace(/_/g, " ")), chapter: info?.n ?? null,
        status: p.status, direction: dir, upper: r2(p.upper), lower: r2(p.lower),
        // The book's measure rule applied to this pattern: an analysis of where the move could reach, never a trade target.
        projection: p.status === "confirmed" ? r2(p.target) : null
      };
    })
    .filter((p) => p.upper != null && p.lower != null);
  const st = {};
  for (const [k, name] of [["h4", "H4"], ["h1", "H1"], ["m15", "15m"]]) {
    const s = structure?.[k];
    if (s && (s.trend || s.label)) st[name] = { trend: ["up", "down", "range"].includes(s.trend) ? s.trend : null, label: typeof s.label === "string" ? s.label.slice(0, 20) : null };
  }
  return { version: PUBLIC_ANALYSIS_VERSION, at: new Date(now).toISOString(), price: r2(kl.price), atr_h1: r2(kl.atr_h1), zones, patterns, structure: st };
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
