import { useEffect, useRef, useState } from "react";
import { localNow, nextSeq, pushTime, type PushArrival } from "./pollState";

/**
 * One topic's latest snapshot: its body, the hub's own time (`at`: when the hub published it, ms, the hub's clock; null
 * when the message had none), and its arrival (third review of #520): the local sequence (`seq`, nextSeq) and the
 * steady clock (`local`, localNow) when it reached the page, and `replay`: the first snapshot of the topic on this
 * socket, which the hub sends from its store on every connect. A page orders it by `seq` and counts its age from
 * `local`; `at` only recognises a replay older than the data on screen (pushApplies in lib/pollState.ts). Fourth
 * review: a replay never counts as a good arrival; its age is `at` on the server clock (the reads' Date, takePush).
 */
export type Snapshot<T = any> = PushArrival & { data: T };

/**
 * The push hub's snapshots of some topics (ADR-0015 phase 1, GET /api/stream on this origin, or Omega's
 * /omega/api/push for the Omega overview), over one socket:
 * the latest snapshot of each topic the hub holds as soon as the socket opens, then each new one as its cell
 * publishes it. The socket reconnects with a growing pause (up to a minute) and sends "ping" every 30 seconds,
 * which the hub answers without waking. `live` is true once every topic has delivered a snapshot on the open
 * socket: the page may then poll rarely. `snap` holds each topic's latest snapshot with its arrival (Snapshot), a
 * new object per message, so a replay of the same body is still an arrival the page judges (pushApplies).
 */
export function usePushMany(topics: string[], path = "/api/stream") {
  const key = topics.join(",");
  const [snap, setSnap] = useState<Record<string, Snapshot>>({});
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
      const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}?topics=${encodeURIComponent(key)}`;
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
            const arrival: PushArrival = { seq: nextSeq(), local: localNow(), at: pushTime(msg.at), replay: !seen.has(msg.topic) };
            setSnap((d) => ({ ...d, [msg.topic]: { data: msg.data, ...arrival } }));
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
  }, [key, path]);

  return { snap, live };
}

/** One topic's snapshots (the War Room's): the latest with its arrival, or null before one. */
export function usePush<T = unknown>(topic: string) {
  const { snap, live } = usePushMany([topic]);
  return { snap: (snap[topic] ?? null) as Snapshot<T> | null, live };
}
