import { useState, type MouseEvent, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Activity, BellRing, BookOpenCheck, Brain, CalendarDays, Droplets, ExternalLink, FlaskConical, GitCompareArrows, GraduationCap, Home, Layers, LineChart, Menu, Puzzle, Shapes, Sunrise, Swords, ToggleRight, Trophy, Users, X, Zap, Cpu } from "lucide-react";
import { StatusRow, StatusStrip } from "./HeaderStatus";
import { omegaCell, roomCell } from "../lib/headerStatus";
import { useWarRoom } from "../lib/warroom";
import { useOmegaStatus } from "../lib/omega";
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
  // Call for Councils (owner 2026-11-16: "jangan ditampilkan di omega, buat menu navigator sendiri Call for Councils"):
  // its own navigator item, never part of the Omega page (docs/RFC_CALL_FOR_COUNCILS.md).
  { title: "Councils", items: [{ label: "Call for Councils", href: "/#/councils", key: "councils", icon: Users }] },
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
    { label: "Aether", href: "/#/aether", key: "aether", icon: Brain },
    // How the platform learns from its own decisions (owner 2026-11-13: "pastikan semua ada visualisasi").
    { label: "Model & Learning", href: "/#/model", key: "model", icon: GraduationCap },
    { label: "Strategy agents", href: "/#/strategy", key: "strategy", icon: Puzzle },
    // Track C (owner 2026-11-22: the opening range, chart patterns and liquidity each get their own Intelligence page):
    // Opening range (Track C4), the London and New York opening ranges and the ORB agent's plans, directly after
    // Strategy agents; Chart patterns (Track C3), the Projection Agent's patterns, their measured record and the pattern
    // agents' plans; Liquidity (Track C2), lens B of the Positioning & Liquidity analyst on its own page.
    { label: "Opening range", href: "/#/orb", key: "orb", icon: Sunrise },
    { label: "Chart patterns", href: "/#/patterns", key: "patterns", icon: Shapes },
    { label: "Liquidity", href: "/#/liquidity", key: "liquidity", icon: Droplets },
    // Zones (ZN1, owner 2026-11-25: "setuju mockup ZN1"): Z5's demand and supply zones, the zone breaker and its record.
    { label: "Zones", href: "/#/zones", key: "zones", icon: Layers },
    { label: "Neuron allocation", href: "/#/neurons", key: "neurons", icon: Cpu },
    { label: "Decision audit", href: "/#/audit", key: "audit", icon: BookOpenCheck },
    { label: "Alerts", href: "/#/alerts", key: "alerts", icon: BellRing }
  ] },
  // FS1 (owner 2026-11-25: "panel khusus pengaturan on off untuk semua fitur ini"): the owner's feature switches, the last
  // group, on their own page (#/switches). The Omega page keeps its own settings.
  { title: "Settings", items: [{ label: "Feature switches", href: "/#/switches", key: "switches", icon: ToggleRight }] }
];
export const NAV = NAV_GROUPS.flatMap((g) => g.items).filter((i) => !i.soon);

export default function AppShell({ current, children }: { current: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { room, error } = useWarRoom();
  // The header cells (lib/headerStatus.ts): LIVE only while the 15m room is current (owner 2026-11-13: never on an old room).
  const roomMs = Date.parse(String(room?.bar_close ?? room?.bar_time ?? ""));
  const roomStatus = roomCell({ barMs: roomMs, hasRoom: !!room, error: !!error, closed: marketClosed() });
  // DEF-10 (UI audit 2026-11-14): the Omega badge from a light status read (one bridge row), every 60 s while
  // the page is visible; never the full overview (ADR-0015 resource audit).
  const omega = omegaCell(useOmegaStatus());

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
          <div className="mb-1.5 px-3 text-[11px] font-medium text-muted">{g.title}</div>
          <div className="flex flex-col gap-0.5">
            {g.items.map((item) => {
              const active = !item.soon && item.key === current;
              const cls = `flex items-center gap-2.5 rounded-md border font-semibold transition ${mobile ? "px-4 py-3 text-[13px]" : "px-3 py-2 text-[12px]"}`;
              if (item.soon) return (
                <span key={item.key} className={`${cls} cursor-default border-transparent text-slate-600`} aria-disabled="true">
                  <item.icon className="h-4 w-4 text-slate-700" />{item.label}<span className="ml-auto rounded-sm border border-white/10 px-1.5 text-[10px] text-muted">soon</span>
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
      <header className="border-b border-white/10 bg-obsidian-panel/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1680px] items-center gap-3 px-3 py-3 sm:px-6 sm:py-4">
          <a href="/#/" onClick={(e) => navigate(e, "/#/")} className="flex items-center gap-3" aria-label="Nexus War Room">
            <motion.div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-400/40 bg-cyan-400/10 sm:h-11 sm:w-11"
              animate={{ boxShadow: ["0 0 0 rgba(34,211,238,0)", "0 0 22px rgba(34,211,238,0.35)", "0 0 0 rgba(34,211,238,0)"] }}
              transition={{ duration: 4, repeat: Infinity }}>
              <Activity className="h-4 w-4 text-cyan-300 sm:h-5 sm:w-5" />
            </motion.div>
            <div className="flex items-baseline gap-2.5">
              <span className="text-[15px] font-semibold text-white">Nexus</span>
              <span className="hidden text-[13px] text-slate-400 min-[420px]:inline">XAUUSD War Room</span>
            </div>
          </a>
          <div className="ml-auto hidden sm:flex">
            <StatusStrip room={roomStatus} omega={omega} omegaActive={current === "omega"} navigate={navigate} />
          </div>
          <button type="button" className="ml-auto flex h-[44px] w-[44px] items-center justify-center rounded-lg border border-white/10 bg-white/4 text-slate-300 hover:text-white sm:ml-0 md:hidden"
            onClick={() => setOpen((o) => !o)} aria-label="Toggle navigation" aria-expanded={open}>
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
        <StatusRow room={roomStatus} omega={omega} omegaActive={current === "omega"} navigate={navigate} />
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
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>

      <footer className="sticky bottom-0 z-20 border-t border-white/10 bg-obsidian-foot/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1680px] items-center gap-4 overflow-x-auto px-3 py-3 text-[11px] font-medium text-muted sm:px-6">
          <a href="https://nexus.cryptophys.work/console/" target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 whitespace-nowrap text-cyan-300/80 hover:text-cyan-200">Console <ExternalLink className="h-3 w-3" /></a>
        </div>
      </footer>
    </div>
  );
}
