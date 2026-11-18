import { useEffect, useMemo, useState } from "react";

// Account profile controls (docs/RFC_ACCOUNT_PROFILES.md §10, ADR-0020 Amendment 3), on the Setup view's "Risk profile"
// panel (owner 2026-11-18: not on the monitoring view; no prose; an explicit Update with a confirm). Changing a select
// only edits a draft; Update names the change and applies it after the owner confirms. The server refuses anyone but
// the owner (owner_only) and audits each change; a ceiling below the profile lowers the profile at once.
const LADDER = ["safe", "conservative", "aggressive", "custom"] as const;
const LABEL: Record<string, string> = { safe: "Safe", conservative: "Conservative", aggressive: "Aggressive", custom: "Custom" };
const MODE_LABEL: Record<string, string> = { autonomous: "Autonomous", approval: "Approval" };
const rank = (p: string) => LADDER.indexOf(p as (typeof LADDER)[number]);

type Account = {
  account_ref: string;
  profile: string;
  ceiling: string;
  agent_mode: string;
  pending_upgrade?: { to?: string } | null;
  upgrade_block_until_ms?: number | null;
  pending_downgrade?: { to?: string; reason?: string; at_ms?: number } | null;
  council_veto?: { reason?: string; until_ms?: number } | null;
  council_reviews?: CouncilReview[];
};
type Seat = { verdict?: string; reason?: string } | null;
type CouncilReview = { id: string; kind: string; from: string; to: string; trigger: string; verdict: string; reason?: string; seats?: Record<string, Seat> | null; at_ms: number };
const SEAT_LABEL: Record<string, string> = { risk: "Risk", strategy: "Strategy", trade_management: "Trade mgmt" };
const VERDICT_TONE: Record<string, string> = { approve: "text-emerald-300", reject: "text-rose-300", failed: "text-amber-200", skipped: "text-slate-500" };
const hhmm = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
type Draft = { profile: string; ceiling: string; agent_mode: string };

async function post(body: Record<string, unknown>) {
  const res = await fetch("/omega/api/account-profile", {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/** Pure: the requests that turn `from` into `to`, in an order the server accepts (a profile never above its ceiling). */
export function profileSteps(from: Draft, to: Draft): { action: string; value: string }[] {
  const steps: { action: string; value: string }[] = [];
  const ceilingUp = rank(to.ceiling) > rank(from.ceiling);
  if (ceilingUp && to.ceiling !== from.ceiling) steps.push({ action: "ceiling", value: to.ceiling });
  if (to.profile !== from.profile) steps.push({ action: "profile", value: to.profile });
  if (!ceilingUp && to.ceiling !== from.ceiling) steps.push({ action: "ceiling", value: to.ceiling });
  if (to.agent_mode !== from.agent_mode) steps.push({ action: "agent_mode", value: to.agent_mode });
  return steps;
}

/** Pure: the confirm line, e.g. "Profile Custom → Aggressive, Ceiling Custom → Aggressive". */
export function changeSummary(from: Draft, to: Draft): string {
  const parts: string[] = [];
  if (to.profile !== from.profile) parts.push(`Profile ${LABEL[from.profile] ?? from.profile} → ${LABEL[to.profile] ?? to.profile}`);
  if (to.ceiling !== from.ceiling) parts.push(`Ceiling ${LABEL[from.ceiling] ?? from.ceiling} → ${LABEL[to.ceiling] ?? to.ceiling}`);
  if (to.agent_mode !== from.agent_mode) parts.push(`Agent ${MODE_LABEL[from.agent_mode] ?? from.agent_mode} → ${MODE_LABEL[to.agent_mode] ?? to.agent_mode}`);
  return parts.join(", ");
}

export default function OmegaProfile({ account, onChanged }: { account: Account; onChanged: () => void | Promise<void> }) {
  const saved: Draft = useMemo(() => ({ profile: account.profile, ceiling: account.ceiling, agent_mode: account.agent_mode }), [account.profile, account.ceiling, account.agent_mode]);
  const [draft, setDraft] = useState<Draft>(saved);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);
  // A pushed overview with new saved values resets an untouched draft; an edit in progress is kept.
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setDraft(saved); }, [saved, dirty]);

  const summary = changeSummary(saved, draft);
  const edit = (k: keyof Draft, v: string) => {
    const next = { ...draft, [k]: v };
    // A profile above the ceiling is not offered; lowering the ceiling brings the draft profile down with it.
    if (k === "ceiling" && rank(next.profile) > rank(v)) next.profile = v;
    setDraft(next);
    setDirty(true);
    setConfirming(false);
    setMsg(null);
  };
  const apply = async () => {
    setBusy(true);
    try {
      for (const s of profileSteps(saved, draft)) await post({ account_ref: account.account_ref, ...s });
      setMsg({ tone: "text-emerald-300", text: `Updated: ${summary}.` });
      setDirty(false);
    } catch (e: any) {
      setMsg({ tone: "text-rose-300", text: `Refused: ${e?.message || "failed"}` });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
    await onChanged();
  };
  const proposal = async (action: "accept" | "decline") => {
    setBusy(true);
    try {
      await post({ account_ref: account.account_ref, action });
      setMsg({ tone: "text-emerald-300", text: action === "accept" ? "Proposal accepted." : "Proposal declined." });
    } catch (e: any) {
      setMsg({ tone: "text-rose-300", text: `Refused: ${e?.message || "failed"}` });
    } finally {
      setBusy(false);
    }
    await onChanged();
  };

  const select = "rounded-sm border border-white/10 bg-[#0b1220] px-1.5 py-1 text-[12px] text-slate-200";
  const pending = account.pending_upgrade?.to ? account.pending_upgrade : null;
  const blocked = account.upgrade_block_until_ms && account.upgrade_block_until_ms > Date.now() ? account.upgrade_block_until_ms : null;
  return (
    <div className="space-y-2 text-[12px]" aria-label="Account profile controls">
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5">
        <label className="text-slate-500" htmlFor="omega-profile">Profile</label>
        <select id="omega-profile" className={select} value={draft.profile} disabled={busy} onChange={(e) => edit("profile", e.target.value)}>
          {LADDER.map((p) => <option key={p} value={p} disabled={rank(p) > rank(draft.ceiling)}>{LABEL[p]}</option>)}
        </select>
        <label className="text-slate-500" htmlFor="omega-ceiling" title="The highest profile the agent may move the account to. Only you set it.">Ceiling</label>
        <select id="omega-ceiling" className={select} value={draft.ceiling} disabled={busy} onChange={(e) => edit("ceiling", e.target.value)}>
          {LADDER.map((p) => <option key={p} value={p}>{LABEL[p]}</option>)}
        </select>
        <label className="text-slate-500" htmlFor="omega-agent-mode" title="Autonomous: the agent steps the profile within the ceiling. Approval: its upgrades wait for your click. Downgrades always run.">Agent</label>
        <select id="omega-agent-mode" className={select} value={draft.agent_mode} disabled={busy} onChange={(e) => edit("agent_mode", e.target.value)}>
          <option value="autonomous">Autonomous</option>
          <option value="approval">Approval</option>
        </select>
      </div>
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2 rounded-sm border border-amber-400/30 bg-amber-400/5 px-2 py-1.5" role="alertdialog" aria-label="Confirm the profile change">
          <span className="text-amber-100">{summary}. Confirm?</span>
          <button id="omega-profile-confirm" className="btn border-amber-400/40 bg-amber-400/10 text-amber-100" disabled={busy} onClick={apply}>Confirm</button>
          <button className="btn" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button id="omega-profile-update" className="btn border-emerald-400/30 bg-emerald-400/10 text-emerald-200 disabled:opacity-40" disabled={busy || !summary} onClick={() => setConfirming(true)}>Update</button>
          {dirty && summary ? <button className="btn" disabled={busy} onClick={() => { setDraft(saved); setDirty(false); }}>Reset</button> : null}
          {blocked ? <span className="text-[11px] text-amber-200" title="After the kill switch or the daily loss limit">No auto upgrade before {new Date(blocked).toISOString().slice(11, 16)} UTC</span> : null}
        </div>
      )}
      {pending ? (
        <div className="flex flex-wrap items-center gap-2 rounded-sm border border-cyan-400/20 bg-cyan-400/5 px-2 py-1.5 text-slate-300">
          <span>Agent proposes {LABEL[account.profile] ?? account.profile} → {LABEL[pending.to ?? ""] ?? pending.to}</span>
          <button className="btn border-emerald-400/30 text-emerald-300" disabled={busy} onClick={() => proposal("accept")}>Accept</button>
          <button className="btn" disabled={busy} onClick={() => proposal("decline")}>Decline</button>
        </div>
      ) : null}
      {account.pending_downgrade?.to ? (
        <div className="rounded-sm border border-amber-400/30 bg-amber-400/5 px-2 py-1 text-amber-100">Council reviewing {LABEL[account.profile] ?? account.profile} → {LABEL[account.pending_downgrade.to] ?? account.pending_downgrade.to} ({account.pending_downgrade.reason}) · entries held</div>
      ) : null}
      {account.council_veto?.until_ms && account.council_veto.until_ms > Date.now() ? (
        <div className="text-[11px] text-amber-200">Council veto ({account.council_veto.reason}) until {new Date(account.council_veto.until_ms).toISOString().slice(11, 16)} UTC</div>
      ) : null}
      {account.council_reviews?.length ? (
        <div className="space-y-0.5" aria-label="Profile council reviews">
          <div className="text-slate-500">Council</div>
          {account.council_reviews.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-2 text-[11.5px]" title={r.reason ?? ""}>
              <span className="tabular-nums text-slate-500">{hhmm(r.at_ms)}</span>
              <span className="text-slate-300">{LABEL[r.from] ?? r.from} → {LABEL[r.to] ?? r.to}</span>
              <span className={VERDICT_TONE[r.verdict] ?? "text-slate-300"}>{r.kind === "downgrade" && r.verdict === "reject" ? "veto" : r.verdict}</span>
              {Object.entries(r.seats ?? {}).map(([k, v]) => (
                <span key={k} className={v?.verdict === "approve" ? "text-emerald-300/80" : v?.verdict === "reject" ? "text-rose-300/80" : "text-slate-500"} title={v?.reason ?? "no answer"}>{SEAT_LABEL[k] ?? k} {v?.verdict === "approve" ? "✓" : v?.verdict === "reject" ? "✗" : "–"}</span>
              ))}
            </div>
          ))}
        </div>
      ) : null}
      {msg ? <p className={`text-[11.5px] ${msg.tone}`}>{msg.text}</p> : null}
    </div>
  );
}
