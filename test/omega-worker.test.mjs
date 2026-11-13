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
  const svc = await (await handle(req("/api/overview", { token: await jwt({ common_name: "ci.access" }) }), env, opts)).json();
  assert.equal(svc.viewer.can_control, false, "a service token reads only");
  assert.equal((await (await handle(req("/api/deals?limit=9999", { token: await jwt({ email: "a@b.c" }) }), env, opts)).json()).limit, 500);
  assert.equal((await handle(req("/api/overview", { token: await jwt({ email: "a@b.c" }) }), { ...ENV_BASE }, opts)).status, 503, "no binding");
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

// ---------------------------------------------------------------- phase 2: broker engine routes

function broker() {
  const calls = [];
  const rec = (name) => async (input) => { calls.push([name, input]); return { ok: true }; };
  return {
    calls,
    overview: async () => ({ signal: { side: "BUY" }, broker: { engine: {} } }),
    deals: async () => ({ deals: [] }),
    setControl: rec("setControl"), setSettings: rec("setSettings"), setConnection: rec("setConnection"), clearConnection: rec("clearConnection"), closePosition: rec("closePosition"),
    bridgeKey: async () => ({ kid: "0123456789abcdef", public_key: "AAAA", synced_age_ms: 1000 }),
    bridgeSync: async (input) => { calls.push(["bridgeSync", input]); return { ok: true, intents: [], connection: null, settings_version: 1 }; }
  };
}
const BRIDGE_ID = "4b0e7f.access";

test("the bridge sync: only the service token named by OMEGA_BRIDGE_CLIENT_ID; nobody when it is empty", async () => {
  resetKeyCacheForTests();
  const O = broker();
  const opts = { fetchImpl: certsFetch, now: NOW };
  const body = { kid: "0123456789abcdef", public_key: "AAAA", bridge_version: "1.0.0", state: { connected: true }, results: [] };
  const sync = async (claims, env) => handle(new Request("https://nexus.cryptophys.work/omega/api/bridge/sync", {
    method: "POST", body: JSON.stringify(body), headers: { "cf-access-jwt-assertion": await jwt(claims), "content-type": "application/json" }
  }), env, opts);
  const off = await sync({ common_name: BRIDGE_ID }, { ...ENV_BASE, OMEGA: O, OMEGA_BRIDGE_CLIENT_ID: "" });
  assert.deepEqual([off.status, (await off.json()).error], [403, "bridge_not_configured"]);
  const env = { ...ENV_BASE, OMEGA: O, OMEGA_BRIDGE_CLIENT_ID: BRIDGE_ID };
  assert.equal((await sync({ common_name: "someone-else.access" }, env)).status, 403, "another service token");
  assert.equal((await sync({ email: "owner@example.com" }, env)).status, 403, "a person never syncs as the bridge");
  const ok = await sync({ common_name: BRIDGE_ID }, env);
  assert.equal(ok.status, 200);
  // The Corpus Oracle's corpus (owner 2026-11-11) is forwarded as is; null when the bridge sent none.
  assert.deepEqual(O.calls.at(-1), ["bridgeSync", { state: { connected: true }, results: [], publicKey: "AAAA", kid: "0123456789abcdef", bridgeVersion: "1.0.0", corpus: null, corpusMacro: null, calendar: null }]);
  const big = new Request("https://omega.cryptophys.work/api/bridge/sync", { method: "POST", body: "x".repeat(70_000), headers: { "cf-access-jwt-assertion": await jwt({ common_name: BRIDGE_ID }) } });
  assert.equal((await handle(big, env, opts)).status, 413);
  assert.equal((await handle(req("/api/bridge/sync", { token: await jwt({ common_name: BRIDGE_ID }) }), env, opts)).status, 405);
});

test("settings and connection changes: a person, same origin, JSON; the actor is the Access email", async () => {
  resetKeyCacheForTests();
  const O = broker();
  const env = { ...ENV_BASE, OMEGA: O };
  const opts = { fetchImpl: certsFetch, now: NOW };
  const person = await jwt({ email: "Owner@Example.com" });
  const svc = await jwt({ common_name: "ci.access" });
  const call = (path, method, body, extra = {}) => handle(req(path, { token: person, method, body, ...extra }), env, opts);

  assert.equal((await call("/api/settings", "POST", { enabled: true })).status, 200);
  assert.deepEqual(O.calls.at(-1), ["setSettings", { body: { enabled: true }, actor: "owner@example.com" }]);
  assert.equal((await call("/api/connection", "POST", { server: "Monex-Demo", envelope: { v: 1 } })).status, 200);
  assert.deepEqual(O.calls.at(-1), ["setConnection", { envelope: { v: 1 }, server: "Monex-Demo", actor: "owner@example.com" }]);
  assert.equal((await call("/api/connection", "DELETE", { reason: "switch" })).status, 200);
  assert.deepEqual(O.calls.at(-1), ["clearConnection", { reason: "switch", actor: "owner@example.com" }]);
  assert.equal((await call("/api/position/close", "POST", { ticket: 109121707, reason: "manual_user_exit" })).status, 200);
  assert.deepEqual(O.calls.at(-1), ["closePosition", { ticket: 109121707, reason: "manual_user_exit", actor: "owner@example.com" }]);
  const n = O.calls.length;
  for (const [path, method, body] of [["/api/settings", "POST", { enabled: true }], ["/api/connection", "POST", { server: "S" }], ["/api/connection", "DELETE", { reason: "r" }], ["/api/position/close", "POST", { ticket: 109121707 }]]) {
    assert.equal((await handle(req(path, { token: svc, method, body }), env, opts)).status, 403, `${method} ${path}: service token`);
    assert.equal((await call(path, method, body, { origin: "https://nexus.cryptophys.work" })).status, 403, `${method} ${path}: another origin`);
    assert.equal((await call(path, method, body, { type: "text/plain" })).status, 415, `${method} ${path}: not JSON`);
  }
  assert.equal((await call("/api/settings", "POST", [1, 2])).status, 400, "an array is not a body");
  assert.equal(O.calls.length, n, "nothing refused reached the gateway");
  assert.equal((await call("/api/settings", "GET")).status, 405);
  const key = await handle(req("/api/bridge/key", { token: svc }), env, opts);
  assert.deepEqual(await key.json(), { kid: "0123456789abcdef", public_key: "AAAA", synced_age_ms: 1000 });
  assert.equal((await handle(req("/api/bridge/key", { token: person }), { ...env, OMEGA: { ...O, bridgeKey: async () => null } }, opts)).status, 404);
});

test("under nexus.cryptophys.work/omega: /omega redirects to /omega/, assets and the API keep their own paths, same-origin holds", async () => {
  resetKeyCacheForTests();
  const O = broker();
  const seen = [];
  const env = { ...ENV_BASE, OMEGA: O, ASSETS: { fetch: async (r) => { seen.push(new URL(r.url).pathname); return new Response("ok"); } } };
  const opts = { fetchImpl: certsFetch, now: NOW };
  const token = await jwt({ email: "owner@example.com" });
  const at = (path, init = {}) => new Request(`https://nexus.cryptophys.work${path}`, { ...init, headers: { "cf-access-jwt-assertion": token, ...(init.headers || {}) } });
  const redirect = await handle(at("/omega?x=1"), env, opts);
  assert.deepEqual([redirect.status, redirect.headers.get("location")], [301, "https://nexus.cryptophys.work/omega/?x=1"]);
  assert.equal((await handle(at("/omega/"), env, opts)).status, 200);
  assert.equal((await handle(at("/omega/omega.js"), env, opts)).status, 200);
  assert.deepEqual(seen, ["/", "/omega.js"]);
  assert.equal((await (await handle(at("/omega/api/overview"), env, opts)).json()).signal.side, "BUY");
  const streamRes = await handle(at("/omega/api/stream?max_ticks=2&interval_ms=250"), env, opts);
  assert.equal(streamRes.status, 200);
  assert.match(streamRes.headers.get("content-type"), /text\/event-stream/);
  const streamText = await streamRes.text();
  assert.match(streamText, /event: overview\ndata: /);
  const post = await handle(at("/omega/api/settings", { method: "POST", body: "{}", headers: { origin: "https://nexus.cryptophys.work", "content-type": "application/json" } }), env, opts);
  assert.equal(post.status, 200, "the Nexus origin is the page's origin there");
  assert.equal((await handle(new Request("https://nexus.cryptophys.work/omega/health"), env, opts)).status, 200);
});

test("the page uses relative URLs only and loads the envelope module; the broker forms exist", async () => {
  const { readFileSync } = await import("node:fs");
  const js = readFileSync(new URL("../workers/xauusd-omega/public/omega.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../workers/xauusd-omega/public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(js, /fetch\("\/|from "\//, "no absolute fetch or import");
  assert.doesNotMatch(html, /(href|src)="\//, "no absolute asset");
  assert.match(js, /from "\.\/omega-crypto\.js"/);
  for (const id of ["b-server", "b-login", "b-password", "e-enabled", "e-risk", "e-arm", "e-live"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /type="password"/);
  assert.match(js, /"b-login", "b-password"\]\) document\.getElementById\(id\)\.value = ""/, "the credentials are cleared after a submit");
});

test("the MT5 fallback switch (War Room, 2026-11-11): read when signed in; changed by a person, same origin, a reason", async () => {
  resetKeyCacheForTests();
  const calls = [];
  const O = { ...omega(), feedFallback: async () => ({ mode: "auto", active: true }), setFeedFallback: async (input) => { calls.push(input); return { ok: true, mode: input.mode, changed: true }; } };
  const env = { ...ENV_BASE, OMEGA: O };
  const opts = { fetchImpl: certsFetch, now: NOW };
  const person = await jwt({ email: "Owner@Example.com" });
  const read = await handle(req("/api/feed-fallback", { token: person }), env, opts);
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { mode: "auto", active: true, can_control: true });
  const post = (body, extra = {}) => handle(req("/api/feed-fallback", { token: person, method: "POST", body, ...extra }), env, opts);
  assert.equal((await post({ mode: "off", reason: "TradingView only" })).status, 200);
  assert.deepEqual(calls.at(-1), { mode: "off", reason: "TradingView only", actor: "owner@example.com" });
  assert.equal((await post({ mode: "off" })).status, 400, "a reason is required");
  assert.equal((await post({ mode: "on", reason: "x" })).status, 400, "auto or off only");
  assert.equal((await post({ mode: "auto", reason: "x" }, { origin: "https://evil.example" })).status, 403, "cross-origin refused");
  assert.equal((await handle(req("/api/feed-fallback", { token: await jwt({ common_name: "ci.access" }), method: "POST", body: { mode: "auto", reason: "x" } }), env, opts)).status, 403, "a service token never changes it");
  assert.equal((await handle(req("/api/feed-fallback", { token: person, method: "DELETE" }), env, opts)).status, 405);
  assert.equal((await handle(req("/api/feed-fallback"), env, opts)).status, 403, "no JWT, nothing");
  assert.equal(calls.length, 1);
});

test("the trading mode changes only by a person's same-origin POST (owner 2026-11-13), never a service token or a GET", async () => {
  resetKeyCacheForTests();
  const calls = [];
  const O = { ...omega(), setTradingMode: async (input) => { calls.push(input); return { ok: true, mode: input.mode, previous: "intraday", changed: true }; } };
  const env = { ...ENV_BASE, OMEGA: O };
  const opts = { fetchImpl: certsFetch, now: NOW };
  const person = await jwt({ email: "Owner@Example.com" });
  const post = (body, extra = {}) => handle(req("/api/trading-mode", { token: person, method: "POST", body, ...extra }), env, opts);
  const ok = await post({ mode: "Scalp" });
  assert.equal(ok.status, 200);
  assert.deepEqual(calls.at(-1), { mode: "scalp", actor: "owner@example.com" });
  assert.equal((await post({ mode: "turbo" })).status, 400);
  assert.equal((await post({ mode: "swing" }, { origin: "https://evil.example" })).status, 403, "cross-origin refused");
  assert.equal((await handle(req("/api/trading-mode", { token: await jwt({ common_name: "ci.access" }), method: "POST", body: { mode: "swing" } }), env, opts)).status, 403, "a service token never changes it");
  assert.equal((await handle(req("/api/trading-mode?mode=swing", { token: person }), env, opts)).status, 405, "a GET changes nothing");
  assert.equal(calls.length, 1);
});
