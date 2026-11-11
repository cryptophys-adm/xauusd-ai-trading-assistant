// Corpus Oracle phase 2: the 15m engines on the broker's bars, compared with TradingView's; feeds nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { buildM15LocalCalculations } from "../../local-engines/producer/src/m15-local-producer.mjs";
import { compareComparable, runBrokerShadow, brokerShadowMode, BROKER_M15_KEY } from "../src/broker-shadow.mjs";

class MemoryKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key) ?? null; }
  async put(key, value) { this.map.set(key, value); }
}
function series(count, minutes, endOpenMs) {
  const step = minutes * 60_000;
  return Array.from({ length: count }, (_, i) => {
    const openMs = endOpenMs - (count - 1 - i) * step;
    const open = 3900 + Math.sin(i / 9) * 15 + i * 0.02;
    const close = open + Math.sin(i / 3) * 3;
    return { time: openMs / 1000, open_time: new Date(openMs).toISOString(), close_time: new Date(openMs + step).toISOString(), open, high: Math.max(open, close) + 1.5, low: Math.min(open, close) - 1.2, close, volume: 1000 + (i % 17) * 40 };
  });
}
const lastM15Open = Date.parse("2026-11-03T09:00:00Z");
const NOW = lastM15Open + 15 * 60_000 + 30_000;
function bundle(m15Count = 450) {
  return { timeframes: {
    M5: { candles: series(1000, 5, lastM15Open + 10 * 60_000) }, M1: { candles: series(3000, 1, lastM15Open + 14 * 60_000) },
    M15: { candles: series(m15Count, 15, lastM15Open) }, H1: { candles: series(1000, 60, Date.parse("2026-11-03T08:00:00Z")) },
    H4: { candles: series(500, 240, Date.parse("2026-11-03T04:00:00Z")) }, D1: { candles: series(500, 1440, Date.parse("2026-11-01T22:00:00Z")) },
    W1: { candles: series(260, 10080, Date.parse("2026-10-25T21:00:00Z")) }
  } };
}
/** The broker's minutes that aggregate exactly to the given 15m bars. */
function minutesOf(bars) {
  const rows = [];
  for (const b of bars) {
    for (let k = 0; k < 15; k++) {
      const t = (b.time + k * 60) * 1000;
      if (k === 0) rows.push({ t, o: b.open, h: b.high, l: b.low, c: b.open, v: b.volume });
      else if (k === 14) rows.push({ t, o: b.open, h: Math.max(b.open, b.close), l: Math.min(b.open, b.close), c: b.close, v: 0 });
      else rows.push({ t, o: b.open, h: b.open, l: b.open, c: b.open, v: 0 });
    }
  }
  return rows;
}
const aiWorker = (rows) => {
  const recorded = [];
  return { recorded, async corpusBars(req) { return { source: "mt5:monex-demo:XAUUSD.M", bars: rows.filter((r) => r.t > req.since_ms).slice(0, req.limit) }; }, async recordBrokerShadow(p) { recorded.push(p); return { ok: true, stored: Object.keys(p.engines).length }; } };
};

test("the comparison: every comparable leaf, numbers within rounding", () => {
  const c = compareComparable({ a: { x: 1, y: true }, b: 2 }, { a: { x: 1 + 1e-12, y: false }, b: 2, c: null });
  assert.deepEqual(c, { fields: 4, matched: 2, mismatched: ["a.y", "c"] }, "a field only one side has is a difference");
  assert.equal(brokerShadowMode({}), "on");
  assert.equal(brokerShadowMode({ BROKER_SHADOW_MODE: "off" }), "off");
});

test("the same bars give full agreement; the broker's M15 is cached and only extended; it feeds nothing", async () => {
  const tv = bundle();
  const tvBuilt = buildM15LocalCalculations(tv, { now: NOW });
  const ai = aiWorker(minutesOf(tv.timeframes.M15.candles));
  const env = { MARKET_DATA_CACHE: new MemoryKV(), AI_WORKER: ai };
  const r = await runBrokerShadow(env, { bundle: tv, tvRecords: tvBuilt.records, candleKey: tvBuilt.candle_key, now: NOW });
  assert.equal(r.status, "recorded", JSON.stringify(r));
  const sent = ai.recorded[0];
  assert.equal(sent.candle_key, `OANDA:XAUUSD:15:${lastM15Open}`);
  assert.deepEqual(Object.keys(sent.engines).sort(), ["gmi", "prophet"], "the shared core has no comparable field");
  for (const [engine, e] of Object.entries(sent.engines)) {
    assert.ok(e.fields > 0, engine);
    assert.equal(e.matched, e.fields, `${engine}: ${e.mismatched.join(",")}`);
  }
  assert.equal(sent.engines.prophet.direction_match, true);
  assert.ok(JSON.parse(env.MARKET_DATA_CACHE.map.get(BROKER_M15_KEY)).candles.length >= 400);
  assert.equal(JSON.stringify(sent).includes("3900"), false, "no price is sent");
});

test("no shadow while the fallback runs, before 400 broker bars, or when the broker's last bar is not TradingView's", async () => {
  const tv = bundle();
  const tvBuilt = buildM15LocalCalculations(tv, { now: NOW });
  const base = { tvRecords: tvBuilt.records, candleKey: tvBuilt.candle_key, now: NOW };
  assert.equal((await runBrokerShadow({ MARKET_DATA_CACHE: new MemoryKV(), AI_WORKER: aiWorker([]) }, { ...base, bundle: { ...tv, feed: "mt5_fallback" } })).status, "fallback_running");
  const short = await runBrokerShadow({ MARKET_DATA_CACHE: new MemoryKV(), AI_WORKER: aiWorker(minutesOf(tv.timeframes.M15.candles.slice(-100))) }, { ...base, bundle: tv });
  assert.deepEqual([short.status, short.needed], ["insufficient_history", 400]);
  const behind = await runBrokerShadow({ MARKET_DATA_CACHE: new MemoryKV(), AI_WORKER: aiWorker(minutesOf(tv.timeframes.M15.candles.slice(0, -2))) }, { ...base, bundle: tv });
  assert.equal(behind.status, "not_aligned");
  assert.equal((await runBrokerShadow({ MARKET_DATA_CACHE: new MemoryKV(), AI_WORKER: aiWorker([]), BROKER_SHADOW_MODE: "off" }, { ...base, bundle: tv })).status, "off");
});
