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
// each weight times the chart's TF_WEIGHT (15m 1, 1H 1.5, 4H 2, daily 2.5). A box types a zone on a strict overlap; a
// point must lie inside the zone. Per side, a (source, timeframe) adds only its heaviest box, so two overlapping 15m
// whales count once. Type: demand when demand_w > 0 and demand_w >= 2 x supply_w, supply in the mirror case, mixed when
// both are > 0, else none. Strength on the type's score: strong >= 2.0, medium >= 1.0, else weak. A lone 1H-or-higher
// box is medium; a lone 15m RBS or SBR point (1.0 x 1) is medium too, so decisive; a lone 15m whale (0.9) stays weak.
// Freshness: the touches of the zone on the 40 closed 15m bars before the decision bar (a 10-hour window for every zone
// timeframe), within 0.15 x ATR(1H), at least 3 bars apart (Prophet's rule, local-engines/prophet-r38/src/core.mjs),
// counted up to 3: 0 fresh, 1-2 tested, 3 worn.
// zoneAhead reads only the recorded set (aroundSet, the decision's key_levels with their zone words), so a replay of a
// stored decision reproduces it. Switch: KEY_LEVEL_ZONE_TYPES = "on" (default) | "off" (no typed field anywhere),
// through the strategy modes. ZONE_SOURCES_OFF (Z1a): a list of ZONE_SOURCES tokens left out of the typing, through the
// strategy modes too; "prophet_zone" restores Z0's typing.

import { prophetZoneBoxes } from "./level-readers.mjs";

export const ZONE_TYPES_VERSION = "cryptophys.zone-types.v1";
/** The Key Level Agent's timeframe weights (src/key-level-agent.mjs TF_WEIGHT; a test holds them equal). */
export const ZONE_TF_WEIGHT = Object.freeze({ "15": 1, "60": 1.5, "240": 2, D: 2.5, "1D": 2.5, W: 3 });
/** Source labels use these words, never a period number: "240" would read like a price (public-projection PRICE_LIKE). */
export const ZONE_TF_NAME = Object.freeze({ "15": "15m", "60": "1H", "240": "4H", D: "daily", "1D": "daily", W: "weekly" });
/** The readers' own base weights (src/level-readers.mjs, src/key-level-agent.mjs), and the 15m GMI flag. */
export const ZONE_SOURCE_WEIGHT = Object.freeze({ whale_active: 0.9, whale_mitigation: 0.7, prophet_best: 0.7, rbs: 1, sbr: 1, qm_buy: 0.9, qm_sell: 0.9, gmi_flag: 0.7 });
/** Z1a: an active Prophet order block's base weight, and its weight when the core flags its source bar high_volume. */
export const ZONE_PROPHET_WEIGHT = Object.freeze({ active: 0.7, high_volume: 0.9 });
/** The evidence sources, the tokens of ZONE_SOURCES_OFF. */
export const ZONE_SOURCES = Object.freeze(["prophet_zone", "prophet_best", "whale", "gabfx", "gmi_flag"]);
export const ZONE_RULES = Object.freeze({
  dominance: 2, medium: 1, strong: 2,
  touch_band_atr: 0.15, touch_bars: 40, touch_gap: 3, touch_cap: 3,
  around: 12
});
/** Z0/Z2b's room an opposing zone must leave ahead of the entry: max(1.0 x risk, 0.75 x ATR(1H)). */
export const ZONE_NEED = Object.freeze({ risk: 1, atr: 0.75 });
/** The trend lean that exempts a plan (src/strategy-engine.mjs STRATEGY_PARAMS.lean; a test holds them equal). */
export const ZONE_TREND_LEAN = 0.15;
const CHARTS = Object.freeze(["15", "60", "240", "1D"]);

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
 * Pure: the demand and supply evidence of the charts ({ "15", "60", "240", "1D" } HUD snapshots), with the closed 15m
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
    // The 15m GMI flags say price is inside a block: they type the zone holding price only.
    const ae = tf === "15" && !off.has("gmi_flag") ? snap.huds?.aegis_footprint?.fields : null;
    if (ae) {
      const flag = (side) => boxes.push({ source: "gmi_flag", tf, side, bottom: null, top: null, weight: r2(ZONE_SOURCE_WEIGHT.gmi_flag * ZONE_TF_WEIGHT[tf]), at_price: true });
      if (ae.in_bull_order_block === true || ae.in_bull_mitigation === true) flag("demand");
      if (ae.in_bear_order_block === true || ae.in_bear_mitigation === true) flag("supply");
    }
  }
  const bars = (Array.isArray(bars15) ? bars15 : []).filter((b) => isNum(b?.high) && isNum(b?.low)).slice(-(ZONE_RULES.touch_bars + 1));
  return { boxes, bars, atr_h1: isNum(atrH1) && atrH1 > 0 ? atrH1 : null };
}

/** Pure: does a box type a zone ({ low, high, role })? A strict overlap; a point inside; a flag only at price. */
export function boxTypes(box, z) {
  if (box.at_price) return z.role === "at price";
  if (box.point) return box.bottom >= z.low && box.bottom <= z.high;
  return box.bottom < z.high && box.top > z.low;
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
    // bars, the core's rule), capped as the count: worn dominates.
    const own = zoneTouches(z.low, z.high, evidence?.bars, band);
    const boxTouches = boxes.filter((b) => b.source === "prophet_zone" && isNum(b.touches) && boxTypes(b, z)).map((b) => b.touches);
    const touches = boxTouches.length ? Math.min(ZONE_RULES.touch_cap, Math.max(own ?? 0, ...boxTouches)) : own;
    z.ds = { type, strength, score, freshness: freshnessOf(touches), touches, sources: [...new Set([...best.demand.keys(), ...best.supply.keys()])].sort() };
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
 * words zone_type, zone_strength, zone_freshness and zone_rank ("candidate" | "qualified").
 */
export function aroundSet(zones, price, n = ZONE_RULES.around) {
  const list = (zones || []).filter((z) => (z?.candidate || z?.qualified) && isNum(z.low) && isNum(z.high) && z.low <= z.high);
  if (!isNum(price) || !list.length) return [];
  const dist = (z) => (price < z.low ? z.low - price : price > z.high ? price - z.high : 0);
  return list.sort((a, b) => dist(a) - dist(b)).slice(0, n).map((z) => ({
    low: r2(z.low), high: r2(z.high),
    ...(z.ds ? { zone_type: z.ds.type, zone_strength: z.ds.strength, zone_freshness: z.ds.freshness, zone_rank: z.candidate ? "candidate" : "qualified" } : {})
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
