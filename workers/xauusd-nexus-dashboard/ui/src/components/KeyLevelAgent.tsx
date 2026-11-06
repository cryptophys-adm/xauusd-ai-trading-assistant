import { useId } from "react";
import { Crosshair } from "lucide-react";
import { Badge, Panel, Skeleton } from "./ui";
import { C } from "./charts";
import { useMarket } from "../lib/market";

const ROLE_COLOR: Record<string, string> = { support: C.bull, resistance: C.bear, "at price": C.cyan };
const OPACITY: Record<string, number> = { strong: 0.55, medium: 0.35, weak: 0.18 };
const range = (z: any) => (z.low === z.high ? z.low.toFixed(2) : `${z.low.toFixed(2)}–${z.high.toFixed(2)}`);

/** The zones as horizontal bands on one price axis, price as a line; candidates in colour. */
function ZoneLadder({ k }: { k: any }) {
  const id = useId();
  const zones = (k.zones ?? []) as any[];
  const price = k.price as number;
  const span = Math.max(4 * (k.atr_h1 ?? 10), ...zones.map((z) => Math.abs(z.price - price) + 2));
  const top = price + span, bottom = price - span, H = 300, W = 320, L = 8, R = 150;
  const y = (p: number) => ((top - p) / (top - bottom)) * H;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Key level zones around price">
      <defs><linearGradient id={`${id}-p`} x1="0" x2="1"><stop offset="0" stopColor="#22d3ee" stopOpacity="0" /><stop offset="1" stopColor="#22d3ee" stopOpacity="0.9" /></linearGradient></defs>
      {zones.map((z, i) => {
        const y1 = y(z.high), y2 = y(z.low);
        const h = Math.max(2, y2 - y1);
        const col = z.candidate ? ROLE_COLOR[z.role] ?? C.muted : C.muted;
        return (
          <g key={i}>
            <title>{`${range(z)} · ${z.strength} · ${z.sources} source${z.sources === 1 ? "" : "s"} · score ${z.score}\n${(z.members ?? []).map((m: any) => `${m.price.toFixed(2)} ${m.label}`).join("\n")}`}</title>
            <rect x={L} y={y1 - (h < 3 ? 1 : 0)} width={W - L - R} height={h} rx={2} fill={col} fillOpacity={z.candidate ? OPACITY[z.strength] ?? 0.2 : 0.08} stroke={col} strokeOpacity={z.candidate ? 0.8 : 0.2} strokeWidth={z.candidate ? 1 : 0.5} />
            {z.candidate && (
              <text x={W - R + 6} y={(y1 + y2) / 2 + 3.5} fontSize="10" fill={col} className="mono">{range(z)} · {z.sources}×</text>
            )}
          </g>
        );
      })}
      <line x1={L} x2={W - R} y1={y(price)} y2={y(price)} stroke={`url(#${id}-p)`} strokeWidth="1.5" strokeDasharray="4 3" />
      <text x={W - R + 6} y={y(price) + 3.5} fontSize="10.5" fontWeight="700" fill="#e2e8f0" className="mono">▶ {price.toFixed(2)}</text>
    </svg>
  );
}

/**
 * Key Level Agent (owner decision 2026-11-06): every key level of every chart (Camarilla, pivot
 * ranges, value areas, swings, previous day and week, round numbers), grouped where they stack.
 * A zone with two or more independent sources is a candidate key level; the strategy engine
 * places its entries, stops and targets on these zones. Carried by GET /api/conclusion/global.
 */
export default function KeyLevelAgent() {
  const { global: g, loading } = useMarket();
  const k = g?.strategy?.key_levels ?? null;
  const cands = ((k?.candidates ?? []) as any[]).slice().sort((a, b) => Math.abs(a.price - k.price) - Math.abs(b.price - k.price)).slice(0, 6);
  return (
    <Panel title="Key Level Agent" icon={<Crosshair className="h-3.5 w-3.5 text-violet-300" />} right={k && <Badge tone="purple">{k.candidates?.length ?? 0} candidate zones</Badge>}>
      {loading && !g ? <Skeleton rows={4} /> : !k || k.price == null ? <p className="text-[12px] text-slate-500">The Key Level Agent has no price yet.</p> : (
        <>
          <ZoneLadder k={k} />
          <div className="mt-2 space-y-1">
            {cands.map((z: any, i: number) => (
              <div key={i} className="glass-inner flex items-center gap-2 px-2.5 py-1.5 text-[11px]" title={(z.members ?? []).map((m: any) => `${m.price.toFixed(2)} ${m.label}`).join("\n")}>
                <i className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: ROLE_COLOR[z.role] ?? C.muted }} />
                <span className="mono w-32 shrink-0 text-slate-100">{range(z)}</span>
                <span className="w-16 shrink-0 text-[10px] uppercase tracking-[0.12em] text-slate-500">{z.strength}</span>
                <span className="min-w-0 flex-1 truncate text-[10.5px] text-slate-400">{z.label}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10.5px] leading-snug text-slate-500">{k.summary}</p>
          <p className="mt-1 text-[9.5px] text-slate-600">{k.raw_count} levels from every chart, grouped within {k.tolerance} (0.3 × the 1H ATR). Candidate: two or more independent sources. Hover a zone for its levels.</p>
        </>
      )}
    </Panel>
  );
}
