// CL1 PR2 (owner 2026-11-28, relayed verbatim: "Langsung aja 100%", "Beam → Haiku → WAI (Recommended)"): the live provider
// chain in src/provider-router.mjs. No network: an in-memory SQLite D1, a KV stub, a kernel stub, an injected fetch for
// Beam and the real Anthropic SDK client over an injected fetch. Key values are built at runtime.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import Anthropic from "@anthropic-ai/sdk";
import {
  ROUTER_GROUPS, ROUTER_SWITCHES, ROUTER_OUTPUT_CAP, ROUTER_ROLLBACK, ROUTER_ROLLBACK_KEY, ROUTER_KEEP_MS, BEAM_LIVE_LIMITS, BEAM_METER_PREFIX,
  CLAUDE_LIVE_CAP_USD, WORKERS_AI_RESERVE_MS, routerGroupOf, routerDecisionMode, routerTextMode, claudeLiveCap, schemaErrors, acceptAnswer,
  outboundBlock, outputCap, rollbackVerdicts, rollbackStands, routeLiveCall, evaluateRouterRollback, readModelRouter,
  resetProviderRouterForTests
} from "../src/provider-router.mjs";
import { MODEL_ROUTER_DEFAULTS, MODEL_ROUTER_CAPABILITIES, MODEL_ROUTER_RATE_KEY, MODEL_ROUTER_PAID_KEY, resetModelRouterForTests } from "../src/model-router.mjs";
import { CLAUDE_MODEL, CLAUDE_METER_MODEL, CLAUDE_BREAKER_KEY, resetClaudeShadowSchemaForTests } from "../src/claude-shadow.mjs";
import { resetAiUsageSchemaCacheForTests, recordAiUsage, readAiUsage } from "../src/ai-usage.mjs";
import { callBusModel, MODERATOR_DEFAULT_MODEL, MODERATOR_DEFAULT_FALLBACK_MODEL, BUS_DEFAULT_MODEL } from "../src/model-call.mjs";
import { modelRequests } from "../src/model-text.mjs";
import { switchByKey } from "../src/feature-switches.mjs";
import { councilMessages } from "../src/decision-engine.mjs";

const NOW = Date.parse("2026-11-30T10:15:00Z");
const BEAM = MODEL_ROUTER_DEFAULTS.model;
const BEAM_METER = `${BEAM_METER_PREFIX}${BEAM}`;
const KEY_A = ["fake", "beam", "value", "x1"].join("-");
const KEY_B = ["fake", "claude", "value", "x2"].join("-");
const SCHEMA = { type: "object", additionalProperties: false, required: ["stance", "confidence", "summary"], properties: { stance: { type: "string", enum: ["BUY", "SELL", "WAIT"] }, confidence: { type: ["number", "null"], minimum: 0, maximum: 1 }, summary: { type: "string", maxLength: 400 } } };
const ANSWER = { stance: "WAIT", confidence: 0.4, summary: "Decision WAIT, bias neutral: the quorum is short." };
const MESSAGES = [{ role: "system", content: "You are the council. Answer in JSON." }, { role: "user", content: "Evidence: the bar closed at 4004.4." }];

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT)");
  db.exec("CREATE TABLE engine_decisions (decision_key TEXT PRIMARY KEY, bar_close TEXT NOT NULL, stance TEXT NOT NULL, decision_json TEXT)");
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
  return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } };
}
const statusOn = { outcome: "succeeded", result: { schema: "model_router.status.v1", state: { state: "on", mode: "free_only" } } };
function kernel(answer = () => statusOn) {
  const calls = [];
  return { calls, async syscall(agent, capability, payload) { calls.push({ agent, capability, payload }); return capability === MODEL_ROUTER_CAPABILITIES.status ? answer() : { outcome: "succeeded", result: { changed: true } }; } };
}
function env(over = {}) {
  resetProviderRouterForTests(); resetModelRouterForTests(); resetClaudeShadowSchemaForTests(); resetAiUsageSchemaCacheForTests();
  return { DB: d1(), SIGNAL_CACHE: kv(), AGENTS: kernel(), ROUTER_DECISION: "on", ROUTER_TEXT: "on", REFLECTION_API_KEY: KEY_A, ANTHROPIC_API_KEY: KEY_B, ...over };
}
const beamBody = (content = JSON.stringify(ANSWER), { finish = "stop", usage = { prompt_tokens: 1200, completion_tokens: 300 } } = {}) => ({ choices: [{ message: { content }, finish_reason: finish }], usage });
const beamResponse = (body = beamBody(), { status = 200, retention = "none", headers = {} } = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(retention == null ? {} : { "reflection-data-retention": retention }), ...headers } });
function beam(respond = () => beamResponse()) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers }); const r = respond(calls.length, url, init); if (r instanceof Error) throw r; return r; };
  f.calls = calls;
  return f;
}
const claudeOk = (text = JSON.stringify(ANSWER), { stop = "end_turn", usage = { input_tokens: 900, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } = {}) => ({
  status: 200, body: { id: "msg_test", type: "message", role: "assistant", model: CLAUDE_MODEL, stop_reason: stop, stop_sequence: null, content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text }], usage }
});
function claude(reply = () => claudeOk()) {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) });
    const r = reply(seen.length);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers || {}) } });
  };
  const client = new Anthropic({ apiKey: KEY_B, fetch, maxRetries: 0 });
  client.seen = seen;
  return client;
}
const rows = (e, sql, ...a) => e.DB.raw.prepare(sql).all(...a).map((r) => ({ ...r }));
const routerRows = (e) => rows(e, "SELECT role, provider, asked, outcome, reason, tokens_in, tokens_out, usd_micros FROM router_calls ORDER BY id");
async function quiet(fn) {
  const keep = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  for (const k of Object.keys(keep)) console[k] = (...a) => lines.push(a.map(String).join(" "));
  try { return { value: await fn(), lines }; } finally { Object.assign(console, keep); }
}
const call = (e, over = {}) => quiet(() => routeLiveCall(e, { source: "decision_council", messages: MESSAGES, schema: SCHEMA, maxTokens: 6144, deadline: NOW + 90_000, clock: () => NOW, ...over })).then((r) => r.value);

// ---------------------------------------------------------------- 1. scope, switches, caps

test("PR2-1 one constant for the routed roles; the FS1 switches are off by default and emergency stops", () => {
  assert.deepEqual([...ROUTER_GROUPS.decision], ["decision_council", "war_room_conclusion", "tf_room_conclusion", "macro_room_conclusion"]);
  assert.deepEqual([...ROUTER_GROUPS.text], ["news_daily_tldr", "plain_decision"], "AU1 items 8 and 9 removed the news chain and the threads");
  for (const r of ROUTER_GROUPS.decision) assert.equal(routerGroupOf(r), "decision");
  for (const r of ROUTER_GROUPS.text) assert.equal(routerGroupOf(r), "text");
  for (const r of ["h1_reasoner", "news_analyst", "news_counselor", "news_reasoner", "thread_moderator", "war_room_opening", "war_room_rebuttal", "shadow:decision_council", "claude:decision_council", "cfc:synthesis", "position_council", "", null]) assert.equal(routerGroupOf(r), null, String(r));
  assert.deepEqual(Object.keys(ROUTER_OUTPUT_CAP).sort(), [...ROUTER_GROUPS.decision, ...ROUTER_GROUPS.text].sort(), "an output cap per routed role");
  for (const [g, key] of Object.entries(ROUTER_SWITCHES)) {
    const sw = switchByKey(key);
    assert.deepEqual([sw.default_value, sw.emergency_stop, sw.values], ["off", true, ["on", "off"]], key);
    assert.equal(g === "decision" ? routerDecisionMode({}) : routerTextMode({}), "off");
  }
  for (const raw of ["", "off", "true", "yes", "shadow"]) assert.equal(routerDecisionMode({ ROUTER_DECISION: raw }), "off", raw);
  assert.equal(routerTextMode({ ROUTER_TEXT: " ON " }), "on");
  assert.doesNotMatch(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"), /ROUTER_DECISION|ROUTER_TEXT/, "off until the owner turns it on in FS1");
  assert.deepEqual([claudeLiveCap({}), claudeLiveCap({ ROUTER_CLAUDE_USD_PER_DAY: "0.5" }), claudeLiveCap({ ROUTER_CLAUDE_USD_PER_DAY: "x" })], [CLAUDE_LIVE_CAP_USD, 0.5, 1]);
  assert.deepEqual([outputCap("decision_council", 6144, "beam"), outputCap("decision_council", 6144, "claude"), outputCap("plain_decision", 1000, "beam"), outputCap("news_daily_tldr", 4096, "beam")], [6144, 8000, 1000, 2048]);
});

// ---------------------------------------------------------------- 2. off means unchanged

test("PR2-2 off means unchanged: callBusModel sends today's Workers AI request for every routed role, with no Beam or Anthropic fetch and no router row", async () => {
  const keep = globalThis.fetch;
  const hits = [];
  globalThis.fetch = async (url) => { hits.push(String(url)); throw new Error("no network in tests"); };
  try {
    for (const source of [...ROUTER_GROUPS.decision, ...ROUTER_GROUPS.text]) {
      for (const over of [{ ROUTER_DECISION: undefined, ROUTER_TEXT: undefined }, { ROUTER_DECISION: "off", ROUTER_TEXT: "off" }]) {
        const runs = [];
        const e = env({ ...over, AI: { run: async (model, input) => { runs.push({ model, input: JSON.parse(JSON.stringify(input)) }); return { response: JSON.stringify(ANSWER), usage: { prompt_tokens: 10, completion_tokens: 5 } }; } } });
        const r = await callBusModel(e, { messages: MESSAGES, schemaName: source, schema: SCHEMA, maxTokens: 4096, effort: "low", deadline: NOW + 90_000, clock: () => NOW, runState: {}, role: "moderator" });
        assert.equal(r.status, "answered", source);
        assert.equal(r.model, MODERATOR_DEFAULT_MODEL, source);
        assert.deepEqual(runs, [{ model: MODERATOR_DEFAULT_MODEL, input: JSON.parse(JSON.stringify(modelRequests(MODERATOR_DEFAULT_MODEL, { messages: MESSAGES, maxTokens: 4096, effort: "low", schemaName: source, schema: SCHEMA })[0])) }], `${source}: today's request, byte for byte`);
        assert.equal(rows(e, "SELECT name FROM sqlite_master WHERE name = 'router_calls'").length, 0, "no router table");
        assert.equal(e.AGENTS.calls.length, 0, "no kernel call");
      }
    }
    // A role that is not routed never asks the router, even with both switches on.
    const runs = [];
    const e = env({ AI: { run: async (model) => { runs.push(model); return { response: JSON.stringify(ANSWER) }; } } });
    await callBusModel(e, { messages: MESSAGES, schemaName: "war_room_opening", schema: SCHEMA, maxTokens: 1000, effort: "low", deadline: NOW + 90_000, clock: () => NOW, runState: {}, role: "agent" });
    assert.deepEqual(runs, [BUS_DEFAULT_MODEL]);
  } finally { globalThis.fetch = keep; }
  assert.deepEqual(hits, [], "no fetch at all");
  // aiRun (src/index.ts, the news chain AU1 item 9 removes) never routes; the router returns at once when off.
  const idx = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const aiRun = idx.slice(idx.indexOf("async function aiRun("), idx.indexOf("function aiRunAs("));
  assert.doesNotMatch(aiRun, /routeLiveCall|provider-router/);
  assert.equal(await routeLiveCall(env({ ROUTER_TEXT: "off" }), { source: "plain_decision", messages: MESSAGES, fetcher: () => { throw new Error("fetched"); } }), null);
});

// ---------------------------------------------------------------- 3. Beam answers

test("PR2-3 on: Beam answers first; the same messages, the role's cap, low effort; metered as reflection:<model> and recorded without text", async () => {
  const e = env();
  const fetcher = beam();
  const r = await call(e, { fetcher, claudeClient: claude(() => { throw new Error("claude must not be asked"); }) });
  assert.deepEqual([r.provider, r.model, r.obj, r.usage], ["beam", BEAM_METER, ANSWER, { prompt: 1200, completion: 300 }]);
  assert.equal(fetcher.calls.length, 1);
  const c = fetcher.calls[0];
  assert.equal(c.url, `${MODEL_ROUTER_DEFAULTS.base}/chat/completions`);
  assert.deepEqual([c.body.model, c.body.messages, c.body.max_completion_tokens, c.body.reasoning_effort], [BEAM, MESSAGES, 6144, "low"]);
  assert.equal(c.headers.authorization, `Bearer ${KEY_A}`);
  assert.deepEqual(rows(e, "SELECT source, model, calls, prompt_tokens, completion_tokens FROM ai_usage_daily"), [{ source: "decision_council", model: BEAM_METER, calls: 1, prompt_tokens: 1200, completion_tokens: 300 }]);
  assert.deepEqual(routerRows(e), [{ role: "decision_council", provider: "beam", asked: 1, outcome: "ok", reason: null, tokens_in: 1200, tokens_out: 300, usd_micros: 0 }]);
  const cols = rows(e, "PRAGMA table_info(router_calls)").map((x) => x.name);
  assert.deepEqual(cols, ["id", "at_ms", "day", "role", "grp", "provider", "model", "asked", "outcome", "reason", "latency_ms", "tokens_in", "tokens_out", "usd_micros"], "counts, latency, tokens, USD, outcome and reason only");
  const migration = readFileSync(new URL("../migrations/0029_router_calls.sql", import.meta.url), "utf8");
  for (const col of cols) assert.match(migration, new RegExp(`\\b${col}\\b`), `the migration has ${col}`);
  // A Beam meter row is a free API row: not unpriced, no USD.
  const usage = await readAiUsage(e.DB, { days: 2, now: NOW });
  const day = usage.totals.find((d) => d.day === "2026-11-30");
  assert.deepEqual([day.calls, day.unpriced_tokens, day.api_usd, day.neurons], [1, 0, 0, 0]);
});

test("PR2-3b a routed answer the caller rejects: its retry (skipPrimary) asks Workers AI's primary, not only the fallback; then the next call routes again", async () => {
  const runs = [];
  const keep = globalThis.fetch;
  globalThis.fetch = async (url) => { if (String(url).includes("reflection")) return beamResponse(); throw new Error("no network in tests"); };
  try {
    const e = env({ ANTHROPIC_API_KEY: "", AI: { run: async (model) => { runs.push(model); return { response: JSON.stringify(ANSWER) }; } } });
    const runState = {};
    const args = { messages: MESSAGES, schemaName: "decision_council", schema: SCHEMA, maxTokens: 6144, effort: "low", deadline: Date.now() + 90_000, clock: () => Date.now(), runState, role: "moderator" };
    const first = await quiet(() => callBusModel(e, args));
    assert.deepEqual([first.value.provider, first.value.model, runs.length], ["beam", BEAM_METER, 0]);
    const retry = await quiet(() => callBusModel(e, { ...args, skipPrimary: "invalid_output (x)" }));
    assert.deepEqual([retry.value.model, runs], [MODERATOR_DEFAULT_MODEL, [MODERATOR_DEFAULT_MODEL]], "the primary, not only the fallback");
    assert.equal(retry.value.primary_error, null);
    // A rejected Workers AI answer's retry still skips its primary, as before.
    const again = await quiet(() => callBusModel(e, { ...args, skipPrimary: "invalid_output (y)" }));
    assert.equal(again.value.model, MODERATOR_DEFAULT_FALLBACK_MODEL);
  } finally { globalThis.fetch = keep; }
});

// ---------------------------------------------------------------- 4. each Beam failure falls through to Claude

test("PR2-4 every Beam failure goes on to Claude Haiku: timeout, 429 (held by Retry-After), 5xx, retention missing or contributor, invalid JSON or schema, cut-off, a paid sign", async () => {
  const cases = [
    ["timeout", () => Object.assign(new Error("t"), { name: "TimeoutError" })],
    ["rate_limited", () => beamResponse({ error: { message: "slow down" } }, { status: 429, headers: { "retry-after": "120" } })],
    ["http_5xx", () => beamResponse({ error: { message: "x" } }, { status: 503 })],
    ["retention_missing", () => beamResponse(beamBody(), { retention: null })],
    ["retention_contributor", () => beamResponse(beamBody(), { retention: "contributor" })],
    ["invalid_json", () => beamResponse(beamBody("not json"))],
    ["schema:summary:missing", () => beamResponse(beamBody(JSON.stringify({ stance: "WAIT", confidence: 0.4 })))],
    ["schema:stance:enum", () => beamResponse(beamBody(JSON.stringify({ ...ANSWER, stance: "HOLD" })))],
    ["cut_off", () => beamResponse(beamBody(JSON.stringify(ANSWER), { finish: "length" }))],
    ["paid_402", () => beamResponse({ error: { message: "payment required" } }, { status: 402 })]
  ];
  for (const [reason, respond] of cases) {
    const e = env();
    const cl = claude();
    const r = await call(e, { fetcher: beam(respond), claudeClient: cl });
    assert.equal(r?.provider, "claude", reason);
    assert.deepEqual(r.tried, [reason], reason);
    assert.equal(cl.seen.length, 1, reason);
    const beamRow = routerRows(e).find((x) => x.provider === "beam");
    assert.equal(beamRow.reason, reason);
    assert.ok(rows(e, "SELECT 1 FROM ai_usage_daily WHERE model = ?", BEAM_METER).length === 1, `${reason}: the Beam attempt is metered`);
    if (reason === "rate_limited") assert.equal(JSON.parse(e.SIGNAL_CACHE.m.get(MODEL_ROUTER_RATE_KEY)).until, NOW + 120_000, "Retry-After");
    if (reason === "paid_402") assert.ok(e.SIGNAL_CACHE.m.has(MODEL_ROUTER_PAID_KEY), "the paid sign is held");
  }
  // The held 429 and the paid sign stop the next call before any fetch.
  const e = env();
  await e.SIGNAL_CACHE.put(MODEL_ROUTER_RATE_KEY, JSON.stringify({ until: NOW + 60_000 }));
  const f = beam();
  const r = await call(e, { fetcher: f, claudeClient: claude() });
  assert.deepEqual([r.provider, r.tried, f.calls.length], ["claude", ["rate_limit_hold"], 0]);
  // The kernel's status other than on skips Beam.
  const off = env({ AGENTS: kernel(() => ({ outcome: "succeeded", result: { schema: "model_router.status.v1", state: { state: "off_owner", mode: "free_only" } } })) });
  const f2 = beam();
  assert.deepEqual((await call(off, { fetcher: f2, claudeClient: claude() })).tried, ["kernel_off"]);
  assert.equal(f2.calls.length, 0);
});

// ---------------------------------------------------------------- 5. Claude's request and its failures

test("PR2-5 Claude Haiku: adaptive thinking at effort low with structured output for the decision roles, thinking off for the text roles; the system block cached", async () => {
  const noBeam = { REFLECTION_API_KEY: "" };
  const e = env(noBeam);
  const cl = claude();
  const r = await call(e, { claudeClient: cl });
  assert.deepEqual([r.provider, r.model, r.obj], ["claude", CLAUDE_METER_MODEL, ANSWER]);
  const body = cl.seen[0].body;
  assert.deepEqual([body.model, body.max_tokens, body.thinking, body.output_config.effort, body.output_config.format.type], [CLAUDE_MODEL, 8000, { type: "adaptive" }, "low", "json_schema"]);
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  assert.equal(body.output_config.format.schema.properties.summary.maxLength, undefined, "unsupported constraints dropped");
  assert.deepEqual(body.system, [{ type: "text", text: MESSAGES[0].content, cache_control: { type: "ephemeral" } }], "the system prompt unchanged, cached");
  assert.deepEqual(body.messages, [{ role: "user", content: MESSAGES[1].content }]);
  const meter = rows(e, "SELECT source, model, usd_micros FROM ai_usage_daily WHERE model = ?", CLAUDE_METER_MODEL);
  assert.deepEqual(meter.map((x) => x.source), ["decision_council"], "metered under the role, not claude:<role> (the shadow's)");
  assert.ok(meter[0].usd_micros > 0);
  // A text role: thinking disabled, no effort; its schema as structured output when it has one.
  const t = env(noBeam);
  const cl2 = claude(() => claudeOk("The text in plain prose."));
  const r2 = await quiet(() => routeLiveCall(t, { source: "news_daily_tldr", messages: MESSAGES, maxTokens: 4096, clock: () => NOW, claudeClient: cl2 }));
  assert.equal(r2.value.text, "The text in plain prose.");
  assert.deepEqual([cl2.seen[0].body.thinking, cl2.seen[0].body.output_config, cl2.seen[0].body.max_tokens], [{ type: "disabled" }, undefined, 2048]);
  const t2 = env(noBeam);
  const cl3 = claude();
  await quiet(() => routeLiveCall(t2, { source: "plain_decision", messages: MESSAGES, schema: SCHEMA, maxTokens: 2048, clock: () => NOW, claudeClient: cl3 }));
  assert.deepEqual([cl3.seen[0].body.thinking, cl3.seen[0].body.output_config.effort, cl3.seen[0].body.output_config.format.type], [{ type: "disabled" }, undefined, "json_schema"]);
  // A caller's check (any role) turns a schema-valid answer away: it goes to Workers AI.
  const t3 = env(noBeam);
  const bad = await quiet(() => routeLiveCall(t3, { source: "plain_decision", messages: MESSAGES, schema: SCHEMA, check: (o) => (o.stance === "WAIT" ? "no_wait" : null), clock: () => NOW, claudeClient: claude() }));
  assert.equal(bad.value, null);
});

test("PR2-6 Claude falls through to Workers AI on refusal, max_tokens, 429 and billing; a billing error stops Claude until the next UTC day; the $1 live cap counts live rows only", async () => {
  const noBeam = { REFLECTION_API_KEY: "" };
  for (const [why, reply] of [
    ["refusal", () => claudeOk("", { stop: "refusal" })],
    ["cut_off", () => claudeOk(JSON.stringify(ANSWER), { stop: "max_tokens" })],
    ["rate_limited", () => ({ status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "x" } } })],
    ["billing", () => ({ status: 402, body: { type: "error", error: { type: "billing_error", message: "x" } } })]
  ]) {
    const e = env(noBeam);
    const r = await call(e, { claudeClient: claude(reply) });
    assert.equal(r, null, why);
    assert.equal(routerRows(e).find((x) => x.provider === "claude").reason, why);
    assert.equal(rows(e, "SELECT 1 FROM ai_usage_daily WHERE model = ?", CLAUDE_METER_MODEL).length, 1, `${why}: metered`);
    if (why === "billing") {
      const b = JSON.parse(e.SIGNAL_CACHE.m.get(CLAUDE_BREAKER_KEY));
      assert.deepEqual([b.reason, b.until_ms], ["billing", Date.parse("2026-12-01T00:00:00Z")]);
      const cl = claude();
      const again = await call(e, { claudeClient: cl });
      assert.equal(again, null);
      assert.equal(cl.seen.length, 0, "the breaker stops every Claude call");
      assert.equal(routerRows(e).at(-1).reason, "breaker_billing");
    }
  }
  // The cap: $1.00 of live spend today stops Claude; the shadow's claude:<role> rows do not count.
  const e = env(noBeam);
  await recordAiUsage(e.DB, { source: "claude:decision_council", model: CLAUDE_METER_MODEL, outcome: "ok", usdMicros: 5_000_000, now: NOW });
  const cl = claude();
  assert.equal((await call(e, { claudeClient: cl }))?.provider, "claude", "shadow spend is the shadow's own cap");
  await recordAiUsage(e.DB, { source: "war_room_conclusion", model: CLAUDE_METER_MODEL, outcome: "ok", usdMicros: 1_000_000, now: NOW });
  const cl2 = claude();
  assert.equal(await call(e, { claudeClient: cl2 }), null);
  assert.deepEqual([cl2.seen.length, routerRows(e).at(-1).reason], [0, "cap_reached"]);
});

test("PR2-7 limits: Beam's daily token share and 30 a minute; Claude's calls a minute per role; a call too close to its deadline skips both", async () => {
  const e = env();
  e.DB.raw.exec("CREATE TABLE IF NOT EXISTS router_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, day TEXT NOT NULL, role TEXT NOT NULL, grp TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, asked INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL, reason TEXT, latency_ms INTEGER, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, usd_micros INTEGER NOT NULL DEFAULT 0)");
  const ins = e.DB.raw.prepare("INSERT INTO router_calls (at_ms, day, role, grp, provider, asked, outcome, tokens_in, tokens_out) VALUES (?, '2026-11-30', 'decision_council', 'decision', ?, 1, 'ok', ?, ?)");
  ins.run(NOW - 3_600_000, "beam", BEAM_LIVE_LIMITS.tokens_in_day, 0);
  const f = beam();
  assert.deepEqual((await call(e, { fetcher: f, claudeClient: claude() })).tried, ["limit_tokens_in"]);
  assert.equal(f.calls.length, 0);
  const e2 = env();
  e2.DB.raw.exec(rows(e, "SELECT sql FROM sqlite_master WHERE name = 'router_calls'")[0].sql);
  const ins2 = e2.DB.raw.prepare("INSERT INTO router_calls (at_ms, day, role, grp, provider, asked, outcome) VALUES (?, '2026-11-30', ?, 'decision', ?, 1, 'ok')");
  for (let i = 0; i < BEAM_LIVE_LIMITS.rpm; i++) ins2.run(NOW - 10_000, "war_room_conclusion", "beam");
  for (let i = 0; i < 4; i++) ins2.run(NOW - 10_000, "decision_council", "claude");
  const f2 = beam();
  const cl = claude();
  assert.equal(await call(e2, { fetcher: f2, claudeClient: cl }), null);
  assert.deepEqual([f2.calls.length, cl.seen.length, routerRows(e2).slice(-2).map((x) => x.reason)], [0, 0, ["limit_rpm", "limit_rpm"]]);
  // The deadline: the Workers AI step keeps its reserve.
  const e3 = env();
  const f3 = beam();
  assert.equal(await call(e3, { fetcher: f3, claudeClient: claude(), deadline: NOW + WORKERS_AI_RESERVE_MS + 4_000 }), null);
  assert.deepEqual([f3.calls.length, routerRows(e3).map((x) => x.reason)], [0, ["no_time", "no_time"]]);
});

// ---------------------------------------------------------------- 6. what leaves the account

test("PR2-8 nothing account-bound leaves: a forbidden key or a secret's value blocks the call (Workers AI answers); the council's own prompt passes", async () => {
  for (const k of ["account_ref", "login", "balance", "equity", "free_margin", "lots", "position_size", "owner_email", "email", "password", "api_key", "token"]) {
    assert.equal(outboundBlock({}, [{ role: "user", content: `{"${k}": 1}` }]), `forbidden_key:${k}`, k);
  }
  assert.equal(outboundBlock({ SOME_API_KEY: KEY_A }, [{ role: "user", content: `the value ${KEY_A} inside` }]), "secret_value");
  assert.equal(outboundBlock({ MODEL_ID: "Beam-1.0-501B-A23B" }, [{ role: "user", content: "Beam-1.0-501B-A23B" }]), null, "a non-secret var is fine");
  const e = env();
  const f = beam();
  const r = await call(e, { messages: [{ role: "user", content: `{"account_ref":"acct_x"}` }], fetcher: f, claudeClient: claude() });
  assert.equal(r, null);
  assert.deepEqual([f.calls.length, routerRows(e)[0].reason], [0, "forbidden_key:account_ref"]);
  // The council's real prompt (market evidence, prices, plans) carries none of them.
  const evidence = { bar_close: "2026-11-30T10:15:00Z", witnesses: [{ key: "M15", name: "15m room", weight: 0.2, lean: 0.4, summary: "bullish" }], quorum: { bullish_share: 0.6, bearish_share: 0.2, neutral_share: 0.2, share_needed_above: 0.5 }, long: { allowed: true, checks: [], plan: { entry: 4004.4, stop: 3999, tp1: 4012 } }, short: { allowed: false, checks: [] }, context: { regime: { m15: "trend" } } };
  assert.equal(outboundBlock({ REFLECTION_API_KEY: KEY_A, ANTHROPIC_API_KEY: KEY_B }, councilMessages(evidence)), null);
});

// ---------------------------------------------------------------- 7. rollback

async function seedCalls(e, n, { role = "decision_council", provider = "beam", bad = 0, timeouts = 0, at = NOW - 3_600_000 } = {}) {
  await quiet(() => routeLiveCall(e, { source: "plain_decision", messages: MESSAGES, clock: () => NOW, fetcher: beam(() => beamResponse(beamBody("x"))), claudeClient: claude(() => claudeOk("x")) }));
  const ins = e.DB.raw.prepare("INSERT INTO router_calls (at_ms, day, role, grp, provider, asked, outcome) VALUES (?, '2026-11-30', ?, ?, ?, 1, ?)");
  for (let i = 0; i < n; i++) ins.run(at + i, role, routerGroupOf(role), provider, i < bad ? "invalid" : i < bad + timeouts ? "timeout" : "ok");
}
const flip = (e, key, ms, to = "on") => e.DB.raw.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, 'owner', 'feature_switch', ?)").run(ms, JSON.stringify({ key, from: to === "on" ? "off" : "on", to }));

test("PR2-9 rollback: validity under 95% or timeouts over 2% (20 calls or more) rolls the role's provider back, logs it and tells Telegram once", async () => {
  assert.deepEqual(rollbackVerdicts([...Array(19)].map(() => ({ role: "r", provider: "beam", asked: 1, outcome: "invalid" }))).map((v) => v.trips), [false], "under 20 calls never");
  const v = (bad, timeouts) => rollbackVerdicts([...Array(40)].map((_, i) => ({ role: "r", provider: "beam", asked: 1, outcome: i < bad ? "invalid" : i < bad + timeouts ? "timeout" : "ok" })))[0].trips;
  assert.deepEqual([v(2, 0), v(3, 0), v(0, 1), v(0, 2)], [false, true, false, true], "95.0% holds, 92.5% trips; one timeout alone never; 2 of 40 (5%) trips");
  const failed = rollbackVerdicts([...Array(40)].map((_, i) => ({ role: "r", provider: "beam", asked: 1, outcome: i < 30 ? "failed" : "ok" })))[0];
  assert.deepEqual([failed.trips, failed.validity], [false, 1], "HTTP errors and 429s are no answers: validity is over the answers");
  const e = env();
  await seedCalls(e, 40, { bad: 4 });
  const sent = [];
  const send = async (t) => { sent.push(t); };
  const r1 = await evaluateRouterRollback(e, { now: NOW, send });
  assert.deepEqual([r1.status, r1.added], ["rolled_back", ["decision_council|beam"]]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /beam is rolled back for decision_council \(validity 90%/);
  assert.equal(rows(e, "SELECT actor, action FROM omega_events WHERE action = 'router_rollback'").length, 1);
  const again = await evaluateRouterRollback(e, { now: NOW + 3_600_000, send });
  assert.deepEqual([again.status, sent.length], ["ok", 1], "one notice per rollback event");
  // While it stands, Beam is skipped for that role only.
  const f = beam();
  assert.deepEqual((await call(e, { fetcher: f, claudeClient: claude() })).tried, ["rolled_back"]);
  assert.equal(f.calls.length, 0);
  assert.equal((await call(e, { source: "war_room_conclusion", fetcher: beam(), claudeClient: claude() })).provider, "beam");
  // A failed send is told at the next check, once.
  const e2 = env();
  await seedCalls(e2, 40, { bad: 4 });
  await evaluateRouterRollback(e2, { now: NOW, send: async () => { throw new Error("telegram down"); } });
  assert.equal(JSON.parse(e2.SIGNAL_CACHE.m.get(ROUTER_ROLLBACK_KEY))["decision_council|beam"].telegram_sent_at, null);
  const later = [];
  await evaluateRouterRollback(e2, { now: NOW + 3_600_000, send: async (t) => later.push(t) });
  await evaluateRouterRollback(e2, { now: NOW + 7_200_000, send: async (t) => later.push(t) });
  assert.equal(later.length, 1);
});

test("PR2-10 re-arm: only the owner's FS1 flip to on written after rolled_back_at; an earlier flip never counts; calls before the re-arm never trip it again", async () => {
  const e = env();
  flip(e, "ROUTER_DECISION", NOW - 7_200_000);
  await seedCalls(e, 40, { bad: 4 });
  await evaluateRouterRollback(e, { now: NOW, send: async () => {} });
  const state = JSON.parse(e.SIGNAL_CACHE.m.get(ROUTER_ROLLBACK_KEY))["decision_council|beam"];
  assert.equal(rollbackStands(state, NOW - 7_200_000), true, "the flip before the rollback does not re-arm");
  assert.deepEqual((await call(e, { fetcher: beam(), claudeClient: claude() })).tried, ["rolled_back"]);
  // Another actor's row or another key's never re-arms.
  e.DB.raw.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, 'agent:x', 'feature_switch', ?)").run(NOW + 60_000, JSON.stringify({ key: "ROUTER_DECISION", to: "on" }));
  flip(e, "ROUTER_TEXT", NOW + 60_000);
  assert.deepEqual((await call(e, { fetcher: beam(), claudeClient: claude() })).tried, ["rolled_back"]);
  // The owner's flip after it re-arms; the bad calls before it are not counted again.
  flip(e, "ROUTER_DECISION", NOW + 120_000);
  assert.equal((await call(e, { fetcher: beam(), claudeClient: claude() })).provider, "beam");
  const r = await evaluateRouterRollback(e, { now: NOW + 3_600_000, send: async () => {} });
  assert.equal(r.status, "ok", "no re-trip from the calls before the re-arm");
  // New bad calls after the re-arm trip it again: a new event, a new notice.
  await seedCalls(e, 40, { bad: 4, at: NOW + 200_000 });
  const told = [];
  const r2 = await evaluateRouterRollback(e, { now: NOW + 7_200_000, send: async (t) => told.push(t) });
  assert.deepEqual([r2.status, told.length], ["rolled_back", 1]);
});

test("PR2-11 router_calls is pruned after 30 days by the hourly check; off, the check makes no rollback", async () => {
  const e = env();
  await seedCalls(e, 2, { at: NOW - ROUTER_KEEP_MS - 60_000 });
  await seedCalls(e, 2, { at: NOW - 60_000 });
  const before = rows(e, "SELECT COUNT(*) AS n FROM router_calls")[0].n;
  await evaluateRouterRollback({ ...e, ROUTER_DECISION: "off", ROUTER_TEXT: "off" }, { now: NOW });
  const after = rows(e, "SELECT COUNT(*) AS n FROM router_calls")[0].n;
  assert.equal(before - after, 2);
  assert.equal(ROUTER_KEEP_MS, 30 * 86_400_000);
  assert.equal((await evaluateRouterRollback({ ...e, ROUTER_DECISION: "off", ROUTER_TEXT: "off" }, { now: NOW })).status, "off");
});

// ---------------------------------------------------------------- 8. the read route

test("PR2-12 GET /api/model-router: per role and provider (share, validity, fallbacks, p50/p95, USD, Beam output per call), spend against caps, breaker, rollbacks, council mix", async () => {
  const e = env();
  for (let i = 0; i < 3; i++) await call(e, { fetcher: beam(), claudeClient: claude() });
  await call(e, { fetcher: beam(() => beamResponse(beamBody("x"))), claudeClient: claude() });
  e.DB.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, stance) VALUES ('a', '2026-11-30T09:00:00.000Z', 'BUY'), ('b', '2026-11-30T09:15:00.000Z', 'WAIT'), ('c', '2026-11-25T09:15:00.000Z', 'SELL')").run();
  flip(e, "ROUTER_DECISION", Date.parse("2026-11-30T00:00:00Z"));
  const out = await readModelRouter(e, { now: NOW, days: 7 });
  assert.deepEqual(out.switches, { ROUTER_DECISION: "on", ROUTER_TEXT: "on" });
  assert.deepEqual(out.chain, ["beam", "claude", "workers_ai"]);
  const b = out.by_role.find((x) => x.role === "decision_council" && x.provider === "beam");
  assert.deepEqual([b.calls, b.ok, b.invalid, b.fallbacks, b.validity_rate, b.output_per_call], [4, 3, 1, 1, 0.75, 300]);
  assert.ok("p50_latency_ms" in b && "p95_latency_ms" in b);
  const c = out.by_role.find((x) => x.role === "decision_council" && x.provider === "claude");
  assert.deepEqual([c.calls, c.ok], [1, 1]);
  assert.equal(b.share_of_routed, 0.75);
  assert.equal(out.today.resets_at, "2026-12-01T00:00:00.000Z");
  assert.deepEqual([out.today.claude.cap_usd, out.today.beam.limit_in, out.today.beam.tokens_in], [1, BEAM_LIVE_LIMITS.tokens_in_day, 4800]);
  assert.ok(out.today.claude.usd > 0);
  assert.equal(out.breaker, null);
  assert.deepEqual(out.council.today, { BUY: 1, SELL: 0, WAIT: 1 });
  assert.deepEqual(out.council.before_switch_7d, { BUY: 0, SELL: 1, WAIT: 0 });
  assert.equal(out.council.switch_on_at, "2026-11-30T00:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(out), new RegExp(`${KEY_A}|${KEY_B}|Evidence: the bar`), "no key, no prompt");
});

test("PR2-13 the schema check: required keys, types, enums, nested objects; numeric ranges are left to the caller's validator", () => {
  assert.deepEqual(schemaErrors(ANSWER, SCHEMA), []);
  assert.deepEqual(schemaErrors({ ...ANSWER, confidence: null }, SCHEMA), []);
  assert.deepEqual(schemaErrors({ ...ANSWER, confidence: 7 }, SCHEMA), [], "ranges are the validator's");
  assert.deepEqual(schemaErrors({ stance: 1 }, SCHEMA), ["confidence:missing", "summary:missing", "stance:type"]);
  assert.deepEqual(schemaErrors({ a: { b: "x" } }, { type: "object", properties: { a: { type: "object", required: ["c"], properties: { b: { type: "number" } } } } }), ["a.c:missing", "a.b:type"]);
  assert.deepEqual(acceptAnswer({ text: "```json\n" + JSON.stringify(ANSWER) + "\n```", schema: SCHEMA }).obj, ANSWER);
  assert.equal(acceptAnswer({ text: "", schema: null }).reason, "empty");
});
