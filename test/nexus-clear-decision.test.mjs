// The War Room chart's clear-decision check (owner directive 2026-11-11: no setup on the chart unless the decision is
// explicitly clear). PriceChart read the Decision Engine's stance from `global.engine`, which the Global Conclusion never
// carries (the engine is the body's top-level `engine`, useMarket's `engine`), so an engine BUY or SELL never counted.
// lib/entryZone.ts clearDecision reads the strategy's decision and the market's engine; PriceChart uses it for the plan
// lines, the Entry band and the "plan hidden" note.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clearDecision } from "../workers/xauusd-nexus-dashboard/ui/src/lib/entryZone.ts";

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
  assert.match(pc, /const hasClearDecision = clearDecision\(strategy, engine\);/, "the plan lines");
  assert.match(pc, /const clear = clearDecision\(strategy, engine\);/, "the Entry band");
  assert.match(pc, /showPlan && !!strategy\?\.plan && clearDecision\(strategy, engine\)/, "the plan-hidden note");
  // The effects that draw them re-run when the engine's decision changes.
  assert.match(pc, /\}, \[strategy, engine, showZones, showPlan, mark\.show, mark\.dim, mark\.suffix\]\);/);
  assert.match(pc, /\}, \[strategy, engine, showPlan, mark\.show, mark\.dim\]\);/);
});
