import { Crosshair, Grid3x3, ListChecks, Puzzle, Scale, Shapes } from "lucide-react";
import { Badge, Empty, Hint, Panel, Skeleton } from "../components/ui";
import { C } from "../components/charts";
import { get } from "../lib/api";
import { ago } from "../lib/format";
import { usePoll } from "../lib/usePoll";

// Strategy agents (owner 2026-11-13: "kita perlu agent yang bisa dibongkar pasang menyesuaikan strategy yang
// tepat yang dipilih oleh council"). Read-only, from the AI Worker:
//   - /api/strategy-agents: the registry (status, what each agent is made for), each agent's measured record,
//     and the latest decision's plan per agent with the one the trade took;
//   - /api/plan-learning: the entry and stop grid against the plan, the pick per market condition, the referee.

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const R = (x: number | null | undefined) => (num(x) ? `${x > 0 ? "+" : ""}${x.toFixed(2)}R` : "—");
const pc = (x: number | null | undefined) => (num(x) ? `${Math.round(x * 100)}%` : "—");
const px = (x: number | null | undefined) => (num(x) ? x.toFixed(2) : "—");
const tone = (s?: string): "green" | "slate" | "red" => (s === "live" ? "green" : s === "off" ? "red" : "slate");
const rColor = (x: number | null | undefined) => (!num(x) || Math.abs(x) < 0.005 ? C.muted : x > 0 ? C.bull : C.bear);
const contextText = (c?: string) => String(c ?? "").replace("|", " · ").replace("none · ", "");
const armText = (id?: string) => { const m = /^e([\d.]+)@s([\d.]+)$/.exec(String(id ?? "")); return !m ? "—" : m[1] === "0" && m[2] === "1" ? "the plan as it is" : `entry ${m[1]} ATR deeper · stop ×${m[2]}`; };

/** The registry: one card per agent with its status, what it is made for and its measured record. */
function Registry({ agents, chosen }: { agents: any[]; chosen: string | null }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {agents.map((a) => {
        const rec = a.record;
        return (
          <div key={a.id} className="glass-inner p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-slate-100">
                <span className="truncate">{a.label}</span><Hint text={a.fits} />
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {chosen === a.id ? <Badge tone="cyan">in use</Badge> : null}
                {a.suspended ? <Badge tone="amber">suspended</Badge> : <Badge tone={tone(a.status)}>{a.status}</Badge>}
              </div>
            </div>
            <div className="mt-1 text-[11px] text-slate-400">{a.family ? `${a.patterns?.length ?? 0} patterns of the Projection Agent` : a.patterns ? `${a.patterns.length} patterns, before they break` : String(a.fits ?? "").split(":")[0]}</div>
            {rec ? (
              <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                {[["Setups", String(rec.setups), C.muted], ["Mean", R(rec.mean_r), rColor(rec.mean_r)], ["Filled", pc(rec.fill_rate), C.muted], ["Target", pc(rec.target_rate), C.muted]].map(([k, v, color]) => (
                  <div key={k}>
                    <div className="mono text-[14px] font-bold" style={{ color: color === C.muted ? undefined : color }}>{v}</div>
                    <div className="text-[9.5px] uppercase tracking-wider text-slate-500">{k}</div>
                  </div>
                ))}
              </div>
            ) : <div className="mt-3 text-[11px] text-slate-500">No resolved setup yet.</div>}
          </div>
        );
      })}
    </div>
  );
}

/** Each pattern's own trades, per family; a pattern held back by the breaker is marked. */
function PatternRecords({ agents, held }: { agents: any[]; held: string[] }) {
  const rows = agents.filter((a) => a.patterns).flatMap((a) => (a.record?.patterns ?? []).map((p: any) => ({ agent: a.id, family: a.label, name: (a.patterns ?? []).find((x: any) => x.id === p.pattern)?.name ?? p.pattern, ...p })))
    .sort((x: any, y: any) => y.setups - x.setups);
  if (!rows.length) return <Empty>No pattern has a resolved setup yet.</Empty>;
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead><tr><th>Pattern</th><th>Strategy</th><th>Setups</th><th>Mean</th><th>Filled</th><th>Target</th></tr></thead>
        <tbody>
          {rows.map((p: any) => (
            <tr key={p.agent + p.pattern}>
              <td className="whitespace-nowrap"><span className="text-slate-200">{p.name}</span>{held.includes(`${p.agent}:${p.pattern}`) ? <span className="ml-2"><Badge tone="amber">held back</Badge></span> : null}</td>
              <td className="text-slate-400">{p.family}</td>
              <td className="mono">{p.setups}</td>
              <td className="mono" style={{ color: rColor(p.mean_r) }}>{R(p.mean_r)}</td>
              <td className="mono">{pc(p.fill_rate)}</td>
              <td className="mono">{pc(p.target_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What each agent would trade at the latest decision; the decided side, or both while the engine waits. */
function LatestPlans({ latest, agents }: { latest: any; agents: any[] }) {
  const sides = latest.stance === "BUY" ? ["long"] : latest.stance === "SELL" ? ["short"] : ["long", "short"];
  const rows = sides.flatMap((side) => Object.entries(latest.plans?.[side] ?? {}).map(([id, p]: [string, any]) => ({ side, id, p })));
  if (!rows.length) return <Empty>No agent saw a setup at this decision.</Empty>;
  const label = (id: string) => agents.find((a) => a.id === id)?.label ?? id;
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead><tr><th>Agent</th><th>Side</th><th>Entry</th><th>Stop</th><th>Target</th><th>Reward</th><th>Setup</th></tr></thead>
        <tbody>
          {rows.map(({ side, id, p }) => (
            <tr key={side + id}>
              <td className="whitespace-nowrap"><span className="font-semibold text-slate-200">{label(id)}</span>{latest.chosen === id && latest.stance !== "WAIT" ? <span className="ml-2"><Badge tone="cyan">traded</Badge></span> : p.status !== "live" ? <span className="ml-2"><Badge tone="slate">{p.status}</Badge></span> : null}</td>
              <td style={{ color: side === "long" ? C.bull : C.bear }}>{side === "long" ? "BUY" : "SELL"}</td>
              <td className="mono">{p.at_level ? "market " : "limit "}{px(p.entry)}</td>
              <td className="mono">{px(p.stop)}</td>
              <td className="mono">{px(p.tp1)}</td>
              <td className="mono">{num(p.rrr?.tp1) ? `${p.rrr.tp1}R` : "—"}</td>
              <td className="max-w-[420px] text-[11px] text-slate-400">{p.setup ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Each agent's mean R per market condition (trading mode and 1H regime). */
function ByContext({ agents }: { agents: any[] }) {
  const withRecord = agents.filter((a) => a.record?.contexts?.length);
  const contexts = [...new Set(withRecord.flatMap((a) => a.record.contexts.map((c: any) => c.context)))].sort();
  if (!contexts.length) return <Empty>No resolved setup yet.</Empty>;
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead><tr><th>Market condition</th>{withRecord.map((a) => <th key={a.id}>{a.label}</th>)}</tr></thead>
        <tbody>
          {contexts.map((ctx) => (
            <tr key={ctx}>
              <td>{contextText(ctx)}</td>
              {withRecord.map((a) => {
                const c = a.record.contexts.find((x: any) => x.context === ctx);
                return <td key={a.id} className="mono">{c ? <><span style={{ color: rColor(c.mean_r) }}>{R(c.mean_r)}</span><span className="ml-1.5 text-[10px] text-slate-500">{c.setups}</span></> : <span className="text-slate-600">—</span>}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The entry and stop grid: each arm's mean R per setup against the plan as it is. */
function Grid({ learning }: { learning: any }) {
  const shifts: number[] = learning.grid?.entry_shifts ?? [], scales: number[] = learning.grid?.stop_scales ?? [];
  const arm = (e: number, k: number) => (learning.learned?.arms ?? []).find((a: any) => a.entry_shift === e && a.stop_scale === k);
  const max = Math.max(0.05, ...(learning.learned?.arms ?? []).map((a: any) => Math.abs(a.mean_diff ?? 0)));
  const bg = (d: number | null | undefined) => (!num(d) || Math.abs(d) < 0.005 ? "transparent" : `${d > 0 ? "rgba(52,211,153," : "rgba(251,113,133,"}${(0.08 + 0.42 * Math.min(1, Math.abs(d) / max)).toFixed(2)})`);
  return (
    <div className="table-wrap">
      <table className="tbl text-center">
        <thead>
          <tr><th className="text-left">Entry \ Stop</th>{scales.map((k) => <th key={k} className="text-center">×{k}{k === 1 ? " (plan)" : ""}</th>)}</tr>
        </thead>
        <tbody>
          {shifts.map((e) => (
            <tr key={e}>
              <td className="whitespace-nowrap text-left">{e === 0 ? "at the plan's entry" : `${e} ATR deeper`}</td>
              {scales.map((k) => {
                const a = arm(e, k), control = e === 0 && k === 1;
                return (
                  <td key={k} style={{ background: bg(a?.mean_diff) }} className={control ? "outline outline-1 -outline-offset-1 outline-cyan-400/50" : ""} title={a?.n ? `${a.n} setups · filled ${pc(a.fill_rate)} · reached target ${pc(a.target_rate)}` : "too few setups fit this arm"}>
                    {a?.n ? <><div className="mono text-[12.5px] font-semibold text-slate-100">{R(a.mean_r)}</div><div className="mono text-[10px] text-slate-400">{control ? "the plan" : `${R(a.mean_diff)} · ${pc(a.fill_rate)}`}</div></> : <span className="text-slate-600">—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const VERDICT: Record<string, { text: string; tone: "green" | "amber" | "slate" }> = {
  better_than_plan: { text: "better than the plan", tone: "green" }, not_better: { text: "not better", tone: "amber" }, collecting: { text: "collecting", tone: "slate" }
};

export default function Strategy() {
  const agentsPoll = usePoll(() => get("/api/strategy-agents"), 120_000);
  const learnPoll = usePoll(() => get("/api/plan-learning"), 300_000);
  const s = agentsPoll.data as any, pl = learnPoll.data as any;
  const agents: any[] = s?.agents ?? [];
  const latest = s?.latest ?? null, learning = pl?.learning ?? null, wf = learning?.walk_forward ?? null, advice = pl?.latest?.advice ?? null, plan = pl?.latest?.plan ?? null;
  const verdict = VERDICT[wf?.verdict ?? "collecting"] ?? VERDICT.collecting;
  const loading = agentsPoll.loading && !s;
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      <Panel title="Strategy agents" icon={<Puzzle className="h-3.5 w-3.5 text-cyan-300" />}
        hint="Each agent is one way of trading price action. The council picks the side; a live agent may be chosen for the plan, a shadow agent is recorded and measured only. A live agent with a negative record over 30 setups is suspended until its record recovers."
        right={s ? <Badge tone="slate">{agents.filter((a) => a.status === "live").length} live · {agents.filter((a) => a.status === "shadow" && !a.suspended).length} shadow{agents.some((a) => a.suspended) ? ` · ${agents.filter((a) => a.suspended).length} suspended` : ""}</Badge> : null}>
        {loading ? <Skeleton rows={4} /> : agentsPoll.error && !s ? <Empty>Unavailable ({agentsPoll.error}).</Empty> : <Registry agents={agents} chosen={latest?.stance && latest.stance !== "WAIT" ? latest.chosen : null} />}
      </Panel>

      <Panel title="Latest decision" icon={<Crosshair className="h-3.5 w-3.5 text-cyan-300" />} hint="What each agent would trade at the latest 15m decision. Prices are on the feed's scale (OANDA)."
        right={latest ? <span className="flex items-center gap-2"><span className="mono text-[10.5px] text-slate-500">{String(latest.bar_close ?? "").slice(11, 16)} UTC</span><Badge tone={latest.stance === "BUY" ? "green" : latest.stance === "SELL" ? "red" : "amber"}>{latest.stance}</Badge></span> : null}>
        {loading ? <Skeleton rows={3} /> : !latest ? <Empty>No decision yet.</Empty> : !latest.plans ? <Empty>This decision was made before the agents.</Empty> : <LatestPlans latest={latest} agents={agents} />}
      </Panel>

      <Panel title="Pattern record" icon={<Shapes className="h-3.5 w-3.5 text-cyan-300" />} hint="Each chart pattern's own trades, replayed on the bars that followed. A pattern with a negative record over 15 setups is held back while the rest of its family trades on."
        right={s ? <Badge tone="slate">{agents.filter((a) => a.family).reduce((n, a) => n + (a.patterns?.length ?? 0), 0)} patterns in {agents.filter((a) => a.family).length} families</Badge> : null}>
        {loading ? <Skeleton rows={3} /> : <PatternRecords agents={agents} held={(s?.suspended_patterns ?? []).map((x: any) => `${x.agent}:${x.id}`)} />}
      </Panel>

      <Panel title="Record by market condition" icon={<ListChecks className="h-3.5 w-3.5 text-cyan-300" />} hint="Mean R per setup of each agent's own plan, replayed on the bars that followed; the small number is the setups.">
        {loading ? <Skeleton rows={3} /> : <ByContext agents={agents} />}
      </Panel>

      <Panel title="Entry and stop grid" icon={<Grid3x3 className="h-3.5 w-3.5 text-cyan-300" />}
        hint="The default agent's plans replayed with a deeper entry and a tighter or wider stop. Each cell: mean R per setup, then the difference against the plan and how often it filled. An unfilled entry counts as 0R."
        right={learning ? <Badge tone="slate">{learning.setups?.resolved ?? 0} setups · updated {ago(learning.generated_at)}</Badge> : null}>
        {learnPoll.loading && !pl ? <Skeleton rows={4} /> : !learning ? <Empty>No data yet.</Empty> : <Grid learning={learning} />}
      </Panel>

      <Panel title="Learner against the plan" icon={<Scale className="h-3.5 w-3.5 text-cyan-300" />}
        hint="Walk-forward: for each setup the learner picks from what had ended before it opened. Only setups that did not overlap count for the test."
        right={wf ? <Badge tone={verdict.tone}>{verdict.text}</Badge> : null}>
        {learnPoll.loading && !pl ? <Skeleton rows={3} /> : !wf ? <Empty>No data yet.</Empty> : (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] sm:grid-cols-3">
              {[
                ["Independent setups", `${wf.independent ?? 0} / ${wf.needs?.independent ?? "—"}`],
                ["Pick better", String(wf.discovery?.pick_better ?? 0)],
                ["Plan better", String(wf.discovery?.plan_better ?? 0)],
                ["Mean difference", R(wf.discovery?.mean_diff)],
                ["p-value", num(wf.discovery?.p_value) ? wf.discovery.p_value.toFixed(3) : "—"],
                ["Held-out part", wf.holdout ? R(wf.holdout.mean_diff) : "—"]
              ].map(([k, v]) => (
                <div key={k}><div className="text-[10px] uppercase tracking-wider text-slate-500">{k}</div><div className="mono text-[14px] font-semibold text-slate-200">{v}</div></div>
              ))}
            </div>
            <div>
              <div className="eyebrow mb-2">Pick per market condition</div>
              {(learning.learned?.contexts ?? []).length ? (
                <div className="space-y-1">
                  {learning.learned.contexts.map((c: any) => (
                    <div key={c.context} className="flex items-center justify-between gap-3 text-[11.5px]">
                      <span className="text-slate-300">{contextText(c.context)}<span className="ml-1.5 text-[10px] text-slate-500">{c.n}</span></span>
                      <span className="mono text-slate-400">{armText(c.pick)}{c.gain ? <span className="ml-2" style={{ color: C.bull }}>{R(c.gain)}</span> : null}</span>
                    </div>
                  ))}
                </div>
              ) : <div className="text-[11px] text-slate-500">No market condition measured yet.</div>}
              {plan && advice && !advice.keeps_plan ? (
                <div className="glass-inner mt-3 p-2.5 text-[11.5px] text-slate-300">
                  Latest plan: entry <span className="mono">{px(plan.entry)}</span>, stop <span className="mono">{px(plan.stop)}</span>. Learned: entry <span className="mono text-cyan-300">{px(advice.entry)}</span>, stop <span className="mono text-cyan-300">{px(advice.stop)}</span> ({advice.rrr}R). Not applied.
                </div>
              ) : null}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
