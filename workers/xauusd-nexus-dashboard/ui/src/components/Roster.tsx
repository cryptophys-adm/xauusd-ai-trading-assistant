import { Bot } from "lucide-react";
import { Skeleton } from "./ui";
import { Stance } from "./Stance";
import { calibrationText } from "./Post";
import { useWarRoom } from "../lib/warroom";

/** Left panel: the War Room agents with their calibration status, shown once per agent. */
export default function Roster() {
  const { room, loading } = useWarRoom();
  const said: Record<string, any> = {};
  for (const o of room?.openings ?? []) said[o.id] = o;
  const list = room?.roster ?? [];
  return (
    <div className="glass p-4">
      <div className="eyebrow mb-3 flex items-center gap-2"><Bot className="h-3 w-3 text-cyan-300" />War Room agents</div>
      {loading && !room ? <Skeleton rows={5} /> : !list.length ? <p className="text-[12px] text-slate-500">No War Room session yet.</p> : (
        <div className="max-h-[60vh] space-y-1.5 overflow-y-auto pr-1">
          {list.map((a: any) => {
            const o = said[a.id];
            const cal = calibrationText(a.calibration);
            const verified = /verified|approved|VERIFIED/.test(cal ?? "") && !/not yet/.test(cal ?? "");
            return (
              <div key={a.id} className="glass-inner flex items-start gap-2.5 px-2.5 py-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-cyan-400/20 bg-cyan-400/10 text-[11px] font-bold text-cyan-200">{String(a.name ?? "?").slice(0, 1)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12px] font-semibold text-slate-200">{a.name}</span>
                    {o?.status === "ok" ? <Stance value={o.stance} /> : <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />}
                  </div>
                  {cal && <div className={`mt-0.5 truncate text-[10px] ${verified ? "text-emerald-300/80" : "text-slate-500"}`}>{cal}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
