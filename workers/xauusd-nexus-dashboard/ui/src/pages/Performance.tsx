import { useId, useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  BrainCircuit,
  Calendar,
  Compass,
  Cpu,
  Crosshair,
  Gauge,
  Layers,
  LineChart,
  RefreshCw,
  Scale,
  ShieldCheck,
  Sliders,
  Split,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import { Badge, Dot, Empty, Hint, Kpi, Panel, PollError, Skeleton, phaseOf } from "../components/ui";
import { ExitConfirmModal, type ExitTargetPosition } from "../components/ExitConfirmModal";
import { C } from "../components/charts";
import { T } from "../lib/tokens";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";

const pct = (x?: number | null) => (x == null ? "n/a" : `${Math.round(x * 1000) / 10}%`);
const r = (x?: number | null, sign = true) => (x == null ? "n/a" : `${sign && (x ?? 0) > 0 ? "+" : ""}${Math.round((x ?? 0) * 100) / 100}R`);
const px = (x?: number | null) => (x == null ? "" : x.toFixed(2));
const when = (t?: string | null) => (t ? t.slice(5, 16).replace("T", " ") : "");

const STATUS_TONE: Record<string, "ok" | "late" | "off"> = {
  pending: "late",
  open: "ok",
  closed: "off",
  cancelled: "off",
};

type ViewMode = "signal_ledger" | "omega_broker" | "disparity_knowledge";

interface EquityPoint {
  t: string;
  r: number;
  id: string;
}

/**
 * Interactive Equity Curve with area gradient, high-water mark, zero line, and rich hover inspection.
 */
function InteractiveEquityCurve({
  points,
  currency = "R",
}: {
  points: EquityPoint[];
  currency?: "R" | "USD";
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const gradId = `equity-grad-${useId().replace(/:/g, "")}`;

  if (points.length < 2) {
    return <Empty>Needs two closed trades.</Empty>;
  }

  const w = 780;
  const h = 230;
  const padTop = 18;
  const padBottom = 26;
  const padLeft = 14;
  const padRight = 14;

  let runningPeak = -Infinity;
  const metrics = points.map((p) => {
    runningPeak = Math.max(runningPeak, p.r);
    return {
      ...p,
      peak: runningPeak,
      drawdown: p.r - runningPeak,
    };
  });

  const ys = [0, ...metrics.map((m) => m.r), ...metrics.map((m) => m.peak)];
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;

  const getX = (i: number) => padLeft + (i / (points.length - 1)) * (w - padLeft - padRight);
  const getY = (v: number) => h - padBottom - ((v - lo) / span) * (h - padTop - padBottom);

  const lineD = metrics
    .map((p, i) => `${i === 0 ? "M" : "L"}${getX(i).toFixed(1)},${getY(p.r).toFixed(1)}`)
    .join(" ");

  const peakD = metrics
    .map((p, i) => `${i === 0 ? "M" : "L"}${getX(i).toFixed(1)},${getY(p.peak).toFixed(1)}`)
    .join(" ");

  const zeroY = getY(0);
  const areaD = `${lineD} L${getX(points.length - 1).toFixed(1)},${zeroY.toFixed(1)} L${getX(0).toFixed(1)},${zeroY.toFixed(1)} Z`;

  const lastR = points.at(-1)?.r ?? 0;
  const netPositive = lastR >= 0;
  const strokeColor = netPositive ? C.bull : C.bear;

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const xPos = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, (xPos - padLeft) / (rect.width - padLeft - padRight)));
    const idx = Math.round(ratio * (points.length - 1));
    setHoverIndex(idx);
  };

  const active = hoverIndex != null && metrics[hoverIndex] ? metrics[hoverIndex] : null;

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="h-[230px] w-full cursor-crosshair select-none"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIndex(null)}
        role="img"
        aria-label={`Cumulative equity curve ${lastR}R over ${points.length} signals`}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity={0.28} />
            <stop offset="65%" stopColor={strokeColor} stopOpacity={0.06} />
            <stop offset="100%" stopColor={strokeColor} stopOpacity={0.0} />
          </linearGradient>
        </defs>

        {/* Zero baseline */}
        <line
          x1={padLeft}
          x2={w - padRight}
          y1={zeroY}
          y2={zeroY}
          stroke="rgba(255,255,255,0.18)"
          strokeDasharray="4 4"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        <text
          x={padLeft + 4}
          y={zeroY - 4}
          fontSize="9"
          fill="#64748b"
          className="mono"
        >
          0 {currency}
        </text>

        {/* High water mark peak line: grey, it is no direction and no warning */}
        <path
          d={peakD}
          fill="none"
          stroke={T.fg2}
          strokeWidth={1.2}
          strokeDasharray="3 3"
          opacity={0.55}
          vectorEffect="non-scaling-stroke"
        />

        {/* Area fill */}
        <path d={areaD} fill={`url(#${gradId})`} />

        {/* Main equity curve line */}
        <path
          d={lineD}
          fill="none"
          stroke={strokeColor}
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />

        {/* Interactive hover crosshair and marker */}
        {active && hoverIndex != null && (
          <g>
            <line
              x1={getX(hoverIndex)}
              x2={getX(hoverIndex)}
              y1={padTop}
              y2={h - padBottom}
              stroke="rgba(255,255,255,0.3)"
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={getX(hoverIndex)}
              cy={getY(active.peak)}
              r={3}
              fill={T.fg2}
              opacity={0.8}
            />
            <circle
              cx={getX(hoverIndex)}
              cy={getY(active.r)}
              r={7}
              fill={strokeColor}
              opacity={0.25}
            />
            <circle
              cx={getX(hoverIndex)}
              cy={getY(active.r)}
              r={4}
              fill="#ffffff"
              stroke={strokeColor}
              strokeWidth={2}
            />
          </g>
        )}
      </svg>

      {/* Hover tooltip card */}
      {active && (
        <div className="pointer-events-none absolute right-3 top-3 z-10 flex flex-col gap-1 rounded-lg border border-cyan-400/30 bg-[#0d121c]/95 p-2.5 shadow-xl backdrop-blur-md">
          <div className="flex items-center justify-between gap-4 border-b border-white/10 pb-1 text-[10px] text-slate-400">
            <span className="mono">#{hoverIndex! + 1} · {when(active.t)}</span>
            <span className="mono text-cyan-300 font-semibold">{active.id.slice(0, 16)}...</span>
          </div>
          <div className="grid grid-cols-3 gap-3 pt-1 text-[11px]">
            <div>
              <span className="text-[11px] text-muted">Cumulative</span>
              <p className="mono font-bold" style={{ color: active.r >= 0 ? C.bull : C.bear }}>
                {active.r >= 0 ? "+" : ""}{active.r.toFixed(2)}{currency}
              </p>
            </div>
            <div>
              <span className="text-[11px] text-muted">Peak</span>
              <p className="mono font-bold text-fg-2">
                {active.peak.toFixed(2)}{currency}
              </p>
            </div>
            <div>
              <span className="text-[11px] text-muted">Drawdown</span>
              <p className="mono font-bold text-bear">
                {active.drawdown.toFixed(2)}{currency}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Underwater Drawdown Curve (measuring depth and duration of equity retracements).
 */
function UnderwaterDrawdownChart({
  points,
  currency = "R",
}: {
  points: EquityPoint[];
  currency?: "R" | "USD";
}) {
  if (points.length < 2) return null;

  const w = 780;
  const h = 100;
  const pad = 12;

  let peak = -Infinity;
  const dds = points.map((p) => {
    peak = Math.max(peak, p.r);
    return p.r - peak;
  });

  const maxDd = Math.min(...dds, -0.01);
  const getX = (i: number) => pad + (i / (points.length - 1)) * (w - 2 * pad);
  const getY = (val: number) => pad + (val / maxDd) * (h - 2 * pad);

  const lineD = dds.map((v, i) => `${i === 0 ? "M" : "L"}${getX(i).toFixed(1)},${getY(v).toFixed(1)}`).join(" ");
  const areaD = `${lineD} L${getX(points.length - 1).toFixed(1)},${pad} L${getX(0).toFixed(1)},${pad} Z`;

  return (
    <div className="relative mt-2 border-t border-white/5 pt-2">
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="flex items-center gap-1.5 text-slate-400 font-medium">
          <TrendingDown className="h-3.5 w-3.5 text-bear" />
          Drawdown
        </span>
        <span className="mono text-[10px] text-bear">
          Max DD: {maxDd.toFixed(2)}{currency}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="h-[80px] w-full"
        role="img"
        aria-label="Underwater drawdown curve"
      >
        <line
          x1={pad}
          x2={w - pad}
          y1={pad}
          y2={pad}
          stroke="rgba(255,255,255,0.15)"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
        <path d={areaD} fill="rgba(251,113,133,0.18)" />
        <path
          d={lineD}
          fill="none"
          stroke={C.bear}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}

type Policy = "tp1" | "tp2" | "omega" | "omega4";
/** The exit policy in the equity panel's empty line. */
const POLICY_SHORT: Record<Policy, string> = { tp1: "TP1", tp2: "TP2", omega: "Omega v3", omega4: "Omega v4" };
const MODES = ["scalp", "intraday", "swing", "range"] as const;
// v3 and v4 exits (v4: the live engine's own close reasons, src/ledger-omega4.mjs; the parity table uses the same codes).
const OMEGA_EXIT: Record<string, string> = {
  target: "target", trailed_target: "trailed TP", stop: "stop", sl_plus: "SL+", power_reversal: "power reversed", lean_flip: "lean flipped",
  confidence_drop: "confidence dropped", opposite: "opposite", time: "time",
  pm_take_profit_weakening: "PM: weakening", pm_cut_loss: "PM: cut loss", mean_reversal: "mean reversal", opposite_5m: "opposite 5m",
  kill: "kill", data_gap: "data gap", stop_out: "stop-out", manual: "manual", expert: "EA close"
};
const exitText = (code: any) => (code == null ? "—" : OMEGA_EXIT[code] ?? String(code).replace(/_/g, " "));

/**
 * The plan's targets and the Omega policy per trading mode (owner 2026-11-12: "kebijakan Omega di
 * Signal Ledger sesuai dengan mode intraday, swing, dan scalping"), the same signals under each.
 */
function ModePolicyTable({ byMode }: { byMode: any }) {
  if (!byMode) return <Empty>No per-mode data yet.</Empty>;
  const cell = (p: any) =>
    !p?.trades ? (
      <span className="text-slate-500">—</span>
    ) : (
      <span className="mono">
        <span style={{ color: (p.total_r ?? 0) >= 0 ? C.bull : C.bear }}>{r(p.total_r)}</span>
        <span className="text-slate-500"> · {p.trades} · WR {pct(p.win_rate)} · E {r(p.expectancy_r)}</span>
      </span>
    );
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Mode</th>
            <th>Signals</th>
            <th>TP1</th>
            <th>TP2</th>
            <th>Omega</th>
            <th>Omega max DD</th>
            <th>Omega vs TP1</th>
            <th>Omega v4</th>
            <th>v4 vs v3</th>
            <th>Skipped</th>
          </tr>
        </thead>
        <tbody>
          {MODES.map((m) => {
            const b = byMode[m];
            const o = b?.omega;
            const pr = o?.paired;
            const o4 = b?.omega4;
            const p4 = o4?.paired;
            return (
              <tr key={m}>
                <td className="font-semibold capitalize text-slate-200">{m}</td>
                <td className="mono">{b?.signals ?? 0}</td>
                <td>{cell(b?.tp1)}</td>
                <td>{cell(b?.tp2)}</td>
                <td>{cell(o)}</td>
                <td className="mono text-bear">{o?.trades ? (o.max_drawdown_r ? `−${o.max_drawdown_r}R` : "0R") : "—"}</td>
                <td className="mono">
                  {pr?.trades ? (
                    <>
                      {r(pr.omega_r)} vs {r(pr.plan_r)}
                      <span className="text-slate-500"> · better: Omega {pr.omega_better}, TP1 {pr.plan_better} / {pr.trades}</span>
                    </>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </td>
                <td>{cell(o4)}</td>
                <td className="mono">
                  {p4?.trades ? (
                    <>
                      {r(p4.v4_r)} vs {r(p4.v3_r)}
                      <span className="text-slate-500"> · better: v4 {p4.v4_better}, v3 {p4.v3_better} / {p4.trades}</span>
                    </>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </td>
                <td className="text-[11px] text-slate-400">
                  {Object.entries(o?.skipped ?? {})
                    .map(([k, v]) => `${k.replace(/_/g, " ")} (${v})`)
                    .join(" · ") || "—"}
                  {Object.keys(o4?.skipped ?? {}).length ? (
                    <span className="block text-slate-500">
                      v4:{" "}
                      {Object.entries(o4.skipped)
                        .map(([k, v]) => `${k.replace(/_/g, " ")} (${v})`)
                        .join(" · ")}
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Outcome Distribution Histogram (Buckets of R-multiples).
 */
function OutcomeDistributionHistogram({ items, policy }: { items: any[]; policy: Policy }) {
  const rKey = policy === "tp2" ? "r_tp2" : policy === "omega" ? "r_omega" : policy === "omega4" ? "r_omega4" : "r_tp1";
  const closed = items.filter((x) => (policy === "omega" ? x.omega_status : policy === "omega4" ? x.omega4_status : x.status) === "closed" && Number.isFinite(x[rKey]));

  const buckets = useMemo(() => {
    const b = [
      { label: "> +2.0R", min: 2.0, max: Infinity, count: 0, tone: C.bull },
      { label: "+1.0 to +2.0R", min: 1.0, max: 2.0, count: 0, tone: C.bull },
      { label: "+0.2 to +1.0R", min: 0.2, max: 1.0, count: 0, tone: C.cyan },
      { label: "0.0 to +0.2R (BE)", min: 0.0, max: 0.2, count: 0, tone: C.wait },
      { label: "-0.5 to 0.0R", min: -0.5, max: 0.0, count: 0, tone: C.wait },
      { label: "-1.0 to -0.5R", min: -1.0, max: -0.5, count: 0, tone: C.bear },
      { label: "< -1.0R", min: -Infinity, max: -1.0, count: 0, tone: C.bear },
    ];

    for (const item of closed) {
      const val = item[rKey];
      for (const bucket of b) {
        if (val >= bucket.min && val < bucket.max) {
          bucket.count++;
          break;
        }
      }
    }
    return b;
  }, [closed, rKey]);

  const maxCount = Math.max(...buckets.map((b) => b.count), 1);

  if (!closed.length) {
    return <Empty>No closed trades.</Empty>;
  }

  return (
    <div className="space-y-2 pt-1">
      {buckets.map((b) => {
        const pctVal = Math.round((b.count / closed.length) * 100);
        const barWidth = Math.max(3, Math.round((b.count / maxCount) * 100));
        return (
          <div key={b.label} className="flex items-center gap-2 text-[11px]">
            <span className="mono w-28 shrink-0 text-slate-400">{b.label}</span>
            <div className="relative h-4 flex-1 overflow-hidden rounded-sm bg-white/4">
              <div
                className="h-full rounded-sm transition-all duration-500"
                style={{
                  width: `${barWidth}%`,
                  background: b.tone,
                  opacity: b.count > 0 ? 0.75 : 0.15,
                }}
              />
            </div>
            <span className="mono w-16 text-right font-semibold text-slate-300">
              {b.count} ({pctVal}%)
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Excursion Matrix: MFE vs MAE efficiency analysis.
 */
function ExcursionMatrix({ items }: { items: any[] }) {
  const closedWithExcursion = items.filter(
    (x) => Number.isFinite(x.mfe_r) && Number.isFinite(x.mae_r)
  );

  if (!closedWithExcursion.length) {
    return <Empty>No excursion data yet.</Empty>;
  }

  const avgMfe =
    closedWithExcursion.reduce((s, x) => s + (x.mfe_r || 0), 0) / closedWithExcursion.length;
  const avgMae =
    closedWithExcursion.reduce((s, x) => s + (x.mae_r || 0), 0) / closedWithExcursion.length;
  const edgeEfficiency =
    avgMfe + Math.abs(avgMae) > 0 ? (avgMfe / (avgMfe + Math.abs(avgMae))) * 100 : 50;

  return (
    <div className="space-y-3 pt-1">
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-white/5 bg-white/2 p-2.5">
          <span className="text-[11px] text-muted">Avg MFE</span>
          <p className="mono text-[16px] font-bold text-bull">+{avgMfe.toFixed(2)}R</p>
        </div>
        <div className="rounded-lg border border-white/5 bg-white/2 p-2.5">
          <span className="text-[11px] text-muted">Avg MAE</span>
          <p className="mono text-[16px] font-bold text-bear">−{Math.abs(avgMae).toFixed(2)}R</p>
        </div>
        <div className="rounded-lg border border-white/5 bg-white/2 p-2.5">
          <span className="text-[11px] text-muted">Efficiency</span>
          <p className="mono text-[16px] font-bold text-cyan-400">{Math.round(edgeEfficiency)}%</p>
        </div>
      </div>
      <div className="space-y-1">
        <div className="flex justify-between text-[10px] text-slate-400">
          <span>MAE</span>
          <span className="font-semibold text-cyan-300">MFE</span>
        </div>
        <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-white/6">
          <div
            className="h-full rounded-full bg-linear-to-r from-bear-fill via-amber-400 to-bull-fill transition-all duration-500"
            style={{ width: `${edgeEfficiency}%` }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Renders the exact price level of progressive Stop Loss (SL+).
 */
function SlPlusPricePoint({ item }: { item: any }) {
  const dir = item.side === "BUY" ? 1 : -1;
  const slPlusPrice = item.progressive_stop ?? item.entry;
  const triggerLevel = item.entry + dir * 0.5 * Math.abs(item.tp1 - item.entry);

  if (item.sl_plus_triggered) {
    return (
      <div className="flex flex-col">
        <span className="mono font-bold text-ok">
          LOCKED @ {px(slPlusPrice)}
        </span>
        <span className="text-[10px] text-slate-400">
          {item.sl_plus_at ? when(item.sl_plus_at) : "Break-even"}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <span className="mono text-slate-300">
        SL+ {px(slPlusPrice)}
      </span>
      <span className="text-[10px] text-slate-500">
        Trigger {px(triggerLevel)}
      </span>
    </div>
  );
}

/**
 * Omega Live Execution Panel (Pure MT5 Real Trading Broker View).
 */
function OmegaExecutionPanel({ omega }: { omega: any }) {
  const [closingTicket, setClosingTicket] = useState<number | null>(null);
  const [exitNotice, setExitNotice] = useState<{ tone: string; text: string } | null>(null);
  const [exitModalPosition, setExitModalPosition] = useState<ExitTargetPosition | null>(null);

  const requestExitPosition = (pos: ExitTargetPosition) => {
    setExitModalPosition(pos);
  };

  const confirmExitPosition = async (ticket: number) => {
    setClosingTicket(ticket);
    try {
      const res = await fetch("/omega/api/position/close", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ticket, reason: "manual_user_exit" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setExitNotice({
        tone: "text-ok",
        text: `Close sent for #${ticket}.`,
      });
      setExitModalPosition(null);
    } catch (err: any) {
      setExitNotice({
        tone: "text-fault",
        text: `Close failed for #${ticket}: ${err?.message || "error"}`,
      });
    } finally {
      setClosingTicket(null);
    }
  };

  if (!omega) {
    return (
      <Panel title="Omega Execution" icon={<Cpu className="h-4 w-4 text-cyan-400" />}>
        <Empty>No terminal data.</Empty>
      </Panel>
    );
  }

  const br = omega.bridge || {};
  const tca = omega.tca || {};
  const route = omega.route || {};
  const vol = omega.volatility || {};
  const positions: any[] = br.positions || [];
  const intents: any[] = omega.intents || [];


  // Extract dynamic slippage and latency metrics directly from intents
  const completedIntents = intents.filter((it) => it.status === "done" && it.result?.ok);
  const measuredSlippages = completedIntents
    .map((it) => it.result?.slippage_pts)
    .filter((v): v is number => typeof v === "number");
  const dynamicAvgSlippage = measuredSlippages.length
    ? Number((measuredSlippages.reduce((a, b) => a + Math.abs(b), 0) / measuredSlippages.length).toFixed(1))
    : tca.avg_slippage_points;

  const measuredLatencies = completedIntents
    .map((it) => it.result?.latency_ms ?? (it.created_ms && it.result?.executed_ms ? it.result.executed_ms - it.created_ms : null))
    .filter((v): v is number => typeof v === "number" && v > 0);
  const dynamicAvgLatency = measuredLatencies.length
    ? Math.round(measuredLatencies.reduce((a, b) => a + b, 0) / measuredLatencies.length)
    : tca.avg_latency_ms;

  return (
    <div className="space-y-4">
      {/* Execution KPI header: advisory only, never money (owner 2026-11-12: Financial Management is its own module) */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Kpi
          label="Avg Slippage"
          value={dynamicAvgSlippage != null ? `${dynamicAvgSlippage} pts` : "—"}
          sub={`Max: ${tca.max_slippage_points ?? "—"} pts · ${completedIntents.length} fills`}
          icon={<Sliders className="h-3.5 w-3.5 text-cyan-400" />}
        />
        <Kpi
          label="Latency"
          value={dynamicAvgLatency != null ? `${dynamicAvgLatency} ms` : "n/a"}
          sub={`Route: ${route.active_route || "—"}`}
          icon={<Zap className="h-3.5 w-3.5 text-violet-400" />}
        />
        <Kpi
          label="Fill Quality"
          value={tca.quality || (dynamicAvgSlippage != null ? (dynamicAvgSlippage <= 5 ? "PRIME" : "ACCEPTABLE") : "—")}
          sub={`${tca.samples_count ?? 0} fills`}
          color={tca.quality === "PRIME" ? T.ok : T.late}
          icon={<ShieldCheck className="h-3.5 w-3.5 text-ok" />}
        />
      </div>

      {/* SOR & Volatility Telemetry Panel */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Panel
          title="Order Route"
          icon={<Compass className="h-3.5 w-3.5 text-cyan-400" />}
          right={<Badge tone={route.status === "trading" ? "ok" : "late"}>{route.status || "—"}</Badge>}
        >
          <div className="grid grid-cols-2 gap-3 pt-1 text-[11px]">
            <div>
              <span className="text-[11px] text-muted">Route</span>
              <p className="mono font-semibold text-slate-200">{route.active_route || "—"}</p>
            </div>
            <div>
              <span className="text-[11px] text-muted">Failover</span>
              <p className="mono font-semibold text-slate-200">{route.failover || "—"}</p>
            </div>
            <div>
              <span className="text-[11px] text-muted">Last sync</span>
              <p className={`mono font-semibold ${route.bridge_sync_age_ms != null ? "text-ok" : "text-off"}`}>{route.bridge_sync_age_ms != null ? `${Math.round(route.bridge_sync_age_ms / 1000)}s ago` : "—"}</p>
            </div>
            <div>
              <span className="text-[11px] text-muted">Terminal</span>
              <p className="mono font-semibold text-cyan-400">{br.terminal_connected === true ? "connected" : br.terminal_connected === false ? "not connected" : "—"}</p>
            </div>
          </div>
        </Panel>

        <Panel
          title="Volatility & Sizing"
          icon={<BarChart3 className="h-3.5 w-3.5 text-amber-400" />}
          right={<Badge tone="cyan">{vol.regime || "NORMAL"} REGIME</Badge>}
        >
          <div className="grid grid-cols-2 gap-3 pt-1 text-[11px]">
            <div>
              <span className="text-[11px] text-muted">ATR M15</span>
              <p className="mono font-semibold text-slate-200">{vol.atr_value != null ? String(vol.atr_value) : "—"}</p>
            </div>
            <div>
              <span className="text-[11px] text-muted">Spread</span>
              <p className="mono font-semibold text-slate-200">{br.spread_points != null ? `${br.spread_points} pts` : "n/a"}</p>
            </div>
            <div>
              <span className="text-[11px] text-muted">Risk / trade</span>
              <p className={`mono font-semibold ${omega?.engine?.risk_pct != null ? "text-ok" : "text-off"}`}>{omega?.engine?.risk_pct != null ? `${omega.engine.risk_pct}% equity` : "—"}</p>
            </div>
            <div>
              <span className="text-[11px] text-muted">Adaptive vol</span>
              <p className="mono font-semibold text-cyan-400">{vol.adaptive_enabled ? "ACTIVE" : "FIXED"}</p>
            </div>
          </div>
        </Panel>
      </div>

      {/* Open Positions in Broker MT5 */}
      <Panel
        title={`Open Positions${br.broker ? ` · ${br.broker}` : ""} (${positions.length})`}
        icon={<Activity className="h-3.5 w-3.5 text-ok" />}
        right={
          <div className="flex items-center gap-2">
            <Dot tone={positions.length > 0 ? "ok" : "off"} pulse={positions.length > 0} />
            <span className="text-[11px] text-slate-400">{positions.length > 0 ? "In market" : "Idle"}</span>
          </div>
        }
      >
        {exitNotice ? (
          <div className="mb-3 rounded-lg border border-white/10 bg-[#0d1525] p-2.5">
            <p className={`text-[11.5px] font-semibold ${exitNotice.tone}`}>{exitNotice.text}</p>
          </div>
        ) : null}
        {!positions.length ? (
          <Empty>No open positions.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Source</th>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>Volume</th>
                  <th>Open</th>
                  <th>Price</th>
                  <th>SL</th>
                  <th>TP</th>
                  <th className="text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const pSide = p.side || p.type || "SELL";
                  const curPx = pSide === "SELL" ? br.ask : br.bid;
                  const isManual = p.source === "manual" || p.magic === 0;
                  return (
                    <tr key={p.ticket}>
                      <td className="mono font-bold text-cyan-300">#{p.ticket}</td>
                      <td>
                        {isManual ? (
                          <span className="inline-flex items-center gap-1 rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 border border-amber-500/30">
                            MANUAL
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-sm bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300 border border-cyan-400/30">
                            OMEGA
                          </span>
                        )}
                      </td>
                      <td className="mono font-semibold">{p.symbol || br.symbol || "—"}</td>
                      <td
                        className="mono font-bold"
                        style={{ color: pSide === "BUY" ? C.bull : C.bear }}
                      >
                        {pSide}
                      </td>
                      <td className="mono">{p.volume ?? 0.01}</td>
                      <td className="mono font-semibold text-slate-200">{px(p.open_price)}</td>
                      <td className="mono text-slate-300">{curPx != null ? px(curPx) : px(p.current_price ?? p.open_price)}</td>
                      <td className="mono text-bear">{px(p.sl)}</td>
                      <td className="mono text-bull">{px(p.tp)}</td>
                      <td className="text-right">
                        <button
                          type="button"
                          disabled={closingTicket === p.ticket}
                          onClick={() =>
                            requestExitPosition({
                              ticket: p.ticket,
                              symbol: p.symbol || br.symbol || "",
                              side: pSide,
                              volume: p.volume,
                              open_price: p.open_price,
                              sl: p.sl,
                              tp: p.tp,
                            })
                          }
                          className="inline-flex items-center gap-1 rounded-sm bg-fault-fill/20 px-2.5 py-1 text-[11px] font-bold text-fault border border-fault-fill/40 hover:bg-fault-fill/30 hover:border-fault-fill active:scale-95 transition disabled:opacity-50"
                          title="Close at market"
                        >
                          {closingTicket === p.ticket ? (
                            <span className="inline-flex items-center gap-1">
                              <span className="inline-block h-2 w-2 rounded-full bg-fault-fill animate-ping" />
                              CLOSING…
                            </span>
                          ) : (
                            "CLOSE"
                          )}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Recent Completed Intents */}
      <Panel
        title={`Recent Intents (${intents.slice(0, 10).length})`}
        icon={<Zap className="h-3.5 w-3.5 text-cyan-400" />}
      >
        {!intents.length ? (
          <Empty>No intents yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Time (UTC)</th>
                  <th>Intent</th>
                  <th>Side</th>
                  <th>Volume</th>
                  <th>Price</th>
                  <th>Fill</th>
                  <th>Slippage</th>
                  <th>Latency</th>
                  <th>Ticket</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {intents.slice(0, 10).map((it, idx) => {
                  const itLat = it.result?.latency_ms ?? (it.created_ms && it.result?.executed_ms ? it.result.executed_ms - it.created_ms : null);
                  const itSlip = it.result?.slippage_pts;
                  return (
                    <tr key={it.id || idx}>
                      <td className="mono text-slate-400">{it.created_ms ? when(new Date(it.created_ms).toISOString()) : "—"}</td>
                      <td className="mono text-cyan-300">{String(it.id || it.intent_id || "intent").slice(0, 18)}</td>
                      <td className="mono font-bold" style={{ color: it.side === "BUY" ? C.bull : C.bear }}>{it.side}</td>
                      <td className="mono">{it.volume ?? 0.01}</td>
                      <td className="mono">{px(it.price || it.entry)}</td>
                      <td className="mono font-medium text-slate-200">{px(it.result?.fill_price ?? it.price ?? it.entry)}</td>
                      <td className="mono">
                        {itSlip != null ? (
                          <span style={{ color: Math.abs(itSlip) <= 3 ? T.ok : Math.abs(itSlip) <= 10 ? T.late : T.fault }}>
                            {itSlip > 0 ? "+" : ""}{itSlip} pts
                          </span>
                        ) : "—"}
                      </td>
                      <td className="mono text-violet-300">{itLat != null ? `${itLat} ms` : "—"}</td>
                      <td className="mono text-amber-300">{it.result?.ticket ? `#${it.result.ticket}` : "—"}</td>
                      <td><Badge tone={it.status === "done" ? "ok" : it.status === "failed" ? "fault" : "late"}>{it.status || "done"}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Styled Obsidian/Nexus Confirmation Modal for Market Exit */}
      <ExitConfirmModal
        position={exitModalPosition}
        isOpen={Boolean(exitModalPosition)}
        onClose={() => setExitModalPosition(null)}
        onConfirm={confirmExitPosition}
        isSubmitting={closingTicket !== null}
      />
    </div>
  );
}

/**
 * Disparity & Knowledge Engine: 100% Dynamic Comparative Analysis of Theoretical Signal vs Live MT5 Execution.
 * Dynamically computes all disparities from runtime state (no static text / state).
 * Curated for Aether Knowledge Guardian ingress.
 */
function DisparityKnowledgePanel({
  items,
  omega,
  days,
}: {
  items: any[];
  omega: any;
  days: number;
}) {
  const br = omega?.bridge || {};
  const tca = omega?.tca || {};
  const intents: any[] = omega?.intents || [];
  const positions: any[] = br.positions || [];

  // Dynamically reconcile AI signals with real execution positions & intents
  const dynamicMatches = useMemo(() => {
    return items.map((signal) => {
      const sigTime = new Date(signal.opened_at).getTime();

      // Find matching intent by ID, timestamp within 15 mins, or side
      const matchedIntent = intents.find((it) => {
        if (it.id && signal.id && it.id.includes(signal.id)) return true;
        if (!it.created_ms) return false;
        return Math.abs(it.created_ms - sigTime) <= 900_000;
      });

      // Find matching position in MT5 by intent_id, ticket, or side & entry price proximity
      const matchedPos = positions.find((p) => {
        if (p.intent_id && matchedIntent?.id && p.intent_id === matchedIntent.id) return true;
        if (p.ticket && matchedIntent?.result?.ticket && p.ticket === matchedIntent.result.ticket) return true;
        const pSide = p.side || p.type;
        return pSide === signal.side && Math.abs(Number(p.open_price) - Number(signal.entry)) < 3.0;
      });

      const fillPrice = matchedPos?.open_price ?? matchedIntent?.result?.fill_price ?? signal.entry;
      const priceGap = fillPrice - signal.entry;
      // Favorable slippage: for SELL higher fill is positive; for BUY lower fill is positive
      const dirFactor = signal.side === "SELL" ? 1 : -1;
      const slippagePoints = matchedIntent?.result?.slippage_pts ?? Number((priceGap * 10 * dirFactor).toFixed(1));

      const latencyMs = matchedIntent?.result?.latency_ms
        ?? (matchedIntent?.created_ms && matchedIntent?.result?.executed_ms ? matchedIntent.result.executed_ms - matchedIntent.created_ms : null)
        ?? (matchedPos?.opened_ms && matchedIntent?.created_ms ? matchedPos.opened_ms - matchedIntent.created_ms : null);

      const ticket = matchedPos?.ticket ?? matchedIntent?.result?.ticket ?? null;
      const realSl = matchedPos?.sl ?? null;
      const realTp = matchedPos?.tp ?? null;

      return {
        ...signal,
        fillPrice,
        priceGap,
        slippagePoints,
        latencyMs,
        ticket,
        realSl,
        realTp,
        isLivePosition: Boolean(matchedPos),
        hasExecutionRecord: Boolean(ticket || matchedIntent),
      };
    });
  }, [items, intents, positions]);

  // Dynamic Aggregation from Actual Matches and Live Telemetry
  const executedRecords = dynamicMatches.filter((m) => m.hasExecutionRecord);
  const slippagesList = executedRecords.map((m) => m.slippagePoints).filter((v): v is number => typeof v === "number");
  const latenciesList = executedRecords.map((m) => m.latencyMs).filter((v): v is number => typeof v === "number" && v > 0);

  // Measured values only (owner 2026-11-13: nothing invented): null when there is no sample.
  const dynamicAvgSlippage: number | null = slippagesList.length
    ? Number((slippagesList.reduce((a, b) => a + Math.abs(b), 0) / slippagesList.length).toFixed(1))
    : (tca.avg_slippage_points ?? null);

  const dynamicMaxSlippage: number | null = slippagesList.length
    ? Number(Math.max(...slippagesList.map((s) => Math.abs(s))).toFixed(1))
    : (tca.max_slippage_points ?? null);

  const dynamicAvgLatency: number | null = latenciesList.length
    ? Math.round(latenciesList.reduce((a, b) => a + b, 0) / latenciesList.length)
    : (tca.avg_latency_ms ?? null);

  const dynamicLiveSpread: number | null = br.spread_points != null ? Number(br.spread_points) : null;

  // Dynamic Count of favorable vs adverse fills
  const favorableCount = slippagesList.filter((s) => s > 0).length;
  const adverseCount = slippagesList.filter((s) => s < 0).length;
  const neutralCount = slippagesList.filter((s) => s === 0).length;

  return (
    <div className="space-y-4">
      {/* Dynamic Fidelity & Disparity Overview KPI */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <Kpi
          label="Matched"
          value={`${executedRecords.length} / ${items.length}`}
          sub={`last ${days}D`}
          icon={<BrainCircuit className="h-3.5 w-3.5 text-ok" />}
        />
        <Kpi
          label="Avg Slippage"
          value={dynamicAvgSlippage != null ? `±${dynamicAvgSlippage} pts` : "—"}
          sub={dynamicMaxSlippage != null ? `Max ${dynamicMaxSlippage} pts · ${slippagesList.length} fills` : "No fills yet"}
          color={dynamicAvgSlippage == null ? undefined : dynamicAvgSlippage <= 5 ? T.ok : T.fault}
          icon={<Split className="h-3.5 w-3.5 text-cyan-400" />}
        />
        <Kpi
          label="Latency"
          value={dynamicAvgLatency != null ? `${dynamicAvgLatency} ms` : "—"}
          sub={latenciesList.length ? `${latenciesList.length} fills` : "No fills yet"}
          icon={<Zap className="h-3.5 w-3.5 text-violet-400" />}
        />
        <Kpi
          label="Spread"
          value={dynamicLiveSpread != null ? `${dynamicLiveSpread} pts` : "—"}
          sub={`Bid: ${px(br.bid)} · Ask: ${px(br.ask)}`}
          color={dynamicLiveSpread == null ? undefined : dynamicLiveSpread <= 30 ? T.ok : T.late}
          icon={<Activity className="h-3.5 w-3.5 text-amber-400" />}
        />
      </div>

      {/* Dynamic Disparity Comparison Matrix */}
      <Panel
        title="Signal vs Fill"
        icon={<Gauge className="h-3.5 w-3.5 text-cyan-400" />}
        hint="Plan entry, timing and SL+ against Omega's fills on the MT5 terminal."
      >
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Signal</th>
                <th>Omega fill</th>
                <th>Gap</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {/* Row 1: Entry Fill */}
              <tr>
                <td className="font-semibold text-slate-200">Entry</td>
                <td className="mono text-cyan-300">Plan entry</td>
                <td className="mono text-slate-200">
                  {executedRecords[0]?.fillPrice ? `${px(executedRecords[0].fillPrice)} (latest)` : "No fill"}
                </td>
                <td className="mono" style={{ color: dynamicAvgSlippage == null ? undefined : dynamicAvgSlippage <= 3 ? T.ok : dynamicAvgSlippage <= 10 ? T.late : T.fault }}>
                  {dynamicAvgSlippage != null ? `Avg ${dynamicAvgSlippage} pts · ${favorableCount} fav / ${adverseCount} adv` : "—"}
                </td>
                <td>
                  {dynamicAvgSlippage == null ? <Badge tone="slate">NO SAMPLE</Badge> : (
                    <Badge tone={dynamicAvgSlippage <= 5 ? "ok" : dynamicAvgSlippage <= 15 ? "late" : "fault"}>
                      {dynamicAvgSlippage <= 5 ? "≤ 5 pts" : dynamicAvgSlippage <= 15 ? "5–15 pts" : "> 15 pts"}
                    </Badge>
                  )}
                </td>
              </tr>

              {/* Row 2: Latency */}
              <tr>
                <td className="font-semibold text-slate-200">Latency</td>
                <td className="mono text-cyan-300">Decision time</td>
                <td className="mono text-slate-200">Intent to fill</td>
                <td className="mono text-violet-300">
                  {dynamicAvgLatency != null ? `Avg ${dynamicAvgLatency} ms` : "—"}
                </td>
                <td>
                  {dynamicAvgLatency == null ? <Badge tone="slate">NO SAMPLE</Badge> : <Badge tone={dynamicAvgLatency <= 1500 ? "ok" : "late"}>{dynamicAvgLatency <= 1500 ? "≤ 1.5 s" : "> 1.5 s"}</Badge>}
                </td>
              </tr>

              {/* Row 3: Progressive Stop (SL+) */}
              <tr>
                <td className="font-semibold text-slate-200">SL+</td>
                <td className="mono text-cyan-300">Plan SL+</td>
                <td className="mono text-slate-200">
                  {positions[0]?.sl ? `SL ${px(positions[0].sl)}` : "No position"}
                </td>
                <td className="mono text-slate-300">
                  {executedRecords.filter((m) => m.sl_plus_triggered).length} of {executedRecords.length} triggered
                </td>
                <td>
                  <Badge tone={executedRecords.some((m) => m.sl_plus_triggered) ? "ok" : "off"}>
                    {executedRecords.some((m) => m.sl_plus_triggered) ? "SL+ REACHED" : "NOT YET"}
                  </Badge>
                </td>
              </tr>

            </tbody>
          </table>
        </div>
      </Panel>

      {/* What Aether receives: the hourly execution report (src/signal-ledger.mjs executionReport, pushExecutionReport),
          per trading mode in R. Nothing on this page is sent (owner 2026-11-13: no invented payload). */}

      {/* Dynamic Disparity Drilldown Table */}
      <Panel
        title={`Fills by Signal (${dynamicMatches.length})`}
        icon={<Layers className="h-3.5 w-3.5 text-cyan-400" />}
        right={<Badge tone="cyan">{days}D</Badge>}
      >
        {!dynamicMatches.length ? (
          <Empty>No signals in this window.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Time (UTC)</th>
                  <th>Side</th>
                  <th>Entry</th>
                  <th>Fill</th>
                  <th>Slippage</th>
                  <th>Latency</th>
                  <th>SL+</th>
                  <th>Ticket</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {dynamicMatches.map((m) => (
                  <tr key={m.id}>
                    <td className="mono text-slate-400">{when(m.opened_at)}</td>
                    <td className="mono font-bold" style={{ color: m.side === "BUY" ? C.bull : C.bear }}>{m.side}</td>
                    <td className="mono">{px(m.entry)}</td>
                    <td className="mono font-semibold text-slate-200">{px(m.fillPrice)}</td>
                    <td className="mono">
                      {m.slippagePoints != null ? (
                        <span style={{ color: m.slippagePoints >= 0 ? T.ok : Math.abs(m.slippagePoints) <= 5 ? T.late : T.fault }}>
                          {m.slippagePoints > 0 ? "+" : ""}{m.slippagePoints} pts
                        </span>
                      ) : "—"}
                    </td>
                    <td className="mono text-violet-300">{m.latencyMs != null ? `${m.latencyMs} ms` : "—"}</td>
                    <td className="mono"><SlPlusPricePoint item={m} /></td>
                    <td className="mono text-amber-300">{m.ticket ? `#${m.ticket}` : "—"}</td>
                    <td>
                      {m.isLivePosition ? (
                        <Badge tone="ok"><Dot tone="ok" pulse /> LIVE</Badge>
                      ) : m.hasExecutionRecord ? (
                        <Badge tone="cyan">FILLED</Badge>
                      ) : (
                        <Badge tone="slate">NO FILL</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

/**
 * The v4 parity check (src/ledger-omega4.mjs omegaParity, hourly): the replay through the live engine against Omega's
 * real trades on the live USD account (owner 2026-11-20: "pastikan omega performance sama dengan omega yang live
 * sekarang"). R and exit codes only, never a price or an account.
 */
function OmegaParityPanel({ parity }: { parity: any }) {
  if (!parity) return <Empty>No parity check yet: it runs hourly from the ledger cron once v4 has replayed the live window.</Empty>;
  const th = parity.thresholds ?? {};
  const era = parity.era ?? {};
  const earlier = parity.earlier;
  const status: string = parity.status ?? (parity.pass ? "pass" : "fail");
  const tone = status === "pass" ? "ok" : status === "fail" ? "fault" : "late";
  const stamp = (t: any) => String(t ?? "").replace("T", " ").slice(0, 16);
  const trades: any[] = parity.trades ?? [];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-[12px]">
        <Badge tone={tone}>{status.toUpperCase()}</Badge>
        <span className="mono">
          {parity.live_trades ?? 0} of {parity.min_trades ?? 20} current-code live trades · {parity.trades_compared ?? 0} compared
          {parity.v4_only ? ` (${parity.v4_only} v4 only)` : ""} · same exit {pct(parity.same_exit_share)} · mean |ΔR| {parity.mean_abs_dr ?? "—"}
        </span>
        <span className="text-[11px] text-slate-500">
          pass: at least {parity.min_trades ?? 20} trades, same exit ≥ {pct(th.same_exit_min)} and mean |ΔR| ≤ {th.mean_abs_dr_max}; below {parity.min_trades ?? 20}: insufficient · checked {stamp(parity.checked_at)} UTC
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
        <span>
          Engine/PM behaviour era since <span className="mono text-slate-300">{stamp(era.since)} UTC</span>
          {era.reason ? <> · <span className="text-slate-300">{era.reason}</span></> : null}
          {era.seeded ? " (seed: after #491)" : ""}
          {era.commit ? <> · commit <span className="mono text-slate-300">{era.commit}</span></> : null}
          {era.behaviour_hash ? <> · behaviour <span className="mono text-slate-300">{era.behaviour_hash}</span></> : null}
          {(era.code_hash ?? era.hash) ? <> · code <span className="mono text-slate-300">{era.code_hash ?? era.hash}</span></> : null}
          {" · switches "}
          <span className="mono text-slate-300">{Array.isArray(era.switches) && era.switches.length ? era.switches.join(", ") : "all at default"}</span>
          {Array.isArray(era.carried) && era.carried.length ? ` · carried over ${era.carried.length} code change${era.carried.length === 1 ? "" : "s"} (behaviour identical)` : ""}
          {/* The note about eras, in the (i) hint since 2026-11-22 (one-line notes on the page). */}
          <Hint className="ml-1.5 align-middle" text="A change of the engine's behaviour (at its deploy) or of a behaviour switch (at the settings change) starts a new parity window; a code change with identical behaviour carries it over." />
        </span>
      </div>
      {Array.isArray(era.previous) && era.previous.length ? (
        <p className="text-[11px] text-slate-500">
          Earlier eras:{" "}
          {era.previous.map((p: any, i: number) => (
            <span key={`${p.since}-${i}`} className="mr-2">
              <span className="mono">{stamp(p.since)}</span> to <span className="mono">{stamp(p.until)}</span>
              {p.reason ? ` (${p.reason})` : ""}
              {i < era.previous.length - 1 ? ";" : ""}
            </span>
          ))}
        </p>
      ) : null}
      {earlier?.trades_compared ? (
        <p className="text-[11px] text-slate-500">
          Earlier code (shown below, not counted): {earlier.trades_compared} trades · same exit {pct(earlier.same_exit_share)} · mean |ΔR| {earlier.mean_abs_dr ?? "—"} · since {stamp(parity.since)} UTC
        </p>
      ) : null}
      {!trades.length ? (
        <Empty>No live trade in the window yet.</Empty>
      ) : (
        <div className="table-wrap max-h-[320px] overflow-y-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Signal (UTC)</th>
                <th>Side</th>
                <th>Mode</th>
                <th>Matched</th>
                <th>Entry Δ</th>
                <th>Exit live</th>
                <th>Exit v4</th>
                <th>R live</th>
                <th>R v4</th>
                <th>ΔR</th>
                <th>Cause</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t, i) => (
                <tr key={`${t.issued_at}-${t.side}-${i}`}>
                  <td className="mono text-[11px]">
                    {String(t.issued_at).replace("T", " ").slice(0, 16)}
                    {t.live_code === "earlier" ? <span className="ml-1 text-[10px] text-slate-500">earlier (not counted)</span> : null}
                  </td>
                  <td className={`mono font-semibold ${t.side === "BUY" ? "text-bull" : "text-bear"}`}>{t.side}</td>
                  <td className="text-slate-300 capitalize">{t.mode ?? "—"}</td>
                  <td>{t.v4_only ? <Badge tone="late">v4 only</Badge> : t.matched ? <Badge tone="ok">yes</Badge> : <Badge tone="fault">no</Badge>}</td>
                  <td className="mono text-[11px]">{t.entry_diff_s == null ? "—" : `${t.entry_diff_s > 0 ? "+" : ""}${t.entry_diff_s}s`}</td>
                  <td className="text-[11px]">{exitText(t.live_exit)}</td>
                  <td className="text-[11px]" style={{ color: t.same_exit ? T.ok : undefined }}>{t.v4_exit ? exitText(t.v4_exit) : t.v4_status ?? "—"}</td>
                  <td className="mono">{r(t.live_r)}</td>
                  <td className="mono">{r(t.v4_r)}</td>
                  <td className="mono" style={{ color: t.dr != null && Math.abs(t.dr) > (th.mean_abs_dr_max ?? 0.1) ? T.fault : undefined }}>{t.dr == null ? "—" : r(t.dr)}</td>
                  <td className="text-[11px] text-slate-400">{t.cause ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Maker vs taker (docs/RFC_OMEGA_LIMIT_ENTRY.md §8, stage 2, measurement only): per mode, the limit entry at the
 * decision's level (maker, src/ledger-omega-limit.mjs) against v4's market entry (taker) on the same signals, from
 * `by_mode[mode].limit`. A missed limit counts 0R in the pair. R and counts only, never a price.
 */
function MakerTakerPanel({ byMode }: { byMode: any }) {
  if (!byMode) return <Empty>No per-mode data yet.</Empty>;
  const any = MODES.some((m) => byMode[m]?.limit?.decisions);
  if (!any) return <Empty>No limit replay yet: it runs after v4 in the ledger cron, on the minutes v4 has replayed.</Empty>;
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Mode</th>
            <th>Signals</th>
            <th>Fill rate</th>
            <th>Maker R / trade</th>
            <th>Paired R maker vs taker</th>
            <th>Mean ΔR</th>
            <th>Maker better</th>
            <th>Taker better</th>
            <th>Missed</th>
          </tr>
        </thead>
        <tbody>
          {MODES.map((m) => {
            const lim = byMode[m]?.limit;
            const p = lim?.paired;
            return (
              <tr key={m}>
                <td className="font-semibold capitalize text-slate-200">{m}</td>
                <td className="mono">{lim?.decisions ?? 0}</td>
                <td className="mono">
                  {pct(lim?.fill_rate)}
                  <span className="text-slate-500"> · {lim?.filled ?? 0} of {(lim?.filled ?? 0) + (lim?.missed ?? 0)}</span>
                </td>
                <td className="mono">{lim?.trades ? <>{r(lim.expectancy_r)}<span className="text-slate-500"> · {lim.trades}</span></> : <span className="text-slate-500">—</span>}</td>
                <td className="mono">
                  {p?.n ? (
                    <>
                      <span style={{ color: (p.maker_r ?? 0) >= (p.taker_r ?? 0) ? C.bull : C.bear }}>{r(p.maker_r)}</span> vs {r(p.taker_r)}
                      <span className="text-slate-500"> · {p.n} pairs ({p.both_traded} both traded)</span>
                    </>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </td>
                <td className="mono">{p?.mean_dr == null ? "—" : r(p.mean_dr)}</td>
                <td className="mono text-bull">{p?.n ? p.maker_better : "—"}</td>
                <td className="mono text-bear">{p?.n ? p.taker_better : "—"}</td>
                <td className="text-[11px] text-slate-400">
                  {Object.entries(lim?.missed_by ?? {})
                    .map(([k, v]) => `${k.replace(/_/g, " ")} (${v})`)
                    .join(" · ") || "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Performance (owner request 2026-11-07): the Signal Ledger. Every directional signal of the Decision
 * Engine followed on closed bars to its outcome in R. Advisory only: R multiples of the advice, never money, lots or positions.
 */
export default function Performance() {
  const [viewMode, setViewMode] = useState<ViewMode>("signal_ledger");
  const [days, setDays] = useState<number>(30);
  const [policy, setPolicy] = useState<Policy>("tp1");

  const queryUrl = days === 30 ? "/api/ledger?days=30" : `/api/ledger?days=${days}`;
  // One poll feeds every panel of the page, so its state tag shows once, beside Refresh (mockup "Nexus data states").
  const ledgerPoll = usePoll(
    () => get(queryUrl),
    60_000,
    [days]
  );
  const { data, refresh } = ledgerPoll;
  const phase = phaseOf(ledgerPoll);

  const l = (data as any)?.ledger;
  const omega = (data as any)?.omega;

  // Decision Engine is the sole active modern engine (deprecated H1 and Strategy panels removed)
  const block = l ? (l.by_source?.decision ?? l.all) : null;
  const perf = block?.[policy];
  const items: any[] = (l?.items ?? []).filter(
    (x: any) => x.source === "decision" || !x.source
  );

  const toggle = (on: boolean) =>
    `rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
      on
        ? "border-cyan-400/40 bg-cyan-400/10 text-white shadow-xs"
        : "border-white/10 text-slate-400 hover:text-white hover:bg-white/4"
    }`;

  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      {/* Top Header Panel */}
      <Panel
        title="Performance"
        icon={<LineChart className="h-4 w-4 text-cyan-300" />}
        hint={`Decision Engine signals tracked on closed bars (${l?.rules?.bars ?? "1m, else 15m"}): fill within ${l?.rules?.fill_window_hours ?? 8}h, then target, stop (−1R) or exit after ${l?.rules?.hold_max_hours ?? 72}h. Results in R.`}
        poll={ledgerPoll}
        live
        pollRetry={false}
        right={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              className="flex h-11 items-center gap-1 rounded-sm border border-white/10 px-2 py-1 text-[10px] text-slate-400 hover:text-white sm:h-auto"
              title="Refresh"
            >
              <RefreshCw className="h-3 w-3" /> Refresh
            </button>
          </div>
        }
      >
        {/* View Mode & Time Window Tabs */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Distinct Panels: Signal, Omega, Disparity */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={toggle(viewMode === "signal_ledger")}
              onClick={() => setViewMode("signal_ledger")}
            >
              Signal Ledger
            </button>
            <button
              type="button"
              className={toggle(viewMode === "omega_broker")}
              onClick={() => setViewMode("omega_broker")}
            >
              Omega Execution
            </button>
            <button
              type="button"
              className={toggle(viewMode === "disparity_knowledge")}
              onClick={() => setViewMode("disparity_knowledge")}
            >
              Signal vs Fill
            </button>
          </div>

          {/* Time range selector */}
          <div className="flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5 text-slate-400" />
            <span className="text-[11px] text-slate-400">Window:</span>
            {[7, 14, 30, 90].map((d) => (
              <button
                key={d}
                type="button"
                className={toggle(days === d)}
                onClick={() => setDays(d)}
              >
                {d}D
              </button>
            ))}
          </div>
        </div>

        {/* Target Policy Selector (for Signal Ledger) */}
        {viewMode === "signal_ledger" && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-slate-400 font-medium">Exit policy:</span>
            <button
              type="button"
              className={toggle(policy === "tp1")}
              onClick={() => setPolicy("tp1")}
            >
              Exit at TP1
            </button>
            <button
              type="button"
              className={toggle(policy === "tp2")}
              onClick={() => setPolicy("tp2")}
            >
              Exit at TP2
            </button>
            <button
              type="button"
              className={toggle(policy === "omega")}
              onClick={() => setPolicy("omega")}
              title="Omega rules: market entry, daily gates, SL+ and trailing TP"
            >
              Omega policy (v3)
            </button>
            <button
              type="button"
              className={toggle(policy === "omega4")}
              onClick={() => setPolicy("omega4")}
              title="Omega v4: the live engine replayed (planIntents, the Position Manager, the TP ladder, the re-entry cooldown, the profile's caps)"
            >
              Omega v4 (live engine)
            </button>
          </div>
        )}
        {viewMode === "signal_ledger" && l?.rules?.omega4 ? (
          <details className="mt-2 rounded-md border border-white/10 bg-white/2 px-2.5 py-1.5 text-[11px] text-slate-400">
            <summary className="cursor-pointer text-slate-300">Omega v4: how it replays live, and why a trade may differ from live</summary>
            <p className="mt-1.5">{l.rules.omega4.engine}. {l.rules.omega4.granularity}. {l.rules.omega4.unit}.</p>
            <p className="mt-1 text-slate-300">Approximations</p>
            <ul className="ml-4 list-disc">
              {(l.rules.omega4.approximations ?? []).map((a: string) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
            <p className="mt-1 text-slate-300">Not reconstructable from history</p>
            <ul className="ml-4 list-disc">
              {Object.entries(l.rules.omega4.not_reconstructable ?? {}).map(([k, v]) => (
                <li key={k}>
                  <span className="text-slate-300">{k.replace(/_/g, " ")}</span>: {String(v)}
                </li>
              ))}
            </ul>
            <p className="mt-1">{l.rules.omega4.parity}</p>
          </details>
        ) : null}
      </Panel>

      {/* Main Content Area */}
      {phase === "error" ? (
        <Panel>
          <PollError poll={ledgerPoll} />
        </Panel>
      ) : phase === "loading" ? (
        <Panel>
          <Skeleton rows={8} />
        </Panel>
      ) : (
        <>
          {/* TAB 1: SIGNAL LEDGER (TEORITIS) */}
          {viewMode === "signal_ledger" && block && (
            <>
              {/* KPI Cards */}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                <Kpi
                  label="Closed Trades"
                  value={String(perf?.trades ?? 0)}
                  sub={policy === "omega4" ? `${block.omega4?.decisions ?? 0} decisions · ${block.omega4?.open ?? 0} open · ${block.omega4?.pending ?? 0} pending` : `${block.signals} signals · ${block.open} open · ${block.pending} pending`}
                  icon={<Activity className="h-3.5 w-3.5 text-cyan-400" />}
                />
                <Kpi
                  label="Win Rate"
                  value={pct(perf?.win_rate)}
                  sub={`${perf?.wins ?? 0} wins / ${perf?.losses ?? 0} losses`}
                  color={(perf?.win_rate ?? 0) >= 0.5 ? C.bull : C.wait}
                  icon={<Scale className="h-3.5 w-3.5 text-ok" />}
                />
                <Kpi
                  label="Expectancy"
                  value={r(perf?.expectancy_r)}
                  sub="per trade"
                  color={
                    (perf?.expectancy_r ?? 0) > 0
                      ? C.bull
                      : (perf?.expectancy_r ?? 0) < 0
                      ? C.bear
                      : C.muted
                  }
                  icon={<TrendingUp className="h-3.5 w-3.5 text-ok" />}
                />
                <Kpi
                  label="Net R"
                  value={r(perf?.total_r)}
                  sub={`avg win ${r(perf?.avg_win_r)} · avg loss ${r(perf?.avg_loss_r, false)}`}
                  color={(perf?.total_r ?? 0) >= 0 ? C.bull : C.bear}
                  icon={<LineChart className="h-3.5 w-3.5 text-cyan-400" />}
                />
                <Kpi
                  label="Profit factor"
                  value={perf?.profit_factor == null ? "n/a" : String(perf.profit_factor)}
                  icon={<BarChart3 className="h-3.5 w-3.5 text-violet-400" />}
                />
                <Kpi
                  label="Max Drawdown"
                  value={perf?.max_drawdown_r ? `−${perf.max_drawdown_r}R` : "0.00R"}
                  sub={`fill rate ${pct(block.fill_rate)}`}
                  color={C.bear}
                  icon={<TrendingDown className="h-3.5 w-3.5 text-bear" />}
                />
              </div>

              {/* The plan's targets and the Omega policy per trading mode */}
              <Panel
                title="By Trading Mode"
                icon={<Layers className="h-3.5 w-3.5 text-cyan-400" />}
                hint={`Omega: ${l?.rules?.omega?.entry ?? "market entry on the bar after the decision"}; ${l?.rules?.omega?.management ?? "key-level management"}; gates: ${l?.rules?.omega?.gates ?? "the day's loss limit"}. Approximations: ${l?.rules?.omega?.approximations ?? "feed bars"}.`}
              >
                <ModePolicyTable byMode={l?.by_mode} />
              </Panel>

              {/* v4 against the live account (src/ledger-omega4.mjs omegaParity) */}
              <Panel
                title="Omega v4 Parity with Live"
                icon={<Scale className="h-3.5 w-3.5 text-cyan-400" />}
                hint={l?.rules?.omega4?.parity ?? "v4 against the live account's real Omega trades"}
              >
                <OmegaParityPanel parity={l?.parity} />
              </Panel>

              {/* The limit entry against v4's market entry on the same signals (RFC_OMEGA_LIMIT_ENTRY stage 2, measurement only) */}
              <Panel
                title="Maker vs taker"
                icon={<Split className="h-3.5 w-3.5 text-cyan-400" />}
                hint={l?.rules?.limit ? `${l.rules.limit.placement}. Missed: ${l.rules.limit.missed}. ${l.rules.limit.pairing}. Measurement only: live entries stay at market.` : "The limit entry at the decision's level against v4's market entry, per mode"}
              >
                <MakerTakerPanel byMode={l?.by_mode} />
              </Panel>

              {/* Interactive Equity Curve & Underwater Chart */}
              <Panel
                title="Equity Curve"
                icon={<TrendingUp className="h-3.5 w-3.5 text-ok" />}
                right={
                  <div className="flex items-center gap-3 text-[11px] text-slate-400">
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: (perf?.equity?.at(-1)?.r ?? 0) >= 0 ? C.bull : C.bear }} /> Equity (R)
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-2 w-2 rounded-full bg-fg-2" /> Peak
                    </span>
                    <Badge tone="cyan">{policy.toUpperCase()}</Badge>
                  </div>
                }
              >
                {(perf?.equity?.length ?? 0) < 2 ? (
                  // Empty (mockup "Nexus data states"): what is missing, and when it fills.
                  <Empty when="Draws from the 2nd closed trade. The ledger runs every 5m.">
                    {perf?.trades ?? 0} closed trade{(perf?.trades ?? 0) === 1 ? "" : "s"} · {days}D · {POLICY_SHORT[policy]}
                  </Empty>
                ) : (
                  <>
                    <InteractiveEquityCurve points={perf?.equity ?? []} currency="R" />
                    <UnderwaterDrawdownChart points={perf?.equity ?? []} currency="R" />
                  </>
                )}
                <p className="mt-2 text-[11px] text-slate-500">
                  Unfilled:{" "}
                  {Object.entries(block.cancelled ?? {})
                    .map(([k, v]) => `${k.replace(/_/g, " ")} (${v})`)
                    .join(" · ") || "none"}
                  {" · "}
                  Ambiguous: {block.ambiguous} · SL+: {block.sl_plus ?? 0}
                </p>
              </Panel>

              {/* Statistical Distribution & Excursion Analysis */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Panel
                  title="R Distribution"
                  icon={<BarChart3 className="h-3.5 w-3.5 text-cyan-400" />}
                  right={<Badge tone="purple">{perf?.trades ?? 0} Trades</Badge>}
                >
                  <OutcomeDistributionHistogram items={items} policy={policy} />
                </Panel>

                <Panel
                  title="MFE / MAE"
                  icon={<Crosshair className="h-3.5 w-3.5 text-ok" />}
                >
                  <ExcursionMatrix items={items} />
                </Panel>
              </div>

              {/* The decisions the no-stacking rule held back (owner 2026-11-13: "pastikan semua ada visualisasi") */}
              <Panel
                title={`Held Back (${l?.held?.count ?? 0})`}
                icon={<Layers className="h-3.5 w-3.5 text-amber-300" />}
                hint="No stacking: a same-side signal waits while an earlier one is unfilled or unprotected. Not counted in results."
              >
                {!(l?.held?.items ?? []).length ? (
                  <Empty>None held back.</Empty>
                ) : (
                  <div className="table-wrap max-h-[240px] overflow-y-auto">
                    <table className="tbl">
                      <thead><tr><th>Time (UTC)</th><th>Side</th><th>Reason</th><th>Blocked by</th></tr></thead>
                      <tbody>
                        {(l.held.items as any[]).map((h) => (
                          <tr key={h.decision_key}>
                            <td className="mono text-[11px]">{String(h.held_at).replace("T", " ").slice(0, 16)}</td>
                            <td className={`mono font-semibold ${h.side === "BUY" ? "text-bull" : "text-bear"}`}>{h.side}</td>
                            <td className="text-[11px] text-slate-300">{h.reason}</td>
                            <td className="mono text-[10.5px] text-slate-500">{String(h.blocking_id ?? "").replace("decision:", "")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>

              {/* Signal Ledger Detail Table with Real SL+ Price Points */}
              <Panel
                title={`Signals (${items.length})`}
                icon={<Layers className="h-3.5 w-3.5 text-cyan-400" />}
              >
                {!items.length ? (
                  <Empty>No signals in this window.</Empty>
                ) : (
                  <div className="table-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Opened (UTC)</th>
                          <th>Side</th>
                          <th>Entry</th>
                          <th>SL</th>
                          <th>SL+</th>
                          <th>TP1</th>
                          <th>TP2</th>
                          <th>Mode</th>
                          <th>Status</th>
                          <th>R</th>
                          <th>Omega</th>
                          <th>Omega v4</th>
                          <th>MFE / MAE</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((x) => {
                          const rVal = policy === "tp2" ? x.r_tp2 : x.r_tp1;
                          const om = x.omega_status;
                          const o4 = x.omega4_status;
                          return (
                            <tr key={x.id}>
                              <td className="mono">{when(x.opened_at)}</td>
                              <td
                                className="mono font-bold"
                                style={{ color: x.side === "BUY" ? C.bull : C.bear }}
                              >
                                {x.side}
                              </td>
                              <td className="mono">{px(x.entry)}</td>
                              <td className="mono text-bear">{px(x.stop)}</td>
                              <td className="mono">
                                <SlPlusPricePoint item={x} />
                              </td>
                              <td className="mono text-bull">{px(x.tp1)}</td>
                              <td className="mono text-bull">{px(x.tp2)}</td>
                              <td className="text-slate-300 capitalize">{x.trading_mode ?? "—"}</td>
                              <td>
                                <Badge tone={STATUS_TONE[x.status] ?? "plain"}>{x.status}</Badge>
                                {x.ambiguous ? (
                                  <span className="ml-1 text-[10px] text-amber-200">ambiguous</span>
                                ) : null}
                              </td>
                              <td
                                className="mono font-bold"
                                style={{
                                  color:
                                    (rVal ?? 0) > 0
                                      ? C.bull
                                      : (rVal ?? 0) < 0
                                      ? C.bear
                                      : undefined,
                                }}
                              >
                                {rVal == null ? (
                                  x.status === "open" ? (
                                    <span className="text-cyan-300">open {r(x.open_r)}</span>
                                  ) : (
                                    "—"
                                  )
                                ) : (
                                  r(rVal)
                                )}
                              </td>
                              <td className="mono">
                                {om === "closed" ? (
                                  <span style={{ color: (x.r_omega ?? 0) > 0 ? C.bull : (x.r_omega ?? 0) < 0 ? C.bear : undefined }}>
                                    {r(x.r_omega)}{" "}
                                    <span className="text-[10px] text-slate-400">{OMEGA_EXIT[x.omega_exit] ?? x.omega_exit}</span>
                                  </span>
                                ) : om === "skipped" ? (
                                  <span className="text-[10px] text-amber-200">{String(x.omega_gate ?? "skipped").replace(/_/g, " ")}</span>
                                ) : om ? (
                                  <span className="text-cyan-300">{om}</span>
                                ) : (
                                  "—"
                                )}
                              </td>
                              <td className="mono">
                                {o4 === "closed" ? (
                                  <span style={{ color: (x.r_omega4 ?? 0) > 0 ? C.bull : (x.r_omega4 ?? 0) < 0 ? C.bear : undefined }}>
                                    {r(x.r_omega4)}{" "}
                                    <span className="text-[10px] text-slate-400">{exitText(x.omega4_exit)}</span>
                                  </span>
                                ) : o4 ? (
                                  <span className={o4 === "skipped" ? "text-[10px] text-amber-200" : "text-cyan-300"}>{o4}</span>
                                ) : (
                                  "—"
                                )}
                              </td>
                              <td className="mono text-slate-400">
                                {x.mfe_r != null
                                  ? `${r(x.mfe_r)} / ${r(x.mae_r, false)}`
                                  : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </>
          )}

          {/* TAB 2: OMEGA EXECUTION (REAL TRADING) */}
          {viewMode === "omega_broker" && <OmegaExecutionPanel omega={omega} />}

          {/* TAB 3: DISPARITY & KNOWLEDGE ENGINE (SIGNAL VS OMEGA) */}
          {viewMode === "disparity_knowledge" && (
            <DisparityKnowledgePanel items={items} omega={omega} days={days} />
          )}
        </>
      )}
    </div>
  );
}
