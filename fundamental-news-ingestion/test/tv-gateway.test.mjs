import test from "node:test";
import assert from "node:assert/strict";
import { validateOhlcvRequest, parseToolResult, normalizeOhlcvColumns } from "../src/tv-gateway.mjs";

const { default: worker, internals, runTvOhlcv } = await import(new URL("../src/index.mjs", import.meta.url).href);

class MemoryKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.has(key) ? this.map.get(key) : null; }
  async put(key, value) { this.map.set(key, value); }
  async delete(key) { this.map.delete(key); }
}

function createEnv(overrides = {}) {
  return {
    INGEST_SECRET: "ingest-secret",
    OAUTH_STORE: new MemoryKV(),
    TV_MCP_CLIENT_ID: "client-id",
    TV_MCP_REDIRECT_URI: "https://news.example.com/oauth/callback",
    TV_MCP_METADATA_URL: "https://mcp.example.com/.well-known/oauth-authorization-server",
    TV_MCP_ENDPOINT: "https://mcp.example.com/mcp",
    ...overrides
  };
}
const ctx = { waitUntil() {} };
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
async function authorize(env) {
  await env.OAUTH_STORE.put("tv_mcp:oauth_token", JSON.stringify({
    access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_at: Math.floor(Date.now() / 1000) + 3600
  }));
}
function installFetch(mcpHandler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes(".well-known")) {
      return jsonResponse({ authorization_endpoint: "https://mcp.example.com/authorize", token_endpoint: "https://mcp.example.com/token" });
    }
    if (target === "https://mcp.example.com/mcp") {
      const body = JSON.parse(init.body);
      calls.push(body);
      return mcpHandler(body);
    }
    throw new Error("unexpected fetch " + target);
  };
  return calls;
}
const toolText = (obj) => jsonResponse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(obj) }] } });

test.beforeEach(() => { internals.resetForTests(); globalThis.fetch = undefined; });

test("validateOhlcvRequest enforces symbol allowlist, interval set and count bounds", () => {
  assert.deepEqual(validateOhlcvRequest({ symbol: "OANDA:XAUUSD", interval: "5m", count: 10 }).value,
    { symbol: "OANDA:XAUUSD", interval: "5m", count: 10, format: "columns" });
  assert.equal(validateOhlcvRequest({ symbol: "NASDAQ:NVDA", interval: "5m", count: 10 }).error, "symbol_not_allowed");
  assert.equal(validateOhlcvRequest({ symbol: "oanda:xauusd", interval: "5m", count: 10 }).error, "invalid_symbol");
  assert.equal(validateOhlcvRequest({ symbol: "OANDA:XAUUSD", interval: "2m", count: 10 }).error, "invalid_interval");
  assert.equal(validateOhlcvRequest({ symbol: "OANDA:XAUUSD", interval: "5m", count: 0 }).error, "invalid_count");
  assert.equal(validateOhlcvRequest({ symbol: "OANDA:XAUUSD", interval: "5m", count: 9000 }).error, "invalid_count");
  assert.equal(validateOhlcvRequest({ symbol: "OANDA:XAUUSD", interval: "5m", count: 5, date_to: "yesterday" }).error, "invalid_date_to");
  assert.equal(validateOhlcvRequest({ symbol: "OANDA:XAUUSD", interval: "1D", count: 5, date_to: "2026-10-27T21:00:00Z" }).value.date_to, "2026-10-27T21:00:00Z");
});

test("parseToolResult and normalizeOhlcvColumns accept rows and columns, keep null volume, reject bad numbers", () => {
  const rows = parseToolResult({ result: { content: [{ type: "text", text: JSON.stringify({ success: true, bars: [{ t: 1, o: 2, h: 3, l: 1, c: 2, v: 5 }, { t: 2, o: 2, h: 3, l: 1, c: 2, v: null }] }) }] } });
  assert.deepEqual(normalizeOhlcvColumns(rows), { t: [1, 2], o: [2, 2], h: [3, 3], l: [1, 1], c: [2, 2], v: [5, null] });
  const cols = normalizeOhlcvColumns({ bars: { t: [1], o: [1], h: [1], l: [1], c: [1], v: [null] } });
  assert.deepEqual(cols.v, [null]);
  assert.throws(() => normalizeOhlcvColumns({ bars: { t: [1, 2], o: [1], h: [1], l: [1], c: [1] } }), /length mismatch/);
  assert.throws(() => normalizeOhlcvColumns({ bars: { t: [1], o: ["1"], h: [1], l: [1], c: [1] } }), /non-finite/);
  assert.equal(parseToolResult({ result: { structuredContent: { a: 1 } } }).a, 1);
});

test("the OHLCV gateway is RPC-only: no public HTTP route exists", async () => {
  const env = createEnv();
  const response = await worker.fetch(new Request("https://news.example.com/internal/tv-ohlcv", { method: "POST", body: "{}" }), env, ctx);
  assert.equal(response.status, 404);
  const health = await (await worker.fetch(new Request("https://news.example.com/health"), env, ctx)).json();
  assert.equal(health.ohlcv_gateway, "rpc:TvGateway");
});

test("gateway calls mcp-tv-get-ohlcv with validated columns args using the shared OAuth token", async () => {
  const env = createEnv();
  await authorize(env);
  const calls = installFetch(() => toolText({
    success: true, symbol: "OANDA:XAUUSD", interval: "5m", has_more: true, next_date_to: "2026-11-03T00:25:00Z",
    bars: { t: [1793666100, 1793666400], o: [1, 2], h: [2, 3], l: [0.5, 1.5], c: [1.5, 2.5], v: [10, 20] }
  }));
  const { status, body } = await runTvOhlcv(env, [{ symbol: "OANDA:XAUUSD", interval: "5m", count: 2 }]);
  assert.equal(status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "tools/call");
  assert.equal(calls[0].params.name, "mcp-tv-get-ohlcv");
  assert.deepEqual(calls[0].params.arguments, { symbol: "OANDA:XAUUSD", interval: "5m", count: 2, format: "columns" });
  assert.equal(body.results[0].ok, true);
  assert.deepEqual(body.results[0].bars.t, [1793666100, 1793666400]);
  assert.equal(body.results[0].next_date_to, "2026-11-03T00:25:00Z");
});

test("quota exhaustion stops the batch, records the shared cooldown, and later calls are refused without upstream traffic", async () => {
  const env = createEnv();
  await authorize(env);
  const calls = installFetch(() => jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "TOOL_QUOTA_EXCEEDED: access to MCP is suspended until 23:30 UTC" } }));
  const first = await runTvOhlcv(env, [
    { symbol: "OANDA:XAUUSD", interval: "5m", count: 2 },
    { symbol: "TVC:DXY", interval: "4h", count: 2 }
  ]);
  assert.equal(first.status, 429);
  assert.equal(calls.length, 1);
  assert.ok(await env.OAUTH_STORE.get("tv_mcp:quota_cooldown_until"));
  const again = await runTvOhlcv(env, [{ symbol: "OANDA:XAUUSD", interval: "5m", count: 2 }]);
  assert.equal(again.status, 503);
  assert.equal(again.body.error, "mcp_quota_cooldown_active");
  assert.equal(calls.length, 1);
});

test("gateway rejects oversize batches and invalid requests before touching OAuth or MCP", async () => {
  const env = createEnv();
  globalThis.fetch = async () => { throw new Error("must not fetch"); };
  const many = Array.from({ length: 13 }, () => ({ symbol: "OANDA:XAUUSD", interval: "5m", count: 1 }));
  assert.equal((await runTvOhlcv(env, many)).status, 400);
  assert.equal((await runTvOhlcv(env, [])).status, 400);
  const bad = await runTvOhlcv(env, [{ symbol: "BINANCE:BTCUSDT", interval: "5m", count: 1 }]);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "symbol_not_allowed");
});

test("health identifies the Worker by role: TradingView MCP gateway serving news and OHLCV", async () => {
  const body = await (await worker.fetch(new Request("https://news.example.com/health"), createEnv(), ctx)).json();
  assert.equal(body.worker, "xauusd-fundamental-news-ingestion");
  assert.equal(body.role, "tradingview-mcp-gateway");
  assert.deepEqual(Object.keys(body.services), ["news", "ohlcv"]);
  assert.equal(body.services.ohlcv.entrypoint, "TvGateway");
});

test("generic HTTP 429 from MCP stops the OHLCV batch and opens the shared rate-limit cooldown", async () => {
  const env = createEnv();
  await authorize(env);
  const calls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes(".well-known")) {
      return jsonResponse({ authorization_endpoint: "https://mcp.example.com/authorize", token_endpoint: "https://mcp.example.com/token" });
    }
    calls.push(target);
    return new Response(JSON.stringify({ error: "Too Many Requests" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "90" } });
  };
  const first = await runTvOhlcv(env, [
    { symbol: "OANDA:XAUUSD", interval: "5m", count: 2 },
    { symbol: "TVC:DXY", interval: "4h", count: 2 }
  ]);
  assert.equal(first.status, 429);
  assert.equal(first.body.error, "mcp_rate_limited");
  assert.equal(calls.length, 1, "the batch stops at the first 429");
  const cooldown = JSON.parse(await env.OAUTH_STORE.get("tv_mcp:quota_cooldown_until"));
  assert.equal(cooldown.reason, "provider_rate_limited");
  assert.ok(Date.parse(cooldown.until) > Date.now() + 80_000);
  const again = await runTvOhlcv(env, [{ symbol: "OANDA:XAUUSD", interval: "5m", count: 2 }]);
  assert.equal(again.status, 503);
  assert.equal(again.body.error, "mcp_quota_cooldown_active");
  assert.equal(calls.length, 1);
});
