import { Fragment, useEffect, useId, useState } from "react";
import { Crosshair } from "lucide-react";
import { Badge, Panel, Skeleton } from "./ui";
import { C } from "./charts";
import { useMarket } from "../lib/market";
import { tabLabel } from "../lib/tab";
import { utc } from "../lib/format";
import { nearestCandidates } from "../lib/keyZones";

const ROLE_COLOR: Record<string, string> = { support: C.bull, resistance: C.bear, "at price": C.cyan };
const OPACITY: Record<string, number> = { strong: 0.55, medium: 0.35, weak: 0.18 };
/** The four level readers of the chart plane (owner decision 2026-11-08, src/level-readers.mjs). */
const READERS: [string, string, string][] = [["band", "Band", "#facc15"], ["liquidity", "Liquidity", "#22d3ee"], ["projection", "Projection", "#60a5fa"], ["session", "Session", "#c084fc"]];
const READER_NAME: Record<string, string> = { band: "Band Agent", liquidity: "Liquidity Agent", projection: "Projection Agent", session: "Session Agent" };
const SETUP_LABEL: Record<string, string> = { continuation_pullback: "Pullback with the trend", reversal_sweep: "Reversal after a sweep" };
const BAND_TEXT: Record<string, string> = {
  above_h6: "above H6", h5_h6: "between H5 and H6", h4_h5: "in the H4–H5 breakout zone", h3_h4: "between H3 and H4", l3_h3: "inside the H3–L3 range",
  l4_l3: "between L4 and L3", l5_l4: "in the L4–L5 breakdown zone", l6_l5: "between L6 and L5", below_l6: "below L6"
};
const CAM: [string, string, string][] = [["h6", "H6", C.bull], ["h5", "H5", C.bull], ["h4", "H4", C.bull], ["h3", "H3", C.wait], ["l3", "L3", C.wait], ["l4", "L4", C.bear], ["l5", "L5", C.bear], ["l6", "L6", C.bear]];

const memberLines = (z: any) => (z.members ?? []).map((m: any) => `${m.price.toFixed(2)} ${m.label}${m.reader ? ` (${READER_NAME[m.reader] ?? m.reader})` : ""}`).join("\n");
const range = (z: any) => (z.low === z.high ? z.low.toFixed(2) : `${z.low.toFixed(2)}–${z.high.toFixed(2)}`);
const isNum = (v: any): v is number => typeof v === "number" && Number.isFinite(v);
const chartName = (tab: string) => (tab === "NEWS" ? "1H" : tabLabel(tab as any));

type Cpr = { pivot: number; tc: number; bc: number; position?: string | null } | null | undefined;

/** The price between the listed zones: the zones above it sit over this row, the ones below it under it. */
function PriceRow({ price }: { price: number }) {
  return (
    <div className="flex items-center gap-2 px-2.5 text-[10px] text-slate-300" aria-label={`price ${price.toFixed(2)}`}>
      <span className="h-px flex-1 border-t border-dashed border-slate-500/60" />
      <span className="mono">price {price.toFixed(2)}</span>
      <span className="h-px flex-1 border-t border-dashed border-slate-500/60" />
    </div>
  );
}

/**
 * One price axis for both: on the left the Camarilla set of the active tab's chart with the daily
 * and weekly pivot ranges, on the right the Key Level Agent's zones of every chart (candidates in
 * colour), and the price as one line across. The axis spans the zones near price, H4 to L4 and the
 * pivot ranges; a level beyond it is listed at the edge with its price, never drawn off scale.
 */
export function KeyLevelMap({ k, cam, close, daily, weekly }: { k: any; cam: Record<string, number> | null; close: number | null; daily?: Cpr; weekly?: Cpr }) {
  // useId contains colons, which break url(#…) references: strip them (as SentimentGauge does).
  const id = `klm-${useId().replace(/:/g, "")}`;
  const zones = ((k?.zones ?? []) as any[]).filter((z) => isNum(z.low) && isNum(z.high));
  const price = isNum(k?.price) ? k.price : close;
  if (!isNum(price)) return null;
  // The core reach: four 1H ATRs, every candidate zone and H4 / L4. Anything within half again of it
  // (H5/H6/L5/L6, a pivot range) joins the axis; the axis is then fitted to what it shows, so it is
  // not symmetric around price and has no empty band.
  const atr = isNum(k?.atr_h1) ? k.atr_h1 : null;
  const core = [price, ...zones.filter((z) => z.candidate).flatMap((z) => [z.low, z.high]), ...(cam ? ["h3", "l3", "h4", "l4"].map((key) => cam[key]).filter(isNum) : [])];
  const reach = 1.5 * Math.max(atr ? 4 * atr : 0, ...core.map((p) => Math.abs(p - price)), 1);
  const extra = [
    ...(cam ? ["h6", "h5", "l5", "l6"].map((key) => cam[key]).filter(isNum) : []),
    ...[daily, weekly].flatMap((c) => (c && isNum(c.pivot) ? [c.tc, c.bc] : []))
  ].filter((p) => Math.abs(p - price) <= reach);
  const shown = [...core, ...extra];
  const hiRaw = Math.max(...shown, price + (atr ?? 1)), loRaw = Math.min(...shown, price - (atr ?? 1));
  const pad = (hiRaw - loRaw) * 0.04;
  const top = hiRaw + pad, bottom = loRaw - pad;
  const H = 320, W = 340, padT = 16, padB = 16;
  const y = (p: number) => padT + ((top - p) / (top - bottom)) * (H - padT - padB);
  const inside = (p: number) => p <= top && p >= bottom;
  // Lanes: Camarilla labels | Camarilla lines and pivots | zones | zone and price labels.
  const LL = 60, L0 = 62, L1 = 148, Z0 = 156, Z1 = 226, ZL = 232;
  const priceY = y(price);
  // A zone label never sits on the price label: within 11 px it moves away from it.
  const labelY = (mid: number) => (Math.abs(mid - priceY) >= 11 ? mid : mid < priceY ? priceY - 11 : priceY + 11);
  // Everything beyond the axis, listed on one line per edge with its price, each in its own colour.
  const off = (side: "top" | "bottom") => {
    const out = (p: number) => (side === "top" ? p > top : p < bottom);
    const camItems = cam ? CAM.filter(([key]) => isNum(cam[key]) && out(cam[key])).map(([key, name, color]) => ({ text: `${name} ${cam[key].toFixed(2)}`, color })) : [];
    const pivItems = ([[daily, "D pivot", C.cyan], [weekly, "W pivot", C.violet]] as const)
      .filter(([c]) => c && isNum(c.pivot) && out(c.pivot)).map(([c, label, color]) => ({ text: `${label} ${c!.pivot.toFixed(2)}`, color }));
    return [...camItems, ...pivItems];
  };
  const above = off("top"), below = off("bottom");
  const pivot = (c: Cpr, label: string, color: string, dx: number) => {
    if (!c || !isNum(c.pivot)) return null;
    if (!inside(c.pivot)) return null;
    const y1 = y(Math.min(top, c.tc)), y2 = y(Math.max(bottom, c.bc));
    return (
      <g key={label}>
        <title>{`${label}: pivot ${c.pivot.toFixed(2)}, range ${c.bc.toFixed(2)}–${c.tc.toFixed(2)}`}</title>
        <rect x={L1 - 26 + dx} width={10} y={y1} height={Math.max(2, y2 - y1)} rx={2} fill={color} opacity={0.5} />
        <line x1={L1 - 30 + dx} x2={L1 - 12 + dx} y1={y(c.pivot)} y2={y(c.pivot)} stroke={color} strokeWidth={1.2} strokeDasharray="2 2" />
      </g>
    );
  };
  const edge = (list: { text: string; color: string }[], at: "top" | "bottom") => list.length ? (
    <text x={2} y={at === "top" ? 9 : H - 3} textAnchor="start" fontSize="8.5" className="mono">
      <tspan fill={list[0].color}>{at === "top" ? "▲ " : "▼ "}</tspan>
      {list.map((it, i) => <tspan key={it.text} fill={it.color}>{i ? " · " : ""}{it.text}</tspan>)}
    </text>
  ) : null;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Key levels around price ${price.toFixed(2)}`}>
      {/* userSpaceOnUse: a horizontal line has a zero-height bounding box, which an objectBoundingBox gradient cannot paint. */}
      <defs><linearGradient id={`${id}-p`} gradientUnits="userSpaceOnUse" x1={L0} x2={Z1} y1={0} y2={0}><stop offset="0" stopColor="#e2e8f0" stopOpacity="0.45" /><stop offset="1" stopColor="#e2e8f0" stopOpacity="1" /></linearGradient></defs>
      {cam && isNum(cam.h3) && isNum(cam.l3) && inside(cam.h3) && inside(cam.l3) && <rect x={L0} width={L1 - L0} y={y(cam.h3)} height={Math.max(1, y(cam.l3) - y(cam.h3))} fill={C.wait} opacity={0.07} />}
      {cam && CAM.filter(([key]) => isNum(cam[key]) && inside(cam[key])).map(([key, name, color]) => (
        <g key={key}>
          <line x1={L0} x2={L1} y1={y(cam[key])} y2={y(cam[key])} stroke={color} strokeOpacity={key === "h4" || key === "l4" || key === "h3" || key === "l3" ? 0.9 : 0.45} strokeWidth={key === "h4" || key === "l4" ? 1.6 : 1} />
          <text x={LL} y={y(cam[key]) + 3} textAnchor="end" fontSize="8.5" fill={color} className="mono">{name} {cam[key].toFixed(2)}</text>
        </g>
      ))}
      {pivot(daily, "Daily pivot", C.cyan, 0)}
      {pivot(weekly, "Weekly pivot", C.violet, 13)}
      {edge(above, "top")}
      {edge(below, "bottom")}
      {zones.filter((z) => z.high >= bottom && z.low <= top).map((z, i) => {
        const y1 = y(Math.min(top, z.high)), y2 = y(Math.max(bottom, z.low));
        const h = Math.max(2, y2 - y1);
        const col = z.candidate ? ROLE_COLOR[z.role] ?? C.muted : C.muted;
        return (
          <g key={i}>
            <title>{`${range(z)} · ${z.strength} · ${z.sources} source${z.sources === 1 ? "" : "s"} · score ${z.score}\n${memberLines(z)}`}</title>
            <rect x={Z0} y={y1 - (h < 3 ? 1 : 0)} width={Z1 - Z0} height={h} rx={2} fill={col} fillOpacity={z.candidate ? OPACITY[z.strength] ?? 0.2 : 0.08} stroke={col} strokeOpacity={z.candidate ? 0.8 : 0.2} strokeWidth={z.candidate ? 1 : 0.5} />
            {z.candidate && <text x={ZL} y={labelY((y1 + y2) / 2) + 3} fontSize="9" fill={col} className="mono">{range(z)}</text>}
          </g>
        );
      })}
      <line x1={L0} x2={Z1} y1={priceY} y2={priceY} stroke={`url(#${id}-p)`} strokeWidth="1.6" strokeDasharray="4 3" />
      <polygon points={`${Z1 + 1},${priceY} ${Z1 + 6},${priceY - 3.5} ${Z1 + 6},${priceY + 3.5}`} fill="#e2e8f0" />
      <text x={ZL + 2} y={priceY + 3.5} fontSize="10" fontWeight="700" fill="#e2e8f0" className="mono">{price.toFixed(2)}</text>
    </svg>
  );
}

/**
 * Key levels (backlog item 18, owner approval 2026-11-09): the Levels card and the Key Level Agent
 * in one panel on one price axis. The Camarilla set and pivot ranges are the active tab's chart
 * (/api/hud/levels); the zones are the Key Level Agent's, built from every chart's levels (Camarilla,
 * pivot ranges, value areas, swings, previous day and week, round numbers, order blocks, Supertrend
 * and the GMI chart plane through the Band, Liquidity, Projection and Session agents). A zone with
 * three or more independent families and at least medium strength is a candidate key level, at
 * most two per side; the strategy engine places its entries, stops and targets on these zones.
 */
export default function KeyLevels({ levels, loading: levelsLoading, tab }: { levels: any; loading: boolean; tab: string }) {
  const { global: g, loading } = useMarket();
  const k = g?.strategy?.key_levels ?? null;
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => setPick(null), [tab]);
  const sets = (levels?.camarilla ?? []) as any[];
  const set = sets.find((s) => s.tf === pick) ?? sets[0] ?? null;
  const verified = levels?.calibration?.levels === "computed_from_verified_bars";
  const hasK = k && isNum(k.price);
  // The six candidates nearest to price, listed by price from the highest down, as on the map (owner
  // 2026-11-11: "disusun sesuai level harga supaya tidak ambigu"), with the price row where it falls.
  const cands = hasK ? (nearestCandidates(k, 6) as any[]) : [];
  const priceRow = hasK ? cands.filter((z) => (z.low + z.high) / 2 > k.price).length : -1;
  const busy = (loading && !g) || (levelsLoading && !levels);
  return (
    <Panel title={`Key levels · ${chartName(tab)}`} icon={<Crosshair className="h-3.5 w-3.5 text-violet-300" />}
      right={hasK ? <Badge tone="purple">{k.candidates?.length ?? 0} candidate zones</Badge> : null}>
      {busy ? <Skeleton rows={5} /> : !hasK && !set ? <p className="text-[12px] text-slate-500">No price and no HUD snapshot for this chart yet.</p> : (
        <>
          {hasK && (
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
          )}
          {hasK && (!k.readers || READERS.every(([id]) => !k.readers?.[id]?.levels)) ? (
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
          <div className="mb-1 flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[9.5px] uppercase tracking-[0.12em] text-slate-500">Camarilla</span>
            {sets.length > 1 ? sets.map((s) => (
              <button key={s.tf} type="button" onClick={() => setPick(s.tf)}
                className={`rounded-md border px-2 py-0.5 text-[10px] ${set && s.tf === set.tf ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-100" : "border-white/10 text-slate-400 hover:text-slate-200"}`}>{s.label}</button>
            )) : <span className="text-[10px] text-slate-400">{set?.label ?? "no HUD snapshot for this chart yet"}</span>}
            {levels && <span className={`ml-auto text-[9.5px] uppercase tracking-[0.12em] ${verified ? "text-emerald-300" : "text-slate-500"}`}>{verified ? "verified bars" : "not yet calibrated"}</span>}
          </div>
          <div className="mb-0.5 flex justify-between px-1 text-[9px] uppercase tracking-[0.12em] text-slate-600">
            <span>Camarilla · pivots</span><span>{hasK ? "Zones · every chart" : "Zones · none yet"}</span>
          </div>
          <KeyLevelMap k={hasK ? k : null} cam={set?.levels ?? null} close={levels?.close ?? null} daily={levels?.cpr?.daily} weekly={levels?.cpr?.weekly} />
          {set && (
            <p className="mt-1 text-[11px] text-slate-400">
              Close <span className="mono text-slate-200">{isNum(levels?.close) ? levels.close.toFixed(2) : "—"}</span> is {BAND_TEXT[set.band] ?? "off the ladder"} of the {String(set.label).toLowerCase()} Camarilla
              {levels?.cpr?.daily?.position ? `, ${levels.cpr.daily.position === "above_tc" ? "above" : levels.cpr.daily.position === "below_bc" ? "below" : "inside"} the daily pivot range` : ""}.
            </p>
          )}
          {cands.length > 0 && (
            <div className="mt-2 space-y-1">
              {cands.map((z: any, i: number) => (
                <Fragment key={i}>
                  {i === priceRow && <PriceRow price={k.price} />}
                  <div className="glass-inner flex items-center gap-2 px-2.5 py-1.5 text-[11px]" title={memberLines(z)}>
                    <i className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: ROLE_COLOR[z.role] ?? C.muted }} />
                    <span className="mono w-32 shrink-0 text-slate-100">{range(z)}</span>
                    <span className="w-16 shrink-0 text-[10px] uppercase tracking-[0.12em] text-slate-500">{z.strength}</span>
                    <span className="min-w-0 flex-1 truncate text-[10.5px] text-slate-400">{z.label}</span>
                  </div>
                </Fragment>
              ))}
              {priceRow === cands.length && <PriceRow price={k.price} />}
            </div>
          )}
          {hasK && <p className="mt-2 text-[10.5px] leading-snug text-slate-500">{k.summary}</p>}
          <p className="mt-1 text-[9.5px] text-slate-600">
            Left: the Camarilla set{levels?.computed_at ? ` of the ${chartName(tab)} snapshot ${utc(levels.computed_at)}` : ""} with the daily (cyan) and weekly (violet) pivot ranges, formulas of closed bars.
            {hasK ? ` Right: the Key Level Agent's zones from every chart, ${k.raw_count} levels grouped within ${k.tolerance} of each other; a candidate has three or more independent families and at least medium strength, at most two per side. Hover a zone for its levels and their reader.` : ""}
          </p>
        </>
      )}
    </Panel>
  );
}
