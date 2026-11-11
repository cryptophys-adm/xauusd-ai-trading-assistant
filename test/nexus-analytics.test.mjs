import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDisparityMetrics,
  computeScorecardsMetrics,
  computeShadowMetrics,
  computeRegimeMetrics,
  deriveQuorumWeightingInput,
  collectNexusAnalytics,
  NEXUS_ANALYTICS_VERSION
} from "../src/nexus-analytics.mjs";
import { weightingReport } from "../src/aether-push.mjs";
import { quorumFor, agentWeight, WEIGHTING_DEFAULT } from "../src/weighting.mjs";
import { quorumOf } from "../src/decision-engine.mjs";

test("computeDisparityMetrics calculates slippage, latency, fidelity and friction surcharge", () => {
  const bridge = {
    spread_points: 20,
    positions: [{ sl_locked: true, swap: -2 }, { sl_locked: true, swap: -1 }]
  };
  const intents = [
    { created_ms: 1000, updated_ms: 1300, payload: JSON.stringify({ price: 4000 }), result: JSON.stringify({ price: 4001.5 }) },
    { created_ms: 2000, updated_ms: 2200, payload: JSON.stringify({ price: 4010 }), result: JSON.stringify({ price: 4010.5 }) }
  ];

  const m = computeDisparityMetrics({ bridge, intents });
  assert.equal(m.avg_latency_ms, 250);
  assert.equal(m.avg_slippage_points, 1);
  assert.equal(m.max_slippage_points, 1.5);
  assert.equal(m.live_spread_points, 20);
  assert.equal(m.execution_fidelity_score, 0.92);
  assert.equal(m.friction_surcharge, 0);
  assert.equal(m.sl_plus_protection_active, true);
});

test("computeDisparityMetrics raises friction surcharge when broker execution deteriorates", () => {
  const bridge = {
    spread_points: 40,
    positions: [{ unprotected: true, sl_locked: false }]
  };
  const intents = [
    { created_ms: 1000, updated_ms: 2500, payload: JSON.stringify({ price: 4000 }), result: JSON.stringify({ price: 4016 }) }
  ];

  const m = computeDisparityMetrics({ bridge, intents });
  assert.ok(m.execution_fidelity_score < 0.80);
  assert.ok(m.friction_surcharge >= 0.05);
});

test("computeScorecardsMetrics penalizes disqualified stuck agents and compliance rule-breakers", () => {
  const cards = [
    { subject: "agent:trend_h1", accuracy: 0.65, brier: 0.18 },
    { subject: "agent:vol_m15", accuracy: 0.40, brier: 0.32 }
  ];
  const stuck = [{ field: "stuck_engine.signal", status: "open" }];
  const compliance = {
    total: { rate_per_100: 8 },
    agents: [{ agent: "unruly_agent", rate_per_100: 25 }]
  };

  const sm = computeScorecardsMetrics({ cards, stuck, compliance });
  assert.equal(sm.agent_count, 2);
  assert.equal(sm.avg_accuracy, 0.525);
  assert.equal(sm.open_stuck_states, 1);
  assert.deepEqual(sm.disqualified_agents, ["stuck_engine"]);
  assert.equal(sm.agent_weight_discounts["stuck_engine"], 0, "disqualified agent voting weight set to 0");
  assert.equal(sm.agent_weight_discounts["unruly_agent"], 0.75, "rule-breaker discounted proportionally");
});

test("deriveQuorumWeightingInput produces clamped, unified quorum tuning targets", () => {
  const input = deriveQuorumWeightingInput({
    disparity: { friction_surcharge: 0.05, execution_fidelity_score: 0.78 },
    scorecards: { agent_weight_discounts: { bad_bot: 0.5 }, disqualified_agents: ["stuck_bot"] },
    shadow: { aa_noise_baseline_rate: 0.09 },
    regime: { volatility_surcharge: 0.05 },
    baseQuorumShare: 0.50
  });

  assert.equal(input.base_quorum_share, 0.50);
  assert.equal(input.friction_surcharge, 0.05);
  assert.equal(input.volatility_surcharge, 0.05);
  assert.equal(input.recommended_quorum_min, 0.60);
  assert.equal(input.agent_weight_discounts.bad_bot, 0.5);
  assert.deepEqual(input.disqualified_agents, ["stuck_bot"]);
});

test("nexus analytics payload adheres strictly to Aether leak check rules (no price, level, size, or balances)", () => {
  const disparity = computeDisparityMetrics({});
  const scorecards = computeScorecardsMetrics({});
  const shadow = computeShadowMetrics({});
  const regime = computeRegimeMetrics({});
  const qInput = deriveQuorumWeightingInput({ disparity, scorecards, shadow, regime });

  const digest = {
    version: NEXUS_ANALYTICS_VERSION,
    disparity,
    scorecards,
    shadow,
    regime,
    quorum_weighting_input: qInput
  };

  const jsonStr = JSON.stringify(digest);
  assert.doesNotMatch(jsonStr, /"(entry|stop|take_profit|price|position_size)/, "strictly no price, level or size keys");
});

test("weightingReport includes nexus_analytics without violating compliance regex", () => {
  const replay = {
    timeframe: "60",
    equation: "weighting@default",
    active: { id: "w1", params: WEIGHTING_DEFAULT },
    candidates: []
  };
  const nexusAnalytics = {
    version: NEXUS_ANALYTICS_VERSION,
    quorum_weighting_input: { recommended_quorum_min: 0.55 }
  };

  const report = weightingReport(replay, { now: Date.now(), nexusAnalytics });
  assert.equal(report.nexus_analytics.quorum_weighting_input.recommended_quorum_min, 0.55);
  assert.doesNotMatch(JSON.stringify(report), /"(entry|stop|take_profit|price|position_size)/);
});

test("weighting engine quorumFor and agentWeight seamlessly consume analytics inputs", () => {
  // Test quorumFor with analytics surcharge
  const qDefault = quorumFor(WEIGHTING_DEFAULT, "normal");
  assert.equal(qDefault, 0.5);

  const qAdapted = quorumFor(WEIGHTING_DEFAULT, "normal", {
    analytics: { quorum_weighting_input: { friction_surcharge: 0.05 } }
  });
  assert.equal(qAdapted, 0.55);

  // Test agentWeight with compliance discount and stuck disqualification
  const sampleRows = [{ close_ms: 1000, result: "hit", brier: 0.15 }];
  const normalW = agentWeight(sampleRows, WEIGHTING_DEFAULT, 1000 + 4 * 3600000);
  assert.ok(normalW.weight > 0.5);

  const discountedW = agentWeight(sampleRows, WEIGHTING_DEFAULT, 1000 + 4 * 3600000, { discount: 0.5 });
  assert.ok(discountedW.weight < normalW.weight);

  const stuckW = agentWeight(sampleRows, WEIGHTING_DEFAULT, 1000 + 4 * 3600000, { isStuck: true });
  assert.equal(stuckW.weight, WEIGHTING_DEFAULT.weight_range[0]);
  assert.equal(stuckW.stuck, true);
});

test("decision engine quorumOf adjusts share_needed_above when analytics is provided", () => {
  const cards = [
    { key: "D1", weight: 0.2, lean: 0.5, available: true, stale: false },
    { key: "H1", weight: 0.2, lean: 0.6, available: true, stale: false }
  ];

  const qBase = quorumOf(cards, { now: 1000 });
  assert.equal(qBase.share_needed_above, 0.5);

  const qTight = quorumOf(cards, {
    now: 1000,
    analytics: { quorum_weighting_input: { friction_surcharge: 0.05, volatility_surcharge: 0.05 } }
  });
  assert.equal(qTight.share_needed_above, 0.6);
});
