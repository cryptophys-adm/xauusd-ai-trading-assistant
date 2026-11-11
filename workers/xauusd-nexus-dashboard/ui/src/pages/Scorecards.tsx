import { useState } from "react";
import { Trophy, TrendingUp, ShieldAlert, Award, Activity, BarChart2, CheckCircle2 } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";

const p = (x?: number | null) => (x == null ? "n/a" : `${Math.round(x * 1000) / 10}%`);
const CHECK: Record<string, string> = { order_wording: "order or size wording", stance_bias_conflict: "stance against its bias", calibration_talk: "talks about calibration", natural_language: "field names in text", data_scope: "outside its own HUD" };
const CHART: Record<string, string> = { "15": "15m", "60": "1H", "240": "4H", "1D": "D1" };

/** Agent compliance (RFC_AETHER_KNOWLEDGE_GUARDIAN A1): deterministic rule breaks per 100 room messages. */
function Compliance() {
  const { data } = usePoll(() => get("/api/compliance?days=7"), 300_000);
  const c = (data as any)?.compliance;
  if (!c) return null;
  const rows = (c.agents as any[]).filter((a) => a.violations > 0).slice(0, 20);
  return (
    <Panel title="Agent Compliance & Safety Audit (7 days)" icon={<ShieldAlert className="h-3.5 w-3.5 text-amber-300" />} right={<Badge tone={c.total.violations ? "amber" : "green"}>{c.total.rate_per_100 ?? 0} per 100 messages</Badge>}>
      <p className="mb-3 text-[12px] text-slate-400">Deterministic checks of agent prompt compliance against system constraints. Primary Consumer: Aether Guardian evaluates these rates to validate persona stability and rule discipline.</p>
      {!rows.length ? <Empty>No rule break in {c.total.messages} room messages.</Empty> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Room</th>
                <th>Messages</th>
                <th>Rule breaks</th>
                <th>Violation Rate</th>
                <th>Primary Discrepancy</th>
              </tr>
            </thead>
            <tbody>{rows.map((a) => {
              const top = Object.entries(a.by_check as Record<string, any>).sort((x, y) => y[1].count - x[1].count)[0];
              const rate = a.rate_per_100 ?? 0;
              return (
                <tr key={a.chart + a.agent}>
                  <td className="font-semibold text-slate-200">{a.agent}</td>
                  <td className="mono"><Badge tone="slate">{CHART[a.chart] ?? a.chart}</Badge></td>
                  <td className="mono">{a.messages}</td>
                  <td className="mono text-rose-300">{a.violations}</td>
                  <td className="mono">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/5">
                        <div className={`h-full ${rate >= 20 ? "bg-rose-400" : "bg-amber-400"}`} style={{ width: `${Math.min(100, rate * 3)}%` }} />
                      </div>
                      <span className={rate >= 20 ? "text-rose-300" : "text-amber-200"}>{rate} / 100</span>
                    </div>
                  </td>
                  <td className="text-slate-400">{top ? `${CHECK[top[0]] ?? top[0]} (${top[1].count}${top[1].example ? `, e.g. "${top[1].example}"` : ""})` : "—"}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

const SUBJECT: Record<string, string> = {
  "chain:h1": "H1 decision (Reasoner)",
  "indicator:prophet_r38": "Prophet R38 direction",
  "indicator:prophet_r37": "Prophet R37 direction",
  "indicator:gmi_v12_70": "GMI v12.70 verdict"
};

/** Inline horizontal progress bar for rates */
function RateBar({ value, toneClass }: { value?: number | null; toneClass?: string }) {
  if (value == null) return <span className="mono text-slate-500">n/a</span>;
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  const color = toneClass || (pct >= 55 ? "bg-emerald-400" : pct < 45 ? "bg-rose-400" : "bg-slate-400");
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="mono text-[12px]">{pct}%</span>
    </div>
  );
}

/** Visual SVG Leaderboard Bar Chart comparing agents' accuracy and crowd weights */
function LeaderboardGraph({ rows, title }: { rows: any[]; title: string }) {
  if (!rows || !rows.length) return null;
  const topRows = rows.slice(0, 10);
  return (
    <div className="glass-inner mb-4 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[12px] font-semibold text-slate-200">
          <BarChart2 className="h-3.5 w-3.5 text-cyan-400" />
          <span>{title} — Accuracy & Crowd Multiplier Distribution</span>
        </div>
        <div className="flex items-center gap-4 text-[11px] text-slate-400">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-400" /> &gt;= 55% Edge</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-slate-400" /> 45-55% Neutral</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-rose-400" /> &lt; 45% Lag</span>
          <span className="flex items-center gap-1.5 text-cyan-300 font-mono">| 50% Baseline</span>
        </div>
      </div>
      <div className="space-y-2.5">
        {topRows.map((r) => {
          const acc = r.accuracy ?? 0.5;
          const pct = Math.max(0, Math.min(100, Math.round(acc * 100)));
          const weight = r.weight ?? 1;
          const barColor = acc >= 0.55 ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.3)]" : acc < 0.45 ? "bg-rose-400" : "bg-slate-400";
          const weightTone = weight > 1.1 ? "green" : weight < 0.9 ? "red" : "slate";
          return (
            <div key={r.id} className="grid grid-cols-[130px_1fr_70px_70px] items-center gap-3 text-[11px]">
              <div className="truncate font-mono font-medium text-slate-300" title={r.name}>{r.name}</div>
              <div className="relative flex h-4 w-full items-center rounded-md bg-white/[0.04] px-1">
                {/* 50% Baseline Marker */}
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-cyan-400/40 z-10" title="50% baseline" />
                <div className={`h-2.5 rounded transition-all duration-500 ${barColor}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="text-right mono font-bold text-slate-200">{p(r.accuracy)}</div>
              <div className="text-right">
                <Badge tone={weightTone}>x{weight}</Badge>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgentTable({ rows }: { rows: any[] }) {
  if (!rows.length) return <Empty>No scored calls yet: an agent's calls are scored once the next four candles have closed.</Empty>;
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Agent Name</th>
            <th>Family</th>
            <th>Sample</th>
            <th>Accuracy (Hit / Decisive)</th>
            <th>BUY/SELL Hit Rate</th>
            <th>WAIT Accuracy</th>
            <th>Brier Score</th>
            <th>Crowd Weight</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const weight = r.weight ?? 1;
            const weightTone = weight > 1.1 ? "green" : weight < 0.9 ? "red" : "slate";
            const brier = r.brier != null ? Number(r.brier) : null;
            const brierTone = brier == null ? "text-slate-500" : brier < 0.2 ? "text-emerald-300" : brier > 0.28 ? "text-rose-300" : "text-amber-200";
            return (
              <tr key={r.id}>
                <td className="font-semibold text-slate-200">{r.name}</td>
                <td className="text-slate-400"><Badge tone="slate">{r.family}</Badge></td>
                <td className="mono text-slate-300">{r.decisive} <span className="text-[10px] text-slate-500">({r.n ?? 0} tot)</span></td>
                <td><RateBar value={r.accuracy} toneClass={r.accuracy >= 0.55 ? "bg-emerald-400" : r.accuracy < 0.45 ? "bg-rose-400" : "bg-slate-400"} /></td>
                <td><RateBar value={r.hit_rate} toneClass="bg-cyan-400" /></td>
                <td><RateBar value={r.wait_accuracy} toneClass="bg-violet-400" /></td>
                <td className={`mono font-bold ${brierTone}`}>{r.brier ?? "n/a"}</td>
                <td>
                  <Badge tone={weightTone}>x{r.weight}</Badge>
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
 * Scorecards (P7, RFC_INDICATOR_AGENT_PLATFORM §7): every room agent's 30-day track record, the
 * weight it carries in the crowd line, the H1 decision and the indicators. Scores come from prices
 * only, never from model text.
 */
export default function Scorecards() {
  const { data, loading, error } = usePoll(() => get("/api/scorecards?days=30"), 300_000);
  const [activeTab, setActiveTab] = useState<"all" | "1H" | "15m" | "indicators">("all");
  const d = data as any;
  const rooms = d?.reputation?.rooms ?? {};
  const others = ((d?.subjects ?? []) as any[]).filter((s) => SUBJECT[s.subject]);

  const h1Agents = rooms["1H"] ?? [];
  const m15Agents = rooms["15m"] ?? [];
  const allAgents = [...h1Agents, ...m15Agents];

  // Aggregated system metrics
  const scoredAgents = allAgents.filter((a) => typeof a.accuracy === "number");
  const avgAccuracy = scoredAgents.length ? Math.round((scoredAgents.reduce((s, a) => s + a.accuracy, 0) / scoredAgents.length) * 1000) / 10 : 50;
  const topAgent = [...scoredAgents].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];
  const bestBrier = [...scoredAgents].filter((a) => a.brier != null).sort((a, b) => a.brier - b.brier)[0];
  const totalCalls = allAgents.reduce((s, a) => s + (a.decisive || 0), 0);

  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      {/* Header Panel */}
      <Panel
        title="Agent Performance Scorecards & Dynamic Reputation"
        icon={<Trophy className="h-4 w-4 text-amber-300" />}
        right={<Badge tone="purple">30-day rolling · price action only</Badge>}
      >
        <p className="text-[12px] leading-relaxed text-slate-400">
          Deterministic reputation weighting system for all War Room agents. Every stance is scored mathematically against the next {d?.scoring?.horizon ?? 4} closed candles: BUY/SELL is considered a <span className="text-emerald-300 font-semibold">Hit</span> when price moves {d?.scoring?.thresholdAtr ?? 0.5} x ATR its way first, while WAIT is accurate when no {d?.scoring?.waitTargetAtr ?? 1} x ATR directional move occurs.
          This accuracy is transformed into a <strong>Crowd Weight Multiplier</strong> (x0.25 to x2.00) used by the Decision Engine in quorum consensus voting.
        </p>

        {/* Consumer Badges */}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3 text-[11px]">
          <span className="text-slate-400">Primary Consumers:</span>
          <Badge tone="cyan">War Room Decision Weighting</Badge>
          <Badge tone="purple">Aether Epigenetic Learning</Badge>
          <Badge tone="green">Indicator Registry Fault Detection</Badge>
          <Badge tone="slate">Autonomous Risk Governance</Badge>
        </div>
      </Panel>

      {/* KPI Overview Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="glass p-3 sm:p-4">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            <TrendingUp className="h-3.5 w-3.5 text-cyan-400" />
            <span>Avg Agent Accuracy</span>
          </div>
          <div className="mono mt-2 text-[22px] font-extrabold text-cyan-300 sm:text-[26px]">
            {avgAccuracy}%
          </div>
          <div className="mt-1 text-[11px] text-slate-500">Across {scoredAgents.length} scored agents</div>
        </div>

        <div className="glass p-3 sm:p-4">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            <Award className="h-3.5 w-3.5 text-emerald-400" />
            <span>Top Crowd Weight</span>
          </div>
          <div className="mono mt-2 truncate text-[22px] font-extrabold text-emerald-300 sm:text-[26px]">
            {topAgent ? topAgent.name : "n/a"}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">{topAgent ? `x${topAgent.weight} multiplier (${p(topAgent.accuracy)})` : "Collecting"}</div>
        </div>

        <div className="glass p-3 sm:p-4">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            <CheckCircle2 className="h-3.5 w-3.5 text-violet-400" />
            <span>Best Calibration</span>
          </div>
          <div className="mono mt-2 truncate text-[22px] font-extrabold text-violet-300 sm:text-[26px]">
            {bestBrier ? bestBrier.name : "n/a"}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">{bestBrier ? `Brier ${bestBrier.brier}` : "Calculating"}</div>
        </div>

        <div className="glass p-3 sm:p-4">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            <Activity className="h-3.5 w-3.5 text-amber-400" />
            <span>Total Evaluated Calls</span>
          </div>
          <div className="mono mt-2 text-[22px] font-extrabold text-amber-300 sm:text-[26px]">
            {totalCalls}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">Past 30 trading days</div>
        </div>
      </div>

      {loading && !d ? (
        <Panel><Skeleton rows={6} /></Panel>
      ) : error && !d ? (
        <Panel><p className="text-[12px] text-rose-300">Scorecards unavailable: {error}</p></Panel>
      ) : (
        <>
          {/* Visual Graph: Leaderboard Bar Charts */}
          <Panel title="Reputation & Precision Leaderboard Graph" icon={<BarChart2 className="h-3.5 w-3.5 text-cyan-400" />}>
            <LeaderboardGraph rows={h1Agents} title="1H War Room Consensus Agents" />
            <LeaderboardGraph rows={m15Agents} title="15m Tactical Live War Room Agents" />
          </Panel>

          {/* Tab Navigation for Tabular Data */}
          <div className="flex items-center gap-2 border-b border-white/5 pb-2">
            <button
              onClick={() => setActiveTab("all")}
              className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold transition ${activeTab === "all" ? "bg-cyan-500/20 text-cyan-200 border border-cyan-400/30" : "text-slate-400 hover:text-slate-200"}`}
            >
              All Scored Engines ({allAgents.length + others.length})
            </button>
            <button
              onClick={() => setActiveTab("1H")}
              className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold transition ${activeTab === "1H" ? "bg-cyan-500/20 text-cyan-200 border border-cyan-400/30" : "text-slate-400 hover:text-slate-200"}`}
            >
              1H War Room ({h1Agents.length})
            </button>
            <button
              onClick={() => setActiveTab("15m")}
              className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold transition ${activeTab === "15m" ? "bg-cyan-500/20 text-cyan-200 border border-cyan-400/30" : "text-slate-400 hover:text-slate-200"}`}
            >
              15m Live Room ({m15Agents.length})
            </button>
            <button
              onClick={() => setActiveTab("indicators")}
              className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold transition ${activeTab === "indicators" ? "bg-cyan-500/20 text-cyan-200 border border-cyan-400/30" : "text-slate-400 hover:text-slate-200"}`}
            >
              H1 Reasoner & Indicators ({others.length})
            </button>
          </div>

          {/* Tabular Panels */}
          {(activeTab === "all" || activeTab === "1H") && (
            <Panel title="1H War Room Agents Track Record" right={<Badge tone="cyan">{h1Agents.length} agents</Badge>}>
              <AgentTable rows={h1Agents} />
            </Panel>
          )}

          {(activeTab === "all" || activeTab === "15m") && (
            <Panel title="15m Tactical Live War Room Agents Track Record" right={<Badge tone="purple">{m15Agents.length} agents</Badge>}>
              <AgentTable rows={m15Agents} />
            </Panel>
          )}

          {(activeTab === "all" || activeTab === "indicators") && (
            <Panel title="H1 Reasoner & Algorithmic Indicators" right={<Badge tone="slate">{others.length} subjects</Badge>}>
              {!others.length ? <Empty>No scored H1 calls yet.</Empty> : (
                <div className="table-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Subject Entity</th>
                        <th>Scored Sample</th>
                        <th>BUY/SELL Hit Rate</th>
                        <th>WAIT Accuracy</th>
                        <th>Brier Calibration</th>
                      </tr>
                    </thead>
                    <tbody>{others.map((s) => (
                      <tr key={s.subject + s.timeframe}>
                        <td className="font-semibold text-slate-200">{SUBJECT[s.subject] ?? s.subject}</td>
                        <td className="mono text-slate-300">{s.n} bars</td>
                        <td><RateBar value={s.directional?.hit_rate} toneClass="bg-cyan-400" /></td>
                        <td><RateBar value={s.wait?.accuracy} toneClass="bg-violet-400" /></td>
                        <td className="mono font-bold text-slate-200">{s.brier ?? "n/a"}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </Panel>
          )}

          {/* Compliance & Safety Table */}
          <Compliance />

          {/* Stuck States Alert */}
          {!!d?.stuck_states?.length && (
            <Panel title="Caution: Open Indicator Stuck States" icon={<ShieldAlert className="h-4 w-4 text-amber-400" />} right={<Badge tone="amber">{d.stuck_states.length} open</Badge>}>
              <p className="mb-2 text-[12px] text-slate-400">Frozen indicator fields or unresponsive state values during active ATR market moves. The indicator registry automatically disqualifies an agent's voting power when a stuck state is detected.</p>
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Frozen Field</th>
                      <th>Stuck Duration</th>
                      <th>ATR Range Moved</th>
                      <th>Status Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.stuck_states.map((s: any, i: number) => (
                      <tr key={i}>
                        <td className="mono text-amber-200">{s.field}</td>
                        <td className="mono">{s.candles} candles</td>
                        <td className="mono">{s.atr ? Math.round((s.price_range / s.atr) * 10) / 10 : "?"} x ATR</td>
                        <td><Badge tone="red">Voting Disabled</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
