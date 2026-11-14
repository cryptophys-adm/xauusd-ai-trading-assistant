import type { ReactNode } from "react";
import { Stance } from "./Stance";
import { ago, pct } from "../lib/format";

export type RoomMessage = {
  id: string; name?: string; status: string; stance?: string | null; confidence?: number | null; ts?: string;
  claim?: string | null; argument?: string | null; rebuts_names?: string[]; conceded?: boolean; bias?: string | null; calibration?: unknown;
};

export function calibrationText(c: unknown): string | null {
  if (!c) return null;
  if (typeof c === "string") return c;
  const x = c as { total_lines?: number; verified_lines?: number; derived_lines?: number; label?: string };
  if (x.total_lines != null) {
    // Three tiers: verified by parity, computed from verified bars, not yet calibrated.
    const parts = [x.verified_lines ? `${x.verified_lines} verified` : null, x.derived_lines ? `${x.derived_lines} from verified bars` : null].filter(Boolean);
    return parts.length ? `${parts.join(" · ")} of ${x.total_lines}` : "uncalibrated";
  }
  return x.label ?? null;
}

/** The direction an agent's data leans, beside its action (owner decision 2026-11-06). */
export function BiasTag({ bias }: { bias: string }) {
  const c = bias === "BULLISH" ? "text-emerald-300" : bias === "BEARISH" ? "text-rose-300" : "text-slate-400";
  return <span className={`text-[10px] ${c}`} title="The direction this agent's data leans">bias {bias.toLowerCase()}</span>;
}

export type Reputation = { n?: number; decisive?: number; accuracy?: number | null; weight?: number; hit_rate?: number | null; wait_accuracy?: number | null; brier?: number | null; family?: string; caution?: string[] };

/**
 * An agent's 30-day track record beside its post (P7, RFC_INDICATOR_AGENT_PLATFORM §7): the
 * accuracy of its decisive calls, the sample, its weight in the crowd line, and caution flags.
 */
export function TrackRecord({ r }: { r?: Reputation | null }) {
  if (!r) return null;
  const decisive = r.decisive ?? 0;
  const tone = !decisive ? "text-slate-600" : (r.accuracy ?? 0) >= 0.55 ? "text-emerald-300/80" : (r.accuracy ?? 0) < 0.45 ? "text-rose-300/80" : "text-slate-400";
  const title = decisive
    ? `Last 30 days: ${decisive} decisive calls (BUY/SELL hit or miss, WAIT right or a missed move), accuracy ${pct(r.accuracy)}; BUY/SELL hit rate ${pct(r.hit_rate)}, WAIT accuracy ${pct(r.wait_accuracy)}, Brier ${r.brier ?? "n/a"}. Weight in the crowd line ×${r.weight}.`
    : "No scored calls yet: weight ×1 in the crowd line.";
  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      <span className={`mono text-[10px] ${tone}`}>{decisive ? `record ${pct(r.accuracy)} · n ${decisive} · ×${r.weight}` : "no record"}</span>
      {!!r.caution?.length && <span className="chip border-amber-400/30 bg-amber-400/10 px-1.5 py-0 text-[9px] tracking-[0.14em] text-amber-200" title={r.caution.join("\n")}>CAUTION</span>}
    </span>
  );
}

/** One message of a room: an opening on the bus or an answer in the Consensus Discussion. */
export function Post({ m, text, calibration, reputation, extra }: { m: RoomMessage; text?: string | null; calibration?: string | null; reputation?: Reputation | null; extra?: ReactNode }) {
  if (m.status !== "ok") {
    return (
      <div className="glass-inner px-3 py-2 text-[12px] text-slate-500">
        <span className="font-semibold text-slate-400">{m.name ?? m.id}</span> · no response
      </div>
    );
  }
  return (
    <div className="glass-inner px-3 py-2.5">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <span className="font-semibold text-slate-200">{m.name ?? m.id}</span>
        <Stance value={m.stance} />
        {m.bias && <BiasTag bias={m.bias} />}
        <span className="mono">{pct(m.confidence)}</span>
        {calibration && <span className="text-slate-500">· {calibration}</span>}
        <TrackRecord r={reputation} />
        {m.conceded && <span className="chip border-cyan-400/30 bg-cyan-400/10 px-1.5 py-0 text-[9px] tracking-[0.14em] text-cyan-200">CONCEDES</span>}
        {!!m.rebuts_names?.length && <span className="text-violet-300/80">→ {m.rebuts_names.join(", ")}</span>}
        {m.ts && <span className="ml-auto text-[10px] text-slate-600">{ago(m.ts)}</span>}
      </div>
      <p className="text-[12.5px] leading-relaxed text-slate-300">{text}</p>
      {extra}
    </div>
  );
}

export type Conclusion = {
  status: string; stance?: string | null; bias?: string | null; confidence?: number | null; summary?: string | null;
  reasons?: string[]; dissent?: { id: string; name: string }[];
};

/** The moderator's TLDR of a room. */
export function Tldr({ c, waiting }: { c?: Conclusion | null; waiting: string }) {
  if (!c || c.status !== "ok") return <div className="glass-inner px-3 py-3 text-[12px] text-slate-500">{waiting}</div>;
  return (
    <div className="glass-inner border-cyan-400/20 px-3 py-3">
      <div className="mb-2 flex items-center gap-2">
        <Stance value={c.stance} />
        {c.bias && <BiasTag bias={c.bias} />}
        <span className="mono text-[11px] text-slate-400">confidence {pct(c.confidence)}</span>
        <span className="eyebrow ml-auto text-[9px] tracking-[0.24em] text-cyan-300/70">TLDR</span>
      </div>
      <p className="text-[12.5px] leading-relaxed text-slate-200">{c.summary}</p>
      {!!c.reasons?.length && (
        <ul className="mt-2 list-disc space-y-1 pl-4 text-[12px] text-slate-400">{c.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      )}
      {!!c.dissent?.length && <p className="mt-2 text-[11px] text-slate-500">Dissent: {c.dissent.map((d) => d.name).join(", ")}</p>}
    </div>
  );
}
