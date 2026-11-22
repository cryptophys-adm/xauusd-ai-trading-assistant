import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { get, type Dated } from "./api";
import { readDated, usePoll, type Poll } from "./usePoll";
import { usePush } from "./push";
import { isStale, localNow, pageServer, shownFacts, shownSide, takePush, type PushSlots, type ReadSide } from "./pollState";

export type Room = any;
/**
 * `error` is the header's (AppShell): set only while there is no room. `poll` is the read of /api/war-room/latest
 * as a poll (review of #520): the room on screen, the read's error and times with a live push counted as a good arrival
 * (a hub replay never is: fourth review),
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

/** No push applied yet. */
const noPush: PushSlots = { pushed: null, push: null, pushAt: null };

/**
 * The latest Live War Room 15m and the latest H1 decision (60 s), shared by the page. The room comes from the
 * push hub as it changes; the read every 10 seconds stays until the hub has delivered a snapshot, then runs
 * every 5 minutes as a fallback. Which of the read and the push is shown: shownSide (below).
 */
export function WarRoomProvider({ children }: { children: ReactNode }) {
  const push = usePush<any>("war-room");
  // The read is dated (fourth review of #520): no-store, same-origin, its Date noted into the page's server clock.
  const war = usePoll(() => readDated(WAR_ROOM_PATH), push.live ? POLL_LIVE_MS : POLL_MS);
  const dec = usePoll(() => get("/api/decisions?limit=1"), 60_000);
  // The read's room, its send and its Date; the pushes kept apart (pollState.ts takePush), as lib/market.tsx's routes:
  // - a live push is shown when it arrived after the read on screen was sent; its arrival counts toward lastOk and
  //   clears the read's error only when it arrived after the failed read was sent (withPush);
  // - a hub replay is shown only when its `at` is newer than the read's Date (less 1 s), in either arrival order
  //   (shownSide runs on every render, so a read in flight is compared when it settles); it never clears the error
  //   or moves lastOk, and its age is its `at` on the server clock (unknown, so stale, until a read brings a Date).
  const dated = war.data as Dated | null;
  const read: ReadSide | null = dated != null && war.sentSeq != null ? { data: dated.data, seq: war.sentSeq, date: dated.date } : null;
  const readRef = useRef(read);
  readRef.current = read;
  const [slots, setSlots] = useState<PushSlots>(noPush);
  useEffect(() => {
    const snap = push.snap;
    if (!snap?.data) return;
    setSlots((s) => takePush(s, readRef.current, snap.data, snap) ?? s);
  }, [push.snap]);
  const shown = shownSide(read, slots.pushed);
  const latest = (shown.data ?? null) as any;
  const f = shownFacts({ error: war.error, lastOk: war.lastOk, lastFail: war.lastFail, failSeq: war.failSeq, failures: war.failures }, slots.push, shown.push, pageServer.offset());
  const poll: Poll = {
    ...war, ...f, data: latest,
    replayed: f.replayed ?? false, replayAt: f.replayAt ?? null,
    loading: !latest && war.loading,
    stale: isStale({ hasData: latest != null, ...f, intervalMs: war.intervalMs }, localNow()),
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
