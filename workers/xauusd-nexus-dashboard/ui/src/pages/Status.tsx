import { useState } from "react";
import { Activity, Database, Gauge, Newspaper, ShieldCheck } from "lucide-react";
import PriorityQueue from "../components/PriorityQueue";
import { Badge, Dot, Empty, Panel, PollError, Skeleton, phaseOf } from "../components/ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSystemHealth, marketClosed } from "../lib/health";
import { overviewBadge } from "../lib/healthBadge";
import { ago, candleWhen } from "../lib/format";
import { WORKERS, engineTitle } from "../lib/names";

// Parity in the status tones: a match ok, a mismatch (or a revoked engine) a fault, an input mismatch or an engine still
// earning its streak late.
const resultTone = (r?: string | null) => (r === "match" ? "text-ok" : r === "mismatch" ? "text-fault" : r === "input_mismatch" ? "text-late" : "text-slate-400");
const statusTone = (s?: string) => (s === "approved" ? "text-ok" : s === "revoked" ? "text-fault" : "text-late");
const when = (iso?: string | null) => (iso ? `${String(iso).slice(5, 16).replace("T", " ")} UTC` : "—");

/** The rows that come from /api/status (the others from /api/local-lane). */
const STATUS_ROWS = new Set(["ai", "news", "oauth", "lane", "calibration"]);

/**
 * Review of #520: two reads, each with its own state. A failed /api/status is its error box above the lane's rows
 * (they no longer vanish), old rows after failed reads are dimmed under the stale tag, and the badge never says
 * nominal while either read failed or is stale (lib/healthBadge.ts).
 */
function Overview() {
  const { items, poll, lanePoll } = useSystemHealth();
  const statusPhase = phaseOf(poll), lanePhase = phaseOf(lanePoll);
  const bad = items.filter((i) => i.tone === "fault").length, warn = items.filter((i) => i.tone === "late").length;
  const badge = overviewBadge({ bad, warn, status: statusPhase, lane: lanePhase });
  const old = (key: string) => (STATUS_ROWS.has(key) ? statusPhase === "stale" : lanePhase === "stale");
  return (
    <Panel title="Workers and lanes" icon={<Activity className="h-3.5 w-3.5 text-cyan-300" />} hint={marketClosed() ? "Market closed (Fri 17:30 – Sun 18:00 New York): grey lanes are idle." : undefined}
      poll={poll} live right={<Badge tone={badge.tone}>{badge.text}</Badge>}>
      {statusPhase === "error" ? <div className="mb-2"><PollError poll={poll} /></div> : null}
      {lanePhase === "error" ? <div className="mb-2"><PollError poll={lanePoll} /></div> : null}
      {!items.length ? (statusPhase === "loading" || lanePhase === "loading" ? <Skeleton rows={3} /> : null) : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {items.map((i) => (
            <div key={i.key} className={`glass-inner px-3 py-2 ${old(i.key) ? "opacity-60" : ""}`} title={old(i.key) ? "Stale: from the last good read" : undefined}>
              <div className="flex items-center gap-2 text-[12px] text-slate-100"><Dot tone={i.tone} pulse={i.tone === "fault" || i.tone === "late"} />{i.label}</div>
              {i.worker ? <div className="mono text-[10px] text-slate-500">{i.worker}</div> : null}
              <div className="mt-0.5 text-[11px] text-slate-400">{i.detail}</div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function PullAdapter() {
  const { lane, lanePoll } = useSystemHealth();
  if (!lane) return null;
  const used = Number(lane.budget?.used) || 0, dailyRaw = Number(lane.budget?.daily);
  const daily = Number.isFinite(dailyRaw) && dailyRaw > 0 ? dailyRaw : null;
  return (
    <Panel title={`Pull adapter · ${WORKERS.pull.name}`} icon={<Database className="h-3.5 w-3.5 text-cyan-300" />} poll={lanePoll} right={<Badge tone={daily != null && used >= 0.9 * daily ? "late" : "ok"}>{daily != null ? `${used}/${daily} calls today` : `${used} calls today`}</Badge>}>
      <div className="mb-2 h-1.5 overflow-hidden rounded-sm bg-white/5"><div className="h-full bg-cyan-400/60" style={{ width: daily != null ? `${Math.min(100, (used / daily) * 100)}%` : "0%" }} /></div>
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

const CALLER: Record<string, string> = { pull_adapter: "Pull adapter (chart)", news_cron: "News, scheduled", news_ai_worker: "News, AI Worker", news_http: "News, HTTP", calendar: "Calendar", gold_history: "Gold history", other: "Other" };

/**
 * The TradingView quota (owner 2026-11-14): the account refuses the 501st call of the UTC day; on
 * 2026-11-12 and 11-13 it ran out at about 20:00 UTC and the gold chart stood still. Measured counts from
 * the gateway (news worker /health via /api/status), per caller and UTC hour, and whether a news pull
 * is held back for the chart right now.
 */
function TvQuota() {
  const { status, poll } = useSystemHealth();
  const ing = status?.ingestion_worker ?? null;
  const today = ing?.provider_calls?.today ?? null, yesterday = ing?.provider_calls?.yesterday ?? null;
  if (!ing || !today) return null;
  const limit = Number(ing.provider_daily_limit) > 0 ? Number(ing.provider_daily_limit) : null;
  const used = Number(today.total) || 0;
  const reserve = ing.chart_reserve ?? null;
  const share = limit ? used / limit : null;
  const tone = ing.provider_cooldown_until ? "fault" : share != null && share >= 0.9 ? "late" : "ok";
  const hours: number[] = Array.isArray(today.by_hour) ? today.by_hour.map((n: any) => Number(n) || 0) : [];
  const peak = Math.max(1, ...hours);
  const nowHour = new Date().getUTCHours();
  const callers = [...new Set([...Object.keys(today.by_caller ?? {}), ...Object.keys(yesterday?.by_caller ?? {})])];
  const calls = (day: any, k: string) => (day?.by_caller?.[k] ? Number(day.by_caller[k].calls ?? day.by_caller[k]) || 0 : null);
  return (
    <Panel title="TradingView quota" icon={<Gauge className="h-3.5 w-3.5 text-cyan-300" />} poll={poll} hint="Calls this system made to TradingView today (UTC), from the gateway's own count. Calls from outside this system on the same account are not counted." right={<Badge tone={tone}>{limit ? `${used} / ${limit}` : `${used} calls`}</Badge>}>
      <div className="mb-2 h-1.5 overflow-hidden rounded-sm bg-white/5"><div className={`h-full ${tone === "fault" ? "bg-fault-fill/70" : tone === "late" ? "bg-late-fill/70" : "bg-ok-fill/60"}`} style={{ width: share != null ? `${Math.min(100, share * 100)}%` : "0%" }} /></div>
      <p className="mb-2 text-[11.5px] text-slate-400">
        {ing.provider_cooldown_until ? <><b className="text-fault">Paused until {when(ing.provider_cooldown_until)}</b> ({ing.provider_cooldown_reason ?? "provider"}) · </> : null}
        {today.quota_exceeded_at ? <>quota ran out {when(today.quota_exceeded_at)} · </> : null}
        {reserve ? <>chart needs about <b className="text-slate-200">{reserve.chart_need}</b> more today ({reserve.chart_per_hour} an hour){reserve.enabled === false ? " · news reserve off" : reserve.blocked ? <> · <b className="text-late">news held back for the chart</b></> : " · news runs"}</> : "—"}
        {yesterday?.total ? <> · yesterday <b className="text-slate-200">{yesterday.total}</b>{yesterday.quota_exceeded_at ? `, ran out ${when(yesterday.quota_exceeded_at)}` : ""}</> : null}
      </p>
      <div className="mb-3 flex h-10 items-end gap-[2px]" aria-label="Calls per UTC hour today">
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="flex-1" title={`${String(h).padStart(2, "0")}:00 UTC · ${hours[h] ?? 0} calls`}>
            <div className={`w-full rounded-xs ${h === nowHour ? "bg-cyan-300/80" : h < nowHour ? "bg-cyan-400/40" : "bg-white/5"}`} style={{ height: `${Math.max(2, ((hours[h] ?? 0) / peak) * 40)}px` }} />
          </div>
        ))}
      </div>
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Caller</th><th>Today</th><th>Yesterday</th></tr></thead>
          <tbody>
            {callers.map((k) => (
              <tr key={k}><td>{CALLER[k] ?? k}</td><td className="mono">{calls(today, k) ?? "—"}</td><td className="mono">{calls(yesterday, k) ?? "—"}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/**
 * News without TradingView, in shadow (owner 2026-11-14; docs/RFC_CONTENT_AGENT.md P0): every hour the
 * publishers' RSS feeds and GDELT beside TradingView's news. Nothing reads them yet; this shows whether they
 * work, how much they bring and how they compare. Measured values only (news worker /health via /api/status).
 */
function NewsShadow() {
  const { status, poll } = useSystemHealth();
  const shadow = status?.ingestion_worker?.news_shadow ?? null;
  const last = shadow?.last ?? null, today = shadow?.today ?? null;
  if (!last) return null;
  const sources = Object.entries(last.sources ?? {}) as [string, any][];
  const ok = sources.filter(([, s]) => s.ok).length;
  return (
    <Panel title="News sources (shadow)" icon={<Newspaper className="h-3.5 w-3.5 text-cyan-300" />} poll={poll} hint="Publisher RSS feeds and GDELT, read every hour beside TradingView's news and compared with it. Nothing reads them yet." right={<Badge tone={ok === sources.length ? "ok" : ok ? "late" : "fault"}>{ok} / {sources.length} working</Badge>}>
      <p className="mb-2 text-[11.5px] text-slate-400">
        Last hour ({when(last.at)}): <b className="text-slate-200">{last.shadow_recent}</b> headlines here, <b className="text-slate-200">{last.tv_recent}</b> on TradingView, <b className="text-slate-200">{last.overlap}</b> the same story
        {last.lead_minutes != null ? <> · {last.lead_minutes >= 0 ? `${last.lead_minutes} min earlier here` : `${-last.lead_minutes} min later here`}</> : null}
        {today ? <> · today {today.runs} runs: {today.shadow_recent} here, {today.tv_recent} on TradingView, {today.overlap} shared</> : null}
      </p>
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Source</th><th>Status</th><th>Items</th><th>About gold, oil or the dollar</th><th>Last hour</th><th>Today ok / failed / skipped</th></tr></thead>
          <tbody>
            {sources.map(([id, s]) => (
              <tr key={id}>
                <td className="mono">{id}</td>
                <td className={s.ok ? "text-ok" : s.skipped ? "text-late" : "text-fault"} title={s.consecutive_failures ? `${s.consecutive_failures} runs failed in a row` : undefined}>{s.ok ? "ok" : s.skipped === "backoff" ? "backing off (asked every 6th hour)" : s.error === "rate_limited" ? "rate limited (HTTP 429)" : s.error ?? (s.status ? `HTTP ${s.status}` : "failed")}</td>
                <td className="mono">{s.items}</td><td className="mono">{s.relevant}</td><td className="mono">{s.last_hour}</td>
                <td className="mono">{today?.sources?.[id] ? `${today.sources[id].ok_runs} / ${today.sources[id].failed_runs} / ${today.sources[id].skipped_runs ?? 0}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Parity() {
  const poll = usePoll(() => get("/api/parity"), 60_000);
  const { data } = poll;
  const phase = phaseOf(poll);
  const { status } = useSystemHealth();
  const [older, setOlder] = useState(false);
  const p = (data as any)?.parity;
  const cal = status?.ai_worker?.local_lane?.calibration;
  if (phase === "error") return <Panel><PollError poll={poll} /></Panel>;
  if (phase === "loading") return <Panel><Skeleton rows={5} /></Panel>;
  if (!p) return <Panel><Empty>No parity data yet.</Empty></Panel>;
  const rows: any[] = (p.registry ?? []).filter((r: any) => older || r.current);
  return (
    <>
      <Panel title="Parity registry" icon={<ShieldCheck className="h-3.5 w-3.5 text-cyan-300" />} poll={poll} live hint={`Local engines vs the TradingView alert per candle. Recorded until the TradingView alerts were retired (S3); no new comparisons. Approved after ${p.policy?.promote_after ?? 24} matches in a row; a mismatch revokes.`}
        right={<span className="flex gap-1">{cal?.due ? <Badge tone="late">calibration due</Badge> : null}<Badge tone="ok">{(p.registry ?? []).filter((r: any) => r.current && r.status === "approved").length} approved</Badge></span>}>
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
      <TvQuota />
      <NewsShadow />
      <Parity />
    </div>
  );
}
