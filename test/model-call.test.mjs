import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
// The shared model call (src/model-call.mjs, moved from the retired H1 multi-agent bus, owner 2026-11-15): the
// fallback, timeout and rate-limit rules every room, thread and council relies on, the news thread's schemas,
// validators and technical evidence. The bus runner's own tests went with it.
import {
  buildBusEvidence, callBusModel, parseModelObject,
  validateAgentOutput, validateModeratorOutput,
  BUS_DEFAULT_MODEL, BUS_DEFAULT_FALLBACK_MODEL, MODERATOR_DEFAULT_MODEL, AGENT_JSON_SCHEMA, MODERATOR_JSON_SCHEMA
} from "../src/model-call.mjs";

// D1-compatible wrapper over node:sqlite so the real SQL is exercised.
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE ai_syntheses (id INTEGER PRIMARY KEY AUTOINCREMENT, candle_key TEXT NOT NULL, ticker TEXT, timeframe TEXT, timestamp TEXT, prophet_metrics TEXT, gmi_metrics TEXT, ai_analysis TEXT, ai_model TEXT)`);
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}

const CANDLE = "OANDA:XAUUSD:60:1793779200000";
const RUN = "f".repeat(64);

function seedSynthesis(d1, decision = "WAIT") {
  const synthesis = {
    decision: { decision, confidence: null },
    evidence_fusion: {
      complete: false,
      missing_evidence: ["local_calculation:mizan", "local_calculation:prophet", "local_calculation:gmi"],
      validation_errors: [],
      local_calculations: {},
      fundamental_news_analysis: { analysis_key: "n1", analyzed_at: "2026-11-04T09:07:59Z", article_count: 2, recommendation: { stance: "WAIT_FOR_TECHNICAL_CONFIRMATION" }, evidence: { articles: [{ title: "Fed holds rates" }, { title: "Gold steady" }] } },
      informational_5m_context: { engine: "prophet_r38_5m", bias: "NEUTRAL", buy_confirmed: false, sell_confirmed: false, d_enc: 0, candle_time: "2026-11-04T09:30:00Z" }
    }
  };
  d1.raw.prepare("INSERT INTO ai_syntheses (candle_key, ticker, timeframe, prophet_metrics, gmi_metrics, ai_analysis) VALUES (?, ?, ?, ?, ?, ?)").run(
    CANDLE, "OANDA:XAUUSD", "60",
    JSON.stringify({ prophet_r38: { direction: 0, buy_confirmed: false, t_enc: 0, secret: "never" }, prophet_r37_ssot: { direction: 1, d_enc: 0, b_enc: 1 } }),
    JSON.stringify({ verdict: 0, gate: 1, gmi_dir: 0, prophet_dir: 1, conflict: false }),
    JSON.stringify(synthesis)
  );
}

function agentReply(agent, round, stance = "WAIT", extra = {}) {
  return { agent, round, stance, confidence: 0.4, insight: `${agent} r${round}: evidence degraded`, refs: ["evidence_status.missing_evidence"], responds_to: round === 1 ? null : (agent === "technical" ? "news" : "technical"), ...extra };
}
const moderatorReply = (extra = {}) => ({ stance: "WAIT", confidence: 0.5, agreed: true, summary: "Both agents prefer WAIT while evidence is degraded.", dissent: [], ...extra });

/** Fake env.AI: answers in the Chat Completions shape; records every call. */
function fakeAI(handler) {
  const calls = [];
  return {
    calls,
    run: async (model, request) => {
      calls.push({ model, request });
      const content = await handler({ model, request, n: calls.length });
      if (content instanceof Error) throw content;
      return { choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
    }
  };
}

test("schemas constrain stance and forbid extra keys", () => {
  assert.deepEqual(AGENT_JSON_SCHEMA.properties.stance.enum, ["BUY", "SELL", "WAIT"]);
  assert.deepEqual(MODERATOR_JSON_SCHEMA.properties.stance.enum, ["BUY", "SELL", "WAIT"]);
  assert.equal(AGENT_JSON_SCHEMA.additionalProperties, false);
  assert.equal(MODERATOR_JSON_SCHEMA.additionalProperties, false);
});

test("evidence is compact valid JSON, keeps lanes apart and strips unknown fields", () => {
  const d1 = fakeD1(); seedSynthesis(d1);
  const row = d1.raw.prepare("SELECT * FROM ai_syntheses").get();
  const ev = buildBusEvidence(row);
  assert.equal(ev.technical.tradingview_webhook.prophet_r38.secret, undefined);
  assert.equal(ev.technical.informational_5m_context.label, "UNVERIFIED 5m");
  assert.equal(ev.technical.local_computation.trusted_only_when, "approved_by_parity");
  assert.deepEqual(ev.news.fundamental_news.headlines, ["Fed holds rates", "Gold steady"]);
  assert.equal(ev.technical.h1_chain_decision.decision, "WAIT");
  assert.deepEqual(ev.technical.tradingview.lines.map(l => l.source), ["Prophet", "GMI v12.70"]);
  assert.match(ev.technical.tradingview.summary, /TradingView indicators/);
  assert.equal(ev.news.tradingview, undefined, "the news lane does not get the technical reading");
});

test("B2: a parity-verified 5m context reaches the bus as VERIFIED 5m, never as decision evidence", () => {
  const d1 = fakeD1(); seedSynthesis(d1);
  const row = d1.raw.prepare("SELECT * FROM ai_syntheses").get();
  const ai = JSON.parse(row.ai_analysis);
  ai.evidence_fusion.informational_5m_context.verification = { verified: true, label: "VERIFIED 5m", trust_status: "approved_by_parity", summary: "The verified 5m indicators lean bullish." };
  const ev = buildBusEvidence({ ...row, ai_analysis: JSON.stringify(ai) });
  assert.equal(ev.technical.informational_5m_context.label, "VERIFIED 5m");
  assert.equal(ev.technical.informational_5m_context.trust_status, "approved_by_parity");
  assert.match(ev.technical.informational_5m_context.reading, /verified 5m indicators/);
  assert.equal(ev.technical.h1_chain_decision.decision, "WAIT", "the chain decision is unchanged");
  ai.evidence_fusion.informational_5m_context.verification = { verified: false, label: "UNVERIFIED 5m", reason: "m5_parity_not_approved" };
  assert.equal(buildBusEvidence({ ...row, ai_analysis: JSON.stringify(ai) }).technical.informational_5m_context.label, "UNVERIFIED 5m");
});

test("validators", () => {
  assert.equal(validateAgentOutput(agentReply("technical", 1), { agent: "technical", round: 1 }).valid, true);
  assert.ok(validateAgentOutput(agentReply("technical", 1, "WAIT", { confidence: 1.5 }), { agent: "technical", round: 1 }).errors.includes("confidence_out_of_range"));
  assert.ok(validateAgentOutput(agentReply("news", 1), { agent: "technical", round: 1 }).errors.includes("agent_mismatch"));
  assert.ok(validateAgentOutput(agentReply("technical", 2, "WAIT", { responds_to: "technical" }), { agent: "technical", round: 2 }).errors.includes("responds_to_invalid"));
  assert.ok(validateAgentOutput(agentReply("technical", 1, "WAIT", { refs: [] }), { agent: "technical", round: 1 }).errors.includes("refs_missing"));
  assert.equal(validateModeratorOutput(moderatorReply()).valid, true);
  assert.ok(validateModeratorOutput(moderatorReply({ agreed: "yes" })).errors.includes("agreed_missing"));
});

test("a rate-limited call waits and retries the same model once; it never marks the primary as failed", async () => {
  const { callBusModel, isRateLimited } = await import("../src/model-call.mjs");
  assert.equal(isRateLimited(new Error("3021: rate limiting: inference request per min rate reached")), true);
  assert.equal(isRateLimited(new Error("5007: model unavailable")), false);
  // Production 2026-11-06 12:01: every opening of the 15m War Room failed with 3040; the 12:15
  // room ran normally. Capacity errors are transient like the per-minute limit.
  assert.equal(isRateLimited(new Error("3040: Capacity temporarily exceeded, please try again.")), true);
  let calls = 0;
  const ai = { run: async () => { calls += 1; if (calls === 1) throw new Error("3021: rate limiting: inference request per min rate reached"); return { choices: [{ message: { content: "{\"stance\":\"WAIT\"}" }, finish_reason: "stop" }] }; } };
  const runState = {};
  const now = Date.now();
  const r = await callBusModel({ AI: ai, MULTI_AGENT_MODEL: "m", MULTI_AGENT_FALLBACK_MODEL: "m", MODEL_RATE_LIMIT_RETRY_MS: "0" }, { messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], schemaName: "x", schema: { type: "object" }, maxTokens: 10, deadline: now + 60_000, clock: () => now, runState });
  assert.equal(r.status, "answered");
  assert.equal(calls, 2);
  assert.equal(runState.primaryError, undefined, "a transient rate limit does not demote the primary model");

  // A second rate limit, or no time left for the wait, fails the agent as before.
  let n = 0;
  const always = { run: async () => { n += 1; throw new Error("3021: rate limiting"); } };
  const failed = await callBusModel({ AI: always, MULTI_AGENT_MODEL: "m", MULTI_AGENT_FALLBACK_MODEL: "m", MODEL_RATE_LIMIT_RETRY_MS: "0" }, { messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], schemaName: "x", schema: { type: "object" }, maxTokens: 10, deadline: now + 60_000, clock: () => now, runState: {} });
  assert.equal(failed.status, "agent_failed");
  assert.equal(n, 2);
  let m = 0;
  const late = await callBusModel({ AI: { run: async () => { m += 1; throw new Error("3021: rate limiting"); } }, MULTI_AGENT_MODEL: "m", MULTI_AGENT_FALLBACK_MODEL: "m" }, { messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], schemaName: "x", schema: { type: "object" }, maxTokens: 10, deadline: now + 10_000, clock: () => now, runState: {} });
  assert.equal(late.status, "agent_failed");
  assert.equal(m, 1, "no wait when the deadline cannot hold it");
});

test("one primary timeout falls back for that step only; a second timeout in the run pins the fallback", async () => {
  // preview-e2e 2026-11-06 (#127): one glm-5.3-flash timeout sent all five news-thread steps to the
  // fallback. A timeout is transient: the next step tries the primary again.
  const { callBusModel } = await import("../src/model-call.mjs");
  const timeout = () => new Promise(() => {}); // never answers: the per-call timeout fires
  let primaryCalls = 0;
  const ai = { run: async (model) => {
    if (model === "primary") { primaryCalls += 1; if (primaryCalls <= 2 && primaryCalls !== 2) return timeout(); if (primaryCalls === 3) return timeout(); }
    return { choices: [{ message: { content: "{\"stance\":\"WAIT\"}" }, finish_reason: "stop" }] };
  } };
  let now = 0;
  const clock = () => now;
  const env = { AI: ai, MULTI_AGENT_MODEL: "primary", MULTI_AGENT_FALLBACK_MODEL: "fallback", BUS_PRIMARY_TIMEOUT_MS: "5" };
  const args = { messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], schemaName: "x", schema: { type: "object" }, maxTokens: 10, deadline: 1e12, clock };
  const runState = {};
  const first = await callBusModel(env, { ...args, runState });
  assert.equal(first.model, "fallback", "step 1: primary timed out, the fallback answers");
  assert.match(first.primary_error, /timeout/);
  assert.equal(runState.primaryError, undefined, "one timeout does not pin the run");
  const second = await callBusModel(env, { ...args, runState });
  assert.equal(second.model, "primary", "step 2 tries the primary again and it answers");
  assert.equal(second.fallback_used, false);
  const third = await callBusModel(env, { ...args, runState });
  assert.equal(third.model, "fallback", "step 3: a second timeout");
  assert.match(runState.primaryError, /timeout/, "two timeouts pin the fallback for the rest of the run");
  const fourth = await callBusModel(env, { ...args, runState });
  assert.equal(fourth.model, "fallback");
  assert.equal(primaryCalls, 3, "the pinned run no longer spends time on the primary");
});

test("a fallback answer cut off by its token limit is asked once more, briefly, with a larger budget", async () => {
  // preview-e2e 2026-11-06 (#128): the H1 bus moderator fell back to glm-4.7-flash, which spent its
  // whole budget on hidden reasoning (finish_reason length, 9340 tokens) and gave no answer.
  const { callBusModel, FALLBACK_TOKEN_FACTOR } = await import("../src/model-call.mjs");
  const requests = [];
  const ai = { run: async (model, request) => {
    requests.push({ model, request });
    if (model === "primary") throw new Error("5007: model not available");
    if (requests.filter((r) => r.model === "fallback").length === 1) return { choices: [{ message: { content: null }, finish_reason: "length" }] };
    return { choices: [{ message: { content: "{\"stance\":\"WAIT\"}" }, finish_reason: "stop" }] };
  } };
  const now = 0;
  const r = await callBusModel({ AI: ai, MULTI_AGENT_MODEL: "primary", MULTI_AGENT_FALLBACK_MODEL: "fallback" }, { messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], schemaName: "x", schema: { type: "object" }, maxTokens: 100, deadline: 600_000, clock: () => now, runState: {} });
  assert.equal(r.status, "answered");
  assert.deepEqual(r.obj, { stance: "WAIT" });
  assert.equal(r.truncated, false);
  const fallbacks = requests.filter((x) => x.model === "fallback");
  assert.equal(fallbacks.length, 2);
  assert.equal(fallbacks[0].request.max_tokens, 100 * FALLBACK_TOKEN_FACTOR);
  assert.equal(fallbacks[1].request.max_tokens, 100 * FALLBACK_TOKEN_FACTOR * 2, "twice the fallback budget");
  assert.match(fallbacks[1].request.messages.at(-1).content, /JSON object only/);
  assert.equal(r.calls, 3);

  // No time left for the retry: the cut-off answer is returned as before.
  const short = await callBusModel({ AI: { run: async (model) => (model === "primary" ? Promise.reject(new Error("5007")) : { choices: [{ message: { content: null }, finish_reason: "length" }] }) }, MULTI_AGENT_MODEL: "primary", MULTI_AGENT_FALLBACK_MODEL: "fallback" }, { messages: [{ role: "user", content: "u" }], schemaName: "x", schema: { type: "object" }, maxTokens: 100, deadline: 10_000, clock: () => now, runState: {} });
  assert.equal(short.truncated, true);
});

test("the primary leaves time for the fallback; an exhausted budget names no model (post-reopen audit 2026-11-09)", async () => {
  // Production: the 15m conclusion's primary (gpt-oss-120b) timed out at the deadline, the fallback never
  // ran, and the row named the fallback with fallback_used = 1.
  const { callBusModel, FALLBACK_RESERVE_MS } = await import("../src/model-call.mjs");
  const asked = [];
  const ai = { run: async (model) => { asked.push(model); return { choices: [{ message: { content: "{\"stance\":\"WAIT\"}" }, finish_reason: "stop" }] }; } };
  const env = { AI: ai, MULTI_AGENT_MODEL: "primary", MULTI_AGENT_FALLBACK_MODEL: "fallback" };
  const args = { messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], schemaName: "x", schema: { type: "object" }, maxTokens: 10, clock: () => 0 };
  assert.equal(FALLBACK_RESERVE_MS, 20_000);
  const tight = await callBusModel(env, { ...args, deadline: FALLBACK_RESERVE_MS - 5_000, runState: {} });
  assert.equal(tight.model, "fallback", "too little time for both: the primary is skipped");
  assert.deepEqual(asked, ["fallback"]);
  assert.match(tight.primary_error, /skipped/);
  const none = await callBusModel(env, { ...args, deadline: 0, runState: {} });
  assert.deepEqual([none.status, none.model, none.fallback_used], ["budget_exhausted", null, false]);
});

const MSGS = [{ role: "system", content: "s" }, { role: "user", content: "u" }];
const ok = (content) => ({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });

test("an answer cut off by the token limit is marked truncated, with or without text", () => {
  assert.equal(parseModelObject({ choices: [{ message: { content: null }, finish_reason: "length" }] }).truncated, true);
  const cut = "```json\n{\n  \"agent\": \"technical\",\n  \"round\": 2,\n  \"stance\": \"WAIT\",\n  \"insight\": \"I agree with";
  const r = parseModelObject({ choices: [{ message: { content: cut }, finish_reason: "length" }] });
  assert.deepEqual([r.obj, r.truncated], [null, true]);
  assert.deepEqual(parseModelObject(ok({ stance: "WAIT" })).obj, { stance: "WAIT" });
});

test("a primary-model error falls back, records why, and pins the primary for the rest of the run; a moderator keeps its own primary", async () => {
  const ai = fakeAI(({ model }) => (model === BUS_DEFAULT_MODEL ? new Error("5007: model not available") : agentReply("technical", 1)));
  const env = { AI: ai };
  const runState = {};
  const args = { messages: MSGS, schemaName: "thread_agent", schema: AGENT_JSON_SCHEMA, maxTokens: 3072, effort: "low", deadline: 1e12, clock: () => 0, runState };
  const first = await callBusModel(env, args);
  assert.deepEqual([first.status, first.model, first.fallback_used], ["answered", BUS_DEFAULT_FALLBACK_MODEL, true]);
  assert.match(first.primary_error, /5007: model not available/, "the primary error is kept for diagnosis");
  assert.match(runState.primaryError, /5007/, "an error other than a timeout pins the fallback at once");
  const second = await callBusModel(env, args);
  assert.equal(second.model, BUS_DEFAULT_FALLBACK_MODEL);
  assert.equal(ai.calls.filter((c) => c.model === BUS_DEFAULT_MODEL).length, 1, "the primary is tried once per run");
  const fallbackCalls = ai.calls.filter((c) => c.model === BUS_DEFAULT_FALLBACK_MODEL);
  assert.ok(fallbackCalls.every((c) => c.request.reasoning_effort === "low" && c.request.max_tokens >= 2 * 3072), "the gpt-oss-20b fallback reasons at low effort with twice the budget");
  const mod = await callBusModel(env, { ...args, schemaName: "thread_moderator", schema: MODERATOR_JSON_SCHEMA, role: "moderator" });
  assert.deepEqual([mod.model, mod.fallback_used], [MODERATOR_DEFAULT_MODEL, false], "a pin belongs to the failed model");
});

test("both models failing returns agent_failed with the error, never throws", async () => {
  const r = await callBusModel({ AI: fakeAI(() => new Error("down")) }, { messages: MSGS, schemaName: "x", schema: { type: "object" }, maxTokens: 10, deadline: 1e12, clock: () => 0, runState: {} });
  assert.equal(r.status, "agent_failed");
  assert.match(r.error, /down/);
  assert.equal(r.calls, 2);
});
