import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { get } from "./api";
import { usePoll } from "./usePoll";
import { usePush } from "./push";

export type Room = any;
type Ctx = { room: Room | null; enabled: boolean | null; h1: any | null; error: string | null; loading: boolean };
const WarRoomContext = createContext<Ctx>({ room: null, enabled: null, h1: null, error: null, loading: true });

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
  const war = usePoll(() => get("/api/war-room/latest"), push.live ? POLL_LIVE_MS : POLL_MS, [push.live]);
  const dec = usePoll(() => get("/api/decisions?limit=1"), 60_000);
  const [latest, setLatest] = useState<any>(null);
  useEffect(() => { if (war.data) setLatest(war.data); }, [war.data]);
  useEffect(() => { if (push.data) setLatest(push.data); }, [push.data]);
  const value: Ctx = {
    room: latest?.room ?? null,
    enabled: latest?.enabled ?? null,
    h1: (dec.data as any)?.items?.[0] ?? null,
    error: latest ? null : war.error,
    loading: !latest && war.loading,
  };
  return <WarRoomContext.Provider value={value}>{children}</WarRoomContext.Provider>;
}

export const useWarRoom = () => useContext(WarRoomContext);
