import { Fragment } from "react";
import { FlaskConical } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";

const p = (x?: number | null) => (x == null ? "n/a" : `${Math.round(x * 1000) / 10}%`);
const stuck = (s: any) => ["d_enc", "b_enc", "subtype"].map((f) => `${f} ${s?.[f]?.episodes ?? "?"}`).join(", ");
const yes = (b: unknown) => (b === true ? <span className="text-emerald-300">yes</span> : b === false ? <span className="text-rose-300">no</span> : <span className="text-slate-500">{String(b)}</span>);

function Row({ label, t, s, extra }: { label: string; t: any; s: any; extra?: React.ReactNode }) {
  return (
    <tr>
      <td className="mono">{label}</td><td className="mono">{t.n}</td><td className="mono">{p(t.accuracy)}</td>
      <td className="mono">{p(t.directional.hit_rate)} ({t.directional.n})</td><td className="mono">{p(t.wait.accuracy)} ({t.wait.n})</td>
      <td className="mono">{s ? stuck(s) : ""}</td><td>{extra}</td>
    </tr>
  );
}

/**
 * Shadow versions (RFC_INDICATOR_AGENT_PLATFORM P3): candidate indicator versions next to the
 * active control on the same closed H1 bars. Read-only; never shown in a room or used by a decision.
 */
const pointTone = (pt: any) => (pt.status === "stopped" ? "text-slate-500" : pt.status === "untested" ? "text-slate-400"
  : pt.verdict?.startsWith("better_than_active") ? "text-emerald-300" : pt.verdict === "collecting" ? "text-amber-200" : "text-rose-300");

/** Aether A8: every TUNING_GRID point, running (discovery with Holm, holdout), stopped or untested. */
function TuningGrid() {
  const { data } = usePoll(() => get("/api/tuning"), 300_000);
  const t = data as any;
  if (!t?.families?.length) return null;
  return (
    <Panel title="Tuning grid" right={<Badge tone="purple">shadow only · owner PR to promote</Badge>}>
      <p className="mb-3 text-[12px] text-slate-400">Reviewed grid points. A point starts only when a person approves it in Aether or by a reviewed PR. Discovery: {t.statistics.min_discovery_bars}+ bars, one-sided sign test, Holm per family per month ({t.holm_month}); then no worse on the {t.statistics.holdout_bars} newest bars.</p>
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Family</th><th>Parameter</th><th>Active</th><th>Grid points</th></tr></thead>
          <tbody>
            {t.families.map((f: any) => (
              <tr key={f.family + f.param}>
                <td className="mono">{f.family}</td><td className="mono">{f.param}</td><td className="mono">{f.active_value ?? "n/a"}</td>
                <td className="text-[11px]">{f.points.map((pt: any) => (
                  <span key={pt.value} className={"mr-3 " + pointTone(pt)} title={pt.reason ?? pt.verdict ?? ""}>
                    <span className="mono">{pt.value}</span> {pt.status === "running" ? `${pt.verdict}${pt.source === "aether" ? " · Aether" : ""}${pt.discovery?.p_holm != null ? ` · Holm p ${pt.discovery.p_holm}` : ""}` : pt.status}
                  </span>
                ))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {t.replays?.knowledge && (() => {
        const c = t.replays.knowledge;
        return (
          <div className="mt-3 text-[11px] text-slate-400">
            <p className="mb-1 text-[12px] text-slate-300">{c.name}: {c.enabled ? `on, at most ${c.max_calls_per_hour} calls an hour` : "off (SHADOW_KNOWLEDGE_ENABLED)"}. A/A noise: the same prompt changed the stance on {c.aa_noise.changed} of {c.aa_noise.bars} bars{c.aa_noise.rate != null ? ` (${Math.round(c.aa_noise.rate * 100)}%)` : ""}.</p>
            {!c.candidates.length && <p>No approved note is being tested.</p>}
            {c.candidates.map((k: any) => (
              <p key={k.subject}><span className="mono">{k.subject}</span>: <span className={pointTone({ status: "running", verdict: k.verdict })}>{k.verdict}</span> · {k.answered} of {k.calls} calls answered · stance changed on {k.changed_stance} of {k.same_bars} scored bars · discovery: note right {k.discovery.candidate_better}, opening right {k.discovery.control_better} (Holm p {k.discovery.p_holm ?? "n/a"}) · holdout {k.holdout.bars} of {k.holdout.required_bars}</p>
            ))}
          </div>
        );
      })()}
      {t.replays?.strategy && (() => {
        const c = t.replays.strategy;
        return (
          <div className="mt-3 text-[11px] text-slate-400">
            <p className="mb-1 text-[12px] text-slate-300">{c.name}: {c.hours} stored hours scored ({t.strategy_inputs?.captured ?? "?"} captured, kept {t.strategy_inputs?.retention_days ?? 60} days). The control reproduces the live decision on {c.control.matches_live} of {c.control.scored_hours}{c.control.drift?.length ? <span className="text-amber-200"> · drift on {c.control.drift.join(", ")}</span> : null}.</p>
            {c.candidates.map((k: any) => (
              <p key={k.id}><span className="mono">{k.id}</span> {k.change}: <span className={pointTone({ status: "running", verdict: k.verdict })}>{k.verdict}</span> · {k.differing_decisions} hours decided differently · discovery {k.discovery.bars} hours, candidate right {k.discovery.candidate_better}, active right {k.discovery.control_better} (Holm p {k.discovery.p_holm ?? "n/a"}) · holdout {k.holdout.bars} of {k.holdout.required_bars}</p>
            ))}
          </div>
        );
      })()}
      {t.replays?.crowd && (() => {
        const c = t.replays.crowd;
        return (
          <div className="mt-3 text-[11px] text-slate-400">
            <p className="mb-1 text-[12px] text-slate-300">{c.name}: {c.rooms} scored 1H rooms replayed with each parameter set (reputation point in time, bias from each agent's final stance). Weighted crowd against the moderator: crowd right {c.crowd_vs_moderator.crowd_better}, moderator right {c.crowd_vs_moderator.moderator_better} (p {c.crowd_vs_moderator.p_value ?? "n/a"}).</p>
            {c.candidates.map((k: any) => (
              <p key={k.id}><span className="mono">{k.id}</span> {k.change}: <span className={pointTone({ status: "running", verdict: k.verdict })}>{k.verdict}</span> · discovery {k.discovery.bars} rooms, candidate right {k.discovery.candidate_better}, active right {k.discovery.control_better} (Holm p {k.discovery.p_holm ?? "n/a"}) · holdout {k.holdout.bars} of {k.holdout.required_bars}</p>
            ))}
          </div>
        );
      })()}
    </Panel>
  );
}

export default function Shadow() {
  const { data, loading, error } = usePoll(() => get("/api/shadow-versions"), 300_000);
  const families: any[] = (data as any)?.families ?? [];
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      <Panel title="Shadow versions" icon={<FlaskConical className="h-3.5 w-3.5 text-violet-300" />} right={<Badge tone="purple">scored only · never decides</Badge>}>
        <p className="text-[12px] leading-relaxed text-slate-400">Candidate indicator versions run beside the active engine on the same closed H1 bars. They are scored by the same outcome scoring and never reach a room, a prompt or a decision. Promotion is the owner's decision and a separate PR.</p>
      </Panel>
      <TuningGrid />
      {loading && !data ? <Panel><Skeleton rows={6} /></Panel> : error && !data ? <Panel><p className="text-[12px] text-rose-300">Shadow data unavailable: {error}</p></Panel>
        : !families.length ? <Panel><Empty>No shadow data yet.</Empty></Panel> : families.map((f) => {
          const c = f.control;
          return (
            <Panel key={f.name} title={f.name}>
              <p className="mb-3 text-[12px] text-slate-400">Control {c.id}: {c.outputs} stored outputs; matches the approved local records on {c.matches_approved_local_records.agree} of {c.matches_approved_local_records.compared} recent candles.</p>
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>Version</th><th>Scored</th><th>Accuracy</th><th>BUY/SELL hit rate</th><th>WAIT accuracy</th><th>Stuck episodes</th><th>Verdict</th></tr></thead>
                  <tbody>
                    <Row label={`${c.id} (active)`} t={c.scored} s={c.stuck} extra={<span className="text-slate-500">control</span>} />
                    {!f.candidates.length && <tr><td colSpan={7} className="text-slate-500">No candidate version yet.</td></tr>}
                    {f.candidates.map((k: any) => (
                      <Fragment key={k.id}>
                        <Row label={k.id} t={k.scored} s={k.stuck} extra={
                          <span className={k.verdict.startsWith("better_than_active") ? "text-emerald-300" : k.verdict === "collecting" ? "text-amber-200" : "text-rose-300"}>{k.verdict}</span>} />
                        <Row label={`  control on the same ${k.same_bars} bars`} t={k.control_on_same_bars} s={null} extra={<span className="text-slate-500">{k.differing_stances} stances differ</span>} />
                        <tr><td colSpan={7} className="text-[11px] text-slate-500">
                          {k.change} · where they disagree: candidate right {k.paired.candidate_better}, active right {k.paired.control_better} (p {k.paired.p_value ?? "n/a"}) · significantly higher score: {yes(k.criteria.higher_outcome_score)} · no new stuck states: {yes(k.criteria.no_new_stuck_states)} · minimum sample: {yes(k.criteria.minimum_sample)} · reference: {k.reference}
                        </td></tr>
                        {k.discovery && <tr><td colSpan={7} className="text-[11px] text-slate-500">
                          Discovery {k.discovery.bars} bars: candidate right {k.discovery.candidate_better}, active right {k.discovery.control_better} (p {k.discovery.p_value ?? "n/a"}, Holm {k.discovery.p_holm ?? "n/a"}) · holdout {k.holdout.bars} of {k.holdout.required_bars} newest bars: candidate right {k.holdout.candidate_better}, active right {k.holdout.control_better} · no worse on the holdout: {yes(k.criteria.holdout_no_worse)}
                        </td></tr>}
                        {k.origin?.source === "aether" && <tr><td colSpan={7} className="text-[11px] text-violet-300">
                          From Aether: {k.origin.item_id} v{k.origin.version}, approved by a person for shadow testing only. Hypothesis: {k.origin.hypothesis ?? "n/a"} · metric: {k.origin.metric ?? "n/a"}
                        </td></tr>}
                        {k.review && <tr><td colSpan={7} className="text-[11px] text-slate-500">
                          Review by {k.review.by}: {k.review.rule} · decisive pairs {k.review.decisive_pairs} of {k.review.min_decisive_pairs}{k.review.due ? <span className="text-amber-200"> · review due</span> : null}
                        </td></tr>}
                      </Fragment>
                    ))}
                    {(f.retired ?? []).map((r: any) => (
                      <tr key={r.id}><td colSpan={7} className="text-[11px] text-slate-500">
                        <span className="mono">{r.id}</span> stopped {r.retired_on}: {r.reason} (at the review: {r.result.differing_stances} stances differed, candidate right {r.result.candidate_better}, active right {r.result.control_better}).
                      </td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          );
        })}
    </div>
  );
}
