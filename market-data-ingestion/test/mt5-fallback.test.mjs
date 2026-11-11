// The MT5 fallback (docs/RFC_MT5_FALLBACK.md; owner 2026-11-11). src/mt5-fallback.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { applyMt5Fallback, brokerCandles, gatewayDown, fallbackMode, resolveFallbackMode, FALLBACK_STALE_S, FEED_FALLBACK_KEY } from "../src/mt5-fallback.mjs";
import { SERIES, SERIES_INTERNALS, readSeries, refreshSeries, healPlan, buildBundle } from "../src/tradingview-source.mjs";

class MemoryKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key) ?? null; }
  async put(key, value) { this.map.set(key, value); }
}
const T0 = 1_800_000_000 - (1_800_000_000 % 3600); // an hour boundary, Friday 2027-01-15 (market open)
const bar = (time, seconds, o, h, l, c, v = 10) => ({ time, open_time: new Date(time * 1000).toISOString(), close_time: new Date((time + seconds) * 1000).toISOString(), open: o, high: h, low: l, close: c, volume: v });
const spec = (key) => SERIES.find((s) => s.key === key);
const put = (kv, key, record) => kv.put(SERIES_INTERNALS.SERIES_KEY_PREFIX + key, JSON.stringify({ series: key, ...record }));
/** The cache as TradingView left it at T0: 1m, 5m, 15m and 1H closed through T0. */
async function tradingViewCache(kv) {
  const m1 = [], m5 = [], m15 = [], h1 = [];
  for (let t = T0 - 3 * 3600; t < T0; t += 60) m1.push(bar(t, 60, 4040, 4041, 4039, 4040.5));
  for (let t = T0 - 3 * 3600; t < T0; t += 300) m5.push(bar(t, 300, 4040, 4041, 4039, 4040.5));
  for (let t = T0 - 3 * 3600; t < T0; t += 900) m15.push(bar(t, 900, 4040, 4041, 4039, 4040.5));
  for (let t = T0 - 3 * 3600; t < T0; t += 3600) h1.push(bar(t, 3600, 4040, 4041, 4039, 4040.5));
  const at = new Date(T0 * 1000).toISOString();
  await put(kv, "OANDA:XAUUSD|1m", { fetched_at: at, candles: m1 });
  await put(kv, "OANDA:XAUUSD|5m", { fetched_at: at, derived_from: "OANDA:XAUUSD|1m", candles: m5 });
  await put(kv, "OANDA:XAUUSD|15m", { fetched_at: at, derived_from: "OANDA:XAUUSD|1m", candles: m15 });
  await put(kv, "OANDA:XAUUSD|1h", { fetched_at: at, candles: h1 });
}
/** The broker's minutes after T0: a market 20 points lower (the broker's raw price). */
const brokerRows = (minutes) => Array.from({ length: minutes }, (_, i) => ({ t: (T0 + i * 60) * 1000, o: 4020, h: 4021 + (i % 3), l: 4019, c: 4020.5, v: 7 }));
const aiWorker = (rows) => ({ calls: [], async corpusBars(req) { this.calls.push(req); return { source: "mt5:monex-demo:XAUUSD.M", bars: rows.filter((r) => r.t > req.since_ms) }; } });

test("F1. pure parts: broker candles, the gateway-down test, the switch", () => {
  const now = T0 + 300;
  const c = brokerCandles([...brokerRows(6), { t: (T0 + 30) * 1000, o: 1, h: 1, l: 1, c: 1 }, { t: T0 * 1000, o: 5, h: 4, l: 3, c: 5 }], now);
  assert.equal(c.length, 5, "the forming minute, an unaligned bar and an inconsistent bar are dropped");
  assert.deepEqual([c[0].time, c[0].src, c[0].close_time], [T0, "mt5", new Date((T0 + 60) * 1000).toISOString()]);
  const fresh = { candles: [bar(T0 - 60, 60, 1, 1, 1, 1)] };
  assert.equal(gatewayDown("ok", fresh, T0 + 60), false);
  assert.equal(gatewayDown("mcp_quota_cooldown_active", fresh, T0 + 60), true, "the gateway's cooldown");
  assert.equal(gatewayDown("daily_budget_exhausted", fresh, T0 + 60), true);
  assert.equal(gatewayDown("partial", fresh, T0 + FALLBACK_STALE_S + 60), true, "the 1m series too far behind");
  assert.equal(fallbackMode({}), "off");
  assert.equal(fallbackMode({ FEED_FALLBACK_MODE: "auto" }), "auto");
});

test("F2. while TradingView is down the broker's minutes feed 1m, and 5m, 15m and 1H aggregate from them", async () => {
  const kv = new MemoryKV();
  await tradingViewCache(kv);
  const ai = aiWorker(brokerRows(70));
  const now = (T0 + 70 * 60 + 5) * 1000;
  const env = { MARKET_DATA_CACHE: kv, AI_WORKER: ai, FEED_FALLBACK_MODE: "auto" };
  const r = await applyMt5Fallback(env, "mcp_quota_cooldown_active", { now });
  assert.equal(r.status, "active", JSON.stringify(r));
  assert.equal(ai.calls[0].since_ms, (T0 - 60) * 1000, "from the last TradingView minute");
  const m1 = await readSeries(kv, spec("OANDA:XAUUSD|1m"));
  assert.equal(m1.candles.at(-1).close, 4020.5, "the broker's raw price");
  assert.equal(m1.candles.at(-1).src, "mt5");
  assert.equal(m1.fallback.since_sec, T0);
  assert.equal(m1.fallback.source, "mt5:monex-demo:XAUUSD.M");
  for (const [key, seconds, n] of [["OANDA:XAUUSD|5m", 300, 14], ["OANDA:XAUUSD|15m", 900, 4], ["OANDA:XAUUSD|1h", 3600, 1]]) {
    const s = await readSeries(kv, spec(key));
    const fb = s.candles.filter((c) => c.src === "mt5");
    assert.equal(fb.length, n, key);
    assert.equal(fb[0].time, T0, key);
    assert.equal(s.fallback.since_sec, T0, key);
  }
  const bundle = await buildBundle(env, now);
  assert.equal(bundle.feed, "mt5_fallback", "the engines and the 5m context know the feed");
  const again = await applyMt5Fallback(env, "mcp_quota_cooldown_active", { now: now + 60_000 });
  assert.equal(again.status, "no_broker_bars", "nothing newer yet");
  assert.equal((await readSeries(kv, spec("OANDA:XAUUSD|1m"))).fallback.since_sec, T0, "the start is kept");
});

test("F3. nothing changes while TradingView runs, the switch is off, or the market is closed", async () => {
  const kv = new MemoryKV();
  await tradingViewCache(kv);
  const ai = aiWorker(brokerRows(10));
  const base = { MARKET_DATA_CACHE: kv, AI_WORKER: ai };
  assert.equal((await applyMt5Fallback({ ...base, FEED_FALLBACK_MODE: "auto" }, "ok", { now: (T0 + 120) * 1000 })).status, "inactive");
  assert.equal((await applyMt5Fallback(base, "mcp_quota_cooldown_active", { now: (T0 + 600) * 1000 })).status, "off");
  const saturday = Date.parse("2027-01-16T15:00:00Z");
  assert.equal((await applyMt5Fallback({ ...base, FEED_FALLBACK_MODE: "auto" }, "mcp_quota_cooldown_active", { now: saturday })).status, "market_closed");
  assert.equal(ai.calls.length, 0);
  assert.equal((await readSeries(kv, spec("OANDA:XAUUSD|1m"))).fallback, undefined);
});

test("F4. healing: TradingView back, the native series are pulled over the fallback range and the derived ones re-aggregate", async () => {
  const kv = new MemoryKV();
  await tradingViewCache(kv);
  const env = { MARKET_DATA_CACHE: kv, AI_WORKER: aiWorker(brokerRows(70)), FEED_FALLBACK_MODE: "auto", TV_DAILY_CALL_BUDGET: "800" };
  await applyMt5Fallback(env, "mcp_quota_cooldown_active", { now: (T0 + 70 * 60 + 5) * 1000 });
  const nowSec = T0 + 75 * 60 + 5;
  const plan = healPlan(spec("OANDA:XAUUSD|1m"), await readSeries(kv, spec("OANDA:XAUUSD|1m")), nowSec);
  assert.deepEqual([plan.count, plan.heal], [Math.ceil((nowSec - T0) / 60) + 3, true], "back over the whole fallback");
  assert.equal(healPlan(spec("OANDA:XAUUSD|1m"), await readSeries(kv, spec("OANDA:XAUUSD|1m")), nowSec + 60), null, "once per 5 minutes, so a cooldown does not spend the daily budget");
  assert.equal(healPlan(spec("OANDA:XAUUSD|5m"), await readSeries(kv, spec("OANDA:XAUUSD|5m")), nowSec), null, "derived series heal from their source");
  // TradingView's own market after T0: 4030.
  const calls = [];
  env.TV_GATEWAY = { async ohlcv(requests) {
    calls.push(requests);
    return { status: 200, body: { results: requests.map((r) => {
      const s = SERIES.find((x) => x.symbol === r.symbol && x.interval === r.interval);
      const t = [], o = [], h = [], l = [], c = [], v = [];
      const end = Math.floor(nowSec / s.seconds) * s.seconds;
      for (let i = r.count - 1; i >= 0; i--) { const at = end - i * s.seconds; t.push(at); o.push(4030); h.push(4031); l.push(4029); c.push(4030.5); v.push(9); }
      return { ok: true, request: r, bars: { t, o, h, l, c, v } };
    }) } };
  } };
  await refreshSeries(env, { now: nowSec * 1000 });
  const m1 = await readSeries(kv, spec("OANDA:XAUUSD|1m"));
  assert.equal(m1.fallback, undefined, "healed");
  assert.equal(m1.candles.filter((x) => x.time >= T0 && x.src === "mt5").length, 0, "every broker minute was overwritten");
  const pulled1m = calls.flat().find((x) => x.interval === "1m");
  assert.ok(pulled1m.count >= 75, "the 1m pull covered the fallback range: " + pulled1m.count);
  const m5 = await readSeries(kv, spec("OANDA:XAUUSD|5m"));
  assert.equal(m5.fallback, undefined, "the 5m series re-aggregated from the healed minutes");
  assert.equal(m5.candles.find((x) => x.time === T0).close, 4030.5);
  assert.equal(m5.candles.find((x) => x.time === T0).src, undefined);
  assert.equal((await buildBundle(env, nowSec * 1000)).feed, "tradingview");
});

test("F5. the owner's switch (War Room, 2026-11-11) wins over FEED_FALLBACK_MODE", async () => {
  const kv = new MemoryKV();
  await tradingViewCache(kv);
  const ai = aiWorker(brokerRows(10));
  const now = (T0 + 10 * 60 + 5) * 1000;
  await kv.put(FEED_FALLBACK_KEY, JSON.stringify({ mode: "off", actor: "owner@example.com", reason: "test" }));
  const off = await applyMt5Fallback({ MARKET_DATA_CACHE: kv, AI_WORKER: ai, FEED_FALLBACK_MODE: "auto" }, "mcp_quota_cooldown_active", { now });
  assert.deepEqual([off.status, off.mode_source], ["off", "owner"]);
  assert.equal(ai.calls.length, 0);
  await kv.put(FEED_FALLBACK_KEY, JSON.stringify({ mode: "auto", actor: "owner@example.com", reason: "test" }));
  assert.deepEqual(await resolveFallbackMode({ MARKET_DATA_CACHE: kv }), { mode: "auto", source: "owner" });
  assert.equal((await applyMt5Fallback({ MARKET_DATA_CACHE: kv, AI_WORKER: ai }, "mcp_quota_cooldown_active", { now })).status, "active", "on without the env switch");
  await kv.put(FEED_FALLBACK_KEY, "not json");
  assert.deepEqual(await resolveFallbackMode({ MARKET_DATA_CACHE: kv, FEED_FALLBACK_MODE: "auto" }), { mode: "auto", source: "env" });
});

test("F6. 4H and daily bars from the broker's minutes follow the series' own grid (OANDA's session start, 22:00 UTC)", async () => {
  const kv = new MemoryKV();
  const sec = (iso) => Date.parse(iso) / 1000;
  const at = (s) => new Date(s * 1000).toISOString();
  // TradingView until 13:00 UTC Thursday; the 4H series' last bar 10:00, the daily one Tuesday 22:00.
  const m1 = [];
  for (let t = sec("2027-01-13T21:00:00Z"); t < sec("2027-01-14T13:00:00Z"); t += 60) m1.push(bar(t, 60, 4040, 4041, 4039, 4040.5));
  await put(kv, "OANDA:XAUUSD|1m", { fetched_at: at(sec("2027-01-14T13:00:00Z")), candles: m1 });
  await put(kv, "OANDA:XAUUSD|4h", { candles: [bar(sec("2027-01-14T06:00:00Z"), 14400, 4030, 4045, 4025, 4040), bar(sec("2027-01-14T10:00:00Z"), 14400, 4040, 4046, 4035, 4041)] });
  await put(kv, "OANDA:XAUUSD|1D", { candles: [bar(sec("2027-01-12T22:00:00Z"), 86400, 4000, 4050, 3990, 4030)] });
  const rows = [];
  for (let t = sec("2027-01-14T13:00:00Z"); t < sec("2027-01-14T22:30:00Z"); t += 60) rows.push({ t: t * 1000, o: 4020, h: 4022, l: 4018, c: 4021, v: 5 });
  const r = await applyMt5Fallback({ MARKET_DATA_CACHE: kv, AI_WORKER: aiWorker(rows), FEED_FALLBACK_MODE: "auto" }, "mcp_quota_cooldown_active", { now: Date.parse("2027-01-14T22:31:05Z") });
  assert.equal(r.status, "active", JSON.stringify(r));
  const h4 = (await readSeries(kv, spec("OANDA:XAUUSD|4h"))).candles.filter((c) => c.src === "mt5");
  assert.deepEqual(h4.map((c) => c.open_time), ["2027-01-14T14:00:00.000Z", "2027-01-14T18:00:00.000Z"], "on the 22/02/06/10/14/18 grid, not the epoch's 12/16/20");
  assert.equal(h4[0].high, 4022);
  const d1 = (await readSeries(kv, spec("OANDA:XAUUSD|1D"))).candles.filter((c) => c.src === "mt5");
  assert.deepEqual(d1.map((c) => c.open_time), ["2027-01-13T22:00:00.000Z"], "Wednesday 22:00 to Thursday 22:00, TradingView's minutes then the broker's");
  assert.deepEqual([d1[0].open, d1[0].close, d1[0].low], [4040, 4021, 4018]);
  assert.equal((await readSeries(kv, spec("OANDA:XAUUSD|1W"))), null, "the weekly bar waits for TradingView");
});
