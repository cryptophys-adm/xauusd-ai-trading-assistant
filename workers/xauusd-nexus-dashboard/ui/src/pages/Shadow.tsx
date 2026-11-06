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
export default function Shadow() {
  const { data, loading, error } = usePoll(() => get("/api/shadow-versions"), 300_000);
  const families: any[] = (data as any)?.families ?? [];
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      <Panel title="Shadow versions" icon={<FlaskConical className="h-3.5 w-3.5 text-violet-300" />} right={<Badge tone="purple">scored only · never decides</Badge>}>
        <p className="text-[12px] leading-relaxed text-slate-400">Candidate indicator versions run beside the active engine on the same closed H1 bars. They are scored by the same outcome scoring and never reach a room, a prompt or a decision. Promotion is the owner's decision and a separate PR.</p>
      </Panel>
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
                      </Fragment>
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
