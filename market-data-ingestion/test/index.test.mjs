import test from "node:test";
import assert from "node:assert/strict";

const { default: worker, internals } = await import("../src/index.mjs");

class MemoryKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key) ?? null; }
  async put(key, value) { this.map.set(key, value); }
}

const env = (overrides = {}) => ({
  MARKET_DATA_INGEST_SECRET: "test-secret",
  TWELVE_DATA_API_KEY: "test-api-key",
  MARKET_DATA_CACHE: new MemoryKV(),
  ...overrides
});

const now = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
function providerCandle(openMs, overrides = {}) {
  const iso = new Date(openMs).toISOString().slice(0, 19).replace("T", " ");
  return {
    datetime: iso,
    open: "2300.00", high: "2302.00", low: "2299.00", close: "2301.00", volume: "12",
    ...overrides
  };
}
function providerValues(interval, nowMs, count = 60) {
  if (interval === "5min") {
    const start = Math.floor(nowMs / 300_000) * 300_000 - 300_000;
    return Array.from({ length: count }, (_, i) => providerCandle(start - i * 300_000));
  }
  if (interval === "1day") {
    const start = Math.floor(nowMs / DAY_MS) * DAY_MS - DAY_MS;
    return Array.from({ length: count }, (_, i) => providerCandle(start - i * DAY_MS));
  }
  const day = new Date(nowMs).getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const thisWeek = Math.floor((nowMs - daysSinceMonday * DAY_MS) / WEEK_MS) * WEEK_MS;
  const lastWeek = thisWeek - WEEK_MS;
  return Array.from({ length: count }, (_, i) => providerCandle(lastWeek - i * WEEK_MS));
}

test("closed M5 candles exclude the still-forming candle and sort chronologically", () => {
  const closedTime = Math.floor((now - 10 * 60_000) / 300_000) * 300_000;
  const values = Array.from({ length: 60 }, (_, i) => providerCandle(closedTime - i * 300_000));
  values.push(providerCandle(Math.floor(now / 300_000) * 300_000));
  const candles = internals.normalizeProviderPayload({ status: "ok", values }, now);
  assert.equal(candles.length, 60);
  assert.ok(Date.parse(candles[0].open_time) < Date.parse(candles.at(-1).open_time));
  assert.ok(Date.parse(candles.at(-1).close_time) <= now);
});

test("higher timeframes are built only from complete contiguous M5 groups", () => {
  const start = Date.parse("2026-11-02T00:00:00.000Z");
  const m5 = Array.from({ length: 36 }, (_, i) => ({
    open_time: new Date(start + i * 300_000).toISOString(),
    close_time: new Date(start + (i + 1) * 300_000).toISOString(),
    open: 10 + i, high: 20 + i, low: 5 + i, close: 15 + i, volume: 1
  }));
  const m15 = internals.aggregateCandles(m5, { name: "M15", minutes: 15, expectedBars: 3 });
  const h1 = internals.aggregateCandles(m5, { name: "H1", minutes: 60, expectedBars: 12 });
  assert.equal(m15.length, 12);
  assert.equal(h1.length, 3);
  assert.equal(h1[0].open, 10);
  assert.equal(h1[0].close, 26);
  assert.equal(h1[0].high, 31);
  assert.equal(h1[0].low, 5);
  assert.equal(h1[0].volume, 12);
});

test("aggregation rejects groups with missing M5 bars", () => {
  const start = Date.parse("2026-11-02T00:00:00.000Z");
  const m5 = Array.from({ length: 12 }, (_, i) => ({
    open_time: new Date(start + i * 300_000).toISOString(),
    close_time: new Date(start + (i + 1) * 300_000).toISOString(),
    open: 1, high: 2, low: 0.5, close: 1.5, volume: null
  })).filter((_, index) => index !== 5);
  assert.equal(internals.aggregateCandles(m5, { name: "H1", minutes: 60, expectedBars: 12 }).length, 0);
});

test("missing provider volume remains null and is never synthesized", () => {
  const openMs = Math.floor((now - 60 * 60_000) / 300_000) * 300_000;
  const values = Array.from({ length: 60 }, (_, i) => providerCandle(openMs - i * 300_000, { volume: undefined }));
  const candles = internals.normalizeProviderPayload({ status: "ok", values }, now);
  assert.equal(candles.every((candle) => candle.volume === null), true);
});

test("POST /pull requires the configured bearer secret", async () => {
  const response = await worker.fetch(new Request("https://market.example.com/pull", {
    method: "POST",
    headers: { authorization: "Bearer wrong" }
  }), env());
  assert.equal(response.status, 401);
});

test("POST /pull calls Twelve Data with the bounded M5 bootstrap contract", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    const requestedUrl = new URL(String(url));
    requestedUrls.push(requestedUrl);
    const values = providerValues(requestedUrl.searchParams.get("interval"), Date.now(), Number(requestedUrl.searchParams.get("outputsize")));
    return new Response(JSON.stringify({
      status: "ok", meta: { symbol: "XAU/USD" }, values
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const testEnv = env();
  const response = await worker.fetch(new Request("https://market.example.com/pull", {
    method: "POST", headers: { authorization: "Bearer test-secret" }
  }), testEnv);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const m5Request = requestedUrls.find((item) => item.searchParams.get("interval") === "5min");
  const d1Request = requestedUrls.find((item) => item.searchParams.get("interval") === "1day");
  const w1Request = requestedUrls.find((item) => item.searchParams.get("interval") === "1week");
  assert.equal(m5Request.searchParams.get("symbol"), "XAU/USD");
  assert.equal(m5Request.searchParams.get("outputsize"), "5000");
  assert.equal(d1Request.searchParams.get("outputsize"), "60");
  assert.equal(w1Request.searchParams.get("outputsize"), "60");
  assert.equal(m5Request.searchParams.get("timezone"), "UTC");
  assert.equal(m5Request.searchParams.has("apikey"), true);
  assert.equal(body.schema_version, "cryptophys.market-data.v1");
  assert.equal(body.source.canonical_symbol, "OANDA:XAUUSD");
  assert.equal(body.timeframes.M5.candle_count, 5000);
  assert.equal(body.context_timeframes.D1.candle_count, 60);
  assert.equal(body.context_timeframes.W1.candle_count, 60);
  assert.equal(body.history_sufficiency.prophet_default_mtf_ready, true);
  assert.equal(body.timeframes.M15.interval_minutes, 15);
  assert.equal(body.timeframes.H1.interval_minutes, 60);
  assert.equal(body.timeframes.H4.interval_minutes, 240);
  assert.equal((await worker.fetch(new Request("https://market.example.com/latest", {
    headers: { authorization: "Bearer test-secret" }
  }), testEnv)).status, 200);
  const engineResponse = await worker.fetch(new Request("https://market.example.com/engine-inputs?engine=prophet", {
    headers: { authorization: "Bearer test-secret" }
  }), testEnv);
  const engineInput = await engineResponse.json();
  assert.equal(engineResponse.status, 200);
  assert.equal(engineInput.engine, "prophet");
  assert.equal(engineInput.data_status, "history_ready_for_shadow");
  assert.equal(engineInput.calculation_status, "blocked_source_parity");
  assert.equal(engineInput.calculation_allowed_for_trusted_evidence, false);
  assert.equal(engineInput.inputs.timeframes.M5.candle_count, 5000);

  requestedUrls.length = 0;
  const incrementalResponse = await worker.fetch(new Request("https://market.example.com/pull", {
    method: "POST", headers: { authorization: "Bearer test-secret" }
  }), testEnv);
  assert.equal(incrementalResponse.status, 200);
  const incrementalM5 = requestedUrls.find((item) => item.searchParams.get("interval") === "5min");
  assert.equal(incrementalM5.searchParams.get("outputsize"), "3");
  assert.equal(requestedUrls.some((item) => item.searchParams.get("interval") === "1day"), false);
  assert.equal(requestedUrls.some((item) => item.searchParams.get("interval") === "1week"), false);
  const incrementalBundle = await incrementalResponse.json();
  assert.equal(incrementalBundle.timeframes.M5.candle_count, 5000);
});

test("GET /latest requires the configured bearer secret", async () => {
  const response = await worker.fetch(new Request("https://market.example.com/latest"), env());
  assert.equal(response.status, 401);
});

test("health exposes configuration status but no secrets", async () => {
  const response = await worker.fetch(new Request("https://market.example.com/health"), env());
  const body = await response.json();
  assert.equal(body.worker, "xauusd-tradingview-pull-adapter");
  assert.equal(body.source_configured, true);
  assert.equal(JSON.stringify(body).includes("test-api-key"), false);
  assert.equal(JSON.stringify(body).includes("test-secret"), false);
});

test("invalid provider OHLC is rejected", () => {
  const openMs = Date.parse("2026-11-02T00:00:00.000Z");
  assert.throws(() => internals.parseProviderCandle(providerCandle(openMs, { high: "1", low: "9" })));
});
