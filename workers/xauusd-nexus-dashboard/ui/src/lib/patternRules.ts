// The pattern agents' rules on the Chart patterns page (Track C3): each family's label, entry and stop as its agent
// trades them (src/strategy-agents.mjs PATTERN_FAMILIES and patternInside, kept equal by
// test/nexus-chart-patterns-page.test.mjs), and a plan's notes worded from them, never typed per plan. Pure: no React,
// no request. Kept apart from lib/intel.ts, whose strings carry no order word (the Liquidity page's rule).
import { str, words } from "./intel";

/** The charts the pattern agents trade (src/strategy-agents.mjs AGENT_RULES.pattern.charts). */
export const PATTERN_AGENT_CHARTS: readonly string[] = ["15", "60"];

/**
 * Each pattern family's rule as its agent trades it (src/strategy-agents.mjs PATTERN_FAMILIES: the label, the entry and
 * the stop; test/nexus-chart-patterns-page.test.mjs keeps the two equal). A plan's notes on the page are worded from
 * this rule, never typed per plan: "retest" enters on the return to the broken line (the throwback), "momentum" near
 * the breakout; the stop beyond the pattern's other line, or a share of its height behind the broken line, at most
 * `cap` times the 1H ATR.
 */
export type FamilyRule = { label: string; entry: "retest" | "momentum"; stop: { other?: boolean; height?: number; cap: number } };
export const PATTERN_FAMILY_RULES: Record<string, FamilyRule> = {
  peaks: { label: "Reversal tops and bottoms", entry: "retest", stop: { height: 0.5, cap: 1.25 } },
  lines: { label: "Triangles, wedges and rectangles", entry: "retest", stop: { other: true, cap: 1 } },
  curve: { label: "Rounded turns", entry: "retest", stop: { height: 0.33, cap: 1.25 } },
  bars: { label: "Spike pairs", entry: "retest", stop: { other: true, cap: 1.25 } },
  pole: { label: "Flags and pennants", entry: "momentum", stop: { other: true, cap: 1 } },
  gaps: { label: "Gaps and islands", entry: "retest", stop: { other: true, cap: 1 } },
  legs: { label: "Measured moves", entry: "momentum", stop: { other: true, cap: 1.25 } },
  event: { label: "Release patterns", entry: "momentum", stop: { other: true, cap: 1.25 } }
};
/** Inside the pattern (src/strategy-agents.mjs patternInside): a forming pattern's swing from one line to the other. */
export const INSIDE_AGENT = { id: "pattern_inside", label: "Inside the pattern" } as const;

/** A pattern agent's family ("pattern_lines" is "lines"), or null (pattern_inside has none of its own). */
export const familyOf = (agent: unknown): string | null => { const a = str(agent); return a && a.startsWith("pattern_") && a.slice(8) in PATTERN_FAMILY_RULES ? a.slice(8) : null; };
/** A pattern agent's label from its rule (the page prefers /api/strategy-agents' own label when it has one). */
export const agentLabel = (agent: unknown): string => { const f = familyOf(agent); return f ? PATTERN_FAMILY_RULES[f].label : agent === INSIDE_AGENT.id ? INSIDE_AGENT.label : words(agent); };

const share = (x: number) => (x === 0.5 ? "half" : x === 0.33 ? "a third of" : `${x} times`);
/**
 * A plan's notes from its agent's rule: the entry's label and note (the throwback, or price already at the line) and
 * the stop's note. Pure; `atLevel` is the plan's at_level.
 */
export function planNotes(agent: unknown, atLevel: unknown): { entry: string; entryNote: string; stopNote: string } {
  const f = familyOf(agent);
  if (f) {
    const r = PATTERN_FAMILY_RULES[f];
    const at = atLevel === true;
    const entry = r.entry === "retest" && !at ? "Entry (throwback)" : "Entry";
    const entryNote = r.entry === "retest"
      ? (at ? "price is at the broken line" : "return to the broken line")
      : (at ? "price is near the breakout" : "the broken line, near the breakout");
    const stopNote = `${r.stop.other ? "beyond the other line" : `${share(r.stop.height ?? 0.5)} the pattern's height behind the broken line`}, at most ${r.stop.cap} ATR (1H)`;
    return { entry, entryNote, stopNote };
  }
  if (agent === INSIDE_AGENT.id) return { entry: "Entry", entryNote: "at the line it leans on, toward the other line", stopNote: "just beyond the line it leans on" };
  return { entry: "Entry", entryNote: "the agent's plan", stopNote: "the agent's plan" };
}

