import { GitCompareArrows, Globe2 } from "lucide-react";
import { Stance, stanceColor } from "../components/Stance";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";

const chg = (x: number | null | undefined, unit: string) => (x == null ? "n/a" : `${x > 0 ? "+" : ""}${x}${unit === "bp" ? " bp" : "%"}`);
const tone = (x?: number | null) => (x == null ? "text-slate-500" : x > 0 ? "text-emerald-300" : x < 0 ? "text-rose-300" : "text-slate-300");
const corrTone = (c?: number | null) => (c == null ? "text-slate-500" : c >= 0.5 ? "text-emerald-300" : c <= -0.5 ? "text-rose-300" : "text-slate-300");
const corrWord = (c?: number | null) => (c == null ? "not enough bars" : Math.abs(c) < 0.2 ? "unrelated" : `${Math.abs(c) >= 0.6 ? "strongly " : ""}${c > 0 ? "with gold" : "against gold"}`);
const when = (t?: string | null) => (t ? t.slice(5, 16).replace("T", " ") : "");

const pc = (x?: number | null) => (x == null ? "" : `${Math.round(x * 100)}%`);
// The room's agents (src/macro-room.mjs MACRO_AGENTS), shown before the first session too.
const ROSTER: [string, string][] = [
  ["Calendar Agent", "the scheduled US events: the projected effect of each on gold by fixed rules, and the headlines after a release"],
  ["News Analyst", "the news of the last 24 hours: the daily bias for gold and the headlines behind it"],
  ["Dollar Analyst", "the US Dollar Index: its recent move and how tightly it has moved against gold"],
  ["Rates Analyst", "the US 10-year yield: its recent move and the cost of holding gold"],
  ["Metals Analyst", "silver: whether it confirms or contradicts gold's move"],
  ["Oil Analyst", "WTI crude oil and the geopolitical headlines: supply shocks and conflict feeding inflation and safe-haven demand"],
  ["Correlation Analyst", "whether the usual links between gold, the dollar, yields, silver and oil hold now"]
];
// src/macro-room.mjs macroSessionWord: hourly since 2026-11-11; stored 4-hour sessions keep their name.
const sessionWord = (m: any) => (m?.kind === "event" ? "30 minutes after a high-impact US event" : m?.kind === "event2" || m?.kind === "event_follow_up" ? "2 hours after a high-impact US event" : m?.kind === "4h" ? "after a 4-hour close" : "after a 1-hour close");

/**
 * Macro War Room (owner decision 2026-11-08): the Calendar Agent, the News Analyst and the dollar,
 * yields, silver, oil and correlation analysts discuss what moves gold; the moderator concludes the macro
 * bias for the next 4 to 24 hours. Context only: it never changes the strategy engine's decision.
 */
function MacroRoom() {
  const { data, loading } = usePoll(() => get("/api/macro"), 120_000);
  const m = (data as any)?.macro;
  const c = m?.conclusion?.status === "ok" ? m.conclusion : null;
  return (
    <Panel title="Macro War Room" icon={<Globe2 className="h-3.5 w-3.5 text-cyan-300" />} right={<span className="flex gap-1">{m?.stale ? <Badge tone="amber">stale</Badge> : null}<Badge tone="cyan">context only · never decides</Badge></span>}>
      <p className="mb-3 text-[12px] leading-relaxed text-slate-400">The Calendar Agent, the News Analyst and the dollar, yields, silver, oil and correlation analysts discuss what moves gold. Oil is the geopolitical and inflation channel. The room meets 20 minutes after every 1-hour close and 30 minutes after a high-impact US event; the moderator concludes the macro bias for the next 4 to 24 hours. Every room's News Analyst reads it, and the Global decision shows it as the MACRO row.</p>
      {loading && !data ? <Skeleton rows={4} /> : !m ? (
        <div className="space-y-3">
          <Empty>The Macro War Room has not met yet. Its first session is 20 minutes after the first 1-hour close once the market reopens (Sunday evening UTC), or 30 minutes after a high-impact US event.</Empty>
          <div>
            <div className="eyebrow mb-1.5 text-[10px]">Agents</div>
            <div className="grid gap-2 md:grid-cols-2">
              {ROSTER.map(([name, role]) => (
                <div key={name} className="glass-inner px-3 py-2">
                  <div className="mb-0.5 flex items-center gap-2 text-[11px]"><b className="text-slate-100">{name}</b><span className="text-slate-500">waiting for the first session</span></div>
                  <p className="text-[11.5px] leading-relaxed text-slate-400">{role}</p>
                </div>
              ))}
              <div className="glass-inner px-3 py-2 md:col-span-2">
                <div className="mb-0.5 text-[11px]"><b className="text-slate-100">Moderator</b></div>
                <p className="text-[11.5px] leading-relaxed text-slate-400">concludes the macro bias for gold over the next 4 to 24 hours, with its reasons and drivers</p>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="glass-inner border-cyan-400/20 p-3">
            <div className="mb-2 text-[11px] text-slate-500">Session {sessionWord(m)} · {String(m.at ?? "").slice(5, 16).replace("T", " ")} UTC</div>
            {!c ? <p className="text-[12px] text-slate-400">The room has not concluded yet.</p> : (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="flex shrink-0 flex-col gap-1 sm:w-36">
                  <span className="eyebrow text-[9px]">Macro bias</span>
                  <div className={`mono whitespace-nowrap text-[24px] font-extrabold leading-none ${stanceColor(c.bias)}`} style={{ textShadow: "0 0 18px currentColor" }}>{c.bias}</div>
                  <div className="mono text-[11px] text-slate-400">confidence {pc(c.confidence)}</div>
                  <div className="text-[10px] text-slate-500">{c.horizon}</div>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="glass-inner px-3 py-2.5 text-[12px] leading-relaxed text-slate-200">{c.summary}</p>
                  {!!c.reasons?.length && <ul className="mt-2 list-disc space-y-1 pl-5 text-[11.5px] text-slate-300">{c.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>}
                  {!!c.drivers?.length && <p className="mt-2 text-[11px] text-slate-500">Driven by: {c.drivers.join(", ")}</p>}
                </div>
              </div>
            )}
          </div>
          <div>
            <div className="eyebrow mb-1.5 text-[10px]">Communication bus</div>
            <div className="grid gap-2 md:grid-cols-2">
              {m.openings.map((o: any) => (
                <div key={o.agent} className="glass-inner px-3 py-2">
                  <div className="mb-1 flex items-center gap-2 text-[11px]"><b className="text-slate-100">{o.name}</b>{o.status === "ok" ? <><Stance value={o.bias} /><span className="mono text-slate-500">{pc(o.confidence)}</span></> : <span className="text-slate-500">{o.status}</span>}</div>
                  {o.claim && <p className="text-[11.5px] leading-relaxed text-slate-300">{o.claim}</p>}
                </div>
              ))}
            </div>
          </div>
          {m.debate?.some((d: any) => d.status === "ok") ? (
            <div>
              <div className="eyebrow mb-1.5 text-[10px]">Consensus Discussion</div>
              <div className="space-y-2">
                {m.debate.filter((d: any) => d.status === "ok").map((d: any) => (
                  <div key={d.agent} className="glass-inner px-3 py-2">
                    <div className="mb-1 flex items-center gap-2 text-[11px]"><b className="text-slate-100">{d.name}</b><Stance value={d.bias} /><span className="mono text-slate-500">{pc(d.confidence)}</span></div>
                    <p className="text-[11.5px] leading-relaxed text-slate-300">{d.argument}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/** Backlog 11.3: DXY, the US 10-year yield, silver and WTI crude oil beside gold, with the rolling correlation of 4h returns. */
export default function Correlations() {
  const { data, loading, error } = usePoll(() => get("/api/correlations"), 300_000);
  const v = data as any;
  const rows: any[] = v?.assets ?? [];
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      <MacroRoom />
      <Panel title="Correlations" icon={<GitCompareArrows className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="cyan">context only · never decides</Badge>}>
        <p className="text-[12px] leading-relaxed text-slate-400">Gold beside the US Dollar Index, the US 10-year yield, silver and WTI crude oil on closed 4h bars (oil sampled from its 1h bars at gold's 4h closes). The correlation is of 4h returns with gold's over {v?.windows?.short ?? 30} bars (about a week) and {v?.windows?.long ?? 120} bars (about a month). It describes the recent past; it is not a signal.</p>
      </Panel>
      {loading && !data ? <Panel><Skeleton rows={4} /></Panel> : error && !data ? <Panel><p className="text-[12px] text-rose-300">Correlations unavailable: {error}</p></Panel> : !v ? <Panel><Empty>No data yet.</Empty></Panel> : (
        <Panel title="Gold and its drivers (4h)">
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Market</th><th>Last</th><th>4h</th><th>1 day</th><th>5 days</th><th>Correlation, week</th><th>Correlation, month</th></tr></thead>
              <tbody>
                <tr>
                  <td>{v.gold.name} <span className="mono text-slate-500">{v.gold.symbol}</span></td>
                  <td className="mono">{v.gold.last?.toFixed?.(2) ?? "n/a"} <span className="text-slate-500">{when(v.gold.last_close_time)}</span></td>
                  {["4h", "1d", "5d"].map((k) => <td key={k} className={"mono " + tone(v.gold.change?.[k])}>{chg(v.gold.change?.[k], "pct")}</td>)}
                  <td className="text-slate-500">—</td><td className="text-slate-500">—</td>
                </tr>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td>{a.name} <span className="mono text-slate-500">{a.symbol}</span></td>
                    {!a.available ? <td colSpan={6} className="whitespace-normal text-slate-500">No bars cached yet: the pull adapter fetches this series once the market is open.</td> : <>
                      <td className="mono">{a.unit === "bp" ? `${a.last?.toFixed?.(3)}%` : a.last?.toFixed?.(a.id === "dxy" || a.id === "oil" ? 2 : 3)} <span className="text-slate-500">{when(a.last_close_time)}</span></td>
                      {["4h", "1d", "5d"].map((k) => <td key={k} className={"mono " + tone(a.change?.[k])}>{chg(a.change?.[k], a.unit)}</td>)}
                      <td className={"mono " + corrTone(a.correlation.short)} title={`${a.correlation.short_n} bars`}>{a.correlation.short ?? "n/a"} <span className="text-[11px] text-slate-500">{corrWord(a.correlation.short)}</span></td>
                      <td className={"mono " + corrTone(a.correlation.long)} title={`${a.correlation.long_n} bars`}>{a.correlation.long ?? "n/a"} <span className="text-[11px] text-slate-500">{corrWord(a.correlation.long)}</span></td>
                    </>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">{v.note}</p>
        </Panel>
      )}
    </div>
  );
}
