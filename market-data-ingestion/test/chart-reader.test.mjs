import test from "node:test";
import assert from "node:assert/strict";
import { readChartCandles } from "../src/chart-reader.mjs";
import { SERIES_INTERNALS } from "../src/tradingview-source.mjs";

function kvWith(entries) {
  const store = new Map(Object.entries(entries));
  return { get: async (k) => store.get(k) ?? null };
}
const bar = (t, c) => ({ time: t, open: c - 1, high: c + 2, low: c - 2, close: c, volume: 10, open_time: "x", close_time: "y" });

test("readChartCandles returns the last N closed H1 bars in chart shape", async () => {
  const candles = Array.from({ length: 50 }, (_, i) => bar(1793700000 + i * 3600, 3900 + i));
  const env = { MARKET_DATA_CACHE: kvWith({ [SERIES_INTERNALS.SERIES_KEY_PREFIX + "OANDA:XAUUSD|1h"]: JSON.stringify({ candles, fetched_at: "2026-11-03T14:00:00Z" }) }) };
  const r = await readChartCandles(env, { timeframe: "h1", limit: 20 });
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 20);
  assert.equal(r.body.timeframe, "H1");
  assert.deepEqual(Object.keys(r.body.candles[0]).sort(), ["close", "high", "low", "open", "time", "volume"]);
  assert.equal(r.body.candles.at(-1).time, candles.at(-1).time);
  assert.equal(r.body.latest_close_time, new Date((candles.at(-1).time + 3600) * 1000).toISOString());
});

test("readChartCandles rejects unknown timeframes and reports empty caches", async () => {
  const env = { MARKET_DATA_CACHE: kvWith({}) };
  assert.equal((await readChartCandles(env, { timeframe: "M1" })).status, 400);
  const empty = await readChartCandles(env, { timeframe: "M5" });
  assert.equal(empty.status, 503);
  assert.equal(empty.body.error, "no_data_yet");
});
