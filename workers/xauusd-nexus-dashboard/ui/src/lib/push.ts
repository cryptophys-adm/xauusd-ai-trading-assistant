import { useEffect, useRef, useState } from "react";

/**
 * The push hub's snapshots of some topics (ADR-0015 phase 1, GET /api/stream on this origin), over one socket:
 * the latest snapshot of each topic the hub holds as soon as the socket opens, then each new one as its cell
 * publishes it. The socket reconnects with a growing pause (up to a minute) and sends "ping" every 30 seconds,
 * which the hub answers without waking. `live` is true once every topic has delivered a snapshot on the open
 * socket: the page may then poll rarely.
 */
export function usePushMany(topics: string[]) {
  const key = topics.join(",");
  const [data, setData] = useState<Record<string, any>>({});
  const [live, setLive] = useState(false);
  const stop = useRef(false);

  useEffect(() => {
    stop.current = false;
    const wanted = key.split(",").filter(Boolean);
    let ws: WebSocket | null = null;
    let retry = 1000;
    let ping: number | undefined;
    let timer: number | undefined;
    let seen = new Set<string>();
    const open = () => {
      if (stop.current || typeof WebSocket === "undefined" || !wanted.length) return;
      const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/stream?topics=${encodeURIComponent(key)}`;
      try { ws = new WebSocket(url); } catch { schedule(); return; }
      ws.onopen = () => {
        retry = 1000;
        seen = new Set();
        ping = window.setInterval(() => { try { ws?.send("ping"); } catch { /* reconnects on close */ } }, 30_000);
      };
      ws.onmessage = (ev) => {
        if (ev.data === "pong") return;
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg?.type === "snapshot" && wanted.includes(msg.topic) && msg.data) {
            setData((d) => ({ ...d, [msg.topic]: msg.data }));
            seen.add(msg.topic);
            if (seen.size === wanted.length) setLive(true);
          }
        } catch { /* not a snapshot */ }
      };
      ws.onclose = () => { window.clearInterval(ping); setLive(false); schedule(); };
      ws.onerror = () => { try { ws?.close(); } catch { /* closed */ } };
    };
    const schedule = () => {
      if (stop.current) return;
      timer = window.setTimeout(open, retry);
      retry = Math.min(60_000, retry * 2);
    };
    open();
    return () => { stop.current = true; window.clearInterval(ping); window.clearTimeout(timer); try { ws?.close(); } catch { /* closed */ } };
  }, [key]);

  return { data, live };
}

/** One topic's snapshots (the War Room's). */
export function usePush<T = unknown>(topic: string) {
  const { data, live } = usePushMany([topic]);
  return { data: (data[topic] ?? null) as T | null, live };
}
