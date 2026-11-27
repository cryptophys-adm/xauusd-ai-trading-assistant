// K1 (cost brief 2026-11-27): the EA signal reads a 48-bar tail of the gold 5m series instead of the ~880 KB series.
// Equality proof: for any stored series (unsorted, with invalid bars), the reader's last bar and last 24 bars from the
// tail equal those from the full series. Synthetic bars only; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tailOf, TAIL_BARS, TAIL_KEY_PREFIX, TAIL_SERIES, writeSeries, SERIES } from "../market-data-ingestion/src/tradingview-source.mjs";
import { readFeedCandles, eaSignalTailMode, EA_TAIL_KEY, EA_SERIES_KEY, EA_TAIL_MAX_AGE_MS, EA_TAIL_COMPARE_BARS, tailShadowStats } from "../src/ea-signal.mjs";

const T0 = Date.parse("2026-11-26T00:00:00Z");
function series(n, { shuffle = false, junk = false } = {}) {
  let candles = Array.from({ length: n }, (_, i) => {
    const open = T0 + i * 300_000;
    const close = 100 + Math.sin(i / 7) * 3 + i * 0.01;
    return { time: open / 1000, open_time: new Date(open).toISOString(), close_time: new Date(open + 300_000).toISOString(), open: close - 0.1, high: close + 0.2, low: close - 0.3, close: Math.round(close * 100) / 100, volume: i };
  });
  if (junk) candles.push({ time: 1, close: null, close_time: "x" }, { time: 2, close: -1, close_time: new Date(T0).toISOString() }, { time: 3, close: 101, close_time: null }, { time: 4, close: Number.NaN, close_time: new Date(T0 + 1).toISOString() });
  if (shuffle) candles = candles.map((c, i) => [((i * 7919) % 1009), c]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  return { series: "OANDA:XAUUSD|5m", fetched_at: new Date(T0 + n * 300_000).toISOString(), candle_count: candles.length, candles };
}
function countingKv(init = {}) {
  const m = new Map(Object.entries(init));
  const gets = [];
  return { m, gets, async get(k) { gets.push(k); return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } };
}
const readerOf = (rec) => (rec.candles || []).filter((c) => typeof c?.close === "number" && Number.isFinite(c.close) && c.close > 0 && c.close_time).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));

test("K1-1: the tail keeps the reader's last 48 bars of any series (equality proof)", () => {
  for (const opts of [{}, { shuffle: true }, { junk: true }, { shuffle: true, junk: true }]) {
    for (const n of [0, 5, 24, 48, 49, 5000]) {
      const rec = series(n, opts);
      const full = readerOf(rec), tail = readerOf(tailOf(rec));
      assert.equal(tail.length, Math.min(TAIL_BARS, full.length));
      assert.deepEqual(tail.at(-1), full.at(-1), `last bar, n=${n} ${JSON.stringify(opts)}`);
      assert.deepEqual(tail.slice(-EA_TAIL_COMPARE_BARS), full.slice(-EA_TAIL_COMPARE_BARS), `last 24, n=${n}`);
    }
  }
  const t = tailOf({ ...series(10), fallback: { since_sec: 5 } });
  assert.equal(t.series, "OANDA:XAUUSD|5m"); assert.equal(t.tail_of, 10); assert.deepEqual(t.fallback, { since_sec: 5 });
  assert.ok(TAIL_BARS >= EA_TAIL_COMPARE_BARS);
});

test("K1-2: writeSeries writes the tail beside the gold 5m series only", async () => {
  const kv = countingKv();
  const m5 = SERIES.find((s) => s.key === "OANDA:XAUUSD|5m"), m1 = SERIES.find((s) => s.key === "OANDA:XAUUSD|1m");
  assert.deepEqual([...TAIL_SERIES], ["OANDA:XAUUSD|5m"]);
  await writeSeries(kv, m1, series(10));
  assert.equal(kv.m.has(TAIL_KEY_PREFIX + "OANDA:XAUUSD|1m"), false);
  const rec = series(300, { shuffle: true });
  await writeSeries(kv, m5, rec);
  assert.equal(TAIL_KEY_PREFIX + m5.key, EA_TAIL_KEY);
  const tail = JSON.parse(kv.m.get(EA_TAIL_KEY));
  assert.equal(tail.candles.length, TAIL_BARS);
  assert.ok(kv.m.get(EA_TAIL_KEY).length * 5 < kv.m.get(EA_SERIES_KEY).length, "the tail is a small fraction of the series");
});

test("K1-3: 'on' reads only the tail while it is fresh, with the same bars as the series", async () => {
  const rec = series(5000, { shuffle: true, junk: true });
  const now = Date.parse(rec.fetched_at) + 60_000;
  const kv = countingKv({ [EA_SERIES_KEY]: JSON.stringify(rec), [EA_TAIL_KEY]: JSON.stringify(tailOf(rec)) });
  const got = await readFeedCandles({ SIGNAL_CACHE: kv }, { now });
  assert.deepEqual(kv.gets, [EA_TAIL_KEY], "the series is not read");
  const full = readerOf(rec);
  assert.deepEqual(got.at(-1), full.at(-1));
  assert.deepEqual(got.slice(-24), full.slice(-24));
});

test("K1-4: a missing, empty, unparsable or stale tail falls back to the series", async () => {
  const rec = series(100);
  const fresh = Date.parse(rec.fetched_at) + 60_000;
  const cases = [
    [null, fresh], ["not json", fresh], [JSON.stringify({ ...tailOf(rec), candles: [] }), fresh],
    [JSON.stringify({ ...tailOf(rec), fetched_at: null }), fresh], [JSON.stringify(tailOf(rec)), Date.parse(rec.fetched_at) + EA_TAIL_MAX_AGE_MS + 1]
  ];
  for (const [tailRaw, now] of cases) {
    const kv = countingKv({ [EA_SERIES_KEY]: JSON.stringify(rec), ...(tailRaw == null ? {} : { [EA_TAIL_KEY]: tailRaw }) });
    const got = await readFeedCandles({ SIGNAL_CACHE: kv }, { now });
    assert.deepEqual(kv.gets, [EA_TAIL_KEY, EA_SERIES_KEY]);
    assert.equal(got.length, readerOf(rec).length);
  }
  const kv = countingKv();
  assert.deepEqual(await readFeedCandles({ SIGNAL_CACHE: kv }, { now: fresh }), [], "nothing stored: no bars, no throw");
});

test("K1-5: 'off' reads the series as before; 'shadow' reads both, uses the series and counts a mismatch", async () => {
  const rec = series(200);
  const now = Date.parse(rec.fetched_at) + 60_000;
  const kvOff = countingKv({ [EA_SERIES_KEY]: JSON.stringify(rec), [EA_TAIL_KEY]: JSON.stringify(tailOf(rec)) });
  const off = await readFeedCandles({ SIGNAL_CACHE: kvOff, EA_SIGNAL_TAIL: "off" }, { now });
  assert.deepEqual(kvOff.gets, [EA_SERIES_KEY]); assert.equal(off.length, 200);
  const before = { ...tailShadowStats };
  const kvSh = countingKv({ [EA_SERIES_KEY]: JSON.stringify(rec), [EA_TAIL_KEY]: JSON.stringify(tailOf(rec)) });
  const sh = await readFeedCandles({ SIGNAL_CACHE: kvSh, EA_SIGNAL_TAIL: "shadow" }, { now });
  assert.deepEqual(kvSh.gets, [EA_TAIL_KEY, EA_SERIES_KEY]); assert.equal(sh.length, 200);
  assert.equal(tailShadowStats.compared, before.compared + 1); assert.equal(tailShadowStats.mismatched, before.mismatched);
  const stale = tailOf(series(150)); stale.fetched_at = rec.fetched_at;
  const kvMis = countingKv({ [EA_SERIES_KEY]: JSON.stringify(rec), [EA_TAIL_KEY]: JSON.stringify(stale) });
  await readFeedCandles({ SIGNAL_CACHE: kvMis, EA_SIGNAL_TAIL: "shadow" }, { now });
  assert.equal(tailShadowStats.mismatched, before.mismatched + 1);
});

test("K1-6: the switch defaults to on; production sets it on", () => {
  assert.equal(eaSignalTailMode({}), "on");
  assert.equal(eaSignalTailMode({ EA_SIGNAL_TAIL: " Shadow " }), "shadow");
  assert.equal(eaSignalTailMode({ EA_SIGNAL_TAIL: "off" }), "off");
  assert.equal(eaSignalTailMode({ EA_SIGNAL_TAIL: "junk" }), "on");
  assert.match(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"), /"EA_SIGNAL_TAIL": "on"/);
});
