// 5m execution for Omega: the broker's 5m trigger, at each broker 5m close (docs/RFC_OMEGA_5M_EXECUTION.md).
import test from "node:test";
import assert from "node:assert/strict";
import { buildM5LocalCalculations } from "../../local-engines/producer/src/m5-local-producer.mjs";
import { structureOf, runBrokerTrigger, brokerTriggerMode, BROKER_M5_KEY } from "../src/broker-trigger.mjs";

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
const lastM5Open = Date.parse("2026-11-03T09:10:00Z");
const NOW = lastM5Open + 5 * 60_000 + 40_000;
function bundle() {
  return { timeframes: {
    M5: { candles: series(1000, 5, lastM5Open) }, M1: { candles: series(3000, 1, lastM5Open + 4 * 60_000) },
    M15: { candles: series(500, 15, Date.parse("2026-11-03T08:45:00Z")) }, H1: { candles: series(1000, 60, Date.parse("2026-11-03T08:00:00Z")) },
    H4: { candles: series(500, 240, Date.parse("2026-11-03T04:00:00Z")) }, D1: { candles: series(500, 1440, Date.parse("2026-11-01T22:00:00Z")) },
    W1: { candles: series(260, 10080, Date.parse("2026-10-25T21:00:00Z")) }
  } };
}
/** The broker's minutes that aggregate exactly to the given 5m bars. */
function minutesOf(bars) {
  const rows = [];
  for (const b of bars) {
    for (let k = 0; k < 5; k++) {
      const t = (b.time + k * 60) * 1000;
      if (k === 0) rows.push({ t, o: b.open, h: b.high, l: b.low, c: b.open, v: b.volume });
      else if (k === 4) rows.push({ t, o: b.open, h: Math.max(b.open, b.close), l: Math.min(b.open, b.close), c: b.close, v: 0 });
      else rows.push({ t, o: b.open, h: b.open, l: b.open, c: b.open, v: 0 });
    }
  }
  return rows;
}
const aiWorker = (rows, ok = true) => {
  const sent = [];
  return { sent, async corpusBars(req) { return { source: "mt5:monex-demo:XAUUSD.M", bars: rows.filter((r) => r.t > req.since_ms).slice(0, req.limit) }; }, async submitBrokerTrigger(p) { sent.push(p); return ok ? { ok: true } : { ok: false, error: "invalid_trigger" }; } };
};

test("the structure: swing high and low of the last 3 bars, ATR(14) of true ranges", () => {
  const bars = Array.from({ length: 20 }, (_, i) => ({ high: 102 + i, low: 100 + i, close: 101 + i }));
  // Each true range: max(2, |102+i - (101+i-1)| = 2, |100+i - 100-i+... |) = 2.
  assert.deepEqual(structureOf(bars), { swing_high: 121, swing_low: 117, atr: 2 });
  assert.equal(structureOf(bars.slice(0, 10)), null, "needs 15 bars");
  assert.equal(brokerTriggerMode({}), "on");
  assert.equal(brokerTriggerMode({ BROKER_TRIGGER_MODE: "off" }), "off");
});

test("at a broker 5m close: the same bars give TradingView's 5m Prophet confirmations, sent once, with the structure", async () => {
  const tv = bundle();
  const tvR38 = buildM5LocalCalculations(tv, { now: NOW }).records.find((r) => r.engine === "prophet").values.comparable.prophet_r38;
  const ai = aiWorker(minutesOf(tv.timeframes.M5.candles.slice(-500)));
  const env = { MARKET_DATA_CACHE: new MemoryKV(), AI_WORKER: ai };
  const r = await runBrokerTrigger(env, { bundle: tv, now: NOW });
  assert.equal(r.status, "sent", JSON.stringify(r));
  const p = ai.sent[0];
  assert.equal(p.close_ms, lastM5Open + 5 * 60_000);
  assert.deepEqual([p.ready, p.buy_confirmed, p.sell_confirmed], [true, tvR38.buy_confirmed === true, tvR38.sell_confirmed === true]);
  assert.deepEqual({ swing_high: p.swing_high, swing_low: p.swing_low, atr: p.atr }, structureOf(tv.timeframes.M5.candles));
  assert.equal(p.source, "mt5:monex-demo:XAUUSD.M");
  assert.ok(JSON.parse(env.MARKET_DATA_CACHE.map.get(BROKER_M5_KEY)).candles.length >= 400);
  assert.equal((await runBrokerTrigger(env, { bundle: tv, now: NOW + 20_000 })).status, "already_sent");
  assert.equal(ai.sent.length, 1);
});

test("below 400 broker bars: only the structure (not ready); stale, refused, off and unavailable", async () => {
  const tv = bundle();
  const few = aiWorker(minutesOf(tv.timeframes.M5.candles.slice(-100)));
  const r = await runBrokerTrigger({ MARKET_DATA_CACHE: new MemoryKV(), AI_WORKER: few }, { bundle: tv, now: NOW });
  assert.equal(r.status, "sent");
  assert.deepEqual([few.sent[0].ready, few.sent[0].buy_confirmed, few.sent[0].sell_confirmed], [false, false, false]);
  assert.equal((await runBrokerTrigger({ MARKET_DATA_CACHE: new MemoryKV(), AI_WORKER: aiWorker(minutesOf(tv.timeframes.M5.candles.slice(-100))) }, { bundle: tv, now: NOW + 20 * 60_000 })).status, "stale");
  const refusedEnv = { MARKET_DATA_CACHE: new MemoryKV(), AI_WORKER: aiWorker(minutesOf(tv.timeframes.M5.candles.slice(-100)), false) };
  assert.equal((await runBrokerTrigger(refusedEnv, { bundle: tv, now: NOW })).status, "refused");
  assert.equal((await runBrokerTrigger(refusedEnv, { bundle: tv, now: NOW })).status, "refused", "not marked sent: retried next minute");
  assert.equal((await runBrokerTrigger({ BROKER_TRIGGER_MODE: "off" }, { bundle: tv, now: NOW })).status, "off");
  assert.equal((await runBrokerTrigger({ AI_WORKER: {} }, { bundle: tv, now: NOW })).status, "unavailable");
  assert.equal((await runBrokerTrigger({ MARKET_DATA_CACHE: new MemoryKV(), AI_WORKER: aiWorker([]) }, { bundle: tv, now: NOW })).status, "no_broker_bars");
});
