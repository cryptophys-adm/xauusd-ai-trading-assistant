import { useState } from "react";
import { BookOpenCheck } from "lucide-react";
import { Badge, Empty, Panel, PollError, Skeleton, phaseOf } from "../components/ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { stanceColor } from "../components/Stance";

const CHARTS: [string, string][] = [["15", "M15"], ["60", "H1"], ["240", "H4"], ["1D", "D1"]];
const pc = (x?: number | null) => (x == null ? "" : `${Math.round(x * 100)}%`);
const when = (t?: string | null) => (t ? `${t.slice(5, 16).replace("T", " ")} UTC` : "");
// Direction: green bullish, red bearish, amber neutral (WAIT, HOLD, NEUTRAL); no stance in the text colour.
const stanceTone = (s?: string | null) => (!s ? "text-fg" : stanceColor(s));
// A scored call: hit ok, miss fault, open plain.
const resultTone = (r?: string) => (r === "hit" ? "text-ok" : r === "miss" || r === "missed_opportunity" ? "text-fault" : "text-fg-2");

function Card({ c }: { c: any }) {
  const outcomes = Object.entries(c.outcomes ?? {}) as [string, any][];
  return (
    <Panel title={`${when(c.bar_open)} · ${c.session ?? ""}`} right={<span className="flex gap-1">{c.conclusion?.reconvened ? <Badge tone="shadow">reconvened</Badge> : null}{c.compliance?.length ? <Badge tone="late">{c.compliance.length} rule break{c.compliance.length > 1 ? "s" : ""}</Badge> : <Badge tone="ok">clean</Badge>}</span>}>
      <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
        <span>Conclusion: <b className={stanceTone(c.conclusion?.stance)}>{c.conclusion?.stance ?? "none"}</b>{c.conclusion?.bias ? <> · bias <b className={stanceTone(c.conclusion.bias)}>{c.conclusion.bias}</b></> : null} {pc(c.conclusion?.confidence)}</span>
        {c.crowd ? <span>Crowd: <b className={stanceTone(c.crowd.weighted_bias)}>{c.crowd.weighted_bias ?? "n/a"}</b>, disagreement {c.crowd.disagreement ?? "n/a"}</span> : null}
        {c.h1 ? <span>H1 decision: <b className={stanceTone(c.h1.decision)}>{c.h1.decision ?? "n/a"}</b> {pc(c.h1.confidence)}</span> : null}
        {c.stuck_open?.length ? <span className="text-late">Stuck: {c.stuck_open.map((s: any) => `${s.field} ${s.candles}`).join(", ")}</span> : null}
      </div>
      {c.conclusion?.summary ? <p className="mb-2 text-[12px] leading-relaxed text-slate-300">{c.conclusion.summary}</p> : null}
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Agent</th><th>Stance</th><th>Bias</th><th>Confidence</th><th>Claim</th><th>Outcome</th></tr></thead>
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
        <ul className="mt-2 list-disc pl-5 text-[11px] text-late">
          {c.compliance.map((x: any, i: number) => <li key={i}><span className="mono">{x.agent}</span> · {x.check}{x.detail ? `: ${x.detail}` : ""}</li>)}
        </ul>
      ) : null}
      {outcomes.some(([k]) => k === "chain:h1") ? <p className="mt-2 text-[11px] text-slate-400">H1 chain: <span className={resultTone(c.outcomes["chain:h1"].result)}>{c.outcomes["chain:h1"].result}</span></p> : null}
    </Panel>
  );
}

function ComplianceTable() {
  const { data } = usePoll(() => get("/api/compliance?days=7"), 300_000);
  const v = (data as any)?.compliance;
  if (!v) return null;
  const rows: any[] = (v.agents ?? []).filter((a: any) => a.violations > 0);
  return (
    <Panel title="Rule breaks, 7d" hint={(v.checks ?? []).length ? `Checks: ${(v.checks ?? []).join(", ")}` : undefined} right={<span className="flex gap-1"><Badge tone="plain">{v.total?.violations ?? 0} / {v.total?.messages ?? 0} msgs</Badge><Badge tone={v.total?.violations ? "late" : "ok"}>{v.total?.rate_per_100 ?? 0} per 100</Badge></span>}>
      {!rows.length ? <Empty>No rule breaks.</Empty> : (
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
    <Panel title="Aether sync" right={<Badge tone={a.binding === "present" ? "ok" : "off"}>{a.binding === "present" ? "connected" : "not connected"}</Badge>}>
      <p className="mb-2 text-[12px] text-slate-400">24h: {Object.entries(a.last_24h ?? {}).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}{a.learned_pack?.status ? ` · Learned pack: ${a.learned_pack.status}` : ""}</p>
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
  const poll = usePoll(() => get(`/api/decision-cards?chart=${chart}&limit=8`), 300_000, [chart]);
  const { data } = poll;
  const phase = phaseOf(poll);
  const cards: any[] = (data as any)?.cards ?? [];
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      <Panel title="Decision audit" icon={<BookOpenCheck className="h-3.5 w-3.5 text-cyan-300" />} poll={poll} live hint="Each room conclusion with agent stances, rule breaks and scored outcomes.">
        <div className="flex flex-wrap gap-2">
          {CHARTS.map(([k, label]) => (
            <button key={k} onClick={() => setChart(k)} className={`rounded-sm border px-2 py-1 text-[12px] ${chart === k ? "border-white/30 bg-white/8 text-fg" : "border-white/10 text-fg-2 hover:text-fg"}`}>{label}</button>
          ))}
        </div>
      </Panel>
      {phase === "error" ? <Panel><PollError poll={poll} /></Panel> : phase === "loading" ? <Panel><Skeleton rows={6} /></Panel>
        : !cards.length ? <Panel><Empty>No decisions yet.</Empty></Panel> : cards.map((c) => <Card key={c.card_id} c={c} />)}
      <ComplianceTable />
      <AetherStatus />
    </div>
  );
}
