import test from "node:test";
import assert from "node:assert/strict";
import {
  STRATEGY_AGENTS, AGENT_IDS, DEFAULT_AGENT, PROJECTION_NOTE, priceActionReading, AGENT_BREAKER, AGENT_BREAKER_KEY, suspendedAgents, syncAgentBreaker, agentStatuses, agentContext, agentPlans, agentCatalog, finishPlan, slimPlan, strategyAgentsMode
} from "../src/strategy-agents.mjs";
import { tradeLevels, planForDirection } from "../src/strategy-engine.mjs";
import { assess, buildDecisionRecord, decisionKeyFor, decisionMessage, decide, councilEvidence, councilMessages, validateCouncil, liveAgentPlans, agentPlanPasses, strategyPlansOf, tradeFor, TP1_PROJECTION, COUNCIL_JSON_SCHEMA } from "../src/decision-engine.mjs";
import { decisionPlans, setupsFrom, agentRecords, CONTROL_ARM } from "../src/plan-learning.mjs";

const agent = (id) => STRATEGY_AGENTS.find((a) => a.id === id);
const zone = (low, high, label, major = true) => ({ low, high, price: (low + high) / 2, major, label });
/** Closed 15m bars from [low, high, close] rows. */
const bars = (rows) => rows.map(([low, high, close], i) => ({ open_time: new Date(Date.UTC(2026, 10, 10, 0, 15 * i)).toISOString(), open: close, low, high, close }));
const flat = (n, low, high, close) => Array.from({ length: n }, () => [low, high, close]);

test("the registry: one interface, the default agent always live, the others in shadow until the switches move them", () => {
  assert.deepEqual(AGENT_IDS, ["zone_pullback", "sweep_reversal", "breakout_retest", "range_fade", "pattern_breakout"]);
  for (const a of STRATEGY_AGENTS) assert.ok(a.id && a.label && a.fits.length > 40 && typeof a.plan === "function" && a.version >= 1, a.id);
  assert.deepEqual(agentStatuses({}), { zone_pullback: "live", sweep_reversal: "shadow", breakout_retest: "shadow", range_fade: "shadow", pattern_breakout: "shadow" });
  assert.deepEqual(agentStatuses({ STRATEGY_AGENTS_LIVE: " Sweep_Reversal, nope ,range_fade", STRATEGY_AGENTS_OFF: "range_fade,zone_pullback" }), { zone_pullback: "live", sweep_reversal: "live", breakout_retest: "shadow", range_fade: "off", pattern_breakout: "shadow" }, "off wins; the default agent cannot be switched off");
  assert.deepEqual(agentStatuses({ STRATEGY_AGENTS_MODE: "off", STRATEGY_AGENTS_LIVE: "sweep_reversal" }), { zone_pullback: "live", sweep_reversal: "off", breakout_retest: "off", range_fade: "off", pattern_breakout: "off" });
  assert.equal(strategyAgentsMode({}), "on");
  assert.deepEqual(agentCatalog(agentStatuses({})).map((a) => [a.id, a.status]), [["zone_pullback", "live"], ["sweep_reversal", "shadow"], ["breakout_retest", "shadow"], ["range_fade", "shadow"], ["pattern_breakout", "shadow"]]);
  assert.equal(PROJECTION_NOTE, TP1_PROJECTION, "the reward guardrail reads the same note");
  assert.equal(tradeLevels({ dir: 1, price: 100, levels: [], atrH1: 10 }).tp1_note, PROJECTION_NOTE);
});

test("zone pullback is the strategy engine's own plan, unchanged", () => {
  const strategy = { price: 100.4, atr_h1: 10, direction: "LONG", key_levels: { zones: [{ low: 99, high: 100, price: 99.5, candidate: true }, { low: 90, high: 91, price: 90.5, candidate: true }, { low: 112, high: 113, price: 112.5, candidate: true }] } };
  const ctx = agentContext({ strategy, bars: [] });
  const plan = agent(DEFAULT_AGENT).plan(1, ctx);
  const { agent: id, setup, ...rest } = plan;
  assert.deepEqual(rest, planForDirection(strategy, 1));
  assert.deepEqual([id, setup], [DEFAULT_AGENT, "price holds at a key zone"]);
  // The guardrail's plan is reused, not computed twice.
  assert.equal(agent(DEFAULT_AGENT).plan(1, { ...ctx, basePlan: { entry: 1, at_level: false } }).entry, 1);
  assert.equal(agent(DEFAULT_AGENT).plan(1, agentContext({ strategy: null })), null);
});

test("sweep reversal: a new 3-hour low through a zone, reclaimed at the close; the stop just beyond the sweep", () => {
  const levels = [zone(99, 100, "the 99.00–100.00 key zone"), zone(106, 107, "the 106.00–107.00 key zone")];
  const rows = [...flat(10, 100.6, 102, 101), [98.2, 101, 99.4], [98.9, 100.6, 100.4]];
  const ctx = { price: 100.4, atr: 10, levels, bars: bars(rows), scalp: false };
  const plan = agent("sweep_reversal").plan(1, ctx);
  assert.deepEqual(slimPlan(plan), { entry: 100.4, stop: 97.2, tp1: 106, tp2: 110, at_level: true, rrr: { tp1: 1.75, tp2: 3 }, setup: "a sweep of the 99.00–100.00 key zone reclaimed at the 15m close" });
  assert.equal(plan.stop_note, "beyond the sweep's low");
  assert.equal(plan.tp1_note, "the 106.00–107.00 key zone");
  assert.equal(plan.progressive_stop, 100.4);
  // Not reclaimed: the last bar closed below the zone.
  assert.equal(agent("sweep_reversal").plan(1, { ...ctx, bars: bars([...flat(10, 100.6, 102, 101), [98.2, 101, 99.4], [98.4, 99.5, 98.8]]) }), null);
  // Not a sweep: an older bar went lower.
  assert.equal(agent("sweep_reversal").plan(1, { ...ctx, bars: bars([...flat(4, 100.6, 102, 101), [97, 102, 101], ...flat(5, 100.6, 102, 101), [98.2, 101, 99.4], [98.9, 100.6, 100.4]]) }), null);
  // Nothing was swept, or too few bars.
  assert.equal(agent("sweep_reversal").plan(1, { ...ctx, bars: bars(flat(12, 100.6, 102, 101)) }), null);
  assert.equal(agent("sweep_reversal").plan(1, { ...ctx, bars: bars(rows.slice(-5)) }), null);
  // The short mirrors it: a sweep above resistance.
  const up = [zone(100, 101, "the 100.00–101.00 key zone"), zone(93, 94, "the 93.00–94.00 key zone")];
  const short = agent("sweep_reversal").plan(-1, { price: 99.6, atr: 10, levels: up, bars: bars([...flat(10, 98, 99.4, 99), [99, 101.8, 100.6], [99.4, 101.1, 99.6]]), scalp: false });
  assert.deepEqual([short.entry, short.stop, short.tp1, short.stop_note], [99.6, 102.8, 94, "beyond the sweep's high"]);
});

test("breakout retest: a 15m close beyond a zone that held; the entry at the broken edge, the stop behind it", () => {
  const levels = [zone(100, 101, "the 100.00–101.00 key zone"), zone(104, 105, "the 104.00–105.00 key zone")];
  const rows = [...flat(6, 99.8, 101, 100.9), [100.7, 101.8, 101.6], [101.2, 101.9, 101.5], [101.1, 101.7, 101.4]];
  const ctx = { price: 101.4, atr: 4, levels, bars: bars(rows), scalp: false };
  const plan = agent("breakout_retest").plan(1, ctx);
  assert.deepEqual(slimPlan(plan), { entry: 101.4, stop: 100.3, tp1: 104, tp2: 105.1, at_level: true, rrr: { tp1: 2.36, tp2: 3.36 }, setup: "a 15m close above the 100.00–101.00 key zone that held" });
  assert.equal(plan.stop_note, "behind the breakout bar");
  // Price ran on: a limit waits at the broken edge; the structure is closer than the minimum risk.
  const away = agent("breakout_retest").plan(1, { ...ctx, price: 103 });
  assert.deepEqual([away.entry, away.at_level, away.stop, away.entry_note], [101, false, 100, "a retest of the 100.00–101.00 key zone after the break"]);
  assert.match(away.stop_note, /0\.25 times the 1H average range/);
  // The break failed: a later bar closed back below the zone.
  assert.equal(agent("breakout_retest").plan(1, { ...ctx, bars: bars([...flat(5, 99.8, 101, 100.9), [100.7, 101.8, 101.6], [99.5, 101.9, 99.9], [99.6, 100.9, 100.8], [100.5, 101.2, 100.9]]) }), null);
  // A whipsaw around the zone is no breakout: the bars before the second close above had not held below it.
  assert.equal(agent("breakout_retest").plan(1, { ...ctx, bars: bars([...flat(5, 99.8, 101, 100.9), [100.7, 101.8, 101.6], [99.5, 101.9, 99.9], [99.6, 101.7, 101.4], [101.1, 101.7, 101.4]]) }), null);
  // The zone's own edge is the stop when the breakout bar reached below it.
  const deep = agent("breakout_retest").plan(1, { ...ctx, bars: bars([...flat(6, 99.8, 101, 100.9), [99.7, 101.8, 101.6], [101.2, 101.9, 101.5], [101.1, 101.7, 101.4]]) });
  assert.deepEqual([deep.stop, deep.stop_note], [99.6, "behind the 100.00–101.00 key zone"]);
  // No break in the last six bars.
  assert.equal(agent("breakout_retest").plan(1, { ...ctx, bars: bars(flat(10, 101.1, 101.9, 101.5)) }), null);
  assert.equal(agent("breakout_retest").plan(-1, ctx), null, "nothing broke downward");
});

test("range fade: only in a ranging regime, only near the edge; the targets are the range's middle and far side", () => {
  const rows = Array.from({ length: 32 }, (_, i) => (i % 8 < 4 ? [100 + (i % 4), 104 + (i % 4), 103] : [104, 110 - (i % 4), 106]));
  rows[31] = [100.6, 102, 101];
  const ctx = { price: 101, atr: 5, levels: [], bars: bars(rows), regime: "low-ranging", scalp: false };
  const plan = agent("range_fade").plan(1, ctx);
  assert.deepEqual(slimPlan(plan), { entry: 101, stop: 98.75, tp1: 105, tp2: 109, at_level: true, rrr: { tp1: 1.78, tp2: 3.56 }, setup: "the bottom of a 8-hour range in a ranging regime" });
  assert.deepEqual([plan.tp1_note, plan.tp2_note], ["the middle of the 8-hour range", "the top of the 8-hour range"]);
  assert.notEqual(plan.tp1_note, PROJECTION_NOTE, "a real target for the scalp guardrail");
  // Between the edge and the fade zone's limit: a limit closer to the edge.
  const wait = agent("range_fade").plan(1, { ...ctx, price: 103 });
  assert.deepEqual([wait.entry, wait.at_level], [101.5, false]);
  assert.equal(agent("range_fade").plan(1, { ...ctx, price: 105 }), null, "mid-range is no fade");
  assert.equal(agent("range_fade").plan(1, { ...ctx, regime: "high-trending" }), null);
  assert.equal(agent("range_fade").plan(1, { ...ctx, regime: null }), null);
  assert.equal(agent("range_fade").plan(1, { ...ctx, atr: 20 }), null, "a 10-point range is no range against a 20-point ATR");
  const top = agent("range_fade").plan(-1, { ...ctx, price: 109.5 });
  assert.deepEqual([top.entry, top.stop, top.tp1, top.tp2], [109.5, 111.25, 105, 101]);
});

test("every agent's plan has one shape; a stop too far is no plan; an agent that is off is not computed", () => {
  const ctx = { price: 100, atr: 10, levels: [], scalp: false };
  assert.equal(finishPlan("x", 1, { entry: 100, stop: 70, atLevel: true }, ctx), null, "3 ATR of risk");
  const p = finishPlan("x", -1, { entry: 100, stop: 105, atLevel: false, entryNote: "e", stopNote: "s", setup: "u" }, ctx);
  assert.deepEqual(Object.keys(p), ["agent", "setup", "at_level", "entry", "entry_note", "stop", "stop_note", "risk", "tp1", "tp1_note", "tp2", "tp2_note", "progressive_stop", "rrr"]);
  assert.deepEqual([p.tp1, p.tp1_note, p.rrr.tp1], [90, PROJECTION_NOTE, 2]);
  const levels = [zone(99, 100, "the 99.00–100.00 key zone"), zone(106, 107, "the 106.00–107.00 key zone")];
  const full = { price: 100.4, atr: 10, levels, bars: bars([...flat(10, 100.6, 102, 101), [98.2, 101, 99.4], [98.9, 100.6, 100.4]]), scalp: false, basePlan: { entry: 100.4, stop: 89, tp1: 106 } };
  assert.deepEqual(Object.keys(agentPlans(1, full, agentStatuses({}))), ["zone_pullback", "sweep_reversal"]);
  assert.equal(agentPlans(1, full, agentStatuses({})).sweep_reversal.status, "shadow");
  assert.deepEqual(Object.keys(agentPlans(1, full, agentStatuses({ STRATEGY_AGENTS_OFF: "sweep_reversal" }))), ["zone_pullback"]);
  assert.deepEqual(Object.keys(agentPlans(1, { ...full, price: null }, agentStatuses({}))), ["zone_pullback"], "without a price only the guardrail's plan stands");
  assert.deepEqual(agentPlans(0, full, agentStatuses({})), { zone_pullback: { status: "live", plan: { ...full.basePlan, agent: "zone_pullback" } } });
});

// ---------------------------------------------------------------------------
// The Decision Engine: the council's choice.

const base = { at_level: true, entry: 100.4, entry_note: "price holds", stop: 89, stop_note: "beyond", risk: 11.4, tp1: 106, tp1_note: "the 106 zone", tp2: 123, tp2_note: "far", progressive_stop: 100.4, rrr: { tp1: 0.49, tp2: 1.98 } };
const sweep = { agent: "sweep_reversal", setup: "a sweep reclaimed", at_level: true, entry: 100.4, entry_note: "swept", stop: 97.2, stop_note: "beyond the sweep's low", risk: 3.2, tp1: 106, tp1_note: "the 106 zone", tp2: 110, tp2_note: "p", progressive_stop: 100.4, rrr: { tp1: 1.75, tp2: 3 } };
const guard = (status, extra = {}) => ({ side: "BUY", allowed: true, checks: [], plan: base, plans: { zone_pullback: { status: "live", plan: { ...base, agent: "zone_pullback" } }, sweep_reversal: { status, plan: sweep } }, vetoes: [], cautions: [], supports: [], min_rrr: 1.5, target_rule: "rrr", entry_trigger: null, ...extra });
const blocked = { side: "SELL", allowed: false, checks: [{ id: "quorum", pass: false, detail: "no" }], plan: null, plans: {}, vetoes: [], cautions: [], supports: [], min_rrr: 1.5, target_rule: "rrr" };
const answer = (strategy) => ({ stance: "BUY", bias: "BULLISH", confidence: 0.7, entry_type: "market", target: "tp1", ...(strategy ? { strategy } : {}) });
const quorum = { bias: "BULLISH", score: 0.5 };

test("the council chooses among live agents; a shadow agent is never traded; without a choice the plan is as before", () => {
  const live = { long: guard("live"), short: blocked }, shadow = { long: guard("shadow"), short: blocked };
  const picked = decide({ answer: answer("sweep_reversal"), guards: live, quorum });
  assert.deepEqual([picked.stance, picked.trade.strategy, picked.trade.setup, picked.trade.stop, picked.trade.rrr, picked.trade.target], ["BUY", "sweep_reversal", "a sweep reclaimed", 97.2, 1.75, "tp1"]);
  const kept = decide({ answer: answer(null), guards: live, quorum });
  assert.deepEqual([kept.trade.stop, kept.trade.target, "strategy" in kept.trade], [89, "tp2", false], "the default agent's plan, in its old shape");
  assert.deepEqual(decide({ answer: answer("zone_pullback"), guards: live, quorum }).trade, kept.trade);
  assert.deepEqual(decide({ answer: answer("sweep_reversal"), guards: shadow, quorum }).trade, kept.trade, "shadow: recorded, not traded");
  assert.deepEqual(decide({ answer: answer("range_fade"), guards: live, quorum }).trade, kept.trade, "an agent without a setup");
  // Scalp: the agent's first target must be a real level.
  const scalp = { long: guard("live", { target_rule: "nearest" }), short: blocked };
  assert.equal(decide({ answer: answer("sweep_reversal"), guards: scalp, quorum }).trade.strategy, "sweep_reversal");
  const projected = { long: guard("live", { target_rule: "nearest" }), short: blocked };
  projected.long.plans.sweep_reversal = { status: "live", plan: { ...sweep, tp1_note: PROJECTION_NOTE } };
  assert.equal("strategy" in decide({ answer: answer("sweep_reversal"), guards: projected, quorum }).trade, false);
  assert.equal(agentPlanPasses({ ...sweep, rrr: { tp1: 1.1, tp2: 1.2 } }, live.long), false, "below the mode's reward");
  assert.deepEqual(liveAgentPlans(live.long).map(([id]) => id), ["zone_pullback", "sweep_reversal"]);
  assert.deepEqual(liveAgentPlans(shadow.long).map(([id]) => id), ["zone_pullback"]);
  assert.equal(tradeFor("BUY", base, {}).strategy, undefined);
  // The owner's Telegram message names the agent only when the council chose one.
  const msg = (trade) => decisionMessage({ stance: "BUY", bias: "BULLISH", confidence: 0.7, source: "council", bar_close: "2026-11-10T10:00:00.000Z", summary: "Decision BUY, bias bullish: s.", trade });
  assert.ok(msg(picked.trade).includes("\nStrategy: Sweep reversal (a sweep reclaimed)\n"));
  assert.ok(!msg(kept.trade).includes("Strategy:"));
});

test("the evidence lists strategies only when the council has a choice; the record keeps every agent's plan", () => {
  const args = (g) => ({ barClose: "2026-11-10T10:00:00.000Z", cards: [], quorum: { long_share: 0.7, short_share: 0.1, neutral_share: 0.2, score: 0.5, bias: "BULLISH" }, guards: { long: g, short: blocked }, context: {} });
  const none = councilEvidence(args(guard("shadow")));
  assert.equal("strategies" in none.long, false);
  assert.ok(!councilMessages(none)[0].content.includes("strategy agents"), "the prompt is as before");
  const some = councilEvidence(args(guard("live")));
  assert.deepEqual(some.long.strategies.map((s) => [s.id, s.name, s.setup, s.plan.stop]), [["zone_pullback", "Zone pullback", null, 89], ["sweep_reversal", "Sweep reversal", "a sweep reclaimed", 97.2]]);
  assert.ok(some.long.strategies[1].made_for.startsWith("A stop hunt"));
  assert.equal("strategies" in some.short, false);
  assert.ok(councilMessages(some)[0].content.includes("return its id in strategy"));
  assert.deepEqual(strategyPlansOf({ long: guard("shadow"), short: blocked }), {
    long: { zone_pullback: { status: "live", entry: 100.4, stop: 89, tp1: 106, tp2: 123, at_level: true, rrr: { tp1: 0.49, tp2: 1.98 }, setup: null }, sweep_reversal: { status: "shadow", entry: 100.4, stop: 97.2, tp1: 106, tp2: 110, at_level: true, rrr: { tp1: 1.75, tp2: 3 }, setup: "a sweep reclaimed" } },
    short: {}
  });
  assert.equal(strategyPlansOf({ long: { plans: {} }, short: {} }), null);
  // The answer: a known id stays, anything else is dropped; the field is optional.
  const a = { stance: "buy", bias: "bullish", confidence: 0.6, entry_type: "limit", target: "tp1", strategy: "sweep_reversal", summary: "Decision BUY, bias bullish: the sweep held.", reasons: ["The sweep was reclaimed."], risks: [], weighed: [] };
  assert.equal(validateCouncil(a).valid, true);
  assert.equal(a.strategy, "sweep_reversal");
  const b = { ...a, strategy: "martingale" };
  validateCouncil(b);
  assert.equal("strategy" in b, false);
  assert.ok(!COUNCIL_JSON_SCHEMA.required.includes("strategy"));
  assert.deepEqual(COUNCIL_JSON_SCHEMA.properties.strategy.enum, [...AGENT_IDS]);
});

test("the plan learner measures each agent's own setups", () => {
  const M15 = 15 * 60_000, T0 = Date.parse("2026-11-10T10:00:00Z");
  const row = (i, plans) => ({ decision_key: `OANDA:XAUUSD:15:${T0 + (i - 1) * M15}`, decided_at: new Date(T0 + i * M15 + 60_000).toISOString(), side: "BUY", stance: "BUY", entry: 100.4, stop: 89, tp: 106, action: "ENTER_LIMIT", at_level: 1, atr_h1: 10, mode: "scalp", regime: "low-ranging", plans });
  const plans = JSON.stringify(strategyPlansOf({ long: guard("shadow"), short: blocked }));
  // A decision of before the agents holds one plan: its trade, the default agent's.
  assert.deepEqual(decisionPlans(row(0, null)).map((d) => [d.agent, d.entry, d.stop, d.tp1]), [["zone_pullback", 100.4, 89, 106]]);
  const two = decisionPlans(row(1, plans));
  assert.deepEqual(two.map((d) => [d.agent, d.stop, d.action]), [["zone_pullback", 89, "ENTER_MARKET"], ["sweep_reversal", 97.2, "ENTER_MARKET"]]);
  assert.deepEqual(decisionPlans({ ...row(1, plans), side: "SELL", stance: "SELL" }).map((d) => d.agent), ["zone_pullback"], "no agent plan on that side: the trade");
  const setups = setupsFrom([...decisionPlans(row(0, null)), ...two, ...decisionPlans(row(2, plans))].sort((a, b) => a.close_ms - b.close_ms));
  assert.deepEqual(setups.map((s) => [s.agent, s.decisions, s.setup_key.split(":").slice(-2).join(":")]), [["zone_pullback", 3, `${T0 - M15}:BUY`], ["sweep_reversal", 2, "BUY:sweep_reversal"]], "one setup per agent, each with its own repeats");
  const done = (agent, context, r, s = "target") => ({ agent, context, results: { [CONTROL_ARM]: { s, r, f: s === "unfilled" ? 0 : 1 } } });
  assert.deepEqual(agentRecords([done("zone_pullback", "scalp|low-ranging", 0.5), done("zone_pullback", "scalp|low-ranging", -1, "stop"), done("sweep_reversal", "scalp|low-ranging", 1.8), done("sweep_reversal", "scalp|high-trending", 0, "unfilled"), { agent: "x", results: {} }]), [
    { agent: "sweep_reversal", setups: 2, mean_r: 0.9, fill_rate: 0.5, target_rate: 1, stop_rate: 0, contexts: [{ context: "scalp|high-trending", setups: 1, mean_r: 0 }, { context: "scalp|low-ranging", setups: 1, mean_r: 1.8 }] },
    { agent: "zone_pullback", setups: 2, mean_r: -0.25, fill_rate: 1, target_rate: 0.5, stop_rate: 0.5, contexts: [{ context: "scalp|low-ranging", setups: 2, mean_r: -0.25 }] }
  ]);
});

test("end to end: a sweep on the 15m bars reaches the record in shadow, and the trade once the agent is live and the council names it", () => {
  const CLOSE = "2026-11-10T10:00:00.000Z", NOW = Date.parse(CLOSE) + 60_000;
  const r = (key, lean, action = "WAIT") => ({ key, label: key, role: key, available: true, lean, action, confidence: 0.6, summary: `${key} reads the chart.`, at: CLOSE, stale: false });
  const zones = [{ low: 3995, high: 3998, price: 3996.5, candidate: true }, { low: 3980, high: 3980, price: 3980, candidate: true }, { low: 4030, high: 4032, price: 4031, candidate: true }, { low: 4050, high: 4050, price: 4050, candidate: true }];
  const loaded = {
    inputs: { calendar: { events: [] }, m15Bars: bars([...flat(10, 3999, 4003, 4001), [3993.5, 4001, 3996], [3995.5, 4000.5, 4000]]) },
    strategy: { decision: "WAIT", state: "SETUP_READY", direction: "LONG", confidence: 0.6, alignment: 0.5, headline: "The long setup is ready.", price: 4000, atr_h1: 10, key_levels: { zones }, plan: { at_level: true } },
    global: { timeframes: [r("D1", 0.5), r("H4", 0.4), r("H1", 0.3), r("M15", 0.35, "BUY"), r("NEWS", 0.2), r("MACRO", 0.1)] }, correlations: null, regime: "normal-trending"
  };
  const council = (strategy) => ({ answer: { stance: "BUY", bias: "BULLISH", confidence: 0.7, entry_type: "limit", target: "tp1", ...(strategy ? { strategy } : {}), summary: "Decision BUY, bias bullish: the sweep was reclaimed.", reasons: ["The rooms lean bullish."], risks: [], weighed: [] } });
  const record = (env, strategy) => buildDecisionRecord({ key: decisionKeyFor(CLOSE), barClose: CLOSE, loaded, assessment: assess(loaded, { now: NOW, env }), council: council(strategy), now: NOW, env });
  // Shadow (the default): the agent's plan is in the record, the trade is the plan of before.
  const shadow = record({}, "sweep_reversal");
  assert.deepEqual(Object.keys(shadow.strategy_plans.long), ["zone_pullback", "sweep_reversal"]);
  assert.deepEqual(shadow.strategy_plans.long.sweep_reversal, { status: "shadow", entry: 4000, stop: 3992.5, tp1: 4030, tp2: 4050, at_level: true, rrr: { tp1: 4, tp2: 6.67 }, setup: shadow.strategy_plans.long.sweep_reversal.setup });
  assert.match(shadow.strategy_plans.long.sweep_reversal.setup, /^a sweep of the 3995\.00–3998\.00 key zone/);
  assert.equal(shadow.stance, "BUY");
  assert.equal("strategy" in shadow.trade, false);
  assert.deepEqual([shadow.trade.entry, shadow.trade.stop], [shadow.strategy_plans.long.zone_pullback.entry, shadow.strategy_plans.long.zone_pullback.stop]);
  assert.deepEqual(shadow.trade, record({ STRATEGY_AGENTS_MODE: "off" }, "sweep_reversal").trade, "the trade is the same with the agents off");
  assert.deepEqual(Object.keys(record({ STRATEGY_AGENTS_MODE: "off" }, null).strategy_plans.long), ["zone_pullback"]);
  // Live: the council's choice decides the plan; no choice keeps the default.
  const live = record({ STRATEGY_AGENTS_LIVE: "sweep_reversal" }, "sweep_reversal");
  assert.deepEqual([live.trade.strategy, live.trade.entry, live.trade.stop, live.trade.tp, live.trade.rrr], ["sweep_reversal", 4000, 3992.5, 4030, 4]);
  assert.deepEqual(record({ STRATEGY_AGENTS_LIVE: "sweep_reversal" }, null).trade, shadow.trade);
  assert.doesNotMatch(JSON.stringify(live), /lot|position_size|volume/i);
});

test("the breaker: a live agent with a negative record over enough setups goes back to shadow and returns by itself; the owner hears once", async () => {
  const LIVE = { STRATEGY_AGENTS_LIVE: "sweep_reversal,breakout_retest,range_fade,pattern_breakout" };
  const rec = (agent, setups, mean_r) => ({ agent, setups, mean_r, fill_rate: 1, target_rate: 0.4, contexts: [] });
  assert.deepEqual(agentStatuses(LIVE), { zone_pullback: "live", sweep_reversal: "live", breakout_retest: "live", range_fade: "live", pattern_breakout: "live" });
  const records = [rec("zone_pullback", 200, -0.3), rec("sweep_reversal", 30, -0.01), rec("breakout_retest", 29, -0.9), rec("range_fade", 80, 0)];
  assert.deepEqual(suspendedAgents(records), [{ id: "sweep_reversal", setups: 30, mean_r: -0.01 }], "the default agent is never suspended; 29 setups are too few; zero is not negative");
  assert.deepEqual(agentStatuses(LIVE, { records }), { zone_pullback: "live", sweep_reversal: "shadow", breakout_retest: "live", range_fade: "live", pattern_breakout: "live" });
  assert.deepEqual(agentStatuses({}, { records }), { zone_pullback: "live", sweep_reversal: "shadow", breakout_retest: "shadow", range_fade: "shadow", pattern_breakout: "shadow" });
  assert.deepEqual(agentCatalog(agentStatuses(LIVE, { records }), { suspended: ["sweep_reversal"] }).map((a) => [a.id, a.status, a.suspended === true]), [["zone_pullback", "live", false], ["sweep_reversal", "shadow", true], ["breakout_retest", "live", false], ["range_fade", "live", false], ["pattern_breakout", "live", false]]);
  assert.deepEqual(suspendedAgents(null), []);
  assert.equal(AGENT_BREAKER.min_setups, 30);
  // Telegram: once per change, and nothing for an agent the switches never set live.
  const m = new Map(), sent = [];
  const env = { ...LIVE, SIGNAL_CACHE: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  const send = async (t) => { sent.push(t); };
  assert.deepEqual(await syncAgentBreaker(env, [rec("range_fade", 5, -1)], { send }), { status: "unchanged", suspended: [] });
  const first = await syncAgentBreaker(env, records, { send });
  assert.deepEqual([first.status, first.suspended, sent.length], ["changed", ["sweep_reversal"], 1]);
  assert.match(sent[0], /^XAUUSD STRATEGY AGENTS\nSweep reversal is suspended: -0\.01R per setup over 30 setups\./);
  assert.equal((await syncAgentBreaker(env, records, { send })).status, "unchanged");
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(m.get(AGENT_BREAKER_KEY)).ids, ["sweep_reversal"]);
  const back = await syncAgentBreaker(env, [rec("sweep_reversal", 40, 0.05)], { send });
  assert.deepEqual([back.status, back.suspended], ["changed", []]);
  assert.match(sent[1], /Sweep reversal is live again/);
  assert.deepEqual(await syncAgentBreaker({ SIGNAL_CACHE: env.SIGNAL_CACHE }, records, { send }), { status: "unchanged", suspended: [] }, "not set live by the switches: nothing to tell");
});

test("the council reads each strategy's record, overall and in the present market condition; a suspended agent is not offered", () => {
  const args = (g, extra = {}) => ({ barClose: "2026-11-10T10:00:00.000Z", cards: [], quorum: { long_share: 0.7, short_share: 0.1, neutral_share: 0.2, score: 0.5, bias: "BULLISH" }, guards: { long: g, short: blocked }, context: {}, ...extra });
  const agentRecords = [
    { agent: "zone_pullback", setups: 189, mean_r: 0.49, fill_rate: 0.95, target_rate: 0.4, contexts: [{ context: "scalp|low-ranging", setups: 80, mean_r: 0.31 }] },
    { agent: "sweep_reversal", setups: 12, mean_r: 0.2, fill_rate: 1, target_rate: 0.5, contexts: [{ context: "scalp|high-trending", setups: 12, mean_r: 0.2 }] }
  ];
  const ev = councilEvidence(args(guard("live"), { agentRecords, condition: "scalp|low-ranging" }));
  assert.deepEqual(ev.long.strategies.map((s) => [s.id, s.record]), [
    ["zone_pullback", { setups: 189, mean_r_per_setup: 0.49, filled: 0.95, reached_target: 0.4, in_this_market_condition: { setups: 80, mean_r_per_setup: 0.31 } }],
    ["sweep_reversal", { setups: 12, mean_r_per_setup: 0.2, filled: 1, reached_target: 0.5, in_this_market_condition: null }]
  ]);
  assert.ok(councilMessages(ev)[0].content.includes("treat a strategy without a record as untested"));
  assert.equal(councilEvidence(args(guard("live"))).long.strategies[1].record, null, "no record yet");
  // End to end: the breaker's record reaches assess, and the suspended agent is recorded but not offered.
  const CLOSE = "2026-11-10T10:00:00.000Z", NOW = Date.parse(CLOSE) + 60_000;
  const r = (key, lean, action = "WAIT") => ({ key, label: key, role: key, available: true, lean, action, confidence: 0.6, summary: `${key} reads the chart.`, at: CLOSE, stale: false });
  const zones = [{ low: 3995, high: 3998, price: 3996.5, candidate: true }, { low: 3980, high: 3980, price: 3980, candidate: true }, { low: 4030, high: 4032, price: 4031, candidate: true }, { low: 4050, high: 4050, price: 4050, candidate: true }];
  const loaded = {
    inputs: { calendar: { events: [] }, m15Bars: bars([...flat(10, 3999, 4003, 4001), [3993.5, 4001, 3996], [3995.5, 4000.5, 4000]]) },
    strategy: { decision: "WAIT", state: "SETUP_READY", direction: "LONG", confidence: 0.6, alignment: 0.5, headline: "The long setup is ready.", price: 4000, atr_h1: 10, key_levels: { zones }, plan: { at_level: true } },
    global: { timeframes: [r("D1", 0.5), r("H4", 0.4), r("H1", 0.3), r("M15", 0.35, "BUY"), r("NEWS", 0.2), r("MACRO", 0.1)] }, correlations: null, regime: "normal-trending"
  };
  const env = { STRATEGY_AGENTS_LIVE: "sweep_reversal" };
  const liveNow = assess(loaded, { now: NOW, env }).guards.long;
  assert.equal(liveNow.plans.sweep_reversal.status, "live");
  assert.deepEqual(councilEvidence(args(liveNow)).long.strategies.map((s) => s.id), ["zone_pullback", "sweep_reversal"]);
  const held = assess(loaded, { now: NOW, env, agentRecords: [{ agent: "sweep_reversal", setups: 40, mean_r: -0.2 }] }).guards.long;
  assert.equal(held.plans.sweep_reversal.status, "shadow");
  assert.equal("strategies" in councilEvidence(args(held)).long, false);
});

test("pattern breakout: the Projection Agent's broken-out pattern, entered at the broken line toward its measured target; its record on gold decides", () => {
  const dt = { tf: "15", chart: "15m", id: "double_top_eve_adam", name: "double top (Eve & Adam)", status: "confirmed", direction: -1, upper: 110, lower: 104, height: 6, target: 98, bars_ago: 2 };
  const ctx = (extra = {}) => ({ price: 103.6, atr: 4, levels: [], scalp: false, patterns: [dt], calibration: null, ...extra });
  const plan = agent("pattern_breakout").plan(-1, ctx());
  assert.deepEqual(slimPlan(plan), { entry: 103.6, stop: 107.4, tp1: 98, tp2: 95, at_level: true, rrr: { tp1: 1.47, tp2: 2.26 }, setup: "the Projection Agent's 15m double top (Eve & Adam), broken downward (no record on gold yet)" });
  assert.deepEqual([plan.entry_note, plan.stop_note, plan.tp1_note], ["price is at the broken lower line of the 15m double top (Eve & Adam)", "half the pattern's height behind the broken line", "15m double top (Eve & Adam): measured target"]);
  assert.notEqual(plan.tp1_note, PROJECTION_NOTE);
  assert.equal(agent("pattern_breakout").plan(1, ctx()), null, "the pattern broke downward");
  // Price ran on: a limit waits at the broken line.
  const away = agent("pattern_breakout").plan(-1, ctx({ price: 101.5 }));
  assert.deepEqual([away.entry, away.at_level, away.stop], [104, false, 107.4]);
  // Back inside the pattern, or the target too close: no plan.
  assert.equal(agent("pattern_breakout").plan(-1, ctx({ price: 105 })), null);
  assert.equal(agent("pattern_breakout").plan(-1, ctx({ patterns: [{ ...dt, target: 102.5 }] })), null);
  assert.equal(agent("pattern_breakout").plan(-1, ctx({ patterns: [{ ...dt, status: "forming", direction: 0 }] })), null);
  assert.equal(agent("pattern_breakout").plan(-1, ctx({ patterns: [{ ...dt, tf: "D", chart: "D1" }] })), null, "the 15m and 1H charts only");
  // The record on gold: below the rate of all patterns the pattern is left out; above, it is named.
  const cal = (factor, active = true) => ({ base_rate: 0.5, patterns: { double_top_eve_adam: { n: 40, rate: 0.5 * factor, factor, active } } });
  assert.equal(agent("pattern_breakout").plan(-1, ctx({ calibration: cal(0.7) })), null);
  assert.match(agent("pattern_breakout").plan(-1, ctx({ calibration: cal(1.3) })).setup, /\(on gold it reached its target 65% of 40 times\)$/);
  assert.match(agent("pattern_breakout").plan(-1, ctx({ calibration: cal(0.7, false) })).setup, /35% of 40 times, too few to weigh\)$/, "not measured enough: still traded, said so");
  // Two patterns: the better measured record first.
  const wedge = { tf: "60", chart: "1H", id: "falling_wedge", name: "falling wedge", status: "busted", direction: -1, upper: 112, lower: 103.9, height: 8, target: 96, bars_ago: 1 };
  const both = { base_rate: 0.5, patterns: { double_top_eve_adam: { n: 30, rate: 0.5, factor: 1, active: true }, falling_wedge: { n: 30, rate: 0.7, factor: 1.4, active: true } } };
  const best = agent("pattern_breakout").plan(-1, ctx({ patterns: [dt, wedge], calibration: both }));
  assert.match(best.setup, /^the Projection Agent's 1H busted falling wedge, broken downward/);
  // A wide pattern's stop is capped at 1.25 ATR behind the line.
  const wide = agent("pattern_breakout").plan(-1, ctx({ patterns: [{ ...dt, height: 20, target: 84 }] }));
  assert.equal(wide.stop, 109.4);
  // The Projection Agent's reading for the council: no price, broken-out patterns first.
  const forming = { tf: "240", chart: "4H", id: "symmetrical_triangle", name: "symmetrical triangle", status: "forming", direction: 0, upper: 120, lower: 100, height: 20, target: null, bars_ago: 0 };
  assert.deepEqual(priceActionReading([forming, wedge, dt, { tf: "D", name: "x" }], both), [
    { chart: "15m", pattern: "double top (Eve & Adam)", status: "confirmed", direction: "broke out downward", record_on_gold: { breakouts: 30, reached_target_pct: 50, measured_enough: true } },
    { chart: "1H", pattern: "falling wedge", status: "busted", direction: "broke out downward", record_on_gold: { breakouts: 30, reached_target_pct: 70, measured_enough: true } },
    { chart: "4H", pattern: "symmetrical triangle", status: "forming", direction: "not broken out yet" }
  ]);
  assert.doesNotMatch(JSON.stringify(priceActionReading([dt, wedge, forming], both)), /1\d\d(\.\d+)?[,}]/, "no price");
  assert.deepEqual(priceActionReading(null), []);
});

test("the Projection Agent's reading reaches the council with the strategies, and its pattern the trade", () => {
  const CLOSE = "2026-11-10T10:00:00.000Z", NOW = Date.parse(CLOSE) + 60_000;
  const r = (key, lean, action = "WAIT") => ({ key, label: key, role: key, available: true, lean, action, confidence: 0.6, summary: `${key} reads the chart.`, at: CLOSE, stale: false });
  const zones = [{ low: 3995, high: 3998, price: 3996.5, candidate: true }, { low: 3980, high: 3980, price: 3980, candidate: true }, { low: 4030, high: 4032, price: 4031, candidate: true }, { low: 4050, high: 4050, price: 4050, candidate: true }];
  const pattern = { tf: "15", chart: "15m", id: "double_bottom_adam_adam", name: "double bottom (Adam & Adam)", status: "confirmed", direction: 1, upper: 3999.5, lower: 3990, height: 9.5, target: 4009, bars_ago: 1 };
  const loaded = {
    inputs: { calendar: { events: [] }, m15Bars: bars(flat(12, 3999, 4003, 4001)), patternCalibration: { base_rate: 0.5, patterns: { double_bottom_adam_adam: { n: 25, rate: 0.6, factor: 1.2, active: true } } } },
    strategy: { decision: "WAIT", state: "SETUP_READY", direction: "LONG", confidence: 0.6, alignment: 0.5, headline: "The long setup is ready.", price: 4000, atr_h1: 10, key_levels: { zones, patterns: [pattern] }, plan: { at_level: true } },
    global: { timeframes: [r("D1", 0.5), r("H4", 0.4), r("H1", 0.3), r("M15", 0.35, "BUY"), r("NEWS", 0.2), r("MACRO", 0.1)] }, correlations: null, regime: "normal-trending"
  };
  const env = { STRATEGY_AGENTS_LIVE: "pattern_breakout" };
  const a = assess(loaded, { now: NOW, env });
  assert.deepEqual(Object.keys(a.guards.long.plans), ["zone_pullback", "pattern_breakout"]);
  const ev = councilEvidence({ barClose: CLOSE, cards: a.cards, quorum: a.quorum, guards: a.guards, context: {} });
  assert.deepEqual(ev.price_action, [{ chart: "15m", pattern: "double bottom (Adam & Adam)", status: "confirmed", direction: "broke out upward", record_on_gold: { breakouts: 25, reached_target_pct: 60, measured_enough: true } }]);
  assert.deepEqual(ev.long.strategies.map((s) => s.id), ["zone_pullback", "pattern_breakout"]);
  assert.ok(councilMessages(ev)[0].content.includes("price_action, when present, is the Projection Agent's reading"));
  const council = { answer: { stance: "BUY", bias: "BULLISH", confidence: 0.7, entry_type: "limit", target: "tp1", strategy: "pattern_breakout", summary: "Decision BUY, bias bullish: the double bottom broke out.", reasons: ["The pattern is confirmed."], risks: [], weighed: [] } };
  const rec = buildDecisionRecord({ key: decisionKeyFor(CLOSE), barClose: CLOSE, loaded, assessment: a, council, now: NOW, env });
  assert.deepEqual([rec.trade.strategy, rec.trade.entry, rec.trade.stop, rec.trade.tp1, rec.trade.target, rec.trade.tp], ["pattern_breakout", 4000, 3993.75, 4009, "tp2", 4013.75], "the measured target pays 1.44R, below this mode's 1.5R, so the trade takes the second target");
  assert.match(rec.trade.setup, /^the Projection Agent's 15m double bottom \(Adam & Adam\), broken upward \(on gold it reached its target 60% of 25 times\)$/);
  // Without a choice among strategies the evidence carries no price_action, as before.
  const off = assess(loaded, { now: NOW, env: {} });
  assert.equal("price_action" in councilEvidence({ barClose: CLOSE, cards: off.cards, quorum: off.quorum, guards: off.guards, context: {} }), false);
});
