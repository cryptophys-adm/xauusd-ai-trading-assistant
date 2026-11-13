import { useState } from "react";
import { FlaskConical, GitPullRequest, CheckCircle, AlertTriangle, Activity, BarChart2, Zap, ArrowRight, ShieldCheck } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";

const p = (x?: number | null) => (x == null ? "n/a" : `${Math.round(x * 1000) / 10}%`);
const stuck = (s: any) => ["d_enc", "b_enc", "subtype"].map((f) => `${f} ${s?.[f]?.episodes ?? "?"}`).join(", ");
const yes = (b: unknown) => (b === true ? <span className="font-semibold text-emerald-300">PASS</span> : b === false ? <span className="font-semibold text-rose-300">FAIL</span> : <span className="text-slate-500">{String(b)}</span>);

const pointTone = (pt: any) => (
  pt.status === "stopped" ? "text-slate-500" :
  pt.status === "untested" ? "text-slate-400" :
  pt.verdict?.startsWith("better_than_active") ? "text-emerald-300 font-bold" :
  pt.verdict === "collecting" ? "text-amber-200" :
  "text-rose-300"
);

function verdictBadge(verdict: string) {
  if (verdict?.startsWith("better_than_active")) return <Badge tone="green">BETTER (PROMOTION READY)</Badge>;
  if (verdict === "collecting") return <Badge tone="amber">COLLECTING SAMPLE</Badge>;
  if (verdict === "control") return <Badge tone="slate">ACTIVE CONTROL</Badge>;
  return <Badge tone="red">{verdict || "NOT BETTER"}</Badge>;
}

/** Visual SVG Comparative Delta Bar: Candidate vs Control Head-to-Head */
function HeadToHeadGraph({ candidateBetter, controlBetter, candidateName, controlName }: { candidateBetter: number; controlBetter: number; candidateName: string; controlName: string }) {
  const total = (candidateBetter || 0) + (controlBetter || 0);
  if (total === 0) return <div className="text-[11px] text-slate-500 italic">No disagreement bars evaluated yet.</div>;
  const candPct = Math.round((candidateBetter / total) * 100);
  const ctrlPct = 100 - candPct;

  return (
    <div className="space-y-1.5 py-1">
      <div className="flex items-center justify-between text-[11px] mono">
        <span className="text-emerald-300 font-semibold">{candidateName}: {candidateBetter} wins ({candPct}%)</span>
        <span className="text-rose-300 font-semibold">{controlName}: {controlBetter} wins ({ctrlPct}%)</span>
      </div>
      <div className="relative flex h-3 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full bg-emerald-400 transition-all duration-500" style={{ width: `${candPct}%` }} title={`${candidateName}: ${candPct}%`} />
        <div className="h-full bg-rose-400 transition-all duration-500" style={{ width: `${ctrlPct}%` }} title={`${controlName}: ${ctrlPct}%`} />
        {/* 50% Marker */}
        <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-white/40 z-10" />
      </div>
    </div>
  );
}

/** Which shadow arm a knowledge subject belongs to: the 1H rooms, the 15m War Room or the Decision Engine council. */
const isCouncil = (k: any) => k?.agent === "council";
const armOrder = (k: any) => (isCouncil(k) ? 2 : k?.chart === "15" ? 1 : 0);
function armBadge(k: any) {
  if (isCouncil(k)) return <Badge tone="cyan">Council · 15m</Badge>;
  return k?.chart === "15" ? <Badge tone="purple">War Room · 15m</Badge> : <Badge tone="slate">Room · 1H</Badge>;
}

/** Aether A8: every TUNING_GRID point, running (discovery with Holm, holdout), stopped or untested. */
function TuningGrid() {
  const { data } = usePoll(() => get("/api/tuning"), 300_000);
  const t = data as any;
  if (!t?.families?.length) return null;

  return (
    <Panel
      title="Dynamic Parameter Tuning Grid (Statistical Validation)"
      icon={<Zap className="h-3.5 w-3.5 text-cyan-400" />}
      right={<Badge tone="purple">Shadow Validation · Parameters: owner PR · Notes: live by themselves</Badge>}
    >
      <p className="mb-3 text-[12px] text-slate-400">
        Rigorous statistical parameter grid testing: Discovery &ge; {t.statistics.min_discovery_bars} bars, one-sided sign test, Holm-Bonferroni family-wise error correction per month ({t.holm_month}), followed by out-of-sample holdout validation on the newest {t.statistics.holdout_bars} closed candles.
      </p>

      {/* Grid Families Table */}
      <div className="table-wrap mb-4">
        <table className="tbl">
          <thead>
            <tr>
              <th>Family Engine</th>
              <th>Tested Parameter</th>
              <th>Active Value (Control)</th>
              <th>Candidate Grid Values & Verdicts</th>
            </tr>
          </thead>
          <tbody>
            {t.families.map((f: any) => (
              <tr key={f.family + f.param}>
                <td className="font-semibold text-slate-200">{f.family}</td>
                <td className="mono text-cyan-300">{f.param}</td>
                <td className="mono"><Badge tone="slate">{f.active_value ?? "n/a"}</Badge></td>
                <td className="text-[11px]">
                  <div className="flex flex-wrap gap-2">
                    {f.points.map((pt: any) => (
                      <span key={pt.value} className={`rounded px-2 py-0.5 border border-white/5 bg-white/[0.03] ${pointTone(pt)}`} title={pt.reason ?? pt.verdict ?? ""}>
                        <span className="mono font-bold">{pt.value}</span> : {pt.status === "running" ? `${pt.verdict}${pt.discovery?.p_holm != null ? ` (Holm p ${pt.discovery.p_holm})` : ""}` : pt.status}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Aether Knowledge Candidates Table */}
      {t.replays?.knowledge && (() => {
        const c = t.replays.knowledge;
        return (
          <div className="mt-4 rounded-xl border border-white/5 bg-white/[0.02] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12px] font-semibold text-violet-300 flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-violet-400" />
                {c.name} — Aether Knowledge Hypotheses (A/A Baseline)
              </span>
              <Badge tone={c.enabled ? "green" : "slate"}>{c.enabled ? `Active · Max ${c.max_calls_per_hour}/hr` : "Disabled"}</Badge>
            </div>
            <p className="mb-3 text-[11px] text-slate-400">
              A/A noise baseline: identical prompts changed stance on {c.aa_noise.changed} of {c.aa_noise.bars} bars ({c.aa_noise.rate != null ? `${Math.round(c.aa_noise.rate * 100)}%` : "0%"} stochastic model jitter threshold).
            </p>
            {!c.candidates.length ? (
              <Empty>No approved Aether note currently in shadow testing.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Arm</th>
                      <th>Note Subject</th>
                      <th>Calls (Ans/Tot)</th>
                      <th>Stance Delta</th>
                      <th>Discovery Head-to-Head</th>
                      <th>Holm p-value</th>
                      <th>Holdout Bars</th>
                      <th>Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...c.candidates].sort((a: any, b: any) => armOrder(a) - armOrder(b)).map((k: any) => (
                      <tr key={k.subject}>
                        <td>{armBadge(k)}</td>
                        <td className="mono font-semibold text-slate-200" title={k.subject}>{k.agent ?? k.subject}{k.item_id ? <span className="block text-[10px] font-normal text-slate-500">{k.item_id} v{k.item_version}</span> : null}</td>
                        <td className="mono">{k.answered}/{k.calls}</td>
                        <td className="mono text-amber-200">{k.changed_stance} of {k.same_bars} bars</td>
                        <td className="mono text-[11px]">
                          <span className="text-emerald-300">Note: {k.discovery.candidate_better}</span> vs <span className="text-rose-300">Base: {k.discovery.control_better}</span>
                        </td>
                        <td className="mono text-slate-300">{k.discovery.p_holm ?? "n/a"}</td>
                        <td className="mono">{k.holdout.bars}/{k.holdout.required_bars}</td>
                        <td>{verdictBadge(k.verdict)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {/* Strategy Replay Candidates Table */}
      {t.replays?.strategy && (() => {
        const c = t.replays.strategy;
        return (
          <div className="mt-4 rounded-xl border border-white/5 bg-white/[0.02] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12px] font-semibold text-cyan-300 flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-cyan-400" />
                {c.name} — Strategy Input Replays
              </span>
              <span className="mono text-[11px] text-slate-400">{c.hours} scored hours ({t.strategy_inputs?.captured ?? "?"} captured)</span>
            </div>
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Candidate ID</th>
                    <th>Logic Delta</th>
                    <th>Differing Decisions</th>
                    <th>Discovery Comparison</th>
                    <th>Holm p-value</th>
                    <th>Holdout Progress</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {c.candidates.map((k: any) => (
                    <tr key={k.id}>
                      <td className="mono font-semibold text-slate-200">{k.id}</td>
                      <td className="text-slate-300 text-[11px]">{k.change}</td>
                      <td className="mono text-amber-200">{k.differing_decisions} hrs</td>
                      <td className="mono text-[11px]">
                        <span className="text-emerald-300">Cand: {k.discovery.candidate_better}</span> vs <span className="text-rose-300">Ctrl: {k.discovery.control_better}</span>
                      </td>
                      <td className="mono text-slate-300">{k.discovery.p_holm ?? "n/a"}</td>
                      <td className="mono">{k.holdout.bars}/{k.holdout.required_bars}</td>
                      <td>{verdictBadge(k.verdict)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}
    </Panel>
  );
}

export default function Shadow() {
  const { data, loading, error } = usePoll(() => get("/api/shadow-versions"), 300_000);
  const families: any[] = (data as any)?.families ?? [];

  // Aggregated Shadow Telemetry
  let totalCandidates = 0;
  let promotionReadyCount = 0;
  let collectingCount = 0;
  let totalBarsEvaluated = 0;

  for (const f of families) {
    totalBarsEvaluated = Math.max(totalBarsEvaluated, f.control?.outputs || 0);
    for (const c of f.candidates || []) {
      totalCandidates++;
      if (c.verdict?.startsWith("better_than_active")) promotionReadyCount++;
      else if (c.verdict === "collecting") collectingCount++;
    }
  }

  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      {/* Header Panel */}
      <Panel
        title="Shadow Testing & Epigenetic Promotion Arena"
        icon={<FlaskConical className="h-4 w-4 text-violet-300" />}
        right={<Badge tone="purple">Out-of-Band Simulation · Zero Risk</Badge>}
      >
        <p className="text-[12px] leading-relaxed text-slate-400">
          Parallel out-of-band testing arena where candidate indicator algorithms and knowledge hypotheses run alongside the active engine (<span className="text-slate-200 font-semibold">Active Control</span>) on the same closed bars (1H for the indicator candidates and the 1H rooms; 15m for the 15m War Room and the council).
          The platform enforces non-parametric statistical tests (Holm-Bonferroni Sign Test) and out-of-sample holdout validation. Parameter candidates are promoted by a reviewed Pull Request; a knowledge note that reads better than active goes live by itself for the agents and chart it was tested on (see Model &amp; Learning) and retires by itself if it gets worse.
        </p>

        {/* Consumer Badges */}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3 text-[11px]">
          <span className="text-slate-400">Primary Consumers:</span>
          <Badge tone="purple">Epigenetic Promotion Engine (Aether A7/A8)</Badge>
          <Badge tone="cyan">Weighting Replay Statistical Sentry</Badge>
          <Badge tone="green">Reverse Shadow Rollback Guard</Badge>
          <Badge tone="slate">Lead Quant PR Reviewer</Badge>
        </div>
      </Panel>

      {/* KPI Overview Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="glass p-3 sm:p-4">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            <FlaskConical className="h-3.5 w-3.5 text-violet-400" />
            <span>Active Shadow Arms</span>
          </div>
          <div className="mono mt-2 text-[22px] font-extrabold text-violet-300 sm:text-[26px]">
            {totalCandidates}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">Across {families.length} engine families</div>
        </div>

        <div className="glass p-3 sm:p-4">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            <GitPullRequest className="h-3.5 w-3.5 text-emerald-400" />
            <span>Promotion Ready</span>
          </div>
          <div className="mono mt-2 text-[22px] font-extrabold text-emerald-300 sm:text-[26px]">
            {promotionReadyCount}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">{promotionReadyCount ? "Holm p < 0.05 & Holdout Pass" : "No candidate qualifies yet"}</div>
        </div>

        <div className="glass p-3 sm:p-4">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            <Activity className="h-3.5 w-3.5 text-amber-400" />
            <span>Collecting Sample</span>
          </div>
          <div className="mono mt-2 text-[22px] font-extrabold text-amber-300 sm:text-[26px]">
            {collectingCount}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">Target &ge; 50 decisive pairs</div>
        </div>

        <div className="glass p-3 sm:p-4">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            <BarChart2 className="h-3.5 w-3.5 text-cyan-400" />
            <span>Evaluated Candle Series</span>
          </div>
          <div className="mono mt-2 text-[22px] font-extrabold text-cyan-300 sm:text-[26px]">
            {totalBarsEvaluated}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">Paired H1 closed candles</div>
        </div>
      </div>

      {/* Dynamic Parameter Tuning Grid */}
      <TuningGrid />

      {loading && !data ? (
        <Panel><Skeleton rows={6} /></Panel>
      ) : error && !data ? (
        <Panel><p className="text-[12px] text-rose-300">Shadow data unavailable: {error}</p></Panel>
      ) : !families.length ? (
        <Panel><Empty>No shadow version data yet.</Empty></Panel>
      ) : (
        families.map((f) => {
          const c = f.control;
          return (
            <Panel
              key={f.name}
              title={`Engine Family: ${f.name.toUpperCase()}`}
              right={<Badge tone="slate">Active: {c.id}</Badge>}
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-slate-400">
                <span>
                  Control <strong className="text-slate-200">{c.id}</strong>: {c.outputs} total outputs recorded · Matches approved local calculations on{" "}
                  <strong className="text-emerald-300">{c.matches_approved_local_records.agree}</strong> of {c.matches_approved_local_records.compared} candles.
                </span>
                <span className="mono text-[11px]">Accuracy: {p(c.scored?.accuracy)} · Directional: {p(c.scored?.directional?.hit_rate)}</span>
              </div>

              {/* Tabular Candidate Comparison */}
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Candidate Version / Arm</th>
                      <th>Sample (Bars)</th>
                      <th>Accuracy Delta</th>
                      <th>Head-to-Head Win/Loss</th>
                      <th>Holm Significance (p)</th>
                      <th>Holdout Validation</th>
                      <th>Stuck States</th>
                      <th>Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Control Row */}
                    <tr className="bg-white/[0.02]">
                      <td>
                        <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                          <span>{c.id}</span>
                          <Badge tone="slate">CONTROL (ACTIVE)</Badge>
                        </div>
                      </td>
                      <td className="mono">{c.scored?.n ?? 0}</td>
                      <td className="mono text-slate-300">{p(c.scored?.accuracy)}</td>
                      <td className="text-slate-500 text-[11px]">— Baseline Reference —</td>
                      <td className="mono text-slate-500">—</td>
                      <td className="mono text-slate-500">—</td>
                      <td className="mono text-[11px] text-slate-400">{c.stuck ? stuck(c.stuck) : "None"}</td>
                      <td>{verdictBadge("control")}</td>
                    </tr>

                    {/* Candidate Rows */}
                    {!f.candidates.length ? (
                      <tr><td colSpan={8} className="py-4 text-center text-slate-500">No candidate version currently competing in this family.</td></tr>
                    ) : (
                      f.candidates.map((k: any) => (
                        <tr key={k.id} className="border-t border-white/5">
                          <td>
                            <div className="font-semibold text-slate-200">{k.id}</div>
                            <div className="text-[11px] text-slate-400 mt-0.5">{k.change}</div>
                            {k.origin?.source === "aether" && (
                              <div className="mt-1 text-[10px] text-violet-300 flex items-center gap-1">
                                <Zap className="h-3 w-3" />
                                <span>Aether Hypothesis: {k.origin.hypothesis ?? k.origin.item_id}</span>
                              </div>
                            )}
                          </td>
                          <td className="mono text-slate-300">
                            <div>{k.scored?.n ?? 0} bars</div>
                            <div className="text-[10px] text-amber-200">{k.differing_stances} diff</div>
                          </td>
                          <td>
                            <div className="mono font-bold text-slate-200">{p(k.scored?.accuracy)}</div>
                            <div className="text-[10px] text-slate-400">Dir: {p(k.scored?.directional?.hit_rate)}</div>
                          </td>
                          <td className="w-[200px]">
                            <HeadToHeadGraph
                              candidateBetter={k.paired?.candidate_better ?? 0}
                              controlBetter={k.paired?.control_better ?? 0}
                              candidateName={k.id}
                              controlName={c.id}
                            />
                          </td>
                          <td className="mono">
                            <div className={k.paired?.p_value != null && k.paired.p_value < 0.05 ? "text-emerald-300 font-bold" : "text-slate-400"}>
                              p = {k.discovery?.p_holm ?? k.paired?.p_value ?? "n/a"}
                            </div>
                            <div className="text-[10px] text-slate-500">Sign Test {yes(k.criteria?.higher_outcome_score)}</div>
                          </td>
                          <td className="mono">
                            <div>{k.holdout?.bars ?? 0}/{k.holdout?.required_bars ?? "?"} bars</div>
                            <div className="text-[10px]">{yes(k.criteria?.holdout_no_worse)}</div>
                          </td>
                          <td className="mono text-[11px]">{yes(k.criteria?.no_new_stuck_states)}</td>
                          <td>{verdictBadge(k.verdict)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Retired Candidate Audit Trail */}
              {!!f.retired?.length && (
                <div className="mt-3 border-t border-white/5 pt-2 text-[11px] text-slate-500">
                  <span className="font-semibold text-slate-400">Retired Candidates: </span>
                  {f.retired.map((r: any) => (
                    <span key={r.id} className="mr-3">
                      <span className="mono">{r.id}</span> ({r.reason}, stopped {r.retired_on})
                    </span>
                  ))}
                </div>
              )}
            </Panel>
          );
        })
      )}
    </div>
  );
}
