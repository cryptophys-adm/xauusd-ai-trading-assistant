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
      assert.deepEqual(Object.keys(rpc.params.arguments).sort(), ["limit", "symbol"]);
      assert.equal(typeof rpc.params.arguments.symbol, "string");
      return jsonResponse({
        result: {
          data: {
            headlines: [
              { id: "1", title: "Gold rises", url: "https://news/1", published_at: new Date().toISOString(), symbols: ["OANDA:XAUUSD"] }
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
  assert.deepEqual(body.articles[0].symbols.sort(), ["OANDA:XAUUSD", "TVC:DXY", "TVC:USOIL"]);
  const mcpCalls = calls.filter((call) => new URL(call.url).pathname === "/mcp");
  assert.deepEqual(mcpCalls.map((call) => JSON.parse(call.init.body).params.arguments.symbol), ["OANDA:XAUUSD", "TVC:USOIL", "TVC:DXY"]);

  const storedToken = JSON.parse(await env.OAUTH_STORE.get("tv_mcp:oauth_token"));
  assert.equal(storedToken.access_token, "fresh-token");
  assert.equal(calls.some((call) => call.url.includes("/oauth/token")), true);
});

test("GET /health treats expired cooldown as inactive without deleting a concurrently renewed record", async () => {
  const env = createEnv();
  const key = "tv_mcp:quota_cooldown_until";
  const expiredRecord = {
    until: new Date(Date.now() - 60 * 1000).toISOString(),
    reason: "provider_quota_exceeded"
  };
  const renewedRecord = {
    until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    reason: "provider_quota_exceeded"
  };
  await env.OAUTH_STORE.put(key, JSON.stringify(expiredRecord));
  const get = env.OAUTH_STORE.get.bind(env.OAUTH_STORE);
  let replaced = false;
  env.OAUTH_STORE.get = async (requestedKey) => {
    const value = await get(requestedKey);
    if (requestedKey === key && !replaced) {
      replaced = true;
      await env.OAUTH_STORE.put(key, JSON.stringify(renewedRecord));
    }
    return value;
  };

  const response = await worker.fetch(new Request("https://news.example.com/health"), env, createCtx());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider_cooldown_until, null);

  assert.equal(replaced, true);
  assert.deepEqual(JSON.parse(await get(key)), renewedRecord);
});

test("POST /pull serves valid cached headlines during provider quota cooldown", async () => {
  const env = createEnv();
  const cachedPayload = {
    worker: "xauusd-fundamental-news-ingestion",
    provider: "TradingView MCP",
    fetched_at: new Date().toISOString(),
    symbols: ["OANDA:XAUUSD", "TVC:USOIL", "TVC:DXY"],
    count: 1,
    available: true,
    articles: [{ id: "cached-1", title: "Cached gold headline", url: "https://news.example.com/cached-1", published_at: new Date().toISOString(), symbols: ["OANDA:XAUUSD"] }]
  };
  await env.OAUTH_STORE.put("tv_mcp:quota_cooldown_until", JSON.stringify({
    until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    reason: "provider_quota_exceeded"
  }));
  const cacheKey = new Request(new URL("/_internal/tv-mcp-cache?symbols=OANDA%3AXAUUSD%2CTVC%3AUSOIL%2CTVC%3ADXY", "https://news.example.com"), { method: "GET" });
  await caches.default.put(cacheKey, new Response(JSON.stringify(cachedPayload), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=120" }
  }));

  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    throw new Error("upstream must not be called when a valid cache entry exists");
  };

  const response = await worker.fetch(new Request("https://news.example.com/pull", {
    method: "POST",
    headers: { authorization: "Bearer ingest-secret" }
  }), env, createCtx());

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.cache, "hit");
  assert.equal(body.available, true);
  assert.equal(body.count, 1);
  assert.equal(body.articles[0].title, "Cached gold headline");
  assert.equal(upstreamCalls, 0);

  const duplicateResponse = await worker.fetch(new Request("https://news.example.com/pull", {
    method: "POST",
    headers: { authorization: "Bearer ingest-secret" }
  }), env, createCtx());
  assert.equal(duplicateResponse.status, 200);
  const duplicateBody = await duplicateResponse.json();
  assert.equal(duplicateBody.cache, "hit");
  assert.equal(duplicateBody.count, 0);
  assert.deepEqual(duplicateBody.articles, []);
  assert.equal(upstreamCalls, 0, "repeat cache hits must not trigger extra provider calls");
});

test("POST /pull enforces cooldown on cache miss before OAuth or MCP calls", async () => {
  const env = createEnv();
  await env.OAUTH_STORE.put("tv_mcp:quota_cooldown_until", JSON.stringify({
    until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    reason: "provider_quota_exceeded"
  }));

  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    throw new Error("OAuth/MCP must not be called during cooldown");
  };

  const response = await worker.fetch(new Request("https://news.example.com/pull", {
    method: "POST",
    headers: { authorization: "Bearer ingest-secret" }
  }), env, createCtx());

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.reason, "TradingView MCP quota cooldown active");
  assert.equal(body.failure_code, "provider_quota_exceeded");
  assert.equal(upstreamCalls, 0);
});

test("POST /pull rechecks shared cooldown before retrying a transient MCP failure", async () => {
  const env = createEnv({ TV_MCP_MAX_RETRIES: "3" });
  await env.OAUTH_STORE.put(
    "tv_mcp:oauth_token",
    JSON.stringify({ access_token: "ok-token", expires_at: Math.floor(Date.now() / 1000) + 3600 })
  );

  let mcpCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes(".well-known/oauth-authorization-server")) {
      return jsonResponse({
        authorization_endpoint: "https://mcp.example.com/oauth/authorize",
        token_endpoint: "https://mcp.example.com/oauth/token",
        token_endpoint_auth_methods_supported: ["none"]
      });
    }

    if (String(url).includes("/mcp")) {
      mcpCalls += 1;
      if (mcpCalls === 1) {
        // Simulate another concurrent request opening the shared cooldown
        // while this request is waiting to retry its transient 503.
        await env.OAUTH_STORE.put("tv_mcp:quota_cooldown_until", JSON.stringify({
          until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          reason: "provider_quota_exceeded"
        }));
        return jsonResponse({ error: { message: "temporary upstream failure" } }, { status: 503 });
      }
      return jsonResponse({ result: { data: { headlines: [] } } });
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const response = await worker.fetch(new Request("https://news.example.com/pull", {
    method: "POST",
    headers: { authorization: "Bearer ingest-secret" }
  }), env, createCtx());

  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.reason, "TradingView MCP get_news failed");
  assert.equal(body.detail, "TradingView MCP quota cooldown active");
  assert.equal(body.upstream_diagnostic.code, "mcp_quota_cooldown_active");
  assert.equal(mcpCalls, 1, "must not retry MCP after a concurrent request opens cooldown");
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

test("scheduled ingestion uses configured bearer secret internally and records a successful article fetch", async () => {
  const env = createEnv();
  await env.OAUTH_STORE.put(
    "tv_mcp:oauth_token",
    JSON.stringify({ access_token: "valid-token", refresh_token: "refresh-token", expires_at: Math.floor(Date.now() / 1000) + 3600 })
  );

  let mcpCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes(".well-known/oauth-authorization-server")) {
      return jsonResponse({
        authorization_endpoint: "https://mcp.example.com/oauth/authorize",
        token_endpoint: "https://mcp.example.com/oauth/token",
        token_endpoint_auth_methods_supported: ["none"]
      });
    }
    if (String(url).includes("/mcp")) {
      assert.equal(init.headers.authorization, "Bearer valid-token");
      mcpCalls += 1;
      if (mcpCalls === 1) return jsonResponse({ result: { articles: [] } });
      return jsonResponse({
        result: {
          data: {
            headlines: [
              { id: "scheduled-1", title: "Gold outlook update", url: "https://news.example.com/1", published_at: new Date().toISOString(), symbols: ["OANDA:XAUUSD"] }
            ]
          }
        }
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  await worker.scheduled(
    { scheduledTime: Date.now(), cron: "*/30 * * * *" },
    env,
    createCtx()
  );

  const stored = JSON.parse(await env.OAUTH_STORE.get("tv_mcp:last_scheduled_pull"));
  assert.equal(stored.status, "ok");
  assert.equal(stored.article_count, 1);
  assert.equal(stored.http_status, 200);
  assert.equal(stored.pull_attempts, 1);
  assert.equal(mcpCalls, 3);
  assert.deepEqual(stored.symbols, ["OANDA:XAUUSD", "TVC:USOIL", "TVC:DXY"]);

  // The cron warms the shared cache but must not consume the article fingerprint.
  assert.equal(await env.OAUTH_STORE.get("tv_mcp:seen_articles_v1"), null);
  const consumerResponse = await worker.fetch(new Request("https://news.cryptophys.work/pull", {
    method: "POST",
    headers: { authorization: "Bearer ingest-secret" }
  }), env, createCtx());
  assert.equal(consumerResponse.status, 200);
  const consumerBody = await consumerResponse.json();
  assert.equal(consumerBody.cache, "hit");
  assert.equal(consumerBody.count, 1);
  assert.equal(consumerBody.articles[0].title, "Gold outlook update");
  assert.equal(mcpCalls, 3, "consumer should use the scheduled cache without another upstream call");
  const seenAfterConsumer = JSON.parse(await env.OAUTH_STORE.get("tv_mcp:seen_articles_v1"));
  assert.equal(seenAfterConsumer.records.length, 1);
  assert.equal(JSON.stringify(stored).includes("valid-token"), false);

  const health = await worker.fetch(new Request("https://news.example.com/health"), env, createCtx());
  const healthBody = await health.json();
  assert.equal(healthBody.last_scheduled_ingest.status, "ok");
  assert.equal(healthBody.last_scheduled_ingest.article_count, 1);
});

test("HTTP 429 quota response opens cooldown and is not retried", async () => {
  const env = createEnv({ TV_MCP_MAX_RETRIES: "3" });
  await env.OAUTH_STORE.put(
    "tv_mcp:oauth_token",
    JSON.stringify({ access_token: "valid-token", refresh_token: "refresh-token", expires_at: Math.floor(Date.now() / 1000) + 3600 })
  );

  let mcpCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes(".well-known/oauth-authorization-server")) {
      return jsonResponse({
        authorization_endpoint: "https://mcp.example.com/oauth/authorize",
        token_endpoint: "https://mcp.example.com/oauth/token",
        token_endpoint_auth_methods_supported: ["none"]
      });
    }
    if (String(url).includes("/mcp")) {
      mcpCalls += 1;
      return jsonResponse({
        error: {
          code: "TOOL_QUOTA_EXCEEDED"
        }
      }, { status: 429 });
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

  assert.equal(response.status, 502);
  assert.equal(mcpCalls, 1, "HTTP 429 quota responses must not trigger retries");
  const cooldown = JSON.parse(await env.OAUTH_STORE.get("tv_mcp:quota_cooldown_until"));
  assert.equal(cooldown.reason, "provider_quota_exceeded");
  assert.ok(Date.parse(cooldown.until) > Date.now());
});

test("scheduled ingestion opens a quota cooldown and avoids retrying a suspended MCP tool", async () => {
  const env = createEnv();
  await env.OAUTH_STORE.put(
    "tv_mcp:oauth_token",
    JSON.stringify({
      access_token: "valid-token",
      refresh_token: "refresh-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600
    })
  );

  let mcpCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes(".well-known/oauth-authorization-server")) {
      return jsonResponse({
        authorization_endpoint: "https://mcp.example.com/oauth/authorize",
        token_endpoint: "https://mcp.example.com/oauth/token",
        token_endpoint_auth_methods_supported: ["none"]
      });
    }
    if (String(url).includes("/mcp")) {
      mcpCalls += 1;
      return jsonResponse({
        result: {
          isError: true,
          content: [{
            type: "text",
            text: "tool_pre_invoke blocked by plugin ToolQuotaPlugin: TOOL_QUOTA_EXCEEDED - Tool call quota exceeded (Your TradingView account MCP usage has raised suspicion and access to MCP is suspended until 00:00 UTC."
          }]
        }
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  await worker.scheduled({ scheduledTime: Date.now(), cron: "*/1 * * * *" }, env, createCtx());

  assert.equal(mcpCalls, 1, "quota errors must not trigger retries");
  const cooldown = JSON.parse(await env.OAUTH_STORE.get("tv_mcp:quota_cooldown_until"));
  assert.equal(cooldown.reason, "provider_quota_exceeded");
  assert.ok(Date.parse(cooldown.until) > Date.now());

  await worker.scheduled({ scheduledTime: Date.now(), cron: "*/1 * * * *" }, env, createCtx());
  assert.equal(mcpCalls, 1, "active cooldown must prevent further provider calls");

  const health = await worker.fetch(
    new Request("https://news.example.com/health"),
    env,
    createCtx()
  );
  const healthBody = await health.json();
  assert.equal(healthBody.provider_cooldown_until, cooldown.until);
  assert.equal(healthBody.provider_cooldown_reason, "provider_quota_exceeded");
  assert.equal(healthBody.last_scheduled_ingest.failure_reason, "TradingView MCP quota cooldown active");
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


test("last-hour filter excludes stale, future, invalid and undated news", () => {
  const now = Date.parse("2026-11-02T00:00:00.000Z");
  const articles = [
    { title: "At cutoff", url: "https://news.example.com/cutoff", published_at: "2026-11-01T23:00:00.000Z" },
    { title: "Fresh", url: "https://news.example.com/fresh", published_at: "2026-11-01T23:59:00.000Z" },
    { title: "Too old", url: "https://news.example.com/old", published_at: "2026-11-01T22:59:59.999Z" },
    { title: "Future", url: "https://news.example.com/future", published_at: "2026-11-02T00:00:01.000Z" },
    { title: "Undated", url: "https://news.example.com/undated" },
    { title: "Invalid date", url: "https://news.example.com/invalid", published_at: "not-a-date" }
  ];
  const filtered = internals.filterRecentArticles(articles, now);
  assert.deepEqual(filtered.map((item) => item.title), ["At cutoff", "Fresh"]);
});

test("dedupe collapses tracking URLs and title/source duplicates while merging symbols", () => {
  const articles = [
    { title: "Gold rises on dollar weakness", source: "Market News", url: "https://NEWS.example.com/story?id=1&utm_source=a", symbols: ["OANDA:XAUUSD"] },
    { title: "Gold rises on dollar weakness", source: "Market News", url: "https://news.example.com/story?utm_source=b#top", symbols: ["TVC:DXY"] },
    { title: "Oil falls on inventory rise", source: "Market News", url: "https://another.example.com/different", symbols: ["TVC:USOIL"] }
  ];
  const deduped = internals.dedupeArticles(articles);
  assert.equal(deduped.length, 2);
  assert.deepEqual(deduped[0].symbols.sort(), ["OANDA:XAUUSD", "TVC:DXY"]);
});

test("cached articles outside the one-hour window are not returned as valid cache", async () => {
  const env = createEnv();
  const stalePayload = {
    worker: "xauusd-fundamental-news-ingestion",
    provider: "TradingView MCP",
    fetched_at: new Date().toISOString(),
    symbols: ["OANDA:XAUUSD", "TVC:USOIL", "TVC:DXY"],
    count: 1,
    available: true,
    articles: [{ id: "stale", title: "Stale headline", url: "https://news.example.com/stale", published_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), symbols: ["OANDA:XAUUSD"] }]
  };
  const cacheKey = new Request(new URL("/_internal/tv-mcp-cache?symbols=OANDA%3AXAUUSD%2CTVC%3AUSOIL%2CTVC%3ADXY", "https://news.example.com"), { method: "GET" });
  await caches.default.put(cacheKey, new Response(JSON.stringify(stalePayload), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=120" }
  }));
  await env.OAUTH_STORE.put("tv_mcp:quota_cooldown_until", JSON.stringify({
    until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    reason: "provider_quota_exceeded"
  }));
  const response = await worker.fetch(new Request("https://news.example.com/pull", {
    method: "POST",
    headers: { authorization: "Bearer ingest-secret" }
  }), env, createCtx());
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.reason, "TradingView MCP quota cooldown active");
  assert.equal(body.articles.length, 0);
});


test("persistent dedupe suppresses the same article across separate pulls", async () => {
  const env = createEnv();
  const article = {
    title: "Gold rises after dollar weakens",
    source: "Market News",
    url: "https://news.example.com/story?id=42&utm_source=first",
    published_at: new Date().toISOString(),
    symbols: ["OANDA:XAUUSD"]
  };
  const first = await internals.filterPreviouslySeenArticles(env, [article]);
  assert.equal(first.length, 1);

  const duplicateFromAnotherSymbol = {
    ...article,
    url: "https://NEWS.example.com/story?utm_source=second#headline",
    symbols: ["TVC:DXY"]
  };
  const second = await internals.filterPreviouslySeenArticles(env, [duplicateFromAnotherSymbol]);
  assert.equal(second.length, 0);
});

test("runNewsPull (NewsIngestionService RPC) runs /pull with the Worker's own secret", async () => {
  const { runNewsPull } = await import("../src/index.mjs");
  const missing = await runNewsPull({}, { waitUntil() {} });
  assert.equal(missing.rpc_http_status, 503);
  const noOauth = await runNewsPull({ INGEST_SECRET: "s" }, { waitUntil() {} });
  assert.equal(noOauth.rpc_http_status, 503);
  assert.equal(noOauth.oauth_configured, false);
});

test("OAuth callback falls back to the PKCE cookie when the KV state is not visible yet", async () => {
  const env = createEnv();
  const tokenBodies = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes(".well-known/oauth-authorization-server")) {
      return jsonResponse({
        authorization_endpoint: "https://mcp.example.com/oauth/authorize",
        token_endpoint: "https://mcp.example.com/oauth/token",
        token_endpoint_auth_methods_supported: ["none"]
      });
    }
    if (String(url).includes("/oauth/token")) {
      tokenBodies.push(new URLSearchParams(init.body));
      return jsonResponse({ access_token: "new-token", refresh_token: "r", expires_in: 3600 });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const start = await worker.fetch(new Request("https://news.example.com/oauth/start"), env, createCtx());
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const cookie = start.headers.get("set-cookie");
  assert.match(cookie, /^tv_mcp_oauth=[^;]+; .*HttpOnly; Secure; SameSite=Lax/);
  const cookiePair = cookie.split(";")[0];
  const verifier = cookiePair.slice(cookiePair.indexOf(".") + 1);

  // Simulate KV not yet visible at the callback location.
  await env.OAUTH_STORE.delete("tv_mcp:oauth_state:" + state);

  const wrongState = await worker.fetch(
    new Request("https://news.example.com/oauth/callback?code=abc&state=other", { headers: { cookie: cookiePair } }),
    env, createCtx()
  );
  assert.equal(wrongState.status, 400);

  const callback = await worker.fetch(
    new Request(`https://news.example.com/oauth/callback?code=abc&state=${state}`, { headers: { cookie: cookiePair } }),
    env, createCtx()
  );
  assert.equal(callback.status, 200);
  assert.equal((await callback.json()).oauth_authorized, true);
  assert.equal(tokenBodies.at(-1).get("code_verifier"), verifier);
  assert.match(callback.headers.get("set-cookie"), /tv_mcp_oauth=; Max-Age=0/);
  assert.equal(JSON.parse(await env.OAUTH_STORE.get("tv_mcp:oauth_token")).access_token, "new-token");
});

function mcpFetch(onMcp) {
  let mcpCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes(".well-known/oauth-authorization-server")) {
      return jsonResponse({
        authorization_endpoint: "https://mcp.example.com/oauth/authorize",
        token_endpoint: "https://mcp.example.com/oauth/token",
        token_endpoint_auth_methods_supported: ["none"]
      });
    }
    if (String(url).includes("/mcp")) {
      mcpCalls += 1;
      return onMcp(mcpCalls);
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };
  return () => mcpCalls;
}

async function authorizeNews(env) {
  await env.OAUTH_STORE.put(
    "tv_mcp:oauth_token",
    JSON.stringify({ access_token: "valid-token", refresh_token: "refresh-token", expires_at: Math.floor(Date.now() / 1000) + 3600 })
  );
}

test("generic HTTP 429 (no quota message) opens a short shared cooldown and is not retried", async () => {
  const env = createEnv({ TV_MCP_MAX_RETRIES: "3" });
  await authorizeNews(env);
  const calls = mcpFetch(() => new Response(JSON.stringify({ error: { code: "rate_limited", message: "Too Many Requests" } }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "120" }
  }));
  const before = Date.now();
  const response = await worker.fetch(
    new Request("https://news.example.com/pull", { method: "POST", headers: { authorization: "Bearer ingest-secret" } }),
    env,
    createCtx()
  );
  assert.equal(response.status, 502);
  assert.equal(calls(), 1, "a generic HTTP 429 must not be retried");
  const cooldown = JSON.parse(await env.OAUTH_STORE.get("tv_mcp:quota_cooldown_until"));
  assert.equal(cooldown.reason, "provider_rate_limited");
  const untilMs = Date.parse(cooldown.until);
  assert.ok(untilMs >= before + 119_000 && untilMs <= Date.now() + 121_000, "Retry-After (120 s) sets the cooldown length");

  // A second pull inside the cooldown makes no upstream call.
  await worker.fetch(
    new Request("https://news.example.com/pull", { method: "POST", headers: { authorization: "Bearer ingest-secret" } }),
    env,
    createCtx()
  );
  assert.equal(calls(), 1, "the shared cooldown stops the next invocation before MCP");
});

test("a rate-limit cooldown never shortens a longer quota suspension", async () => {
  const env = createEnv();
  const longUntil = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  await internals.writeQuotaCooldown(env, longUntil, "provider_quota_exceeded");
  await internals.writeQuotaCooldown(env, internals.rateLimitCooldownUntil(60_000), "provider_rate_limited");
  let stored = JSON.parse(await env.OAUTH_STORE.get("tv_mcp:quota_cooldown_until"));
  assert.equal(stored.until, longUntil, "the shorter rate-limit pause is ignored");
  assert.equal(stored.reason, "provider_quota_exceeded");

  // A longer cooldown does replace a shorter one.
  const env2 = createEnv();
  await internals.writeQuotaCooldown(env2, internals.rateLimitCooldownUntil(60_000), "provider_rate_limited");
  await internals.writeQuotaCooldown(env2, longUntil, "provider_quota_exceeded");
  stored = JSON.parse(await env2.OAUTH_STORE.get("tv_mcp:quota_cooldown_until"));
  assert.equal(stored.until, longUntil);
  assert.equal(stored.reason, "provider_quota_exceeded");
});

test("rate-limit cooldown length honours Retry-After within 30 s .. 15 min", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  const len = (ms) => Date.parse(internals.rateLimitCooldownUntil(ms, now)) - now;
  assert.equal(len(null), 60_000, "default 60 s without Retry-After");
  assert.equal(len(5_000), 30_000, "minimum 30 s");
  assert.equal(len(120_000), 120_000);
  assert.equal(len(3 * 60 * 60 * 1000), 15 * 60 * 1000, "maximum 15 min");
});

test("gatewayStatus reports the quota cooldown and OAuth state for the AI Worker, never a token", async () => {
  const { gatewayStatus } = await import(moduleUrl.href);
  const env = createEnv();
  const until = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
  await env.OAUTH_STORE.put("tv_mcp:quota_cooldown_until", JSON.stringify({ until, reason: "provider_quota_exceeded" }));
  const status = await gatewayStatus(env);
  assert.equal(status.cooldown_until, until);
  assert.equal(status.cooldown_reason, "provider_quota_exceeded");
  assert.equal(status.oauth_authorized, false);
  assert.doesNotMatch(JSON.stringify(status), /token|secret/i);
  const none = await gatewayStatus(createEnv());
  assert.deepEqual([none.cooldown_until, none.cooldown_reason], [null, null]);
});
