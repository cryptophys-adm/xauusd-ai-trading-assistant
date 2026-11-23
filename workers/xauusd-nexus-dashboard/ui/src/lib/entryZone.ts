// The EZ1 entry zone in Nexus (owner-approved mockup, 2026-11-23): the decision's entry zone on the War Room (the
// Decision card, the plan ladder and the chart's Entry band, on the feed scale) and where Omega rests its limit on the
// Omega page (EZ1 in the zone, EZ1b at the near edge, or refused; broker scale, drawn on the feed chart). Display only:
// every field is one the pages already read (GET /api/conclusion/global, GET /omega/api/overview). Pure: no React, no
// request.
//
// Backend facts (unchanged here): the plan's `entry_low`/`entry_high` (src/strategy-engine.mjs entryZoneOf, feed
// scale, low < high); the signal's `entry_zone_low`/`entry_zone_high` (feed), `entry_zone_edge` (a boolean) and
// `feed_basis` (broker − feed, with `feed_basis_known`); an intent's `entry_zone` (broker), `zone_from` and
// `entry_basis`; the planner's codes limit_in_zone, limit_zone_edge, zone_passed, zone_tight and zone_rr.

export const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
export type Zone = { low: number; high: number };
export type Side = "BUY" | "SELL";

/** A price with two decimals ("2684.20"), "—" when missing. */
export const px = (x: unknown, digits = 2): string => (isNum(x) ? x.toFixed(digits) : "—");
/** A zone as "2684.20–2685.60". */
export const zoneText = (z: Zone, digits = 2): string => `${z.low.toFixed(digits)}–${z.high.toFixed(digits)}`;
const round = (x: number, digits = 2) => Math.round(x * 10 ** digits) / 10 ** digits;

/** A plan's (or trade's) entry zone on the feed scale, or null: both edges numbers and low < high (entryZoneOf's rule). */
export function zoneOf(plan: any): Zone | null {
  const lo = plan?.entry_low, hi = plan?.entry_high;
  return isNum(lo) && isNum(hi) && lo < hi ? { low: lo, high: hi } : null;
}

/** The EA signal's entry zone on the feed scale (entry_zone_low/high), or null as zoneOf. */
export function signalZoneOf(signal: any): Zone | null {
  const lo = signal?.entry_zone_low, hi = signal?.entry_zone_high;
  return isNum(lo) && isNum(hi) && lo < hi ? { low: lo, high: hi } : null;
}

/** An intent's entry zone on the broker scale ({ low, high }), or null. */
export function intentZoneOf(intent: any): Zone | null {
  const z = intent?.entry_zone;
  return z && isNum(z.low) && isNum(z.high) && z.low < z.high ? { low: z.low, high: z.high } : null;
}

/**
 * The plan the Entry band and the Decision card read (the reviewer's ruling 1): the Decision Engine's trade when the
 * engine is on (the body carries `engine`), else the strategy engine's plan. `edge` is EZ1b's switch as the decision
 * carries it (`entry_zone_mode: "edge"`); the strategy plan has none.
 */
export function bandSource(g: any): { source: "engine" | "plan"; plan: any; zone: Zone | null; side: Side | null; edge: boolean } {
  if (g?.engine) {
    const t = g.engine.trade ?? null;
    const side = t?.side === "BUY" || t?.side === "SELL" ? t.side : null;
    return { source: "engine", plan: t, zone: t ? zoneOf(t) : null, side, edge: g.engine.entry_zone_mode === "edge" };
  }
  const s = g?.strategy ?? null;
  const p = s?.plan ?? null;
  const side = s?.direction === "LONG" ? "BUY" : s?.direction === "SHORT" ? "SELL" : s?.decision === "BUY" || s?.decision === "SELL" ? s.decision : null;
  return { source: "plan", plan: p, zone: p ? zoneOf(p) : null, side, edge: false };
}

/**
 * A clear decision, the only time the chart draws a plan (owner directive 2026-11-11): the strategy engine's BUY or SELL,
 * or the Decision Engine's BUY or SELL stance. `engine` is the body's top-level `engine` (useMarket's `engine`); the
 * Global Conclusion's `global` never carries it.
 */
export const clearDecision = (strategy: any, engine: any): boolean =>
  strategy?.decision === "BUY" || strategy?.decision === "SELL" || engine?.stance === "BUY" || engine?.stance === "SELL";

/**
 * The plan the War Room chart draws as lines (Entry, Stop, SL+, TP1, TP2), from the same source as the Entry band and the
 * Decision card (bandSource): the engine's trade when the engine is on, else the strategy plan; only on a clear decision.
 * The engine's trade carries its RRR per target as `rrr_all` (its `rrr` is the chosen target's number). Null: no lines.
 * With the engine on and no trade (a WAIT), there is no plan, as on the card.
 */
export function chartPlan(strategy: any, engine: any): any | null {
  if (!clearDecision(strategy, engine)) return null;
  const src = bandSource({ engine, strategy });
  const p = src.plan;
  if (!p) return null;
  if (src.source === "plan") return p;
  return { entry: p.entry, stop: p.stop, tp1: p.tp1, tp2: p.tp2, at_level: p.at_level, progressive_stop: p.progressive_stop ?? null, rrr: p.rrr_all ?? null };
}

/** The zone's near edge for a side: a BUY's high, a SELL's low (EZ1b rests the limit there). */
export const nearEdge = (side: Side | null, z: Zone): number | null => (side === "BUY" ? z.high : side === "SELL" ? z.low : null);

// ---------------------------------------------------------------- broker and feed

/** The signal's broker-to-feed basis (broker − feed) when the server knows it, else null (no conversion is drawn). */
export function knownFeedBasis(signal: any): number | null {
  return signal?.feed_basis_known === true && isNum(signal?.feed_basis) ? signal.feed_basis : null;
}
/** A broker price on the feed scale: broker − basis, to the symbol's digits (the cent by default); null without a price or a basis. */
export const brokerToFeed = (price: unknown, basis: number | null, digits = 2): number | null => (isNum(price) && price > 0 && isNum(basis) ? round(price - basis, digits) : null);
/** A broker zone on the feed scale, or null. */
export const zoneToFeed = (z: Zone | null, basis: number | null): Zone | null => {
  if (!z || !isNum(basis)) return null;
  return { low: round(z.low - basis), high: round(z.high - basis) };
};
/** A feed zone on the broker scale, or null. */
export const zoneToBroker = (z: Zone | null, basis: number | null): Zone | null => {
  if (!z || !isNum(basis)) return null;
  return { low: round(z.low + basis), high: round(z.high + basis) };
};
/** The basis as signed text: "+0.420". */
export const basisText = (b: number, digits = 3): string => `${b >= 0 ? "+" : "−"}${Math.abs(b).toFixed(digits)}`;

/** A bid or ask line's title on the feed chart: "bid broker 2684.64 · feed 2684.22". */
export const quoteTitle = (kind: "bid" | "ask", broker: number, feed: number, digits = 2): string => `${kind} broker ${broker.toFixed(digits)} · feed ${feed.toFixed(digits)}`;
/** The resting limit's title on the feed chart: "LIMIT · broker 2684.64 (feed 2684.22)". */
export const limitTitle = (broker: number, feed: number, digits = 2): string => `LIMIT · broker ${broker.toFixed(digits)} (feed ${feed.toFixed(digits)})`;
/** The entry zone's label on the feed chart: "Entry zone · broker A–B (feed C–D)"; on a phone "zone · feed C–D (broker +0.42)". */
export function chartZoneLabel(broker: Zone, feed: Zone, basis: number, phone = false): string {
  return phone ? `zone · feed ${zoneText(feed)} (broker ${basisText(basis, 2)})` : `Entry zone · broker ${zoneText(broker)} (feed ${zoneText(feed)})`;
}

/** One open position's line on the feed chart: its price on the chart's scale and its title. */
export type PositionLine = { kind: "entry" | "sl" | "tp"; price: number; title: string };
/**
 * An open position's entry, SL and TP lines on the feed chart (the reviewer's addition to EZ1): with a known basis each
 * broker price converted (broker − basis) and titled "<words> · broker X · feed Y"; without one at the broker's price,
 * titled "<words> · broker", so the chart never mixes scales unlabelled. The words are the page's own: "#ticket SIDE lot",
 * "#ticket SL", "#ticket TP". A missing or zero price (no SL or TP) draws no line.
 */
export function positionLines(p: any, basis: number | null, digits = 2): PositionLine[] {
  if (!p || typeof p !== "object") return [];
  const ticket = p.ticket != null && p.ticket !== "" ? `#${p.ticket}` : "#?";
  const side = p.side === "BUY" || p.side === "SELL" ? p.side : "";
  const lot = isNum(p.volume) ? p.volume.toFixed(2) : "";
  const words = { entry: [ticket, side, lot].filter(Boolean).join(" "), sl: `${ticket} SL`, tp: `${ticket} TP` };
  const raw = { entry: p.open_price ?? p.entry, sl: p.sl, tp: p.tp };
  const out: PositionLine[] = [];
  for (const kind of ["entry", "sl", "tp"] as const) {
    const broker = raw[kind];
    if (!isNum(broker) || broker <= 0) continue;
    if (isNum(basis)) {
      const feed = brokerToFeed(broker, basis, digits);
      if (feed != null) out.push({ kind, price: feed, title: `${words[kind]} · broker ${broker.toFixed(digits)} · feed ${feed.toFixed(digits)}` });
    } else out.push({ kind, price: broker, title: `${words[kind]} · broker` });
  }
  return out;
}

/**
 * Omega's resting limit (broker scale): its own pending BUY_LIMIT or SELL_LIMIT at the broker (not a manual order),
 * else the newest place_limit intent still pending or sent. The zone is that intent's entry_zone (broker), if any.
 */
export function restingLimit(orders: any[], intents: any[]): { price: number; side: Side | null; zone: Zone | null; intent: any } | null {
  const own = (orders ?? []).find((o: any) => (o?.type === "BUY_LIMIT" || o?.type === "SELL_LIMIT") && !(o.source === "manual" || o.magic === 0) && isNum(o.price_open) && o.price_open > 0);
  const live = (intents ?? []).filter((i: any) => i?.kind === "place_limit" && (i.status === "pending" || i.status === "sent" || i.status === "done"));
  if (own) {
    const it = live.find((i: any) => i.id === own.comment || Number(i?.result?.ticket) === Number(own.ticket)) ?? null;
    return { price: own.price_open, side: own.type === "BUY_LIMIT" ? "BUY" : "SELL", zone: intentZoneOf(it), intent: it };
  }
  const pend = live.filter((i: any) => i.status !== "done" && isNum(i.entry) && i.entry > 0).sort((a: any, b: any) => (b.created_ms ?? 0) - (a.created_ms ?? 0))[0];
  return pend ? { price: pend.entry, side: pend.side === "BUY" || pend.side === "SELL" ? pend.side : null, zone: intentZoneOf(pend), intent: pend } : null;
}

// ---------------------------------------------------------------- the planner's notes

/** limit_in_zone's detail ("2685.32 -> 2684.64", broker) as "from 2685.32 to 2684.64 · broker"; null when it is not that shape. */
export function inZoneDetail(detail: unknown): string | null {
  if (typeof detail !== "string") return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*->\s*(-?\d+(?:\.\d+)?)\s*$/.exec(detail);
  return m ? `from ${Number(m[1]).toFixed(2)} to ${Number(m[2]).toFixed(2)} · broker` : null;
}

/**
 * limit_zone_edge's detail (JSON.stringify({ plan_entry, edge, away_r_plan, away_r_edge }), broker) as
 * "plan 2685.32 · 0.462R away → edge 2686.02 · 0.307R away · broker"; null when it is not that JSON.
 */
export function zoneEdgeDetail(detail: unknown): string | null {
  if (typeof detail !== "string") return null;
  let d: any;
  try { d = JSON.parse(detail); } catch { return null; }
  if (!d || typeof d !== "object" || !isNum(d.plan_entry) || !isNum(d.edge)) return null;
  const away = (r: unknown) => (isNum(r) ? ` · ${Number(r.toFixed(3))}R away` : "");
  return `plan ${d.plan_entry.toFixed(2)}${away(d.away_r_plan)} → edge ${d.edge.toFixed(2)}${away(d.away_r_edge)} · broker`;
}

/** The five EZ1 codes (src/omega-engine.mjs): two placements ("adjust") and three refusals ("block"). */
export const EZ_CODES = ["limit_in_zone", "limit_zone_edge", "zone_passed", "zone_tight", "zone_rr"] as const;
export const EZ_REFUSALS = new Set<string>(["zone_passed", "zone_tight", "zone_rr"]);

/**
 * A planner note's detail as the Entry status shows it: limit_in_zone's and limit_zone_edge's through their formatters;
 * the three refusals in the code's own words with the scale ("· broker"); any other code unchanged. Null without one.
 */
export function plannerDetail(code: string, detail: unknown): string | null {
  if (detail == null || detail === "") return null;
  const raw = typeof detail === "string" ? detail : JSON.stringify(detail);
  if (code === "limit_in_zone") return inZoneDetail(raw) ?? raw;
  if (code === "limit_zone_edge") return zoneEdgeDetail(raw) ?? raw;
  if (EZ_REFUSALS.has(code)) return `${raw} · broker`;
  return raw;
}

/** How an intent's limit came to rest: "in zone · from 2685.32" (EZ1), "near edge · from 2685.32" (EZ1b), or null. */
export function intentPlacement(intent: any): string | null {
  if (!isNum(intent?.zone_from)) return null;
  return `${intent.entry_basis === "zone_edge" ? "near edge" : "in zone"} · from ${intent.zone_from.toFixed(2)}`;
}

// ---------------------------------------------------------------- times (UTC and the owner's GMT+7)

const GMT7_MS = 7 * 3_600_000;
const two = (n: number) => String(n).padStart(2, "0");
/** "14:00:00" (seconds) or "14:00" in UTC. */
export function utcClockOf(ms: unknown, seconds = false): string {
  if (!isNum(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}${seconds ? `:${two(d.getUTCSeconds())}` : ""}`;
}
/** The same instant in GMT+7: "21:00" (or with seconds). */
export const gmt7ClockOf = (ms: unknown, seconds = false): string => (isNum(ms) && ms > 0 ? utcClockOf(ms + GMT7_MS, seconds) : "—");
/** "14:00:00 UTC · 21:00 GMT+7". */
export const utcAndGmt7 = (ms: unknown, seconds = true): string => (isNum(ms) && ms > 0 ? `${utcClockOf(ms, seconds)} UTC · ${gmt7ClockOf(ms)} GMT+7` : "—");

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/**
 * A chart's time-axis tick in GMT+7 (lightweight-charts' tickMarkFormatter; `time` in UTC seconds, `type` its
 * TickMarkType: 0 year, 1 month, 2 day of month, 3 time, 4 time with seconds): "Thu 19" at midnight, else "08:00".
 */
export function gmt7Tick(time: unknown, type: number): string {
  if (!isNum(time)) return "";
  const d = new Date(time * 1000 + GMT7_MS);
  if (type === 0) return String(d.getUTCFullYear());
  if (type === 1) return MONTHS[d.getUTCMonth()];
  if (type === 2) return `${DAYS[d.getUTCDay()]} ${two(d.getUTCDate())}`;
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}${type === 4 ? `:${two(d.getUTCSeconds())}` : ""}`;
}
/** The crosshair's time in GMT+7 (lightweight-charts' localization.timeFormatter): "Thu 19 Nov 21:00 GMT+7". */
export function gmt7Crosshair(time: unknown): string {
  if (!isNum(time)) return "";
  const d = new Date(time * 1000 + GMT7_MS);
  return `${DAYS[d.getUTCDay()]} ${two(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} GMT+7`;
}
