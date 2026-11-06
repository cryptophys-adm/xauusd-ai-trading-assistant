import { createContext, useContext, type ReactNode } from "react";
import { get } from "./api";
import { usePoll } from "./usePoll";

export type Room = any;
type Ctx = { room: Room | null; enabled: boolean | null; h1: any | null; error: string | null; loading: boolean };
const WarRoomContext = createContext<Ctx>({ room: null, enabled: null, h1: null, error: null, loading: true });

/** The latest Live War Room 15m (10 s refresh) and the latest H1 decision (60 s), shared by the page. */
export function WarRoomProvider({ children }: { children: ReactNode }) {
  const war = usePoll(() => get("/api/war-room/latest"), 10_000);
  const dec = usePoll(() => get("/api/decisions?limit=1"), 60_000);
  const value: Ctx = {
    room: (war.data as any)?.room ?? null,
    enabled: (war.data as any)?.enabled ?? null,
    h1: (dec.data as any)?.items?.[0] ?? null,
    error: war.error,
    loading: war.loading,
  };
  return <WarRoomContext.Provider value={value}>{children}</WarRoomContext.Provider>;
}

export const useWarRoom = () => useContext(WarRoomContext);
