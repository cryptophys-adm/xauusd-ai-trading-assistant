// Execution only per the strategy agents, under the Decision Engine (owner 2026-11-16, docs/RFC_STRATEGY_EXECUTION.md).
import test from "node:test";
import assert from "node:assert/strict";
import { agentConfidence, agentConfidences, confidenceTrend, flatConfidences, parseConfidences, agentsConsensus, strategyExecutionEnabled, CONFIDENCE_RULES, DEFAULT_AGENT } from "../src/strategy-agents.mjs";
import { decide, buildDecisionRecord } from "../src/decision-engine.mjs";

const base = { at_level: true, entry: 100.4, entry_note: "price holds", stop: 89, stop_note: "beyond", risk: 11.4, tp1: 106, tp1_note: "the 106 zone", tp2: 123, tp2_note: "far", progressive_stop: 100.4, rrr: { tp1: 0.49, tp2: 1.98 } };
const sweep = { agent: "sweep_reversal", setup: "a sweep reclaimed", at_level: true, entry: 100.4, entry_note: "swept", stop: 97.2, stop_note: "beyond the sweep's low", risk: 3.2, tp1: 106, tp1_note: "the 106 zone", tp2: 110, tp2_note: "p", progressive_stop: 100.4, rrr: { tp1: 1.75, tp2: 3 } };
const blocked = { side: "SELL", allowed: false, checks: [{ id: "quorum", pass: false, detail: "no" }], plan: null, plans: {}, vetoes: [], cautions: [], supports: [], min_rrr: 1.5, target_rule: "rrr" };
const answer = (strategy) => ({ stance: "BUY", bias: "BULLISH", confidence: 0.7, entry_type: "market", target: "tp1", ...(strategy ? { strategy } : {}) });
const quorum = { bias: "BULLISH", score: 0.5 };
const passes = (p) => Math.max(p.rrr?.tp1 ?? 0, p.rrr?.tp2 ?? 0) >= 1.5;

/** Guards as assess builds them, with the strategy execution rules on: the consensus of the long side's plans. */
function guardsOf(longPlans, { shortPlans = {}, on = true } = {}) {
  const long = { side: "BUY", allowed: true, checks: [], plan: base, plans: longPlans, vetoes: [], cautions: [], supports: [], min_rrr: 1.5, target_rule: "rrr", entry_trigger: null };
  return { long, short: { ...blocked, plans: shortPlans }, strategy_execution: on, consensus: agentsConsensus({ long: longPlans, short: shortPlans }, { passes }) };
}

test("a BUY trades only a plan of an agent that speaks on its side; without one it is held at WAIT", () => {
  const atLevel = { zone_pullback: { status: "live", plan: { ...base, agent: DEFAULT_AGENT } }, sweep_reversal: { status: "live", plan: sweep } };
  const chosen = decide({ answer: answer("sweep_reversal"), guards: guardsOf(atLevel), quorum });
  assert.deepEqual([chosen.stance, chosen.trade.agent, chosen.trade.stop], ["BUY", "sweep_reversal", 97.2], "the council's speaking agent");
  const strongest = decide({ answer: answer(null), guards: guardsOf(atLevel), quorum });
  assert.equal(strongest.trade.agent, DEFAULT_AGENT, "equal voices: the default agent first");
  // The default agent away from its level does not speak; a shadow agent never does.
  const away = { zone_pullback: { status: "live", plan: { ...base, at_level: false, agent: DEFAULT_AGENT } }, sweep_reversal: { status: "shadow", plan: sweep } };
  const none = decide({ answer: answer("sweep_reversal"), guards: guardsOf(away), quorum });
  assert.deepEqual([none.stance, none.trade, none.overruled.by, none.overruled.failed[0].detail], ["WAIT", null, "strategy_agents", "no live strategy agent sees its setup on the buy side"]);
  // The council's choice that does not speak gives way to one that does.
  const onlySweep = { zone_pullback: { status: "live", plan: { ...base, at_level: false, agent: DEFAULT_AGENT } }, sweep_reversal: { status: "live", plan: sweep } };
  assert.equal(decide({ answer: answer("zone_pullback"), guards: guardsOf(onlySweep), quorum }).trade.agent, "sweep_reversal");
  // The fallback (no council) obeys the same rule.
  assert.equal(decide({ answer: null, guards: guardsOf(away), strategy: { decision: "BUY", confidence: 0.6 }, quorum }).stance, "WAIT");
});

test("the agents comply with the Decision Engine: their lean against the stance holds the trade", () => {
  const longPlans = { sweep_reversal: { status: "live", plan: sweep } };
  const shortPlans = { breakout_retest: { status: "live", plan: { ...sweep, agent: "breakout_retest" } }, range_fade: { status: "live", plan: { ...sweep, agent: "range_fade" } }, pattern_pole: { status: "live", plan: { ...sweep, agent: "pattern_pole" } } };
  const g = guardsOf(longPlans, { shortPlans });
  assert.ok(g.consensus.lean <= -0.15);
  const d = decide({ answer: answer("sweep_reversal"), guards: g, quorum });
  assert.deepEqual([d.stance, d.overruled.by], ["WAIT", "strategy_agents"]);
  assert.match(d.overruled.failed[0].detail, /lean against the decision/);
});

test("STRATEGY_EXECUTION off: the default plan as before", () => {
  assert.equal(strategyExecutionEnabled({}), true);
  assert.equal(strategyExecutionEnabled({ STRATEGY_EXECUTION: " OFF " }), false);
  const away = { zone_pullback: { status: "live", plan: { ...base, at_level: false, agent: DEFAULT_AGENT } } };
  const d = decide({ answer: answer(null), guards: guardsOf(away, { on: false }), quorum });
  assert.deepEqual([d.stance, d.trade.stop, "agent" in d.trade], ["BUY", 89, false]);
});

test("the agent's confidence: direction, setup and quality; the 15m trend with a 0.02 band", () => {
  assert.deepEqual(CONFIDENCE_RULES, { direction: 0.4, setup: 0.35, quality: 0.25, stable_band: 0.02 });
  assert.equal(agentConfidence(1, { speaksHere: true, score: 1, voice: 1.5 }), 1);
  assert.equal(agentConfidence(1, { speaksThere: true, score: -1, voice: 0.5 }), 0);
  assert.equal(agentConfidence(1, { score: 0, voice: 1 }), 0.5, "neutral everywhere");
  assert.equal(agentConfidence(-1, { speaksHere: true, score: 0.5, voice: 1 }), 0.57, "0.4 x 0.25 + 0.35 + 0.25 x 0.5 = 0.575");
  assert.equal(agentConfidence(1, { speaksHere: true, score: null }), 0.68, "an unknown direction counts as neutral");
  const conf = agentConfidences({ long: { zone_pullback: { status: "live", plan: { ...base, rrr: { tp1: 0.5, tp2: 1 } } }, sweep_reversal: { status: "live", plan: sweep } }, short: {} }, { score: 0.5, passes, statuses: { zone_pullback: "live", sweep_reversal: "live", range_fade: "shadow" } });
  assert.deepEqual(Object.keys(conf), ["zone_pullback", "sweep_reversal"], "live agents only");
  assert.deepEqual(conf.sweep_reversal, { long: 0.78, short: 0.23 }, "0.4 x 0.75 + 0.35 + 0.125; 0.4 x 0.25 + 0 + 0.125");
  assert.deepEqual(conf.zone_pullback, { long: 0.6, short: 0.4 }, "its plan pays under 1.5R: it speaks on neither side");
  assert.deepEqual(parseConfidences(flatConfidences(conf)), conf);
  assert.equal(flatConfidences(null), "");
  assert.deepEqual(parseConfidences("a:0.5:x,b::1,c:0.2:0.3"), { c: { long: 0.2, short: 0.3 } });
  assert.equal(confidenceTrend(0.6, 0.5), "rising");
  assert.equal(confidenceTrend(0.6, 0.62), "stable");
  assert.equal(confidenceTrend(0.6, 0.58), "stable");
  assert.equal(confidenceTrend(0.55, 0.6), "drop");
  assert.equal(confidenceTrend(0.55, null), "unknown");
});

test("the record keeps the confidence, and the previous one only from the bar exactly before", () => {
  const CLOSE = "2026-11-16T10:15:00.000Z";
  const g = guardsOf({ sweep_reversal: { status: "live", plan: sweep } });
  g.agent_confidence = { sweep_reversal: { long: 0.83, short: 0.13 } };
  const assessment = { cards: [], quorum: { ...quorum, long_share: 0.6, short_share: 0.1 }, guards: g, market: null };
  const rec = (previous) => buildDecisionRecord({ key: "XAUUSD:15:" + CLOSE, barClose: CLOSE, loaded: {}, assessment, previous, now: Date.parse(CLOSE) + 60_000 });
  const prevConf = { sweep_reversal: { long: 0.9, short: 0.1 } };
  const r = rec({ decision_key: "prev", bar_close: "2026-11-16T10:00:00.000Z", stance: "BUY", confidence: 0.6, agent_confidence: prevConf });
  assert.deepEqual([r.strategy_execution, r.agent_confidence, r.agent_confidence_prev], [true, g.agent_confidence, prevConf]);
  assert.equal(rec({ decision_key: "older", bar_close: "2026-11-16T09:45:00.000Z", agent_confidence: prevConf }).agent_confidence_prev, null, "a bar missing between");
  assert.equal(rec(null).agent_confidence_prev, null);
});

test("the signal carries the rules, the trade's agent and both confidences as flat strings", async () => {
  const { managementFields } = await import("../src/ea-signal.mjs");
  const f = managementFields({ decision_key: "XAUUSD:15:2026-11-16T10:15:00.000Z", strategy_execution: true, trade: { agent: "sweep_reversal" }, agent_confidence: { sweep_reversal: { long: 0.78, short: 0.23 } }, agent_confidence_prev: { sweep_reversal: { long: 0.8, short: 0.2 } } });
  assert.deepEqual([f.strategy_execution, f.trade_agent, f.agent_conf, f.agent_conf_prev], [true, "sweep_reversal", "sweep_reversal:0.78:0.23", "sweep_reversal:0.8:0.2"]);
  assert.ok(Object.values(f).every((v) => ["string", "number", "boolean"].includes(typeof v)), "flat values only: the EA parses a flat JSON object");
});
