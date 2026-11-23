import { AlertTriangle, ShieldAlert, X } from "lucide-react";
import { CHIP, directionTone } from "../lib/tokens";

export interface ExitTargetPosition {
  ticket: number;
  symbol?: string;
  side?: string;
  volume?: number;
  open_price?: number;
  profit?: number;
  sl?: number;
  tp?: number;
  currency?: string;
}

interface ExitConfirmModalProps {
  position: ExitTargetPosition | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (ticket: number) => Promise<void> | void;
  isSubmitting?: boolean;
}

export function ExitConfirmModal({
  position,
  isOpen,
  onClose,
  onConfirm,
  isSubmitting = false,
}: ExitConfirmModalProps) {
  if (!isOpen || !position) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-150">
      <div
        className="relative w-full max-w-md rounded-2xl border border-fault-fill/40 bg-linear-to-b from-panel to-ground p-5 shadow-[0_0_60px_rgba(239,68,68,0.22)] ring-1 ring-white/10"
        role="dialog"
        aria-modal="true"
        aria-labelledby="exit-modal-title"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-fault-fill/40 bg-fault-fill/10 text-fault">
              <ShieldAlert className="h-6 w-6 text-fault animate-pulse" />
            </div>
            <div>
              <h3 id="exit-modal-title" className="text-[15px] font-bold text-fg">
                Close position
              </h3>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition disabled:opacity-50"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Position Details Card */}
        <div className="mt-4 rounded-xl border border-white/10 bg-black/40 p-3.5 space-y-2 text-[12px]">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted">Ticket</span>
            <span className="mono font-bold text-fg">#{position.ticket}</span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted">Position</span>
            <div className="flex items-center gap-2">
              <span className="mono font-semibold text-slate-200">{position.symbol || "gold"}</span>
              <span
                className={`mono font-bold px-1.5 py-0.5 rounded text-[11px] border ${CHIP[directionTone(position.side)]}`}
              >
                {position.side || "POSITION"} {position.volume ? `${position.volume} lots` : ""}
              </span>
            </div>
          </div>

          {position.open_price != null && (
            <div className="flex items-center justify-between text-[11.5px]">
              <span className="text-[11px] font-medium text-muted">Open price</span>
              <span className="mono text-slate-200">{Number(position.open_price).toFixed(2)}</span>
            </div>
          )}

          {position.profit != null && (
            <div className="flex items-center justify-between pt-1.5 border-t border-white/5">
              <span className="text-[11px] font-medium text-muted">Floating P&L</span>
              <span
                className={`mono font-extrabold text-[13px] ${
                  position.profit >= 0 ? "text-bull" : "text-bear"
                }`}
              >
                {position.profit >= 0 ? "+" : ""}${Number(position.profit).toFixed(2)} {position.currency || "USD"}
              </span>
            </div>
          )}
        </div>

        {/* Warning Banner */}
        <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-late-fill/30 bg-late-fill/10 p-2.5 text-[11px] text-late leading-relaxed">
          <AlertTriangle className="h-4 w-4 shrink-0 text-late mt-0.5" />
          <span>
            Closes at market now. The position's SL and TP are cancelled.
          </span>
        </div>

        {/* Modal Actions */}
        <div className="mt-5 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="btn rounded-lg px-3.5 py-2 text-[12px] font-semibold text-slate-300 hover:text-white transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(position.ticket)}
            disabled={isSubmitting}
            className="inline-flex items-center gap-2 rounded-lg border border-fault-fill/60 bg-fault-fill/20 px-4 py-2 text-[12px] font-bold text-fault hover:bg-fault-fill/30 active:scale-95 transition disabled:opacity-50"
          >
            {isSubmitting ? (
              <>
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-white animate-ping" />
                Closing…
              </>
            ) : (
              <>
                Close at market
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
