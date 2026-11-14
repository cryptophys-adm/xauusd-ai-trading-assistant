// The pull adapter's daily TradingView budget, counted atomically in D1 (ADR-0015 phase 4 narrow, 2026-11-14).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { reserveTvCalls, releaseTvCalls, readTvBudget, resetTvBudgetSchemaForTests } from "../src/tv-budget.mjs";

function d1() {
  const raw = new DatabaseSync(":memory:");
  const stmt = (sql, params = []) => ({ bind: (...a) => stmt(sql, a), async run() { raw.prepare(sql).run(...params); return {}; }, async first() { return raw.prepare(sql).get(...params) ?? null; }, async all() { return { results: raw.prepare(sql).all(...params) }; } });
  return { prepare: (sql) => stmt(sql) };
}

test("one statement grants and counts: two runs at once never pass the day's cap together", async () => {
  resetTvBudgetSchemaForTests();
  const db = d1();
  const day = "2026-11-16";
  assert.deepEqual(await reserveTvCalls(db, { day, wanted: 8, daily: 20 }), { allowed: 8, used: 8, daily: 20 });
  // Two overlapping runs each want 8 of the 12 left.
  const [a, b] = await Promise.all([reserveTvCalls(db, { day, wanted: 8, daily: 20 }), reserveTvCalls(db, { day, wanted: 8, daily: 20 })]);
  assert.equal(a.allowed + b.allowed, 12);
  assert.equal((await readTvBudget(db, day)).used, 20);
  assert.deepEqual(await reserveTvCalls(db, { day, wanted: 3, daily: 20 }), { allowed: 0, used: 20, daily: 20 }, "spent: nothing more");
  // A refused run gives its calls back; never below zero.
  assert.deepEqual(await releaseTvCalls(db, { day, count: 5 }), { used: 15 });
  assert.deepEqual(await releaseTvCalls(db, { day, count: 50 }), { used: 0 });
  // A new day starts from zero; a budget raised for the day (the owner's override) applies at once.
  assert.equal((await reserveTvCalls(db, { day: "2026-11-17", wanted: 8, daily: 20 })).allowed, 8);
  await assert.rejects(reserveTvCalls(db, { day: "bad", wanted: 1, daily: 1 }));
});

test("the pull adapter reserves through the binding (D1 count, KV copy) and falls back to KV when the binding fails", async () => {
  const { refreshSeries, SERIES_INTERNALS } = await import("../market-data-ingestion/src/tradingview-source.mjs");
  resetTvBudgetSchemaForTests();
  const db = d1();
  const NOW = Date.parse("2027-01-15T13:20:00Z");
  const day = "2027-01-15";
  const kvOf = () => { const m = new Map(); return { map: m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } }; };
  const gateway = { async ohlcv(requests) { return { status: 200, body: { results: requests.map((r) => ({ ok: false, request: r, error: "no_data" })) } }; } };
  // Through the binding: the D1 count is the truth, the KV key a copy.
  const kv = kvOf();
  const worker = { reserveTvCalls: (input) => reserveTvCalls(db, input), releaseTvCalls: (input) => releaseTvCalls(db, input) };
  const r = await refreshSeries({ MARKET_DATA_CACHE: kv, TV_GATEWAY: gateway, AI_WORKER: worker, TV_DAILY_CALL_BUDGET: "800" }, { now: NOW });
  assert.equal(r.budget.counter, "d1");
  assert.equal((await readTvBudget(db, day)).used, r.requested);
  assert.equal(Number(kv.map.get(SERIES_INTERNALS.BUDGET_KEY_PREFIX + day)), r.requested);
  // The binding fails: the KV count, as before.
  const kv2 = kvOf();
  const broken = { async reserveTvCalls() { throw new Error("rpc down"); } };
  const r2 = await refreshSeries({ MARKET_DATA_CACHE: kv2, TV_GATEWAY: gateway, AI_WORKER: broken, TV_DAILY_CALL_BUDGET: "800" }, { now: NOW });
  assert.equal(r2.budget.counter, "kv");
  assert.equal(Number(kv2.map.get(SERIES_INTERNALS.BUDGET_KEY_PREFIX + day)), r2.requested);
});
