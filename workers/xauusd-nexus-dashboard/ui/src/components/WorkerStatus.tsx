import { Server } from "lucide-react";
import { Dot, Skeleton } from "./ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";

/** Left panel: Worker health and the parity registry of the local engines. */
export default function WorkerStatus() {
  const { data, loading, error } = usePoll(() => get("/api/status"), 30_000);
  const ai = (data as any)?.ai_worker ?? {};
  const ing = (data as any)?.ingestion_worker ?? {};
  const pills = [
    { label: "AI Worker", ok: ai.status === "ok" },
    { label: "News ingestion", ok: ing.status === "ok" },
    { label: "TradingView OAuth", ok: !!ing.oauth_authorized },
    { label: "Local lane", ok: !!ai.local_lane?.fresh },
  ];
  const registry: any[] = Array.isArray(ai.local_lane?.registry) ? ai.local_lane.registry : [];
  return (
    <div className="glass p-4">
      <div className="eyebrow mb-3 flex items-center gap-2"><Server className="h-3 w-3 text-cyan-300" />Worker status</div>
      {loading && !data ? <Skeleton rows={3} /> : error && !data ? <p className="text-[12px] text-rose-300">Status unavailable.</p> : (
        <>
          <div className="grid grid-cols-2 gap-1.5">
            {pills.map((p) => <div key={p.label} className="glass-inner flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-slate-300"><Dot tone={p.ok ? "green" : "red"} pulse={!p.ok} />{p.label}</div>)}
          </div>
          {!!registry.length && (
            <div className="mt-3">
              <div className="label">Parity registry</div>
              <div className="space-y-1">
                {registry.map((x) => (
                  <div key={x.engine + x.status} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="mono text-slate-400">{x.engine}</span>
                    <span className={`mono ${x.status === "approved" ? "text-emerald-300" : x.status === "revoked" ? "text-rose-300" : "text-amber-200"}`}>{x.status} {x.consecutive_matches}/24</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
