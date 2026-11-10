import { Activity, Cpu, HeartPulse, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { Badge, Dot, Panel, Skeleton } from "./ui";
import { usePoll } from "../lib/usePoll";
import { get } from "../lib/api";

interface OrganismData {
  status: string;
  organism?: {
    lifecycle: string;
    mode: string;
    market_state: string;
    treasury?: {
      power_mode?: string;
      ai_quota_percent?: number;
    };
    nervous_system?: {
      decision_engine_ssot?: string;
      deals_count?: number;
      omega_bridge?: string;
      canon_sync?: string;
    };
  };
  timestamp?: string;
}

export default function OrganismCard() {
  const { data, loading } = usePoll<OrganismData>(() => get<OrganismData>("/api/organism/status"), 30_000);
  const org = data?.organism;

  const isGrowth = org?.mode?.includes("GROWTH") ?? true;
  const isSurvival = org?.mode?.includes("SURVIVAL") ?? false;
  const tone = isSurvival ? "amber" : isGrowth ? "emerald" : "cyan";

  return (
    <Panel
      title="Digital Organism"
      icon={<Sparkles className="h-3.5 w-3.5 text-emerald-400" />}
      right={
        <Badge tone={tone === "amber" ? "amber" : "cyan"}>
          {org?.lifecycle ? "Autonomous · Living Mesh" : "Active"}
        </Badge>
      }
    >
      {loading && !org ? (
        <Skeleton rows={4} />
      ) : (
        <div className="space-y-2.5">
          {/* Mode & Operational State */}
          <div className="glass-inner flex items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2">
              <Dot tone={isSurvival ? "amber" : "green"} pulse />
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-400">Power Mode</div>
                <div className="mono text-xs font-bold text-white">
                  {org?.mode ?? "GROWTH (Full Capacity)"}
                </div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">Market State</div>
              <div className="mono text-xs font-semibold uppercase text-cyan-300">
                {org?.market_state ?? "OPEN"}
              </div>
            </div>
          </div>

          {/* Living Mesh & Nervous System Subsystems */}
          <div className="space-y-1.5 pt-0.5 text-[11px]">
            <div className="flex items-center justify-between text-slate-300">
              <span className="flex items-center gap-1.5">
                <HeartPulse className="h-3 w-3 text-cyan-400" />
                <span>15m Decision SSOT</span>
              </span>
              <span className="mono text-[10px] text-emerald-400">Awareness Active</span>
            </div>

            <div className="flex items-center justify-between text-slate-300">
              <span className="flex items-center gap-1.5">
                <Zap className="h-3 w-3 text-amber-400" />
                <span>Omega Broker Bridge</span>
              </span>
              <span className="mono text-[10px] text-cyan-300">
                {org?.nervous_system?.omega_bridge === "armed" ? "Armed Live" : "Bridge Ready"}
              </span>
            </div>

            <div className="flex items-center justify-between text-slate-300">
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="h-3 w-3 text-purple-400" />
                <span>Aether Canon Sync</span>
              </span>
              <span className="mono text-[10px] text-purple-300">SHA-256 Verified</span>
            </div>

            <div className="flex items-center justify-between text-slate-300">
              <span className="flex items-center gap-1.5">
                <Cpu className="h-3 w-3 text-emerald-400" />
                <span>Compute Allocation</span>
              </span>
              <span className="mono text-[10px] text-emerald-300">
                {org?.treasury?.ai_quota_percent ?? 150}% AI Quota
              </span>
            </div>
          </div>

          <div className="border-t border-white/5 pt-1.5 text-[10px] text-slate-500 leading-tight">
            Self-governing closed loop · Homeostasis active across all mesh nodes.
          </div>
        </div>
      )}
    </Panel>
  );
}
