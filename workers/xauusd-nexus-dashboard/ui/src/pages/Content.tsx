import { useCallback, useEffect, useState } from "react";
import { Megaphone } from "lucide-react";
import { Badge, Empty, Panel } from "../components/ui";

// The content queue (owner 2026-11-14: "persiapan engine post ke Instagram/threads"): the drafts the content
// engine (xauusd-content) made from the public projection, each checked by the content guardian, waiting for a
// person. Read and decided through Omega's API (Cloudflare Access; a person, same origin; a rejection needs a
// reason). Publishing stays off until the owner turns it on in the content Worker: an approved draft waits.

type Guardian = { pass?: boolean; failures?: { check: string; detail: string }[] };
type Draft = { id: string; kind: string; channel: string; text: string; status: string; created_at: string; decided_by?: string | null; decision_reason?: string | null; guardian?: Guardian; remote_id?: string | null; error?: string | null };
type Queue = {
  drafts?: Draft[];
  counts?: Record<string, number>;
  status?: { publish?: string; channels?: string[]; delay_hours?: number; accounts?: Record<string, { configured?: boolean; quota?: { used: number; total: number | null } | null }> };
  can_control?: boolean;
};

async function call(path: string, method = "GET", body?: unknown) {
  const res = await fetch(path, {
    method, credentials: "same-origin",
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

const TONE: Record<string, "green" | "amber" | "red" | "cyan" | "slate" | "purple"> = { pending: "cyan", needs_image: "slate", blocked: "red", approved: "amber", rejected: "slate", published: "green", failed: "red" };
const LABEL: Record<string, string> = { pending: "waits for you", needs_image: "needs an image", blocked: "blocked by the guardian", approved: "approved", rejected: "rejected", published: "published", failed: "publishing failed" };
const when = (iso?: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "—");

function DraftCard({ d, canControl, publishOn, onDone }: { d: Draft; canControl: boolean; publishOn: boolean; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const decide = async (decision: "approve" | "reject") => {
    if (decision === "reject" && !reason.trim()) { setError("a reason is required to reject"); return; }
    setBusy(true);
    try { await call("/omega/api/content/decide", "POST", { id: d.id, decision, reason: reason.trim() }); setError(null); onDone(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const showPreview = async () => {
    try { setPreview(JSON.stringify(await call(`/omega/api/content/preview?id=${encodeURIComponent(d.id)}`), null, 2)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="glass p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
        <Badge tone={d.channel === "threads" ? "purple" : "cyan"}>{d.channel}</Badge>
        <Badge tone={TONE[d.status] ?? "slate"}>{LABEL[d.status] ?? d.status}</Badge>
        <span className="mono text-slate-500">{d.id}</span>
        <span className="text-slate-500">drafted {when(d.created_at)}</span>
      </div>
      <pre className="whitespace-pre-wrap rounded bg-slate-900/60 p-2 text-[12px] text-slate-200">{d.text}</pre>
      <div className="mt-2 text-[11px] text-slate-400">
        Guardian: {d.guardian?.pass ? <span className="text-emerald-300">all checks pass</span> : <span className="text-rose-300">{(d.guardian?.failures ?? []).map((f) => `${f.check} (${f.detail})`).join(", ") || "not checked"}</span>}
        {d.decided_by ? <> · decided by <span className="mono">{d.decided_by}</span>{d.decision_reason ? ` (${d.decision_reason})` : ""}</> : null}
        {d.remote_id ? <> · post id <span className="mono">{d.remote_id}</span></> : null}
        {d.error ? <> · <span className="text-rose-300">{d.error}</span></> : null}
      </div>
      {d.status === "pending" && canControl ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason (required to reject)" className="min-w-[220px] flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[12px]" />
          <button disabled={busy} onClick={() => decide("approve")} className="rounded bg-emerald-500/20 px-3 py-1 text-[12px] text-emerald-200 hover:bg-emerald-500/30">{publishOn ? "Approve and publish" : "Approve (publishing is off)"}</button>
          <button disabled={busy} onClick={() => decide("reject")} className="rounded bg-rose-500/20 px-3 py-1 text-[12px] text-rose-200 hover:bg-rose-500/30">Reject</button>
          <button onClick={showPreview} className="rounded px-2 py-1 text-[12px] text-slate-400 hover:text-slate-200">Dry run</button>
        </div>
      ) : null}
      {error ? <div className="mt-1 text-[11px] text-rose-300">{error}</div> : null}
      {preview ? <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-950 p-2 text-[10.5px] text-slate-400">{preview}</pre> : null}
    </div>
  );
}

export default function Content() {
  const [q, setQ] = useState<Queue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("");
  const load = useCallback(async () => {
    try { setQ(await call(`/omega/api/content${filter ? `?status=${filter}` : ""}`)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [filter]);
  useEffect(() => { load(); const t = setInterval(load, 120_000); return () => clearInterval(t); }, [load]);
  const publishOn = q?.status?.publish === "on";
  const filters = ["", "pending", "needs_image", "blocked", "approved", "published", "rejected", "failed"];
  return (
    <div className="space-y-4">
      <Panel title="Content queue" icon={<Megaphone className="h-3.5 w-3.5 text-cyan-300" />}
        hint="Recaps of past decisions for Threads and Instagram, drafted Tuesday to Saturday from the public projection (decisions older than 24 hours, no price level, plan or account data), in fixed templates, each checked by the content guardian. Every draft waits for you; an approval runs the guardian again. Education only, with the disclaimer; never a live instruction."
        right={<Badge tone={publishOn ? "green" : "amber"}>publishing {publishOn ? "on" : "off"}</Badge>}>
        {error ? <div className="text-[12px] text-rose-300">{error}</div> : null}
        <div className="mb-3 flex flex-wrap gap-3 text-[11.5px] text-slate-400">
          {Object.entries(q?.status?.accounts ?? {}).map(([c, a]) => (
            <span key={c}>{c}: {a.configured ? <span className="text-emerald-300">account connected</span> : <span className="text-amber-300">no account yet</span>}{a.quota ? ` · ${a.quota.used}/${a.quota.total ?? "?"} posts today` : ""}</span>
          ))}
          {!publishOn ? <span>Approved drafts wait: publishing is turned on by an owner PR, after the legal check.</span> : null}
        </div>
        <div className="mb-3 flex flex-wrap gap-1">
          {filters.map((f) => <button key={f || "all"} onClick={() => setFilter(f)} className={`rounded px-2 py-0.5 text-[11px] ${f === filter ? "bg-cyan-500/20 text-cyan-200" : "text-slate-400 hover:text-slate-200"}`}>{f ? `${LABEL[f]} (${q?.counts?.[f] ?? 0})` : "all"}</button>)}
        </div>
        {!(q?.drafts ?? []).length ? <Empty>No draft yet: the first recap is drafted on the next Tuesday-to-Saturday run (22:17 UTC).</Empty> : (
          <div className="space-y-3">{q!.drafts!.map((d) => <DraftCard key={d.id} d={d} canControl={Boolean(q?.can_control)} publishOn={publishOn} onDone={load} />)}</div>
        )}
      </Panel>
    </div>
  );
}
