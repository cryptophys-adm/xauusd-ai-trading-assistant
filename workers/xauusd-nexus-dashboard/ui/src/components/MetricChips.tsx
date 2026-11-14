import { Stance } from "./Stance";
import { pct } from "../lib/format";

/**
 * Metric chips (AI Neuron A3, owner 2026-11-14: "lanjut"): an agent's shadow answer of the same bar in metric
 * form, under its post on the bus. Each chip is one metric: its reading, its value, the way it points (green
 * bullish, red bearish, grey neutral) and its weight. A rebuttal shows which metric of which agent it disputes,
 * with which metric of its own. Marked SHADOW: nothing here reaches the room or a decision.
 */
export type MetricOpening = {
  stance?: string | null; confidence?: number | null; cited?: number; grounded?: number; invalidation?: string | null;
  metrics?: { id: string; value?: unknown; reading?: string | null; implication?: string; weight?: number }[];
};
export type MetricRebuttal = {
  stance?: string | null; confidence?: number | null; cited?: number; grounded?: number;
  rebuts?: { agent?: string | null; their_metric: string; my_metric: string; relation: string }[];
};

const TONE: Record<string, string> = {
  bullish: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  bearish: "border-rose-400/30 bg-rose-400/10 text-rose-200",
  neutral: "border-slate-500/30 bg-slate-500/10 text-slate-300",
};
const RELATION: Record<string, string> = { contradicts: "✕ contradicts", outweighs: "› outweighs", confirms: "✓ confirms" };

/** The metric id without its data path, for a short chip ("candles_15m.range_ratio" → "range_ratio"). */
export const shortId = (id: string) => String(id).split(".").slice(-1)[0];
export function chipValue(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "boolean") return v ? "yes" : "no";
  const s = String(v);
  return s.length > 24 ? `${s.slice(0, 23)}…` : s;
}

function Shadow({ stance, confidence, live, grounded, cited }: { stance?: string | null; confidence?: number | null; live?: string | null; grounded?: number; cited?: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] text-slate-500">
      <span className="chip border-violet-400/30 bg-violet-400/10 px-1.5 py-0 text-[9px] tracking-[0.14em] text-violet-200" title="The same agent, same data, answering in metric form; shadow only, never in the room or a decision">SHADOW · METRICS</span>
      {stance && <Stance value={stance} />}
      {confidence != null && <span className="mono">{pct(confidence)}</span>}
      {stance && live && stance !== live && <span className="text-amber-300/80" title="The metric answer's stance differs from the live post's">differs from live</span>}
      {cited ? <span className="mono" title="Cited metrics found in the agent's own data">grounded {grounded ?? 0}/{cited}</span> : null}
    </span>
  );
}

export function MetricChips({ m, live }: { m?: MetricOpening | null; live?: string | null }) {
  if (!m?.metrics?.length) return null;
  return (
    <div className="mt-1.5 space-y-1 border-t border-white/5 pt-1.5">
      <Shadow stance={m.stance} confidence={m.confidence} live={live} grounded={m.grounded} cited={m.cited} />
      <div className="flex flex-wrap gap-1">
        {m.metrics.map((x, i) => {
          const value = chipValue(x.value);
          return (
            <span key={`${x.id}-${i}`} title={`${x.id}${value ? ` = ${value}` : ""} · ${x.implication ?? ""} · weight ${pct(x.weight ?? null)}${m.invalidation === x.id ? " · would invalidate the view" : ""}`}
              className={`chip px-1.5 py-0 text-[10px] normal-case tracking-normal ${TONE[x.implication ?? "neutral"] ?? TONE.neutral}`}
              style={{ opacity: 0.55 + 0.45 * Math.min(1, Math.max(0, x.weight ?? 0.5)) }}>
              <span className="mono">{shortId(x.id)}</span>
              {x.reading && <span className="ml-1 text-slate-300/90">{x.reading}</span>}
              {value && <span className="mono ml-1 text-slate-400">{value}</span>}
              {m.invalidation === x.id && <span className="ml-1" aria-label="invalidation metric">⚑</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function RebuttalChips({ r, live, names }: { r?: MetricRebuttal | null; live?: string | null; names?: Record<string, string> }) {
  if (!r) return null;
  return (
    <div className="mt-1.5 space-y-1 border-t border-white/5 pt-1.5">
      <Shadow stance={r.stance} confidence={r.confidence} live={live} grounded={r.grounded} cited={r.cited} />
      {!r.rebuts?.length ? <div className="text-[10px] text-slate-500">disputes nothing</div> : (
        <div className="flex flex-wrap gap-1">
          {r.rebuts.map((b, i) => (
            <span key={i} className="chip px-1.5 py-0 text-[10px] normal-case tracking-normal border-slate-500/30 bg-slate-500/10 text-slate-300" title={`${b.their_metric} (${b.agent ?? "?"}) ${b.relation} by ${b.my_metric}`}>
              <span className="text-slate-400">{(b.agent && names?.[b.agent]) || b.agent || "?"}</span>
              <span className="mono ml-1">{shortId(b.their_metric)}</span>
              <span className={`ml-1 ${b.relation === "confirms" ? "text-emerald-300" : b.relation === "contradicts" ? "text-rose-300" : "text-amber-300"}`}>{RELATION[b.relation] ?? b.relation}</span>
              <span className="mono ml-1">{shortId(b.my_metric)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
