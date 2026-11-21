// The Nexus and Omega seats of the Knowledge Council (owner 2026-11-11: "autonomous doctrine protocol
// harus dilakukan oleh knowledge council, dilakukan harian dan di propose ke cerebrum untuk
// eksekusinya"). Every hour this Worker reports the facts it runs with to Aether
// (KnowledgeIngress.ingestDoctrineFacts, cryptophys.doctrine-facts.v1). Aether's council compares them
// with the doctrine of its canon once a day and proposes each lasting difference to the Cerebrum
// consensus, which executes it. Every value here is read from the running code, its variables and the
// stored Omega settings: never typed in. No price, level, size or account appears.
import { LENS_MODES, LENS_KNOBS, lensKnobs, readLensState } from "./lens-policy.mjs";
import { strategyArmMode, ARM_MAX } from "./strategy-arm.mjs";
import { exec5mMode } from "./broker-trigger.mjs";
import { activeWitnessWeights, decisionEngineEnabled, guardrailsFor, MIN_CONFIDENCE, modeThresholds, tradingMode } from "./decision-engine.mjs";
import { QUORUM_SHARE } from "./reputation.mjs";
import { UNCALIBRATED_CONFIDENCE_CAP } from "./war-room.mjs";
import { ACTIVATION_COOLDOWN_DAYS, ROLLBACK_MIN_ROOMS } from "./weighting.mjs";
import { DEFAULT_POLICY } from "./parity-registry.mjs";
import { blackoutWindow } from "./ea-signal.mjs";
import { OMEGA_DEFAULTS, RISK_PCT_MAX, ROLLOVER_QUARANTINE_UTC } from "./omega-engine.mjs";
import { readSettings, connectedAccount } from "./omega-broker.mjs";
import { PROFILES, PROFILE_IDS, effectiveLimits, readAccounts } from "./account-spec.mjs";
import { activeWitnessTuning, tuningFrozen } from "./witness-tuning.mjs";
import { activeRoom, roomTuningFrozen, ROOM_MIN, ROOM_MAX, ROOM_MODES } from "./room-tuning.mjs";

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
  // The room guardrail in 1H ranges, per mode and for the mode in force (src/room-tuning.mjs, owner 2026-11-19): an
  // operational value the learning protocol moves inside the owner's bounds, carried here for the doctrine protocol.
  const rooms = {};
  for (const m of ROOM_MODES) { try { rooms[m] = (await activeRoom(env, m)).value; } catch { rooms[m] = 1; } }
  // The Decision Engine's thresholds per trading mode (owner 2026-11-19, relayed: "mau"): one fact per mode, as the room,
  // so a mode switch alone is no drift. The council's live knobs replace a mode's quorum and reward as the engine reads
  // them (modeThresholds); unreadable knobs: the code's values. Scalp has no reward minimum (owner 2026-11-12, "Tanpa batas
  // RRR"): its 0 is reported, not a bounded value.
  let knobs = {};
  try { knobs = await (await import("./council-knobs.mjs")).readKnobOverrides(env); } catch { knobs = {}; }
  const perMode = {};
  for (const m of ROOM_MODES) {
    const x = modeThresholds(m, knobs);
    perMode[`decision.quorum_min_${m}`] = x.quorum_min;
    perMode[`decision.lean_${m}`] = x.lean;
    perMode[`decision.min_rrr_${m}`] = x.min_rrr;
  }
  return {
    ...perMode,
    "decision.room_min_atr": rooms[t.mode] ?? rooms.intraday ?? 1,
    "decision.room_min_atr_by_mode": rooms,
    // One fact per mode (the canon anchors these): a mode switch alone is no drift for the doctrine protocol.
    "decision.room_min_atr_scalp": rooms.scalp ?? 1,
    "decision.room_min_atr_intraday": rooms.intraday ?? 1,
    "decision.room_min_atr_swing": rooms.swing ?? 1,
    "decision.room_min_atr_range": rooms.range ?? 1,
    "decision.room_bounds_atr": [ROOM_MIN, ROOM_MAX],
    "decision.room_tuning": roomTuningFrozen(env) ? "default" : "auto",
    "decision.engine_enabled": decisionEngineEnabled(env),
    "decision.cadence": "15m",
    "decision.witness_weights": weights,
    "decision.witness_tuning": tuningFrozen(env) ? "default" : "auto",
    "decision.guardrails": guards,
    "decision.confirmation_required": guards.includes("confirmation"),
    // Owner 2026-11-11: the confirmation candle is the entry trigger (src/ea-signal.mjs entryTriggerFor).
    // 2026-11-12 (docs/RFC_OMEGA_5M_EXECUTION.md): the broker's 5m confirmation, within 3 bars, while OMEGA_EXEC_5M is on.
    "decision.execution_trigger": exec5mMode(env) === "on" ? "prophet_candle_for_market_orders_broker_5m" : "prophet_candle_for_market_orders",
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
    "lanes.indicator_source": String(env?.INDICATOR_SOURCE ?? "local").trim().toLowerCase() || "local",
    // The Positioning & Liquidity analyst's knobs in force (docs/RFC_POSITIONING_LIQUIDITY.md §8, §10), both lenses on
    // this seat: Aether's validator keeps the Omega seat to omega.* facts and refuses the whole report otherwise
    // (2026-11-20, from #505 on every facts push was refused until this fix).
    ...(await lensFacts(env, "positioning")),
    ...(await lensFacts(env, "liquidity"))
  };
}

/** The knobs in force of one lens as doctrine facts (`<base>_<mode>` and the score knobs), plus its switch. */
async function lensFacts(env, lens) {
  const out = {};
  try {
    const st = await readLensState(env);
    for (const m of LENS_MODES) {
      // The knob as the doctrine holds it (Aether's value or the anchor, at its floor after a rollback): the owner's switch
      // is its own fact (<lens>.enabled), so a lens switched off does not report a weight of 0 outside its bound.
      const k = lensKnobs(lens, m, { policy: st.policy, floor: st.floor, enabled: true, baseline: "sufficient" });
      for (const base of Object.keys(LENS_KNOBS).filter((b) => b.startsWith(`${lens}.`))) out[`${base}_${m}`] = k[base.split(".")[1]];
      if (m === "intraday") { out[`${lens}.score_floor`] = k.score_floor; out[`${lens}.score_window`] = k.score_window; }
    }
    out[`${lens}.enabled`] = st.switches[lens] !== false;
  } catch { /* none */ }
  return out;
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
    "omega.live_arm_required": true,
    // The strategy arm (RFC §10, owner 2026-11-17): live → an entry needs an armed strategy or the AUTO pick.
    "omega.strategy_arm_required": strategyArmMode(env) === "live",
    "omega.max_armed_strategies": ARM_MAX,
    ...(await profileFacts(env, settings))
  };
}

/**
 * ADR-0020 Amendment 10: the doctrine bounds risk per profile. Per profile the limits an entry is sized within under the
 * settings in force (`omega.risk_pct_<profile>`, `omega.max_daily_loss_pct_<profile>`, `omega.max_positions_<profile>`,
 * effectiveLimits), the account's profile (`omega.profile`) and the limits in force for it (`omega.effective_*`). The
 * account is the one the last bridge state names, else the one seen last; with no account seen the profile and
 * effective facts are left out. Never the account reference.
 */
export async function profileFacts(env, settings) {
  const out = {};
  for (const id of PROFILE_IDS) {
    const lim = effectiveLimits(id, settings);
    out[`omega.risk_pct_${id}`] = lim.risk_pct;
    out[`omega.max_daily_loss_pct_${id}`] = lim.max_daily_loss_pct;
    out[`omega.max_positions_${id}`] = lim.max_positions;
  }
  try {
    if (!env?.DB) return out;
    const accounts = await readAccounts(env.DB);
    let state = null;
    try { state = JSON.parse((await env.DB.prepare("SELECT state FROM omega_bridge WHERE id = 1").first())?.state ?? "null"); } catch { state = null; }
    const acct = (state ? await connectedAccount(accounts, state) : null)
      ?? [...accounts].sort((a, b) => Number(b.last_seen_ms ?? 0) - Number(a.last_seen_ms ?? 0))[0] ?? null;
    if (!acct || !PROFILES[acct.profile]) return out;
    const lim = effectiveLimits(acct.profile, settings);
    out["omega.profile"] = acct.profile;
    out["omega.effective_risk_pct"] = lim.risk_pct;
    out["omega.effective_max_daily_loss_pct"] = lim.max_daily_loss_pct;
    out["omega.effective_max_positions"] = lim.max_positions;
  } catch { /* the per-profile facts stand without the account */ }
  return out;
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
