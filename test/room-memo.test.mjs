// Owner 2026-11-11: "kurangi neuron/hari tanpa mengurangi kapabilitas agent". The usage meter, the room
// memo (shadow by default, reuse with ROOM_MEMO_ENABLED) and the tf room schemas that dropped "metrics".
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { threadInternals, ensureThreadSchema } from "../src/agent-threads.mjs";
import { usageSplit, readAiUsage, neuronsOf, recordAiUsage, resetAiUsageSchemaCacheForTests } from "../src/ai-usage.mjs";
import { memoKind, inputHash, resetRoomMemoSchemaCacheForTests } from "../src/room-memo.mjs";
import { callBusModel } from "../src/multi-agent-bus.mjs";
import { TF_ROOM_SCHEMAS } from "../src/timeframe-threads.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  const stmt = (sql, params = []) => ({
    bind: (...a) => stmt(sql, a.map((v) => (v === undefined ? null : v))),
    async run() { const r = db.prepare(sql).run(...params); return { success: true, meta: { changes: Number(r.changes) } }; },
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { return { results: db.prepare(sql).all(...params) }; }
  });
  return { raw: db, prepare: (sql) => stmt(sql) };
}

const NOW = Date.parse("2026-11-11T03:00:00Z");
const GEMMA = "@cf/google/gemma-4-26b-a4b-it";

function fakeAI({ answer = { agent: "fabio_amt", stance: "WAIT", bias: "NEUTRAL", confidence: 0.4, claim: "Value sits inside the balance area, so the auction has no edge yet.", metrics: ["the value area"] }, failPrimary = false } = {}) {
  const calls = [];
  return {
    calls,
    run: async (model, request) => {
      calls.push({ model, request });
      if (failPrimary && model === GEMMA) throw new Error("3010: internal server error");
      return { choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } };
    }
  };
}

async function setup(overrides = {}, ai = fakeAI()) {
  resetAiUsageSchemaCacheForTests(); resetRoomMemoSchemaCacheForTests();
  const db = d1();
  await ensureThreadSchema(db);
  return { env: { DB: db, AI: ai, MODEL_RATE_LIMIT_RETRY_MS: "0", ...overrides }, db, ai };
}

const messages = (data = "value area: inside") => [{ role: "system", content: "You are Fabio AMT in the XAUUSD Live War Room." }, { role: "user", content: "YOUR DATA:\n" + data }];
function step(env, runId, { data, evidence = undefined, validate = (o) => ({ valid: typeof o?.claim === "string" && Array.isArray(o?.metrics), errors: [] }), threadId = "warroom:2026-11-11" } = {}) {
  return threadInternals.runStep(env, env.DB, { thread_id: threadId, run_id: runId, step: "open:fabio_amt", agent: "fabio_amt", parent_id: null, bar_time: runId }, {
    messages: messages(data), schemaName: "war_room_opening", schema: null, maxTokens: 512, effort: "low", ...(evidence !== undefined ? { evidence } : {}),
    deadline: Date.now() + 60_000, clock: () => Date.now(), runState: {}, budgetOk: async () => true, validate,
    toBody: (o) => ({ body: { claim: o.claim, bias: o.bias, metrics: o.metrics, name: "Fabio AMT" }, refs: [] })
  });
}
const usage = async (db) => (await readAiUsage(db, { days: 1 })).totals[0];

test("R1. the tf room schemas carry the metrics list the validators require (strict schemas dropped it)", () => {
  for (const [name, schema] of Object.entries(TF_ROOM_SCHEMAS)) {
    assert.ok(schema.properties.metrics, `${name} schema has metrics`);
    assert.ok(schema.required.includes("metrics"), `${name} schema requires metrics`);
    assert.equal(schema.additionalProperties, false);
  }
});

test("R2. the meter: input and output tokens from every response form, and neurons from the published rates", async () => {
  assert.deepEqual(usageSplit({ usage: { prompt_tokens: 10, completion_tokens: 4 } }), { prompt: 10, completion: 4 });
  assert.deepEqual(usageSplit({ usage: { input_tokens: 7, output_tokens: 3 } }), { prompt: 7, completion: 3 }, "Responses form");
  assert.deepEqual(usageSplit({ usage: { prompt_tokens: 10, total_tokens: 15 } }), { prompt: 10, completion: 5 });
  assert.deepEqual(usageSplit({}), { prompt: 0, completion: 0 });
  assert.equal(neuronsOf(GEMMA, 1_000_000, 0), 9091);
  assert.equal(neuronsOf("@cf/openai/gpt-oss-120b", 0, 1_000_000), 68182);
  assert.equal(neuronsOf("@cf/unknown/model", 1000, 1000), null, "no guessed rate");
  const { db } = await setup();
  assert.equal(await recordAiUsage(db, { source: "x", model: GEMMA, outcome: "nonsense" }), false);
  assert.equal(await recordAiUsage(null, { source: "x" }), false, "never throws without a database");
});

test("R3. shadow memo (default): the same request calls the model again and is counted as a hit with the same stance", async () => {
  const { env, db, ai } = await setup();
  const first = await step(env, "2026-11-11T02:45:00.000Z");
  assert.equal(first.status, "ok");
  assert.match(first.input_hash, /^[0-9a-f]{32}$/);
  const second = await step(env, "2026-11-11T03:00:00.000Z");
  assert.equal(second.status, "ok");
  assert.equal(second.reused, undefined);
  assert.equal(ai.calls.length, 2, "shadow never skips the model");
  const u = await usage(db);
  assert.equal(u.calls, 2);
  assert.equal(u.prompt_tokens, 2000);
  assert.equal(u.completion_tokens, 200);
  assert.equal(u.memo_hits, 1);
  assert.equal(u.memo_same, 1, "the model gave the same stance and bias to the same request");
  assert.equal(u.reused, 0);
  assert.equal(u.neurons, Math.round((2000 * 9091 + 200 * 27273) / 1e6));
});

test("R4. memo on: the same request reuses the stored answer without a model call; a changed request calls the model", async () => {
  const { env, db, ai } = await setup({ ROOM_MEMO_ENABLED: "true" });
  const first = await step(env, "2026-11-11T02:45:00.000Z");
  const second = await step(env, "2026-11-11T03:00:00.000Z");
  assert.equal(ai.calls.length, 1, "the second bar made no model call");
  assert.equal(second.status, "ok");
  assert.equal(second.reused, true);
  assert.equal(second.reused_from, first.id);
  assert.equal(second.stance, first.stance);
  assert.equal(second.claim, first.claim);
  assert.equal(second.usage_tokens, 0);
  assert.equal(second.model, GEMMA);
  // A reused step made no model call, so it does not count against the room's hourly budget.
  assert.equal(await threadInternals.callsInLastHour(db, Date.now(), "warroom"), 1);
  const third = await step(env, "2026-11-11T03:15:00.000Z", { data: "value area: above" });
  assert.equal(ai.calls.length, 2, "new data, new call");
  assert.equal(third.reused, undefined);
  const u = await usage(db);
  assert.equal(u.reused, 1);
  assert.equal(u.calls, 2);
});

test("R5. memo on: a stored answer this room's rules now reject is not reused; the model answers", async () => {
  const { env, ai } = await setup({ ROOM_MEMO_ENABLED: "true" });
  await step(env, "2026-11-11T02:45:00.000Z");
  let strict = true;
  const validate = (o) => (strict ? { valid: false, errors: ["names_an_agent"] } : { valid: true, errors: [] });
  // First validation of the reused answer fails; the model's own answer then passes.
  const wrapped = (o) => { const v = validate(o); strict = false; return v; };
  const second = await step(env, "2026-11-11T03:00:00.000Z", { validate: wrapped });
  assert.equal(ai.calls.length, 2);
  assert.equal(second.status, "ok");
  assert.equal(second.reused, undefined);
});

test("R6. only the primary model's answers are stored: a fallback answer is never reused", async () => {
  const ai = fakeAI({ failPrimary: true });
  const { env, db } = await setup({ ROOM_MEMO_ENABLED: "true" }, ai);
  const first = await step(env, "2026-11-11T02:45:00.000Z");
  assert.equal(first.status, "ok");
  assert.equal(first.fallback_used, true);
  await step(env, "2026-11-11T03:00:00.000Z");
  assert.equal(ai.calls.filter((c) => c.model !== GEMMA).length, 2, "the fallback answered both bars");
  assert.equal((await usage(db)).reused, 0);
  const failed = (await readAiUsage(db, { days: 1 })).rows.find((r) => r.model === GEMMA);
  assert.equal(failed.failed, 2, "the primary's errors are counted");
});

test("R7. a call abandoned at its timeout is counted, and its tokens still land when it finishes (Workers AI bills it)", async () => {
  const { db } = await setup();
  const ai = {
    run: async (model) => {
      if (model === GEMMA) await new Promise((r) => setTimeout(r, 60));
      return { choices: [{ message: { content: JSON.stringify({ ok: true }) }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 50 } };
    }
  };
  const env = { DB: db, AI: ai, BUS_PRIMARY_TIMEOUT_MS: "10", MODEL_RATE_LIMIT_RETRY_MS: "0" };
  const r = await callBusModel(env, { messages: messages(), schemaName: "tf_room_opening", schema: null, maxTokens: 256, effort: "low", deadline: Date.now() + 60_000, clock: () => Date.now(), runState: {} });
  assert.equal(r.status, "answered");
  assert.equal(r.fallback_used, true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const rows = (await readAiUsage(db, { days: 1 })).rows;
  const gemma = rows.find((x) => x.model === GEMMA);
  assert.equal(gemma.source, "tf_room_opening");
  assert.equal(gemma.timeouts, 1);
  assert.equal(gemma.calls, 1, "the late completion");
  assert.equal(gemma.prompt_tokens, 500);
  assert.ok(rows.find((x) => x.model === "@cf/openai/gpt-oss-20b")?.calls === 1, "the fallback's call");
});

test("R8. memo keys: the War Room's daily thread is one family; the hash covers the whole request", async () => {
  assert.equal(memoKind("warroom:2026-11-11"), "warroom");
  assert.equal(memoKind("tf:H1"), "tf:H1");
  const a = await inputHash(["m", "s", messages("x")]);
  assert.equal(a, await inputHash(["m", "s", messages("x")]));
  assert.notEqual(a, await inputHash(["m", "s", messages("y")]));
  assert.notEqual(a, await inputHash(["other-model", "s", messages("x")]), "a model change is a new request");
});

test("R9. dismantled HUD agents (owner 2026-11-11: \"dismantle sekarang\") speak in no room; their HUD sections stay computed", async () => {
  const { hudAgentsIn, HUD_IDS } = await import("../src/hud-reading.mjs");
  const { MANIFESTS } = await import("../src/indicator-manifests.mjs");
  const gone = ["r37_funnel", "gabfx_price_action", "playbook_execution", "grid_bot_protocol"];
  for (const room of ["M15", "H1", "H4", "D1"]) {
    const ids = hudAgentsIn(room);
    for (const id of gone) assert.ok(!ids.includes(id), `${id} is not in the ${room} roster`);
    assert.ok(ids.includes("prophet") && ids.includes("fabio_amt"), `${room} keeps the other HUD agents`);
  }
  for (const id of gone) {
    assert.ok(HUD_IDS.includes(id), `${id} stays a section of the HUD snapshot`);
    assert.equal(MANIFESTS.find((m) => m.id === id).dismantled.on, "2026-11-11");
  }
});

// A4 (owner 2026-11-14: "lanjut"): the memo by evidence, in shadow.
test("A4: the evidence key counts, on a fresh call the prompt key missed, whether it had an answer and whether the model gave the same", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { evidenceShadow, resetEvidenceMemoSchemaCacheForTests, inputHash } = await import("../src/room-memo.mjs");
  const { memoComparison } = await import("../src/neuron-allocation.mjs");
  resetEvidenceMemoSchemaCacheForTests();
  const raw = new DatabaseSync(":memory:");
  const stmt = (sql, params = []) => ({ bind: (...a) => stmt(sql, a), async run() { raw.prepare(sql).run(...params); return {}; }, async first() { return raw.prepare(sql).get(...params) ?? null; }, async all() { return { results: raw.prepare(sql).all(...params) }; } });
  const db = { prepare: (sql) => stmt(sql) };
  const recorded = [];
  const record = async (r) => { recorded.push(r.outcome); };
  const now = Date.parse("2026-11-16T10:00:00Z");
  // The same evidence on two bars (the closes moved, the menu did not): one hash.
  const menu = [{ id: "L1", value: "trend up since [level]" }, { id: "candles_15m.range_ratio", value: 1.2 }];
  const h = await inputHash(["gemma", "war_room_opening", { menu, learned: null }]);
  const base = { kind: "warroom", step: "open:supertrend", hash: h, schemaName: "war_room_opening", model: "gemma", record };
  assert.equal(await evidenceShadow(db, { ...base, answer: { stance: "BUY", bias: "BULLISH" }, now }), "miss");
  assert.equal(await evidenceShadow(db, { ...base, answer: { stance: "BUY", bias: "BULLISH" }, now: now + 900_000 }), "same");
  assert.equal(await evidenceShadow(db, { ...base, answer: { stance: "WAIT", bias: "BULLISH" }, now: now + 1_800_000 }), "hit");
  // A prompt-key hit is the live memo's: not counted again here.
  assert.equal(await evidenceShadow(db, { ...base, answer: { stance: "WAIT", bias: "BULLISH" }, promptHit: true, now: now + 2_700_000 }), "prompt_hit");
  assert.deepEqual(recorded, ["memo_hit", "memo_same", "memo_hit"]);
  // Past the TTL: a miss again.
  assert.equal(await evidenceShadow(db, { ...base, answer: { stance: "WAIT", bias: "BULLISH" }, now: now + 3 * 86_400_000 }), "miss");
  // The readout: live calls and reuse beside the evidence key's hits and agreement.
  const [war] = memoComparison([
    { source: "war_room_opening", calls: 1000, reused: 400, neurons: 14000 },
    { source: "evidence_memo:war_room_opening", memo_hits: 300, memo_same: 270 }
  ], { days: 1 });
  assert.deepEqual([war.prompt_reuse_rate, war.evidence_hit_rate, war.evidence_same_rate, war.extra_neurons_per_day], [0.286, 0.3, 0.9, 3780]);
});

test("A4: through a room step: a prompt that changed with the same evidence still calls the model (the live memo is untouched) and counts an evidence hit", async () => {
  const { resetEvidenceMemoSchemaCacheForTests } = await import("../src/room-memo.mjs");
  resetEvidenceMemoSchemaCacheForTests();
  const { env, db, ai } = await setup({ ROOM_MEMO_ENABLED: "true" });
  const evidence = { menu: [{ id: "value_area", value: "inside" }], learned: null };
  await step(env, "2026-11-11T02:45:00.000Z", { data: "close 4012.10, value area: inside", evidence });
  const second = await step(env, "2026-11-11T03:00:00.000Z", { data: "close 4012.35, value area: inside", evidence });
  assert.equal(ai.calls.length, 2, "the prompt changed: the live memo calls the model");
  assert.equal(second.reused, undefined);
  const rows = (await db.prepare("SELECT source, memo_hits, memo_same FROM ai_usage_daily WHERE source LIKE 'evidence_memo:%'").all()).results;
  assert.deepEqual(rows.map((r) => [r.source, r.memo_hits, r.memo_same]), [["evidence_memo:war_room_opening", 1, 1]]);
  const u = await usage(db);
  assert.equal(u.memo_hits, 0, "the live memo's totals do not carry the evidence key's counts");
  // EVIDENCE_MEMO_SHADOW off: nothing is counted.
  const off = await setup({ EVIDENCE_MEMO_SHADOW: "off" });
  await step(off.env, "2026-11-11T02:45:00.000Z", { data: "a", evidence });
  await step(off.env, "2026-11-11T03:00:00.000Z", { data: "b", evidence });
  assert.equal((await off.db.prepare("SELECT COUNT(*) AS n FROM ai_usage_daily WHERE source LIKE 'evidence_memo:%'").first()).n, 0);
});
