// The War Room chart's clear-decision check (owner directive 2026-11-11: no setup on the chart unless the decision is
// explicitly clear). PriceChart read the Decision Engine's stance from `global.engine`, which the Global Conclusion never
// carries (the engine is the body's top-level `engine`, useMarket's `engine`), so an engine BUY or SELL never counted.
// lib/entryZone.ts clearDecision reads the strategy's decision and the market's engine; PriceChart uses it for the plan
// lines, the Entry band and the "plan hidden" note.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chartPlan, clearDecision } from "../workers/xauusd-nexus-dashboard/ui/src/lib/entryZone.ts";

const src = (p) => readFileSync(new URL(`../workers/xauusd-nexus-dashboard/ui/src/${p}`, import.meta.url), "utf8");

test("CD1 clearDecision: a strategy BUY or SELL, or an engine BUY or SELL stance", () => {
  for (const d of ["BUY", "SELL"]) {
    assert.equal(clearDecision({ decision: d }, null), true, `strategy ${d}`);
    assert.equal(clearDecision({ decision: "WAIT" }, { stance: d }), true, `engine ${d} over a strategy WAIT`);
    assert.equal(clearDecision(null, { stance: d }), true, `engine ${d} with no strategy`);
  }
  for (const [s, e] of [[{ decision: "WAIT" }, { stance: "WAIT" }], [{ decision: "WAIT" }, null], [null, null], [undefined, undefined], [{}, {}], [{ decision: "buy" }, { stance: "sell" }]]) {
    assert.equal(clearDecision(s, e), false, JSON.stringify([s, e]));
  }
});

test("CD2 PriceChart reads the market's engine, never global.engine", () => {
  const pc = src("components/PriceChart.tsx");
  assert.doesNotMatch(pc, /g\?\.engine|global\?\.engine|g\.engine\b/, "the Global Conclusion's global carries no engine");
  assert.match(pc, /const \{ global: g, engine, pollOf \} = useMarket\(\);/);
  assert.match(pc, /const p = showPlan && mark\.show \? chartPlan\(strategy, engine\) : null;/, "the plan lines");
  assert.match(pc, /const clear = clearDecision\(strategy, engine\);/, "the Entry band");
  assert.match(pc, /showPlan && !!chartPlan\(strategy, engine\)/, "the plan-hidden note");
  assert.doesNotMatch(pc, /\? strategy\?\.plan : null/, "the lines never read the strategy plan directly");
  // The effects that draw them re-run when the engine's decision changes.
  assert.match(pc, /\}, \[strategy, engine, showZones, showPlan, mark\.show, mark\.dim, mark\.suffix\]\);/);
  assert.match(pc, /\}, \[strategy, engine, showPlan, mark\.show, mark\.dim\]\);/);
});

test("CD3 chartPlan: the chart's plan lines follow the Entry band's source", () => {
  const trade = { side: "BUY", entry: 2684.9, entry_low: 2684.2, entry_high: 2685.6, stop: 2680.4, tp1: 2691.6, tp2: 2697.2, at_level: false, progressive_stop: 2683.1, rrr: 1.49, rrr_all: { tp1: 1.49, tp2: 2.73 } };
  const engine = { stance: "BUY", trade };
  const fromTrade = { entry: 2684.9, stop: 2680.4, tp1: 2691.6, tp2: 2697.2, at_level: false, progressive_stop: 2683.1, rrr: { tp1: 1.49, tp2: 2.73 } };
  const opposite = { decision: "WAIT", direction: "SHORT", plan: { entry: 2690, stop: 2694, tp1: 2684, tp2: 2680, rrr: { tp1: 1.5, tp2: 2.5 } } };
  // Engine BUY over a strategy WAIT: the lines are the engine's trade, whatever the strategy plan is.
  for (const strategy of [{ decision: "WAIT", plan: null }, opposite, { decision: "WAIT" }, null]) {
    assert.deepEqual(chartPlan(strategy, engine), fromTrade, JSON.stringify(strategy));
  }
  // Even a strategy BUY with its own plan: with the engine on, the engine's trade.
  assert.deepEqual(chartPlan({ decision: "BUY", plan: opposite.plan }, engine), fromTrade);
  // Engine on with no trade (a WAIT, or no trade yet): no lines, as the card shows no ladder.
  assert.equal(chartPlan({ decision: "BUY", plan: opposite.plan }, { stance: "WAIT", trade: null }), null);
  assert.equal(chartPlan({ decision: "WAIT", plan: opposite.plan }, { stance: "BUY", trade: null }), null);
  // Engine off: the strategy plan on its own BUY or SELL, nothing on a WAIT.
  const s = { decision: "SELL", direction: "SHORT", plan: opposite.plan };
  assert.equal(chartPlan(s, null), opposite.plan);
  assert.equal(chartPlan({ ...s, decision: "WAIT" }, null), null);
  assert.equal(chartPlan({ decision: "BUY", plan: null }, null), null);
});
