import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { pkceChallenge, extractArticles } from "../src/index.js";

const MCP = "https://mcp.example.test/mcp";
const AS = "https://auth.example.test";
class KV {
  m = new Map();
  async get(k) { return this.m.get(k) ?? null; }
  async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
}
let kv, env, calls, tokenResponses, newsHandler;
const J = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", ...h } });

beforeEach(() => {
  kv = new KV();
  env = { INGEST_SECRET: "s3", TRADINGVIEW_MCP_URL: MCP, TV_OAUTH_KV: kv, TV_SYMBOLS: "A,B", TV_NO_BACKOFF: "1" };
  calls = [];
  tokenResponses = [];
  newsHandler = (sym) => J({ jsonrpc: "2.0", id: 1, result: { structuredContent: { articles: [{ title: "T " + sym, url: "u1" }, { title: "dup", url: "u1" }] } } });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("oauth-protected-resource")) return J({ authorization_servers: [AS] });
    if (url.includes("oauth-authorization-server")) return J({ authorization_endpoint: AS + "/authorize", token_endpoint: AS + "/token", registration_endpoint: AS + "/register", token_endpoint_auth_methods_supported: ["none"] });
    if (url === AS + "/register") return J({ client_id: "cid" }, 201);
    if (url === AS + "/token") return tokenResponses.shift() || J({ error: "invalid_grant" }, 403);
    if (url === MCP) {
      const body = JSON.parse(init.body);
      if (body.method === "initialize") return J({ jsonrpc: "2.0", id: 1, result: {} }, 200, { "mcp-session-id": "sess" });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return newsHandler(body.params.arguments.symbol, init);
    }
    throw new Error("unexpected " + url);
  };
});

const req = (path, method = "GET", auth) => new Request("https://w.test" + path, { method, headers: auth ? { authorization: "Bearer " + auth } : {} });
const setTokens = (t) => kv.put("tv:tokens", JSON.stringify(t));

test("health reports TradingView MCP without secrets", async () => {
  const r = await worker.fetch(req("/health"), env);
  const b = await r.json();
  assert.equal(b.provider, "TradingView MCP");
  assert.equal(b.configured, true);
  assert.equal(b.oauth_authorized, false);
  assert.ok(!JSON.stringify(b).includes("s3"));
});

test("pull without auth is 401", async () => {
  assert.equal((await worker.fetch(req("/pull", "POST"), env)).status, 401);
  assert.equal((await worker.fetch(req("/pull", "POST", "bad"), env)).status, 401);
});

test("pull without OAuth token is safe 503", async () => {
  const r = await worker.fetch(req("/pull", "POST", "s3"), env);
  const b = await r.json();
  assert.equal(r.status, 503);
  assert.deepEqual(b.articles, []);
  assert.equal(b.available, false);
});

test("oauth flow: state, PKCE, exact redirect_uri, state single use", async () => {
  const start = await (await worker.fetch(req("/oauth/start", "GET", "s3"), env)).json();
  const u = new URL(start.authorization_url);
  assert.equal(u.searchParams.get("redirect_uri"), "https://w.test/oauth/callback");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  const state = u.searchParams.get("state");
  const verifier = JSON.parse(kv.m.get("tv:state:" + state)).verifier;
  assert.equal(u.searchParams.get("code_challenge"), await pkceChallenge(verifier));

  assert.equal((await worker.fetch(req("/oauth/callback?code=c&state=wrong"), env)).status, 400);

  tokenResponses.push(J({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }));
  const r = await worker.fetch(req("/oauth/callback?code=c&state=" + state), env);
  assert.equal(r.status, 200);
  const tok = calls.find((c) => c.url === AS + "/token");
  const form = new URLSearchParams(tok.init.body);
  assert.equal(form.get("code_verifier"), verifier);
  assert.equal(form.get("redirect_uri"), "https://w.test/oauth/callback");
  assert.equal(JSON.parse(kv.m.get("tv:tokens")).refresh_token, "RT");
  // replay of same state rejected
  assert.equal((await worker.fetch(req("/oauth/callback?code=c&state=" + state), env)).status, 400);
});

test("token exchange failure surfaces 502 without leaking secrets", async () => {
  const start = await (await worker.fetch(req("/oauth/start", "GET", "s3"), env)).json();
  const state = new URL(start.authorization_url).searchParams.get("state");
  const r = await worker.fetch(req("/oauth/callback?code=c&state=" + state), env);
  const b = await r.json();
  assert.equal(r.status, 502);
  assert.match(b.detail, /403 \(invalid_grant\)/);
});

test("expired token is refreshed", async () => {
  await setTokens({ access_token: "old", refresh_token: "RT", expires_at: Date.now() - 1000 });
  tokenResponses.push(J({ access_token: "new", expires_in: 3600 }));
  const r = await worker.fetch(req("/pull", "POST", "s3"), env);
  assert.equal(r.status, 200);
  const stored = JSON.parse(kv.m.get("tv:tokens"));
  assert.equal(stored.access_token, "new");
  assert.equal(stored.refresh_token, "RT");
  assert.equal(new URLSearchParams(calls.find((c) => c.url === AS + "/token").init.body).get("grant_type"), "refresh_token");
});

test("successful get_news returns deduplicated articles and caches", async () => {
  await setTokens({ access_token: "AT", refresh_token: "RT", expires_at: Date.now() + 3600000 });
  const r = await worker.fetch(req("/pull", "POST", "s3"), env);
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.provider, "TradingView MCP");
  assert.equal(b.count, 1);
  assert.equal(b.articles[0].url, "u1");
  const n = calls.length;
  const b2 = await (await worker.fetch(req("/pull", "POST", "s3"), env)).json();
  assert.equal(b2.cache, "hit");
  assert.equal(calls.length, n);
});

test("empty get_news result returns empty articles", async () => {
  await setTokens({ access_token: "AT", expires_at: Date.now() + 3600000 });
  newsHandler = () => J({ jsonrpc: "2.0", id: 1, result: { structuredContent: { articles: [] } } });
  const b = await (await worker.fetch(req("/pull", "POST", "s3"), env)).json();
  assert.equal(b.available, true);
  assert.deepEqual(b.articles, []);
});

test("MCP tool error is reported as unavailable, nothing fabricated", async () => {
  await setTokens({ access_token: "AT", expires_at: Date.now() + 3600000 });
  newsHandler = () => J({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "boom" }] } });
  const r = await worker.fetch(req("/pull", "POST", "s3"), env);
  const b = await r.json();
  assert.equal(r.status, 502);
  assert.equal(b.available, false);
  assert.deepEqual(b.articles, []);
});

test("429 from MCP is retried with bounded attempts then 503", async () => {
  await setTokens({ access_token: "AT", expires_at: Date.now() + 3600000 });
  let n = 0;
  newsHandler = () => { n++; return new Response("", { status: 429 }); };
  const r = await worker.fetch(req("/pull", "POST", "s3"), env);
  assert.equal(r.status, 503);
  assert.equal(n, 3);
});

test("AI Worker contract: payload exposes articles array", async () => {
  assert.equal(extractArticles({ content: [{ type: "text", text: JSON.stringify([{ title: "x" }]) }] }).length, 1);
  await setTokens({ access_token: "AT", expires_at: Date.now() + 3600000 });
  const b = await (await worker.fetch(req("/pull", "POST", "s3"), env)).json();
  assert.ok(Array.isArray(b.articles));
});
