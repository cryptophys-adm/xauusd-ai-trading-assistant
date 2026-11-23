import { Badge } from "./ui";
import { zoneAt } from "./SetupLifecycle";
import { bandSource, nearEdge, px, zoneText, type Side, type Zone } from "../lib/entryZone";

// The Decision card's trade plan (moved from GlobalDecision.tsx) and the EZ1 entry zone pieces (owner-approved mockup,
// 2026-11-23): the zone beside the decision, the ladder's Entry row as the zone with the plan's level under it, and the
// "Omega limit" note, which says what the War Room does not read. Pure and null-safe: the render check
// (scripts/render-entry.tsx) renders DecisionPlanView over /api/conclusion/global bodies. With no zone fields nothing
// new is drawn (the reviewer's ruling 6): no Entry zone item, no Omega limit note, today's Entry row.

/** The chart's entry band in small (cyan edges and fill), beside every zone price. */
export function ZoneSwatch({ dim = false }: { dim?: boolean }) {
  return <span aria-hidden="true" className={`inline-block h-[7px] w-3.5 shrink-0 border-y-[1.5px] ${dim ? "border-ok-fill/45 bg-ok-fill/15" : "border-ok-fill bg-ok-fill/30"}`} />;
}

/** The stale tag after a zone ("· stale 12m"), in the late tone; nothing while the decision is fresh. */
function StaleTag({ suffix }: { suffix?: string }) {
  const t = (suffix ?? "").replace(/^\s*·\s*/, "");
  return t ? <span className="mono text-[11px] text-late">· {t}</span> : null;
}

/** The Decision card's Entry zone item: the zone on the feed scale. Null without a zone. */
export function EntryZoneCell({ zone, suffix }: { zone: Zone | null; suffix?: string }) {
  if (!zone) return null;
  return (
    <div className="flex flex-col gap-1 pb-1" title="The decision's entry zone (entry_low to entry_high), on the feed scale">
      <span className="eyebrow">Entry zone</span>
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <ZoneSwatch dim={!!suffix} />
        <span className="mono text-[13px] font-semibold text-fg">{zoneText(zone)}</span>
        <span className="text-[11px] text-fg-2">· feed scale</span>
        <StaleTag suffix={suffix} />
      </span>
    </div>
  );
}

/** The trade of a decision as the plan ladder's input (the chosen target carries its note; the entry its key-level zone). */
export function tradePlan(t: any, levels?: any[]) {
  const z = zoneAt((Array.isArray(levels) ? levels : []).filter((x: any) => x && typeof x.low === "number" && typeof x.high === "number"), t.entry);
  return { entry: t.entry, entry_low: t.entry_low, entry_high: t.entry_high, stop: t.stop, tp1: t.tp1, tp2: t.tp2, risk: t.risk, rrr: t.rrr_all, at_level: t.at_level, key_zone: z ? { low: z.low, high: z.high } : null, entry_text: t.entry_note ?? null, entry_note: [z ? `zone ${z.low.toFixed(2)}–${z.high.toFixed(2)}` : null, t.entry_note].filter(Boolean).join(" · "), stop_note: t.stop_note, progressive_stop: t.progressive_stop, tp1_note: t.target === "tp1" ? `target · ${t.tp_note ?? ""}` : "", tp2_note: t.target === "tp2" ? `target · ${t.tp_note ?? ""}` : "" };
}

/** The Entry row with a zone: the zone on the feed scale, and under it the plan's own level, its key zone and its note. */
function ZoneEntryRow({ plan, zone, suffix }: { plan: any; zone: Zone; suffix?: string }) {
  const kz = plan.key_zone && typeof plan.key_zone.low === "number" && typeof plan.key_zone.high === "number" ? `key zone ${zoneText(plan.key_zone)}` : null;
  const rest = [kz, plan.entry_text ?? (plan.key_zone ? null : plan.entry_note)].filter(Boolean).join(" · ");
  return (
    <div className="flex items-start gap-2 bg-ok-fill/5 px-3 py-[7px]" role="row">
      <span className="mono w-11 shrink-0 text-[11px] font-semibold leading-[18px] text-fg">Entry</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-1.5">
          <ZoneSwatch dim={!!suffix} />
          <span className="mono text-[12.5px] font-semibold leading-[18px] text-fg">{zoneText(zone)}</span>
          <span className="text-[11px] text-fg-2">zone · feed scale</span>
          <StaleTag suffix={suffix} />
        </span>
        <span className="text-[11px] leading-4 text-fg-2"><span className="mono text-fg">plan {px(plan.entry)}</span>{rest ? ` · ${rest}` : ""}</span>
      </span>
    </div>
  );
}

/** The trade plan as a price ladder: targets above, entry, stop below (mirrored for a short). Every price on the feed scale. */
export function PlanLadder({ plan, long, minRrr, zone = null, suffix }: { plan: any; long: boolean; minRrr: number | null; zone?: Zone | null; suffix?: string }) {
  const rows = [
    { k: "TP2", price: plan.tp2, note: plan.tp2_note, rr: plan.rrr?.tp2, tone: "text-bull" },
    { k: "TP1", price: plan.tp1, note: plan.tp1_note, rr: plan.rrr?.tp1, tone: "text-bull" },
    { k: "Entry", price: plan.entry, note: plan.entry_note, rr: null, tone: "text-fg" },
    { k: "Stop", price: plan.stop, note: plan.stop_note, rr: null, tone: "text-bear" },
    { k: "SL+", price: plan.progressive_stop, note: "breakeven stop", rr: null, tone: "text-neutral" }
  ];
  const ordered = long ? rows : [...rows].reverse();
  return (
    <div className="glass-inner mt-3 divide-y divide-white/5" role="table" aria-label="Key levels of the trade plan">
      {ordered.map((r) => (r.k === "Entry" && zone ? <ZoneEntryRow key={r.k} plan={plan} zone={zone} suffix={suffix} /> : (
        <div key={r.k} className="flex items-center gap-2 px-3 py-1.5" role="row">
          <span className={`mono w-11 text-[11px] font-semibold ${r.tone}`}>{r.k}</span>
          <span className="mono w-16 text-[12.5px] font-semibold text-fg">{r.price?.toFixed?.(2) ?? "—"}</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-fg-2" title={r.note}>{r.note}</span>
          {r.rr != null && <span className={`mono text-[11px] ${minRrr == null || r.rr >= minRrr ? "text-ok" : "text-late"}`}>{r.rr}R</span>}
        </div>
      )))}
      <div className="flex items-center justify-between px-3 py-1.5 text-[11px] text-muted">
        <span>risk {plan.risk?.toFixed?.(2) ?? "—"}{minRrr == null ? "" : minRrr > 0 ? ` · min ${minRrr}R` : " · target at nearest level"} · feed scale</span>
        {!plan.at_level && <span className="text-violet-300">pullback entry</span>}
      </div>
    </div>
  );
}

/**
 * Where Omega may rest the limit, as the War Room can say it: the rules the zone allows (EZ1 in the zone; EZ1b at the
 * near edge, feed scale, when the decision carries entry_zone_mode "edge"). The War Room reads no Omega notes or
 * intents, so the note names what the Omega page reads instead of fetching it. Null without a zone.
 */
export function OmegaLimitNote({ zone, side, edge }: { zone: Zone | null; side: Side | null; edge: boolean }) {
  if (!zone) return null;
  const at = edge ? nearEdge(side, zone) : null;
  return (
    <div className="glass-inner mt-2 flex flex-col gap-1.5 px-3 py-2" aria-label="Omega limit">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="w-[72px] text-[11px] font-medium text-muted">Omega limit</span>
        <Badge tone="off">not available on this page</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-2">
        <span className="text-muted">rule</span>
        <span className="mono font-medium text-fg">EZ1</span><span>in the zone</span>
        {at != null && <><span className="text-dim" aria-hidden="true">·</span><span className="mono font-medium text-fg">EZ1b</span><span>near edge <span className="mono font-medium text-fg">{px(at)}</span> feed · allowed</span></>}
      </div>
      <div className="mono text-[10.5px] leading-normal text-muted">
        needs planner.codes · intents[].entry_zone, zone_from, entry_basis from GET /omega/api/overview <a href="/#/omega" className="font-sans text-ok hover:underline">Omega page</a>
      </div>
    </div>
  );
}

/**
 * The EZ1 parts of the Decision card over one /api/conclusion/global body (the render check's view): the Entry zone item,
 * the plan ladder and the Omega limit note, from the plan bandSource picks (the engine's trade, else the strategy plan).
 */
export function DecisionPlanView({ d, suffix }: { d: any; suffix?: string }) {
  const g = d && typeof d === "object" ? (d.global ? { ...d.global, engine: d.engine ?? null } : d) : null;
  const src = bandSource(g);
  const e = g?.engine ?? null;
  const s = g?.strategy ?? null;
  const ladder = src.source === "engine"
    ? (src.plan ? <PlanLadder plan={tradePlan(src.plan, e?.key_levels)} long={src.plan.side === "BUY"} minRrr={e?.rules?.min_rrr ?? null} zone={src.zone} suffix={suffix} /> : null)
    : (src.plan ? <PlanLadder plan={src.plan} long={s?.direction === "LONG"} minRrr={s?.min_rrr ?? 1.5} zone={src.zone} suffix={suffix} /> : null);
  return (
    <div aria-label="Decision plan">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2"><EntryZoneCell zone={src.zone} suffix={suffix} /></div>
      {ladder}
      {ladder && <OmegaLimitNote zone={src.zone} side={src.side} edge={src.edge} />}
    </div>
  );
}
