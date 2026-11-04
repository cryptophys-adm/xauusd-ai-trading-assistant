import { runOhlcvRequests } from "./tv-gateway.mjs";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const PROVIDER = "TradingView MCP";
const WORKER_NAME = "xauusd-fundamental-news-ingestion";
const TOKEN_KEY = "tv_mcp:oauth_token";
const LAST_SCHEDULED_PULL_KEY = "tv_mcp:last_scheduled_pull";
const QUOTA_COOLDOWN_KEY = "tv_mcp:quota_cooldown_until";
const SEEN_ARTICLES_KEY = "tv_mcp:seen_articles_v1";
const SEEN_ARTICLES_TTL_MS = 24 * 60 * 60 * 1000;
const STATE_PREFIX = "tv_mcp:oauth_state:";
// PKCE fallback cookie: KV is eventually consistent across locations, so the
// state written by /oauth/start may not be readable yet where /oauth/callback
// lands. The browser carries the same state + verifier back in an HttpOnly cookie.
const OAUTH_COOKIE = "tv_mcp_oauth";
const OAUTH_STATE_TTL_SECONDS = 15 * 60;
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
      // Treat expired records as inactive. Do not delete here: a concurrent
      // invocation may have replaced the key with a newer cooldown.
      return null;
    }
    return { until, reason: asString(value?.reason) || "provider_quota_exceeded" };
  } catch {
    return null;
  }
}

async function writeQuotaCooldown(env, until, reason = "provider_quota_exceeded") {
  if (!env.OAUTH_STORE) return;
  const cooldownUntil = asString(until) || new Date(Date.now() + 60 * 60 * 1000).toISOString();
  // Never shorten an active cooldown: a short rate-limit pause must not
  // overwrite a longer quota suspension recorded by another invocation.
  const current = await readQuotaCooldown(env);
  if (current && Date.parse(current.until) >= Date.parse(cooldownUntil)) return;
  await env.OAUTH_STORE.put(
    QUOTA_COOLDOWN_KEY,
    JSON.stringify({
      until: cooldownUntil,
      reason,
      recorded_at: new Date().toISOString()
    }),
    { expirationTtl: 60 * 60 * 24 }
  );
}

const RATE_LIMIT_COOLDOWN_MIN_MS = 30 * 1000;
const RATE_LIMIT_COOLDOWN_DEFAULT_MS = 60 * 1000;
const RATE_LIMIT_COOLDOWN_MAX_MS = 15 * 60 * 1000;

/**
 * Shared cooldown end for a generic HTTP 429 (rate limit without the
 * TOOL_QUOTA_EXCEEDED message): honour Retry-After, clamped to 30 s..15 min.
 */
function rateLimitCooldownUntil(retryAfterMs, now = Date.now()) {
  const requested = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : RATE_LIMIT_COOLDOWN_DEFAULT_MS;
  const bounded = Math.min(Math.max(requested, RATE_LIMIT_COOLDOWN_MIN_MS), RATE_LIMIT_COOLDOWN_MAX_MS);
  return new Date(now + bounded).toISOString();
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
  const published = item.published || item.published_at || item.datetime || item.time || item.timestamp || null;
  const symbols = asArray(item.symbols || item.tickers) || [];

  return {
    id: asString(item.id || item.uuid),
    title: asString(item.title || item.headline || item.name),
    summary: asString(item.summary || item.shortDescription || item.description || item.snippet),
    url: asString(item.url || item.link || item.storyPath),
    source,
    language: asString(item.language || item.lang),
    published_at: published,
    symbols: symbols.filter((value) => typeof value === "string")
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
    asString(rootError?.code),
    asString(rootError?.message),
    asString(resultError?.code),
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

function canonicalArticleUrl(value) {
  const raw = asString(value).trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return raw.split(/[?#]/, 1)[0].replace(/\/+$/, "").toLowerCase();
  }
}

function articleDedupeKey(article) {
  const url = canonicalArticleUrl(article.url);
  if (url) return "url:" + url;
  const id = asString(article.id).trim().toLowerCase();
  if (id) return "id:" + id;
  const title = asString(article.title).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (!title) return "";
  const source = asString(article.source).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return "title:" + title + "|source:" + source;
}

function dedupeArticles(articles) {
  const seen = new Map();
  const deduped = [];
  for (const article of articles) {
    const key = articleDedupeKey(article);
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

function parsePublishedAtMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function filterRecentArticles(articles, now = Date.now(), windowMs = 60 * 60 * 1000) {
  const cutoff = now - windowMs;
  return dedupeArticles(articles).filter((article) => {
    const publishedAt = parsePublishedAtMs(article.published_at);
    // Missing/invalid timestamps cannot be proven to belong to the last hour.
    return publishedAt !== null && publishedAt >= cutoff && publishedAt <= now;
  });
}

async function filterPreviouslySeenArticles(env, articles, now = Date.now()) {
  const uniqueArticles = dedupeArticles(articles);
  if (!env.OAUTH_STORE || uniqueArticles.length === 0) return uniqueArticles;

  let storedRecords = [];
  try {
    const raw = await env.OAUTH_STORE.get(SEEN_ARTICLES_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed?.records)) storedRecords = parsed.records;
  } catch {
    storedRecords = [];
  }

  const cutoff = now - SEEN_ARTICLES_TTL_MS;
  const records = storedRecords.filter((record) =>
    typeof record?.fingerprint === "string" &&
    Number.isFinite(Date.parse(record.seen_at)) &&
    Date.parse(record.seen_at) >= cutoff
  );
  const seen = new Set(records.map((record) => record.fingerprint));
  const fresh = [];

  for (const article of uniqueArticles) {
    const key = articleDedupeKey(article);
    if (!key) continue;
    const fingerprint = await sha256Base64Url(key);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    records.push({ fingerprint, seen_at: new Date(now).toISOString() });
    fresh.push(article);
  }

  try {
    await env.OAUTH_STORE.put(
      SEEN_ARTICLES_KEY,
      JSON.stringify({ records }),
      { expirationTtl: Math.ceil(SEEN_ARTICLES_TTL_MS / 1000) }
    );
  } catch {
    // Keep ingestion available if dedupe state cannot be persisted; per-payload
    // deduplication and the one-hour publication-time filter still apply.
    console.error("news_dedupe_state_write_failed");
  }
  return fresh;
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
  const limit = parsePositiveInt(env.TV_MCP_MAX_ARTICLES, 20);
  const toolName = asString(env.TV_MCP_NEWS_TOOL_NAME || "mcp-tv-get-news");
  const mergedArticles = [];

  for (const symbol of symbols) {
    const requestBody = {
      jsonrpc: "2.0",
      id: randomBase64Url(12),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: { symbol, limit }
      }
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": asString(env.NEWS_INGEST_USER_AGENT || "XAUUSD-Fundamental-News-Ingestion/2.0")
      },
      body: JSON.stringify(requestBody),
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
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs = Number.isFinite(Number.parseInt(String(retryAfter || ""), 10))
        ? Number.parseInt(String(retryAfter), 10) * 1000
        : null;
      const upstreamMessage = payload ? extractMcpErrorText(payload) : text;
      const quotaExceeded = /TOOL_QUOTA_EXCEEDED|tool call quota exceeded|access to MCP is suspended/i.test(upstreamMessage);
      const rateLimited = !quotaExceeded && response.status === 429;
      throw Object.assign(new Error(
        quotaExceeded
          ? "TradingView MCP tool quota exceeded"
          : rateLimited
            ? `TradingView MCP rate limited (HTTP 429) for symbol ${symbol}`
            : `TradingView MCP returned HTTP ${response.status} for symbol ${symbol}`
      ), {
        code: quotaExceeded ? "mcp_quota_exceeded" : rateLimited ? "mcp_rate_limited" : "mcp_upstream_error",
        status: quotaExceeded ? 429 : response.status,
        quota_cooldown_until: quotaExceeded
          ? parseQuotaCooldownUntil(upstreamMessage)
          : rateLimited ? rateLimitCooldownUntil(retryAfterMs) : null,
        retry_after_ms: retryAfterMs,
        detail: asObject(payload) || text.slice(0, 500)
      });
    }

    if (!payload) {
      throw Object.assign(new Error("TradingView MCP returned non-JSON response"), {
        code: "mcp_invalid_response",
        detail: text.slice(0, 500)
      });
    }

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

    const symbolArticles = parseArticlesFromMcpPayload(payload).map((article) => ({
      ...article,
      symbols: [...new Set([symbol, ...(asArray(article.symbols) || [])])]
    }));
    mergedArticles.push(...symbolArticles);
  }

  const articles = dedupeArticles(mergedArticles);
  return {
    jsonrpc: "2.0",
    id: "combined-news-result",
    result: {
      content: [{ type: "text", text: JSON.stringify({ articles }) }]
    }
  };
}

async function invokeMcpGetNewsWithRetry(env, metadata, accessToken, symbols) {
  const maxAttempts = parsePositiveInt(env.TV_MCP_MAX_RETRIES, 3);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      const cooldown = await readQuotaCooldown(env);
      if (cooldown) {
        throw Object.assign(new Error("TradingView MCP quota cooldown active"), {
          code: "mcp_quota_cooldown_active",
          status: 503,
          quota_cooldown_until: cooldown.until
        });
      }
    }
    try {
      const payload = await invokeMcpGetNews(env, metadata, accessToken, symbols);
      return { payload, attempt };
    } catch (error) {
      lastError = error;
      if (error?.code === "mcp_quota_exceeded" || error?.code === "mcp_rate_limited") {
        // Quota suspension or generic HTTP 429: open the shared cooldown and do
        // not retry, so no invocation keeps spending provider quota.
        try {
          await writeQuotaCooldown(
            env,
            error.quota_cooldown_until,
            error.code === "mcp_rate_limited" ? "provider_rate_limited" : "provider_quota_exceeded"
          );
        } catch {
          console.error("provider_quota_cooldown_store_failed");
        }
        break;
      }
      const status = Number.parseInt(String(error?.status || ""), 10);
      const retryable = !Number.isFinite(status) || (status >= 500 && status <= 599);
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
    OAUTH_STATE_TTL_SECONDS
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
  return new Response(null, {
    status: 302,
    headers: {
      location: authUrl.toString(),
      "set-cookie": `${OAUTH_COOKIE}=${state}.${codeVerifier}; Max-Age=${OAUTH_STATE_TTL_SECONDS}; Path=/oauth; HttpOnly; Secure; SameSite=Lax`,
      "cache-control": "no-store"
    }
  });
}

function readOAuthCookie(request, state) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== OAUTH_COOKIE) continue;
    const value = rest.join("=");
    const dot = value.indexOf(".");
    if (dot <= 0) return null;
    const cookieState = value.slice(0, dot);
    const codeVerifier = value.slice(dot + 1);
    // Only accept the cookie for the exact state TradingView echoed back.
    if (cookieState !== state || !/^[A-Za-z0-9_-]{43,128}$/.test(codeVerifier)) return null;
    return { code_verifier: codeVerifier };
  }
  return null;
}

const CLEAR_OAUTH_COOKIE = { "set-cookie": `${OAUTH_COOKIE}=; Max-Age=0; Path=/oauth; HttpOnly; Secure; SameSite=Lax` };

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

  const configuredRedirectUri = asString(env.TV_MCP_REDIRECT_URI).trim();
  const kvRecord = await readKVJson(env, STATE_PREFIX + state);
  await deleteKVKey(env, STATE_PREFIX + state);
  const cookieRecord = kvRecord ? null : readOAuthCookie(request, state);
  const stateRecord = kvRecord || (cookieRecord ? { ...cookieRecord, redirect_uri: configuredRedirectUri } : null);
  if (!stateRecord) {
    return json({
      error: "Invalid or expired OAuth state",
      hint: "Open /oauth/start again and finish the TradingView login within 15 minutes in the same browser, without reloading the callback page."
    }, 400, CLEAR_OAUTH_COOKIE);
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
    }, 200, CLEAR_OAUTH_COOKIE);
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
    // The Worker name is historical: it is the single TradingView MCP gateway
    // (one OAuth grant, one account-wide quota cooldown) for news and OHLCV.
    role: "tradingview-mcp-gateway",
    services: {
      news: { transport: "http+cron", endpoints: ["POST /pull"], cron: "5 * * * *" },
      ohlcv: { transport: "rpc", entrypoint: "TvGateway", consumers: ["xauusd-tradingview-pull-adapter"] }
    },
    provider: PROVIDER,
    symbols,
    ingest_auth_configured: Boolean(asString(env.INGEST_SECRET)),
    oauth_configured: hasOAuthConfig(env),
    oauth_authorized: hasUsableAccessToken || hasRefreshToken,
    oauth_redirect_uri_configured: Boolean(asString(env.TV_MCP_REDIRECT_URI).trim()),
    oauth_client_id_configured: Boolean(asString(env.TV_MCP_CLIENT_ID).trim()),
    oauth_store_configured: Boolean(env.OAUTH_STORE),
    ohlcv_gateway: "rpc:TvGateway",
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

  const symbols = parseCsv(env.TV_MCP_SYMBOLS, DEFAULT_SYMBOLS);
  const cacheKey = new Request(new URL(`/_internal/tv-mcp-cache?symbols=${encodeURIComponent(symbols.join(","))}`, request.url), {
    method: "GET"
  });
  const cache = caches.default;
  if (!options.forceRefresh) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const payload = await cached.json();
      const recentCachedArticles = filterRecentArticles(asArray(payload.articles) || []);
      const cachedArticles = options.skipSeenTracking === true
        ? recentCachedArticles
        : await filterPreviouslySeenArticles(env, recentCachedArticles);
      if (cachedArticles.length > 0) {
        return json({ ...payload, articles: cachedArticles, count: cachedArticles.length, cache: "hit" });
      }
      if (recentCachedArticles.length > 0) {
        // The cache is fresh but all items have already been emitted. Return an
        // empty cache hit instead of making another provider request.
        return json({ ...payload, articles: [], count: 0, available: true, cache: "hit", duplicate_count: recentCachedArticles.length });
      }
      // A cache containing only stale/undated headlines is not valid for the
      // one-hour news window. Continue to upstream unless the quota cooldown blocks it.
    }
  }

  // Cached headlines are safe to serve during provider cooldown. Enforce the
  // circuit breaker only before OAuth discovery or an upstream MCP request.
  const cooldown = await readQuotaCooldown(env);
  if (cooldown) {
    return unavailableResponse(503, "TradingView MCP quota cooldown active", {
      failure_code: "provider_quota_exceeded",
      retry_at: cooldown.until
    });
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
    const recentArticles = filterRecentArticles(parseArticlesFromMcpPayload(payload));
    // Scheduled pulls warm the shared cache; only a consumer pull may mark
    // articles as emitted, otherwise the AI Worker could miss fresh news.
    const articles = options.skipSeenTracking === true
      ? recentArticles
      : await filterPreviouslySeenArticles(env, recentArticles);
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

/** Shared-grant OHLCV runner used by the TvGateway RPC entrypoint (src/worker.mjs). */
/**
 * Internal pull for RPC callers (the AI Worker's NEWS_INGESTION binding).
 * Runs the same handler as POST /pull with this Worker's own INGEST_SECRET, so
 * the caller needs no shared secret. Returns the JSON body of /pull.
 */
export async function runNewsPull(env, ctx, { forceRefresh = false } = {}) {
  const request = new Request("https://news.cryptophys.work/pull", {
    method: "POST",
    headers: { authorization: `Bearer ${asString(env.INGEST_SECRET)}` }
  });
  const response = await handlePull(request, env, ctx, { forceRefresh: forceRefresh === true });
  const body = await response.json().catch(() => ({}));
  return { ...body, rpc_http_status: response.status };
}

export function runTvOhlcv(env, requests) {
  return runOhlcvRequests(env, requests, {
    fetch: (...args) => fetch(...args),
    requestId: () => randomBase64Url(12),
    fetchOAuthMetadata,
    getValidAccessToken,
    readQuotaCooldown,
    writeQuotaCooldown,
    parseQuotaCooldownUntil,
    rateLimitCooldownUntil,
    extractMcpErrorText
  });
}

export const internals = {
  parseArticlesFromMcpPayload,
  dedupeArticles,
  filterRecentArticles,
  filterPreviouslySeenArticles,
  normalizeArticle,
  normalizeTokenPayload,
  resolveTokenAuthMethod,
  rateLimitCooldownUntil,
  writeQuotaCooldown,
  readQuotaCooldown,
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
      const request = new Request("https://news.cryptophys.work/pull", {
        method: "POST",
        headers: { authorization: `Bearer ${asString(env.INGEST_SECRET)}` }
      });
      // One scheduled invocation performs one pull only. Empty results are valid
      // and must not trigger a second quota-consuming provider request.
      const response = await handlePull(request, env, ctx, { skipSeenTracking: true });
      const payload = await response.json().catch(() => ({}));
      const pullAttempt = 1;
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
