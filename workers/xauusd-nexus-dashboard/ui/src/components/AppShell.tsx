import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Activity, BellRing, BookOpenCheck, Brain, CalendarDays, ExternalLink, FlaskConical, GitCompareArrows, GraduationCap, Home, LineChart, Menu, ShieldCheck, Sparkles, Swords, Trophy, X, Zap } from "lucide-react";
import { Dot } from "./ui";
import { useWarRoom } from "../lib/warroom";
import { marketClosed } from "../lib/health";

// Same header, glass panels and footer as the Cerebrum Console (cryptophys-cloud-platform
// workers/console/ui; Nexus joins the Console in phase 2, ADR-0008). Navigation is a grouped left
// sidebar (owner request 2026-11-07) so each analytic layer has its own page; layers still being
// built are listed as "soon" and are not links.
type NavItem = { label: string; href: string; key: string; icon: typeof Swords; soon?: boolean };
export const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  { title: "Live", items: [{ label: "War Room", href: "/#/", key: "", icon: Swords }, { label: "System status", href: "/#/status", key: "status", icon: Activity }] },
  // Omega (owner decisions 2026-11-09): rendered in the main pane beside the left sidebar (#/omega and /omega/) behind the same Cloudflare Access sign-in; /omega/api/* forwards to xauusd-omega.
  { title: "Execution", items: [{ label: "Omega", href: "/#/omega", key: "omega", icon: Zap }] },
  { title: "Analytics", items: [
    { label: "Performance", href: "/#/performance", key: "performance", icon: LineChart },
    { label: "Scorecards", href: "/#/scorecards", key: "scorecards", icon: Trophy },
    { label: "Shadow versions", href: "/#/shadow", key: "shadow", icon: FlaskConical }
  ] },
  { title: "Market", items: [
    { label: "Economic calendar", href: "/#/calendar", key: "calendar", icon: CalendarDays },
    { label: "Macro War Room", href: "/#/correlations", key: "correlations", icon: GitCompareArrows }
  ] },
  { title: "Intelligence", items: [
    { label: "Aether", href: "/aether", key: "aether", icon: Brain },
    // How the platform learns from its own decisions (owner 2026-11-13: "pastikan semua ada visualisasi").
    { label: "Model & Learning", href: "/#/model", key: "model", icon: GraduationCap },
    { label: "Decision audit", href: "/#/audit", key: "audit", icon: BookOpenCheck },
    { label: "Alerts", href: "/#/alerts", key: "alerts", icon: BellRing }
  ] }
];
export const NAV = NAV_GROUPS.flatMap((g) => g.items).filter((i) => !i.soon);

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(t); }, []);
  return <span className="mono">{now.toISOString().slice(11, 19)} UTC</span>;
}

export default function AppShell({ current, children }: { current: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { room, error } = useWarRoom();
  // "Room live" only while the 15m room is current (owner 2026-11-13: not green on an old room).
  const roomMs = Date.parse(String(room?.bar_close ?? room?.bar_time ?? ""));
  const closed = marketClosed();
  const live = !error && !!room && Number.isFinite(roomMs) && Date.now() - roomMs < 45 * 60_000;

  const navigate = (e: MouseEvent<HTMLAnchorElement>, href: string) => {
    setOpen(false);
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    window.history.pushState(null, "", href);
    window.dispatchEvent(new Event("popstate"));
  };

  const sideNav = (mobile: boolean) => (
    <div className="flex flex-col gap-4">
      {NAV_GROUPS.map((g) => (
        <div key={g.title}>
          <div className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">{g.title}</div>
          <div className="flex flex-col gap-0.5">
            {g.items.map((item) => {
              const active = !item.soon && item.key === current;
              const cls = `flex items-center gap-2.5 rounded-md border font-semibold transition ${mobile ? "px-4 py-3 text-[13px]" : "px-3 py-2 text-[12px]"}`;
              if (item.soon) return (
                <span key={item.key} className={`${cls} cursor-default border-transparent text-slate-600`} aria-disabled="true">
                  <item.icon className="h-4 w-4 text-slate-700" />{item.label}<span className="ml-auto rounded border border-white/10 px-1.5 text-[9px] uppercase tracking-[0.15em] text-slate-500">soon</span>
                </span>
              );
              return (
                <a key={item.key} href={item.href} onClick={(e) => navigate(e, item.href)} aria-current={active ? "page" : undefined}
                  className={`${cls} ${active ? "border-cyan-400/40 bg-cyan-400/10 text-white" : "border-transparent text-slate-400 hover:border-white/10 hover:bg-white/5 hover:text-white"}`}>
                  <item.icon className={`h-4 w-4 ${active ? "text-cyan-300" : "text-slate-500"}`} />{item.label}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className="min-h-screen text-slate-100">
      <header className="border-b border-white/10 bg-obsidian-panel/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1680px] items-center gap-3 px-3 py-3 sm:px-6 sm:py-4">
          <a href="/#/" onClick={(e) => navigate(e, "/#/")} className="flex items-center gap-3" aria-label="Nexus War Room">
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
            <a href="/#/omega" onClick={(e) => navigate(e, "/#/omega")}
              className={`chip transition ${current === "omega" ? "border-cyan-400/40 bg-cyan-400/20 text-cyan-200" : "border-cyan-400/20 bg-cyan-400/10 text-cyan-300 hover:border-cyan-400/40 hover:text-white"}`}
              title="MetaTrader 5 live execution bridge and terminal">
              <Zap className="h-3 w-3 text-cyan-300" />
              <span>{current === "omega" ? "MT5 Live" : "MT5 Execution"}</span>
            </a>
            <span className="chip border-emerald-400/20 bg-emerald-400/10 text-emerald-300"><ShieldCheck className="h-3 w-3" />{current === "omega" ? "Execution · Access protected" : "Advisory only"}</span>
            <span className={`chip ${live ? "border-amber-400/20 bg-amber-400/10 text-amber-200" : "border-rose-400/20 bg-rose-400/10 text-rose-300"}`}>
              <Dot tone={live ? "green" : closed ? "slate" : "red"} pulse={live} />{live ? "Room live" : closed ? "Market closed" : !room ? "Room offline" : "Room behind"}
            </span>
            <span className="chip border-white/10 bg-white/[0.04] text-slate-300"><Clock /></span>
          </div>
          <button type="button" className="ml-auto rounded-md border border-white/10 bg-white/[0.04] p-2 text-slate-400 hover:text-white md:hidden"
            onClick={() => setOpen((o) => !o)} aria-label="Toggle navigation" aria-expanded={open}>
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </header>

      {open && (
        <nav className="border-b border-white/10 bg-obsidian-bar px-3 py-3 md:hidden" aria-label="Nexus">
          {sideNav(true)}
          <a href="https://nexus.cryptophys.work/console/" className="mt-2 inline-flex items-center gap-3 rounded-md px-4 py-3 text-[13px] font-semibold text-slate-400 hover:text-white"><Home className="h-4 w-4 text-slate-500" />Cerebrum Console</a>
        </nav>
      )}

      <div className="flex">
        <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col justify-between overflow-y-auto border-r border-white/10 bg-obsidian-bar px-2 py-4 md:flex" aria-label="Nexus">
          {sideNav(false)}
          <div className="mt-6 flex items-center gap-2 px-3 text-[10px] uppercase tracking-[0.2em] text-slate-500">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-cyan-300" />Observe → discuss → conclude → attest
          </div>
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>

      <footer className="sticky bottom-0 z-20 border-t border-white/10 bg-obsidian-foot/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1680px] items-center gap-4 overflow-x-auto px-3 py-3 text-[11px] font-medium uppercase tracking-[0.2em] text-slate-500 sm:px-6">
          {["War Room 15m", "Threads D1 · 4H · 1H", "News Daily", "Local engines", "Parity", "Workers AI", "D1"].map((s) => <span key={s} className="whitespace-nowrap">{s}</span>)}
          <a href="https://nexus.cryptophys.work/console/" target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 whitespace-nowrap text-cyan-300/80 hover:text-cyan-200">Console <ExternalLink className="h-3 w-3" /></a>
        </div>
      </footer>
    </div>
  );
}
