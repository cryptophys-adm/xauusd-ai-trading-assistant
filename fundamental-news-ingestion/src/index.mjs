const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const PROVIDER = "TradingView MCP";
const WORKER_NAME = "xauusd-fundamental-news-ingestion";
const TOKEN_KEY = "tv_mcp:oauth_token";
const LAST_SCHEDULED_PULL_KEY = "tv_mcp:last_scheduled_pull";
const QUOTA_COOLDOWN_KEY = "tv_mcp:quota_cooldown_until";
const STATE_PREFIX = "tv_mcp:oauth_state:";
const DEFAULT_SYMBOLS = ["OANDA:XAUUSD", "TVC:USOIL", "TVC:DXY"];
const METADATA_CACHE_TTL_MS = 60 * 60 * 1000;

let metadataCache = { value: null, expiresAt: 0 };

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

function getBearer(request) {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function asObject(value) {
  return value && typeof value === "object" ? value : null;
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function asArray(value) {
  return Array.isArray(value) ? value : null;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function parseCsv(value, fallback = []) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomBase64Url(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256Base64Url(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base64UrlEncode(new Uint8Array(digest));
}

function getBaseUrl(env) {
  const base = asString(env.TV_MCP_BASE_URL || "https://mcp.tradingview.com").trim();
  return base.replace(/\/+$/, "");
}

function getMetadataCandidates(env) {
  const base = getBaseUrl(env);
  const configured = asString(env.TV_MCP_METADATA_URL).trim();
  const candidates = [
    configured,
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`
  ].filter(Boolean);
  return [...new Set(candidates)];
}

function hasOAuthConfig(env) {
  return Boolean(env.OAUTH_STORE && asString(env.TV_MCP_CLIENT_ID) && asString(env.TV_MCP_REDIRECT_URI));
}

async function readKVJson(env, key) {
  if (!env.OAUTH_STORE) return null;
  const raw = await env.OAUTH_STORE.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return asObject(parsed);
  } catch {
    return null;
  }
}

async function writeKVJson(env, key, value, expirationTtl) {
  if (!env.OAUTH_STORE) return;
  await env.OAUTH_STORE.put(key, JSON.stringify(value), expirationTtl ? { expirationTtl } : undefined);
}

async function deleteKVKey(env, key) {
  if (!env.OAUTH_STORE) return;
  await env.OAUTH_STORE.delete(key);
}

async function readQuotaCooldown(env) {
  if (!env.OAUTH_STORE) return null;
  try {
    const raw = await env.OAUTH_STORE.get(QUOTA_COOLDOWN_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    const until = asString(value?.until);
    const untilMs = Date.parse(until);
    if (!Number.isFinite(untilMs)) return null;
    if (untilMs <= Date.now()) {
      await deleteKVKey(env, QUOTA_COOLDOWN_KEY);
      return null;
    }
    return { until, reason: asString(value?.reason) || "provider_quota_exceeded" };
  } catch {
    return null;
  }
}

async function writeQuotaCooldown(env, until) {
  if (!env.OAUTH_STORE) return;
  const cooldownUntil = asString(until) || new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await env.OAUTH_STORE.put(
    QUOTA_COOLDOWN_KEY,
    JSON.stringify({
      until: cooldownUntil,
      reason: "provider_quota_exceeded",
      recorded_at: new Date().toISOString()
    }),
    { expirationTtl: 60 * 60 * 24 }
  );
}

async function fetchOAuthMetadata(env) {
  const now = Date.now();
  if (metadataCache.value && metadataCache.expiresAt > now) {
    return metadataCache.value;
  }

  const errors = [];
  const userAgent = asString(env.NEWS_INGEST_USER_AGENT || "XAUUSD-Fundamental-News-Ingestion/2.0");
  for (const endpoint of getMetadataCandidates(env)) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          accept: "application/json",
          "user-agent": userAgent
        },
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) {
        errors.push(`metadata ${endpoint} -> HTTP ${response.status}`);
        continue;
      }
      const body = await response.json();
      const metadata = asObject(body);
      if (!metadata) {
        errors.push(`metadata ${endpoint} -> invalid JSON object`);
        continue;
      }
      const authorizationEndpoint = asString(metadata.authorization_endpoint);
      const tokenEndpoint = asString(metadata.token_endpoint);
      if (!authorizationEndpoint || !tokenEndpoint) {
        errors.push(`metadata ${endpoint} -> missing authorization_endpoint/token_endpoint`);
        continue;
      }

      const base = getBaseUrl(env);
      const normalized = {
        ...metadata,
        authorization_endpoint: authorizationEndpoint,
        token_endpoint: tokenEndpoint,
        mcp_endpoint: asString(env.TV_MCP_ENDPOINT || metadata.mcp_endpoint || `${base}/mcp`).trim(),
        token_endpoint_auth_methods_supported: asArray(metadata.token_endpoint_auth_methods_supported) || []
      };
      metadataCache = { value: normalized, expiresAt: now + METADATA_CACHE_TTL_MS };
      return normalized;
    } catch (error) {
      errors.push(`metadata ${endpoint} -> ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  throw Object.assign(new Error("Unable to load TradingView MCP OAuth metadata"), {
    code: "metadata_unavailable",
    detail: errors
  });
}

function resolveTokenAuthMethod(env, metadata) {
  const configured = asString(env.TV_MCP_TOKEN_AUTH_METHOD).trim();
  if (configured) return configured;

  const supportedRaw = asArray(metadata.token_endpoint_auth_methods_supported) || [];
  const supported = supportedRaw.filter((item) => typeof item === "string");
  const hasSecret = Boolean(asString(env.TV_MCP_CLIENT_SECRET));

  if (hasSecret && supported.includes("client_secret_basic")) return "client_secret_basic";
  if (hasSecret && supported.includes("client_secret_post")) return "client_secret_post";
  if (supported.includes("none")) return "none";

  return hasSecret ? "client_secret_basic" : "none";
}

async function requestToken(env, metadata, params) {
  const tokenEndpoint = asString(metadata.token_endpoint);
  const clientId = asString(env.TV_MCP_CLIENT_ID).trim();
  const clientSecret = asString(env.TV_MCP_CLIENT_SECRET);
  const tokenAuthMethod = resolveTokenAuthMethod(env, metadata);

  if (!clientId) {
    throw Object.assign(new Error("TV_MCP_CLIENT_ID is not configured"), { code: "oauth_not_configured" });
  }

  const body = new URLSearchParams(params);
  if (!body.get("client_id")) {
    body.set("client_id", clientId);
  }

  const headers = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    "user-agent": asString(env.NEWS_INGEST_USER_AGENT || "XAUUSD-Fundamental-News-Ingestion/2.0")
  };

  if (tokenAuthMethod === "client_secret_basic") {
    if (!clientSecret) {
      throw Object.assign(new Error("TV_MCP_CLIENT_SECRET is required for client_secret_basic"), {
        code: "oauth_not_configured"
      });
    }
    headers.authorization = "Basic " + btoa(`${clientId}:${clientSecret}`);
    body.delete("client_secret");
  } else if (tokenAuthMethod === "client_secret_post") {
    if (!clientSecret) {
      throw Object.assign(new Error("TV_MCP_CLIENT_SECRET is required for client_secret_post"), {
        code: "oauth_not_configured"
      });
    }
    body.set("client_secret", clientSecret);
  } else {
    body.delete("client_secret");
  }

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers,
    body: body.toString(),
    signal: AbortSignal.timeout(15000)
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw Object.assign(new Error(`Token exchange failed with HTTP ${response.status}`), {
      code: "token_exchange_failed",
      status: response.status,
      detail: asObject(payload) || text.slice(0, 500)
    });
  }

  const data = asObject(payload);
  if (!data || !asString(data.access_token)) {
    throw Object.assign(new Error("Token endpoint returned invalid token payload"), {
      code: "token_exchange_failed",
      detail: asObject(payload) || text.slice(0, 500)
    });
  }

  return data;
}

function normalizeTokenPayload(payload, previousRefreshToken = "") {
  const expiresIn = Number.parseInt(String(payload.expires_in || ""), 10);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? nowSeconds() + expiresIn : null;

  return {
    access_token: asString(payload.access_token),
    token_type: asString(payload.token_type) || "Bearer",
    refresh_token: asString(payload.refresh_token) || previousRefreshToken || "",
    scope: asString(payload.scope),
    expires_at: expiresAt,
    updated_at: new Date().toISOString()
  };
}

async function exchangeAuthorizationCode(env, metadata, code, codeVerifier, redirectUri) {
  const tokenPayload = await requestToken(env, metadata, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: asString(env.TV_MCP_CLIENT_ID),
    code_verifier: codeVerifier
  });
  return normalizeTokenPayload(tokenPayload);
}

async function refreshAccessToken(env, metadata, tokenRecord) {
  const refreshToken = asString(tokenRecord.refresh_token);
  if (!refreshToken) {
    throw Object.assign(new Error("Stored OAuth token is missing refresh_token"), {
      code: "token_missing_refresh"
    });
  }
  const tokenPayload = await requestToken(env, metadata, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: asString(env.TV_MCP_CLIENT_ID)
  });
  return normalizeTokenPayload(tokenPayload, refreshToken);
}

async function getStoredToken(env) {
  return readKVJson(env, TOKEN_KEY);
}

async function storeToken(env, tokenRecord) {
  await writeKVJson(env, TOKEN_KEY, tokenRecord);
}

async function getValidAccessToken(env, metadata) {
  const stored = await getStoredToken(env);
  if (!stored) {
    throw Object.assign(new Error("OAuth token has not been authorized yet"), { code: "token_missing" });
  }

  const accessToken = asString(stored.access_token);
  const expiresAt = Number.parseInt(String(stored.expires_at || ""), 10);
  const now = nowSeconds();

  if (accessToken && Number.isFinite(expiresAt) && expiresAt - now > 60) {
    return accessToken;
  }

  const refreshed = await refreshAccessToken(env, metadata, stored);
  await storeToken(env, refreshed);
  return asString(refreshed.access_token);
}

function normalizeArticle(item) {
  const source = asString(item.source || item.provider || item.author || item.site || item.domain);
  const rawPublished = item.published ?? item.published_at ?? item.datetime ?? item.time ?? item.timestamp ?? null;
  let published = rawPublished;
  if (typeof rawPublished === "number" || (typeof rawPublished === "string" && /^\d{10,13}$/.test(rawPublished.trim()))) {
    const numeric = Number(rawPublished);
    const milliseconds = String(Math.trunc(numeric)).length <= 10 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    published = Number.isFinite(date.getTime()) ? date.toISOString() : rawPublished;
  } else if (typeof rawPublished === "string" && rawPublished.trim()) {
    const date = new Date(rawPublished);
    if (Number.isFinite(date.getTime())) published = date.toISOString();
  }
  const symbols = asArray(item.symbols || item.tickers || item.relatedSymbols) || [];

  return {
    id: asString(item.id || item.uuid),
    title: asString(item.title || item.headline || item.name),
    summary: asString(item.summary || item.shortDescription || item.description || item.snippet),
    url: asString(item.url || item.link || item.storyPath),
    source,
    language: asString(item.language || item.lang),
    published_at: published,
    symbols: [...new Set(symbols.filter((value) => typeof value === "string"))]
  };
}

function pushCandidateArrays(target, value) {
  if (Array.isArray(value)) {
    target.push(value);
    return;
  }
  const objectValue = asObject(value);
  if (!objectValue) return;

  for (const key of ["articles", "headlines", "data", "results", "items", "news"]) {
    const candidate = objectValue[key];
    if (Array.isArray(candidate)) target.push(candidate);
    else if (candidate && typeof candidate === "object") pushCandidateArrays(target, candidate);
  }

  if (Array.isArray(objectValue.content)) {
    for (const item of objectValue.content) {
      if (Array.isArray(item)) {
        target.push(item);
        continue;
      }
      const contentItem = asObject(item);
      if (!contentItem) continue;
      if (Array.isArray(contentItem.articles)) target.push(contentItem.articles);
      const text = asString(contentItem.text);
      if (!text) continue;
      try {
        const parsed = JSON.parse(text);
        pushCandidateArrays(target, parsed);
      } catch {
        // Ignore non-JSON content entries.
      }
    }
  }
}

function redactDiagnosticText(value) {
  return asString(value)
    .slice(0, 240)
    .replace(/Bearer\\s+[A-Za-z0-9._~+\\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(access_token|refresh_token|client_secret|authorization)\\s*[:=]\\s*["']?[^,\\s"']+/gi, "$1=[redacted]");
}

function safeUpstreamDiagnostic(error) {
  const detail = asObject(error?.detail);
  const rpcError = asObject(detail?.error);
  const result = asObject(detail?.result);
  const resultError = asObject(result?.error);
  const selected = rpcError || resultError;
  const content = Array.isArray(result?.content) ? result.content : [];
  const contentText = content.map((item) => asString(asObject(item)?.text)).find(Boolean) || "";
  return {
    code: asString(error?.code) || null,
    upstream_error_code: selected && (typeof selected.code === "string" || typeof selected.code === "number") ? selected.code : null,
    upstream_error_message: redactDiagnosticText(selected?.message || detail?.message || contentText) || null,
    response_shape: detail ? Object.keys(detail).slice(0, 12) : typeof error?.detail === "string" ? "non_json_body" : null
  };
}

function summarizeMcpPayload(payload) {
  const root = asObject(payload) || {};
  const result = asObject(root.result) || {};
  const content = asArray(result.content) || [];
  return {
    top_level_keys: Object.keys(root).slice(0, 12),
    result_keys: Object.keys(result).slice(0, 12),
    has_rpc_error: Boolean(root.error),
    result_is_error: result.isError === true,
    content_types: content.slice(0, 5).map((item) => {
      const entry = asObject(item) || {};
      const text = asString(entry.text);
      let text_is_json = false;
      if (text) {
        try {
          JSON.parse(text);
          text_is_json = true;
        } catch {
          text_is_json = false;
        }
      }
      return {
        type: asString(entry.type) || null,
        text_length: text.length,
        text_is_json
      };
    })
  };
}

function extractMcpErrorText(payload) {
  const root = asObject(payload) || {};
  const result = asObject(root.result) || {};
  const rootError = asObject(root.error);
  const resultError = asObject(result.error);
  const content = asArray(result.content) || [];
  const contentText = content
    .map((item) => asString(asObject(item)?.text))
    .filter(Boolean)
    .join(" ");
  return [
    asString(rootError?.message),
    asString(resultError?.message),
    contentText
  ].filter(Boolean).join(" ");
}

function parseArticlesFromMcpPayload(payload) {
  const candidates = [];
  pushCandidateArrays(candidates, payload);
  const root = asObject(payload);
  if (root && root.result) pushCandidateArrays(candidates, root.result);
  if (root && root.params) pushCandidateArrays(candidates, root.params);

  const merged = [];
  for (const list of candidates) {
    for (const item of list) {
      const objectItem = asObject(item);
      if (!objectItem) continue;
      merged.push(normalizeArticle(objectItem));
    }
  }
  return dedupeArticles(merged);
}

function dedupeArticles(articles) {
  const seen = new Map();
  const deduped = [];
  for (const article of articles) {
    const key = asString(article.url) || asString(article.id) || (asString(article.title) + "|" + String(article.published_at || ""));
    if (!key) continue;
    const existingIndex = seen.get(key);
    if (existingIndex !== undefined) {
      const existing = deduped[existingIndex];
      existing.symbols = [...new Set([...(asArray(existing.symbols) || []), ...(asArray(article.symbols) || [])])];
      continue;
    }
    seen.set(key, deduped.length);
    deduped.push({ ...article, symbols: [...new Set(asArray(article.symbols) || [])] });
  }
  return deduped;
}

function unavailableResponse(status, reason, detail = {}) {
  return json(
    {
      worker: WORKER_NAME,
      provider: PROVIDER,
      fetched_at: new Date().toISOString(),
      available: false,
      reason,
      articles: [],
      count: 0,
      ...detail
    },
    status
  );
}

function retryAfterMilliseconds(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  const base = Math.min(300 * 2 ** (attempt - 1), 3000);
  return base + Math.floor(Math.random() * 100);
}

function parseMcpHttpBody(text, contentType, requestId = null) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {}
  // Streamable HTTP may emit multiple SSE events. Prefer the JSON-RPC response
  // matching this request ID; ignore unrelated notifications/progress messages.
  if (String(contentType || "").includes("text/event-stream") || trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    const messages = [];
    for (const block of trimmed.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === "object") messages.push(parsed);
      } catch {}
    }
    if (!messages.length) return null;
    if (requestId !== null) {
      // A request may receive progress/notification events before its response.
      // Never accept an unrelated event as the response for this request.
      return messages.find((message) =>
        message.id === requestId &&
        (message.result !== undefined || message.error !== undefined)
      ) || null;
    }
    return [...messages].reverse().find((message) => message && (message.result !== undefined || message.error !== undefined)) || messages[messages.length - 1];
  }
  return null;
}

async function postMcp(env, endpoint, accessToken, body, sessionId = "") {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
    "mcp-protocol-version": "2025-03-26",
    "user-agent": asString(env.NEWS_INGEST_USER_AGENT || "XAUUSD-Fundamental-News-Ingestion/2.0")
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`TradingView MCP returned HTTP ${response.status}`), {
      code: "mcp_upstream_error",
      status: response.status,
      retry_after_ms: Number.isFinite(Number.parseInt(response.headers.get("retry-after") || "", 10))
        ? Number.parseInt(response.headers.get("retry-after"), 10) * 1000 : null,
      detail: text.slice(0, 500)
    });
  }
  if (response.status === 202 || !text.trim()) {
    if (body?.id !== undefined) {
      throw Object.assign(new Error("TradingView MCP returned no JSON-RPC response for a request"), {
        code: "mcp_invalid_response",
        status: response.status,
        detail: { expected_id: body.id, response_status: response.status }
      });
    }
    return { payload: null, sessionId: response.headers.get("mcp-session-id") || sessionId };
  }
  const payload = parseMcpHttpBody(text, response.headers.get("content-type"), body?.id ?? null);
  if (!payload) {
    throw Object.assign(new Error("TradingView MCP returned an unparseable response"), {
      code: "mcp_invalid_response", detail: text.slice(0, 500)
    });
  }
  if (body?.id !== undefined && payload.id !== body.id) {
    throw Object.assign(new Error("TradingView MCP response ID does not match request ID"), {
      code: "mcp_invalid_response",
      detail: { expected_id: body.id, received_id: payload.id ?? null }
    });
  }
  if (payload.error) {
    throw Object.assign(new Error(`MCP JSON-RPC error: ${payload.error.message || "unknown error"}`), {
      code: "mcp_jsonrpc_error", detail: payload.error
    });
  }
  return { payload, sessionId: response.headers.get("mcp-session-id") || sessionId };
}

function parseQuotaCooldownUntil(message, now = Date.now()) {
  const match = asString(message).match(/suspended until\s+(\d{1,2}):(\d{2})\s*UTC/i);
  if (!match) return new Date(now + 60 * 60 * 1000).toISOString();

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return new Date(now + 60 * 60 * 1000).toISOString();

  const current = new Date(now);
  let until = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate(),
    hours,
    minutes,
    0,
    0
  );
  if (until <= now) until += 24 * 60 * 60 * 1000;
  return new Date(until).toISOString();
}

async function invokeMcpGetNews(env, metadata, accessToken, symbols) {
  const endpoint = asString(metadata.mcp_endpoint || env.TV_MCP_ENDPOINT || `${getBaseUrl(env)}/mcp`);
  const limit = Math.min(parsePositiveInt(env.TV_MCP_MAX_ARTICLES, 25), 200);
  const lang = asString(env.TV_MCP_NEWS_LANG || "en");
  let requestId = 1;

  // Establish a Streamable HTTP MCP session before invoking tools.
  const initialized = await postMcp(env, endpoint, accessToken, {
    jsonrpc: "2.0",
    id: requestId++,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: WORKER_NAME, version: "1.0.0" }
    }
  });
  const protocolVersion = initialized.payload?.result?.protocolVersion;
  if (protocolVersion !== "2025-03-26") {
    throw Object.assign(new Error(`TradingView MCP returned an unsupported protocol version: ${asString(protocolVersion) || "missing"}`), {
      code: "mcp_invalid_response"
    });
  }
  let sessionId = initialized.sessionId;

  await postMcp(env, endpoint, accessToken, {
    jsonrpc: "2.0",
    method: "notifications/initialized"
  }, sessionId);

  const articles = [];
  const calls = [];
  for (const symbol of symbols) {
    const result = await postMcp(env, endpoint, accessToken, {
      jsonrpc: "2.0",
      id: requestId++,
      method: "tools/call",
      params: {
        name: "get_news",
        arguments: { symbol, lang, limit, offset: 0 }
      }
    }, sessionId);
    sessionId = result.sessionId || sessionId;
    const payload = result.payload;
    if (!payload) continue;
    const resultObject = asObject(payload.result);
    if (payload.error || resultObject?.isError === true) {
      const upstreamMessage = extractMcpErrorText(payload);
      const quotaExceeded = /TOOL_QUOTA_EXCEEDED|tool call quota exceeded|access to MCP is suspended/i.test(upstreamMessage);
      throw Object.assign(new Error(
        quotaExceeded
          ? "TradingView MCP tool quota exceeded"
          : `TradingView MCP get_news tool reported an error for symbol ${symbol}`
      ), {
        code: quotaExceeded ? "mcp_quota_exceeded" : "mcp_tool_error",
        status: quotaExceeded ? 429 : 502,
        quota_cooldown_until: quotaExceeded ? parseQuotaCooldownUntil(upstreamMessage) : null,
        detail: payload
      });
    }

    calls.push({ symbol, result: payload.result ?? payload });
    const parsed = parseArticlesFromMcpPayload(payload);
    for (const article of parsed) {
      if (!article.symbols.length) article.symbols = [symbol];
      articles.push(article);
    }
  }
  return {
    jsonrpc: "2.0",
    id: "news-aggregate",
    result: { articles: dedupeArticles(articles), calls }
  };
}

async function invokeMcpGetNewsWithRetry(env, metadata, accessToken, symbols) {
  const maxAttempts = parsePositiveInt(env.TV_MCP_MAX_RETRIES, 3);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const payload = await invokeMcpGetNews(env, metadata, accessToken, symbols);
      return { payload, attempt };
    } catch (error) {
      lastError = error;
      if (error?.code === "mcp_quota_exceeded") {
        try {
          await writeQuotaCooldown(env, error.quota_cooldown_until);
        } catch {
          console.error("provider_quota_cooldown_store_failed");
        }
        break;
      }
      const status = Number.parseInt(String(error?.status || ""), 10);
      const retryable = !Number.isFinite(status) || status === 429 || (status >= 500 && status <= 599);
      if (!retryable || attempt === maxAttempts) break;

      const retryDelay = Number.isFinite(Number(error?.retry_after_ms))
        ? Number(error.retry_after_ms)
        : retryAfterMilliseconds({ headers: { get: () => null } }, attempt);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }

  throw lastError || new Error("TradingView MCP request failed");
}

async function handleOAuthStart(request, env) {
  if (!hasOAuthConfig(env)) {
    return unavailableResponse(503, "OAuth configuration is incomplete", {
      oauth_configured: false
    });
  }

  let metadata;
  try {
    metadata = await fetchOAuthMetadata(env);
  } catch (error) {
    return unavailableResponse(503, "OAuth metadata unavailable", {
      detail: error instanceof Error ? error.message : "Unknown error"
    });
  }

  const state = randomBase64Url(24);
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const redirectUri = asString(env.TV_MCP_REDIRECT_URI).trim();
  const scope = asString(env.TV_MCP_SCOPE || "").trim();
  const resource = asString(env.TV_MCP_RESOURCE || "").trim();

  await writeKVJson(
    env,
    STATE_PREFIX + state,
    {
      created_at: new Date().toISOString(),
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      scope,
      resource
    },
    10 * 60
  );

  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", asString(env.TV_MCP_CLIENT_ID).trim());
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  if (scope) authUrl.searchParams.set("scope", scope);
  if (resource) authUrl.searchParams.set("resource", resource);

  const url = new URL(request.url);
  if (url.searchParams.get("format") === "json") {
    return json({ authorization_url: authUrl.toString(), state });
  }
  return Response.redirect(authUrl.toString(), 302);
}

async function handleOAuthCallback(request, env) {
  if (!hasOAuthConfig(env)) {
    return unavailableResponse(503, "OAuth configuration is incomplete", {
      oauth_configured: false
    });
  }

  const url = new URL(request.url);
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    return json({
      worker: WORKER_NAME,
      provider: PROVIDER,
      oauth_authorized: false,
      error: errorParam,
      error_description: url.searchParams.get("error_description") || ""
    }, 400);
  }

  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  if (!code || !state) {
    return json({ error: "Missing OAuth code or state" }, 400);
  }

  const stateRecord = await readKVJson(env, STATE_PREFIX + state);
  await deleteKVKey(env, STATE_PREFIX + state);
  if (!stateRecord) {
    return json({ error: "Invalid or expired OAuth state" }, 400);
  }

  const codeVerifier = asString(stateRecord.code_verifier);
  const expectedRedirect = asString(stateRecord.redirect_uri);
  const configuredRedirect = asString(env.TV_MCP_REDIRECT_URI).trim();
  if (!codeVerifier) {
    return json({ error: "Invalid PKCE verifier for OAuth state" }, 400);
  }
  if (!expectedRedirect || expectedRedirect !== configuredRedirect) {
    return json({ error: "Configured redirect URI does not match OAuth state redirect URI" }, 400);
  }

  let metadata;
  try {
    metadata = await fetchOAuthMetadata(env);
  } catch (error) {
    return unavailableResponse(503, "OAuth metadata unavailable", {
      detail: error instanceof Error ? error.message : "Unknown error"
    });
  }

  try {
    const tokenRecord = await exchangeAuthorizationCode(env, metadata, code, codeVerifier, configuredRedirect);
    await storeToken(env, tokenRecord);
    return json({
      worker: WORKER_NAME,
      provider: PROVIDER,
      oauth_authorized: true,
      token_type: tokenRecord.token_type,
      expires_at: tokenRecord.expires_at,
      scope: tokenRecord.scope
    });
  } catch (error) {
    const status = Number.parseInt(String(error?.status || ""), 10);
    const safeStatus = Number.isFinite(status) && status >= 400 && status < 600 ? status : 502;
    return json({
      worker: WORKER_NAME,
      provider: PROVIDER,
      oauth_authorized: false,
      error: "OAuth token exchange failed",
      detail: error instanceof Error ? error.message : "Unknown error",
      upstream_status: Number.isFinite(status) ? status : null
    }, safeStatus);
  }
}

async function readLastScheduledPull(env) {
  if (!env.OAUTH_STORE) return null;
  try {
    const raw = await env.OAUTH_STORE.get(LAST_SCHEDULED_PULL_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    return {
      status: asString(value.status) || "unknown",
      checked_at: asString(value.checked_at) || null,
      fetched_at: asString(value.fetched_at) || null,
      article_count: Number.isFinite(Number(value.article_count)) ? Number(value.article_count) : 0,
      symbols: Array.isArray(value.symbols) ? value.symbols.filter((item) => typeof item === "string").slice(0, 10) : [],
      cache: asString(value.cache) || null,
      http_status: Number.isFinite(Number(value.http_status)) ? Number(value.http_status) : null,
      pull_attempts: Number.isFinite(Number(value.pull_attempts)) ? Number(value.pull_attempts) : 1,
      payload_diagnostics: value.payload_diagnostics && typeof value.payload_diagnostics === "object" ? value.payload_diagnostics : null,
      failure_reason: asString(value.failure_reason) || null,
      failure_diagnostic: value.failure_diagnostic && typeof value.failure_diagnostic === "object" ? value.failure_diagnostic : null,
      upstream_status: Number.isFinite(Number(value.upstream_status)) ? Number(value.upstream_status) : null
    };
  } catch {
    return null;
  }
}

async function buildHealth(env) {
  const symbols = parseCsv(env.TV_MCP_SYMBOLS, DEFAULT_SYMBOLS);
  const token = await getStoredToken(env);
  const tokenExpiresAt = Number.parseInt(String(token?.expires_at || ""), 10);
  const hasUsableAccessToken = Boolean(asString(token?.access_token)) && (!Number.isFinite(tokenExpiresAt) || tokenExpiresAt > nowSeconds());
  const hasRefreshToken = Boolean(asString(token?.refresh_token));
  const providerCooldown = await readQuotaCooldown(env);

  return {
    worker: WORKER_NAME,
    status: "ok",
    provider: PROVIDER,
    symbols,
    ingest_auth_configured: Boolean(asString(env.INGEST_SECRET)),
    oauth_configured: hasOAuthConfig(env),
    oauth_authorized: hasUsableAccessToken || hasRefreshToken,
    oauth_redirect_uri_configured: Boolean(asString(env.TV_MCP_REDIRECT_URI).trim()),
    oauth_client_id_configured: Boolean(asString(env.TV_MCP_CLIENT_ID).trim()),
    oauth_store_configured: Boolean(env.OAUTH_STORE),
    provider_cooldown_until: providerCooldown?.until || null,
    provider_cooldown_reason: providerCooldown?.reason || null,
    last_scheduled_ingest: await readLastScheduledPull(env)
  };
}

async function handlePull(request, env, ctx, options = {}) {
  if (!asString(env.INGEST_SECRET)) {
    return unavailableResponse(503, "INGEST_SECRET is not configured");
  }

  if (getBearer(request) !== env.INGEST_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (!hasOAuthConfig(env)) {
    return unavailableResponse(503, "TradingView MCP OAuth is not configured", {
      oauth_configured: false
    });
  }

  const cooldown = await readQuotaCooldown(env);
  if (cooldown) {
    return unavailableResponse(503, "TradingView MCP quota cooldown active", {
      failure_code: "provider_quota_exceeded",
      retry_at: cooldown.until
    });
  }

  const symbols = parseCsv(env.TV_MCP_SYMBOLS, DEFAULT_SYMBOLS);
  const cacheKey = new Request(new URL(`/_internal/tv-mcp-cache?symbols=${encodeURIComponent(symbols.join(","))}`, request.url), {
    method: "GET"
  });
  const cache = caches.default;
  if (!options.forceRefresh) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const payload = await cached.json();
      return json({ ...payload, cache: "hit" });
    }
  }

  let metadata;
  try {
    metadata = await fetchOAuthMetadata(env);
  } catch (error) {
    return unavailableResponse(503, "TradingView MCP OAuth metadata unavailable", {
      detail: error instanceof Error ? error.message : "Unknown error"
    });
  }

  let accessToken;
  try {
    accessToken = await getValidAccessToken(env, metadata);
  } catch (error) {
    return unavailableResponse(503, "TradingView MCP OAuth token unavailable", {
      detail: error instanceof Error ? error.message : "Unknown error"
    });
  }

  try {
    const { payload, attempt } = await invokeMcpGetNewsWithRetry(env, metadata, accessToken, symbols);
    const articles = parseArticlesFromMcpPayload(payload);
    const result = {
      worker: WORKER_NAME,
      provider: PROVIDER,
      fetched_at: new Date().toISOString(),
      symbols,
      count: articles.length,
      available: true,
      fetch_attempts: attempt,
      articles,
      ...(articles.length === 0 ? { payload_diagnostics: summarizeMcpPayload(payload) } : {})
    };

    const cacheTtl = parsePositiveInt(env.TV_MCP_CACHE_TTL_SECONDS, 120);
    const cacheResponse = new Response(JSON.stringify(result), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${cacheTtl}`
      }
    });
    ctx.waitUntil(cache.put(cacheKey, cacheResponse));

    return json({ ...result, cache: "miss" });
  } catch (error) {
    const status = Number.parseInt(String(error?.status || ""), 10);
    if (status === 401 || status === 403) {
      return unavailableResponse(503, "TradingView MCP OAuth authorization failed", {
        upstream_status: status,
        detail: error instanceof Error ? error.message : "Unknown error"
      });
    }
    const safeStatus = Number.isFinite(status) ? 502 : 502;
    return unavailableResponse(safeStatus, "TradingView MCP get_news failed", {
      upstream_status: Number.isFinite(status) ? status : null,
      detail: error instanceof Error ? error.message : "Unknown error",
      upstream_diagnostic: safeUpstreamDiagnostic(error)
    });
  }
}

export const internals = {
  parseArticlesFromMcpPayload,
  dedupeArticles,
  normalizeArticle,
  normalizeTokenPayload,
  resolveTokenAuthMethod,
  resetForTests() {
    metadataCache = { value: null, expiresAt: 0 };
  }
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json(await buildHealth(env));
    }

    if (request.method === "GET" && url.pathname === "/oauth/start") {
      return handleOAuthStart(request, env);
    }

    if (request.method === "GET" && url.pathname === "/oauth/callback") {
      return handleOAuthCallback(request, env);
    }

    if (request.method === "POST" && url.pathname === "/pull") {
      return handlePull(request, env, ctx);
    }

    return json(
      {
        error: "Not found",
        endpoints: ["GET /health", "GET /oauth/start", "GET /oauth/callback", "POST /pull"]
      },
      404
    );
  },

  async scheduled(_controller, env, ctx) {
    const checkedAt = new Date().toISOString();
    try {
      let response;
      let payload = {};
      let pullAttempt = 0;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const request = new Request("https://news.cryptophys.work/pull", {
          method: "POST",
          headers: { authorization: `Bearer ${asString(env.INGEST_SECRET)}` }
        });
        response = await handlePull(request, env, ctx, { forceRefresh: attempt > 1 });
        payload = await response.json().catch(() => ({}));
        pullAttempt = attempt;
        const articles = Array.isArray(payload.articles) ? payload.articles : [];
        const count = Number.isFinite(Number(payload.count)) ? Number(payload.count) : articles.length;
        if (response.ok && payload.available === true && count > 0) break;
        if (!(attempt === 1 && response.ok && payload.available === true && count === 0)) break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      const articles = Array.isArray(payload.articles) ? payload.articles : [];
      const articleCount = Number.isFinite(Number(payload.count)) ? Number(payload.count) : articles.length;
      const available = payload.available === true;
      const status = response.ok && available && articleCount > 0
        ? "ok"
        : response.ok && available
          ? "empty"
          : "error";
      const summary = {
        status,
        checked_at: checkedAt,
        fetched_at: asString(payload.fetched_at) || null,
        article_count: articleCount,
        symbols: Array.isArray(payload.symbols) ? payload.symbols.filter((item) => typeof item === "string").slice(0, 10) : parseCsv(env.TV_MCP_SYMBOLS, DEFAULT_SYMBOLS),
        cache: asString(payload.cache) || null,
        http_status: response.status,
        pull_attempts: pullAttempt,
        payload_diagnostics: payload.payload_diagnostics && typeof payload.payload_diagnostics === "object" ? payload.payload_diagnostics : null,
        failure_reason: asString(payload.reason) || null,
        failure_diagnostic: payload.upstream_diagnostic && typeof payload.upstream_diagnostic === "object" ? payload.upstream_diagnostic : null,
        upstream_status: Number.isFinite(Number(payload.upstream_status)) ? Number(payload.upstream_status) : null
      };
      if (env.OAUTH_STORE) {
        await env.OAUTH_STORE.put(LAST_SCHEDULED_PULL_KEY, JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 * 7 });
      }
      const message = JSON.stringify(summary);
      if (status === "ok") console.log("scheduled_news_ingest_success", message);
      else if (status === "empty") console.warn("scheduled_news_ingest_empty", message);
      else console.error("scheduled_news_ingest_failed", message);
    } catch (error) {
      const summary = {
        status: "error",
        checked_at: checkedAt,
        fetched_at: null,
        article_count: 0,
        symbols: parseCsv(env.TV_MCP_SYMBOLS, DEFAULT_SYMBOLS),
        cache: null,
        http_status: 500
      };
      if (env.OAUTH_STORE) {
        try {
          await env.OAUTH_STORE.put(LAST_SCHEDULED_PULL_KEY, JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 * 7 });
        } catch {
          // Keep the scheduled invocation from failing on a secondary status-write error.
        }
      }
      console.error("scheduled_news_ingest_failed", JSON.stringify({
        ...summary,
        error: error instanceof Error ? error.message.slice(0, 200) : "Unknown error"
      }));
    }
  }
};
