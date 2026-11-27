// CMC USDT shadow sampler (src/cmc-usdt-shadow.mjs): parsing, the hourly gate, failure handling, 4h bars and the
// comparison with the stored TradingView series. No live network: the fetch is injected; the key is built at runtime.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CMC_SHADOW_KEY, TV_USDT_SERIES_KEY, CMC_KEEP_HOURS, cmcShadowMode, cmcUrls, parseQuote, parseGlobal, bars4hFromSamples, compareWithTv,
  runCmcUsdtStep, cmcUsdtShadowSummary
} from "../src/cmc-usdt-shadow.mjs";

const fakeKey = () => ["unit", "test", "cmc", String(process.pid)].join("-");
const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-27T08:00:00Z");

function memoryKv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, puts: 0, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { this.puts += 1; m.set(k, v); } };
}
const quoteBody = (mcap, dom = 4.9, credit = 1) => ({ status: { error_code: 0, credit_count: credit }, data: { "825": { id: 825, symbol: "USDT", quote: { USD: { market_cap: mcap, market_cap_dominance: dom, last_updated: "2026-11-27T08:05:00.000Z" } } } } });
const globalBody = (total, credit = 1) => ({ status: { error_code: 0, credit_count: credit }, data: { quote: { USD: { total_market_cap: total } } } });
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = url.includes("global-metrics") ? responses.global : responses.quote;
    if (r instanceof Error) throw r;
    return { ok: r.status === 200, status: r.status, async text() { return typeof r.body === "string" ? r.body : JSON.stringify(r.body); } };
  };
  fn.calls = calls;
  return fn;
}

test("CMC-1: switch defaults on, 'off' stops it; production on, previews off", () => {
  assert.equal(cmcShadowMode({}), "on");
  assert.equal(cmcShadowMode({ CMC_USDT_SHADOW: " OFF " }), "off");
  assert.equal(cmcShadowMode({ CMC_USDT_SHADOW: "on" }), "on");
  const prod = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const preview = readFileSync(new URL("../wrangler.preview.jsonc", import.meta.url), "utf8");
  assert.match(prod, /"CMC_USDT_SHADOW": "on"/);
  assert.match(prod.slice(prod.indexOf('"previews"')), /"CMC_USDT_SHADOW": "off"/, "previews never spend production credits");
  assert.match(preview, /"CMC_USDT_SHADOW": "off"/);
});

test("CMC-2: quote and global parsing; wrong shapes are null", () => {
  const q = parseQuote(quoteBody(1.6e11, 4.9, 1));
  assert.equal(q.mcap, 1.6e11); assert.equal(q.dom, 4.9); assert.equal(q.credit, 1); assert.equal(q.at, Date.parse("2026-11-27T08:05:00Z"));
  assert.equal(parseQuote({ data: { "825": [quoteBody(2e11).data["825"]] } }).mcap, 2e11, "the array form of v2");
  assert.equal(parseQuote({ data: {} }), null);
  assert.equal(parseQuote(quoteBody(0)), null);
  assert.equal(parseQuote(quoteBody(-5)), null);
  assert.equal(parseQuote(quoteBody(1e11, 150)).dom, null, "an impossible dominance is dropped");
  assert.equal(parseGlobal(globalBody(3.2e12)).total, 3.2e12);
  assert.equal(parseGlobal({ data: { quote: { USD: { total_market_cap: null } } } }), null);
  const u = cmcUrls();
  assert.match(u.quote, /^https:\/\/pro-api\.coinmarketcap\.com\/v2\/cryptocurrency\/quotes\/latest\?id=825/);
  assert.match(u.global, /^https:\/\/pro-api\.coinmarketcap\.com\/v1\/global-metrics\/quotes\/latest/);
});

test("CMC-3: dormant without the key, off with the switch; no fetch either way", async () => {
  const f = fakeFetch({ quote: { status: 200, body: quoteBody(1e11) }, global: { status: 200, body: globalBody(3e12) } });
  const kv = memoryKv();
  assert.deepEqual(await runCmcUsdtStep({ SIGNAL_CACHE: kv }, { now: T0, fetchImpl: f }), { status: "no_key" });
  assert.deepEqual(await runCmcUsdtStep({ SIGNAL_CACHE: kv, CMC_API_KEY: "  " }, { now: T0, fetchImpl: f }), { status: "no_key" });
  assert.deepEqual(await runCmcUsdtStep({ SIGNAL_CACHE: kv, CMC_API_KEY: fakeKey(), CMC_USDT_SHADOW: "off" }, { now: T0, fetchImpl: f }), { status: "off" });
  assert.equal(f.calls.length, 0); assert.equal(kv.puts, 0);
});

test("CMC-4: one sample per UTC hour; the key goes only in the header; the result carries no value", async () => {
  const key = fakeKey();
  const f = fakeFetch({ quote: { status: 200, body: quoteBody(1.6e11, 4.9, 1) }, global: { status: 200, body: globalBody(3.2e12, 1) } });
  const kv = memoryKv();
  const env = { SIGNAL_CACHE: kv, CMC_API_KEY: key };
  const r = await runCmcUsdtStep(env, { now: T0 + 10 * 60_000, fetchImpl: f });
  assert.equal(r.status, "sampled"); assert.equal(r.samples, 1); assert.equal(r.credits_today, 2); assert.deepEqual(r.http, { quote: 200, global: 200 });
  assert.equal(f.calls.length, 2);
  for (const c of f.calls) { assert.equal(c.init.headers["X-CMC_PRO_API_KEY"], key); assert.ok(!c.url.includes(key), "never in the URL"); }
  const text = JSON.stringify(r);
  assert.ok(!text.includes(key) && !text.includes("160000000000") && !text.includes("1.6e+11"), "no key, no value in the summary");
  const state = JSON.parse(kv.m.get(CMC_SHADOW_KEY));
  assert.equal(state.samples[0].h, T0); assert.equal(state.samples[0].mcap, 1.6e11); assert.equal(state.samples[0].dom, 5);
  // Same hour again: not due, no fetch.
  assert.deepEqual(await runCmcUsdtStep(env, { now: T0 + 40 * 60_000, fetchImpl: f }), { status: "not_due" });
  assert.equal(f.calls.length, 2);
  // Next hour: a second sample; credits add up within the UTC day.
  const r2 = await runCmcUsdtStep(env, { now: T0 + HOUR + 5 * 60_000, fetchImpl: f });
  assert.equal(r2.samples, 2); assert.equal(r2.credits_today, 4);
});

test("CMC-5: HTTP errors and timeouts are recorded once per hour and not retried in that hour", async () => {
  const kv = memoryKv();
  const env = { SIGNAL_CACHE: kv, CMC_API_KEY: fakeKey() };
  const bad = fakeFetch({ quote: { status: 401, body: "" }, global: { status: 401, body: "" } });
  const r = await runCmcUsdtStep(env, { now: T0, fetchImpl: bad });
  assert.equal(r.status, "http_error"); assert.deepEqual(r.http, { quote: 401, global: 401 }); assert.equal(r.fails, 1);
  assert.deepEqual(await runCmcUsdtStep(env, { now: T0 + 15 * 60_000, fetchImpl: bad }), { status: "not_due" });
  assert.equal(bad.calls.length, 2);
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const slow = fakeFetch({ quote: timeout, global: timeout });
  const r2 = await runCmcUsdtStep(env, { now: T0 + HOUR, fetchImpl: slow });
  assert.equal(r2.status, "fetch_failed"); assert.equal(r2.reason, "timeout"); assert.equal(r2.fails, 2);
  // A good hour resets the failure count; a missing global still keeps the quote sample.
  const half = fakeFetch({ quote: { status: 200, body: quoteBody(1e11) }, global: { status: 429, body: "" } });
  const r3 = await runCmcUsdtStep(env, { now: T0 + 2 * HOUR, fetchImpl: half });
  assert.equal(r3.status, "sampled"); assert.equal(r3.global, "missing");
  const state = JSON.parse(kv.m.get(CMC_SHADOW_KEY));
  assert.equal(state.fails, 0); assert.equal(state.samples[0].dom, null); assert.equal(state.samples[0].total, null);
  // A 200 with the wrong shape.
  const odd = fakeFetch({ quote: { status: 200, body: { data: {} } }, global: { status: 200, body: globalBody(3e12) } });
  assert.equal((await runCmcUsdtStep(env, { now: T0 + 3 * HOUR, fetchImpl: odd })).status, "bad_shape");
});

test("CMC-6: 4h bars on the UTC grid; close is the first sample after the bar closed", () => {
  const s = (hOff, mcap) => ({ h: T0 + hOff * HOUR, mcap });
  // T0 is 08:00Z, a 4h boundary.
  const bars = bars4hFromSamples([s(0, 100), s(1, 103), s(2, 98), s(3, 101), s(4, 102), s(5, 104), s(8, 99)]);
  assert.equal(bars.length, 2);
  assert.deepEqual(bars[0], { time: T0 / 1000, open: 100, high: 103, low: 98, close: 102, n: 5 });
  assert.equal(bars[1].time, (T0 + 4 * HOUR) / 1000); assert.equal(bars[1].close, 99); assert.equal(bars[1].n, 3, "missing hours inside the bar are allowed");
  assert.equal(bars4hFromSamples([s(1, 1), s(5, 2)]).length, 0, "no open on the grid, no bar");
  assert.equal(bars4hFromSamples([s(0, 1), s(1, 2)]).length, 0, "no close yet, no bar");
});

test("CMC-7: comparison with TradingView by open time, in basis points", () => {
  const bars = [{ time: 1000, close: 101 }, { time: 15400, close: 99 }, { time: 29800, close: 50 }];
  const tv = [{ time: 1000, close: 100 }, { time: 15400, close: 100 }, { time: 44200, close: 100 }, { time: 29800, close: 0 }];
  const c = compareWithTv(bars, tv);
  assert.equal(c.compared, 2); assert.equal(c.tv_bars, 3);
  assert.equal(c.median_abs_bp, 100); assert.equal(c.max_abs_bp, 100); assert.equal(c.mean_signed_bp, 0);
  assert.deepEqual(compareWithTv(bars, []), { compared: 0, tv_bars: 0 });
});

test("CMC-8: the step compares against the stored TV series and keeps at most CMC_KEEP_HOURS samples", async () => {
  const tvCandles = [{ time: T0 / 1000, close: 200 }];
  const old = Array.from({ length: CMC_KEEP_HOURS + 3 }, (_, i) => ({ h: T0 - (CMC_KEEP_HOURS + 3 - i) * HOUR, mcap: 1 }));
  old.push({ h: T0, mcap: 200 }, { h: T0 + HOUR, mcap: 201 }, { h: T0 + 2 * HOUR, mcap: 199 }, { h: T0 + 3 * HOUR, mcap: 200 });
  const kv = memoryKv({ [CMC_SHADOW_KEY]: JSON.stringify({ samples: old }), [TV_USDT_SERIES_KEY]: JSON.stringify({ candles: tvCandles }) });
  const f = fakeFetch({ quote: { status: 200, body: quoteBody(202) }, global: { status: 200, body: globalBody(4040) } });
  const r = await runCmcUsdtStep({ SIGNAL_CACHE: kv, CMC_API_KEY: fakeKey() }, { now: T0 + 4 * HOUR + 60_000, fetchImpl: f });
  assert.equal(r.status, "sampled"); assert.equal(r.samples, CMC_KEEP_HOURS);
  assert.equal(r.compare.compared, 1); assert.equal(r.compare.median_abs_bp, 100);
  const sum = await cmcUsdtShadowSummary({ SIGNAL_CACHE: kv });
  assert.equal(sum.status, "ok"); assert.equal(sum.samples, CMC_KEEP_HOURS); assert.equal(sum.last_hour, new Date(T0 + 4 * HOUR).toISOString());
  assert.ok(!/mcap|"close"|"total"|"dom"/.test(JSON.stringify(sum)), "the summary carries no value");
  assert.deepEqual(await cmcUsdtShadowSummary({ SIGNAL_CACHE: memoryKv() }), { status: "empty" });
});

test("CMC-9: the sweep calls the step in the trading and the closed-market branch, and logs without values", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.equal((src.match(/logCmcUsdt\(await runCmcUsdtStep\(env, \{ now: event\.scheduledTime \|\| Date\.now\(\) \}\)\)/g) || []).length, 2);
  assert.match(src, /r\.status !== "not_due" && r\.status !== "off" && r\.status !== "no_key"/);
});
