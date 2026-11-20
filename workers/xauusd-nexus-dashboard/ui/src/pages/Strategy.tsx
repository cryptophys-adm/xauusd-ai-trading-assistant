import { useState } from "react";
import { Crosshair, Grid3x3, ListChecks, Puzzle, Scale, Shapes } from "lucide-react";
import { Badge, Empty, Hint, Panel, Skeleton } from "../components/ui";
import { C } from "../components/charts";
import { get } from "../lib/api";
import { ago } from "../lib/format";
import { usePoll } from "../lib/usePoll";
import { LensPanel } from "../components/LensPanel";

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

/**
 * The strategy arm (owner 2026-11-17, ADR-0020): one click arms or disarms a live strategy, at most 3. While none is
 * armed the mode is AUTO: each entry is the one best strategy by confidence × confluence. The server checks the rest.
 */
type ArmState = { mode?: string; selection?: string; max?: number; state?: { version: number; ids: string[]; armed_count: number }; allowed?: string[]; blocked?: string | null; error?: string; can_arm?: boolean; council?: { ceiling?: string; auto?: boolean; acting?: boolean; pins?: { id: string; by: string; at: string; action: string }[] } } | null;
function ArmButton({ id, arm, onDone }: { id: string; arm: ArmState; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const armed = arm?.state?.ids?.includes(id) ?? false;
  const full = (arm?.state?.armed_count ?? 0) >= (arm?.max ?? 3);
  const canArm = !armed && (arm?.allowed ?? []).includes(id) && !full && !arm?.blocked && arm?.mode !== "off";
  // Owner only (RFC §11.3): another signed-in person sees the state, never the button.
  if (!arm || arm.error || arm.mode === "off" || arm.can_arm === false) return null;
  const click = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/omega/api/strategy-arm", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ strategy_id: id, action: armed ? "disarm" : "arm", request_id: crypto.randomUUID(), expected_version: arm.state?.version ?? null }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d?.ok === false) throw new Error(d?.error === "conflict" ? "changed meanwhile, reloaded" : d?.error || `HTTP ${r.status}`);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); onDone(); }
  };
  const title = armed ? "Disarm: this strategy stops opening positions (its open ones keep being managed)"
    : !(arm.allowed ?? []).includes(id) ? "Only a live strategy can be armed" : full ? `At most ${arm.max ?? 3} armed: disarm one first` : arm.blocked ? `Cannot arm while ${arm.blocked}` : "Arm: only the armed strategies open positions";
  return (
    <div className="mt-2 flex items-center gap-2">
      <button type="button" disabled={busy || (!armed && !canArm)} title={title} onClick={click}
        className={`rounded-md px-2.5 py-1 text-[11px] font-semibold ${armed ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/40" : "bg-slate-700/60 text-slate-200 ring-1 ring-slate-500/40"} disabled:opacity-40`}>
        {busy ? "…" : armed ? "Armed · Disarm" : "Arm"}
      </button>
      {err ? <span className="text-[10.5px] text-rose-300">{err}</span> : null}
    </div>
  );
}

const RECO_TEXT: Record<string, string> = {
  breaker_suspended: "the breaker holds it back", record_negative: "its record is below 0 R", context_negative: "its record in the present condition is below 0 R",
  omega_stop_share: "too many of its Omega trades end at the stop or the locked stop", recommend_bar: "30+ setups at +0.10 R or better", collecting: "collecting setups (under 15)", below_recommend_bar: "not yet 30 setups at +0.10 R"
};
/** The recommendation (RFC §3, deterministic, read-only): the verdict, why, and Omega's exits and real trades. */
function RecoLine({ card }: { card: any }) {
  const r = card?.recommendation;
  if (!r) return null;
  const verdict: [string, "green" | "red" | "slate"] = r.verdict === "recommended" ? ["Recommended", "green"] : r.verdict === "not_recommended" ? ["Not recommended", "red"] : ["Neutral", "slate"];
  const ex = card.exits ?? {}, run = card.executed ?? {};
  const rules = (r.rules ?? []).map((x: any) => `${x.holds ? "✓" : "✗"} ${x.rule}: ${x.value ?? "n/a"} (${x.threshold}) ${x.ref}`).join("\n");
  return (
    <div className="mt-2 space-y-1 text-[10.5px] text-slate-400" title={rules}>
      <div className="flex items-center gap-1.5"><Badge tone={verdict[1]}>{verdict[0]}</Badge><span className="truncate">{RECO_TEXT[r.reason] ?? r.reason}</span></div>
      <div className="mono">Omega exits: stop {pc(ex.stop_share)} · locked {pc(ex.sl_plus_share)} (n {ex.n ?? 0}) · trades {run.opened ?? 0} opened, {run.closed ?? 0} closed{run.win_share != null ? `, ${pc(run.win_share)} won` : ""}</div>
    </div>
  );
}

const ownerPost = async (path: string, body: unknown) => {
  const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d?.ok === false) throw new Error(d?.error || `HTTP ${r.status}`);
  return d;
};
/** The strategy council's daily verdict (walk-forward and proposal), deterministic gate, read-only. */
function VerdictLine({ v }: { v: any }) {
  if (!v) return null;
  const wf = v.walk_forward ?? {};
  const tone: "green" | "red" | "slate" = wf.status === "pass" ? "green" : wf.status === "fail" ? "red" : "slate";
  return (
    <div className="mt-1 text-[10.5px] text-slate-400" title={`walk-forward: ${wf.n} setups, mean ${wf.mean_r}R, bootstrap low ${wf.low}, latest ${wf.holdout_n}: ${wf.holdout_mean_r}R${v.live_mean_r != null ? ` · live last 10: ${v.live_mean_r}R` : ""}`}>
      <Badge tone={tone}>walk-forward {wf.status}</Badge> <span>Council: <span className="text-slate-200">{v.proposal}</span>{v.reason ? ` · ${v.reason}` : ""}{v.applied ? ` · ${v.applied}` : ""}</span>
    </div>
  );
}
/** A strategy the owner armed or disarmed by hand is pinned against the council until the owner unpins it. */
function PinLine({ id, arm, onDone }: { id: string; arm: ArmState; onDone: () => void }) {
  const pin = arm?.council?.pins?.find((p) => p.id === id);
  if (!pin || arm?.can_arm === false) return null;
  return (
    <div className="mt-1 flex items-center gap-2 text-[10.5px] text-slate-400">
      <span>Pinned by your {pin.action || "click"}: the council leaves it.</span>
      <button type="button" className="rounded-sm px-1.5 py-0.5 ring-1 ring-slate-500/40 hover:bg-slate-700/50" onClick={async () => { try { await ownerPost("/omega/api/strategy-arm/unpin", { strategy_id: id }); } finally { onDone(); } }}>Unpin</button>
    </div>
  );
}
/** The owner's "Council auto-arm" toggle; off until the platform allows it (ADR-0020 Amendment 2). */
function CouncilToggle({ arm, onDone }: { arm: ArmState; onDone: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const c = arm?.council;
  if (!c || arm?.can_arm === false) return null;
  const allowed = c.ceiling === "allowed";
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
      <span>Council auto-arm:</span>
      <button type="button" disabled={!allowed && !c.auto} title={allowed ? "When on, the strategy council arms and disarms by itself within its guards; your manual clicks pin a strategy" : "Waiting for the platform's approval (ADR-0020 Amendment 2)"}
        onClick={async () => { setErr(null); try { await ownerPost("/omega/api/strategy-council", { auto: !c.auto }); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { onDone(); } }}
        className={`rounded-md px-2 py-0.5 font-semibold ring-1 ${c.auto ? "bg-emerald-500/20 text-emerald-200 ring-emerald-400/40" : "bg-slate-700/60 text-slate-200 ring-slate-500/40"} disabled:opacity-40`}>{c.auto ? "On" : "Off"}</button>
      <span>{c.acting ? "the council arms and disarms within its guards" : allowed ? "proposals only" : "proposals only · waiting for the platform's approval"}</span>
      {err ? <span className="text-rose-300">{err}</span> : null}
    </div>
  );
}

/** The registry: one card per agent with its status, what it is made for and its measured record. */
function Registry({ agents, chosen, arm, reload }: { agents: any[]; chosen: string | null; arm: ArmState; reload: () => void }) {
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
            <RecoLine card={a.card} />
            <VerdictLine v={a.verdicts} />
            <ArmButton id={a.id} arm={arm} onDone={reload} />
            <PinLine id={a.id} arm={arm} onDone={reload} />
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
                  <td key={k} style={{ background: bg(a?.mean_diff) }} className={control ? "outline-solid outline-1 -outline-offset-1 outline-cyan-400/50" : ""} title={a?.n ? `${a.n} setups · filled ${pc(a.fill_rate)} · reached target ${pc(a.target_rate)}` : "too few setups fit this arm"}>
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

/** The cells Omega uses now, per strategy and regime (src/grid-adapt.mjs); the plan everywhere else. */
function GridAdapt({ g }: { g: any }) {
  if (!g) return null;
  const slices = Object.entries(g.slices ?? {}) as [string, any][];
  const held = Object.keys(g.held ?? {});
  return (
    <div className="mt-2 text-[11px] text-slate-400">
      <span className="mr-2">Automatic adaptation: <span className="mono text-slate-200">{g.mode}</span>{g.day ? ` · evaluated ${g.day}` : ""}.</span>
      {slices.length ? slices.map(([k, v]) => <span key={k} className="mr-2"><Badge tone="cyan">{k.replace("|", " · ")}: {v.cell}</Badge> <span className="mono">+{v.evidence?.gain}R</span></span>)
        : <span>Every strategy and regime uses the plan: no cell passes the evidence gate.</span>}
      {held.length ? <span className="ml-2">Held after a revert: {held.join(", ")}.</span> : null}
    </div>
  );
}

const VERDICT: Record<string, { text: string; tone: "green" | "amber" | "slate" }> = {
  better_than_plan: { text: "better than the plan", tone: "green" }, not_better: { text: "not better", tone: "amber" }, collecting: { text: "collecting", tone: "slate" }
};

export default function Strategy() {
  const agentsPoll = usePoll(() => get("/api/strategy-agents"), 120_000);
  // The arm state from Omega (a person's page; the AI Worker checks the click server-side).
  const [armTick, setArmTick] = useState(0);
  const armPoll = usePoll(() => fetch(`/omega/api/strategy-arm?t=${armTick}`, { credentials: "same-origin", headers: { accept: "application/json" } }).then((r) => r.json()), 60_000, [armTick]);
  const arm = (armPoll.data ?? null) as ArmState;
  const armIds = arm?.state?.ids ?? [];
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
        right={s ? <span className="flex items-center gap-1.5">{arm && !arm.error && arm.mode !== "off" ? <span title={armIds.length ? `Only the armed strategies open positions: ${armIds.join(", ")}` : "No strategy armed: each entry is the one best strategy by confidence × confluence"}><Badge tone={armIds.length ? "green" : "cyan"}>{armIds.length ? `ARMED ${armIds.length}/${arm.max ?? 3}` : "AUTO · best of all"}</Badge></span> : null}<Badge tone="slate">{agents.filter((a) => a.status === "live").length} live · {agents.filter((a) => a.status === "shadow" && !a.suspended).length} shadow{agents.some((a) => a.suspended) ? ` · ${agents.filter((a) => a.suspended).length} suspended` : ""}</Badge></span> : null}>
        <CouncilToggle arm={arm} onDone={() => setArmTick((t) => t + 1)} />
        {loading ? <Skeleton rows={4} /> : agentsPoll.error && !s ? <Empty>Unavailable ({agentsPoll.error}).</Empty> : <Registry agents={agents} chosen={latest?.stance && latest.stance !== "WAIT" ? latest.chosen : null} arm={arm} reload={() => setArmTick((t) => t + 1)} />}
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
        hint="The default agent's plans replayed with a deeper entry and a tighter or wider stop. Each cell: mean R per setup in R of the cell's own stop (a tighter stop makes 1R smaller), then the difference against the plan and how often it filled. An unfilled entry counts as 0R. Omega adopts a cell automatically only per strategy and regime, judged in R of the plan's stop on the same setups (40+ fills, bootstrap, holdout, neighbours)."
        right={learning ? <Badge tone="slate">{learning.setups?.resolved ?? 0} setups · updated {ago(learning.generated_at)}</Badge> : null}>
        {learnPoll.loading && !pl ? <Skeleton rows={4} /> : !learning ? <Empty>No data yet.</Empty> : <Grid learning={learning} />}
        <GridAdapt g={pl?.grid_adapt} />
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

      <LensPanel />
    </div>
  );
}
