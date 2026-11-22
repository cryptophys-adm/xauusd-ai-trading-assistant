import { Check, Circle, Lock, X } from "lucide-react";
import { Badge, Hint } from "./ui";
import type { Tone } from "../lib/tokens";

/**
 * The live setup (owner 2026-11-12: "ya kerjakan semua nomor jika memang lebih baik"): a Decision Engine
 * signal from the ledger with its levels locked at the decision that opened it, and its lifecycle on the
 * ledger's 1m bars: signal → entry → SL+ → TP1 → TP2, or the stop. Later 15m decisions only confirm it
 * (same side) or call against it; they never move these levels. Omega's own trade of it is shown beside.
 * From GET /api/conclusion/global → setups (src/signal-ledger.mjs activeSetups of the AI Worker).
 */
/** The ledger's paper gates in words: they come from the ledger's own paper trades, never from the account. */
const PAPER_GATE: Record<string, string> = {
  max_positions: "another paper trade still open (max positions)",
  same_side_unprotected: "a paper trade on this side not yet protected",
  waiting_for_pullback: "price never came back to the entry"
};
const hm = (iso?: string | null) => (iso ? String(iso).slice(11, 16) : "");
const px = (x?: number | null) => (x == null ? "—" : x.toFixed(2));
const r = (x?: number | null) => (x == null ? "" : `${x > 0 ? "+" : ""}${Math.round(x * 100) / 100}R`);
/** A target reached is a gain (bull green), a stop a loss (bear red); the rest are states. */
const PHASE: Record<string, { text: string; tone: Tone }> = {
  awaiting_entry: { text: "awaiting entry", tone: "ok" },
  open: { text: "entry active", tone: "ok" },
  tp1: { text: "TP1 reached", tone: "bull" },
  tp2: { text: "TP2 reached", tone: "bull" },
  sl_plus: { text: "closed at SL+", tone: "neutral" },
  stopped: { text: "invalidated", tone: "bear" },
  cancelled: { text: "cancelled", tone: "off" },
  time: { text: "time exit", tone: "off" }
};
const CANCEL: Record<string, string> = { unfilled: "not filled in time", invalidated: "stop touched before entry", target_before_entry: "target reached before entry" };
const OMEGA_EXIT: Record<string, string> = { target: "target", trailed_target: "trailed TP", stop: "stop", sl_plus: "SL+", power_reversal: "power reversed", lean_flip: "lean flipped", confidence_drop: "confidence dropped", opposite: "opposite", time: "time" };

/** The key-level zone holding a price (the entry zone), or null. */
export function zoneAt(levels: any[] | undefined, price?: number | null) {
  if (price == null) return null;
  return (levels ?? []).find((z: any) => z.low <= price && price <= z.high) ?? null;
}

function Step({ label, at, state, note }: { label: string; at?: string | null; state: "done" | "fail" | "next" | "off"; note?: string }) {
  const icon = state === "done" ? <Check className="h-3 w-3 text-ok" /> : state === "fail" ? <X className="h-3 w-3 text-fault" /> : <Circle className={`h-3 w-3 ${state === "next" ? "text-ok" : "text-dim"}`} />;
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-0.5 text-center" role="listitem">
      {icon}
      <span className={`text-[10.5px] font-medium ${state === "done" ? "text-ok" : state === "fail" ? "text-fault" : state === "next" ? "text-fg" : "text-muted"}`}>{label}</span>
      <span className="mono text-[10px] text-fg-2">{at ? hm(at) : note ?? "—"}</span>
    </div>
  );
}

export default function SetupLifecycle({ setup: s, levels }: { setup: any; levels?: any[] }) {
  if (!s) return null;
  const long = s.side === "BUY";
  const st = s.steps ?? {};
  const failed = !!st.invalidated, cancelled = !!st.cancelled;
  const zone = zoneAt(levels, s.locked?.entry);
  const after = (x: boolean) => (failed || cancelled ? "off" : x ? "next" : "off");
  const phase = PHASE[s.phase] ?? { text: s.phase, tone: "plain" as const };
  const o = s.omega;
  return (
    <div className="glass-inner mt-3 px-3 py-2.5" aria-label="Live setup">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <Lock className="h-3.5 w-3.5 text-amber-300" aria-label="levels locked" />
        <span className={`mono font-bold ${long ? "text-bull" : "text-bear"}`}>{s.side}</span>
        <span className="text-fg-2">opened {hm(s.opened_at)} UTC{s.mode ? ` · ${s.mode}` : ""}</span>
        <Badge tone={phase.tone}>{phase.text}</Badge>
        <Hint text="Levels locked at the decision; times from the ledger's 1m bars." />
        {(s.decisions_since?.same || s.decisions_since?.opposite) ? (
          <span className="text-[11px] text-muted" title="Decisions since this setup opened: same side confirm it, the opposite side calls against it (its levels stay locked)">
            {s.decisions_since.same ? `confirmed ×${s.decisions_since.same}` : ""}{s.decisions_since.same && s.decisions_since.opposite ? " · " : ""}{s.decisions_since.opposite ? <span className="text-late">opposite ×{s.decisions_since.opposite}</span> : ""}
          </span>
        ) : null}
      </div>
      <div className="mono mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10.5px] text-slate-300 sm:grid-cols-4">
        <span>entry <b className="text-fg">{px(s.locked?.entry)}</b>{zone ? <span className="text-muted"> ({px(zone.low)}–{px(zone.high)})</span> : null}</span>
        <span>stop <b className="text-bear">{px(s.locked?.stop)}</b></span>
        <span>TP1 <b className="text-bull">{px(s.locked?.tp1)}</b></span>
        <span>TP2 <b className="text-bull">{px(s.locked?.tp2)}</b></span>
      </div>
      <div className="mt-2 flex items-start gap-1" role="list" aria-label="Setup lifecycle">
        <Step label="Signal" at={st.signal} state="done" />
        <Step label="Entry" at={st.entry} state={st.entry ? "done" : cancelled ? "fail" : "next"} note={cancelled ? CANCEL[st.cancelled.reason] ?? st.cancelled.reason : s.fill_deadline ? `until ${hm(s.fill_deadline)}` : undefined} />
        <Step label="SL+" at={st.sl_plus} state={st.sl_plus ? "done" : after(!!st.entry)} />
        <Step label="TP1" at={st.tp1} state={st.tp1 ? "done" : after(!!st.entry)} />
        {s.locked?.tp2 != null && <Step label="TP2" at={st.tp2} state={st.tp2 ? "done" : after(!!st.tp1)} />}
        <Step label="Invalid" at={st.invalidated} state={failed ? "fail" : "off"} note={failed ? undefined : "not hit"} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 text-[11px] text-muted">
        {(s.r?.tp1 != null || s.r?.open != null) && <span>plan {s.r?.tp1 != null ? `TP1 ${r(s.r.tp1)}` : `open ${r(s.r.open)}`}{s.r?.tp2 != null ? ` · TP2 ${r(s.r.tp2)}` : ""}</span>}
        {/* The ledger's replay of Omega's policy on paper (owner 2026-11-18: "omega selalu info max positions"): it is not
            the live EA, whose reason is on the Omega page ("Omega right now"); "max positions" here means another paper
            trade of the ledger is still open. */}
        {o && <span title="The Signal Ledger's paper replay of Omega's policy, not the live EA. The live EA's reason is on the Omega page.">Omega policy (paper) {o.status === "closed" ? `${r(o.r)} (${OMEGA_EXIT[o.exit] ?? o.exit})` : o.status === "skipped" ? `skipped: ${PAPER_GATE[o.gate] ?? String(o.gate ?? "").replace(/_/g, " ")}` : o.status}</span>}
      </div>
    </div>
  );
}
