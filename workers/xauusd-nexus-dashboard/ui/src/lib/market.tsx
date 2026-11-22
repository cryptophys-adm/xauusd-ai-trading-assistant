import { createContext, useContext, useEffect, useReducer, useRef, type ReactNode } from "react";
import { errorText, type ApiError } from "./api";
import { readDated, useSchedule, type Poll } from "./usePoll";
import { usePushMany } from "./push";
import { STALE_TICK_MS, emptyRoute, isStale, joinsInFlight, localNow, nextSeq, pageServer, routeFacts, routePushed, routeSent, routeSettled, type ReadOutcome, type RouteState } from "./pollState";

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
  /** The first failed route's error (see `failed`), null when none failed. */
  error: string | null;
  /**
   * The reads that failed on their latest try, by path (e.g. "/api/news/daily" → "/api/news/daily 502"): each read
   * keeps its own catch, so one failure never blanks the others, and a tab can tell a failed read from an empty one.
   */
  failed: Record<string, string>;
  /** The last good arrival of each read, by path (ms, the steady local clock localNow). */
  okAt: Record<string, number>;
  /** The retry cadence of the read at a path (ms). */
  intervalOf: (path: string) => number;
  /**
   * One read as a poll (review of #520): the last good answer of that path (a failed read keeps it on screen), its
   * error, times and failures, so a panel shows it with the shared tag, error box and Retry now. Its `busy` and
   * `refresh` are that path's own (re-review): Retry now reads that path again, past a hung read of it.
   */
  pollOf: (path: string) => Poll;
  /** A read of some path is in flight. */
  busy: boolean;
  /** Read every path again now (each joins only a read of its own sent within RETRY_JOIN_MS: a double click starts one). */
  retry: () => Promise<void>;
};
const idlePoll: Poll = { data: null, error: null, loading: true, refresh: () => {}, lastOk: null, lastFail: null, failures: 0, stale: false, intervalMs: 0 };
const MarketContext = createContext<Ctx>({ threads: {}, news: null, m5: null, global: null, strategy: null, engine: null, setups: [], loading: true, error: null, failed: {}, okAt: {}, intervalOf: () => 0, pollOf: () => idlePoll, busy: false, retry: async () => {} });

/** The paths of the reads, so a tab names the one it shows. */
export const NEWS_PATH = "/api/news/daily";
export const M5_PATH = "/api/m5-context";
export const GLOBAL_PATH = "/api/conclusion/global";
export const threadPath = (c: TfChart) => `/api/threads/timeframe?chart=${c}`;

/** The pushed reads (the rooms and the decision, ADR-0015), every 60 s or 5 minutes; the others every 60 s. */
const SLOW_PATHS = [...TF_CHARTS.map(threadPath), GLOBAL_PATH];
const FAST_PATHS = [NEWS_PATH, M5_PATH];
const ALL_PATHS = [...SLOW_PATHS, ...FAST_PATHS];

/** What a panel shows of a route's body: News Daily's `daily`, the 5m `context`, a room's `thread`, the decision whole. */
function shownOf(path: string, body: any): unknown {
  if (path === GLOBAL_PATH) return body ?? null;
  if (path === NEWS_PATH) return body?.daily ?? null;
  if (path === M5_PATH) return body?.context ?? null;
  return body?.thread ?? null;
}

/**
 * The 1H, 4H and D1 Threads, News Daily, the 5m context and the Global Conclusion (the rooms and the conclusion pushed
 * as they change, ADR-0015), shared by
 * the center tabs and the right-hand assistant panel, so each is fetched once per refresh.
 *
 * Review of #520: a failed read keeps that path's last good answer on screen (it used to blank the Decision Engine
 * card on a later 502), and each path has its own facts, so `pollOf(path)` marks it stale or shows its error.
 *
 * Re-review of #520 (lib/pollState.ts RouteState):
 * - each path applies its own answer as it resolves, and records lastOk only then: a hung sibling read (D1's room)
 *   no longer holds the decision back while it reads as live;
 * - `busy` and Retry now are per path.
 *
 * Third review of #520: one local order for reads and pushes (nextSeq, taken when a read is sent and when a push
 * arrives; never a wall clock, never the hub's `at` against a browser time):
 * - a settled read replaces the data unless a push arrived after it was sent; a push replaces it unless the hub's
 *   `at` marks it a replay older than what is on screen (pushApplies);
 * - lastOk is the steady local time (localNow) of the last good arrival, a read's settle or a push's arrival, so a
 *   push applied before a later failed read keeps its age; only clearing the error needs the push to have arrived
 *   after the failed read was sent (withPush);
 * - Retry now joins only a read sent within RETRY_JOIN_MS, else sends a new one, even during a hang.
 *
 * Fourth review of #520:
 * - a hub replay may show data, but never clears an error or moves lastOk; its age is its `at` on the server clock
 *   (the reads' `Date`, pageServer), unknown (stale, the plan hidden) until a read brings a Date;
 * - a replay replaces a read's data only when its `at` is newer than that read's `Date` (less 1 s), in either
 *   arrival order (a read in flight is compared when it settles); a live push keeps the f42efc2 rule;
 * - a forward clock jump reads every path once at once (useSchedule), skipping a path whose read is in flight.
 */
export function MarketProvider({ children }: { children: ReactNode }) {
  // ADR-0015 phase 1: the rooms and the global decision come from the push hub as they conclude; their read
  // stays every 60 s until the hub has delivered both, then runs every 5 minutes as a fallback.
  const push = usePushMany(["threads", "decision"]);
  const routes = useRef<Record<string, RouteState>>({});
  const flights = useRef<Record<string, { since: number; p: Promise<void> }>>({});
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const route = (path: string): RouteState => routes.current[path] ?? emptyRoute;
  const slowMs = push.live ? POLL_LIVE_MS : POLL_MS;
  const intervalOf = (path: string) => (FAST_PATHS.includes(path) ? POLL_MS : slowMs);

  // One read of one path: its own catch, its own settle. A failed read records what failed and when and keeps the
  // data as it was (routeSettled never sets it to null); a read overtaken by a newer settled one is dropped.
  const read = (path: string): Promise<void> => {
    const id = nextSeq();
    routes.current[path] = routeSent(route(path), id);
    const settle = (r: ReadOutcome) => { routes.current[path] = routeSettled(route(path), id, r); bump(); };
    const p = readDated(path).then(
      (r) => settle({ ok: true, data: r.data, at: localNow(), date: r.date }),
      (e) => settle({ ok: false, error: errorText(e), at: localNow(), date: (e as ApiError)?.date ?? null }),
    );
    flights.current[path] = { since: localNow(), p };
    void p.then(() => { if (flights.current[path]?.p === p) delete flights.current[path]; });
    bump();
    return p;
  };
  /** Retry now for one path: joins its read in flight while younger than RETRY_JOIN_MS, else sends a new one. */
  const refresh = (path: string): Promise<void> => {
    const f = flights.current[path];
    return f && joinsInFlight(f.since, localNow()) ? f.p : read(path);
  };
  const retry = async () => { await Promise.all(ALL_PATHS.map(refresh)); };

  // The stale verdicts follow the clock: a coarse tick (and the tab coming back) renders when one of them changed.
  const staleOf = (path: string, t: number) => {
    const f = routeFacts(route(path), pageServer.offset());
    return isStale({ hasData: shownOf(path, route(path).data) != null, ...f, intervalMs: intervalOf(path) }, t);
  };
  const staleSig = (t: number) => ALL_PATHS.map((p) => (staleOf(p, t) ? "1" : "0")).join("");
  const now = localNow();
  const sig = useRef({ shown: "", of: staleSig });
  sig.current = { shown: staleSig(now), of: staleSig };
  useEffect(() => {
    const check = () => { if (sig.current.of(localNow()) !== sig.current.shown) bump(); };
    const t = window.setInterval(check, STALE_TICK_MS);
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  // A forward clock jump: each path once at once, unless its read is in flight (single-flight).
  const inFlight = (p: string) => route(p).sent > route(p).settled;
  useSchedule(() => { for (const p of SLOW_PATHS) void read(p); }, slowMs, () => { for (const p of SLOW_PATHS) if (!inFlight(p)) void read(p); });
  // News Daily and the 5m context are not pushed yet: every 60 s, as before.
  useSchedule(() => { for (const p of FAST_PATHS) void read(p); }, POLL_MS, () => { for (const p of FAST_PATHS) if (!inFlight(p)) void read(p); });

  // A push: each room and the decision, by its arrival (routePushed; the hub's `at` only keeps a replay out).
  const threadsSnap = push.snap.threads ?? null;
  const decisionSnap = push.snap.decision ?? null;
  useEffect(() => {
    if (!threadsSnap) return;
    for (const c of TF_CHARTS) routes.current[threadPath(c)] = routePushed(route(threadPath(c)), threadsSnap.data?.[c] ?? null, threadsSnap);
    bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadsSnap]);
  useEffect(() => {
    if (!decisionSnap) return;
    routes.current[GLOBAL_PATH] = routePushed(route(GLOBAL_PATH), decisionSnap.data, decisionSnap);
    bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisionSnap]);

  const pollOf = (path: string): Poll => {
    const s = route(path);
    const f = routeFacts(s, pageServer.offset());
    const data = shownOf(path, s.data);
    const intervalMs = intervalOf(path);
    return {
      data, error: f.error, lastOk: f.lastOk, lastFail: f.lastFail, failures: f.failures, intervalMs,
      replayed: f.replayed ?? false, replayAt: f.replayAt ?? null,
      loading: data == null && s.settled === 0, busy: s.sent > s.settled, refresh: () => refresh(path),
      stale: isStale({ hasData: data != null, ...f, intervalMs }, now),
    };
  };
  const failed: Record<string, string> = {};
  const okAt: Record<string, number> = {};
  for (const path of ALL_PATHS) {
    const f = routeFacts(route(path));
    if (f.error) failed[path] = f.error;
    if (f.lastOk != null) okAt[path] = f.lastOk;
  }
  const firstLoad = (paths: string[]) => paths.every((p) => shownOf(p, route(p).data) == null) && paths.some((p) => route(p).settled === 0);
  const glob = route(GLOBAL_PATH).data as any;
  const value: Ctx = {
    threads: { D1: shownOf(threadPath("D1"), route(threadPath("D1")).data), H4: shownOf(threadPath("H4"), route(threadPath("H4")).data), H1: shownOf(threadPath("H1"), route(threadPath("H1")).data) },
    news: shownOf(NEWS_PATH, route(NEWS_PATH).data), m5: shownOf(M5_PATH, route(M5_PATH).data),
    global: glob?.global ?? null, strategy: glob?.global?.strategy ?? null, engine: glob?.engine ?? null, setups: Array.isArray(glob?.setups) ? glob.setups : [],
    loading: firstLoad(SLOW_PATHS) || firstLoad(FAST_PATHS),
    error: Object.values(failed)[0] ?? null,
    failed, okAt, intervalOf, pollOf, busy: ALL_PATHS.some((p) => route(p).sent > route(p).settled), retry,
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
