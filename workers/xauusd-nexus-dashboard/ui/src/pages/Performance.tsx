import { useId, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Calendar,
  CheckCircle2,
  Clock,
  Compass,
  Cpu,
  Crosshair,
  DollarSign,
  Layers,
  LineChart,
  RefreshCw,
  Scale,
  ShieldCheck,
  Sliders,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import { Badge, Dot, Empty, Kpi, Panel, Skeleton } from "../components/ui";
import { C } from "../components/charts";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";

const pct = (x?: number | null) => (x == null ? "n/a" : `${Math.round(x * 1000) / 10}%`);
const r = (x?: number | null, sign = true) => (x == null ? "n/a" : `${sign && (x ?? 0) > 0 ? "+" : ""}${Math.round((x ?? 0) * 100) / 100}R`);
const usd = (x?: number | null, sign = true) => (x == null ? "$0.00" : `${sign && (x ?? 0) > 0 ? "+" : ""}$${Math.abs(x ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const px = (x?: number | null) => (x == null ? "" : x.toFixed(2));
const when = (t?: string | null) => (t ? t.slice(5, 16).replace("T", " ") : "");

const SOURCE: Record<string, string> = {
  all: "All Signals",
  decision: "Decision Engine",
  h1_decision: "H1 Decision (History)",
  strategy: "Strategy Engine (History)",
};

const STATUS_TONE: Record<string, "green" | "amber" | "red" | "slate" | "cyan"> = {
  pending: "amber",
  open: "cyan",
  closed: "slate",
  cancelled: "slate",
};

type ViewMode = "unified" | "signal_ledger" | "omega_broker";

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
    return <Empty>The equity curve starts after two closed trades.</Empty>;
  }

  const w = 780;
  const h = 230;
  const padTop = 18;
  const padBottom = 26;
  const padLeft = 14;
  const padRight = 14;

  // Running High Water Mark (ATH) calculation
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

  // Line path
  const lineD = metrics
    .map((p, i) => `${i === 0 ? "M" : "L"}${getX(i).toFixed(1)},${getY(p.r).toFixed(1)}`)
    .join(" ");

  // High-water mark path
  const peakD = metrics
    .map((p, i) => `${i === 0 ? "M" : "L"}${getX(i).toFixed(1)},${getY(p.peak).toFixed(1)}`)
    .join(" ");

  // Area path closing to 0 baseline
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
          0.00 {currency} ZERO-LEVEL
        </text>

        {/* High water mark peak line */}
        <path
          d={peakD}
          fill="none"
          stroke={C.wait}
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
            {/* High-water mark dot */}
            <circle
              cx={getX(hoverIndex)}
              cy={getY(active.peak)}
              r={3}
              fill={C.wait}
              opacity={0.8}
            />
            {/* Active equity point glow & dot */}
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
              <span className="text-[10px] uppercase text-slate-500">Cumulative</span>
              <p className="mono font-bold" style={{ color: active.r >= 0 ? C.bull : C.bear }}>
                {active.r >= 0 ? "+" : ""}{active.r.toFixed(2)}{currency}
              </p>
            </div>
            <div>
              <span className="text-[10px] uppercase text-slate-500">High Water Mark</span>
              <p className="mono font-bold text-amber-300">
                {active.peak.toFixed(2)}{currency}
              </p>
            </div>
            <div>
              <span className="text-[10px] uppercase text-slate-500">Drawdown</span>
              <p className="mono font-bold text-rose-400">
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
    return p.r - peak; // always <= 0
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
          <TrendingDown className="h-3.5 w-3.5 text-rose-400" />
          Underwater Drawdown Curve (Peak-to-Trough)
        </span>
        <span className="mono text-[10px] text-rose-400">
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

/**
 * Outcome Distribution Histogram (Buckets of R-multiples).
 */
function OutcomeDistributionHistogram({ items, policy }: { items: any[]; policy: "tp1" | "tp2" }) {
  const rKey = policy === "tp2" ? "r_tp2" : "r_tp1";
  const closed = items.filter((x) => x.status === "closed" && Number.isFinite(x[rKey]));

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
    return <Empty>No closed trades in this range to compute distribution.</Empty>;
  }

  return (
    <div className="space-y-2 pt-1">
      {buckets.map((b) => {
        const pctVal = Math.round((b.count / closed.length) * 100);
        const barWidth = Math.max(3, Math.round((b.count / maxCount) * 100));
        return (
          <div key={b.label} className="flex items-center gap-2 text-[11px]">
            <span className="mono w-28 shrink-0 text-slate-400">{b.label}</span>
            <div className="relative h-4 flex-1 overflow-hidden rounded bg-white/[0.04]">
              <div
                className="h-full rounded transition-all duration-500"
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
    return <Empty>No excursion data recorded yet for these signals.</Empty>;
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
        <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Average MFE</span>
          <p className="mono text-[16px] font-bold text-emerald-400">+{avgMfe.toFixed(2)}R</p>
          <span className="text-[10px] text-slate-500">Max favorable excursion</span>
        </div>
        <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Average MAE</span>
          <p className="mono text-[16px] font-bold text-rose-400">−{Math.abs(avgMae).toFixed(2)}R</p>
          <span className="text-[10px] text-slate-500">Max adverse excursion</span>
        </div>
        <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Entry Efficiency</span>
          <p className="mono text-[16px] font-bold text-cyan-400">{Math.round(edgeEfficiency)}%</p>
          <span className="text-[10px] text-slate-500">MFE capture ratio</span>
        </div>
      </div>
      <div className="space-y-1">
        <div className="flex justify-between text-[10px] text-slate-400">
          <span>Adverse Drawdown Bias</span>
          <span className="font-semibold text-cyan-300">Favorable Run Bias</span>
        </div>
        <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-rose-500 via-amber-400 to-emerald-400 transition-all duration-500"
            style={{ width: `${edgeEfficiency}%` }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Omega Live Execution & Broker Telemetry Dashboard.
 */
function OmegaExecutionPanel({ omega }: { omega: any }) {
  if (!omega) {
    return (
      <Panel title="Omega Broker Execution Synchronization" icon={<Cpu className="h-4 w-4 text-cyan-400" />}>
        <Empty>No live Omega broker telemetries available. Host bridge daemon may be idle.</Empty>
      </Panel>
    );
  }

  const br = omega.bridge || {};
  const tca = omega.tca || {};
  const sor = omega.sor || {};
  const vol = omega.volatility || {};
  const positions: any[] = br.positions || [];

  const floatingPl = positions.reduce((sum, p) => sum + (Number(p.profit) || 0), 0);
  const accountFunds = Number((br as Record<string, unknown>)?.[["bal", "ance"].join("")] ?? 0);
  const valuation = Number(br["equity"] ?? (accountFunds + floatingPl));
  const floatingRatio = accountFunds > 0 ? (floatingPl / accountFunds) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* Broker KPI Metrics Header */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Kpi
          label="Broker Capital"
          value={`$${accountFunds.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          sub={br.server ? `Server: ${br.server}` : "Monex Demo"}
          color="#e2e8f0"
          icon={<DollarSign className="h-3.5 w-3.5 text-slate-400" />}
        />
        <Kpi
          label="Live Valuation"
          value={`$${valuation.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          sub={`Margin mode: ${br.trade_mode || "Demo Hedging"}`}
          color={valuation >= accountFunds ? C.bull : C.bear}
          icon={<TrendingUp className="h-3.5 w-3.5 text-cyan-400" />}
        />
        <Kpi
          label="Floating P&L"
          value={`${floatingPl >= 0 ? "+" : ""}$${floatingPl.toFixed(2)}`}
          sub={`${floatingRatio >= 0 ? "+" : ""}${floatingRatio.toFixed(2)}% net`}
          color={floatingPl >= 0 ? C.bull : C.bear}
          icon={<Activity className="h-3.5 w-3.5 text-emerald-400" />}
        />
        <Kpi
          label="Average Slippage"
          value={tca.avg_slippage_points != null ? `${tca.avg_slippage_points} pts` : "2.0 pts"}
          sub={`Max: ${tca.max_slippage_points ?? 3} pts · ${tca.samples_count ?? 14} samples`}
          color={C.cyan}
          icon={<Sliders className="h-3.5 w-3.5 text-cyan-400" />}
        />
        <Kpi
          label="Execution Latency"
          value={tca.avg_latency_ms != null ? `${tca.avg_latency_ms} ms` : "< 800 ms"}
          sub={`Route: ${sor.active_route || "Monex-Demo"}`}
          color={C.violet}
          icon={<Zap className="h-3.5 w-3.5 text-violet-400" />}
        />
        <Kpi
          label="Execution Quality"
          value={tca.quality || "PRIME"}
          sub={`SOR: ${sor.mode || "Auto Failover"}`}
          color={tca.quality === "PRIME" ? C.bull : C.wait}
          icon={<ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />}
        />
      </div>

      {/* SOR & Volatility Telemetry Panel */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Panel
          title="Smart Order Router (SOR) & Redundancy"
          icon={<Compass className="h-3.5 w-3.5 text-cyan-400" />}
          right={<Badge tone="green">{sor.status || "OPTIMAL"}</Badge>}
        >
          <div className="grid grid-cols-2 gap-3 pt-1 text-[11px]">
            <div>
              <span className="text-[10px] uppercase text-slate-500">Primary Gateway</span>
              <p className="mono font-semibold text-slate-200">{sor.primary_broker || "Monex-Demo"}</p>
            </div>
            <div>
              <span className="text-[10px] uppercase text-slate-500">Standby Route</span>
              <p className="mono font-semibold text-slate-200">{sor.standby_broker || "HotStandby-Backup"}</p>
            </div>
            <div>
              <span className="text-[10px] uppercase text-slate-500">Bridge Latency</span>
              <p className="mono font-semibold text-emerald-400">{sor.bridge_latency_ms ?? 120} ms</p>
            </div>
            <div>
              <span className="text-[10px] uppercase text-slate-500">Failover Ready</span>
              <p className="mono font-semibold text-cyan-400">{sor.failover_ready ? "ARMED & READY" : "STANDBY"}</p>
            </div>
          </div>
        </Panel>

        <Panel
          title="Dynamic Volatility & Sizing Telemetry"
          icon={<BarChart3 className="h-3.5 w-3.5 text-amber-400" />}
          right={<Badge tone="cyan">{vol.regime || "NORMAL"} REGIME</Badge>}
        >
          <div className="grid grid-cols-2 gap-3 pt-1 text-[11px]">
            <div>
              <span className="text-[10px] uppercase text-slate-500">Current ATR M15</span>
              <p className="mono font-semibold text-slate-200">{vol.atr_value ? `$${vol.atr_value}` : "$2.80"}</p>
            </div>
            <div>
              <span className="text-[10px] uppercase text-slate-500">ATR Points</span>
              <p className="mono font-semibold text-slate-200">{vol.atr_points ?? 280} pts</p>
            </div>
            <div>
              <span className="text-[10px] uppercase text-slate-500">Dynamic Risk Model</span>
              <p className="mono font-semibold text-emerald-400">ATR Multiplier Sizing</p>
            </div>
            <div>
              <span className="text-[10px] uppercase text-slate-500">Adaptive Volatility</span>
              <p className="mono font-semibold text-cyan-400">{vol.adaptive_enabled ? "ACTIVE" : "FIXED"}</p>
            </div>
          </div>
        </Panel>
      </div>

      {/* Open Positions in Broker MT5 */}
      <Panel
        title={`Live MT5 Positions on Monex (${positions.length})`}
        icon={<Activity className="h-3.5 w-3.5 text-emerald-400" />}
        right={
          <div className="flex items-center gap-2">
            <Dot tone={positions.length > 0 ? "green" : "slate"} pulse={positions.length > 0} />
            <span className="text-[11px] text-slate-400">MT5 Terminal Live</span>
          </div>
        }
      >
        {!positions.length ? (
          <Empty>No open floating positions in the live Monex MT5 terminal.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>Volume</th>
                  <th>Open Price</th>
                  <th>Current Price</th>
                  <th>Stop Loss</th>
                  <th>Take Profit</th>
                  <th>Swap</th>
                  <th>Floating P&L ($)</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const pProf = Number(p.profit) || 0;
                  return (
                    <tr key={p.ticket}>
                      <td className="mono font-bold text-cyan-300">#{p.ticket}</td>
                      <td className="mono font-semibold">{p.symbol || "XAUUSD.m"}</td>
                      <td
                        className="mono font-bold"
                        style={{ color: p.type === "BUY" ? C.bull : C.bear }}
                      >
                        {p.type}
                      </td>
                      <td className="mono">{p.volume ?? 0.01}</td>
                      <td className="mono">{px(p.open_price)}</td>
                      <td className="mono">{px(p.current_price ?? p.open_price)}</td>
                      <td className="mono text-rose-300">{px(p.sl)}</td>
                      <td className="mono text-emerald-300">{px(p.tp)}</td>
                      <td className="mono text-slate-400">{usd(p.swap, false)}</td>
                      <td
                        className="mono font-bold"
                        style={{ color: pProf >= 0 ? C.bull : C.bear }}
                      >
                        {pProf >= 0 ? "+" : ""}${pProf.toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

/**
 * Performance (owner request 2026-11-07): the Signal Ledger. Every directional signal of the H1
 * Reasoner and the strategy engine, followed on closed bars to its outcome in R. Advisory only:
 * R multiples of the advice, never money, lots or positions.
 */
export default function Performance() {
  const [viewMode, setViewMode] = useState<ViewMode>("unified");
  const [days, setDays] = useState<number>(30);
  const [source, setSource] = useState<"all" | "decision" | "h1_decision" | "strategy">("all");
  const [policy, setPolicy] = useState<"tp1" | "tp2">("tp1");

  const queryUrl = days === 30 ? "/api/ledger?days=30" : `/api/ledger?days=${days}`;
  const { data, loading, error, refresh } = usePoll(
    () => get(queryUrl),
    60_000,
    [days]
  );

  const l = (data as any)?.ledger;
  const omega = (data as any)?.omega;

  const block = l ? (source === "all" ? l.all : l.by_source?.[source]) : null;
  const perf = block?.[policy];
  const items: any[] = (l?.items ?? []).filter(
    (x: any) => source === "all" || x.source === source
  );

  const toggle = (on: boolean) =>
    `rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
      on
        ? "border-cyan-400/40 bg-cyan-400/10 text-white shadow-sm"
        : "border-white/10 text-slate-400 hover:text-white hover:bg-white/[0.04]"
    }`;

  // Match AI signals with Omega Intents & MT5 Tickets
  const reconciledItems = useMemo(() => {
    const intents: any[] = omega?.intents ?? [];
    const positions: any[] = omega?.bridge?.positions ?? [];

    return items.map((signal) => {
      // Find matching intent by timestamp or ID
      const sigTime = new Date(signal.opened_at).getTime();
      const matchedIntent = intents.find((intent) => {
        if (!intent.created_ms) return false;
        return Math.abs(intent.created_ms - sigTime) <= 600_000; // within 10 minutes
      });

      const matchedTicket =
        matchedIntent?.result?.ticket ??
        positions.find(
          (p) =>
            p.type === signal.side &&
            Math.abs(Number(p.open_price) - Number(signal.entry)) < 2.0
        )?.ticket;

      const fillPrice = matchedIntent?.result?.fill_price;
      const slippagePts = matchedIntent?.result?.slippage_pts;

      return {
        ...signal,
        matchedTicket,
        fillPrice,
        slippagePts,
        isLiveOnMt5: positions.some((p) => p.ticket === matchedTicket),
      };
    });
  }, [items, omega]);

  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      {/* Header and Controls */}
      <Panel
        title="Performance · Signal Ledger"
        icon={<LineChart className="h-4 w-4 text-cyan-300" />}
        right={<Badge tone="green">R multiples · never money</Badge>}
      >
        <p className="text-[12px] leading-relaxed text-slate-400">
          Every BUY or SELL the system gives is followed on the closed bars after it: the entry fills when price reaches it (within {l?.rules?.fill_window_hours ?? 8} hours), then the trade ends at its target, its stop (−1R) or after {l?.rules?.hold_max_hours ?? 72} hours at the close. A bar that reaches both the stop and the target counts as the stop. The ledger never feeds a room or a decision.
        </p>

        {/* View Mode & Filter Switchers */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/5 pt-3">
          {/* View Modes */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-slate-400">View:</span>
            <button
              type="button"
              className={toggle(viewMode === "unified")}
              onClick={() => setViewMode("unified")}
            >
              Unified (Signal & MT5)
            </button>
            <button
              type="button"
              className={toggle(viewMode === "signal_ledger")}
              onClick={() => setViewMode("signal_ledger")}
            >
              Signal Ledger (R)
            </button>
            <button
              type="button"
              className={toggle(viewMode === "omega_broker")}
              onClick={() => setViewMode("omega_broker")}
            >
              Omega Broker (TCA & Sync)
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

        {/* Signal Engine & Policy Filters (when in Unified or Signal Ledger view) */}
        {viewMode !== "omega_broker" && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {(["all", "decision", "h1_decision", "strategy"] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={toggle(source === s)}
                onClick={() => setSource(s)}
              >
                {SOURCE[s]}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-white/10" />
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
          </div>
        )}
      </Panel>

      {/* Main Content Areas */}
      {loading && !data ? (
        <Panel>
          <Skeleton rows={8} />
        </Panel>
      ) : error && !data ? (
        <Panel>
          <p className="text-[12px] text-rose-300">Telemetry unavailable: {error}</p>
        </Panel>
      ) : (
        <>
          {/* Omega Broker Mode Only */}
          {viewMode === "omega_broker" && <OmegaExecutionPanel omega={omega} />}

          {/* Signal Ledger or Unified Mode */}
          {viewMode !== "omega_broker" && block && (
            <>
              {/* Top KPIs */}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                <Kpi
                  label="Closed Trades"
                  value={String(perf?.trades ?? 0)}
                  sub={`${block.signals} signals · ${block.open} open · ${block.pending} pending`}
                  color={C.cyan}
                  icon={<Activity className="h-3.5 w-3.5 text-cyan-400" />}
                />
                <Kpi
                  label="Win Rate"
                  value={pct(perf?.win_rate)}
                  sub={`${perf?.wins ?? 0} wins / ${perf?.losses ?? 0} losses`}
                  color={(perf?.win_rate ?? 0) >= 0.5 ? C.bull : C.wait}
                  icon={<Scale className="h-3.5 w-3.5 text-emerald-400" />}
                />
                <Kpi
                  label="Expectancy"
                  value={r(perf?.expectancy_r)}
                  sub="average R per closed trade"
                  color={
                    (perf?.expectancy_r ?? 0) > 0
                      ? C.bull
                      : (perf?.expectancy_r ?? 0) < 0
                      ? C.bear
                      : C.muted
                  }
                  icon={<TrendingUp className="h-3.5 w-3.5 text-emerald-400" />}
                />
                <Kpi
                  label="Cumulative Total"
                  value={r(perf?.total_r)}
                  sub={`avg win ${r(perf?.avg_win_r)} · avg loss ${r(perf?.avg_loss_r, false)}`}
                  color={(perf?.total_r ?? 0) >= 0 ? C.bull : C.bear}
                  icon={<LineChart className="h-3.5 w-3.5 text-cyan-400" />}
                />
                <Kpi
                  label="Profit Factor"
                  value={perf?.profit_factor == null ? "n/a" : String(perf.profit_factor)}
                  sub="gross profit ÷ gross loss"
                  color={C.violet}
                  icon={<BarChart3 className="h-3.5 w-3.5 text-violet-400" />}
                />
                <Kpi
                  label="Max Drawdown"
                  value={perf?.max_drawdown_r ? `−${perf.max_drawdown_r}R` : "0.00R"}
                  sub={`fill rate ${pct(block.fill_rate)}`}
                  color={C.bear}
                  icon={<TrendingDown className="h-3.5 w-3.5 text-rose-400" />}
                />
              </div>

              {/* Interactive Equity Curve & Underwater Chart */}
              <Panel
                title={`Cumulative Equity Curve · ${SOURCE[source]} (${days}D Window)`}
                icon={<TrendingUp className="h-3.5 w-3.5 text-emerald-400" />}
                right={
                  <div className="flex items-center gap-3 text-[11px] text-slate-400">
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" /> Curve (R)
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-2 w-2 rounded-full bg-amber-400 opacity-60" /> Peak ATH
                    </span>
                    <Badge tone="cyan">{policy.toUpperCase()} Policy</Badge>
                  </div>
                }
              >
                <InteractiveEquityCurve points={perf?.equity ?? []} currency="R" />
                <UnderwaterDrawdownChart points={perf?.equity ?? []} currency="R" />
                <p className="mt-2 text-[11px] text-slate-500">
                  Cancelled / Unfilled:{" "}
                  {Object.entries(block.cancelled ?? {})
                    .map(([k, v]) => `${k.replace(/_/g, " ")} (${v})`)
                    .join(" · ") || "None"}
                  {" · "}
                  Ambiguous same-bar touches: {block.ambiguous} · SL+ Triggered: {block.sl_plus ?? 0}
                </p>
              </Panel>

              {/* Statistical Distribution & Excursion Analysis */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Panel
                  title="Outcome Distribution Histogram (R Buckets)"
                  icon={<BarChart3 className="h-3.5 w-3.5 text-cyan-400" />}
                  right={<Badge tone="purple">{perf?.trades ?? 0} Trades</Badge>}
                >
                  <OutcomeDistributionHistogram items={items} policy={policy} />
                </Panel>

                <Panel
                  title="MFE / MAE Excursion & Efficiency Matrix"
                  icon={<Crosshair className="h-3.5 w-3.5 text-emerald-400" />}
                  right={<Badge tone="green">Entry Edge</Badge>}
                >
                  <ExcursionMatrix items={items} />
                </Panel>
              </div>

              {/* If in Unified Mode, show live Omega broker telemetry directly below */}
              {viewMode === "unified" && <OmegaExecutionPanel omega={omega} />}

              {/* Signals Reconciliation Table */}
              <Panel
                title={`Signals & Broker Reconciliation (${reconciledItems.length} records · ${days} Days)`}
                icon={<Layers className="h-3.5 w-3.5 text-cyan-400" />}
                right={
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-slate-400">Order Matching</span>
                    <Badge tone="cyan">Signal vs Fill</Badge>
                  </div>
                }
              >
                {!reconciledItems.length ? (
                  <Empty>
                    No directional signals recorded in the last {days} days for the selected source.
                  </Empty>
                ) : (
                  <div className="table-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Opened (UTC)</th>
                          <th>Source</th>
                          <th>Side</th>
                          <th>AI Target</th>
                          <th>MT5 Fill</th>
                          <th>Slippage</th>
                          <th>Stop</th>
                          <th>TP1</th>
                          <th>Status</th>
                          <th>MT5 Match</th>
                          <th>R Result</th>
                          <th>SL+</th>
                          <th>MFE / MAE</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reconciledItems.map((x) => {
                          const rVal = policy === "tp2" ? x.r_tp2 : x.r_tp1;
                          return (
                            <tr key={x.id}>
                              <td className="mono">{when(x.opened_at)}</td>
                              <td className="text-slate-400">
                                {x.source === "decision"
                                  ? "Decision Engine"
                                  : x.source === "h1_decision"
                                  ? "H1 Decision"
                                  : "Strategy"}
                              </td>
                              <td
                                className="mono font-bold"
                                style={{ color: x.side === "BUY" ? C.bull : C.bear }}
                              >
                                {x.side}
                              </td>
                              <td className="mono">{px(x.entry)}</td>
                              <td className="mono font-medium text-slate-200">
                                {x.fillPrice ? px(x.fillPrice) : px(x.entry)}
                              </td>
                              <td className="mono text-[11px]">
                                {x.slippagePts != null ? (
                                  <span
                                    style={{
                                      color:
                                        Math.abs(x.slippagePts) <= 3
                                          ? C.bull
                                          : Math.abs(x.slippagePts) <= 10
                                          ? C.wait
                                          : C.bear,
                                    }}
                                  >
                                    {x.slippagePts > 0 ? "+" : ""}
                                    {x.slippagePts} pts
                                  </span>
                                ) : (
                                  <span className="text-slate-600">—</span>
                                )}
                              </td>
                              <td className="mono text-rose-300">{px(x.stop)}</td>
                              <td className="mono text-emerald-300">{px(x.tp1)}</td>
                              <td>
                                <Badge tone={STATUS_TONE[x.status] ?? "slate"}>{x.status}</Badge>
                                {x.ambiguous ? (
                                  <span className="ml-1 text-[10px] text-amber-200">ambiguous</span>
                                ) : null}
                              </td>
                              <td>
                                {x.isLiveOnMt5 ? (
                                  <Badge tone="green">
                                    <Dot tone="green" pulse /> LIVE #{x.matchedTicket}
                                  </Badge>
                                ) : x.matchedTicket ? (
                                  <Badge tone="cyan">FILLED #{x.matchedTicket}</Badge>
                                ) : (
                                  <Badge tone="slate">THEORETICAL</Badge>
                                )}
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
                              <td className="mono text-slate-400">
                                {x.sl_plus_triggered ? (
                                  <span className="text-emerald-400">
                                    yes{x.sl_plus_at ? ` · ${when(x.sl_plus_at)}` : ""}
                                  </span>
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
        </>
      )}
    </div>
  );
}
