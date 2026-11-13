import { useState } from "react";
import { Activity, BookOpenCheck, Brain, Cpu, Database, ScrollText, ShieldAlert, Sparkles, Scale, Sliders } from "lucide-react";
import { Badge, Empty, Hint, Kpi, Panel, Skeleton } from "../components/ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { ago } from "../lib/format";

/**
 * Aether, the Knowledge Guardian (owner 2026-11-09: its own page at nexus.cryptophys.work/aether,
 * behind the same Cloudflare Access sign-in as Nexus). Read-only: GET /api/aether/overview, served
 * by the Nexus Worker from Aether's AetherReader RPC entrypoint. No price anywhere.
 */

const TIMEFRAMES = ["15", "60", "240", "1D"] as const;
const TF_LABEL: Record<string, string> = { "15": "15m", "60": "1H", "240": "4H", "1D": "D1", engine: "Engine" };
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
    <Panel title="Room weighting" icon={<Scale className="h-3.5 w-3.5" />}>
      <div className="mb-3 flex flex-wrap gap-2" role="tablist">
        {TIMEFRAMES.map((k) => (
          <button key={k} role="tab" aria-selected={tf === k} onClick={() => setTf(k)}
            className={`btn ${tf === k ? "border-cyan-400/50 bg-cyan-400/10 text-white" : ""}`}>
            {TF_LABEL[k]}{byTf[k] ? "" : " · no report"}
          </button>
        ))}
      </div>
      {!r ? <Empty>No report for {TF_LABEL[tf]} yet.</Empty> : (
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
              <div className="label">Regimes</div>
              {regimes.length ? regimes.map(([name, n]) => (
                <div key={name} className="grid grid-cols-[130px_1fr_44px] items-center gap-2 py-0.5 text-[11px]">
                  <span className="mono text-slate-400">{name}</span><Bar value={n} max={regimeMax} tone="bg-violet-400/70" /><span className="mono text-right text-slate-300">{n}</span>
                </div>
              )) : <Empty>No regime yet.</Empty>}
            </div>
            <div>
              <div className="label">Agent weights</div>
              {agents.length ? agents.map((a: any) => (
                <div key={a.agent} className="grid grid-cols-[130px_1fr_44px_60px] items-center gap-2 py-0.5 text-[11px]">
                  <span className="mono truncate text-slate-400" title={a.agent}>{a.agent}</span>
                  <Bar value={a.weight ?? 0} max={weightMax} />
                  <span className="mono text-right text-slate-200">{num(a.weight)}</span>
                  <span className="mono text-right text-slate-500">{pct(a.accuracy)}</span>
                </div>
              )) : <Empty>No scored calls yet.</Empty>}
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
                  {!(r.candidates || []).length && <tr><td colSpan={5} className="text-slate-500">No candidates yet.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="glass-inner p-3 text-[12px]">
              <div className="label flex items-center gap-1.5">Rollback check <Hint text="Rollback needs 100 rooms and p < 0.05." /></div>
              {r.reverse ? <p className="text-slate-300">Previous <span className="mono">{r.reverse.previous_id}</span> vs active: {pct(r.reverse.previous_accuracy)} vs {pct(r.reverse.active_accuracy)}, p {r.reverse.p_value ?? "n/a"} · {r.reverse.rooms} rooms since {r.reverse.since ? ago(r.reverse.since) : "n/a"}</p>
                : <p className="text-slate-500">No activation yet.</p>}
            </div>
            <div>
              <div className="label">History</div>
              {(r.history || []).length ? (r.history || []).map((h: any, i: number) => (
                <div key={i} className="flex flex-wrap items-center gap-2 py-0.5 text-[11px]">
                  <Badge tone={h.kind === "rolled_back" ? "red" : h.kind === "activated" ? "green" : "slate"}>{h.kind}</Badge>
                  <span className="mono text-slate-300">{h.id ?? ""}</span><span className="text-slate-500">{h.at ? ago(h.at) : ""}</span>
                  {h.reason && <span className="text-slate-500">· {String(h.reason).slice(0, 120)}</span>}
                </div>
              )) : <Empty>No history yet.</Empty>}
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

// The B-11 starting set is read from the AI Worker (GET /api/weighting/engine default_weights; owner 2026-11-13:
// the page no longer keeps its own copy).
const WITNESS_LABEL: Record<string, string> = { D1: "Daily room", H4: "4H room", H1: "1H room", M15: "15m room", NEWS: "News", MACRO: "Macro room", STRATEGY: "Strategy", KEY_LEVELS: "Key levels", REGIME: "Regime", TREND_TF: "Trend TF", MACRO_DRIVERS: "Macro drivers", SESSION: "Session", CALENDAR: "Calendar", STRATEGY_AGENTS: "Strategy agents" };
const SOURCE_TEXT: Record<string, string> = { auto_tuned: "Auto-tuned", default: "Default", base: "Base (weighting off)" };

/**
 * The Decision Engine's witness weights (owner 2026-11-11: "harusnya bobot itu dinamis sesuai dengan auto
 * tune yang ada di aether"): xauusd's report of timeframe "engine", as Aether stored it for the audit.
 */
function WitnessWeights({ reports, reference }: { reports: any[]; reference: Record<string, number> | null }) {
  const r = (reports || []).find((x) => x.timeframe === "engine");
  const active: Record<string, number> = r?.active?.params || {};
  const B11: Record<string, number> = reference ?? {};
  const keys = [...new Set([...Object.keys(B11), ...Object.keys(active)])];
  const max = Math.max(0.28, ...keys.map((k) => active[k] ?? 0));
  const best = [...(r?.candidates || [])].sort((a: any, b: any) => ((b.discovery?.bars ?? 0) + (b.holdout?.bars ?? 0)) - ((a.discovery?.bars ?? 0) + (a.holdout?.bars ?? 0)))[0];
  return (
    <Panel title="Witness weights" icon={<Scale className="h-3.5 w-3.5" />} hint="Decision Engine witness weights, reported hourly after the 1H close.">
      {!r ? <Empty>No report yet.</Empty> : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
              <dt className="text-slate-500">Active</dt><dd className="mono text-slate-200">{SOURCE_TEXT[r.active?.source] ?? r.active?.source ?? "n/a"} <span className="text-slate-500">{r.active?.id ?? ""}</span></dd>
              <dt className="text-slate-500">Change</dt><dd className="text-slate-300">{r.active?.change ?? "n/a"}</dd>
              <dt className="text-slate-500">Activated</dt><dd className="mono">{r.active?.activated_at ? ago(r.active.activated_at) : "never (default)"}</dd>
              <dt className="text-slate-500">Replayed</dt><dd className="mono">{r.rooms} {r.window_days ? `(${r.window_days} days)` : ""} · scored {r.control?.scored_rooms ?? "n/a"} · accuracy {pct(r.control?.accuracy)}</dd>
              <dt className="text-slate-500">Fidelity</dt><dd className="mono">{r.replay_fidelity?.checks ? `${pct(r.replay_fidelity.share)} of ${r.replay_fidelity.checks} checks match` : "n/a"}</dd>
              <dt className="text-slate-500">Report</dt><dd className="mono">{r.received_at ? ago(r.received_at) : "n/a"}</dd>
            </dl>
            <div>
              <div className="label flex items-center gap-1.5">Weights vs default <Hint text="Bar: active weight. Marker: default weight." /></div>
              {keys.map((k) => {
                const w = active[k];
                const d = w == null || B11[k] == null ? null : w - B11[k];
                return (
                  <div key={k} className="grid grid-cols-[110px_1fr_52px_60px] items-center gap-2 py-0.5 text-[11px]">
                    <span className="truncate text-slate-400">{WITNESS_LABEL[k]}</span>
                    <div className="relative h-1.5 w-full rounded-full bg-white/5">
                      <div className="h-1.5 rounded-full bg-cyan-400/70" style={{ width: `${w == null ? 0 : Math.max(2, Math.round((w / max) * 100))}%` }} />
                      <div className="absolute -top-0.5 h-2.5 w-px bg-amber-300/80" style={{ left: `${Math.round((B11[k] / max) * 100)}%` }} title={`Default ${pct(B11[k])}`} />
                    </div>
                    <span className="mono text-right text-slate-200">{pct(w)}</span>
                    <span className={`mono text-right ${d == null || Math.abs(d) < 0.0005 ? "text-slate-500" : d > 0 ? "text-emerald-300" : "text-rose-300"}`}>{d == null ? "n/a" : Math.abs(d) < 0.0005 ? "=" : `${d > 0 ? "+" : ""}${Math.round(d * 1000) / 10}pp`}</span>
                  </div>
                );
              })}
            </div>
            {best && (
              <div className="glass-inner p-3 text-[12px]">
                <div className="label">Leading candidate</div>
                <p className="text-slate-300">{best.change ?? best.changed}: discovery {best.discovery?.bars ?? 0}/200, holdout {best.holdout?.bars ?? 0}/{best.holdout?.required_bars ?? 100}</p>
                <div className="mt-1"><Bar value={Math.min(200, best.discovery?.bars ?? 0)} max={200} /></div>
              </div>
            )}
          </div>
          <div className="space-y-3">
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Candidate</th><th>Verdict</th><th>Discovery</th><th>Holm p</th><th>Holdout</th></tr></thead>
                <tbody>
                  {(r.candidates || []).slice(0, 12).map((c: any) => (
                    <tr key={c.id}>
                      <td title={c.id}>{c.change ?? c.changed ?? c.id}</td>
                      <td className={`mono ${verdictTone(c.verdict)}`}>{c.verdict ?? "n/a"}</td>
                      <td className="mono">{c.discovery ? `${pct(c.discovery.accuracy)} vs ${pct(c.discovery.control_accuracy)} (${c.discovery.bars ?? 0})` : "n/a"}</td>
                      <td className="mono">{c.discovery?.p_holm ?? "n/a"}</td>
                      <td className="mono">{c.holdout ? `${pct(c.holdout.accuracy)} vs ${pct(c.holdout.control_accuracy)}${c.holdout.complete ? "" : " · open"}` : "n/a"}</td>
                    </tr>
                  ))}
                  {!(r.candidates || []).length && <tr><td colSpan={5} className="text-slate-500">No candidates yet.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="glass-inner p-3 text-[12px]">
              <div className="label flex items-center gap-1.5">Rollback check <Hint text="Rollback needs 100 decisions and p < 0.05." /></div>
              {r.reverse ? <p className="text-slate-300">Previous <span className="mono">{r.reverse.previous_id}</span> vs active: {pct(r.reverse.previous_accuracy)} vs {pct(r.reverse.active_accuracy)}, p {r.reverse.p_value ?? "n/a"} · {r.reverse.rooms} decisions since {r.reverse.since ? ago(r.reverse.since) : "n/a"}</p>
                : <p className="text-slate-500">No activation yet.</p>}
            </div>
            <div>
              <div className="label">History</div>
              {(r.history || []).length ? (r.history || []).map((h: any, i: number) => (
                <div key={i} className="flex flex-wrap items-center gap-2 py-0.5 text-[11px]">
                  <Badge tone={h.kind === "rolled_back" ? "red" : h.kind === "activated" ? "green" : "slate"}>{h.kind}</Badge>
                  <span className="mono text-slate-300">{h.id ?? ""}</span><span className="text-slate-500">{h.at ? ago(h.at) : ""}</span>
                  {h.reason && <span className="text-slate-500">· {String(h.reason).slice(0, 120)}</span>}
                </div>
              )) : <Empty>No history yet.</Empty>}
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

function NexusAnalyticsBridge({ analytics, guard }: { analytics: any; guard: { quorum_min: number | null; mode: string | null } | null }) {
  if (!analytics) {
    return (
      <Panel title="Execution analytics" icon={<Sliders className="h-3.5 w-3.5" />}>
        <Empty>No data yet.</Empty>
      </Panel>
    );
  }

  const { disparity, scorecards, shadow, regime, quorum_weighting_input: qwi } = analytics;
  // Measured or nothing (owner 2026-11-13): no fallback numbers.
  const fidelity: number | null = disparity?.execution_fidelity_score != null ? Math.round(disparity.execution_fidelity_score * 100) : null;
  const frictionSurcharge = qwi?.friction_surcharge ?? disparity?.friction_surcharge ?? 0;
  const volSurcharge = qwi?.volatility_surcharge ?? regime?.volatility_surcharge ?? 0;
  const baseQuorum: number | null = qwi?.base_quorum_share ?? null;
  const effectiveQuorum: number | null = qwi?.recommended_quorum_min ?? (baseQuorum != null ? baseQuorum + frictionSurcharge + volSurcharge : null);
  const discounts = Object.entries(qwi?.agent_weight_discounts || scorecards?.agent_weight_discounts || {});
  const disqualified = (qwi?.disqualified_agents || scorecards?.disqualified_agents || []) as string[];

  return (
    <Panel
      title="Execution analytics"
      icon={<Sliders className="h-3.5 w-3.5" />}
      hint="Recommends a quorum floor from execution friction and volatility. Recorded with each quorum, not applied."
      right={
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={fidelity == null ? "slate" : fidelity >= 80 ? "green" : "amber"}>
            Fidelity {fidelity != null ? `${fidelity}%` : "no sample"}
          </Badge>
          <Badge tone="slate">
            Quorum {guard?.quorum_min != null ? `> ${pct(guard.quorum_min)} (${guard.mode})` : "—"}
          </Badge>
        </div>
      }
    >

      {/* 4 Pillars Summary Grid */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="glass-inner p-3">
          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-400">
            <span>Fidelity</span>
            {frictionSurcharge > 0 ? <Badge tone="amber">+{pct(frictionSurcharge)} friction</Badge> : fidelity != null ? <Badge tone="green">OK</Badge> : null}
          </div>
          <div className="mono mt-1 text-[20px] font-bold text-slate-200">{fidelity != null ? `${fidelity}%` : "—"}</div>
          <div className="mono mt-1 text-[11px] text-slate-500">
            Slip {num(disparity?.avg_slippage_points, 1)} pts (max {num(disparity?.max_slippage_points, 1)}) · Spread {disparity?.live_spread_points != null ? `${disparity.live_spread_points} pts` : "—"} · Latency {disparity?.avg_latency_ms != null ? `${disparity.avg_latency_ms} ms` : "—"}
          </div>
        </div>

        <div className="glass-inner p-3">
          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-400">
            <span>Agent accuracy</span>
            {disqualified.length > 0 ? <Badge tone="red">{disqualified.length} disqualified</Badge> : scorecards?.avg_accuracy != null ? <Badge tone="green">OK</Badge> : null}
          </div>
          <div className="mono mt-1 text-[20px] font-bold text-slate-200">{pct(scorecards?.avg_accuracy)}</div>
          <div className="mono mt-1 text-[11px] text-slate-500">
            Brier {num(scorecards?.avg_brier, 3)} · {scorecards?.agent_count ?? 0} agents · {scorecards?.compliance_violation_rate ?? 0}/100 breaks
          </div>
        </div>

        <div className="glass-inner p-3">
          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-400">
            <span>Recommended floor</span>
            <Badge tone={effectiveQuorum != null && baseQuorum != null && effectiveQuorum > baseQuorum ? "amber" : "cyan"}>
              +{pct(frictionSurcharge + volSurcharge)}
            </Badge>
          </div>
          <div className="mono mt-1 text-[20px] font-bold text-cyan-300">{pct(effectiveQuorum)}</div>
          <div className="mono mt-1 text-[11px] text-slate-500">
            Base {pct(baseQuorum)} · Friction +{pct(frictionSurcharge)} · Vol +{pct(volSurcharge)}
          </div>
        </div>

        <div className="glass-inner p-3">
          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-400">
            <span>Shadow & regime</span>
            {regime?.regime ? <Badge tone="purple">{regime.regime}</Badge> : null}
          </div>
          <div className="mono mt-1 text-[20px] font-bold text-violet-300">{shadow?.promotion_ready ?? 0} ready</div>
          <div className="mono mt-1 text-[11px] text-slate-500">
            {shadow?.candidate_arms ?? 0} candidates · A/A noise {pct(shadow?.aa_noise_baseline_rate)}
          </div>
        </div>
      </div>

      {/* Two Column Details: Quorum Adaptation Equation + Agent Penalties */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="glass-inner p-3 text-[12px]">
          <div className="label mb-1">Quorum floor</div>
          <div className="space-y-1.5 mono text-[11px]">
            <div className="flex justify-between py-1 border-b border-white/5">
              <span className="text-slate-400">Base floor</span>
              <span className="text-slate-200">{pct(baseQuorum)}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-white/5">
              <span className="text-slate-400">+ Execution friction</span>
              <span className={frictionSurcharge > 0 ? "text-amber-300 font-semibold" : "text-slate-400"}>+{pct(frictionSurcharge)}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-white/5">
              <span className="text-slate-400">+ Volatility</span>
              <span className={volSurcharge > 0 ? "text-amber-300 font-semibold" : "text-slate-400"}>+{pct(volSurcharge)}</span>
            </div>
            <div className="flex justify-between py-1 font-bold text-cyan-300">
              <span>= Recommended (not applied)</span>
              <span>{pct(effectiveQuorum)}</span>
            </div>
          </div>
        </div>

        <div className="glass-inner p-3 text-[12px]">
          <div className="label mb-1">Vote discounts</div>
          {discounts.length > 0 || disqualified.length > 0 ? (
            <div className="space-y-1 mono text-[11px]">
              {disqualified.map((a: string) => (
                <div key={a} className="flex items-center justify-between py-1 px-2 rounded bg-rose-500/10 border border-rose-500/20 text-rose-300">
                  <span className="font-semibold">{a}</span>
                  <Badge tone="red">DISQUALIFIED</Badge>
                </div>
              ))}
              {discounts.filter(([a]) => !disqualified.includes(a)).map(([agent, mult]: [string, any]) => (
                <div key={agent} className="flex items-center justify-between py-1 px-2 rounded bg-amber-500/10 border border-amber-500/20 text-amber-200">
                  <span>{agent}</span>
                  <Badge tone="amber">{mult}x weight</Badge>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded border border-emerald-500/20 bg-emerald-500/10 p-2 text-emerald-300">
              All agents at full weight.
            </div>
          )}
          <div className="mt-3 text-[11px] text-slate-500">
            SL+ lock: <span className="mono text-slate-300">{disparity?.sl_plus_protection_active ? "Protected" : "Standard"}</span> · Updated {ago(analytics.measured_at)}
          </div>
        </div>
      </div>
    </Panel>
  );
}

const CHECK_LABEL: Record<string, string> = {
  reachable: "Aether reachable", kb_match: "KB hash match", local_push: "Card push",
  ingest: "Card ingest", canon_index: "Canon index", embed_backlog: "Embedding backlog", ai_budget: "AI budget"
};
const checkLabel = (k: string) => CHECK_LABEL[k] ?? CHECK_LABEL[k.replace(/^aether_/, "")] ?? (k.replace(/^aether_/, "").startsWith("weighting_") ? `Weighting ${TF_LABEL[k.replace(/^(aether_)?weighting_/, "")] ?? k}` : k);
const checkTone = (s?: string): "green" | "amber" | "slate" => (s === "ok" ? "green" : s === "warn" ? "amber" : "slate");

/** End-to-end sync (hardening 2026-11-09): Aether's own checks plus the AI Worker's (KB match, push, reachability). */
function Sync({ aether, worker }: { aether: any; worker: any }) {
  const rows: [string, any][] = [
    ...Object.entries(worker?.checks || {}).filter(([k]) => !k.startsWith("aether_")),
    ...Object.entries(aether?.checks || {})
  ];
  const warn = rows.some(([, c]) => c?.status === "warn");
  return (
    <Panel title="Sync status" icon={<Activity className="h-3.5 w-3.5" />} hint={`Checked every 15 minutes; a warning raises a Priority Queue alert. "idle" means the market was closed.`}
      right={rows.length ? <Badge tone={warn ? "amber" : "green"}>{warn ? "attention" : "in sync"}{aether?.market_open === false ? " · market closed" : ""}</Badge> : null}>
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
    </Panel>
  );
}

function Guardian({ g }: { g: any }) {
  const rows = g?.findings || [];
  return (
    <Panel title="Agent compliance, 24h" icon={<ShieldAlert className="h-3.5 w-3.5" />} right={<Badge tone="slate">{g?.cards ?? 0} cards · warn ≥ {g?.threshold_per_100 ?? 20}/100</Badge>}>
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
      ) : <Empty>No rule breaks in 24h.</Empty>}
    </Panel>
  );
}

function Knowledge({ k }: { k: any }) {
  const counts = Object.entries(k?.counts || {});
  return (
    <Panel title="Knowledge proposals" icon={<Sparkles className="h-3.5 w-3.5" />} hint="Reviewed in the Console. Approved items are used for shadow testing only."
      right={<div className="flex flex-wrap gap-1.5">{counts.map(([s, n]) => <Badge key={s} tone={statusTone(s)}>{s} {String(n)}</Badge>)}</div>}>
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
      ) : <Empty>No proposals yet.</Empty>}
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
      title="Canon & doctrine"
      icon={<ScrollText className="h-3.5 w-3.5" />}
      right={
        <div className="flex items-center gap-1.5">
          {council?.mode && (
            <Badge tone={council.mode === "propose" ? "green" : "amber"}>
              council {council.mode}
            </Badge>
          )}
          {council?.schedule_utc && (
            <Badge tone="cyan">{council.schedule_utc}</Badge>
          )}
          <Badge tone="purple">v{c?.version} · {short(c?.content_sha256)}</Badge>
        </div>
      }
    >

      {/* Council & Seats Status Card */}
      <div className="mb-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        <div className="glass-inner p-2.5 text-[12px]">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Council</span>
          <div className="mt-1 flex items-center justify-between">
            <span className="mono text-cyan-300">{council?.agent ?? "knowledge-council"}</span>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            {session ? `Last session ${ago(session.held_at)} · ${session.review?.length ?? 0} reviewed · ${session.proposals?.length ?? 0} proposed` : "No session yet."}
          </p>
        </div>

        <div className="glass-inner p-2.5 text-[12px]">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Nexus seat</span>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-slate-300">Decisions</span>
            <Badge tone={facts?.seats?.nexus ? "green" : "slate"}>
              {facts?.seats?.nexus ? `${facts.seats.nexus.facts} facts` : "no data"}
            </Badge>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            {facts?.measured_at ? `Updated ${ago(facts.measured_at)} · ${short(facts.seats?.nexus?.version_id, 8)}` : "No data yet."}
          </p>
        </div>

        <div className="glass-inner p-2.5 text-[12px]">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Omega seat</span>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-slate-300">Execution</span>
            <Badge tone={facts?.seats?.omega ? "green" : "slate"}>
              {facts?.seats?.omega ? `${facts.seats.omega.facts} facts` : "no data"}
            </Badge>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            {facts?.measured_at ? `Updated ${ago(facts.measured_at)} · ${short(facts.seats?.omega?.version_id, 8)}` : "No data yet."}
          </p>
        </div>
      </div>

      {/* Applied Amendments from Cerebrum Consensus */}
      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Amendments ({applied.length})
          </span>
          {applied.length === 0 && (
            <span className="text-[11px] text-slate-500">Matches canon</span>
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
            No amendments yet.
          </div>
        )}
      </div>

      {/* Active Doctrine Rules List */}
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Rules in force ({rules.length})
        </span>
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
                    Amended: {r.amended.amendment_id}
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
  const { data: tuning } = usePoll(() => get("/api/weighting/engine"), 300_000);
  const { data: latest } = usePoll(() => get("/api/engine/decisions?limit=1"), 120_000);
  const d0 = (latest as any)?.decisions?.[0] ?? null;
  const guard = d0 ? { quorum_min: d0.rules?.quorum_min ?? null, mode: d0.trading_mode ?? null } : null;
  const o = data as any;
  if (!o) return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      <Panel title="Aether" icon={<Brain className="h-3.5 w-3.5" />}>
        {loading && !error ? <Skeleton rows={4} /> : <Empty>Aether unavailable ({error ?? "no answer"}).</Empty>}
      </Panel>
    </div>
  );
  const charts = Object.entries(o.cards || {}) as [string, any][];
  const totalCards = charts.reduce((s, [, v]) => s + (v?.cards ?? 0), 0);
  const ai = o.ai || {};
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      <Panel title="Aether" icon={<Brain className="h-3.5 w-3.5" />} hint="Knowledge guardian: keeps the canon, stores decision cards, audits compliance and weighting. Never changes a decision."
        right={<Badge tone="slate">updated {ago(o.generated_at)}</Badge>}>
        {null}
      </Panel>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Decision cards" value={String(totalCards)} sub={charts.map(([k, v]) => `${TF_LABEL[k] ?? k} ${v.cards}`).join(" · ") || "none yet"} color="#39d0d8" icon={<Database className="h-3 w-3" />} />
        <Kpi label="Ingested 24h" value={String(o.ingest?.last_24h?.accepted ?? 0)} sub={`${o.ingest?.last_24h?.rejected ?? 0} refused · ${o.ingest?.last_24h?.calls ?? 0} calls`} color="#3fb950" icon={<BookOpenCheck className="h-3 w-3" />} />
        <Kpi label="AI budget" value={`${ai.used_today ?? 0}/${ai.daily_limit ?? 0}`} sub="today" color={ai.used_today >= ai.daily_limit ? "#f85149" : "#d29922"} icon={<Cpu className="h-3 w-3" />} />
        <Kpi label="Vector index" value={o.indexes?.canon?.indexed ? "in sync" : "pending"} sub={`${o.indexes?.canon?.vectors ?? 0} canon vectors · ${o.indexes?.market?.pending_cards ?? 0} cards to embed`} color={o.indexes?.canon?.indexed ? "#3fb950" : "#d29922"} icon={<Brain className="h-3 w-3" />} />
      </div>
      <NexusAnalyticsBridge analytics={analytics} guard={guard} />
      <Sync aether={o.sync} worker={(status as any)?.aether?.sync} />
      <WitnessWeights reports={o.weighting || []} reference={(tuning as any)?.default_weights ?? null} />
      <Weighting reports={o.weighting || []} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Guardian g={o.guardian} />
        <Knowledge k={o.knowledge} />
      </div>
      <Canon c={o.canon} doctrine={o.doctrine} />
    </div>
  );
}
