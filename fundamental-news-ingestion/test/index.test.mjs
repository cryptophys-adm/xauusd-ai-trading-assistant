import test from "node:test";
import assert from "node:assert/strict";

const moduleUrl = new URL("../src/index.mjs", import.meta.url);
const { default: worker, internals } = await import(moduleUrl.href);

class MemoryKV {
  constructor() {
    this.map = new Map();
  }

  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  async put(key, value) {
    this.map.set(key, value);
  }

  async delete(key) {
    this.map.delete(key);
  }
}

class MemoryCache {
  constructor() {
    this.map = new Map();
  }

  async match(request) {
    const key = request.url;
    if (!this.map.has(key)) return undefined;
    return this.map.get(key).clone();
  }

  async put(request, response) {
    this.map.set(request.url, response.clone());
  }
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

function createCtx() {
  return {
    waitUntil(promise) {
      void promise;
    }
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" }
  });
}

function installCache() {
  globalThis.caches = { default: new MemoryCache() };
}

test.beforeEach(() => {
  installCache();
  internals.resetForTests();
  globalThis.fetch = undefined;
});

test("GET /health reports TradingView MCP status without secrets", async () => {
  const env = createEnv();
  const response = await worker.fetch(new Request("https://news.example.com/health"), env, createCtx());
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.provider, "TradingView MCP");
  assert.equal(body.oauth_configured, true);
  assert.equal(body.oauth_authorized, false);
  assert.deepEqual(body.symbols, ["OANDA:XAUUSD", "TVC:USOIL", "TVC:DXY"]);
  assert.equal(body.oauth_store_configured, true);
});

test("POST /pull returns 401 when bearer token is invalid", async () => {
  const env = createEnv();
  const request = new Request("https://news.example.com/pull", {
    method: "POST",
    headers: { authorization: "Bearer wrong" }
  });

  const response = await worker.fetch(request, env, createCtx());
  assert.equal(response.status, 401);
});

test("POST /pull returns safe unavailable 503 when OAuth config/token is missing", async () => {
  const env = createEnv({ TV_MCP_CLIENT_ID: "" });
  const request = new Request("https://news.example.com/pull", {
    method: "POST",
    headers: { authorization: "Bearer ingest-secret" }
  });

  const response = await worker.fetch(request, env, createCtx());
  assert.equal(response.status, 503);
  const body = await response.json();

  assert.equal(Array.isArray(body.articles), true);
  assert.equal(body.articles.length, 0);
  assert.equal(body.available, false);
});

test("OAuth callback validates state and PKCE verifier", async () => {
  const env = createEnv();
  const responseMissingState = await worker.fetch(
    new Request("https://news.example.com/oauth/callback?code=abc&state=missing"),
    env,
    createCtx()
  );
  assert.equal(responseMissingState.status, 400);

  await env.OAUTH_STORE.put(
    "tv_mcp:oauth_state:badpkce",
    JSON.stringify({ redirect_uri: env.TV_MCP_REDIRECT_URI, code_verifier: "" })
  );
  const responseBadPkce = await worker.fetch(
    new Request("https://news.example.com/oauth/callback?code=abc&state=badpkce"),
    env,
    createCtx()
  );
  assert.equal(responseBadPkce.status, 400);
});

test("POST /pull refreshes expired token and returns headlines from mcp-tv-get-news", async () => {
  const env = createEnv();
  const now = Math.floor(Date.now() / 1000);
  await env.OAUTH_STORE.put(
    "tv_mcp:oauth_token",
    JSON.stringify({ access_token: "expired", refresh_token: "refresh-token", expires_at: now - 10 })
  );

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });

    if (String(url).includes(".well-known/oauth-authorization-server")) {
      return jsonResponse({
        authorization_endpoint: "https://mcp.example.com/oauth/authorize",
        token_endpoint: "https://mcp.example.com/oauth/token",
        token_endpoint_auth_methods_supported: ["none"]
      });
    }

    if (String(url).includes("/oauth/token")) {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("grant_type"), "refresh_token");
      return jsonResponse({ access_token: "fresh-token", refresh_token: "refresh-token", expires_in: 3600 });
    }

    if (String(url).includes("/mcp")) {
      assert.equal(init.headers.authorization, "Bearer fresh-token");
      const rpc = JSON.parse(init.body);
      assert.equal(rpc.method, "tools/call");
      assert.equal(rpc.params.name, "mcp-tv-get-news");
      return jsonResponse({
        result: {
          data: {
            headlines: [
              { id: "1", title: "Gold rises", url: "https://news/1", symbols: ["OANDA:XAUUSD"] }
            ]
          }
        }
      });
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const response = await worker.fetch(
    new Request("https://news.example.com/pull", {
      method: "POST",
      headers: { authorization: "Bearer ingest-secret" }
    }),
    env,
    createCtx()
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.available, true);
  assert.equal(body.count, 1);
  assert.equal(body.articles[0].title, "Gold rises");

  const storedToken = JSON.parse(await env.OAUTH_STORE.get("tv_mcp:oauth_token"));
  assert.equal(storedToken.access_token, "fresh-token");
  assert.equal(calls.some((call) => call.url.includes("/oauth/token")), true);
});

test("POST /pull returns 502 with empty articles when MCP tool fails", async () => {
  const env = createEnv();
  await env.OAUTH_STORE.put("tv_mcp:oauth_token", JSON.stringify({ access_token: "ok-token", expires_at: Math.floor(Date.now() / 1000) + 3600 }));

  globalThis.fetch = async (url) => {
    if (String(url).includes(".well-known/oauth-authorization-server")) {
      return jsonResponse({
        authorization_endpoint: "https://mcp.example.com/oauth/authorize",
        token_endpoint: "https://mcp.example.com/oauth/token",
        token_endpoint_auth_methods_supported: ["none"]
      });
    }
    if (String(url).includes("/mcp")) {
      return jsonResponse({ error: "upstream" }, { status: 502 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const response = await worker.fetch(
    new Request("https://news.example.com/pull", {
      method: "POST",
      headers: { authorization: "Bearer ingest-secret" }
    }),
    env,
    createCtx()
  );

  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.available, false);
  assert.deepEqual(body.articles, []);
});

test("POST /pull returns 200 with empty articles when mcp-tv-get-news is empty", async () => {
  const env = createEnv();
  await env.OAUTH_STORE.put("tv_mcp:oauth_token", JSON.stringify({ access_token: "ok-token", expires_at: null }));

  globalThis.fetch = async (url) => {
    if (String(url).includes(".well-known/oauth-authorization-server")) {
      return jsonResponse({
        authorization_endpoint: "https://mcp.example.com/oauth/authorize",
        token_endpoint: "https://mcp.example.com/oauth/token",
        token_endpoint_auth_methods_supported: ["none"]
      });
    }
    if (String(url).includes("/mcp")) {
      return jsonResponse({ result: { articles: [] } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const response = await worker.fetch(
    new Request("https://news.example.com/pull", {
      method: "POST",
      headers: { authorization: "Bearer ingest-secret" }
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

test("Parser output preserves AI-worker expected articles array contract", () => {
  const parsed = internals.parseArticlesFromMcpPayload({
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            articles: [
              { title: "A", url: "https://news/a", published_at: "2026-10-31T00:00:00Z" },
              { title: "A", url: "https://news/a", published_at: "2026-10-31T00:00:00Z" }
            ]
          })
        }
      ]
    }
  });

  assert.equal(Array.isArray(parsed), true);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].url, "https://news/a");
});
