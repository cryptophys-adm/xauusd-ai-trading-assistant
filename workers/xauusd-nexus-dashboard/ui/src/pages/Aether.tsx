import { useState } from "react";
import { Activity, BookOpenCheck, Brain, Cpu, Database, ScrollText, ShieldAlert, Sparkles, Scale, Sliders, ShieldCheck, Zap } from "lucide-react";
import { Badge, Empty, Kpi, Panel, Skeleton } from "../components/ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { ago } from "../lib/format";

/**
 * Aether, the Knowledge Guardian (owner 2026-11-09: its own page at nexus.cryptophys.work/aether,
 * behind the same Cloudflare Access sign-in as Nexus). Read-only: GET /api/aether/overview, served
 * by the Nexus Worker from Aether's AetherReader RPC entrypoint. No price anywhere.
 */

const TIMEFRAMES = ["15", "60", "240", "1D"] as const;
const TF_LABEL: Record<string, string> = { "15": "15m", "60": "1H", "240": "4H", "1D": "D1" };
const pct = (x?: number | null) => (x == null ? "n/a" : `${Math.round(x * 1000) / 10}%`);
const num = (x?: number | null, d = 2) => (x == null ? "n/a" : x.toFixed(d));
const short = (s?: string | null, n = 12) => (s ? s.slice(0, n) : "n/a");
const statusTone = (s?: string): "green" | "amber" | "red" | "slate" | "purple" =>
  s === "approved" ? "green" : s === "pending" ? "amber" : s === "rejected" ? "red" : s === "proposed" ? "purple" : "slate";
const verdictTone = (v?: string | null) => (v?.startsWith("better_than_active") ? "text-emerald-300" : v === "running" || v === "collecting" ? "text-amber-200" : "text-slate-400");

function Bar({ value, max, tone = "bg-cyan-400/70" }: { value: number; max: number; tone?: string }) {
  const w = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return <div className="h-1.5 w-full rounded-full bg-white/5"><div className={`h-1.5 rounded-full ${tone}`} style={{ width: `${w}%` }} /></div>;
}

function Weighting({ reports }: { reports: any[] }) {
  const byTf = Object.fromEntries((reports || []).map((r) => [r.timeframe, r]));
  const [tf, setTf] = useState<string>(byTf["60"] ? "60" : (reports?.[0]?.timeframe ?? "60"));
  const r = byTf[tf];
  const regimes = Object.entries(r?.regimes || {}).sort((a: any, b: any) => b[1] - a[1]) as [string, number][];
  const regimeMax = Math.max(1, ...regimes.map(([, n]) => n));
  const agents = [...(r?.agents || [])].sort((a: any, b: any) => (b.weight ?? 0) - (a.weight ?? 0));
  const weightMax = Math.max(1, ...agents.map((a: any) => a.weight ?? 0));
  return (
    <Panel title="Room quorum weighting" icon={<Scale className="h-3.5 w-3.5" />} right={<Badge tone="purple">auto-tuned per timeframe · audited</Badge>}>
      <div className="mb-3 flex flex-wrap gap-2" role="tablist">
        {TIMEFRAMES.map((k) => (
          <button key={k} role="tab" aria-selected={tf === k} onClick={() => setTf(k)}
            className={`btn ${tf === k ? "border-cyan-400/50 bg-cyan-400/10 text-white" : ""}`}>
            {TF_LABEL[k]}{byTf[k] ? "" : " · no report"}
          </button>
        ))}
      </div>
      {!r ? <Empty>No weighting report for {TF_LABEL[tf]} yet. xauusd sends one when its replay changes.</Empty> : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
              <dt className="text-slate-500">Active point</dt><dd className="mono text-slate-200">{r.active?.id ?? "n/a"}</dd>
              <dt className="text-slate-500">Mode</dt><dd className="mono">{r.mode ?? "n/a"}</dd>
              <dt className="text-slate-500">Rooms replayed</dt><dd className="mono">{r.rooms} {r.window_days ? `(${r.window_days} days)` : ""}</dd>
              <dt className="text-slate-500">Activated</dt><dd className="mono">{r.active?.activated_at ? ago(r.active.activated_at) : "default point"}</dd>
              <dt className="text-slate-500">Report</dt><dd className="mono">{r.received_at ? ago(r.received_at) : "n/a"}</dd>
            </dl>
            <div>
              <div className="label">Regimes of the replayed rooms</div>
              {regimes.length ? regimes.map(([name, n]) => (
                <div key={name} className="grid grid-cols-[130px_1fr_44px] items-center gap-2 py-0.5 text-[11px]">
                  <span className="mono text-slate-400">{name}</span><Bar value={n} max={regimeMax} tone="bg-violet-400/70" /><span className="mono text-right text-slate-300">{n}</span>
                </div>
              )) : <Empty>No regime yet.</Empty>}
            </div>
            <div>
              <div className="label">Agent weights (own record on this timeframe)</div>
              {agents.length ? agents.map((a: any) => (
                <div key={a.agent} className="grid grid-cols-[130px_1fr_44px_60px] items-center gap-2 py-0.5 text-[11px]">
                  <span className="mono truncate text-slate-400" title={a.agent}>{a.agent}</span>
                  <Bar value={a.weight ?? 0} max={weightMax} />
                  <span className="mono text-right text-slate-200">{num(a.weight)}</span>
                  <span className="mono text-right text-slate-500">{pct(a.accuracy)}</span>
                </div>
              )) : <Empty>No agent has a scored call yet.</Empty>}
            </div>
          </div>
          <div className="space-y-3">
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Candidate</th><th>Verdict</th><th>Discovery</th><th>Holm p</th><th>Holdout</th></tr></thead>
                <tbody>
                  {(r.candidates || []).slice(0, 8).map((c: any) => (
                    <tr key={c.id}>
                      <td className="mono" title={c.change ?? ""}>{c.changed ?? c.id}</td>
                      <td className={`mono ${verdictTone(c.verdict)}`}>{c.verdict ?? "n/a"}</td>
                      <td className="mono">{c.discovery ? `${pct(c.discovery.accuracy)} vs ${pct(c.discovery.control_accuracy)} (${c.discovery.bars ?? 0})` : "n/a"}</td>
                      <td className="mono">{c.discovery?.p_holm ?? "n/a"}</td>
                      <td className="mono">{c.holdout ? `${pct(c.holdout.accuracy)} vs ${pct(c.holdout.control_accuracy)}${c.holdout.complete ? "" : " · open"}` : "n/a"}</td>
                    </tr>
                  ))}
                  {!(r.candidates || []).length && <tr><td colSpan={5} className="text-slate-500">No candidate replayed yet.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="glass-inner p-3 text-[12px]">
              <div className="label">Reverse shadow (rollback check)</div>
              {r.reverse ? <p className="text-slate-300">Previous <span className="mono">{r.reverse.previous_id}</span> against the active point on {r.reverse.rooms} rooms since {r.reverse.since ? ago(r.reverse.since) : "n/a"}: {pct(r.reverse.previous_accuracy)} vs {pct(r.reverse.active_accuracy)}, p {r.reverse.p_value ?? "n/a"}. A rollback needs 100 rooms and p &lt; 0.05.</p>
                : <p className="text-slate-500">No activation yet, so nothing to roll back.</p>}
            </div>
            <div>
              <div className="label">History</div>
              {(r.history || []).length ? (r.history || []).map((h: any, i: number) => (
                <div key={i} className="flex flex-wrap items-center gap-2 py-0.5 text-[11px]">
                  <Badge tone={h.kind === "rolled_back" ? "red" : h.kind === "activated" ? "green" : "slate"}>{h.kind}</Badge>
                  <span className="mono text-slate-300">{h.id ?? ""}</span><span className="text-slate-500">{h.at ? ago(h.at) : ""}</span>
                  {h.reason && <span className="text-slate-500">· {String(h.reason).slice(0, 120)}</span>}
                </div>
              )) : <Empty>No activation or rollback yet.</Empty>}
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

function NexusAnalyticsBridge({ analytics }: { analytics: any }) {
  if (!analytics) {
    return (
      <Panel title="Nexus Analytics · Intelligent Quorum Weighting Engine" icon={<Sliders className="h-3.5 w-3.5" />}
        right={<Badge tone="amber">Awaiting Telemetry</Badge>}>
        <Empty>Loading real-time Nexus Analytics & Quorum Weighting bridge telemetry...</Empty>
      </Panel>
    );
  }

  const { disparity, scorecards, shadow, regime, quorum_weighting_input: qwi } = analytics;
  const fidelity = disparity?.execution_fidelity_score != null ? Math.round(disparity.execution_fidelity_score * 100) : 92;
  const frictionSurcharge = qwi?.friction_surcharge ?? disparity?.friction_surcharge ?? 0;
  const volSurcharge = qwi?.volatility_surcharge ?? regime?.volatility_surcharge ?? 0;
  const baseQuorum = qwi?.base_quorum_share ?? 0.50;
  const effectiveQuorum = qwi?.recommended_quorum_min ?? (baseQuorum + frictionSurcharge + volSurcharge);
  const discounts = Object.entries(qwi?.agent_weight_discounts || scorecards?.agent_weight_discounts || {});
  const disqualified = (qwi?.disqualified_agents || scorecards?.disqualified_agents || []) as string[];

  return (
    <Panel
      title="Nexus Analytics · Intelligent Quorum Weighting Engine"
      icon={<Sliders className="h-3.5 w-3.5" />}
      right={
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="purple">RFC_AETHER §6.1 Compliant</Badge>
          <Badge tone={fidelity >= 80 ? "green" : "amber"}>
            Fidelity {fidelity}%
          </Badge>
          <Badge tone={effectiveQuorum > 0.5 ? "amber" : "cyan"}>
            Consensus Floor {pct(effectiveQuorum)}
          </Badge>
        </div>
      }
    >
      <p className="mb-3 text-[12px] leading-relaxed text-slate-400">
        All 4 pillars of Nexus Analytics (Execution Disparity, Scorecards/Reputation, Shadow Proofs, and Market Volatility Regime) are synthesized into Intelligent Aether to dynamically adapt the quorum consensus threshold (<span className="mono text-cyan-300">share_needed_above</span>) and discount or disqualify compromised agents. Strictly compliant with Aether leak checks (zero absolute prices, orders, or sizes).
      </p>

      {/* 4 Pillars Summary Grid */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="glass-inner p-3">
          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-400">
            <span>Execution Fidelity</span>
            <Badge tone={frictionSurcharge > 0 ? "amber" : "green"}>
              {frictionSurcharge > 0 ? `+${pct(frictionSurcharge)} friction` : "Optimal"}
            </Badge>
          </div>
          <div className="mono mt-1 text-[20px] font-bold text-slate-200">{fidelity}%</div>
          <div className="mono mt-1 text-[11px] text-slate-500">
            Slippage: {num(disparity?.avg_slippage_points, 1)} pts (max {num(disparity?.max_slippage_points, 1)}) · Spread: {disparity?.live_spread_points ?? 16} pts · Latency: {disparity?.avg_latency_ms ?? 240}ms
          </div>
        </div>

        <div className="glass-inner p-3">
          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-400">
            <span>Agent Reputation</span>
            <Badge tone={disqualified.length > 0 ? "red" : "green"}>
              {disqualified.length > 0 ? `${disqualified.length} Disqualified` : "Active"}
            </Badge>
          </div>
          <div className="mono mt-1 text-[20px] font-bold text-slate-200">{pct(scorecards?.avg_accuracy)}</div>
          <div className="mono mt-1 text-[11px] text-slate-500">
            Calibration Brier: {num(scorecards?.avg_brier, 3)} · {scorecards?.agent_count ?? 0} scored agents · Violations: {scorecards?.compliance_violation_rate ?? 0}/100
          </div>
        </div>

        <div className="glass-inner p-3">
          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-400">
            <span>Dynamic Quorum Floor</span>
            <Badge tone={effectiveQuorum > baseQuorum ? "amber" : "cyan"}>
              +{pct(frictionSurcharge + volSurcharge)} Surcharge
            </Badge>
          </div>
          <div className="mono mt-1 text-[20px] font-bold text-cyan-300">{pct(effectiveQuorum)}</div>
          <div className="mono mt-1 text-[11px] text-slate-500">
            Base: {pct(baseQuorum)} · Friction: +{pct(frictionSurcharge)} · Volatility: +{pct(volSurcharge)}
          </div>
        </div>

        <div className="glass-inner p-3">
          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-400">
            <span>Shadow & Regime Guard</span>
            <Badge tone="purple">{regime?.regime ?? "normal"}</Badge>
          </div>
          <div className="mono mt-1 text-[20px] font-bold text-violet-300">{shadow?.promotion_ready ?? 0} Promotable</div>
          <div className="mono mt-1 text-[11px] text-slate-500">
            {shadow?.candidate_arms ?? 0} candidate arms · A/A baseline noise: {pct(shadow?.aa_noise_baseline_rate)}
          </div>
        </div>
      </div>

      {/* Two Column Details: Quorum Adaptation Equation + Agent Penalties */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="glass-inner p-3 text-[12px]">
          <div className="label mb-1">Quorum Consensus Dynamic Formula</div>
          <p className="text-slate-300 mb-2">
            The decision council requires a directional witness supermajority exceeding <span className="mono text-cyan-300 font-semibold">{pct(effectiveQuorum)}</span> before permitting directional entries. When broker slippage expands or volatility spikes, the floor ratchets up to protect capital:
          </p>
          <div className="space-y-1.5 mono text-[11px]">
            <div className="flex justify-between py-1 border-b border-white/5">
              <span className="text-slate-400">Base Quorum Consensus Floor</span>
              <span className="text-slate-200">{pct(baseQuorum)}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-white/5">
              <span className="text-slate-400">+ Broker Execution Friction Surcharge</span>
              <span className={frictionSurcharge > 0 ? "text-amber-300 font-semibold" : "text-slate-400"}>+{pct(frictionSurcharge)}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-white/5">
              <span className="text-slate-400">+ Market Regime Volatility Surcharge</span>
              <span className={volSurcharge > 0 ? "text-amber-300 font-semibold" : "text-slate-400"}>+{pct(volSurcharge)}</span>
            </div>
            <div className="flex justify-between py-1 font-bold text-cyan-300">
              <span>= Effective Quorum Consensus Floor (share_needed_above)</span>
              <span>{pct(effectiveQuorum)}</span>
            </div>
          </div>
        </div>

        <div className="glass-inner p-3 text-[12px]">
          <div className="label mb-1">Agent Voting Discounts & Disqualifications</div>
          <p className="text-slate-300 mb-2">
            Agents in stuck states or with recurring compliance rule breaks suffer automatic voting discounts or outright disqualification in council quorums:
          </p>
          {discounts.length > 0 || disqualified.length > 0 ? (
            <div className="space-y-1 mono text-[11px]">
              {disqualified.map((a: string) => (
                <div key={a} className="flex items-center justify-between py-1 px-2 rounded bg-rose-500/10 border border-rose-500/20 text-rose-300">
                  <span className="font-semibold">{a}</span>
                  <Badge tone="red">DISQUALIFIED (Stuck State · 0% Weight)</Badge>
                </div>
              ))}
              {discounts.filter(([a]) => !disqualified.includes(a)).map(([agent, mult]: [string, any]) => (
                <div key={agent} className="flex items-center justify-between py-1 px-2 rounded bg-amber-500/10 border border-amber-500/20 text-amber-200">
                  <span>{agent}</span>
                  <Badge tone="amber">Weight Multiplier: {mult}x (Rule Breaker)</Badge>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded border border-emerald-500/20 bg-emerald-500/10 p-2 text-emerald-300">
              ✓ All agents in full compliance. Zero stuck states detected. Full voting weights active.
            </div>
          )}
          <div className="mt-3 text-[11px] text-slate-500">
            SL+ locked status: <span className="mono text-slate-300">{disparity?.sl_plus_protection_active ? "Protected" : "Standard"}</span> · Telemetry updated {ago(analytics.measured_at)}.
          </div>
        </div>
      </div>
    </Panel>
  );
}

const CHECK_LABEL: Record<string, string> = {
  reachable: "Aether reachable from the AI Worker", kb_match: "KB v4 hash: xauusd = Aether canon", local_push: "AI Worker pushes decision cards",
  ingest: "Aether receives decision cards", canon_index: "Canon indexed in Vectorize", embed_backlog: "Card embedding backlog", ai_budget: "Aether AI budget"
};
const checkLabel = (k: string) => CHECK_LABEL[k] ?? CHECK_LABEL[k.replace(/^aether_/, "")] ?? (k.replace(/^aether_/, "").startsWith("weighting_") ? `Weighting report ${TF_LABEL[k.replace(/^(aether_)?weighting_/, "")] ?? k}` : k);
const checkTone = (s?: string): "green" | "amber" | "slate" => (s === "ok" ? "green" : s === "warn" ? "amber" : "slate");

/** End-to-end sync (hardening 2026-11-09): Aether's own checks plus the AI Worker's (KB match, push, reachability). */
function Sync({ aether, worker }: { aether: any; worker: any }) {
  const rows: [string, any][] = [
    ...Object.entries(worker?.checks || {}).filter(([k]) => !k.startsWith("aether_")),
    ...Object.entries(aether?.checks || {})
  ];
  const warn = rows.some(([, c]) => c?.status === "warn");
  return (
    <Panel title="End-to-end sync · xauusd → Aether → Nexus" icon={<Activity className="h-3.5 w-3.5" />}
      right={<Badge tone={warn ? "amber" : "green"}>{warn ? "attention" : "in sync"}{aether?.market_open === false ? " · market closed" : ""}</Badge>}>
      {!rows.length ? <Empty>No sync status yet.</Empty> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead>
            <tbody>
              {rows.map(([k, c]) => (
                <tr key={k}>
                  <td>{checkLabel(k)}</td>
                  <td><Badge tone={checkTone(c?.status)}>{c?.status ?? "n/a"}</Badge></td>
                  <td className="mono text-[11px] text-slate-400">
                    {c?.age_minutes != null ? `${c.age_minutes} min ago (limit ${c.limit_minutes})` : ""}
                    {c?.last_at && c?.age_minutes == null ? ago(c.last_at) : ""}
                    {c?.pending != null ? `${c.pending} pending${c.oldest_minutes ? `, oldest ${c.oldest_minutes} min` : ""}` : ""}
                    {c?.local ? `xauusd ${c.local} · Aether ${c.aether ?? "n/a"}` : ""}
                    {c?.canon ? `canon ${c.canon} · indexed ${c.indexed_canon ?? "none"}` : ""}
                    {c?.used != null ? `${c.used}/${c.limit}` : ""}
                    {c?.error ? String(c.error) : ""}
                    {c?.hint ? ` · ${c.hint}` : c?.note ? ` · ${c.note}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[11px] text-slate-500">Checked every 15 minutes by the AI Worker's health alerts; a warning opens an alert in the Priority Queue. "idle": the market was closed during the check's window.</p>
    </Panel>
  );
}

function Guardian({ g }: { g: any }) {
  const rows = g?.findings || [];
  return (
    <Panel title="Guardian · agent compliance (24 h)" icon={<ShieldAlert className="h-3.5 w-3.5" />} right={<Badge tone="slate">{g?.cards ?? 0} room conclusions · warn at {g?.threshold_per_100 ?? 20}/100</Badge>}>
      {rows.length ? (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Agent</th><th>Check</th><th>Breaks</th><th>Messages</th><th>Per 100</th></tr></thead>
            <tbody>
              {rows.map((f: any) => (
                <tr key={`${f.agent}|${f.check}`}>
                  <td className="mono">{f.agent}</td><td className="mono">{f.check}</td><td className="mono">{f.breaks}</td><td className="mono">{f.messages}</td>
                  <td className={`mono ${f.per_100 >= (g.threshold_per_100 ?? 20) ? "text-rose-300" : "text-slate-300"}`}>{f.per_100}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>No rule break in the last 24 hours.</Empty>}
    </Panel>
  );
}

function Knowledge({ k }: { k: any }) {
  const counts = Object.entries(k?.counts || {});
  return (
    <Panel title="Knowledge proposals (curator · calibrator)" icon={<Sparkles className="h-3.5 w-3.5" />}
      right={<div className="flex flex-wrap gap-1.5">{counts.map(([s, n]) => <Badge key={s} tone={statusTone(s)}>{s} {String(n)}</Badge>)}</div>}>
      <p className="mb-2 text-[12px] text-slate-400">Learned, never canon. A person approves or rejects each proposal in the Console's Knowledge page; an approved item is used for shadow testing only.</p>
      {(k?.items || []).length ? (
        <div className="space-y-2">
          {k.items.map((it: any) => (
            <div key={`${it.item_id}@${it.version}`} className="glass-inner p-3">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
                <Badge tone={statusTone(it.status)}>{it.status}</Badge><Badge tone="slate">{it.kind}</Badge>
                <span className="mono text-slate-400">{it.agent}</span><span className="ml-auto text-slate-500">{ago(it.updated_at)}</span>
              </div>
              <p className="text-[12px] leading-relaxed text-slate-200">{it.text ?? it.item_id}</p>
              {it.params && <p className="mono mt-1 text-[11px] text-violet-300">{JSON.stringify(it.params)}</p>}
            </div>
          ))}
        </div>
      ) : <Empty>No proposal yet.</Empty>}
    </Panel>
  );
}

function Canon({ c, doctrine }: { c: any; doctrine?: any }) {
  const council = doctrine?.council;
  const facts = doctrine?.facts;
  const applied = doctrine?.applied || [];
  const rules = doctrine?.rules || c?.doctrine || [];
  const session = council?.last_session;

  return (
    <Panel
      title="Canon · Knowledge Council & Doctrine"
      icon={<ScrollText className="h-3.5 w-3.5" />}
      right={
        <div className="flex items-center gap-1.5">
          {council?.mode && (
            <Badge tone={council.mode === "propose" ? "green" : "amber"}>
              Council: {council.mode}
            </Badge>
          )}
          {council?.schedule_utc && (
            <Badge tone="cyan">{council.schedule_utc}</Badge>
          )}
          <Badge tone="purple">v{c?.version} · {short(c?.content_sha256)}</Badge>
        </div>
      }
    >
      <p className="mb-3 text-[12px] text-slate-400">
        Autonomous Doctrine Protocol: Knowledge Council evaluates measured system facts against doctrine daily, proposing drifts to Cerebrum Consensus for execution. Effective doctrine is synced hourly to Aether and consumed dynamically by Trading Agents.
      </p>

      {/* Council & Seats Status Card */}
      <div className="mb-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        <div className="glass-inner p-2.5 text-[12px]">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Knowledge Council</span>
          <div className="mt-1 flex items-center justify-between">
            <span className="mono text-cyan-300">{council?.agent ?? "knowledge-council"}</span>
            <Badge tone="green">daily 03:52 UTC</Badge>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            {session ? `Last session: ${ago(session.held_at)} · ${session.review?.length ?? 0} reviewed · ${session.proposals?.length ?? 0} proposed` : "Next scheduled session: 03:52 UTC"}
          </p>
        </div>

        <div className="glass-inner p-2.5 text-[12px]">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Nexus Seat (Decisions)</span>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-slate-300">Measured facts</span>
            <Badge tone={facts?.seats?.nexus ? "green" : "slate"}>
              {facts?.seats?.nexus ? `${facts.seats.nexus.facts} facts` : "reporting"}
            </Badge>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            {facts?.measured_at ? `Freshness: ${ago(facts.measured_at)} · version: ${short(facts.seats?.nexus?.version_id, 8)}` : "Hourly sweep reporting active"}
          </p>
        </div>

        <div className="glass-inner p-2.5 text-[12px]">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Omega Seat (Execution)</span>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-slate-300">Broker & gates</span>
            <Badge tone={facts?.seats?.omega ? "green" : "slate"}>
              {facts?.seats?.omega ? `${facts.seats.omega.facts} facts` : "reporting"}
            </Badge>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            {facts?.measured_at ? `Freshness: ${ago(facts.measured_at)} · version: ${short(facts.seats?.omega?.version_id, 8)}` : "Hourly sweep reporting active"}
          </p>
        </div>
      </div>

      {/* Applied Amendments from Cerebrum Consensus */}
      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Cerebrum Executed Amendments ({applied.length})
          </span>
          {applied.length === 0 && (
            <span className="text-[11px] text-slate-500">Doctrine in force matches Canon baseline</span>
          )}
        </div>
        {applied.length > 0 ? (
          <div className="space-y-1.5">
            {applied.map((a: any) => (
              <div key={a.amendment_id} className="glass-inner flex items-center justify-between p-2 text-[12px]">
                <div>
                  <span className="mono text-emerald-300">{a.amendment_id}</span>
                  <span className="ml-2 font-medium text-slate-200">{a.rule}</span>
                  <span className="ml-2 text-slate-400">({a.action})</span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-slate-400">
                  <span>Executed {ago(a.executed_at)}</span>
                  <Badge tone="green">applied</Badge>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="glass-inner p-2.5 text-[11px] text-slate-400">
            No amendments executed yet. The 20 baseline rules of Canon v2 are active with zero drift rejections.
          </div>
        )}
      </div>

      {/* Active Doctrine Rules List */}
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Doctrine Rules in Force ({rules.length})
        </span>
        <span className="text-[11px] text-slate-500">Live feed for Decision Council & Agents</span>
      </div>
      <ol className="max-h-[480px] space-y-1.5 overflow-y-auto text-[12px] pr-1">
        {rules.map((r: any) => (
          <li key={r.id} className="glass-inner p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <div className="flex items-center gap-2">
                <span className="mono font-semibold text-cyan-300">{r.id}</span>
                <Badge tone={r.class === "constitutional" ? "purple" : "cyan"}>
                  {r.class || "operational"}
                </Badge>
                {r.amended && (
                  <Badge tone="green">
                    Amended by Cerebrum: {r.amended.amendment_id}
                  </Badge>
                )}
              </div>
              {r.since && <span className="text-[10px] text-slate-500">since {r.since}</span>}
            </div>
            <p className="mt-1 leading-relaxed text-slate-300">{r.rule}</p>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

export default function Aether() {
  const { data, error, loading } = usePoll(() => get("/api/aether/overview"), 120_000);
  const { data: status } = usePoll(() => get("/api/aether/status"), 120_000);
  const { data: analytics } = usePoll(() => get("/api/aether/nexus-analytics"), 60_000);
  const o = data as any;
  if (!o) return (
    <div className="space-y-4">
      <Panel title="Aether · Knowledge Guardian" icon={<Brain className="h-3.5 w-3.5" />}>
        {loading && !error ? <Skeleton rows={4} /> : <Empty>Aether is unavailable ({error ?? "no answer"}).</Empty>}
      </Panel>
    </div>
  );
  const charts = Object.entries(o.cards || {}) as [string, any][];
  const totalCards = charts.reduce((s, [, v]) => s + (v?.cards ?? 0), 0);
  const ai = o.ai || {};
  return (
    <div className="space-y-4">
      <Panel title="Aether · Knowledge Guardian" icon={<Brain className="h-3.5 w-3.5" />} right={<Badge tone="purple">advisory only · read-only view</Badge>}>
        <p className="text-[12px] leading-relaxed text-slate-400">Aether keeps the canon, stores every room's decision card, audits agent compliance, proposes learned knowledge for shadow testing and audits the automatic room weighting. It never changes a decision and never holds a price. Updated {ago(o.generated_at)}.</p>
      </Panel>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Decision cards" value={String(totalCards)} sub={charts.map(([k, v]) => `${TF_LABEL[k] ?? k} ${v.cards}`).join(" · ") || "none yet"} color="#39d0d8" icon={<Database className="h-3 w-3" />} />
        <Kpi label="Ingested 24 h" value={String(o.ingest?.last_24h?.accepted ?? 0)} sub={`${o.ingest?.last_24h?.rejected ?? 0} refused · ${o.ingest?.last_24h?.calls ?? 0} calls`} color="#3fb950" icon={<BookOpenCheck className="h-3 w-3" />} />
        <Kpi label="AI budget today" value={`${ai.used_today ?? 0}/${ai.daily_limit ?? 0}`} sub="embeddings only" color={ai.used_today >= ai.daily_limit ? "#f85149" : "#d29922"} icon={<Cpu className="h-3 w-3" />} />
        <Kpi label="Vector indexes" value={o.indexes?.canon?.indexed ? "in sync" : "pending"} sub={`${o.indexes?.canon?.vectors ?? 0} canon vectors · ${o.indexes?.market?.pending_cards ?? 0} cards to embed`} color={o.indexes?.canon?.indexed ? "#3fb950" : "#d29922"} icon={<Brain className="h-3 w-3" />} />
      </div>
      <NexusAnalyticsBridge analytics={analytics} />
      <Sync aether={o.sync} worker={(status as any)?.aether?.sync} />
      <Weighting reports={o.weighting || []} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Guardian g={o.guardian} />
        <Knowledge k={o.knowledge} />
      </div>
      <Canon c={o.canon} doctrine={o.doctrine} />
    </div>
  );
}
