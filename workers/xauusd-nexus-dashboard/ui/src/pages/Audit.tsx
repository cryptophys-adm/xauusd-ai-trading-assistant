import { useState } from "react";
import { BookOpenCheck } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";

const CHARTS: [string, string][] = [["15", "15m War Room"], ["60", "1H room"], ["240", "4H room"], ["1D", "D1 room"]];
const pc = (x?: number | null) => (x == null ? "" : `${Math.round(x * 100)}%`);
const when = (t?: string | null) => (t ? `${t.slice(5, 16).replace("T", " ")} UTC` : "");
const stanceTone = (s?: string | null) => (s === "BUY" || s === "bullish" ? "text-emerald-300" : s === "SELL" || s === "bearish" ? "text-rose-300" : "text-slate-300");
const resultTone = (r?: string) => (r === "hit" ? "text-emerald-300" : r === "miss" || r === "missed_opportunity" ? "text-rose-300" : "text-slate-400");

function Card({ c }: { c: any }) {
  const outcomes = Object.entries(c.outcomes ?? {}) as [string, any][];
  return (
    <Panel title={`${when(c.bar_open)} · ${c.session ?? ""}`} right={<span className="flex gap-1">{c.conclusion?.reconvened ? <Badge tone="purple">reconvened</Badge> : null}{c.compliance?.length ? <Badge tone="amber">{c.compliance.length} rule break{c.compliance.length > 1 ? "s" : ""}</Badge> : <Badge tone="green">no rule break</Badge>}</span>}>
      <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
        <span>Conclusion: <b className={stanceTone(c.conclusion?.stance)}>{c.conclusion?.stance ?? "none"}</b>{c.conclusion?.bias ? <> · bias <b className={stanceTone(c.conclusion.bias)}>{c.conclusion.bias}</b></> : null} {pc(c.conclusion?.confidence)}</span>
        {c.crowd ? <span>Crowd: <b className={stanceTone(c.crowd.weighted_bias)}>{c.crowd.weighted_bias ?? "n/a"}</b>, disagreement {c.crowd.disagreement ?? "n/a"}</span> : null}
        {c.h1 ? <span>H1 decision: <b className={stanceTone(c.h1.decision)}>{c.h1.decision ?? "n/a"}</b> {pc(c.h1.confidence)}</span> : null}
        {c.stuck_open?.length ? <span className="text-amber-200">Stuck: {c.stuck_open.map((s: any) => `${s.field} ${s.candles}`).join(", ")}</span> : null}
      </div>
      {c.conclusion?.summary ? <p className="mb-2 text-[12px] leading-relaxed text-slate-300">{c.conclusion.summary}</p> : null}
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Agent</th><th>Final stance</th><th>Bias</th><th>Confidence</th><th>Opening claim</th><th>Outcome</th></tr></thead>
          <tbody>
            {(c.agents ?? []).map((a: any) => {
              const o = c.outcomes?.[`agent:${a.id}`];
              return (
                <tr key={a.id}>
                  <td className="mono">{a.id}</td><td><span className={stanceTone(a.stance)}>{a.stance ?? ""}</span></td><td><span className={stanceTone(a.bias)}>{a.bias ?? ""}</span></td>
                  <td className="mono">{pc(a.confidence)}</td><td className="max-w-[460px] text-[11px] text-slate-400">{a.claim ?? ""}</td>
                  <td><span className={resultTone(o?.result)}>{(o?.result ?? "open").replace("_", " ")}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {c.compliance?.length ? (
        <ul className="mt-2 list-disc pl-5 text-[11px] text-amber-200">
          {c.compliance.map((x: any, i: number) => <li key={i}><span className="mono">{x.agent}</span> · {x.check}{x.detail ? `: ${x.detail}` : ""}</li>)}
        </ul>
      ) : null}
      {outcomes.some(([k]) => k === "chain:h1") ? <p className="mt-2 text-[11px] text-slate-400">H1 chain outcome: <span className={resultTone(c.outcomes["chain:h1"].result)}>{c.outcomes["chain:h1"].result}</span></p> : null}
    </Panel>
  );
}

function ComplianceTable() {
  const { data } = usePoll(() => get("/api/compliance?days=7"), 300_000);
  const v = (data as any)?.compliance;
  if (!v) return null;
  const rows: any[] = (v.agents ?? []).filter((a: any) => a.violations > 0);
  return (
    <Panel title="Rule breaks, last 7 days" right={<Badge tone={v.total?.violations ? "amber" : "green"}>{v.total?.rate_per_100 ?? 0} per 100 messages</Badge>}>
      <p className="mb-2 text-[12px] text-slate-400">Deterministic checks of every room message ({(v.checks ?? []).join(", ")}). {v.total?.messages ?? 0} messages, {v.total?.violations ?? 0} breaks.</p>
      {!rows.length ? <Empty>No rule break in the window.</Empty> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Room</th><th>Agent</th><th>Messages</th><th>Breaks</th><th>Per 100</th><th>Checks</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.chart + r.agent}>
                  <td className="mono">{r.chart}</td><td className="mono">{r.agent}</td><td className="mono">{r.messages}</td><td className="mono">{r.violations}</td><td className="mono">{r.rate_per_100 ?? ""}</td>
                  <td className="text-[11px] text-slate-400">{Object.entries(r.by_check ?? {}).map(([k, x]: [string, any]) => `${k} ${x.count}`).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function AetherStatus() {
  const { data } = usePoll(() => get("/api/aether/status"), 300_000);
  const a = (data as any)?.aether;
  if (!a) return null;
  const charts = Object.entries(a.charts ?? {}) as [string, any][];
  return (
    <Panel title="Sent to Aether" right={<Badge tone={a.binding === "present" ? "green" : "slate"}>{a.binding === "present" ? "binding present" : "binding absent"}</Badge>}>
      <p className="mb-2 text-[12px] text-slate-400">Every decision card is pushed to the Knowledge Guardian for embedding and audit. Last 24 hours: {Object.entries(a.last_24h ?? {}).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}.{a.learned_pack?.status ? ` Learned pack: ${a.learned_pack.status}.` : ""}</p>
      {charts.length ? (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Room</th><th>Accepted</th><th>Rejected</th><th>Last push</th></tr></thead>
            <tbody>{charts.map(([k, x]) => <tr key={k}><td className="mono">{k}</td><td className="mono">{x.accepted ?? 0}</td><td className="mono">{x.rejected ?? 0}</td><td className="mono">{when(x.last_pushed_at)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}

/**
 * Decision audit (RFC_AETHER_KNOWLEDGE_GUARDIAN A1): the decision card of each room conclusion, with
 * every agent's final stance, the crowd line, the rule breaks and the outcomes once scored. Cards
 * carry no level of any kind. Read-only.
 */
export default function Audit() {
  const [chart, setChart] = useState("60");
  const { data, loading, error } = usePoll(() => get(`/api/decision-cards?chart=${chart}&limit=8`), 300_000, [chart]);
  const cards: any[] = (data as any)?.cards ?? [];
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      <Panel title="Decision audit" icon={<BookOpenCheck className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="cyan">no levels · read-only</Badge>}>
        <p className="text-[12px] leading-relaxed text-slate-400">The record of each room's conclusion: every agent's final stance and opening claim, the room's crowd line, the rule breaks found in its messages, and the outcome of each statement once its horizon has closed. The same cards go to Aether.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {CHARTS.map(([k, label]) => (
            <button key={k} onClick={() => setChart(k)} className={`rounded border px-2 py-1 text-[12px] ${chart === k ? "border-cyan-400/50 bg-cyan-500/10 text-cyan-200" : "border-white/10 text-slate-400 hover:text-slate-200"}`}>{label}</button>
          ))}
        </div>
      </Panel>
      {loading && !data ? <Panel><Skeleton rows={6} /></Panel> : error && !data ? <Panel><p className="text-[12px] text-rose-300">Decision cards unavailable: {error}</p></Panel>
        : !cards.length ? <Panel><Empty>No room conclusion recorded for this room yet.</Empty></Panel> : cards.map((c) => <Card key={c.card_id} c={c} />)}
      <ComplianceTable />
      <AetherStatus />
    </div>
  );
}
