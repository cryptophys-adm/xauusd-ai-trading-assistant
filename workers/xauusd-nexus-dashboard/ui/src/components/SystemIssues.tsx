import { AlertTriangle } from "lucide-react";
import { Dot, phaseOf } from "./ui";
import { useSystemHealth } from "../lib/health";

/**
 * War Room: only what needs attention (owner request 2026-11-08). The full Worker status lives on the
 * System status page; this panel appears only when a lane is late (amber) or a fault (red).
 */
export default function SystemIssues() {
  const { items, poll, lanePoll } = useSystemHealth();
  // Review of #520: a failed or stale /api/status is an issue too (its rows are missing or old), never silence; so is
  // a failed or stale /api/local-lane (re-review: the pull adapter's rows), as System status lists it.
  const readIssue = ([["status-read", "System status", poll], ["lane-read", "Pull adapter", lanePoll]] as const).flatMap(([key, label, p]) => {
    const phase = phaseOf(p);
    return phase === "error" || phase === "stale"
      ? [{ key, label, tone: "late" as const, detail: p.error ?? "no good read for 2 × the interval", worker: undefined as string | undefined }]
      : [];
  });
  const issues = [...readIssue, ...items.filter((i) => i.tone === "fault" || i.tone === "late")];
  if (!issues.length) return null;
  return (
    <a href="/#/status" className="glass block border-fault-fill/20 p-4 transition hover:border-fault-fill/40">
      <div className="panel-title mb-2 flex items-center gap-2"><AlertTriangle className="h-3 w-3 text-fault" />System issues</div>
      <div className="space-y-1.5">
        {issues.map((i) => (
          <div key={i.key} className="flex items-start gap-2 text-[11.5px]">
            <span className="mt-1.5"><Dot tone={i.tone} pulse /></span>
            <span><b className="text-slate-100">{i.label}</b> <span className="text-slate-400">{i.detail}</span>{i.worker ? <span className="mono block text-[10px] text-slate-500">{i.worker}</span> : null}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 text-[10.5px] text-cyan-300">Open System status →</div>
    </a>
  );
}
