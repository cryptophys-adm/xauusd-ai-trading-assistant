import { useState } from "react";

// Account profile controls (docs/RFC_ACCOUNT_PROFILES.md §10, ADR-0020 Amendment 3): the owner sets the ceiling, the
// profile and the agent mode, and accepts or declines the agent's upgrade proposal. The server refuses anyone else
// (owner_only); a ceiling below the current profile lowers the profile at once.
const LADDER = ["safe", "conservative", "aggressive", "custom"] as const;
const LABEL: Record<string, string> = { safe: "Safe", conservative: "Conservative", aggressive: "Aggressive", custom: "Custom" };

type Account = {
  account_ref: string;
  profile: string;
  ceiling: string;
  agent_mode: string;
  pending_upgrade?: { to?: string; evidence?: Record<string, unknown> } | null;
  upgrade_block_until_ms?: number | null;
  last_upgrade_ms?: number | null;
};

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

export default function OmegaProfile({ account, onChanged }: { account: Account; onChanged: () => void | Promise<void> }) {
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (action: string, value: string | null = null) => {
    setBusy(true);
    try {
      await post({ account_ref: account.account_ref, action, value });
      setMsg({ tone: "text-emerald-300", text: "Saved." });
    } catch (e: any) {
      setMsg({ tone: "text-rose-300", text: `Refused: ${e?.message || "failed"}` });
    } finally {
      setBusy(false);
    }
    await onChanged();
  };
  const ceilingRank = LADDER.indexOf(account.ceiling as (typeof LADDER)[number]);
  const pending = account.pending_upgrade?.to ? account.pending_upgrade : null;
  const blocked = account.upgrade_block_until_ms && account.upgrade_block_until_ms > Date.now() ? account.upgrade_block_until_ms : null;
  const select = "rounded-sm border border-white/10 bg-[#0b1220] px-1.5 py-0.5 text-[11px] text-slate-200";
  return (
    <div className="mt-2 space-y-1.5 text-[11px]" aria-label="Account profile controls">
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
        <label className="text-slate-500" htmlFor="omega-profile">Profile</label>
        <select id="omega-profile" className={select} value={account.profile} disabled={busy} onChange={(e) => act("profile", e.target.value)}>
          {LADDER.map((p, i) => <option key={p} value={p} disabled={i > ceilingRank}>{LABEL[p]}{i > ceilingRank ? " (above ceiling)" : ""}</option>)}
        </select>
        <label className="text-slate-500" htmlFor="omega-ceiling">Ceiling</label>
        <select id="omega-ceiling" className={select} value={account.ceiling} disabled={busy} onChange={(e) => act("ceiling", e.target.value)}>
          {LADDER.map((p) => <option key={p} value={p}>{LABEL[p]}</option>)}
        </select>
        <label className="text-slate-500" htmlFor="omega-agent-mode">Agent</label>
        <select id="omega-agent-mode" className={select} value={account.agent_mode} disabled={busy} onChange={(e) => act("agent_mode", e.target.value)}>
          <option value="autonomous">Autonomous (within the ceiling)</option>
          <option value="approval">Approval (upgrades need your click)</option>
        </select>
      </div>
      {pending ? (
        <div className="rounded-sm border border-cyan-400/20 bg-cyan-400/5 px-2 py-1.5 text-slate-300">
          The agent proposes {LABEL[account.profile] ?? account.profile} → {LABEL[pending.to ?? ""] ?? pending.to} on evidence.
          <span className="ml-2 inline-flex gap-1.5">
            <button className="rounded-sm border border-emerald-400/30 px-1.5 text-emerald-300" disabled={busy} onClick={() => act("accept")}>Accept</button>
            <button className="rounded-sm border border-white/15 px-1.5 text-slate-300" disabled={busy} onClick={() => act("decline")}>Decline</button>
          </span>
        </div>
      ) : null}
      <p className="text-slate-500">
        Downgrades run at once (kill switch or daily loss to Safe, a 20% drawdown, 4 losses in a row, extreme volatility). Upgrades:
        one step, on evidence, never above the ceiling or with a position or order open, at most one per 7 days.
        {blocked ? ` No autonomous upgrade before ${new Date(blocked).toISOString().slice(0, 16).replace("T", " ")} UTC.` : ""}
      </p>
      {msg ? <p className={msg.tone}>{msg.text}</p> : null}
    </div>
  );
}
