/**
 * xauusd-omega (omega.cryptophys.work): the Omega Execution Engine page (owner decisions 2026-11-09:
 * a page separate from Nexus and Aether; monitor + control; its own subdomain; per-position data).
 *
 * The EA on the owner's MT5 terminal executes. Omega shows the signal, the EA's heartbeat and open
 * positions, the closed deals and their statistics, and sets the EA control: active, paused (no new
 * entries) or killed (the EA closes its positions and stops). It reads and writes only through the
 * OMEGA Service Binding to the AI Worker's OmegaGateway entrypoint (RPC, no secret, no public API).
 *
 * Security (fail closed, whether or not the edge Access policy covers the hostname yet):
 *   - every request but /health needs a valid Cloudflare Access JWT (RS256 against the team's keys,
 *     issuer, expiry, and the audience when ACCESS_AUD is set);
 *   - no /api/* route answers without ACCESS_AUD (503 audience_not_configured): without the audience
 *     only the empty page shell is served, so a JWT of another Access application never reads data;
 *   - EA data (overview, deals, whoami) is for a person only. A service token (the CI token, an
 *     external agent such as the EA's own token) reads only /api/status: the control mode and
 *     whether the EA is connected, never a position, a price or a P&L;
 *   - a change (POST /api/control) needs a person (never a service token), a same-origin request,
 *     a JSON body, a reason to pause or kill, and the typed confirmation KILL to kill. The person's
 *     Access email is the actor recorded in the audit (D1 ea_control_events).
 * Unrelated to the legacy "omega" swarm of cryptophys-cloud-platform (prohibited, never migrated):
 * Omega never signs, never places an order and holds no broker credential.
 */

const CLOCK_SKEW_SECONDS = 60;
const JWKS_TTL_MS = 10 * 60 * 1000;
const TEAM_DOMAIN = /^[a-z0-9-]+\.cloudflareaccess\.com$/;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const MODES = ["active", "paused", "killed"];
const AUD_PATTERN = /^[0-9a-f]{64}$/;

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

export async function handle(request, env, { fetchImpl = fetch, now } = {}) {
  const url = new URL(request.url);
  if (url.pathname === "/health") return json({ status: "ok", service: "xauusd-omega" });

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return json({ error: "access_denied", hint: "omega.cryptophys.work is reached through Cloudflare Access" }, 403);
  const auth = await verifyAccessJwt(token, env, { fetchImpl, now });
  if (!auth.ok) {
    console.warn(JSON.stringify({ event: "access_denied", reason: auth.reason }));
    return json({ error: "access_denied" }, auth.reason === "access_not_configured" ? 503 : 403);
  }
  const identity = auth.identity;

  if (url.pathname.startsWith("/api/")) {
    if (!AUD_PATTERN.test(String(env.ACCESS_AUD || ""))) return json({ error: "audience_not_configured", hint: "re-run the Deploy Omega workflow once Cloudflare Access covers omega.cryptophys.work" }, 503);
    if (!env.OMEGA || typeof env.OMEGA.overview !== "function") return json({ error: "omega_binding_missing" }, 503);
    if (request.method === "GET" && url.pathname === "/api/status") {
      // Any admitted identity (the deploy smoke test's CI token): no position, price or P&L.
      try {
        const o = await env.OMEGA.overview();
        return json({ status: "ok", control_mode: o?.control?.mode ?? "active", ea_connected: Boolean(o?.ea?.connected), viewer_type: identity.type });
      } catch { return json({ error: "status_unavailable" }, 502); }
    }
    if (identity.type !== "user") return json({ error: "forbidden", hint: "EA data is for a signed-in person; a service token reads /api/status only" }, 403);
    if (request.method === "GET" && url.pathname === "/api/whoami") return json({ subject: identity.subject, type: identity.type, can_control: identity.type === "user" });
    if (request.method === "GET" && url.pathname === "/api/overview") {
      try { return json({ ...(await env.OMEGA.overview()), viewer: { subject: identity.subject, type: identity.type, can_control: identity.type === "user" } }); }
      catch (error) { console.error("omega_overview_failed", String(error?.message ?? error)); return json({ error: "overview_unavailable" }, 502); }
    }
    if (request.method === "GET" && url.pathname === "/api/deals") {
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || "200") || 200));
      try { return json(await env.OMEGA.deals({ limit })); }
      catch { return json({ error: "deals_unavailable" }, 502); }
    }
    if (url.pathname === "/api/control") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      if (identity.type !== "user") return json({ error: "forbidden", hint: "a person changes the EA control, never a service token" }, 403);
      const origin = request.headers.get("origin");
      if (origin !== url.origin) return json({ error: "cross_origin_refused" }, 403);
      if (!String(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json({ error: "content_type_must_be_json" }, 415);
      let body;
      try {
        const text = await request.text();
        if (text.length > 2048) return json({ error: "body_too_large" }, 413);
        body = JSON.parse(text);
      } catch { return json({ error: "invalid_json" }, 400); }
      const req = controlRequest(body);
      if (req.error) return json({ error: req.error }, 400);
      try {
        const r = await env.OMEGA.setControl({ mode: req.mode, reason: req.reason, actor: identity.subject });
        return json(r, r?.ok ? 200 : 400);
      } catch (error) {
        console.error("omega_control_failed", String(error?.message ?? error));
        return json({ error: "control_failed" }, 502);
      }
    }
    return json({ error: "not_found" }, 404);
  }

  if (env.ASSETS && (request.method === "GET" || request.method === "HEAD")) {
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    headers.set("cache-control", "no-store");
    return new Response(res.body, { status: res.status, headers });
  }
  return json({ error: "not_found" }, 404);
}
