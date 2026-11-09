import test from "node:test";
import assert from "node:assert/strict";
import { handle, verifyAccessJwt, controlRequest, resetKeyCacheForTests } from "../workers/xauusd-omega/src/omega.mjs";

const TEAM = "cryptophys.cloudflareaccess.com";
const AUD = "a".repeat(64);
const b64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
const certsFetch = async (url) => {
  assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
};
const NOW = 1_794_220_000;
async function jwt(claims, { key = pair.privateKey, kid = "k1" } = {}) {
  const head = enc({ alg: "RS256", kid }), body = enc({ iss: `https://${TEAM}`, aud: [AUD], exp: NOW + 600, ...claims });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}
const ENV_BASE = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

function omega() {
  const calls = [];
  return {
    calls,
    overview: async () => ({ signal: { side: "BUY" }, control: { mode: "active" } }),
    deals: async (o) => ({ deals: [], limit: o.limit }),
    setControl: async (input) => { calls.push(input); return { ok: true, control: { mode: input.mode } }; }
  };
}
const req = (path, { token, method = "GET", body, origin = "https://omega.cryptophys.work", type = "application/json" } = {}) =>
  new Request(`https://omega.cryptophys.work${path}`, {
    method, body: body == null ? undefined : JSON.stringify(body),
    headers: { ...(token ? { "cf-access-jwt-assertion": token } : {}), ...(origin ? { origin } : {}), ...(body != null ? { "content-type": type } : {}) }
  });

test("the Access JWT: signature, audience, issuer and expiry; a person or a service token", async () => {
  resetKeyCacheForTests();
  const opts = { fetchImpl: certsFetch, now: NOW };
  assert.deepEqual(await verifyAccessJwt(await jwt({ email: "Owner@Example.com" }), ENV_BASE, opts), { ok: true, identity: { subject: "owner@example.com", type: "user" } });
  assert.deepEqual((await verifyAccessJwt(await jwt({ common_name: "abc.access" }), ENV_BASE, opts)).identity, { subject: "abc.access", type: "service_token" });
  assert.equal((await verifyAccessJwt(await jwt({ email: "x@y.z" }, { key: other.privateKey }), ENV_BASE, opts)).reason, "invalid_signature");
  assert.equal((await verifyAccessJwt(await jwt({ email: "x@y.z", aud: ["b".repeat(64)] }), ENV_BASE, opts)).reason, "wrong_audience");
  assert.equal((await verifyAccessJwt(await jwt({ email: "x@y.z", iss: "https://evil.cloudflareaccess.com" }), ENV_BASE, opts)).reason, "wrong_issuer");
  assert.equal((await verifyAccessJwt(await jwt({ email: "x@y.z", exp: NOW - 120 }), ENV_BASE, opts)).reason, "expired");
  assert.equal((await verifyAccessJwt(await jwt({ email: "x@y.z" }, { kid: "nope" }), ENV_BASE, opts)).reason, "unknown_signing_key");
  assert.equal((await verifyAccessJwt("a.b", ENV_BASE, opts)).reason, "malformed_token");
  assert.equal((await verifyAccessJwt(await jwt({ email: "x@y.z" }), {}, opts)).reason, "access_not_configured");
  assert.equal((await verifyAccessJwt(await jwt({ email: "x@y.z", aud: ["anything"] }), { ACCESS_TEAM_DOMAIN: TEAM }, opts)).ok, true, "without ACCESS_AUD the audience is not checked");
});

test("every route but /health needs the JWT; reads go through the OmegaGateway binding", async () => {
  resetKeyCacheForTests();
  const O = omega();
  const env = { ...ENV_BASE, OMEGA: O };
  const opts = { fetchImpl: certsFetch, now: NOW };
  assert.equal((await handle(req("/health"), env, opts)).status, 200);
  assert.equal((await handle(req("/"), env, opts)).status, 403, "no JWT, no page (fail closed even before the edge covers the host)");
  assert.equal((await handle(req("/api/overview"), env, opts)).status, 403);
  assert.equal((await handle(req("/api/overview", { token: await jwt({ email: "a@b.c" }, { key: other.privateKey }) }), env, opts)).status, 403);
  const ok = await handle(req("/api/overview", { token: await jwt({ email: "owner@example.com" }) }), env, opts);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.signal.side, "BUY");
  assert.deepEqual(body.viewer, { subject: "owner@example.com", type: "user", can_control: true });
  const ci = await jwt({ common_name: "ci.access" });
  assert.equal((await handle(req("/api/overview", { token: ci }), env, opts)).status, 403, "a service token never reads positions or P&L");
  assert.equal((await handle(req("/api/deals", { token: ci }), env, opts)).status, 403);
  assert.equal((await handle(req("/api/whoami", { token: ci }), env, opts)).status, 403);
  const st = await handle(req("/api/status", { token: ci }), env, opts);
  assert.equal(st.status, 200);
  assert.deepEqual(await st.json(), { status: "ok", control_mode: "active", ea_connected: false, viewer_type: "service_token" }, "status: the control mode and the connection, nothing else");
  assert.equal((await (await handle(req("/api/deals?limit=9999", { token: await jwt({ email: "a@b.c" }) }), env, opts)).json()).limit, 500);
  assert.equal((await handle(req("/api/overview", { token: await jwt({ email: "a@b.c" }) }), { ...ENV_BASE }, opts)).status, 503, "no binding");
  // Without the audience, no data route answers; only the empty page shell is served.
  const noAud = { ACCESS_TEAM_DOMAIN: TEAM, OMEGA: O, ASSETS: { fetch: async () => new Response("<!doctype html>") } };
  const anyAud = await jwt({ email: "owner@example.com", aud: ["c".repeat(64)] });
  for (const path of ["/api/overview", "/api/status", "/api/deals"]) {
    const r = await handle(req(path, { token: anyAud }), noAud, opts);
    assert.equal(r.status, 503, path);
    assert.equal((await r.json()).error, "audience_not_configured");
  }
  assert.equal((await handle(req("/api/control", { token: anyAud, method: "POST", body: { mode: "paused", reason: "x" } }), noAud, opts)).status, 503);
  assert.equal((await handle(req("/", { token: anyAud }), noAud, opts)).status, 200, "the shell has no data");
});

test("a control change: a person, same origin, JSON, a reason, KILL typed; the actor is the Access email", async () => {
  resetKeyCacheForTests();
  const O = omega();
  const env = { ...ENV_BASE, OMEGA: O };
  const opts = { fetchImpl: certsFetch, now: NOW };
  const person = await jwt({ email: "Owner@Example.com" });
  const post = (body, extra = {}) => handle(req("/api/control", { token: person, method: "POST", body, ...extra }), env, opts);

  assert.equal((await post({ mode: "paused", reason: "CPI" })).status, 200);
  assert.deepEqual(O.calls.at(-1), { mode: "paused", reason: "CPI", actor: "owner@example.com" });
  assert.equal((await post({ mode: "paused" })).status, 400, "a reason is required");
  assert.equal((await post({ mode: "killed", reason: "dd" })).status, 400, "KILL must be typed");
  assert.equal((await post({ mode: "killed", reason: "dd", confirm: "KILL" })).status, 200);
  assert.equal((await post({ mode: "active" })).status, 200, "resume needs no reason");
  assert.equal((await post({ mode: "paused", reason: "x" }, { origin: "https://evil.example" })).status, 403, "cross-origin refused");
  assert.equal((await post({ mode: "paused", reason: "x" }, { origin: null })).status, 403, "no origin refused");
  assert.equal((await post({ mode: "paused", reason: "x" }, { type: "text/plain" })).status, 415);
  assert.equal((await handle(req("/api/control", { token: await jwt({ common_name: "ci.access" }), method: "POST", body: { mode: "paused", reason: "x" } }), env, opts)).status, 403, "a service token never changes the control");
  assert.equal((await handle(req("/api/control", { token: person }), env, opts)).status, 405);
  assert.equal(O.calls.length, 3);
  assert.deepEqual(controlRequest({ mode: "off" }), { error: "mode must be one of active, paused, killed" });
});

test("pages carry a strict CSP and are never cached", async () => {
  resetKeyCacheForTests();
  const env = { ...ENV_BASE, OMEGA: omega(), ASSETS: { fetch: async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) } };
  const r = await handle(req("/", { token: await jwt({ email: "a@b.c" }) }), env, { fetchImpl: certsFetch, now: NOW });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("the page script writes values as text, never as HTML", async () => {
  const { readFileSync } = await import("node:fs");
  const js = readFileSync(new URL("../workers/xauusd-omega/public/omega.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../workers/xauusd-omega/public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)/, "no inline script");
  assert.doesNotMatch(html, /style="/, "no inline style");
});
