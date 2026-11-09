import { useState } from "react";
import { BookOpenCheck, Brain, Cpu, Database, ScrollText, ShieldAlert, Sparkles, Scale } from "lucide-react";
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

function Canon({ c }: { c: any }) {
  return (
    <Panel title="Canon · doctrine" icon={<ScrollText className="h-3.5 w-3.5" />} right={<Badge tone="cyan">v{c?.version} · {short(c?.content_sha256)}</Badge>}>
      <p className="mb-2 text-[12px] text-slate-400">{c?.files ?? 0} canon files · KB {c?.kb_version ?? "n/a"} ({short(c?.kb_content_sha256)}). The canon changes only by a reviewed PR.</p>
      <ol className="space-y-1.5 text-[12px]">
        {(c?.doctrine || []).map((r: any) => (
          <li key={r.id} className="glass-inner p-2">
            <span className="mono text-cyan-300">{r.id}</span>{r.since && <span className="ml-2 text-[10px] text-slate-500">since {r.since}</span>}
            {r.status && <span className="ml-2"><Badge tone="slate">{r.status}</Badge></span>}
            <p className="mt-0.5 leading-relaxed text-slate-300">{r.rule}</p>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

export default function Aether() {
  const { data, error, loading } = usePoll(() => get("/api/aether/overview"), 120_000);
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
      <Weighting reports={o.weighting || []} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Guardian g={o.guardian} />
        <Knowledge k={o.knowledge} />
      </div>
      <Canon c={o.canon} />
    </div>
  );
}
