import { ShieldAlert } from "lucide-react";
import { Dot, Skeleton } from "./ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { ago } from "../lib/format";

/**
 * Priority Queue (same panel as the Cerebrum Console): the open health alerts of the XAUUSD system
 * (parity revoked, input bar mismatch, missing local record, room without conclusion, rate limit,
 * stale News Daily or War Room), and those resolved in the last 24 hours.
 */
export default function PriorityQueue() {
  const { data, loading, error } = usePoll(() => get("/api/health/alerts"), 60_000);
  const open: any[] = (data as any)?.open ?? [];
  const resolved: any[] = (data as any)?.resolved_24h ?? [];
  return (
    <div className="glass p-4">
      <div className="eyebrow mb-3 flex items-center gap-2"><ShieldAlert className="h-3 w-3 text-amber-300" />Priority Queue</div>
      {loading && !data ? <Skeleton rows={2} /> : error && !data ? <p className="text-[12px] text-rose-300">Health checks unavailable.</p> : (
        <div className="space-y-2 text-[12.5px]">
          {open.length === 0 ? (
            <div className="glass-inner flex items-start gap-2.5 px-3 py-2 text-slate-300"><span className="mt-1.5"><Dot tone="green" /></span><span>No open items. The system is nominal.</span></div>
          ) : open.map((a) => (
            <div key={a.alert_key} className="glass-inner flex items-start gap-2.5 px-3 py-2 text-slate-200">
              <span className="mt-1.5"><Dot tone={a.kind === "parity_revoked" || a.kind === "war_room_stale" ? "red" : "amber"} pulse /></span>
              <span className="flex-1">{a.subject}<span className="mt-0.5 block text-[10px] text-slate-500">since {ago(a.opened_at)}{a.reported ? ` · reported (${a.reported})` : ""}</span></span>
            </div>
          ))}
          {!!resolved.length && (
            <details className="text-[11px] text-slate-500">
              <summary className="cursor-pointer select-none">Resolved in the last 24 hours ({resolved.length})</summary>
              <div className="mt-1.5 space-y-1">{resolved.map((a) => <div key={a.alert_key} className="flex gap-2"><Dot tone="slate" /><span>{a.subject} · {ago(a.resolved_at)}</span></div>)}</div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
