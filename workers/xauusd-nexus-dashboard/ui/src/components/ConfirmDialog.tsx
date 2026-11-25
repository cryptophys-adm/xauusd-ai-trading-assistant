import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";

/** A themed confirmation (owner 2026-11-17: pop-ups follow the main theme instead of the browser's own dialog). */
export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * The confirm button's meaning, in the status tones (mockup "Nexus colours and text"): ok (cyan) to approve or
   * accept, late (amber) for a step to think twice about, fault (red) for a destructive one. Green is for a buy or
   * a bullish action only, and no dialog asks for one.
   */
  tone?: "ok" | "late" | "fault";
  /**
   * FS1: text the person types before the confirm button works (an emergency stop's key on the Feature switches page).
   * Absent: the dialog is as before.
   */
  typed?: string;
}

/** Border, glow, icon and button per tone: the tokens' fills (#22d3ee, #fbbf24, #ef4444) and text colours. */
const TONES = {
  ok: { border: "border-ok-fill/40", glow: "shadow-[0_0_60px_rgba(34,211,238,0.18)]", icon: "border-ok-fill/40 bg-ok-fill/10 text-ok", button: "bg-ok-fill/20 text-ok ring-ok-fill/50 hover:bg-ok-fill/30" },
  late: { border: "border-late-fill/40", glow: "shadow-[0_0_60px_rgba(251,191,36,0.18)]", icon: "border-late-fill/40 bg-late-fill/10 text-late", button: "bg-late-fill/20 text-late ring-late-fill/50 hover:bg-late-fill/30" },
  fault: { border: "border-fault-fill/40", glow: "shadow-[0_0_60px_rgba(239,68,68,0.22)]", icon: "border-fault-fill/40 bg-fault-fill/10 text-fault", button: "bg-fault-fill/20 text-fault ring-fault-fill/50 hover:bg-fault-fill/30" }
} as const;

export function ConfirmDialog({ options, onDone }: { options: ConfirmOptions; onDone: (ok: boolean) => void }) {
  const t = TONES[options.tone ?? "ok"];
  const confirmRef = useRef<HTMLButtonElement>(null);
  const typedRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const ready = options.typed == null || text === options.typed;
  useEffect(() => {
    (options.typed != null ? typedRef.current : confirmRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDone(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone, options.typed]);
  const Icon = options.tone === "fault" || options.tone === "late" ? AlertTriangle : CheckCircle2;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md" onClick={() => onDone(false)}>
      <div role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}
        className={`relative w-full max-w-md rounded-2xl border ${t.border} bg-linear-to-b from-panel to-ground p-5 ring-1 ring-white/10 ${t.glow}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${t.icon}`}><Icon className="h-5 w-5" /></div>
            <h3 id="confirm-title" className="text-[15px] font-bold text-fg">{options.title}</h3>
          </div>
          <button type="button" onClick={() => onDone(false)} title="Cancel" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button>
        </div>
        {options.body ? <div className="mt-4 rounded-xl border border-white/10 bg-black/40 p-3.5 text-[12.5px] leading-relaxed text-slate-300">{options.body}</div> : null}
        {options.typed != null ? (
          <div className="mt-3">
            <label htmlFor="confirm-typed" className="block text-[11.5px] font-medium text-fault">Type the key to confirm</label>
            <input id="confirm-typed" ref={typedRef} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false}
              onKeyDown={(e) => { if (e.key === "Enter" && ready) onDone(true); }}
              className="mono mt-1.5 w-full rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-[12px] text-fg outline-hidden focus:border-fault-fill/50" />
          </div>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => onDone(false)} className="rounded-lg px-3.5 py-1.5 text-[12.5px] font-semibold text-slate-300 ring-1 ring-slate-600/60 transition hover:bg-white/5 hover:text-white">{options.cancelLabel ?? "Cancel"}</button>
          <button ref={confirmRef} type="button" disabled={!ready} onClick={() => { if (ready) onDone(true); }} className={`rounded-lg px-3.5 py-1.5 text-[12.5px] font-semibold ring-1 transition disabled:cursor-not-allowed disabled:opacity-40 ${t.button}`}>{options.confirmLabel ?? "Confirm"}</button>
        </div>
      </div>
    </div>
  );
}

/** `const [confirm, dialog] = useConfirm()`: `await confirm({...})` resolves true or false; render `dialog` once. */
export function useConfirm(): [(o: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ options, resolve })), []);
  const done = useCallback((ok: boolean) => { setPending((p) => { p?.resolve(ok); return null; }); }, []);
  return [confirm, pending ? <ConfirmDialog options={pending.options} onDone={done} /> : null];
}
