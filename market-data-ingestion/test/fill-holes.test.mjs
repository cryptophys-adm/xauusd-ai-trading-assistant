// BF1 (d): filling the 1m series' holes from the corpus (src/mt5-fallback.mjs fillHoles). No network.
import test from "node:test";
import assert from "node:assert/strict";
import { fillHoles, seriesHoles, filledBuckets, goldTradesAt, FILL_WINDOW_S, FILL_EVERY_MIN } from "../src/mt5-fallback.mjs";
import { SERIES, SERIES_INTERNALS, readSeries } from "../src/tradingview-source.mjs";
import { breakoutAgeBars } from "../../src/fresh-pattern.mjs";
import { breakoutCloseMs } from "../../src/public-patterns.mjs";

class MemoryKV {
  constructor() { this.map = new Map(); this.writes = 0; }
  async get(key) { return this.map.get(key) ?? null; }
  async put(key, value) { this.writes += 1; this.map.set(key, value); }
}
const T0 = 1_800_000_000 - (1_800_000_000 % 3600); // 2027-01-15 08:00 UTC, a Friday, gold trading
const bar = (time, seconds, o, h, l, c, v = 10) => ({ time, open_time: new Date(time * 1000).toISOString(), close_time: new Date((time + seconds) * 1000).toISOString(), open: o, high: h, low: l, close: c, volume: v });
const spec = (key) => SERIES.find((s) => s.key === key);
const put = (kv, key, record) => kv.put(SERIES_INTERNALS.SERIES_KEY_PREFIX + key, JSON.stringify({ series: key, ...record }));
const HOLE_FROM = T0 - 90 * 60, HOLE_TO = T0 - 60 * 60; // 06:30-06:59 missing
/** TradingView's cache through T0 with 30 minutes missing in 1m, and the 5m, 15m and 1H bars over them missing too (but one 15m bar). */
async function cacheWithHole(kv, { keep15 = null } = {}) {
  const inHole = (t, s) => t + s > HOLE_FROM && t < HOLE_TO;
  const series = (s) => { const out = []; for (let t = T0 - 3 * 3600; t < T0; t += s) if (!inHole(t, s) || (s === 900 && t === keep15)) out.push(bar(t, s, 4040, 4041, 4039, 4040.5)); return out; };
  const at = new Date(T0 * 1000).toISOString();
  await put(kv, "OANDA:XAUUSD|1m", { fetched_at: at, candles: series(60) });
  await put(kv, "OANDA:XAUUSD|5m", { fetched_at: at, derived_from: "OANDA:XAUUSD|1m", candles: series(300) });
  await put(kv, "OANDA:XAUUSD|15m", { fetched_at: at, derived_from: "OANDA:XAUUSD|1m", candles: series(900) });
  await put(kv, "OANDA:XAUUSD|1h", { fetched_at: at, candles: series(3600) });
}
const rows = (fromSec, n, c = 4020.5) => Array.from({ length: n }, (_, i) => ({ t: (fromSec + i * 60) * 1000, o: c - 0.5, h: c + 1, l: c - 1, c, v: 7 }));
/** The corpus: the feed bridge's source holds the hole's first 20 minutes, the executor's the whole hole. */
const corpus = ({ feed = rows(HOLE_FROM, 20, 4030.5), exec = rows(HOLE_FROM, 30, 4020.5), feedFresh = true } = {}) => ({
  calls: [],
  async corpusBars(req) {
    this.calls.push(req);
    const pick = req.prefer_feed && feedFresh ? { source: "mt5:feedbroker-demo:XAUUSD", feed: true, bars: feed } : { source: "mt5:execbroker:GOLD", feed: false, bars: exec };
    return { ...pick, bars: pick.bars.filter((r) => r.t > req.since_ms).slice(0, req.limit) };
  }
});
const NOW = (T0 + 5 * 60) * 1000; // 08:05, a fill minute
const ENV = (kv, ai, extra = {}) => ({ MARKET_DATA_CACHE: kv, AI_WORKER: ai, FEED_FALLBACK_MODE: "auto", ...extra });

test("FH-1 pure parts: gold's hours and the holes of a series", () => {
  assert.equal(goldTradesAt(Date.parse("2026-11-24T12:00:00Z") / 1000), true);
  assert.equal(goldTradesAt(Date.parse("2026-11-24T22:30:00Z") / 1000), false, "the daily break in November");
  assert.equal(goldTradesAt(Date.parse("2026-11-29T22:30:00Z") / 1000), false, "Sunday before the reopen");
  assert.equal(goldTradesAt(Date.parse("2026-11-29T23:00:00Z") / 1000), true);
  const contiguous = Array.from({ length: 10 }, (_, i) => bar(T0 - 600 + i * 60, 60, 1, 1, 1, 1));
  assert.deepEqual(seriesHoles(contiguous, T0), []);
  const brk = [bar(Date.parse("2026-11-24T21:59:00Z") / 1000, 60, 1, 1, 1, 1), bar(Date.parse("2026-11-24T23:00:00Z") / 1000, 60, 1, 1, 1, 1)];
  assert.deepEqual(seriesHoles(brk, Date.parse("2026-11-24T23:05:00Z") / 1000), [], "the daily break is no hole");
  const holed = [bar(T0 - 3600, 60, 1, 1, 1, 1), bar(T0 - 1800, 60, 1, 1, 1, 1)];
  assert.deepEqual(seriesHoles(holed, T0), [{ from: T0 - 3540, to: T0 - 1800, minutes: 29 }]);
  assert.deepEqual(seriesHoles(holed, T0 + FILL_WINDOW_S), [], "a hole older than the window is left");
  assert.deepEqual([FILL_WINDOW_S, FILL_EVERY_MIN], [36_000, 5]);
});

test("FH-2 the feed fills first, the executor the rest; no bar is replaced; the buckets the fill completes are built", async () => {
  const kv = new MemoryKV();
  await cacheWithHole(kv, { keep15: T0 - 90 * 60 });
  const before = await readSeries(kv, spec("OANDA:XAUUSD|1m"));
  const ai = corpus();
  const r = await fillHoles(ENV(kv, ai), { now: NOW });
  assert.equal(r.status, "filled", JSON.stringify(r));
  assert.deepEqual([r.holes, r.missing, r.filled, r.by_source], [1, 30, 30, { "mt5-feed": 20, "mt5-exec": 10 }]);
  assert.deepEqual(ai.calls.map((c) => [c.prefer_feed, c.since_ms, c.limit]), [[true, (HOLE_FROM - 60) * 1000, 31], [false, (HOLE_FROM - 60) * 1000, 31]], "bounded to the hole");
  const m1 = await readSeries(kv, spec("OANDA:XAUUSD|1m"));
  assert.equal(m1.candles.length, before.candles.length + 30);
  const filled = m1.candles.filter((c) => c.fill);
  assert.deepEqual([filled.length, filled[0].time, filled[0].src, filled[0].close, filled.at(-1).src, filled.at(-1).close], [30, HOLE_FROM, "mt5-feed", 4030.5, "mt5-exec", 4020.5]);
  const untouched = m1.candles.filter((c) => !c.fill);
  assert.deepEqual(untouched, before.candles, "every TradingView minute byte for byte");
  // 5m: the six buckets of the hole; 15m: 06:45 only (06:30 had a bar, kept); 1H: 06:00-07:00, whole once the hole is filled.
  const m5 = await readSeries(kv, spec("OANDA:XAUUSD|5m"));
  assert.equal(m5.candles.filter((c) => c.fill).length, 6);
  const m15 = await readSeries(kv, spec("OANDA:XAUUSD|15m"));
  const f15 = m15.candles.filter((c) => c.fill);
  assert.deepEqual(f15.map((c) => [c.time, c.src, c.open_time]), [[T0 - 75 * 60, "mt5-exec", new Date((T0 - 75 * 60) * 1000).toISOString()]], "its own open time; the kept 06:30 bar not replaced");
  assert.equal(m15.candles.find((c) => c.time === T0 - 90 * 60).close, 4040.5, "the TradingView 15m bar stays");
  const h1 = await readSeries(kv, spec("OANDA:XAUUSD|1h"));
  const f1h = h1.candles.filter((c) => c.fill);
  assert.deepEqual(f1h.map((c) => [c.time, c.src]), [[T0 - 2 * 3600, "mt5-exec"]], "06:00-07:00, whole now: half TradingView's minutes, half the corpus's");
  assert.equal(f1h[0].close, 4020.5, "its last minute's close");
  // Run again: no hole left, nothing asked.
  const again = await fillHoles(ENV(kv, corpus()), { now: NOW });
  assert.equal(again.status, "no_hole");
});

test("FH-3 off, not due, closed market, an empty corpus, no hole", async () => {
  const kv = new MemoryKV();
  await cacheWithHole(kv);
  assert.equal((await fillHoles(ENV(kv, corpus(), { FEED_FALLBACK_MODE: "off" }), { now: NOW })).status, "off", "the owner's fallback switch governs it");
  assert.equal((await fillHoles(ENV(kv, corpus()), { now: NOW + 60_000 })).status, "not_due");
  assert.equal((await fillHoles(ENV(kv, corpus()), { now: Date.parse("2027-01-16T12:00:00Z") })).status, "market_closed");
  const writes = kv.writes;
  const empty = await fillHoles(ENV(kv, corpus({ feed: [], exec: [] })), { now: NOW });
  assert.deepEqual([empty.status, empty.missing, kv.writes], ["nothing_in_corpus", 30, writes], "nothing written");
  // Without a fresh feed the executor's bars fill the whole hole in one read.
  const ai = corpus({ feedFresh: false });
  const r = await fillHoles(ENV(kv, ai), { now: NOW });
  assert.deepEqual([r.status, r.by_source, ai.calls.length], ["filled", { "mt5-exec": 30 }, 1]);
  const none = corpus();
  assert.equal((await fillHoles(ENV(kv, none), { now: NOW })).status, "no_hole");
  assert.equal(none.calls.length, 0, "no hole: no corpus read");
});

test("FH-4 filledBuckets: only whole buckets, never one that exists", () => {
  const m = Array.from({ length: 15 }, (_, i) => ({ ...bar(T0 + i * 60, 60, 1, 2, 0.5, 1.5), src: i < 5 ? "mt5-feed" : undefined }));
  const out = filledBuckets(m, [T0], [], { seconds: 900, nowSec: T0 + 3600 });
  assert.deepEqual(out.map((c) => [c.time, c.src, c.open, c.close, c.volume, c.fill]), [[T0, "mt5-feed", 1, 1.5, 150, true]]);
  assert.deepEqual(filledBuckets(m.slice(1), [T0 + 60], [], { seconds: 900, nowSec: T0 + 3600 }), [], "a minute missing: not whole");
  assert.deepEqual(filledBuckets(m, [T0], [bar(T0, 900, 9, 9, 9, 9)], { seconds: 900, nowSec: T0 + 3600 }), [], "the series' bar stays");
  assert.deepEqual(filledBuckets(m, [T0], [], { seconds: 900, nowSec: T0 + 600 }), [], "a bucket not yet closed");
});

test("FH-5 no retro-trigger: a filled 15m bar three bars back is no fresh breakout, for FP1 and the public patterns", () => {
  // 40 quiet 15m bars below 4000, then a filled bar breaking the line, then three more bars beyond it.
  const quiet = Array.from({ length: 40 }, (_, i) => ({ ...bar(T0 - 44 * 900 + i * 900, 900, 3993, 3996, 3990, 3993) }));
  const beyond = Array.from({ length: 4 }, (_, i) => ({ ...bar(T0 - 4 * 900 + i * 900, 900, 4003, 4005, 3999, 4003), ...(i === 0 ? { src: "mt5-exec", fill: true } : {}) }));
  const bars = [...quiet, ...beyond];
  const wedge = { direction: 1, upper: 4000, lower: 3985, bars_ago: 8, end_bar: 30 };
  assert.equal(breakoutAgeBars(bars, wedge), 3, "three closed bars since the filled bar broke: FP1's limit is 1");
  assert.equal(breakoutCloseMs(bars, wedge, { barMs: 900_000 }), (T0 - 3 * 900) * 1000, "confirmed at the filled bar's own close: CTA's breakoutState reads it stale");
});
