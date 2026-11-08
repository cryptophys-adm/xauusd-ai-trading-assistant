import { useState } from "react";
import { Activity, Database, ShieldCheck } from "lucide-react";
import PriorityQueue from "../components/PriorityQueue";
import { Badge, Dot, Empty, Panel, Skeleton } from "../components/ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSystemHealth, marketClosed } from "../lib/health";
import { ago, candleWhen } from "../lib/format";
import { WORKERS, engineTitle } from "../lib/names";

const resultTone = (r?: string | null) => (r === "match" ? "text-emerald-300" : r === "mismatch" ? "text-rose-300" : r === "input_mismatch" ? "text-amber-200" : "text-slate-400");
const statusTone = (s?: string) => (s === "approved" ? "text-emerald-300" : s === "revoked" ? "text-rose-300" : "text-amber-200");
const when = (iso?: string | null) => (iso ? `${String(iso).slice(5, 16).replace("T", " ")} UTC` : "—");

function Overview() {
  const { items, loading, error } = useSystemHealth();
  const bad = items.filter((i) => i.tone === "red").length, warn = items.filter((i) => i.tone === "amber").length;
  return (
    <Panel title="Workers and lanes" icon={<Activity className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone={bad ? "red" : warn ? "amber" : "green"}>{bad ? `${bad} down` : warn ? `${warn} need attention` : "all nominal"}</Badge>}>
      {loading ? <Skeleton rows={3} /> : error && !items.length ? <p className="text-[12px] text-rose-300">Status unavailable: {error}</p> : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {items.map((i) => (
            <div key={i.key} className="glass-inner px-3 py-2">
              <div className="flex items-center gap-2 text-[12px] text-slate-100"><Dot tone={i.tone} pulse={i.tone === "red" || i.tone === "amber"} />{i.label}</div>
              {i.worker ? <div className="mono text-[10px] text-slate-500">{i.worker}</div> : null}
              <div className="mt-0.5 text-[11px] text-slate-400">{i.detail}</div>
            </div>
          ))}
        </div>
      )}
      {marketClosed() ? <p className="mt-2 text-[11px] text-slate-500">The market is closed (Friday 17:30 to Sunday 18:00 New York): grey lanes are expected to be idle.</p> : null}
    </Panel>
  );
}

function PullAdapter() {
  const { lane } = useSystemHealth();
  if (!lane) return null;
  const used = Number(lane.budget?.used) || 0, daily = Number(lane.budget?.daily) || 800;
  return (
    <Panel title={`Pull adapter · ${WORKERS.pull.name}`} icon={<Database className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone={used >= 0.9 * daily ? "amber" : "cyan"}>{used}/{daily} calls today</Badge>}>
      <div className="mb-2 h-1.5 overflow-hidden rounded bg-white/5"><div className="h-full bg-cyan-400/60" style={{ width: `${Math.min(100, (used / daily) * 100)}%` }} /></div>
      <p className="mb-2 text-[11.5px] text-slate-400">
        Last refresh: <b className="text-slate-200">{lane.last_refresh?.status ?? "none"}</b> {ago(lane.last_refresh?.checked_at)}
        {lane.last_publish?.status ? <> · last H1 publish: <b className="text-slate-200">{lane.last_publish.status}</b> {ago(lane.last_publish.published_at)}</> : null}
        {lane.derived_check?.status ? <> · derived check: <b className="text-slate-200">{lane.derived_check.status}</b> ({lane.derived_check.date})</> : null}
      </p>
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Series</th><th>Role</th><th>Pull</th><th>Last close</th><th>Bars</th></tr></thead>
          <tbody>
            {(lane.series ?? []).map((s: any) => (
              <tr key={s.series}>
                <td className="mono">{s.series}</td><td className="text-slate-400">{s.role}</td>
                <td className="text-slate-400">{s.derived_from ? `built from ${s.derived_from}` : s.cadence_seconds ? `every ${s.cadence_seconds / 60} min` : "each new bar"}</td>
                <td className="mono">{when(s.latest_close_time)} <span className="text-slate-500">{ago(s.latest_close_time)}</span></td>
                <td className="mono">{s.candle_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Parity() {
  const { data, loading, error } = usePoll(() => get("/api/parity"), 60_000);
  const { status } = useSystemHealth();
  const [older, setOlder] = useState(false);
  const p = (data as any)?.parity;
  const cal = status?.ai_worker?.local_lane?.calibration;
  if (loading && !data) return <Panel><Skeleton rows={5} /></Panel>;
  if (error && !data) return <Panel><p className="text-[12px] text-rose-300">Parity unavailable: {error}</p></Panel>;
  if (!p) return <Panel><Empty>No parity data yet.</Empty></Panel>;
  const rows: any[] = (p.registry ?? []).filter((r: any) => older || r.current);
  return (
    <>
      <Panel title="Parity registry" icon={<ShieldCheck className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="cyan">{(p.registry ?? []).filter((r: any) => r.current && r.status === "approved").length} approved</Badge>}>
        <p className="mb-2 text-[11.5px] text-slate-400">Each local engine of the pull adapter (MizanLib, Prophet R38 + R37, GMI v12.70 and the HUD comparators) is compared with the TradingView alert of the same candle. An identity is approved after {p.policy?.promote_after ?? 24} matching candles in a row; any indicator mismatch revokes it; an incomplete comparison neither advances nor resets the streak.{cal?.due ? " One approved engine is due for calibration." : ""}</p>
        <label className="mb-2 inline-flex cursor-pointer items-center gap-2 text-[11.5px] text-slate-300"><input type="checkbox" checked={older} onChange={(e) => setOlder(e.target.checked)} /> Show older identities</label>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Engine</th><th>Status</th><th>Streak</th><th>Matches</th><th>Mismatches</th><th>Incomplete</th><th>Last 24 h</th><th>Last result</th><th>Implementation</th></tr></thead>
            <tbody>
              {rows.map((r: any) => {
                const d = p.last_24h?.[r.engine] ?? {};
                return (
                  <tr key={r.engine + r.implementation} className={r.current ? "" : "opacity-50"}>
                    <td>{engineTitle(r.engine)} <span className="mono text-[10px] text-slate-500">{r.engine}</span></td>
                    <td><span className={statusTone(r.status)}>{r.status}</span></td>
                    <td className="mono">{r.consecutive_matches}/{r.promote_after}</td>
                    <td className="mono">{r.totals.matches}</td><td className="mono">{r.totals.mismatches}</td><td className="mono">{r.totals.incomplete}</td>
                    <td className="mono text-[11px]">{Object.entries(d).map(([k, n]) => `${k} ${n}`).join(", ") || "—"}</td>
                    <td><span className={resultTone(r.last_result)}>{r.last_result ?? "—"}</span> <span className="text-[11px] text-slate-500">{r.last_candle_key ? candleWhen(r.last_candle_key) : ""}</span></td>
                    <td className="mono text-slate-500">{r.implementation}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Recent comparisons">
        {!(p.recent ?? []).length ? <Empty>No comparison yet.</Empty> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>When</th><th>Engine</th><th>Candle</th><th>Result</th><th>Fields</th></tr></thead>
              <tbody>
                {p.recent.map((c: any, i: number) => (
                  <tr key={i}>
                    <td className="mono">{when(c.compared_at)}</td><td>{engineTitle(c.engine)} <span className="mono text-[10px] text-slate-500">{c.engine}</span></td>
                    <td className="mono text-[11px]">{candleWhen(c.candle_key)}</td><td><span className={resultTone(c.result)}>{c.result}</span></td>
                    <td className="text-[11px] text-slate-400">{(c.mismatches ?? []).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

/** System status (owner request 2026-11-08): the Worker status, the pull adapter and the parity checks in detail. */
export default function Status() {
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      <Overview />
      <PriorityQueue />
      <PullAdapter />
      <Parity />
    </div>
  );
}
