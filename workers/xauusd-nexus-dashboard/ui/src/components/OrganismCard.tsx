import type { ReactNode } from "react";
import { Activity, Clock, HeartPulse, Radio, Server, Sparkles } from "lucide-react";
import { Badge, Dot, Panel, Skeleton } from "./ui";
import { usePoll } from "../lib/usePoll";
import { get } from "../lib/api";

/**
 * Owner 2026-11-12 ("ya bersihkan sekalian"): measured only. GET /api/organism/status returns the market session,
 * the Decision Engine's latest decision time, Omega's EA heartbeat and bridge sync, and the count of recent deals.
 * There is no treasury, quota or power mode here (the platform's Metabolism holds the treasury). A value the
 * route did not measure shows "—".
 */
interface OrganismData {
  status: string;
  organism?: {
    market_state?: "open" | "closed";
    decision_engine?: { enabled?: boolean; latest_bar_close?: string | null; latest_decided_at?: string | null };
    omega?: { engine_enabled?: boolean; control_mode?: string | null; ea_connected?: boolean; ea_heartbeat_age_ms?: number | null; bridge_connected?: boolean; bridge_sync_age_ms?: number | null };
    deals?: { recent_count?: number | null; window?: string };
    observed_at?: string;
  };
}

const age = (ms?: number | null): string => {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const since = (iso?: string | null): string => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? age(Date.now() - t) : "—";
};

function Row({ icon, label, value, tone = "text-slate-300" }: { icon: ReactNode; label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between text-slate-300">
      <span className="flex items-center gap-1.5">{icon}<span>{label}</span></span>
      <span className={`mono text-[10px] ${tone}`}>{value}</span>
    </div>
  );
}

export default function OrganismCard() {
  const { data, loading, error } = usePoll<OrganismData>(() => get<OrganismData>("/api/organism/status"), 30_000);
  const org = data?.organism;
  const de = org?.decision_engine, om = org?.omega;
  const market = org?.market_state ?? "—";

  return (
    <Panel
      title="Digital Organism"
      icon={<Sparkles className="h-3.5 w-3.5 text-emerald-400" />}
      right={<Badge tone="cyan">measured</Badge>}
    >
      {loading && !org ? (
        <Skeleton rows={4} />
      ) : !org ? (
        <div className="text-[11px] text-slate-500">{error ? `Status not available: ${error}` : "Status not available."}</div>
      ) : (
        <div className="space-y-2.5">
          <div className="glass-inner flex items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2">
              <Dot tone={market === "open" ? "green" : "amber"} pulse={market === "open"} />
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-400">Market State</div>
                <div className="mono text-xs font-semibold uppercase text-cyan-300">{market}</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">Omega control</div>
              <div className="mono text-xs font-bold uppercase text-white">{om?.control_mode ?? "—"}</div>
            </div>
          </div>

          <div className="space-y-1.5 pt-0.5 text-[11px]">
            <Row icon={<HeartPulse className="h-3 w-3 text-cyan-400" />} label="Decision Engine"
              value={de?.enabled === true ? `on · last decision ${since(de.latest_decided_at)}` : de?.enabled === false ? "off" : "—"}
              tone={de?.enabled ? "text-emerald-400" : "text-slate-400"} />
            <Row icon={<Radio className="h-3 w-3 text-amber-400" />} label="Omega EA heartbeat"
              value={`${om?.ea_connected === true ? "fresh" : om?.ea_heartbeat_age_ms != null ? "stale" : "never seen"} · ${age(om?.ea_heartbeat_age_ms)}`}
              tone={om?.ea_connected ? "text-emerald-400" : "text-amber-300"} />
            <Row icon={<Server className="h-3 w-3 text-purple-400" />} label="VPS bridge sync"
              value={`${om?.bridge_connected === true ? "fresh" : om?.bridge_sync_age_ms != null ? "stale" : "never seen"} · ${age(om?.bridge_sync_age_ms)}`}
              tone={om?.bridge_connected ? "text-emerald-400" : "text-amber-300"} />
            <Row icon={<Activity className="h-3 w-3 text-emerald-400" />} label="Omega engine"
              value={om?.engine_enabled === true ? "on" : om?.engine_enabled === false ? "off" : "—"} />
            <Row icon={<Clock className="h-3 w-3 text-slate-400" />} label="Recent deals"
              value={org.deals?.recent_count != null ? `${org.deals.recent_count} (${org.deals.window ?? "recent"})` : "—"} />
          </div>
        </div>
      )}
    </Panel>
  );
}
