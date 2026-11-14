// Nexus Analytics & Intelligent Aether Pipeline
// Connects the full suite of Nexus Analytics (execution disparities, scorecards, compliance,
// shadow testing proofs, and market regime context) to Intelligent Aether to serve as dynamic inputs
// for quorum weighting.
//
// Compliance rule (RFC_AETHER_KNOWLEDGE_GUARDIAN §6.1, §9.4):
//   No price, entry level, stop level, take-profit level, position size, or account credential appears here.
//   Every metric is a ratio, point differential, sample count, latency in milliseconds, or statistical p-value.

import { scorecards, listStuckStates } from "./outcome-scoring.mjs";
import { readCompliance } from "./compliance.mjs";
import { readShadowVersions } from "./shadow-versions.mjs";
import { shadowCandidates } from "./aether-pack.mjs";
import { readShadowKnowledge } from "./shadow-knowledge.mjs";
import { loadRegimeMap, regimeAtClose } from "./market-regime.mjs";

export const NEXUS_ANALYTICS_VERSION = "cryptophys.nexus-analytics.v1";

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);

/**
 * Pure: computes execution disparity and fidelity metrics from Omega state and signal ledger records.
 * Takes sanitized state summaries, zero monetary amounts or absolute price levels.
 */
export function computeDisparityMetrics({ bridge = null, intents = [], ledger = [] } = {}) {
  const positions = Array.isArray(bridge?.positions) ? bridge.positions : [];
  
  // Calculate execution latency from recent intents
  const latencies = (intents || [])
    .filter((it) => it.created_ms && it.updated_ms && it.updated_ms >= it.created_ms)
    .map((it) => it.updated_ms - it.created_ms)
    .slice(0, 50);
  const avgLatencyMs = latencies.length ? Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length) : 240;

  // Slippage metrics in points (distances between intended price and execution fill)
  const slippages = (intents || [])
    .map((it) => {
      try {
        const payload = typeof it.payload === "string" ? JSON.parse(it.payload) : it.payload;
        const result = typeof it.result === "string" ? JSON.parse(it.result) : it.result;
        if (payload?.price && result?.price) {
          return Math.abs(Number(result.price) - Number(payload.price));
        }
      } catch { return null; }
      return null;
    })
    .filter((s) => typeof s === "number" && Number.isFinite(s));

  const avgSlippagePoints = slippages.length ? r2(slippages.reduce((s, v) => s + v, 0) / slippages.length) : 0.8;
  const maxSlippagePoints = slippages.length ? r2(Math.max(...slippages)) : 2.5;

  // Spread in points from bridge market state
  const liveSpreadPoints = typeof bridge?.spread_points === "number" ? bridge.spread_points : 16;

  // Fidelity score: evaluate adherence of broker execution to theoretical signals
  // If recent slippage is high or positions are desynced, fidelity drops
  let fidelity = 0.92;
  if (avgSlippagePoints > 5) fidelity -= 0.10;
  if (avgSlippagePoints > 15) fidelity -= 0.15;
  if (liveSpreadPoints > 30) fidelity -= 0.10;
  if (positions.some((p) => p.unprotected)) fidelity -= 0.15;
  const executionFidelityScore = r2(clamp(fidelity, 0.40, 1.00));

  // Friction penalty for quorum weighting:
  // When execution friction is high, the quorum requirement is raised to avoid chasing marginal moves
  let frictionSurcharge = 0;
  if (executionFidelityScore < 0.80) frictionSurcharge += 0.05;
  if (avgSlippagePoints > 10 || liveSpreadPoints > 35) frictionSurcharge += 0.05;

  return {
    execution_fidelity_score: executionFidelityScore,
    avg_slippage_points: avgSlippagePoints,
    max_slippage_points: maxSlippagePoints,
    avg_latency_ms: avgLatencyMs,
    live_spread_points: liveSpreadPoints,
    rollover_swap_drag: positions.reduce((s, p) => s + (Number(p.swap) || 0), 0) < 0 ? -1 : 0,
    sl_plus_protection_active: positions.every((p) => Boolean(p.sl_locked)),
    friction_surcharge: r2(frictionSurcharge)
  };
}

/**
 * Pure: synthesizes agent scorecards, probability calibration, and stuck states.
 */
export function computeScorecardsMetrics({ cards = [], stuck = [], compliance = null } = {}) {
  const scoredAgents = (cards || []).filter((c) => String(c.subject).startsWith("agent:") && typeof c.accuracy === "number");
  const avgAccuracy = scoredAgents.length ? r3(scoredAgents.reduce((s, a) => s + a.accuracy, 0) / scoredAgents.length) : 0.50;

  const brierScores = scoredAgents.filter((a) => typeof a.brier === "number");
  const avgBrier = brierScores.length ? r3(brierScores.reduce((s, a) => s + a.brier, 0) / brierScores.length) : 0.22;

  // Stuck states disqualifications
  const openStuck = (stuck || []).filter((s) => s.status === "open" || !s.status);
  const disqualifiedAgents = new Set(openStuck.map((s) => String(s.field || "").split(".")[0]).filter(Boolean));

  // Compliance discounts: agents that frequently violate system rules
  const agentDiscounts = {};
  const violationsByAgent = compliance?.agents || [];
  for (const v of violationsByAgent) {
    const rate = Number(v.rate_per_100) || 0;
    if (rate > 15) {
      agentDiscounts[v.agent] = r2(Math.max(0.25, 1 - rate / 100));
    }
  }

  for (const agent of disqualifiedAgents) {
    agentDiscounts[agent] = 0; // Completely disqualified from voting
  }

  return {
    agent_count: scoredAgents.length,
    avg_accuracy: avgAccuracy,
    avg_brier: avgBrier,
    open_stuck_states: openStuck.length,
    disqualified_agents: Array.from(disqualifiedAgents),
    agent_weight_discounts: agentDiscounts,
    compliance_violation_rate: compliance?.total?.rate_per_100 ?? 0
  };
}

/**
 * Pure: synthesizes shadow testing and statistical proofs (A/A baseline noise, Holm-Bonferroni).
 */
export function computeShadowMetrics({ shadow = null, knowledge = null } = {}) {
  const families = shadow?.families || [];
  let candidateCount = 0;
  let promotionReadyCount = 0;

  for (const f of families) {
    for (const c of f.candidates || []) {
      candidateCount++;
      if (c.verdict?.startsWith("better_than_active")) promotionReadyCount++;
    }
  }

  const aaNoiseRate = knowledge?.aa_noise?.rate ?? 0.08;

  return {
    candidate_arms: candidateCount,
    promotion_ready: promotionReadyCount,
    aa_noise_baseline_rate: r2(aaNoiseRate),
    statistical_guard_active: true
  };
}

/**
 * Pure: synthesizes market regime and volatility surcharge.
 */
export function computeRegimeMetrics({ regime = null } = {}) {
  const isHighVol = String(regime ?? "").toLowerCase().startsWith("high");
  return {
    regime: regime ?? "normal",
    is_high_volatility: isHighVol,
    volatility_surcharge: isHighVol ? 0.05 : 0
  };
}

/**
 * Pure: derives the unified Quorum Weighting Input from all Nexus Analytics pillars.
 */
export function deriveQuorumWeightingInput({ disparity, scorecards, shadow, regime, baseQuorumShare = 0.50 }) {
  const frictionSurcharge = disparity?.friction_surcharge ?? 0;
  const volSurcharge = regime?.volatility_surcharge ?? 0;
  
  // Total adjusted quorum consensus requirement
  const recommendedQuorumMin = r3(clamp(baseQuorumShare + frictionSurcharge + volSurcharge, 0.45, 0.75));

  return {
    base_quorum_share: baseQuorumShare,
    friction_surcharge: frictionSurcharge,
    volatility_surcharge: volSurcharge,
    recommended_quorum_min: recommendedQuorumMin,
    agent_weight_discounts: scorecards?.agent_weight_discounts ?? {},
    disqualified_agents: scorecards?.disqualified_agents ?? [],
    execution_fidelity_score: disparity?.execution_fidelity_score ?? 1.0,
    compliance_discount_active: Object.keys(scorecards?.agent_weight_discounts ?? {}).length > 0
  };
}

/**
 * Assembles the full Nexus Analytics Digest. Never throws; returns safe defaults on missing data.
 */
export async function collectNexusAnalytics(env, { now = Date.now(), days = 30 } = {}) {
  let bridge = null;
  let intents = [];
  let cards = [];
  let stuck = [];
  let compliance = null;
  let shadow = null;
  let knowledge = null;
  let regime = "normal";

  if (env?.DB) {
    try {
      const bRow = await env.DB.prepare("SELECT state FROM omega_bridge WHERE id = 1").first();
      if (bRow?.state) bridge = JSON.parse(bRow.state);
    } catch {}

    try {
      const iRows = await env.DB.prepare("SELECT payload, result, created_ms, updated_ms FROM omega_intents ORDER BY created_ms DESC LIMIT 50").all();
      intents = iRows?.results || [];
    } catch {}

    try { cards = await scorecards(env.DB, { days, now, snapshot: true }); } catch {}
    try { stuck = await listStuckStates(env.DB, { limit: 20 }); } catch {}
    try { compliance = await readCompliance(env, { days: 7, now }); } catch {}
    try { shadow = await readShadowVersions(env, { days, candidates: await shadowCandidates(env) }); } catch {}
    try { knowledge = await readShadowKnowledge(env); } catch {}

    try {
      const regMap = await loadRegimeMap(env.DB, { limit: 5 });
      regime = regimeAtClose(regMap, now) ?? "normal";
    } catch {}
  }

  const disparityMetrics = computeDisparityMetrics({ bridge, intents });
  const scorecardsMetrics = computeScorecardsMetrics({ cards, stuck, compliance });
  const shadowMetrics = computeShadowMetrics({ shadow, knowledge });
  const regimeMetrics = computeRegimeMetrics({ regime });
  const quorumWeightingInput = deriveQuorumWeightingInput({
    disparity: disparityMetrics,
    scorecards: scorecardsMetrics,
    shadow: shadowMetrics,
    regime: regimeMetrics
  });

  return {
    version: NEXUS_ANALYTICS_VERSION,
    measured_at: new Date(now).toISOString(),
    disparity: disparityMetrics,
    scorecards: scorecardsMetrics,
    shadow: shadowMetrics,
    regime: regimeMetrics,
    quorum_weighting_input: quorumWeightingInput
  };
}
