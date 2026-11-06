import { Swords } from "lucide-react";
import { Badge, Panel, Skeleton } from "./ui";
import { stanceColor, Stance } from "./Stance";
import { useWarRoom } from "../lib/warroom";
import { candleWhen, pct, utc } from "../lib/format";

const side = (x: any) => (x?.buy_confirmed ? "buy confirmed" : x?.sell_confirmed ? "sell confirmed" : "no confirmation");

/** Main panel: the conclusion of the latest Live War Room, with the H1 decision as its constraint. */
export default function WarRoomConclusion() {
  const { room, h1: latestH1, loading, enabled } = useWarRoom();
  const c = room?.conclusion;
  const h1 = room?.h1 ?? {};
  const lv = latestH1 && latestH1.candle_key === h1.candle_key && (latestH1.decision === "BUY" || latestH1.decision === "SELL") && latestH1.entry_price ? latestH1 : null;
  const cf = room?.confirmations;
  const m5 = room?.m5_label;
  return (
    <Panel title="War Room conclusion" icon={<Swords className="h-3.5 w-3.5 text-cyan-300" />}
      right={<div className="flex flex-wrap gap-2">{room && <Badge tone="slate">15m close {utc(room.bar_time)}</Badge>}{m5 && <Badge tone={m5 === "VERIFIED 5m" ? "green" : "amber"}>{m5}</Badge>}</div>}>
      {loading && !room ? <Skeleton rows={3} /> : !room ? (
        <p className="text-[12px] text-slate-500">{enabled === false ? "The War Room is off in this environment." : "No War Room session yet."}</p>
      ) : !c || c.status !== "ok" ? (
        <p className="text-[12px] text-slate-400">{room.phase === "closed" ? "The moderator could not conclude this round." : `The War Room is in session (${room.phase}); the conclusion follows the debate.`}</p>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="flex shrink-0 flex-col items-start gap-1 lg:w-44">
            <div className={`mono text-[52px] font-extrabold leading-none ${stanceColor(c.stance)}`} style={{ textShadow: "0 0 28px currentColor" }}>{c.stance}</div>
            <div className="mono text-[12px] text-slate-400">confidence {pct(c.confidence)}</div>
            {c.majority && <div className="text-[11px] text-slate-500">bus majority {c.majority}</div>}
          </div>
          <div className="min-w-0 flex-1">
            <p className="glass-inner px-4 py-3 text-[13px] leading-relaxed text-slate-200">{c.summary}</p>
            {!!c.reasons?.length && <ul className="mt-3 list-disc space-y-1 pl-5 text-[12.5px] text-slate-300">{c.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>}
            {!!c.dissent?.length && <p className="mt-2 text-[11px] text-slate-500">Still disagree: {c.dissent.map((d: any) => d.name).join(", ")}</p>}
          </div>
        </div>
      )}
      {room && (
        <div className="mt-4 grid gap-2 text-[11px] text-slate-400 md:grid-cols-2">
          <div className="glass-inner flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="eyebrow text-[9px]">H1 constraint</span><Stance value={h1.decision} /><span className="mono">{pct(h1.confidence)}</span><span>· {candleWhen(h1.candle_key)}</span>
            {lv && <span className="mono text-slate-300">· entry {lv.entry_price} · stop {lv.stop_loss} · target {lv.take_profit}</span>}
          </div>
          {cf && (
            <div className="glass-inner px-3 py-2">
              <span className="eyebrow mr-2 text-[9px]">Entry confirmation</span>
              H1 Prophet R38: {side(cf.h1_prophet_r38)} · 5m: {side(cf.m5_prophet_r38)}{cf.m5_prophet_r38 && !cf.m5_prophet_r38.verified ? " (unverified, does not count)" : ""}
            </div>
          )}
        </div>
      )}
      <p className="mt-3 text-[10px] uppercase tracking-widest text-slate-600">Advisory only. Price levels come only from the validated H1 chain. No orders are placed.</p>
    </Panel>
  );
}
