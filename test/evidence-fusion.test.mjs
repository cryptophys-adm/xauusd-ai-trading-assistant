import test from "node:test";
import assert from "node:assert/strict";
import { buildEvidenceFusion, validateLocalCalculation, containsCredentialFields, stripCredentialFields, LOCAL_CALCULATION_CONTRACT_VERSION, WEBHOOK_EVIDENCE_CONTRACT_VERSION, NEWS_ANALYSIS_CONTRACT_VERSION } from "../src/evidence-fusion.mjs";

const now = Date.parse("2026-11-01T15:00:00.000Z");
const candleTime = "2026-11-01T14:55:00.000Z";
const candleKey = "OANDA:XAUUSD:M5:" + candleTime;
const symbol = "OANDA:XAUUSD";
const timeframe = "M5";

function local(engine) {
  return {
    schema_version: LOCAL_CALCULATION_CONTRACT_VERSION,
    engine, symbol, timeframe, candle_time: candleTime, candle_key: candleKey,
    computed_at: "2026-11-01T14:59:00.000Z", calculation_version: engine + "-test-v1",
    values: { bias: "NEUTRAL", score: 0 }, provenance: { source: "test-fixture", source_hash: ({mizan:"a",prophet:"c",gmi:"e"})[engine].repeat(64), implementation_hash: ({mizan:"b",prophet:"d",gmi:"f"})[engine].repeat(64) }
  };
}
function webhook(source) {
  return { schema_version: WEBHOOK_EVIDENCE_CONTRACT_VERSION, source, ticker: symbol, timeframe, candle_time: candleTime, metrics: { bias: "NEUTRAL" } };
}
function news() {
  return {
    schema_version: NEWS_ANALYSIS_CONTRACT_VERSION, status: "ok", analysis_type: "fundamental_news", analyzed_at: "2026-11-01T14:58:00.000Z",
    fetched_at: "2026-11-01T14:57:00.000Z", symbols: [symbol],
    evidence: { articles: [{ id: "fixture-1", title: "Fixture article", published_at: "2026-11-01T14:30:00.000Z" }] },
    recommendation: { recommendation: "WAIT_FOR_TECHNICAL_CONFIRMATION" }
  };
}
function completeInput() {
  return {
    candleKey, symbol, timeframe, candleTime,
    webhookPayloads: {
      prophet_r38: webhook("prophet_r38"),
      prophet_r37_ssot: webhook("prophet_r37_ssot"),
      gmi_v12_70: webhook("gmi_v12_70")
    },
    localCalculations: [local("mizan"), local("prophet"), local("gmi")],
    newsAnalysis: news()
  };
}

test("accepts a complete same-candle evidence bundle", () => {
  const result = buildEvidenceFusion(completeInput(), now);
  assert.equal(result.status, "ready");
  assert.equal(result.complete, true);
  assert.deepEqual(result.missing_evidence, []);
  assert.equal(Object.keys(result.local_calculations).length, 3);
});

test("marks missing local calculations and news as degraded", () => {
  const input = completeInput();
  input.localCalculations = [local("mizan")];
  input.newsAnalysis = null;
  const result = buildEvidenceFusion(input, now);
  assert.equal(result.status, "degraded");
  assert.equal(result.complete, false);
  assert.ok(result.missing_evidence.includes("local_calculation:prophet"));
  assert.ok(result.missing_evidence.includes("local_calculation:gmi"));
  assert.ok(result.missing_evidence.includes("fundamental_news_analysis"));
});

test("rejects a mismatched candle identity", () => {
  const input = completeInput();
  input.localCalculations[0].candle_key = "different-candle";
  const result = buildEvidenceFusion(input, now);
  assert.equal(result.complete, false);
  assert.ok(result.validation_errors.includes("local_calculation:mizan:candle_key_mismatch"));
});

test("rejects stale local calculation output", () => {
  const payload = local("mizan");
  payload.computed_at = "2026-11-01T13:00:00.000Z";
  const result = validateLocalCalculation(payload, { symbol, timeframe, candle_key: candleKey, candle_time: candleTime }, now);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("calculation_stale"));
});

test("rejects stale completed news analysis", () => {
  const input = completeInput();
  input.newsAnalysis.analyzed_at = "2026-11-01T01:00:00.000Z";
  const result = buildEvidenceFusion(input, now);
  assert.equal(result.complete, false);
  assert.ok(result.validation_errors.includes("news:news_analysis_stale"));
});

test("enforces the one-hour completed-news analysis freshness boundary", () => {
  const input = completeInput();
  input.newsAnalysis.analyzed_at = "2026-11-01T13:44:00.000Z";
  const result = buildEvidenceFusion(input, now);
  assert.equal(result.complete, false);
  assert.ok(result.validation_errors.includes("news:news_analysis_stale"));
});

test("rejects stale underlying articles even when the analysis timestamps are fresh", () => {
  const input = completeInput();
  input.newsAnalysis.evidence.articles[0].published_at = "2026-11-01T13:56:59.999Z";
  const result = buildEvidenceFusion(input, now);
  assert.equal(result.complete, false);
  assert.ok(result.validation_errors.includes("news:news_articles_outside_lookback_or_duplicate"));
});

test("rejects duplicate underlying news articles", () => {
  const input = completeInput();
  input.newsAnalysis.evidence.articles.push({ ...input.newsAnalysis.evidence.articles[0], title: "Duplicate headline" });
  const result = buildEvidenceFusion(input, now);
  assert.equal(result.complete, false);
  assert.ok(result.validation_errors.includes("news:news_articles_outside_lookback_or_duplicate"));
});

test("rejects future-dated underlying news articles", () => {
  const input = completeInput();
  input.newsAnalysis.evidence.articles[0].published_at = "2026-11-01T15:00:01.000Z";
  const result = buildEvidenceFusion(input, now);
  assert.equal(result.complete, false);
  assert.ok(result.validation_errors.includes("news:news_articles_outside_lookback_or_duplicate"));
});

test("rejects future candle timestamps", () => {
  const input = completeInput();
  input.candleTime = "2026-11-02T15:00:00.000Z";
  const result = buildEvidenceFusion(input, now);
  assert.equal(result.complete, false);
  assert.ok(result.validation_errors.includes("candle_time_in_future"));
});

test("rejects stale M5 candle even when local calculations are newly computed", () => {
  const input = completeInput();
  input.candleTime = "2026-11-01T14:00:00.000Z";
  input.candleKey = symbol + ":" + timeframe + ":" + input.candleTime;
  input.webhookPayloads = Object.fromEntries(Object.entries(input.webhookPayloads).map(([key, value]) => [key, { ...value, candle_time: input.candleTime }]));
  input.localCalculations = input.localCalculations.map(value => ({ ...value, candle_time: input.candleTime, candle_key: input.candleKey }));
  const result = buildEvidenceFusion(input, now);
  assert.equal(result.complete, false);
  assert.ok(result.validation_errors.includes("candle_stale"));
});

test("rejects calculation timestamps that predate their candle", () => {
  const payload = local("mizan");
  payload.computed_at = "2026-11-01T14:40:00.000Z";
  const result = validateLocalCalculation(payload, { symbol, timeframe, candle_key: candleKey, candle_time: candleTime }, now);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("calculation_predates_candle"));
});

test("fails closed for timeframes without a declared freshness policy", () => {
  const input = completeInput();
  input.timeframe = "UNKNOWN";
  const result = buildEvidenceFusion(input, now);
  assert.equal(result.complete, false);
  assert.ok(result.validation_errors.includes("timeframe_freshness_policy_unsupported"));
});

test("detects credential-like fields recursively", () => {
  assert.equal(containsCredentialFields({ values: { bias: "NEUTRAL", authToken: "do-not-store" } }), true);
  assert.equal(containsCredentialFields({ values: { bias: "NEUTRAL", token_count: 3 } }), true);
});

test("strips credentials recursively from webhook evidence", () => {
  const input = { source: "gmi_v12_70", secret: "top-level", metrics: { bias: "NEUTRAL", api_key: "nested" } };
  assert.deepEqual(stripCredentialFields(input), { source: "gmi_v12_70", metrics: { bias: "NEUTRAL" } });
});

test("rejects non-SHA256 provenance hashes", () => {
  const payload = local("mizan");
  payload.provenance.source_hash = "not-a-hash";
  const result = validateLocalCalculation(payload, { symbol, timeframe, candle_key: candleKey, candle_time: candleTime }, now);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("provenance_source_hash_must_be_sha256"));
});

test("rejects local calculations for a candle in the future (ported from PR #13)", () => {
  const futureCandle = "2026-11-01T15:30:00.000Z";
  const payload = { ...local("mizan"), candle_time: futureCandle, candle_key: "OANDA:XAUUSD:M5:" + futureCandle };
  const result = validateLocalCalculation(payload, {}, now);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("candle_time_in_future"));
  // Within the 5-minute clock-skew allowance is still accepted.
  const nearCandle = "2026-11-01T15:04:00.000Z";
  const near = validateLocalCalculation({ ...local("mizan"), candle_time: nearCandle, candle_key: "x", computed_at: "2026-11-01T15:04:30.000Z" }, {}, now);
  assert.ok(!near.errors.includes("candle_time_in_future"));
});

test("fusion keeps webhook, local computation and news as three distinct labelled lanes", () => {
  const result = buildEvidenceFusion(completeInput(), now);
  assert.deepEqual(Object.keys(result.input_lanes), ["tradingview_webhook", "local_computation", "fundamental_news"]);
  assert.match(result.input_lanes.tradingview_webhook.computed_by, /TradingView/);
  assert.match(result.input_lanes.local_computation.computed_by, /raw TradingView OHLCV/);
  assert.deepEqual(result.input_lanes.tradingview_webhook.present_sources, ["prophet_r38", "prophet_r37_ssot", "gmi_v12_70"]);
  assert.deepEqual(result.input_lanes.local_computation.present_engines, ["mizan", "prophet", "gmi"]);
  assert.equal(result.input_lanes.local_computation.calculation_versions.prophet, "prophet-test-v1");
  assert.ok(Object.values(result.input_lanes).every((lane) => lane.complete === true));

  const partial = completeInput();
  delete partial.webhookPayloads.gmi_v12_70;
  partial.localCalculations = [local("prophet")];
  partial.newsAnalysis = null;
  const degraded = buildEvidenceFusion(partial, now);
  assert.deepEqual(degraded.input_lanes.tradingview_webhook.missing_sources, ["gmi_v12_70"]);
  assert.equal(degraded.input_lanes.tradingview_webhook.complete, false);
  assert.deepEqual(degraded.input_lanes.local_computation.missing_engines, ["mizan", "gmi"]);
  assert.equal(degraded.input_lanes.fundamental_news.present, false);
  // A missing local lane never borrows webhook values, and vice versa.
  assert.ok(!("gmi" in degraded.local_calculations));
});

test("TradingView epoch-ms candle_time (str.tostring(time)) is accepted and matched against ISO local records", () => {
  const input = completeInput();
  const ms = String(Date.parse(candleTime));
  for (const source of Object.keys(input.webhookPayloads)) input.webhookPayloads[source].candle_time = ms;
  input.candleTime = ms;
  const result = buildEvidenceFusion(input, now);
  assert.ok(!result.validation_errors.some((e) => e.startsWith("webhook_candle_time_mismatch")), JSON.stringify(result.validation_errors));
  assert.ok(!result.validation_errors.includes("candle_time_invalid"));
  // Local records keep ISO candle_time; both resolve to the same instant.
  assert.ok(!result.validation_errors.some((e) => e.endsWith("candle_time_mismatch")), JSON.stringify(result.validation_errors));
  assert.equal(result.status, "ready");
});

test("informational 5m context never affects completeness or missing evidence", () => {
  const base = completeInput();
  const without = buildEvidenceFusion(base, now);
  const withCtx = buildEvidenceFusion({ ...base, informational5mContext: { trust_status: "informational_unverified", bias: "BULLISH" } }, now);
  assert.equal(withCtx.complete, without.complete);
  assert.deepEqual(withCtx.missing_evidence, without.missing_evidence);
  assert.equal(withCtx.informational_5m_context?.trust_status, "informational_unverified");
});

test("news analysis from :06 stays valid when retried at :00:40 next hour", () => {
  const input = completeInput();
  // fetch/analyze at 00:06, article published 50 min before fetch
  input.newsAnalysis.fetched_at = "2026-11-01T00:06:00.000Z";
  input.newsAnalysis.analyzed_at = "2026-11-01T00:06:00.000Z";
  input.newsAnalysis.evidence.articles[0].published_at = "2026-10-31T23:16:00.000Z";
  const validationTime = Date.parse("2026-11-01T01:00:40.000Z");
  const result = buildEvidenceFusion(input, validationTime);
  assert.equal(result.fundamental_news_analysis !== null, true);
});
