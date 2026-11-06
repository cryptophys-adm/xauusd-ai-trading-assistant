import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  runMultiAgentBus, readBus, buildMultiAgentBusTask, buildBusEvidence, busEnabled,
  validateAgentOutput, validateModeratorOutput, resetBusSchemaCacheForTests, ensureBusSchema,
  BUS_DEFAULT_MODEL, BUS_DEFAULT_FALLBACK_MODEL, BUS_WALL_BUDGET_MS, AGENT_JSON_SCHEMA, MODERATOR_JSON_SCHEMA
} from "../src/multi-agent-bus.mjs";

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

function happyHandler({ request }) {
  const name = request.response_format?.json_schema?.name;
  const user = request.messages[1].content;
  if (name === "bus_moderator" || /moderator/i.test(request.messages[0].content)) return moderatorReply();
  const agent = (user.match(/Required JSON: \{"agent":"(\w+)"/) || [])[1];
  const round = /Round 2 of/.test(user) ? 2 : 1;
  return agentReply(agent, round);
}

function env(overrides = {}) {
  const d1 = fakeD1();
  seedSynthesis(d1);
  return { DB: d1, AI: fakeAI(happyHandler), MULTI_AGENT_BUS_ENABLED: "true", MULTI_AGENT_MAX_CALLS_PER_HOUR: "20", ...overrides };
}
const task = () => buildMultiAgentBusTask({ candleKey: CANDLE, inputFingerprint: RUN });

test.beforeEach(() => resetBusSchemaCacheForTests());

test("flag false: no model calls, no rows", async () => {
  const e = env({ MULTI_AGENT_BUS_ENABLED: "false" });
  assert.equal(busEnabled(e), false);
  const result = await runMultiAgentBus(e, task());
  assert.equal(result.status, "disabled");
  assert.equal(e.AI.calls.length, 0);
  assert.equal(busEnabled({}), false, "flag defaults to off");
});

test("flag true: 5 calls in order, all to glm-5.3-flash with strict json_schema", async () => {
  const e = env();
  const result = await runMultiAgentBus(e, task());
  assert.equal(result.status, "complete");
  assert.equal(e.AI.calls.length, 5);
  assert.ok(e.AI.calls.every(c => c.model === BUS_DEFAULT_MODEL));
  const order = e.AI.calls.map(c => c.request.response_format.json_schema.name);
  assert.deepEqual(order, ["bus_agent", "bus_agent", "bus_agent", "bus_agent", "bus_moderator"]);
  for (const c of e.AI.calls) {
    assert.equal(c.request.response_format.type, "json_schema");
    assert.equal(c.request.response_format.json_schema.strict, true);
    assert.equal(c.request.response_format.json_schema.schema.additionalProperties, false);
    assert.ok(c.request.max_completion_tokens >= 3072);
    assert.ok(["low", "high"].includes(c.request.reasoning_effort), "never medium (maps to max on glm-5.3-flash)");
  }
  assert.equal(e.AI.calls[4].request.max_completion_tokens, 4096, "moderator gets a reasoning-sized budget");
  const bus = await readBus(e.DB, CANDLE);
  assert.equal(bus.items.length, 5);
  assert.ok(bus.items.every(m => m.status === "ok" && m.model === BUS_DEFAULT_MODEL && m.fallback_used === false && m.usage_tokens === 120));
  assert.equal(bus.consensus.stance, "WAIT");
  assert.equal(bus.chain_decision, "WAIT");
  assert.equal(bus.agreement_with_chain, true);
});

test("schemas constrain stance and forbid extra keys", () => {
  assert.deepEqual(AGENT_JSON_SCHEMA.properties.stance.enum, ["BUY", "SELL", "WAIT"]);
  assert.deepEqual(MODERATOR_JSON_SCHEMA.properties.stance.enum, ["BUY", "SELL", "WAIT"]);
  assert.equal(AGENT_JSON_SCHEMA.additionalProperties, false);
  assert.equal(MODERATOR_JSON_SCHEMA.additionalProperties, false);
});

test("round 2 receives the other agent's round-1 message", async () => {
  const e = env();
  await runMultiAgentBus(e, task());
  const round2Technical = e.AI.calls[2].request.messages[1].content;
  assert.match(round2Technical, /Round 2 of 2/);
  assert.match(round2Technical, /OTHER AGENTS \(round 1\)/);
  assert.match(round2Technical, /news r1: evidence degraded/);
  assert.doesNotMatch(round2Technical.split("OTHER AGENTS")[1], /technical r1/, "an agent does not answer itself");
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
  assert.deepEqual(ev.technical.tradingview.lines.map(l => l.source), ["Prophet R38", "Prophet R37", "GMI v12.70"]);
  assert.match(ev.technical.tradingview.summary, /TradingView indicators/);
  assert.equal(ev.news.tradingview, undefined, "the news lane does not get the technical reading");
});

test("the technical agent is told to interpret each TradingView indicator; the moderator sees the reading", async () => {
  const e = env({ AI: fakeAI(happyHandler) });
  await runMultiAgentBus(e, task());
  const techR1 = e.AI.calls[0].request.messages[1].content;
  const newsR1 = e.AI.calls[1].request.messages[1].content;
  assert.match(techR1, /Interpret each indicator by name \(Prophet R38, Prophet R37 and GMI v12\.70\)/);
  assert.match(techR1, /"tradingview":\{"summary"/);
  assert.doesNotMatch(newsR1, /Interpret each indicator by name/);
  const moderator = e.AI.calls.at(-1).request.messages.map(m => m.content).join("\n");
  assert.match(moderator, /TRADINGVIEW READING/);
});

test("invalid JSON or out-of-schema output is stored as invalid_output, bus continues", async () => {
  const e = env({ AI: fakeAI(({ n, request }) => {
    if (n === 1) return "not json at all";
    if (n === 2) return agentReply("news", 1, "LONG");
    return happyHandler({ request });
  }) });
  const result = await runMultiAgentBus(e, task());
  assert.equal(result.status, "complete");
  const bus = await readBus(e.DB, CANDLE);
  const statuses = bus.items.map(m => `${m.round}:${m.agent}:${m.status}`);
  assert.deepEqual(statuses.slice(0, 2), ["1:technical:invalid_output", "1:news:invalid_output"]);
  assert.ok(bus.items[1].errors.includes("stance_invalid"));
  assert.equal(bus.consensus.stance, "WAIT");
});

test("text that reads like code gets one correction attempt, for agents and the moderator", async () => {
  // preview-e2e (PR #116): the moderator named a field from the evidence and the conclusion was lost.
  let moderatorAsked = 0;
  const e = env({ AI: fakeAI(({ n, request }) => {
    if (n === 1) return agentReply("technical", 1, "WAIT", { insight: "The buy_confirmed flag is false." });
    if (/moderator/i.test(request.messages[0].content) && ++moderatorAsked === 1) return moderatorReply({ summary: "Stand aside: the symbol_coverage check failed." });
    return happyHandler({ request });
  }) });
  await runMultiAgentBus(e, task());
  const bus = await readBus(e.DB, CANDLE);
  assert.equal(e.AI.calls.length, 7, "five steps plus one correction each for the two rejected answers");
  assert.ok(bus.items.every(m => m.status === "ok"), bus.items.map(m => m.status).join(","));
  const fix = e.AI.calls[1].request.messages;
  assert.match(fix.at(-1).content, /rejected: its text reads like code/);
  assert.equal(fix.at(-2).role, "assistant");
  assert.equal(bus.items.find(m => m.agent === "moderator").corrections, 1);

  // The hourly budget counts the correction calls: 5 rows + 2 corrections = 7 of 7.
  resetBusSchemaCacheForTests();
  const tight = env({ MULTI_AGENT_MAX_CALLS_PER_HOUR: "7", AI: fakeAI(({ n, request }) => (n === 1 ? agentReply("technical", 1, "WAIT", { insight: "The buy_confirmed flag is false." }) : happyHandler({ request }))) });
  await runMultiAgentBus(tight, task());
  assert.equal(tight.AI.calls.length, 6, "one correction plus five steps");
  await runMultiAgentBus(tight, buildMultiAgentBusTask({ candleKey: CANDLE, inputFingerprint: RUN + "-next" }));
  assert.equal(tight.AI.calls.length, 7, "only one more call fits: the correction counted toward the budget");

  // A second answer that still reads like code stays invalid; no third call.
  resetBusSchemaCacheForTests();
  const stubborn = env({ AI: fakeAI(({ request }) => (/moderator/i.test(request.messages[0].content) ? moderatorReply({ summary: "The h1.decision is WAIT." }) : happyHandler({ request }))) });
  await runMultiAgentBus(stubborn, task());
  assert.equal(stubborn.AI.calls.length, 6);
  assert.equal((await readBus(stubborn.DB, CANDLE)).items.find(m => m.agent === "moderator").status, "invalid_output");

  // Other errors (a wrong stance) get no correction attempt.
  resetBusSchemaCacheForTests();
  const wrong = env({ AI: fakeAI(({ n, request }) => (n === 1 ? agentReply("technical", 1, "LONG") : happyHandler({ request }))) });
  await runMultiAgentBus(wrong, task());
  assert.equal(wrong.AI.calls.length, 5);
});

test("finish_reason length with null content is invalid_output", async () => {
  const d1 = fakeD1(); seedSynthesis(d1);
  const ai = { calls: [], run: async (model, request) => { ai.calls.push({ model, request }); return { choices: [{ message: { content: null }, finish_reason: "length" }] }; } };
  const e = { DB: d1, AI: ai, MULTI_AGENT_BUS_ENABLED: "true", MULTI_AGENT_MAX_CALLS_PER_HOUR: "50" };
  await runMultiAgentBus(e, task());
  const bus = await readBus(d1, CANDLE);
  assert.ok(bus.items.every(m => m.status === "invalid_output"));
  assert.equal(bus.consensus, null, "no consensus from an invalid moderator answer");
});

test("an answer cut off by the token limit is recorded as finish_reason_length", async () => {
  const d1 = fakeD1(); seedSynthesis(d1);
  const cut = "```json\n{\n  \"agent\": \"technical\",\n  \"round\": 2,\n  \"stance\": \"WAIT\",\n  \"insight\": \"I agree with";
  const ai = { calls: [], run: async (model, request) => { ai.calls.push({ model, request }); return { choices: [{ message: { content: cut }, finish_reason: "length" }] }; } };
  await runMultiAgentBus({ DB: d1, AI: ai, MULTI_AGENT_BUS_ENABLED: "true", MULTI_AGENT_MAX_CALLS_PER_HOUR: "50" }, task());
  const bus = await readBus(d1, CANDLE);
  assert.ok(bus.items.every(m => m.status === "invalid_output" && m.errors.includes("finish_reason_length")), JSON.stringify(bus.items.map(m => m.errors)));
});

test("a primary-model error falls back, records why, and skips the primary for the rest of the run", async () => {
  const e = env({ AI: fakeAI(({ model, request }) => model === BUS_DEFAULT_MODEL ? new Error("5007: model not available") : happyHandler({ request: { ...request, response_format: { json_schema: { name: /moderator/i.test(request.messages[0].content) ? "bus_moderator" : "bus_agent" } } } })) });
  await runMultiAgentBus(e, task());
  assert.equal(e.AI.calls.filter(c => c.model === BUS_DEFAULT_MODEL).length, 1, "the primary is tried once per run");
  const fallbackCalls = e.AI.calls.filter(c => c.model === BUS_DEFAULT_FALLBACK_MODEL);
  assert.equal(fallbackCalls.length, 5);
  assert.ok(fallbackCalls.every(c => c.request.response_format === undefined && c.request.max_tokens > 0), "fallback uses the plain Workers AI chat form");
  assert.ok(fallbackCalls.every(c => c.request.max_tokens >= 2 * 3072), "the fallback reasoning model gets twice the token budget");
  const bus = await readBus(e.DB, CANDLE);
  assert.ok(bus.items.every(m => m.fallback_used === true && m.model === BUS_DEFAULT_FALLBACK_MODEL && m.status === "ok"));
  assert.ok(bus.items.every(m => /5007: model not available/.test(m.primary_error)), "the primary error is stored for diagnosis");
});

test("both models failing records agent_failed and still finishes", async () => {
  const e = env({ AI: fakeAI(() => new Error("down")) });
  const result = await runMultiAgentBus(e, task());
  assert.equal(result.status, "complete");
  const bus = await readBus(e.DB, CANDLE);
  assert.equal(bus.items.length, 5);
  assert.ok(bus.items.every(m => m.status === "agent_failed"));
});

test("hourly budget exhausted: no calls, budget_exhausted rows", async () => {
  const e = env({ MULTI_AGENT_MAX_CALLS_PER_HOUR: "0" });
  await runMultiAgentBus(e, task());
  assert.equal(e.AI.calls.length, 0);
  const bus = await readBus(e.DB, CANDLE);
  assert.ok(bus.items.every(m => m.status === "budget_exhausted"));
});

test("hourly budget counts real calls in the last 60 minutes (ISO timestamps)", async () => {
  const e = env({ MULTI_AGENT_MAX_CALLS_PER_HOUR: "3" });
  await runMultiAgentBus(e, task());
  assert.equal(e.AI.calls.length, 3, "stops after the third call in the hour");
  const bus = await readBus(e.DB, CANDLE);
  assert.deepEqual(bus.items.map(m => m.status), ["ok", "ok", "ok", "budget_exhausted", "budget_exhausted"]);
});

test("budget counter failure fails closed", async () => {
  const e = env();
  const realPrepare = e.DB.prepare;
  e.DB.prepare = (sql) => sql.includes("SUM(1 + COALESCE") ? { bind: () => ({ first: async () => { throw new Error("d1 down"); } }) } : realPrepare(sql);
  await runMultiAgentBus(e, task());
  assert.equal(e.AI.calls.length, 0);
});

test("wall budget (fake clock) stops further calls", async () => {
  let now = Date.parse("2026-11-04T10:00:00Z");
  const e = env({ AI: fakeAI(({ request }) => { now += 80_000; return happyHandler({ request }); }) });
  await runMultiAgentBus(e, task(), { clock: () => now });
  assert.equal(BUS_WALL_BUDGET_MS, 300_000);
  assert.equal(e.AI.calls.length, 4, "the 4th call starts at 240 s; the moderator at 320 s is over budget");
  const bus = await readBus(e.DB, CANDLE);
  assert.equal(bus.items.find(m => m.agent === "moderator").status, "budget_exhausted");
});

test("five fallback-speed calls (~50 s each) fit inside the wall budget", async () => {
  let now = Date.parse("2026-11-04T10:00:00Z");
  const e = env({ AI: fakeAI(({ request }) => { now += 50_000; return happyHandler({ request }); }) });
  await runMultiAgentBus(e, task(), { clock: () => now });
  assert.equal(e.AI.calls.length, 5);
  const bus = await readBus(e.DB, CANDLE);
  assert.equal(bus.items.find(m => m.agent === "moderator").status, "ok");
});

test("redelivering the same queue message makes no new calls and no duplicate rows", async () => {
  const e = env();
  await runMultiAgentBus(e, task());
  const again = await runMultiAgentBus(e, task());
  assert.equal(again.status, "already_complete");
  assert.equal(e.AI.calls.length, 5);
  const count = e.DB.raw.prepare("SELECT COUNT(*) AS n FROM bus_messages").get().n;
  assert.equal(count, 5);
});

test("a partial run (isolate evicted after round 1) resumes without repeating finished steps", async () => {
  const e = env();
  await ensureBusSchema(e.DB);
  const ts = new Date().toISOString();
  for (const agent of ["technical", "news"]) {
    e.DB.raw.prepare("INSERT INTO bus_messages (run_id, candle_key, round, agent, ts, insight, confidence, refs_json, model, status, latency_ms, fallback_used, usage_tokens) VALUES (?, ?, 1, ?, ?, ?, 0.4, '[\"x\"]', ?, 'ok', 10, 0, 120)")
      .run(RUN, CANDLE, agent, ts, JSON.stringify({ stance: "WAIT", insight: `${agent} r1: evidence degraded`, responds_to: null }), BUS_DEFAULT_MODEL);
  }
  const result = await runMultiAgentBus(e, task());
  assert.equal(result.status, "complete");
  assert.equal(e.AI.calls.length, 3, "only round 2 (2 agents) and the moderator are called");
  assert.match(e.AI.calls[0].request.messages[1].content, /news r1: evidence degraded/, "stored round-1 messages feed round 2");
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM bus_messages").get().n, 5);
});

test("the bus never writes to ai_syntheses (chain evidence/decision untouched)", async () => {
  const e = env();
  const before = e.DB.raw.prepare("SELECT ai_analysis FROM ai_syntheses").get().ai_analysis;
  await runMultiAgentBus(e, task());
  const after = e.DB.raw.prepare("SELECT ai_analysis FROM ai_syntheses").get().ai_analysis;
  assert.equal(after, before);
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

test("agent prompts carry the advisory and trust rules", async () => {
  const e = env();
  await runMultiAgentBus(e, task());
  for (const c of e.AI.calls) {
    const text = c.request.messages.map(m => m.content).join("\n");
    assert.match(text, /never produce entry, stop loss, take profit or position size/);
    assert.match(text, /approved_by_parity/);
    assert.match(text, /UNVERIFIED 5m/);
  }
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

test("readBus without candle_key lists recent messages; schema ensure is idempotent", async () => {
  const e = env();
  await ensureBusSchema(e.DB);
  resetBusSchemaCacheForTests();
  await ensureBusSchema(e.DB);
  await runMultiAgentBus(e, task());
  const recent = await readBus(e.DB, null);
  assert.equal(recent.items.length, 5);
  assert.equal(recent.consensus, null);
});

test("task builder is deterministic", () => {
  const t = buildMultiAgentBusTask({ candleKey: CANDLE, inputFingerprint: RUN, enqueuedAt: "x" });
  assert.equal(t.kind, "multi_agent_bus");
  assert.equal(t.event_id, `bus:${CANDLE}:${RUN}`);
  assert.throws(() => buildMultiAgentBusTask({ candleKey: "", inputFingerprint: RUN }));
});

test("a rate-limited call waits and retries the same model once; it never marks the primary as failed", async () => {
  const { callBusModel, isRateLimited } = await import("../src/multi-agent-bus.mjs");
  assert.equal(isRateLimited(new Error("3021: rate limiting: inference request per min rate reached")), true);
  assert.equal(isRateLimited(new Error("5007: model unavailable")), false);
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
