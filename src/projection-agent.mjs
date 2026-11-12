// The Projection Agent in the rooms (owner 2026-11-12: "Projection Agent sekarang harus masuk ke room").
// It already gave the Key Level Agent its levels (Fibonacci, the probability cone, trendlines, PA levels,
// and the chart and event patterns); now it also speaks as a desk agent in the 15m Live War Room and the
// 1H, 4H and D1 rooms, from the same readings of the room's own chart:
//   - the chart patterns of the room's last 60 closed bars (src/chart-patterns.mjs detectPatterns, the
//     detector the Key Level Agent runs), each with its measured record on gold
//     (src/pattern-calibration.mjs) when one exists;
//   - the projection levels of the chart's HUD snapshot plane (src/level-readers.mjs projectionLevels).
// A room never states price levels (ROOM_RULES), so its data carries no price: every level is a
// distance from the last close in average bar ranges, above or below.
import { detectPatterns, meanRange, normBars } from "./chart-patterns.mjs";
import { projectionLevels } from "./level-readers.mjs";

export const PROJECTION_WINDOW = 60;
const num = (x) => typeof x === "number" && Number.isFinite(x);
const r2 = (x) => Math.round(x * 100) / 100;
const DIRECTION = { 1: "broke out upward", "-1": "broke out downward", 0: "not broken out yet" };

/**
 * Pure: the Projection Agent's data for one room: the chart's patterns and projection levels, each as a
 * distance from the last close in average bar ranges (never a price). `bars` are the chart's closed bars
 * (oldest first); `plane` the chart plane of its HUD snapshot (or null); `calibration` the stored
 * pattern calibration (or null).
 */
export function projectionReading({ bars = [], plane = null, calibration = null, timeframe = "" } = {}) {
  const recent = (Array.isArray(bars) ? bars : []).slice(-PROJECTION_WINDOW);
  const b = normBars(recent);
  const close = b.at(-1)?.c;
  const range = b.length >= 2 ? meanRange(b) : null;
  if (!num(close) || !num(range) || range <= 0) return { timeframe, available: false, note: "not enough closed bars" };
  const away = (price) => (num(price) ? { side: price > close ? "above" : price < close ? "below" : "at", ranges: r2(Math.abs(price - close) / range) } : null);
  let found = [];
  try { found = detectPatterns(recent); } catch { found = []; }
  const patterns = found.map((p) => {
    const rec = calibration?.patterns?.[p.id];
    return {
      pattern: p.name, status: p.status, direction: DIRECTION[p.direction] ?? DIRECTION[0], bars_since_last_turn: p.bars_ago,
      upper_line: away(p.upper), lower_line: away(p.lower), measured_target: away(p.target),
      ...(rec ? { record_on_gold: { breakouts: rec.n, reached_target_pct: Math.round(rec.rate * 100), weight_factor: rec.factor, measured_enough: rec.active } } : {})
    };
  });
  const levels = projectionLevels(plane).map((l) => ({ level: l.label, ...away(l.price) })).filter((l) => l.side);
  return {
    timeframe, available: patterns.length > 0 || levels.length > 0, unit: "distance from the last close in average bar ranges",
    patterns, levels,
    ...(calibration?.base_rate != null ? { all_patterns_reached_target_pct: Math.round(calibration.base_rate * 100) } : {})
  };
}
