/**
 * The badge of "Workers and lanes" on System status (review of #520): pure, no imports, so
 * test/nexus-poll-states.test.mjs runs it in Node. "all nominal" only when both reads are live; a failed or stale
 * /api/status (or /api/local-lane) never reads as nominal, because its rows are missing or old.
 */
export type ReadState = "live" | "stale" | "error" | "checking" | "loading" | "idle";
export type BadgeTone = "red" | "amber" | "green" | "slate";

export function overviewBadge({ bad, warn, status, lane }: { bad: number; warn: number; status: ReadState; lane: ReadState }): { tone: BadgeTone; text: string } {
  if (bad) return { tone: "red", text: `${bad} down` };
  if (status === "error") return { tone: "red", text: "status unknown" };
  if (lane === "error") return { tone: "red", text: "lane unknown" };
  if (status === "stale" || lane === "stale") return { tone: "amber", text: warn ? `${warn} need attention · stale` : status === "stale" ? "status stale" : "lane stale" };
  if (warn) return { tone: "amber", text: `${warn} need attention` };
  if (status !== "live" || lane !== "live") return { tone: "slate", text: "checking" };
  return { tone: "green", text: "all nominal" };
}
