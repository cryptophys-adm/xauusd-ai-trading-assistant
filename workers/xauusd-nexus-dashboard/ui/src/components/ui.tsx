import { motion } from "framer-motion";
import clsx from "clsx";
import { RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { CHIP, FILL, T, type Tone } from "../lib/tokens";
import type { Poll } from "../lib/usePoll";
import { localClock, localNow, okLine, pollPhase, retryEvery, shortAge, staleTitle, utcClock, wallOf, type PollPhase } from "../lib/pollState";

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

/** The state a poll puts its panel in, now (its times are on the steady local clock, localNow). */
export function phaseOf(poll: Poll): PollPhase {
  return pollPhase({ hasData: poll.data != null, error: poll.error, loading: poll.loading, lastOk: poll.lastOk, lastFail: poll.lastFail, failures: poll.failures, intervalMs: poll.intervalMs }, localNow());
}

/**
 * A glass panel. Given a `poll`, its header's right slot carries the data state first, then the panel's own controls
 * (mockup "Nexus data states", part A): amber "stale 7m" with the last good read and a retry, red "error", and with
 * `live` the cyan time of the last good read. With no poll it is as before.
 */
export function Panel({ title, icon, right, hint, children, className, poll, live = false, pollRetry = true, staleOpen = false }: { title?: ReactNode; icon?: ReactNode; right?: ReactNode; hint?: string; children: ReactNode; className?: string; poll?: Poll; live?: boolean; pollRetry?: boolean; staleOpen?: boolean }) {
  // `staleOpen`: the stale detail (what failed, the last good read) starts open, for a panel traded from.
  const [open, setOpen] = useState(staleOpen);
  const phase = poll ? phaseOf(poll) : null;
  const tag = poll && phase && (phase === "stale" || phase === "error" || (live && phase === "live"))
    ? <PollTag poll={poll} phase={phase} open={open} onToggle={() => setOpen((o) => !o)} retry={pollRetry} />
    : null;
  return (
    <motion.section initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: "easeOut" }}
      className={clsx("glass p-4", className)}>
      {(title || right || tag) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="panel-title flex items-center gap-2">{icon}{title}{hint && <Hint text={hint} />}</h2>
          {tag ? <div className="flex flex-wrap items-center gap-2">{tag}{right}</div> : right}
        </div>
      )}
      {poll && open && phase === "stale" ? <StaleDetail poll={poll} /> : null}
      {children}
    </motion.section>
  );
}

/** A clock for the ages on screen, every `ms`: the steady local clock (localNow), as the polls' times. */
function useNow(ms: number) {
  const [now, setNow] = useState(() => localNow());
  useEffect(() => { const t = window.setInterval(() => setNow(localNow()), ms); return () => window.clearInterval(t); }, [ms]);
  return now;
}

/** A poll's times as the wall clock reads them now (wallOf), for the clock times on screen; ages stay local. */
const shownTimes = (poll: Poll): Poll => ({ ...poll, lastOk: wallOf(poll.lastOk), lastFail: wallOf(poll.lastFail) });

const tagText = "mono whitespace-nowrap text-[11px]";
const tagChip = "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5";

/** The header tag of a poll: stale (amber, late), error (red, fault) or live (cyan, ok). */
function PollTag({ poll, phase, open, onToggle, retry }: { poll: Poll; phase: PollPhase; open: boolean; onToggle: () => void; retry: boolean }) {
  if (phase === "error") {
    return <span className={clsx(tagText, tagChip, "border-fault-fill/35 bg-fault-fill/10 text-fault")} title={`${poll.error} · retry ${retryEvery(poll.intervalMs)}`}><Dot tone="fault" />error</span>;
  }
  if (phase === "live") {
    const ok = wallOf(poll.lastOk);
    if (ok == null) return null;
    return (
      <span className={clsx(tagText, "inline-flex items-center gap-1.5 text-fg-2")} title={`updated ${utcClock(ok)} UTC · ${localClock(ok)} local`} aria-label={`Live, updated ${utcClock(ok, false)} UTC`}>
        <Dot tone="ok" />{utcClock(ok, false)} UTC
      </span>
    );
  }
  return <StaleTag poll={poll} open={open} onToggle={onToggle} retry={retry} />;
}

/** Stale: the chip (a button: on a phone it opens the detail line), the last good read, and Retry now. */
function StaleTag({ poll, open, onToggle, retry }: { poll: Poll; open: boolean; onToggle: () => void; retry: boolean }) {
  const now = useNow(15_000);
  const age = poll.lastOk != null ? shortAge(Math.max(now, localNow()) - poll.lastOk) : "";
  const shown = shownTimes(poll);
  return (
    <>
      <button type="button" onClick={onToggle} aria-expanded={open} aria-label={`Stale ${age}, show details`} title={staleTitle(shown)}
        className="inline-flex h-11 items-center rounded-md sm:h-auto">
        <span className={clsx(tagText, tagChip, "border-late-fill/35 bg-late-fill/10 text-late")}><Dot tone="late" />stale {age}</span>
      </button>
      {shown.lastOk != null ? <span className={clsx(tagText, "hidden text-fg-2 sm:inline")}>ok {okLine(shown.lastOk, false)}</span> : null}
      {retry ? <RetryButton onRetry={poll.refresh} busy={pollBusy(poll)} compact /> : null}
    </>
  );
}

/** The stale tag opened: what failed, how often, the retry cadence and the last good read. */
function StaleDetail({ poll }: { poll: Poll }) {
  return (
    <div className="mono -mt-1 mb-3 rounded-lg border border-late-fill/25 bg-late-fill/6 px-2.5 py-2 text-[11px] leading-relaxed text-fg-2">
      {poll.error != null
        ? <><span className="text-late">{poll.error}</span> · {poll.failures} failed · retry {retryEvery(poll.intervalMs)}</>
        : <><span className="text-late">no good read for {shortAge(2 * poll.intervalMs)}</span> · retry {retryEvery(poll.intervalMs)}</>}
      <br />ok {okLine(wallOf(poll.lastOk), false)}
    </div>
  );
}

/** A read of the poll is in flight (a poll without `busy` falls back to its first-load `loading`). Informational. */
export const pollBusy = (poll: Poll) => poll.busy ?? poll.loading;

/** The longest Retry now spins for its own click (ms): a click that joined a read that then hangs frees the button. */
export const RETRY_SPIN_MS = 10_000;

/**
 * Retry now: an icon (in a header) or a labelled button (in the error box); 44 px tall on a phone. Guarded by its
 * own click only (re-review of #520): disabled and spinning while that click's retry runs, at most RETRY_SPIN_MS. A
 * read in flight elsewhere (`busy`, e.g. the hung read that made the panel stale) never disables it: the poll's
 * refresh joins a young read and starts a new one past an old one (joinsInFlight), so clicks never start parallel
 * reads and the owner never has to reload.
 */
export function RetryButton({ onRetry, busy = false, compact = false }: { onRetry: () => void | Promise<void>; busy?: boolean; compact?: boolean }) {
  const [running, setRunning] = useState(false);
  const click = () => {
    if (running) return;
    setRunning(true);
    let t = 0;
    const end = () => { window.clearTimeout(t); setRunning(false); };
    t = window.setTimeout(end, RETRY_SPIN_MS);
    Promise.resolve().then(onRetry).catch(() => {}).finally(end);
  };
  return (
    <button type="button" onClick={click} disabled={running} aria-label="Retry now" aria-busy={running} data-reading={busy || undefined} title={compact ? "Retry now" : undefined}
      className={clsx("inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/4 text-[12px] font-medium text-fg transition hover:border-white/20 hover:bg-white/8 disabled:cursor-wait disabled:opacity-60",
        compact ? "h-11 w-11 sm:h-7 sm:w-7" : "h-11 px-2.5 sm:h-8")}>
      <RefreshCw className={clsx("h-3.5 w-3.5 text-fg-2", running && "animate-spin")} aria-hidden="true" />{compact ? null : "Retry now"}
    </button>
  );
}

/**
 * A failed read with nothing on screen: the route and its code ("/api/ledger 502"), the retry cadence, the last good
 * read and Retry now. The one error line of every page (no raw "Unavailable: HTTP 502").
 */
export function ErrorBox({ error, lastOk = null, intervalMs = 0, retrying = false, onRetry }: { error: string; lastOk?: number | null; intervalMs?: number; retrying?: boolean; onRetry?: () => void | Promise<void> }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-fault-fill/20 bg-fault-fill/6 px-3 py-2.5">
      <div className="mono flex min-w-0 flex-col gap-1 text-[12px]">
        <span className="break-all text-fault">{error}{intervalMs ? <span className="text-fg-2"> · retry {retryEvery(intervalMs)}</span> : null}</span>
        <span className="text-[11px] text-fg-2">last ok {okLine(lastOk, false)}</span>
      </div>
      {onRetry ? <RetryButton onRetry={onRetry} busy={retrying} /> : null}
    </div>
  );
}

/** The error box of a poll. */
export function PollError({ poll }: { poll: Poll }) {
  return <ErrorBox error={poll.error ?? "read failed"} lastOk={wallOf(poll.lastOk)} intervalMs={poll.intervalMs} retrying={pollBusy(poll)} onRetry={poll.refresh} />;
}

/**
 * A failed read in one line, where a box would repeat the panel's own error box (a KPI, a pipeline step, a list
 * the box above already explains): the route and code in red.
 */
export function ErrorLine({ error }: { error: string }) {
  return <p className="mono break-all py-1 text-[12px] text-fault">{error}</p>;
}

/**
 * A poll's state tag outside a Panel header (the War Room tabs, a council session): stale with the last good read
 * and Retry now, or with `live` the cyan time of the last good read. Nothing while it loads or has no data.
 */
export function PollStrip({ poll, live = false, className }: { poll: Poll; live?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const phase = phaseOf(poll);
  if (!(phase === "stale" || (live && phase === "live"))) return null;
  return (
    <div className={clsx("mb-2", className)}>
      <div className="flex flex-wrap items-center justify-end gap-2"><PollTag poll={poll} phase={phase} open={open} onToggle={() => setOpen((o) => !o)} retry /></div>
      {open && phase === "stale" ? <div className="mt-2"><StaleDetail poll={poll} /></div> : null}
    </div>
  );
}

/**
 * The body of a polled panel: the skeleton on the first load only, the error box when the read failed with nothing
 * on screen (kept while its retry runs), `empty` when the read was good with nothing to show, else the content.
 * Pass the content as a function when it reads the data, so it runs only once there is some.
 */
export function PollBody({ poll, skeleton = 3, empty, children }: { poll: Poll; skeleton?: number | "chart"; empty?: ReactNode; children: ReactNode | (() => ReactNode) }) {
  const phase = phaseOf(poll);
  if (phase === "error") return <PollError poll={poll} />;
  if (phase === "loading") return skeleton === "chart" ? <Skeleton variant="chart" /> : <Skeleton rows={skeleton} />;
  if (empty) return <>{empty}</>;
  if (phase === "idle") return null;
  return <>{typeof children === "function" ? children() : children}</>;
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

/** The first-load placeholder, shaped like what it replaces: rows, or a chart (legend, plot, label, strip, footer). */
export function Skeleton({ rows = 3, variant = "rows" }: { rows?: number; variant?: "rows" | "chart" }) {
  if (variant === "chart") {
    return (
      <div className="flex animate-pulse flex-col gap-2" aria-hidden="true">
        <div className="flex justify-between"><div className="h-2.5 w-[120px] rounded-sm bg-white/5" /><div className="h-[18px] w-12 rounded-full bg-white/5" /></div>
        <div className="h-[150px] rounded-lg bg-white/5" />
        <div className="h-2.5 w-[90px] rounded-sm bg-white/5" />
        <div className="h-[52px] rounded-lg bg-white/5" />
        <div className="h-2.5 rounded-sm bg-white/5" />
      </div>
    );
  }
  return <div className="animate-pulse space-y-2" aria-hidden="true">{Array.from({ length: rows }, (_, i) => <div key={i} className="h-9 rounded-lg bg-white/5" />)}</div>;
}

/**
 * Nothing to show after a good read. With `when` it says what is missing and when it fills (mockup "Nexus data
 * states"): "0 closed trades · 30D · TP1" over "Draws from the 2nd closed trade. The ledger runs every 5m."
 */
export function Empty({ children, when }: { children: ReactNode; when?: ReactNode }) {
  if (when == null) return <p className="py-3 text-[12px] text-muted">{children}</p>;
  return (
    <div className="glass-inner flex flex-col justify-center gap-1.5 p-3.5 sm:min-h-[120px] sm:px-4">
      <span className="mono text-[13px] text-fg">{children}</span>
      <span className="text-[12px] leading-snug text-fg-2">{when}</span>
    </div>
  );
}

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <label className={clsx("block", className)}><span className="label">{label}</span>{children}</label>;
}

/** An alert's severity as a status tone: critical fault, warning late, info ok (never green: green is bullish). */
export function severityTone(s?: string): Tone {
  return s === "critical" ? "fault" : s === "warning" ? "late" : s === "info" ? "ok" : "plain";
}
