import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { get } from "./api";
import { usePoll, type Poll } from "./usePoll";
import { usePush } from "./push";
import { isStale, pushApplies, withPush } from "./pollState";

export type Room = any;
/**
 * `error` is the header's (AppShell): set only while there is no room. `poll` is the read of /api/war-room/latest
 * as a poll (review of #520): the room on screen, the read's error and times with a push counted as a good arrival,
 * for the 15m tab's error box and stale tag.
 */
type Ctx = { room: Room | null; enabled: boolean | null; h1: any | null; error: string | null; loading: boolean; poll: Poll };
const idlePoll: Poll = { data: null, error: null, loading: true, refresh: () => {}, lastOk: null, lastFail: null, failures: 0, stale: false, intervalMs: 0 };
const WarRoomContext = createContext<Ctx>({ room: null, enabled: null, h1: null, error: null, loading: true, poll: idlePoll });

/** The War Room read's path, so the 15m tab names it. */
export const WAR_ROOM_PATH = "/api/war-room/latest";

/** While the push hub delivers the room, the read is a fallback every 5 minutes (ADR-0015 phase 1). */
const POLL_LIVE_MS = 300_000;
const POLL_MS = 10_000;

/**
 * The latest Live War Room 15m and the latest H1 decision (60 s), shared by the page. The room comes from the
 * push hub as it changes; the read every 10 seconds stays until the hub has delivered a snapshot, then runs
 * every 5 minutes as a fallback. The newest of the two arrivals is shown.
 */
export function WarRoomProvider({ children }: { children: ReactNode }) {
  const push = usePush<any>("war-room");
  const war = usePoll(() => get(WAR_ROOM_PATH), push.live ? POLL_LIVE_MS : POLL_MS);
  const dec = usePoll(() => get("/api/decisions?limit=1"), 60_000);
  // The room on screen and how new it is (`at`: a read's answer time, or a push's own `at`), and the own `at` of the
  // last push applied. Re-review of #520: a push applies only when newer than the room on screen, and counts as a good
  // arrival only when newer than the last failed read (withPush), so the hub's replay of an old snapshot on reconnect
  // never replaces a newer room or clears a live failure.
  const [shown, setShown] = useState<{ data: any; at: number | null; pushAt: number | null }>({ data: null, at: null, pushAt: null });
  useEffect(() => { if (war.data) setShown((s) => ({ ...s, data: war.data, at: war.lastOk })); }, [war.data]);
  useEffect(() => {
    const snap = push.snap;
    if (!snap?.data) return;
    setShown((s) => (pushApplies(snap.at, s.at) ? { data: snap.data, at: snap.at, pushAt: Math.max(s.pushAt ?? -Infinity, snap.at as number) } : s));
  }, [push.snap]);
  const latest = shown.data;
  const f = withPush({ error: war.error, lastOk: war.lastOk, lastFail: war.lastFail, failures: war.failures }, shown.pushAt);
  const poll: Poll = {
    ...war, ...f, data: latest,
    loading: !latest && war.loading,
    stale: isStale({ hasData: latest != null, error: f.error, lastOk: f.lastOk, intervalMs: war.intervalMs }, Date.now()),
  };
  const value: Ctx = {
    room: latest?.room ?? null,
    enabled: latest?.enabled ?? null,
    h1: (dec.data as any)?.items?.[0] ?? null,
    error: latest ? null : war.error,
    loading: !latest && war.loading,
    poll,
  };
  return <WarRoomContext.Provider value={value}>{children}</WarRoomContext.Provider>;
}

export const useWarRoom = () => useContext(WarRoomContext);
