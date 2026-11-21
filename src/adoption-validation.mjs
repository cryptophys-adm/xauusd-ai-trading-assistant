// Adoption Validation Gates (shared evaluation protocol, baseline-vs-candidate report,
// validation gates and deterministic aggregation).
//
// Governed by:
//   - AGENTS.md (five-Worker topology, no new Workers, no Pine SSOT edits, English output)
//   - docs/SSOT.md (canonical system architecture and autonomous parity registry)
//   - docs/RFC_STRATEGY_AGENTS.md (strategy agents registry and breakers)
//   - docs/RFC_PLAN_LEARNING.md (plan learner referee, walk-forward, sign test)
//   - docs/BACKLOG.md (items 10, 12, 23, 24)
//   - docs/adoption/ADOPTION_VALIDATION_GATES.md (implementation brief for PR #510)
//
// Cross-PR adoption support:
//   - PR #507: Session Opening Range Breakout (ORB) Strategy Agent
//   - PR #508: Adaptive Entry Confirmation Layer
//   - PR #509: Monte Carlo & Historical Replay Validation Utility
//   - PR #510: Shared Adoption Validation Gates (this module)

import { signTestP, SHADOW_SIGNIFICANCE, holmAdjust } from "./shadow-versions.mjs";
import { sessionAt, TRADING_MODES, toMs } from "./signal-ledger.mjs";

export const ADOPTION_VALIDATION_VERSION = "cryptophys.adoption-validation.v1";

/**
 * Strict evidence taxonomy. Synthetic, simulated, replay and shadow records MUST
 * be distinct from realized production outcomes in schemas and reports.
 */
export const EVIDENCE_TYPES = Object.freeze({
  REALIZED_PRODUCTION: "realized_production",
  HISTORICAL_REPLAY: "historical_replay",
  SHADOW_RUNTIME: "shadow_runtime",
  MONTE_CARLO_SIMULATION: "monte_carlo_simulation"
});

export const EVIDENCE_DISCLAIMERS = Object.freeze({
  [EVIDENCE_TYPES.REALIZED_PRODUCTION]:
    "Realized production execution outcomes from broker/EA/Omega account history.",
  [EVIDENCE_TYPES.HISTORICAL_REPLAY]:
    "Deterministic historical replay over closed price bars. Not realized execution.",
  [EVIDENCE_TYPES.SHADOW_RUNTIME]:
    "Prospective shadow decisions recorded in live runtime without order execution. Not realized execution.",
  [EVIDENCE_TYPES.MONTE_CARLO_SIMULATION]:
    "Synthetic resampled distribution from historical/shadow outcomes. Strictly research/validation; never a trade signal or production arming evidence."
});

/**
 * Canonical gate thresholds drawn from existing SSOT and RFC contracts.
 * Discrepancies between RFC and BACKLOG are explicitly exposed for owner reconciliation.
 */
export const VALIDATION_GATES = Object.freeze({
  STRATEGY_AGENT: Object.freeze({
    min_setups: 30,
    min_mean_r: 0.0,
    description: "Strategy Agent Breaker (RFC_STRATEGY_AGENTS / AGENT_BREAKER): >= 30 resolved setups and non-negative mean R"
  }),
  PATTERN: Object.freeze({
    min_setups: 15,
    min_mean_r: 0.0,
    description: "Pattern Breaker (RFC_STRATEGY_AGENTS / PATTERN_BREAKER): >= 15 resolved setups and non-negative mean R"
  }),
  CONSENSUS_VOICE: Object.freeze({
    record_min_setups: 15,
    voice_min: 0.5,
    voice_max: 1.5,
    description: "Consensus Voice (CONSENSUS_RULES): >= 15 resolved setups to adjust voice weight"
  }),
  OMEGA_PARITY: Object.freeze({
    min_trades: 30,
    max_abs_diff_r: 0.1,
    min_direction_match: 0.90,
    min_p_value: 0.05,
    description: "Omega v4 Parity (PARITY_PASS): >= 30 trades, |diff| <= 0.1R, >= 90% direction match, p >= 0.05"
  }),
  PLAN_LEARNER: Object.freeze({
    rfc: Object.freeze({
      min_setups: 60,
      min_decisive: 20,
      holdout_share: 0.25,
      holdout_min: 15,
      margin_r: 0.05,
      p_value_max: 0.05
    }),
    backlog_item_23: Object.freeze({
      min_setups: 100,
      min_decisive: 30
    }),
    reconciliation_required: true,
    reconciliation_note:
      "Discrepancy flagged: docs/RFC_PLAN_LEARNING.md and PLAN_RULES specify min_setups=60, min_decisive=20. docs/BACKLOG.md item 23 specifies min_setups=100, min_decisive=30. Owner/SSOT reconciliation required for live promotion."
  }),
  SHADOW_CANDIDATE: Object.freeze({
    min_decisive_pairs: 30,
    min_shared_bars: 300,
    description: "Shadow Candidate Referee (BACKLOG item 10): >= 30 decisive pairs or 300 shared bars"
  }),
  ROOM_QUORUM: Object.freeze({
    min_scored_rooms: 300,
    description: "Room Quorum Weighting (SSOT / BACKLOG item 12): >= 300 scored rooms per timeframe"
  })
});

export const GATE_STATUSES = Object.freeze({
  COLLECTING: "collecting",
  FAILED: "failed",
  PASSED_SHADOW_GATE: "passed_shadow_gate"
});

export const DEFAULT_GATE_RULES = Object.freeze({
  min_setups: VALIDATION_GATES.PLAN_LEARNER.rfc.min_setups,
  min_decisive: VALIDATION_GATES.PLAN_LEARNER.rfc.min_decisive,
  holdout_share: VALIDATION_GATES.PLAN_LEARNER.rfc.holdout_share,
  holdout_min: VALIDATION_GATES.PLAN_LEARNER.rfc.holdout_min,
  margin_r: VALIDATION_GATES.PLAN_LEARNER.rfc.margin_r,
  p_value_max: SHADOW_SIGNIFICANCE,
  max_drawdown_tolerance_ratio: 1.25, // candidate max drawdown should not exceed 125% of baseline drawdown
  min_opportunity_capture_rate: 0.20 // candidate filter must preserve at least 20% of baseline volume
});

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r3 = (n) => finite(n) ? Math.round(n * 1000) / 1000 : null;
const iso = (ms) => finite(ms) ? new Date(ms).toISOString() : null;

/**
 * Pure calculation of trade performance metrics from an array of realized or replayed trade results.
 * Each trade should have at least { r: number } (or { r_tp1, r_omega, etc. }).
 */
export function calculateTradeMetrics(trades = [], { rKey = "r" } = {}) {
  const list = (trades || []).filter((x) => x && finite(x[rKey]));
  const rs = list.map((x) => x[rKey]);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r < 0);
  const even = rs.filter((r) => r === 0);

  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  const equity = list.map((x, i) => {
    cum += rs[i];
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
    return {
      id: x.id ?? `trade-${i + 1}`,
      t: x.closed_at ?? x.t ?? null,
      r: r3(cum)
    };
  });

  const sumWin = wins.reduce((a, b) => a + b, 0);
  const sumLoss = -losses.reduce((a, b) => a + b, 0);
  const totalR = rs.reduce((a, b) => a + b, 0);

  return {
    trades: rs.length,
    wins: wins.length,
    losses: losses.length,
    even: even.length,
    win_rate: rs.length ? r3(wins.length / rs.length) : null,
    loss_rate: rs.length ? r3(losses.length / rs.length) : null,
    even_rate: rs.length ? r3(even.length / rs.length) : null,
    avg_win_r: wins.length ? r3(sumWin / wins.length) : null,
    avg_loss_r: losses.length ? r3(-sumLoss / losses.length) : null,
    mean_r: rs.length ? r3(totalR / rs.length) : null,
    expectancy_r: rs.length ? r3(totalR / rs.length) : null,
    total_r: r3(totalR),
    profit_factor: sumLoss > 0 ? r3(sumWin / sumLoss) : (sumWin > 0 ? Infinity : null),
    max_drawdown_r: r3(maxDd),
    equity
  };
}

/**
 * Pure paired difference evaluation between baseline and candidate on identical signals/setups.
 */
export function evaluatePairedDifference(baselineTrades = [], candidateTrades = [], options = {}) {
  const { rKey = "r", tolerance = 1e-9 } = options;
  // Index or ID matching
  const n = Math.min(baselineTrades.length, candidateTrades.length);
  const pairs = [];
  for (let i = 0; i < n; i++) {
    const b = baselineTrades[i];
    const c = candidateTrades[i];
    if (!b || !c) continue;
    const br = finite(b[rKey]) ? b[rKey] : null;
    const cr = finite(c[rKey]) ? c[rKey] : null;
    if (br === null || cr === null) continue;
    const diff = cr - br;
    pairs.push({
      id: c.id ?? b.id ?? `pair-${i + 1}`,
      opened_ms: b.opened_ms ?? c.opened_ms ?? (b.opened_at ? toMs(b.opened_at) : null),
      resolved_ms: b.resolved_ms ?? c.resolved_ms ?? (b.closed_at ? toMs(b.closed_at) : null),
      context: c.context ?? b.context ?? null,
      session: c.session ?? b.session ?? null,
      mode: c.mode ?? b.mode ?? null,
      regime: c.regime ?? b.regime ?? null,
      baseline_r: br,
      candidate_r: cr,
      diff_r: r3(diff),
      candidate_better: diff > tolerance,
      baseline_better: diff < -tolerance,
      tie: Math.abs(diff) <= tolerance
    });
  }

  const decisive = pairs.filter((p) => !p.tie);
  const candidateBetter = pairs.filter((p) => p.candidate_better).length;
  const baselineBetter = pairs.filter((p) => p.baseline_better).length;
  const ties = pairs.filter((p) => p.tie).length;
  const netDiffR = pairs.reduce((sum, p) => sum + (p.candidate_r - p.baseline_r), 0);
  const pValue = signTestP(candidateBetter, baselineBetter);

  return {
    paired_count: pairs.length,
    decisive_pairs: decisive.length,
    candidate_better: candidateBetter,
    baseline_better: baselineBetter,
    ties,
    net_diff_r: r3(netDiffR),
    mean_diff_r: pairs.length ? r3(netDiffR / pairs.length) : null,
    p_value: pValue,
    pairs
  };
}

/**
 * Pure opportunity capture / trade filter analysis.
 * Vital for evaluating candidate entry filters (e.g. Adaptive Entry Confirmation in PR #508)
 * and breakout selectivity (e.g. ORB in PR #507).
 */
export function evaluateOpportunityCapture({
  baselineSignals = [],
  candidateSignals = [],
  filterEvaluations = []
} = {}) {
  const baseCount = Array.isArray(baselineSignals) ? baselineSignals.length : Number(baselineSignals) || 0;
  const candCount = Array.isArray(candidateSignals) ? candidateSignals.length : Number(candidateSignals) || 0;
  const filteredCount = Math.max(0, baseCount - candCount);
  const captureRate = baseCount > 0 ? r3(candCount / baseCount) : null;

  // If detailed filter outcome evaluations are supplied (filtered setups evaluated against baseline result)
  let trueFilters = 0;   // Filtered a setup that would have lost (loss avoided)
  let falseFilters = 0;  // Filtered a setup that would have won (missed winner!)
  let neutralFilters = 0;// Filtered a break-even setup
  let avoidedLossR = 0;
  let missedProfitR = 0;

  for (const ev of filterEvaluations) {
    const r = finite(ev.baseline_r) ? ev.baseline_r : (finite(ev.r) ? ev.r : null);
    if (r === null) continue;
    if (r < 0) {
      trueFilters += 1;
      avoidedLossR += Math.abs(r);
    } else if (r > 0) {
      falseFilters += 1;
      missedProfitR += r;
    } else {
      neutralFilters += 1;
    }
  }

  const decisiveFilters = trueFilters + falseFilters;
  const filterPrecision = decisiveFilters > 0 ? r3(trueFilters / decisiveFilters) : null;
  const netFilterBenefitR = r3(avoidedLossR - missedProfitR);

  return {
    baseline_signals: baseCount,
    candidate_signals: candCount,
    filtered_signals: filteredCount,
    opportunity_capture_rate: captureRate,
    true_filters: trueFilters,
    false_filters: falseFilters,
    neutral_filters: neutralFilters,
    filter_precision: filterPrecision,
    avoided_loss_r: r3(avoidedLossR),
    missed_profit_r: r3(missedProfitR),
    net_filter_benefit_r: netFilterBenefitR
  };
}

/**
 * Segmentation helper: breaks down trade performance by session, trading mode, 1H regime, or agent.
 */
export function segmentMetrics(trades = [], keyExtractor) {
  const groups = {};
  for (const t of trades) {
    const rawKey = typeof keyExtractor === "function" ? keyExtractor(t) : t[keyExtractor];
    const key = rawKey || "unknown";
    (groups[key] ??= []).push(t);
  }

  const result = {};
  for (const key of Object.keys(groups).sort()) {
    result[key] = calculateTradeMetrics(groups[key]);
  }
  return result;
}

/**
 * Partition chronological setups into discovery and holdout segments,
 * extracting independent (non-overlapping) trades to eliminate serial overlap bias.
 * Ensures strict walk-forward discipline without data leakage.
 */
export function partitionChronological(items = [], options = {}) {
  const {
    holdoutShare = VALIDATION_GATES.PLAN_LEARNER.rfc.holdout_share,
    holdoutMin = VALIDATION_GATES.PLAN_LEARNER.rfc.holdout_min,
    minSetups = VALIDATION_GATES.PLAN_LEARNER.rfc.min_setups
  } = options;

  // Strict chronological sort by opened_ms
  const sorted = items
    .filter((x) => x && (finite(x.opened_ms) || (x.opened_at && finite(toMs(x.opened_at)))))
    .map((x) => ({
      ...x,
      opened_ms: finite(x.opened_ms) ? x.opened_ms : toMs(x.opened_at),
      resolved_ms: finite(x.resolved_ms) ? x.resolved_ms : (x.closed_at ? toMs(x.closed_at) : x.opened_ms)
    }))
    .sort((a, b) => a.opened_ms - b.opened_ms);

  // Extract independent trades (opened after the previous resolved)
  const independent = [];
  let freeUntil = -Infinity;
  for (const item of sorted) {
    if (item.opened_ms >= freeUntil) {
      independent.push(item);
      freeUntil = item.resolved_ms ?? item.opened_ms;
    }
  }

  const n = independent.length;
  const holdCount = n >= minSetups ? Math.max(holdoutMin, Math.round(n * holdoutShare)) : 0;
  const discovery = independent.slice(0, n - holdCount);
  const holdout = holdCount > 0 ? independent.slice(-holdCount) : [];

  // Verification of no future leakage: discovery must strictly precede holdout
  const maxDiscoveryMs = discovery.length ? Math.max(...discovery.map((x) => x.opened_ms)) : -Infinity;
  const minHoldoutMs = holdout.length ? Math.min(...holdout.map((x) => x.opened_ms)) : Infinity;
  const leakFree = discovery.length === 0 || holdout.length === 0 || maxDiscoveryMs <= minHoldoutMs;

  return {
    total_items: sorted.length,
    independent_count: n,
    leak_free: leakFree,
    discovery: {
      count: discovery.length,
      start_ms: discovery.length ? discovery[0].opened_ms : null,
      end_ms: discovery.length ? discovery[discovery.length - 1].opened_ms : null,
      items: discovery
    },
    holdout: {
      count: holdout.length,
      start_ms: holdout.length ? holdout[0].opened_ms : null,
      end_ms: holdout.length ? holdout[holdout.length - 1].opened_ms : null,
      items: holdout
    }
  };
}

/**
 * Pure evaluation of validation gates against a generated comparison report.
 */
export function evaluateValidationGates(report, options = {}) {
  const rules = { ...DEFAULT_GATE_RULES, ...(options.rules || {}) };
  const verdicts = {};
  const flags = [];

  const baseline = report.baseline_metrics || {};
  const candidate = report.candidate_metrics || {};
  const paired = report.paired_comparison || {};
  const partition = report.chronological_partition || {};
  const opp = report.opportunity_capture || null;

  // 1. Sample Size Gate
  const indepCount = partition.independent_count ?? paired.paired_count ?? candidate.trades ?? 0;
  const decisiveCount = paired.decisive_pairs ?? (candidate.wins + candidate.losses);
  const samplePass = indepCount >= rules.min_setups && decisiveCount >= rules.min_decisive;
  verdicts.sample_size = {
    pass: samplePass,
    collecting: !samplePass,
    independent_setups: indepCount,
    needed_setups: rules.min_setups,
    decisive_pairs: decisiveCount,
    needed_decisive: rules.min_decisive,
    note: samplePass
      ? `Sample requirement met (${indepCount} >= ${rules.min_setups}, decisive ${decisiveCount} >= ${rules.min_decisive})`
      : `Insufficient sample (${indepCount}/${rules.min_setups} setups, ${decisiveCount}/${rules.min_decisive} decisive); status is collecting`
  };

  // Flag RFC vs Backlog 23 threshold discrepancy
  flags.push(VALIDATION_GATES.PLAN_LEARNER.reconciliation_note);

  // 2. Statistical Significance Gate (Discovery)
  const disc = partition.discovery_comparison || paired;
  const discMeanDiff = disc.mean_diff_r ?? (candidate.mean_r !== null && baseline.mean_r !== null ? r3(candidate.mean_r - baseline.mean_r) : 0);
  const discP = disc.p_value ?? 1.0;
  const sigPass = samplePass && finite(discP) && discP < rules.p_value_max && discMeanDiff > rules.margin_r;
  verdicts.statistical_significance = {
    pass: sigPass,
    p_value: discP,
    threshold: rules.p_value_max,
    mean_diff_r: discMeanDiff,
    margin_r: rules.margin_r,
    note: sigPass
      ? `Statistically significant improvement (p=${discP} < ${rules.p_value_max}, mean diff ${discMeanDiff}R > ${rules.margin_r}R)`
      : `Improvement not statistically significant (p=${discP}, mean diff ${discMeanDiff}R)`
  };

  // 3. Holdout Agreement Gate
  let holdoutPass = false;
  let holdoutNote = "No holdout partition evaluated";
  if (partition.holdout && partition.holdout.count > 0 && partition.holdout_comparison) {
    const holdDiff = partition.holdout_comparison.mean_diff_r ?? 0;
    holdoutPass = samplePass && holdDiff > 0;
    holdoutNote = holdoutPass
      ? `Holdout partition confirms advantage (mean diff ${holdDiff}R > 0)`
      : `Holdout partition failed to confirm advantage (mean diff ${holdDiff}R <= 0)`;
  } else if (!samplePass) {
    holdoutNote = "Holdout pending sufficient sample size";
  }
  verdicts.holdout_agreement = {
    pass: holdoutPass,
    note: holdoutNote
  };

  // 4. Drawdown & Risk Gate
  const baseDd = baseline.max_drawdown_r ?? 0;
  const candDd = candidate.max_drawdown_r ?? 0;
  const maxAllowedDd = baseDd > 0 ? r3(baseDd * rules.max_drawdown_tolerance_ratio) : 5.0;
  const ddPass = candDd <= maxAllowedDd;
  verdicts.drawdown_risk = {
    pass: ddPass,
    baseline_dd_r: baseDd,
    candidate_dd_r: candDd,
    max_allowed_dd_r: maxAllowedDd,
    note: ddPass
      ? `Drawdown within tolerance (${candDd}R <= ${maxAllowedDd}R)`
      : `Excessive drawdown (${candDd}R > ${maxAllowedDd}R)`
  };

  // 5. Opportunity Capture Gate (if filter metrics exist)
  if (opp && opp.opportunity_capture_rate !== null) {
    const capturePass = opp.opportunity_capture_rate >= rules.min_opportunity_capture_rate;
    const precisionPass = opp.filter_precision === null || opp.filter_precision >= 0.50;
    const oppPass = capturePass && precisionPass;
    verdicts.opportunity_capture = {
      pass: oppPass,
      capture_rate: opp.opportunity_capture_rate,
      min_capture_rate: rules.min_opportunity_capture_rate,
      filter_precision: opp.filter_precision,
      net_filter_benefit_r: opp.net_filter_benefit_r,
      note: oppPass
        ? `Filter preserves adequate opportunity (${r3(opp.opportunity_capture_rate * 100)}% capture, precision ${opp.filter_precision})`
        : `Filter rejected too many valid trades or has poor precision (capture ${opp.opportunity_capture_rate}, precision ${opp.filter_precision})`
    };
  }

  // Determine overall gate status
  let overallStatus = GATE_STATUSES.COLLECTING;
  if (!samplePass) {
    overallStatus = GATE_STATUSES.COLLECTING;
  } else if (sigPass && holdoutPass && ddPass && (!verdicts.opportunity_capture || verdicts.opportunity_capture.pass)) {
    overallStatus = GATE_STATUSES.PASSED_SHADOW_GATE;
  } else {
    overallStatus = GATE_STATUSES.FAILED;
  }

  return {
    status: overallStatus,
    verdicts,
    rules_applied: rules,
    reconciliation_flags: flags
  };
}

/**
 * Generate a complete, reproducible baseline-vs-candidate comparison report.
 */
export function generateComparisonReport({
  baseline = { id: "baseline", version: "1.0", label: "Baseline" },
  candidate = { id: "candidate", version: "1.0", label: "Candidate" },
  evidence_type = EVIDENCE_TYPES.SHADOW_RUNTIME,
  window = { start_ms: null, end_ms: null },
  pairs = [],
  filter_evaluations = [],
  costs = { spread_points: 0, slippage_points: 0, model: "zero_cost_unmodeled" },
  missing_data = { missing_bars: 0, stale_bars: 0, gaps: 0 },
  rules = DEFAULT_GATE_RULES,
  now = Date.now()
} = {}) {
  // Validate evidence type
  if (!Object.values(EVIDENCE_TYPES).includes(evidence_type)) {
    throw new Error(`Invalid evidence_type "${evidence_type}". Must be one of: ${Object.values(EVIDENCE_TYPES).join(", ")}`);
  }

  // Unpack baseline and candidate trade arrays
  const baselineTrades = pairs.map((p) => ({
    id: p.id,
    opened_ms: p.opened_ms,
    closed_at: p.closed_at ?? (p.resolved_ms ? iso(p.resolved_ms) : null),
    r: p.baseline_r,
    session: p.session ?? (p.opened_ms ? sessionAt(p.opened_ms) : null),
    mode: p.mode,
    regime: p.regime,
    agent: p.agent
  }));

  const candidateTrades = pairs.map((p) => ({
    id: p.id,
    opened_ms: p.opened_ms,
    closed_at: p.closed_at ?? (p.resolved_ms ? iso(p.resolved_ms) : null),
    r: p.candidate_r,
    session: p.session ?? (p.opened_ms ? sessionAt(p.opened_ms) : null),
    mode: p.mode,
    regime: p.regime,
    agent: p.agent
  }));

  const baseMetrics = calculateTradeMetrics(baselineTrades);
  const candMetrics = calculateTradeMetrics(candidateTrades);
  const pairedDiff = evaluatePairedDifference(baselineTrades, candidateTrades);

  // Chronological partitioning
  const partition = partitionChronological(pairs, {
    minSetups: rules.min_setups,
    holdoutShare: rules.holdout_share,
    holdoutMin: rules.holdout_min
  });

  let discoveryComparison = null;
  let holdoutComparison = null;
  if (partition.discovery.count > 0) {
    const discBase = partition.discovery.items.map((x) => ({ ...x, r: x.baseline_r }));
    const discCand = partition.discovery.items.map((x) => ({ ...x, r: x.candidate_r }));
    discoveryComparison = evaluatePairedDifference(discBase, discCand);
  }
  if (partition.holdout.count > 0) {
    const holdBase = partition.holdout.items.map((x) => ({ ...x, r: x.baseline_r }));
    const holdCand = partition.holdout.items.map((x) => ({ ...x, r: x.candidate_r }));
    holdoutComparison = evaluatePairedDifference(holdBase, holdCand);
  }

  // Opportunity capture
  const oppCapture = evaluateOpportunityCapture({
    baselineSignals: baseMetrics.trades,
    candidateSignals: candMetrics.trades,
    filterEvaluations: filter_evaluations
  });

  // Segmentations
  const segments = {
    by_session: {
      baseline: segmentMetrics(baselineTrades, "session"),
      candidate: segmentMetrics(candidateTrades, "session")
    },
    by_trading_mode: {
      baseline: segmentMetrics(baselineTrades, "mode"),
      candidate: segmentMetrics(candidateTrades, "mode")
    },
    by_regime: {
      baseline: segmentMetrics(baselineTrades, "regime"),
      candidate: segmentMetrics(candidateTrades, "regime")
    },
    by_agent: {
      baseline: segmentMetrics(baselineTrades, "agent"),
      candidate: segmentMetrics(candidateTrades, "agent")
    }
  };

  const report = {
    schema: "cryptophys.adoption-validation.report.v1",
    generated_at: iso(now),
    version: ADOPTION_VALIDATION_VERSION,
    evidence_type,
    evidence_disclaimer: EVIDENCE_DISCLAIMERS[evidence_type],
    provenance: {
      baseline,
      candidate,
      dataset_window: {
        start_ms: window.start_ms ?? (pairs.length ? pairs[0].opened_ms : null),
        end_ms: window.end_ms ?? (pairs.length ? pairs[pairs.length - 1].opened_ms : null),
        start_iso: iso(window.start_ms ?? (pairs.length ? pairs[0].opened_ms : null)),
        end_iso: iso(window.end_ms ?? (pairs.length ? pairs[pairs.length - 1].opened_ms : null))
      }
    },
    costs_treatment: {
      model: costs.model || "zero_cost_unmodeled",
      spread_points: costs.spread_points ?? 0,
      slippage_points: costs.slippage_points ?? 0,
      disclosure: costs.model === "zero_cost_unmodeled"
        ? "Costs omitted: spread, slippage and broker commissions are not modelled in this simulation. Live fill prices may differ."
        : `Modelled costs: ${costs.spread_points} points spread, ${costs.slippage_points} points slippage applied.`
    },
    missing_data_disclosure: {
      missing_bars: missing_data.missing_bars ?? 0,
      stale_bars: missing_data.stale_bars ?? 0,
      gaps: missing_data.gaps ?? 0,
      disclosure: (missing_data.missing_bars > 0 || missing_data.stale_bars > 0 || missing_data.gaps > 0)
        ? `Data limitations: ${missing_data.missing_bars} missing bars, ${missing_data.stale_bars} stale bars, ${missing_data.gaps} gaps observed.`
        : "No missing or stale bars detected in dataset window."
    },
    baseline_metrics: baseMetrics,
    candidate_metrics: candMetrics,
    paired_comparison: pairedDiff,
    opportunity_capture: oppCapture,
    chronological_partition: {
      total_items: partition.total_items,
      independent_count: partition.independent_count,
      leak_free: partition.leak_free,
      discovery_count: partition.discovery.count,
      holdout_count: partition.holdout.count,
      discovery_comparison: discoveryComparison,
      holdout_comparison: holdoutComparison
    },
    segmentation: segments
  };

  // Evaluate gates
  const gateEvaluation = evaluateValidationGates(report, { rules });
  report.validation_gates = gateEvaluation;

  return report;
}

/**
 * Format a comparison report into publication-ready GitHub Flavored Markdown.
 */
export function formatComparisonReportMarkdown(report) {
  const {
    evidence_type,
    evidence_disclaimer,
    provenance,
    costs_treatment,
    missing_data_disclosure,
    baseline_metrics: bm,
    candidate_metrics: cm,
    paired_comparison: pc,
    opportunity_capture: oc,
    chronological_partition: cp,
    validation_gates: vg
  } = report;

  const statusBadge = vg.status === GATE_STATUSES.PASSED_SHADOW_GATE
    ? "PASSED (SHADOW ONLY)"
    : vg.status === GATE_STATUSES.COLLECTING
      ? "COLLECTING (INSUFFICIENT SAMPLE)"
      : "FAILED (NOT BETTER)";

  let md = `# Adoption Validation Report: ${provenance.candidate.label || provenance.candidate.id} vs ${provenance.baseline.label || provenance.baseline.id}\n\n`;

  md += `> [!IMPORTANT]\n`;
  md += `> **Status**: \`${statusBadge}\` | **Evidence Type**: \`${evidence_type}\`\n`;
  md += `> ${evidence_disclaimer}\n`;
  md += `> Promotion remains an owner-controlled decision. This report enables no production changes.\n\n`;

  md += `## 1. Provenance & Dataset Window\n\n`;
  md += `- **Baseline**: \`${provenance.baseline.id}\` (v${provenance.baseline.version})\n`;
  md += `- **Candidate**: \`${provenance.candidate.id}\` (v${provenance.candidate.version})\n`;
  md += `- **Evaluation Window**: ${provenance.dataset_window.start_iso ?? "N/A"} to ${provenance.dataset_window.end_iso ?? "N/A"}\n`;
  md += `- **Cost Treatment**: ${costs_treatment.disclosure}\n`;
  md += `- **Data Disclosures**: ${missing_data_disclosure.disclosure}\n\n`;

  md += `## 2. Global Performance Comparison\n\n`;
  md += `| Metric | Baseline | Candidate | Difference |\n`;
  md += `| :--- | :--- | :--- | :--- |\n`;
  md += `| **Trades (Setups)** | ${bm.trades} | ${cm.trades} | ${cm.trades - bm.trades} |\n`;
  md += `| **Win Rate** | ${bm.win_rate !== null ? (bm.win_rate * 100).toFixed(1) + "%" : "N/A"} | ${cm.win_rate !== null ? (cm.win_rate * 100).toFixed(1) + "%" : "N/A"} | ${bm.win_rate !== null && cm.win_rate !== null ? ((cm.win_rate - bm.win_rate) * 100).toFixed(1) + "%" : "N/A"} |\n`;
  md += `| **Mean R (Expectancy)** | ${bm.mean_r ?? "N/A"}R | ${cm.mean_r ?? "N/A"}R | ${bm.mean_r !== null && cm.mean_r !== null ? r3(cm.mean_r - bm.mean_r) + "R" : "N/A"} |\n`;
  md += `| **Total R** | ${bm.total_r ?? "N/A"}R | ${cm.total_r ?? "N/A"}R | ${bm.total_r !== null && cm.total_r !== null ? r3(cm.total_r - bm.total_r) + "R" : "N/A"} |\n`;
  md += `| **Profit Factor** | ${bm.profit_factor ?? "N/A"} | ${cm.profit_factor ?? "N/A"} | ${bm.profit_factor && cm.profit_factor ? r3(cm.profit_factor - bm.profit_factor) : "N/A"} |\n`;
  md += `| **Max Drawdown (R)** | ${bm.max_drawdown_r ?? "N/A"}R | ${cm.max_drawdown_r ?? "N/A"}R | ${bm.max_drawdown_r !== null && cm.max_drawdown_r !== null ? r3(cm.max_drawdown_r - bm.max_drawdown_r) + "R" : "N/A"} |\n\n`;

  md += `## 3. Paired Difference & Statistical Significance\n\n`;
  md += `- **Paired Trades**: ${pc.paired_count} (Decisive: ${pc.decisive_pairs})\n`;
  md += `- **Candidate Better**: ${pc.candidate_better} | **Baseline Better**: ${pc.baseline_better} | **Ties**: ${pc.ties}\n`;
  md += `- **Net R Difference**: ${pc.net_diff_r}R (Mean: ${pc.mean_diff_r}R)\n`;
  md += `- **Paired Sign Test P-Value**: \`${pc.p_value ?? "N/A"}\` (Alpha = ${vg.rules_applied.p_value_max})\n\n`;

  if (oc) {
    md += `## 4. Opportunity Capture & Filter Analysis\n\n`;
    md += `- **Baseline Signals**: ${oc.baseline_signals} -> **Candidate Signals**: ${oc.candidate_signals}\n`;
    md += `- **Filtered Count**: ${oc.filtered_signals} (Opportunity Capture: ${oc.opportunity_capture_rate !== null ? (oc.opportunity_capture_rate * 100).toFixed(1) + "%" : "N/A"})\n`;
    md += `- **True Filters (Avoided Losses)**: ${oc.true_filters} (+${oc.avoided_loss_r}R)\n`;
    md += `- **False Filters (Missed Winners)**: ${oc.false_filters} (-${oc.missed_profit_r}R)\n`;
    md += `- **Filter Precision**: ${oc.filter_precision !== null ? (oc.filter_precision * 100).toFixed(1) + "%" : "N/A"}\n`;
    md += `- **Net Filter Benefit**: ${oc.net_filter_benefit_r}R\n\n`;
  }

  md += `## 5. Chronological Partition (Leakage-Free Walk-Forward)\n\n`;
  md += `- **Total Independent Trades**: ${cp.independent_count} (Leakage check: \`${cp.leak_free ? "PASSED" : "FAILED"}\`)\n`;
  if (cp.discovery_comparison) {
    md += `- **Discovery (${cp.discovery_count} trades)**: Mean diff = ${cp.discovery_comparison.mean_diff_r}R, p-value = \`${cp.discovery_comparison.p_value}\`\n`;
  }
  if (cp.holdout_comparison) {
    md += `- **Holdout (${cp.holdout_count} trades)**: Mean diff = ${cp.holdout_comparison.mean_diff_r}R, p-value = \`${cp.holdout_comparison.p_value}\`\n`;
  } else {
    md += `- **Holdout**: None evaluated or insufficient sample\n`;
  }
  md += `\n`;

  md += `## 6. Validation Gates Checklist\n\n`;
  for (const [k, v] of Object.entries(vg.verdicts)) {
    const icon = v.pass ? "✅" : (v.collecting ? "⏳" : "❌");
    md += `- ${icon} **${k.replace(/_/g, " ").toUpperCase()}**: ${v.note}\n`;
  }
  md += `\n`;

  if (vg.reconciliation_flags && vg.reconciliation_flags.length) {
    md += `> [!NOTE]\n`;
    md += `> **Threshold Reconciliation Flags**:\n`;
    for (const flag of vg.reconciliation_flags) {
      md += `> - ${flag}\n`;
    }
    md += `\n`;
  }

  md += `## 7. Owner Promotion Criteria\n\n`;
  md += `Candidate strategies cannot be promoted automatically. Promotion requires:\n`;
  md += `1. Validation gate status is \`PASSED (SHADOW ONLY)\`.\n`;
  md += `2. Reconciliation of RFC vs Backlog 23 sample thresholds if applicable.\n`;
  md += `3. Explicit owner instruction and PR merged to \`main\`.\n`;
  md += `4. No direct modification of production flags or live execution settings.\n`;

  return md;
}
