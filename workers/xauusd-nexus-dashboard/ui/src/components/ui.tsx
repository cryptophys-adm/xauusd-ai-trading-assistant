import { motion } from "framer-motion";
import clsx from "clsx";
import type { ReactNode } from "react";
import { CHIP, FILL, T, type Tone } from "../lib/tokens";

/**
 * An explanation kept out of the layout (owner 2026-11-13: no paragraphs of notes on a production page):
 * a small info mark whose text shows on hover or focus.
 */
export function Hint({ text, className }: { text: string; className?: string }) {
  return (
    <span tabIndex={0} role="note" aria-label={text} title={text}
      className={clsx("inline-flex h-3.5 w-3.5 shrink-0 cursor-help items-center justify-center rounded-full border border-white/15 text-[9px] font-semibold normal-case leading-none tracking-normal text-muted outline-hidden hover:border-white/30 hover:text-slate-300 focus:border-cyan-400/50 focus:text-slate-200", className)}>
      i
    </span>
  );
}

export function Panel({ title, icon, right, hint, children, className }: { title?: ReactNode; icon?: ReactNode; right?: ReactNode; hint?: string; children: ReactNode; className?: string }) {
  return (
    <motion.section initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: "easeOut" }}
      className={clsx("glass p-4", className)}>
      {(title || right) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="panel-title flex items-center gap-2">{icon}{title}{hint && <Hint text={hint} />}</h2>
          {right}
        </div>
      )}
      {children}
    </motion.section>
  );
}

/**
 * A KPI tile: a sentence-case label, the value in the text colour unless it carries a meaning (a gain or a loss, a
 * status), and no glow (mockup "Nexus colours and text").
 */
export function Kpi({ label, value, sub, color, icon }: { label: string; value: string; sub?: string; color?: string; icon?: ReactNode }) {
  return (
    <div className="glass flex flex-col justify-between p-4">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
        {icon && <span style={{ color: color ?? T.muted }}>{icon}</span>}{label}
      </div>
      <div className="mono mt-2 text-[24px] font-semibold leading-none" style={{ color: color ?? T.fg }}>{value}</div>
      {sub && <div className="mono mt-1 text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

/**
 * Legacy tone names, kept so every caller still compiles: green is bull, red is bear (the same red as fault), amber
 * is neutral (the same amber as late), cyan is ok, purple is shadow, slate is plain. New code names the meaning.
 */
type LegacyTone = "green" | "amber" | "red" | "cyan" | "slate" | "purple";
export type BadgeTone = Tone | LegacyTone;
const LEGACY: Record<LegacyTone, Tone> = { green: "bull", red: "bear", amber: "neutral", cyan: "ok", purple: "shadow", slate: "plain" };
const toneOf = (t: BadgeTone): Tone => (t in LEGACY ? LEGACY[t as LegacyTone] : (t as Tone));

export function Dot({ tone = "ok", pulse = false }: { tone?: BadgeTone; pulse?: boolean }) {
  const t = toneOf(tone);
  const c = t === "plain" ? "bg-off-fill" : FILL[t];
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      {pulse && <span className={clsx("absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping-slow", c)} />}
      <span className={clsx("relative inline-flex h-2 w-2 rounded-full", c)} />
    </span>
  );
}

/** A chip in a semantic tone: bull, bear, neutral (direction); ok, late, fault, off (status); shadow; plain. */
export function Badge({ tone = "plain", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={clsx("chip", CHIP[toneOf(tone)])}>{children}</span>;
}

export function JsonView({ value }: { value: unknown }) {
  return <pre className="glass-inner mono max-h-[420px] overflow-auto p-3 text-[11px] leading-relaxed text-slate-300">{JSON.stringify(value, null, 2)}</pre>;
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div className="animate-pulse space-y-2">{Array.from({ length: rows }, (_, i) => <div key={i} className="h-9 rounded-lg bg-white/5" />)}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-3 text-[12px] text-muted">{children}</p>;
}

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <label className={clsx("block", className)}><span className="label">{label}</span>{children}</label>;
}

/** An alert's severity as a status tone: critical fault, warning late, info ok (never green: green is bullish). */
export function severityTone(s?: string): Tone {
  return s === "critical" ? "fault" : s === "warning" ? "late" : s === "info" ? "ok" : "plain";
}
