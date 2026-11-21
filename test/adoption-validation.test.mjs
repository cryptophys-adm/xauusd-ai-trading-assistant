// Adoption Validation Gates test suite.
// Verifies evaluation protocol, baseline-vs-candidate report, validation gates,
// leakage prevention, opportunity capture, and evidence labeling.

import test from "node:test";
import assert from "node:assert/strict";
import {
  ADOPTION_VALIDATION_VERSION,
  EVIDENCE_TYPES,
  EVIDENCE_DISCLAIMERS,
  VALIDATION_GATES,
  GATE_STATUSES,
  DEFAULT_GATE_RULES,
  calculateTradeMetrics,
  evaluatePairedDifference,
  evaluateOpportunityCapture,
  segmentMetrics,
  partitionChronological,
  evaluateValidationGates,
  generateComparisonReport,
  formatComparisonReportMarkdown
} from "../src/adoption-validation.mjs";

test("Adoption Validation: evidence taxonomy & strict disclaimers", () => {
  assert.equal(ADOPTION_VALIDATION_VERSION, "cryptophys.adoption-validation.v1");
  assert.equal(EVIDENCE_TYPES.REALIZED_PRODUCTION, "realized_production");
  assert.equal(EVIDENCE_TYPES.HISTORICAL_REPLAY, "historical_replay");
  assert.equal(EVIDENCE_TYPES.SHADOW_RUNTIME, "shadow_runtime");
  assert.equal(EVIDENCE_TYPES.MONTE_CARLO_SIMULATION, "monte_carlo_simulation");

  // Every evidence type has a distinct disclaimer
  for (const type of Object.values(EVIDENCE_TYPES)) {
    assert.ok(EVIDENCE_DISCLAIMERS[type], `Missing disclaimer for ${type}`);
    assert.ok(typeof EVIDENCE_DISCLAIMERS[type] === "string");
  }

  // Simulation disclaimer explicitly states research-only
  assert.match(
    EVIDENCE_DISCLAIMERS[EVIDENCE_TYPES.MONTE_CARLO_SIMULATION],
    /never a trade signal or production arming evidence/i
  );
  assert.match(
    EVIDENCE_DISCLAIMERS[EVIDENCE_TYPES.SHADOW_RUNTIME],
    /Not realized execution/i
  );

  // Invalid evidence type throws
  assert.throws(() => {
    generateComparisonReport({
      evidence_type: "invalid_unverified_source",
      pairs: []
    });
  }, /Invalid evidence_type/);
});

test("Adoption Validation: canonical gate thresholds & backlog discrepancy flagging", () => {
  // Strategy Agent Breaker
  assert.equal(VALIDATION_GATES.STRATEGY_AGENT.min_setups, 30);
  assert.equal(VALIDATION_GATES.STRATEGY_AGENT.min_mean_r, 0.0);

  // Pattern Breaker
  assert.equal(VALIDATION_GATES.PATTERN.min_setups, 15);
  assert.equal(VALIDATION_GATES.PATTERN.min_mean_r, 0.0);

  // Consensus Voice
  assert.equal(VALIDATION_GATES.CONSENSUS_VOICE.record_min_setups, 15);

  // Omega v4 Parity
  assert.equal(VALIDATION_GATES.OMEGA_PARITY.min_trades, 30);
  assert.equal(VALIDATION_GATES.OMEGA_PARITY.max_abs_diff_r, 0.1);
  assert.equal(VALIDATION_GATES.OMEGA_PARITY.min_direction_match, 0.90);
  assert.equal(VALIDATION_GATES.OMEGA_PARITY.min_p_value, 0.05);

  // Plan Learner: RFC vs Backlog 23 reconciliation flag
  assert.equal(VALIDATION_GATES.PLAN_LEARNER.rfc.min_setups, 60);
  assert.equal(VALIDATION_GATES.PLAN_LEARNER.rfc.min_decisive, 20);
  assert.equal(VALIDATION_GATES.PLAN_LEARNER.backlog_item_23.min_setups, 100);
  assert.equal(VALIDATION_GATES.PLAN_LEARNER.backlog_item_23.min_decisive, 30);
  assert.equal(VALIDATION_GATES.PLAN_LEARNER.reconciliation_required, true);
  assert.match(
    VALIDATION_GATES.PLAN_LEARNER.reconciliation_note,
    /RFC_PLAN_LEARNING\.md.*BACKLOG\.md item 23/
  );
});

test("Adoption Validation: calculateTradeMetrics calculates R aggregation, drawdown and win rates", () => {
  // Empty
  const empty = calculateTradeMetrics([]);
  assert.equal(empty.trades, 0);
  assert.equal(empty.win_rate, null);
  assert.equal(empty.mean_r, null);
  assert.equal(empty.total_r, 0);
  assert.equal(empty.max_drawdown_r, 0);

  // Series with wins, losses, even, and drawdown
  // Cum R: +1.5 -> +2.5 -> +1.5 -> +0.5 -> +2.0 -> +2.0
  // Peak: 1.5, 2.5, 2.5, 2.5, 2.5, 2.5
  // Max DD: peak(2.5) - 0.5 = 2.0
  const trades = [
    { id: "t1", r: 1.5, closed_at: "2026-11-10T10:00:00Z" },
    { id: "t2", r: 1.0, closed_at: "2026-11-10T11:00:00Z" },
    { id: "t3", r: -1.0, closed_at: "2026-11-10T12:00:00Z" },
    { id: "t4", r: -1.0, closed_at: "2026-11-10T13:00:00Z" },
    { id: "t5", r: 1.5, closed_at: "2026-11-10T14:00:00Z" },
    { id: "t6", r: 0.0, closed_at: "2026-11-10T15:00:00Z" }
  ];

  const m = calculateTradeMetrics(trades);
  assert.equal(m.trades, 6);
  assert.equal(m.wins, 3);
  assert.equal(m.losses, 2);
  assert.equal(m.even, 1);
  assert.equal(m.win_rate, 0.5); // 3 / 6
  assert.equal(m.total_r, 2.0);
  assert.equal(m.mean_r, 0.333); // 2.0 / 6
  assert.equal(m.expectancy_r, 0.333);
  assert.equal(m.avg_win_r, 1.333); // 4.0 / 3
  assert.equal(m.avg_loss_r, -1.0); // -2.0 / 2
  assert.equal(m.profit_factor, 2.0); // 4.0 / 2.0
  assert.equal(m.max_drawdown_r, 2.0);
  assert.equal(m.equity.length, 6);
  assert.equal(m.equity[3].r, 0.5);
});

test("Adoption Validation: evaluatePairedDifference computes diffs, decisive pairs, and sign test", () => {
  const base = [
    { id: "p1", r: -1.0 },
    { id: "p2", r: 1.5 },
    { id: "p3", r: 1.0 },
    { id: "p4", r: -1.0 },
    { id: "p5", r: 0.0 }
  ];
  const cand = [
    { id: "p1", r: 1.2 },  // cand better (+2.2)
    { id: "p2", r: 1.5 },  // tie (0)
    { id: "p3", r: 2.0 },  // cand better (+1.0)
    { id: "p4", r: -1.2 }, // base better (-0.2)
    { id: "p5", r: 0.0 }   // tie (0)
  ];

  const res = evaluatePairedDifference(base, cand);
  assert.equal(res.paired_count, 5);
  assert.equal(res.decisive_pairs, 3);
  assert.equal(res.candidate_better, 2);
  assert.equal(res.baseline_better, 1);
  assert.equal(res.ties, 2);
  assert.equal(res.net_diff_r, 3.0); // 2.2 + 0 + 1.0 - 0.2 + 0 = 3.0
  assert.equal(res.mean_diff_r, 0.6); // 3.0 / 5
  assert.ok(typeof res.p_value === "number");
});

test("Adoption Validation: evaluateOpportunityCapture assesses filtering, missed winners and precision", () => {
  // Candidate filters out 4 trades from 10 baseline trades
  // Filtered trades outcomes under baseline:
  // - 3 were losses (true filters: avoided loss of -1.0, -1.2, -0.8 = 3.0R)
  // - 1 was a winner (false filter / missed winner: 2.0R missed)
  const filterEvals = [
    { baseline_r: -1.0 },
    { baseline_r: -1.2 },
    { baseline_r: -0.8 },
    { baseline_r: 2.0 }
  ];

  const opp = evaluateOpportunityCapture({
    baselineSignals: 10,
    candidateSignals: 6,
    filterEvaluations: filterEvals
  });

  assert.equal(opp.baseline_signals, 10);
  assert.equal(opp.candidate_signals, 6);
  assert.equal(opp.filtered_signals, 4);
  assert.equal(opp.opportunity_capture_rate, 0.6); // 6 / 10
  assert.equal(opp.true_filters, 3);
  assert.equal(opp.false_filters, 1);
  assert.equal(opp.filter_precision, 0.75); // 3 / 4
  assert.equal(opp.avoided_loss_r, 3.0);
  assert.equal(opp.missed_profit_r, 2.0);
  assert.equal(opp.net_filter_benefit_r, 1.0); // +3.0 - 2.0 = +1.0R
});

test("Adoption Validation: segmentMetrics segments by session, mode, and regime", () => {
  const trades = [
    { id: "t1", session: "london", mode: "scalp", regime: "low-ranging", r: 1.0 },
    { id: "t2", session: "london", mode: "scalp", regime: "low-ranging", r: 1.5 },
    { id: "t3", session: "new_york", mode: "intraday", regime: "normal-trending", r: -1.0 },
    { id: "t4", session: "new_york", mode: "intraday", regime: "normal-trending", r: 2.0 }
  ];

  const bySession = segmentMetrics(trades, "session");
  assert.equal(bySession.london.trades, 2);
  assert.equal(bySession.london.mean_r, 1.25);
  assert.equal(bySession.new_york.trades, 2);
  assert.equal(bySession.new_york.mean_r, 0.5);

  const byMode = segmentMetrics(trades, "mode");
  assert.equal(byMode.scalp.trades, 2);
  assert.equal(byMode.intraday.trades, 2);
});

test("Adoption Validation: partitionChronological prevents data leakage and extracts independent setups", () => {
  // Overlapping setups:
  // s1: opened 1000, resolved 2000
  // s2: opened 1500 (overlaps s1) -> excluded from independent
  // s3: opened 2500, resolved 3500 (independent)
  // s4: opened 3000 (overlaps s3) -> excluded from independent
  // s5: opened 4000, resolved 5000 (independent)
  const items = [
    { id: "s1", opened_ms: 1000, resolved_ms: 2000, baseline_r: 1.0, candidate_r: 1.2 },
    { id: "s2", opened_ms: 1500, resolved_ms: 2200, baseline_r: -1.0, candidate_r: -0.5 },
    { id: "s3", opened_ms: 2500, resolved_ms: 3500, baseline_r: 1.0, candidate_r: 1.5 },
    { id: "s4", opened_ms: 3000, resolved_ms: 3800, baseline_r: -1.0, candidate_r: -1.0 },
    { id: "s5", opened_ms: 4000, resolved_ms: 5000, baseline_r: 0.5, candidate_r: 1.0 }
  ];

  const part = partitionChronological(items, { minSetups: 2, holdoutShare: 0.33, holdoutMin: 1 });
  assert.equal(part.total_items, 5);
  assert.equal(part.independent_count, 3); // s1, s3, s5
  assert.equal(part.leak_free, true);

  // Discovery has s1, s3; holdout has s5
  assert.equal(part.discovery.count, 2);
  assert.equal(part.holdout.count, 1);
  assert.ok(part.discovery.end_ms <= part.holdout.start_ms);
});

test("Adoption Validation: evaluateValidationGates returns collecting on small sample", () => {
  const report = {
    baseline_metrics: { trades: 10, mean_r: 0.1, max_drawdown_r: 2.0 },
    candidate_metrics: { trades: 10, mean_r: 0.3, max_drawdown_r: 1.5 },
    paired_comparison: { paired_count: 10, decisive_pairs: 8, candidate_better: 6, baseline_better: 2, mean_diff_r: 0.2, p_value: 0.1445 },
    chronological_partition: { independent_count: 10, leak_free: true }
  };

  const evalResult = evaluateValidationGates(report, {
    rules: { min_setups: 60, min_decisive: 20 }
  });

  assert.equal(evalResult.status, GATE_STATUSES.COLLECTING);
  assert.equal(evalResult.verdicts.sample_size.pass, false);
  assert.equal(evalResult.verdicts.sample_size.collecting, true);
  assert.ok(evalResult.reconciliation_flags.length > 0);
});

test("Adoption Validation: evaluateValidationGates returns passed_shadow_gate when all criteria met", () => {
  const report = {
    baseline_metrics: { trades: 80, mean_r: 0.1, max_drawdown_r: 3.0 },
    candidate_metrics: { trades: 80, mean_r: 0.35, max_drawdown_r: 2.5 },
    paired_comparison: {
      paired_count: 80,
      decisive_pairs: 40,
      candidate_better: 30,
      baseline_better: 10,
      mean_diff_r: 0.25,
      p_value: 0.0011 // p < 0.05
    },
    chronological_partition: {
      independent_count: 65,
      leak_free: true,
      discovery_comparison: { mean_diff_r: 0.28, p_value: 0.002 },
      holdout: { count: 16 },
      holdout_comparison: { mean_diff_r: 0.15, p_value: 0.03 }
    },
    opportunity_capture: {
      opportunity_capture_rate: 0.85,
      filter_precision: 0.70,
      net_filter_benefit_r: 5.0
    }
  };

  const evalResult = evaluateValidationGates(report, {
    rules: DEFAULT_GATE_RULES
  });

  assert.equal(evalResult.status, GATE_STATUSES.PASSED_SHADOW_GATE);
  assert.equal(evalResult.verdicts.sample_size.pass, true);
  assert.equal(evalResult.verdicts.statistical_significance.pass, true);
  assert.equal(evalResult.verdicts.holdout_agreement.pass, true);
  assert.equal(evalResult.verdicts.drawdown_risk.pass, true);
  assert.equal(evalResult.verdicts.opportunity_capture.pass, true);
});

test("Adoption Validation: full report generation and markdown formatting", () => {
  // Generate 70 deterministic pairs
  const pairs = [];
  const baseTime = 1731500000000;
  for (let i = 0; i < 70; i++) {
    const opened = baseTime + i * 3600_000;
    const resolved = opened + 1800_000; // 30 min duration -> non-overlapping with next hour
    const bR = (i % 3 === 0) ? -1.0 : (i % 3 === 1 ? 1.5 : 0.5);
    // Candidate improves slightly
    const cR = (i % 3 === 0) ? -0.8 : (i % 3 === 1 ? 1.8 : 0.5);
    pairs.push({
      id: `pair-${i + 1}`,
      opened_ms: opened,
      resolved_ms: resolved,
      baseline_r: bR,
      candidate_r: cR,
      mode: i % 2 === 0 ? "scalp" : "intraday",
      regime: "normal-trending",
      agent: "zone_pullback"
    });
  }

  const report = generateComparisonReport({
    baseline: { id: "zone_pullback", version: "1.0", label: "Zone Pullback" },
    candidate: { id: "orb_breakout", version: "1.0", label: "ORB Breakout" },
    evidence_type: EVIDENCE_TYPES.SHADOW_RUNTIME,
    pairs,
    costs: { spread_points: 0, slippage_points: 0, model: "zero_cost_unmodeled" },
    missing_data: { missing_bars: 0, stale_bars: 0, gaps: 0 }
  });

  assert.equal(report.schema, "cryptophys.adoption-validation.report.v1");
  assert.equal(report.evidence_type, EVIDENCE_TYPES.SHADOW_RUNTIME);
  assert.equal(report.baseline_metrics.trades, 70);
  assert.equal(report.candidate_metrics.trades, 70);
  assert.ok(report.paired_comparison.candidate_better > report.paired_comparison.baseline_better);
  assert.ok(report.chronological_partition.leak_free);
  assert.ok(report.segmentation.by_trading_mode.baseline.scalp);
  assert.ok(report.segmentation.by_trading_mode.candidate.scalp);
  assert.ok(report.segmentation.by_trading_mode.baseline.intraday);
  assert.ok(report.segmentation.by_trading_mode.candidate.intraday);
  assert.ok(report.validation_gates);

  const md = formatComparisonReportMarkdown(report);
  assert.ok(typeof md === "string");
  assert.match(md, /# Adoption Validation Report/);
  assert.match(md, /ORB Breakout.*Zone Pullback/);
  assert.match(md, /> \[!IMPORTANT\]/);
  assert.match(md, /Status.*Evidence Type/);
  assert.match(md, /Global Performance Comparison/);
  assert.match(md, /Paired Difference & Statistical Significance/);
  assert.match(md, /Chronological Partition/);
  assert.match(md, /Validation Gates Checklist/);
  assert.match(md, /Owner Promotion Criteria/);
  assert.match(md, /Threshold Reconciliation Flags/);
});
