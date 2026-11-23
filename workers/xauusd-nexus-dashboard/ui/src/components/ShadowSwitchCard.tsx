import { useCallback, useEffect, useState } from "react";
import { Power } from "lucide-react";
import { Dot } from "./ui";

/**
 * The shadow kill switch (owner 2026-11-14: "berikan kill switch untuk mode shadow jika ternyata biaya
 * membengkak"). One switch for every shadow path that calls a model: the metric-format arm, the learned notes
 * under test and a benched agent's answer beside its room. Off, the live rooms and decisions go on. The cost
 * breaker turns it off by itself once today's shadow calls pass the daily neuron budget; it stays off until a
 * person turns it on. Read and changed through Omega's API (Cloudflare Access; a person, same origin, a
 * reason); every change is audited and sent to Telegram.
 */
type ShadowMode = {
  mode?: "on" | "off";
  mode_source?: "owner" | "breaker" | "default";
  allowed?: boolean;
  held_off_by_variable?: boolean;
  set_at?: string | null;
  reason?: string | null;
  budget_neurons_per_day?: number;
  spend_today?: { day: string; calls: number; neurons: number; share_of_budget: number; usd_at_paid_rate: number; by_source: Record<string, { calls: number; neurons: number }> } | null;
  can_control?: boolean;
  events?: Array<{ at: string; mode: string; previous_mode: string | null; reason: string; actor: string }>;
};

async function call(path: string, method = "GET", body?: unknown): Promise<ShadowMode & { ok?: boolean; error?: string }> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

const when = (iso?: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "—");
const k = (n?: number) => (typeof n === "number" ? n.toLocaleString("en-US") : "—");
const SOURCE_NAMES: Record<string, string> = {
  "shadow:metric_opening": "Metric format (openings)",
  "shadow:metric_rebuttal": "Metric format (rebuttals)",
  "shadow:war_room_opening": "15m room (notes / benched)",
  "shadow:tf_room_opening": "1H-D1 rooms (notes / benched)",
  "shadow:decision_council": "Council (notes)",
};

export default function ShadowSwitchCard() {
  const [state, setState] = useState<ShadowMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setState(await call("/omega/api/shadow-mode")); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  const on = state?.mode !== "off";
  const next = on ? "off" : "on";
  const submit = async () => {
    if (!reason.trim()) return;
    setBusy(true);
    try { await call("/omega/api/shadow-mode", "POST", { mode: next, reason: reason.trim() }); setEditing(false); setReason(""); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const spend = state?.spend_today;
  const share = Math.min(1, spend?.share_of_budget ?? 0);
  // Only what the server reports: an answer without the switch's state shows "unknown", never OFF.
  const known = typeof state?.allowed === "boolean";
  // Off by the owner (or held off by the SHADOW_MODE variable) is a choice: grey, still. Only the cost breaker's stop
  // is a fault: red, pulsing.
  const breaker = known && !state?.allowed && !state?.held_off_by_variable && state?.mode_source === "breaker";
  const tone = !known ? "off" : !state?.allowed ? (breaker ? "fault" : "off") : share >= 0.8 ? "late" : "ok";

  return (
    <div className="glass p-4">
      <div className="panel-title mb-2 flex items-center gap-2"><Power className="h-3 w-3 text-fault" />Shadow mode · kill switch</div>
      {state ? (
        <div className="space-y-2 text-[11.5px]">
          <div className="flex items-center gap-2">
            <Dot tone={tone} pulse={breaker} />
            <span className="text-slate-100">
              {!known ? "State unknown" : state.allowed ? "Shadow calls running" : state.held_off_by_variable ? "Shadow held off by the SHADOW_MODE variable" : state.mode_source === "breaker" ? "Shadow OFF: stopped by the cost breaker" : "Shadow OFF"}
            </span>
          </div>
          <div className="text-slate-400">
            Switch: <b className={!state.mode ? "text-slate-400" : on ? "text-ok" : "text-off"}>{!state.mode ? "—" : on ? "ON" : "OFF"}</b>
            {state.mode_source !== "default" ? <span> · {state.mode_source === "breaker" ? "cost breaker" : "owner"}, {when(state.set_at)}{state.reason ? ` — ${state.reason}` : ""}</span> : <span> · default</span>}
          </div>
          <div>
            <div className="mb-1 flex justify-between text-slate-400">
              <span>Today's shadow neurons</span>
              <span className="mono text-slate-200">{k(spend?.neurons)} / {k(state.budget_neurons_per_day)}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-sm bg-white/5">
              <div className={`h-full ${share >= 1 ? "bg-fault-fill" : share >= 0.8 ? "bg-late-fill" : "bg-ok-fill"}`} style={{ width: `${Math.round(share * 100)}%` }} />
            </div>
            <div className="mt-1 text-[10.5px] text-slate-500">
              {spend ? `${k(spend.calls)} calls · about USD ${spend.usd_at_paid_rate.toFixed(2)} at the paid rate · the breaker turns shadow off past the budget` : "—"}
            </div>
          </div>
          {spend && Object.keys(spend.by_source).length ? (
            <div className="space-y-0.5 text-[10.5px] text-slate-400">
              {Object.entries(spend.by_source).sort((a, b) => b[1].neurons - a[1].neurons).map(([s, v]) => (
                <div key={s} className="flex justify-between"><span>{SOURCE_NAMES[s] ?? s}</span><span className="mono">{k(v.neurons)} · {k(v.calls)} calls</span></div>
              ))}
            </div>
          ) : null}
          <div className="text-[10.5px] text-slate-500">Off stops every shadow model call (metric format, notes under test, benched agents' turns). Live rooms and decisions are not affected; benched agents stay benched and their record pauses.</div>
          {state.can_control ? (
            editing ? (
              <div className="space-y-1.5">
                <input
                  className="w-full rounded-sm border border-white/10 bg-black/30 px-2 py-1 text-[11.5px] text-slate-100 outline-hidden focus:border-cyan-400/50"
                  placeholder={`Reason to switch shadow ${next.toUpperCase()}`}
                  value={reason}
                  maxLength={200}
                  onChange={(e) => setReason(e.target.value)}
                />
                <div className="flex gap-2">
                  <button className={`rounded-sm px-2 py-1 text-[11px] disabled:opacity-40 ${next === "off" ? "bg-fault-fill/20 text-fault" : "bg-ok-fill/20 text-ok"}`} disabled={busy || !reason.trim()} onClick={submit}>
                    {busy ? "Saving…" : `Switch shadow ${next.toUpperCase()}`}
                  </button>
                  <button className="rounded-sm px-2 py-1 text-[11px] text-slate-400" onClick={() => { setEditing(false); setReason(""); }}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="rounded-sm border border-white/10 px-2 py-1 text-[11px] text-slate-200 hover:border-fault-fill/40" onClick={() => setEditing(true)}>
                {on ? "Switch shadow OFF…" : "Switch shadow ON…"}
              </button>
            )
          ) : null}
          {state.events?.length ? (
            <div className="border-t border-white/5 pt-1.5 text-[10.5px] text-slate-500">
              {state.events.slice(0, 3).map((e, i) => <div key={i}>{when(e.at)} · {e.mode.toUpperCase()} · {e.actor === "cost-breaker" ? "cost breaker" : "owner"} — {e.reason}</div>)}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="text-[11.5px] text-slate-500">{error ? `Unavailable (${error})` : "—"}</div>
      )}
      {state && error ? <div className="mt-1 text-[10.5px] text-fault">{error}</div> : null}
    </div>
  );
}
