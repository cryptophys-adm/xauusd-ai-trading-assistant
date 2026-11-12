import test from "node:test";
import assert from "node:assert/strict";
import { guardrailsFor } from "../src/decision-engine.mjs";

test("adaptive thresholds per TRADING_MODE do not throw", () => {
  const cards = [];
  const quorum = { long_share: 0.4, short_share: 0.1, score: 0.2, bias: "BULLISH" };
  const strategy = null; const inputs = {};
  for (const mode of ["scalp","intraday","swing","unknown"]) {
    const g = guardrailsFor(1, { cards, quorum, strategy, inputs, env: { TRADING_MODE: mode } });
    // market_open, fresh, quorum, no_veto, levels, reward (market_open since 2026-11-09; the confirmation
    // candle is the entry trigger since 2026-11-11, recorded as entry_trigger, not a check)
    assert.ok(Array.isArray(g.checks) && g.checks.length === 6, mode);
    assert.equal(typeof g.entry_trigger?.fired, "boolean", mode);
  }
});
