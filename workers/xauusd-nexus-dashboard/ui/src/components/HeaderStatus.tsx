import { useEffect, useState, type MouseEvent } from "react";
import clsx from "clsx";
import { clockParts, type Cell, type OmegaCell, type Tone } from "../lib/headerStatus";

/** Tone classes: cyan ok, amber late, red fault, grey off. Green stays for bullish only, so the header never uses it. */
const TEXT: Record<Tone, string> = { ok: "text-cyan-300", late: "text-amber-300", fault: "text-red-400", off: "text-slate-400" };
const DOT: Record<Tone, string> = { ok: "border-cyan-400 bg-cyan-400", late: "border-amber-400 bg-amber-400", fault: "border-red-500 bg-red-500", off: "border-slate-400 bg-slate-400" };

function StatusDot({ tone, filled = true }: { tone: Tone; filled?: boolean }) {
  return <span aria-hidden="true" className={clsx("inline-block h-[7px] w-[7px] shrink-0 rounded-full border-[1.5px]", DOT[tone], !filled && "bg-transparent")} />;
}

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(t); }, []);
  return now;
}

type Nav = (e: MouseEvent<HTMLAnchorElement>, href: string) => void;
const cellCls = "flex min-h-[40px] items-center gap-2 px-3.5 transition hover:bg-white/5 hover:text-white";
const divider = "border-l border-white/10";

/** Desktop (sm and up): one strip of three cells, room, Omega, clock. */
export function StatusStrip({ room, omega, omegaActive, navigate }: { room: Cell; omega: OmegaCell; omegaActive: boolean; navigate: Nav }) {
  const c = clockParts(useNow());
  return (
    <div className="mono flex items-stretch overflow-hidden rounded-lg border border-white/10 text-[12px]">
      <a href="/#/" onClick={(e) => navigate(e, "/#/")} title={room.title} className={cellCls}>
        <span className="text-slate-400">15m</span>
        <StatusDot tone={room.tone} />
        <span className={clsx("font-semibold", TEXT[room.tone])}>{room.code}</span>
        {room.detail && <span className="text-slate-300">{room.detail}</span>}
      </a>
      <a href="/#/omega" onClick={(e) => navigate(e, "/#/omega")} title={omega.title} aria-current={omegaActive ? "page" : undefined}
        className={clsx(cellCls, divider, omegaActive && "bg-cyan-400/10")}>
        <span className="text-slate-400">Omega</span>
        <StatusDot tone={omega.tone} filled={omega.filled} />
        <span className={clsx("font-semibold", omega.code === "READY" ? "text-slate-100" : TEXT[omega.tone])}>{omega.code}</span>
        {omega.positions != null && <span className="text-slate-300">{omega.positions} pos</span>}
        {omega.broker && <span className="max-w-40 truncate text-slate-400">{omega.broker}</span>}
      </a>
      <div className={clsx("flex min-h-[40px] items-center gap-2.5 px-3.5", divider)}>
        <span><span className="font-medium text-slate-100">{c.utc}</span> <span className="text-slate-400">UTC</span></span>
        <span><span className="text-slate-300">{c.local}</span> <span className="text-slate-400">{c.zone}</span></span>
      </div>
    </div>
  );
}

/** Phone (below sm): the same three cells as a row under the logo, in short codes. */
const SHORT: Record<string, string> = { BEHIND: "", OFFLINE: "OFF", CLOSED: "CLSD", ARMED: "ARM", READY: "RDY", "NO BRIDGE": "NO BR" };
export function StatusRow({ room, omega, omegaActive, navigate }: { room: Cell; omega: OmegaCell; omegaActive: boolean; navigate: Nav }) {
  const c = clockParts(useNow());
  const roomCode = room.code === "BEHIND" ? room.detail ?? "LATE" : SHORT[room.code] ?? room.code;
  const cell = "flex min-h-[44px] items-center justify-center gap-1.5";
  return (
    <div className="mono grid grid-cols-3 border-t border-white/10 text-[12px] sm:hidden">
      <a href="/#/" onClick={(e) => navigate(e, "/#/")} title={room.title} className={cell}>
        <span className="text-slate-400">15m</span>
        <StatusDot tone={room.tone} />
        <span className={clsx("font-semibold", TEXT[room.tone])}>{roomCode}</span>
      </a>
      <a href="/#/omega" onClick={(e) => navigate(e, "/#/omega")} title={omega.title} aria-current={omegaActive ? "page" : undefined}
        className={clsx(cell, divider, omegaActive && "bg-cyan-400/10")}>
        <span className="text-slate-400">Ω</span>
        <StatusDot tone={omega.tone} filled={omega.filled} />
        <span className={clsx("font-semibold", omega.code === "READY" ? "text-slate-100" : TEXT[omega.tone])}>{SHORT[omega.code] ?? omega.code}</span>
        {omega.positions != null && <span className="text-slate-300">{omega.positions}</span>}
      </a>
      <div className={clsx(cell, divider)} title={`${c.utc} UTC, ${c.local} ${c.zone}`}>
        <span className="font-medium text-slate-100">{c.utcShort}Z</span>
        <span className="text-slate-400">{c.local}</span>
      </div>
    </div>
  );
}
