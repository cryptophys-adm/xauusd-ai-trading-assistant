import { useState, type ReactNode } from "react";
import { ErrorBox, Hint, PollError, PollStrip, Skeleton, phaseOf } from "./ui";
import { usePoll } from "../lib/usePoll";
import { ALSO_OFF, PM_LINES_READS, canTurnOn, errorWords, linesOf, offBy, postPmLine, readErrorOf, readErrorText, readPmLines, rText, tagOf, whenText, type PmLine } from "../lib/pmLines";

// C5: the Position Manager lines on the Omega page (the owner-approved mockup "Nexus C5 Position Manager lines mockup",
// "setuju mockup C5"): one block in Setup › Engine, inside the Broker engine panel, right under the Reversal probation
// row and above the engine form; nothing else on the page moves. Per line (B5's GET /api/omega/position-manager lines):
// id@version, on (ok cyan) or off (fault red), the mean R of its last 15 closes, its mean R against holding to the plan's
// stop and target, its closes, and for a line the breaker turned off when (UTC · GMT+7). R is neutral, never green or
// red. The owner's Turn back on (only on a line its breaker holds off; viewer.can_control, as the probation's button)
// opens the confirm box, then POST /omega/api/pm-lines { line, enabled: true } (lib/pmLines.ts postPmLine): the panel's
// only write. There is no turn-off control (a line goes off by its breaker or PM_LINES_OFF). OmegaWhy gets no entry:
// pm_line_off is an event, not a planner note. PmLinesView is pure and null-safe (the page render check renders it over
// test/fixtures/nexus-pm-lines/*.json, the seed's real answers). Explanations are in the ⓘ tooltips.

/**
 * The desktop grid: the line, on/off, last 15, vs hold, closes (the mockup's columns, the fixed ones a little narrower so
 * the longest id, tp_further_atr_expansion_trend@1, is whole in the engine panel's 474 px at 1440).
 */
const GRID = "grid grid-cols-[minmax(0,1fr)_28px_56px_56px_40px] items-baseline gap-x-3";

export const PANEL_HINT = "Each line is one Position Manager rule at its version. Its breaker turns it off when the mean R of its last 15 closes is below 0R; the Position Manager then acts as if the rule had not fired. A line comes back with a new version, or when the owner turns it back on (a fresh window of 15 closes starts). PM_LINES_OFF in the AI Worker switches lines off by hand.";
export const LAST15_TITLE = "Mean R of the line's last 15 closes (of all, while it has fewer); — before its first close.";
export const VS_HOLD_TITLE = "Mean R of those closes against holding to the plan's original stop and target, over the closes whose hold has settled; — before any has.";
export const HAND_HINT = "The switch PM_LINES_OFF (Settings › Feature switches, Position Manager lines) names this line: it is off by hand, and no button here turns it on. It comes back when the switch no longer names it.";
export const ALSO_HINT = "Its breaker turned it off, and the switch PM_LINES_OFF names it too: it stays off until the switch no longer names it.";

/** The way to the switch: Settings › Feature switches (FS1's PM_LINES_OFF row). */
function SwitchLink({ children }: { children: ReactNode }) {
  return <a href="/#/switches" title="Settings › Feature switches: PM_LINES_OFF" className="text-ok hover:underline">{children}</a>;
}

/** The block's frame: the rule above it, its label with the ⓘ, a poll's stale tag, and its body. */
export function PmLinesFrame({ children, top = null }: { children: ReactNode; top?: ReactNode }) {
  return (
    <div id="pm-lines" className="mb-3 border-t border-white/10 pt-3 text-[12px]" aria-label="Position Manager lines">
      <div className="mb-1.5 flex items-center gap-1.5 text-slate-500">Position Manager lines<Hint text={PANEL_HINT} /></div>
      {top}
      {children}
    </div>
  );
}

export type PmPhase = "idle" | "sending";
export type PmLinesProps = {
  /** GET /api/omega/position-manager's body. */
  d: any;
  /** viewer.can_control on the Omega overview: the probation button's gate (the route checks the owner). */
  canControl?: boolean;
  /** The line whose confirm box is open. */
  open?: string | null;
  phase?: PmPhase;
  /** The refused POST's code, shown in the open box. */
  error?: string | null;
  /** The tag of the line just turned back on ("pm_fast_cut@1 back on."). */
  done?: string | null;
  onAsk?: (id: string) => void;
  onConfirm?: (id: string) => void;
  onCancel?: () => void;
  /** The poll's stale tag, inside the frame. */
  top?: ReactNode;
};

function OnOff({ l }: { l: PmLine }) {
  return <span className={`mono ${l.enabled ? "text-ok" : "text-fault"}`}>{l.enabled ? "on" : "off"}</span>;
}
function Tag({ l, className = "" }: { l: PmLine; className?: string }) {
  return <span className={`mono truncate text-slate-200 ${className}`}>{l.id}<span className="text-fg-2">@{l.version}</span></span>;
}

function LineRow({ l, canControl, open, phase, error, onAsk, onConfirm, onCancel }: { l: PmLine } & Required<Pick<PmLinesProps, "canControl" | "phase">> & Pick<PmLinesProps, "open" | "error" | "onAsk" | "onConfirm" | "onCancel">) {
  const by = offBy(l), isOpen = open === l.id, sending = phase === "sending";
  const button = canControl && canTurnOn(l) && !isOpen;
  return (
    <div className="border-t border-white/5">
      <div className={`${GRID} hidden py-1.5 sm:grid`}>
        <Tag l={l} />
        <OnOff l={l} />
        <span className="mono text-right text-slate-200">{rText(l.mean_r_last15)}</span>
        <span className="mono text-right text-slate-200">{rText(l.r_vs_hold)}</span>
        <span className="mono text-right text-slate-200">{l.closes}</span>
      </div>
      <div className="py-1.5 sm:hidden">
        <div className="flex items-baseline justify-between gap-3"><Tag l={l} className="min-w-0" /><OnOff l={l} /></div>
        <div className="mono mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-fg-2">
          <span><span className="text-slate-200">{rText(l.mean_r_last15)}</span> last 15</span>
          <span><span className="text-slate-200">{rText(l.r_vs_hold)}</span> vs hold</span>
          <span><span className="text-slate-200">{l.closes}</span> closes</span>
        </div>
      </div>
      {by ? (
        <div className="pb-1.5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            {by === "breaker"
              ? <span className="mono text-[11px] text-fg-2">off since {whenText(l.off_since)}</span>
              : <span className="mono flex items-center gap-1.5 text-[11px] text-fg-2">off by the <SwitchLink>switch</SwitchLink><Hint text={HAND_HINT} /></span>}
            {button ? <button type="button" className="btn px-2 py-0.5 text-[11px]" disabled={sending} onClick={() => onAsk?.(l.id)}>Turn back on</button> : null}
          </div>
          {isOpen && canControl && by === "breaker" ? (
            <div className="glass-inner mt-1.5 space-y-2 p-2.5">
              <p className="text-[11px] text-slate-300">Turn <span className="mono text-slate-100">{tagOf(l)}</span> back on?</p>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="btn btn-approve px-2.5 py-1 text-[11px]" disabled={sending} onClick={() => onConfirm?.(l.id)}>{sending ? "Sending…" : "Confirm"}</button>
                <button type="button" className="btn px-2.5 py-1 text-[11px]" disabled={sending} onClick={() => onCancel?.()}>Cancel</button>
              </div>
              {error === ALSO_OFF ? (
                <p role="alert" className="mono flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-fault">Refused: {error}<span className="text-fg-2">· also off by the <SwitchLink>switch</SwitchLink></span><Hint text={ALSO_HINT} /></p>
              ) : error ? <p role="alert" className="mono break-all text-[11.5px] text-fault">Refused: {error}<span className="text-fg-2"> · {errorWords(error)}</span></p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The block over one read of the route (pure, null-safe). */
export function PmLinesView({ d, canControl = false, open = null, phase = "idle", error = null, done = null, onAsk, onConfirm, onCancel, top = null }: PmLinesProps) {
  const lines = linesOf(d);
  const readError = readErrorOf(d);
  if (!lines || !lines.length) {
    return (
      <PmLinesFrame top={top}>
        {readError ? (
          <ErrorBox error={readErrorText(readError)} />
        ) : (
          <div className="glass-inner flex flex-col justify-center gap-1.5 p-3.5 sm:min-h-[120px] sm:px-4">
            <span className="mono text-[13px] text-fg">No lines yet</span>
            <span className="text-[12px] leading-snug text-fg-2">The route sent no Position Manager lines.</span>
          </div>
        )}
      </PmLinesFrame>
    );
  }
  return (
    <PmLinesFrame top={top}>
      <div className={`${GRID} hidden pb-1 text-[11px] text-muted sm:grid`}>
        <span>Line</span>
        <span />
        <span className="text-right" title={LAST15_TITLE}>Last 15</span>
        <span className="text-right" title={VS_HOLD_TITLE}>vs hold</span>
        <span className="text-right">Closes</span>
      </div>
      {lines.map((l) => (
        <LineRow key={l.id} l={l} canControl={canControl} open={open} phase={phase} error={error} onAsk={onAsk} onConfirm={onConfirm} onCancel={onCancel} />
      ))}
      {done ? <p className="pt-1.5 text-[11.5px] text-ok">{done} back on.</p> : null}
    </PmLinesFrame>
  );
}

/** While the first read runs. */
export function PmLinesLoading() {
  return <PmLinesFrame><Skeleton rows={3} /></PmLinesFrame>;
}

/**
 * The block on the page: its one read (GET only, lib/pmLines.ts PM_LINES_READS, every 60 s while Setup › Engine is
 * shown), the confirm box and its one write. A failed first read is the shared error box with Retry now; a failed
 * refresh keeps the lines with the stale tag.
 */
export default function PmLines({ canControl }: { canControl: boolean }) {
  const poll = usePoll(readPmLines, PM_LINES_READS.lines.everyMs);
  const [open, setOpen] = useState<string | null>(null);
  const [phase, setPhase] = useState<PmPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const ask = (id: string) => { if (phase === "sending") return; setOpen(id); setError(null); setDone(null); };
  const cancel = () => { if (phase === "sending") return; setOpen(null); setError(null); };
  const confirm = async (id: string) => {
    if (phase === "sending") return;
    const line = (linesOf(poll.data) ?? []).find((l) => l.id === id);
    setPhase("sending");
    setError(null);
    const r = await postPmLine(id);
    setPhase("idle");
    if (!r.ok) { setError(r.error); return; }
    setOpen(null);
    setDone(line ? tagOf(line) : id);
    await poll.refresh();
  };
  const ph = phaseOf(poll);
  if (ph === "error") return <PmLinesFrame><PollError poll={poll} /></PmLinesFrame>;
  if (ph === "loading" || poll.data == null) return <PmLinesLoading />;
  return <PmLinesView d={poll.data} canControl={canControl} open={open} phase={phase} error={error} done={done} onAsk={ask} onConfirm={confirm} onCancel={cancel} top={ph === "stale" ? <PollStrip poll={poll} /> : null} />;
}
