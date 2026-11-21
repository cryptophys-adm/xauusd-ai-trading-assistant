import test from "node:test";
import assert from "node:assert/strict";

import {
  ADAPTIVE_ENTRY_VERSION,
  CONFIRMATION_RULES,
  CONFIRMATION_STATUSES,
  REASON_CODES,
  RESEARCH_DISCLAIMER,
  confirmAdaptiveEntry,
  evaluateConfirmationAgainstBaseline
} from "../src/adaptive-entry.mjs";

const makeBar = (i, open, high, low, close, forming = false) => ({
  open_time: new Date(1760000000000 + i * 900000).toISOString(),
  close_time: new Date(1760000000000 + (i + 1) * 900000).toISOString(),
  open,
  high,
  low,
  close,
  forming
});

test("Adaptive Entry: forming (unclosed) candles are rejected with forming_bar_rejected", () => {
  const bars = [
    makeBar(0, 2600, 2605, 2595, 2602),
    makeBar(1, 2602, 2606, 2601, 2604),
    makeBar(2, 2604, 2607, 2603, 2605),
    makeBar(3, 2605, 2608, 2604, 2607),
    makeBar(4, 2607, 2615, 2606, 2614, true) // forming = true!
  ];

  const plan = { entry: 2610, stop: 2600, tp1: 2630 };
  const res = confirmAdaptiveEntry(plan, "BUY", bars, 8, null, { now: 1760000000000 + 5 * 900000 });

  assert.equal(res.status, CONFIRMATION_STATUSES.REJECTED);
  assert.equal(res.confirmed, false);
  assert.equal(res.reason, REASON_CODES.FORMING_BAR_REJECTED);
  assert.match(res.disclaimer, /RESEARCH ONLY/);
});

test("Adaptive Entry: stale data fails closed with stale_data_rejected", () => {
  const bars = [
    makeBar(0, 2600, 2605, 2595, 2602),
    makeBar(1, 2602, 2606, 2601, 2604),
    makeBar(2, 2604, 2607, 2603, 2605),
    makeBar(3, 2605, 2608, 2604, 2607),
    makeBar(4, 2607, 2615, 2606, 2614)
  ];

  const plan = { entry: 2610, stop: 2600, tp1: 2630 };
  // now is 3 hours later than last bar close
  const lateNow = 1760000000000 + 5 * 900000 + 3 * 3600 * 1000;
  const res = confirmAdaptiveEntry(plan, "BUY", bars, 8, null, { now: lateNow });

  assert.equal(res.status, CONFIRMATION_STATUSES.REJECTED);
  assert.equal(res.reason, REASON_CODES.STALE_DATA_REJECTED);
});

test("Adaptive Entry: prohibited volatile regime (chaos, extreme stretch) is rejected", () => {
  const bars = [
    makeBar(0, 2600, 2605, 2595, 2602),
    makeBar(1, 2602, 2606, 2601, 2604),
    makeBar(2, 2604, 2607, 2603, 2605),
    makeBar(3, 2605, 2608, 2604, 2607),
    makeBar(4, 2607, 2615, 2606, 2614)
  ];

  const plan = { entry: 2610, stop: 2600, tp1: 2630 };
  const lastCloseMs = 1760000000000 + 5 * 900000;

  // Chaos regime
  const resChaos = confirmAdaptiveEntry(plan, "BUY", bars, 8, { chaos: true, label: "trending" }, { now: lastCloseMs });
  assert.equal(resChaos.reason, REASON_CODES.REGIME_PROHIBITED);

  // Extreme stretch regime
  const resStretch = confirmAdaptiveEntry(plan, "BUY", bars, 8, { stretch_z: 3.5, label: "stretch" }, { now: lastCloseMs });
  assert.equal(resStretch.reason, REASON_CODES.REGIME_PROHIBITED);
});

test("Adaptive Entry: long/short symmetry and clean breakout confirmation", () => {
  const lastCloseMs = 1760000000000 + 5 * 900000;

  // Long confirmation: closed bullish candle holding above entry
  const longBars = [
    makeBar(0, 2600, 2605, 2598, 2602),
    makeBar(1, 2602, 2606, 2601, 2604),
    makeBar(2, 2604, 2607, 2603, 2605),
    makeBar(3, 2605, 2608, 2604, 2607),
    makeBar(4, 2608, 2616, 2607.5, 2614) // Strong bullish close
  ];
  const longPlan = { entry: 2608, stop: 2598, tp1: 2630, at_level: true };
  const longRes = confirmAdaptiveEntry(longPlan, "BUY", longBars, 8, null, { now: lastCloseMs });

  assert.equal(longRes.status, CONFIRMATION_STATUSES.CONFIRMED);
  assert.equal(longRes.confirmed, true);
  assert.equal(longRes.reason, REASON_CODES.CONFIRMED);

  // Short confirmation: closed bearish candle holding below entry
  const shortBars = [
    makeBar(0, 2616, 2618, 2610, 2614),
    makeBar(1, 2614, 2615, 2609, 2612),
    makeBar(2, 2612, 2613, 2608, 2610),
    makeBar(3, 2610, 2611, 2606, 2608),
    makeBar(4, 2608, 2609, 2600, 2602) // Strong bearish close
  ];
  const shortPlan = { entry: 2608, stop: 2618, tp1: 2580, at_level: true };
  const shortRes = confirmAdaptiveEntry(shortPlan, "SELL", shortBars, 8, null, { now: lastCloseMs });

  assert.equal(shortRes.status, CONFIRMATION_STATUSES.CONFIRMED);
  assert.equal(shortRes.confirmed, true);
  assert.equal(shortRes.reason, REASON_CODES.CONFIRMED);
});

test("Adaptive Entry: retest excessive adverse penetration is invalidated", () => {
  const lastCloseMs = 1760000000000 + 5 * 900000;
  // Plan entry is 2610 for a BUY.
  // Last bar penetrates down to 2602 (adverse penetration = 8 = 1.0 ATR > 0.50 max_retest_penetration_atr)
  const bars = [
    makeBar(0, 2605, 2612, 2604, 2608),
    makeBar(1, 2608, 2614, 2607, 2610),
    makeBar(2, 2610, 2615, 2609, 2612),
    makeBar(3, 2612, 2616, 2610, 2614),
    makeBar(4, 2614, 2615, 2602, 2611) // low penetrates down to 2602
  ];

  const plan = { entry: 2610, stop: 2600, tp1: 2630 };
  const res = confirmAdaptiveEntry(plan, "BUY", bars, 8, null, { now: lastCloseMs });

  assert.equal(res.status, CONFIRMATION_STATUSES.REJECTED);
  assert.equal(res.reason, REASON_CODES.RETEST_INVALIDATED);
});

test("Adaptive Entry: evaluateConfirmationAgainstBaseline evaluates avoided losses and missed winners", () => {
  const mockTrades = [
    { id: "t1", r: 1.5, valid: true },
    { id: "t2", r: -1.0, valid: false }, // Avoided loss!
    { id: "t3", r: 2.0, valid: true },
    { id: "t4", r: -1.0, valid: false }, // Avoided loss!
    { id: "t5", r: 1.2, valid: false },  // Missed winner!
    { id: "t6", r: -1.0, valid: true }   // Passed loss
  ];

  const evalRes = evaluateConfirmationAgainstBaseline(mockTrades, (t) => ({
    confirmed: t.valid
  }));

  assert.equal(evalRes.status, "ok");
  assert.equal(evalRes.baseline.count, 6);
  assert.equal(evalRes.filtered.count, 3);
  assert.equal(evalRes.audit.avoided_losses, 2);
  assert.equal(evalRes.audit.missed_winners, 1);
  assert.ok(evalRes.audit.opportunity_capture_ratio > 0);
  assert.ok(evalRes.delta.expectancy_gain > 0);
  assert.match(evalRes.disclaimer, /RESEARCH ONLY/);
});
