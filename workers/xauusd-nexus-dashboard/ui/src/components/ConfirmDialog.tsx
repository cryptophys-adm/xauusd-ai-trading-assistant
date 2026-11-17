import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";

/** A themed confirmation (owner 2026-11-17: pop-ups follow the main theme instead of the browser's own dialog). */
export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "cyan" | "emerald" | "amber" | "rose";
}

const TONES = {
  cyan: { border: "border-cyan-400/40", glow: "shadow-[0_0_60px_rgba(34,211,238,0.18)]", icon: "border-cyan-400/40 bg-cyan-400/10 text-cyan-300", button: "bg-cyan-500/20 text-cyan-100 ring-cyan-400/50 hover:bg-cyan-500/30" },
  emerald: { border: "border-emerald-400/40", glow: "shadow-[0_0_60px_rgba(52,211,153,0.18)]", icon: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300", button: "bg-emerald-500/20 text-emerald-100 ring-emerald-400/50 hover:bg-emerald-500/30" },
  amber: { border: "border-amber-400/40", glow: "shadow-[0_0_60px_rgba(251,191,36,0.18)]", icon: "border-amber-400/40 bg-amber-400/10 text-amber-300", button: "bg-amber-500/20 text-amber-100 ring-amber-400/50 hover:bg-amber-500/30" },
  rose: { border: "border-rose-500/40", glow: "shadow-[0_0_60px_rgba(244,63,94,0.22)]", icon: "border-rose-500/40 bg-rose-500/10 text-rose-300", button: "bg-rose-500/20 text-rose-100 ring-rose-400/50 hover:bg-rose-500/30" }
} as const;

function ConfirmDialog({ options, onDone }: { options: ConfirmOptions; onDone: (ok: boolean) => void }) {
  const t = TONES[options.tone ?? "cyan"];
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDone(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);
  const Icon = options.tone === "rose" || options.tone === "amber" ? AlertTriangle : CheckCircle2;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md" onClick={() => onDone(false)}>
      <div role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}
        className={`relative w-full max-w-md rounded-2xl border ${t.border} bg-linear-to-b from-[#0e1628] via-[#09101d] to-[#060a12] p-5 ring-1 ring-white/10 ${t.glow}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${t.icon}`}><Icon className="h-5 w-5" /></div>
            <h3 id="confirm-title" className="text-[15px] font-bold tracking-wide text-white">{options.title}</h3>
          </div>
          <button type="button" onClick={() => onDone(false)} title="Cancel" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button>
        </div>
        {options.body ? <div className="mt-4 rounded-xl border border-white/10 bg-black/40 p-3.5 text-[12.5px] leading-relaxed text-slate-300">{options.body}</div> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => onDone(false)} className="rounded-lg px-3.5 py-1.5 text-[12.5px] font-semibold text-slate-300 ring-1 ring-slate-600/60 transition hover:bg-white/5 hover:text-white">{options.cancelLabel ?? "Cancel"}</button>
          <button ref={confirmRef} type="button" onClick={() => onDone(true)} className={`rounded-lg px-3.5 py-1.5 text-[12.5px] font-semibold ring-1 transition ${t.button}`}>{options.confirmLabel ?? "Confirm"}</button>
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
