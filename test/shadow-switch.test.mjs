// The shadow kill switch (owner 2026-11-14: "berikan kill switch untuk mode shadow jika ternyata biaya membengkak").
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { shadowAllowed, setShadowMode, readShadowMode, shadowSpendToday, checkShadowBudget, gateShadowTurns, SHADOW_SWITCH_KEY, DEFAULT_SHADOW_NEURONS_PER_DAY } from "../src/shadow-switch.mjs";
import { recordAiUsage, resetAiUsageSchemaCacheForTests } from "../src/ai-usage.mjs";
import { runMetricShadow, resetMetricShadowSchemaCacheForTests } from "../src/metric-shadow.mjs";
import { runShadowCalls } from "../src/shadow-knowledge.mjs";
import { callBusModel } from "../src/multi-agent-bus.mjs";

const NOW = Date.parse("2026-11-16T10:20:00Z");
function world() {
  const raw = new DatabaseSync(":memory:");
  const stmt = (sql, params = []) => ({ bind: (...a) => stmt(sql, a), async run() { raw.prepare(sql).run(...params); return {}; }, async first() { return raw.prepare(sql).get(...params) ?? null; }, async all() { return { results: raw.prepare(sql).all(...params) }; } });
  const kv = new Map();
  resetAiUsageSchemaCacheForTests();
  return { raw, kv, env: { DB: { prepare: (sql) => stmt(sql) }, SIGNAL_CACHE: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } } };
}

test("on by default; off by the owner (a person and a reason, audited) or by the SHADOW_MODE variable", async () => {
  const { env, kv } = world();
  assert.equal(await shadowAllowed(env), true);
  assert.equal((await setShadowMode(env, { mode: "off", actor: "owner@example.com" })).ok, false, "a reason is required");
  assert.equal((await setShadowMode(env, { mode: "pause", reason: "x", actor: "owner@example.com" })).ok, false);
  const r = await setShadowMode(env, { mode: "off", reason: "cost check", actor: "owner@example.com" }, { now: NOW });
  assert.deepEqual([r.ok, r.previous_mode, r.changed], [true, "on", true]);
  assert.equal(await shadowAllowed(env), false);
  assert.ok(kv.has(SHADOW_SWITCH_KEY));
  const view = await readShadowMode(env, { now: NOW });
  assert.deepEqual([view.mode, view.mode_source, view.allowed, view.events.length, view.events[0].actor], ["off", "owner", false, 1, "owner@example.com"]);
  await setShadowMode(env, { mode: "on", reason: "back", actor: "owner@example.com" }, { now: NOW });
  assert.equal(await shadowAllowed(env), true);
  assert.equal(await shadowAllowed({ ...env, SHADOW_MODE: "off" }), false);
  assert.equal((await readShadowMode({ ...env, SHADOW_MODE: "off" }, { now: NOW })).held_off_by_variable, true);
});

test("off, no shadow path calls a model: the metric arm, the notes under test, a benched agent's turn", async () => {
  const { env } = world();
  let calls = 0;
  const AI = { async run() { calls += 1; return { response: "{}" }; } };
  await setShadowMode(env, { mode: "off", reason: "cost", actor: "owner@example.com" }, { now: NOW });
  resetMetricShadowSchemaCacheForTests();
  const metric = await runMetricShadow({ ...env, AI }, { barTime: "2026-11-16T10:15:00.000Z", agents: [{ agent: "technical", stance: "BUY" }], dataFor: () => ({}), roleFor: () => "role" });
  assert.equal(metric.status, "shadow_off");
  const notes = await runShadowCalls({ ...env, AI, SHADOW_KNOWLEDGE_ENABLED: "true" }, { calls: [{ subject: "x", agent: "technical", arm: "note" }], candleKey: "k", statementClose: "t", messagesFor: () => [], validate: () => ({ valid: true }) });
  assert.equal(notes.status, "shadow_off");
  assert.equal(calls, 0);
  const split = { live: ["news", "technical"], shadow: ["risk"], benched: ["risk"] };
  assert.deepEqual(await gateShadowTurns(env, split), { live: ["news", "technical"], shadow: [], benched: ["risk"], shadow_off: true });
  await setShadowMode(env, { mode: "on", reason: "back", actor: "owner@example.com" }, { now: NOW });
  assert.equal(await gateShadowTurns(env, split), split);
});

test("shadow calls are metered apart as shadow:<schema>, and the breaker turns shadow off past the day's budget", async () => {
  const { env } = world();
  // A shadow call through the bus lands on its own meter row.
  const AI = { async run() { return { response: JSON.stringify({ ok: 1 }), usage: { prompt_tokens: 1000, completion_tokens: 100 } }; } };
  await callBusModel({ ...env, AI }, { messages: [{ role: "user", content: "x" }], schemaName: "metric_opening", schema: { type: "object" }, maxTokens: 100, effort: "low", deadline: Date.now() + 30_000, clock: Date.now, meterSource: "shadow:metric_opening" });
  const sources = (await env.DB.prepare("SELECT source FROM ai_usage_daily").all()).results.map((r) => r.source);
  assert.deepEqual(sources, ["shadow:metric_opening"]);
  // A live row does not count against the shadow budget.
  const day = NOW;
  await recordAiUsage(env.DB, { source: "war_room_opening", model: "@cf/google/gemma-4-26b-a4b-it", prompt: 5_000_000, completion: 0, now: day });
  await recordAiUsage(env.DB, { source: "shadow:war_room_opening", model: "@cf/google/gemma-4-26b-a4b-it", prompt: 1_000_000, completion: 100_000, now: day });
  const spend = await shadowSpendToday(env.DB, { now: day });
  assert.equal(spend.neurons, 9091 + 2727);
  assert.ok(!("war_room_opening" in spend.by_source));
  assert.deepEqual(await checkShadowBudget(env, { now: day }), { status: "within_budget", neurons: 11818, budget: DEFAULT_SHADOW_NEURONS_PER_DAY });
  await recordAiUsage(env.DB, { source: "shadow:metric_opening", model: "@cf/google/gemma-4-26b-a4b-it", prompt: 2_000_000, completion: 0, now: day });
  const sent = [];
  const trip = await checkShadowBudget(env, { now: day, send: async (t) => sent.push(t) });
  assert.equal(trip.status, "tripped");
  assert.equal(await shadowAllowed(env), false);
  assert.match(sent[0], /switched OFF by the cost breaker/);
  assert.equal((await readShadowMode(env, { now: day })).mode_source, "breaker");
  // It stays off (the next hour does nothing) until the owner switches it on.
  assert.deepEqual(await checkShadowBudget(env, { now: day + 3_600_000 }), { status: "off" });
  assert.equal(sent.length, 1);
  // A smaller budget by variable.
  const { env: e2 } = world();
  await recordAiUsage(e2.DB, { source: "shadow:metric_opening", model: "@cf/google/gemma-4-26b-a4b-it", prompt: 1_000_000, completion: 0, now: day });
  assert.equal((await checkShadowBudget({ ...e2, SHADOW_NEURONS_PER_DAY_MAX: "5000" }, { now: day })).status, "tripped");
});
