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
function providerCandle(openMs, overrides = {}) {
  const iso = new Date(openMs).toISOString().slice(0, 19).replace("T", " ");
  return {
    datetime: iso,
    open: "2300.00", high: "2302.00", low: "2299.00", close: "2301.00", volume: "12",
    ...overrides
  };
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
  const start = Math.floor((Date.now() - 2 * 60 * 60_000) / 300_000) * 300_000;
  const values = Array.from({ length: 300 }, (_, i) => providerCandle(start - i * 300_000));
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(String(url));
    return new Response(JSON.stringify({
      status: "ok", meta: { symbol: "XAU/USD" }, values
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const response = await worker.fetch(new Request("https://market.example.com/pull", {
    method: "POST", headers: { authorization: "Bearer test-secret" }
  }), env());
  assert.equal(response.status, 200);
  assert.equal(requestedUrl.searchParams.get("symbol"), "XAU/USD");
  assert.equal(requestedUrl.searchParams.get("interval"), "5min");
  assert.equal(requestedUrl.searchParams.get("outputsize"), "300");
  assert.equal(requestedUrl.searchParams.get("timezone"), "UTC");
  assert.equal(requestedUrl.searchParams.has("apikey"), true);
  const body = await response.json();
  assert.equal(body.schema_version, "cryptophys.market-data.v1");
  assert.equal(body.source.canonical_symbol, "OANDA:XAUUSD");
  assert.equal(body.timeframes.M5.candle_count, 300);
  assert.equal(body.timeframes.M15.interval_minutes, 15);
  assert.equal(body.timeframes.H1.interval_minutes, 60);
  assert.equal(body.timeframes.H4.interval_minutes, 240);
  assert.equal((await worker.fetch(new Request("https://market.example.com/latest"), env())).status, 200);
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
