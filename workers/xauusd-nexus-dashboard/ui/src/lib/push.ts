import { useEffect, useRef, useState } from "react";

/**
 * The push hub's snapshots of one topic (ADR-0015 phase 1, GET /api/stream on this origin): the latest
 * snapshot the hub holds as soon as the socket opens, then each new one as the cell publishes it. The socket
 * reconnects with a growing pause (up to a minute) and sends "ping" every 30 seconds, which the hub answers
 * without waking. `live` is true once a snapshot arrived on an open socket: the page may then poll rarely.
 */
export function usePush<T = unknown>(topic: string) {
  const [data, setData] = useState<T | null>(null);
  const [live, setLive] = useState(false);
  const stop = useRef(false);

  useEffect(() => {
    stop.current = false;
    let ws: WebSocket | null = null;
    let retry = 1000;
    let ping: number | undefined;
    let timer: number | undefined;
    const open = () => {
      if (stop.current || typeof WebSocket === "undefined") return;
      const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/stream?topics=${encodeURIComponent(topic)}`;
      try { ws = new WebSocket(url); } catch { schedule(); return; }
      ws.onopen = () => {
        retry = 1000;
        ping = window.setInterval(() => { try { ws?.send("ping"); } catch { /* reconnects on close */ } }, 30_000);
      };
      ws.onmessage = (ev) => {
        if (ev.data === "pong") return;
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg?.type === "snapshot" && msg.topic === topic && msg.data) { setData(msg.data as T); setLive(true); }
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
  }, [topic]);

  return { data, live };
}
