const WORKER = "xauusd-fundamental-news-ingestion";
const PROVIDER = "TradingView MCP";
const DEFAULT_SYMBOLS = ["OANDA:XAUUSD", "TVC:USOIL", "TVC:DXY"];
const CACHE_TTL_S = 300;
const MAX_ATTEMPTS = 3;
const MAX_ARTICLES = 50;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra }
  });
}

function bearer(request) {
  const v = request.headers.get("authorization") || "";
  return v.startsWith("Bearer ") ? v.slice(7) : "";
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function authorized(request, env) {
  return timingSafeEqual(bearer(request), env.INGEST_SECRET || "");
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(n = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

export async function pkceChallenge(verifier) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export function redirectUri(request, env) {
  const configured = env.TV_MCP_REDIRECT_URI;
  if (!configured) throw new Error("TV_MCP_REDIRECT_URI is not configured");
  const uri = new URL(configured);
  if (uri.protocol !== "https:" || uri.pathname !== "/oauth/callback" || uri.search || uri.hash) {
    throw new Error("TV_MCP_REDIRECT_URI must be a canonical HTTPS /oauth/callback URL");
  }
  return uri.toString();
}

function symbolsOf(env) {
  const list = (env.TV_SYMBOLS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_SYMBOLS;
}

async function kvGetJson(env, key) {
  const raw = await env.TV_OAUTH_KV.get(key);
  return raw ? JSON.parse(raw) : null;
}
const kvPut = (env, key, value, ttl) =>
  env.TV_OAUTH_KV.put(key, JSON.stringify(value), ttl ? { expirationTtl: ttl } : undefined);

function configured(env) {
  return Boolean(env.INGEST_SECRET && env.TRADINGVIEW_MCP_URL && env.TV_OAUTH_KV);
}

// ---- OAuth discovery / registration -------------------------------------------------

async function discover(env) {
  const mcp = new URL(env.TRADINGVIEW_MCP_URL);
  let authServer = mcp.origin;
  try {
    const r = await fetch(new URL("/.well-known/oauth-protected-resource" + (mcp.pathname === "/" ? "" : mcp.pathname), mcp.origin));
    if (r.ok) {
      const prm = await r.json();
      if (Array.isArray(prm.authorization_servers) && prm.authorization_servers[0]) authServer = prm.authorization_servers[0];
    }
  } catch { /* fall back to MCP origin */ }
  const as = new URL(authServer);
  const r = await fetch(new URL("/.well-known/oauth-authorization-server" + (as.pathname === "/" ? "" : as.pathname), as.origin));
  if (!r.ok) throw new Error("OAuth metadata discovery failed with HTTP " + r.status);
  const meta = await r.json();
  if (!meta.authorization_endpoint || !meta.token_endpoint) throw new Error("OAuth metadata missing endpoints");
  return meta;
}

function authMethod(meta, client) {
  const supported = meta.token_endpoint_auth_methods_supported || ["client_secret_basic"];
  if (!client.client_secret) return "none";
  if (client.token_endpoint_auth_method) return client.token_endpoint_auth_method;
  return supported.includes("client_secret_basic") ? "client_secret_basic" : supported.includes("client_secret_post") ? "client_secret_post" : "none";
}

async function getClient(env, meta, request) {
  if (env.TV_OAUTH_CLIENT_ID) {
    return { client_id: env.TV_OAUTH_CLIENT_ID, client_secret: env.TV_OAUTH_CLIENT_SECRET || undefined };
  }
  const uri = redirectUri(request, env);
  const stored = await kvGetJson(env, "tv:client");
  // A client registered with a different redirect URI would cause token/authorize failures.
  if (stored && stored.redirect_uri === uri) return stored;
  if (!meta.registration_endpoint) throw new Error("No client credentials configured and no registration_endpoint advertised");
  const r = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "XAUUSD AI Trading Assistant",
      redirect_uris: [uri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    })
  });
  if (!r.ok) throw new Error("Client registration failed with HTTP " + r.status);
  const reg = await r.json();
  const client = {
    client_id: reg.client_id,
    client_secret: reg.client_secret,
    token_endpoint_auth_method: reg.token_endpoint_auth_method,
    redirect_uri: uri
  };
  await kvPut(env, "tv:client", client);
  return client;
}

async function tokenRequest(env, meta, client, params) {
  const method = authMethod(meta, client);
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const body = new URLSearchParams(params);
  if (method === "client_secret_basic") headers.authorization = "Basic " + btoa(client.client_id + ":" + client.client_secret);
  else {
    body.set("client_id", client.client_id);
    if (method === "client_secret_post") body.set("client_secret", client.client_secret);
  }
  body.set("resource", env.TRADINGVIEW_MCP_URL);
  const r = await fetch(meta.token_endpoint, { method: "POST", headers, body });
  let data = null;
  try { data = await r.json(); } catch { /* non-JSON */ }
  if (!r.ok || !data || !data.access_token) {
    // Only the OAuth error code is surfaced; never tokens or secrets.
    const err = new Error("Token endpoint returned HTTP " + r.status + (data && data.error ? " (" + data.error + ")" : ""));
    err.status = r.status;
    err.oauth_error = data && data.error;
    throw err;
  }
  return data;
}

async function storeTokens(env, data, previous) {
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || (previous && previous.refresh_token) || null,
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000
  };
  await kvPut(env, "tv:tokens", tokens);
  return tokens;
}

async function getAccessToken(env, request, forceRefresh = false) {
  const tokens = await kvGetJson(env, "tv:tokens");
  if (!tokens) return null;
  if (!forceRefresh && tokens.expires_at - Date.now() > 60000) return tokens.access_token;
  if (!tokens.refresh_token) return null;
  const meta = await discover(env);
  const client = await getClient(env, meta, request);
  const data = await tokenRequest(env, meta, client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  return (await storeTokens(env, data, tokens)).access_token;
}

async function oauthStart(request, env) {
  const meta = await discover(env);
  const client = await getClient(env, meta, request);
  const state = randomString(24);
  const verifier = randomString(48);
  await kvPut(env, "tv:state:" + state, { verifier }, 600);
  const u = new URL(meta.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri(request, env),
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    resource: env.TRADINGVIEW_MCP_URL
  }).toString();
  return json({ authorization_url: u.toString(), expires_in: 600 });
}

async function oauthCallback(request, env) {
  const q = new URL(request.url).searchParams;
  if (q.get("error")) return json({ error: "Authorization denied", oauth_error: q.get("error") }, 400);
  const state = q.get("state");
  const code = q.get("code");
  if (!state || !code) return json({ error: "Missing state or code" }, 400);
  const saved = await kvGetJson(env, "tv:state:" + state);
  if (!saved) return json({ error: "Invalid or expired state" }, 400);
  await env.TV_OAUTH_KV.delete("tv:state:" + state); // single use
  try {
    const meta = await discover(env);
    const client = await getClient(env, meta, request);
    const data = await tokenRequest(env, meta, client, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(request, env),
      code_verifier: saved.verifier
    });
    await storeTokens(env, data, null);
    return json({ status: "authorized" });
  } catch (e) {
    return json({ error: "Token exchange failed", detail: e.message }, 502);
  }
}

// ---- MCP client ----------------------------------------------------------------------

async function parseRpc(response) {
  const text = await response.text();
  if ((response.headers.get("content-type") || "").includes("text/event-stream")) {
    const msgs = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean);
    return JSON.parse(msgs[msgs.length - 1] || "null");
  }
  return text ? JSON.parse(text) : null;
}

async function rpc(env, token, sessionId, body) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: "Bearer " + token
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(env.TRADINGVIEW_MCP_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if ((r.status === 429 || r.status >= 500) && attempt < MAX_ATTEMPTS) {
      const ra = Number(r.headers.get("retry-after"));
      const wait = Math.min(ra > 0 ? ra * 1000 : 500 * 2 ** (attempt - 1), 5000);
      await new Promise((res) => setTimeout(res, env.TV_NO_BACKOFF ? 0 : wait));
      continue;
    }
    if (r.status === 401) { const e = new Error("MCP unauthorized"); e.unauthorized = true; throw e; }
    if (r.status === 429) { const e = new Error("MCP rate limited"); e.rateLimited = true; throw e; }
    if (!r.ok) throw new Error("MCP HTTP " + r.status);
    return { message: await parseRpc(r), sessionId: r.headers.get("mcp-session-id") || sessionId };
  }
}

export function extractArticles(result) {
  let data = result.structuredContent;
  if (!data) {
    for (const c of result.content || []) {
      if (c.type === "text") { try { data = JSON.parse(c.text); break; } catch { /* not JSON */ } }
    }
  }
  if (!data) return [];
  const list = Array.isArray(data) ? data : data.articles || data.news || data.items || data.results || [];
  return Array.isArray(list) ? list : [];
}

function normalize(item, symbol) {
  return {
    title: String(item.title || item.headline || ""),
    url: String(item.url || item.link || ""),
    source: String(item.source || item.provider || item.publisher || ""),
    published_at: String(item.published_at || item.published || item.time || item.date || ""),
    summary: String(item.summary || item.description || ""),
    symbol
  };
}

async function fetchAllNews(env, token) {
  let { message, sessionId } = await rpc(env, token, null, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: WORKER, version: "2.0.0" } }
  });
  if (message && message.error) throw new Error("MCP initialize error");
  await rpc(env, token, sessionId, { jsonrpc: "2.0", method: "notifications/initialized" });
  const seen = new Set();
  const articles = [];
  const errors = [];
  let id = 2;
  for (const symbol of symbolsOf(env)) {
    ({ message } = await rpc(env, token, sessionId, {
      jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "get_news", arguments: { symbol } }
    }));
    const result = message && message.result;
    if (!result || message.error || result.isError) { errors.push({ symbol, error: "get_news failed" }); continue; }
    for (const raw of extractArticles(result)) {
      const a = normalize(raw, symbol);
      const key = (a.url || a.title).toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      articles.push(a);
    }
  }
  return { articles: articles.slice(0, MAX_ARTICLES), errors };
}

async function pull(request, env) {
  const base = { worker: WORKER, provider: PROVIDER, fetched_at: new Date().toISOString(), articles: [], count: 0 };
  const unavailable = (reason, status = 503, extra = {}) => json({ ...base, available: false, reason, ...extra }, status);

  let token;
  try { token = await getAccessToken(env, request); } catch (e) { return unavailable("OAuth token refresh failed: " + e.message, 503); }
  if (!token) return unavailable("TradingView MCP is not authorized; complete OAuth via /oauth/start.");

  const cached = await kvGetJson(env, "tv:cache");
  if (cached) return json({ ...cached, cache: "hit" });

  let out;
  try {
    try { out = await fetchAllNews(env, token); }
    catch (e) {
      if (!e.unauthorized) throw e;
      const fresh = await getAccessToken(env, request, true);
      if (!fresh) return unavailable("TradingView MCP rejected the token; re-authorize.");
      out = await fetchAllNews(env, fresh);
    }
  } catch (e) {
    if (e.rateLimited) return unavailable("TradingView MCP rate limit reached", 503);
    return unavailable("TradingView MCP request failed: " + e.message, 502);
  }
  if (out.errors.length) return unavailable("get_news failed for one or more symbols; refusing an incomplete snapshot", 502, { errors: out.errors });
  const result = { ...base, available: true, symbols: symbolsOf(env), count: out.articles.length, articles: out.articles, errors: out.errors };
  await kvPut(env, "tv:cache", result, CACHE_TTL_S);
  return json({ ...result, cache: "miss" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === "GET" && pathname === "/health") {
      let authorizedFlag = false;
      if (env.TV_OAUTH_KV) { try { authorizedFlag = Boolean(await kvGetJson(env, "tv:tokens")); } catch { /* ignore */ } }
      return json({
        worker: WORKER,
        status: "ok",
        provider: PROVIDER,
        configured: configured(env),
        auth_configured: Boolean(env.INGEST_SECRET),
        oauth_authorized: authorizedFlag,
        symbols: symbolsOf(env)
      });
    }
    if (request.method === "GET" && pathname === "/oauth/callback") {
      if (!env.TV_OAUTH_KV || !env.TRADINGVIEW_MCP_URL) return json({ error: "Not configured" }, 503);
      return oauthCallback(request, env);
    }
    const known = (pathname === "/pull" && request.method === "POST") || (pathname === "/oauth/start" && request.method === "GET");
    if (!known) return json({ error: "Not found", endpoints: ["GET /health", "POST /pull", "GET /oauth/start", "GET /oauth/callback"] }, 404);
    if (!env.INGEST_SECRET) return json({ error: "INGEST_SECRET is not configured" }, 503);
    if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
    if (!env.TRADINGVIEW_MCP_URL || !env.TV_OAUTH_KV) {
      return json({ worker: WORKER, provider: PROVIDER, available: false, reason: "TradingView MCP is not configured", articles: [], count: 0 }, 503);
    }
    try {
      return pathname === "/pull" ? await pull(request, env) : await oauthStart(request, env);
    } catch (e) {
      return json({ worker: WORKER, provider: PROVIDER, available: false, reason: e.message, articles: [], count: 0 }, 502);
    }
  }
};
