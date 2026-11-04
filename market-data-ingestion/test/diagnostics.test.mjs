import test from "node:test";
import assert from "node:assert/strict";
import { readDiagnostics } from "../src/diagnostics.mjs";
import { LAST_REFRESH_KEY } from "../src/tradingview-source.mjs";
import { LAST_PUBLISH_KEY } from "../src/local-publisher.mjs";

function kv() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); }
  };
}

const NOW = Date.parse("2026-11-04T01:10:00.000Z");

test("diagnostics reports cache_not_configured without a KV binding", async () => {
  const result = await readDiagnostics({}, { now: NOW });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "cache_not_configured");
});

test("diagnostics reports null summaries and empty series on a cold cache", async () => {
  const env = { MARKET_DATA_CACHE: kv() };
  const result = await readDiagnostics(env, { now: NOW });
  assert.equal(result.status, 200);
  assert.equal(result.body.worker, "xauusd-tradingview-pull-adapter");
  assert.equal(result.body.gateway_configured, false);
  assert.equal(result.body.publisher_configured, false);
  assert.equal(result.body.last_refresh, null);
  assert.equal(result.body.last_publish, null);
  assert.equal(result.body.budget.used, 0);
  assert.equal(result.body.budget.daily, 1200);
  assert.equal(result.body.budget.date, "2026-11-04");
  assert.equal(result.body.series.length, 10);
  assert.ok(result.body.series.every((s) => s.candle_count === 0 && s.latest_close_time === null));
});

test("diagnostics surfaces last refresh, last publish, per-series close times and budget", async () => {
  const cache = kv();
  await cache.put(LAST_REFRESH_KEY, JSON.stringify({ status: "ok", requested: 4, checked_at: "2026-11-04T01:05:35.000Z" }));
  await cache.put(LAST_PUBLISH_KEY, JSON.stringify({ status: "published", candle_key: "OANDA:XAUUSD:60:1793750400000", published_at: "2026-11-04T01:00:33.676Z" }));
  await cache.put("market-data:v2:series:OANDA:XAUUSD|1h", JSON.stringify({
    series: "OANDA:XAUUSD|1h",
    fetched_at: "2026-11-04T01:05:35.000Z",
    candle_count: 2,
    candles: [
      { time: 1793746800, open_time: "2026-11-03T23:00:00.000Z", close_time: "2026-11-04T00:00:00.000Z", open: 1, high: 2, low: 1, close: 2, volume: null },
      { time: 1793750400, open_time: "2026-11-04T00:00:00.000Z", close_time: "2026-11-04T01:00:00.000Z", open: 2, high: 3, low: 2, close: 3, volume: null }
    ]
  }));
  await cache.put("market-data:v2:mcp-calls:2026-11-04", "37");

  const env = { MARKET_DATA_CACHE: cache, TV_GATEWAY: { ohlcv: async () => ({}) }, AI_WORKER: { submit: async () => ({}) }, TV_DAILY_CALL_BUDGET: "1200" };
  const result = await readDiagnostics(env, { now: NOW });
  assert.equal(result.status, 200);
  assert.equal(result.body.gateway_configured, true);
  assert.equal(result.body.publisher_configured, true);
  assert.equal(result.body.budget.used, 37);
  assert.equal(result.body.last_refresh.status, "ok");
  assert.equal(result.body.last_publish.candle_key, "OANDA:XAUUSD:60:1793750400000");
  const h1 = result.body.series.find((s) => s.series === "OANDA:XAUUSD|1h");
  assert.equal(h1.candle_count, 2);
  assert.equal(h1.latest_close_time, "2026-11-04T01:00:00.000Z");
  const usoil = result.body.series.find((s) => s.series === "TVC:USOIL|5m");
  assert.equal(usoil.candle_count, 0);
});
