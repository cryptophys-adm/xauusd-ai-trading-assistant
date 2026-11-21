import test from "node:test";
import assert from "node:assert/strict";

import {
  MONTE_CARLO_VERSION,
  DEFAULT_CONFIG,
  RESEARCH_DISCLAIMER,
  RESAMPLE_METHODS,
  createRng,
  normalizeTrade,
  filterResolvedTrades,
  calculatePathMetrics,
  computeBaselineMetrics,
  summarizeDistribution,
  resampleIndependent,
  resampleBlockBootstrap,
  resampleStratified,
  runMonteCarlo,
  partitionTrades,
  evaluateWalkForward,
  analyzeSampleSizeSensitivity,
  generateMonteCarloReport
} from "../src/monte-carlo.mjs";

test("Monte Carlo: PRNG is deterministic and seed reproducible", () => {
  const rng1 = createRng(12345);
  const seq1 = [rng1(), rng1(), rng1(), rng1()];

  const rng2 = createRng(12345);
  const seq2 = [rng2(), rng2(), rng2(), rng2()];

  assert.deepEqual(seq1, seq2, "Identical seeds must produce identical random streams");

  const rng3 = createRng(54321);
  const seq3 = [rng3(), rng3(), rng3(), rng3()];
  assert.notDeepEqual(seq1, seq3, "Different seeds must produce different streams");
});

test("Monte Carlo: normalizeTrade handles various record formats and enforces evidence provenance", () => {
  // Signal Ledger format
  const t1 = normalizeTrade({
    id: "sig_1",
    opened_at: "2026-10-01T10:00:00Z",
    closed_at: "2026-10-01T11:00:00Z",
    r_tp1: 1.5,
    status: "closed",
    exit_reason: "tp1",
    side: "BUY"
  });
  assert.equal(t1.r, 1.5);
  assert.equal(t1.status, "closed");
  assert.equal(t1.side, "BUY");
  assert.equal(t1.provenance.is_synthetic, false);
  assert.equal(t1.provenance.is_realized, true);

  // Omega v4 format
  const t2 = normalizeTrade({
    decision_key: "omega_1",
    issued_ms: 1761912000000,
    r_omega4: -1.0,
    omega4_status: "stopped_out"
  });
  assert.equal(t2.r, -1.0);
  assert.equal(t2.status, "stopped_out");

  // Invalid / unresolved trade
  const t3 = normalizeTrade({ id: "sig_no_r", status: "open" });
  assert.equal(t3, null, "Trade without R must normalize to null");
});

test("Monte Carlo: calculatePathMetrics computes cumulative R, max drawdown, and streaks", () => {
  const rValues = [1.0, 1.5, -1.0, -1.0, -0.5, 2.0];
  const metrics = calculatePathMetrics(rValues, { ruinThresholdR: -5, guardrailDrawdownR: 2.0 });

  assert.equal(metrics.count, 6);
  assert.equal(metrics.cumulative_r, 2.0); // 1 + 1.5 - 1 - 1 - 0.5 + 2 = 2
  // Peaks: [1, 2.5, 2.5, 2.5, 2.5, 2.5]
  // CumR:  [1, 2.5, 1.5, 0.5, 0.0, 2.0]
  // DD:    [0,   0, 1.0, 2.0, 2.5, 0.5] -> Max DD = 2.5
  assert.equal(metrics.max_drawdown_r, 2.5);
  assert.equal(metrics.max_losing_streak, 3); // -1, -1, -0.5
  assert.equal(metrics.max_winning_streak, 2); // 1, 1.5
  assert.equal(metrics.guardrail_breached, true);
  assert.equal(metrics.ruin_breached, false);
});

test("Monte Carlo: empty and insufficient samples fail closed cleanly", () => {
  const resEmpty = runMonteCarlo([], { criticalMinSample: 5 });
  assert.equal(resEmpty.status, "insufficient_data");
  assert.equal(resEmpty.trades_count, 0);
  assert.equal(resEmpty.provenance.is_synthetic, true);
  assert.match(resEmpty.provenance.disclaimer, /RESEARCH ONLY/);

  const fewTrades = [{ r: 1.0 }, { r: -1.0 }];
  const resFew = runMonteCarlo(fewTrades, { criticalMinSample: 5 });
  assert.equal(resFew.status, "insufficient_data");
  assert.equal(resFew.trades_count, 2);
});

test("Monte Carlo: runMonteCarlo executes independent, block, and stratified resampling", () => {
  const sampleTrades = [];
  const sessions = ["london", "new_york", "asian"];
  for (let i = 0; i < 35; i++) {
    sampleTrades.push({
      id: `t_${i}`,
      opened_ms: 1761900000000 + i * 3600000,
      closed_ms: 1761900000000 + i * 3600000 + 1800000,
      r: i % 2 === 0 ? 1.2 : -0.8,
      session: sessions[i % 3]
    });
  }

  // Independent
  const resInd = runMonteCarlo(sampleTrades, {
    seed: 42,
    simulations: 200,
    method: "independent"
  });
  assert.equal(resInd.status, "ok");
  assert.equal(resInd.methodology.simulations, 200);
  assert.ok(resInd.distributions.expectancy.mean > 0);
  assert.ok(resInd.distributions.max_drawdown_r.mean > 0);
  assert.equal(resInd.provenance.is_synthetic, true);

  // Block bootstrap
  const resBlock = runMonteCarlo(sampleTrades, {
    seed: 42,
    simulations: 200,
    method: "block_bootstrap",
    blockSize: 3
  });
  assert.equal(resBlock.status, "ok");
  assert.equal(resBlock.methodology.resample_method, "block_bootstrap");

  // Stratified
  const resStrat = runMonteCarlo(sampleTrades, {
    seed: 42,
    simulations: 200,
    method: "stratified",
    stratifyBy: "session"
  });
  assert.equal(resStrat.status, "ok");
  assert.equal(resStrat.methodology.resample_method, "stratified");
});

test("Monte Carlo: partitionTrades splits chronologically without future leakage", () => {
  const trades = [];
  for (let i = 0; i < 40; i++) {
    trades.push({
      id: `trade_${i}`,
      opened_ms: 1000 + i * 100,
      closed_ms: 1050 + i * 100,
      r: 1.0
    });
  }

  const { in_sample, out_of_sample, boundary } = partitionTrades(trades, { holdoutShare: 0.25, minHoldout: 10 });
  assert.equal(in_sample.length, 30);
  assert.equal(out_of_sample.length, 10);
  assert.ok(boundary.strictly_chronological);

  const maxInSample = Math.max(...in_sample.map(t => t.closed_ms));
  const minHoldout = Math.min(...out_of_sample.map(t => t.closed_ms));
  assert.ok(maxInSample <= minHoldout, "In-sample must strictly precede holdout");
});

test("Monte Carlo: analyzeSampleSizeSensitivity assesses degradation across subsets", () => {
  const trades = [];
  for (let i = 0; i < 60; i++) {
    trades.push({
      id: `t_${i}`,
      opened_ms: 1000 + i * 100,
      closed_ms: 1050 + i * 100,
      r: i % 3 === 0 ? -1.0 : 0.8
    });
  }

  const res = analyzeSampleSizeSensitivity(trades, {
    seed: 42,
    sampleSizes: [15, 30, 45],
    simulations: 100
  });

  assert.equal(res.status, "ok");
  assert.ok(Array.isArray(res.sensitivity));
  assert.ok(res.sensitivity.length >= 3);
});

test("Monte Carlo: generateMonteCarloReport produces structured evidence with disclaimers", () => {
  const trades = [];
  for (let i = 0; i < 35; i++) {
    trades.push({
      id: `t_${i}`,
      opened_ms: 1761900000000 + i * 3600000,
      closed_ms: 1761900000000 + i * 3600000 + 1800000,
      r: i % 2 === 0 ? 1.0 : -0.8,
      session: "london"
    });
  }

  const report = generateMonteCarloReport(trades, {
    seed: 99,
    simulations: 150,
    strategyName: "TestStrategy"
  });

  assert.equal(report.version, MONTE_CARLO_VERSION);
  assert.ok(report.baseline_realized);
  assert.ok(report.method_comparison);
  assert.match(report.disclaimer, /RESEARCH ONLY/);
  assert.ok(report.assumptions_and_limitations.non_stationarity);
});
