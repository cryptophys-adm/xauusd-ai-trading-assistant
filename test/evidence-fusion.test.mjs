import test from "node:test";
import assert from "node:assert/strict";
import { buildEvidenceFusion, validateLocalCalculation, LOCAL_CALCULATION_CONTRACT_VERSION, WEBHOOK_EVIDENCE_CONTRACT_VERSION, NEWS_ANALYSIS_CONTRACT_VERSION } from "../src/evidence-fusion.mjs";

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
    values: { bias: "NEUTRAL", score: 0 }, provenance: { source: "test-fixture", source_hash: "fixture-sha256" }
  };
}
function webhook(source) {
  return { schema_version: WEBHOOK_EVIDENCE_CONTRACT_VERSION, source, ticker: symbol, timeframe, candle_time: candleTime, metrics: { bias: "NEUTRAL" } };
}
function news() {
  return {
    schema_version: NEWS_ANALYSIS_CONTRACT_VERSION, status: "ok", analysis_type: "fundamental_news", analyzed_at: "2026-11-01T14:58:00.000Z",
    fetched_at: "2026-11-01T14:57:00.000Z", symbols: [symbol],
    evidence: { articles: [{ id: "fixture-1", title: "Fixture article" }] },
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
