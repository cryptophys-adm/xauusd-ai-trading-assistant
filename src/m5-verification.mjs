// C0 step 4: the 5m execution data is labelled verified only while the 5m
// implementations are parity-approved on the 5m chart (registry ids
// prophet_m5 and gmi_m5, earned through 24 consecutive matching 5m candles).
// The verified reading is the observed local record of that 5m bar computed by
// an approved implementation, exactly like the trusted H1 local_computation
// lane. Otherwise the 5m data stays UNVERIFIED. The label switches by itself.
import { identityOf, isTrusted, ensureSchema } from "./parity-registry.mjs";
import { interpretWebhooks } from "./webhook-interpretation.mjs";

export const M5_VERIFIED_LABEL = "VERIFIED 5m";
export const M5_UNVERIFIED_LABEL = "UNVERIFIED 5m";
const OBSERVED_PREFIX = "localcalc-observed:";
const M5_MS = 5 * 60 * 1000;

function parse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** 5m webhook candle key for the 5m bar that closes at closeIso. */
export function m5CandleKeyForClose(closeIso, symbol = "OANDA:XAUUSD") {
  const closeMs = Date.parse(closeIso);
  return Number.isFinite(closeMs) ? `${symbol}:5:${closeMs - M5_MS}` : null;
}

/**
 * Verified 5m reading for the bar that closes at closeIso, or
 * { verified: false, reason } when no approved 5m record exists for it.
 */
export async function verifiedM5Reading(env, closeIso) {
  const candleKey = m5CandleKeyForClose(closeIso);
  if (!candleKey || !env?.WEBHOOK_BUFFER || !env?.DB) return { verified: false, reason: "unavailable" };
  const [prophet, gmi] = await Promise.all(["prophet", "gmi"].map(async engine => parse(await env.WEBHOOK_BUFFER.get(OBSERVED_PREFIX + candleKey + ":" + engine))));
  if (!prophet || !gmi) return { verified: false, reason: "no_local_5m_record", candle_key: candleKey };
  const ids = [identityOf(prophet), identityOf(gmi)];
  if (ids.some(id => !id || !id.engine.endsWith("_m5"))) return { verified: false, reason: "not_a_5m_identity", candle_key: candleKey };
  await ensureSchema(env.DB);
  const trusted = await Promise.all(ids.map(id => isTrusted(env.DB, id)));
  if (!trusted.every(Boolean)) return { verified: false, reason: "m5_parity_not_approved", candle_key: candleKey };
  // The verified comparable fields are the webhook fields (same names, same codes),
  // so the H1 plain-language reading applies unchanged.
  const reading = interpretWebhooks({
    prophetR38: prophet.values?.comparable?.prophet_r38,
    prophetR37: prophet.values?.comparable?.prophet_r37_ssot,
    gmi: gmi.values?.comparable?.gmi_v12_70
  });
  return {
    verified: true,
    candle_key: candleKey,
    bias: reading.bias,
    summary: String(reading.summary || "").replace(/the TradingView indicators/gi, "the verified 5m indicators"),
    lines: reading.lines
  };
}

/** Whether both 5m implementations currently hold an approved registry row. */
export async function m5ParityApproved(db) {
  if (!db) return false;
  try {
    const row = await db.prepare(
      "SELECT SUM(CASE WHEN engine = 'prophet_m5' THEN 1 ELSE 0 END) AS prophet, SUM(CASE WHEN engine = 'gmi_m5' THEN 1 ELSE 0 END) AS gmi FROM engine_parity_registry WHERE status = 'approved'"
    ).first();
    return Number(row?.prophet) > 0 && Number(row?.gmi) > 0;
  } catch {
    return false;
  }
}
