/**
 * The badge of "Workers and lanes" on System status (review of #520): pure, no imports, so
 * test/nexus-poll-states.test.mjs runs it in Node. "all nominal" only when both reads are live; a failed or stale
 * /api/status (or /api/local-lane) never reads as nominal, because its rows are missing or old.
 */
export type ReadState = "live" | "stale" | "error" | "checking" | "loading" | "idle";
/** The status tones (as the header): fault red, late amber, ok cyan, off grey. Green is for bullish only. */
export type BadgeTone = "fault" | "late" | "ok" | "off";

export function overviewBadge({ bad, warn, status, lane }: { bad: number; warn: number; status: ReadState; lane: ReadState }): { tone: BadgeTone; text: string } {
  if (bad) return { tone: "fault", text: `${bad} down` };
  if (status === "error") return { tone: "fault", text: "status unknown" };
  if (lane === "error") return { tone: "fault", text: "lane unknown" };
  if (status === "stale" || lane === "stale") return { tone: "late", text: warn ? `${warn} need attention · stale` : status === "stale" ? "status stale" : "lane stale" };
  if (warn) return { tone: "late", text: `${warn} need attention` };
  if (status !== "live" || lane !== "live") return { tone: "off", text: "checking" };
  return { tone: "ok", text: "all nominal" };
}
