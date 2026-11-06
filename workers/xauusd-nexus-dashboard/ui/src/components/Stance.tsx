import clsx from "clsx";

const TONE: Record<string, string> = {
  BUY: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  BULLISH: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  SELL: "border-rose-400/30 bg-rose-400/10 text-rose-300",
  BEARISH: "border-rose-400/30 bg-rose-400/10 text-rose-300",
  WAIT: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  HOLD: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  CLOSE: "border-cyan-400/30 bg-cyan-400/10 text-cyan-200",
  NEUTRAL: "border-white/10 bg-white/[0.04] text-slate-300",
};

/** A room stance or a news bias as a small chip. */
export function Stance({ value, className }: { value?: string | null; className?: string }) {
  if (!value) return null;
  return <span className={clsx("chip px-2 py-0.5 text-[10px] tracking-[0.14em]", TONE[value] ?? TONE.NEUTRAL, className)}>{value}</span>;
}

export function stanceColor(value?: string | null): string {
  return value === "BUY" || value === "BULLISH" ? "text-emerald-400" : value === "SELL" || value === "BEARISH" ? "text-rose-400" : value === "CLOSE" ? "text-cyan-300" : "text-amber-300";
}
