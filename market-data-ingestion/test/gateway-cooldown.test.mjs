// The gateway's quota cooldown spends no daily budget (2026-11-11: after the provider quota ran out at
// 13:05 UTC, every minute's run reserved its calls although the gateway refused them without calling
// TradingView, and the budget read exhausted by evening).
import test from "node:test";
import assert from "node:assert/strict";
import { SERIES, SERIES_INTERNALS, refreshSeries } from "../src/tradingview-source.mjs";

class MemoryKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key) ?? null; }
  async put(key, value) { this.map.set(key, value); }
}
const NOW = Date.parse("2027-01-15T13:20:00Z"); // a Friday, the market open
const UNTIL = "2027-01-16T00:00:00.000Z";
const budgetOf = async (kv) => Number(await kv.get(SERIES_INTERNALS.BUDGET_KEY_PREFIX + "2027-01-15")) || 0;

test("a gateway in cooldown: the reservation goes back, the cooldown is kept, later runs reserve and ask nothing", async () => {
  const kv = new MemoryKV();
  let asked = 0;
  const env = {
    MARKET_DATA_CACHE: kv,
    TV_GATEWAY: { async ohlcv(requests) { asked += 1; return { status: 503, body: { error: "mcp_quota_cooldown_active", quota_cooldown_until: UNTIL } }; } }
  };
  const first = await refreshSeries(env, { now: NOW });
  assert.equal(first.status, "mcp_quota_cooldown_active");
  assert.ok(first.requested > 0, "the empty cache plans bootstrap pulls");
  assert.equal(first.budget.released, first.requested);
  assert.equal(await budgetOf(kv), 0, "the gateway called nobody, so nothing is spent");
  assert.equal(JSON.parse(await kv.get(SERIES_INTERNALS.GATEWAY_COOLDOWN_KEY)).until, UNTIL);

  for (let i = 1; i <= 5; i++) {
    const r = await refreshSeries(env, { now: NOW + i * 60_000 });
    assert.equal(r.status, "mcp_quota_cooldown_active", "the fallback still sees the gateway down");
    assert.equal(r.quota_cooldown_until, UNTIL);
    assert.equal(r.requested, 0);
  }
  assert.equal(asked, 1, "no call while the cooldown holds");
  assert.equal(await budgetOf(kv), 0);

  // After the cooldown the pulls go again.
  const after = Date.parse(UNTIL) + 60_000;
  await refreshSeries(env, { now: after });
  assert.equal(asked, 2);
});

test("the provider's own quota refusal is spent (TradingView was called) and opens the cooldown too", async () => {
  const kv = new MemoryKV();
  const env = {
    MARKET_DATA_CACHE: kv,
    TV_GATEWAY: { async ohlcv(requests) { return { status: 429, body: { error: "mcp_quota_exceeded", quota_cooldown_until: UNTIL, results: [{ ok: false, request: requests[0], error: "mcp_quota_exceeded" }] } }; } }
  };
  const r = await refreshSeries(env, { now: NOW });
  assert.equal(r.status, "mcp_quota_exceeded");
  assert.equal(r.budget.released, undefined);
  assert.equal(await budgetOf(kv), r.requested);
  assert.equal((await refreshSeries(env, { now: NOW + 60_000 })).status, "mcp_quota_cooldown_active");
  assert.equal(await budgetOf(kv), r.requested, "nothing more reserved");
});

test("a gateway that answers spends its calls as before", async () => {
  const kv = new MemoryKV();
  const env = {
    MARKET_DATA_CACHE: kv,
    TV_GATEWAY: { async ohlcv(requests) { return { status: 200, body: { results: requests.map((r) => ({ ok: true, request: r, bars: { t: [], o: [], h: [], l: [], c: [], v: [] } })) } }; } }
  };
  const r = await refreshSeries(env, { now: NOW });
  assert.equal(await budgetOf(kv), r.requested);
  assert.equal(await kv.get(SERIES_INTERNALS.GATEWAY_COOLDOWN_KEY), null);
  assert.ok(SERIES.length > 0);
});
