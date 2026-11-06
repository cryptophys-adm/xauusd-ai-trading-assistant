import { Bot } from "lucide-react";
import { Skeleton } from "./ui";
import { Stance } from "./Stance";
import { calibrationText, BiasTag } from "./Post";
import { useWarRoom } from "../lib/warroom";
import { useMarket } from "../lib/market";
import { useTab, tabLabel } from "../lib/tab";
import { pct } from "../lib/format";

function Agent({ name, stance, bias, cal, ok = true }: { name: string; stance?: string | null; bias?: string | null; cal?: string | null; ok?: boolean }) {
  const verified = /verified|approved|VERIFIED/.test(cal ?? "") && !/not yet/.test(cal ?? "");
  return (
    <div className="glass-inner flex items-start gap-2.5 px-2.5 py-2">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-cyan-400/20 bg-cyan-400/10 text-[11px] font-bold text-cyan-200">{String(name ?? "?").slice(0, 1)}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[12px] font-semibold text-slate-200">{name}</span>
          {ok && stance ? <span className="flex items-center gap-1.5">{bias && <BiasTag bias={bias} />}<Stance value={stance} /></span> : <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />}
        </div>
        {cal && <div className={`mt-0.5 truncate text-[10px] ${verified ? "text-emerald-300/80" : "text-slate-500"}`}>{cal}</div>}
      </div>
    </div>
  );
}

/**
 * Left panel: the desks and HUD agents of the room in the active tab, with their stance in that
 * room and their calibration (owner decision 2026-11-06: the desks follow the active tab, so the
 * 15m tab shows only the 15m room's analysis). The News tab shows the News Analyst's daily read.
 */
export default function Roster() {
  const { tab } = useTab();
  const { room: m15, loading: l15 } = useWarRoom();
  const { threads, news, loading } = useMarket();
  const room = tab === "M15" ? m15 : tab === "NEWS" ? null : threads[tab];
  const busy = tab === "M15" ? l15 && !m15 : loading;
  const said: Record<string, any> = {};
  for (const o of room?.openings ?? []) said[o.id] = o;
  const list = room?.roster ?? [];
  return (
    <div className="glass p-4">
      <div className="eyebrow mb-3 flex items-center gap-2"><Bot className="h-3 w-3 text-cyan-300" />{tab === "NEWS" ? "News desk" : `${tabLabel(tab)} War Room agents`}</div>
      {busy ? <Skeleton rows={5} /> : tab === "NEWS" ? (
        news?.tldr?.status === "ok"
          ? <Agent name="News Analyst" stance={news.tldr.stance} cal={`last 24 hours · confidence ${pct(news.tldr.confidence)}`} />
          : <p className="text-[12px] text-slate-500">The News Analyst has not concluded yet.</p>
      ) : !list.length ? <p className="text-[12px] text-slate-500">No {tabLabel(tab)} War Room session yet.</p> : (
        <div className="max-h-[60vh] space-y-1.5 overflow-y-auto pr-1">
          {list.map((a: any) => <Agent key={a.id} name={a.name} stance={said[a.id]?.stance} bias={said[a.id]?.bias} ok={said[a.id]?.status === "ok"} cal={calibrationText(a.calibration)} />)}
        </div>
      )}
    </div>
  );
}
