// The Aether-Governed Dynamic Witness Weighting Engine for XAUUSD Decision Council.
// (owner 2026-11-11: "mengubah decision engine ini menjadi weighting based on aether").
//
// Mathematical Model:
//  1. Baseline Anchor: B-11 extended witness weights serve as the Dirichlet Prior w_0.
//  2. Empirical Conditioning:
//     - Market Regime (1H efficiency, volatility tercile, chaos/stretch):
//       * Trending: Boosts higher timeframes (D1, H4, Trend TF) by +15% to +25%.
//       * Mean-reverting / Chop: Boosts Key Levels and M15 structure by +20% to +30%.
//       * High volatility / News: Boosts News Daily and Macro War Room.
//     - Nexus Analytics Disparity:
//       * High broker spread/slippage friction surcharges penalize breakout witnesses
//         and prioritize structural pullback (Key Levels / Limit order) entries.
//     - Witness Scorecards / Track Record:
//       * Downweights stuck or non-compliant witnesses.
//  3. Constitutional Safeguards:
//     - Strict clamp: every witness bounded within [w_min = 0.02, w_max = 0.28].
//     - DOCTRINE_BOUNDS compliance: no single witness can exceed max_each = 0.30.
//     - Re-normalization: sum of active weights strictly equals 1.000.

export const WITNESS_KEYS = Object.freeze([
  "D1", "H4", "H1", "M15", "NEWS", "MACRO", "STRATEGY",
  "KEY_LEVELS", "REGIME", "TREND_TF", "MACRO_DRIVERS", "SESSION"
]);

export const WITNESS_PRIORS = Object.freeze({
  D1: 0.16,
  H4: 0.16,
  H1: 0.16,
  M15: 0.12,
  NEWS: 0.08,
  MACRO: 0.04,
  STRATEGY: 0.08,
  KEY_LEVELS: 0.05,
  REGIME: 0.05,
  TREND_TF: 0.05,
  MACRO_DRIVERS: 0.03,
  SESSION: 0.02
});

export const WITNESS_MIN_WEIGHT = 0.02; // 2% minimum floor (preserves diversity)
export const WITNESS_MAX_WEIGHT = 0.28; // 28% ceiling (< 30% DOCTRINE_BOUNDS limit)

export const WITNESS_WEIGHTS_KV_KEY = "aether:witness_weights:effective";

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const round4 = (x) => Math.round(x * 10_000) / 10_000;

/**
 * Validates and normalises a witness weights dictionary.
 * Ensures all 12 keys exist, values are within [min, max], and sum = 1.0.
 */
export function validateWitnessWeights(weights) {
  if (!weights || typeof weights !== "object" || Array.isArray(weights)) {
    return { valid: false, errors: ["not_an_object"], normalised: { ...WITNESS_PRIORS } };
  }
  const errors = [];
  const entries = {};
  let rawSum = 0;

  for (const k of WITNESS_KEYS) {
    const val = Number(weights[k]);
    if (!isNum(val) || val < 0) {
      errors.push(`missing_or_invalid_key_${k}`);
      entries[k] = WITNESS_PRIORS[k];
    } else if (val > 0.30) {
      errors.push(`key_${k}_exceeds_doctrine_max_0.30`);
      entries[k] = 0.28;
    } else {
      entries[k] = val;
    }
    rawSum += entries[k];
  }

  // Renormalise so sum is strictly 1.0
  const normalised = {};
  if (rawSum > 0) {
    for (const k of WITNESS_KEYS) {
      normalised[k] = round4(entries[k] / rawSum);
    }
    // Adjust rounding residual on D1
    const finalSum = Object.values(normalised).reduce((a, b) => a + b, 0);
    const residual = round4(1.0 - finalSum);
    if (Math.abs(residual) > 0 && Math.abs(residual) <= 0.005) {
      normalised.D1 = round4(normalised.D1 + residual);
    }
  } else {
    Object.assign(normalised, WITNESS_PRIORS);
  }

  return { valid: errors.length === 0, errors, normalised };
}

/**
 * Pure: Derives dynamic Aether-conditioned witness weights.
 * Applies market regime shifts and nexus analytics friction.
 */
export function deriveWitnessWeights({
  basePriors = WITNESS_PRIORS,
  regime = null,
  analytics = null,
  witnessScores = null
} = {}) {
  const multipliers = Object.fromEntries(WITNESS_KEYS.map((k) => [k, 1.0]));

  // 1. Market Regime Conditioning (1H/15m volatility, efficiency, and market state)
  if (regime && typeof regime === "object") {
    const efficiency = Number(regime?.efficiency_ratio ?? regime?.h1?.efficiency_ratio ?? 0.35);
    const volatility = String(regime?.volatility_tercile ?? regime?.h1?.volatility_tercile ?? "").toLowerCase();
    const state = String(regime?.state ?? regime?.market_state ?? "").toLowerCase();

    // A. Trending Regimes (High directional efficiency)
    if (efficiency >= 0.40 || state.includes("trend")) {
      multipliers.D1 *= 1.25;      // Macro trend carries high predictive power
      multipliers.H4 *= 1.20;      // Intraday trend alignment
      multipliers.TREND_TF *= 1.20;// Moving average confluence
      multipliers.REGIME *= 1.15;  // Regime confirmation
      multipliers.KEY_LEVELS *= 0.85; // Less reliance on horizontal mean-reversion
    }
    // B. Mean-Reverting / Choppy Regimes (Low efficiency, high entropy)
    else if (efficiency <= 0.28 || state.includes("chop") || state.includes("range")) {
      multipliers.KEY_LEVELS *= 1.30; // Horizontal structural S/R and liquidity pools dominate
      multipliers.M15 *= 1.20;        // 15m structure reaction
      multipliers.D1 *= 0.80;         // Trend chasing leads to false breakouts
      multipliers.H4 *= 0.85;
      multipliers.TREND_TF *= 0.75;
    }

    // C. High Volatility / Event Expansion
    if (volatility === "high" || state.includes("chaos") || state.includes("expansion")) {
      multipliers.NEWS *= 1.35;        // Fundamental headlines carry heavy impact
      multipliers.MACRO *= 1.30;       // Macro driver shift
      multipliers.MACRO_DRIVERS *= 1.25; // Dollar/Yields disparity
      multipliers.STRATEGY *= 0.80;    // Technical triggers experience higher false slippage
    }
  }

  // 2. Nexus Analytics Disparity & Friction Adaptation
  if (analytics && typeof analytics === "object") {
    const friction = Number(analytics?.disparity?.friction_surcharge_pct ?? 0);
    const slippage = Number(analytics?.disparity?.slippage_pips ?? 0);
    const discounts = analytics?.quorum_weighting_input?.agent_weight_discounts || {};

    // When broker friction is severe (> 15% surcharge or > 3 pips slippage),
    // downweight momentum/breakout witnesses and prioritize structural key level pullbacks
    if (friction > 15 || slippage > 3.0) {
      multipliers.STRATEGY *= 0.75;
      multipliers.M15 *= 0.85;
      multipliers.KEY_LEVELS *= 1.25; // Limit orders at key levels protect against slippage
    }

    // Apply any specific witness discounts from analytics
    for (const [k, d] of Object.entries(discounts)) {
      if (k in multipliers && isNum(d)) {
        multipliers[k] *= Math.max(0.1, Math.min(1.0, Number(d)));
      }
    }
  }

  // 3. Historical Witness Predictive Scorecards (if provided from Aether D1)
  if (witnessScores && typeof witnessScores === "object") {
    for (const k of WITNESS_KEYS) {
      const score = witnessScores[k];
      if (score && isNum(score.accuracy)) {
        // Center around 0.50: 60% accuracy gives +20% weight, 40% accuracy gives -20%
        const delta = Math.max(-0.3, Math.min(0.3, (score.accuracy - 0.50) * 2.0));
        multipliers[k] *= (1.0 + delta);
      }
    }
  }

  // 4. Calculate adjusted raw weights with constitutional clamping
  const adjusted = {};
  for (const k of WITNESS_KEYS) {
    const base = isNum(basePriors[k]) ? basePriors[k] : WITNESS_PRIORS[k];
    const candidate = base * (multipliers[k] ?? 1.0);
    adjusted[k] = Math.max(WITNESS_MIN_WEIGHT, Math.min(WITNESS_MAX_WEIGHT, candidate));
  }

  // 5. Renormalise iteratively to strictly honour [WITNESS_MIN_WEIGHT, WITNESS_MAX_WEIGHT] and sum = 1.0
  const result = { ...adjusted };
  for (let iter = 0; iter < 5; iter++) {
    const sum = Object.values(result).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1.0) < 0.0001) break;
    for (const k of WITNESS_KEYS) {
      result[k] = round4(result[k] / sum);
      result[k] = Math.max(WITNESS_MIN_WEIGHT, Math.min(WITNESS_MAX_WEIGHT, result[k]));
    }
  }

  const finalSum = Object.values(result).reduce((a, b) => a + b, 0);
  const residual = round4(1.0 - finalSum);
  if (Math.abs(residual) > 0 && Math.abs(residual) <= 0.005) {
    const target = result.H1 + residual <= WITNESS_MAX_WEIGHT && result.H1 + residual >= WITNESS_MIN_WEIGHT ? "H1" : "D1";
    result[target] = round4(result[target] + residual);
  }

  return result;
}

/**
 * Resolves active witness weights by consulting:
 * 1. env.DYNAMIC_WITNESS_WEIGHTS (if explicitly injected)
 * 2. KV cache `aether:witness_weights:effective`
 * 3. Fallback to baseline priors (WITNESS_PRIORS)
 */
export async function resolveActiveWitnessWeights(env) {
  if (env?.DYNAMIC_WITNESS_WEIGHTS && typeof env.DYNAMIC_WITNESS_WEIGHTS === "object") {
    const check = validateWitnessWeights(env.DYNAMIC_WITNESS_WEIGHTS);
    if (check.valid) return check.normalised;
  }

  if (env?.SIGNAL_CACHE?.get) {
    try {
      const cached = await env.SIGNAL_CACHE.get(WITNESS_WEIGHTS_KV_KEY, "json");
      if (cached && typeof cached === "object") {
        const check = validateWitnessWeights(cached);
        if (check.valid) return check.normalised;
      }
    } catch { /* proceed to fallback */ }
  }

  return { ...WITNESS_PRIORS };
}
