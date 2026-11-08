import { GitCompareArrows } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";

const chg = (x: number | null | undefined, unit: string) => (x == null ? "n/a" : `${x > 0 ? "+" : ""}${x}${unit === "bp" ? " bp" : "%"}`);
const tone = (x?: number | null) => (x == null ? "text-slate-500" : x > 0 ? "text-emerald-300" : x < 0 ? "text-rose-300" : "text-slate-300");
const corrTone = (c?: number | null) => (c == null ? "text-slate-500" : c >= 0.5 ? "text-emerald-300" : c <= -0.5 ? "text-rose-300" : "text-slate-300");
const corrWord = (c?: number | null) => (c == null ? "not enough bars" : Math.abs(c) < 0.2 ? "unrelated" : `${Math.abs(c) >= 0.6 ? "strongly " : ""}${c > 0 ? "with gold" : "against gold"}`);
const when = (t?: string | null) => (t ? t.slice(5, 16).replace("T", " ") : "");

/** Backlog 11.3: DXY, the US 10-year yield and silver beside gold, with the rolling correlation of 4h returns. */
export default function Correlations() {
  const { data, loading, error } = usePoll(() => get("/api/correlations"), 300_000);
  const v = data as any;
  const rows: any[] = v?.assets ?? [];
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      <Panel title="Correlations" icon={<GitCompareArrows className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="cyan">context only · never decides</Badge>}>
        <p className="text-[12px] leading-relaxed text-slate-400">Gold beside the US Dollar Index, the US 10-year yield and silver on closed 4h bars. The correlation is of 4h returns with gold's over {v?.windows?.short ?? 30} bars (about a week) and {v?.windows?.long ?? 120} bars (about a month). It describes the recent past; it is not a signal.</p>
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
                    {!a.available ? <td colSpan={6} className="text-slate-500">No bars cached yet (the pull adapter adds this series on its next 4h close).</td> : <>
                      <td className="mono">{a.unit === "bp" ? `${a.last?.toFixed?.(3)}%` : a.last?.toFixed?.(a.id === "dxy" ? 2 : 3)} <span className="text-slate-500">{when(a.last_close_time)}</span></td>
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
