import { useState } from "react";
import { LineChart } from "lucide-react";
import { Badge, Empty, Kpi, Panel, Skeleton } from "../components/ui";
import { C } from "../components/charts";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";

const pct = (x?: number | null) => (x == null ? "n/a" : `${Math.round(x * 1000) / 10}%`);
const r = (x?: number | null, sign = true) => (x == null ? "n/a" : `${sign && x > 0 ? "+" : ""}${Math.round(x * 100) / 100}R`);
const px = (x?: number | null) => (x == null ? "" : x.toFixed(2));
const when = (t?: string | null) => (t ? t.slice(5, 16).replace("T", " ") : "");
const SOURCE: Record<string, string> = { all: "All signals", h1_decision: "H1 decision (Reasoner)", strategy: "Strategy engine" };
const STATUS_TONE: Record<string, "green" | "amber" | "red" | "slate" | "cyan"> = { pending: "amber", open: "cyan", closed: "slate", cancelled: "slate" };

/** Cumulative R after each closed signal, as an SVG line with a zero line. */
function EquityCurve({ points }: { points: { t: string; r: number }[] }) {
  if (points.length < 2) return <Empty>The equity curve starts after two closed signals.</Empty>;
  const w = 640, h = 180, pad = 8;
  const ys = [0, ...points.map((p) => p.r)];
  const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
  const x = (i: number) => pad + (i / (points.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - lo) / span) * (h - 2 * pad);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.r).toFixed(1)}`).join(" ");
  const last = points.at(-1)!.r;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-[180px] w-full" role="img" aria-label={`Cumulative ${last}R over ${points.length} closed signals`}>
      <line x1={pad} x2={w - pad} y1={y(0)} y2={y(0)} stroke={C.track} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
      <path d={d} fill="none" stroke={last >= 0 ? C.bull : C.bear} strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * Performance (owner request 2026-11-07): the Signal Ledger. Every directional signal of the H1
 * Reasoner and the strategy engine, followed on closed bars to its outcome in R. Advisory only:
 * R multiples of the advice, never money, lots or positions.
 */
export default function Performance() {
  const [source, setSource] = useState<"all" | "h1_decision" | "strategy">("all");
  const [policy, setPolicy] = useState<"tp1" | "tp2">("tp1");
  const { data, loading, error } = usePoll(() => get("/api/ledger?days=30"), 120_000);
  const l = (data as any)?.ledger;
  const block = l ? (source === "all" ? l.all : l.by_source?.[source]) : null;
  const perf = block?.[policy];
  const items: any[] = (l?.items ?? []).filter((x: any) => source === "all" || x.source === source);
  const toggle = (on: boolean) => `rounded-md border px-2.5 py-1 text-[11px] font-semibold ${on ? "border-cyan-400/40 bg-cyan-400/10 text-white" : "border-white/10 text-slate-400 hover:text-white"}`;

  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      <Panel title="Performance · Signal Ledger" icon={<LineChart className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="green">R multiples · never money</Badge>}>
        <p className="text-[12px] leading-relaxed text-slate-400">
          Every BUY or SELL the system gives is followed on the closed bars after it: the entry fills when price reaches it (within {l?.rules?.fill_window_hours ?? 8} hours), then the trade ends at its target, its stop (−1R) or after {l?.rules?.hold_max_hours ?? 72} hours at the close. A bar that reaches both the stop and the target counts as the stop. The ledger never feeds a room or a decision.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(["all", "h1_decision", "strategy"] as const).map((s) => <button key={s} type="button" className={toggle(source === s)} onClick={() => setSource(s)}>{SOURCE[s]}</button>)}
          <span className="mx-1 h-4 w-px bg-white/10" />
          <button type="button" className={toggle(policy === "tp1")} onClick={() => setPolicy("tp1")}>Exit at TP1</button>
          <button type="button" className={toggle(policy === "tp2")} onClick={() => setPolicy("tp2")}>Exit at TP2</button>
        </div>
      </Panel>

      {loading && !data ? <Panel><Skeleton rows={6} /></Panel> : error && !data ? <Panel><p className="text-[12px] text-rose-300">Ledger unavailable: {error}</p></Panel> : !block ? <Panel><Empty>No ledger data yet.</Empty></Panel> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi label="Closed trades" value={String(perf?.trades ?? 0)} sub={`${block.signals} signals · ${block.open} open · ${block.pending} pending`} color={C.cyan} />
            <Kpi label="Win rate" value={pct(perf?.win_rate)} sub={`${perf?.wins ?? 0} wins / ${perf?.losses ?? 0} losses`} color={(perf?.win_rate ?? 0) >= 0.5 ? C.bull : C.wait} />
            <Kpi label="Expectancy" value={r(perf?.expectancy_r)} sub="average R per closed trade" color={(perf?.expectancy_r ?? 0) > 0 ? C.bull : (perf?.expectancy_r ?? 0) < 0 ? C.bear : C.muted} />
            <Kpi label="Total" value={r(perf?.total_r)} sub={`avg win ${r(perf?.avg_win_r)} · avg loss ${r(perf?.avg_loss_r, false)}`} color={(perf?.total_r ?? 0) >= 0 ? C.bull : C.bear} />
            <Kpi label="Profit factor" value={perf?.profit_factor == null ? "n/a" : String(perf.profit_factor)} sub="sum of wins ÷ sum of losses" color={C.violet} />
            <Kpi label="Max drawdown" value={perf?.max_drawdown_r ? `−${perf.max_drawdown_r}R` : "0R"} sub={`fill rate ${pct(block.fill_rate)}`} color={C.bear} />
          </div>

          <Panel title={`Cumulative R · ${SOURCE[source]} · exit at ${policy.toUpperCase()}`}>
            <EquityCurve points={perf?.equity ?? []} />
            <p className="mt-2 text-[11px] text-slate-500">
              Not filled or cancelled: {Object.entries(block.cancelled ?? {}).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(" · ") || "none"} · bars reaching both stop and target: {block.ambiguous}
            </p>
          </Panel>

          <Panel title="Signals (last 30 days)">
            {!items.length ? <Empty>No directional signal yet in the last 30 days. The ledger records each H1 BUY or SELL and each triggered strategy setup from 2026-11-07.</Empty> : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>Opened (UTC)</th><th>Source</th><th>Side</th><th>Entry</th><th>Stop</th><th>TP1</th><th>TP2</th><th>Status</th><th>Exit</th><th>R at TP1</th><th>R at TP2</th><th>MFE / MAE</th></tr></thead>
                  <tbody>
                    {items.map((x) => (
                      <tr key={x.id}>
                        <td className="mono">{when(x.opened_at)}</td><td className="text-slate-400">{x.source === "h1_decision" ? "H1 decision" : "Strategy"}</td>
                        <td className="mono font-bold" style={{ color: x.side === "BUY" ? C.bull : C.bear }}>{x.side}</td>
                        <td className="mono">{px(x.entry)}</td><td className="mono">{px(x.stop)}</td><td className="mono">{px(x.tp1)}</td><td className="mono">{px(x.tp2)}</td>
                        <td><Badge tone={STATUS_TONE[x.status] ?? "slate"}>{x.status}</Badge>{x.ambiguous ? <span className="ml-1 text-[10px] text-amber-200">ambiguous bar</span> : null}</td>
                        <td className="text-slate-400">{x.exit_reason ? x.exit_reason.replace(/_/g, " ") : x.status === "open" ? `open ${r(x.open_r)}` : ""}</td>
                        <td className="mono" style={{ color: (x.r_tp1 ?? 0) > 0 ? C.bull : (x.r_tp1 ?? 0) < 0 ? C.bear : undefined }}>{x.r_tp1 == null ? "" : r(x.r_tp1)}</td>
                        <td className="mono" style={{ color: (x.r_tp2 ?? 0) > 0 ? C.bull : (x.r_tp2 ?? 0) < 0 ? C.bear : undefined }}>{x.r_tp2 == null ? "" : r(x.r_tp2)}</td>
                        <td className="mono text-slate-400">{x.mfe_r == null ? "" : `${r(x.mfe_r)} / ${r(x.mae_r, false)}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
