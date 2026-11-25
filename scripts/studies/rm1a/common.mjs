// RM1a shared helpers: the 1m bar series (feed, with the broker's demo bars shifted by the median basis before the feed
// starts, as SV1a), the decisions and the quorum side.
import fs from "node:fs";
import path from "node:path";
// The data JSON is not kept in the repository (production rows): point RM1A_DATA at it (default ./data beside these scripts).
export const DATA = path.resolve(process.env.RM1A_DATA ?? new URL("./data", import.meta.url).pathname);
// The code the study ran against (main 738960c); default this checkout.
export const REPO = process.env.RM1A_REPO ?? new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const r3 = (x) => Math.round(x * 1000) / 1000;
export const finite = (x) => typeof x === "number" && Number.isFinite(x);
export function loadBars() {
  const j = JSON.parse(fs.readFileSync(path.join(DATA, "bars.json"), "utf8"));
  const feed = j.feed.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
  const corpus = j.corpus.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
  const at = new Map(feed.map((b) => [b.t, b]));
  const diffs = corpus.filter((b) => at.has(b.t)).map((b) => at.get(b.t).c - b.c).sort((a, b) => a - b);
  const basis = diffs.length ? Math.round(diffs[diffs.length >> 1] / 0.005) * 0.005 : 0;
  const first = feed[0].t;
  const shifted = corpus.filter((b) => b.t < first).map((b) => ({ t: b.t, o: r3(b.o + basis), h: r3(b.h + basis), l: r3(b.l + basis), c: r3(b.c + basis) }));
  const m1 = [...shifted, ...feed].sort((a, b) => a.t - b.t);
  return { m1, basis, overlap: diffs.length, feedN: feed.length, shiftedN: shifted.length, firstFeed: first };
}
export const loadDecisions = () => JSON.parse(fs.readFileSync(path.join(DATA, "decisions.json"), "utf8"));
const qPass = (d, s) => d.guardrails?.[s]?.checks?.find((c) => c.id === "quorum")?.pass === true;
/** The quorum's side: the side whose quorum check passed; both passed: the larger share (then the score's sign). */
export function quorumSide(d) {
  const L = qPass(d, "long"), S = qPass(d, "short");
  if (L && !S) return "long";
  if (S && !L) return "short";
  if (!L && !S) return null;
  const ls = d.quorum?.long_share ?? 0, ss = d.quorum?.short_share ?? 0;
  return ls > ss ? "long" : ss > ls ? "short" : (d.quorum?.score ?? 0) >= 0 ? "long" : "short";
}
export const failedOf = (d, s) => (d.guardrails?.[s]?.checks || []).filter((c) => !c.pass).map((c) => c.id);
/** Index of the 1m bar at or before t (binary search). */
export function idxAtOrBefore(m1, t) { let lo = 0, hi = m1.length - 1, ans = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (m1[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; } return ans; }
