import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { get } from "./api";
import { usePoll, type Poll } from "./usePoll";
import { usePush } from "./push";
import { isStale, localNow, pushApplies, pushShown, withPush, type PushMark } from "./pollState";

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
 * every 5 minutes as a fallback. The newest of the two arrivals, on the local order, is shown.
 */
export function WarRoomProvider({ children }: { children: ReactNode }) {
  const push = usePush<any>("war-room");
  const war = usePoll(() => get(WAR_ROOM_PATH), push.live ? POLL_LIVE_MS : POLL_MS);
  const dec = usePoll(() => get("/api/decisions?limit=1"), 60_000);
  // The last applied push (third review of #520): its body, its arrival (local sequence and steady time) and the newest
  // hub `at` applied. A push applies unless the hub's `at` marks it a replay older than what is on screen
  // (pushApplies); the room on screen is the push's only when it arrived after the read that brought the read's room
  // was sent (pushShown), so a read sent before a newer push never overwrites it; the push's arrival counts toward
  // lastOk and clears the read's error only when it arrived after the failed read was sent (withPush).
  const [pushed, setPushed] = useState<{ data: any; mark: PushMark; at: number } | null>(null);
  useEffect(() => {
    const snap = push.snap;
    if (!snap?.data) return;
    setPushed((s) => (pushApplies(snap, s?.at ?? null) ? { data: snap.data, mark: { seq: snap.seq, local: snap.local }, at: Math.max(s?.at ?? -Infinity, snap.at as number) } : s));
  }, [push.snap]);
  const mark = pushed?.mark ?? null;
  const latest = war.data != null && !pushShown(war.sentSeq, mark) ? war.data : pushed?.data ?? war.data ?? null;
  const f = withPush({ error: war.error, lastOk: war.lastOk, lastFail: war.lastFail, failSeq: war.failSeq, failures: war.failures }, mark);
  const poll: Poll = {
    ...war, ...f, data: latest,
    loading: !latest && war.loading,
    stale: isStale({ hasData: latest != null, error: f.error, lastOk: f.lastOk, intervalMs: war.intervalMs }, localNow()),
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
