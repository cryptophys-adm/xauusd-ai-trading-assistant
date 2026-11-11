import { useCallback, useEffect, useState } from "react";
import { RadioTower } from "lucide-react";
import { Dot } from "./ui";

/**
 * The MT5 fallback switch (owner 2026-11-11: "possible kita sediakan menu toggle data source di war room";
 * MT5 stays the fallback, the owner switches it). While TradingView is down and the switch is on, the
 * XAUUSD bars come from the broker's MT5 terminal (1m to D1) and decisions trade on them. Read and changed
 * through Omega's API (Cloudflare Access; a person, same origin, a reason); every change is audited and
 * sent to Telegram. Shows only what the server reports ("—" when it is not known).
 */
type FeedFallback = {
  mode?: "auto" | "off";
  mode_source?: "owner" | "default";
  set_at?: string | null;
  set_by?: string | null;
  reason?: string | null;
  active?: boolean;
  active_since?: string | null;
  corpus?: { source: string; last_bar_close: string; age_s: number } | null;
  can_control?: boolean;
  events?: Array<{ at: string; mode: string; previous_mode: string | null; reason: string; actor: string }>;
};

async function call(path: string, method = "GET", body?: unknown): Promise<FeedFallback & { ok?: boolean; error?: string }> {
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

const hhmm = (iso?: string | null) => (iso ? new Date(iso).toISOString().slice(11, 16) + " UTC" : "—");
const age = (s?: number) => (typeof s === "number" ? (s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`) : "—");

export default function FeedFallbackCard() {
  const [state, setState] = useState<FeedFallback | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setState(await call("/omega/api/feed-fallback")); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  const on = state?.mode === "auto";
  const next = on ? "off" : "auto";
  const submit = async () => {
    if (!reason.trim()) return;
    setBusy(true);
    try { await call("/omega/api/feed-fallback", "POST", { mode: next, reason: reason.trim() }); setEditing(false); setReason(""); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="glass p-4">
      <div className="eyebrow mb-2 flex items-center gap-2"><RadioTower className="h-3 w-3 text-cyan-300" />Data source · MT5 fallback</div>
      {state ? (
        <div className="space-y-1.5 text-[11.5px]">
          <div className="flex items-center gap-2">
            <Dot tone={state.active ? "amber" : "green"} pulse={Boolean(state.active)} />
            <span className="text-slate-100">{state.active ? `Broker MT5 bars since ${hhmm(state.active_since)}` : "TradingView (OANDA)"}</span>
          </div>
          <div className="text-slate-400">
            Fallback switch: <b className={on ? "text-emerald-300" : "text-slate-200"}>{on ? "ON" : "OFF"}</b>
            {state.mode_source === "owner" ? <span> · set {hhmm(state.set_at)}{state.reason ? ` — ${state.reason}` : ""}</span> : <span> · default</span>}
          </div>
          <div className="text-slate-500">Broker corpus: {state.corpus ? `last bar ${age(state.corpus.age_s)} ago` : "—"}</div>
          {state.can_control ? (
            editing ? (
              <div className="mt-2 space-y-1.5">
                <input
                  className="w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-[11.5px] text-slate-100 outline-none focus:border-cyan-400/50"
                  placeholder={`Reason to switch ${next === "auto" ? "ON" : "OFF"}`}
                  value={reason}
                  maxLength={200}
                  onChange={(e) => setReason(e.target.value)}
                />
                <div className="flex gap-2">
                  <button className="rounded bg-cyan-500/20 px-2 py-1 text-[11px] text-cyan-200 disabled:opacity-40" disabled={busy || !reason.trim()} onClick={submit}>
                    {busy ? "Saving…" : `Switch ${next === "auto" ? "ON" : "OFF"}`}
                  </button>
                  <button className="rounded px-2 py-1 text-[11px] text-slate-400" onClick={() => { setEditing(false); setReason(""); }}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="mt-1 rounded border border-white/10 px-2 py-1 text-[11px] text-slate-200 hover:border-cyan-400/40" onClick={() => setEditing(true)}>
                {on ? "Switch fallback OFF…" : "Switch fallback ON…"}
              </button>
            )
          ) : null}
        </div>
      ) : (
        <div className="text-[11.5px] text-slate-500">{error ? `Unavailable (${error})` : "—"}</div>
      )}
      {state && error ? <div className="mt-1 text-[10.5px] text-rose-300">{error}</div> : null}
    </div>
  );
}
