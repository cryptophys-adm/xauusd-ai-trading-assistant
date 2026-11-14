import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { get } from "./api";
import { usePoll } from "./usePoll";
import { usePushMany } from "./push";

/** While the push hub delivers the rooms and the decision, their read is a fallback every 5 minutes (ADR-0015). */
const POLL_LIVE_MS = 300_000;
const POLL_MS = 60_000;

/** Timeframe Thread keys of /api/threads/timeframe. */
export const TF_CHARTS = ["D1", "H4", "H1"] as const;
export type TfChart = (typeof TF_CHARTS)[number];

type Ctx = {
  threads: Partial<Record<TfChart, any>>;
  news: any | null;
  m5: any | null;
  /** The Global Conclusion of the AI Worker (GET /api/conclusion/global). */
  global: any | null;
  /** The strategy engine's decision, key levels and RRR (carried by the Global Conclusion). */
  strategy: any | null;
  /** The Decision Engine's latest decision, the single SSOT (src/decision-engine.mjs of the AI Worker). */
  engine: any | null;
  /** The live Decision Engine setups with their locked levels and lifecycle (the ledger's rows). */
  setups: any[];
  loading: boolean;
  error: string | null;
};
const MarketContext = createContext<Ctx>({ threads: {}, news: null, m5: null, global: null, strategy: null, engine: null, setups: [], loading: true, error: null });

/**
 * The 1H, 4H and D1 Threads, News Daily, the 5m context and the Global Conclusion (the rooms and the conclusion pushed
 * as they change, ADR-0015), shared by
 * the center tabs and the right-hand assistant panel, so each is fetched once per refresh.
 */
export function MarketProvider({ children }: { children: ReactNode }) {
  // ADR-0015 phase 1: the rooms and the global decision come from the push hub as they conclude; their read
  // stays every 60 s until the hub has delivered both, then runs every 5 minutes as a fallback.
  const push = usePushMany(["threads", "decision"]);
  const slow = usePoll(async () => {
    const [d1, h4, h1, glob] = await Promise.all([
      ...TF_CHARTS.map((c) => get(`/api/threads/timeframe?chart=${c}`).catch(() => null)),
      get("/api/conclusion/global").catch(() => null),
    ]);
    return { threads: { D1: d1, H4: h4, H1: h1 }, decision: glob };
  }, push.live ? POLL_LIVE_MS : POLL_MS);
  // News Daily and the 5m context are not pushed yet: every 60 s, as before.
  const fast = usePoll(async () => {
    const [news, m5] = await Promise.all([get("/api/news/daily").catch(() => null), get("/api/m5-context").catch(() => null)]);
    return { news: news?.daily ?? null, m5: m5?.context ?? null };
  }, POLL_MS);
  // The newest arrival of each, read or pushed, is shown.
  const [threadsBody, setThreadsBody] = useState<any>(null);
  const [decisionBody, setDecisionBody] = useState<any>(null);
  useEffect(() => { const d = slow.data as any; if (d) { setThreadsBody(d.threads); setDecisionBody(d.decision); } }, [slow.data]);
  useEffect(() => { if (push.data.threads) setThreadsBody(push.data.threads); }, [push.data.threads]);
  useEffect(() => { if (push.data.decision) setDecisionBody(push.data.decision); }, [push.data.decision]);
  const f = fast.data as any;
  const glob = decisionBody;
  const value: Ctx = {
    threads: { D1: threadsBody?.D1?.thread ?? null, H4: threadsBody?.H4?.thread ?? null, H1: threadsBody?.H1?.thread ?? null },
    news: f?.news ?? null, m5: f?.m5 ?? null,
    global: glob?.global ?? null, strategy: glob?.global?.strategy ?? null, engine: glob?.engine ?? null, setups: Array.isArray(glob?.setups) ? glob.setups : [],
    loading: (slow.loading && !threadsBody && !decisionBody) || (fast.loading && !f),
    error: slow.error ?? fast.error,
  };
  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}

export const useMarket = () => useContext(MarketContext);

/** +1 for a bullish stance or bias, -1 for a bearish one, 0 otherwise (WAIT, HOLD, CLOSE, NEUTRAL). */
export function direction(stance?: string | null): number {
  return stance === "BUY" || stance === "BULLISH" ? 1 : stance === "SELL" || stance === "BEARISH" ? -1 : 0;
}

/**
 * The room's directional lean in [-1, 1]: the confidence-weighted mean of the biases of the agents
 * that opened successfully (their action when no bias was stored). A WAIT agent pulls the lean toward 0 with its confidence, so a room
 * that mostly waits reads as neutral even when one desk leans hard.
 */
export function roomLean(openings: any[] | undefined): number | null {
  const ok = (openings ?? []).filter((o) => o?.status === "ok" && typeof o.confidence === "number");
  const weight = ok.reduce((s, o) => s + o.confidence, 0);
  if (!ok.length || weight <= 0) return null;
  return ok.reduce((s, o) => s + direction(o.bias || o.stance) * o.confidence, 0) / weight;
}

/** Stance counts of the agents that opened successfully. */
export function stanceMix(openings: any[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of openings ?? []) if (o?.status === "ok" && o.stance) out[o.stance] = (out[o.stance] ?? 0) + 1;
  return out;
}

/** News lean in [-1, 1]: (bullish − bearish) over every tagged headline. */
export function newsLean(counts: any): number | null {
  const b = Number(counts?.bullish) || 0, s = Number(counts?.bearish) || 0, n = Number(counts?.neutral) || 0;
  return b + s + n ? (b - s) / (b + s + n) : null;
}

/** The 5m context as a lean: its bias, doubled in weight when a confirmation printed. */
export function m5Lean(m5: any): number | null {
  if (!m5) return null;
  if (m5.buy_confirmed) return 1;
  if (m5.sell_confirmed) return -1;
  return direction(m5.bias) * 0.5;
}

/** Plain label of a lean. */
export function leanLabel(v: number | null | undefined): string {
  if (v == null) return "no data";
  const a = Math.abs(v);
  const side = v > 0 ? "bullish" : "bearish";
  // The quorum's own band (src/decision-engine.mjs LEAN): below it a witness has no direction.
  return a < 0.15 ? "neutral" : a < 0.3 ? `slightly ${side}` : a < 0.6 ? side : `strongly ${side}`;
}

const ACTION_ONLY = /\b(consensus|settles?|agrees?|stay flat|no (directional )?entry|confirmation rule)\b|^(the )?(room|moderator|h1 decision)\b/i;

/**
 * One line that says something about the market rather than the action: the first sentence of
 * the summary or reasons that is not only about the room's WAIT, else the first sentence.
 */
export function interpretation(c: any): string | null {
  if (!c || c.status !== "ok") return null;
  const sentences = [...String(c.summary ?? "").split(/(?<=[.!?])\s+/), ...(Array.isArray(c.reasons) ? c.reasons : [])].map((x) => String(x).trim()).filter(Boolean);
  return sentences.find((x) => !ACTION_ONLY.test(x)) ?? sentences[0] ?? null;
}

/** First sentence of a summary, for a one-line interpretation. */
export function firstSentence(text?: string | null): string | null {
  if (!text) return null;
  const m = String(text).match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : String(text)).trim();
}
