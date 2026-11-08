import { useId } from "react";
import { Crosshair } from "lucide-react";
import { Badge, Panel, Skeleton } from "./ui";
import { C } from "./charts";
import { useMarket } from "../lib/market";

const ROLE_COLOR: Record<string, string> = { support: C.bull, resistance: C.bear, "at price": C.cyan };
const OPACITY: Record<string, number> = { strong: 0.55, medium: 0.35, weak: 0.18 };
/** The four level readers of the chart plane (owner decision 2026-11-08, src/level-readers.mjs). */
const READERS: [string, string, string][] = [["band", "Band", "#facc15"], ["liquidity", "Liquidity", "#22d3ee"], ["projection", "Projection", "#60a5fa"], ["session", "Session", "#c084fc"]];
const READER_NAME: Record<string, string> = { band: "Band Agent", liquidity: "Liquidity Agent", projection: "Projection Agent", session: "Session Agent" };
const SETUP_LABEL: Record<string, string> = { continuation_pullback: "Pullback with the trend", reversal_sweep: "Reversal after a sweep" };
const memberLines = (z: any) => (z.members ?? []).map((m: any) => `${m.price.toFixed(2)} ${m.label}${m.reader ? ` (${READER_NAME[m.reader] ?? m.reader})` : ""}`).join("\n");
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
            <title>{`${range(z)} · ${z.strength} · ${z.sources} source${z.sources === 1 ? "" : "s"} · score ${z.score}\n${memberLines(z)}`}</title>
            <rect x={L} y={y1 - (h < 3 ? 1 : 0)} width={W - L - R} height={h} rx={2} fill={col} fillOpacity={z.candidate ? OPACITY[z.strength] ?? 0.2 : 0.08} stroke={col} strokeOpacity={z.candidate ? 0.8 : 0.2} strokeWidth={z.candidate ? 1 : 0.5} />
            {z.candidate && (
              <text x={W - R + 6} y={(y1 + y2) / 2 + 3.5} fontSize="10" fill={col} className="mono">{range(z)} · {z.sources} fam.</text>
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
 * ranges, value areas, swings, previous day and week, round numbers, order blocks, Supertrend and,
 * from 2026-11-08, the GMI chart plane through the Band, Liquidity, Projection and Session agents),
 * grouped where they stack. A zone with three or more independent level families and at least medium
 * strength is a candidate key level (at most two per side, 2026-11-08); the strategy engine places its entries, stops and targets on
 * these zones, and its setup type (the 15m location) is shown here. Carried by GET /api/conclusion/global.
 */
export default function KeyLevelAgent() {
  const { global: g, loading } = useMarket();
  const k = g?.strategy?.key_levels ?? null;
  const cands = ((k?.candidates ?? []) as any[]).slice().sort((a, b) => Math.abs(a.price - k.price) - Math.abs(b.price - k.price)).slice(0, 6);
  return (
    <Panel title="Key Level Agent" icon={<Crosshair className="h-3.5 w-3.5 text-violet-300" />} right={k && <Badge tone="purple">{k.candidates?.length ?? 0} candidate zones</Badge>}>
      {loading && !g ? <Skeleton rows={4} /> : !k || k.price == null ? <p className="text-[12px] text-slate-500">The Key Level Agent has no price yet.</p> : (
        <>
          <div className="mb-2 grid grid-cols-4 gap-1" aria-label="Level readers">
            {READERS.map(([id, name, color]) => {
              const n = k.readers?.[id]?.levels;
              return (
                <div key={id} className="glass-inner px-1.5 py-1 text-center" title={k.readers?.[id]?.role ?? READER_NAME[id]}>
                  <div className="text-[9.5px] uppercase tracking-[0.1em]" style={{ color }}>{name}</div>
                  <div className="mono text-[12px] text-slate-100">{typeof n === "number" ? n : "—"}</div>
                </div>
              );
            })}
          </div>
          {!k.readers || READERS.every(([id]) => !k.readers?.[id]?.levels) ? (
            <p className="mb-2 text-[10px] text-slate-500">The four readers wait for the GMI chart plane of the next HUD snapshot.</p>
          ) : null}
          {(() => {
            const st = g?.strategy?.setup;
            if (!st || !g?.strategy?.direction || g.strategy.direction === "NONE") return null;
            return (
              <div className="glass-inner mb-2 px-2.5 py-1.5 text-[11px]">
                <span className="text-[9.5px] uppercase tracking-[0.12em] text-slate-500">Setup at the 15m location · {g.strategy.direction.toLowerCase()}</span>
                <div className={st.type === "none" ? "text-slate-400" : "font-semibold text-emerald-200"}>{SETUP_LABEL[st.type] ?? "No setup type at price"}</div>
                {st.evidence?.length ? <div className="text-[10.5px] text-slate-400">{st.evidence.join(" · ")}</div> : null}
              </div>
            );
          })()}
          <ZoneLadder k={k} />
          <div className="mt-2 space-y-1">
            {cands.map((z: any, i: number) => (
              <div key={i} className="glass-inner flex items-center gap-2 px-2.5 py-1.5 text-[11px]" title={memberLines(z)}>
                <i className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: ROLE_COLOR[z.role] ?? C.muted }} />
                <span className="mono w-32 shrink-0 text-slate-100">{range(z)}</span>
                <span className="w-16 shrink-0 text-[10px] uppercase tracking-[0.12em] text-slate-500">{z.strength}</span>
                <span className="min-w-0 flex-1 truncate text-[10.5px] text-slate-400">{z.label}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10.5px] leading-snug text-slate-500">{k.summary}</p>
          <p className="mt-1 text-[9.5px] text-slate-600">{k.raw_count} levels from every chart, grouped within {k.tolerance} (0.3 × the 1H ATR). Candidate: three or more independent families (a family on one chart counts once) and at least medium strength, at most two per side. Hover a zone for its levels and their reader.</p>
        </>
      )}
    </Panel>
  );
}
