import test from "node:test";
import assert from "node:assert/strict";
import {
  WITNESS_KEYS,
  WITNESS_PRIORS,
  WITNESS_MIN_WEIGHT,
  WITNESS_MAX_WEIGHT,
  validateWitnessWeights,
  deriveWitnessWeights,
  resolveActiveWitnessWeights,
  WITNESS_WEIGHTS_KV_KEY
} from "../src/witness-weighting.mjs";

test("WITNESS_PRIORS has all 12 keys and sums strictly to 1.0", () => {
  assert.equal(WITNESS_KEYS.length, 12);
  const sum = Object.values(WITNESS_PRIORS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 0.0001, `sum must be 1.0, got ${sum}`);
  assert.equal(WITNESS_PRIORS.D1, 0.16);
  assert.equal(WITNESS_PRIORS.H4, 0.16);
  assert.equal(WITNESS_PRIORS.H1, 0.16);
  assert.equal(WITNESS_PRIORS.M15, 0.12);
  assert.equal(WITNESS_PRIORS.NEWS, 0.08);
  assert.equal(WITNESS_PRIORS.MACRO, 0.04);
  assert.equal(WITNESS_PRIORS.STRATEGY, 0.08);
  assert.equal(WITNESS_PRIORS.KEY_LEVELS, 0.05);
  assert.equal(WITNESS_PRIORS.REGIME, 0.05);
  assert.equal(WITNESS_PRIORS.TREND_TF, 0.05);
  assert.equal(WITNESS_PRIORS.MACRO_DRIVERS, 0.03);
  assert.equal(WITNESS_PRIORS.SESSION, 0.02);
});

test("validateWitnessWeights enforces bounds and renormalises cleanly", () => {
  // Valid case
  const res1 = validateWitnessWeights(WITNESS_PRIORS);
  assert.equal(res1.valid, true);
  assert.equal(res1.errors.length, 0);

  // Invalid case: missing key and exceeding 0.30 bound
  const invalid = { ...WITNESS_PRIORS, D1: 0.55, H1: -0.1 };
  const res2 = validateWitnessWeights(invalid);
  assert.equal(res2.valid, false);
  assert.ok(res2.errors.some((e) => e.includes("exceeds_doctrine_max")));
  // Normalized sum must still be 1.0
  const sum2 = Object.values(res2.normalised).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum2 - 1.0) < 0.005);
  assert.ok(res2.normalised.D1 <= 0.30);
});

test("deriveWitnessWeights boosts higher timeframes in trending regimes", () => {
  const trendingRegime = {
    efficiency_ratio: 0.65,
    volatility_tercile: "normal",
    state: "strong_trend_bullish"
  };

  const weights = deriveWitnessWeights({ regime: trendingRegime });
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 0.005, `sum must be 1.0, got ${sum}`);

  // D1 and H4 should be boosted relative to baseline
  assert.ok(weights.D1 > WITNESS_PRIORS.D1, `D1 ${weights.D1} should be > prior ${WITNESS_PRIORS.D1}`);
  assert.ok(weights.H4 > WITNESS_PRIORS.H4, `H4 ${weights.H4} should be > prior ${WITNESS_PRIORS.H4}`);
  assert.ok(weights.TREND_TF > WITNESS_PRIORS.TREND_TF, `TREND_TF ${weights.TREND_TF} should be > prior ${WITNESS_PRIORS.TREND_TF}`);

  // Horizontal Key Levels should be lower relative to trend
  assert.ok(weights.KEY_LEVELS < weights.D1);
});

test("deriveWitnessWeights boosts Key Levels and M15 in choppy/ranging regimes", () => {
  const choppyRegime = {
    efficiency_ratio: 0.18,
    volatility_tercile: "low",
    state: "choppy_range"
  };

  const weights = deriveWitnessWeights({ regime: choppyRegime });
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 0.005, `sum must be 1.0, got ${sum}`);

  // Key Levels and M15 structure should be boosted relative to baseline
  assert.ok(weights.KEY_LEVELS > WITNESS_PRIORS.KEY_LEVELS, `KEY_LEVELS ${weights.KEY_LEVELS} should be > prior ${WITNESS_PRIORS.KEY_LEVELS}`);
  assert.ok(weights.M15 > WITNESS_PRIORS.M15, `M15 ${weights.M15} should be > prior ${WITNESS_PRIORS.M15}`);

  // Trend chasing should be downweighted
  assert.ok(weights.D1 < WITNESS_PRIORS.D1, `D1 ${weights.D1} should be < prior ${WITNESS_PRIORS.D1}`);
});

test("deriveWitnessWeights penalizes breakout strategy under high broker friction", () => {
  const highFrictionAnalytics = {
    disparity: {
      friction_surcharge_pct: 22.5,
      slippage_pips: 4.8
    }
  };

  const weights = deriveWitnessWeights({ analytics: highFrictionAnalytics });
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 0.005);

  // Strategy (market entry) is penalized; Key Levels (limit entry) is boosted
  assert.ok(weights.STRATEGY < WITNESS_PRIORS.STRATEGY, `STRATEGY ${weights.STRATEGY} should be < prior ${WITNESS_PRIORS.STRATEGY}`);
  assert.ok(weights.KEY_LEVELS > WITNESS_PRIORS.KEY_LEVELS, `KEY_LEVELS ${weights.KEY_LEVELS} should be > prior ${WITNESS_PRIORS.KEY_LEVELS}`);
});

test("deriveWitnessWeights respects constitutional clamping bounds under extreme inputs", () => {
  const extremeRegime = {
    efficiency_ratio: 0.99,
    volatility_tercile: "high",
    state: "runaway_hyper_trend"
  };

  const weights = deriveWitnessWeights({ regime: extremeRegime });
  for (const [k, w] of Object.entries(weights)) {
    assert.ok(w >= WITNESS_MIN_WEIGHT, `${k} weight ${w} must be >= min floor ${WITNESS_MIN_WEIGHT}`);
    assert.ok(w <= WITNESS_MAX_WEIGHT, `${k} weight ${w} must be <= max ceiling ${WITNESS_MAX_WEIGHT}`);
  }
});

test("resolveActiveWitnessWeights retrieves from dynamic env, KV, or fallback", async () => {
  // 1. Fallback case
  const res1 = await resolveActiveWitnessWeights({});
  assert.equal(res1.D1, WITNESS_PRIORS.D1);

  // 2. Direct env injection
  const dynamicEnv = {
    DYNAMIC_WITNESS_WEIGHTS: { ...WITNESS_PRIORS, D1: 0.20, H4: 0.12 }
  };
  const res2 = await resolveActiveWitnessWeights(dynamicEnv);
  assert.equal(res2.D1, 0.20);
  assert.equal(res2.H4, 0.12);

  // 3. KV retrieval
  const mockKv = {
    get: async (k) => (k === WITNESS_WEIGHTS_KV_KEY ? { ...WITNESS_PRIORS, D1: 0.18, H4: 0.14 } : null)
  };
  const res3 = await resolveActiveWitnessWeights({ SIGNAL_CACHE: mockKv });
  assert.equal(res3.D1, 0.18);
  assert.equal(res3.H4, 0.14);
});
