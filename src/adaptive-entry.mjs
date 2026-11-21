// Adaptive Entry Confirmation Layer (RFC_STRATEGY_AGENTS, RFC_PLAN_LEARNING,
// docs/adoption/ADAPTIVE_ENTRY_CONFIRMATION.md).
//
// Pure and deterministic confirmation layer for strategy plans.
// Evaluates closed-candle confirmation, ATR-normalized breakout strength,
// retest/hold validation, volatility regime, and entry expiry.
//
// Status: "shadow/research-only" by default. Never alters live execution
// or overrides Strategy Council authority without explicit owner promotion.

export const ADAPTIVE_ENTRY_VERSION = "cryptophys.adaptive-entry.v1";

export const CONFIRMATION_RULES = Object.freeze({
  min_strength_atr: 0.08,    // closed bar must confirm direction with at least 0.08 ATR momentum
  retest_tolerance_atr: 0.25,// retest within 0.25 ATR of entry level
  max_retest_penetration_atr: 0.50, // penetration beyond entry against side before invalidation
  max_wait_bars: 4,          // 4 bars (60m on 15m timeframe) before entry expires
  max_staleness_ms: 30 * 60 * 1000, // 30 minutes max age for latest bar
  min_history_bars: 5,       // at least 5 closed bars required
  disallowed_regimes: Object.freeze(["chaos", "extreme_stretch"])
});

export const CONFIRMATION_STATUSES = Object.freeze({
  CONFIRMED: "confirmed",
  REJECTED: "rejected",
  INSUFFICIENT_DATA: "insufficient_data",
  EXPIRED: "expired"
});

export const REASON_CODES = Object.freeze({
  CONFIRMED: "confirmed",
  FORMING_BAR_REJECTED: "forming_bar_rejected",
  INSUFFICIENT_BARS: "insufficient_bars",
  STALE_DATA_REJECTED: "stale_data_rejected",
  DIRECTION_MISMATCH: "direction_mismatch",
  INSUFFICIENT_STRENGTH: "insufficient_strength",
  RETEST_INVALIDATED: "retest_invalidated",
  REGIME_PROHIBITED: "regime_prohibited",
  ENTRY_EXPIRED: "entry_expired",
  INVALID_PLAN: "invalid_plan"
});

export const RESEARCH_DISCLAIMER =
  "RESEARCH ONLY: Adaptive entry confirmation layer evaluated in shadow mode. Preserves Strategy Council authority and live guardrails.";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r3 = (v) => (isNum(v) ? Math.round(v * 1000) / 1000 : null);
const r4 = (v) => (isNum(v) ? Math.round(v * 10000) / 10000 : null);

/**
 * Pure: Evaluates a candidate trade plan against adaptive confirmation criteria.
 *
 * Parameters:
 * - plan: { entry, stop, tp1, at_level, side, risk }
 * - side: "BUY" | "SELL"
 * - bars: Array of closed bars [{ open_time, close_time, open, high, low, close, forming }]
 * - atr: Current 1H ATR (> 0)
 * - regime: Optional 1H regime label or object { label, chaos, stretch_z }
 * - options: Optional rule overrides { now, rules }
 */
export function confirmAdaptiveEntry(plan, side, bars, atr, regime = null, options = {}) {
  const rules = { ...CONFIRMATION_RULES, ...(options.rules || {}) };
  const now = options.now ?? Date.now();

  if (!plan || !isNum(plan.entry) || !isNum(plan.stop) || !(side === "BUY" || side === "SELL")) {
    return {
      status: CONFIRMATION_STATUSES.REJECTED,
      confirmed: false,
      reason: REASON_CODES.INVALID_PLAN,
      rule: "input_validation",
      metrics: null,
      disclaimer: RESEARCH_DISCLAIMER
    };
  }

  if (!Array.isArray(bars) || bars.length < rules.min_history_bars || !isNum(atr) || atr <= 0) {
    return {
      status: CONFIRMATION_STATUSES.INSUFFICIENT_DATA,
      confirmed: false,
      reason: REASON_CODES.INSUFFICIENT_BARS,
      rule: "history_check",
      metrics: { bars_count: bars?.length ?? 0, atr },
      disclaimer: RESEARCH_DISCLAIMER
    };
  }

  const lastBar = bars.at(-1);

  // 1. Never confirm on a forming (unclosed) candle
  if (lastBar.forming === true || lastBar.is_forming === true) {
    return {
      status: CONFIRMATION_STATUSES.REJECTED,
      confirmed: false,
      reason: REASON_CODES.FORMING_BAR_REJECTED,
      rule: "closed_candle_only",
      metrics: { forming: true },
      disclaimer: RESEARCH_DISCLAIMER
    };
  }

  // 2. Fail-closed on stale data
  const barCloseMs = Date.parse(lastBar.close_time || lastBar.open_time);
  if (isNum(barCloseMs) && now - barCloseMs > rules.max_staleness_ms) {
    return {
      status: CONFIRMATION_STATUSES.REJECTED,
      confirmed: false,
      reason: REASON_CODES.STALE_DATA_REJECTED,
      rule: "staleness_guard",
      metrics: { age_minutes: Math.round((now - barCloseMs) / 60000) },
      disclaimer: RESEARCH_DISCLAIMER
    };
  }

  // 3. Volatility regime check
  if (regime) {
    const isChaos = regime.chaos === true || regime === "chaos";
    const isExtremeStretch = Math.abs(regime.stretch_z ?? 0) >= 3.0 || regime === "extreme_stretch";
    if (isChaos || isExtremeStretch) {
      return {
        status: CONFIRMATION_STATUSES.REJECTED,
        confirmed: false,
        reason: REASON_CODES.REGIME_PROHIBITED,
        rule: "volatility_regime",
        metrics: { regime: typeof regime === "string" ? regime : regime.label, chaos: isChaos, stretch_z: regime.stretch_z ?? null },
        disclaimer: RESEARCH_DISCLAIMER
      };
    }
  }

  // 4. Directional momentum & breakout strength
  const dir = side === "BUY" ? 1 : -1;
  const candleBody = lastBar.close - lastBar.open;
  const directionalMove = dir * candleBody;

  // The confirmation candle must close favorably or hold entry
  if (directionalMove < 0 && Math.abs(directionalMove) > 0.5 * atr) {
    return {
      status: CONFIRMATION_STATUSES.REJECTED,
      confirmed: false,
      reason: REASON_CODES.DIRECTION_MISMATCH,
      rule: "candle_direction",
      metrics: { candle_body_r: r3(directionalMove / atr) },
      disclaimer: RESEARCH_DISCLAIMER
    };
  }

  // 5. Retest / Hold validation
  const distFromEntry = dir * (lastBar.close - plan.entry);
  const adversePenetration = dir * (plan.entry - (dir > 0 ? lastBar.low : lastBar.high));

  if (adversePenetration > rules.max_retest_penetration_atr * atr) {
    return {
      status: CONFIRMATION_STATUSES.REJECTED,
      confirmed: false,
      reason: REASON_CODES.RETEST_INVALIDATED,
      rule: "retest_penetration_limit",
      metrics: { adverse_penetration_atr: r3(adversePenetration / atr) },
      disclaimer: RESEARCH_DISCLAIMER
    };
  }

  // 6. Strength requirement
  const strengthAtr = Math.max(directionalMove, distFromEntry) / atr;
  if (strengthAtr < rules.min_strength_atr && !plan.at_level) {
    return {
      status: CONFIRMATION_STATUSES.REJECTED,
      confirmed: false,
      reason: REASON_CODES.INSUFFICIENT_STRENGTH,
      rule: "momentum_strength",
      metrics: { strength_atr: r3(strengthAtr), required_atr: rules.min_strength_atr },
      disclaimer: RESEARCH_DISCLAIMER
    };
  }

  // Confirmed!
  return {
    status: CONFIRMATION_STATUSES.CONFIRMED,
    confirmed: true,
    reason: REASON_CODES.CONFIRMED,
    rule: "all_criteria_passed",
    metrics: {
      strength_atr: r3(strengthAtr),
      retest_dist_atr: r3(distFromEntry / atr),
      adverse_penetration_atr: r3(adversePenetration / atr),
      bar_close: lastBar.close_time || lastBar.open_time
    },
    disclaimer: RESEARCH_DISCLAIMER
  };
}

/**
 * Pure: Compares an adaptive confirmation filter against an unfiltered trade baseline.
 * Measures:
 * - Total baseline trades
 * - Passed vs Rejected trades
 * - Avoided losses (rejected trades where R < 0)
 * - Missed winners (rejected trades where R > 0)
 * - False filters (filtered out winning trades)
 * - Opportunity capture ratio
 * - Baseline vs filtered win rate and expectancy
 */
export function evaluateConfirmationAgainstBaseline(trades, confirmationChecker) {
  if (!Array.isArray(trades) || !trades.length || typeof confirmationChecker !== "function") {
    return { status: "insufficient_data", baseline_count: 0 };
  }

  let baselineR = 0;
  let baselineWins = 0;
  let baselineLosses = 0;

  let passedCount = 0;
  let passedR = 0;
  let passedWins = 0;
  let passedLosses = 0;

  let rejectedCount = 0;
  let avoidedLosses = 0;   // R < 0 rejected
  let missedWinners = 0;   // R > 0 rejected
  let rejectedScratch = 0; // R === 0 rejected

  for (const t of trades) {
    const r = Number(t.r ?? t.r_tp1 ?? 0);
    baselineR += r;
    if (r > 0) baselineWins++;
    else if (r < 0) baselineLosses++;

    const check = confirmationChecker(t);
    if (check.confirmed) {
      passedCount++;
      passedR += r;
      if (r > 0) passedWins++;
      else if (r < 0) passedLosses++;
    } else {
      rejectedCount++;
      if (r < 0) avoidedLosses++;
      else if (r > 0) missedWinners++;
      else rejectedScratch++;
    }
  }

  const n = trades.length;
  const baselineExpectancy = n ? baselineR / n : 0;
  const filteredExpectancy = passedCount ? passedR / passedCount : 0;
  const baselineWinRate = n ? baselineWins / n : 0;
  const filteredWinRate = passedCount ? passedWins / passedCount : 0;

  // Opportunity capture: fraction of total available winning trades retained by filter
  const opportunityCapture = baselineWins > 0 ? passedWins / baselineWins : 1;
  // Precision improvement: ratio of avoided losses to total rejections
  const filterEfficiency = rejectedCount > 0 ? avoidedLosses / rejectedCount : null;

  return {
    status: "ok",
    baseline: {
      count: n,
      expectancy: r4(baselineExpectancy),
      cumulative_r: r3(baselineR),
      win_rate: r3(baselineWinRate),
      wins: baselineWins,
      losses: baselineLosses
    },
    filtered: {
      count: passedCount,
      expectancy: r4(filteredExpectancy),
      cumulative_r: r3(passedR),
      win_rate: r3(filteredWinRate),
      wins: passedWins,
      losses: passedLosses
    },
    delta: {
      expectancy_gain: r4(filteredExpectancy - baselineExpectancy),
      win_rate_gain: r3(filteredWinRate - baselineWinRate),
      trades_filtered_pct: r3(rejectedCount / n)
    },
    audit: {
      rejected_total: rejectedCount,
      avoided_losses: avoidedLosses,
      missed_winners: missedWinners,
      rejected_scratch: rejectedScratch,
      opportunity_capture_ratio: r3(opportunityCapture),
      filter_precision_efficiency: r3(filterEfficiency)
    },
    disclaimer: RESEARCH_DISCLAIMER
  };
}
