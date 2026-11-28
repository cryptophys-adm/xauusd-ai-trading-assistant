// Phase C2 (AI Worker side): HUD snapshots from the pull adapter, stored per candle,
// and their plain-language readings with per-field verification.
//
// A snapshot arrives over the LocalComputationIngress RPC (submitHud). It is evidence
// for the HUD agents only: it never enters the H1 decision lane or the evidence fusion.
// Verification is decided here, at read time, against the trusted local record of the same
// candle (localcalc:<candle_key>:prophet|gmi): a HUD field is verified only when it equals
// that record. A statement that is a pure formula of closed bars reads as "computed from
// verified bars" when that trusted record was built on native bars (barsVerified, S2).
// Everything else reads as not yet calibrated.
import { containsCredentialFields, INGEST_ENGINES } from "./evidence-fusion.mjs";
import { PARITY_GROUPS } from "./parity-registry.mjs";
import { readHud, verifiedFields, HUD_IDS } from "./hud-reading.mjs";

export const HUD_SNAPSHOT_VERSION = "cryptophys.hud-snapshot.v1";
// ZF2 (owner 2026-11-26: "ZF2 snapshot Weekly"): "1W" (Pine v6 timeframe.period of the weekly chart, as "1D" is the
// daily's) is the weekly snapshot, read only by the zone typing (src/zone-types.mjs dsEvidence). It is optional: no
// room, council, health check or UI reads it, and a missing one means no weekly boxes, never an error.
export const HUD_TIMEFRAMES = Object.freeze(["60", "15", "240", "1D", "1W"]);
const KEY = /^OANDA:XAUUSD:(60|15|240|1D|1W):\d{12,13}$/;
const MAX_AGE_MS = 30 * 60 * 1000;
const MAX_BYTES = 64 * 1024;
const TTL = { expirationTtl: 60 * 60 * 24 * 14 };
// The latest snapshot per chart stays readable for at least one bar plus a margin (HT1, 2026-11-25): with one 3-hour TTL
// for every chart, the last hour of each 4H bar and most of each day read no 4H or 1D chart (found in the Z2 live replay).
// 15m and 1H keep 3 hours (several bars); 4H 5 hours (bar + 1h); 1D 26 hours (bar + 2h); 1W (ZF2) 8 days (bar + 1 day).
export const HUD_LATEST_TTL_S = Object.freeze({ "15": 60 * 60 * 3, "60": 60 * 60 * 3, "240": 60 * 60 * 5, "1D": 60 * 60 * 26, "1W": 60 * 60 * 24 * 8 });
/** The KV TTL (seconds) of hud:<timeframe>:latest. */
export const latestTtlSeconds = (timeframe) => HUD_LATEST_TTL_S[timeframe] ?? 60 * 60 * 3;

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
  // An unknown HUD id (a producer ahead of this Worker) is dropped, not a reason to reject the
  // snapshot: the known HUDs are kept and the dropped ids are listed (dropped_huds).
  const dropped = isRecord(p.huds) ? Object.keys(p.huds).filter((id) => !HUD_IDS.includes(id)) : [];
  if (!isRecord(p.huds) || !Object.keys(p.huds).every((id) => !HUD_IDS.includes(id) || isRecord(p.huds[id]?.fields))) errors.push("huds_invalid");
  if (containsCredentialFields(p)) errors.push("credential_fields_not_permitted");
  if (JSON.stringify(p).length > MAX_BYTES) errors.push("snapshot_too_large");
  return { valid: errors.length === 0, errors, ...(dropped.length ? { dropped_huds: dropped } : {}) };
}

/** The snapshot without its unknown HUD ids, which it lists in dropped_huds (none: the snapshot itself). */
function withoutUnknownHuds(p, dropped) {
  if (!dropped?.length) return p;
  const huds = Object.fromEntries(Object.entries(p.huds).filter(([id]) => !dropped.includes(id)));
  return { ...p, huds, dropped_huds: dropped };
}

export async function storeHudSnapshot(env, p, now = Date.now()) {
  const validation = validateHudSnapshot(p, now);
  if (!validation.valid) return { status: 400, body: { error: validation.errors[0], validation_errors: validation.errors } };
  const kv = env.SIGNAL_CACHE;
  if (!kv || typeof kv.put !== "function") return { status: 503, body: { error: "kv_not_configured" } };
  const dropped = validation.dropped_huds || [];
  if (dropped.length) console.warn("hud_snapshot_dropped_huds", p.timeframe, p.candle_key, dropped.join(","));
  const stored = { ...withoutUnknownHuds(p, dropped), received_at: new Date(now).toISOString() };
  await kv.put(`hud:${p.timeframe}:${p.candle_key}`, JSON.stringify(stored), TTL);
  await kv.put(`hud:${p.timeframe}:latest`, JSON.stringify(stored), { expirationTtl: latestTtlSeconds(p.timeframe) });
  return { status: 202, body: { status: "accepted", candle_key: p.candle_key, timeframe: p.timeframe, ...(dropped.length ? { dropped_huds: dropped } : {}) } };
}

export async function loadHudSnapshot(env, { timeframe = "60", candleKey = null } = {}) {
  const raw = await env.SIGNAL_CACHE?.get?.(candleKey ? `hud:${timeframe}:${candleKey}` : `hud:${timeframe}:latest`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * The approved comparable fields of a candle (prophet_r38, prophet_r37_ssot, gmi_v12_70), or null.
 * Merged per source and per field group (B7): a trusted group's copy (localcalc:<candle>:<group id>)
 * adds its own fields to its source, so they read as verified even while another group of the same
 * source, or the whole engine, is revoked. Only groups of an ingested engine are read (none today).
 */
export async function approvedComparable(env, candleKey, { groups = PARITY_GROUPS } = {}) {
  const out = {};
  const merge = (comparable) => {
    if (!isRecord(comparable)) { Object.assign(out, comparable); return; }
    for (const [source, fields] of Object.entries(comparable)) out[source] = isRecord(out[source]) && isRecord(fields) ? { ...out[source], ...fields } : fields;
  };
  // Only groups of an ingested engine (the decision lane since S4, 2026-11-28, which retired the gmi_hud copy and
  // the adoption records); no group is declared for one today.
  const groupIds = Object.keys(groups || {}).filter((id) => INGEST_ENGINES.includes(groups[id]?.engine));
  for (const key of ["prophet", "gmi", ...groupIds]) {
    const raw = await env.WEBHOOK_BUFFER?.get?.("localcalc:" + candleKey + ":" + key);
    if (!raw) continue;
    try { merge(JSON.parse(raw)?.values?.comparable || {}); } catch { /* malformed record is ignored */ }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * True when this candle's bars are verified: a trusted copy of a decision engine exists for the candle and
 * was built on native bars, not on the broker's during an MT5 fallback (parity removal S2, orchestrator
 * PR1 ruling 2: "trusted identity + native settled bar"). Native H1 and longer bars are published only
 * after they settle (market-data-ingestion SETTLE_SECONDS). Before S2 it needed a parity comparison of the
 * candle that matched and none that found the input bar different; of the 1,196 15m candles compared
 * 2026-11-03..27, 10 (all with an input-bar difference) read differently under this rule.
 */
export async function barsVerified(env, candleKey) {
  if (typeof candleKey !== "string" || !env?.WEBHOOK_BUFFER?.get) return false;
  for (const engine of ["prophet", "gmi"]) {
    const raw = await env.WEBHOOK_BUFFER.get("localcalc:" + candleKey + ":" + engine);
    if (!raw) continue;
    try {
      const record = JSON.parse(raw);
      if (record?.trust_status === "approved_by_parity" && record?.feed !== "mt5_fallback") return true;
    } catch { /* malformed copy is ignored */ }
  }
  return false;
}

/**
 * Prophet as one indicator (owner decision 2026-11-06): its own HUD plus, from the same snapshot,
 * the R38 signal and setup gate (computed for the R37 Funnel panel) and the R37 consensus
 * direction (carried by Trade Management as prophet_dir, equal to the R37 alert's direction in
 * production), each with its parity path so it is verified on its own.
 */
function prophetView(hud, huds) {
  const fields = { ...(hud.fields || {}) }, parity = { ...(hud.parity || {}) };
  const take = (source, keys) => {
    for (const k of keys) {
      if (source?.fields && k in source.fields && !(k in fields)) {
        fields[k] = source.fields[k];
        if (source.parity?.[k]) parity[k] = source.parity[k];
      }
    }
  };
  take(huds?.r37_funnel, ["buy_confirmed", "sell_confirmed", "buy_high_quality", "sell_high_quality", "gate_status"]);
  take(huds?.trade_management, ["prophet_dir"]);
  return { ...hud, fields, parity };
}

/** Readings for every HUD of a snapshot, with verification against the approved record. */
export async function hudReadings(env, snapshot) {
  if (!isRecord(snapshot?.huds)) return null;
  const approved = await approvedComparable(env, snapshot.candle_key);
  // Only a candle in the trusted lane (an approved record exists) can vouch for its bars.
  const bars = approved ? await barsVerified(env, snapshot.candle_key) : false;
  const readings = {};
  for (const id of HUD_IDS) {
    const hud = snapshot.huds[id];
    if (!hud) continue;
    const view = id === "prophet" ? prophetView(hud, snapshot.huds) : hud;
    readings[id] = readHud(id, { ...view, verified: verifiedFields(view, approved), bars_verified: bars });
  }
  return {
    candle_key: snapshot.candle_key,
    timeframe: snapshot.timeframe,
    computed_at: snapshot.computed_at,
    verified_against_approved_record: Boolean(approved),
    bars_verified: bars,
    not_computed: Array.isArray(snapshot.not_computed) ? snapshot.not_computed : [],
    ...(Array.isArray(snapshot.dropped_huds) && snapshot.dropped_huds.length ? { dropped_huds: snapshot.dropped_huds } : {}),
    readings
  };
}
