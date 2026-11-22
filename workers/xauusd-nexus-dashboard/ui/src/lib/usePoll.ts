import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { errorText } from "./api";
import { STALE_TICK_MS, isStale, singleFlight, staleAt, staleChanged, staleWake } from "./pollState";

/**
 * Load once, then refresh every `intervalMs` while the tab is visible (0 = no refresh), and at once when the tab
 * becomes visible again (UI audit DEF-08). A background refresh never shows the skeleton again: `loading` is
 * true only until the first answer, or after `deps` changed (another chart, another filter), when the old data
 * no longer applies. The interval is not a dep: a page that slows its fallback read once the push hub delivers
 * (ADR-0015) keeps its data on screen.
 *
 * The data states (mockup "Nexus data states", part A; lib/pollState.ts): `lastOk` and `lastFail` (ms, the
 * browser clock: the API has no generated_at), `failures` (failed reads in a row) and `stale` (data on screen and
 * the last read failed, or no good read for 2 × the interval). A failed refresh keeps the data as it was.
 *
 * Review of #520: `busy` is true while any read is in flight, and `refresh` (Retry now) joins the read in flight
 * instead of starting another, but only while that read is younger than the interval (re-review: a hung read is
 * never joined, so Retry now always gets a new read past it; joinsInFlight in lib/pollState.ts). The stale verdict follows the wall clock after a sleep or a clock jump: the tab
 * becoming visible re-evaluates it before the refresh, a coarse tick (STALE_TICK_MS) re-evaluates it while data is
 * on screen, and a stale timer that fires early (the clock moved back) is armed again (staleWake).
 */
export function usePoll<T>(load: () => Promise<T>, intervalMs = 0, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [lastFail, setLastFail] = useState<number | null>(null);
  const [failures, setFailures] = useState(0);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const intervalRef = useRef(intervalMs);
  intervalRef.current = intervalMs;
  const hasData = useRef(false);
  const seq = useRef(0);
  const pending = useRef(0);
  const flight = useRef(singleFlight());
  const mounted = useRef(false);

  const read = useCallback(async () => {
    const id = ++seq.current;
    if (!hasData.current) setLoading(true);
    pending.current += 1;
    setBusy(true);
    try {
      const value = await loadRef.current();
      if (id === seq.current) { setData(value); hasData.current = true; setError(null); setLastOk(Date.now()); setFailures(0); }
    } catch (e) {
      if (id === seq.current) { setError(errorText(e)); setLastFail(Date.now()); setFailures((n) => n + 1); }
    } finally {
      if (id === seq.current) setLoading(false);
      pending.current -= 1;
      if (pending.current === 0) setBusy(false);
    }
  }, []);
  /** The poll's own reads (mount, deps, the interval, the tab coming back): always run; the newest one wins. */
  const start = useCallback(() => flight.current.start(read), [read]);
  /** Retry now: joins a read in flight younger than the interval (repeated clicks start no parallel reads), else reads. */
  const refresh = useCallback(() => flight.current.retry(read, intervalRef.current), [read]);

  // The data: loaded on mount, and again (from empty) when the deps change.
  useEffect(() => {
    if (mounted.current) { hasData.current = false; setData(null); setError(null); setLastOk(null); setLastFail(null); setFailures(0); }
    mounted.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const present = data != null;
  const stale = isStale({ hasData: present, error, lastOk, intervalMs }, Date.now());
  // The verdict on screen, for the tick and the tab coming back (they render only when it changes).
  const shown = useRef({ stale, facts: { hasData: present, error, lastOk, intervalMs } });
  shown.current = { stale, facts: { hasData: present, error, lastOk, intervalMs } };

  // The refresh: every intervalMs while visible, and on becoming visible (the stale verdict first: after a sleep
  // the old data must not read as live while the refresh is in flight).
  useEffect(() => {
    if (!intervalMs) return;
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void start(); }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (staleChanged(shown.current.stale, shown.current.facts, Date.now())) rerender();
      void start();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
  }, [intervalMs, start]);

  // The coarse clock while data is on screen: timers count awake time, so after a sleep or a forward clock jump
  // the stale timer below can be late; this tick turns the tag within STALE_TICK_MS.
  useEffect(() => {
    if (!intervalMs || !present) return;
    const t = window.setInterval(() => { if (staleChanged(shown.current.stale, shown.current.facts, Date.now())) rerender(); }, STALE_TICK_MS);
    return () => window.clearInterval(t);
  }, [intervalMs, present]);

  // The stale rule's clock: one render when 2 × the interval passes with no good read (a hung or skipped read).
  // Fired before staleAt (the clock moved back): armed again for what is left.
  useEffect(() => {
    const at = staleAt({ lastOk, intervalMs });
    if (at == null) return;
    let t = 0;
    const arm = (ms: number) => {
      t = window.setTimeout(() => {
        const w = staleWake(at, Date.now());
        if (w.rearmMs != null) arm(w.rearmMs);
        else if (w.render) rerender();
      }, Math.max(0, ms));
    };
    arm(at - Date.now());
    return () => window.clearTimeout(t);
  }, [lastOk, intervalMs]);

  return { data, error, loading, refresh, lastOk, lastFail, failures, stale, intervalMs, busy };
}

/**
 * Run `run` on mount, every `intervalMs` while the tab is visible (0 = once) and at once when the tab becomes visible
 * again: usePoll's cadence without its state, for a provider that keeps each route's state itself (lib/market.tsx).
 */
export function useSchedule(run: () => void, intervalMs: number) {
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => { runRef.current(); }, []);
  useEffect(() => {
    if (!intervalMs) return;
    const t = window.setInterval(() => { if (document.visibilityState === "visible") runRef.current(); }, intervalMs);
    const onVisible = () => { if (document.visibilityState === "visible") runRef.current(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
  }, [intervalMs]);
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
};
