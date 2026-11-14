// Closed-market idle and the single bundle read (2026-11-14, resource audit): the cron's KV reads,
// counted with a fake KV, while gold is closed and while it trades.
import test from "node:test";
import assert from "node:assert/strict";
import { SERIES, closureId, pendingWork, LAST_REFRESH_KEY } from "../src/tradingview-source.mjs";

const { default: worker, closedMarketIdle, STATUS_REWRITE_MS } = await import("../src/index.mjs");

class CountingKV {
  constructor() { this.map = new Map(); this.gets = []; this.puts = []; }
  async get(key) { this.gets.push(key); return this.map.get(key) ?? null; }
  async put(key, value) { this.puts.push(key); this.map.set(key, value); }
  reset() { this.gets = []; this.puts = []; }
}

/** TradingView-like columns: closed bars up to the request time, then a forming bar. */
function fakeGateway() {
  return {
    async ohlcv(requests) {
      const nowSec = Math.floor(Date.now() / 1000);
      const results = requests.map((r) => {
        const spec = SERIES.find((s) => s.symbol === r.symbol && s.interval === r.interval);
        const lastOpen = Math.floor(nowSec / spec.seconds) * spec.seconds;
        const t = Array.from({ length: r.count }, (_, i) => lastOpen - (r.count - 1 - i) * spec.seconds);
        const o = t.map((_, i) => 2300 + Math.sin(i / 9));
        const c = o.map((x, i) => x + Math.sin(i / 3) * 0.4);
        return { ok: true, request: r, symbol: r.symbol, interval: r.interval, count: t.length, has_more: true,
          bars: { t, o, c, h: o.map((x, i) => Math.max(x, c[i]) + 0.3), l: o.map((x, i) => Math.min(x, c[i]) - 0.3), v: t.map((_, i) => 100 + (i % 13)) } };
      });
      return { status: 200, body: { contract: "cryptophys.tv-ohlcv-gateway.v1", results } };
    }
  };
}

async function runCron(env) {
  const pending = [];
  await worker.scheduled({ cron: "* * * * *" }, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
}

// November 2026 is New York standard time (UTC-5): gold closes Friday 22:30 UTC, reopens Sunday 23:00 UTC.
const FRIDAY_OPEN = Date.parse("2026-11-06T21:50:30.000Z");
const SATURDAY = Date.parse("2026-11-07T10:07:30.000Z");
const SUNDAY_REOPEN = Date.parse("2026-11-08T23:00:30.000Z");
const WEDNESDAY = Date.parse("2026-11-11T10:07:30.000Z");

test("closureId names the weekend by its Friday and is null while gold trades", () => {
  const at = (iso) => closureId(Math.floor(Date.parse(iso) / 1000));
  assert.equal(at("2026-11-06T22:29:00Z"), null, "Friday 17:29 New York still trades");
  assert.equal(at("2026-11-06T22:30:00Z"), "2026-11-06");
  assert.equal(at("2026-11-07T12:00:00Z"), "2026-11-06");
  assert.equal(at("2026-11-08T22:59:00Z"), "2026-11-06", "Sunday 17:59 New York is the same closure");
  assert.equal(at("2026-11-08T23:00:00Z"), null, "the reopen");
  assert.equal(at("2026-11-11T10:00:00Z"), null);
  assert.equal(at("2026-11-14T05:00:00Z"), "2026-11-13");
});

test("pendingWork lists empty series and series holding broker bars", () => {
  const records = SERIES.map(() => ({ candles: [{ time: 1 }] }));
  records[0] = { candles: [{ time: 1 }], fallback: { since_sec: 100 } };
  records[3] = null;
  assert.deepEqual(pendingWork(records), { bootstrap: [SERIES[3].key], heal: [SERIES[0].key] });
  assert.deepEqual(pendingWork(SERIES.map(() => ({ candles: [{ time: 1 }] }))), { bootstrap: [], heal: [] });
});

test("a closed market costs one KV read a minute once its closure is idle, and the reopen runs in full", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: FRIDAY_OPEN });
  const kv = new CountingKV();
  const env = { MARKET_DATA_CACHE: kv, TV_GATEWAY: fakeGateway(), TV_DAILY_CALL_BUDGET: "800" };
  await runCron(env); // Friday before the close: every series bootstraps

  // Saturday: full runs until one leaves nothing to pull, bootstrap or heal (USDT, which trades on
  // weekends, is pulled once first); then the closure is idle.
  t.mock.timers.setTime(SATURDAY);
  let fullRuns = 0;
  for (; fullRuns < 4; fullRuns++) {
    kv.reset();
    await runCron(env);
    if (kv.gets.length === 1) break;
  }
  assert.ok(fullRuns >= 1 && fullRuns <= 3, `full runs before the idle mark: ${fullRuns}`);
  assert.equal(JSON.parse(kv.map.get(LAST_REFRESH_KEY)).closed_idle, "2026-11-06");

  // Idle minutes: the refresh summary is the only key read, and nothing is written.
  for (let i = 1; i <= 3; i++) {
    t.mock.timers.setTime(SATURDAY + i * 60_000);
    kv.reset();
    await runCron(env);
    assert.deepEqual(kv.gets, [LAST_REFRESH_KEY]);
    assert.deepEqual(kv.puts, []);
  }

  // The heartbeat: the summary is rewritten once it is older than STATUS_REWRITE_MS, still healthy.
  t.mock.timers.setTime(SATURDAY + STATUS_REWRITE_MS + 120_000);
  kv.reset();
  await runCron(env);
  assert.deepEqual(kv.gets, [LAST_REFRESH_KEY]);
  assert.deepEqual(kv.puts, [LAST_REFRESH_KEY]);
  const beat = JSON.parse(kv.map.get(LAST_REFRESH_KEY));
  assert.equal(beat.status, "up_to_date");
  assert.equal(beat.market_closed, true);
  assert.equal(beat.checked_at, new Date(SATURDAY + STATUS_REWRITE_MS + 120_000).toISOString());

  // The reopen: the full cycle runs again, the first post-open pull included.
  t.mock.timers.setTime(SUNDAY_REOPEN);
  kv.reset();
  await runCron(env);
  assert.ok(kv.gets.length > SERIES.length, `reads at the reopen: ${kv.gets.length}`);
  assert.ok(kv.puts.some((k) => k.endsWith("OANDA:XAUUSD|1m")), "the 1m chart source is pulled at the reopen");
  assert.equal(JSON.parse(kv.map.get(LAST_REFRESH_KEY)).closed_idle, undefined);
});

test("a closure with broker bars to heal is never idle", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: SATURDAY });
  const kv = new CountingKV();
  const summary = { closed_idle: null, status: "up_to_date", checked_at: new Date(SATURDAY).toISOString() };
  kv.map.set(LAST_REFRESH_KEY, JSON.stringify(summary));
  assert.equal(await closedMarketIdle(kv, SATURDAY), false);
  // An idle mark of the previous weekend does not hold for this one.
  kv.map.set(LAST_REFRESH_KEY, JSON.stringify({ ...summary, closed_idle: "2026-10-30" }));
  assert.equal(await closedMarketIdle(kv, SATURDAY), false);
  // While gold trades no read is made at all.
  kv.reset();
  assert.equal(await closedMarketIdle(kv, WEDNESDAY), false);
  assert.deepEqual(kv.gets, []);
});

test("an open market reads each series once a quiet minute (the bundle reuses the refresh's records)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: WEDNESDAY });
  const kv = new CountingKV();
  const env = { MARKET_DATA_CACHE: kv, TV_GATEWAY: fakeGateway(), TV_DAILY_CALL_BUDGET: "800" };
  await runCron(env);
  await runCron(env); // settle the first run's pulls and derived bars
  t.mock.timers.setTime(WEDNESDAY + 60_000); // a minute with no 1m pull (cadence 5 minutes)
  kv.reset();
  await runCron(env);
  const seriesReads = kv.gets.filter((k) => k.startsWith("market-data:v2:series:"));
  const perSeries = Object.values(Object.groupBy(seriesReads, (k) => k)).map((v) => v.length);
  assert.equal(seriesReads.length, SERIES.length, `series reads: ${seriesReads.length}`);
  assert.ok(perSeries.every((n) => n === 1));
});

test("a published bar's marker is read from KV once per binding, not every minute (resource audit 2026-11-14)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: WEDNESDAY });
  const kv = new CountingKV();
  const ai = { async submit() { return { status: 202 }; }, async submitContext() { return { status: 202 }; }, async submitHud() { return { status: 202 }; } };
  const env = { MARKET_DATA_CACHE: kv, TV_GATEWAY: fakeGateway(), TV_DAILY_CALL_BUDGET: "800", AI_WORKER: ai, M5_PARITY_PUBLISH: "true", M15_PARITY_PUBLISH: "true", HTF_PARITY_PUBLISH: "true", HUD_SNAPSHOT_PUBLISH: "true" };
  await runCron(env);
  await runCron(env);
  t.mock.timers.setTime(WEDNESDAY + 60_000);
  kv.reset();
  await runCron(env);
  const markers = kv.gets.filter((k) => /:(hud|local)-published:/.test(k));
  // Only the H1 revision check reads its markers' content (the last closed H1 bars); no presence check reads KV.
  assert.ok(markers.every((k) => k.includes(":60:")), markers.join(", "));
  assert.ok(!kv.gets.includes("market-data:v2:derived-check"), "the day's derived check is known done");
});
