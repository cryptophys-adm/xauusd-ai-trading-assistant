import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aggregateCandles, sourceCovers, compareWithNative } from "../src/derived-series.mjs";
import { SERIES, refreshSeries, verifyDerivedSeries, readSeries, SERIES_INTERNALS } from "../src/tradingview-source.mjs";

class MemoryKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key) ?? null; }
  async put(key, value) { this.map.set(key, value); }
}

const bar = (time, seconds, o, h, l, c, v) => ({ time, open_time: new Date(time * 1000).toISOString(), close_time: new Date((time + seconds) * 1000).toISOString(), open: o, high: h, low: l, close: c, volume: v });
const T0 = 1_800_000_000 - (1_800_000_000 % 900); // a 15m boundary

/** A synthetic 1m market: every interval is the exact aggregation of these minutes. */
function minute(t, symbol = "OANDA:XAUUSD") {
  const k = t / 60 + (symbol === "TVC:USOIL" ? 7 : 0);
  const o = 2300 + Math.sin(k / 9) * 3, c = 2300 + Math.sin((k + 1) / 9) * 3;
  return { t, o, c, h: Math.max(o, c) + 0.2 + (k % 5) / 10, l: Math.min(o, c) - 0.2, v: 10 + (k % 7) };
}
function nativeBars(symbol, seconds, count, nowSec) {
  const forming = Math.floor(nowSec / seconds) * seconds;
  const t = [], o = [], h = [], l = [], c = [], v = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = forming - i * seconds;
    const ms = [];
    for (let m = start; m < start + seconds && m < nowSec; m += 60) ms.push(minute(m, symbol));
    if (!ms.length) continue;
    t.push(start); o.push(ms[0].o); c.push(ms.at(-1).c); h.push(Math.max(...ms.map((x) => x.h))); l.push(Math.min(...ms.map((x) => x.l))); v.push(ms.reduce((a, x) => a + x.v, 0));
  }
  return { t, o, h, l, c, v };
}
function gateway(nowSec) {
  const calls = [];
  return {
    calls,
    async ohlcv(requests) {
      calls.push(requests);
      return { status: 200, body: { results: requests.map((r) => {
        const spec = SERIES.find((s) => s.symbol === r.symbol && s.interval === r.interval);
        return { ok: true, request: r, bars: nativeBars(r.symbol, spec.seconds, r.count, nowSec) };
      }) } };
    }
  };
}
const closed = (symbol, seconds, count, nowSec) => {
  const b = nativeBars(symbol, seconds, count + 1, nowSec);
  return b.t.slice(0, -1).map((t, i) => bar(t, seconds, b.o[i], b.h[i], b.l[i], b.c[i], b.v[i]));
};

test("aggregation: first open, highest high, lowest low, last close, summed volume; incomplete buckets wait", () => {
  const ones = [0, 1, 2, 3, 4, 5, 6].map((i) => bar(T0 + i * 60, 60, 10 + i, 12 + i, 9 + i, 11 + i, 1 + i));
  const out = aggregateCandles(ones, { seconds: 300, sourceSeconds: 60, nowSec: T0 + 7 * 60 });
  assert.equal(out.length, 1, "the second 5m bucket has not ended");
  assert.deepEqual(out[0], bar(T0, 300, 10, 16, 9, 15, 15));
  // A quiet last minute: the bucket completes once the source was fetched a minute past its end.
  const quiet = ones.slice(0, 4);
  assert.equal(aggregateCandles(quiet, { seconds: 300, sourceSeconds: 60, nowSec: T0 + 360, fetchedAtSec: T0 + 330 }).length, 0);
  assert.equal(aggregateCandles(quiet, { seconds: 300, sourceSeconds: 60, nowSec: T0 + 400, fetchedAtSec: T0 + 360 })[0].close, 14);
  // A null volume makes the bucket's volume null; `after` skips stored buckets.
  const nullVol = ones.slice(0, 5).map((c, i) => (i === 2 ? { ...c, volume: null } : c));
  assert.equal(aggregateCandles(nullVol, { seconds: 300, sourceSeconds: 60, nowSec: T0 + 600 })[0].volume, null);
  assert.equal(aggregateCandles(ones, { seconds: 300, sourceSeconds: 60, nowSec: T0 + 600, after: T0 }).length, 0);
});

test("coverage and native comparison", () => {
  assert.equal(sourceCovers(bar(T0, 300), [bar(T0 + 120, 60)], 300), true);
  assert.equal(sourceCovers(bar(T0, 300), [bar(T0 + 600, 60)], 300), false, "the first missing bucket starts before the source");
  const d = [bar(T0, 300, 1, 2, 0, 1, 5)];
  assert.deepEqual(compareWithNative(d, [bar(T0, 300, 1, 2, 0, 1, 5)]), { compared: 1, mismatched: 0, mismatches: [] });
  assert.equal(compareWithNative(d, [bar(T0, 300, 1, 2.5, 0, 1, 5)]).mismatches[0].fields.join(), "high");
});

test("a refresh pulls M1 and USOIL 5m only, and extends XAUUSD M5/M15 and USOIL M15/H1 locally", async () => {
  const kv = new MemoryKV();
  const start = T0 + 3600; // cached through T0+3600
  for (const spec of SERIES) {
    const nowSec = spec.seconds >= 3600 ? start + 3 * 3600 : start; // H1+ series are already current later
    const candles = closed(spec.symbol, spec.seconds, Math.min(60, spec.retain), spec.seconds >= 14400 ? T0 + 30 * 86400 : nowSec);
    await kv.put(SERIES_INTERNALS.SERIES_KEY_PREFIX + spec.key, JSON.stringify({ series: spec.key, fetched_at: new Date(start * 1000).toISOString(), candles }));
  }
  // H1/H4/D1/W1 and the 4h macro series are current, so only the two 5-minute sources are due.
  const now = (start + 30 * 60 + 5) * 1000;
  const gw = gateway(Math.floor(now / 1000));
  const env = { MARKET_DATA_CACHE: kv, TV_GATEWAY: gw, TV_DAILY_CALL_BUDGET: "800" };
  const r = await refreshSeries(env, { now });
  const pulled = gw.calls.flat().map((x) => `${x.symbol}|${x.interval}`).sort();
  assert.ok(pulled.every((k) => ["OANDA:XAUUSD|1m", "TVC:USOIL|5m"].includes(k)), "no native 5m/15m XAUUSD and no USOIL 15m/1h: " + pulled.join());
  assert.deepEqual(r.derived.map((d) => d.series).sort(), ["OANDA:XAUUSD|15m", "OANDA:XAUUSD|5m", "TVC:USOIL|15m"].sort());
  // The derived bars equal the native bars of the same market.
  for (const key of ["OANDA:XAUUSD|5m", "OANDA:XAUUSD|15m", "TVC:USOIL|15m"]) {
    const spec = SERIES.find((s) => s.key === key);
    const stored = (await readSeries(kv, spec)).candles;
    const native = closed(spec.symbol, spec.seconds, 8, Math.floor(now / 1000));
    const cmp = compareWithNative(stored, native);
    assert.ok(cmp.compared >= 2, key);
    assert.equal(cmp.mismatched, 0, key + " " + JSON.stringify(cmp.mismatches));
  }
  assert.equal(JSON.parse(await kv.get(SERIES_INTERNALS.SERIES_KEY_PREFIX + "OANDA:XAUUSD|5m")).derived_from, "OANDA:XAUUSD|1m");
});

test("a derived cache the source no longer reaches is filled natively once", async () => {
  const kv = new MemoryKV();
  const nowSec = T0 + 10 * 86400;
  for (const spec of SERIES) {
    const at = spec.key === "OANDA:XAUUSD|15m" ? T0 : nowSec; // 15m cache is 10 days old
    await kv.put(SERIES_INTERNALS.SERIES_KEY_PREFIX + spec.key, JSON.stringify({ series: spec.key, fetched_at: new Date(at * 1000).toISOString(), candles: closed(spec.symbol, spec.seconds, 40, at) }));
  }
  const gw = gateway(nowSec + 400);
  await refreshSeries({ MARKET_DATA_CACHE: kv, TV_GATEWAY: gw, TV_DAILY_CALL_BUDGET: "800" }, { now: (nowSec + 400) * 1000 });
  assert.ok(gw.calls.flat().some((x) => x.symbol === "OANDA:XAUUSD" && x.interval === "15m"), "gap fill for the stale 15m cache");
});

test("the daily check compares every derived series with a few native bars, once per UTC day from 01:00", async () => {
  const kv = new MemoryKV();
  const nowSec = T0 - (T0 % 86400) + 2 * 3600; // 02:00 UTC
  for (const spec of SERIES.filter((s) => s.derived_from)) {
    await kv.put(SERIES_INTERNALS.SERIES_KEY_PREFIX + spec.key, JSON.stringify({ candles: closed(spec.symbol, spec.seconds, 60, nowSec) }));
  }
  const gw = gateway(nowSec);
  const env = { MARKET_DATA_CACHE: kv, TV_GATEWAY: gw, TV_DAILY_CALL_BUDGET: "800" };
  const r = await verifyDerivedSeries(env, { now: nowSec * 1000 });
  assert.equal(r.status, "match", JSON.stringify(r));
  assert.equal(r.series.length, 5, "XAUUSD 5m, 15m and 1h (since 2026-11-14), USOIL 15m and 1h");
  assert.ok(r.series.every((x) => x.compared > 0 && x.mismatched === 0));
  assert.equal((await verifyDerivedSeries(env, { now: nowSec * 1000 + 60_000 })).status, "not_due", "once a day");
  assert.equal(gw.calls.length, 1);
});

test("steady-state daily MCP demand fits the 800 budget with margin", () => {
  const cronSeconds = 300;
  const perDay = SERIES.filter((s) => !s.derived_from).reduce((sum, s) => sum + 86400 / Math.max(cronSeconds, s.seconds), 0) + SERIES.filter((s) => s.derived_from).length;
  const budget = Number(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").match(/"TV_DAILY_CALL_BUDGET":\s*"(\d+)"/)[1]);
  assert.equal(budget, 800);
  assert.ok(perDay <= 0.8 * budget, `demand ${Math.round(perDay)} a day`);
  assert.ok(SERIES.some((s) => s.key === "TVC:USOIL|5m" && !s.derived_from), "USOIL stays a 5m pull (Macro & Aether WTI)");
});

test("a one-day budget override applies to its UTC date only", async () => {
  const { SERIES_INTERNALS } = await import("../src/tradingview-source.mjs");
  const env = { TV_DAILY_CALL_BUDGET: "800", TV_DAILY_CALL_BUDGET_OVERRIDE: "2026-11-08:1000" };
  assert.equal(SERIES_INTERNALS.dailyBudget(env, Date.parse("2026-11-08T22:05:00Z")), 1000);
  assert.equal(SERIES_INTERNALS.dailyBudget(env, Date.parse("2026-11-09T00:00:00Z")), 800, "lapses at the next UTC midnight");
  assert.equal(SERIES_INTERNALS.dailyBudget({ TV_DAILY_CALL_BUDGET: "800", TV_DAILY_CALL_BUDGET_OVERRIDE: "junk" }, Date.parse("2026-11-08T22:05:00Z")), 800);
});

test("the XAUUSD 1H bar is built from the hour's 1m bars on the UTC hour (since 2026-11-14, the TradingView quota)", () => {
  const h1 = SERIES.find((s) => s.key === "OANDA:XAUUSD|1h");
  assert.equal(h1.derived_from, "OANDA:XAUUSD|1m");
  const start = Date.UTC(2026, 10, 16, 14, 0) / 1000;
  const minutes = Array.from({ length: 60 }, (_, i) => ({ time: start + i * 60, open: 100 + i, high: 101 + i + (i === 30 ? 9 : 0), low: 99 + i - (i === 10 ? 7 : 0), close: 100.5 + i, volume: 2 }));
  const out = aggregateCandles(minutes, { seconds: 3600, sourceSeconds: 60, nowSec: start + 3600 + 5, fetchedAtSec: start + 3600 + 5 });
  assert.deepEqual(out.map((c) => [c.open_time, c.close_time, c.open, c.high, c.low, c.close, c.volume]), [["2026-11-16T14:00:00.000Z", "2026-11-16T15:00:00.000Z", 100, 160, 99, 159.5, 120]]);
  assert.deepEqual(aggregateCandles(minutes.slice(0, 59), { seconds: 3600, sourceSeconds: 60, nowSec: start + 3600 - 30 }), [], "not before the hour is complete");
});
