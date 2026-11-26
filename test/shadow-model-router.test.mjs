// SB1, the shadow model router (owner 2026-11-25: "semua shadow pakai beam", then "news_compare saja"). Only the news
// shadow comparison's two readings may go to Beam, behind the FS1 switch SHADOW_MODEL_ROUTER (off by default); every
// limit, error and paid sign falls back to the Workers AI call of today. No test reaches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  routeShadowCall, shadowModelRouterMode, modelRouterConfig, routerCounters, routerLimitReached, readRouterEvents, resetModelRouterForTests,
  MODEL_ROUTER_DEFAULTS, MODEL_ROUTER_LIMITS, MODEL_ROUTER_MAX_TOKENS, MODEL_ROUTER_TIMEOUT_MS, MODEL_ROUTER_BREAKER, MODEL_ROUTER_AGENT,
  MODEL_ROUTER_CAPABILITIES, MODEL_ROUTER_PAID_KEY, MODEL_ROUTER_REASONS, MODEL_ROUTER_STATUS_CACHE_MS, readKernelStatus, paidSignalOf
} from "../src/model-router.mjs";
import { runNewsShadowCompare, cleanReading, NEWS_COMPARE_METER, MODEL_ROUTER_ALLOW } from "../src/news-shadow-compare.mjs";
import { shadowSpendToday, checkShadowBudget } from "../src/shadow-switch.mjs";
import { callBusModel, BUS_DEFAULT_MODEL } from "../src/model-call.mjs";
import { resetAiUsageSchemaCacheForTests } from "../src/ai-usage.mjs";
import { switchByKey, FEATURE_SWITCH_OVERRIDE_KEY } from "../src/feature-switches.mjs";
import { setFeatureSwitch, withFeatureSwitches, resetFeatureSwitchMemoForTests } from "../src/feature-switch-store.mjs";

const BEAM = MODEL_ROUTER_DEFAULTS.model;
const NIGHT = Date.parse("2026-11-25T21:10:00Z");
const SECRET_HEADLINE = "Zephyrquill headline marker 7731";
const SECRET_CATALYST = "Quasarbloom catalyst marker";
const READING = { gold_bias: "BEARISH", dollar_bias: "BULLISH", impact: "HIGH", catalysts: [SECRET_CATALYST] };
const items = {
  tv: [{ title: `${SECRET_HEADLINE}: US CPI rises more than expected`, published_at: "2026-11-25T13:30:00Z" }],
  shadow: [{ title: `${SECRET_HEADLINE}: gold falls after hot US inflation data`, source: "fxstreet", published_at: "2026-11-25T13:31:00Z" }]
};

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT)");
  const sql = [];
  return {
    raw: db, sql,
    prepare(text) {
      let params = [];
      const stmt = {
        bind(...a) { params = a.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { sql.push(text); const r = db.prepare(text).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { sql.push(text); return db.prepare(text).get(...params) ?? null; },
        async all() { sql.push(text); return { results: db.prepare(text).all(...params) }; }
      };
      return stmt;
    }
  };
}
function kv() {
  const m = new Map();
  return { m, reads: [], async get(k) { this.reads.push(k); return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } };
}
/** A model_router.status result as the kernel returns it (control-plane-shared/src/model-router.ts modelRouterStatus, 982971c). */
const statusResult = (state = "on", mode = "free_only") => ({
  schema: "model_router.status.v1", available: state !== null, system: "cryptophys", provider: "reflection", model: "Beam-1.0-501B-A23B", tasks: ["shadow"],
  configured: { var_on: false, key_present: false, base_url_valid: true },
  state: state === null ? null : { state, mode, paid_cap_usd: mode === "paid_capped" ? 5 : null, spent_usd: 0, updated_by: "agent:test", updated_at: "2026-11-25T20:00:00Z", reason: null },
  effective: "disabled", health: null, limits: {}, today: { day: "2026-11-25", requests: 0, in_tokens: 0, out_tokens: 0, this_minute: 0 }, ledger: [], fallbacks: {}, generated_at: "2026-11-25T21:10:00Z"
});
const kOn = () => ({ outcome: "succeeded", capability: "model_router.status", tier: 0, decision_id: null, result: statusResult("on", "free_only") });
/** report_paid as the kernel checks it (syscall.ts reportModelRouterPaid): only { signal }, one of the five; anything else throws. */
function reportPaidAnswer(payload) {
  const extra = Object.keys(payload ?? {}).filter((k) => k !== "signal");
  if (extra.length || !["http_402", "billing_error", "cost_field", "plan_change", "reported"].includes(payload?.signal)) return { outcome: "failed", reason: "model_router_report_invalid" };
  return { outcome: "succeeded", capability: "model_router.report_paid", tier: 2, decision_id: "d1", result: { changed: true } };
}
function kernel(status = kOn) {
  const calls = [];
  return { calls, async syscall(agent, capability, payload) { calls.push({ agent, capability, payload }); return capability === MODEL_ROUTER_CAPABILITIES.status ? status() : reportPaidAnswer(payload); } };
}
const reportPaidCalls = (k) => k.calls.filter((c) => c.capability === MODEL_ROUTER_CAPABILITIES.report_paid);
function fresh(over = {}) {
  resetAiUsageSchemaCacheForTests();
  resetModelRouterForTests();
  resetFeatureSwitchMemoForTests();
  return { DB: d1(), SIGNAL_CACHE: kv(), AGENTS: kernel(), SHADOW_MODEL_ROUTER: "on", REFLECTION_API_KEY: "test-key-not-real", NEWS_INGESTION: { shadowItems: async () => items }, ...over };
}
const answerBody = (obj = READING, usage = { prompt_tokens: 900, completion_tokens: 400 }) => ({ choices: [{ message: { content: JSON.stringify(obj) }, finish_reason: "stop" }], usage });
const beamResponse = (body = answerBody(), { status = 200, retention = "none" } = {}) => new Response(JSON.stringify(body), { status, headers: retention == null ? { "content-type": "application/json" } : { "content-type": "application/json", "reflection-data-retention": retention } });
function beam(respond = () => beamResponse()) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); return respond(url, init, calls.length); };
  f.calls = calls;
  return f;
}
/** console.* captured while `fn` runs (the lines, as text). */
async function capture(fn) {
  const lines = [];
  const keep = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(keep)) console[k] = (...a) => { lines.push(a.map(String).join(" ")); };
  try { return { value: await fn(), lines }; } finally { Object.assign(console, keep); }
}
/** One routed call of the news comparison's shape, its Workers AI fallback counted. */
async function route(env, { fetcher = beam(), at = NIGHT, timeoutMs = MODEL_ROUTER_TIMEOUT_MS } = {}) {
  let fellBack = 0;
  const out = await capture(() => routeShadowCall(env, {
    site: "news_compare", allow: MODEL_ROUTER_ALLOW, reading: "tv", messages: [{ role: "user", content: SECRET_HEADLINE }], meterSource: NEWS_COMPARE_METER,
    accept: cleanReading, fallback: async () => { fellBack += 1; return { from: "workers_ai" }; },
    spendToday: () => shadowSpendToday(env.DB, { now: at }), fetcher, clock: () => at, timeoutMs
  }));
  return { ...out.value, fellBack, lines: out.lines, fetched: fetcher.calls?.length ?? 0 };
}
const beamRows = (env) => env.DB.raw.prepare("SELECT * FROM ai_usage_daily WHERE model = ?").all(BEAM);
const hasTable = (env, name) => Boolean(env.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const workersAi = () => {
  const runs = [];
  return { runs, run: async (model, inputs) => { runs.push({ model, inputs: JSON.parse(JSON.stringify(inputs)) }); return { response: { ...READING, catalysts: ["CPI"] }, usage: { prompt_tokens: 800, completion_tokens: 120 } }; } };
};
async function withFetchTrap(fn) {
  const hits = [];
  const keep = globalThis.fetch;
  globalThis.fetch = async (url) => { hits.push(String(url)); throw new Error("no network in tests"); };
  try { return { value: await fn(), hits }; } finally { globalThis.fetch = keep; }
}

// ---------------------------------------------------------------- 1. off is byte-identical

test("SB1-1 off (the default) is byte-identical: no router read, no Beam fetch, the same Workers AI calls and D1 statements", async () => {
  assert.equal(switchByKey("SHADOW_MODEL_ROUTER").default_value, "off");
  assert.equal(shadowModelRouterMode({}), "off");
  for (const raw of [undefined, "", "off", "OFF", "true", "bogus"]) assert.equal(shadowModelRouterMode(raw === undefined ? {} : { SHADOW_MODEL_ROUTER: raw }), "off", String(raw));
  assert.doesNotMatch(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"), /SHADOW_MODEL_ROUTER|REFLECTION_API_KEY/, "off until the owner turns it on in FS1");
  const runOnce = async (over) => {
    const ai = workersAi();
    const env = { ...fresh({ AI: ai, AGENTS: kernel() }), ...over };
    const { value, hits } = await withFetchTrap(() => runNewsShadowCompare(env, { now: NIGHT }));
    return { value, hits, runs: ai.runs, sql: env.DB.sql, agents: env.AGENTS.calls, kvReads: env.SIGNAL_CACHE.reads, events: hasTable(env, "model_router_events"), rows: env.DB.raw.prepare("SELECT source, model, calls, prompt_tokens, completion_tokens FROM ai_usage_daily").all() };
  };
  // As on main: none of the router's variables. Then the switch off with a key set, and unset with a key set.
  const main = await runOnce({ SHADOW_MODEL_ROUTER: undefined, REFLECTION_API_KEY: undefined });
  for (const over of [{ SHADOW_MODEL_ROUTER: "off" }, { SHADOW_MODEL_ROUTER: undefined }, { SHADOW_MODEL_ROUTER: "bogus", MODEL_ID: "other-model" }]) {
    const off = await runOnce(over);
    assert.equal(off.value.status, "compared");
    assert.deepEqual(off.value, main.value, JSON.stringify(over));
    assert.deepEqual(off.runs, main.runs, "the same Workers AI requests, byte for byte");
    assert.deepEqual(off.sql, main.sql, "the same D1 statements in the same order");
    assert.deepEqual(off.rows, main.rows, "the same meter rows");
    assert.deepEqual([off.hits, off.agents, off.events], [[], [], false], "no fetch, no kernel call, no router table");
    assert.deepEqual(off.kvReads, main.kvReads, "no extra KV read");
  }
  assert.equal(main.runs.length, 2);
  assert.ok(main.runs.every((r) => r.model === BUS_DEFAULT_MODEL), "the agent model of today");
  assert.ok(main.rows.every((r) => r.source === NEWS_COMPARE_METER && r.model === BUS_DEFAULT_MODEL));
});

// ---------------------------------------------------------------- 2. on routes news_compare only

test("SB1-2 on: both news_compare readings go to Beam (low effort, the hard cap), metered under Beam; no Workers AI call", async () => {
  const ai = workersAi();
  const env = fresh({ AI: ai });
  const fetcher = beam();
  const r = await runNewsShadowCompare(env, { now: NIGHT, router: { fetcher, clock: () => NIGHT } });
  assert.equal(r.status, "compared");
  assert.equal(fetcher.calls.length, 2, "the TradingView set and the free set");
  assert.equal(ai.runs.length, 0);
  for (const c of fetcher.calls) {
    assert.equal(c.url, `${MODEL_ROUTER_DEFAULTS.base}/chat/completions`);
    assert.deepEqual([c.body.model, c.body.max_completion_tokens, c.body.reasoning_effort], [BEAM, MODEL_ROUTER_MAX_TOKENS, "low"]);
    assert.equal(c.headers.authorization, "Bearer test-key-not-real");
  }
  assert.deepEqual(beamRows(env).map((x) => [x.source, x.calls, x.prompt_tokens, x.completion_tokens]), [[NEWS_COMPARE_METER, 2, 1800, 800]]);
  assert.deepEqual((await readRouterEvents(env.DB)).map((e) => [e.reading, e.outcome, e.day]).sort(), [["free", "routed", "2026-11-25"], ["tv", "routed", "2026-11-25"]]);
  assert.ok(env.AGENTS.calls.every((c) => c.agent === MODEL_ROUTER_AGENT && c.agent === "xauusd-model-router"), "the kernel calls are the router agent's");
  // The settings: MODEL_BASE_URL and MODEL_ID; no key, no call.
  assert.deepEqual(modelRouterConfig({ MODEL_BASE_URL: "http://x", MODEL_ID: "m" }), { base: MODEL_ROUTER_DEFAULTS.base, model: "m", has_key: false });
  const noKey = await route(fresh({ REFLECTION_API_KEY: "" }));
  assert.deepEqual([noKey.reason, noKey.fetched, noKey.fellBack], ["no_key", 0, 1]);
  // A site outside its own allow-list never routes.
  const other = await capture(() => routeShadowCall(fresh(), { site: "metric_opening", allow: MODEL_ROUTER_ALLOW, messages: [], meterSource: "shadow:metric_opening", accept: cleanReading, fallback: async () => "wa", fetcher: beam() }));
  assert.deepEqual([other.value.via, other.value.reason], ["workers_ai", "not_allowed"]);
});

test("SB1-2b on: metric_opening, the note arm, the benched seats and decision_council still call Workers AI; only the news comparison calls the router", async () => {
  const sources = ["shadow:metric_opening", "shadow:war_room_opening", "shadow:tf_room_opening", "decision_council", "war_room_opening", "shadow:arena:decision_council"];
  for (const meterSource of sources) {
    const ai = workersAi();
    const env = fresh({ AI: ai });
    const { value, hits } = await withFetchTrap(() => callBusModel(env, { messages: [{ role: "user", content: "u" }], schemaName: "x", schema: { type: "object" }, maxTokens: 100, effort: "low", deadline: Date.now() + 60_000, clock: () => Date.now(), runState: {}, role: "agent", meterSource }));
    assert.equal(value.status, "answered", meterSource);
    assert.deepEqual([ai.runs.length, ai.runs[0].model, hits.length, env.AGENTS.calls.length], [1, BUS_DEFAULT_MODEL, 0, 0], meterSource);
  }
  // Selected by call site: the router's call is made in one module, and the shared model call never reads the switch.
  const src = new URL("../src/", import.meta.url);
  const files = readdirSync(src).filter((f) => /\.(mjs|ts)$/.test(f) && !f.endsWith(".d.mts"));
  const text = (f) => readFileSync(new URL(f, src), "utf8");
  assert.deepEqual(files.filter((f) => /from "\.\/model-router\.mjs"/.test(text(f))).sort(), ["news-shadow-compare.mjs", "shadow-switch.mjs"]);
  assert.deepEqual(files.filter((f) => /routeShadowCall\(/.test(text(f))).sort(), ["model-router.mjs", "news-shadow-compare.mjs"]);
  assert.doesNotMatch(text("shadow-switch.mjs"), /routeShadowCall/, "the breaker reads the counters only");
  assert.deepEqual([...MODEL_ROUTER_ALLOW], ["news_compare"]);
  assert.doesNotMatch(text("model-router.mjs"), /startsWith\("shadow:|meterSource\.(startsWith|match)|SHADOW_METER_PREFIX/, "never selected by the source prefix");
});

// ---------------------------------------------------------------- 3. every fallback trigger

const fellBackWith = (r, reason) => {
  assert.equal(r.via, "workers_ai", reason);
  assert.equal(r.reason, reason);
  assert.equal(r.fellBack, 1, `${reason}: the Workers AI call ran once`);
  assert.deepEqual(r.value, { from: "workers_ai" });
  assert.ok(r.lines.some((l) => l.startsWith("model_router_fallback") && l.includes(`"reason":"${reason}"`)), `${reason}: logged`);
  assert.ok(MODEL_ROUTER_REASONS.includes(reason), reason);
};

test("SB1-3a unreachable: a 25 s timeout and a network error fall back; 3 failures in 15 minutes open the breaker for the rest of that window", async () => {
  assert.equal(MODEL_ROUTER_TIMEOUT_MS, 25_000);
  assert.deepEqual({ ...MODEL_ROUTER_BREAKER }, { failures: 3, window_ms: 15 * 60_000 });
  const env = fresh();
  const hang = beam((url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))));
  const t0 = Date.parse("2026-11-25T21:00:00Z");
  // AbortSignal.timeout's timer does not hold node's event loop open; this one does while the call waits.
  const alive = setTimeout(() => {}, 2_000);
  const r1 = await route(env, { fetcher: hang, at: t0, timeoutMs: 15 });
  clearTimeout(alive);
  fellBackWith(r1, "timeout");
  const down = beam(() => { throw new TypeError("fetch failed"); });
  fellBackWith(await route(env, { fetcher: down, at: t0 + 61_000 }), "unreachable");
  fellBackWith(await route(env, { fetcher: down, at: t0 + 122_000 }), "unreachable");
  const ok = beam();
  const open = await route(env, { fetcher: ok, at: t0 + 183_000 });
  fellBackWith(open, "breaker_open");
  assert.equal(ok.calls.length, 0, "the breaker sends nothing");
  fellBackWith(await route(env, { fetcher: ok, at: t0 + 15 * 60_000 - 1 }), "breaker_open");
  const next = await route(env, { fetcher: ok, at: t0 + 15 * 60_000 });
  assert.deepEqual([next.via, ok.calls.length], ["beam", 1], "the next window closes it");
  assert.deepEqual(beamRows(env).map((x) => [x.calls, x.failed, x.timeouts]), [[1, 2, 1]], "every request metered under Beam");
});

test("SB1-3b a 429 falls back, with no paid report", async () => {
  const env = fresh();
  const r = await route(env, { fetcher: beam(() => beamResponse({ error: { code: "rate_limit_exceeded", message: "Too many requests" } }, { status: 429 })) });
  fellBackWith(r, "rate_limited");
  assert.equal(reportPaidCalls(env.AGENTS).length, 0);
});

test("SB1-3c Beam's own counters: 100k input, 20k output (this call's cap reserved), 20 requests a day, 2 a minute", async () => {
  assert.deepEqual({ ...MODEL_ROUTER_LIMITS }, { tokens_in_day: 100_000, tokens_out_day: 20_000, requests_day: 20, rpm: 2 });
  const seed = (env, p, c) => env.DB.raw.prepare("INSERT INTO ai_usage_daily (day, source, model, calls, prompt_tokens, completion_tokens) VALUES (?, ?, ?, ?, ?, ?)").run("2026-11-25", NEWS_COMPARE_METER, BEAM, 1, p, c);
  for (const [p, c, reason] of [[100_000, 0, "limit_tokens_in"], [0, 20_000 - MODEL_ROUTER_MAX_TOKENS + 1, "limit_tokens_out"]]) {
    const env = fresh();
    await shadowSpendToday(env.DB, { now: NIGHT }); // the meter's table
    seed(env, p, c);
    const f = beam();
    fellBackWith(await route(env, { fetcher: f }), reason);
    assert.equal(f.calls.length, 0);
  }
  {
    const env = fresh();
    await shadowSpendToday(env.DB, { now: NIGHT });
    seed(env, 99_999, 20_000 - MODEL_ROUTER_MAX_TOKENS);
    assert.equal((await route(env)).via, "beam", "just under both limits");
  }
  // 20 requests a day (one a minute and a bit), then the 21st falls back.
  const env = fresh();
  const f = beam(() => beamResponse(answerBody(READING, { prompt_tokens: 10, completion_tokens: 10 })));
  const start = Date.parse("2026-11-25T00:00:00Z");
  for (let i = 0; i < 20; i++) assert.equal((await route(env, { fetcher: f, at: start + i * 61_000 })).via, "beam", `request ${i + 1}`);
  fellBackWith(await route(env, { fetcher: f, at: start + 20 * 61_000 }), "limit_requests_day");
  assert.equal(f.calls.length, 20);
  assert.equal((await route(env, { fetcher: f, at: start + 86_400_000 })).via, "beam", "a new UTC day");
  // 2 a minute.
  const rpm = fresh();
  const g = beam();
  assert.equal((await route(rpm, { fetcher: g, at: NIGHT })).via, "beam");
  assert.equal((await route(rpm, { fetcher: g, at: NIGHT + 1_000 })).via, "beam");
  fellBackWith(await route(rpm, { fetcher: g, at: NIGHT + 2_000 }), "limit_rpm");
  assert.equal((await route(rpm, { fetcher: g, at: NIGHT + 60_001 })).via, "beam");
  assert.deepEqual(routerLimitReached(null), null);
});

test("SB1-3d paid signs (402, a billing error, a cost above 0) fall back and call report_paid exactly once", async () => {
  const cases = [
    ["paid_402", () => beamResponse({ error: { code: "payment_required", message: "Payment required" } }, { status: 402 })],
    ["paid_billing", () => beamResponse({ error: { code: "invalid_request", type: "billing_error", message: "Your credit balance is too low" } }, { status: 400 })],
    ["paid_cost", () => beamResponse({ ...answerBody(), usage: { prompt_tokens: 900, completion_tokens: 400, cost: 0.0012 } })]
  ];
  for (const [reason, respond] of cases) {
    const env = fresh();
    const f = beam(respond);
    fellBackWith(await route(env, { fetcher: f }), reason);
    const paid = reportPaidCalls(env.AGENTS);
    assert.equal(paid.length, 1, reason);
    assert.deepEqual(paid[0], { agent: "xauusd-model-router", capability: "model_router.report_paid", payload: { signal: { paid_402: "http_402", paid_billing: "billing_error", paid_cost: "cost_field" }[reason] } });
    assert.equal(JSON.parse(env.SIGNAL_CACHE.m.get(MODEL_ROUTER_PAID_KEY)).reason, reason);
    // The next call is held: no request, no second report.
    fellBackWith(await route(env, { fetcher: f, at: NIGHT + 1_000 }), "paid_hold");
    assert.deepEqual([f.calls.length, reportPaidCalls(env.AGENTS).length], [1, 1], reason);
  }
});

test("SB1-3e the kernel's model_router.status not on: off, refused, failed, unreachable or unreadable all fall back (60 s cache)", async () => {
  const answers = [
    ["kernel_off", () => ({ outcome: "succeeded", result: statusResult("off_paid", "free_only") })],
    ["kernel_off", () => ({ outcome: "succeeded", result: statusResult("off", "free_only") })],
    ["kernel_paid_capped", () => ({ outcome: "succeeded", result: statusResult("on", "paid_capped") })],
    ["kernel_unknown", () => ({ outcome: "succeeded", result: statusResult(null) })],
    ["kernel_unknown", () => ({ outcome: "succeeded", result: { status: "on" } })],
    ["kernel_unknown", () => ({ outcome: "denied", reason: "capability_not_granted" })],
    ["kernel_unknown", () => ({ outcome: "failed", reason: "unknown_capability" })],
    ["kernel_unknown", () => { throw new Error("rpc down"); }],
    ["kernel_unknown", () => ({ outcome: "succeeded", result: { ...statusResult(), state: { state: "maybe", mode: "free_only" } } })],
    ["kernel_unknown", () => ({ outcome: "succeeded" })]
  ];
  for (const [reason, status] of answers) {
    const env = fresh({ AGENTS: kernel(status) });
    const f = beam();
    fellBackWith(await route(env, { fetcher: f }), reason);
    assert.equal(f.calls.length, 0, reason);
  }
  const noBinding = fresh({ AGENTS: undefined });
  fellBackWith(await route(noBinding), "kernel_unknown");
  // The 60 s cache: one status read per minute per isolate.
  assert.equal(MODEL_ROUTER_STATUS_CACHE_MS, 60_000);
  let state = "off";
  const env = fresh({ AGENTS: kernel(() => ({ outcome: "succeeded", result: statusResult(state === "off" ? "off_paid" : state, "free_only") })) });
  fellBackWith(await route(env, { at: NIGHT }), "kernel_off");
  state = "on";
  fellBackWith(await route(env, { at: NIGHT + 59_000 }), "kernel_off");
  assert.equal((await route(env, { at: NIGHT + 60_000 })).via, "beam");
  assert.equal(env.AGENTS.calls.filter((c) => c.capability === MODEL_ROUTER_CAPABILITIES.status).length, 2);
});

test("SB1-3f retention: no reflection-data-retention header, or \"contributor\", falls back", async () => {
  fellBackWith(await route(fresh(), { fetcher: beam(() => beamResponse(answerBody(), { retention: null })) }), "retention_missing");
  fellBackWith(await route(fresh(), { fetcher: beam(() => beamResponse(answerBody(), { retention: "Contributor" })) }), "retention_contributor");
  assert.equal((await route(fresh(), { fetcher: beam(() => beamResponse(answerBody(), { retention: "zero" })) })).via, "beam");
});

test("SB1-3g an invalid answer (the same parse and cleanReading as today) falls back", async () => {
  const bad = [
    { choices: [{ message: { content: "no JSON here" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } },
    answerBody({ gold_bias: "UP", dollar_bias: "BEARISH", impact: "HIGH", catalysts: [] }),
    { choices: [{ message: { content: null }, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: MODEL_ROUTER_MAX_TOKENS } },
    null
  ];
  for (const body of bad) fellBackWith(await route(fresh(), { fetcher: beam(() => (body == null ? new Response("<html>", { status: 200, headers: { "reflection-data-retention": "none" } }) : beamResponse(body))) }), "invalid_answer");
  const env = fresh();
  fellBackWith(await route(env, { fetcher: beam(() => beamResponse(null, { status: 503 })) }), "http_5xx");
  fellBackWith(await route(env, { fetcher: beam(() => beamResponse({ error: { code: "bad_request" } }, { status: 400 })), at: NIGHT + 61_000 }), "http_4xx");
});

test("SB1-3h on, a reading that falls back runs the Workers AI call of today, unchanged", async () => {
  const ai = workersAi();
  const env = fresh({ AI: ai, AGENTS: kernel(() => ({ outcome: "denied", reason: "capability_not_granted" })) });
  const off = workersAi();
  const offEnv = fresh({ AI: off, SHADOW_MODEL_ROUTER: "off" });
  const r = await runNewsShadowCompare(env, { now: NIGHT, router: { fetcher: beam(), clock: () => NIGHT } });
  await runNewsShadowCompare(offEnv, { now: NIGHT });
  assert.equal(r.status, "compared");
  assert.deepEqual(ai.runs, off.runs, "the same Workers AI requests as with the switch off");
  assert.deepEqual((await readRouterEvents(env.DB)).map((e) => e.reason).sort(), ["kernel_unknown", "kernel_unknown"]);
});

// ---------------------------------------------------------------- 4. paid signs hold routing off until the kernel reads on

test("SB1-4 a paid sign turns routing off until the kernel's status reads on again (in this isolate and in a new one)", async () => {
  let state = "on";
  const env = fresh({ AGENTS: kernel(() => ({ outcome: "succeeded", result: statusResult(state === "off" ? "off_paid" : state, "free_only") })) });
  let paid = true;
  const f = beam(() => (paid ? beamResponse({ error: { code: "payment_required" } }, { status: 402 }) : beamResponse()));
  fellBackWith(await route(env, { fetcher: f, at: NIGHT }), "paid_402");
  paid = false;
  // The platform turned the router off org-wide; within the cache window this isolate holds it off itself.
  state = "off";
  fellBackWith(await route(env, { fetcher: f, at: NIGHT + 30_000 }), "paid_hold");
  fellBackWith(await route(env, { fetcher: f, at: NIGHT + 90_000 }), "paid_hold");
  // The kernel's status still "on" within the cache (the report not applied yet): still held.
  state = "on";
  fellBackWith(await route(env, { fetcher: f, at: NIGHT + 120_000 }), "paid_hold");
  assert.equal(f.calls.length, 1);
  // Read after the cache: on again, routing resumes and the hold is cleared.
  assert.equal((await route(env, { fetcher: f, at: NIGHT + 151_000 })).via, "beam");
  assert.equal(env.SIGNAL_CACHE.m.has(MODEL_ROUTER_PAID_KEY), false);
  assert.equal(reportPaidCalls(env.AGENTS).length, 1, "reported once");
  // Another isolate (a fresh cache) sees the stored hold and reads the kernel before routing.
  const env2 = fresh({ AGENTS: kernel(() => ({ outcome: "succeeded", result: statusResult(state === "off" ? "off_paid" : state, "free_only") })) });
  env2.SIGNAL_CACHE.m.set(MODEL_ROUTER_PAID_KEY, JSON.stringify({ at: NIGHT - 1, reason: "paid_cost", reported: true }));
  state = "off";
  fellBackWith(await route(env2, { at: NIGHT }), "paid_hold");
  resetModelRouterForTests();
  state = "on";
  assert.equal((await route(env2, { at: NIGHT + 1 })).via, "beam");
});

// ---------------------------------------------------------------- 5. the shadow breaker sees Beam's counters

test("SB1-5 the shadow breaker reads Beam's counters: no zero-priced pass", async () => {
  const env = fresh();
  await shadowSpendToday(env.DB, { now: NIGHT });
  const ins = env.DB.raw.prepare("INSERT INTO ai_usage_daily (day, source, model, calls, prompt_tokens, completion_tokens) VALUES (?, ?, ?, ?, ?, ?)");
  ins.run("2026-11-25", NEWS_COMPARE_METER, BEAM, 12, 99_000, 18_500);
  ins.run("2026-11-25", "shadow:metric_opening", BUS_DEFAULT_MODEL, 3, 3000, 300);
  const spend = await shadowSpendToday(env.DB, { now: NIGHT });
  assert.deepEqual(spend.beam, { model: BEAM, calls: 12, requests: 12, tokens_in: 99_000, tokens_out: 18_500, limits: { ...MODEL_ROUTER_LIMITS }, at_limit: "limit_tokens_out" });
  assert.equal(spend.unpriced_tokens, 0, "a Beam row is not an unpriced pass");
  assert.equal(spend.calls, 15);
  const budget = await capture(() => checkShadowBudget(env, { now: NIGHT }));
  assert.equal(budget.value.status, "within_budget");
  assert.deepEqual(budget.value.beam, spend.beam, "the hourly breaker reports Beam's counters");
  assert.ok(budget.lines.some((l) => l.startsWith("model_router_limit") && l.includes("limit_tokens_out")));
  // The router's day limit is the breaker's reading.
  const f = beam();
  fellBackWith(await route(env, { fetcher: f }), "limit_tokens_out");
  assert.equal(f.calls.length, 0);
  // No Beam row: the breaker's reading is exactly as before (no beam key).
  assert.equal("beam" in (await shadowSpendToday(fresh().DB, { now: NIGHT })), false);
  assert.deepEqual(routerCounters([{ model: "@cf/x", calls: 1, p: 1, c: 1 }]), null);
});

// ---------------------------------------------------------------- 6. no prompt or answer in any log or meter row

test("SB1-6 no prompt or answer text in any log line, ai_usage_daily row or router event", async () => {
  const env = fresh({ AI: workersAi() });
  let n = 0;
  const f = beam(() => { n += 1; return n === 1 ? beamResponse() : beamResponse({ error: { code: "x", message: `echo ${SECRET_HEADLINE}` } }, { status: 500 }); });
  const { value, lines } = await capture(() => runNewsShadowCompare(env, { now: NIGHT, router: { fetcher: f, clock: () => NIGHT } }));
  assert.equal(value.status, "compared");
  const stored = JSON.stringify([env.DB.raw.prepare("SELECT * FROM ai_usage_daily").all(), env.DB.raw.prepare("SELECT * FROM model_router_events").all(), lines]);
  for (const secret of [SECRET_HEADLINE, SECRET_CATALYST, "US CPI", "test-key-not-real", "Bearer"]) assert.ok(!stored.includes(secret), secret);
  assert.ok(lines.some((l) => l.includes('"reason":"http_5xx"')), "the reason code is logged");
});

// ---------------------------------------------------------------- 7. the switch date

test("SB1-7 the switch date: FS1's audit row marks each flip; each reading's route and day are in model_router_events", async () => {
  const OWNER = "owner-sub-test";
  const env = fresh({ OWNER_ACCESS_SUB: OWNER, SHADOW_MODEL_ROUTER: undefined });
  const on = await setFeatureSwitch(env, { key: "SHADOW_MODEL_ROUTER", value: "on", actor: "owner", actor_sub: OWNER, now: NIGHT - 3_600_000 });
  assert.deepEqual([on.ok, on.changed, on.switch.value, on.switch.source], [true, true, "on", "override"]);
  const resolved = await withFeatureSwitches(env, { now: NIGHT });
  assert.equal(shadowModelRouterMode(resolved), "on", "the run's env carries the owner's override");
  assert.equal(JSON.parse(env.SIGNAL_CACHE.m.get(FEATURE_SWITCH_OVERRIDE_KEY)).SHADOW_MODEL_ROUTER.value, "on");
  const r = await runNewsShadowCompare(resolved, { now: NIGHT, router: { fetcher: beam(), clock: () => NIGHT } });
  assert.equal(r.status, "compared");
  const off = await setFeatureSwitch(env, { key: "SHADOW_MODEL_ROUTER", value: "off", actor: "owner", actor_sub: OWNER, now: NIGHT + 3_600_000 });
  assert.equal(off.changed, true);
  const audit = env.DB.raw.prepare("SELECT ms, action, detail FROM omega_events WHERE action = 'feature_switch' ORDER BY id").all().map((x) => ({ ms: x.ms, ...JSON.parse(x.detail) }));
  assert.deepEqual(audit.map((a) => [a.ms, a.key, a.from, a.to]), [[NIGHT - 3_600_000, "SHADOW_MODEL_ROUTER", "off", "on"], [NIGHT + 3_600_000, "SHADOW_MODEL_ROUTER", "on", "off"]]);
  const events = await readRouterEvents(env.DB);
  assert.deepEqual(events.map((e) => [e.day, e.site, e.outcome, e.model]), [["2026-11-25", "news_compare", "routed", BEAM], ["2026-11-25", "news_compare", "routed", BEAM]]);
});

test("SB1-4b a paid sign whose report_paid failed holds routing, even with the kernel on, and is reported again until it lands", async () => {
  let reportOk = false;
  const calls = [];
  const AGENTS = { calls, async syscall(agent, capability, payload) {
    calls.push({ agent, capability, payload });
    if (capability === MODEL_ROUTER_CAPABILITIES.status) return kOn();
    return reportOk ? { outcome: "succeeded", result: {} } : { outcome: "failed", reason: "unreachable" };
  } };
  const env = fresh({ AGENTS });
  let paid = true;
  const f = beam(() => (paid ? beamResponse({ error: { code: "payment_required" } }, { status: 402 }) : beamResponse()));
  fellBackWith(await route(env, { fetcher: f, at: NIGHT }), "paid_402");
  assert.equal(JSON.parse(env.SIGNAL_CACHE.m.get(MODEL_ROUTER_PAID_KEY)).reported, false);
  paid = false;
  // Far past the status cache, the kernel reads "on", but the switch-off never landed: held, reported again.
  fellBackWith(await route(env, { fetcher: f, at: NIGHT + 120_000 }), "paid_hold");
  fellBackWith(await route(env, { fetcher: f, at: NIGHT + 240_000 }), "paid_hold");
  assert.equal(reportPaidCalls(AGENTS).length, 3, "the first report and two retries");
  assert.equal(f.calls.length, 1, "no request to Beam while held");
  // The retry lands: still held on that call, then the normal rule (a status read after it says "on").
  reportOk = true;
  fellBackWith(await route(env, { fetcher: f, at: NIGHT + 360_000 }), "paid_hold");
  assert.equal(JSON.parse(env.SIGNAL_CACHE.m.get(MODEL_ROUTER_PAID_KEY)).reported, true);
  assert.equal(reportPaidCalls(AGENTS).length, 4);
  assert.equal((await route(env, { fetcher: f, at: NIGHT + 480_000 })).via, "beam");
  assert.equal(reportPaidCalls(AGENTS).length, 4, "no report once it landed");
});

// ---------------------------------------------------------------- 8. the kernel's real shapes (platform 982971c)

test("SB1-8a model_router.status: only state on with mode free_only routes; paid_capped, off_* and a null state never do; effective is not read", () => {
  assert.deepEqual(readKernelStatus(statusResult("on", "free_only")), { status: "on", detail: null });
  assert.equal(statusResult("on", "free_only").effective, "disabled", "the kernel's own var and key say disabled: ignored");
  assert.equal(readKernelStatus(statusResult("on", "paid_capped")).status, "paid_capped");
  for (const st of ["off", "off_paid", "off_owner", "off_retention"]) assert.equal(readKernelStatus(statusResult(st, "free_only")).status, "off", st);
  assert.deepEqual(readKernelStatus(statusResult(null)), { status: "unknown", detail: "no_state" });
  for (const bad of [null, undefined, {}, { status: "on" }, { schema: "model_router.status.v1", state: "on" }, { ...statusResult(), schema: "other" }, { ...statusResult(), state: { state: "on", mode: "free" } }])
    assert.equal(readKernelStatus(bad).status, "unknown", JSON.stringify(bad));
});

test("SB1-8b model_router.report_paid sends { signal } only, mapped from the paid reason; a refused report keeps routing held", async () => {
  assert.deepEqual(["paid_402", "paid_billing", "paid_cost", "paid_plan", "anything"].map(paidSignalOf), ["http_402", "billing_error", "cost_field", "plan_change", "reported"]);
  // The kernel's own rule (the fixture copies syscall.ts): an extra key is refused, { signal } accepted.
  assert.equal(reportPaidAnswer({ signal: "http_402", model: BEAM }).outcome, "failed");
  assert.equal(reportPaidAnswer({ signal: "paid_cap_reached" }).outcome, "failed");
  assert.equal(reportPaidAnswer({ signal: "cost_field" }).outcome, "succeeded");
  // Accepted: the stored hold reads reported, and the payload has the one key.
  const env = fresh();
  fellBackWith(await route(env, { fetcher: beam(() => beamResponse({ error: { code: "payment_required" } }, { status: 402 })), at: NIGHT }), "paid_402");
  const [sent] = reportPaidCalls(env.AGENTS);
  assert.deepEqual(Object.keys(sent.payload), ["signal"]);
  assert.equal(JSON.parse(env.SIGNAL_CACHE.m.get(MODEL_ROUTER_PAID_KEY)).reported, true);
  // Refused (a kernel that rejects every report): never reported, held even with the kernel on, retried each call.
  const refusing = { calls: [], async syscall(agent, capability, payload) { this.calls.push({ agent, capability, payload }); return capability === MODEL_ROUTER_CAPABILITIES.status ? kOn() : { outcome: "failed", reason: "model_router_report_invalid" }; } };
  const env2 = fresh({ AGENTS: refusing });
  const f = beam(() => beamResponse({ error: { code: "payment_required" } }, { status: 402 }));
  fellBackWith(await route(env2, { fetcher: f, at: NIGHT }), "paid_402");
  assert.equal(JSON.parse(env2.SIGNAL_CACHE.m.get(MODEL_ROUTER_PAID_KEY)).reported, false);
  fellBackWith(await route(env2, { fetcher: f, at: NIGHT + 120_000 }), "paid_hold");
  assert.equal(f.calls.length, 1);
  assert.equal(reportPaidCalls(refusing).length, 2);
});
