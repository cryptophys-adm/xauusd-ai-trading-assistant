import { useState } from "react";
import clsx from "clsx";
import { Layers } from "lucide-react";
import { Post, Tldr, calibrationText } from "./Post";
import { Stance } from "./Stance";
import { Skeleton } from "./ui";
import { useWarRoom } from "../lib/warroom";
import { useMarket } from "../lib/market";
import { ago, utc } from "../lib/format";

// Owner decision 2026-11-06: News first, then the rooms from the fastest timeframe up.
const TABS = [["NEWS", "News"], ["M15", "15m"], ["H1", "1H"], ["H4", "4H"], ["D1", "D1"]] as const;
type Tab = (typeof TABS)[number][0];

function RoomView({ room, label }: { room: any; label: string }) {
  const cal: Record<string, unknown> = {};
  for (const a of room.roster ?? []) cal[a.id] = a.calibration;
  const opens = room.openings ?? [], debate = room.debate ?? [];
  const phase = room.phase === "closed" ? "debate closed" : room.phase === "debate" ? "debate open" : "openings on the bus";
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-slate-500">{label} · candle closing {utc(room.bar_close ?? room.bar_time)} · {phase} · {opens.length} agents</p>
      <Tldr c={room.conclusion} waiting={room.phase === "closed" ? "The moderator could not conclude this round." : "The room is in session; the TLDR follows the debate."} />
      {!!opens.length && <div className="eyebrow pt-1 text-[10px]">Communication bus</div>}
      <div className="space-y-1.5">{opens.map((m: any) => <Post key={m.id} m={m} text={m.claim} calibration={calibrationText(m.calibration ?? cal[m.id])} />)}</div>
      {!!debate.length && <div className="eyebrow pt-1 text-[10px]">Debate</div>}
      <div className="space-y-1.5">{debate.map((m: any) => <Post key={m.id} m={m} text={m.argument} />)}</div>
    </div>
  );
}

function Move({ x, name }: { x?: { change_24h_percent?: number } | null; name: string }) {
  if (x?.change_24h_percent == null) return null;
  const v = x.change_24h_percent;
  return <span className={clsx("mono", v > 0 ? "text-emerald-300" : v < 0 ? "text-rose-300" : "text-slate-400")}>{name} {v > 0 ? "+" : ""}{v}%</span>;
}

function NewsView({ d }: { d: any }) {
  const c = d.counts ?? {};
  const ctx = d.context ?? {};
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-slate-500">News of the last 24 hours · updated {ago(d.run_at)} · {d.items?.length ?? 0} headlines</p>
      <Tldr c={d.tldr} waiting="The News Analyst has not written the TLDR yet." />
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
        <Stance value="BULLISH" />{c.bullish ?? 0}<Stance value="BEARISH" />{c.bearish ?? 0}<Stance value="NEUTRAL" />{c.neutral ?? 0}
      </div>
      <div className="flex flex-wrap gap-3 text-[11px]"><span className="text-slate-500">24h</span><Move x={ctx.gold} name="Gold" /><Move x={ctx.dollar} name="DXY" /><Move x={ctx.oil} name="Oil" /><Move x={ctx.usdt} name="USDT.D" /></div>
      <div className="eyebrow pt-1 text-[10px]">Headlines</div>
      <div className="space-y-1.5">
        {(d.items ?? []).map((i: any, k: number) => (
          <div key={k} className="glass-inner px-3 py-2.5">
            <div className="mb-1 flex items-center gap-2 text-[10px] text-slate-500">{i.bias ? <Stance value={i.bias} /> : <span>not tagged</span>}<span>{ago(i.published_at)}</span></div>
            {i.url ? <a href={i.url} target="_blank" rel="noopener noreferrer" className="text-[12.5px] leading-snug text-slate-200 hover:text-cyan-200">{i.title}</a> : <span className="text-[12.5px] text-slate-200">{i.title}</span>}
            {i.why && <p className="mt-1 text-[11px] text-slate-500">{i.why}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function TabBody({ tab }: { tab: Tab }) {
  const { room } = useWarRoom();
  const { threads, news, loading, error } = useMarket();
  if (tab === "M15") return room ? <RoomView room={room} label="Live War Room 15m" /> : <p className="text-[12px] text-slate-500">No War Room yet.</p>;
  if (loading) return <Skeleton rows={6} />;
  if (tab === "NEWS") return news ? <NewsView d={news} /> : error ? <p className="text-[12px] text-rose-300">Unavailable: {error}</p> : <p className="text-[12px] text-slate-500">No daily news analysis yet: it runs with the hourly news cron.</p>;
  const t = threads[tab];
  const label = TABS.find(([k]) => k === tab)?.[1] ?? tab;
  return t ? <RoomView room={t} label={`${label} War Room`} /> : <p className="text-[12px] text-slate-500">No {label} Thread yet: the room meets at the next closed {tab === "H1" ? "1-hour" : tab === "H4" ? "4-hour" : "daily"} candle.</p>;
}

/**
 * Center, under the chart: the living War Rooms of every timeframe in one card whose top is the
 * tab bar News | 15m | 1H | 4H | D1. Every page load opens on News (owner decision 2026-11-06).
 */
export default function ThreadsPanel({ className }: { className?: string }) {
  const [tab, setTab] = useState<Tab>("NEWS");
  return (
    <section className={clsx("glass flex min-h-0 flex-col overflow-hidden", className)} aria-label="War Rooms">
      <div className="flex items-center border-b border-white/10 bg-white/[0.02]" role="tablist" aria-label="War Room timeframe">
        <span className="hidden px-3 text-cyan-300 sm:inline-flex" aria-hidden="true"><Layers className="h-3.5 w-3.5" /></span>
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={clsx("flex-1 border-b-2 px-2 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] transition",
              tab === key ? "border-cyan-400 bg-cyan-400/[0.06] text-white" : "border-transparent text-slate-500 hover:bg-white/[0.03] hover:text-slate-200")}>{label}</button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3"><TabBody key={tab} tab={tab} /></div>
    </section>
  );
}
