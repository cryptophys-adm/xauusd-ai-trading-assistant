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
  if (typeof claims.email === "string" && claims.email) return { ok: true, identity: { subject: claims.email.toLowerCase(), type: "user", sub: typeof claims.sub === "string" && claims.sub ? claims.sub : null } };
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
  if (path === "/health") return json({ status: "ok", service: "xauusd-omega", commit: String(env?.DEPLOY_COMMIT ?? "").slice(0, 12) || null, deployed_at: env?.DEPLOYED_AT ?? null });

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
      return rpc(() => env.OMEGA.bridgeSync({ state: body.state ?? null, results: body.results ?? [], publicKey: body.public_key, kid: body.kid, bridgeVersion: body.bridge_version, corpus: body.corpus ?? null, corpusMacro: body.corpus_macro ?? null, calendar: body.calendar ?? null, bridgeSymbol: body.bridge_symbol ?? null }), "sync_failed");
    }

    if (route === "GET /api/whoami") return json({ subject: identity.subject, type: identity.type, can_control: canControl });
    // The Nexus badge (UI audit DEF-10): connected, armed, server and open positions, from one bridge row.
    if (route === "GET /api/status") {
      if (typeof env.OMEGA.status !== "function") return json({ error: "status_unavailable" }, 503);
      return rpc(() => env.OMEGA.status(), "status_failed");
    }
    if (route === "GET /api/overview") {
      try { return json({ ...(await env.OMEGA.overview()), viewer: { subject: identity.subject, type: identity.type, can_control: canControl } }); }
      catch (error) { console.error("omega_overview_failed", String(error?.message ?? error)); return json({ error: "overview_unavailable" }, 502); }
    }
    // ADR-0015 phase 1 (owner 2026-11-14: "lanjut"): the overview pushed after each bridge sync, through the
    // Nexus push hub (cross-script binding PUSH_HUB), to identities this Worker verified above, like
    // GET /api/overview. The hub sends only this topic here; Nexus' own /api/stream never carries it.
    if (route === "GET /api/push") {
      if (!env.PUSH_HUB || typeof env.PUSH_HUB.getByName !== "function") return json({ error: "push_hub_not_configured" }, 503);
      if (String(request.headers.get("upgrade") || "").toLowerCase() !== "websocket") return json({ error: "expected_websocket" }, 426);
      const target = new URL(request.url);
      target.pathname = "/api/stream";
      target.search = "?topics=omega-overview";
      return env.PUSH_HUB.getByName("nexus").fetch(new Request(target.toString(), request));
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
      // Risk, positions, daily loss and arming: owner only, like the arm (2026-11-18, docs/RFC_ACCOUNT_PROFILES.md §9:
      // it was open to any signed-in person). Same origin; the D1 omega_events row keeps the audit.
      const r = await personJson(request, url, identity, 2048);
      if (r.response) return r.response;
      if (request.headers.get("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") return json({ error: "same_origin_only" }, 403);
      const ownerSub = String(env.OWNER_ACCESS_SUB ?? "").trim();
      if (!ownerSub || identity.sub !== ownerSub) return json({ error: "owner_only" }, 403);
      return rpc(() => env.OMEGA.setSettings({ body: r.body, actor: identity.subject }), "settings_failed");
    }
    // Account profiles (docs/RFC_ACCOUNT_PROFILES.md §10, ADR-0020 Amendment 3): the ceiling, the profile, the agent
    // mode and the agent's upgrade proposal are the owner's alone. Same origin; the AI Worker checks again and audits.
    if (route === "POST /api/account-profile") {
      const r = await personJson(request, url, identity, 1024);
      if (r.response) return r.response;
      if (request.headers.get("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") return json({ error: "same_origin_only" }, 403);
      const ownerSub = String(env.OWNER_ACCESS_SUB ?? "").trim();
      if (!ownerSub || identity.sub !== ownerSub) return json({ error: "owner_only" }, 403);
      const action = ["ceiling", "profile", "agent_mode", "accept", "decline", "reset", "reset_override"].includes(r.body.action) ? r.body.action : "";
      const ref = typeof r.body.account_ref === "string" && /^acct_[0-9a-f]{16}$/.test(r.body.account_ref) ? r.body.account_ref : "";
      if (!action || !ref) return json({ error: "account_ref and action (ceiling, profile, agent_mode, accept, decline, reset or reset_override) are required" }, 400);
      if (typeof env.OMEGA.setAccountProfile !== "function") return json({ error: "account_profile_unavailable" }, 503);
      return rpc(() => env.OMEGA.setAccountProfile({ account_ref: ref, action, value: typeof r.body.value === "string" ? r.body.value.slice(0, 20) : null, actor: identity.subject, actor_sub: identity.sub ?? null }), "account_profile_failed");
    }
    // Reversal probation (owner 2026-11-18): the owner's switch alone. Same origin; the AI Worker audits it.
    if (route === "POST /api/probation") {
      const r = await personJson(request, url, identity, 256);
      if (r.response) return r.response;
      if (request.headers.get("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") return json({ error: "same_origin_only" }, 403);
      const ownerSub = String(env.OWNER_ACCESS_SUB ?? "").trim();
      if (!ownerSub || identity.sub !== ownerSub) return json({ error: "owner_only" }, 403);
      if (typeof r.body.enabled !== "boolean") return json({ error: "enabled must be true or false" }, 400);
      if (typeof env.OMEGA.setProbation !== "function") return json({ error: "probation_unavailable" }, 503);
      return rpc(() => env.OMEGA.setProbation({ enabled: r.body.enabled, actor: identity.subject }), "probation_failed");
    }
    if (route === "POST /api/connection") {
      const r = await personJson(request, url, identity, 16384);
      if (r.response) return r.response;
      return rpc(() => env.OMEGA.setConnection({ envelope: r.body.envelope, server: r.body.server, trade_symbol: r.body.trade_symbol ?? null, units_per_usd: r.body.units_per_usd ?? null, actor: identity.subject }), "connection_failed");
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
      // Phase 4 (owner 2026-11-18): a mode pins it; action "auto" or "veto". The AI Worker checks the owner again.
      const mode = typeof r.body.mode === "string" ? r.body.mode.trim().toLowerCase() : "";
      const action = r.body.action === "auto" || r.body.action === "veto" ? r.body.action : null;
      if (!action && !["scalp", "intraday", "swing", "range"].includes(mode)) return json({ error: "mode must be scalp, intraday, swing or range, or action auto or veto" }, 400);
      if (typeof env.OMEGA.setTradingMode !== "function") return json({ error: "trading_mode_unavailable" }, 503);
      return rpc(() => env.OMEGA.setTradingMode({ mode: action ? null : mode, action, actor: identity.subject, actor_sub: identity.sub ?? null }), "trading_mode_failed");
    }
    // The strategy arm (owner 2026-11-17, ADR-0020; HAIC Q6: arm and disarm in Nexus only): the state for the Strategy
    // Agents page, and the owner's one click (a person, same origin, JSON). The AI Worker checks the rest server-side.
    if (route === "GET /api/strategy-arm") {
      if (typeof env.OMEGA.strategyArm !== "function") return json({ error: "strategy_arm_unavailable" }, 503);
      return rpc(() => env.OMEGA.strategyArm({ viewer: identity.subject, viewer_sub: identity.sub ?? null }), "strategy_arm_failed");
    }
    if (route === "POST /api/strategy-arm") {
      const r = await personJson(request, url, identity, 1024);
      if (r.response) return r.response;
      if (request.headers.get("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") return json({ error: "same_origin_only" }, 403);
      const id = typeof r.body.strategy_id === "string" ? r.body.strategy_id.trim() : "";
      const action = r.body.action === "arm" || r.body.action === "disarm" ? r.body.action : "";
      if (!id || !action) return json({ error: "strategy_id and action (arm or disarm) are required" }, 400);
      // Owner only (RFC §11.3): the Access user id must equal OWNER_ACCESS_SUB once it is set; the AI Worker checks again.
      const ownerSub = String(env.OWNER_ACCESS_SUB ?? "").trim();
      if (ownerSub && identity.sub !== ownerSub) return json({ error: "owner_only" }, 403);
      if (typeof env.OMEGA.setStrategyArm !== "function") return json({ error: "strategy_arm_unavailable" }, 503);
      return rpc(() => env.OMEGA.setStrategyArm({ strategy_id: id, action, request_id: typeof r.body.request_id === "string" ? r.body.request_id.slice(0, 64) : null,
        expected_version: Number.isFinite(Number(r.body.expected_version)) ? Number(r.body.expected_version) : null, actor: identity.subject, actor_sub: identity.sub ?? null }), "strategy_arm_failed");
    }
    // Call for Councils P2 (owner 2026-11-17): start a session, write to its seats, switch sessions. Owner only.
    if (route === "POST /api/council") {
      const r = await personJson(request, url, identity, 4096);
      if (r.response) return r.response;
      if (request.headers.get("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") return json({ error: "same_origin_only" }, 403);
      const ownerSub = String(env.OWNER_ACCESS_SUB ?? "").trim();
      if (!ownerSub || identity.sub !== ownerSub) return json({ error: "owner_only" }, 403);
      const b = r.body, action = ["start", "message", "close", "reopen", "accept", "switch"].includes(b.action) ? b.action : "";
      if (!action) return json({ error: "action must be start, message, close, reopen, accept or switch" }, 400);
      if (typeof env.OMEGA.council !== "function") return json({ error: "council_unavailable" }, 503);
      const strs = (v, n) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => x.slice(0, 40)).slice(0, n) : []);
      return rpc(() => env.OMEGA.council({ action, topic_key: typeof b.topic_key === "string" ? b.topic_key.slice(0, 120) : null, text: typeof b.text === "string" ? b.text.slice(0, 1000) : null,
        seats: strs(b.seats, 6), session_id: typeof b.session_id === "string" ? b.session_id.slice(0, 60) : null, option_id: typeof b.option_id === "string" ? b.option_id.slice(0, 40) : null, to: strs(b.to, 2), on: b.on === true, actor: identity.subject, actor_sub: identity.sub ?? null }), "council_failed");
    }
    // The owner's "Council auto-arm" toggle and unpin (owner 2026-11-17): owner only, like the arm itself.
    if (route === "POST /api/strategy-council" || route === "POST /api/strategy-arm/unpin") {
      const r = await personJson(request, url, identity, 1024);
      if (r.response) return r.response;
      if (request.headers.get("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") return json({ error: "same_origin_only" }, 403);
      const ownerSub = String(env.OWNER_ACCESS_SUB ?? "").trim();
      if (!ownerSub || identity.sub !== ownerSub) return json({ error: "owner_only" }, 403);
      if (route === "POST /api/strategy-council") {
        // SV1b (owner 2026-11-24): the owner's force of the strategy agents' veto rule on the same owner-only route
        // ("two_sided" or "classic" pins it, "auto" hands it back to AGENT_VETO_RULE and the automatic revert).
        if (typeof r.body.veto_rule === "string") {
          const rule = r.body.veto_rule.trim().toLowerCase();
          if (!["two_sided", "classic", "auto"].includes(rule)) return json({ error: "veto_rule must be two_sided, classic or auto" }, 400);
          if (typeof env.OMEGA.setAgentVetoRule !== "function") return json({ error: "strategy_council_unavailable" }, 503);
          return rpc(() => env.OMEGA.setAgentVetoRule({ rule, actor: identity.subject, actor_sub: identity.sub ?? null }), "agent_veto_failed");
        }
        if (typeof r.body.auto !== "boolean") return json({ error: "auto (true or false) is required" }, 400);
        if (typeof env.OMEGA.setCouncilAuto !== "function") return json({ error: "strategy_council_unavailable" }, 503);
        return rpc(() => env.OMEGA.setCouncilAuto({ on: r.body.auto, actor: identity.subject, actor_sub: identity.sub ?? null }), "strategy_council_failed");
      }
      const id = typeof r.body.strategy_id === "string" ? r.body.strategy_id.trim() : "";
      if (!id) return json({ error: "strategy_id is required" }, 400);
      if (typeof env.OMEGA.unpinStrategy !== "function") return json({ error: "strategy_council_unavailable" }, 503);
      return rpc(() => env.OMEGA.unpinStrategy({ strategy_id: id, actor_sub: identity.sub ?? null }), "strategy_unpin_failed");
    }
    // FS1 (owner 2026-11-25: "panel khusus pengaturan on off untuk semua fitur ini"): the owner's feature-switch panel. The
    // read is open to anyone signed in (viewer.can_control: the owner gate below and the AI Worker's own check); a change is
    // the owner's alone, a person, same origin, JSON, like the council toggle; the AI Worker checks the owner again.
    if (route === "GET /api/feature-switches") {
      if (typeof env.OMEGA.featureSwitches !== "function") return json({ error: "feature_switches_unavailable" }, 503);
      const ownerSub = String(env.OWNER_ACCESS_SUB ?? "").trim();
      const isOwner = identity.type === "user" && Boolean(ownerSub) && identity.sub === ownerSub;
      return rpc(async () => {
        const body = await env.OMEGA.featureSwitches({ viewer_sub: identity.sub ?? null });
        return { ...body, viewer: { can_control: isOwner && body?.viewer?.can_control === true } };
      }, "feature_switches_failed");
    }
    if (route === "POST /api/feature-switches") {
      const r = await personJson(request, url, identity, 2048);
      if (r.response) return r.response;
      if (request.headers.get("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") return json({ error: "same_origin_only" }, 403);
      const ownerSub = String(env.OWNER_ACCESS_SUB ?? "").trim();
      if (!ownerSub || identity.sub !== ownerSub) return json({ error: "owner_only" }, 403);
      const key = typeof r.body.key === "string" ? r.body.key.trim().slice(0, 60) : "";
      if (!key) return json({ ok: false, error: "unknown_key" }, 400);
      const reset = r.body.reset === true;
      if (!reset && !(typeof r.body.value === "string" || (Array.isArray(r.body.value) && r.body.value.length <= 10 && r.body.value.every((x) => typeof x === "string")))) return json({ ok: false, error: "invalid_value" }, 400);
      if (typeof env.OMEGA.setFeatureSwitch !== "function") return json({ error: "feature_switches_unavailable" }, 503);
      const value = reset ? null : Array.isArray(r.body.value) ? r.body.value.map((x) => x.slice(0, 40)) : r.body.value.slice(0, 200);
      return rpc(() => env.OMEGA.setFeatureSwitch({ key, value, reset, actor: identity.subject, actor_sub: identity.sub ?? null }), "feature_switch_failed");
    }
    // Human-AI interaction on the Trade tab (owner 2026-11-19): the owner's edit of a position or a pending order, and
    // delegation of manual positions to Omega. The owner alone, same origin; the AI Worker checks the live price again.
    if (route === "POST /api/position/modify" || route === "POST /api/position/delegate" || route === "POST /api/delegate-mode") {
      const r = await personJson(request, url, identity, 1024);
      if (r.response) return r.response;
      if (request.headers.get("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") return json({ error: "same_origin_only" }, 403);
      const ownerSub = String(env.OWNER_ACCESS_SUB ?? "").trim();
      if (!ownerSub || identity.sub !== ownerSub) return json({ error: "owner_only" }, 403);
      const level = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
      if (route === "POST /api/delegate-mode") {
        if (typeof r.body.on !== "boolean") return json({ error: "on must be true or false" }, 400);
        if (typeof env.OMEGA.setDelegateMode !== "function") return json({ error: "delegation_unavailable" }, 503);
        return rpc(() => env.OMEGA.setDelegateMode({ on: r.body.on, actor: identity.subject }), "delegate_mode_failed");
      }
      const ticket = Number(r.body?.ticket);
      if (!Number.isInteger(ticket) || ticket <= 0) return json({ error: "invalid_ticket" }, 400);
      if (route === "POST /api/position/delegate") {
        if (typeof r.body.on !== "boolean") return json({ error: "on must be true or false" }, 400);
        if (typeof env.OMEGA.setDelegation !== "function") return json({ error: "delegation_unavailable" }, 503);
        return rpc(() => env.OMEGA.setDelegation({ ticket, on: r.body.on, actor: identity.subject }), "delegate_failed");
      }
      const levels = [level(r.body.sl), level(r.body.tp), level(r.body.price)];
      if (levels.some((v) => v !== null && !(Number.isFinite(v) && v >= 0))) return json({ error: "sl, tp and price must be prices (or empty)" }, 400);
      if (typeof env.OMEGA.ownerModify !== "function") return json({ error: "modify_unavailable" }, 503);
      return rpc(() => env.OMEGA.ownerModify({ target: r.body.target === "order" ? "order" : "position", ticket, sl: levels[0], tp: levels[1], price: levels[2], actor: identity.subject }), "modify_failed");
    }
    if (route === "POST /api/position/close") {
      const r = await personJson(request, url, identity, 2048);
      if (r.response) return r.response;
      const ticket = Number(r.body?.ticket);
      if (!Number.isFinite(ticket) || ticket <= 0) return json({ error: "invalid_ticket" }, 400);
      return rpc(() => env.OMEGA.closePosition({ ticket, reason: r.body?.reason, actor: identity.subject }), "close_position_failed");
    }
    if (["/api/control", "/api/settings", "/api/connection", "/api/bridge/key", "/api/overview", "/api/stream", "/api/deals", "/api/whoami", "/api/position/close", "/api/position/modify", "/api/position/delegate", "/api/delegate-mode", "/api/feed-fallback", "/api/trading-mode", "/api/strategy-arm", "/api/strategy-council", "/api/strategy-arm/unpin", "/api/council", "/api/shadow-mode", "/api/push", "/api/status", "/api/account-profile", "/api/probation", "/api/feature-switches"].includes(path)) return json({ error: "method_not_allowed" }, 405);
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
