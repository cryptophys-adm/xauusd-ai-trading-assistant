// Monte Carlo & Historical Replay validation utility (RFC_STRATEGY_AGENTS, RFC_PLAN_LEARNING,
// docs/adoption/MONTE_CARLO_REPLAY_ENHANCEMENT.md).
//
// Adopted and improved statistical validation for XAUUSD strategy evaluation.
// Research and backtest validation capability ONLY: advisory, pure, and strictly separated from
// production execution. Never a trade signal, never modifies EA/Omega orders, never alters
// strategy parameters or guardrails.
//
// Methodology & Principles:
// 1. Seed-based, reproducible PRNG with versioned methodology.
// 2. Resampling models:
//    - independent: sequence risk resampling of trade outcomes with replacement;
//    - block_bootstrap: circular moving-block bootstrap preserving local serial autocorrelation & clustering;
//    - stratified: session/regime-stratified resampling preserving empirical stratum frequencies.
//    (Candles are never independently shuffled to fake realistic market paths).
// 3. Distribution metrics & quantiles:
//    - expectancy (mean R per trade);
//    - cumulative R;
//    - max drawdown (peak-to-trough drop in R);
//    - losing streaks (consecutive losses);
//    - ruin probability (chance of cumulative R dropping below ruin threshold);
//    - guardrail breach probability (chance of max drawdown exceeding threshold);
//    - sample-size sensitivity.
// 4. Chronological boundaries & walk-forward validation:
//    - In-sample discovery vs out-of-sample holdout strictly separated by timestamp;
//    - Zero future leakage; holdout evaluated against in-sample simulated distributions.
// 5. Strict labeling:
//    - Realized evidence vs synthetic/simulated evidence clearly demarcated;
//    - Research-only disclaimers attached to all outputs.
// 6. Explicit assumptions and limitations documented.

import { sessionAt, toMs } from "./signal-ledger.mjs";

export const MONTE_CARLO_VERSION = "cryptophys.monte-carlo.v1";

export const RESAMPLE_METHODS = Object.freeze(["independent", "block_bootstrap", "stratified"]);

export const DEFAULT_CONFIG = Object.freeze({
  seed: 42,
  simulations: 1000,
  method: "independent",
  blockSize: 5,
  ruinThresholdR: -10,
  guardrailDrawdownR: 5,
  holdoutShare: 0.25,
  minHoldout: 15,
  minSampleWarning: 30,
  criticalMinSample: 5
});

export const RESEARCH_DISCLAIMER =
  "RESEARCH ONLY: Advisory statistical validation. Never a trade signal, parameter update, or execution control.";

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const r4 = (x) => (finite(x) ? Math.round(x * 10000) / 10000 : null);

/**
 * Deterministic 32-bit Pseudo-Random Number Generator (Mulberry32).
 * Fast, robust, and identical across all V8/Node environments.
 */
export function createRng(seed = DEFAULT_CONFIG.seed) {
  let s = (Number(seed) >>> 0) || 1;
  return function rnd() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Normalizes an arbitrary trade or ledger row into a canonical trade outcome record.
 * Handles:
 * - Signal Ledger rows ({ id, opened_at, closed_at, r_tp1, r_tp2, exit_reason, side, status })
 * - Omega4 rows ({ decision_key, r_omega4, omega4_status, omega4_exit, trading_mode, agent, issued_ms })
 * - Plan learning setups ({ setup_key, opened_ms, resolved_ms, results: { e0@s1: { r, s, f } }, context, mode, regime })
 * - Direct trade records ({ id, r, opened_at, closed_at, session, regime, mode, exit_reason })
 */
export function normalizeTrade(raw, { fallbackPolicy = "tp1" } = {}) {
  if (!raw || typeof raw !== "object") return null;

  let id = raw.id ?? raw.setup_key ?? raw.decision_key ?? raw.key ?? null;
  let openedMs = NaN;
  let closedMs = NaN;
  let openedAt = null;
  let closedAt = null;

  if (raw.opened_at) {
    openedAt = String(raw.opened_at);
    openedMs = toMs(raw.opened_at);
  } else if (finite(raw.opened_ms)) {
    openedMs = Number(raw.opened_ms);
    openedAt = new Date(openedMs).toISOString();
  } else if (finite(raw.issued_ms)) {
    openedMs = Number(raw.issued_ms);
    openedAt = new Date(openedMs).toISOString();
  }

  if (raw.closed_at) {
    closedAt = String(raw.closed_at);
    closedMs = toMs(raw.closed_at);
  } else if (finite(raw.closed_ms)) {
    closedMs = Number(raw.closed_ms);
    closedAt = new Date(closedMs).toISOString();
  } else if (finite(raw.resolved_ms)) {
    closedMs = Number(raw.resolved_ms);
    closedAt = new Date(closedMs).toISOString();
  } else if (finite(raw.omega4_closed_at)) {
    closedMs = toMs(raw.omega4_closed_at);
    closedAt = String(raw.omega4_closed_at);
  }

  // Determine R
  let r = null;
  if (finite(raw.r)) {
    r = Number(raw.r);
  } else if (finite(raw.r_omega4)) {
    r = Number(raw.r_omega4);
  } else if (fallbackPolicy === "tp2" && finite(raw.r_tp2)) {
    r = Number(raw.r_tp2);
  } else if (finite(raw.r_tp1)) {
    r = Number(raw.r_tp1);
  } else if (raw.results) {
    // Check plan learning results object
    const arm = raw.results["e0@s1"] ?? Object.values(raw.results)[0];
    if (finite(arm?.r)) r = Number(arm.r);
  }

  if (!finite(r)) return null;

  // Determine status & exit reason
  const status = raw.status ?? raw.omega4_status ?? (finite(closedMs) ? "closed" : "unknown");
  const exitReason = raw.exit_reason ?? raw.omega4_exit ?? raw.results?.["e0@s1"]?.s ?? null;
  const side = raw.side === "BUY" || raw.side === "SELL" ? raw.side : null;

  // Derive session and regime
  const session = raw.session ?? (finite(openedMs) ? sessionAt(openedMs) : "unknown");
  const regime = raw.regime ?? (typeof raw.context === "string" ? raw.context.split("|")[1] ?? null : null);
  const mode = raw.mode ?? raw.trading_mode ?? (typeof raw.context === "string" ? raw.context.split("|")[0] ?? null : null);

  return {
    id: String(id ?? `trade_${openedMs || Date.now()}`),
    opened_at: openedAt,
    closed_at: closedAt,
    opened_ms: finite(openedMs) ? openedMs : null,
    closed_ms: finite(closedMs) ? closedMs : (finite(openedMs) ? openedMs : null),
    r: r3(r),
    status,
    exit_reason: exitReason,
    side,
    session,
    regime,
    mode,
    provenance: Object.freeze({
      evidence_type: "realized_ledger",
      is_synthetic: false,
      is_realized: true
    })
  };
}

/**
 * Filter and sort a list of raw trades into valid resolved trades.
 * Discards unclosed, invalid, or missing-R records.
 */
export function filterResolvedTrades(trades, options = {}) {
  if (!Array.isArray(trades)) return [];
  const normalized = [];
  for (const t of trades) {
    const item = normalizeTrade(t, options);
    if (item && finite(item.r)) {
      normalized.push(item);
    }
  }
  // Sort chronologically by close time (fallback to open time)
  normalized.sort((a, b) => {
    const ta = a.closed_ms ?? a.opened_ms ?? 0;
    const tb = b.closed_ms ?? b.opened_ms ?? 0;
    return ta - tb;
  });
  return normalized;
}

/**
 * Pure: Calculates peak-to-trough max drawdown, streaks, and cumulative trajectory on an array of R values.
 */
export function calculatePathMetrics(rValues, { ruinThresholdR = DEFAULT_CONFIG.ruinThresholdR, guardrailDrawdownR = DEFAULT_CONFIG.guardrailDrawdownR } = {}) {
  const n = rValues.length;
  if (!n) {
    return {
      count: 0,
      expectancy: null,
      cumulative_r: 0,
      max_drawdown_r: 0,
      max_losing_streak: 0,
      max_winning_streak: 0,
      ruin_breached: false,
      guardrail_breached: false
    };
  }

  let cumR = 0;
  let peak = 0;
  let maxDD = 0;
  let currentLoseStreak = 0;
  let maxLoseStreak = 0;
  let currentWinStreak = 0;
  let maxWinStreak = 0;
  let ruinBreached = false;
  const ruinLevel = -Math.abs(ruinThresholdR);

  for (let i = 0; i < n; i++) {
    const r = rValues[i];
    cumR += r;

    if (cumR > peak) {
      peak = cumR;
    }
    const dd = peak - cumR;
    if (dd > maxDD) {
      maxDD = dd;
    }

    if (cumR <= ruinLevel) {
      ruinBreached = true;
    }

    if (r < 0) {
      currentLoseStreak += 1;
      currentWinStreak = 0;
      if (currentLoseStreak > maxLoseStreak) maxLoseStreak = currentLoseStreak;
    } else if (r > 0) {
      currentWinStreak += 1;
      currentLoseStreak = 0;
      if (currentWinStreak > maxWinStreak) maxWinStreak = currentWinStreak;
    } else {
      currentLoseStreak = 0;
      currentWinStreak = 0;
    }
  }

  return {
    count: n,
    expectancy: r4(cumR / n),
    cumulative_r: r3(cumR),
    max_drawdown_r: r3(maxDD),
    max_losing_streak: maxLoseStreak,
    max_winning_streak: maxWinStreak,
    ruin_breached: ruinBreached,
    guardrail_breached: maxDD >= guardrailDrawdownR
  };
}

/**
 * Pure: computes baseline realized metrics from an array of resolved trades.
 */
export function computeBaselineMetrics(trades, config = {}) {
  const resolved = filterResolvedTrades(trades, config);
  const n = resolved.length;
  if (!n) {
    return {
      trades_count: 0,
      expectancy: null,
      cumulative_r: 0,
      win_rate: null,
      loss_rate: null,
      scratch_rate: null,
      profit_factor: null,
      max_drawdown_r: 0,
      max_losing_streak: 0,
      max_winning_streak: 0,
      ruin_breached: false,
      guardrail_breached: false,
      provenance: Object.freeze({
        evidence_type: "realized_ledger",
        is_synthetic: false,
        is_realized: true
      })
    };
  }

  const rValues = resolved.map((t) => t.r);
  const path = calculatePathMetrics(rValues, config);

  const wins = rValues.filter((r) => r > 0);
  const losses = rValues.filter((r) => r < 0);
  const scratches = rValues.filter((r) => r === 0);

  const sumWins = wins.reduce((a, b) => a + b, 0);
  const sumLosses = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = sumLosses > 0 ? r3(sumWins / sumLosses) : sumWins > 0 ? Infinity : 1;

  return {
    trades_count: n,
    expectancy: path.expectancy,
    cumulative_r: path.cumulative_r,
    win_rate: r3(wins.length / n),
    loss_rate: r3(losses.length / n),
    scratch_rate: r3(scratches.length / n),
    profit_factor: profitFactor,
    max_drawdown_r: path.max_drawdown_r,
    max_losing_streak: path.max_losing_streak,
    max_winning_streak: path.max_winning_streak,
    ruin_breached: path.ruin_breached,
    guardrail_breached: path.guardrail_breached,
    provenance: Object.freeze({
      evidence_type: "realized_ledger",
      is_synthetic: false,
      is_realized: true
    })
  };
}

/**
 * Pure: Summarizes a distribution of values into quantiles and moments.
 */
export function summarizeDistribution(values) {
  const n = values?.length ?? 0;
  if (!n) {
    return {
      count: 0,
      mean: null,
      std: null,
      min: null,
      p5: null,
      p10: null,
      p25: null,
      p50: null,
      p75: null,
      p90: null,
      p95: null,
      max: null
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;

  let variance = 0;
  if (n > 1) {
    variance = sorted.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (n - 1);
  }

  const percentile = (p) => {
    if (n === 1) return sorted[0];
    const idx = (n - 1) * p;
    const low = Math.floor(idx);
    const high = Math.ceil(idx);
    const weight = idx - low;
    return sorted[low] * (1 - weight) + sorted[high] * weight;
  };

  return {
    count: n,
    mean: r4(mean),
    std: r4(Math.sqrt(variance)),
    min: r3(sorted[0]),
    p5: r3(percentile(0.05)),
    p10: r3(percentile(0.1)),
    p25: r3(percentile(0.25)),
    p50: r3(percentile(0.5)),
    p75: r3(percentile(0.75)),
    p90: r3(percentile(0.9)),
    p95: r3(percentile(0.95)),
    max: r3(sorted[n - 1])
  };
}

/**
 * Resamples trade outcomes independently with replacement.
 */
export function resampleIndependent(rValues, count, rnd) {
  const n = rValues.length;
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(rnd() * n);
    out[i] = rValues[idx];
  }
  return out;
}

/**
 * Resamples trade outcomes using a circular moving-block bootstrap.
 * Preserves local serial dependence up to `blockSize`.
 */
export function resampleBlockBootstrap(rValues, count, blockSize, rnd) {
  const n = rValues.length;
  if (n <= 1 || blockSize <= 1) {
    return resampleIndependent(rValues, count, rnd);
  }
  const effBlock = Math.min(blockSize, n);
  const out = [];
  while (out.length < count) {
    const start = Math.floor(rnd() * n);
    for (let k = 0; k < effBlock && out.length < count; k++) {
      const idx = (start + k) % n;
      out.push(rValues[idx]);
    }
  }
  return out;
}

/**
 * Resamples trade outcomes stratified by session or regime.
 * Preserves the empirical proportions of each stratum and samples with replacement within each stratum.
 */
export function resampleStratified(trades, count, rnd, { stratifyBy = "session" } = {}) {
  const n = trades.length;
  if (n <= 1) {
    return trades.map((t) => t.r);
  }

  // Partition into strata
  const strata = new Map();
  for (let i = 0; i < n; i++) {
    const t = trades[i];
    let key = "default";
    if (stratifyBy === "session") {
      key = t.session || "unknown";
    } else if (stratifyBy === "regime") {
      key = t.regime || "unknown";
    } else if (stratifyBy === "context") {
      key = `${t.mode || "none"}|${t.regime || "unknown"}`;
    }
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(t.r);
  }

  // If only 1 stratum exists, fall back to independent resampling
  if (strata.size <= 1) {
    return resampleIndependent(trades.map((t) => t.r), count, rnd);
  }

  // Cumulative distribution of strata based on empirical trade frequencies
  const strataKeys = Array.from(strata.keys());
  const strataWeights = strataKeys.map((k) => strata.get(k).length / n);
  const cdf = [];
  let cum = 0;
  for (let i = 0; i < strataWeights.length; i++) {
    cum += strataWeights[i];
    cdf.push(cum);
  }

  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const rVal = rnd();
    let sIdx = 0;
    while (sIdx < cdf.length - 1 && rVal > cdf[sIdx]) {
      sIdx++;
    }
    const pool = strata.get(strataKeys[sIdx]);
    const tradeIdx = Math.floor(rnd() * pool.length);
    out[i] = pool[tradeIdx];
  }
  return out;
}

/**
 * Core Monte Carlo Simulation Runner.
 * Executes reproducible simulation across paths and computes distributions.
 */
export function runMonteCarlo(trades, options = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...options };
  const resolved = filterResolvedTrades(trades, cfg);
  const n = resolved.length;

  if (n < cfg.criticalMinSample) {
    return {
      status: "insufficient_data",
      reason: `Need at least ${cfg.criticalMinSample} resolved trades; provided ${n}.`,
      trades_count: n,
      simulations: cfg.simulations,
      method: cfg.method,
      provenance: Object.freeze({
        evidence_type: "synthetic_simulation",
        is_synthetic: true,
        is_realized: false,
        disclaimer: RESEARCH_DISCLAIMER
      })
    };
  }

  const rnd = createRng(cfg.seed);
  const rValues = resolved.map((t) => t.r);
  const pathLength = cfg.pathLength || n;

  const expectancies = new Array(cfg.simulations);
  const cumulativeRs = new Array(cfg.simulations);
  const maxDrawdowns = new Array(cfg.simulations);
  const maxLosingStreaks = new Array(cfg.simulations);
  let ruinBreachCount = 0;
  let guardrailBreachCount = 0;

  for (let b = 0; b < cfg.simulations; b++) {
    let sampleR;
    if (cfg.method === "block_bootstrap") {
      sampleR = resampleBlockBootstrap(rValues, pathLength, cfg.blockSize, rnd);
    } else if (cfg.method === "stratified") {
      sampleR = resampleStratified(resolved, pathLength, rnd, cfg);
    } else {
      sampleR = resampleIndependent(rValues, pathLength, rnd);
    }

    const path = calculatePathMetrics(sampleR, {
      ruinThresholdR: cfg.ruinThresholdR,
      guardrailDrawdownR: cfg.guardrailDrawdownR
    });

    expectancies[b] = path.expectancy;
    cumulativeRs[b] = path.cumulative_r;
    maxDrawdowns[b] = path.max_drawdown_r;
    maxLosingStreaks[b] = path.max_losing_streak;
    if (path.ruin_breached) ruinBreachCount++;
    if (path.guardrail_breached) guardrailBreachCount++;
  }

  const isSmallSample = n < cfg.minSampleWarning;

  return {
    status: "ok",
    methodology: Object.freeze({
      version: MONTE_CARLO_VERSION,
      seed: cfg.seed,
      simulations: cfg.simulations,
      resample_method: cfg.method,
      block_size: cfg.method === "block_bootstrap" ? cfg.blockSize : null,
      path_length: pathLength,
      ruin_threshold_r: cfg.ruinThresholdR,
      guardrail_drawdown_r: cfg.guardrailDrawdownR
    }),
    sample_summary: {
      trades_count: n,
      small_sample_warning: isSmallSample,
      warning_message: isSmallSample
        ? `Sample size (N=${n}) is below recommended threshold (${cfg.minSampleWarning}). Estimates subject to wide error bounds.`
        : null
    },
    distributions: {
      expectancy: summarizeDistribution(expectancies),
      cumulative_r: summarizeDistribution(cumulativeRs),
      max_drawdown_r: summarizeDistribution(maxDrawdowns),
      max_losing_streak: summarizeDistribution(maxLosingStreaks)
    },
    probabilities: {
      ruin_probability: r4(ruinBreachCount / cfg.simulations),
      guardrail_breach_probability: r4(guardrailBreachCount / cfg.simulations)
    },
    provenance: Object.freeze({
      evidence_type: "synthetic_simulation",
      is_synthetic: true,
      is_realized: false,
      disclaimer: RESEARCH_DISCLAIMER
    })
  };
}

/**
 * Analyzes sensitivity of Monte Carlo distributions across varying sample sizes / trade horizons.
 */
export function analyzeSampleSizeSensitivity(trades, options = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...options };
  const resolved = filterResolvedTrades(trades, cfg);
  const n = resolved.length;

  if (n < cfg.criticalMinSample) {
    return { status: "insufficient_data", sample_sizes: [] };
  }

  // Derive sensible evaluation horizons (e.g. N/4, N/2, N, 2N)
  const defaultSizes = [
    Math.max(5, Math.floor(n * 0.25)),
    Math.max(10, Math.floor(n * 0.5)),
    n,
    n * 2
  ];
  const uniqueSizes = Array.from(new Set(cfg.customSampleSizes || defaultSizes)).sort((a, b) => a - b);

  const sensitivity = uniqueSizes.map((size) => {
    const mc = runMonteCarlo(resolved, { ...cfg, pathLength: size });
    if (mc.status !== "ok") return { sample_size: size, status: mc.status };
    return {
      sample_size: size,
      expectancy: {
        mean: mc.distributions.expectancy.mean,
        p5: mc.distributions.expectancy.p5,
        p50: mc.distributions.expectancy.p50,
        p95: mc.distributions.expectancy.p95,
        std: mc.distributions.expectancy.std
      },
      cumulative_r: {
        mean: mc.distributions.cumulative_r.mean,
        p5: mc.distributions.cumulative_r.p5,
        p50: mc.distributions.cumulative_r.p50,
        p95: mc.distributions.cumulative_r.p95
      },
      max_drawdown_r: {
        mean: mc.distributions.max_drawdown_r.mean,
        p50: mc.distributions.max_drawdown_r.p50,
        p95: mc.distributions.max_drawdown_r.p95
      },
      ruin_probability: mc.probabilities.ruin_probability,
      guardrail_breach_probability: mc.probabilities.guardrail_breach_probability
    };
  });

  return {
    status: "ok",
    sensitivity,
    provenance: Object.freeze({
      evidence_type: "synthetic_simulation",
      is_synthetic: true,
      is_realized: false,
      disclaimer: RESEARCH_DISCLAIMER
    })
  };
}

/**
 * Chronological partitioning into In-Sample (discovery) and Out-Of-Sample (holdout).
 * Guarantees ZERO future leakage: trades are strictly sequenced by close/open timestamps.
 */
export function partitionTrades(trades, options = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...options };
  const resolved = filterResolvedTrades(trades, cfg);
  const n = resolved.length;

  if (n === 0) {
    return { in_sample: [], out_of_sample: [], split_ms: null, valid: false };
  }

  let cutIndex = -1;
  if (finite(cfg.splitTimestamp)) {
    cutIndex = resolved.findIndex((t) => (t.closed_ms ?? t.opened_ms ?? 0) >= cfg.splitTimestamp);
    if (cutIndex < 0) cutIndex = n;
  } else {
    const holdCount = Math.max(
      Math.min(cfg.minHoldout, Math.floor(n * 0.5)),
      Math.round(n * cfg.holdoutShare)
    );
    cutIndex = Math.max(0, n - holdCount);
  }

  const inSample = resolved.slice(0, cutIndex);
  const outOfSample = resolved.slice(cutIndex);

  const lastInMs = inSample.length ? (inSample[inSample.length - 1].closed_ms ?? inSample[inSample.length - 1].opened_ms) : null;
  const firstOutMs = outOfSample.length ? (outOfSample[0].closed_ms ?? outOfSample[0].opened_ms) : null;

  const strictlyChronological =
    inSample.length === 0 || outOfSample.length === 0 || (lastInMs !== null && firstOutMs !== null && lastInMs <= firstOutMs);

  return {
    in_sample: inSample,
    out_of_sample: outOfSample,
    in_sample_count: inSample.length,
    out_of_sample_count: outOfSample.length,
    boundary: {
      last_in_sample_ms: lastInMs,
      first_out_of_sample_ms: firstOutMs,
      split_iso: firstOutMs ? new Date(firstOutMs).toISOString() : null,
      strictly_chronological: strictlyChronological
    },
    valid: strictlyChronological && inSample.length > 0
  };
}

/**
 * Walk-Forward Validation Engine:
 * Compares out-of-sample realized metrics against in-sample Monte Carlo simulated distribution bounds.
 */
export function evaluateWalkForward(trades, options = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...options };
  const partition = partitionTrades(trades, cfg);

  if (!partition.valid || partition.in_sample.length < cfg.criticalMinSample) {
    return {
      status: "insufficient_data",
      reason: `Insufficient trades to split chronologically into valid in-sample and holdout partitions (in-sample: ${partition.in_sample.length}, holdout: ${partition.out_of_sample.length}).`,
      partition
    };
  }

  // In-sample baseline & Monte Carlo
  const inBaseline = computeBaselineMetrics(partition.in_sample, cfg);
  const inMonteCarlo = runMonteCarlo(partition.in_sample, cfg);

  // Out-of-sample baseline & Monte Carlo
  const outBaseline = computeBaselineMetrics(partition.out_of_sample, cfg);
  const outMonteCarlo = partition.out_of_sample.length >= cfg.criticalMinSample
    ? runMonteCarlo(partition.out_of_sample, cfg)
    : null;

  // Consistency checks: does holdout realized performance fall within in-sample MC envelope?
  const inExpDist = inMonteCarlo.distributions.expectancy;
  const inDdDist = inMonteCarlo.distributions.max_drawdown_r;

  const expectancyWithinCi =
    outBaseline.expectancy !== null && inExpDist.p5 !== null && inExpDist.p95 !== null
      ? outBaseline.expectancy >= inExpDist.p5 && outBaseline.expectancy <= inExpDist.p95
      : null;

  const expectancyDegraded =
    outBaseline.expectancy !== null && inExpDist.p5 !== null
      ? outBaseline.expectancy < inExpDist.p5
      : null;

  const drawdownExceedsInSampleTail =
    outBaseline.max_drawdown_r !== null && inDdDist.p95 !== null
      ? outBaseline.max_drawdown_r > inDdDist.p95
      : null;

  let verdict = "consistent";
  if (expectancyDegraded || drawdownExceedsInSampleTail) {
    verdict = "drift_detected";
  } else if (partition.out_of_sample.length < cfg.minHoldout) {
    verdict = "collecting";
  }

  return {
    status: "ok",
    verdict,
    partition: {
      in_sample_trades: partition.in_sample.length,
      out_of_sample_trades: partition.out_of_sample.length,
      boundary: partition.boundary
    },
    in_sample: {
      realized: inBaseline,
      monte_carlo: inMonteCarlo
    },
    out_of_sample: {
      realized: outBaseline,
      monte_carlo: outMonteCarlo
    },
    walk_forward_checks: {
      expectancy_within_ci: expectancyWithinCi,
      expectancy_degraded: expectancyDegraded,
      drawdown_exceeds_tail: drawdownExceedsInSampleTail
    },
    provenance: Object.freeze({
      evidence_type: "walk_forward_evaluation",
      is_synthetic: true,
      is_realized: false,
      disclaimer: RESEARCH_DISCLAIMER
    })
  };
}

/**
 * Generates the full comparative Monte Carlo research validation report.
 * Compares all 3 resampling methodologies, computes baseline, sample sensitivity,
 * walk-forward partition, and documents assumptions and limitations.
 */
export function generateMonteCarloReport(trades, options = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...options };
  const rawList = Array.isArray(trades) ? trades : [];
  const resolved = filterResolvedTrades(rawList, cfg);

  const baseline = computeBaselineMetrics(resolved, cfg);

  // Multi-method comparisons (same seed for fair comparison)
  const independentMC = runMonteCarlo(resolved, { ...cfg, method: "independent" });
  const blockMC = runMonteCarlo(resolved, { ...cfg, method: "block_bootstrap" });
  const stratifiedMC = runMonteCarlo(resolved, { ...cfg, method: "stratified" });

  const methodComparison = {
    independent: independentMC.status === "ok" ? {
      expectancy_mean: independentMC.distributions.expectancy.mean,
      expectancy_p5: independentMC.distributions.expectancy.p5,
      expectancy_p95: independentMC.distributions.expectancy.p95,
      max_drawdown_p95: independentMC.distributions.max_drawdown_r.p95,
      max_losing_streak_p95: independentMC.distributions.max_losing_streak.p95,
      ruin_probability: independentMC.probabilities.ruin_probability,
      guardrail_breach_probability: independentMC.probabilities.guardrail_breach_probability
    } : null,
    block_bootstrap: blockMC.status === "ok" ? {
      block_size: cfg.blockSize,
      expectancy_mean: blockMC.distributions.expectancy.mean,
      expectancy_p5: blockMC.distributions.expectancy.p5,
      expectancy_p95: blockMC.distributions.expectancy.p95,
      max_drawdown_p95: blockMC.distributions.max_drawdown_r.p95,
      max_losing_streak_p95: blockMC.distributions.max_losing_streak.p95,
      ruin_probability: blockMC.probabilities.ruin_probability,
      guardrail_breach_probability: blockMC.probabilities.guardrail_breach_probability
    } : null,
    stratified: stratifiedMC.status === "ok" ? {
      expectancy_mean: stratifiedMC.distributions.expectancy.mean,
      expectancy_p5: stratifiedMC.distributions.expectancy.p5,
      expectancy_p95: stratifiedMC.distributions.expectancy.p95,
      max_drawdown_p95: stratifiedMC.distributions.max_drawdown_r.p95,
      max_losing_streak_p95: stratifiedMC.distributions.max_losing_streak.p95,
      ruin_probability: stratifiedMC.probabilities.ruin_probability,
      guardrail_breach_probability: stratifiedMC.probabilities.guardrail_breach_probability
    } : null
  };

  const sensitivity = analyzeSampleSizeSensitivity(resolved, cfg);
  const walkForward = evaluateWalkForward(resolved, cfg);

  // Time range
  const timeRange = resolved.length ? {
    start_iso: resolved[0].opened_at ?? (resolved[0].opened_ms ? new Date(resolved[0].opened_ms).toISOString() : null),
    end_iso: resolved[resolved.length - 1].closed_at ?? (resolved[resolved.length - 1].closed_ms ? new Date(resolved[resolved.length - 1].closed_ms).toISOString() : null)
  } : { start_iso: null, end_iso: null };

  return {
    version: MONTE_CARLO_VERSION,
    generated_at: new Date().toISOString(),
    input_provenance: {
      total_raw_records: rawList.length,
      valid_resolved_trades: resolved.length,
      omitted_unresolved: rawList.length - resolved.length,
      time_range: timeRange
    },
    baseline_realized: baseline,
    method_comparison: methodComparison,
    resampling_details: {
      independent: independentMC,
      block_bootstrap: blockMC,
      stratified: stratifiedMC
    },
    sample_size_sensitivity: sensitivity,
    walk_forward: walkForward,
    assumptions_and_limitations: Object.freeze({
      non_stationarity:
        "Assumes historical trade outcome distribution is stationary over the tested window. Structural market shifts, macroeconomic regime changes, and central bank surprises can invalidate past distributions.",
      serial_clustering:
        "Block bootstrap models local autocorrelation and volatility clustering up to block size, but longer-term clustering or persistent multi-week drawdowns require extended horizon monitoring.",
      regime_stratification:
        "Stratification conditions on observed session and regime labels; unobserved regimes or misclassified sessions introduce residual estimation noise.",
      execution_and_slippage:
        "Outcomes reflect the source model assumptions (e.g. 0.2 spread in Omega simulation; conservative stop priority on ambiguous bars). Variable broker slippage, weekend swap rates, and execution queue latency are omitted unless recorded in broker bridge execution records.",
      sample_size_sensitivity:
        resolved.length < cfg.minSampleWarning
          ? `Sample size N=${resolved.length} is small (< ${cfg.minSampleWarning}). Quantile estimates, particularly ruin and tail drawdown probabilities, carry wide confidence bounds.`
          : `Sample size N=${resolved.length} satisfies minimum validation criteria.`
    }),
    disclaimer: RESEARCH_DISCLAIMER
  };
}
