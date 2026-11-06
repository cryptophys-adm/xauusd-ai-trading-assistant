// Phase C2 (AI Worker side): HUD snapshots from the pull adapter, stored per candle,
// and their plain-language readings with per-field verification.
//
// A snapshot arrives over the LocalComputationIngress RPC (submitHud). It is evidence
// for the HUD agents only: it never enters the H1 decision lane or the evidence fusion.
// Verification is decided here, at read time, against the parity-approved local record
// of the same candle (localcalc:<candle_key>:prophet|gmi): a HUD field is verified only
// when it equals that record. Everything else reads as not yet calibrated.
import { containsCredentialFields } from "./evidence-fusion.mjs";
import { readHud, verifiedFields, HUD_IDS } from "./hud-reading.mjs";

export const HUD_SNAPSHOT_VERSION = "cryptophys.hud-snapshot.v1";
export const HUD_TIMEFRAMES = Object.freeze(["60", "15", "240", "1D"]);
const KEY = /^OANDA:XAUUSD:(60|15|240|1D):\d{12,13}$/;
const MAX_AGE_MS = 30 * 60 * 1000;
const MAX_BYTES = 64 * 1024;
const TTL = { expirationTtl: 60 * 60 * 24 * 14 };
const LATEST_TTL = { expirationTtl: 60 * 60 * 3 };

const isRecord = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function validateHudSnapshot(p, now = Date.now()) {
  const errors = [];
  if (!isRecord(p)) return { valid: false, errors: ["payload_must_be_object"] };
  if (p.schema_version !== HUD_SNAPSHOT_VERSION) errors.push("unsupported_schema_version");
  if (!HUD_TIMEFRAMES.includes(p.timeframe)) errors.push("unsupported_timeframe");
  if (typeof p.candle_key !== "string" || !KEY.test(p.candle_key) || p.candle_key.split(":")[2] !== p.timeframe) errors.push("candle_key_invalid");
  const computedAt = Date.parse(p.computed_at ?? "");
  if (!Number.isFinite(computedAt)) errors.push("computed_at_invalid");
  else if (computedAt > now + 5 * 60 * 1000) errors.push("computed_at_in_future");
  else if (now - computedAt > MAX_AGE_MS) errors.push("snapshot_stale");
  if (!isRecord(p.huds) || !Object.keys(p.huds).every((id) => HUD_IDS.includes(id) && isRecord(p.huds[id]?.fields))) errors.push("huds_invalid");
  if (containsCredentialFields(p)) errors.push("credential_fields_not_permitted");
  if (JSON.stringify(p).length > MAX_BYTES) errors.push("snapshot_too_large");
  return { valid: errors.length === 0, errors };
}

export async function storeHudSnapshot(env, p, now = Date.now()) {
  const validation = validateHudSnapshot(p, now);
  if (!validation.valid) return { status: 400, body: { error: validation.errors[0], validation_errors: validation.errors } };
  const kv = env.SIGNAL_CACHE;
  if (!kv || typeof kv.put !== "function") return { status: 503, body: { error: "kv_not_configured" } };
  const stored = { ...p, received_at: new Date(now).toISOString() };
  await kv.put(`hud:${p.timeframe}:${p.candle_key}`, JSON.stringify(stored), TTL);
  await kv.put(`hud:${p.timeframe}:latest`, JSON.stringify(stored), LATEST_TTL);
  return { status: 202, body: { status: "accepted", candle_key: p.candle_key, timeframe: p.timeframe } };
}

export async function loadHudSnapshot(env, { timeframe = "60", candleKey = null } = {}) {
  const raw = await env.SIGNAL_CACHE?.get?.(candleKey ? `hud:${timeframe}:${candleKey}` : `hud:${timeframe}:latest`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** The approved comparable fields of a candle (prophet_r38, prophet_r37_ssot, gmi_v12_70), or null. */
export async function approvedComparable(env, candleKey) {
  const out = {};
  for (const engine of ["prophet", "gmi"]) {
    const raw = await env.WEBHOOK_BUFFER?.get?.("localcalc:" + candleKey + ":" + engine);
    if (!raw) continue;
    try { Object.assign(out, JSON.parse(raw)?.values?.comparable || {}); } catch { /* malformed record is ignored */ }
  }
  return Object.keys(out).length ? out : null;
}

/** Readings for every HUD of a snapshot, with verification against the approved record. */
export async function hudReadings(env, snapshot) {
  if (!isRecord(snapshot?.huds)) return null;
  const approved = await approvedComparable(env, snapshot.candle_key);
  const readings = {};
  for (const id of HUD_IDS) {
    const hud = snapshot.huds[id];
    if (!hud) continue;
    readings[id] = readHud(id, { ...hud, verified: verifiedFields(hud, approved) });
  }
  return {
    candle_key: snapshot.candle_key,
    timeframe: snapshot.timeframe,
    computed_at: snapshot.computed_at,
    verified_against_approved_record: Boolean(approved),
    not_computed: Array.isArray(snapshot.not_computed) ? snapshot.not_computed : [],
    readings
  };
}
