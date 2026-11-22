import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ApiError, errorText, getDated, type Dated } from "./api";
import { STALE_TICK_MS, cadenceOf, clockJump, dueReads, isStale, localNow, nextSeq, pageServer, singleFlight, staleAt, staleChanged, staleWake, type Cadence } from "./pollState";

/**
 * A poll or retry read of a same-origin /api/* path with its `Date` (fourth review of #520): no-store (api.ts
 * getDated), and its Date (a failed read's too) noted with the local time it settled into the page's server clock
 * (pollState.ts pageServer), which ages a hub replay. Only these reads note: never a chart read or a cached one.
 */
export function readDated<T = any>(path: string): Promise<Dated<T>> {
  return getDated<T>(path).then(
    (r) => { pageServer.note(r.date, localNow()); return r; },
    (e) => { if (e instanceof ApiError) pageServer.note(e.date, localNow()); throw e; },
  );
}

/**
 * Load once, then refresh every `intervalMs` while the tab is visible (0 = no refresh), and at once when the tab
 * becomes visible again (UI audit DEF-08). A background refresh never shows the skeleton again: `loading` is
 * true only until the first answer, or after `deps` changed (another chart, another filter), when the old data
 * no longer applies. The interval is not a dep: a page that slows its fallback read once the push hub delivers
 * (ADR-0015) keeps its data on screen.
 *
 * The data states (mockup "Nexus data states", part A; lib/pollState.ts): `lastOk` and `lastFail` (ms, the
 * steady local clock localNow: the API has no generated_at, and a backward wall-clock step never freezes an age),
 * `failures` (failed reads in a row) and `stale` (data on screen and the last read failed, or no good read for 2 ×
 * the interval). A failed refresh keeps the data as it was. `sentSeq` is the local sequence (nextSeq) of the send of
 * the read whose answer `data` is, `failSeq` that of the last failed read: a page that also takes a push (the War
 * Room's 15m room) orders the two by it (third review of #520).
 *
 * Review of #520: `busy` is true while any read is in flight, and `refresh` (Retry now) joins the read in flight
 * instead of starting another, but only while that read is younger than RETRY_JOIN_MS (third review: any older read,
 * the hung one or the poll's own scheduled one, is never joined, so Retry now always sends a request past it;
 * joinsInFlight in lib/pollState.ts). The stale verdict follows the steady clock (it counts a sleep and never runs back): the tab
 * becoming visible re-evaluates it before the refresh, a coarse tick (STALE_TICK_MS) re-evaluates it while data is
 * on screen, and a stale timer that fires early (the clock moved back) is armed again (staleWake).
 *
 * Fourth review of #520: a forward clock jump (an NTP step, a wake from sleep: the steady clock outran the monotonic
 * one by more than the interval, clockJump) reads once at once, unless a read is in flight (single-flight).
 *
 * Fifth review of #520:
 * - `errorMs`: the cadence while the last read failed (cadenceOf; default the interval). The War Room passes its fast
 *   10 s, so a transient 502 with the push live recovers within 10 s, not at the 5-minute fallback. The returned
 *   `intervalMs` is the cadence in force (the tag's "retry 10s").
 * - The schedule keeps its phase (dueReads): the next read is at max(now, last send + cadence), so an interval change
 *   never restarts it; any read (the schedule, the tab coming back, a jump, Retry now, `nudge`) counts as the send.
 * - `nudge()` reads once unless a read is in flight (single-flight): the War Room calls it for an errored read when
 *   the push turns live or a replay arrives.
 * - The clock-jump detector lives as long as the poll (a ref), never re-created with the interval.
 */
export function usePoll<T>(load: () => Promise<T>, intervalMs = 0, deps: unknown[] = [], errorMs = intervalMs) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [lastFail, setLastFail] = useState<number | null>(null);
  const [failures, setFailures] = useState(0);
  const [sentSeq, setSentSeq] = useState<number | null>(null);
  const [failSeq, setFailSeq] = useState<number | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const hasData = useRef(false);
  const seq = useRef(0);
  const pending = useRef(0);
  const flight = useRef(singleFlight());
  const mounted = useRef(false);
  // The last send (localNow), for the schedule's phase; the clock-jump detector for the poll's whole life.
  const lastSend = useRef<number | null>(null);
  const jump = useRef<((limitMs: number) => boolean) | null>(null);
  if (jump.current == null) jump.current = clockJump();

  const read = useCallback(async () => {
    const id = nextSeq();
    seq.current = id;
    lastSend.current = localNow();
    if (!hasData.current) setLoading(true);
    pending.current += 1;
    setBusy(true);
    try {
      const value = await loadRef.current();
      if (id === seq.current) { setData(value); hasData.current = true; setSentSeq(id); setError(null); setLastOk(localNow()); setFailures(0); }
    } catch (e) {
      if (id === seq.current) { setError(errorText(e)); setLastFail(localNow()); setFailSeq(id); setFailures((n) => n + 1); }
    } finally {
      if (id === seq.current) setLoading(false);
      pending.current -= 1;
      if (pending.current === 0) setBusy(false);
    }
  }, []);
  /** The poll's own reads (mount, deps, the interval, the tab coming back): always run; the newest one wins. */
  const start = useCallback(() => flight.current.start(read), [read]);
  /** Retry now: joins a read in flight younger than RETRY_JOIN_MS (a double click starts one read), else reads. */
  const refresh = useCallback(() => flight.current.retry(read), [read]);
  /** One read now unless one is in flight (single-flight): an errored read when the push turns live. */
  const nudge = useCallback(() => { if (!flight.current.busy) void start(); }, [start]);

  // The data: loaded on mount, and again (from empty) when the deps change.
  useEffect(() => {
    if (mounted.current) { hasData.current = false; setData(null); setError(null); setLastOk(null); setLastFail(null); setFailures(0); setSentSeq(null); setFailSeq(null); }
    mounted.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const present = data != null;
  // The cadence in force: the fast one while the last read failed (fifth review of #520).
  const every = cadenceOf(error != null, intervalMs, errorMs);
  const stale = isStale({ hasData: present, error, lastOk, intervalMs: every }, localNow());
  // The verdict on screen, for the tick and the tab coming back (they render only when it changes).
  const shown = useRef({ stale, facts: { hasData: present, error, lastOk, intervalMs: every } });
  shown.current = { stale, facts: { hasData: present, error, lastOk, intervalMs: every } };

  // The refresh: due at max(now, last send + cadence) while visible (dueReads: a cadence change keeps the phase), and
  // on becoming visible (the stale verdict first: after a sleep the old data must not read as live while the refresh
  // is in flight).
  useEffect(() => {
    if (!every) return;
    let t = 0;
    const plan = (): Cadence[] => [{ key: "read", lastSend: lastSend.current, every }];
    const arm = (ms: number) => {
      t = window.setTimeout(() => {
        const r = dueReads(plan(), localNow(), document.visibilityState === "visible");
        if (r.due.length) void start();
        if (r.waitMs != null) arm(r.waitMs);
      }, Math.max(0, ms));
    };
    // Checked at once: a read overdue on the new cadence (last send + cadence already past) is sent now.
    arm(0);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (staleChanged(shown.current.stale, shown.current.facts, localNow())) rerender();
      void start();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearTimeout(t); document.removeEventListener("visibilitychange", onVisible); };
  }, [every, start]);

  // A forward clock jump schedules no read: read once now, unless one is in flight (it brings the answer). The
  // detector keeps its baselines across cadence changes (fifth review: a wake with the socket dropped).
  useEffect(() => {
    if (!every) return;
    const t = window.setInterval(() => { if (jump.current?.(every) && !flight.current.busy && document.visibilityState === "visible") void start(); }, STALE_TICK_MS);
    return () => window.clearInterval(t);
  }, [every, start]);

  // The coarse clock while data is on screen: timers count awake time, so after a sleep or a forward clock jump
  // the stale timer below can be late; this tick turns the tag within STALE_TICK_MS.
  useEffect(() => {
    if (!every || !present) return;
    const t = window.setInterval(() => { if (staleChanged(shown.current.stale, shown.current.facts, localNow())) rerender(); }, STALE_TICK_MS);
    return () => window.clearInterval(t);
  }, [every, present]);

  // The stale rule's clock: one render when 2 × the interval passes with no good read (a hung or skipped read).
  // Fired before staleAt (the clock moved back): armed again for what is left.
  useEffect(() => {
    const at = staleAt({ lastOk, intervalMs: every });
    if (at == null) return;
    let t = 0;
    const arm = (ms: number) => {
      t = window.setTimeout(() => {
        const w = staleWake(at, localNow());
        if (w.rearmMs != null) arm(w.rearmMs);
        else if (w.render) rerender();
      }, Math.max(0, ms));
    };
    arm(at - localNow());
    return () => window.clearTimeout(t);
  }, [lastOk, every]);

  return { data, error, loading, refresh, lastOk, lastFail, failures, stale, intervalMs: every, busy, sentSeq, failSeq, nudge };
}

/**
 * usePoll's cadence without its state, for a provider that keeps each route's state itself (lib/market.tsx): `run`
 * reads the routes it is given; on mount and when the tab becomes visible again it is given every route of `plan()`.
 * Fifth review of #520: per route, each read due at max(now, its last send + its cadence) while the tab is visible
 * (dueReads), so a cadence change (the push turning live, a route turning errored or good) keeps the phase instead
 * of restarting it. On a forward clock jump (clockJump: more than the shortest cadence) it runs `onJump` once
 * (fourth review; the provider's skips a route whose read is in flight, single-flight); the detector lives as long
 * as the schedule. `cadenceKey` names the cadences in force (the timer is armed again when it changes).
 */
export function useSchedule(plan: () => Cadence[], run: (keys: string[]) => void, cadenceKey: string, onJump: () => void) {
  const planRef = useRef(plan);
  planRef.current = plan;
  const runRef = useRef(run);
  runRef.current = run;
  const jumpRef = useRef(onJump);
  jumpRef.current = onJump;
  const jump = useRef<((limitMs: number) => boolean) | null>(null);
  if (jump.current == null) jump.current = clockJump();
  const all = () => planRef.current().map((c) => c.key);
  useEffect(() => { runRef.current(all()); }, []);
  useEffect(() => {
    const t = window.setInterval(() => {
      const every = planRef.current().map((c) => c.every).filter((ms) => ms > 0);
      if (every.length && jump.current?.(Math.min(...every)) && document.visibilityState === "visible") jumpRef.current();
    }, STALE_TICK_MS);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    let t = 0;
    const arm = (ms: number) => {
      t = window.setTimeout(() => {
        const r = dueReads(planRef.current(), localNow(), document.visibilityState === "visible");
        if (r.due.length) runRef.current(r.due);
        if (r.waitMs != null) arm(r.waitMs);
      }, Math.max(0, ms));
    };
    // Checked at once: a route overdue on its new cadence is read now.
    arm(0);
    const onVisible = () => { if (document.visibilityState === "visible") runRef.current(all()); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearTimeout(t); document.removeEventListener("visibilitychange", onVisible); };
  }, [cadenceKey]);
}

/** What a panel needs of a poll to show its state (components/ui.tsx Panel, PollBody, PollError). */
export type Poll = {
  data: unknown;
  error: string | null;
  loading: boolean;
  refresh: () => void | Promise<void>;
  lastOk: number | null;
  lastFail: number | null;
  failures: number;
  stale: boolean;
  intervalMs: number;
  /** The poll's own read is in flight (informational: Retry now is disabled only while its own click runs). */
  busy?: boolean;
  /**
   * The data on screen is a hub replay's (fourth review of #520): its age is `replayAt` (server-aged, localNow), null
   * while unknown; lastOk stays the last good read or live push (pollState.ts ageBase).
   */
  replayed?: boolean;
  replayAt?: number | null;
  /** A replay of unknown age while the route's own first read is in flight (fifth review of #520: pollState.ts isChecking). */
  checking?: boolean;
};
