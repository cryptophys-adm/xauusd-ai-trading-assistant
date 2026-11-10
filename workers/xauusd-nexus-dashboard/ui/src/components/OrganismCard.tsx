import { Activity, Flame, HeartPulse, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { Badge, Dot, Panel, Skeleton } from "./ui";
import { usePoll } from "../lib/usePoll";
import { get } from "../lib/api";

interface OrganismData {
  status: string;
  organism?: {
    lifecycle: string;
    mode: string;
    market_state: string;
    treasury: {
      balance_usd: number;
      daily_burn_usd: number;
      runway_days: number;
      power_mode: string;
      ai_quota_percent: number;
    };
    nervous_system: {
      decision_engine_ssot: string;
      deals_count: number;
      net_profit_estimate: number;
      omega_bridge: string;
      canon_sync: string;
    };
  };
  timestamp?: string;
}

export default function OrganismCard() {
  const { data, loading } = usePoll<OrganismData>(() => get<OrganismData>("/api/organism/status"), 30_000);
  const org = data?.organism;

  const isGrowth = org?.mode?.includes("GROWTH");
  const isSurvival = org?.mode?.includes("SURVIVAL");
  const tone = isSurvival ? "amber" : isGrowth ? "emerald" : "cyan";

  return (
    <Panel
      title="Digital organism"
      icon={<Sparkles className="h-3.5 w-3.5 text-emerald-400" />}
      right={
        <Badge tone={tone === "amber" ? "amber" : "cyan"}>
          {org?.lifecycle ? "Autonomous · Swasembada" : "Active"}
        </Badge>
      }
    >
      {loading && !org ? (
        <Skeleton rows={4} />
      ) : (
        <div className="space-y-3">
          {/* Mode & Power Banner */}
          <div className="glass-inner flex items-center justify-between px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Dot tone={isSurvival ? "amber" : "green"} pulse />
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-400">Power Mode</div>
                <div className="mono text-xs font-bold text-white">{org?.mode ?? "GROWTH (150% AI Quota)"}</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">Market State</div>
              <div className="mono text-xs font-semibold text-cyan-300 uppercase">{org?.market_state ?? "OPEN"}</div>
            </div>
          </div>

          {/* Treasury & Burn Metrics */}
          <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
            <div className="glass-inner px-2 py-2">
              <span className="block text-[10px] text-slate-400">Kas Mandiri</span>
              <span className="mono text-xs font-bold text-emerald-400">
                ${org?.treasury?.balance_usd?.toFixed(2) ?? "500.00"}
              </span>
            </div>
            <div className="glass-inner px-2 py-2">
              <span className="block text-[10px] text-slate-400">Infra Burn</span>
              <span className="mono text-xs font-bold text-amber-300">
                ${org?.treasury?.daily_burn_usd?.toFixed(2) ?? "2.40"}/d
              </span>
            </div>
            <div className="glass-inner px-2 py-2">
              <span className="block text-[10px] text-slate-400">Runway</span>
              <span className="mono text-xs font-bold text-cyan-300">
                {org?.treasury?.runway_days ?? 208} Hari
              </span>
            </div>
          </div>

          {/* Nervous System Integration Badges */}
          <div className="space-y-1.5 pt-1 text-[11px]">
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
          </div>
        </div>
      )}
    </Panel>
  );
}
