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
//          regime (the 1H regime label), scalp, strategy }, in the shape of tradeLevels' plan, or null
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

import { planForDirection, zoneLevels, SCALP_TARGET } from "./strategy-engine.mjs";

export const STRATEGY_AGENTS_VERSION = "cryptophys.strategy-agents.v1";
export const DEFAULT_AGENT = "zone_pullback";
export const AGENT_STATUSES = Object.freeze(["live", "shadow", "off"]);
/** The first target's note when no key level lies ahead (as src/strategy-engine.mjs tradeLevels). */
export const PROJECTION_NOTE = "a 2R projection";
export const AGENT_RULES = Object.freeze({
  min_risk_atr: 0.25, max_risk_atr: 2.5, pad_atr: 0.1, target_gap_atr: 0.5,
  sweep: Object.freeze({ bars: 3, lookback: 12, through_atr: 0.05 }),
  breakout: Object.freeze({ bars: 6, base_bars: 3, beyond_atr: 0.1, retest_atr: 0.15 }),
  range: Object.freeze({ bars: 32, min_bars: 24, min_atr: 1, max_atr: 4, zone: 0.35, at: 0.2, entry: 0.15, stop_atr: 0.25, far: 0.1 })
});

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;
const lo = (z) => (isNum(z.low) ? z.low : z.price), hi = (z) => (isNum(z.high) ? z.high : z.price);
const hours = (bars) => Math.round((bars * 15) / 60);

/** Pure: the key levels ahead as targets, as tradeLevels: the nearest major zone, then one 1.5R or more away. */
function targetsAhead({ dir, entry, risk, levels, atr, gapAtr }) {
  const edge = (z) => (dir > 0 ? lo(z) : hi(z));
  const ahead = (levels || []).filter((z) => z.major !== false && dir * (edge(z) - entry) >= gapAtr * atr).sort((a, b) => dir * (edge(a) - edge(b)));
  const t1 = ahead[0] ?? null;
  const t2 = t1 ? ahead.find((z) => dir * (edge(z) - edge(t1)) >= 0.5 * atr && Math.abs(edge(z) - entry) / risk >= 1.5) ?? null : null;
  const tp1 = t1 ? edge(t1) : entry + dir * 2 * risk;
  return {
    tp1, tp1_note: t1 ? t1.label : PROJECTION_NOTE,
    tp2: t2 ? edge(t2) : entry + dir * Math.max(3 * risk, Math.abs(tp1 - entry) + risk), tp2_note: t2 ? t2.label : "a projection beyond the first target"
  };
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
  const t = targets ?? targetsAhead({ dir, entry, risk, levels: ctx.levels, atr, gapAtr: ctx.scalp ? SCALP_TARGET.targetGapAtr : AGENT_RULES.target_gap_atr });
  if (!(dir * (t.tp1 - entry) > 0) || !(dir * (t.tp2 - t.tp1) >= 0)) return null;
  const rr = (tp) => r2(Math.abs(tp - entry) / risk);
  return {
    agent, setup, at_level: atLevel === true, entry: r2(entry), entry_note: entryNote, stop: r2(s), stop_note: note, risk: r2(risk),
    tp1: r2(t.tp1), tp1_note: t.tp1_note, tp2: r2(t.tp2), tp2_note: t.tp2_note, progressive_stop: r2(entry), rrr: { tp1: rr(t.tp1), tp2: rr(t.tp2) }
  };
}

const zonePullback = Object.freeze({
  id: DEFAULT_AGENT, version: 1, label: "Zone pullback",
  fits: "Any market: enter at the nearest key zone behind price (or at price when it already holds there), the stop behind the next zone, the target at the next key level. The plan of every decision before the agents.",
  plan(dir, ctx) {
    const p = ctx.basePlan ?? planForDirection(ctx.strategy, dir, { scalp: ctx.scalp === true });
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
  id: "breakout_retest", version: 1, label: "Breakout retest",
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

/** The registry: adding or removing a strategy is one entry here. */
export const STRATEGY_AGENTS = Object.freeze([zonePullback, sweepReversal, breakoutRetest, rangeFade]);
export const AGENT_IDS = Object.freeze(STRATEGY_AGENTS.map((a) => a.id));

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

/** Pure: each agent's status. The default agent is always live; "off" wins over "live"; the breaker turns a live agent with a negative record to shadow. */
export function agentStatuses(env, { records = null } = {}) {
  const on = strategyAgentsMode(env) === "on", live = idList(env?.STRATEGY_AGENTS_LIVE), off = idList(env?.STRATEGY_AGENTS_OFF);
  const held = suspendedAgents(records).map((x) => x.id);
  return Object.fromEntries(AGENT_IDS.map((id) => [id, id === DEFAULT_AGENT ? "live" : !on || off.includes(id) ? "off" : live.includes(id) && !held.includes(id) ? "live" : "shadow"]));
}

/**
 * Tells the owner once when the breaker suspends an agent that the switches set live, or lets it back
 * (KV keeps the last told set). Never throws.
 */
export async function syncAgentBreaker(env, records, { send = null, now = Date.now() } = {}) {
  try {
    const wanted = idList(env?.STRATEGY_AGENTS_LIVE).filter((id) => !idList(env?.STRATEGY_AGENTS_OFF).includes(id));
    const held = strategyAgentsMode(env) === "on" ? suspendedAgents(records).filter((x) => wanted.includes(x.id)) : [];
    const before = JSON.parse((await env?.SIGNAL_CACHE?.get?.(AGENT_BREAKER_KEY)) || "null")?.ids ?? [];
    const ids = held.map((x) => x.id).sort();
    if (JSON.stringify(ids) === JSON.stringify([...before].sort())) return { status: "unchanged", suspended: ids };
    await env?.SIGNAL_CACHE?.put?.(AGENT_BREAKER_KEY, JSON.stringify({ ids, at: new Date(now).toISOString() }));
    const label = (id) => STRATEGY_AGENTS.find((a) => a.id === id)?.label ?? id;
    const lines = [
      ...held.filter((x) => !before.includes(x.id)).map((x) => `${label(x.id)} is suspended: ${x.mean_r}R per setup over ${x.setups} setups. It stays measured in shadow and returns by itself when its record is no longer negative.`),
      ...before.filter((id) => !ids.includes(id)).map((id) => `${label(id)} is live again: its record is no longer negative.`)
    ];
    if (lines.length && typeof send === "function") await send(["XAUUSD STRATEGY AGENTS", ...lines].join("\n"));
    return { status: "changed", suspended: ids, told: lines.length };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 160) };
  }
}

/** Pure: the agents' context of a direction from the strategy engine's output and the decision's inputs. */
export function agentContext({ strategy = null, bars = [], regime = null, scalp = false, basePlan = undefined } = {}) {
  return {
    strategy, scalp: scalp === true, regime: typeof regime === "string" ? regime : null, basePlan,
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

/** Pure: the registry as the council and the pages read it (`suspended`: held back by the breaker). */
export function agentCatalog(statuses, { suspended = [] } = {}) {
  return STRATEGY_AGENTS.map((a) => ({ id: a.id, label: a.label, version: a.version, status: statuses?.[a.id] ?? (a.id === DEFAULT_AGENT ? "live" : "shadow"), ...(suspended.includes(a.id) ? { suspended: true } : {}), fits: a.fits }));
}

/** Pure: an agent's plan as the decision record keeps it (levels and why; the notes stay in the trade). */
export const slimPlan = (p) => ({ entry: p.entry, stop: p.stop, tp1: p.tp1, tp2: p.tp2, at_level: p.at_level === true, rrr: p.rrr ?? null, setup: p.setup ?? null });
