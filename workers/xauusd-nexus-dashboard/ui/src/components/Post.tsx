import { Stance } from "./Stance";
import { ago, pct } from "../lib/format";

export type RoomMessage = {
  id: string; name?: string; status: string; stance?: string | null; confidence?: number | null; ts?: string;
  claim?: string | null; argument?: string | null; rebuts_names?: string[]; conceded?: boolean; calibration?: unknown;
};

export function calibrationText(c: unknown): string | null {
  if (!c) return null;
  if (typeof c === "string") return c;
  const x = c as { total_lines?: number; verified_lines?: number; derived_lines?: number; label?: string };
  if (x.total_lines != null) {
    // Three tiers: verified by parity, computed from verified bars, not yet calibrated.
    const parts = [x.verified_lines ? `${x.verified_lines} verified` : null, x.derived_lines ? `${x.derived_lines} from verified bars` : null].filter(Boolean);
    return parts.length ? `${parts.join(" · ")} of ${x.total_lines}` : "not yet calibrated";
  }
  return x.label ?? null;
}

/** One message of a room: an opening on the bus or a rebuttal in the debate. */
export function Post({ m, text, calibration }: { m: RoomMessage; text?: string | null; calibration?: string | null }) {
  if (m.status !== "ok") {
    return (
      <div className="glass-inner px-3 py-2 text-[12px] text-slate-500">
        <span className="font-semibold text-slate-400">{m.name ?? m.id}</span> could not speak this round.
      </div>
    );
  }
  return (
    <div className="glass-inner px-3 py-2.5">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <span className="font-semibold text-slate-200">{m.name ?? m.id}</span>
        <Stance value={m.stance} />
        <span className="mono">{pct(m.confidence)}</span>
        {calibration && <span className="text-slate-500">· {calibration}</span>}
        {m.conceded && <span className="chip border-cyan-400/30 bg-cyan-400/10 px-1.5 py-0 text-[9px] tracking-[0.14em] text-cyan-200">CONCEDES</span>}
        {!!m.rebuts_names?.length && <span className="text-violet-300/80">→ {m.rebuts_names.join(", ")}</span>}
        {m.ts && <span className="ml-auto text-[10px] text-slate-600">{ago(m.ts)}</span>}
      </div>
      <p className="text-[12.5px] leading-relaxed text-slate-300">{text}</p>
    </div>
  );
}

export type Conclusion = {
  status: string; stance?: string | null; confidence?: number | null; summary?: string | null;
  reasons?: string[]; dissent?: { id: string; name: string }[];
};

/** The moderator's TLDR of a room. */
export function Tldr({ c, waiting }: { c?: Conclusion | null; waiting: string }) {
  if (!c || c.status !== "ok") return <div className="glass-inner px-3 py-3 text-[12px] text-slate-500">{waiting}</div>;
  return (
    <div className="glass-inner border-cyan-400/20 px-3 py-3">
      <div className="mb-2 flex items-center gap-2">
        <Stance value={c.stance} />
        <span className="mono text-[11px] text-slate-400">confidence {pct(c.confidence)}</span>
        <span className="eyebrow ml-auto text-[9px] tracking-[0.24em] text-cyan-300/70">TLDR</span>
      </div>
      <p className="text-[12.5px] leading-relaxed text-slate-200">{c.summary}</p>
      {!!c.reasons?.length && (
        <ul className="mt-2 list-disc space-y-1 pl-4 text-[12px] text-slate-400">{c.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      )}
      {!!c.dissent?.length && <p className="mt-2 text-[11px] text-slate-500">Still disagree: {c.dissent.map((d) => d.name).join(", ")}</p>}
    </div>
  );
}
