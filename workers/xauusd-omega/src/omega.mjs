/**
 * xauusd-omega: the Omega Execution Engine page, at omega.cryptophys.work and at
 * nexus.cryptophys.work/omega (Nexus forwards /omega/* here through its OMEGA_PAGE binding).
 *
 * v1 (PR #205): the signal, the EA heartbeat and positions, the closed deals and their statistics, and
 * the EA control (active, paused, killed).
 * Phase 2 (owner decisions 2026-11-09: "Omega memegang akses broker"; the page takes the broker's
 * server, login and password; "Bridge di host ini"; "Mati sampai Anda aktifkan"): the broker engine
 * (src/omega-engine.mjs, src/omega-broker.mjs in the AI Worker) plans the trades and sizes them, and the
 * bridge on the owner's MT5 host executes them (docs/OMEGA_BRIDGE_PROTOCOL.md). The page encrypts the
 * credentials in the browser to the bridge's public key: no Worker can read the login or the password.
 * Data path: only the OMEGA Service Binding to the AI Worker's OmegaGateway entrypoint (RPC).
 *
 * Security (fail closed, whether or not the edge Access policy covers the hostname yet):
 *   - every request but /health needs a valid Cloudflare Access JWT (RS256 against the team's keys,
 *     issuer, expiry, and the audience when ACCESS_AUD is set);
 *   - a change (control, settings, connection) needs a person (never a service token), a same-origin
 *     JSON request; pause and kill need a reason, kill the typed KILL, live trading the typed LIVE.
 *     The person's Access email is the actor in the audit;
 *   - POST /api/bridge/sync accepts only the service token whose client id is OMEGA_BRIDGE_CLIENT_ID
 *     (empty: every bridge is refused).
 * Unrelated to the legacy "omega" swarm of cryptophys-cloud-platform (prohibited, never migrated).
 */

const CLOCK_SKEW_SECONDS = 60;
const JWKS_TTL_MS = 10 * 60 * 1000;
const TEAM_DOMAIN = /^[a-z0-9-]+\.cloudflareaccess\.com$/;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const MODES = ["active", "paused", "killed"];
const BRIDGE_BODY_MAX = 64 * 1024;

let jwksCache = null;
export function resetKeyCacheForTests() { jwksCache = null; }

function b64urlBytes(input) {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlJson(input) {
  try { return JSON.parse(new TextDecoder().decode(b64urlBytes(input))); } catch { return null; }
}

async function signingKeys(domain, forceRefresh, fetchImpl) {
  if (!forceRefresh && jwksCache && jwksCache.domain === domain && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetchImpl(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`access certs HTTP ${res.status}`);
  const body = await res.json();
  const keys = (body.keys ?? []).filter((k) => k.kty === "RSA");
  jwksCache = { domain, keys, fetchedAt: Date.now() };
  return keys;
}

/** Verifies a Cloudflare Access JWT. Never throws. */
export async function verifyAccessJwt(token, env, { now = Math.floor(Date.now() / 1000), fetchImpl = fetch } = {}) {
  const domain = env.ACCESS_TEAM_DOMAIN;
  if (!domain || !TEAM_DOMAIN.test(domain)) return { ok: false, reason: "access_not_configured" };
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed_token" };
  const header = b64urlJson(parts[0]), claims = b64urlJson(parts[1]);
  if (!header || !claims) return { ok: false, reason: "malformed_token" };
  if (header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "unsupported_algorithm" };
  let keys;
  try {
    keys = await signingKeys(domain, false, fetchImpl);
    if (!keys.some((k) => k.kid === header.kid)) keys = await signingKeys(domain, true, fetchImpl);
  } catch { return { ok: false, reason: "signing_keys_unavailable" }; }
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: "unknown_signing_key" };
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return { ok: false, reason: "invalid_signature" };
  } catch { return { ok: false, reason: "invalid_signature" }; }
  if (env.ACCESS_AUD) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(env.ACCESS_AUD)) return { ok: false, reason: "wrong_audience" };
  }
  if (claims.iss !== `https://${domain}`) return { ok: false, reason: "wrong_issuer" };
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < now) return { ok: false, reason: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > now) return { ok: false, reason: "not_yet_valid" };
  if (typeof claims.email === "string" && claims.email) return { ok: true, identity: { subject: claims.email.toLowerCase(), type: "user" } };
  if (typeof claims.common_name === "string" && claims.common_name) return { ok: true, identity: { subject: claims.common_name, type: "service_token" } };
  return { ok: false, reason: "no_identity" };
}

const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });

/** Security headers for every page and asset: same-origin scripts and styles only. */
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()"
};

/** Pure: validates a control change from the page. */
export function controlRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body must be a JSON object" };
  const mode = String(body.mode ?? "");
  if (!MODES.includes(mode)) return { error: `mode must be one of ${MODES.join(", ")}` };
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "";
  if (mode !== "active" && !reason) return { error: "a reason is required to pause or kill" };
  if (mode === "killed" && body.confirm !== "KILL") return { error: "type KILL to confirm" };
  return { mode, reason };
}

/** Nexus forwards nexus.cryptophys.work/omega/* here unchanged (OMEGA_PAGE binding); "/omega" alone is redirected. */
export const PATH_PREFIX = "/omega";

/** Reads a same-origin JSON body from a person; returns { body } or { response }. */
async function personJson(request, url, identity, maxBytes) {
  if (identity.type !== "user") return { response: json({ error: "forbidden", hint: "a person makes this change, never a service token" }, 403) };
  if (request.headers.get("origin") !== url.origin) return { response: json({ error: "cross_origin_refused" }, 403) };
  if (!String(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return { response: json({ error: "content_type_must_be_json" }, 415) };
  const text = await request.text();
  if (text.length > maxBytes) return { response: json({ error: "body_too_large" }, 413) };
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) return { response: json({ error: "body must be a JSON object" }, 400) };
    return { body };
  } catch { return { response: json({ error: "invalid_json" }, 400) }; }
}

async function rpc(fn, failure) {
  try {
    const r = await fn();
    return json(r, r?.ok === false ? 400 : 200);
  } catch (error) {
    console.error(failure, String(error?.message ?? error));
    return json({ error: failure }, 502);
  }
}

export async function handle(request, env, { fetchImpl = fetch, now } = {}) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "content-type, accept", "access-control-max-age": "86400" } });
  }
  if (url.pathname === PATH_PREFIX) return Response.redirect(`${url.origin}${PATH_PREFIX}/${url.search}`, 301);
  // Under the prefix the page and API keep their own paths; every link in the page is relative.
  const path = url.pathname.startsWith(`${PATH_PREFIX}/`) ? url.pathname.slice(PATH_PREFIX.length) : url.pathname;
  if (path === "/health") return json({ status: "ok", service: "xauusd-omega" });

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return json({ error: "access_denied", hint: "Omega is reached through Cloudflare Access" }, 403);
  const auth = await verifyAccessJwt(token, env, { fetchImpl, now });
  if (!auth.ok) {
    console.warn(JSON.stringify({ event: "access_denied", reason: auth.reason }));
    return json({ error: "access_denied" }, auth.reason === "access_not_configured" ? 503 : 403);
  }
  const identity = auth.identity;
  const canControl = identity.type === "user";

  if (path.startsWith("/api/")) {
    if (!env.OMEGA || typeof env.OMEGA.overview !== "function") return json({ error: "omega_binding_missing" }, 503);
    const route = `${request.method} ${path}`;

    // The host bridge (docs/OMEGA_BRIDGE_PROTOCOL.md): one Access service token, named by its client id.
    if (path === "/api/bridge/sync") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const expected = String(env.OMEGA_BRIDGE_CLIENT_ID || "");
      if (!expected) return json({ error: "bridge_not_configured" }, 403);
      if (identity.type !== "service_token" || identity.subject !== expected) return json({ error: "forbidden", hint: "only the Omega bridge's service token syncs" }, 403);
      const text = await request.text();
      if (text.length > BRIDGE_BODY_MAX) return json({ error: "body_too_large" }, 413);
      let body;
      try { body = JSON.parse(text); } catch { return json({ error: "invalid_json" }, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "body must be a JSON object" }, 400);
      return rpc(() => env.OMEGA.bridgeSync({ state: body.state ?? null, results: body.results ?? [], publicKey: body.public_key, kid: body.kid, bridgeVersion: body.bridge_version, corpus: body.corpus ?? null, corpusMacro: body.corpus_macro ?? null, calendar: body.calendar ?? null }), "sync_failed");
    }

    if (route === "GET /api/whoami") return json({ subject: identity.subject, type: identity.type, can_control: canControl });
    if (route === "GET /api/overview") {
      try { return json({ ...(await env.OMEGA.overview()), viewer: { subject: identity.subject, type: identity.type, can_control: canControl } }); }
      catch (error) { console.error("omega_overview_failed", String(error?.message ?? error)); return json({ error: "overview_unavailable" }, 502); }
    }
    if (route === "GET /api/stream") {
      const intervalMs = Math.max(250, Math.min(2000, Number(url.searchParams.get("interval_ms") || "500") || 500));
      const maxTicks = Math.max(1, Math.min(40, Number(url.searchParams.get("max_ticks") || "30") || 30));
      const viewer = { subject: identity.subject, type: identity.type, can_control: canControl };
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          let lastFp = "";
          try {
            for (let i = 0; i < maxTicks; i++) {
              if (request.signal?.aborted) break;
              try {
                const ov = await env.OMEGA.overview();
                const br = ov?.broker?.bridge || {};
                const fp = JSON.stringify([
                  br.bid,
                  br.ask,
                  br.spread_points,
                  br.balance,
                  br.equity,
                  br.terminal_connected,
                  (br.positions || []).map((p) => [p.ticket, p.profit, p.sl, p.tp]),
                  ov?.signal?.signal_id,
                  ov?.control?.mode,
                  ov?.broker?.engine?.enabled,
                  ov?.broker?.engine?.settings_version,
                  ov?.broker?.connection?.version,
                  ov?.broker?.intents?.[0]?.id,
                  ov?.broker?.intents?.[0]?.status,
                ]);
                if (i === 0 || fp !== lastFp || i % 6 === 0) {
                  lastFp = fp;
                  controller.enqueue(enc.encode(`event: overview\ndata: ${JSON.stringify({ ...ov, viewer })}\n\n`));
                } else {
                  controller.enqueue(enc.encode(`: keepalive\n\n`));
                }
              } catch {
                controller.enqueue(enc.encode(`event: error\ndata: {"error":"overview_unavailable"}\n\n`));
              }
              if (i + 1 < maxTicks && !request.signal?.aborted) {
                await new Promise((r) => setTimeout(r, intervalMs));
              }
            }
          } finally {
            try { controller.close(); } catch { /* already closed */ }
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (route === "GET /api/deals") {
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || "200") || 200));
      try { return json(await env.OMEGA.deals({ limit })); }
      catch { return json({ error: "deals_unavailable" }, 502); }
    }
    if (route === "GET /api/bridge/key") {
      try {
        const key = await env.OMEGA.bridgeKey();
        return key ? json(key) : json({ error: "bridge_not_seen", hint: "start the Omega bridge on the MT5 host first" }, 404);
      } catch { return json({ error: "bridge_unavailable" }, 502); }
    }
    if (route === "POST /api/control") {
      const r = await personJson(request, url, identity, 2048);
      if (r.response) return r.response;
      const req = controlRequest(r.body);
      if (req.error) return json({ error: req.error }, 400);
      return rpc(() => env.OMEGA.setControl({ mode: req.mode, reason: req.reason, actor: identity.subject }), "control_failed");
    }
    if (route === "POST /api/settings") {
      const r = await personJson(request, url, identity, 2048);
      if (r.response) return r.response;
      return rpc(() => env.OMEGA.setSettings({ body: r.body, actor: identity.subject }), "settings_failed");
    }
    if (route === "POST /api/connection") {
      const r = await personJson(request, url, identity, 16384);
      if (r.response) return r.response;
      return rpc(() => env.OMEGA.setConnection({ envelope: r.body.envelope, server: r.body.server, actor: identity.subject }), "connection_failed");
    }
    if (request.method === "GET" && path === "/api/connection" && url.searchParams.get("disconnect") === "1") {
      const reason = (url.searchParams.get("reason") || "disconnect requested from omega page").slice(0, 200);
      return rpc(() => env.OMEGA.clearConnection({ reason, actor: identity.subject }), "connection_failed");
    }
    if (route === "DELETE /api/connection") {
      const r = await personJson(request, url, identity, 2048);
      if (r.response) return r.response;
      return rpc(() => env.OMEGA.clearConnection({ reason: r.body.reason, actor: identity.subject }), "connection_failed");
    }
    // The MT5 fallback switch (owner 2026-11-11): read by anyone signed in, changed by a person with a reason.
    if (route === "GET /api/feed-fallback") {
      if (typeof env.OMEGA.feedFallback !== "function") return json({ error: "feed_fallback_unavailable" }, 503);
      return rpc(async () => ({ ...(await env.OMEGA.feedFallback()), can_control: canControl }), "feed_fallback_failed");
    }
    if (route === "POST /api/feed-fallback") {
      const r = await personJson(request, url, identity, 2048);
      if (r.response) return r.response;
      const mode = typeof r.body.mode === "string" ? r.body.mode : "";
      const reason = typeof r.body.reason === "string" ? r.body.reason.trim().slice(0, 200) : "";
      if (mode !== "auto" && mode !== "off") return json({ error: "mode must be auto or off" }, 400);
      if (!reason) return json({ error: "a reason is required" }, 400);
      return rpc(() => env.OMEGA.setFeedFallback({ mode, reason, actor: identity.subject }), "feed_fallback_failed");
    }
    // The shadow kill switch (owner 2026-11-14): read by anyone signed in, changed by a person with a reason.
    if (route === "GET /api/shadow-mode") {
      if (typeof env.OMEGA.shadowMode !== "function") return json({ error: "shadow_mode_unavailable" }, 503);
      return rpc(async () => ({ ...(await env.OMEGA.shadowMode()), can_control: canControl }), "shadow_mode_failed");
    }
    if (route === "POST /api/shadow-mode") {
      const r = await personJson(request, url, identity, 2048);
      if (r.response) return r.response;
      const mode = typeof r.body.mode === "string" ? r.body.mode : "";
      const reason = typeof r.body.reason === "string" ? r.body.reason.trim().slice(0, 200) : "";
      if (mode !== "on" && mode !== "off") return json({ error: "mode must be on or off" }, 400);
      if (!reason) return json({ error: "a reason is required" }, 400);
      if (typeof env.OMEGA.setShadowMode !== "function") return json({ error: "shadow_mode_unavailable" }, 503);
      return rpc(() => env.OMEGA.setShadowMode({ mode, reason, actor: identity.subject }), "shadow_mode_failed");
    }
    if (route === "POST /api/trading-mode") {
      // Owner 2026-11-13: the trading mode changes only here (a person, same origin), never by a GET.
      const r = await personJson(request, url, identity, 1024);
      if (r.response) return r.response;
      const mode = typeof r.body.mode === "string" ? r.body.mode.trim().toLowerCase() : "";
      if (!["scalp", "intraday", "swing"].includes(mode)) return json({ error: "mode must be scalp, intraday or swing" }, 400);
      if (typeof env.OMEGA.setTradingMode !== "function") return json({ error: "trading_mode_unavailable" }, 503);
      return rpc(() => env.OMEGA.setTradingMode({ mode, actor: identity.subject }), "trading_mode_failed");
    }
    if (route === "POST /api/position/close") {
      const r = await personJson(request, url, identity, 2048);
      if (r.response) return r.response;
      const ticket = Number(r.body?.ticket);
      if (!Number.isFinite(ticket) || ticket <= 0) return json({ error: "invalid_ticket" }, 400);
      return rpc(() => env.OMEGA.closePosition({ ticket, reason: r.body?.reason, actor: identity.subject }), "close_position_failed");
    }
    if (["/api/control", "/api/settings", "/api/connection", "/api/bridge/key", "/api/overview", "/api/stream", "/api/deals", "/api/whoami", "/api/position/close", "/api/feed-fallback", "/api/trading-mode", "/api/shadow-mode"].includes(path)) return json({ error: "method_not_allowed" }, 405);
    return json({ error: "not_found" }, 404);
  }

  if (env.ASSETS && (request.method === "GET" || request.method === "HEAD")) {
    const assetUrl = new URL(url);
    assetUrl.pathname = path;
    const res = await env.ASSETS.fetch(path === url.pathname ? request : new Request(assetUrl.toString(), { method: request.method, headers: request.headers }));
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    headers.set("cache-control", "no-store");
    return new Response(res.body, { status: res.status, headers });
  }
  return json({ error: "not_found" }, 404);
}
