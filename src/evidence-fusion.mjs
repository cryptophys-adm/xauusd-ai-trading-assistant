export const EVIDENCE_CONTRACT_VERSION = "cryptophys.evidence-fusion.v1";
export const LOCAL_CALCULATION_CONTRACT_VERSION = "cryptophys.local-calculation.v1";
export const WEBHOOK_EVIDENCE_CONTRACT_VERSION = "cryptophys.webhook-evidence.v1";
export const NEWS_ANALYSIS_CONTRACT_VERSION = "cryptophys.completed-news-analysis.v1";
export const LOCAL_ENGINES = Object.freeze(["mizan", "prophet", "gmi"]);
export const NEWS_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const LOCAL_CALC_MAX_AGE_MS = 30 * 60 * 1000;
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const CANDLE_INTERVAL_MS = Object.freeze({
  M1: 60_000, M5: 5 * 60_000, M15: 15 * 60_000, M30: 30 * 60_000,
  H1: 60 * 60_000, H4: 4 * 60 * 60_000, D1: 24 * 60 * 60_000,
  W1: 7 * 24 * 60 * 60_000
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestampMs(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function symbolKey(value) {
  return typeof value === "string" ? value.trim().toUpperCase().split(":").pop() : "";
}

function timeframeKey(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function deriveCandleKey(symbol, timeframe, candleTime) {
  return [symbol, timeframe, candleTime].map((part) => String(part ?? "").trim()).join(":");
}

export function validateLocalCalculation(payload, expected = {}, now = Date.now()) {
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
    if (typeof payload.provenance.source_hash !== "string" || !payload.provenance.source_hash.trim()) errors.push("provenance_source_hash_required");
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
  if (computedAt !== null && computedAt > now + FUTURE_CLOCK_SKEW_MS) errors.push("computed_at_in_future");
  if (computedAt !== null && now - computedAt > LOCAL_CALC_MAX_AGE_MS) errors.push("calculation_stale");
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
  if (!evidence || !Array.isArray(evidence.articles) || evidence.articles.length === 0) errors.push("news_articles_missing");
  const symbols = Array.isArray(newsAnalysis.symbols) ? newsAnalysis.symbols : (Array.isArray(evidence?.symbols) ? evidence.symbols : []);
  if (!symbols.some((symbol) => symbolKey(symbol) === symbolKey(expectedSymbol))) errors.push("news_symbol_not_covered");
  return { valid: errors.length === 0, errors };
}

export function buildEvidenceFusion(input, now = Date.now()) {
  const { candleKey, symbol, timeframe, candleTime, webhookPayloads = {}, localCalculations = [], newsAnalysis = null } = input || {};
  const missing = [];
  const errors = [];
  const candleTimeMs = timestampMs(candleTime);
  if (candleTimeMs === null) errors.push("candle_time_invalid");
  else {
    if (candleTimeMs > now + FUTURE_CLOCK_SKEW_MS) errors.push("candle_time_in_future");
    const tf = timeframeKey(timeframe);
    const intervalMs = CANDLE_INTERVAL_MS[tf];
    if (!intervalMs) errors.push("timeframe_freshness_policy_unsupported");
    else if (candleTimeMs <= now && now - candleTimeMs > intervalMs * 2) errors.push("candle_stale");
  }
  const webhookSources = ["prophet_r38", "prophet_r37_ssot", "gmi_v12_70"];
  for (const source of webhookSources) {
    const payload = webhookPayloads[source];
    if (!isRecord(payload)) {
      missing.push("webhook:" + source);
      continue;
    }
    if (payload.schema_version !== WEBHOOK_EVIDENCE_CONTRACT_VERSION) errors.push("webhook_schema_invalid:" + source);
    if (symbolKey(payload.ticker || payload.symbol) !== symbolKey(symbol)) errors.push("webhook_symbol_mismatch:" + source);
    if (timeframeKey(payload.timeframe) !== timeframeKey(timeframe)) errors.push("webhook_timeframe_mismatch:" + source);
    if (timestampMs(payload.candle_time || payload.timestamp) !== timestampMs(candleTime)) errors.push("webhook_candle_time_mismatch:" + source);
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
    const validation = validateLocalCalculation(item, { symbol, timeframe, candle_key: candleKey, candle_time: candleTime }, now);
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
  return {
    schema_version: EVIDENCE_CONTRACT_VERSION,
    status: complete ? "ready" : "degraded",
    complete,
    candle_key: candleKey,
    symbol,
    timeframe,
    candle_time: candleTime,
    fused_at: new Date(now).toISOString(),
    webhook_sources: webhookSources.filter((source) => isRecord(webhookPayloads[source])),
    local_calculations: calculationByEngine,
    fundamental_news_analysis: newsValidation.valid ? newsAnalysis : null,
    missing_evidence: [...new Set(missing)],
    validation_errors: [...new Set(errors)]
  };
}
