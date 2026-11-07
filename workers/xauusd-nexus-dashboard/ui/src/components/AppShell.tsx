import { useEffect, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Activity, ExternalLink, FlaskConical, Home, Menu, ShieldCheck, Sparkles, Swords, X } from "lucide-react";
import { Dot } from "./ui";
import { useWarRoom } from "../lib/warroom";

// Same shell as the Cerebrum Console (cryptophys-cloud-platform workers/console/ui): Nexus joins
// the Console in phase 2 (ADR-0008), so its header, nav, glass panels and footer match.
export const NAV = [
  { label: "War Room", href: "#/", key: "", icon: Swords },
  { label: "Shadow versions", href: "#/shadow", key: "shadow", icon: FlaskConical },
];

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(t); }, []);
  return <span className="mono">{now.toISOString().slice(11, 19)} UTC</span>;
}

export default function AppShell({ current, children }: { current: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { room, error } = useWarRoom();
  const live = !error && !!room;

  const navLinks = (mobile: boolean) => NAV.map((item) => {
    const active = item.key === current;
    return (
      <a key={item.key} href={item.href} onClick={() => setOpen(false)} aria-current={active ? "page" : undefined}
        className={`inline-flex items-center gap-2 rounded-md border font-semibold transition ${mobile ? "px-4 py-3 text-[13px]" : "px-3 py-2 text-[12px]"} ${active ? "border-cyan-400/40 bg-cyan-400/10 text-white" : "border-transparent text-slate-400 hover:border-white/10 hover:bg-white/5 hover:text-white"}`}>
        <item.icon className={`h-4 w-4 ${active ? "text-cyan-300" : "text-slate-500"}`} />{item.label}
      </a>
    );
  });

  return (
    <div className="min-h-screen text-slate-100">
      <header className="border-b border-white/10 bg-obsidian-panel/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1680px] items-center gap-3 px-3 py-3 sm:px-6 sm:py-4">
          <a href="#/" className="flex items-center gap-3" aria-label="Nexus War Room">
            <motion.div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-400/40 bg-cyan-400/10 sm:h-11 sm:w-11"
              animate={{ boxShadow: ["0 0 0 rgba(34,211,238,0)", "0 0 22px rgba(34,211,238,0.35)", "0 0 0 rgba(34,211,238,0)"] }}
              transition={{ duration: 4, repeat: Infinity }}>
              <Activity className="h-4 w-4 text-cyan-300 sm:h-5 sm:w-5" />
            </motion.div>
            <div>
              <div className="text-xs uppercase tracking-[0.35em] text-cyan-300/80">Cryptophys Nexus</div>
              <div className="text-sm font-semibold text-white">XAUUSD Agent War Room</div>
            </div>
          </a>
          <div className="ml-auto hidden items-center gap-2 sm:flex">
            <span className="chip border-emerald-400/20 bg-emerald-400/10 text-emerald-300"><ShieldCheck className="h-3 w-3" />Advisory only</span>
            <span className={`chip ${live ? "border-amber-400/20 bg-amber-400/10 text-amber-200" : "border-rose-400/20 bg-rose-400/10 text-rose-300"}`}>
              <Dot tone={live ? "green" : "red"} pulse={live} />{live ? "Room live" : "Room offline"}
            </span>
            <span className="chip border-white/10 bg-white/[0.04] text-slate-300"><Clock /></span>
          </div>
          <button type="button" className="ml-auto rounded-md border border-white/10 bg-white/[0.04] p-2 text-slate-400 hover:text-white md:hidden"
            onClick={() => setOpen((o) => !o)} aria-label="Toggle navigation" aria-expanded={open}>
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </header>

      <nav className="border-b border-white/10 bg-obsidian-bar" aria-label="Nexus">
        <div className="mx-auto flex max-w-[1680px] items-center gap-2 px-3 py-3 sm:px-6">
          <div className="hidden flex-wrap items-center gap-1 md:flex">{navLinks(false)}</div>
          <div className="flex items-center gap-2 md:hidden">
            {NAV.filter((n) => n.key === current).map((n) => <span key={n.key} className="inline-flex items-center gap-2 text-[12px] font-semibold text-white"><n.icon className="h-4 w-4 text-cyan-300" />{n.label}</span>)}
          </div>
          <div className="ml-auto hidden items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] uppercase tracking-[0.2em] text-slate-500 lg:flex">
            <Sparkles className="h-3.5 w-3.5 text-cyan-300" />Observe → discuss → conclude → attest
          </div>
        </div>
        {open && (
          <div className="mx-auto flex max-w-[1680px] flex-col gap-1 px-3 pb-3 md:hidden">
            {navLinks(true)}
            <a href="https://console.cryptophys.work" className="inline-flex items-center gap-3 rounded-md px-4 py-3 text-[13px] font-semibold text-slate-400 hover:text-white"><Home className="h-4 w-4 text-slate-500" />Cerebrum Console</a>
          </div>
        )}
      </nav>

      {children}

      <footer className="sticky bottom-0 z-20 border-t border-white/10 bg-obsidian-foot/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1680px] items-center gap-4 overflow-x-auto px-3 py-3 text-[11px] font-medium uppercase tracking-[0.2em] text-slate-500 sm:px-6">
          {["War Room 15m", "Threads D1 · 4H · 1H", "News Daily", "Local engines", "Parity", "Workers AI", "D1"].map((s) => <span key={s} className="whitespace-nowrap">{s}</span>)}
          <a href="https://console.cryptophys.work" target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 whitespace-nowrap text-cyan-300/80 hover:text-cyan-200">Console <ExternalLink className="h-3 w-3" /></a>
        </div>
      </footer>
    </div>
  );
}
