// Swing structure per timeframe (owner 2026-11-12: "ya kerjakan semua nomor jika memang lebih baik"; the
// strip "H4 LH/LL · H1 LH/LL · 15m HH/HL" beside the Decision Engine's decision). Display only: it is
// neither a witness nor a guardrail, the council does not read it, and no price leaves this module: only
// the labels of the last two confirmed swing highs and lows (src/chart-patterns.mjs zigzag, the same turns
// the Projection Agent reads).
import { normBars, zigzag } from "./chart-patterns.mjs";

export const STRUCTURE_LABELS = Object.freeze({ "HH/HL": "up", "LH/LL": "down", "HH/LL": "expanding", "LH/HL": "contracting" });

/**
 * Pure: the swing structure of closed bars (oldest first): the last two confirmed swing highs compared
 * (HH or LH) and the last two confirmed swing lows (HL or LL), from 2-bar fractals. { label, trend } or
 * null when fewer than two confirmed highs and two confirmed lows exist.
 */
export function swingStructure(bars) {
  const turns = zigzag(normBars(bars)).filter((t) => !t.prov);
  const highs = turns.filter((t) => t.t === "H").slice(-2), lows = turns.filter((t) => t.t === "L").slice(-2);
  if (highs.length < 2 || lows.length < 2) return null;
  const label = `${highs[1].p > highs[0].p ? "HH" : "LH"}/${lows[1].p > lows[0].p ? "HL" : "LL"}`;
  return { label, trend: STRUCTURE_LABELS[label] };
}

/** Pure: the structure of the engine's 4H, 1H and 15m bars ({ h4, h1, m15 }, each null when unknown). */
export function marketStructure({ h4Bars = [], h1Bars = [], m15Bars = [] } = {}) {
  return { h4: swingStructure(h4Bars), h1: swingStructure(h1Bars), m15: swingStructure(m15Bars) };
}
