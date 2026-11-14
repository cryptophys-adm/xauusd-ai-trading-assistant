import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Load once, then refresh every `intervalMs` while the tab is visible (0 = no refresh), and at once when the tab
 * becomes visible again (UI audit DEF-08). A background refresh never shows the skeleton again: `loading` is
 * true only until the first answer, or after `deps` changed (another chart, another filter), when the old data
 * no longer applies. The interval is not a dep: a page that slows its fallback read once the push hub delivers
 * (ADR-0015) keeps its data on screen.
 */
export function usePoll<T>(load: () => Promise<T>, intervalMs = 0, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
      if (id === seq.current) { setData(value); hasData.current = true; setError(null); }
    } catch (e) {
      if (id === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  // The data: loaded on mount, and again (from empty) when the deps change.
  useEffect(() => {
    if (mounted.current) { hasData.current = false; setData(null); }
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

  return { data, error, loading, refresh };
}
