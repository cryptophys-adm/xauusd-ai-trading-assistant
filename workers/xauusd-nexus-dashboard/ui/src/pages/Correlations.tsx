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
  ["Calendar Agent", "US economic events"],
  ["News Analyst", "24h news bias"],
  ["Dollar Analyst", "US Dollar Index"],
  ["Rates Analyst", "US 10-year yield"],
  ["Metals Analyst", "Silver"],
  ["Oil Analyst", "WTI crude and geopolitics"],
  ["Correlation Analyst", "Cross-asset links"]
];
// src/macro-room.mjs macroSessionWord: hourly since 2026-11-11; stored 4-hour sessions keep their name.
const sessionWord = (m: any) => (m?.kind === "event" ? "US event +30m" : m?.kind === "event2" || m?.kind === "event_follow_up" ? "US event +2h" : m?.kind === "4h" ? "4H close" : "1H close");

/**
 * Macro War Room (owner decision 2026-11-08): the Calendar Agent, the News Analyst and the dollar,
 * yields, silver, oil and correlation analysts discuss what moves gold; the moderator concludes the macro
 * bias for the next 4 to 24 hours. Its conclusion is the MACRO witness of the Decision Engine, weighted in the quorum.
 */
function MacroRoom() {
  const { data, loading } = usePoll(() => get("/api/macro"), 120_000);
  const m = (data as any)?.macro;
  // MACRO is a weighted witness of the Decision Engine (owner 2026-11-13: not "context only"): its weight in force.
  const { data: latest } = usePoll(() => get("/api/engine/decisions?limit=1"), 300_000);
  const macroWeight: number | null = (latest as any)?.decisions?.[0]?.weights?.MACRO ?? null;
  const c = m?.conclusion?.status === "ok" ? m.conclusion : null;
  return (
    <Panel title="Macro War Room" icon={<Globe2 className="h-3.5 w-3.5 text-cyan-300" />} hint="Meets 20 min after each 1H close and 30 min after high-impact US events. Concludes the 4–24h macro bias."
      right={<span className="flex gap-1">{m?.stale ? <Badge tone="amber">stale</Badge> : null}{macroWeight != null ? <Badge tone="cyan">weight {Math.round(macroWeight * 1000) / 10}%</Badge> : null}</span>}>
      {loading && !data ? <Skeleton rows={4} /> : !m ? (
        <div className="space-y-3">
          <Empty>No session yet.</Empty>
          <div>
            <div className="eyebrow mb-1.5 text-[10px]">Agents</div>
            <div className="grid gap-2 md:grid-cols-2">
              {ROSTER.map(([name, role]) => (
                <div key={name} className="glass-inner px-3 py-2">
                  <div className="mb-0.5 flex items-center gap-2 text-[11px]"><b className="text-slate-100">{name}</b><span className="text-slate-500">waiting</span></div>
                  <p className="text-[11.5px] leading-relaxed text-slate-400">{role}</p>
                </div>
              ))}
              <div className="glass-inner px-3 py-2 md:col-span-2">
                <div className="mb-0.5 text-[11px]"><b className="text-slate-100">Moderator</b></div>
                <p className="text-[11.5px] leading-relaxed text-slate-400">4–24h macro bias</p>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="glass-inner border-cyan-400/20 p-3">
            <div className="mb-2 text-[11px] text-slate-500">{sessionWord(m)} · {String(m.at ?? "").slice(5, 16).replace("T", " ")} UTC</div>
            {!c ? <p className="text-[12px] text-slate-400">No conclusion yet.</p> : (
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
                  {!!c.drivers?.length && <p className="mt-2 text-[11px] text-slate-500">Drivers: {c.drivers.join(", ")}</p>}
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
  const hint = [`Correlation of 4h returns with gold over ${v?.windows?.short ?? 30} bars (~1 week) and ${v?.windows?.long ?? 120} bars (~1 month). Context, not a signal.`, v?.note].filter(Boolean).join(" ");
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      <MacroRoom />
      {loading && !data ? <Panel><Skeleton rows={4} /></Panel> : error && !data ? <Panel><p className="text-[12px] text-rose-300">Unavailable: {error}</p></Panel> : !v ? <Panel><Empty>No data yet.</Empty></Panel> : (
        <Panel title="Correlations · 4h" icon={<GitCompareArrows className="h-3.5 w-3.5 text-cyan-300" />} hint={hint}>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Market</th><th>Last</th><th>4h</th><th>1D</th><th>5D</th><th>Corr 1W</th><th>Corr 1M</th></tr></thead>
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
                    {!a.available ? <td colSpan={6} className="whitespace-normal text-slate-500">No bars yet.</td> : <>
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
        </Panel>
      )}
    </div>
  );
}
