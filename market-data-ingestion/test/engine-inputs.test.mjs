import test from "node:test";
import assert from "node:assert/strict";
import { buildLocalEngineInput, buildLocalEngineReadiness } from "../src/engine-inputs.mjs";

function series(count, minutes) {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, i) => ({
    open_time: new Date(start + i * minutes * 60000).toISOString(),
    close_time: new Date(start + (i + 1) * minutes * 60000).toISOString(),
    open: 2000, high: 2002, low: 1999, close: 2001, volume: 10
  }));
}
function bundle() {
  return {
    schema_version: "cryptophys.market-data.v1",
    source: { canonical_symbol: "OANDA:XAUUSD", provider: "Twelve Data", provider_symbol: "XAU/USD" },
    fetched_at: "2026-01-02T00:00:00.000Z",
    latest_closed_m5_close_time: "2026-01-02T00:00:00.000Z",
    volume_available: true,
    timeframes: {
      M5: { interval_minutes: 5, candle_count: 5000, candles: series(5000, 5) },
      M15: { interval_minutes: 15, candle_count: 1666, candles: series(1666, 15) },
      H1: { interval_minutes: 60, candle_count: 416, candles: series(416, 60) },
      H4: { interval_minutes: 240, candle_count: 104, candles: series(104, 240) },
      D1: { interval_minutes: 1440, candle_count: 17, candles: series(17, 1440) }
    },
    context_timeframes: {
      D1: { interval_minutes: 1440, candle_count: 60, candles: series(60, 1440), source: { provider: "Twelve Data", interval: "1day" } },
      W1: { interval_minutes: 10080, candle_count: 60, candles: series(60, 10080), source: { provider: "Twelve Data", interval: "1week" } }
    }
  };
}

test("Prophet receives sufficient default MTF warm-up but remains parity-blocked", () => {
  const result = buildLocalEngineInput(bundle(), "prophet");
  assert.equal(result.data_status, "history_ready_for_shadow");
  assert.equal(result.calculation_status, "blocked_source_parity");
  assert.equal(result.calculation_allowed_for_trusted_evidence, false);
  assert.equal(result.inputs.timeframes.M5.candles.length, 5000);
  assert.equal(result.inputs.context_timeframes.D1.candles.length, 60);
  assert.equal(result.inputs.context_timeframes.W1.candles.length, 60);
});

test("short daily and weekly histories are blocked rather than padded", () => {
  const data = bundle();
  data.context_timeframes.D1.candles = data.context_timeframes.D1.candles.slice(0, 17);
  data.context_timeframes.D1.candle_count = 17;
  data.context_timeframes.W1.candles = data.context_timeframes.W1.candles.slice(0, 2);
  data.context_timeframes.W1.candle_count = 2;
  const result = buildLocalEngineInput(data, "prophet");
  assert.equal(result.data_status, "blocked_insufficient_history");
  assert.ok(result.history_gaps.some((gap) => gap.timeframe === "D1" && gap.required_bars === 51));
  assert.ok(result.history_gaps.some((gap) => gap.timeframe === "W1" && gap.required_bars === 51));
});

test("GMI stays blocked without intrabars and external symbol history", () => {
  const result = buildLocalEngineInput(bundle(), "gmi");
  assert.equal(result.data_status, "history_ready_for_shadow");
  assert.equal(result.calculation_status, "blocked_missing_gmi_inputs");
  assert.equal(result.calculation_allowed_for_trusted_evidence, false);
  assert.ok(result.missing_dependencies.length >= 5);
});

test("Mizan stays unapproved even when history is sufficient", () => {
  const result = buildLocalEngineInput(bundle(), "mizan");
  assert.equal(result.data_status, "blocked_history_contract_undefined");
  assert.equal(result.calculation_status, "blocked_source_identity");
  assert.ok(result.history_gaps.some((gap) => gap.code === "engine_history_requirements_unverified"));
  assert.equal(result.calculation_allowed_for_trusted_evidence, false);
});

test("readiness lists the three engines and does not claim parity", () => {
  const readiness = buildLocalEngineReadiness(bundle());
  assert.deepEqual(Object.keys(readiness), ["mizan", "prophet", "gmi"]);
  assert.ok(Object.values(readiness).every((item) => item.parity_status === "not_proven"));
});
