import { Users } from "lucide-react";
import { Badge } from "./ui";

const COLOR: Record<string, string> = { BULLISH: "#34d399", NEUTRAL: "#64748b", BEARISH: "#fb7185" };
const ORDER = ["BULLISH", "NEUTRAL", "BEARISH"] as const;

/** One stacked bar of the three biases (shares of 1). */
function Bar({ label, shares }: { label: string; shares: Record<string, number> }) {
  const total = ORDER.reduce((a, k) => a + (shares[k] ?? 0), 0) || 1;
  const bullPct = Math.round(((shares.BULLISH ?? 0) / total) * 100);
  const neutPct = Math.round(((shares.NEUTRAL ?? 0) / total) * 100);
  const bearPct = Math.round(((shares.BEARISH ?? 0) / total) * 100);
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
      <div className="flex items-center justify-between sm:w-[76px] sm:shrink-0">
        <span className="whitespace-nowrap text-[10px] uppercase tracking-[0.12em] text-slate-500">{label}</span>
      </div>
      <div className="flex h-2.5 flex-1 overflow-hidden rounded-sm bg-white/5" role="img" aria-label={`${label}: ${ORDER.map((k) => `${k.toLowerCase()} ${Math.round(((shares[k] ?? 0) / total) * 100)}%`).join(", ")}`}>
        {ORDER.map((k) => <div key={k} style={{ width: `${((shares[k] ?? 0) / total) * 100}%`, background: COLOR[k] }} title={`${k.toLowerCase()} ${Math.round(((shares[k] ?? 0) / total) * 100)}%`} />)}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 mono text-[10px]" aria-label={`${label} percentages`}>
        <span className="font-medium text-emerald-300" title="Bullish share">▲{bullPct}%</span>
        <span className="font-medium text-slate-400" title="Neutral share">·{neutPct}%</span>
        <span className="font-medium text-rose-300" title="Bearish share">▼{bearPct}%</span>
      </div>
    </div>
  );
}

/**
 * The crowd line of a room (P7, RFC_INDICATOR_AGENT_PLATFORM §7): every agent's final bias as a
 * head count and weighted by its 30-day track record, the disagreement index, and the agent
 * families that lean against the weighted crowd. Deterministic; the moderator received it.
 */
export default function CrowdLine({ crowd: c, conclusionBias }: { crowd: any; conclusionBias?: string | null }) {
  const differs = conclusionBias && c.weighted_bias && conclusionBias !== c.weighted_bias;
  return (
    <section className="glass-inner p-3" aria-label="Crowd line">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="eyebrow flex items-center gap-1.5 text-[10px]"><Users className="h-3 w-3 text-cyan-300" />Crowd line</span>
        <Badge tone="slate">{c.agents} agents · {c.scored_agents} with a record</Badge>
        <Badge tone={c.weighted_bias === "BULLISH" ? "green" : c.weighted_bias === "BEARISH" ? "red" : "slate"}>weighted {String(c.weighted_bias).toLowerCase()}</Badge>
        <Badge tone={c.disagreement > 0.7 ? "amber" : "slate"}>disagreement {c.disagreement}</Badge>
        {differs && <Badge tone="amber">differs from the conclusion ({String(conclusionBias).toLowerCase()})</Badge>}
      </div>
      <div className="space-y-1.5">
        <Bar label="head count" shares={c.biases ?? {}} />
        <Bar label="weighted" shares={c.weighted_biases ?? {}} />
      </div>
      {!!c.disagreeing_families?.length && <p className="mt-2 text-[11px] text-slate-500">Against the weighted crowd: {c.disagreeing_families.join(", ")}.</p>}
    </section>
  );
}
