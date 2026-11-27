// RD (2026-11-27): the text this Worker stores (the last-pull summary, served on /health) and logs never keeps a
// secret. redactDiagnosticText's patterns were written with doubled escapes, so Bearer tokens and access_token=...
// survived; it now uses sanitizeText, shared with the O5 refusal log. Fake values only, built at runtime.
import test from "node:test";
import assert from "node:assert/strict";

const mod = await import(new URL("../src/index.mjs", import.meta.url).href);
const { sanitizeText, sanitizeRefusalText } = mod;
const fake = (tag) => `${tag}${"Zq9".repeat(4)}`; // 15 characters: short enough to dodge the 32+ run rule on purpose

test("RD-1 a bearer token, credential pairs, an email and a URL with its query never survive", () => {
  const bearer = fake("bt"), access = fake("at"), refresh = fake("rt"), secret = fake("cs");
  const text = `upstream 401: Authorization: Bearer ${bearer} access_token=${access}&refresh_token="${refresh}" client_secret: ${secret} for owner@example.com at https://mcp.example/tools?code=${fake("cd")}&state=x`;
  const clean = sanitizeText(text, 400);
  for (const v of [bearer, access, refresh, secret, fake("cd")]) assert.ok(!clean.includes(v), clean);
  assert.ok(!/example\.com|https?:|\?code=/.test(clean), clean);
  assert.match(clean, /upstream 401/);
  assert.match(clean, /access_token=<redacted>/);
  assert.ok(sanitizeText("x ".repeat(400), 240).length <= 240);
  assert.equal(sanitizeRefusalText(text), sanitizeText(text, 300), "the O5 refusal log uses the same rules");
});

test("RD-2 the stored upstream diagnostic is redacted: a failing pull's summary carries no token", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\\\\s/, "no doubled escapes left in a regex literal");
  assert.match(src, /function redactDiagnosticText\(value\) \{\s*return sanitizeText\(value, 240\);/);
  assert.match(src, /error: error instanceof Error \? sanitizeText\(error\.message, 200\)/, "the scheduled catch logs a sanitized message");
  const consoleLines = src.split("\n").filter((l) => /console\.(log|warn|error|info|debug)\(/.test(l));
  assert.equal(consoleLines.length, 9, "the Worker's console lines, each reviewed in the PR");
});

test("RD-3 the public /health carries no free-text diagnostic: codes only, whatever the stored summary holds", async () => {
  const { default: worker, publicLastPull } = mod;
  const map = new Map();
  const kv = { get: async (k) => map.get(k) ?? null, put: async (k, v) => { map.set(k, String(v)); }, delete: async (k) => { map.delete(k); }, list: async () => ({ keys: [] }) };
  const upstream = `upstream says: token=${fake("tk")} see https://mcp.example/x?y=1 owner@example.com`;
  await kv.put("tv_mcp:last_scheduled_pull", JSON.stringify({ status: "error", checked_at: "2026-11-27T00:00:00.000Z", article_count: 0, symbols: ["OANDA:XAUUSD"], http_status: 502, failure_reason: "TradingView MCP get_news failed",
    failure_diagnostic: { code: "upstream_error", upstream_error_code: -32000, upstream_error_message: upstream, response_shape: ["error"] } }));
  const res = await worker.fetch(new Request("https://news.example.com/health"), { OAUTH_STORE: kv, TV_HEALTH_CACHE_SECONDS: "0" }, { waitUntil() {} });
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.last_scheduled_ingest.status, "error");
  assert.equal(body.last_scheduled_ingest.failure_code, "upstream_error");
  assert.equal(body.last_scheduled_ingest.upstream_error_code, -32000);
  assert.equal(body.last_scheduled_ingest.failure_diagnostic, undefined);
  assert.ok(!text.includes("upstream says") && !text.includes(fake("tk")) && !/example\.com/.test(text), "no free-text upstream message on the public route");
  assert.equal(publicLastPull(null), null);
  assert.equal(publicLastPull({ status: "ok", failure_diagnostic: { code: "has a space" } }).failure_code, null, "a non-code value is dropped, not served");
});
