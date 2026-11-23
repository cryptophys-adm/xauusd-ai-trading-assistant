// The strategy agents' confidence as the signal carries it and Omega reads it (owner 2026-11-16,
// docs/RFC_STRATEGY_EXECUTION.md). Kept apart from src/strategy-agents.mjs so the Omega Worker reads it without the
// strategy engine. Pure.

/** A 15m change within this many points (on the 0-1 scale) is "stable". */
export const CONFIDENCE_STABLE_BAND = 0.02;
/**
 * CH1, the change threshold of a confidence (owner 2026-11-23: "supaya tidak terlalu dini, perubahan confluence dan
 * confidence perlu threshold atau ambang perubahan"; "Live semua (Rekomendasi)"): with the Omega setting
 * change_thresholds' token `conf` on (src/change-thresholds.mjs), a drop or a rise needs a change of at least this
 * much; about 89% of the 15m changes are 0.00-0.02 of score noise.
 */
export const CONFIDENCE_CHANGE_MIN = 0.05;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Pure: the 15m change of a confidence: "rising", "stable", "drop", or "unknown" without both values. Without `min`,
 * a change beyond CONFIDENCE_STABLE_BAND (today's rule); with `min` (CH1's CONFIDENCE_CHANGE_MIN), a change of at
 * least `min` either way, measured without the 2-place rounding (0.049 is stable, 0.05 is a drop).
 */
export function confidenceTrend(now, prev, { min = null } = {}) {
  if (!isNum(now) || !isNum(prev)) return "unknown";
  if (isNum(min) && min > 0) {
    const c = Math.round((now - prev) * 1e9) / 1e9;
    return c >= min - 1e-9 ? "rising" : c <= -min + 1e-9 ? "drop" : "stable";
  }
  // Rounded to the confidences' 2 places: 0.60 - 0.62 is a hair below -0.02 in floating point.
  const d = r2(now - prev);
  return d > CONFIDENCE_STABLE_BAND ? "rising" : d < -CONFIDENCE_STABLE_BAND ? "drop" : "stable";
}

/** Pure: the confidences as one flat string for the signal ("id:long:short" joined by ","), "" without any. */
export function flatConfidences(conf) {
  return Object.entries(conf && typeof conf === "object" ? conf : {}).filter(([, v]) => isNum(v?.long) && isNum(v?.short)).map(([id, v]) => `${id}:${v.long}:${v.short}`).join(",");
}

/** Pure: the flat string back ({ id: { long, short } }); unreadable parts are skipped. */
export function parseConfidences(text) {
  const out = {};
  for (const part of String(text ?? "").split(",")) {
    const [id, l, sh] = part.split(":");
    const long = Number(l), short = Number(sh);
    if (id && l !== "" && sh !== "" && l !== undefined && sh !== undefined && Number.isFinite(long) && Number.isFinite(short)) out[id] = { long, short };
  }
  return out;
}
