// The Nexus and Omega seats of the Knowledge Council (owner 2026-11-11: "autonomous doctrine protocol
// harus dilakukan oleh knowledge council, dilakukan harian dan di propose ke cerebrum untuk
// eksekusinya"). Every hour this Worker reports the facts it runs with to Aether
// (KnowledgeIngress.ingestDoctrineFacts, cryptophys.doctrine-facts.v1). Aether's council compares them
// with the doctrine of its canon once a day and proposes each lasting difference to the Cerebrum
// consensus, which executes it. Every value here is read from the running code, its variables and the
// stored Omega settings: never typed in. No price, level, size or account appears.
import { activeWitnessWeights, decisionEngineEnabled, guardrailsFor, MIN_CONFIDENCE, modeThresholds, tradingMode } from "./decision-engine.mjs";
import { QUORUM_SHARE } from "./reputation.mjs";
import { UNCALIBRATED_CONFIDENCE_CAP } from "./war-room.mjs";
import { ACTIVATION_COOLDOWN_DAYS, ROLLBACK_MIN_ROOMS } from "./weighting.mjs";
import { DEFAULT_POLICY } from "./parity-registry.mjs";
import { blackoutWindow } from "./ea-signal.mjs";
import { OMEGA_DEFAULTS, RISK_PCT_MAX, ROLLOVER_QUARANTINE_UTC } from "./omega-engine.mjs";
import { readSettings } from "./omega-broker.mjs";
import { activeWitnessTuning, tuningFrozen } from "./witness-tuning.mjs";

export const DOCTRINE_FACTS_SCHEMA = "cryptophys.doctrine-facts.v1";

/** Pure: the guardrail ids the Decision Engine checks for a side, plus the council's confidence check. */
export function guardrailIds(env = {}) {
  let ids = [];
  try {
    ids = guardrailsFor(1, { cards: [], quorum: { long_share: 0, short_share: 0, score: 0 }, strategy: null, inputs: {}, env }).checks.map((c) => c.id);
  } catch { ids = []; }
  return ids.length ? [...ids, "confidence"] : [];
}

/** The decision side (the Nexus seat). */
export async function nexusFacts(env) {
  const mode = await tradingMode(env).catch(() => "intraday");
  const t = modeThresholds(mode);
  const guards = guardrailIds({ ...env, TRADING_MODE: t.mode });
  const { beforeMs, afterMs } = blackoutWindow(env);
  // The weights in force: the auto-tuned set when one is active (src/witness-tuning.mjs).
  let weights = { ...activeWitnessWeights(env) };
  try { weights = { ...(await activeWitnessTuning(env)).weights }; } catch { /* the static set */ }
  return {
    "decision.engine_enabled": decisionEngineEnabled(env),
    "decision.cadence": "15m",
    "decision.witness_weights": weights,
    "decision.witness_tuning": tuningFrozen(env) ? "default" : "auto",
    "decision.guardrails": guards,
    "decision.confirmation_required": guards.includes("confirmation"),
    "decision.trading_mode": t.mode,
    "decision.quorum_min": t.quorum_min,
    "decision.lean": t.lean,
    "decision.min_rrr": t.min_rrr,
    "decision.min_confidence": MIN_CONFIDENCE,
    "rooms.quorum_share_default": QUORUM_SHARE,
    "room.m15_unverified_confidence_cap": UNCALIBRATED_CONFIDENCE_CAP,
    "weighting.mode": String(env?.WEIGHTING_MODE ?? "").trim().toLowerCase() === "default" ? "default" : "auto",
    "weighting.activation_min_days": ACTIVATION_COOLDOWN_DAYS,
    "weighting.rollback_min_rooms": ROLLBACK_MIN_ROOMS,
    "calendar.blackout_before_min": Math.round(beforeMs / 60_000),
    "calendar.blackout_after_min": Math.round(afterMs / 60_000),
    "parity.approval_candles": DEFAULT_POLICY.promoteAfter,
    "lanes.indicator_source": String(env?.INDICATOR_SOURCE ?? "local").trim().toLowerCase() || "local"
  };
}

/** The execution side (the Omega seat): the settings in force and the fixed gates. */
export async function omegaFacts(env) {
  let settings = OMEGA_DEFAULTS;
  try { if (env?.DB) settings = (await readSettings(env)).settings; } catch { settings = OMEGA_DEFAULTS; }
  return {
    "omega.risk_pct": Number(settings.risk_pct),
    "omega.risk_pct_max": RISK_PCT_MAX,
    "omega.max_positions": Number(settings.max_positions),
    "omega.max_daily_loss_pct": Number(settings.max_daily_loss_pct),
    "omega.max_spread_points": Number(settings.max_spread_points),
    "omega.max_signal_age_min": Math.round(Number(settings.max_signal_age_ms) / 60_000 * 100) / 100,
    "omega.rollover_quarantine_utc": ROLLOVER_QUARANTINE_UTC,
    "omega.live_arm_required": true
  };
}

/** The facts report of both seats, tagged with this Worker's deployed version. */
export async function doctrineFacts(env, { now = Date.now() } = {}) {
  const version = typeof env?.CF_VERSION_METADATA?.id === "string" ? env.CF_VERSION_METADATA.id : null;
  return {
    schema: DOCTRINE_FACTS_SCHEMA,
    measured_at: new Date(now).toISOString(),
    seats: {
      nexus: { version_id: version, facts: await nexusFacts(env) },
      omega: { version_id: version, facts: await omegaFacts(env) }
    }
  };
}

/** Sweep step, hourly with the card push. Never throws; a no-op without the Aether binding. */
export async function pushDoctrineFacts(env, { now = Date.now() } = {}) {
  if (typeof env?.AETHER?.ingestDoctrineFacts !== "function") return { status: "disabled" };
  try {
    const facts = await doctrineFacts(env, { now });
    const res = await env.AETHER.ingestDoctrineFacts(facts);
    return { status: "ok", ...(res && typeof res === "object" ? res : {}) };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}
