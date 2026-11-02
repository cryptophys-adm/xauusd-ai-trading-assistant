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
  input.newsAnalysis.analyzed_at = "2026-11-01T13:59:00.000Z";
  const result = buildEvidenceFusion(input, now);
  assert.equal(result.complete, false);
  assert.ok(result.validation_errors.includes("news:news_analysis_stale"));
});

test("rejects stale underlying articles even when the analysis timestamps are fresh", () => {
  const input = completeInput();
  input.newsAnalysis.evidence.articles[0].published_at = "2026-11-01T13:59:59.999Z";
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
