import type { ReactNode } from "react";
import clsx from "clsx";
import { Layers } from "lucide-react";
import { Post, calibrationText } from "./Post";
import { Stance, stanceColor } from "./Stance";
import { Skeleton } from "./ui";
import { useWarRoom } from "../lib/warroom";
import { useMarket } from "../lib/market";
import { TABS, useTab, tabLabel, type Tab } from "../lib/tab";
import { ago, candleWhen, pct, utc } from "../lib/format";

const side = (x: any) => (x?.buy_confirmed ? "buy confirmed" : x?.sell_confirmed ? "sell confirmed" : "no confirmation");

/**
 * The conclusion of the active tab, first under the tab bar (owner decision 2026-11-06): the
 * stance in large type, its confidence, the summary, reasons and dissent, then what binds it.
 */
function ConclusionHero({ c, title, waiting, meta, constraint }: { c: any; title: string; waiting: string; meta?: string | null; constraint?: ReactNode }) {
  const ok = c && c.status === "ok";
  return (
    <section className="glass-inner border-cyan-400/20 px-4 py-4" aria-label={`${title} conclusion`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="eyebrow text-[10px] text-cyan-300/80">{title} conclusion</span>
        {meta && <span className="text-[11px] text-slate-500">· {meta}</span>}
      </div>
      {!ok ? <p className="text-[12.5px] text-slate-400">{waiting}</p> : (
        <div className="flex flex-col gap-4 md:flex-row md:items-start">
          <div className="flex shrink-0 flex-col items-start gap-1 md:w-40">
            <div className={`mono text-[44px] font-extrabold leading-none ${stanceColor(c.stance)}`} style={{ textShadow: "0 0 26px currentColor" }}>{c.stance}</div>
            <div className="mono text-[12px] text-slate-400">confidence {pct(c.confidence)}</div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-cyan-400/70" style={{ width: `${Math.round((Number(c.confidence) || 0) * 100)}%` }} /></div>
            {c.majority && <div className="text-[11px] text-slate-500">bus majority {c.majority}</div>}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] leading-relaxed text-slate-200">{c.summary}</p>
            {!!c.reasons?.length && <ul className="mt-2 list-disc space-y-1 pl-5 text-[12.5px] text-slate-400">{c.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>}
            {!!c.dissent?.length && <p className="mt-2 text-[11px] text-slate-500">Still disagree: {c.dissent.map((d: any) => d.name ?? d).join(", ")}</p>}
          </div>
        </div>
      )}
      {constraint && <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-400">{constraint}</div>}
    </section>
  );
}

function Chip({ label, children }: { label: string; children: ReactNode }) {
  return <div className="glass-inner flex flex-wrap items-center gap-2 px-3 py-1.5"><span className="eyebrow text-[9px]">{label}</span>{children}</div>;
}

/** The communication bus and the debate of one room, under its conclusion. */
function Discussion({ room }: { room: any }) {
  const cal: Record<string, unknown> = {};
  for (const a of room.roster ?? []) cal[a.id] = a.calibration;
  const opens = room.openings ?? [], debate = room.debate ?? [];
  return (
    <div className="space-y-3">
      {!!opens.length && <div className="eyebrow pt-1 text-[10px]">Communication bus · {opens.length} agents</div>}
      <div className="space-y-1.5">{opens.map((m: any) => <Post key={m.id} m={m} text={m.claim} calibration={calibrationText(m.calibration ?? cal[m.id])} />)}</div>
      {!!debate.length && <div className="eyebrow pt-1 text-[10px]">Debate</div>}
      <div className="space-y-1.5">{debate.map((m: any) => <Post key={m.id} m={m} text={m.argument} />)}</div>
    </div>
  );
}

const phaseText = (room: any) => (room.phase === "closed" ? "debate closed" : room.phase === "debate" ? "debate open" : "openings on the bus");

function RoomTab({ room, tab }: { room: any; tab: Tab }) {
  const label = tabLabel(tab);
  const cf = room.confirmations ?? {};
  const constraint = tab === "M15" ? (
    <>
      {room.h1 && <Chip label="H1 constraint"><Stance value={room.h1.decision} /><span className="mono">{pct(room.h1.confidence)}</span><span>· {candleWhen(room.h1.candle_key)}</span></Chip>}
      <Chip label="Entry confirmation">H1 R38 {side(cf.h1_prophet_r38)} · 5m {side(cf.m5_prophet_r38)}{cf.m5_prophet_r38 && !cf.m5_prophet_r38.verified ? " (unverified)" : ""}</Chip>
    </>
  ) : cf.chart_prophet_r38 ? (
    <Chip label={`${label} confirmation`}>Prophet R38 {side(cf.chart_prophet_r38)}{cf.chart_prophet_r38.approved_by_parity === false ? " (not parity approved)" : ""}</Chip>
  ) : null;
  return (
    <div className="space-y-3">
      <ConclusionHero c={room.conclusion} title={`${label} War Room`} meta={`candle closing ${utc(room.bar_close ?? room.bar_time)} · ${phaseText(room)}`}
        waiting={room.phase === "closed" ? "The moderator could not conclude this round." : "The room is in session; the conclusion follows the debate."} constraint={constraint} />
      <Discussion room={room} />
    </div>
  );
}

function Move({ x, name }: { x?: { change_24h_percent?: number } | null; name: string }) {
  if (x?.change_24h_percent == null) return null;
  const v = x.change_24h_percent;
  return <span className={clsx("mono", v > 0 ? "text-emerald-300" : v < 0 ? "text-rose-300" : "text-slate-400")}>{name} {v > 0 ? "+" : ""}{v}%</span>;
}

function NewsTab({ d }: { d: any }) {
  const c = d.counts ?? {};
  const ctx = d.context ?? {};
  return (
    <div className="space-y-3">
      <ConclusionHero c={d.tldr} title="News" meta={`last 24 hours · updated ${ago(d.run_at)} · ${d.items?.length ?? 0} headlines`} waiting="The News Analyst has not written the TLDR yet."
        constraint={<>
          <Chip label="Bias"><Stance value="BULLISH" />{c.bullish ?? 0}<Stance value="BEARISH" />{c.bearish ?? 0}<Stance value="NEUTRAL" />{c.neutral ?? 0}</Chip>
          <Chip label="24h"><Move x={ctx.gold} name="Gold" /><Move x={ctx.dollar} name="DXY" /><Move x={ctx.oil} name="Oil" /><Move x={ctx.usdt} name="USDT.D" /></Chip>
        </>} />
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
  if (tab === "M15") return room ? <RoomTab room={room} tab="M15" /> : <p className="text-[12px] text-slate-500">No War Room yet.</p>;
  if (loading) return <Skeleton rows={6} />;
  if (tab === "NEWS") return news ? <NewsTab d={news} /> : error ? <p className="text-[12px] text-rose-300">Unavailable: {error}</p> : <p className="text-[12px] text-slate-500">No daily news analysis yet: it runs with the hourly news cron.</p>;
  const t = threads[tab];
  return t ? <RoomTab room={t} tab={tab} /> : <p className="text-[12px] text-slate-500">No {tabLabel(tab)} War Room yet: the room meets at the next closed {tab === "H1" ? "1-hour" : tab === "H4" ? "4-hour" : "daily"} candle.</p>;
}

/**
 * Center, under the chart: the living War Rooms of every timeframe in one card whose top is the
 * tab bar News | 15m | 1H | 4H | D1, then the active tab's conclusion, then its discussion. Every
 * page load opens on News (owner decision 2026-11-06).
 */
export default function ThreadsPanel({ className }: { className?: string }) {
  const { tab, setTab } = useTab();
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
