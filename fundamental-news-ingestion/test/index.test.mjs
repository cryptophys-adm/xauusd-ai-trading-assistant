import test from "node:test";
import assert from "node:assert/strict";

const moduleUrl = new URL("../src/index.mjs", import.meta.url);
const { default: worker, internals } = await import(moduleUrl.href);

class MemoryKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.has(key) ? this.map.get(key) : null; }
  async put(key, value) { this.map.set(key, value); }
  async delete(key) { this.map.delete(key); }
}

class MemoryCache {
  constructor() { this.map = new Map(); }
  async match(request) { return this.map.has(request.url) ? this.map.get(request.url).clone() : undefined; }
  async put(request, response) { this.map.set(request.url, response.clone()); }
}

function createEnv(overrides = {}) {
  return {
    INGEST_SECRET: "ingest-secret",
    OAUTH_STORE: new MemoryKV(),
    TV_MCP_CLIENT_ID: "client-id",
    TV_MCP_REDIRECT_URI: "https://news.example.com/oauth/callback",
    TV_MCP_METADATA_URL: "https://mcp.example.com/.well-known/oauth-authorization-server",
    TV_MCP_ENDPOINT: "https://mcp.example.com/mcp",
    TV_MCP_SYMBOLS: "OANDA:XAUUSD,TVC:USOIL,TVC:DXY",
    NEWS_INGEST_USER_AGENT: "test-agent",
    ...overrides
  };
}

function createCtx() { return { waitUntil(promise) { void promise; } }; }

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) }
  });
}

function rpcResponse(rpc, result, headers = {}) {
  return jsonResponse({ jsonrpc: "2.0", id: rpc.id, result }, { headers });
}

function installCache() { globalThis.caches = { default: new MemoryCache() }; }

function installOAuthFetch({ onMcp }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (target.includes(".well-known/oauth-authorization-server")) {
      return jsonResponse({
        authorization_endpoint: "https://mcp.example.com/oauth/authorize",
        token_endpoint: "https://mcp.example.com/oauth/token",
        token_endpoint_auth_methods_supported: ["none"]
      });
    }
    if (target.includes("/oauth/token")) {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("grant_type"), "refresh_token");
      return jsonResponse({ access_token: "fresh-token", refresh_token: "refresh-token", expires_in: 3600 });
    }
    if (target.includes("/mcp")) return onMcp(JSON.parse(init.body), init, calls.length);
    throw new Error(`Unexpected fetch URL: ${target}`);
  };
  return calls;
}

test.beforeEach(() => {
  installCache();
  internals.resetForTests();
  globalThis.fetch = undefined;
});

test("GET /health reports TradingView MCP status without secrets", async () => {
  const response = await worker.fetch(new Request("https://news.example.com/health"), createEnv(), createCtx());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider, "TradingView MCP");
  assert.equal(body.oauth_configured, true);
  assert.equal(body.oauth_authorized, false);
  assert.deepEqual(body.symbols, ["OANDA:XAUUSD", "TVC:USOIL", "TVC:DXY"]);
  assert.equal(body.oauth_store_configured, true);
});

test("POST /pull returns 401 when bearer token is invalid", async () => {
  const response = await worker.fetch(new Request("https://news.example.com/pull", {
    method: "POST", headers: { authorization: "Bearer wrong" }
  }), createEnv(), createCtx());
  assert.equal(response.status, 401);
});

test("POST /pull returns safe unavailable 503 when OAuth config/token is missing", async () => {
  const response = await worker.fetch(new Request("https://news.example.com/pull", {
    method: "POST", headers: { authorization: "Bearer ingest-secret" }
  }), createEnv({ TV_MCP_CLIENT_ID: "" }), createCtx());
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(Array.isArray(body.articles), true);
  assert.equal(body.articles.length, 0);
  assert.equal(body.available, false);
});

test("OAuth callback validates state and PKCE verifier", async () => {
  const env = createEnv();
  const missingState = await worker.fetch(
    new Request("https://news.example.com/oauth/callback?code=abc&state=missing"), env, createCtx()
  );
  assert.equal(missingState.status, 400);
  await env.OAUTH_STORE.put("tv_mcp:oauth_state:badpkce",
    JSON.stringify({ redirect_uri: env.TV_MCP_REDIRECT_URI, code_verifier: "" }));
  const badPkce = await worker.fetch(
    new Request("https://news.example.com/oauth/callback?code=abc&state=badpkce"), env, createCtx()
  );
  assert.equal(badPkce.status, 400);
});

test("POST /pull refreshes token and calls initialize then get_news once per symbol", async () => {
  const env = createEnv();
  const now = Math.floor(Date.now() / 1000);
  await env.OAUTH_STORE.put("tv_mcp:oauth_token",
    JSON.stringify({ access_token: "expired", refresh_token: "refresh-token", expires_at: now - 10 }));
  const rpcCalls = [];
  const calls = installOAuthFetch({ onMcp: async (rpc, init) => {
    assert.equal(init.headers.authorization, "Bearer fresh-token");
    rpcCalls.push(rpc);
    if (rpc.method === "initialize") {
      return rpcResponse(rpc, { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "test" } },
        { "mcp-session-id": "session-1" });
    }
    if (rpc.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    assert.equal(rpc.method, "tools/call");
    assert.equal(rpc.params.name, "get_news");
    const symbol = rpc.params.arguments.symbol;
    const article = { id: symbol, title: `Headline ${symbol}`, url: `https://news.example.com/${encodeURIComponent(symbol)}`, symbols: [symbol] };
    return rpcResponse(rpc, { content: [{ type: "text", text: JSON.stringify({ articles: [article] }) }] });
  }});

  const response = await worker.fetch(new Request("https://news.example.com/pull", {
    method: "POST", headers: { authorization: "Bearer ingest-secret" }
  }), env, createCtx());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.available, true);
  assert.equal(body.count, 3);
  assert.equal(rpcCalls[0].method, "initialize");
  assert.equal(rpcCalls[1].method, "notifications/initialized");
  assert.deepEqual(rpcCalls.slice(2).map((rpc) => rpc.params.arguments.symbol),
    ["OANDA:XAUUSD", "TVC:USOIL", "TVC:DXY"]);
  assert.equal(calls.some((call) => call.url.includes("/oauth/token")), true);
  const storedToken = JSON.parse(await env.OAUTH_STORE.get("tv_mcp:oauth_token"));
  assert.equal(storedToken.access_token, "fresh-token");
});

test("SSE response selects matching request ID and ignores notifications", async () => {
  const env = createEnv();
  await env.OAUTH_STORE.put("tv_mcp:oauth_token",
    JSON.stringify({ access_token: "ok-token", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  const calls = installOAuthFetch({ onMcp: async (rpc) => {
    if (rpc.method === "initialize") {
      return new Response([
        'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}',
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26" } })}`,
        ""
      ].join("\n\n"), { headers: { "content-type": "text/event-stream", "mcp-session-id": "session-sse" } });
    }
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    const article = { id: "sse-1", title: "Gold headline", url: "https://news.example.com/sse-1" };
    return new Response([
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}',
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify({ articles: [article] }) }] } })}`,
      ""
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
  }});
  const response = await worker.fetch(new Request("https://news.example.com/pull", {
    method: "POST", headers: { authorization: "Bearer ingest-secret" }
  }), env, createCtx());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.count, 1);
  assert.equal(body.articles[0].title, "Gold headline");
  assert.ok(calls.length >= 5);
});

test("SSE without matching JSON-RPC response fails instead of returning empty success", async () => {
  const env = createEnv();
  await env.OAUTH_STORE.put("tv_mcp:oauth_token",
    JSON.stringify({ access_token: "ok-token", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  let toolCalls = 0;
  installOAuthFetch({ onMcp: async (rpc) => {
    if (rpc.method === "initialize") return rpcResponse(rpc, { protocolVersion: "2025-03-26" });
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    toolCalls += 1;
    return new Response('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n',
      { headers: { "content-type": "text/event-stream" } });
  }});
  const response = await worker.fetch(new Request("https://news.example.com/pull", {
    method: "POST", headers: { authorization: "Bearer ingest-secret" }
  }), env, createCtx());
  assert.equal(response.status, 502);
  assert.equal(toolCalls, 3);
  const body = await response.json();
  assert.equal(body.available, false);
  assert.equal(body.count, 0);
});

test("POST /pull returns 502 with empty articles when MCP tool fails", async () => {
  const env = createEnv();
  await env.OAUTH_STORE.put("tv_mcp:oauth_token",
    JSON.stringify({ access_token: "ok-token", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  installOAuthFetch({ onMcp: async (rpc) => {
    if (rpc.method === "initialize") return rpcResponse(rpc, { protocolVersion: "2025-03-26" });
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    return jsonResponse({ error: "upstream" }, { status: 502 });
  }});
  const response = await worker.fetch(new Request("https://news.example.com/pull", {
    method: "POST", headers: { authorization: "Bearer ingest-secret" }
  }), env, createCtx());
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.available, false);
  assert.deepEqual(body.articles, []);
});

test("POST /pull returns 200 with empty articles when get_news is empty", async () => {
  const env = createEnv();
  await env.OAUTH_STORE.put("tv_mcp:oauth_token", JSON.stringify({ access_token: "ok-token", expires_at: Math.floor(Date.now() / 1000) + 3600 }));

  installOAuthFetch({ onMcp: async (rpc) => {
    if (rpc.method === "initialize") return rpcResponse(rpc, { protocolVersion: "2025-03-26" });
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    return rpcResponse(rpc, { content: [{ type: "text", text: JSON.stringify({ articles: [] }) }] });
  }});

  const response = await worker.fetch(
    new Request("https://news.example.com/pull", {
      method: "POST",
      headers: { authorization: "Bearer " + env.INGEST_SECRET }
    }),
    env,
    createCtx()
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.available, true);
  assert.equal(body.count, 0);
  assert.deepEqual(body.articles, []);
});

test("scheduled ingestion records a successful article fetch after retrying an empty pull", async () => {
  const env = createEnv();
  await env.OAUTH_STORE.put(
    "tv_mcp:oauth_token",
    JSON.stringify({ access_token: "valid-token", refresh_token: "refresh-token", expires_at: Math.floor(Date.now() / 1000) + 3600 })
  );

  let toolCalls = 0;
  installOAuthFetch({ onMcp: async (rpc) => {
    if (rpc.method === "initialize") return rpcResponse(rpc, { protocolVersion: "2025-03-26" }, { "mcp-session-id": "session-1" });
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    toolCalls += 1;
    const articles = toolCalls <= 3 ? [] : [{
      id: "scheduled-1",
      title: "Gold outlook update",
      url: "https://news.example.com/1",
      symbols: ["OANDA:XAUUSD"]
    }];
    return rpcResponse(rpc, { content: [{ type: "text", text: JSON.stringify({ articles }) }] });
  }});

  await worker.scheduled(
    { scheduledTime: Date.now(), cron: "*/30 * * * *" },
    env,
    createCtx()
  );

  const stored = JSON.parse(await env.OAUTH_STORE.get("tv_mcp:last_scheduled_pull"));
  assert.equal(stored.status, "ok");
  assert.equal(stored.article_count, 1);
  assert.equal(stored.http_status, 200);
  assert.equal(stored.pull_attempts, 2);
  assert.equal(toolCalls, 6);
  assert.deepEqual(stored.symbols, ["OANDA:XAUUSD", "TVC:USOIL", "TVC:DXY"]);
  assert.equal(JSON.stringify(stored).includes("valid-token"), false);

  const health = await worker.fetch(new Request("https://news.example.com/health"), env, createCtx());
  const healthBody = await health.json();
  assert.equal(healthBody.last_scheduled_ingest.status, "ok");
  assert.equal(healthBody.last_scheduled_ingest.article_count, 1);
});

test("Parser output preserves AI-worker expected articles array contract", () => {
  const parsed = internals.parseArticlesFromMcpPayload({ result: { content: [{
    type: "text",
    text: JSON.stringify({ articles: [
      { title: "A", url: "https://news/a", published_at: "2026-10-31T00:00:00Z" },
      { title: "A", url: "https://news/a", published_at: "2026-10-31T00:00:00Z" }
    ] })
  }] } });
  assert.equal(Array.isArray(parsed), true);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].url, "https://news/a");
});
