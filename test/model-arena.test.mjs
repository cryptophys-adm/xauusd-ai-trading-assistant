// AI Neuron B, the model arena (owner 2026-11-14: "lanjut B"): a challenger model answers the heavy steps
// again in shadow, on a sample of bars, within its own cap and the shadow kill switch; nothing live changes.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  isArenaBar, arenaGate, runArenaCall, scoreModelArena, compareModelArena, readModelArena, arenaSpendToday,
  resetModelArenaSchemaForTests, ARENA_DEFAULT_MODEL, ARENA_DEFAULT_EVERY, ARENA_DEFAULT_NEURONS_PER_DAY
} from "../src/model-arena.mjs";
import { isRebuttalBar } from "../src/metric-shadow.mjs";
import { modelRequests, modelFamily } from "../src/model-text.mjs";
import { neuronsOf, recordAiUsage, resetAiUsageSchemaCacheForTests } from "../src/ai-usage.mjs";
import { SHADOW_SWITCH_KEY } from "../src/shadow-switch.mjs";

function d1() {
  const raw = new DatabaseSync(":memory:");
  const stmt = (sql, params = []) => ({ bind: (...a) => stmt(sql, a), async run() { raw.prepare(sql).run(...params); return { meta: {} }; }, async first() { return raw.prepare(sql).get(...params) ?? null; }, async all() { return { results: raw.prepare(sql).all(...params) }; } });
  return { raw, prepare: (sql) => stmt(sql) };
}
function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } };
}
const Q = 900_000;
/** The first 15m bar close at or after `from` whose bar index satisfies `pred`. */
function barWhere(pred, from = Date.parse("2026-11-16T08:00:00Z")) {
  let t = Math.ceil(from / Q) * Q;
  while (!pred(Math.floor(t / Q))) t += Q;
  return new Date(t).toISOString();
}
const council = { stance: "WAIT", confidence: 0.55, reason: "No confirmed setup." };
function fakeAi(answer = council, { usage = { prompt_tokens: 8000, completion_tokens: 600, prompt_tokens_details: { cached_tokens: 4000 } }, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async run(model, input, opts) {
      calls.push({ model, input, opts });
      if (fail) throw new Error(fail);
      return { choices: [{ message: { content: typeof answer === "string" ? answer : JSON.stringify(answer) }, finish_reason: "stop" }], usage };
    }
  };
}
function fresh() { resetModelArenaSchemaForTests(); resetAiUsageSchemaCacheForTests(); }
const base = (over = {}) => ({
  role: "decision_council", schemaName: "decision_council", messages: [{ role: "system", content: "council" }, { role: "user", content: "evidence" }],
  validate: (o) => ({ valid: ["BUY", "SELL", "WAIT"].includes(o?.stance), errors: ["stance_invalid"] }),
  live: { model: "@cf/openai/gpt-oss-120b", status: "ok", stance: "WAIT", latency_ms: 21_000 }, ...over
});

test("the arena samples every 8th bar, offset so it never falls on a metric rebuttal bar", () => {
  const bars = Array.from({ length: 96 }, (_, i) => new Date(Date.parse("2026-11-16T00:00:00Z") + (i + 1) * Q).toISOString());
  const sampled = bars.filter((b) => isArenaBar(b, ARENA_DEFAULT_EVERY));
  assert.equal(sampled.length, 12, "twelve a day: about one every two hours");
  assert.ok(sampled.every((b) => !isRebuttalBar(b, 4)));
  assert.equal(isArenaBar("not a time"), false);
});

test("the gate: off, shadow off, not sampled, meter unavailable, own cap, then headroom under the kill switch's budget", () => {
  const ok = { enabled: true, allowed: true, sampled: true, arenaNeurons: 0, shadowNeurons: 0, cap: 6000, budget: 25_000 };
  assert.equal(arenaGate(ok), null);
  assert.equal(arenaGate({ ...ok, enabled: false }), "disabled");
  assert.equal(arenaGate({ ...ok, allowed: false }), "shadow_off");
  assert.equal(arenaGate({ ...ok, sampled: false }), "not_an_arena_bar");
  assert.equal(arenaGate({ ...ok, meterError: "meter_unavailable" }), "meter_unavailable");
  assert.equal(arenaGate({ ...ok, arenaNeurons: 6000 }), "arena_cap_reached");
  assert.equal(arenaGate({ ...ok, shadowNeurons: 20_000 }), "shadow_budget_headroom", "stops at 80% so it never trips the breaker by itself");
  assert.equal(arenaGate({ ...ok, shadowNeurons: 19_999 }), null);
});

test("the challenger's request: reasoning effort low with the JSON schema first; cached input priced at its own rate", () => {
  assert.equal(modelFamily(ARENA_DEFAULT_MODEL), "deepseek-v4");
  const forms = modelRequests(ARENA_DEFAULT_MODEL, { messages: [{ role: "user", content: "x" }], maxTokens: 100, effort: "low", schemaName: "decision_council", schema: { type: "object" } });
  assert.equal(forms.length, 3);
  assert.equal(forms[0].reasoning_effort, "low");
  assert.equal(forms[0].response_format.type, "json_schema");
  assert.equal(forms[1].response_format, undefined);
  assert.equal(forms[2].reasoning_effort, undefined, "the last form is the plain one");
  assert.equal(modelRequests(ARENA_DEFAULT_MODEL, { messages: [], maxTokens: 1, effort: "none" })[0].reasoning_effort, "none");
  // 4,000 fresh + 4,000 cached input tokens and 600 output: 4000*27273 + 4000*545 + 600*109091 per million.
  assert.equal(neuronsOf(ARENA_DEFAULT_MODEL, 8000, 600, 4000), Math.round((4000 * 27273 + 4000 * 545 + 600 * 109091) / 1e6));
  assert.equal(neuronsOf(ARENA_DEFAULT_MODEL, 8000, 600), Math.round((8000 * 27273 + 600 * 109091) / 1e6));
  // A model with no cached rate is priced as before, cached tokens or not.
  assert.equal(neuronsOf("@cf/openai/gpt-oss-120b", 8000, 600, 4000), neuronsOf("@cf/openai/gpt-oss-120b", 8000, 600));
});

test("one call per sampled bar: stored beside the live step, metered as shadow:arena, never twice", async () => {
  fresh();
  const db = d1(), ai = fakeAi();
  const env = { DB: db, AI: ai, SIGNAL_CACHE: kv() };
  const bar = barWhere((i) => i % 8 === 2);
  const out = await runArenaCall(env, { ...base(), candleKey: `m15:${bar}`, statementClose: bar, clock: () => Date.parse(bar) + 60_000 });
  assert.equal(out.status, "ok");
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].model, ARENA_DEFAULT_MODEL);
  assert.equal(ai.calls[0].input.reasoning_effort, "low");
  assert.equal(ai.calls[0].opts.extraHeaders["x-session-affinity"], "xauusd:arena:decision_council");
  const row = db.raw.prepare("SELECT * FROM model_arena_outputs").get();
  assert.deepEqual([row.status, row.stance, row.live_stance, row.live_model, row.live_latency_ms, row.prompt_tokens, row.cached_tokens], ["ok", "WAIT", "WAIT", "@cf/openai/gpt-oss-120b", 21000, 8000, 4000]);
  const meter = db.raw.prepare("SELECT source, model, calls, cached_tokens FROM ai_usage_daily").all();
  assert.deepEqual(meter.map((m) => ({ ...m })), [{ source: "shadow:arena:decision_council", model: ARENA_DEFAULT_MODEL, calls: 1, cached_tokens: 4000 }]);
  // The meter dates a call by the wall clock (Workers AI bills it when it settles).
  const spend = await arenaSpendToday(db);
  assert.equal(spend.arena, neuronsOf(ARENA_DEFAULT_MODEL, 8000, 600, 4000));
  assert.equal(spend.arena, spend.shadow, "the arena counts against the shadow kill switch's budget too");
  assert.equal((await runArenaCall(env, { ...base(), candleKey: `m15:${bar}`, statementClose: bar })).status, "already_done");
  assert.equal(ai.calls.length, 1);
});

test("no call off the sample, with shadow off, with MODEL_ARENA off, or past the arena's own cap", async () => {
  fresh();
  const bar = barWhere((i) => i % 8 === 2);
  const off = barWhere((i) => i % 8 === 3);
  const run = async (env, at = bar) => runArenaCall(env, { ...base(), candleKey: `m15:${at}`, statementClose: at, clock: () => Date.parse(at) + 60_000 });
  const ai = fakeAi();
  assert.equal((await run({ DB: d1(), AI: ai, SIGNAL_CACHE: kv() }, off)).status, "not_an_arena_bar");
  assert.equal((await run({ DB: d1(), AI: ai, SIGNAL_CACHE: kv({ [SHADOW_SWITCH_KEY]: JSON.stringify({ mode: "off", actor: "owner" }) }) })).status, "shadow_off");
  assert.equal((await run({ DB: d1(), AI: ai, SIGNAL_CACHE: kv(), SHADOW_MODE: "off" })).status, "shadow_off");
  assert.equal((await run({ DB: d1(), AI: ai, SIGNAL_CACHE: kv(), MODEL_ARENA: "off" })).status, "disabled");
  fresh();
  const db = d1();
  // Today's arena calls already cost more than the cap.
  await recordAiUsage(db, { source: "shadow:arena:war_room_conclusion", model: ARENA_DEFAULT_MODEL, prompt: 300_000, completion: 10_000, now: Date.parse(bar) });
  const capped = await run({ DB: db, AI: ai, SIGNAL_CACHE: kv() });
  assert.equal(capped.status, "arena_cap_reached");
  assert.ok(capped.arena_neurons >= ARENA_DEFAULT_NEURONS_PER_DAY);
  // Other shadow arms near the kill switch's budget: the arena yields first.
  fresh();
  const busy = d1();
  await recordAiUsage(busy, { source: "shadow:war_room_opening", model: "@cf/google/gemma-4-26b-a4b-it", prompt: 2_000_000, completion: 100_000, now: Date.parse(bar) });
  assert.equal((await run({ DB: busy, AI: ai, SIGNAL_CACHE: kv() })).status, "shadow_budget_headroom");
  assert.equal(ai.calls.length, 0, "no model was called in any of these");
});

test("an invalid or failed answer is recorded as such, with no correction call", async () => {
  fresh();
  const bar = barWhere((i) => i % 8 === 2);
  const db = d1(), ai = fakeAi({ stance: "MAYBE" });
  await runArenaCall({ DB: db, AI: ai, SIGNAL_CACHE: kv() }, { ...base(), candleKey: "a", statementClose: bar });
  const broken = fakeAi(null, { fail: "3040 Capacity temporarily exceeded" });
  await runArenaCall({ DB: db, AI: broken, SIGNAL_CACHE: kv() }, { ...base({ role: "war_room_conclusion", schemaName: "war_room_conclusion" }), candleKey: "a", statementClose: bar });
  assert.equal(ai.calls.length, 1);
  const rows = db.raw.prepare("SELECT role, status, stance, errors FROM model_arena_outputs ORDER BY role").all().map((r) => ({ ...r }));
  assert.deepEqual(rows.map((r) => [r.role, r.status, r.stance]), [["decision_council", "invalid_output", null], ["war_room_conclusion", "agent_failed", null]]);
  assert.match(rows[0].errors, /stance_invalid/);
});

test("both stances are scored on the same 15m outcome, and compared per step", async () => {
  fresh();
  const db = d1();
  const bar = barWhere((i) => i % 8 === 2);
  const closeMs = Date.parse(bar);
  // 20 quiet bars, the arena bar, then four bars that rise well past half an ATR.
  const candles = [];
  for (let i = -20; i <= 4; i++) {
    const c = 4000 + (i > 0 ? i * 4 : 0);
    candles.push({ open: c, high: c + 1, low: c - 1, close: c, open_time: new Date(closeMs + (i - 1) * Q).toISOString(), close_time: new Date(closeMs + i * Q).toISOString() });
  }
  const env = { DB: db, AI: fakeAi({ stance: "BUY", confidence: 0.6, reason: "x" }), SIGNAL_CACHE: kv({ "market-data:v2:series:OANDA:XAUUSD|15m": JSON.stringify({ candles }) }) };
  await runArenaCall(env, { ...base(), candleKey: "k1", statementClose: bar, clock: () => closeMs + 60_000 });
  const scored = await scoreModelArena(env, { now: closeMs + 5 * Q });
  assert.equal(scored.scored, 1);
  const row = db.raw.prepare("SELECT result, live_result FROM model_arena_outputs").get();
  assert.deepEqual([row.result, row.live_result], ["hit", "missed_opportunity"]);
  const read = await readModelArena(env, { now: closeMs + 5 * Q });
  const c = read.roles.find((r) => r.role === "decision_council");
  assert.equal(c.calls, 1);
  assert.equal(c.stance_agreement, 0);
  assert.deepEqual([c.hit_rate, c.live_hit_rate], [1, 0], "a WAIT that let a 2:1 trade go by counts as a miss");
  assert.equal(c.verdict, "collecting");
  assert.equal(read.challenger, ARENA_DEFAULT_MODEL);
});

test("compare: first-try validity on both sides, live neurons per call from the meter", () => {
  const rows = [
    { role: "war_room_conclusion", status: "ok", stance: "WAIT", live_stance: "WAIT", live_status: "ok", latency_ms: 4000, live_latency_ms: 9000, model: ARENA_DEFAULT_MODEL, prompt_tokens: 3400, completion_tokens: 500, cached_tokens: 0 },
    { role: "war_room_conclusion", status: "invalid_output", stance: null, live_stance: "BUY", live_status: "ok_after_retry", latency_ms: 5000, live_latency_ms: 30000, model: ARENA_DEFAULT_MODEL, prompt_tokens: 3400, completion_tokens: 500, cached_tokens: 0 }
  ];
  const usage = [{ source: "war_room_conclusion", model: "@cf/openai/gpt-oss-120b", calls: 82, prompt_tokens: 276_068, completion_tokens: 42_830 }];
  const w = compareModelArena(rows, usage).roles.find((r) => r.role === "war_room_conclusion");
  assert.deepEqual([w.calls, w.validity, w.live_validity, w.live_answered, w.stance_agreement, w.compared], [2, 0.5, 0.5, 1, 1, 1]);
  assert.deepEqual(w.failures, { invalid_output: 1 });
  assert.equal(w.latency_ms, 4000, "latency of the valid answers");
  assert.equal(w.neurons_per_call, neuronsOf(ARENA_DEFAULT_MODEL, 3400, 500));
  assert.equal(w.live_neurons_per_call, Math.round(neuronsOf("@cf/openai/gpt-oss-120b", 276_068, 42_830) / 82));
  assert.equal(w.live_tokens_per_call, Math.round((276_068 + 42_830) / 82));
});
