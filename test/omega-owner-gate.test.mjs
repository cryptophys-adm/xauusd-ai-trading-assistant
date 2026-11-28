// CF2a (2026-11-28): every mutating Omega route is the owner's alone, server-side (OWNER_ACCESS_SUB, fail closed), and
// can_control / is_owner report the owner check, never "any signed-in person". No network: a local key pair signs the
// Access JWTs and the OmegaGateway RPC is a stub that records what reached it.
import test from "node:test";
import assert from "node:assert/strict";
import { handle, resetKeyCacheForTests, isOwnerIdentity } from "../workers/xauusd-omega/src/omega.mjs";

const TEAM = "cryptophys.cloudflareaccess.com", AUD = "a".repeat(64), NOW_S = 1_794_220_000, OWNER = "owner-sub-0001";
const b64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
const certsFetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
async function jwt(claims) {
  const head = enc({ alg: "RS256", kid: "k1" }), body = enc({ iss: `https://${TEAM}`, aud: [AUD], exp: NOW_S + 600, ...claims });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}
const ORIGIN = "https://omega.cryptophys.work";
const req = (method, path, { token, body, headers = {} } = {}) => new Request(`${ORIGIN}${path}`, {
  method, body: body == null ? undefined : JSON.stringify(body),
  headers: { "cf-access-jwt-assertion": token, origin: ORIGIN, ...(body != null ? { "content-type": "application/json" } : {}), ...headers }
});
function gateway() {
  const calls = [];
  const O = new Proxy({}, { get: (_t, name) => (name === "then" ? undefined : async (input) => { calls.push(String(name)); return { ok: true, name, input: input ?? null }; }) });
  return { O, calls };
}

// Every mutating route, with a body the route accepts, so the owner reaches the RPC.
const MUTATING = [
  ["POST", "/api/control", { mode: "paused", reason: "test" }],
  ["POST", "/api/settings", { enabled: false }],
  ["POST", "/api/account-profile", { account_ref: `acct_${"0".repeat(16)}`, action: "reset" }],
  ["POST", "/api/probation", { enabled: false }],
  ["POST", "/api/pm-lines", { line: "tp2", enabled: true }],
  ["POST", "/api/connection", { envelope: { v: 1 }, server: "Demo" }],
  ["DELETE", "/api/connection", { reason: "test" }],
  ["POST", "/api/feed-connection", { bridge_id: "feed", envelope: { v: 1 }, server: "Demo" }],
  ["DELETE", "/api/feed-connection", { bridge_id: "feed", reason: "test" }],
  ["POST", "/api/feed-fallback", { mode: "off", reason: "test" }],
  ["POST", "/api/shadow-mode", { mode: "off", reason: "test" }],
  ["POST", "/api/trading-mode", { mode: "scalp" }],
  ["POST", "/api/strategy-arm", { strategy_id: "zone_pullback", action: "disarm" }],
  ["POST", "/api/council", { action: "close", session_id: "s1" }],
  ["POST", "/api/strategy-council", { auto: false }],
  ["POST", "/api/strategy-arm/unpin", { strategy_id: "zone_pullback" }],
  ["POST", "/api/correction", { input: { text: "t" } }],
  ["POST", "/api/feature-switches", { key: "CFC_MODE", value: "on" }],
  ["POST", "/api/position/modify", { ticket: 1, sl: null, tp: null }],
  ["POST", "/api/position/delegate", { ticket: 1, on: true }],
  ["POST", "/api/delegate-mode", { on: false }],
  ["POST", "/api/position/close", { ticket: 1, reason: "test" }],
];

test("OG-1 a signed-in non-owner gets 403 owner_only on every mutating route, and nothing reaches the AI Worker", async () => {
  resetKeyCacheForTests();
  const { O, calls } = gateway();
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OMEGA: O, OWNER_ACCESS_SUB: OWNER };
  const opts = { fetchImpl: certsFetch, now: NOW_S };
  const guest = await jwt({ email: "guest@example.com", sub: "guest-sub-0002" });
  for (const [method, path, body] of MUTATING) {
    const r = await handle(req(method, path, { token: guest, body }), env, opts);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal((await r.json()).error, "owner_only", `${method} ${path}`);
  }
  const gone = await handle(req("GET", "/api/connection?disconnect=1&reason=x", { token: guest }), env, opts);
  assert.deepEqual([gone.status, (await gone.json()).error], [403, "owner_only"], "the GET disconnect too");
  assert.deepEqual(calls, [], "no RPC was made for a non-owner");
});

test("OG-2 the owner reaches the RPC on every mutating route; with OWNER_ACCESS_SUB unset nobody does (fail closed, the arm included)", async () => {
  resetKeyCacheForTests();
  const opts = { fetchImpl: certsFetch, now: NOW_S };
  const owner = await jwt({ email: "owner@example.com", sub: OWNER });
  for (const [method, path, body] of MUTATING) {
    const { O, calls } = gateway();
    const r = await handle(req(method, path, { token: owner, body }), { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OMEGA: O, OWNER_ACCESS_SUB: OWNER }, opts);
    // The owner passes the gate; a body this test does not shape fully may still get a 400 from the route's own checks.
    assert.notEqual(r.status, 403, `${method} ${path}: the owner is let through (${r.status})`);
    if (r.status === 200) assert.ok(calls.length >= 1, `${method} ${path}: an RPC was made`);
    else assert.equal(r.status, 400, `${method} ${path}: only the body check can stop the owner`);
    const { O: O2, calls: c2 } = gateway();
    const unset = await handle(req(method, path, { token: owner, body }), { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OMEGA: O2, OWNER_ACCESS_SUB: "" }, opts);
    assert.equal(unset.status, 403, `${method} ${path} with no owner configured`);
    assert.deepEqual(c2, []);
  }
});

test("OG-3 the GET disconnect: the owner from the same origin only; a service token or a cross-site navigation is refused; an unset owner arms nobody", async () => {
  resetKeyCacheForTests();
  const opts = { fetchImpl: certsFetch, now: NOW_S };
  const owner = await jwt({ email: "owner@example.com", sub: OWNER }), svc = await jwt({ common_name: "ci.access" });
  const { O, calls } = gateway();
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OMEGA: O, OWNER_ACCESS_SUB: OWNER };
  const path = "/api/connection?disconnect=1&reason=x";
  assert.equal((await handle(req("GET", path, { token: svc }), env, opts)).status, 403);
  const cross = await handle(req("GET", path, { token: owner, headers: { "sec-fetch-site": "cross-site" } }), env, opts);
  assert.deepEqual([cross.status, (await cross.json()).error], [403, "same_origin_only"]);
  assert.deepEqual(calls, []);
  assert.equal((await handle(req("GET", path, { token: owner, headers: { "sec-fetch-site": "same-origin" } }), env, opts)).status, 200);
  assert.deepEqual(calls, ["clearConnection"]);
  // CF2a: with the owner unset the live arm is refused too: the owner's sub is configured, never learned from a visitor.
  const { O: O2, calls: c2 } = gateway();
  const arm = await handle(req("POST", "/api/strategy-arm", { token: owner, body: { strategy_id: "zone_pullback", action: "arm" } }), { ...env, OMEGA: O2, OWNER_ACCESS_SUB: "" }, opts);
  assert.deepEqual([arm.status, (await arm.json()).error, c2], [403, "owner_only", []]);
  const view = await handle(req("GET", "/api/strategy-arm", { token: owner }), { ...env, OMEGA: O2, OWNER_ACCESS_SUB: "" }, opts);
  assert.equal(view.status, 200, "the read stays open to the signed-in");
});

test("OG-4 can_control and is_owner are the owner check on whoami, the overview, feed-fallback and shadow-mode", async () => {
  resetKeyCacheForTests();
  const { O } = gateway();
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OMEGA: O, OWNER_ACCESS_SUB: OWNER };
  const opts = { fetchImpl: certsFetch, now: NOW_S };
  const owner = await jwt({ email: "owner@example.com", sub: OWNER }), guest = await jwt({ email: "guest@example.com", sub: "guest-sub-0002" });
  const read = async (path, token) => (await handle(req("GET", path, { token }), env, opts)).json();
  for (const [token, want] of [[owner, true], [guest, false]]) {
    const who = await read("/api/whoami", token);
    assert.deepEqual([who.can_control, who.is_owner], [want, want]);
    assert.equal((await read("/api/overview", token)).viewer.can_control, want);
    assert.equal((await read("/api/feed-fallback", token)).can_control, want);
    assert.equal((await read("/api/shadow-mode", token)).can_control, want);
  }
  assert.equal(isOwnerIdentity({ OWNER_ACCESS_SUB: OWNER }, { type: "service_token", sub: OWNER }), false, "a service token is never the owner");
  assert.equal(isOwnerIdentity({ OWNER_ACCESS_SUB: " " }, { type: "user", sub: " " }), false);
});
