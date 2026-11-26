// The broker-built series (src/mt5-fallback.mjs BROKER_TARGETS, applyBrokerSeries; SERIES entries with `broker`).
// QB1 O3 (2026-11-26) built silver 4H from the broker's bars; QB1-R the same day pulled it from TradingView again,
// because the bridge sends no macro symbol on the active broker. The builder stays, inert, until it does.
import test from "node:test";
import assert from "node:assert/strict";
import { applyBrokerSeries, rebuildFromBroker, BROKER_TARGETS, MACRO_TARGETS } from "../src/mt5-fallback.mjs";
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

test("QB-1. QB1-R: no series is broker-built; silver is a TradingView pull again and a fallback macro target; the builder asks nothing", async () => {
  assert.deepEqual(SERIES.filter((s) => s.broker).map((s) => s.key), [], "every series is pulled or derived");
  assert.deepEqual(BROKER_TARGETS, []);
  assert.ok(MACRO_TARGETS.some((t) => t.keys.includes("OANDA:XAGUSD|4h")), "silver is rebuilt from the broker only during a fallback, as before QB1");
  const silver = spec("OANDA:XAGUSD|4h");
  assert.equal(silver.role, "context");
  assert.ok(healPlan(silver, { candles: [bar(T0, 14400, 1, 1, 1, 1)], fallback: { since_sec: T0 } }, Math.floor(T0 / 300) * 300 + 3600 * 5) !== null, "fallback bars heal from TradingView again");
  const records = SERIES.map((s) => (s.key === "OANDA:XAGUSD|4h" ? { candles: [] } : { candles: [bar(T0, s.seconds, 1, 1, 1, 1)] }));
  assert.ok(pendingWork(records).bootstrap.includes("OANDA:XAGUSD|4h"), "an empty silver cache bootstraps from TradingView");
  let asked = 0;
  const ai = { async corpusBars() { asked += 1; return { source: "x", bars: [] }; } };
  assert.deepEqual(await applyBrokerSeries({ MARKET_DATA_CACHE: new MemoryKV(), AI_WORKER: ai }, { now: T0 * 1000 }), []);
  assert.equal(asked, 0);
});

test("QB-2. the builder without the fallback mark (kept for when the bridge sends macro symbols): own grid, covered buckets only, no fallback mark, asks only once a bucket can have closed", async () => {
  const kv = new MemoryKV();
  await put(kv, "OANDA:XAGUSD|4h", { candles: [bar(T0 - 6 * 3600, 14400, 50, 51, 49, 50.5)], fallback: { since_sec: T0 - 6 * 3600, source: "old" } });
  const minutes = Array.from({ length: 300 }, (_, i) => ({ t: (T0 - 3 * 3600 + i * 60) * 1000, o: 50.2, h: 50.3, l: 50.1, c: 50.25, v: 2 }));
  const calls = [];
  const ai = { async corpusBars(req) { calls.push(req); return { source: "mt5macro:demo:XAGUSD", bars: minutes.filter((r) => r.t > req.since_ms) }; } };
  const env = { MARKET_DATA_CACHE: kv, AI_WORKER: ai };
  const target = { base: "XAGUSD", keys: ["OANDA:XAGUSD|4h"] };
  assert.deepEqual(await rebuildFromBroker(env, kv, target, { now: (T0 + 5400) * 1000, mark: false }), [{ base: "XAGUSD", status: "not_due" }]);
  assert.equal(calls.length, 0);
  assert.deepEqual(await rebuildFromBroker(env, kv, target, { now: (T0 + 2 * 3600 + 65) * 1000, mark: false }), [{ series: "OANDA:XAGUSD|4h", bars: 1 }]);
  const s = await readSeries(kv, spec("OANDA:XAGUSD|4h"));
  assert.deepEqual(s.candles.map((c) => [c.open_time, c.src ?? null]), [[new Date((T0 - 6 * 3600) * 1000).toISOString(), null], [new Date((T0 - 2 * 3600) * 1000).toISOString(), "mt5"]]);
  assert.equal(s.fallback, undefined);
  assert.equal(s.source, "mt5macro:demo:XAGUSD");
});

test("QB-3. the engines' bundle (4H and every other input) is byte-identical whatever silver holds", async () => {
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
  assert.ok(a.length > 1000);
  assert.equal(a, b);
  assert.equal(a, none);
  assert.ok(!a.includes("XAGUSD"));
});
