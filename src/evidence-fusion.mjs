import { filterRecentUniqueArticles, NEWS_LOOKBACK_MS } from "./news-filter.mjs";
export const EVIDENCE_CONTRACT_VERSION = "cryptophys.evidence-fusion.v1";
export const LOCAL_CALCULATION_CONTRACT_VERSION = "cryptophys.local-calculation.v1";
export const WEBHOOK_EVIDENCE_CONTRACT_VERSION = "cryptophys.webhook-evidence.v1";
export const NEWS_ANALYSIS_CONTRACT_VERSION = "cryptophys.completed-news-analysis.v1";
export const LOCAL_ENGINES = Object.freeze(["mizan", "prophet", "gmi"]);
export const NEWS_MAX_AGE_MS = 75 * 60 * 1000;
export const LOCAL_CALC_MAX_AGE_MS = 30 * 60 * 1000;
// Provisional acceptance policy: must be reviewed against the deployed candle-time semantics before production.
export const CANDLE_MAX_AGE_MS_BY_TIMEFRAME = Object.freeze({
  M1: 5 * 60 * 1000,
  M5: 15 * 60 * 1000,
  M15: 45 * 60 * 1000,
  M30: 90 * 60 * 1000,
  H1: 3 * 60 * 60 * 1000,
  H2: 6 * 60 * 60 * 1000,
  H4: 12 * 60 * 60 * 1000,
  D1: 72 * 60 * 60 * 1000,
  W1: 14 * 24 * 60 * 60 * 1000
});
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const TIMEFRAME_ALIASES = Object.freeze({
  "1": "M1", "1M": "M1", "M1": "M1",
  "5": "M5", "5M": "M5", "M5": "M5",
  "15": "M15", "15M": "M15", "M15": "M15",
  "30": "M30", "30M": "M30", "M30": "M30",
  "60": "H1", "60M": "H1", "1H": "H1", "H1": "H1",
  "120": "H2", "120M": "H2", "2H": "H2", "H2": "H2",
  "240": "H4", "240M": "H4", "4H": "H4", "H4": "H4",
  "D": "D1", "1D": "D1", "D1": "D1",
  "W": "W1", "1W": "W1", "W1": "W1"
});


export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCredentialField(key) {
  const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return /(^|_)(secret|password|credential|authorization|api_key|private_key|access_token|refresh_token|token|bearer)(_|$)/i.test(normalized);
}

export function containsCredentialFields(value, depth = 0) {
  if (depth > 20) return true;
  if (Array.isArray(value)) return value.some(item => containsCredentialFields(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => isCredentialField(key) || containsCredentialFields(child, depth + 1));
}

export function stripCredentialFields(value, depth = 0) {
  if (depth > 20) return null;
  if (Array.isArray(value)) return value.map(item => stripCredentialFields(item, depth + 1));
  if (!isRecord(value)) return value;
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (!isCredentialField(key)) clean[key] = stripCredentialFields(child, depth + 1);
  }
  return clean;
}

export function timestampMs(value) {
  // TradingView alerts send `time` via str.tostring(time): epoch milliseconds
  // as a digit string (e.g. "1793656800000"). Accept epoch ms/seconds strings
  // and numbers as well as ISO-8601.
  if (typeof value === "number") return Number.isFinite(value) ? (Math.abs(value) < 1e11 ? value * 1000 : value) : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (/^\d{10}$/.test(text)) return Number(text) * 1000;
  if (/^\d{12,13}$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function symbolKey(value) {
  return typeof value === "string" ? value.trim().toUpperCase().split(":").pop() : "";
}

export function timeframeKey(value) {
  if (typeof value !== "string") return "";
  const raw = value.trim().toUpperCase();
  return TIMEFRAME_ALIASES[raw] || "";
}

/**
 * Whether a webhook on this timeframe may start the AI analysis chain.
 * ANALYSIS_TIMEFRAMES is a comma list (default "60" = H1 only). Webhooks on any
 * other timeframe (for example 5m or 15m parity comparators) are stored only:
 * they never run the Analyst -> Counselor -> Reasoner chain, the bus or Telegram.
 */
/** HUD comparator webhook sources (for example prophet_r38_hud) are stored for parity only. */
export function isHudSource(source) {
  return typeof source === "string" && source.endsWith("_hud");
}

export function analysisAllowedForTimeframe(timeframe, configured = "60") {
  const key = timeframeKey(String(timeframe ?? ""));
  if (!key) return false;
  const allowed = String(configured || "60").split(",").map(v => timeframeKey(v.trim())).filter(Boolean);
  return allowed.includes(key);
}

export function deriveCandleKey(symbol, timeframe, candleTime) {
  return [symbol, timeframe, candleTime].map((part) => String(part ?? "").trim()).join(":");
}

const TIMEFRAME_MINUTES = Object.freeze({ M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H2: 120, H4: 240, D1: 1440 });

/**
 * staleFrom "now" (ingest): the record must be at most LOCAL_CALC_MAX_AGE_MS old now.
 * staleFrom "candle_close" (fusion): the record must have been computed within
 * LOCAL_CALC_MAX_AGE_MS of its candle's close, however late the analysis runs. A record
 * of candle X stays valid evidence for candle X when the analysis is retried or
 * backfilled after a Workers AI timeout; candle_key equality still binds it to X.
 */
export function validateLocalCalculation(payload, expected = {}, now = Date.now(), { staleFrom = "now" } = {}) {
  const errors = [];
  if (!isRecord(payload)) return { valid: false, errors: ["payload_must_be_object"] };
  if (payload.schema_version !== LOCAL_CALCULATION_CONTRACT_VERSION) errors.push("unsupported_schema_version");
  if (!LOCAL_ENGINES.includes(payload.engine)) errors.push("unsupported_engine");
  if (typeof payload.symbol !== "string" || !payload.symbol.trim()) errors.push("symbol_required");
  if (typeof payload.timeframe !== "string" || !payload.timeframe.trim()) errors.push("timeframe_required");
  if (!timestampMs(payload.candle_time)) errors.push("candle_time_must_be_parseable_timestamp");
  if (!timestampMs(payload.computed_at)) errors.push("computed_at_must_be_parseable_timestamp");
  if (typeof payload.candle_key !== "string" || !payload.candle_key.trim()) errors.push("candle_key_required");
  if (typeof payload.calculation_version !== "string" || !payload.calculation_version.trim()) errors.push("calculation_version_required");
  if (!isRecord(payload.values)) errors.push("values_must_be_object");
  if (!isRecord(payload.provenance)) errors.push("provenance_must_be_object");
  else {
    if (typeof payload.provenance.source !== "string" || !payload.provenance.source.trim()) errors.push("provenance_source_required");
    if (typeof payload.provenance.source_hash !== "string" || !/^[a-f0-9]{64}$/i.test(payload.provenance.source_hash)) errors.push("provenance_source_hash_must_be_sha256");
    if (typeof payload.provenance.implementation_hash !== "string" || !/^[a-f0-9]{64}$/i.test(payload.provenance.implementation_hash)) errors.push("provenance_implementation_hash_must_be_sha256");
  }
  if (isRecord(payload.values) && Object.keys(payload.values).length === 0) errors.push("values_must_not_be_empty");
  if (isRecord(payload.values)) {
    for (const [key, value] of Object.entries(payload.values)) {
      if (!key || (typeof value === "number" && !Number.isFinite(value))) {
        errors.push("values_contain_invalid_field");
        break;
      }
    }
  }
  const candleAt = timestampMs(payload.candle_time);
  const computedAt = timestampMs(payload.computed_at);
  if (candleAt !== null && candleAt > now + FUTURE_CLOCK_SKEW_MS) errors.push("candle_time_in_future");
  if (computedAt !== null && computedAt > now + FUTURE_CLOCK_SKEW_MS) errors.push("computed_at_in_future");
  const tfMinutes = TIMEFRAME_MINUTES[timeframeKey(payload.timeframe)];
  const staleReference = staleFrom === "candle_close" && candleAt !== null && tfMinutes ? candleAt + tfMinutes * 60_000 : now;
  if (computedAt !== null && staleReference - computedAt > LOCAL_CALC_MAX_AGE_MS) errors.push("calculation_stale");
  if (staleFrom === "candle_close" && computedAt !== null && staleReference !== now && computedAt - staleReference > LOCAL_CALC_MAX_AGE_MS) errors.push("calculation_stale");
  if (computedAt !== null && candleAt !== null && computedAt < candleAt - FUTURE_CLOCK_SKEW_MS) errors.push("calculation_predates_candle");
  if (expected.symbol && symbolKey(payload.symbol) !== symbolKey(expected.symbol)) errors.push("symbol_mismatch");
  if (expected.timeframe && timeframeKey(payload.timeframe) !== timeframeKey(expected.timeframe)) errors.push("timeframe_mismatch");
  if (expected.candle_key && payload.candle_key !== expected.candle_key) errors.push("candle_key_mismatch");
  if (expected.candle_time && timestampMs(payload.candle_time) !== timestampMs(expected.candle_time)) errors.push("candle_time_mismatch");
  return { valid: errors.length === 0, errors };
}

function validateNewsAnalysis(newsAnalysis, expectedSymbol, now) {
  const errors = [];
  if (!isRecord(newsAnalysis)) return { valid: false, errors: ["completed_news_analysis_missing"] };
  if (newsAnalysis.schema_version !== NEWS_ANALYSIS_CONTRACT_VERSION) errors.push("completed_news_analysis_schema_invalid");
  if (newsAnalysis.status !== "ok" || newsAnalysis.analysis_type !== "fundamental_news") errors.push("completed_news_analysis_invalid_status");
  const analyzedAt = timestampMs(newsAnalysis.analyzed_at);
  const fetchedAt = timestampMs(newsAnalysis.fetched_at);
  if (analyzedAt === null) errors.push("news_analyzed_at_missing_or_invalid");
  else if (analyzedAt > now + FUTURE_CLOCK_SKEW_MS) errors.push("news_analysis_timestamp_in_future");
  else if (now - analyzedAt > NEWS_MAX_AGE_MS) errors.push("news_analysis_stale");
  if (fetchedAt === null) errors.push("news_fetched_at_missing_or_invalid");
  else if (fetchedAt > now + FUTURE_CLOCK_SKEW_MS) errors.push("news_fetch_timestamp_in_future");
  else if (now - fetchedAt > NEWS_MAX_AGE_MS) errors.push("news_evidence_stale");
  const evidence = isRecord(newsAnalysis.evidence) ? newsAnalysis.evidence : null;
  if (!evidence || !Array.isArray(evidence.articles) || evidence.articles.length === 0) {
    errors.push("news_articles_missing");
  } else {
    // Validate the underlying article publication times, not just the time at which
    // an old digest was analyzed or fetched. Historical rows fail closed.
    const referenceTime = Number.isFinite(fetchedAt) ? fetchedAt : now;
    const recentUniqueArticles = filterRecentUniqueArticles(evidence.articles, referenceTime, NEWS_LOOKBACK_MS);
    if (recentUniqueArticles.length !== evidence.articles.length) {
      errors.push("news_articles_outside_lookback_or_duplicate");
    }
  }
  const symbols = Array.isArray(newsAnalysis.symbols) ? newsAnalysis.symbols : (Array.isArray(evidence?.symbols) ? evidence.symbols : []);
  if (!symbols.some((symbol) => symbolKey(symbol) === symbolKey(expectedSymbol))) errors.push("news_symbol_not_covered");
  return { valid: errors.length === 0, errors };
}

/** The three indicator sources and the local engine whose parity-approved output reproduces each. */
export const INDICATOR_SOURCES = Object.freeze({ prophet_r38: "prophet", prophet_r37_ssot: "prophet", gmi_v12_70: "gmi" });

/**
 * Indicator payloads for the AI chain, derived from parity-approved local records
 * (local-primary architecture, owner decision 2026-11-05). The comparable fields are
 * exactly the TradingView alert fields, so every consumer reads them unchanged;
 * `origin` marks that they were computed locally, never by a webhook.
 */
export function indicatorPayloadsFromLocal(localCalculations, { symbol, timeframe, candleKey } = {}) {
  const byEngine = {};
  for (const item of Array.isArray(localCalculations) ? localCalculations : []) {
    if (isRecord(item) && LOCAL_ENGINES.includes(item.engine) && !byEngine[item.engine]) byEngine[item.engine] = item;
  }
  const out = {};
  for (const [source, engine] of Object.entries(INDICATOR_SOURCES)) {
    const record = byEngine[engine];
    const fields = record?.values?.comparable?.[source];
    if (!isRecord(fields)) continue;
    const candle = isRecord(record.values.candle) ? record.values.candle : {};
    out[source] = {
      schema_version: WEBHOOK_EVIDENCE_CONTRACT_VERSION,
      origin: "local_computation",
      trust_status: record.trust_status ?? null,
      source, ticker: symbol ?? record.symbol, symbol: symbol ?? record.symbol,
      timeframe: timeframe ?? record.timeframe, candle_time: record.candle_time, candle_key: candleKey ?? record.candle_key,
      o: candle.o, h: candle.h, l: candle.l, c: candle.c, volume: candle.volume,
      ...fields
    };
  }
  return out;
}

export function buildEvidenceFusion(input, now = Date.now()) {
  const { candleKey, symbol, timeframe, candleTime, webhookPayloads = {}, localCalculations = [], newsAnalysis = null, informational5mContext = null, webhookLane = "required" } = input || {};
  // webhookLane "calibration": TradingView webhooks only calibrate the local engines
  // (parity registry). They are neither required nor validated as decision evidence.
  const calibrationOnly = webhookLane === "calibration";
  const missing = [];
  const errors = [];
  const candleTimeMs = timestampMs(candleTime);
  if (candleTimeMs === null) errors.push("candle_time_invalid");
  else {
    if (candleTimeMs > now + FUTURE_CLOCK_SKEW_MS) errors.push("candle_time_in_future");
    const tf = timeframeKey(timeframe);
    const maxAgeMs = CANDLE_MAX_AGE_MS_BY_TIMEFRAME[tf];
    if (!maxAgeMs) errors.push("timeframe_freshness_policy_unsupported");
    else if (candleTimeMs <= now && now - candleTimeMs > maxAgeMs) errors.push("candle_stale");
  }
  const webhookSources = ["prophet_r38", "prophet_r37_ssot", "gmi_v12_70"];
  for (const source of calibrationOnly ? [] : webhookSources) {
    const payload = webhookPayloads[source];
    if (!isRecord(payload)) {
      missing.push("webhook:" + source);
      continue;
    }
    if (payload.schema_version !== WEBHOOK_EVIDENCE_CONTRACT_VERSION) errors.push("webhook_schema_invalid:" + source);
    if (symbolKey(payload.ticker || payload.symbol) !== symbolKey(symbol)) errors.push("webhook_symbol_mismatch:" + source);
    if (!timeframeKey(timeframe) || !CANDLE_MAX_AGE_MS_BY_TIMEFRAME[timeframeKey(timeframe)]) errors.push("timeframe_freshness_policy_unsupported");
    if (timeframeKey(payload.timeframe) !== timeframeKey(timeframe)) errors.push("webhook_timeframe_mismatch:" + source);
    const sourceCandleAt = timestampMs(payload.candle_time || payload.timestamp);
    if (sourceCandleAt !== timestampMs(candleTime)) errors.push("webhook_candle_time_mismatch:" + source);
    if (sourceCandleAt !== null && timeframeKey(timeframe) && CANDLE_MAX_AGE_MS_BY_TIMEFRAME[timeframeKey(timeframe)] && now - sourceCandleAt > CANDLE_MAX_AGE_MS_BY_TIMEFRAME[timeframeKey(timeframe)]) errors.push("candle_stale");
  }

  const calculationByEngine = {};
  for (const item of Array.isArray(localCalculations) ? localCalculations : []) {
    const engine = item?.engine;
    if (!LOCAL_ENGINES.includes(engine)) {
      errors.push("local_calculation_engine_invalid");
      continue;
    }
    if (calculationByEngine[engine]) {
      errors.push("duplicate_local_calculation:" + engine);
      continue;
    }
    const validation = validateLocalCalculation(item, { symbol, timeframe, candle_key: candleKey, candle_time: candleTime }, now, { staleFrom: "candle_close" });
    if (!validation.valid) {
      errors.push(...validation.errors.map((error) => "local_calculation:" + engine + ":" + error));
      continue;
    }
    calculationByEngine[engine] = item;
  }
  for (const engine of LOCAL_ENGINES) {
    if (!calculationByEngine[engine]) missing.push("local_calculation:" + engine);
  }

  const newsValidation = validateNewsAnalysis(newsAnalysis, symbol, now);
  if (!newsValidation.valid) {
    missing.push("fundamental_news_analysis");
    errors.push(...newsValidation.errors.map((error) => "news:" + error));
  }

  const complete = missing.length === 0 && errors.length === 0;
  // Three separate input lanes. Values are never merged or relabelled across
  // lanes: TradingView-computed indicator outputs (webhook) stay distinct from
  // locally computed outputs (raw TradingView OHLCV -> local engines).
  const presentWebhooks = webhookSources.filter((source) => isRecord(webhookPayloads[source]));
  const presentEngines = LOCAL_ENGINES.filter((engine) => calculationByEngine[engine]);
  const inputLanes = {
    tradingview_webhook: {
      lane_id: "tradingview_webhook",
      computed_by: "TradingView: installed Pine indicators, delivered by alert webhook",
      role: calibrationOnly ? "calibration_only" : "decision_evidence",
      required_sources: calibrationOnly ? [] : [...webhookSources],
      present_sources: presentWebhooks,
      missing_sources: webhookSources.filter((source) => !presentWebhooks.includes(source)),
      complete: presentWebhooks.length === webhookSources.length && !errors.some((error) => error.startsWith("webhook_"))
    },
    local_computation: {
      lane_id: "local_computation",
      computed_by: "Local Mizan/Prophet/GMI engines from raw TradingView OHLCV (TradingView MCP)",
      required_engines: [...LOCAL_ENGINES],
      present_engines: presentEngines,
      missing_engines: LOCAL_ENGINES.filter((engine) => !presentEngines.includes(engine)),
      calculation_versions: Object.fromEntries(presentEngines.map((engine) => [engine, calculationByEngine[engine].calculation_version])),
      complete: presentEngines.length === LOCAL_ENGINES.length && !errors.some((error) => error.startsWith("local_calculation"))
    },
    fundamental_news: {
      lane_id: "fundamental_news",
      computed_by: "News ingestion (TradingView MCP news) and completed fundamental news analysis",
      present: newsValidation.valid,
      analyzed_at: newsValidation.valid ? newsAnalysis.analyzed_at ?? null : null,
      complete: newsValidation.valid
    }
  };
  return {
    schema_version: EVIDENCE_CONTRACT_VERSION,
    status: complete ? "ready" : "degraded",
    complete,
    candle_key: candleKey,
    symbol,
    timeframe,
    candle_time: candleTime,
    fused_at: new Date(now).toISOString(),
    input_lanes: inputLanes,
    webhook_sources: presentWebhooks,
    local_calculations: calculationByEngine,
    fundamental_news_analysis: newsValidation.valid ? newsAnalysis : null,
    informational_5m_context: informational5mContext && typeof informational5mContext === "object" ? informational5mContext : null,
    missing_evidence: [...new Set(missing)],
    validation_errors: [...new Set(errors)]
  };
}
