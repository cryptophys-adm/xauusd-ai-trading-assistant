// CL1 PR1 (2026-11-28): the Claude Haiku 5.5 shadow (src/claude-shadow.mjs). No network: an in-memory SQLite D1, a KV stub,
// and the real Anthropic SDK client with an injected fetch (the request it would send is checked, the answer is canned).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Anthropic from "@anthropic-ai/sdk";
import {
  CLAUDE_MODEL, CLAUDE_METER_MODEL, CLAUDE_DAILY_CAP_USD, CLAUDE_BREAKER_KEY, CLAUDE_ROLES, claudeShadowMode, claudeDailyCap, claudeUsdMicros,
  toClaudeRequest, claudeSchema, claudeGate, classifyClaudeError, runClaudeShadow, readClaudeShadow, resetClaudeShadowSchemaForTests
} from "../src/claude-shadow.mjs";
import { resetAiUsageSchemaCacheForTests, readAiUsage, recordAiUsage } from "../src/ai-usage.mjs";
import { FEATURE_SWITCHES } from "../src/feature-switches.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
function kv() {
  const m = new Map();
  return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } };
}
// A fake key built at runtime (never a realistic key format).
const FAKE_KEY = ["test", "only", "not", "a", "key"].join("-");
function env(over = {}) {
  resetClaudeShadowSchemaForTests(); resetAiUsageSchemaCacheForTests();
  return { DB: d1(), SIGNAL_CACHE: kv(), CLAUDE_SHADOW: "shadow", ANTHROPIC_API_KEY: FAKE_KEY, ...over };
}
const NOW = Date.parse("2026-11-30T10:15:00Z");
const MESSAGES = [{ role: "system", content: "You are the council. Answer in JSON." }, { role: "user", content: "Evidence: the bar." }];
const SCHEMA = { type: "object", additionalProperties: false, properties: { stance: { type: "string", enum: ["BUY", "SELL", "WAIT"] }, confidence: { type: "number", minimum: 0, maximum: 1 }, summary: { type: "string", maxLength: 400 }, reasons: { type: "array", items: { type: "string" }, maxItems: 5 } }, required: ["stance", "confidence", "summary", "reasons"] };
const validate = (o) => (o && ["BUY", "SELL", "WAIT"].includes(o.stance) ? { valid: true } : { valid: false, errors: ["bad_stance"] });

/** A real SDK client whose fetch records the request and answers `reply` (status, body). */
function sdkClient(reply, seen = []) {
  const fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    const r = typeof reply === "function" ? reply(seen.length) : reply;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers || {}) } });
  };
  return new Anthropic({ apiKey: FAKE_KEY, fetch, maxRetries: 0 });
}
const okMessage = (text, usage = {}) => ({
  status: 200,
  body: { id: "msg_test", type: "message", role: "assistant", model: CLAUDE_MODEL, stop_reason: "end_turn", stop_sequence: null,
    content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text }],
    usage: { input_tokens: 9000, output_tokens: 700, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0, ...usage } }
});

test("CL1-1 the request: claude-haiku-5-5, adaptive thinking at low effort, the live schema as structured output (closed, constraints removed), the system part cached", async () => {
  const e = env(), seen = [];
  const r = await runClaudeShadow(e, { role: "decision_council", candleKey: "OANDA:XAUUSD:15:1", statementClose: "2026-11-30T10:15:00Z", messages: MESSAGES, schema: SCHEMA, validate, live: { model: "@cf/openai/gpt-oss-120b", status: "ok", stance: "WAIT", latency_ms: 4200 }, clock: () => NOW, client: sdkClient(okMessage(JSON.stringify({ stance: "WAIT", confidence: 0.6, summary: "s", reasons: ["r"] })), seen) });
  assert.equal(r.status, "ok");
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /\/v1\/messages$/);
  const b = seen[0].body;
  assert.equal(b.model, "claude-haiku-5-5");
  assert.deepEqual(b.thinking, { type: "adaptive" });
  assert.equal(b.output_config.effort, "low");
  assert.equal(b.output_config.format.type, "json_schema");
  assert.equal(b.output_config.format.schema.additionalProperties, false);
  assert.equal(b.output_config.format.schema.properties.confidence.minimum, undefined, "numeric constraints are removed (the live validator still checks)");
  assert.equal(b.output_config.format.schema.properties.summary.maxLength, undefined);
  assert.equal(b.output_config.format.schema.properties.reasons.maxItems, undefined);
  assert.deepEqual(b.system, [{ type: "text", text: "You are the council. Answer in JSON.", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(b.messages, [{ role: "user", content: "Evidence: the bar." }]);
  assert.equal(b.temperature, undefined, "no sampling parameters");
  assert.equal(CLAUDE_ROLES.h1_reasoner.json, false, "the reasoner's free text is not forced into a schema");
});

test("CL1-2 the answer is read by block type (thinking first), checked by the live validator, and recorded with tokens, USD and agreement", async () => {
  const e = env();
  const reply = okMessage(JSON.stringify({ stance: "BUY", confidence: 0.7, summary: "s", reasons: ["r"] }));
  const r = await runClaudeShadow(e, { role: "war_room_conclusion", candleKey: "k1", messages: MESSAGES, schema: SCHEMA, validate, live: { stance: "WAIT", status: "ok", latency_ms: 3000 }, clock: () => NOW, client: sdkClient(reply) });
  assert.deepEqual([r.status, r.stance, r.live_stance, r.agree], ["ok", "BUY", "WAIT", 0]);
  const row = e.DB.raw.prepare("SELECT * FROM claude_shadow_outputs WHERE role = 'war_room_conclusion'").get();
  assert.deepEqual([row.model, row.thinking, row.effort, row.status, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.confidence], [CLAUDE_MODEL, "adaptive", "low", "ok", 9000, 700, 1500, 0.7]);
  // 9000 x 0.10 + 700 x 0.50 + 1500 x 0.01 micro-dollars = 900 + 350 + 15.
  assert.equal(row.usd_micros, 1265);
  const meter = e.DB.raw.prepare("SELECT * FROM ai_usage_daily").get();
  assert.deepEqual([meter.source, meter.model, meter.calls, meter.prompt_tokens, meter.completion_tokens, meter.cached_tokens, meter.usd_micros], ["claude:war_room_conclusion", CLAUDE_METER_MODEL, 1, 10500, 700, 1500, 1265]);
  // Once per role and bar.
  assert.equal((await runClaudeShadow(e, { role: "war_room_conclusion", candleKey: "k1", messages: MESSAGES, schema: SCHEMA, validate, clock: () => NOW, client: sdkClient(reply) })).status, "already_done");
  const read = await readClaudeShadow(e, { now: NOW });
  assert.equal(read.key_configured, true);
  assert.ok(!JSON.stringify(read).includes(FAKE_KEY), "the key's value is never returned");
  assert.deepEqual([read.today.usd, read.today.calls, read.by_role[0].calls, read.by_role[0].validity_rate, read.by_role[0].agreement_rate], [0.001265, 1, 1, 1, 0]);
  const usage = await readAiUsage(e.DB, { days: 1, now: NOW });
  assert.deepEqual([usage.totals[0].api_usd, usage.totals[0].unpriced_tokens], [0.001265, 0], "a paid API row is never an unpriced Workers AI row");
});

test("CL1-3 refusal, a cut-off answer and an invalid one are recorded as such; nothing is retried", async () => {
  const e = env(), seen = [];
  const refusal = { status: 200, body: { ...okMessage("").body, stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "x" }, content: [] } };
  assert.equal((await runClaudeShadow(e, { role: "decision_council", candleKey: "a", messages: MESSAGES, schema: SCHEMA, validate, clock: () => NOW, client: sdkClient(refusal, seen) })).status, "refusal");
  const cut = { status: 200, body: { ...okMessage("{\"stance\":").body, stop_reason: "max_tokens" } };
  assert.equal((await runClaudeShadow(e, { role: "decision_council", candleKey: "b", messages: MESSAGES, schema: SCHEMA, validate, clock: () => NOW, client: sdkClient(cut, seen) })).status, "invalid_output");
  const bad = okMessage(JSON.stringify({ stance: "MAYBE", confidence: 0.5, summary: "s", reasons: [] }));
  assert.equal((await runClaudeShadow(e, { role: "decision_council", candleKey: "c", messages: MESSAGES, schema: SCHEMA, validate, clock: () => NOW, client: sdkClient(bad, seen) })).status, "invalid_output");
  assert.equal(seen.length, 3, "one request per call, no retry");
  const rows = e.DB.raw.prepare("SELECT candle_key, status, errors, agree FROM claude_shadow_outputs ORDER BY candle_key").all();
  assert.deepEqual(rows.map((r) => [r.candle_key, r.status, r.agree]), [["a", "refusal", null], ["b", "invalid_output", null], ["c", "invalid_output", null]]);
  assert.equal(rows[1].errors, "answer_cut_off");
});

test("CL1-4 the gates: off by default, the shadow kill switch, no key, the breaker, the hard daily cap (never raised above USD 0.55)", async () => {
  assert.equal(claudeShadowMode({}), "off");
  assert.equal(claudeShadowMode({ CLAUDE_SHADOW: "shadow" }), "shadow");
  assert.equal(claudeDailyCap({}), CLAUDE_DAILY_CAP_USD);
  assert.equal(claudeDailyCap({ CLAUDE_SHADOW_USD_PER_DAY: "5" }), 0.55, "an env value never raises the cap");
  assert.equal(claudeDailyCap({ CLAUDE_SHADOW_USD_PER_DAY: "0.2" }), 0.2);
  const base = { enabled: true, allowed: true, hasKey: true, breaker: null, spentUsd: 0, cap: 0.55, now: NOW };
  assert.equal(claudeGate(base), null);
  assert.equal(claudeGate({ ...base, enabled: false }), "claude_shadow_off");
  assert.equal(claudeGate({ ...base, allowed: false }), "shadow_off");
  assert.equal(claudeGate({ ...base, hasKey: false }), "no_key");
  assert.equal(claudeGate({ ...base, breaker: { reason: "billing", until_ms: NOW + 1 } }), "breaker_billing");
  assert.equal(claudeGate({ ...base, breaker: { reason: "billing", until_ms: NOW - 1 } }), null, "an expired breaker lets calls through");
  assert.equal(claudeGate({ ...base, spentUsd: 0.55 }), "cap_reached");
  assert.equal(claudeGate({ ...base, spentUsd: Infinity }), "cap_reached", "an unreadable meter counts as the cap reached");
  // End to end: no fetch is made behind any closed gate.
  const seen = [];
  const off = env({ CLAUDE_SHADOW: undefined });
  assert.equal((await runClaudeShadow(off, { role: "decision_council", candleKey: "x", messages: MESSAGES, clock: () => NOW, client: sdkClient(okMessage("{}"), seen) })).status, "claude_shadow_off");
  const nokey = env({ ANTHROPIC_API_KEY: "" });
  assert.equal((await runClaudeShadow(nokey, { role: "decision_council", candleKey: "x", messages: MESSAGES, clock: () => NOW })).status, "no_key");
  const capped = env();
  await recordAiUsage(capped.DB, { source: "claude:decision_council", model: CLAUDE_METER_MODEL, prompt: 1, completion: 1, usdMicros: 550_000, now: NOW });
  const c = await runClaudeShadow(capped, { role: "decision_council", candleKey: "x", messages: MESSAGES, clock: () => NOW, client: sdkClient(okMessage("{}"), seen) });
  assert.deepEqual([c.status, c.spent_usd, c.cap_usd], ["cap_reached", 0.55, 0.55]);
  const killed = env({ SHADOW_MODE: "off" });
  assert.equal((await runClaudeShadow(killed, { role: "decision_council", candleKey: "x", messages: MESSAGES, clock: () => NOW, client: sdkClient(okMessage("{}"), seen) })).status, "shadow_off");
  assert.equal(seen.length, 0);
});

test("CL1-5 the breaker: 402 / billing and 401 / 403 until the next UTC day, 429 for an hour, three timeouts in a row for an hour", async () => {
  const err = (status, type) => ({ status, body: { type: "error", error: { type, message: "m" } } });
  for (const [status, type, reason, until] of [[402, "billing_error", "billing", Date.parse("2026-12-01T00:00:00Z")], [401, "authentication_error", "auth", Date.parse("2026-12-01T00:00:00Z")], [403, "permission_error", "auth", Date.parse("2026-12-01T00:00:00Z")], [429, "rate_limit_error", "rate_limited", NOW + 3_600_000]]) {
    const e = env(), seen = [];
    const r = await runClaudeShadow(e, { role: "decision_council", candleKey: "k", messages: MESSAGES, schema: SCHEMA, validate, clock: () => NOW, client: sdkClient(err(status, type), seen) });
    assert.equal(r.status, "agent_failed", `${status}`);
    const b = JSON.parse(e.SIGNAL_CACHE.m.get(CLAUDE_BREAKER_KEY));
    assert.deepEqual([b.reason, b.until_ms], [reason, until], `${status}`);
    assert.equal((await runClaudeShadow(e, { role: "decision_council", candleKey: "k2", messages: MESSAGES, schema: SCHEMA, validate, clock: () => NOW + 60_000, client: sdkClient(okMessage("{}"), seen) })).status, `breaker_${reason}`);
    assert.equal(seen.length, 1, "the breaker stops the next call before any request");
    assert.equal(e.DB.raw.prepare("SELECT failed FROM ai_usage_daily").get().failed, 1);
  }
  assert.deepEqual(classifyClaudeError(new Anthropic.APIConnectionTimeoutError({ message: "t" })), { outcome: "timeout", trip: null });
  const e = env();
  const timeoutClient = { messages: { create: async () => { throw new Anthropic.APIConnectionTimeoutError({ message: "timed out" }); } } };
  for (let i = 0; i < 3; i++) assert.equal((await runClaudeShadow(e, { role: "decision_council", candleKey: `t${i}`, messages: MESSAGES, clock: () => NOW + i, client: timeoutClient })).status, "timeout");
  assert.equal(JSON.parse(e.SIGNAL_CACHE.m.get(CLAUDE_BREAKER_KEY)).reason, "timeouts");
  assert.equal((await runClaudeShadow(e, { role: "decision_council", candleKey: "t4", messages: MESSAGES, clock: () => NOW + 10, client: timeoutClient })).status, "breaker_timeouts");
  assert.equal(e.DB.raw.prepare("SELECT timeouts FROM ai_usage_daily").get().timeouts, 3);
});

test("CL1-6 pure helpers: the request conversion, the schema subset, USD by card", () => {
  const req = toClaudeRequest([{ role: "system", content: "A" }, { role: "system", content: [{ type: "text", text: "B" }] }, { role: "assistant", content: "dropped: before the first user turn" }, { role: "user", content: "Q" }, { role: "assistant", content: "R" }]);
  assert.deepEqual(req.system, [{ type: "text", text: "A\n\nB", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(req.messages, [{ role: "user", content: "Q" }, { role: "assistant", content: "R" }]);
  assert.equal(toClaudeRequest([{ role: "user", content: "only" }]).system, undefined);
  const sch = claudeSchema({ type: "object", properties: { a: { type: "object", properties: { n: { type: "integer", minimum: 1 } } }, l: { type: "array", minItems: 1, items: { type: "string", minLength: 2 } } } });
  assert.deepEqual(sch, { type: "object", properties: { a: { type: "object", properties: { n: { type: "integer" } }, additionalProperties: false }, l: { type: "array", items: { type: "string" } } }, additionalProperties: false });
  assert.equal(claudeUsdMicros({ input: 50_000 }), 5_000, "USD 0.10 per million input tokens");
  assert.equal(claudeUsdMicros({ output: 1_000_000 }), 500_000, "USD 0.50 per million output tokens");
  assert.equal(claudeUsdMicros({ cacheWrite: 80_000 }), 10_000, "5-minute cache writes at 1.25x");
  assert.equal(claudeUsdMicros({ cacheRead: 80_000 }), 800, "cache reads at 0.1x");
  assert.equal(claudeUsdMicros({ input: 120_000 }), 60_000, "a prompt over 100K tokens is priced on the long card (USD 0.50 / M)");
});

test("CL1-7 the FS1 switch: CLAUDE_SHADOW, off by default, shadow or off", () => {
  const sw = FEATURE_SWITCHES.find((x) => x.key === "CLAUDE_SHADOW");
  assert.ok(sw);
  assert.deepEqual([sw.values, sw.default_value, sw.read(undefined), sw.read("shadow"), sw.read("on"), sw.read("yes")], [["shadow", "off"], "off", "off", "shadow", "shadow", "off"]);
  assert.match(sw.description, /0\.55/);
});
