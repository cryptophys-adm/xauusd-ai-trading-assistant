import test from "node:test";
import assert from "node:assert/strict";
import { guardrailsFor } from "../src/decision-engine.mjs";

test("adaptive thresholds per TRADING_MODE do not throw", () => {
  const cards = [];
  const quorum = { long_share: 0.4, short_share: 0.1, score: 0.2, bias: "BULLISH" };
  const strategy = null; const inputs = {};
  for (const mode of ["scalp","intraday","swing","unknown"]) {
    const g = guardrailsFor(1, { cards, quorum, strategy, inputs, env: { TRADING_MODE: mode } });
    assert.ok(Array.isArray(g.checks) && g.checks.length === 6, mode);
  }
});
