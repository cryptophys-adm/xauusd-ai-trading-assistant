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
    source: { canonical_symbol: "OANDA:XAUUSD", provider: "TradingView MCP", provider_symbol: "OANDA:XAUUSD" },
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
      D1: { interval_minutes: 1440, candle_count: 60, candles: series(60, 1440), source: { provider: "TradingView MCP", interval: "1D" } },
      W1: { interval_minutes: 10080, candle_count: 60, candles: series(60, 10080), source: { provider: "TradingView MCP", interval: "1W" } }
    }
  };
}

test("Prophet receives caller-derived MTF warm-up but remains parity-blocked", () => {
  const result = buildLocalEngineInput(bundle(), "prophet");
  assert.equal(result.data_status, "history_ready_for_shadow");
  assert.equal(result.calculation_status, "blocked_source_parity");
  assert.equal(result.calculation_allowed_for_trusted_evidence, false);
  assert.equal(result.inputs.timeframes.M5.candles.length, 5000);
  assert.equal(result.inputs.context_timeframes.D1.candles.length, 60);
  assert.equal(result.inputs.context_timeframes.W1.candles.length, 60);
  assert.equal(result.history_requirements.M5, 101);
  assert.equal(result.history_requirements.W1, 51);
  assert.match(result.source_caller_contract.source, /R38/);
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

test("GMI returns structured unavailable-input records and remains blocked", () => {
  const result = buildLocalEngineInput(bundle(), "gmi");
  assert.equal(result.data_status, "history_ready_for_shadow");
  assert.equal(result.calculation_status, "blocked_missing_gmi_inputs");
  assert.equal(result.calculation_allowed_for_trusted_evidence, false);
  assert.ok(result.unavailable_inputs.some((item) => item.code === "missing_intrabar_ohlcv"));
  assert.ok(result.unavailable_inputs.some((item) => item.symbol === "TVC:DXY"));
  assert.ok(result.unavailable_inputs.some((item) => item.symbol === "CRYPTOCAP:USDT"));
  assert.ok(result.unavailable_inputs.some((item) => item.symbol === "TVC:USOIL"));
  assert.ok(!result.unavailable_inputs.some((item) => item.code === "missing_tradingview_footprint_semantics"));
});

test("GMI inputs from TradingView-native M1 and external series clear the unavailable list but not the calculator/parity block", () => {
  const data = bundle();
  data.timeframes.M1 = { interval_minutes: 1, candle_count: 3000, candles: series(3000, 1) };
  data.external_series = {
    "TVC:DXY": { H4: { candle_count: 500, candles: series(500, 240) } },
    "CRYPTOCAP:USDT": { H4: { candle_count: 500, candles: series(500, 240) } },
    "TVC:USOIL": { M5: { candle_count: 1000, candles: series(1000, 5) } }
  };
  const result = buildLocalEngineInput(data, "gmi");
  assert.deepEqual(result.unavailable_inputs, []);
  assert.equal(result.calculation_status, "blocked_no_local_gmi_calculator");
  assert.equal(result.calculation_allowed_for_trusted_evidence, false);
  assert.equal(result.inputs.external_series["TVC:DXY"].H4.candle_count, 500);
  data.external_series["TVC:DXY"].H4 = { candle_count: 10, candles: series(10, 240) };
  const short = buildLocalEngineInput(data, "gmi");
  assert.deepEqual(short.unavailable_inputs.map((i) => [i.symbol, i.available_bars]), [["TVC:DXY", 10]]);
});

test("Mizan history floor comes from known callers but identity/parity remain blocked", () => {
  const result = buildLocalEngineInput(bundle(), "mizan");
  assert.equal(result.data_status, "history_ready_for_shadow");
  assert.equal(result.calculation_status, "blocked_source_identity");
  assert.equal(result.calculation_allowed_for_trusted_evidence, false);
  assert.equal(result.history_requirements.M5, 300);
  assert.equal(result.history_requirements.W1, 51);
  assert.match(result.history_requirement_scope, /not a universal requirement/);
  assert.equal(result.parity_status, "not_proven");
});

test("Mizan and Prophet history gaps are explicit when the source-derived floor is not met", () => {
  const data = bundle();
  data.timeframes.M5.candles = data.timeframes.M5.candles.slice(0, 100);
  data.timeframes.M5.candle_count = 100;
  const mizan = buildLocalEngineInput(data, "mizan");
  const prophet = buildLocalEngineInput(data, "prophet");
  assert.ok(mizan.history_gaps.some((gap) => gap.timeframe === "M5" && gap.required_bars === 300));
  assert.ok(prophet.history_gaps.some((gap) => gap.timeframe === "M5" && gap.required_bars === 101));
});

test("readiness lists all engines and never claims parity or trusted eligibility", () => {
  const readiness = buildLocalEngineReadiness(bundle());
  assert.deepEqual(Object.keys(readiness), ["mizan", "prophet", "gmi"]);
  assert.ok(Object.values(readiness).every((item) => item.parity_status === "not_proven"));
  assert.ok(Object.values(readiness).every((item) => item.calculation_allowed_for_trusted_evidence === false));
});
