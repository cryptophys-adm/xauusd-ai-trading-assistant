// QB1 (orchestrator 2026-11-26, O3; the TradingView quota): silver 4H is built from the broker's bars at all times and
// never pulled from TradingView. src/tradingview-source.mjs (SERIES `broker`), src/mt5-fallback.mjs applyBrokerSeries.
import test from "node:test";
import assert from "node:assert/strict";
import { applyBrokerSeries, BROKER_TARGETS, MACRO_TARGETS } from "../src/mt5-fallback.mjs";
import { SERIES, SERIES_INTERNALS, readSeries, healPlan, pendingWork, buildBundle } from "../src/tradingview-source.mjs";

class MemoryKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key) ?? null; }
  async put(key, value) { this.map.set(key, value); }
}
const T0 = 1_800_000_000 - (1_800_000_000 % 3600); // Friday 2027-01-15 08:00 UTC (market open)
const bar = (time, seconds, o, h, l, c, v = 10) => ({ time, open_time: new Date(time * 1000).toISOString(), close_time: new Date((time + seconds) * 1000).toISOString(), open: o, high: h, low: l, close: c, volume: v });
const spec = (key) => SERIES.find((s) => s.key === key);
const put = (kv, key, record) => kv.put(SERIES_INTERNALS.SERIES_KEY_PREFIX + key, JSON.stringify({ series: key, ...record }));

test("QB-1. silver 4H is the only broker-built series; it is never planned, bootstrapped or healed from TradingView", () => {
  assert.deepEqual(SERIES.filter((s) => s.broker).map((s) => [s.key, s.broker, s.role]), [["OANDA:XAGUSD|4h", "XAGUSD", "context"]]);
  assert.deepEqual(BROKER_TARGETS.map((t) => t.keys).flat(), ["OANDA:XAGUSD|4h"]);
  assert.ok(!MACRO_TARGETS.some((t) => t.keys.includes("OANDA:XAGUSD|4h")), "no longer a fallback target");
  const silver = spec("OANDA:XAGUSD|4h");
  assert.equal(healPlan(silver, { candles: [bar(T0, 14400, 1, 1, 1, 1)], fallback: { since_sec: T0 } }, T0 + 3600 * 5), null, "a leftover fallback mark is never healed");
  const records = SERIES.map((s) => (s.key === "OANDA:XAGUSD|4h" ? { candles: [], fallback: { since_sec: T0 } } : { candles: [bar(T0, s.seconds, 1, 1, 1, 1)] }));
  const due = pendingWork(records);
  assert.ok(!due.bootstrap.includes("OANDA:XAGUSD|4h") && !due.heal.includes("OANDA:XAGUSD|4h"));
  // Every other series keeps its SERIES entry as before (no `broker`).
  assert.equal(SERIES.filter((s) => !s.broker).length, SERIES.length - 1);
});

test("QB-2. built from the broker's silver on the series' own grid, buckets the minutes cover only, no fallback mark; the broker is asked only once a bucket can have closed", async () => {
  const kv = new MemoryKV();
  await put(kv, "OANDA:XAGUSD|4h", { candles: [bar(T0 - 6 * 3600, 14400, 50, 51, 49, 50.5)], fallback: { since_sec: T0 - 6 * 3600, source: "old" } }); // 02:00 bar
  const minutes = Array.from({ length: 300 }, (_, i) => ({ t: (T0 - 3 * 3600 + i * 60) * 1000, o: 50.2, h: 50.3, l: 50.1, c: 50.25, v: 2 })); // from 05:00
  const calls = [];
  const ai = { async corpusBars(req) { calls.push(req); return { source: "mt5macro:demo:XAGUSD", bars: minutes.filter((r) => r.t > req.since_ms) }; } };
  const env = { MARKET_DATA_CACHE: kv, AI_WORKER: ai };
  // 09:30: the 06:00-10:00 bucket is still open, the broker is not asked.
  assert.deepEqual(await applyBrokerSeries(env, { now: (T0 + 5400) * 1000 }), [{ base: "XAGUSD", status: "not_due" }]);
  assert.equal(calls.length, 0);
  // 10:01: it closed; the broker's minutes cover it from 06:00.
  const r = await applyBrokerSeries(env, { now: (T0 + 2 * 3600 + 65) * 1000 });
  assert.deepEqual(r, [{ series: "OANDA:XAGUSD|4h", bars: 1 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].base, "XAGUSD");
  const s = await readSeries(kv, spec("OANDA:XAGUSD|4h"));
  assert.deepEqual(s.candles.map((c) => [c.open_time, c.src ?? null]), [[new Date((T0 - 6 * 3600) * 1000).toISOString(), null], [new Date((T0 - 2 * 3600) * 1000).toISOString(), "mt5"]]);
  assert.equal(s.fallback, undefined, "the old fallback mark is cleared: nothing heals it");
  assert.equal(s.source, "mt5macro:demo:XAGUSD");
  // No binding, no broker bars: nothing written, never throws.
  assert.deepEqual(await applyBrokerSeries({ MARKET_DATA_CACHE: kv }, { now: (T0 + 8 * 3600) * 1000 }), []);
  const empty = { MARKET_DATA_CACHE: kv, AI_WORKER: { async corpusBars() { return { source: "x", bars: [] }; } } };
  assert.deepEqual(await applyBrokerSeries(empty, { now: (T0 + 8 * 3600) * 1000 }), [{ base: "XAGUSD", status: "no_broker_bars" }]);
  const failing = { MARKET_DATA_CACHE: kv, AI_WORKER: { async corpusBars() { throw new Error("rpc down"); } } };
  assert.equal((await applyBrokerSeries(failing, { now: (T0 + 8 * 3600) * 1000 }))[0].status, "failed");
});

test("QB-3. the engines' bundle (4H and every other input) is byte-identical whether silver came from TradingView or the broker", async () => {
  const build = async (silverCandles) => {
    const kv = new MemoryKV();
    const at = new Date(T0 * 1000).toISOString();
    for (const s of SERIES) {
      if (s.key === "OANDA:XAGUSD|4h") continue;
      const candles = [];
      for (let t = T0 - 40 * s.seconds; t < T0; t += s.seconds) candles.push(bar(t, s.seconds, 100, 101, 99, 100.5));
      await put(kv, s.key, { symbol: s.symbol, interval: s.interval, timeframe: s.timeframe, fetched_at: at, candle_count: candles.length, volume_available: true, candles });
    }
    await put(kv, "OANDA:XAGUSD|4h", { symbol: "OANDA:XAGUSD", interval: "4h", timeframe: "H4", fetched_at: at, candles: silverCandles });
    return JSON.stringify(await buildBundle({ MARKET_DATA_CACHE: kv }, T0 * 1000));
  };
  const native = [];
  for (let t = T0 - 40 * 14400; t < T0; t += 14400) native.push(bar(t, 14400, 50, 51, 49, 50.5));
  const broker = native.map((c, i) => (i >= 35 ? { ...c, open: 49.9, close: 50.4, src: "mt5" } : c));
  const a = await build(native), b = await build(broker), none = await build([]);
  assert.ok(a.length > 1000, "a real bundle");
  assert.equal(a, b, "silver's source never reaches the engines' bundle");
  assert.equal(a, none, "nor does its presence");
  assert.ok(!a.includes("XAGUSD"));
});
