import { usePoll } from "./usePoll";

/**
 * The Omega badge on every page (UI audit DEF-10, 2026-11-14): connected, armed, server and open positions from
 * Omega's light status read (one bridge row, Access-checked by Omega), every 60 s while the page is visible.
 * Null when Omega cannot be read (no Access session for it, or Omega down): the badge then shows Standby.
 */
export type OmegaStatus = {
  connected: boolean; armed: boolean; server?: string | null; broker?: string | null; positions: number;
  // The execution state (xauusd #516): absent from an older Omega, so every one is optional.
  live_armed?: boolean | null; control_mode?: "active" | "paused" | "killed" | null; control_reason?: string | null;
  limit_fault?: { why: string } | null; account_mode?: "demo" | "real" | "contest" | null; engine_enabled?: boolean | null;
};

async function readStatus(): Promise<OmegaStatus | null> {
  try {
    const res = await fetch("/omega/api/status", { credentials: "same-origin", headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const d = await res.json();
    const mode = ["active", "paused", "killed"].includes(d?.control_mode) ? d.control_mode : null;
    const account = ["demo", "real", "contest"].includes(d?.account_mode) ? d.account_mode : null;
    return {
      connected: d?.connected === true, armed: d?.armed === true, server: d?.server ?? null, broker: d?.broker ?? null, positions: Number(d?.positions) || 0,
      live_armed: typeof d?.live_armed === "boolean" ? d.live_armed : null, control_mode: mode,
      control_reason: typeof d?.control_reason === "string" ? d.control_reason.slice(0, 60) : null,
      limit_fault: d?.limit_fault && typeof d.limit_fault === "object" ? { why: String(d.limit_fault.why ?? "limit_fault").slice(0, 40) } : null,
      account_mode: account, engine_enabled: typeof d?.engine_enabled === "boolean" ? d.engine_enabled : null
    };
  } catch {
    return null;
  }
}

export function useOmegaStatus(): OmegaStatus | null {
  return usePoll(readStatus, 60_000).data ?? null;
}
