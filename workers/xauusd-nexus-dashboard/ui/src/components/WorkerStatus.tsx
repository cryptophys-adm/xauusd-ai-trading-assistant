import { Server } from "lucide-react";
import { Dot, Skeleton } from "./ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";

/** Left panel: Worker health and the parity registry of the local engines. */
export default function WorkerStatus() {
  const { data, loading, error } = usePoll(() => get("/api/status"), 30_000);
  const ai = (data as any)?.ai_worker ?? {};
  const ing = (data as any)?.ingestion_worker ?? {};
  const registry: any[] = Array.isArray(ai.local_lane?.registry) ? ai.local_lane.registry : [];
  // The local lane is fresh when an approved local H1 record exists for a recent candle. While the
  // H1 identities re-earn parity it is not fresh by design: show the progress instead of a bare red.
  const h1 = registry.filter((x) => x.engine === "prophet" || x.engine === "gmi");
  const reEarning = !ai.local_lane?.fresh && h1.length > 0 && h1.every((x) => x.status !== "approved");
  const progress = h1.length ? Math.min(...h1.map((x) => Number(x.consecutive_matches) || 0)) : 0;
  const pills: { label: string; tone: "green" | "amber" | "red" }[] = [
    { label: "AI Worker", tone: ai.status === "ok" ? "green" : "red" },
    { label: "News ingestion", tone: ing.status === "ok" ? "green" : "red" },
    { label: "TradingView OAuth", tone: ing.oauth_authorized ? "green" : "red" },
    { label: reEarning ? `Local lane · re-earning ${progress}/24` : "Local lane", tone: ai.local_lane?.fresh ? "green" : reEarning ? "amber" : "red" },
  ];
  return (
    <div className="glass p-4">
      <div className="eyebrow mb-3 flex items-center gap-2"><Server className="h-3 w-3 text-cyan-300" />Worker status</div>
      {loading && !data ? <Skeleton rows={3} /> : error && !data ? <p className="text-[12px] text-rose-300">Status unavailable.</p> : (
        <>
          <div className="grid grid-cols-2 gap-1.5">
            {pills.map((p) => <div key={p.label} className="glass-inner flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-slate-300"><Dot tone={p.tone} pulse={p.tone !== "green"} />{p.label}</div>)}
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
