import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { errorText } from "./api";
import { isStale, staleAt } from "./pollState";

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
 */
export function usePoll<T>(load: () => Promise<T>, intervalMs = 0, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [lastFail, setLastFail] = useState<number | null>(null);
  const [failures, setFailures] = useState(0);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const hasData = useRef(false);
  const seq = useRef(0);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    const id = ++seq.current;
    if (!hasData.current) setLoading(true);
    try {
      const value = await loadRef.current();
      if (id === seq.current) { setData(value); hasData.current = true; setError(null); setLastOk(Date.now()); setFailures(0); }
    } catch (e) {
      if (id === seq.current) { setError(errorText(e)); setLastFail(Date.now()); setFailures((n) => n + 1); }
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  // The data: loaded on mount, and again (from empty) when the deps change.
  useEffect(() => {
    if (mounted.current) { hasData.current = false; setData(null); setError(null); setLastOk(null); setLastFail(null); setFailures(0); }
    mounted.current = true;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // The refresh: every intervalMs while visible, and on becoming visible.
  useEffect(() => {
    if (!intervalMs) return;
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, intervalMs);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
  }, [intervalMs, refresh]);

  // The stale rule's clock: one render when 2 × the interval passes with no good read (a hung or skipped read).
  useEffect(() => {
    const at = staleAt({ lastOk, intervalMs });
    if (at == null) return;
    const t = window.setTimeout(rerender, Math.max(0, at - Date.now()));
    return () => window.clearTimeout(t);
  }, [lastOk, intervalMs]);

  const present = data != null;
  const stale = isStale({ hasData: present, error, lastOk, intervalMs }, Date.now());
  return { data, error, loading, refresh, lastOk, lastFail, failures, stale, intervalMs };
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
};
