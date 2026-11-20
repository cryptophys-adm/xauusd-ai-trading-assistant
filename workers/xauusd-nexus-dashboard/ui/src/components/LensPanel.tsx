import type { ReactNode } from "react";
import { Layers } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "./ui";
import { get } from "../lib/api";
import { ago } from "../lib/format";
import { usePoll } from "../lib/usePoll";

// The Positioning & Liquidity analyst (docs/RFC_POSITIONING_LIQUIDITY.md §10; owner 2026-11-20, breakglass live): one
// agent, two lenses. Read-only, from the AI Worker's GET /api/lens: per lens the weight per mode and where it comes from
// (Aether's anchor, Aether's value, the floor after a poor score, the owner's switch off), the outcome score, whether
// it is at its floor, lens B's baseline, the CFTC report's freshness and the owner's switches. No price.

const MODES = ["scalp", "intraday", "swing", "range"] as const;
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const pc = (x: unknown) => (num(x) ? `${Math.round(x * 100)}%` : "—");
const SOURCE: Record<string, string> = { anchor: "anchor", aether: "Aether", floor_rollback: "floor", switch_off: "off", anchor_baseline_insufficient: "anchor (baseline)" };

function Lens({ title, lens, on, extra }: { title: string; lens: any; on: boolean; extra: ReactNode }) {
  const s = lens?.score;
  return (
    <div className="glass-inner p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-semibold text-slate-100">{title}</span>
        <span className="flex gap-1.5">
          <Badge tone={on ? "green" : "red"}>{on ? "on" : "switched off"}</Badge>
          {lens?.floored ? <Badge tone="amber">at floor</Badge> : null}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-2 text-[11px]">
        {MODES.map((m) => (
          <div key={m}>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">{m}</div>
            <div className="mono text-[13px] font-semibold text-slate-200">{num(lens?.weights?.[m]?.weight) ? lens.weights[m].weight.toFixed(2) : "—"}</div>
            <div className="text-[10px] text-slate-500">{SOURCE[lens?.weights?.[m]?.source] ?? lens?.weights?.[m]?.source ?? "—"}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 text-[11px] text-slate-400">
        Score {pc(s?.share)} over {s?.n ?? 0} readings ({s?.hits ?? 0} hit, {s?.misses ?? 0} miss) · floor {pc(s?.score_floor)} · window {s?.score_window ?? "—"}
      </div>
      <div className="mt-1 text-[11px] text-slate-400">{extra}</div>
    </div>
  );
}

export function LensPanel() {
  const poll = usePoll(() => get("/api/lens"), 120_000);
  const d: any = poll.data;
  return (
    <Panel title="Positioning & Liquidity" icon={<Layers className="h-3.5 w-3.5 text-cyan-300" />}
      hint="One analyst, two lenses: the CFTC positioning report (a small Decision Engine witness) and the broker's own tick volume and spread (a spread-spike filter, liquidity key levels and the councils' measured reasons). Each weight moves per mode within its doctrine bound; a poor score drops it to the floor until Aether sends a newer value. Neither lens ever opens a position."
      right={d ? <Badge tone="slate">mode {d.mode}{d.policy_pulled_at ? ` · Aether ${ago(d.policy_pulled_at)}` : " · anchors"}</Badge> : null}>
      {poll.loading && !d ? <Skeleton rows={3} /> : !d || d.status !== "ok" ? <Empty>No data yet.</Empty> : (
        <div className="grid gap-3 lg:grid-cols-2">
          <Lens title="Lens A · Positioning (CFTC)" lens={d.positioning} on={d.switches?.positioning_enabled !== false}
            extra={<>
              Report {d.positioning?.cot?.as_of ?? "none yet"}{num(d.positioning?.cot?.age_days) ? ` (${Math.round(d.positioning.cot.age_days)} days old)` : ""} · {d.positioning?.cot?.series ?? "—"}
              {d.positioning?.cot?.stale ? <span className="ml-1 text-amber-300">stale</span> : <span className="ml-1 text-emerald-300">fresh</span>}
              {d.positioning?.facts ? <> · {String(d.positioning.facts.crowding).replace("_", " ")}, divergence {String(d.positioning.facts.divergence).replace(/_/g, " ")}</> : null}
            </>} />
          <Lens title="Lens B · Liquidity (broker M1)" lens={d.liquidity} on={d.switches?.liquidity_enabled !== false}
            extra={<>
              Baseline: <span className={d.liquidity?.baseline === "sufficient" ? "text-emerald-300" : "text-amber-300"}>{d.liquidity?.baseline ?? "—"}</span> ({d.liquidity?.baseline_weeks ?? 0} of 4 weeks){d.liquidity?.updated_at ? ` · updated ${ago(d.liquidity.updated_at)}` : ""}
              {d.liquidity?.line ? <div className="mt-1 text-slate-500">{d.liquidity.line}</div> : null}
            </>} />
        </div>
      )}
    </Panel>
  );
}
