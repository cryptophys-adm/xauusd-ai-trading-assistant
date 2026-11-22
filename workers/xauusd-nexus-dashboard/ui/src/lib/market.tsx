import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { errorText, get } from "./api";
import { usePoll, type Poll } from "./usePoll";
import { usePushMany } from "./push";
import { isStale, withPush } from "./pollState";

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
  /**
   * The reads that failed on their latest try, by path (e.g. "/api/news/daily" → "/api/news/daily 502"): each read
   * keeps its own catch, so one failure never blanks the others, and a tab can tell a failed read from an empty one.
   */
  failed: Record<string, string>;
  /** The last good answer of each read, by path (ms, the browser clock). */
  okAt: Record<string, number>;
  /** The retry cadence of the read at a path (ms). */
  intervalOf: (path: string) => number;
  /**
   * One read as a poll (review of #520): the last good answer of that path (a failed read keeps it on screen), its
   * error, times and failures, so a panel shows it with the shared tag, error box and Retry now.
   */
  pollOf: (path: string) => Poll;
  /** A read is in flight. */
  busy: boolean;
  /** Read everything again now (joins the reads in flight: repeated clicks start no parallel reads). */
  retry: () => Promise<void>;
};
const idlePoll: Poll = { data: null, error: null, loading: true, refresh: () => {}, lastOk: null, lastFail: null, failures: 0, stale: false, intervalMs: 0 };
const MarketContext = createContext<Ctx>({ threads: {}, news: null, m5: null, global: null, strategy: null, engine: null, setups: [], loading: true, error: null, failed: {}, okAt: {}, intervalOf: () => 0, pollOf: () => idlePoll, busy: false, retry: async () => {} });

/** The paths of the reads, so a tab names the one it shows. */
export const NEWS_PATH = "/api/news/daily";
export const M5_PATH = "/api/m5-context";
export const GLOBAL_PATH = "/api/conclusion/global";
export const threadPath = (c: TfChart) => `/api/threads/timeframe?chart=${c}`;

/** What is known of one path's reads (ms, the browser clock). */
type PathFacts = { lastOk: number | null; lastFail: number | null; error: string | null; failures: number };
const noFacts: PathFacts = { lastOk: null, lastFail: null, error: null, failures: 0 };

/**
 * The 1H, 4H and D1 Threads, News Daily, the 5m context and the Global Conclusion (the rooms and the conclusion pushed
 * as they change, ADR-0015), shared by
 * the center tabs and the right-hand assistant panel, so each is fetched once per refresh.
 *
 * Review of #520: a failed read keeps that path's last good answer on screen (it used to blank the Decision Engine
 * card on a later 502), and each path has its own facts, so `pollOf(path)` marks it stale or shows its error.
 */
export function MarketProvider({ children }: { children: ReactNode }) {
  // ADR-0015 phase 1: the rooms and the global decision come from the push hub as they conclude; their read
  // stays every 60 s until the hub has delivered both, then runs every 5 minutes as a fallback.
  const push = usePushMany(["threads", "decision"]);
  // Each read keeps its own catch (one failure never blanks the others) and records what failed and when.
  const facts = useRef<Record<string, PathFacts>>({});
  const read = (path: string, failed: Record<string, string>) =>
    get(path).then((v) => {
      facts.current[path] = { lastOk: Date.now(), lastFail: facts.current[path]?.lastFail ?? null, error: null, failures: 0 };
      return v;
    }, (e) => {
      const was = facts.current[path] ?? noFacts;
      failed[path] = errorText(e);
      facts.current[path] = { ...was, lastFail: Date.now(), error: failed[path], failures: was.failures + 1 };
      return null;
    });
  const slowMs = push.live ? POLL_LIVE_MS : POLL_MS;
  const slow = usePoll(async () => {
    const failed: Record<string, string> = {};
    const [d1, h4, h1, glob] = await Promise.all([
      ...TF_CHARTS.map((c) => read(threadPath(c), failed)),
      read(GLOBAL_PATH, failed),
    ]);
    return { threads: { D1: d1, H4: h4, H1: h1 }, decision: glob, failed };
  }, slowMs);
  // News Daily and the 5m context are not pushed yet: every 60 s, as before.
  const fast = usePoll(async () => {
    const failed: Record<string, string> = {};
    const [news, m5] = await Promise.all([read(NEWS_PATH, failed), read(M5_PATH, failed)]);
    return { news: news?.daily ?? null, m5: m5?.context ?? null, failed };
  }, POLL_MS);
  // The newest arrival of each, read or pushed, is shown; a failed read leaves the last good one in place.
  const [threadsBody, setThreadsBody] = useState<Partial<Record<TfChart, any>>>({});
  const [decisionBody, setDecisionBody] = useState<any>(null);
  const [fastBody, setFastBody] = useState<{ news: any; m5: any } | null>(null);
  const [pushAt, setPushAt] = useState<{ threads: number | null; decision: number | null }>({ threads: null, decision: null });
  useEffect(() => {
    const d = slow.data as any;
    if (!d) return;
    const got: Partial<Record<TfChart, any>> = {};
    for (const c of TF_CHARTS) if (!d.failed[threadPath(c)]) got[c] = d.threads[c];
    if (Object.keys(got).length) setThreadsBody((prev) => ({ ...prev, ...got }));
    if (!d.failed[GLOBAL_PATH]) setDecisionBody(d.decision);
  }, [slow.data]);
  useEffect(() => {
    const d = fast.data as any;
    if (!d) return;
    setFastBody((prev) => ({ news: d.failed[NEWS_PATH] ? prev?.news ?? null : d.news, m5: d.failed[M5_PATH] ? prev?.m5 ?? null : d.m5 }));
  }, [fast.data]);
  useEffect(() => { if (push.data.threads) { setThreadsBody((prev) => ({ ...prev, ...push.data.threads })); setPushAt((p) => ({ ...p, threads: Date.now() })); } }, [push.data.threads]);
  useEffect(() => { if (push.data.decision) { setDecisionBody(push.data.decision); setPushAt((p) => ({ ...p, decision: Date.now() })); } }, [push.data.decision]);
  const glob = decisionBody;
  const busy = !!(slow.busy || fast.busy);
  const retry = async () => { await Promise.all([slow.refresh(), fast.refresh()]); };
  const intervalOf = (path: string) => (path === NEWS_PATH || path === M5_PATH ? POLL_MS : slowMs);
  const dataOf = (path: string): unknown => {
    if (path === GLOBAL_PATH) return glob;
    if (path === NEWS_PATH) return fastBody?.news ?? null;
    if (path === M5_PATH) return fastBody?.m5 ?? null;
    const c = TF_CHARTS.find((x) => threadPath(x) === path);
    return c ? threadsBody[c]?.thread ?? null : null;
  };
  const pollOf = (path: string): Poll => {
    const own = facts.current[path] ?? noFacts;
    const pushed = path === GLOBAL_PATH ? pushAt.decision : path.startsWith("/api/threads/timeframe") ? pushAt.threads : null;
    const f = withPush(own, pushed);
    const data = dataOf(path);
    const intervalMs = intervalOf(path);
    const isFast = path === NEWS_PATH || path === M5_PATH;
    const p = isFast ? fast : slow;
    return {
      data, error: f.error, lastOk: f.lastOk, lastFail: f.lastFail, failures: f.failures, intervalMs,
      loading: p.loading && data == null, busy, refresh: retry,
      stale: isStale({ hasData: data != null, error: f.error, lastOk: f.lastOk, intervalMs }, Date.now()),
    };
  };
  const failed: Record<string, string> = {};
  const okAt: Record<string, number> = {};
  for (const [path, f] of Object.entries(facts.current)) {
    if (f.error) failed[path] = f.error;
    if (f.lastOk != null) okAt[path] = f.lastOk;
  }
  const f = fastBody;
  const value: Ctx = {
    threads: { D1: threadsBody.D1?.thread ?? null, H4: threadsBody.H4?.thread ?? null, H1: threadsBody.H1?.thread ?? null },
    news: f?.news ?? null, m5: f?.m5 ?? null,
    global: glob?.global ?? null, strategy: glob?.global?.strategy ?? null, engine: glob?.engine ?? null, setups: Array.isArray(glob?.setups) ? glob.setups : [],
    loading: (slow.loading && !Object.keys(threadsBody).length && !decisionBody) || (fast.loading && !f),
    error: slow.error ?? fast.error,
    failed, okAt, intervalOf, pollOf, busy, retry,
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
