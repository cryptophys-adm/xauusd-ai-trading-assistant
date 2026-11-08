import { AlertTriangle } from "lucide-react";
import { Dot } from "./ui";
import { useSystemHealth } from "../lib/health";

/**
 * War Room: only what needs attention (owner request 2026-11-08). The full Worker status and parity
 * live on the System status page; this panel appears only when a lane is amber or red.
 */
export default function SystemIssues() {
  const { items } = useSystemHealth();
  const issues = items.filter((i) => i.tone === "red" || i.tone === "amber");
  if (!issues.length) return null;
  return (
    <a href="#/status" className="glass block border-rose-400/20 p-4 transition hover:border-rose-300/40">
      <div className="eyebrow mb-2 flex items-center gap-2"><AlertTriangle className="h-3 w-3 text-rose-300" />System issues</div>
      <div className="space-y-1.5">
        {issues.map((i) => (
          <div key={i.key} className="flex items-start gap-2 text-[11.5px]">
            <span className="mt-1.5"><Dot tone={i.tone} pulse /></span>
            <span><b className="text-slate-100">{i.label}</b> <span className="text-slate-400">{i.detail}</span></span>
          </div>
        ))}
      </div>
      <div className="mt-2 text-[10.5px] text-cyan-300">Open System status →</div>
    </a>
  );
}
