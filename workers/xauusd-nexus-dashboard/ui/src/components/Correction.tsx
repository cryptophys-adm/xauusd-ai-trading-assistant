import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { ThumbsDown, ThumbsUp, X } from "lucide-react";
import { Hint } from "./ui";
import { get } from "../lib/api";
import { CHIP } from "../lib/tokens";
import { FS_PATH, FS_POLL_MS } from "../lib/featureSwitches";
import {
  CATEGORIES, HIDDEN, HINT, OFF_WORDS, TEXT_MAX, asOfText, bodyOf, canSend, emptyDraft, errorOf, gateOf, over, postCorrection, sentChips, targetKey,
  type Draft, type ErrorText, type Gate, type Rating, type Sent, type Tab, type Target
} from "../lib/corrections";

// H3f, the owner's correction control (owner "2. yes", 2026-11-25; the owner-approved mockup "H3f Correction control
// mockup"): one small "Rate / correct" button at the right end of a host's footer, for the owner only and only while
// OWNER_CORRECTIONS is on, read once for every control on the page (the shared read below). It opens a popover under
// itself (a bottom sheet on a phone) and never navigates away; its one write is lib/corrections.ts postCorrection.
// No inline style strings: the popover's place is set on the element after it renders (CSSOM), never as markup.

// ------------------------------------------------------------------ the shared gate: one read for every control
let gate: Gate = HIDDEN;
const listeners = new Set<() => void>();
let timer: number | null = null;
let reading = false;
const emit = () => { for (const l of listeners) l(); };
function read() {
  if (reading || (typeof document !== "undefined" && document.hidden)) return;
  reading = true;
  // A failed read keeps the last answer (a blip never flickers the control); before any answer the control is hidden.
  get(FS_PATH).then((d) => { gate = gateOf(d); emit(); }, () => {}).finally(() => { reading = false; });
}
const onVisible = () => { if (!document.hidden) read(); };
function subscribe(l: () => void) {
  listeners.add(l);
  if (listeners.size === 1) {
    read();
    timer = window.setInterval(read, FS_POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    listeners.delete(l);
    if (!listeners.size && timer != null) { window.clearInterval(timer); timer = null; document.removeEventListener("visibilitychange", onVisible); }
  };
}
/** A 409 disabled: the switch was turned off while the page was open; the control hides until the read says on again. */
function switchedOff() { gate = { ...gate, on: false, show: false }; emit(); }
const useSharedGate = () => useSyncExternalStore(subscribe, () => gate, () => HIDDEN);
/** For the render check and tests: a gate given to every control below it instead of the shared read. */
export const GateOverride = createContext<Gate | null>(null);
/**
 * The owner gate of the shared read (the feature-switch GET's viewer.can_control: the owner's Access sub and the AI
 * Worker's own check), for a page's other owner-only controls (CF2: the Councils page's Approve and Reject). Omega's
 * /api/whoami can_control is true for any signed-in person, so it is not the owner gate.
 */
export function useOwnerGate(): boolean {
  const override = useContext(GateOverride);
  const shared = useSharedGate();
  return (override ?? shared).canControl;
}

// ------------------------------------------------------------------ the chips, until the page reloads (v1)
const sentByTarget = new Map<string, Sent>();

/** The mockup's icon: a speech box with a check (lucide 0.378 has no message-square-check). */
export function RateIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="m9 10 2 2 4-4" />
    </svg>
  );
}

/** The slot at the end of a footer row; a host whose control takes its own row passes ROW (the mockup's footer). */
const FOOT = "ml-auto inline-flex flex-wrap items-center justify-end gap-[8px]";
export const ROW = "flex w-full flex-wrap items-center justify-end gap-[8px]";
const RC = "inline-flex h-[26px] min-w-[26px] shrink-0 items-center justify-center rounded-[8px] border px-[6px] transition max-sm:h-[44px] max-sm:w-[44px] max-sm:rounded-[10px]";
const RC_IDLE = "border-white/10 bg-white/4 text-fg-2 hover:border-ok-fill/40 hover:bg-ok-fill/10 hover:text-fg";
const RC_OPEN = "border-ok-fill/50 bg-ok-fill/12 text-fg";

/**
 * The footer slot, pure: nothing unless the gate shows and the host has a target; else the chips of the last send (they
 * take their own line on a phone) and the icon button, its words in its label and tooltip.
 */
export function CorrectionFooter({ gate: g, target, sent, open = false, onOpen, buttonRef, className }: { gate: Gate; target: Target | null; sent: Sent | null; open?: boolean; onOpen?: () => void; buttonRef?: RefObject<HTMLButtonElement>; className?: string }) {
  if (!target || (!g.show && !open)) return null;
  return (
    <span className={className ?? FOOT}>
      {sent ? (
        <span className="flex flex-wrap justify-end gap-[6px] max-sm:order-2 max-sm:basis-full">
          {sentChips(sent).map((c) => <span key={c.text} className={clsx("chip", CHIP[c.tone])} title={sent.id ?? undefined}>{c.text}</span>)}
        </span>
      ) : null}
      <button ref={buttonRef} type="button" aria-label="Rate / correct" title="Rate / correct" aria-haspopup="dialog" aria-expanded={open} onClick={onOpen}
        className={clsx(RC, open ? RC_OPEN : RC_IDLE)}>
        <RateIcon className="h-[14px] w-[14px] max-sm:h-[18px] max-sm:w-[18px]" />
      </button>
    </span>
  );
}

export type Phase = "idle" | "sending" | "error" | "off";

const TONE_ON: Record<Rating, string> = { up: "border-ok-fill/50 bg-ok-fill/14 text-ok", down: "border-off-fill/55 bg-off-fill/16 text-slate-200" };
const PLAIN = "border-white/10 bg-white/4 text-fg-2";
const FIELD = "box-border w-full rounded-[6px] border bg-panel text-[12.5px] text-fg disabled:opacity-50";
const ERR_TONE = { fault: "border-fault-fill/35 bg-fault-fill/8 text-fault", late: "border-late-fill/35 bg-late-fill/8 text-late" } as const;

/**
 * The popover, pure (the render check draws every state): the Rate and Correct tabs, what is rated in small mono codes
 * (source, ref, subject, as of), the form, the inline error (role="alert", the form and text kept) or the off message.
 * Up is the ok cyan and down the off grey, never a direction colour (FS1's rule).
 */
export function CorrectionPanel({ target, draft, phase, error = null, sheet = false, onDraft, onSend, onClose, idBase = "rc" }: {
  target: Target; draft: Draft; phase: Phase; error?: ErrorText | null; sheet?: boolean; idBase?: string;
  onDraft?: (d: Draft) => void; onSend?: () => void; onClose?: () => void;
}) {
  const set = (p: Partial<Draft>) => onDraft?.({ ...draft, ...p });
  const busy = phase === "sending";
  const isRate = draft.tab === "rate";
  const field = phase === "error" ? error?.field ?? null : null;
  const long = over(draft);
  const count = draft.text.length;
  const pick = (r: Rating) => set({ rating: !isRate && draft.rating === r ? null : r });
  const tab = (t: Tab, label: string) => (
    <button type="button" role="tab" id={`${idBase}-tab-${t}`} aria-selected={draft.tab === t} aria-controls={`${idBase}-body`} onClick={() => set({ tab: t })}
      className={clsx("rounded-[6px] px-[12px] text-[12px] font-semibold", sheet ? "h-[40px]" : "h-[28px]", draft.tab === t ? "bg-ok-fill/12 text-white" : "text-fg-2 hover:text-fg")}>{label}</button>
  );
  const ratingBad = field === "rating";
  return (
    <div role="dialog" aria-label="Rate or correct this output" className={clsx("box-border flex flex-col gap-[14px] border border-white/12 bg-bar text-fg shadow-[0_18px_50px_rgba(0,0,0,0.55)]",
      sheet ? "w-full rounded-t-[16px] px-[16px] pt-[10px] pb-[20px]" : "w-[360px] max-w-[calc(100vw-24px)] rounded-[12px] p-[14px]")}>
      {sheet ? <div className="flex justify-center pt-[2px] pb-[10px]" aria-hidden="true"><span className="h-[4px] w-[36px] rounded-full bg-white/18" /></div> : null}
      <div className="flex items-center justify-between gap-[8px]">
        <div role="tablist" aria-label="Rate or correct" className="inline-flex gap-[2px] rounded-[8px] border border-white/10 bg-black/25 p-[2px]">
          {tab("rate", "Rate")}{tab("correct", "Correct")}
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className={clsx("inline-flex items-center justify-center rounded-[8px] text-fg-2 hover:text-fg", sheet ? "h-[44px] w-[44px]" : "h-[28px] w-[28px]")}><X className="h-[14px] w-[14px]" /></button>
      </div>
      <div aria-label="What is rated" className={clsx("mono flex flex-col gap-[2px] rounded-[8px] border bg-black/25 px-[10px] py-[8px] text-[10.5px] leading-[1.55]", field === "target" ? "border-fault-fill/60" : "border-white/6")}>
        <div className="flex gap-[8px]"><span className="w-[52px] shrink-0 text-muted">source</span><span className="text-fg">{target.source}</span></div>
        <div className="flex gap-[8px]"><span className="w-[52px] shrink-0 text-muted">ref</span><span className="min-w-0 break-all text-fg-2">{target.ref}</span></div>
        <div className="flex gap-[8px]"><span className="w-[52px] shrink-0 text-muted">subject</span><span className="min-w-0 break-all text-fg">{target.subject}</span></div>
        <div className="flex gap-[8px]"><span className="w-[52px] shrink-0 text-muted">as of</span><span className="text-fg-2">{asOfText(target)}</span></div>
      </div>
      {phase === "off" ? (
        <div role="alert" className="rounded-[10px] border border-off-fill/30 bg-off-fill/8 p-[12px] text-[12.5px] leading-[1.55] text-fg">
          <div className="mono mb-[4px] text-[11px] text-off">409 disabled</div>
          {OFF_WORDS} <a href="/#/switches" className="text-ok hover:underline">Settings › Feature switches</a>.
        </div>
      ) : (
        <div id={`${idBase}-body`} role="tabpanel" aria-labelledby={`${idBase}-tab-${draft.tab}`} className="flex flex-col gap-[12px]">
          {isRate ? (
            <div className="flex flex-col gap-[6px]">
              <span className="text-[11px] font-medium text-muted">Rating</span>
              <div className={clsx("flex gap-[8px]", ratingBad && "rounded-full ring-1 ring-fault-fill/60")}>
                {(["up", "down"] as const).map((r) => (
                  <button key={r} type="button" aria-pressed={draft.rating === r} disabled={busy} onClick={() => pick(r)}
                    className={clsx("mono inline-flex items-center gap-[6px] rounded-full border px-[14px] text-[12px] font-semibold disabled:opacity-50", sheet ? "h-[44px]" : "h-[32px]", draft.rating === r ? TONE_ON[r] : PLAIN)}>
                    {r === "up" ? <ThumbsUp className="h-[16px] w-[16px]" aria-hidden="true" /> : <ThumbsDown className="h-[16px] w-[16px]" aria-hidden="true" />}{r}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="flex flex-col gap-[6px]">
            <label htmlFor={`${idBase}-cat`} className="text-[11px] font-medium text-muted">{isRate ? "Category, optional" : "Category"}</label>
            <select id={`${idBase}-cat`} value={draft.category} disabled={busy} onChange={(e) => set({ category: e.target.value })} aria-invalid={field === "category" || field === "both"}
              className={clsx(FIELD, "px-[10px]", sheet ? "h-[44px]" : "h-[32px]", field === "category" || field === "both" ? "border-fault-fill/60" : "border-white/10")}>
              <option value="">No category</option>
              {CATEGORIES.map(([k, w]) => <option key={k} value={k}>{w}</option>)}
            </select>
          </div>
          {!isRate ? (
            <div className="flex flex-col gap-[6px]">
              <div className="flex items-center justify-between gap-[8px]">
                <label htmlFor={`${idBase}-txt`} className="inline-flex items-center gap-[6px] text-[11px] font-medium text-muted">What was wrong <Hint text={HINT} /></label>
                <span aria-live="polite" className={clsx("mono text-[11px] font-medium", long ? "text-fault" : count > 450 ? "text-late" : "text-muted")}>{count}/{TEXT_MAX}</span>
              </div>
              <textarea id={`${idBase}-txt`} value={draft.text} disabled={busy} rows={4} placeholder="Describe the level, do not type it" onChange={(e) => set({ text: e.target.value })}
                aria-invalid={field === "text" || field === "both" || long}
                className={clsx(FIELD, "resize-y px-[10px] py-[8px] leading-normal", sheet ? "min-h-[120px]" : "min-h-[88px]", field === "text" || field === "both" || long ? "border-fault-fill/60" : "border-white/10")} />
              <span className="text-[11px] text-muted">Prices are masked as [level].</span>
              {long ? <span role="alert" className="text-[11px] text-fault">Over 500 characters: shorten to send.</span> : null}
              <div className="mt-[2px] flex items-center gap-[8px]">
                <span className="text-[11px] text-muted">Rating, optional</span>
                {(["up", "down"] as const).map((r) => (
                  <button key={r} type="button" aria-pressed={draft.rating === r} aria-label={`Rating ${r}`} disabled={busy} onClick={() => pick(r)}
                    className={clsx("inline-flex items-center justify-center rounded-[8px] border disabled:opacity-50", sheet ? "h-[44px] w-[44px]" : "h-[28px] w-[28px]", draft.rating === r ? TONE_ON[r] : PLAIN, ratingBad && "border-fault-fill/60")}>
                    {r === "up" ? <ThumbsUp className="h-[14px] w-[14px]" aria-hidden="true" /> : <ThumbsDown className="h-[14px] w-[14px]" aria-hidden="true" />}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {phase === "error" && error ? (
            <div role="alert" className={clsx("rounded-[8px] border px-[10px] py-[8px] text-[12px] leading-normal", ERR_TONE[error.tone])}>
              <div className="mono mb-[2px] text-[11px]">{error.code}</div>
              <div className="text-fg">{error.words}</div>
            </div>
          ) : null}
          <div className="flex items-center justify-end gap-[8px]">
            <button type="button" disabled={busy || !canSend(draft)} onClick={onSend}
              className={clsx("rounded-[6px] border border-ok-fill/30 bg-ok-fill/10 px-[14px] text-[12px] font-semibold text-ok hover:bg-ok-fill/20 disabled:cursor-not-allowed disabled:opacity-40", sheet ? "h-[44px] flex-1" : "h-[32px]")}>
              {busy ? "Sending…" : isRate ? "Send rating" : "Send correction"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const PHONE = "(max-width: 639px)";
const isPhone = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE).matches;

/** The desktop popover's place: under its control, its right edge on the control's, kept on screen; above when it does not fit below. */
function place(panel: HTMLElement, button: HTMLElement) {
  const r = button.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const w = panel.offsetWidth, h = panel.offsetHeight;
  const left = Math.max(12, Math.min(r.right - w, vw - w - 12));
  const below = r.bottom + 6;
  const top = below + h <= vh - 12 || r.top - 6 - h < 12 ? below : r.top - 6 - h;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(Math.max(12, top))}px`;
}

/**
 * The control of one host. `target` comes from the host's own data (lib/corrections.ts engineTarget,
 * roomConclusionTarget, roomMessageTarget, councilOpinionTarget, councilOptionsTarget, strategyVerdictTarget); null hides it,
 * as does the gate. Esc or a click outside closes the popover.
 */
export function CorrectionControl({ target, className }: { target: Target | null; className?: string }) {
  const override = useContext(GateOverride);
  const shared = useSharedGate();
  const g = override ?? shared;
  const key = target ? targetKey(target) : "";
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft());
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<ErrorText | null>(null);
  const [sent, setSent] = useState<Sent | null>(() => (key ? sentByTarget.get(key) ?? null : null));
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const idBase = `rc${useId().replace(/[^A-Za-z0-9]/g, "")}`;
  useEffect(() => { setSent(key ? sentByTarget.get(key) ?? null : null); }, [key]);

  const close = () => { setOpen(false); if (phase !== "sending") { setPhase((p) => (p === "off" ? "idle" : p)); } buttonRef.current?.focus(); };
  const closeRef = useRef(close);
  closeRef.current = close;

  useLayoutEffect(() => {
    if (!open || sheet || !panelRef.current || !buttonRef.current) return;
    const p = panelRef.current, b = buttonRef.current;
    const again = () => place(p, b);
    again();
    window.addEventListener("resize", again);
    window.addEventListener("scroll", again, true);
    return () => { window.removeEventListener("resize", again); window.removeEventListener("scroll", again, true); };
  }, [open, sheet, phase, draft.tab, error]);
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [open]);

  if (!target) return null;
  const toggle = () => { if (open) { close(); return; } setSheet(isPhone()); if (phase === "off") setPhase("idle"); setOpen(true); };
  const send = async () => {
    if (phase === "sending" || !canSend(draft)) return;
    setPhase("sending");
    setError(null);
    const reply = await postCorrection(bodyOf(target, draft));
    if (reply.kind === "sent") {
      sentByTarget.set(key, reply.sent);
      setSent(reply.sent);
      setDraft(emptyDraft(draft.tab));
      setPhase("idle");
      setOpen(false);
      buttonRef.current?.focus();
    } else if (reply.kind === "off") {
      setPhase("off");
      switchedOff();
    } else {
      setError(errorOf(reply.status, reply.code));
      setPhase("error");
    }
  };
  const panel = (
    <CorrectionPanel target={target} draft={draft} phase={phase} error={error} sheet={sheet} idBase={idBase}
      onDraft={(d) => { setDraft(d); if (phase === "error") setPhase("idle"); }} onSend={() => { void send(); }} onClose={close} />
  );
  let layer: ReactNode = null;
  if (open && typeof document !== "undefined") {
    layer = createPortal(sheet ? (
      <>
        <div className="fixed inset-0 z-[60] bg-black/60" aria-hidden="true" />
        <div ref={panelRef} className="fixed inset-x-0 bottom-0 z-[61] max-h-[92dvh] overflow-y-auto">{panel}</div>
      </>
    ) : (
      <div ref={panelRef} className="fixed left-[12px] top-[12px] z-[61] max-h-[calc(100vh-24px)] overflow-y-auto rounded-[12px]">{panel}</div>
    ), document.body);
  }
  return (
    <>
      <CorrectionFooter gate={g} target={target} sent={sent} open={open} onOpen={toggle} buttonRef={buttonRef} className={className} />
      {layer}
    </>
  );
}
