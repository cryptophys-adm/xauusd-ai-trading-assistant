// Demand and supply zone types (Z0, owner 2026-11-23: "Langsung prioritaskan"; docs/RFC_DEMAND_SUPPLY_ZONES.md).
// Recorded only: nothing here changes a zone, a candidate, a plan's prices, a guardrail, the council or the EA signal.
// Z2 (the end of this file) reads the record: the zone_ahead check of the Decision Engine's guardrails and its plan
// filter (zonePlanPasses), switched by ZONE_PRIORITY and ZONE_AHEAD_MODE.
//
// The Key Level Agent (src/key-level-agent.mjs) groups every chart's levels into zones; a zone's `role` is only its
// position against price. This pure module types each zone from the demand and supply boxes the charts already carry:
//   whale         chart_plane.liquidity.whale_zones: a support zone is demand, a resistance zone supply (the producer
//                 already flips a mitigated block's role, local-engines/producer/src/chart-plane.mjs whaleZones);
//                 0.9 active, 0.7 mitigation
//   prophet_best  the order_blocks HUD's best bullish (demand) and bearish (supply) block, 0.7
//   gabfx         chart_plane.liquidity.gabfx points: RBS 1.0 and QM buy 0.9 demand, SBR 1.0 and QM sell 0.9 supply
//   gmi_flag      the 15m aegis_footprint flags (in a bullish order block or mitigation: demand; bearish: supply), 0.7,
//                 only on the zone holding price (role "at price")
//   prophet_zone  (Z1a) every active Prophet order block the producer adds to the chart plane (chart_plane.zones.prophet,
//                 the 4 nearest per side; local-engines/producer/src/adopt/prophet-ob.mjs): bull demand, bear supply,
//                 0.7, 0.9 when high_volume. On a chart that has them, prophet_best (one of them) is dropped. A zone's
//                 freshness reads the most touches of its own count and of the prophet_zone boxes typing it (worn
//                 dominates).
//   gmi_ob        (Z1b) GMI's active Aegis validated order blocks the producer adds to the chart plane
//                 (chart_plane.zones.aegis, the 4 nearest per side; local-engines/producer/src/adopt/gmi-zone.mjs):
//                 bull demand, bear supply, 0.8. On a chart that has them, gmi_flag is dropped (its order-block flag is
//                 price inside one of them); a chart without them keeps it. Their touches age a zone as prophet_zone's.
// each weight times the chart's TF_WEIGHT (15m 1, 1H 1.5, 4H 2, daily 2.5, weekly 3). A box types a zone on a strict overlap, or when
// one of its edges is one of the zone's member prices (ZF1: the box made the cluster); a point must lie inside the zone
// or on a member. Per side, a (source, timeframe) adds only its heaviest box, so two overlapping 15m
// whales count once. Type: demand when demand_w > 0 and demand_w >= 2 x supply_w, supply in the mirror case, mixed when
// both are > 0, else none. Strength on the type's score: strong >= 2.0, medium >= 1.0, else weak. A lone 1H-or-higher
// box is medium; a lone 15m RBS or SBR point (1.0 x 1) is medium too, so decisive; a lone 15m whale (0.9) stays weak.
// Freshness: the touches of the zone on the 40 closed 15m bars before the decision bar (a 10-hour window for every zone
// timeframe), within 0.15 x ATR(1H), at least 3 bars apart (Prophet's rule, local-engines/prophet-r38/src/core.mjs),
// counted up to 3: 0 fresh, 1-2 tested, 3 worn.
// zoneAhead reads only the recorded set (aroundSet, the decision's key_levels with their zone words), so a replay of a
// stored decision reproduces it. Switch: KEY_LEVEL_ZONE_TYPES = "on" (default) | "off" (no typed field anywhere),
// through the strategy modes. ZONE_SOURCES_OFF (Z1a): a list of ZONE_SOURCES tokens left out of the typing, through the
// strategy modes too; "prophet_zone" restores Z0's typing, "gmi_ob" (Z1b) Z1a's.

import { prophetZoneBoxes, aegisZoneBoxes } from "./level-readers.mjs";

export const ZONE_TYPES_VERSION = "cryptophys.zone-types.v1";
/** The Key Level Agent's timeframe weights (src/key-level-agent.mjs TF_WEIGHT; a test holds them equal). */
export const ZONE_TF_WEIGHT = Object.freeze({ "15": 1, "60": 1.5, "240": 2, D: 2.5, "1D": 2.5, W: 3, "1W": 3 });
/** Source labels use these words, never a period number: "240" would read like a price (public-projection PRICE_LIKE). */
export const ZONE_TF_NAME = Object.freeze({ "15": "15m", "60": "1H", "240": "4H", D: "daily", "1D": "daily", W: "weekly", "1W": "weekly" });
/** The readers' own base weights (src/level-readers.mjs, src/key-level-agent.mjs), and the 15m GMI flag. */
export const ZONE_SOURCE_WEIGHT = Object.freeze({ whale_active: 0.9, whale_mitigation: 0.7, prophet_best: 0.7, rbs: 1, sbr: 1, qm_buy: 0.9, qm_sell: 0.9, gmi_flag: 0.7 });
/** Z1a: an active Prophet order block's base weight, and its weight when the core flags its source bar high_volume. */
export const ZONE_PROPHET_WEIGHT = Object.freeze({ active: 0.7, high_volume: 0.9 });
/** Z1b: an active GMI Aegis validated order block's base weight. */
export const ZONE_GMI_OB_WEIGHT = 0.8;
/**
 * Z1b: one block counts once. A gmi_ob box on the same chart and side as a prophet_zone box, with both edges within
 * this tolerance, is the same block (both cores run the same order-block algorithm): it adds no box, only provenance
 * (`also: ["gmi_ob"]` on the prophet_zone box). Absolute, in price units: 0.001 on XAUUSD is about 0.0000025 of price.
 */
export const ZONE_SAME_BLOCK_TOL = 0.001;
// The edges are 3 dp; 1e-9 absorbs binary rounding, so a difference of exactly one 0.001 step is within.
const near = (a, b) => Math.abs(a - b) <= ZONE_SAME_BLOCK_TOL + 1e-9;
/** The evidence sources, the tokens of ZONE_SOURCES_OFF. */
export const ZONE_SOURCES = Object.freeze(["prophet_zone", "prophet_best", "whale", "gabfx", "gmi_flag", "gmi_ob"]);
/** The sources whose boxes carry their own chart's touches, read into a zone's freshness. */
const BOX_TOUCH_SOURCES = new Set(["prophet_zone", "gmi_ob"]);
export const ZONE_RULES = Object.freeze({
  dominance: 2, medium: 1, strong: 2,
  touch_band_atr: 0.15, touch_bars: 40, touch_gap: 3, touch_cap: 3,
  around: 12
});
/** Z0/Z2b's room an opposing zone must leave ahead of the entry: max(1.0 x risk, 0.75 x ATR(1H)). */
export const ZONE_NEED = Object.freeze({ risk: 1, atr: 0.75 });
/** The trend lean that exempts a plan (src/strategy-engine.mjs STRATEGY_PARAMS.lean; a test holds them equal). */
export const ZONE_TREND_LEAN = 0.15;
// ZF2 (owner 2026-11-26: "ZF2 snapshot Weekly"): the weekly snapshot ("1W", optional) types zones too: its
// prophet_zone, whale and prophet_best boxes at the weekly weight (it carries no GMI, so no gmi_ob, gabfx or flag).
// A missing weekly snapshot adds no box: every other chart's typing is as before.
const CHARTS = Object.freeze(["15", "60", "240", "1D", "1W"]);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);

/** KEY_LEVEL_ZONE_TYPES: "on" (default) | "off". */
export function keyLevelZoneTypesMode(env) {
  return String(env?.KEY_LEVEL_ZONE_TYPES ?? "on").trim().toLowerCase() === "off" ? "off" : "on";
}

/**
 * ZONE_SOURCES_OFF (Z1a): the ZONE_SOURCES tokens to leave out of the typing, comma- or space-separated, in
 * ZONE_SOURCES order; unknown tokens are ignored. [] (default) leaves every source in.
 */
export function zoneSourcesOffMode(env) {
  return zoneSourcesList(String(env?.ZONE_SOURCES_OFF ?? "").split(/[\s,]+/));
}
/** The strategy modes' entry for ZONE_SOURCES_OFF: { zoneSourcesOff: [...] } when a source is off, else {} (modes unchanged). */
export function zoneSourcesModes(env) {
  const off = zoneSourcesOffMode(env);
  return off.length ? { zoneSourcesOff: off } : {};
}
/** Pure: the known tokens of a list (an array or a separated string), in ZONE_SOURCES order, each once. */
export function zoneSourcesList(list) {
  const given = new Set((Array.isArray(list) ? list : typeof list === "string" ? list.split(/[\s,]+/) : []).map((t) => String(t).trim().toLowerCase()));
  return ZONE_SOURCES.filter((t) => given.has(t));
}

/** Pure: need = ZONE_NEED.risk x risk, at least ZONE_NEED.atr x ATR(1H). */
export const zoneNeed = (risk, atrH1) => Math.max(ZONE_NEED.risk * risk, ZONE_NEED.atr * atrH1);

/**
 * Pure: the demand and supply evidence of the charts ({ "15", "60", "240", "1D", "1W" } HUD snapshots; "1W" optional, ZF2), with the closed 15m
 * bars and the 1H ATR for freshness: { boxes: [{ source, tf, side, bottom, top, weight, point?, at_price?, touches? }],
 * bars, atr_h1 }. `weight` is the base weight times the chart's timeframe weight. A missing field gives no box, never a
 * default. `sourcesOff` (ZONE_SOURCES_OFF) leaves those sources out.
 */
export function dsEvidence({ snapshots = {}, bars15 = [], atrH1 = null, sourcesOff = [] } = {}) {
  const boxes = [];
  const off = new Set(zoneSourcesList(sourcesOff));
  const box = (source, tf, side, bottom, top, base, extra = {}) => {
    if (!isNum(bottom) || !isNum(top) || top < bottom) return;
    boxes.push({ source, tf, side, bottom, top, weight: r2(base * ZONE_TF_WEIGHT[tf]), ...extra });
  };
  for (const chart of CHARTS) {
    const snap = snapshots?.[chart];
    if (!snap || typeof snap !== "object") continue;
    const tf = String(snap.timeframe ?? chart);
    if (!ZONE_TF_NAME[tf]) continue;
    const liq = snap.chart_plane?.liquidity;
    // Z1a: every active Prophet order block of the chart (the producer's chart_plane.zones.prophet).
    const prophet = off.has("prophet_zone") ? [] : prophetZoneBoxes(snap.chart_plane);
    for (const z of prophet) box("prophet_zone", tf, z.side, z.bottom, z.top, z.high_volume ? ZONE_PROPHET_WEIGHT.high_volume : ZONE_PROPHET_WEIGHT.active, { touches: z.touches });
    // Z1b: GMI's active Aegis validated order blocks of the chart (the producer's chart_plane.zones.aegis).
    // A box that is the same block as one of this chart's prophet_zone boxes counts once: it is recorded as provenance
    // on that box (no weight); with prophet_zone off, every gmi_ob box counts.
    const aegis = off.has("gmi_ob") ? [] : aegisZoneBoxes(snap.chart_plane);
    const chartProphet = boxes.filter((b) => b.source === "prophet_zone" && b.tf === tf);
    for (const z of aegis) {
      const same = chartProphet.find((b) => b.side === z.side && isNum(z.bottom) && isNum(z.top)
        && near(b.bottom, z.bottom) && near(b.top, z.top));
      if (same) { if (!same.also) same.also = ["gmi_ob"]; continue; }
      box("gmi_ob", tf, z.side, z.bottom, z.top, ZONE_GMI_OB_WEIGHT, { touches: z.touches });
    }
    for (const z of off.has("whale") || !Array.isArray(liq?.whale_zones) ? [] : liq.whale_zones) {
      const side = z?.role === "support" ? "demand" : z?.role === "resistance" ? "supply" : null;
      if (side) box("whale", tf, side, z.bottom, z.top, z.state === "active" ? ZONE_SOURCE_WEIGHT.whale_active : ZONE_SOURCE_WEIGHT.whale_mitigation);
    }
    const g = off.has("gabfx") ? null : liq?.gabfx;
    if (g && typeof g === "object") {
      for (const [k, side] of [["rbs", "demand"], ["qm_buy", "demand"], ["sbr", "supply"], ["qm_sell", "supply"]]) {
        if (isNum(g[k]) && g[k] > 0) box("gabfx", tf, side, g[k], g[k], ZONE_SOURCE_WEIGHT[k], { point: true });
      }
    }
    // The best blocks are among the active ones: dropped on a chart that has prophet_zone boxes.
    const ob = off.has("prophet_best") || prophet.length ? null : snap.huds?.order_blocks?.fields;
    if (ob) {
      box("prophet_best", tf, "demand", ob.bull_bottom, ob.bull_top, ZONE_SOURCE_WEIGHT.prophet_best);
      box("prophet_best", tf, "supply", ob.bear_bottom, ob.bear_top, ZONE_SOURCE_WEIGHT.prophet_best);
    }
    // The 15m GMI flags say price is inside a block: they type the zone holding price only. Z1b: dropped on a chart
    // that has gmi_ob boxes (the blocks themselves).
    const ae = tf === "15" && !off.has("gmi_flag") && !aegis.length ? snap.huds?.aegis_footprint?.fields : null;
    if (ae) {
      const flag = (side) => boxes.push({ source: "gmi_flag", tf, side, bottom: null, top: null, weight: r2(ZONE_SOURCE_WEIGHT.gmi_flag * ZONE_TF_WEIGHT[tf]), at_price: true });
      if (ae.in_bull_order_block === true || ae.in_bull_mitigation === true) flag("demand");
      if (ae.in_bear_order_block === true || ae.in_bear_mitigation === true) flag("supply");
    }
  }
  const bars = (Array.isArray(bars15) ? bars15 : []).filter((b) => isNum(b?.high) && isNum(b?.low)).slice(-(ZONE_RULES.touch_bars + 1));
  return { boxes, bars, atr_h1: isNum(atrH1) && atrH1 > 0 ? atrH1 : null };
}

/**
 * ZF1 (owner 2026-11-25: "ZF1 tepi kotak"): a box types the cluster its own edge made. A cluster's edges are written to
 * two decimals (key-level-agent.mjs clusterLevels, r2) while its members keep their prices, so a box whose edge is a
 * member could fall just outside the rounded band (the 15m whale demand bottom 3433.454 against its cluster's top
 * 3433.45) and miss it. A box edge (or a point) within BOX_EDGE_TOL of one of the zone's member prices types the zone.
 * Every other box still needs a strict overlap: a box that only touches a cluster it did not make still does not type it.
 */
export const BOX_EDGE_TOL = 0.001;
const edgeIsMember = (z, edge) => isNum(edge) && Array.isArray(z.members) && z.members.some((m) => isNum(m?.price) && Math.abs(m.price - edge) <= BOX_EDGE_TOL);

/** Pure: does a box type a zone ({ low, high, role, members? })? A strict overlap or an own edge (ZF1); a point inside or a member; a flag only at price. */
export function boxTypes(box, z) {
  if (box.at_price) return z.role === "at price";
  if (box.point) return (box.bottom >= z.low && box.bottom <= z.high) || edgeIsMember(z, box.bottom);
  return (box.bottom < z.high && box.top > z.low) || edgeIsMember(z, box.bottom) || edgeIsMember(z, box.top);
}

/**
 * Pure: the touches of [low, high] on `bars` (closed 15m, oldest first; the last is the decision bar, not counted):
 * the 40 bars before it, a bar within `band` of the zone, a touch at least 3 bars after the one counted before it
 * (core.mjs's rule), up to touch_cap. Null without bars or a band.
 */
export function zoneTouches(low, high, bars, band) {
  if (!Array.isArray(bars) || bars.length < 2 || !isNum(band)) return null;
  const i = bars.length - 1;
  let touches = 0, last = -10000;
  for (let back = 1; back <= ZONE_RULES.touch_bars; back++) {
    const k = i - back;
    if (k < 0) break;
    if (bars[k].low <= high + band && bars[k].high >= low - band && back - last >= ZONE_RULES.touch_gap) { touches += 1; last = back; }
  }
  return Math.min(touches, ZONE_RULES.touch_cap);
}
export const freshnessOf = (touches) => (!isNum(touches) ? null : touches === 0 ? "fresh" : touches < 3 ? "tested" : "worn");

/**
 * Pure overlay: sets z.ds = { type, strength, score, freshness, touches, sources } on every zone of `zones` (mutates
 * and returns them). Nothing else of a zone changes.
 */
export function zoneTypes(zones, evidence) {
  const boxes = Array.isArray(evidence?.boxes) ? evidence.boxes : [];
  const band = isNum(evidence?.atr_h1) ? ZONE_RULES.touch_band_atr * evidence.atr_h1 : null;
  for (const z of zones || []) {
    if (!z || !isNum(z.low) || !isNum(z.high)) continue;
    const best = { demand: new Map(), supply: new Map() };
    for (const b of boxes) {
      if (!boxTypes(b, z)) continue;
      const key = `${b.source}@${ZONE_TF_NAME[b.tf]}`;
      best[b.side].set(key, Math.max(best[b.side].get(key) ?? 0, b.weight));
    }
    const sum = (m) => [...m.values()].reduce((s, w) => s + w, 0);
    const d = sum(best.demand), s = sum(best.supply);
    const type = d > 0 && d >= ZONE_RULES.dominance * s ? "demand" : s > 0 && s >= ZONE_RULES.dominance * d ? "supply" : d > 0 && s > 0 ? "mixed" : "none";
    const score = r2(type === "demand" ? d : type === "supply" ? s : Math.max(d, s));
    const strength = type === "none" ? null : score >= ZONE_RULES.strong ? "strong" : score >= ZONE_RULES.medium ? "medium" : "weak";
    // Z1a: the most touches of the zone's own count and of the prophet_zone boxes typing it (each on its own chart's
    // bars, the core's rule), capped as the count: worn dominates. Z1b: the gmi_ob boxes' touches too.
    const own = zoneTouches(z.low, z.high, evidence?.bars, band);
    const boxTouches = boxes.filter((b) => BOX_TOUCH_SOURCES.has(b.source) && isNum(b.touches) && boxTypes(b, z)).map((b) => b.touches);
    const touches = boxTouches.length ? Math.min(ZONE_RULES.touch_cap, Math.max(own ?? 0, ...boxTouches)) : own;
    // Z1b: the sources that found the same block as a box typing the zone (provenance only, no weight); absent when none.
    const also = [...new Set(boxes.filter((b) => Array.isArray(b.also) && boxTypes(b, z)).flatMap((b) => b.also.map((a) => `${a}@${ZONE_TF_NAME[b.tf]}`)))].sort();
    z.ds = { type, strength, score, freshness: freshnessOf(touches), touches, sources: [...new Set([...best.demand.keys(), ...best.supply.keys()])].sort(), ...(also.length ? { also } : {}) };
  }
  return zones;
}

/** Pure: a demand or supply zone of medium or higher strength (z.ds, or the recorded words). */
export function decisive(z) {
  const type = z?.ds?.type ?? z?.zone_type, strength = z?.ds?.strength ?? z?.zone_strength;
  return (type === "demand" || type === "supply") && (strength === "medium" || strength === "strong");
}

/** Pure: a zone's words for a plan ({ type, strength, freshness }), or null for an untyped zone. */
export const zoneWords = (z) => (z?.ds ? { type: z.ds.type, strength: z.ds.strength, freshness: z.ds.freshness } : null);
/** Pure: do these zones carry types (KEY_LEVEL_ZONE_TYPES on)? */
export const typedZones = (zones) => Array.isArray(zones) && zones.some((z) => z?.ds && typeof z.ds === "object");

/**
 * Pure: the recorded set, keyLevelsAround's exact rule (src/decision-engine.mjs): the candidate or qualified zones
 * nearest to price, at most `n`, lowest first, { low, high } on the feed's scale, and beside them, when typed, the
 * words zone_type, zone_strength, zone_freshness and zone_rank ("candidate" | "qualified"), and (Z1b) ds_sources, the
 * source labels (dsSourceLabels) when it has any.
 */
/** Z1b: at most this many source labels per recorded level (ds_sources), each at most ZONE_SOURCE_LABEL_MAX chars. */
export const ZONE_SOURCE_LABELS_MAX = 12;
export const ZONE_SOURCE_LABEL_MAX = 32;
// Every ZONE_TF_NAME word (weekly included: a snapshot whose timeframe is "W" types as weekly).
const LABEL = new RegExp(`^[a-z_]+@(${[...new Set(Object.values(ZONE_TF_NAME))].join("|")})(\\(dup\\))?$`);
/**
 * Pure (Z1b): a typed zone's source labels for the recorded set, words only: its weighted sources (`prophet_zone@1H`)
 * sorted, then the same-block duplicates that added no weight as `<source>@<tf>(dup)` (`gmi_ob@1H(dup)`), sorted;
 * at most ZONE_SOURCE_LABELS_MAX. Null when there are none.
 */
export function dsSourceLabels(ds) {
  if (!ds || typeof ds !== "object") return null;
  const words = (list) => (Array.isArray(list) ? list.filter((l) => typeof l === "string" && l.length <= ZONE_SOURCE_LABEL_MAX) : []);
  const out = [...words(ds.sources).sort(), ...words(ds.also).map((l) => `${l}(dup)`).sort()]
    .filter((l) => l.length <= ZONE_SOURCE_LABEL_MAX && LABEL.test(l)).slice(0, ZONE_SOURCE_LABELS_MAX);
  return out.length ? out : null;
}

export function aroundSet(zones, price, n = ZONE_RULES.around) {
  const list = (zones || []).filter((z) => (z?.candidate || z?.qualified) && isNum(z.low) && isNum(z.high) && z.low <= z.high);
  if (!isNum(price) || !list.length) return [];
  const dist = (z) => (price < z.low ? z.low - price : price > z.high ? price - z.high : 0);
  return list.sort((a, b) => dist(a) - dist(b)).slice(0, n).map((z) => ({
    low: r2(z.low), high: r2(z.high),
    ...(z.ds ? { zone_type: z.ds.type, zone_strength: z.ds.strength, zone_freshness: z.ds.freshness, zone_rank: z.candidate ? "candidate" : "qualified" } : {}),
    // Z1b: the sources behind the type, for Z5's readings by source (zone_readings.ds_sources); absent when none.
    ...(z.ds && dsSourceLabels(z.ds) ? { ds_sources: dsSourceLabels(z.ds) } : {})
  })).sort((a, b) => a.low - b.low);
}

/**
 * Pure: the nearest decisive opposing zone ahead of the plan's entry, from the recorded set only (`around`, aroundSet's
 * output or a decision's key_levels): supply for a long (dir 1), demand for a short. A zone is ahead when part of it
 * lies beyond the entry; its room is the distance from the entry to its near edge (0 when the entry is inside it).
 * need = zoneNeed(risk, ATR(1H)); with_trend when dir x trend >= ZONE_TREND_LEAN; would_block when the room is short of
 * need and the plan is not with the trend (Z2's 'trend' rule; recorded only here). Null without an entry, a stop or an
 * ATR. Distances only (ATR and R), never a price.
 */
export function zoneAhead(plan, around, { dir, atrH1, trend = null } = {}) {
  if (!plan || !(dir === 1 || dir === -1) || ![plan.entry, plan.stop, atrH1].every(isNum) || atrH1 <= 0) return null;
  const entry = plan.entry, risk = Math.abs(entry - plan.stop);
  if (!(risk > 0)) return null;
  const want = dir > 0 ? "supply" : "demand";
  const opp = (Array.isArray(around) ? around : [])
    .filter((z) => z?.zone_type === want && decisive(z) && isNum(z.low) && isNum(z.high) && (dir > 0 ? z.high > entry : z.low < entry))
    .map((z) => ({ z, room: Math.max(0, dir > 0 ? z.low - entry : entry - z.high) }))
    .sort((a, b) => a.room - b.room)[0] ?? null;
  const need = zoneNeed(risk, atrH1);
  const lean = isNum(trend) ? r2(trend) : null;
  const withTrend = isNum(lean) && dir * lean >= ZONE_TREND_LEAN;
  return {
    o_type: opp ? opp.z.zone_type : null, o_strength: opp ? opp.z.zone_strength : null, o_freshness: opp ? opp.z.zone_freshness ?? null : null, o_rank: opp ? opp.z.zone_rank ?? null : null,
    room_atr: opp ? r2(opp.room / atrH1) : null, room_r: opp ? r2(opp.room / risk) : null, need_r: r2(need / risk),
    trend_lean: lean, with_trend: withTrend, would_block: Boolean(opp) && opp.room < need && !withTrend
  };
}

/**
 * Pure: the plan with plan.opposing_ahead from the strategy's recorded set (aroundSet of its Key Level Agent zones at
 * its price), its 1H ATR and its trend, both as the record keeps them. Called last, on the plan's final entry and stop.
 * The plan as it is when the zones are untyped (KEY_LEVEL_ZONE_TYPES off) or nothing can be measured.
 */
export function withZoneAhead(plan, strategy, dir) {
  const zones = strategy?.key_levels?.zones;
  if (!plan || !typedZones(zones)) return plan;
  const oa = zoneAhead(plan, aroundSet(zones, strategy.price), { dir, atrH1: strategy.atr_h1, trend: strategy.trend });
  return oa ? { ...plan, opposing_ahead: oa } : plan;
}

// ---------------------------------------------------------------- Z2: the zone_ahead check (decision side only)
// Owner 2026-11-23, "Langsung prioritaskan": no trade into a decisive opposing demand or supply zone against the trend.
// The check reads plan.opposing_ahead (zoneAhead above, recorded since Z0), so a stored decision replays it.

/** ZONE_AHEAD_MODE values: the check in the guardrails ('trend', 'all'), recorded only ('record'), none ('off'). */
export const ZONE_AHEAD_MODES = Object.freeze(["trend", "all", "record", "off"]);
/** The rule's version in rule_version (src/mode-shadow.mjs ruleVersionOf) while the check is in the guardrails. */
export const ZONE_AHEAD_RULE = "zone_ahead@1";

/**
 * ZONE_PRIORITY: "on" | "off". Unset reads "off" (a config without the variable behaves as before Z2); wrangler.jsonc
 * sets "on", the live default.
 */
export function zonePriorityMode(env) {
  return String(env?.ZONE_PRIORITY ?? "off").trim().toLowerCase() === "on" ? "on" : "off";
}

/**
 * The zone_ahead mode in force: ZONE_AHEAD_MODE ("trend" default, "all" owner-set only, "record", "off") while
 * ZONE_PRIORITY is on; "off" while it is off, and while the zones are untyped (KEY_LEVEL_ZONE_TYPES "off" in env or in
 * the strategy's modes: every Z rule then behaves as before). An unknown value reads "trend".
 */
export function zoneAheadMode(env, modes = null) {
  if (zonePriorityMode(env) !== "on" || keyLevelZoneTypesMode(env) === "off" || modes?.zoneTypes === "off") return "off";
  const v = String(env?.ZONE_AHEAD_MODE ?? "trend").trim().toLowerCase();
  return ZONE_AHEAD_MODES.includes(v) ? v : "trend";
}
/** Pure: is the check in the guardrails in this mode ('trend' or 'all')? */
export const zoneAheadChecks = (mode) => mode === "trend" || mode === "all";

/**
 * Pure: does a recorded opposing_ahead fail in `mode`? 'trend': would_block (room < need and dir x trend < 0.15, Z0's
 * exact rule); 'all': also a with-trend plan whose room is short of need (the recorded room_r against need_r, 2 dp).
 * No opposing zone, no record, or any other mode: false.
 */
export function zoneAheadFails(oa, mode) {
  if (!zoneAheadChecks(mode) || !oa || !oa.o_type) return false;
  if (oa.would_block === true) return true;
  return mode === "all" && isNum(oa.room_r) && isNum(oa.need_r) && oa.room_r < oa.need_r;
}

/**
 * Pure (Z2): an agent's plan passes the zone_ahead rule of its side's guardrails (`g.zone_ahead`, the mode guardrailsFor
 * recorded). True while the check is not in the guardrails, and for a plan without a recorded opposing zone.
 */
export function zonePlanPasses(plan, g) {
  return !zoneAheadFails(plan?.opposing_ahead ?? null, g?.zone_ahead ?? null);
}

/** Pure: the zone_ahead check of a side's plan in `mode`: { pass, detail }, the detail in words, ATR and R only. */
export function zoneAheadCheck(plan, mode, dir) {
  if (!plan) return { pass: true, detail: "no plan to check" };
  const oa = plan.opposing_ahead ?? null;
  if (!oa) return { pass: true, detail: "no recorded demand or supply zone to measure the room ahead against" };
  if (!oa.o_type) return { pass: true, detail: "no demand or supply zone against the trade within reach" };
  const zone = [oa.o_strength, oa.o_freshness, oa.o_type].filter(Boolean).join(" ");
  const side = dir > 0 ? "long" : "short";
  const where = oa.room_r === 0 ? `the ${side} entry sits inside a ${zone} zone (no room)` : `the nearest ${zone} zone lies ${oa.room_atr} ATR ahead of the ${side} entry (${oa.room_r}R)`;
  const lean = isNum(oa.trend_lean) ? `${oa.trend_lean > 0 ? "+" : ""}${oa.trend_lean}` : "unknown";
  const short = isNum(oa.room_r) && isNum(oa.need_r) && oa.room_r < oa.need_r;
  if (!short && oa.would_block !== true) return { pass: true, detail: `${where}, at least the ${oa.need_r}R it needs` };
  if (zoneAheadFails(oa, mode)) {
    return { pass: false, detail: mode === "all" && oa.would_block !== true
      ? `${where}, short of the ${oa.need_r}R it needs; the owner's 'all' mode exempts no trend (lean ${lean})`
      : `${where}, short of the ${oa.need_r}R it needs, and the trend (lean ${lean}) is not with the trade` };
  }
  return { pass: true, detail: `${where}, short of the ${oa.need_r}R it needs, but the trend (lean ${lean}) is with the trade: noted only` };
}

/** The rule_version token of the check in force (`ZONE_AHEAD_RULE`, `:all` in 'all'), or null when it is not in the guardrails. */
export function zoneRuleToken(env) {
  const mode = zoneAheadMode(env);
  return mode === "trend" ? ZONE_AHEAD_RULE : mode === "all" ? `${ZONE_AHEAD_RULE}:all` : null;
}

// ---------------------------------------------------------------- Z2b: execution plans aimed by zone type
// Owner 2026-11-23, "Langsung prioritaskan" (docs/RFC_DEMAND_SUPPLY_ZONES.md §6). The targets, the stop and the strategy
// pick read the zone types. Every rule runs on EXECUTION COPIES of the plans (src/decision-engine.mjs: the guardrails'
// plan in guardrailsFor, the agents' plans where assess attaches them), after agentsConsensus and the quorum, so the
// STRATEGY_AGENTS witness and the quorum read the plans as before; zoneAhead runs last on every aimed copy.
//   tp_typed   TP1-KZ's target set (the key zones, zone_rank "candidate"): a decisive opposing TP1 gains its words in
//              tp1_note, its price never changes ('label'); TP2 is the next decisive opposing key zone at least
//              tp2_gap_atr beyond TP1 and at least tp2_min_r, else today's TP2. 'qualified' (owner-set only, after the
//              owner amends TP1-KZ to tp1_kz@2): a decisive opposing qualified zone at or beyond ZONE_NEED, nearer than
//              TP1, becomes TP1. Inert with TP1_KEY_ZONE_MODE off, and for agents with their own targets.
//   stop_skip  the zone_pullback geometry's stop sits beyond the first zone at least stop_gap_atr beyond the entry that
//              is not a decisive opposing-type zone (supply under a long, demand over a short); today's pad, cap and
//              fallback. Structural stops (sweep, breakout, range, patterns) are unchanged.
//   factor     pickStrategy's score x zone_factor: factor_own for a decisive own-type entry zone that is fresh or
//              tested, factor_opposite for a decisive opposite-type one, else 1 (src/decision-engine.mjs pickStrategy).
// zone_rules = [{ rule, base_tp1_r, base_stop_atr }] on a copy a rule moved a price of (distances from the entry, never a
// price: Z5 and MS2's base arm rebuild the base from the entry); [{ rule, held: "rrr" }] on the base kept when the aimed
// copy fails the reward gate its base passed. Record only: never in the council's evidence, a card or a room.
// Switches: ZONE_PRIORITY (unset "off": none of Z2b), ZONE_AIM_OFF (tokens tp, stop, factor; default ""), ZONE_AIM_TP
// ("label" default | "qualified").

export const ZONE_AIM_RULE = "zone_aim@1";
export const ZONE_AIM_TOKENS = Object.freeze(["tp", "stop", "factor"]);
export const ZONE_AIM_TP_MODES = Object.freeze(["label", "qualified"]);
export const ZONE_AIM = Object.freeze({
  tp2_gap_atr: 0.5, tp2_min_r: 1.5,
  stop_gap_atr: 0.5, stop_pad_atr: 0.2, stop_cap_atr: 2.5, stop_fallback_atr: 1.5,
  factor_own: 1.2, factor_opposite: 0.85
});

/** ZONE_AIM_OFF: the ZONE_AIM_TOKENS left off, comma- or space-separated, in token order; unknown tokens are ignored. */
export function zoneAimOffMode(env) {
  const given = new Set(String(env?.ZONE_AIM_OFF ?? "").split(/[\s,]+/).map((t) => t.trim().toLowerCase()));
  return ZONE_AIM_TOKENS.filter((t) => given.has(t));
}
/** ZONE_AIM_TP: "label" (default) | "qualified" (owner-set only); an unknown value reads "label". */
export function zoneAimTpMode(env) {
  return String(env?.ZONE_AIM_TP ?? "label").trim().toLowerCase() === "qualified" ? "qualified" : "label";
}
/**
 * The Z2b rules in force: { tp: "label" | "qualified" | null, stop, factor } while ZONE_PRIORITY is on and the zones are
 * typed (KEY_LEVEL_ZONE_TYPES on in env and in the strategy's modes), with at least one rule on; else null (inert).
 */
export function zoneAimMode(env, modes = null) {
  if (zonePriorityMode(env) !== "on" || keyLevelZoneTypesMode(env) === "off" || modes?.zoneTypes === "off") return null;
  const off = zoneAimOffMode(env);
  if (off.length === ZONE_AIM_TOKENS.length) return null;
  return { tp: off.includes("tp") ? null : zoneAimTpMode(env), stop: !off.includes("stop"), factor: !off.includes("factor") };
}
/**
 * The rule_version token of Z2b (src/mode-shadow.mjs ruleVersionOf): ZONE_AIM_RULE, ":qualified" in that TP mode, and
 * ":no_<token>" for each rule left off; null while Z2b is inert.
 */
export function zoneAimRuleToken(env) {
  const aim = zoneAimMode(env);
  if (!aim) return null;
  return `${ZONE_AIM_RULE}${aim.tp === "qualified" ? ":qualified" : ""}${zoneAimOffMode(env).map((t) => `:no_${t}`).join("")}`;
}

const ownType = (dir) => (dir > 0 ? "demand" : "supply");
const oppType = (dir) => (dir > 0 ? "supply" : "demand");
/** Pure: a zone's words ({ type, strength, freshness }, a plan's zone_types entry) decisive and of `type`? */
const decisiveWords = (w, type) => Boolean(w) && w.type === type && decisive({ zone_type: w.type, zone_strength: w.strength });

/**
 * Pure: pickStrategy's zone factor for a plan on a side (dir 1 long, -1 short), from its entry zone's words
 * (plan.zone_types.entry): ZONE_AIM.factor_own for a decisive own-type zone (demand for a long) that is fresh or tested,
 * ZONE_AIM.factor_opposite for a decisive opposite-type zone, else 1. Null for a plan without zone_types (untyped).
 */
export function zoneFactorOf(plan, dir) {
  if (!plan?.zone_types || typeof plan.zone_types !== "object") return null;
  const e = plan.zone_types.entry ?? null;
  if (decisiveWords(e, ownType(dir)) && (e.freshness === "fresh" || e.freshness === "tested")) return ZONE_AIM.factor_own;
  if (decisiveWords(e, oppType(dir))) return ZONE_AIM.factor_opposite;
  return 1;
}

const tpWords = (z) => `(${[z.zone_type, z.zone_freshness].filter(Boolean).join(", ")})`;
const fresh = (z) => (z.zone_freshness ? ` (${z.zone_freshness})` : "");
const aroundWords = (z) => ({ type: z.zone_type, strength: z.zone_strength ?? null, freshness: z.zone_freshness ?? null });

/**
 * Pure (Z2b): the plan's execution copy aimed by zone type, or the plan itself when no rule applies. `around` is the
 * recorded set (aroundSet: the targets and zoneAhead read only it); ctx = { dir, atrH1, trend, aim (zoneAimMode),
 * keyZone (TP1-KZ on), typedTargets (the plan's targets come from the key zones), stopFromZones (the tradeLevels
 * geometry: its stop sits beyond a key-level zone), levels (zoneLevels of every zone, the stop's search set) }.
 * The entry never moves. A copy a rule moved a price of carries zone_rules and a fresh opposing_ahead (zoneAhead last,
 * on the final entry and stop); a label alone changes no price and records no rule.
 */
export function zoneAim(plan, around, { dir, atrH1, trend = null, aim = null, keyZone = false, typedTargets = false, stopFromZones = false, levels = [] } = {}) {
  if (!plan || !aim || !(dir === 1 || dir === -1) || ![plan.entry, plan.stop, plan.tp1, plan.tp2, atrH1].every(isNum) || atrH1 <= 0) return plan;
  if (!typedZones(levels) && !(Array.isArray(around) && around.some((z) => z?.zone_type))) return plan;
  const entry = plan.entry, baseRisk = Math.abs(entry - plan.stop);
  if (!(baseRisk > 0)) return plan;
  const out = { ...plan };
  const rules = [];
  const types = plan.zone_types && typeof plan.zone_types === "object" ? { ...plan.zone_types } : null;

  // stop_skip: past a decisive opposing-type zone to the first zone that is not one (today's gap, pad, cap and fallback).
  if (aim.stop && stopFromZones) {
    const lo = (z) => (isNum(z.low) ? z.low : z.price), hi = (z) => (isNum(z.high) ? z.high : z.price);
    const far = (z) => (dir > 0 ? lo(z) : hi(z));
    const gap = ZONE_AIM.stop_gap_atr * atrH1, pad = ZONE_AIM.stop_pad_atr * atrH1;
    const against = (z) => z?.ds?.type === oppType(dir) && decisive(z);
    const behind = (levels || []).filter((z) => isNum(far(z)) && dir * (entry - far(z)) >= gap).sort((a, b) => dir * (far(b) - far(a)));
    const first = behind[0] ?? null;
    // Only the plan's own stop zone (today's choice, its stop within a cent): a fallback or a structural stop is kept.
    if (first && against(first) && Math.abs(r2(far(first) - dir * pad) - plan.stop) < 0.01) {
      const next = behind.find((z) => !against(z)) ?? null;
      let stop = next ? far(next) - dir * pad : null, from = next;
      let note = next ? `beyond ${next.label}` : null;
      if (!isNum(stop) || Math.abs(entry - stop) > ZONE_AIM.stop_cap_atr * atrH1) { stop = entry - dir * ZONE_AIM.stop_fallback_atr * atrH1; note = "1.5 times the 1H average range"; from = null; }
      if (r2(stop) !== plan.stop) {
        out.stop = r2(stop); out.stop_note = note; out.risk = r2(Math.abs(entry - stop));
        if (types) types.stop = zoneWords(from);
        // EZ1: the entry zone's stop side stays within ENTRY_ZONE.stop_share (0.5) of the new risk.
        if (isNum(out.entry_low) && isNum(out.entry_high)) {
          const toStop = 0.5 * Math.abs(entry - stop);
          if (dir > 0) out.entry_low = r2(Math.max(out.entry_low, entry - toStop)); else out.entry_high = r2(Math.min(out.entry_high, entry + toStop));
          if (!(out.entry_high > out.entry_low)) { delete out.entry_low; delete out.entry_high; }
        }
        rules.push("stop_skip");
      }
    }
  }
  const risk = Math.abs(entry - out.stop);

  // tp_typed: TP1-KZ's set (the key zones of the recorded set), only for plans whose targets come from it.
  if (aim.tp && keyZone && typedTargets) {
    const edge = (z) => (dir > 0 ? z.low : z.high);
    const set = (Array.isArray(around) ? around : []).filter((z) => isNum(z?.low) && isNum(z?.high));
    const opposing = (z) => z.zone_type === oppType(dir) && decisive(z);
    const keys = set.filter((z) => z.zone_rank === "candidate");
    let t1 = keys.find((z) => Math.abs(edge(z) - plan.tp1) < 0.005) ?? null;
    if (aim.tp === "qualified") {
      const need = zoneNeed(risk, atrH1);
      const q = set.filter((z) => z.zone_rank === "qualified" && opposing(z) && dir * (edge(z) - entry) >= need - 1e-9 && dir * (edge(z) - plan.tp1) < 0)
        .sort((a, b) => dir * (edge(a) - edge(b)))[0] ?? null;
      if (q) {
        t1 = q;
        out.tp1 = r2(edge(q)); out.tp1_note = `the nearest ${q.zone_strength} ${q.zone_type} zone ahead${fresh(q)}`;
        if (types) types.tp1 = aroundWords(q);
      }
    }
    if (t1 && opposing(t1) && out.tp1 === plan.tp1) out.tp1_note = `${plan.tp1_note} ${tpWords(t1)}`;
    const t2 = keys.filter((z) => opposing(z) && dir * (edge(z) - out.tp1) >= ZONE_AIM.tp2_gap_atr * atrH1 - 1e-9 && Math.abs(edge(z) - entry) / risk >= ZONE_AIM.tp2_min_r)
      .sort((a, b) => dir * (edge(a) - edge(b)))[0] ?? null;
    if (t2 && r2(edge(t2)) !== plan.tp2) {
      out.tp2 = r2(edge(t2)); out.tp2_note = `the next ${t2.zone_strength} ${t2.zone_type} key zone${fresh(t2)}`;
      if (types) types.tp2 = aroundWords(t2);
    }
    if (out.tp1 !== plan.tp1 || out.tp2 !== plan.tp2) rules.push("tp_typed");
  }

  if (!rules.length) return out.tp1_note === plan.tp1_note ? plan : out;
  out.rrr = { tp1: r2(Math.abs(out.tp1 - entry) / risk), tp2: r2(Math.abs(out.tp2 - entry) / risk) };
  if (types) out.zone_types = types;
  const base = { base_tp1_r: r2(Math.abs(plan.tp1 - entry) / baseRisk), base_stop_atr: r2(baseRisk / atrH1) };
  out.zone_rules = rules.map((rule) => ({ rule, ...base }));
  // Z0 last: the opposing zone ahead on the final entry and stop.
  const oa = zoneAhead(out, around, { dir, atrH1, trend });
  if (oa) out.opposing_ahead = oa;
  return out;
}

/**
 * Pure (Z2b): the execution copy the side trades: `zoneAim`'s copy, unless it fails `passes` (the reward gate) where the
 * base passed: then the base, with zone_rules [{ rule, held: "rrr" }]. A base that fails the gate is not aimed (no rule
 * rescues a plan the gate refuses).
 */
export function zoneAimHeld(plan, around, ctx, passes = () => true) {
  if (!plan || !passes(plan)) return plan;
  const aimed = zoneAim(plan, around, ctx);
  if (aimed === plan || !aimed.zone_rules || passes(aimed)) return aimed;
  return { ...plan, zone_rules: aimed.zone_rules.map(({ rule }) => ({ rule, held: "rrr" })) };
}

/**
 * Pure (Z2b, MS2's base arm and Z5): the base plan's stop and first target rebuilt from a recorded plan's entry and its
 * zone_rules ({ entry, stop, tp1 }; distances only, so the prices are the entry's scale), or null when no rule moved a
 * price (the plan is its own base). `dir` 1 long, -1 short.
 */
export function zoneAimBase(plan, atrH1, dir) {
  const r = (Array.isArray(plan?.zone_rules) ? plan.zone_rules : []).find((x) => isNum(x?.base_stop_atr) && isNum(x?.base_tp1_r));
  if (!r || !isNum(plan.entry) || !isNum(atrH1) || !(dir === 1 || dir === -1)) return null;
  const risk = r.base_stop_atr * atrH1;
  return { entry: plan.entry, stop: r2(plan.entry - dir * risk), tp1: r2(plan.entry + dir * r.base_tp1_r * risk) };
}

// ---------------------------------------------------------------- Z6: supply and demand boxes as key levels
// Owner 2026-11-26: "Langsung signal + zone_sd" (straight to the signal, with the Omega setting zone_sd on). The boxes
// the typing reads (dsEvidence) become levels of their own beside the Key Level Agent's 12 clusters, each box ONE zone
// [bottom, top], never two points. Clusters, zoneLevels, squeezeOf, aroundSet, the plans and zoneAhead do not change:
// this reads the same evidence after the typing and returns a separate list (reading.sd_levels, decision.sd_levels).
//   merge     boxes of one side (demand or supply) that overlap by at least half of the narrower one merge: the higher
//             timeframe's box (then the heavier, then the lower) keeps its edges and its weight; the others are provenance
//             only (ds_sources `<source>@<tf>(dup)`, no weight), as Z1b's same-block rule;
//   exclude   a box the kept clusters (aroundSet, the recorded 12) already cover for at least half of its width, or whose
//             near edge (both edges when price is inside it) lies within near_edge_atr x ATR(1H) of a kept edge;
//   window    its distance from price (0 inside it) at most window_atr[tf] x ATR(1H) of its own timeframe;
//   cap       at most cap_per_side[tf] per side (demand, supply) per timeframe, then at most `max` overall: decisive
//             (medium or stronger) first, then the nearest, then the higher timeframe;
//   words     zone_type its side, zone_strength from its own weight (ZONE_RULES medium / strong), zone_freshness as the
//             typing's (its own touches and its boxes' touches), zone_rank "sd", tf (its timeframe in words), ds_sources.
// Only decisive boxes reach the signal (src/ea-signal.mjs managementFields, SD_LEVELS "signal"); weak ones are recorded.
// Switch: SD_LEVELS = "off" (default: nothing computed, nothing recorded) | "record" | "signal", through the strategy modes.

export const SD_LEVELS_MODES = Object.freeze(["off", "record", "signal"]);
export const SD_RANK = "sd";
export const SD_RULES = Object.freeze({
  window_atr: Object.freeze({ "15m": 3, "1H": 4, "4H": 6, daily: 8, weekly: 10 }),
  cap_per_side: Object.freeze({ "15m": 1, "1H": 2, "4H": 2, daily: 2, weekly: 1 }),
  max: 8, merge_share: 0.5, cover_share: 0.5, near_edge_atr: 0.3
});

/** SD_LEVELS: "off" (default) | "record" | "signal"; an unknown value reads "off". */
export function sdLevelsMode(env) {
  const v = String(env?.SD_LEVELS ?? "off").trim().toLowerCase();
  return v === "record" || v === "signal" ? v : "off";
}
/** The strategy modes' entry for SD_LEVELS: { sdLevels } when it is not "off", else {} (modes unchanged). */
export function sdLevelsModes(env) {
  const m = sdLevelsMode(env);
  return m === "off" ? {} : { sdLevels: m };
}
/** Pure: a modes value read as an SD_LEVELS mode ("off" unless "record" or "signal"). */
export const sdModeOf = (v) => (v === "record" || v === "signal" ? v : "off");

const sdWidth = (b) => b.top - b.bottom;
/** Pure: how much of the narrower of two boxes their overlap covers (0..1); a zero-width box inside the other is 1. */
function overlapShare(a, b) {
  const ov = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom);
  if (ov < 0) return 0;
  const w = Math.min(sdWidth(a), sdWidth(b));
  return w > 0 ? ov / w : 1;
}
/** Pure: how much of [low, high] the kept zones cover together (0..1); a zero-width box inside one is 1. */
function coveredShare(low, high, kept) {
  const parts = kept.map((k) => [Math.max(low, k.low), Math.min(high, k.high)]).filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  if (!(high > low)) return parts.length ? 1 : 0;
  let total = 0, end = -Infinity;
  for (const [a, b] of parts) {
    const from = Math.max(a, end);
    if (b > from) total += b - from;
    end = Math.max(end, b);
  }
  return total / (high - low);
}

/**
 * Pure (Z6): the supply and demand boxes as their own levels (see above), lowest first: [{ low, high, zone_type,
 * zone_strength, zone_freshness, zone_rank: "sd", tf, ds_sources? }], on the feed's scale. `evidence` is dsEvidence's
 * output (the same the zones were typed on), `zones` the typed zones near price (their recorded 12, aroundSet, are the
 * kept clusters). [] without a price or an ATR.
 */
export function sdLevels(evidence, zones, price, atrH1) {
  if (!isNum(price) || !isNum(atrH1) || atrH1 <= 0) return [];
  const boxes = (Array.isArray(evidence?.boxes) ? evidence.boxes : [])
    .filter((b) => b && !b.point && !b.at_price && isNum(b.bottom) && isNum(b.top) && b.top >= b.bottom && ZONE_TF_NAME[b.tf] && isNum(b.weight) && (b.side === "demand" || b.side === "supply"))
    .sort((a, b) => ZONE_TF_WEIGHT[b.tf] - ZONE_TF_WEIGHT[a.tf] || b.weight - a.weight || a.bottom - b.bottom || a.top - b.top || String(a.source).localeCompare(String(b.source)));
  // Merge: each box joins the first group of its side whose lead it overlaps by half the narrower one, else leads one.
  const groups = [];
  for (const b of boxes) {
    const g = groups.find((x) => x.lead.side === b.side && overlapShare(x.lead, b) >= SD_RULES.merge_share);
    if (g) g.members.push(b); else groups.push({ lead: b, members: [b] });
  }
  const kept = aroundSet(zones, price).filter((k) => isNum(k.low) && isNum(k.high));
  const nearBand = SD_RULES.near_edge_atr * atrH1;
  const band = isNum(evidence?.atr_h1) ? ZONE_RULES.touch_band_atr * evidence.atr_h1 : null;
  const out = [];
  for (const { lead, members } of groups) {
    const low = lead.bottom, high = lead.top, tf = ZONE_TF_NAME[lead.tf];
    const dist = price < low ? low - price : price > high ? price - high : 0;
    if (dist > SD_RULES.window_atr[tf] * atrH1 + 1e-9) continue;
    if (kept.length && coveredShare(low, high, kept) >= SD_RULES.cover_share) continue;
    const edges = price < low ? [low] : price > high ? [high] : [low, high];
    if (kept.some((k) => edges.some((e) => Math.abs(e - k.low) <= nearBand + 1e-9 || Math.abs(e - k.high) <= nearBand + 1e-9))) continue;
    const score = r2(lead.weight);
    const strength = score >= ZONE_RULES.strong ? "strong" : score >= ZONE_RULES.medium ? "medium" : "weak";
    const own = zoneTouches(low, high, evidence?.bars, band);
    const boxTouches = members.filter((b) => BOX_TOUCH_SOURCES.has(b.source) && isNum(b.touches)).map((b) => b.touches);
    const touches = boxTouches.length ? Math.min(ZONE_RULES.touch_cap, Math.max(own ?? 0, ...boxTouches)) : own;
    const leadLabel = `${lead.source}@${tf}`;
    const also = [...new Set([
      ...members.slice(1).map((b) => `${b.source}@${ZONE_TF_NAME[b.tf]}`),
      ...members.flatMap((b) => (Array.isArray(b.also) ? b.also.map((a) => `${a}@${ZONE_TF_NAME[b.tf]}`) : []))
    ])].sort();
    const labels = dsSourceLabels({ sources: [leadLabel], also });
    out.push({
      level: { low: r2(low), high: r2(high), zone_type: lead.side, zone_strength: strength, zone_freshness: freshnessOf(touches), zone_rank: SD_RANK, tf, ...(labels ? { ds_sources: labels } : {}) },
      dist, rank: ZONE_TF_WEIGHT[lead.tf]
    });
  }
  const order = (a, b) => (decisive(a.level) ? 0 : 1) - (decisive(b.level) ? 0 : 1) || a.dist - b.dist || b.rank - a.rank || a.level.low - b.level.low;
  const count = new Map();
  const capped = out.sort(order).filter(({ level }) => {
    const k = `${level.tf}|${level.zone_type}`, n = count.get(k) ?? 0;
    if (n >= SD_RULES.cap_per_side[level.tf]) return false;
    count.set(k, n + 1);
    return true;
  });
  return capped.slice(0, SD_RULES.max).map((x) => x.level).sort((a, b) => a.low - b.low || a.high - b.high);
}

/**
 * Pure (Z6): opposing_ahead_sd, the counterfactual zoneAhead of a plan over the recorded set AND the decisive sd levels
 * (zoneAhead itself reads only the recorded set; this is recorded only and nothing reads it for a decision).
 */
export function zoneAheadSd(plan, around, sd, ctx) {
  const extra = (Array.isArray(sd) ? sd : []).filter((z) => decisive(z));
  if (!extra.length) return null;
  return zoneAhead(plan, [...(Array.isArray(around) ? around : []), ...extra], ctx);
}
