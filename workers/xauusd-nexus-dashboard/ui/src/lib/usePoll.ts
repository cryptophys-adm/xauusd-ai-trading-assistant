import { useCallback, useEffect, useRef, useState } from "react";

/** Load once, then refresh every `intervalMs` while the tab is visible (0 = no refresh). */
export function usePoll<T>(load: () => Promise<T>, intervalMs = 0, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const dataRef = useRef<T | null>(null);
  dataRef.current = data;
  const seq = useRef(0);
  const prevDeps = useRef(deps);

  const refresh = useCallback(async () => {
    const id = ++seq.current;
    if (dataRef.current == null) {
      setLoading(true);
    }
    try {
      const value = await loadRef.current();
      if (id === seq.current) {
        setData(value);
        dataRef.current = value;
        setError(null);
      }
    } catch (e) {
      if (id === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const depsChanged = deps.length !== prevDeps.current.length || deps.some((d, i) => !Object.is(d, prevDeps.current[i]));
    prevDeps.current = deps;
    if (depsChanged) {
      dataRef.current = null;
      setData(null);
      setLoading(true);
    }
    void refresh();
    if (!intervalMs) return;

    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalMs);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, refresh };
}
