import { usePoll } from "./usePoll";

/**
 * The Omega badge on every page (UI audit DEF-10, 2026-11-14): connected, armed, server and open positions from
 * Omega's light status read (one bridge row, Access-checked by Omega), every 60 s while the page is visible.
 * Null when Omega cannot be read (no Access session for it, or Omega down): the badge then shows Standby.
 */
export type OmegaStatus = { connected: boolean; armed: boolean; server?: string | null; positions: number };

async function readStatus(): Promise<OmegaStatus | null> {
  try {
    const res = await fetch("/omega/api/status", { credentials: "same-origin", headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const d = await res.json();
    return { connected: d?.connected === true, armed: d?.armed === true, server: d?.server ?? null, positions: Number(d?.positions) || 0 };
  } catch {
    return null;
  }
}

export function useOmegaStatus(): OmegaStatus | null {
  return usePoll(readStatus, 60_000).data ?? null;
}
