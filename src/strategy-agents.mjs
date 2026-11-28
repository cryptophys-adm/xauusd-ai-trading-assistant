// Strategy agents (owner 2026-11-13: "bukan hanya logicnya, itu static, kita perlu agent yang bisa
// dibongkar pasang menyesuaikan strategy yang tepat yang dipilih oleh council";
// docs/RFC_STRATEGY_AGENTS.md). Until now one fixed logic placed every plan (src/strategy-engine.mjs
// tradeLevels: a pullback to the nearest key zone). A strategy agent is one way of trading price action,
// behind one interface, so agents can be added, removed and switched without touching the engine:
//
//   { id, version, label, fits, plan(dir, ctx) }
//
//   fits   one sentence for the council: the price action this strategy is made for.
//   plan   pure and deterministic: the agent's plan for a direction (1 long, -1 short) from the context
//          { price, atr (1H), levels (the Key Level Agent's zones), bars (closed 15m, oldest first),
//          regime (the 1H regime label), scalp, strategy, patterns and calibration (the Projection
//          Agent's chart patterns and each pattern's measured record on gold) }, in the shape of tradeLevels' plan, or null
//          when its setup is not on the chart. An agent never reads a room, a witness or the quorum: the
//          council decides the side, the agent only says where its strategy would enter, stop and target.
//
// Status per agent: "live" (the council may choose it), "shadow" (its plan is recorded with every decision
// and measured by the plan learner, never traded) or "off" (not computed). zone_pullback, the plan of
// before, is always live and is the plan whenever the council names no other. The others start in shadow;
// STRATEGY_AGENTS_LIVE and STRATEGY_AGENTS_OFF (comma-separated ids) move them (production: all three live
// since 2026-11-13, owner: "live sekarang langsung implementasi"), and a breaker turns a live agent with a
// negative measured record back to shadow by itself. STRATEGY_AGENTS_MODE =
// "on" (default) | "off" (only zone_pullback; nothing else is computed or recorded).

import { planForDirection, zoneLevels, SCALP_TARGET, TP1_MIN_R, tp1KeyZoneOf, entryZoneOf } from "./strategy-engine.mjs";
import { patternInfo, PATTERN_CATALOG } from "./chart-patterns.mjs";
import { CONFIDENCE_STABLE_BAND } from "./agent-confidence.mjs";
import { zoneWords, typedZones, withZoneAhead } from "./zone-types.mjs";
import { openingRanges } from "./opening-range.mjs";
import { FRESH_PATTERN, breakoutAgeBars, freshPatternRecord } from "./fresh-pattern.mjs";
export { confidenceTrend, flatConfidences, parseConfidences } from "./agent-confidence.mjs";

export const STRATEGY_AGENTS_VERSION = "cryptophys.strategy-agents.v1";
export const DEFAULT_AGENT = "zone_pullback";
export const AGENT_STATUSES = Object.freeze(["live", "shadow", "off"]);
/** The first target's note when no key level lies ahead (as src/strategy-engine.mjs tradeLevels). */
export const PROJECTION_NOTE = "a 2R projection";
export const AGENT_RULES = Object.freeze({
  min_risk_atr: 0.25, max_risk_atr: 2.5, pad_atr: 0.1, target_gap_atr: 0.5,
  sweep: Object.freeze({ bars: 3, lookback: 12, through_atr: 0.05 }),
  breakout: Object.freeze({ bars: 6, base_bars: 3, beyond_atr: 0.1, retest_atr: 0.15 }),
  range: Object.freeze({ bars: 32, min_bars: 24, min_atr: 1, max_atr: 4, zone: 0.35, at: 0.2, entry: 0.15, stop_atr: 0.25, far: 0.1 }),
  pattern: Object.freeze({ charts: Object.freeze(["15", "60"]), retest_atr: 0.15, momentum_atr: 0.35, min_factor: 1, council_max: 6 }),
  inside: Object.freeze({ family: "lines", min_width_atr: 0.8, zone: 0.25, beyond_atr: 0.1, at_atr: 0.15, entry: 0.05, stop_atr: 0.25, far: 0.1 }),
  // Track A PR 7: the London and New York opening ranges (src/opening-range.mjs), three 15m bars each.
  orb: Object.freeze({ range_bars: 3, min_width_atr: 0.25, max_width_atr: 3.5 })
});

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;
const lo = (z) => (isNum(z.low) ? z.low : z.price), hi = (z) => (isNum(z.high) ? z.high : z.price);
const hours = (bars) => Math.round((bars * 15) / 60);

/** Pure: the key levels ahead as targets, as tradeLevels: the nearest major zone, then one 1.5R or more away. */
function targetsAhead({ dir, entry, risk, levels, atr, gapAtr, keyZone = false }) {
  const edge = (z) => (dir > 0 ? lo(z) : hi(z));
  const ahead = (levels || []).filter((z) => z.major !== false && dir * (edge(z) - entry) >= gapAtr * atr).sort((a, b) => dir * (edge(a) - edge(b)));
  // TP1-KZ (src/strategy-engine.mjs TP1_MIN_R): the nearest key zone ahead, never jumped; under 1R, no targets.
  const t1 = keyZone ? tp1KeyZoneOf(ahead, levels, { dir, entry, tgap: gapAtr * atr, edge }) : ahead[0] ?? null;
  const t2 = t1 ? ahead.find((z) => dir * (edge(z) - edge(t1)) >= 0.5 * atr && Math.abs(edge(z) - entry) / risk >= 1.5) ?? null : null;
  const tp1 = t1 ? edge(t1) : entry + dir * 2 * risk;
  if (keyZone && Math.abs(tp1 - entry) / risk < TP1_MIN_R) return null;
  return {
    tp1, tp1_note: t1 ? t1.label : PROJECTION_NOTE,
    tp2: t2 ? edge(t2) : entry + dir * Math.max(3 * risk, Math.abs(tp1 - entry) + risk), tp2_note: t2 ? t2.label : "a projection beyond the first target",
    // Z0 (recorded only): the type words of the two target zones, with typed zones.
    ...(typedZones(levels) ? { zone_types: { tp1: zoneWords(t1), tp2: zoneWords(t2) } } : {})
  };
}

/**
 * Pure, Z0 (recorded only): the type words of the zones an agent's plan stands on, from the typed levels: the entry's
 * zone (the one holding the entry), the stop's (the zone between the entry and the stop whose far edge lies nearest the
 * stop: the structure the stop hides behind) and each target's (targetsAhead's own zone, else the zone holding the
 * target). Null where no zone is. Without typed levels: null (no zone_types on the plan).
 */
function planZoneTypes(dir, levels, { entry, stop, t }) {
  if (!typedZones(levels)) return null;
  const holding = (p) => (levels || []).find((z) => p >= lo(z) && p <= hi(z)) ?? null;
  const far = (z) => (dir > 0 ? lo(z) : hi(z));
  const behind = (levels || []).filter((z) => dir * (entry - far(z)) > 0 && dir * (far(z) - stop) >= 0).sort((a, b) => dir * (far(a) - far(b)))[0] ?? null;
  const own = t.zone_types;
  return { entry: zoneWords(holding(entry)), stop: zoneWords(behind), tp1: own ? own.tp1 : zoneWords(holding(t.tp1)), tp2: own ? own.tp2 : zoneWords(holding(t.tp2)) };
}

/**
 * Pure, TP1-KZ2 (owner 2026-11-23, "setuju": TP1-KZ applies to the pattern agents too): an agent's own targets under
 * TP1_KEY_ZONE_MODE "on". TP1 is the key-zone first target (`kz`, targetsAhead with keyZone: the nearest key zone beyond
 * the gap, never jumped, at least TP1_MIN_R; null, no plan, when it pays less), exactly as the default agent's. The
 * agent's own measured target (`own.measured`, else none) becomes TP2 when it lies beyond that TP1; else the agent's own
 * TP2 when it is not short of TP1; else the key-zone second target. A measured target left short of TP1 stays named in
 * the TP2 note. `own`: { tp1, tp1_note, tp2, tp2_note, measured?: { price, note } }.
 */
export function ownTargetsUnderKeyZone(dir, own, kz) {
  if (!kz) return null;
  const beyond = (x, strict) => isNum(x) && (strict ? dir * (x - kz.tp1) > 0 : dir * (x - kz.tp1) >= 0);
  const m = own?.measured;
  if (m && beyond(m.price, true)) return { tp1: kz.tp1, tp1_note: kz.tp1_note, tp2: m.price, tp2_note: m.note };
  const short = m && isNum(m.price) ? `; ${m.note} (${r2(m.price).toFixed(2)}) lies short of the first key zone` : "";
  if (beyond(own?.tp2, false)) return { tp1: kz.tp1, tp1_note: kz.tp1_note, tp2: own.tp2, tp2_note: `${own.tp2_note}${short}` };
  return { tp1: kz.tp1, tp1_note: kz.tp1_note, tp2: kz.tp2, tp2_note: `${kz.tp2_note}${short}` };
}

/**
 * Pure: a plan in tradeLevels' shape from an agent's entry and stop. The stop is at least MIN_RISK ATR
 * away (a closer one is moved out); a stop farther than MAX_RISK ATR is no plan. Targets are the key
 * levels ahead unless the agent gives its own.
 */
export function finishPlan(agent, dir, { entry, stop, atLevel, entryNote, stopNote, setup, targets = null }, ctx) {
  const atr = ctx.atr;
  if (![entry, stop, atr].every(isNum) || atr <= 0) return null;
  let s = stop, note = stopNote;
  if (dir * (entry - s) < AGENT_RULES.min_risk_atr * atr) { s = entry - dir * AGENT_RULES.min_risk_atr * atr; note = `${AGENT_RULES.min_risk_atr} times the 1H average range (the structure is closer)`; }
  const risk = dir * (entry - s);
  if (risk > AGENT_RULES.max_risk_atr * atr) return null;
  const gapAtr = ctx.scalp ? SCALP_TARGET.targetGapAtr : AGENT_RULES.target_gap_atr;
  // TP1-KZ2 (owner 2026-11-23, "setuju"): an agent with its own targets takes TP1 at the key zone too (ownTargetsUnderKeyZone).
  const t = targets
    ? (ctx.keyZone === true ? ownTargetsUnderKeyZone(dir, targets, targetsAhead({ dir, entry, risk, levels: ctx.levels, atr, gapAtr, keyZone: true })) : targets)
    : targetsAhead({ dir, entry, risk, levels: ctx.levels, atr, gapAtr, keyZone: ctx.keyZone === true });
  if (!t) return null;
  if (!(dir * (t.tp1 - entry) > 0) || !(dir * (t.tp2 - t.tp1) >= 0)) return null;
  const rr = (tp) => r2(Math.abs(tp - entry) / risk);
  // EZ1 (src/strategy-engine.mjs ENTRY_ZONE): a structural plan's entry zone, the entry +/- 0.15 x ATR(1H).
  const zone = ctx.entryZone === true ? entryZoneOf({ dir, entry, stop: s, atrH1: atr }) : null;
  const types = planZoneTypes(dir, ctx.levels, { entry, stop: s, t });
  const plan = {
    agent, setup, at_level: atLevel === true, entry: r2(entry), entry_note: entryNote, ...(zone ?? {}), stop: r2(s), stop_note: note, risk: r2(risk),
    tp1: r2(t.tp1), tp1_note: t.tp1_note, tp2: r2(t.tp2), tp2_note: t.tp2_note, progressive_stop: r2(entry), rrr: { tp1: rr(t.tp1), tp2: rr(t.tp2) },
    ...(types ? { zone_types: types } : {})
  };
  // Z0 (recorded only): the nearest decisive opposing zone ahead, last, on the final entry and stop (src/zone-types.mjs).
  return withZoneAhead(plan, ctx.strategy, dir);
}

const zonePullback = Object.freeze({
  id: DEFAULT_AGENT, version: 1, label: "Zone pullback",
  fits: "Any market: enter at the nearest key zone behind price (or at price when it already holds there), the stop behind the next zone, the target at the next key level. The plan of every decision before the agents.",
  plan(dir, ctx) {
    const p = ctx.basePlan ?? planForDirection(ctx.strategy, dir, { scalp: ctx.scalp === true, keyZone: ctx.keyZone === true, entryZone: ctx.entryZone === true });
    return p ? { ...p, agent: DEFAULT_AGENT, setup: p.at_level ? "price holds at a key zone" : "a pullback to the nearest key zone" } : null;
  }
});

const sweepReversal = Object.freeze({
  id: "sweep_reversal", version: 1, label: "Sweep reversal",
  fits: "A stop hunt: within the last three 15m bars price went through a key zone to a new 3-hour extreme and the last bar closed back inside. Enter at the close with the stop just beyond the sweep's extreme: a tight stop, a quick invalidation. Not for a trend that keeps closing beyond the zone.",
  plan(dir, ctx) {
    const R = AGENT_RULES.sweep, bars = ctx.bars || [], last = bars.at(-1);
    if (!last || bars.length < R.lookback || !isNum(ctx.price)) return null;
    const recent = bars.slice(-R.bars), window = bars.slice(-R.lookback);
    // For a long the sweep is below a support zone; for a short above a resistance zone.
    const far = (z) => (dir > 0 ? lo(z) : hi(z));
    const wick = (b) => (dir > 0 ? b.low : b.high);
    const extreme = recent.reduce((x, b) => (dir * (wick(b) - x) < 0 ? wick(b) : x), wick(recent[0]));
    const lowest = window.every((b) => dir * (wick(b) - extreme) >= 0);
    if (!lowest) return null;
    const zone = (ctx.levels || []).filter((z) => dir * (far(z) - extreme) >= R.through_atr * ctx.atr && dir * (last.close - far(z)) > 0)
      .sort((a, b) => dir * (far(a) - far(b)))[0];
    if (!zone) return null;
    return finishPlan(this.id, dir, {
      entry: ctx.price, atLevel: true, stop: extreme - dir * AGENT_RULES.pad_atr * ctx.atr,
      entryNote: `price swept ${dir > 0 ? "below" : "above"} ${zone.label} and closed back ${dir > 0 ? "above" : "below"} it`,
      stopNote: `beyond the sweep's ${dir > 0 ? "low" : "high"}`,
      setup: `a sweep of ${zone.label} reclaimed at the 15m close`
    }, ctx);
  }
});

const breakoutRetest = Object.freeze({
  id: "breakout_retest", version: 1, label: "Break and retest",
  fits: "A trend continuing: within the last six 15m bars a bar closed beyond a key zone that had held price back for at least three bars, and no bar has closed back through it. Enter on the retest of the broken zone's edge, the stop behind the zone (or the breakout bar), the target at the next key level. Not for a range, where breaks fail.",
  plan(dir, ctx) {
    const R = AGENT_RULES.breakout, bars = ctx.bars || [];
    if (bars.length < R.bars + R.base_bars || !isNum(ctx.price)) return null;
    const near = (z) => (dir > 0 ? hi(z) : lo(z)), far = (z) => (dir > 0 ? lo(z) : hi(z));
    const start = bars.length - R.bars;
    // The broken zones now behind price, nearest first.
    const behind = (ctx.levels || []).filter((z) => dir * (ctx.price - near(z)) >= 0).sort((a, b) => dir * (near(b) - near(a)));
    for (const z of behind) {
      for (let i = bars.length - 1; i >= start; i--) {
        // A break: the bars before it closed on the other side of the edge (the zone held price back).
        const broke = dir * (bars[i].close - near(z)) >= R.beyond_atr * ctx.atr && bars.slice(i - R.base_bars, i).every((b) => dir * (b.close - near(z)) <= 0);
        if (!broke) continue;
        if (bars.slice(i + 1).some((b) => dir * (b.close - far(z)) < 0)) break;
        const retesting = dir * (ctx.price - near(z)) <= R.retest_atr * ctx.atr;
        const barEdge = dir > 0 ? bars[i].low : bars[i].high;
        // The tighter of the zone's far edge and the breakout bar's own extreme.
        const base = dir * (barEdge - far(z)) > 0 ? barEdge : far(z);
        return finishPlan(this.id, dir, {
          entry: retesting ? ctx.price : near(z), atLevel: retesting, stop: base - dir * AGENT_RULES.pad_atr * ctx.atr,
          entryNote: retesting ? `price retests ${z.label} after the break` : `a retest of ${z.label} after the break`,
          stopNote: base === far(z) ? `behind ${z.label}` : "behind the breakout bar",
          setup: `a 15m close ${dir > 0 ? "above" : "below"} ${z.label} that held`
        }, ctx);
      }
    }
    return null;
  }
});

const rangeFade = Object.freeze({
  id: "range_fade", version: 1, label: "Range fade",
  fits: "A ranging 1H regime: price near the edge of its 8-hour range. Enter at the edge, the stop a quarter of the 1H average range beyond it, the first target the middle of the range and the second its far side. Not for a trending regime or a range that is breaking.",
  plan(dir, ctx) {
    const R = AGENT_RULES.range, bars = (ctx.bars || []).slice(-R.bars);
    if (typeof ctx.regime !== "string" || !ctx.regime.endsWith("ranging") || bars.length < R.min_bars || !isNum(ctx.price)) return null;
    const top = Math.max(...bars.map((b) => b.high)), bottom = Math.min(...bars.map((b) => b.low)), height = top - bottom;
    if (!(height >= R.min_atr * ctx.atr) || height > R.max_atr * ctx.atr) return null;
    const edge = dir > 0 ? bottom : top;
    // How far price is from the edge it would fade, as a share of the range.
    const pos = (dir * (ctx.price - edge)) / height;
    if (pos < 0 || pos > R.zone) return null;
    const at = pos <= R.at, span = `${hours(bars.length)}-hour range`;
    return finishPlan(this.id, dir, {
      entry: at ? ctx.price : edge + dir * R.entry * height, atLevel: at, stop: edge - dir * R.stop_atr * ctx.atr,
      entryNote: at ? `price is at the ${dir > 0 ? "bottom" : "top"} of its ${span}` : `a return to the ${dir > 0 ? "bottom" : "top"} of the ${span}`,
      stopNote: `beyond the ${dir > 0 ? "bottom" : "top"} of the ${span}`,
      setup: `the ${dir > 0 ? "bottom" : "top"} of a ${span} in a ranging regime`,
      targets: { tp1: edge + dir * 0.5 * height, tp1_note: `the middle of the ${span}`, tp2: edge + dir * (1 - R.far) * height, tp2_note: `the ${dir > 0 ? "top" : "bottom"} of the ${span}` }
    }, ctx);
  }
});

/**
 * The pattern families (owner 2026-11-13: the Projection Agent's 53 chart patterns and 10 event patterns,
 * each family a strategy of its own; "benar"). A family is traded by its own rule, the patterns' own way
 * of being confirmed and of failing, written here from the method and to be measured on gold:
 *   entry   "retest": these patterns return to the line they broke, so the entry waits there (or is at
 *           price within RETEST_ATR of it); "momentum": these run from the breakout, so the entry is at
 *           price within the wider MOMENTUM_ATR of the line.
 *   stop    behind the broken line: either a share of the pattern's height (a move that far back says
 *           the reversal failed), or the pattern's other line (a close beyond it is the busted pattern),
 *           never farther than `cap` x the 1H ATR.
 *   target  `first`: the share of the measured move the first target takes (curves reach half the measure
 *           far more often than the whole); the second target is the measured target, or half the
 *           pattern's height beyond it when the first already is the whole measure.
 */
export const PATTERN_FAMILIES = Object.freeze({
  peaks: Object.freeze({ label: "Reversal tops and bottoms", what: "double and triple tops and bottoms, head-and-shoulders, three falling peaks and three rising valleys", entry: "retest", stop: Object.freeze({ height: 0.5, cap: 1.25 }), first: 1, style: "A reversal: price closed through the pattern's confirmation line. Enter on the return to that line, the stop half the pattern's height back inside it." }),
  lines: Object.freeze({ label: "Triangles, wedges and rectangles", what: "triangles, wedges, rectangles, broadening formations and diamonds", entry: "retest", stop: Object.freeze({ other: true, cap: 1 }), first: 1, style: "A breakout from two boundary lines. Enter on the return to the broken line, the stop beyond the pattern's other line, where the pattern would be busted." }),
  curve: Object.freeze({ label: "Rounded turns", what: "cup with handle, rounding tops and bottoms, scallops and bump-and-run reversals", entry: "retest", stop: Object.freeze({ height: 0.33, cap: 1.25 }), first: 0.5, style: "A slow rounded turn that broke its rim. Enter on the return to the rim, the stop a third of the pattern's height behind it, the first target half the measured move." }),
  bars: Object.freeze({ label: "Spike pairs", what: "horns and pipes", entry: "retest", stop: Object.freeze({ other: true, cap: 1.25 }), first: 1, style: "Two spikes that marked a turn. Enter on the return to the level they broke, the stop beyond the spikes' own extreme." }),
  pole: Object.freeze({ label: "Flags and pennants", what: "flags, pennants and the high and tight flag", entry: "momentum", stop: Object.freeze({ other: true, cap: 1 }), first: 1, style: "A pause after a sharp run that broke the way of the run. These seldom return: enter near the breakout, the stop beyond the flag's other side, the target the pole's length." }),
  gaps: Object.freeze({ label: "Gaps and islands", what: "gaps, island reversals and long islands", entry: "retest", stop: Object.freeze({ other: true, cap: 1 }), first: 1, style: "A gap that held. Enter on the return to the gap's edge, the stop beyond its other edge." }),
  legs: Object.freeze({ label: "Measured moves", what: "the measured move up and down", entry: "momentum", stop: Object.freeze({ other: true, cap: 1.25 }), first: 1, style: "A second leg starting after the pause between two legs. Enter as the pause breaks, the stop beyond the pause, the target a second leg as long as the first." }),
  event: Object.freeze({ label: "Release patterns", what: "the dead-cat bounce and its inverse, the bullish and bearish release surprise and the release flag", entry: "momentum", stop: Object.freeze({ other: true, cap: 1.25 }), first: 1, style: "A high-impact USD release moved price and the pattern after it broke. Enter near the break, the stop beyond the pattern's other side." })
});
/** A pattern is held back once its own record is negative over this many resolved setups. */
export const PATTERN_BREAKER = Object.freeze({ min_setups: 15 });

/** A pattern's measured record on gold (src/pattern-calibration.mjs), or null: { n, rate, factor, active }. */
const recordOf = (calibration, id) => { const r = calibration?.patterns?.[id]; return r && isNum(r.rate) ? r : null; };
/** The family of a pattern that applies to gold (the five event patterns without a gold event belong to none). */
const familyOf = (id) => { const info = patternInfo(id); return info?.applies ? (info.part === "event" ? "event" : info.group) : null; };

/** One strategy agent per pattern family: the Projection Agent's broken-out patterns of that family, by the family's rule. */
function patternAgent(family) {
  const F = PATTERN_FAMILIES[family], R = AGENT_RULES.pattern;
  const band = F.entry === "momentum" ? R.momentum_atr : R.retest_atr;
  const line = (dir, p) => (dir > 0 ? p.upper : p.lower), other = (dir, p) => (dir > 0 ? p.lower : p.upper);
  // The family's broken-out patterns a plan may stand on, best first (`charts`: the charts read).
  const fitOf = (id, dir, ctx, charts = R.charts) => {
    const held = Array.isArray(ctx.suspendedPatterns) ? ctx.suspendedPatterns : [];
    return (ctx.patterns || []).filter((p) => charts.includes(String(p?.tf)) && familyOf(p.id) === family && p.status !== "forming" && p.direction === dir && [line(dir, p), p.target, p.height].every(isNum) && p.height > 0)
      // Price has not fallen back into the pattern.
      .filter((p) => dir * (ctx.price - line(dir, p)) >= -R.retest_atr * ctx.atr)
      // The pattern's own trades here: held back by the breaker.
      .filter((p) => !held.includes(`${id}:${p.id}`))
      .map((p) => ({ p, rec: recordOf(ctx.calibration, p.id) }))
      // The Projection Agent's own record decides: a measured pattern below the rate of all patterns is left out.
      .filter(({ rec }) => !(rec?.active && isNum(rec.factor) && rec.factor < R.min_factor))
      // The best measured record first, then the lower chart, then the freshest.
      .sort((a, b) => (b.rec?.active ? b.rec.factor : 1) - (a.rec?.active ? a.rec.factor : 1) || Number(a.p.tf) - Number(b.p.tf) || (a.p.bars_ago ?? 0) - (b.p.bars_ago ?? 0));
  };
  // A pattern's entry, stop and words, as the plan places them.
  const placeOf = (dir, ctx, p, rec) => {
    const broken = line(dir, p), near = Math.abs(ctx.price - broken) <= band * ctx.atr;
    const entry = near ? ctx.price : broken;
    const cap = F.stop.cap * ctx.atr, far = other(dir, p);
    const structural = F.stop.other && isNum(far) && dir * (broken - far) > 0;
    const back = structural ? Math.min(dir * (broken - far), cap) : Math.min((F.stop.height ?? 0.5) * p.height, cap);
    const chart = p.chart ?? (String(p.tf) === "15" ? "15m" : "1H"), word = p.status === "busted" ? "busted " : "", name = `${chart} ${word}${p.name}`;
    return {
      broken, near, entry, chart, name,
      fields: {
        entry, atLevel: near, stop: broken - dir * (back + AGENT_RULES.pad_atr * ctx.atr),
        entryNote: near ? `price is at the broken ${dir > 0 ? "upper" : "lower"} line of the ${name}` : `a return to the broken ${dir > 0 ? "upper" : "lower"} line of the ${name}`,
        stopNote: back >= cap ? `${F.stop.cap} times the 1H average range behind the broken line (the pattern is larger)` : structural ? "beyond the pattern's other line" : `${F.stop.height === 0.5 ? "half" : "a third of"} the pattern's height behind the broken line`,
        setup: `the Projection Agent's ${name}, broken ${dir > 0 ? "upward" : "downward"}${rec ? ` (on gold it reached its target ${Math.round(rec.rate * 100)}% of ${rec.n} times${rec.active ? "" : ", too few to weigh"})` : " (no record on gold yet)"}`
      }
    };
  };
  return Object.freeze({
    id: `pattern_${family}`, version: 1, label: F.label, family,
    fits: `${F.style} The Projection Agent's ${F.what}, broken out or busted on the 15m or 1H chart with the measured target still ahead; a pattern whose measured record on gold is below the rate of all patterns, or whose own trades here lost, is left out.`,
    plan(dir, ctx) {
      if (!isNum(ctx.price)) return null;
      const gap = (ctx.scalp ? SCALP_TARGET.targetGapAtr : AGENT_RULES.target_gap_atr) * ctx.atr;
      for (const { p, rec } of fitOf(this.id, dir, ctx)) {
        const at = placeOf(dir, ctx, p, rec);
        const tp1 = F.first === 1 ? p.target : at.broken + F.first * (p.target - at.broken);
        if (dir * (tp1 - at.entry) < gap) continue;
        const plan = finishPlan(this.id, dir, {
          ...at.fields,
          targets: { ...(F.first === 1
            ? { tp1: p.target, tp1_note: `${at.name}: measured target`, tp2: p.target + dir * 0.5 * p.height, tp2_note: "half the pattern's height beyond the measured target" }
            : { tp1, tp1_note: `${at.name}: half the measured move`, tp2: p.target, tp2_note: `${at.name}: measured target` }), measured: { price: p.target, note: `${at.name}: measured target` } }
        }, ctx);
        if (plan) return { ...plan, pattern: p.id, chart: at.chart };
      }
      return null;
    },
    /**
     * FP1 (src/fresh-pattern.mjs): the plan of a 15m pattern whose breakout is fresh (confirmed within the last
     * FRESH_PATTERN.max_age_bars + 1 closed 15m bars, from ctx.bars), ignoring TP1-KZ: the entry at price (market by
     * design), the stop as plan() places it, TP1 the pattern's measured target, only when it pays at least FRESH_PATTERN.min_target_r; else none
     * (no fallback to a key zone). The breaker, the held-back patterns and the measured record apply as in plan().
     */
    fresh(dir, ctx) {
      if (!isNum(ctx.price) || !isNum(ctx.atr) || ctx.atr <= 0) return null;
      const gap = (ctx.scalp ? SCALP_TARGET.targetGapAtr : AGENT_RULES.target_gap_atr) * ctx.atr;
      for (const { p, rec } of fitOf(this.id, dir, ctx, [FRESH_PATTERN.chart])) {
        const age = breakoutAgeBars(ctx.bars, p);
        if (age == null || age > FRESH_PATTERN.max_age_bars) continue;
        // Market by design (the replay behind FP1 entered at the close): the entry is price, the stop as plan() puts it.
        const at = placeOf(dir, ctx, p, rec);
        if (dir * (p.target - ctx.price) < gap) continue;
        const plan = finishPlan(this.id, dir, {
          ...at.fields, entry: ctx.price, atLevel: true,
          entryNote: `price, ${age === 0 ? "on the close that broke" : "one closed bar after the close that broke"} the ${dir > 0 ? "upper" : "lower"} line of the ${at.name} (a fresh breakout, entered at market)`,
          targets: { tp1: p.target, tp1_note: `${at.name}: measured target (fresh breakout)`, tp2: p.target + dir * 0.5 * p.height, tp2_note: "half the pattern's height beyond the measured target" }
        }, { ...ctx, keyZone: false });
        if (!plan || !((plan.rrr?.tp1 ?? 0) >= FRESH_PATTERN.min_target_r)) continue;
        return { ...plan, pattern: p.id, chart: at.chart, fresh_pattern: freshPatternRecord({ pattern: p.id, ageBars: age, targetR: plan.rrr.tp1 }) };
      }
      return null;
    }
  });
}
const PATTERN_AGENTS = Object.freeze(Object.keys(PATTERN_FAMILIES).map(patternAgent));

/**
 * Inside the pattern (owner 2026-11-13, "approve all": a pattern that has not broken yet was not traded).
 * A pattern with two boundary lines that is still forming (a rectangle, a broadening formation, a wide
 * triangle, wedge or diamond) swings between its lines: at one line, trade the swing toward the other.
 * Up or down alike: a long from the lower line, a short from the upper line. The stop is just beyond the
 * line the trade leans on (a close beyond it is the family's break, traded by pattern_lines the other
 * way); the targets are the middle of the pattern and its far line. Lines closer together than
 * MIN_WIDTH x the 1H ATR leave no room and are left alone.
 */
const patternInside = Object.freeze({
  id: "pattern_inside", version: 1, label: "Inside the pattern", covers: AGENT_RULES.inside.family,
  fits: "A pattern with two boundary lines that has not broken yet (a rectangle, a broadening formation, a wide triangle, wedge or diamond) and price at one of its lines: trade the swing to the other line, a long from the lower line or a short from the upper one, the stop just beyond the line it leans on. Not when the lines are close together, and not once a bar has closed beyond a line: that is the break, another strategy.",
  plan(dir, ctx) {
    const R = AGENT_RULES.inside;
    if (!isNum(ctx.price)) return null;
    const held = Array.isArray(ctx.suspendedPatterns) ? ctx.suspendedPatterns : [];
    const fit = (ctx.patterns || []).filter((p) => AGENT_RULES.pattern.charts.includes(String(p?.tf)) && familyOf(p.id) === R.family && p.status === "forming" && [p.upper, p.lower].every(isNum) && p.upper - p.lower >= R.min_width_atr * ctx.atr)
      .filter((p) => !held.includes(`${this.id}:${p.id}`))
      // The lower chart first, then the freshest.
      .sort((a, b) => Number(a.tf) - Number(b.tf) || (a.bars_ago ?? 0) - (b.bars_ago ?? 0));
    for (const p of fit) {
      const width = p.upper - p.lower, edge = dir > 0 ? p.lower : p.upper, far = dir > 0 ? p.upper : p.lower;
      // Price is in the part of the pattern next to the line, or a hair beyond it.
      const from = dir * (ctx.price - edge);
      if (from < -R.beyond_atr * ctx.atr || from > R.zone * width) continue;
      const at = Math.abs(ctx.price - edge) <= R.at_atr * ctx.atr;
      const chart = p.chart ?? (String(p.tf) === "15" ? "15m" : "1H"), name = `forming ${chart} ${p.name}`, line = dir > 0 ? "lower" : "upper", other = dir > 0 ? "upper" : "lower";
      const plan = finishPlan(this.id, dir, {
        entry: at ? ctx.price : edge + dir * R.entry * width, atLevel: at, stop: edge - dir * R.stop_atr * ctx.atr,
        entryNote: at ? `price is at the ${line} line of the ${name}` : `a return to the ${line} line of the ${name}`,
        stopNote: `beyond the pattern's ${line} line`,
        setup: `the Projection Agent's ${name}, not broken yet: a swing from its ${line} line toward its ${other} line`,
        targets: { tp1: edge + dir * 0.5 * width, tp1_note: `the middle of the ${name}`, tp2: far - dir * R.far * width, tp2_note: `the ${other} line of the ${name}` }
      }, ctx);
      if (plan) return { ...plan, pattern: p.id, chart };
    }
    return null;
  }
});

/** The registry: adding or removing a strategy is one entry here. */
const toMsOf = (v) => (typeof v === "number" ? v : Date.parse(v));
/**
 * Pure (Track B PR 14, shared by orb_breakout and GET /api/orb): a formed opening range's width against the 1H ATR:
 * "ok" between AGENT_RULES.orb's min_width_atr and max_width_atr (inclusive), "too_narrow" or "too_wide" outside, null
 * without a width or an ATR.
 */
export function orbWidthStatus(range, atr) {
  const O = AGENT_RULES.orb;
  if (!isNum(range?.width) || !isNum(atr) || atr <= 0) return null;
  return range.width < O.min_width_atr * atr ? "too_narrow" : range.width > O.max_width_atr * atr ? "too_wide" : "ok";
}
/**
 * Track A PR 7 (rebuilds #507): the opening range breakout, the 14th live agent. A 15m close beyond the London or New
 * York opening range (the session's first three 15m bars) by the breakout band; entry on the retest of the broken
 * edge, the stop behind the range's midpoint or the breakout bar, whichever is further; the plan lasts until the
 * session window ends (valid_until_ms). New York wins on a side where both have a plan. Each session is its own
 * pattern (orb_london, orb_new_york) for the breaker.
 */
const orbBreakout = Object.freeze({
  id: "orb_breakout", version: 1, label: "Opening range breakout",
  variants: Object.freeze({ orb_london: "London opening range", orb_new_york: "New York opening range" }),
  fits: "The first hours of the London or New York session: a 15m close beyond the session's opening range (its first three 15m bars) that has not closed back through the range's middle. Enter on the retest of the broken edge, the stop behind the middle of the range or the breakout bar, the target at the next key level; the plan ends with the session's window. Not when a high-impact release fell inside the range, or the range is too narrow or too wide.",
  plan(dir, ctx) {
    if (!isNum(ctx.price) || !isNum(ctx.atr) || ctx.atr <= 0) return null;
    const B = AGENT_RULES.breakout, bars = ctx.bars || [], atr = ctx.atr;
    const held = Array.isArray(ctx.suspendedPatterns) ? ctx.suspendedPatterns : [];
    // New York first: in the overlap it wins on a side where it has a plan.
    for (const r of openingRanges(bars, { events: ctx.events }).reverse()) {
      if (r.status !== "ok" || held.includes(`${this.id}:${r.key}`)) continue;
      if (orbWidthStatus(r, atr) !== "ok") continue;
      const edge = dir > 0 ? r.high : r.low;
      const after = bars.filter((b) => toMsOf(b.open_time) >= r.range_end_ms);
      const i = after.findIndex((b) => dir * (b.close - edge) >= B.beyond_atr * atr);
      if (i < 0) continue;
      // A close back through the middle ends the side for the window.
      if (after.slice(i + 1).some((b) => dir * (b.close - r.mid) < 0)) continue;
      const back = dir * (ctx.price - edge);
      if (back < -B.retest_atr * atr) continue;
      const retesting = back <= B.retest_atr * atr;
      const barEdge = dir > 0 ? after[i].low : after[i].high;
      const base = dir > 0 ? Math.min(r.mid, barEdge) : Math.max(r.mid, barEdge);
      const word = dir > 0 ? "above" : "below", edgeWord = `the ${r.session} opening range ${dir > 0 ? "high" : "low"}`;
      const plan = finishPlan(this.id, dir, {
        entry: retesting ? ctx.price : edge, atLevel: retesting, stop: base - dir * AGENT_RULES.pad_atr * atr,
        entryNote: retesting ? `price retests ${edgeWord} after the break` : `a retest of ${edgeWord} after the break`,
        stopNote: base === r.mid ? `${dir > 0 ? "below" : "above"} the middle of the ${r.session} opening range` : `${dir > 0 ? "below" : "above"} the breakout bar`,
        setup: `a 15m close ${word} the ${r.session} opening range`
      }, ctx);
      if (plan) return { ...plan, pattern: r.key, chart: "15m", valid_until_ms: r.end_ms };
    }
    return null;
  }
});

export const STRATEGY_AGENTS = Object.freeze([zonePullback, sweepReversal, breakoutRetest, rangeFade, ...PATTERN_AGENTS, patternInside, orbBreakout]);
export const AGENT_IDS = Object.freeze(STRATEGY_AGENTS.map((a) => a.id));
/**
 * Z2b's TP2 helper (src/zone-types.mjs zoneAim, tp_typed): the agents whose targets come from the key levels
 * (tradeLevels or targetsAhead: the default agent, the sweep and the break-and-retest). Only their TP2 may move to the
 * next decisive opposing key zone; the agents with their own targets (range_fade, the pattern agents, pattern_inside)
 * keep theirs.
 */
export const KEY_TARGET_AGENTS = Object.freeze([DEFAULT_AGENT, "sweep_reversal", "breakout_retest"]);
export const keyLevelTargets = (id) => KEY_TARGET_AGENTS.includes(id);

export function strategyAgentsMode(env) {
  return String(env?.STRATEGY_AGENTS_MODE ?? "on").trim().toLowerCase() === "off" ? "off" : "on";
}
const idList = (v) => String(v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => AGENT_IDS.includes(s));

/**
 * The breaker (owner 2026-11-13: live at once, "live sekarang langsung implementasi"): a live agent whose
 * own measured record (the plan learner's, src/plan-learning.mjs agentRecords) is negative over at least
 * MIN_SETUPS resolved setups is suspended: it goes back to shadow, where it is still recorded and
 * measured, and it is live again as soon as its record is no longer negative. The default agent is never
 * suspended: it is the plan when no other is chosen.
 */
export const AGENT_BREAKER = Object.freeze({ min_setups: 30 });
export const AGENT_BREAKER_KEY = "strategy-agents:suspended:v1";

/** Pure: the agents the breaker holds back: [{ id, setups, mean_r }] from the agents' records. */
export function suspendedAgents(records) {
  return (Array.isArray(records) ? records : []).filter((r) => AGENT_IDS.includes(r?.agent) && r.agent !== DEFAULT_AGENT && isNum(r.mean_r) && isNum(r.setups) && r.setups >= AGENT_BREAKER.min_setups && r.mean_r < 0)
    .map((r) => ({ id: r.agent, setups: r.setups, mean_r: r.mean_r }));
}

/**
 * Pure: the patterns the breaker holds back: [{ id, agent, setups, mean_r }] from the agents' records (their
 * `patterns`). Per agent: a pattern's breaks and its swings inside are different trades with their own record.
 */
export function suspendedPatterns(records) {
  return (Array.isArray(records) ? records : []).flatMap((r) => (Array.isArray(r?.patterns) ? r.patterns : []).filter((x) => typeof x?.pattern === "string" && isNum(x.mean_r) && isNum(x.setups) && x.setups >= PATTERN_BREAKER.min_setups && x.mean_r < 0)
    .map((x) => ({ id: x.pattern, agent: r.agent, setups: x.setups, mean_r: x.mean_r })));
}

/** Pure: each agent's status. The default agent is always live; "off" wins over "live"; the breaker turns a live agent with a negative record to shadow. */
export function agentStatuses(env, { records = null } = {}) {
  const on = strategyAgentsMode(env) === "on", live = idList(env?.STRATEGY_AGENTS_LIVE), off = idList(env?.STRATEGY_AGENTS_OFF);
  const held = suspendedAgents(records).map((x) => x.id);
  return Object.fromEntries(AGENT_IDS.map((id) => [id, id === DEFAULT_AGENT ? "live" : !on || off.includes(id) ? "off" : live.includes(id) && !held.includes(id) ? "live" : "shadow"]));
}

/**
 * Pure: the name of what an agent trades under a key: the agent's own variant label (an agent may declare
 * `variants: { key: label }`, such as the two opening ranges of one agent), else the catalogue pattern's name.
 */
export function variantName(agentId, key) {
  const variant = STRATEGY_AGENTS.find((a) => a.id === agentId)?.variants?.[key];
  return typeof variant === "string" ? variant : patternInfo(key)?.name ?? null;
}

/** Pure: the roster as the switches set it (the breaker does not move an agent here): { id: { status, version } }. */
export function agentRoster(env) {
  const statuses = agentStatuses(env);
  return Object.fromEntries(STRATEGY_AGENTS.map((a) => [a.id, { status: statuses[a.id], version: a.version }]));
}

/**
 * Pure: the roster lines for the owner (Track A PR 3): one line per agent added, removed, version-bumped, or moved
 * between live, shadow and off; the whole roster once when nothing was stored before; nothing when nothing changed.
 */
export function rosterLines(before, now) {
  const label = (id) => STRATEGY_AGENTS.find((a) => a.id === id)?.label ?? id;
  if (!before || typeof before !== "object") {
    const by = (status) => Object.entries(now).filter(([, x]) => x.status === status).map(([id, x]) => `${label(id)} v${x.version}`);
    const parts = ["live", "shadow", "off"].map((s) => [s, by(s)]).filter(([, list]) => list.length).map(([s, list]) => `${s[0].toUpperCase()}${s.slice(1)}: ${list.join(", ")}.`);
    return [`The roster: ${Object.keys(now).length} strategy agents. ${parts.join(" ")}`];
  }
  const lines = [];
  for (const [id, x] of Object.entries(now)) {
    const was = before[id];
    if (!was) lines.push(`${label(id)} joins the roster: v${x.version}, ${x.status}.`);
    else {
      if (was.version !== x.version) lines.push(`${label(id)} is now v${x.version} (was v${was.version}).`);
      if (was.status !== x.status) lines.push(`${label(id)} moves from ${was.status} to ${x.status}.`);
    }
  }
  for (const id of Object.keys(before)) if (!now[id]) lines.push(`${id} leaves the roster.`);
  return lines;
}

/**
 * Tells the owner once when the breaker suspends an agent that the switches set live, or lets it back, and
 * when the roster changes (Track A PR 3). KV keeps the last told set and roster in one value. A breaker
 * suspension sends only its own line: the roster is the switches' view, which the breaker does not move.
 * Never throws.
 */
export async function syncAgentBreaker(env, records, { send = null, now = Date.now() } = {}) {
  try {
    const on = strategyAgentsMode(env) === "on";
    const wanted = idList(env?.STRATEGY_AGENTS_LIVE).filter((id) => !idList(env?.STRATEGY_AGENTS_OFF).includes(id));
    const held = on ? suspendedAgents(records).filter((x) => wanted.includes(x.id)) : [];
    // A pattern of a family the switches set live (a suspended family says it once for all its patterns).
    const patterns = on ? suspendedPatterns(records).filter((x) => wanted.includes(x.agent) && !held.some((h) => h.id === x.agent)) : [];
    const stored = JSON.parse((await env?.SIGNAL_CACHE?.get?.(AGENT_BREAKER_KEY)) || "null");
    const before = stored?.ids ?? [];
    const key = (x) => `pattern:${x.agent}:${x.id}`;
    const ids = [...held.map((x) => x.id), ...patterns.map(key)].sort();
    const roster = agentRoster(env);
    const told = rosterLines(stored?.roster ?? null, roster);
    const idsSame = JSON.stringify(ids) === JSON.stringify([...before].sort());
    if (idsSame && !told.length) return { status: "unchanged", suspended: ids };
    const agentLabel = (id) => STRATEGY_AGENTS.find((a) => a.id === id)?.label ?? id;
    // "pattern:<agent>:<pattern>": a pattern is judged per agent (its breaks and its swings inside are different trades).
    // A variant of the agent's own (variants: { key: label }) is named by its label, before the catalogue's names.
    const label = (id) => {
      if (!id.startsWith("pattern:")) return agentLabel(id);
      const [, agent, pattern] = id.split(":");
      const variant = STRATEGY_AGENTS.find((a) => a.id === agent)?.variants?.[pattern];
      return typeof variant === "string" ? `The ${variant} (${agentLabel(agent)})` : `The ${patternInfo(pattern)?.name ?? pattern} pattern (${agentLabel(agent)})`;
    };
    const lines = idsSame ? [] : [
      ...held.filter((x) => !before.includes(x.id)).map((x) => `${label(x.id)} is suspended: ${x.mean_r}R per setup over ${x.setups} setups. It stays measured in shadow and returns by itself when its record is no longer negative.`),
      ...patterns.filter((x) => !before.includes(key(x))).map((x) => `${label(key(x))} is held back: ${x.mean_r}R per setup over ${x.setups} setups of its own. The rest of its family trades on.`),
      ...before.filter((id) => !ids.includes(id)).map((id) => `${label(id)} is ${id.startsWith("pattern:") ? "traded" : "live"} again: its record is no longer negative.`)
    ];
    // Send first, then keep only what was told (Track A PR 3 review): a send that fails leaves its part of the stored
    // value as it was, so the next ledger step sends the same lines again. A crash between a send and the write can
    // repeat a notice; it never loses one.
    let error = null;
    const tell = async (body) => {
      if (!body.length || typeof send !== "function") return true;
      try { await send(["XAUUSD STRATEGY AGENTS", ...body].join("\n")); return true; } catch (e) { error = String(e?.message ?? e).slice(0, 160); return false; }
    };
    const rosterTold = await tell(told);
    const idsTold = await tell(lines);
    const keep = { ids: idsTold ? ids : [...before].sort(), roster: rosterTold ? roster : (stored?.roster ?? null) };
    if (JSON.stringify(keep.ids) !== JSON.stringify([...before].sort()) || JSON.stringify(keep.roster) !== JSON.stringify(stored?.roster ?? null)) {
      await env?.SIGNAL_CACHE?.put?.(AGENT_BREAKER_KEY, JSON.stringify({ ...keep, at: new Date(now).toISOString() }));
    }
    const rosterOut = told.length ? { roster: { status: rosterTold ? "changed" : "failed", told: rosterTold ? told.length : 0 } } : {};
    if (error) return { status: "failed", error, suspended: keep.ids, ...rosterOut };
    if (idsSame) return { status: "unchanged", suspended: ids, ...rosterOut };
    return { status: "changed", suspended: ids, told: lines.length, ...rosterOut };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 160) };
  }
}

/** Pure: the agents' context of a direction from the strategy engine's output and the decision's inputs. */
export function agentContext({ strategy = null, bars = [], regime = null, scalp = false, basePlan = undefined, calibration = null, suspendedPatterns = [], keyZone = false, entryZone = false, events = [] } = {}) {
  return {
    // Track A PR 7: the calendar's events (inputs.calendar.events), for the opening range's release check.
    events: Array.isArray(events) ? events : [],
    strategy, scalp: scalp === true, regime: typeof regime === "string" ? regime : null, basePlan, ...(keyZone === true ? { keyZone: true } : {}), ...(entryZone === true ? { entryZone: true } : {}),
    // The Projection Agent's reading (owner 2026-11-13: "libatkan Projection Agent karena dia yang punya
    // knowledge terkait price action"): the chart patterns it detected on each chart and each pattern's
    // measured record on gold.
    patterns: Array.isArray(strategy?.key_levels?.patterns) ? strategy.key_levels.patterns : [], calibration: calibration ?? null,
    suspendedPatterns: Array.isArray(suspendedPatterns) ? suspendedPatterns : [],
    price: isNum(strategy?.price) ? strategy.price : null, atr: isNum(strategy?.atr_h1) ? strategy.atr_h1 : null,
    levels: zoneLevels(strategy?.key_levels?.zones, { qualified: scalp === true && SCALP_TARGET.qualified }),
    bars: (bars || []).filter((b) => [b?.high, b?.low, b?.close].every(isNum))
  };
}

/**
 * Pure: every agent that is not off and sees its setup: { id: { status, plan } }. An agent that throws
 * has no plan; it never takes the decision down.
 */
export function agentPlans(dir, ctx, statuses) {
  const out = {};
  if (!(dir === 1 || dir === -1) || !isNum(ctx?.price) || !isNum(ctx?.atr) || ctx.atr <= 0) {
    if (ctx?.basePlan) out[DEFAULT_AGENT] = { status: "live", plan: { ...ctx.basePlan, agent: DEFAULT_AGENT } };
    return out;
  }
  for (const agent of STRATEGY_AGENTS) {
    const status = statuses?.[agent.id] ?? (agent.id === DEFAULT_AGENT ? "live" : "shadow");
    if (status === "off") continue;
    let plan = null;
    try { plan = agent.plan(dir, ctx); } catch { plan = null; }
    if (plan) out[agent.id] = { status, plan };
  }
  return out;
}

/**
 * FP1 (src/fresh-pattern.mjs): each pattern family agent that is not off and has a fresh 15m pattern on this side:
 * { id: { status, plan } }, the plan carrying fresh_pattern. An agent that throws has none.
 */
export function freshPatternPlans(dir, ctx, statuses) {
  const out = {};
  if (!(dir === 1 || dir === -1) || !isNum(ctx?.price) || !isNum(ctx?.atr) || ctx.atr <= 0) return out;
  for (const agent of PATTERN_AGENTS) {
    const status = statuses?.[agent.id] ?? "shadow";
    if (status === "off") continue;
    let plan = null;
    try { plan = agent.fresh(dir, ctx); } catch { plan = null; }
    if (plan) out[agent.id] = { status, plan };
  }
  return out;
}

/**
 * Pure, FP1 "on": the plans with the fresh plans in: an agent without a plan on the side, or whose plan stands on the
 * same fresh pattern, takes its fresh plan (entry at price, TP1 the measured target: exactly what FP1 trades and its
 * revert judges; the agent's own retest limit or key-zone TP1 never carries fresh_pattern); any other plan is as it was.
 */
export function withFreshPlans(plans, fresh) {
  const out = { ...(plans || {}) };
  for (const [id, a] of Object.entries(fresh || {})) {
    const own = out[id];
    if (!own?.plan || (own.plan.pattern === a.plan.pattern && own.plan.chart === a.plan.chart)) out[id] = { ...(own ?? {}), status: own?.status ?? a.status, plan: a.plan };
  }
  return out;
}

/** Pure: the registry as the council and the pages read it (`suspended`: held back by the breaker). */
export function agentCatalog(statuses, { suspended = [] } = {}) {
  return STRATEGY_AGENTS.map((a) => ({
    id: a.id, label: a.label, version: a.version, status: statuses?.[a.id] ?? (a.id === DEFAULT_AGENT ? "live" : "shadow"), ...(suspended.includes(a.id) ? { suspended: true } : {}), fits: a.fits,
    // A pattern family: the patterns of the Projection Agent's catalogue it trades.
    ...(a.family ? { family: a.family } : {}),
    // The patterns it trades: its own family, or (inside the pattern) the family whose forming patterns it swings in.
    ...(a.family || a.covers ? { patterns: PATTERN_CATALOG.filter((p) => p.applies && familyOf(p.id) === (a.family ?? a.covers)).map((p) => ({ id: p.id, name: p.name })) } : {}),
    // Track B PR 14: an agent's own variants (orb_breakout's two opening ranges), whose records are its record's patterns.
    ...(a.variants ? { variants: Object.entries(a.variants).map(([id, name]) => ({ id, name })) } : {})
  }));
}

/**
 * The agents' consensus (owner 2026-11-13: "libatkan agen strategi dalam decision council ... sejajar
 * dengan TF karena merupakan konsensus dari beberapa agen"): the live agents as ONE witness of the
 * Decision Engine's quorum, weighted like a timeframe room. An agent speaks for a side when it sees its
 * own setup there and its plan passes the reward guardrail (the plans the council may choose from). The
 * default agent plans both sides at every bar, so it speaks only where price already holds at its zone.
 * A voice counts 1, moved between VOICE_MIN and VOICE_MAX by the agent's own measured record here (the
 * plan learner's mean R per setup) once it has RECORD_MIN_SETUPS resolved setups. The lean is
 * (buy voices - sell voices) / (all voices + SILENT): one silent voice keeps a lone agent from speaking
 * with full force. When no agent speaks the witness does not count. No price in it.
 */
export const CONSENSUS_RULES = Object.freeze({ silent: 1, record_min_setups: 15, voice_min: 0.5, voice_max: 1.5 });

/** Pure: how much an agent's voice counts from its own record ({ setups, mean_r }); 1 while it is not measured enough. */
export function agentVoice(record) {
  if (!record || !isNum(record.mean_r) || !isNum(record.setups) || record.setups < CONSENSUS_RULES.record_min_setups) return 1;
  return r2(Math.min(CONSENSUS_RULES.voice_max, Math.max(CONSENSUS_RULES.voice_min, 1 + record.mean_r)));
}

/**
 * Pure: the consensus of both sides' agent plans ({ long: { id: { status, plan } }, short }). `passes(plan)`
 * is the reward guardrail on a plan, `records` the plan learner's agent records, `statuses` each agent's
 * status. Returns { lean (null when nobody speaks), live, speaking, long: [{ id, name, voice, pattern? }],
 * short: [...], summary }.
 */
/** Pure: whether an agent speaks for a side: live, its own setup there, its plan passing `passes`, the default agent only at its level. */
export function agentSpeaks(id, a, passes = () => true) {
  return a?.status === "live" && Boolean(a.plan) && (id === DEFAULT_AGENT ? a.plan.at_level === true : true) && passes(a.plan);
}

export function agentsConsensus({ long = {}, short = {} } = {}, { records = null, passes = () => true, statuses = null } = {}) {
  const recordOfAgent = (id) => (Array.isArray(records) ? records : []).find((r) => r?.agent === id) ?? null;
  const speakers = (plans) => Object.entries(plans || {})
    .filter(([id, a]) => agentSpeaks(id, a, passes))
    .map(([id, a]) => {
      // An agent's own variant label first (variants: { key: label }), then the catalogue pattern's name.
      const pattern = a.plan.pattern ? variantName(id, a.plan.pattern) : null;
      return { id, name: STRATEGY_AGENTS.find((x) => x.id === id)?.label ?? id, voice: agentVoice(recordOfAgent(id)), ...(pattern ? { pattern } : {}) };
    });
  const buy = speakers(long), sell = speakers(short);
  const sum = (list) => list.reduce((s, x) => s + x.voice, 0);
  const L = sum(buy), S = sum(sell);
  const live = statuses ? Object.values(statuses).filter((v) => v === "live").length : new Set([...Object.entries(long || {}), ...Object.entries(short || {})].filter(([, a]) => a?.status === "live").map(([id]) => id)).size;
  const speaking = new Set([...buy, ...sell].map((x) => x.id)).size;
  const names = (list) => (list.length ? list.map((x) => (x.pattern ? `${x.name} (${x.pattern})` : x.name)).join(", ") : "none");
  if (!(L + S > 0)) return { lean: null, live, speaking: 0, long: [], short: [], summary: `None of the ${live} live strategy agents sees its setup on the chart now.` };
  const lean = r2((L - S) / (L + S + CONSENSUS_RULES.silent));
  return { lean, live, speaking, long: buy, short: sell, summary: `${speaking} of the ${live} live strategy agents ${speaking === 1 ? "sees its" : "see their"} setup now. Buy side: ${names(buy)}. Sell side: ${names(sell)}.` };
}

const BREAK_WORD = { 1: "broke upward", "-1": "broke downward", 0: "not broken yet" };
/**
 * Pure: the Projection Agent's reading of the price action for the council's choice of strategy: the chart
 * patterns of the 15m, 1H and 4H charts (broken-out ones first), each with its status, the way it broke and
 * its measured record on gold. No price: the levels are in the plans.
 */
export function priceActionReading(patterns, calibration = null) {
  const list = (Array.isArray(patterns) ? patterns : []).filter((p) => ["15", "60", "240"].includes(String(p?.tf)) && typeof p.name === "string")
    .sort((a, b) => (b.status !== "forming") - (a.status !== "forming") || Number(a.tf) - Number(b.tf) || (a.bars_ago ?? 0) - (b.bars_ago ?? 0)).slice(0, AGENT_RULES.pattern.council_max);
  return list.map((p) => {
    const rec = recordOf(calibration, p.id);
    return { chart: p.chart ?? p.tf, pattern: p.name, status: p.status, direction: BREAK_WORD[p.direction] ?? BREAK_WORD[0], ...(rec ? { record_on_gold: { breakouts: rec.n, reached_target_pct: Math.round(rec.rate * 100), measured_enough: rec.active === true } } : {}) };
  });
}

/** Pure: an agent's plan as the decision record keeps it (levels and why; the notes stay in the trade). */
// Z0: zone_types and opposing_ahead only when the plan has them (KEY_LEVEL_ZONE_TYPES on).
export const slimPlan = (p) => ({ entry: p.entry, ...(isNum(p.entry_low) && isNum(p.entry_high) ? { entry_low: p.entry_low, entry_high: p.entry_high } : {}), stop: p.stop, tp1: p.tp1, tp2: p.tp2, at_level: p.at_level === true, rrr: p.rrr ?? null, setup: p.setup ?? null, ...(p.pattern ? { pattern: p.pattern } : {}), ...(p.pattern && typeof p.chart === "string" ? { chart: p.chart } : {}), ...(isNum(p.valid_until_ms) ? { valid_until_ms: p.valid_until_ms } : {}), ...(p.zone_types ? { zone_types: p.zone_types } : {}), ...(p.opposing_ahead ? { opposing_ahead: p.opposing_ahead } : {}), ...(p.fresh_pattern ? { fresh_pattern: p.fresh_pattern } : {}) });

/**
 * Execution per the strategy agents (owner 2026-11-16, docs/RFC_STRATEGY_EXECUTION.md): a BUY or SELL trades only
 * a plan of an agent that speaks on its side, and the agents' own confidence, evaluated at every 15m decision,
 * closes a winner when it drops and lets a position be extended only while it is stable or rising.
 * STRATEGY_EXECUTION "off" is the rollback (the default plan, no confidence exits).
 */
export function strategyExecutionEnabled(env) {
  return String(env?.STRATEGY_EXECUTION ?? "on").trim().toLowerCase() !== "off";
}
export const CONFIDENCE_RULES = Object.freeze({ direction: 0.4, setup: 0.35, quality: 0.25, stable_band: CONFIDENCE_STABLE_BAND });

/**
 * Pure: one agent's confidence on one side (dir +1 long, -1 short), 0 to 1:
 *   0.40 x direction (the Decision Engine's quorum score signed for the side, 0 against, 0.5 neutral, 1 with it)
 * + 0.35 x setup     (1 when it speaks on the side, 0.5 when it speaks on neither, 0 when on the other)
 * + 0.25 x quality   (its measured voice between VOICE_MIN and VOICE_MAX; 0.5 until it is measured).
 */
export function agentConfidence(dir, { speaksHere = false, speaksThere = false, score = null, voice = 1 } = {}) {
  const direction = isNum(score) ? (1 + Math.max(-1, Math.min(1, dir * score))) / 2 : 0.5;
  const setup = speaksHere ? 1 : speaksThere ? 0 : 0.5;
  const quality = Math.max(0, Math.min(1, ((isNum(voice) ? voice : 1) - CONSENSUS_RULES.voice_min) / (CONSENSUS_RULES.voice_max - CONSENSUS_RULES.voice_min)));
  return r2(CONFIDENCE_RULES.direction * direction + CONFIDENCE_RULES.setup * setup + CONFIDENCE_RULES.quality * quality);
}

/** Pure: every live agent's confidence on both sides ({ id: { long, short } }) from both sides' plans and the quorum score. */
export function agentConfidences({ long = {}, short = {} } = {}, { score = null, records = null, passes = () => true, statuses = null } = {}) {
  const ids = AGENT_IDS.filter((id) => (statuses?.[id] ?? (id === DEFAULT_AGENT ? "live" : "shadow")) === "live");
  const recordOfAgent = (id) => (Array.isArray(records) ? records : []).find((r) => r?.agent === id) ?? null;
  const out = {};
  for (const id of ids) {
    const L = agentSpeaks(id, long?.[id], passes), S = agentSpeaks(id, short?.[id], passes);
    const voice = agentVoice(recordOfAgent(id));
    out[id] = { long: agentConfidence(1, { speaksHere: L, speaksThere: S, score, voice }), short: agentConfidence(-1, { speaksHere: S, speaksThere: L, score, voice }) };
  }
  return out;
}

