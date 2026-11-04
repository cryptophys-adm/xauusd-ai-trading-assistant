const SCHEMA_VERSION = "cryptophys.local-context.v1";
const TRUST_STATUS = "informational_unverified";
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const CANDLE_MAX_AGE_MS = 15 * 60 * 1000;
const RECEIVED_MAX_AGE_MS = 10 * 60 * 1000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateM5Context(payload, now = Date.now()) {
  const errors = [];
  if (!isRecord(payload)) return { valid: false, errors: ["payload_must_be_object"] };
  if (payload.schema_version !== SCHEMA_VERSION) errors.push("invalid_schema_version");
  if (payload.trust_status !== TRUST_STATUS) errors.push("invalid_trust_status");
  if (typeof payload.symbol !== "string" || !payload.symbol.trim()) errors.push("missing_symbol");
  if (payload.timeframe !== "5") errors.push("timeframe_must_be_5");
  const candleAt = Date.parse(String(payload.candle_time ?? ""));
  if (!Number.isFinite(candleAt)) errors.push("candle_time_invalid");
  else if (candleAt > now + FUTURE_SKEW_MS) errors.push("candle_time_in_future");
  return { valid: errors.length === 0, errors };
}

export function freshM5Context(stored, now = Date.now()) {
  if (!isRecord(stored)) return null;
  const validation = validateM5Context(stored, now);
  if (!validation.valid) return null;
  const candleAt = Date.parse(String(stored.candle_time ?? ""));
  const receivedAt = Date.parse(String(stored.received_at ?? ""));
  if (!Number.isFinite(candleAt) || !Number.isFinite(receivedAt)) return null;
  if (now - candleAt > CANDLE_MAX_AGE_MS) return null;
  if (now - receivedAt > RECEIVED_MAX_AGE_MS) return null;
  return stored;
}

export const internals = { validateM5Context, freshM5Context, CANDLE_MAX_AGE_MS, RECEIVED_MAX_AGE_MS };
