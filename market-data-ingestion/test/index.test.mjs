import test from "node:test";
import assert from "node:assert/strict";
import { SERIES } from "../src/tradingview-source.mjs";

const { default: worker, internals } = await import("../src/index.mjs");

class MemoryKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key) ?? null; }
  async put(key, value) { this.map.set(key, value); }
}

// The pulls compare bar times with Date.now(): a 1m, 5m or 15m bar that closed while a test ran
// made the second pull fetch new bars (CI on PR #116: "6 !== 4" at a quarter-hour boundary).
// Every test reads a frozen clock in the middle of every bar, far from any boundary.
const FROZEN_NOW = Date.parse("2026-11-04T10:07:30.000Z");
test.beforeEach((t) => t.mock.timers.enable({ apis: ["Date"], now: FROZEN_NOW }));

const SECRET = "test-secret";
const auth = { authorization: `Bearer ${SECRET}` };

/** Fake gateway: serves TradingView-like columns ending with a still-forming bar. */
function fakeGateway({ nowSec = Math.floor(Date.now() / 1000), status = 200, body = null } = {}) {
  const calls = [];
  return {
    calls,
    async ohlcv(requests) {
      calls.push({ requests });
      if (body) return { status, body };
      const results = requests.map((r) => {
        const spec = SERIES.find((s) => s.symbol === r.symbol && s.interval === r.interval);
        const lastOpen = Math.floor(nowSec / spec.seconds) * spec.seconds; // forming bar
        const t = Array.from({ length: r.count }, (_, i) => lastOpen - (r.count - 1 - i) * spec.seconds);
        const o = t.map((_, i) => 2300 + Math.sin(i / 9));
        const c = o.map((x, i) => x + Math.sin(i / 3) * 0.4);
        return {
          ok: true, request: r, symbol: r.symbol, interval: r.interval, count: t.length, has_more: true,
          bars: { t, o, c, h: o.map((x, i) => Math.max(x, c[i]) + 0.3), l: o.map((x, i) => Math.min(x, c[i]) - 0.3),
            v: t.map((_, i) => (r.symbol === "TVC:DXY" ? null : 100 + (i % 13))) }
        };
      });
      return { status: 200, body: { contract: "cryptophys.tv-ohlcv-gateway.v1", results } };
    }
  };
}

const env = (overrides = {}) => ({
  MARKET_DATA_INGEST_SECRET: SECRET,
  MARKET_DATA_CACHE: new MemoryKV(),
  ...overrides
});

test("closed candles exclude the still-forming TradingView bar, keep null volume, and sort", () => {
  const spec = SERIES.find((s) => s.interval === "5m" && s.symbol === "OANDA:XAUUSD");
  const nowSec = 1_800_000_000;
  const forming = Math.floor(nowSec / 300) * 300;
  const bars = { t: [forming, forming - 300, forming - 600], o: [1, 1, 1], h: [2, 2, 2], l: [0, 0, 0], c: [1, 1, 1], v: [5, null, 7] };
  const candles = internals.closedCandlesFromColumns(bars, spec, nowSec);
  assert.deepEqual(candles.map((c) => c.time), [forming - 600, forming - 300]);
  assert.deepEqual(candles.map((c) => c.volume), [7, null]);
  assert.equal(candles[1].close_time, new Date(forming * 1000).toISOString());
  assert.throws(() => internals.closedCandlesFromColumns({ t: [1], o: [5], h: [4], l: [3], c: [5], v: [1] }, spec, nowSec), /inconsistent/);
});

test("D1 bars use TradingView session open time and close only after a full session", () => {
  const spec = SERIES.find((s) => s.interval === "1D");
  const sessionOpen = Date.parse("2026-11-02T22:00:00Z") / 1000; // OANDA 17:00 New York
  const bars = { t: [sessionOpen - 86400, sessionOpen], o: [1, 1], h: [1, 1], l: [1, 1], c: [1, 1], v: [1, 1] };
  const before = internals.closedCandlesFromColumns(bars, spec, sessionOpen + 86400 + internals.SETTLE_SECONDS - 1);
  const after = internals.closedCandlesFromColumns(bars, spec, sessionOpen + 86400 + internals.SETTLE_SECONDS);
  assert.equal(before.length, 1);
  assert.equal(after.length, 2);
});

test("native H1 and longer bars settle 90 s after their close before they count as closed; M1 does not wait", () => {
  // Production 2026-11-06: an H1 bar pulled seconds after its close carried a provisional close
  // and volume, and the local record built on it failed parity against the final bar.
  const h1 = SERIES.find((s) => s.interval === "1h" && s.symbol === "OANDA:XAUUSD");
  const m1 = SERIES.find((s) => s.interval === "1m" && s.symbol === "OANDA:XAUUSD");
  assert.equal(internals.settleSeconds(h1), 90);
  assert.equal(internals.settleSeconds(m1), 0);
  assert.equal(internals.settleSeconds(SERIES.find((s) => s.symbol === "TVC:USOIL" && s.interval === "1h")), 0, "a derived series inherits its source's timing");
  const open = 1_800_000_000 - 3600;
  const bars = { t: [open], o: [1], h: [2], l: [0], c: [1], v: [5] };
  assert.equal(internals.closedCandlesFromColumns(bars, h1, open + 3600 + 30).length, 0, "30 s after the close: not final yet");
  assert.equal(internals.closedCandlesFromColumns(bars, h1, open + 3600 + 90).length, 1);
  const last = { time: open - 3600 };
  assert.equal(internals.planRequest(h1, { candles: [last] }, open + 3600 + 30), null, "no pull before the bar settles");
  assert.ok(internals.planRequest(h1, { candles: [last] }, open + 3600 + 90));
  const m1Open = 1_800_000_000 - 60;
  assert.equal(internals.closedCandlesFromColumns({ t: [m1Open], o: [1], h: [2], l: [0], c: [1], v: [5] }, m1, m1Open + 60).length, 1);
});

test("planRequest bootstraps empty series, skips until a new bar closes, then requests only the gap", () => {
  const spec = SERIES.find((s) => s.interval === "5m" && s.symbol === "OANDA:XAUUSD");
  assert.deepEqual(internals.planRequest(spec, null, 1_000_000), { symbol: spec.symbol, interval: "5m", count: 5000, bootstrap: true });
  const last = { time: 1_000_000 - 600 };
  assert.equal(internals.planRequest(spec, { candles: [last] }, 1_000_000 - 1), null);
  assert.equal(internals.planRequest(spec, { candles: [last] }, 1_000_000).count, 4); // gap + forming bar + overlap
  assert.equal(internals.planRequest(spec, { candles: [last] }, 1_000_000 + 3000).bootstrap, false);
  assert.equal(internals.planRequest(spec, { candles: [{ time: 0 }] }, 10_000_000).bootstrap, true);
});

test("mergeCandles deduplicates by open time with newer data winning and keeps retention", () => {
  const merged = internals.mergeCandles([{ time: 1, close: 1 }, { time: 2, close: 2 }], [{ time: 2, close: 9 }, { time: 3, close: 3 }], 2);
  assert.deepEqual(merged, [{ time: 2, close: 9 }, { time: 3, close: 3 }]);
});

test("POST /pull requires the configured bearer secret", async () => {
  const response = await worker.fetch(new Request("https://market.example.com/pull", { method: "POST", headers: { authorization: "Bearer wrong" } }), env());
  assert.equal(response.status, 401);
});

test("POST /pull bootstraps via the TradingView gateway within the per-run budget, then only fetches newly closed bars", async () => {
  const gateway = fakeGateway();
  const e = env({ TV_GATEWAY: gateway });
  const first = await (await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e)).json();
  assert.equal(first.status, "ok");
  assert.equal(first.requested, 8);
  assert.equal(first.deferred, 6);
  // M1 (the chart source) first; an empty derived cache is bootstrapped natively once.
  assert.deepEqual(gateway.calls[0].requests[0], { symbol: "OANDA:XAUUSD", interval: "1m", count: 3000 });
  assert.deepEqual(gateway.calls[0].requests[1], { symbol: "OANDA:XAUUSD", interval: "5m", count: 5000 });
  assert.ok(gateway.calls[0].requests.every((r) => Object.keys(r).join() === "symbol,interval,count"));

  const second = await (await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e)).json();
  assert.equal(second.requested, 6);
  assert.deepEqual(second.updated.map((u) => u.series).sort(), ["CRYPTOCAP:USDT|4h", "OANDA:XAGUSD|4h", "TVC:DXY|4h", "TVC:US10Y|4h", "TVC:USOIL|15m", "TVC:USOIL|1h"]);

  const third = await (await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e)).json();
  assert.equal(third.status, "up_to_date");
  assert.equal(gateway.calls.length, 2);

  const latest = await (await worker.fetch(new Request("https://m/latest", { headers: auth }), e)).json();
  assert.equal(latest.available, true);
  assert.equal(latest.schema_version, "cryptophys.market-data.v2");
  assert.equal(latest.timeframes.M5.candle_count, 4999); // forming bar dropped
  assert.equal(latest.timeframes.M1.candle_count, 2999);
  assert.equal(latest.external_series["TVC:DXY"].H4.volume_available, false);
  // The correlations panel's context series (US10Y, silver) are cached but never in the engine bundle.
  assert.equal(latest.external_series["TVC:US10Y"], undefined);
  assert.equal(latest.external_series["OANDA:XAGUSD"], undefined);
  assert.deepEqual(Object.keys(latest.external_series).sort(), ["CRYPTOCAP:USDT", "TVC:DXY", "TVC:USOIL"]);
  assert.ok(latest.timeframes.D1.candles.every((c) => Date.parse(c.close_time) <= Date.now()));
});

test("gateway quota exhaustion is surfaced as 429 and leaves cached series untouched", async () => {
  const gateway = fakeGateway({ status: 429, body: { error: "mcp_quota_exceeded", quota_cooldown_until: "2026-11-03T23:30:00.000Z", results: [] } });
  const e = env({ TV_GATEWAY: gateway });
  const response = await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  const body = await response.json();
  assert.equal(response.status, 429);
  assert.equal(body.status, "mcp_quota_exceeded");
  assert.equal(body.quota_cooldown_until, "2026-11-03T23:30:00.000Z");
  assert.equal(body.updated.length, 0);
});

test("daily MCP call budget stops pulls without contacting the gateway", async () => {
  const gateway = fakeGateway();
  const e = env({ TV_GATEWAY: gateway, TV_DAILY_CALL_BUDGET: "0" });
  const response = await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, "daily_budget_exhausted");
  assert.equal(gateway.calls.length, 0);
});

test("pull fails closed when the TvGateway RPC binding is missing", async () => {
  const response = await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), env());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "gateway_not_configured");
  assert.equal(body.updated.length, 0);
});

test("GET /latest requires the bearer secret and reports no data before the first pull", async () => {
  assert.equal((await worker.fetch(new Request("https://m/latest"), env())).status, 401);
  const response = await worker.fetch(new Request("https://m/latest", { headers: auth }), env());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).reason, "no_successful_pull_yet");
});

test("health exposes configuration status but no secrets", async () => {
  const body = await (await worker.fetch(new Request("https://m/health"), env({ TV_GATEWAY: fakeGateway() }))).json();
  assert.equal(body.gateway_configured, true);
  assert.equal(body.pull_auth_configured, true);
  assert.equal(body.series.length, SERIES.length);
  const text = JSON.stringify(body);
  assert.ok(!text.includes(SECRET));
  assert.equal(body.local_publisher_configured, false);
});

test("GET /engine-shadow runs the partial Prophet kernel on TradingView-native series and never trusts it", async () => {
  const e = env({ TV_GATEWAY: fakeGateway() });
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  const response = await worker.fetch(new Request("https://m/engine-shadow?engine=prophet", { headers: auth }), e);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.engine_shadow_status, "partial_calculation_available");
  assert.equal(body.parity_status, "not_proven");
  assert.equal(body.calculation_allowed_for_trusted_evidence, false);
  assert.equal(body.outputs.length, 20);
  assert.equal(body.input_history_counts.M5, 500);
  assert.equal(body.input_history_counts.D1, 499);
  assert.ok(body.outputs.every((o) => o.trusted_evidence_allowed === false));
});

test("GET /engine-shadow refuses to pretend Mizan/GMI local calculators exist", async () => {
  const response = await worker.fetch(new Request("https://m/engine-shadow?engine=gmi", { headers: auth }), env());
  const body = await response.json();
  assert.equal(response.status, 501);
  assert.equal(body.engine_shadow_status, "blocked_no_local_calculator");
  assert.equal(body.calculation_allowed_for_trusted_evidence, false);
});

const { publishLocalComputation, publishM5LocalComputation, publishM15LocalComputation, publishHudSnapshots, republishRevisedH1, bundleUntil, LAST_M5_PUBLISH_KEY, LAST_M15_PUBLISH_KEY } = await import("../src/local-publisher.mjs");
const { buildBundle } = await import("../src/tradingview-source.mjs");

function fakeAiWorker(status = 202) {
  const posts = [];
  return {
    posts,
    async submit(body) {
      posts.push({ body });
      return { status, body: { status: "accepted", engine: body.engine, trust_status: "candidate_pending_parity", analysis_status: "waiting_for_evidence" } };
    }
  };
}

test("publisher posts mizan+prophet+gmi local_computation for the latest closed H1 bar once, keyed like the webhook", async () => {
  const ai = fakeAiWorker();
  const e = env({ TV_GATEWAY: fakeGateway(), AI_WORKER: ai });
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  const lastH1 = (await buildBundle(e)).timeframes.H1.candles.at(-1);
  const now = Date.parse(lastH1.close_time) + 60_000;

  const first = await publishLocalComputation(e, { now });
  assert.equal(first.status, "published", JSON.stringify(first));
  // gmi_hud: the Grid Bot Protocol parity record (separate identity), posted after the engines.
  assert.deepEqual(ai.posts.map((p) => p.body.engine), ["mizan", "prophet", "gmi", "gmi_hud"]);
  assert.equal(first.candle_key, `OANDA:XAUUSD:60:${lastH1.time * 1000}`);
  assert.equal(ai.posts[1].body.values.candle.c, lastH1.close);
  assert.deepEqual(first.not_produced, []);
  assert.equal(first.hud_parity.engine, "gmi_hud");
  assert.equal(first.hud_parity.http_status, 202);
  const hud = ai.posts[3].body;
  assert.equal(hud.candle_key, first.candle_key);
  assert.deepEqual(Object.keys(hud.values.comparable), ["gmi_v12_70_hud"]);
  assert.deepEqual(hud.values.comparable.gmi_v12_70_hud.verdict, ai.posts[2].body.values.comparable.gmi_v12_70.verdict);

  const again = await publishLocalComputation(e, { now });
  assert.equal(again.status, "already_published");
  assert.equal(ai.posts.length, 4);

  const stale = await publishLocalComputation(e, { now: now + 30 * 60_000 });
  assert.equal(stale.status, "no_fresh_h1_close");

  const latest = await (await worker.fetch(new Request("https://m/local-computation/latest", { headers: auth }), e)).json();
  assert.equal(latest.last_publish.candle_key, first.candle_key);
});

test("a published H1 bar that TradingView revises later is rebuilt on the final bar and published once more", async () => {
  // Production 2026-11-06: the H1 bar pulled seconds after its close was provisional (close and
  // volume); the overlap re-pull merged the final bar later, after the records were published.
  const ai = fakeAiWorker();
  const e = env({ TV_GATEWAY: fakeGateway(), AI_WORKER: ai });
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  const bundle = await buildBundle(e);
  const lastH1 = bundle.timeframes.H1.candles.at(-1);
  const now = Date.parse(lastH1.close_time) + 60_000;
  assert.equal((await publishLocalComputation(e, { now, bundle })).status, "published");
  assert.deepEqual(await republishRevisedH1(e, { now, bundle }), { status: "unchanged", candles: [] }, "an unrevised bar is never republished");

  const revised = structuredClone(bundle);
  const bar = revised.timeframes.H1.candles.at(-1);
  bar.close = Math.round((bar.close - 0.33) * 1000) / 1000;
  bar.low = Math.min(bar.low, bar.close);
  bar.volume = (bar.volume ?? 0) + 496;
  const r = await republishRevisedH1(e, { now: now + 60 * 60_000, bundle: revised });
  assert.equal(r.status, "revised");
  assert.equal(r.candles[0].status, "republished");
  assert.equal(r.candles[0].candle_key, `OANDA:XAUUSD:60:${lastH1.time * 1000}`);
  const reposted = ai.posts.slice(4).map((p) => p.body);
  assert.deepEqual(reposted.map((b) => b.engine), ["mizan", "prophet", "gmi", "gmi_hud"], "the Grid Bot parity record is rebuilt on the final bar too");
  assert.equal(reposted[1].values.candle.c, bar.close, "rebuilt on the final bar");
  assert.equal(reposted[1].values.candle.volume, bar.volume);

  assert.equal((await republishRevisedH1(e, { now: now + 61 * 60_000, bundle: revised })).status, "unchanged", "republished once only");
  assert.equal(ai.posts.length, 8);
});

test("a rejected gmi_hud record never blocks or repeats the H1 engine publish", async () => {
  const posts = [];
  const ai = { posts, async submit(body) { posts.push({ body }); return body.engine === "gmi_hud" ? { status: 400, body: { error: "Invalid candle_key or engine" } } : { status: 202, body: { status: "accepted" } }; } };
  const e = env({ TV_GATEWAY: fakeGateway(), AI_WORKER: ai });
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  const lastH1 = (await buildBundle(e)).timeframes.H1.candles.at(-1);
  const now = Date.parse(lastH1.close_time) + 60_000;
  const first = await publishLocalComputation(e, { now });
  assert.equal(first.status, "published");
  assert.equal(first.hud_parity.http_status, 400);
  assert.equal((await publishLocalComputation(e, { now })).status, "already_published");
  assert.equal(posts.length, 4);
});

test("bundleUntil cuts every series at a close, so a past bar is rebuilt as it was then", () => {
  const f = (closes) => ({ candles: closes.map((c) => ({ close_time: new Date(c).toISOString() })) });
  const cut = bundleUntil({ timeframes: { H1: f([1000, 2000, 3000]), D1: f([5000]) }, external_series: { "TVC:DXY": { H4: f([1500, 2500]) } } }, 2000);
  assert.equal(cut.timeframes.H1.candles.length, 2);
  assert.equal(cut.timeframes.D1.candles.length, 0);
  assert.equal(cut.external_series["TVC:DXY"].H4.candles.length, 1);
  assert.equal(cut.context_timeframes.D1, cut.timeframes.D1);
});

test("publisher stays off without the AI Worker RPC binding and records failures without a dedupe marker", async () => {
  const off = await publishLocalComputation(env({ TV_GATEWAY: fakeGateway() }));
  assert.equal(off.status, "publisher_not_configured");

  const ai = fakeAiWorker(400);
  const e = env({ TV_GATEWAY: fakeGateway(), AI_WORKER: ai });
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  const lastH1 = (await buildBundle(e)).timeframes.H1.candles.at(-1);
  const now = Date.parse(lastH1.close_time) + 60_000;
  const failed = await publishLocalComputation(e, { now });
  assert.equal(failed.status, "partial_failure");
  const retry = await publishLocalComputation(e, { now });
  assert.equal(retry.status, "partial_failure"); // retried, not deduplicated
  assert.equal(ai.posts.length, 8); // 3 engine records and the gmi_hud record, twice
});

test("5m publisher is off unless M5_PARITY_PUBLISH is true, then posts timeframe-5 records once per closed 5m bar", async () => {
  const ai = fakeAiWorker();
  const off = await publishM5LocalComputation(env({ TV_GATEWAY: fakeGateway(), AI_WORKER: ai }));
  assert.equal(off.status, "m5_publish_disabled");
  assert.equal(ai.posts.length, 0);

  const e = env({ TV_GATEWAY: fakeGateway(), AI_WORKER: ai, M5_PARITY_PUBLISH: "true" });
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  const lastM5 = (await buildBundle(e)).timeframes.M5.candles.at(-1);
  const now = Date.parse(lastM5.close_time) + 30_000;

  const first = await publishM5LocalComputation(e, { now });
  assert.equal(first.status, "published", JSON.stringify(first));
  assert.equal(first.candle_key, `OANDA:XAUUSD:5:${lastM5.time * 1000}`);
  assert.deepEqual(ai.posts.map((p) => p.body.engine), ["mizan", "prophet", "gmi"]);
  assert.ok(ai.posts.every((p) => p.body.timeframe === "5" && p.body.candle_key === first.candle_key));
  assert.equal(JSON.parse(await e.MARKET_DATA_CACHE.get(LAST_M5_PUBLISH_KEY)).candle_key, first.candle_key);

  const again = await publishM5LocalComputation(e, { now });
  assert.equal(again.status, "already_published");
  assert.equal(ai.posts.length, 3);

  const stale = await publishM5LocalComputation(e, { now: now + 15 * 60_000 });
  assert.equal(stale.status, "no_fresh_m5_close");
});

test("15m publisher is off unless M15_PARITY_PUBLISH is true, then posts timeframe-15 records once per closed 15m bar", async () => {
  const ai = fakeAiWorker();
  assert.equal((await publishM15LocalComputation(env({ TV_GATEWAY: fakeGateway(), AI_WORKER: ai }))).status, "m15_publish_disabled");
  const e = env({ TV_GATEWAY: fakeGateway(), AI_WORKER: ai, M15_PARITY_PUBLISH: "true" });
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  const lastM15 = (await buildBundle(e)).timeframes.M15.candles.at(-1);
  const now = Date.parse(lastM15.close_time) + 60_000;
  const first = await publishM15LocalComputation(e, { now });
  assert.equal(first.status, "published", JSON.stringify(first));
  assert.equal(first.candle_key, `OANDA:XAUUSD:15:${lastM15.time * 1000}`);
  assert.deepEqual(ai.posts.map((p) => p.body.engine), ["mizan", "prophet", "gmi"]);
  assert.ok(ai.posts.every((p) => p.body.timeframe === "15" && p.body.candle_key === first.candle_key));
  assert.equal(JSON.parse(await e.MARKET_DATA_CACHE.get(LAST_M15_PUBLISH_KEY)).candle_key, first.candle_key);
  assert.equal((await publishM15LocalComputation(e, { now })).status, "already_published");
  assert.equal((await publishM15LocalComputation(e, { now: now + 20 * 60_000 })).status, "no_fresh_m15_close");
});

test("scheduled cron publishes the 5m parity records end to end (no swallowed failures)", async () => {
  const posts = [];
  const contexts = [];
  const ai = {
    async submit(body) { posts.push(body); return { status: 202, body: { status: "accepted" } }; },
    async submitContext(body) { contexts.push(body); return { status: 202, body: { status: "accepted" } }; }
  };
  const e = env({ TV_GATEWAY: fakeGateway(), AI_WORKER: ai, M5_PARITY_PUBLISH: "true" });
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.join(" ")); };
  try {
    const pending = [];
    await worker.scheduled({ cron: "*/5 * * * *" }, e, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(errors.filter((line) => /_failed/.test(line)), [], "the cron must not swallow a publish failure");
  const m5 = posts.filter((p) => p.timeframe === "5");
  assert.deepEqual(m5.map((p) => p.engine), ["mizan", "prophet", "gmi"]);
  assert.ok(m5.every((p) => p.candle_key.startsWith("OANDA:XAUUSD:5:")));
  // B2: the 5m context is the same bar's prophet parity record, reshaped (no second computation).
  assert.equal(contexts.length, 1);
  const [context] = contexts;
  const prophet = m5.find((p) => p.engine === "prophet");
  const r38 = prophet.values.comparable.prophet_r38;
  assert.equal(context.candle_key, prophet.candle_key);
  assert.equal(context.source, "m5_parity_record");
  assert.equal(context.trust_status, "informational_unverified");
  assert.equal(Date.parse(context.candle_time) - Date.parse(prophet.candle_time), 5 * 60_000, "the context carries the bar's close");
  assert.deepEqual([context.buy_confirmed, context.sell_confirmed, context.d_enc, context.t_enc, context.bias], [r38.buy_confirmed, r38.sell_confirmed, r38.d_enc, r38.t_enc, prophet.values.bias]);
  assert.equal(context.recent_bars.length, 12);
  assert.equal(context.recent_bars.at(-1).t, context.candle_time);
});

test("HUD publisher is off unless HUD_SNAPSHOT_PUBLISH is true, then sends one H1 and one M15 snapshot per closed bar", async () => {
  const sent = [];
  // H4 and D1 snapshots (timeframe War Rooms) have their own test below; this one follows H1 and M15.
  const ai = { async submitHud(body) { if (body.timeframe === "60" || body.timeframe === "15") sent.push(body); return { status: 202, body: { status: "accepted" } }; } };
  assert.equal((await publishHudSnapshots(env({ TV_GATEWAY: fakeGateway(), AI_WORKER: ai }))).status, "hud_publish_disabled");

  const e = env({ TV_GATEWAY: fakeGateway(), AI_WORKER: ai, HUD_SNAPSHOT_PUBLISH: "true" });
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  const b = await buildBundle(e);
  const lastH1 = b.timeframes.H1.candles.at(-1), lastM15 = b.timeframes.M15.candles.at(-1);
  const nowH1 = Date.parse(lastH1.close_time) + 60_000;
  const nowM15 = Date.parse(lastM15.close_time) + 60_000;

  const h1 = await publishHudSnapshots(e, { now: nowH1, bundle: b });
  assert.equal(h1.charts.H1.status, "published", JSON.stringify(h1));
  const m15 = await publishHudSnapshots(e, { now: nowM15, bundle: b });
  // When the latest 15m close lies within its window of the H1 close, the first call
  // already published it; either way it is published exactly once.
  const m15Statuses = [h1.charts.M15.status, m15.charts.M15.status];
  assert.ok(m15Statuses.includes("published") && m15Statuses.filter(st => st === "published").length === 1, JSON.stringify(m15Statuses));
  assert.deepEqual(sent.map(s => s.timeframe).sort(), ["15", "60"]);
  assert.equal(sent.find(s => s.timeframe === "60").candle_key, `OANDA:XAUUSD:60:${lastH1.time * 1000}`);
  assert.ok(sent.every(s => s.schema_version === "cryptophys.hud-snapshot.v1" && s.huds.prophet && !JSON.stringify(s).includes("secret")));

  const again = await publishHudSnapshots(e, { now: nowM15, bundle: b });
  assert.equal(again.charts.M15.status, "already_published");
  assert.equal(sent.length, 2);
  const now = nowM15;
  const stale = await publishHudSnapshots(e, { now: now + 60 * 60_000, bundle: b });
  assert.equal(stale.charts.H1.status, "no_fresh_close");
  assert.equal(stale.charts.M15.status, "no_fresh_close");
});

test("HUD publisher catches up a missed H4 or D1 snapshot once while that bar is the latest close", async () => {
  const sent = [];
  const ai = { async submitHud(body) { sent.push(body); return { status: 202, body: { status: "accepted" } }; } };
  const e = env({ TV_GATEWAY: fakeGateway(), AI_WORKER: ai, HUD_SNAPSHOT_PUBLISH: "true" });
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  const b = await buildBundle(e);
  const last = b.timeframes.D1.candles.at(-1);
  const closeMs = Date.parse(last.close_time);
  // Owner decision 2026-11-06: the D1 close passed before the HUD D1 feature, so its room met
  // without the HUD agents. Hours later the bar is still the latest close and is sent once.
  const r = await publishHudSnapshots(e, { now: closeMs + 3 * 3600_000, bundle: b });
  assert.equal(r.charts.D1.status, "published", JSON.stringify(r.charts.D1));
  assert.equal(r.charts.D1.catch_up, true);
  assert.ok(!r.charts.H1.catch_up && !r.charts.M15.catch_up, "H1 and M15 rooms move on with every bar: no catch-up");
  const d1 = sent.filter((s) => s.timeframe === "1D");
  assert.equal(d1.length, 1);
  assert.equal(d1[0].candle_key, `OANDA:XAUUSD:1D:${Date.parse(last.open_time)}`);
  const health = await (await worker.fetch(new Request("https://m/health"), e)).json();
  // The chart plane (every price object GMI draws) rides in the snapshot; /health names its version.
  assert.deepEqual(health.last_hud_publish.charts.D1, { status: "published", candle_key: d1[0].candle_key, catch_up: true, chart_plane: "cryptophys.chart-plane.v1" });
  assert.equal(d1[0].chart_plane?.version, "cryptophys.chart-plane.v1");
  assert.ok(!JSON.stringify(health).includes(SECRET));

  const again = await publishHudSnapshots(e, { now: closeMs + 4 * 3600_000, bundle: b });
  assert.equal(again.charts.D1.status, "already_published");
  assert.equal(sent.filter((s) => s.timeframe === "1D").length, 1, "once only");
  const h1Last = b.timeframes.H1.candles.at(-1);
  const h1Late = await publishHudSnapshots(e, { now: Date.parse(h1Last.close_time) + 2 * 3600_000, bundle: b });
  assert.equal(h1Late.charts.H1.status, "no_fresh_close");
  const past = await publishHudSnapshots(e, { now: closeMs + 73 * 3600_000, bundle: b });
  assert.equal(past.charts.D1.status, "no_fresh_close", "past the catch-up window");
});

test("HUD publisher also sends the H4 and D1 snapshots of a fresh close, once each", async () => {
  const sent = [];
  const ai = { async submitHud(body) { sent.push(body); return { status: 202, body: { status: "accepted" } }; } };
  const e = env({ TV_GATEWAY: fakeGateway(), AI_WORKER: ai, HUD_SNAPSHOT_PUBLISH: "true" });
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  await worker.fetch(new Request("https://m/pull", { method: "POST", headers: auth }), e);
  const b = await buildBundle(e);
  for (const [chart, period] of [["H4", "240"], ["D1", "1D"]]) {
    const last = b.timeframes[chart]?.candles?.at(-1);
    if (!last) continue;
    const now = Date.parse(last.close_time) + 60_000;
    const r = await publishHudSnapshots(e, { now, bundle: b });
    // A short fixture history is reported, never invented; a close already sent by an earlier
    // call (the D1 close is also an H4 close) is not sent twice.
    const status = r.charts[chart].status;
    assert.ok(["published", "already_published", "insufficient_hud_history"].includes(status), JSON.stringify(r.charts[chart]));
    if (status !== "insufficient_hud_history") {
      assert.equal(sent.filter((s) => s.timeframe === period).length, 1);
      assert.equal((await publishHudSnapshots(e, { now, bundle: b })).charts[chart].status, "already_published");
    }
  }
});

test("no pull while the market is closed (Friday 17:30 to Sunday 18:00 New York), except crypto and an empty series", () => {
  const sec = (iso) => Date.parse(iso) / 1000;
  const closed = internals.marketClosed;
  // Winter (New York UTC-5): Friday 22:30 to Sunday 23:00 UTC.
  assert.equal(closed("OANDA:XAUUSD", sec("2026-11-06T22:00:00Z")), false, "Friday before 17:30 New York");
  assert.equal(closed("OANDA:XAUUSD", sec("2026-11-06T22:30:00Z")), true);
  assert.equal(closed("TVC:US10Y", sec("2026-11-07T12:00:00Z")), true, "Saturday");
  assert.equal(closed("TVC:DXY", sec("2026-11-08T22:00:00Z")), true, "Sunday 17:00 New York: gold has not opened yet (2026-11-08 spent an hour of pulls here)");
  assert.equal(closed("TVC:DXY", sec("2026-11-08T22:59:00Z")), true);
  assert.equal(closed("TVC:DXY", sec("2026-11-08T23:00:00Z")), false, "Sunday 18:00 New York reopen");
  // Summer (New York UTC-4): Friday 21:30 to Sunday 22:00 UTC.
  assert.equal(closed("OANDA:XAUUSD", sec("2026-07-10T21:30:00Z")), true, "summer Friday 17:30 New York");
  assert.equal(closed("OANDA:XAUUSD", sec("2026-07-12T21:59:00Z")), true);
  assert.equal(closed("OANDA:XAUUSD", sec("2026-07-12T22:00:00Z")), false, "summer Sunday reopen");
  assert.equal(closed("CRYPTOCAP:USDT", sec("2026-11-07T12:00:00Z")), false, "crypto trades every day");
  const spec = { symbol: "TVC:US10Y", interval: "4h", seconds: 14400, retain: 500 };
  const last = { time: sec("2026-11-06T18:00:00Z") };
  assert.equal(internals.planRequest(spec, { candles: [last] }, sec("2026-11-08T12:00:00Z")), null, "a weekend spends no call");
  assert.ok(internals.planRequest(spec, { candles: [last] }, sec("2026-11-08T23:05:00Z")), "the gap is pulled at the reopen");
  assert.equal(internals.planRequest(spec, null, sec("2026-11-08T12:00:00Z")).bootstrap, true, "an empty series still bootstraps once");
  assert.ok(internals.planRequest({ ...spec, symbol: "CRYPTOCAP:USDT" }, { candles: [last] }, sec("2026-11-08T12:00:00Z")), "crypto is pulled on the weekend");
});

test("USOIL 5m is pulled once per 15 minutes with every bar; the gold 1m chart stays every 5 minutes", () => {
  const sec = (iso) => Date.parse(iso) / 1000;
  const oil = internals.SERIES.find((s) => s.key === "TVC:USOIL|5m");
  assert.equal(oil.cadence, 900);
  const last = { time: sec("2026-11-10T09:55:00Z") }; // the 5m bar closing at 10:00 is cached
  assert.equal(internals.planRequest(oil, { candles: [last] }, sec("2026-11-10T10:05:10Z")), null, "no oil pull at 10:05");
  assert.equal(internals.planRequest(oil, { candles: [last] }, sec("2026-11-10T10:10:10Z")), null, "no oil pull at 10:10");
  const plan = internals.planRequest(oil, { candles: [last] }, sec("2026-11-10T10:15:10Z"));
  assert.ok(plan && plan.count >= 3, "at 10:15 the pull brings all three 5m bars");
  const m1 = internals.SERIES.find((s) => s.key === "OANDA:XAUUSD|1m");
  assert.equal(m1.cadence, undefined, "the gold chart has no cadence");
  assert.ok(internals.planRequest(m1, { candles: [{ time: sec("2026-11-10T09:59:00Z") }] }, sec("2026-11-10T10:05:10Z")), "gold 1m is pulled at 10:05");
});
