import { useMemo, useState } from "react";
import { Cpu } from "lucide-react";
import { Badge, Empty, Kpi, Panel, Skeleton } from "../components/ui";
import { C } from "../components/charts";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";

// Neuron allocation (owner 2026-11-14: "perlu visualisasi yang jelas di dashboard"): what each agent costs in
// Workers AI neurons and what it delivers (its 30-day hit rate), from GET /api/neuron-allocation.

const pc = (x?: number | null) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);
const k = (x?: number | null) => (x == null ? "n/a" : x >= 10_000 ? `${Math.round(x / 1000)}k` : x >= 1000 ? `${(x / 1000).toFixed(1)}k` : String(Math.round(x)));
const PALETTE = ["#22d3ee", "#a78bfa", "#34d399", "#fcd34d", "#fb7185", "#60a5fa", "#f472b6", "#94a3b8"];

function Spark({ values }: { values: number[] }) {
  if (!values.length) return null;
  const max = Math.max(1, ...values);
  const w = 72, h = 18;
  const pts = values.map((v, i) => `${values.length === 1 ? w / 2 : (i / (values.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return <svg width={w} height={h} className="overflow-visible"><polyline points={pts} fill="none" stroke={C.cyan} strokeWidth={1.5} /></svg>;
}

/** Accuracy (y) against neurons per day (x), one dot per agent; the dashed lines are the medians. */
function Quadrant({ agents }: { agents: any[] }) {
  const pts = agents.filter((a) => a.hit_rate != null && a.neurons_per_day > 0);
  if (!pts.length) return <Empty>No agent has both a scored record and neurons in this window.</Empty>;
  const W = 560, H = 300, P = 36;
  const xs = pts.map((a) => Math.log10(a.neurons_per_day));
  const x0 = Math.min(...xs), x1 = Math.max(...xs) + 1e-6;
  const x = (v: number) => P + ((Math.log10(v) - x0) / (x1 - x0 || 1)) * (W - 2 * P);
  const y = (v: number) => H - P - v * (H - 2 * P);
  const med = (arr: number[]) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
  const mx = 10 ** med(xs), my = med(pts.map((a) => a.hit_rate));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <rect x={P} y={P} width={W - 2 * P} height={H - 2 * P} fill="none" stroke={C.track} />
      <line x1={x(mx)} x2={x(mx)} y1={P} y2={H - P} stroke={C.muted} strokeDasharray="4 4" />
      <line x1={P} x2={W - P} y1={y(my)} y2={y(my)} stroke={C.muted} strokeDasharray="4 4" />
      <text x={P + 4} y={P + 12} fontSize="10" fill={C.bull}>↖ accurate and cheap</text>
      <text x={W - P - 4} y={H - P - 6} textAnchor="end" fontSize="10" fill={C.bear}>costly and inaccurate ↘</text>
      <text x={P} y={H - 8} fontSize="10" fill={C.muted}>neurons/day (log) →</text>
      <text x={8} y={P - 8} fontSize="10" fill={C.muted}>hit rate ↑</text>
      {[0, 0.5, 1].map((v) => <text key={v} x={P - 6} y={y(v) + 3} textAnchor="end" fontSize="9" fill={C.muted}>{Math.round(v * 100)}%</text>)}
      {pts.map((a) => (
        <g key={a.agent}>
          <circle cx={x(a.neurons_per_day)} cy={y(a.hit_rate)} r={Math.max(3, Math.min(9, Math.sqrt(a.scored)))} fill={a.status === "live" ? C.cyan : C.violet} fillOpacity={0.7}>
            <title>{`${a.agent}: ${pc(a.hit_rate)} of ${a.scored} scored, ${k(a.neurons_per_day)} neurons/day`}</title>
          </circle>
          <text x={x(a.neurons_per_day) + 6} y={y(a.hit_rate) - 6} fontSize="9" fill="#cbd5e1">{a.agent}</text>
        </g>
      ))}
    </svg>
  );
}

/** Neurons per day in one room, stacked by agent (the six largest, the rest as "other"). */
function RoomBars({ rows, room }: { rows: any[]; room: string }) {
  const days = rows.filter((r) => r.room === room);
  if (!days.length) return <Empty>No AI call in this room in the window.</Empty>;
  const totals = new Map<string, number>();
  for (const d of days) for (const [a, v] of Object.entries(d.by_agent as Record<string, number>)) totals.set(a, (totals.get(a) || 0) + v);
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([a]) => a);
  const keys = [...top, "other"];
  const max = Math.max(1, ...days.map((d) => d.neurons));
  return (
    <div>
      <div className="flex items-end gap-2" style={{ height: 160 }}>
        {days.map((d) => {
          const parts = keys.map((key, i) => ({ key, color: PALETTE[i % PALETTE.length], v: key === "other" ? Object.entries(d.by_agent as Record<string, number>).filter(([a]) => !top.includes(a)).reduce((s, [, v]) => s + v, 0) : (d.by_agent[key] || 0) }));
          return (
            <div key={d.day} className="flex flex-1 flex-col items-center gap-1">
              <div className="flex w-full flex-col-reverse" style={{ height: `${(d.neurons / max) * 140}px` }} title={`${d.day}: ${k(d.neurons)} neurons`}>
                {parts.map((p) => p.v > 0 ? <div key={p.key} style={{ height: `${(p.v / d.neurons) * 100}%`, background: p.color }} title={`${p.key}: ${k(p.v)}`} /> : null)}
              </div>
              <span className="text-[10px] text-slate-500">{d.day.slice(5)}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[10.5px] text-slate-400">
        {keys.map((key, i) => <span key={key} className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />{key}</span>)}
      </div>
    </div>
  );
}

export default function Neurons() {
  const { data, loading, error } = usePoll(() => get("/api/neuron-allocation?days=7"), 300_000);
  const v = data as any;
  const rooms: string[] = useMemo(() => [...new Set(((v?.rooms_by_day ?? []) as any[]).map((r) => r.room))].sort(), [v]);
  const [room, setRoom] = useState("M15");
  if (loading && !v) return <Skeleton rows={6} />;
  if (error && !v) return <Empty>Neuron allocation unavailable ({error}).</Empty>;
  const agents: any[] = v?.agents ?? [];
  const scored = agents.filter((a) => a.hit_rate != null);
  return (
    <div className="space-y-4 px-4 py-4 md:px-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Neurons / day" value={k(v?.neurons_per_day)} sub={`${v?.window_days ?? 7}-day average`} color="text-cyan-300" icon={<Cpu className="h-4 w-4" />} />
        <Kpi label="Agents" value={String(agents.length)} sub={`${scored.length} with a 30-day record`} color="text-slate-100" />
        <Kpi label="Live / shadow" value={`${agents.filter((a) => a.status === "live").length} / ${agents.filter((a) => a.status !== "live").length}`} sub={`${agents.reduce((n, a) => n + (a.shadow_rooms?.length ?? 0), 0)} agent-room pairs in shadow`} color="text-emerald-300" />
        <Kpi label="Largest share" value={agents[0] ? pc(agents[0].share) : "n/a"} sub={agents[0]?.agent ?? ""} color="text-amber-300" />
      </div>

      <Panel title="Agents" hint="Neurons from each agent's room messages, priced with its model's input/output mix of the day. Hit rate: directional calls of the last 30 days (± the number scored). Grounding: share of cited metrics found in the agent's input, measured once agents answer in metrics.">
        {!agents.length ? <Empty>No AI call recorded in the window.</Empty> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Agent</th><th>Status</th><th>Rooms</th><th>Hit rate (30d)</th><th>Grounding</th><th>Neurons/day</th><th>Share</th><th>Neurons / correct call</th><th>Trend</th></tr></thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.agent}>
                    <td className="mono">{a.agent}</td>
                    <td>{a.shadow_rooms?.length && a.status === "live" ? <Badge tone="amber">{`shadow in ${a.shadow_rooms.join(", ")}`}</Badge> : <Badge tone={a.status === "live" ? "green" : "purple"}>{a.status}</Badge>}</td>
                    <td className="text-[11px] text-slate-400">{a.rooms.join(", ")}</td>
                    <td className="mono">{a.hit_rate == null ? <span className="text-slate-500">n/a</span> : <>{pc(a.hit_rate)} <span className="text-slate-500">± {a.scored}</span></>}</td>
                    <td className="mono text-slate-500">{a.grounding_rate == null ? "not yet" : pc(a.grounding_rate)}</td>
                    <td className="mono">{k(a.neurons_per_day)}</td>
                    <td className="mono">{pc(a.share)}</td>
                    <td className="mono">{k(a.neurons_per_hit)}</td>
                    <td><Spark values={a.trend ?? []} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Accuracy against cost" hint="One dot per agent: up is more accurate, left is cheaper. The dot's size grows with the number of scored calls; the dashed lines are the medians.">
          <Quadrant agents={agents} />
        </Panel>
        <Panel title="Neurons per room per day" right={<span className="flex flex-wrap gap-1">{rooms.map((r) => <button key={r} onClick={() => setRoom(r)} className={`rounded px-2 py-0.5 text-[11px] ${r === room ? "bg-cyan-500/20 text-cyan-200" : "text-slate-400 hover:text-slate-200"}`}>{r}</button>)}</span>}>
          <RoomBars rows={v?.rooms_by_day ?? []} room={rooms.includes(room) ? room : rooms[0] ?? "M15"} />
        </Panel>
      </div>

      <Panel title="Allocation changes" hint={`Per room, on the directional calls of the last 30 days: below ${Math.round((v?.rules?.demote_below ?? 0.45) * 100)}% over at least ${v?.rules?.min_scored ?? 60} decided calls the agent goes to shadow (it leaves the room's quorum and answers every ${v?.rules?.shadow_every ?? 4}th bar in shadow); back at ${Math.round((v?.rules?.promote_at ?? 0.5) * 100)}% it is live again. The moderator is exempt; a room keeps at least ${v?.rules?.min_live ?? 4} live agents with a record.`}>
        {!(v?.changes ?? []).length ? <Empty>No allocation change yet: every agent runs live as before.</Empty> : (
          <ul className="space-y-1 text-[12px]">
            {v.changes.map((c: any, i: number) => <li key={i}><span className="mono text-slate-500">{String(c.at).slice(0, 16).replace("T", " ")} UTC</span> · <span className="mono">{c.agent}</span> in {c.room} · <Badge tone={c.to === "live" ? "green" : "purple"}>{c.to}</Badge> {c.reason}</li>)}
          </ul>
        )}
      </Panel>
    </div>
  );
}
