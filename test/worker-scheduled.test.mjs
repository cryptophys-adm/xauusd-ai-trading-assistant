// The AI Worker's cron handlers, run for real: src/index.ts is bundled with esbuild (as
// wrangler does) and its exported scheduled() is called with a D1 over node:sqlite, Map KV,
// a captured queue and a fake Workers AI. Unit tests cover the modules one by one; this test
// proves the deployed entry point wires them together (a cron that imports or calls the
// wrong thing passes every unit test and fails only in production, as the pull adapter's
// M5 publisher once did).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// The crons act on "the last closed candle" and the worker analyses nothing while the market is closed, so
// on the wall clock these tests failed every weekend (found 2026-11-13, a Friday after the 22:00 UTC
// close). The file's clock starts on a Wednesday in the London session and runs on from there; each test
// file has its own process, so no other test sees it.
{
  const RealDate = Date;
  const shift = RealDate.UTC(2026, 10, 11, 10, 7, 0) - RealDate.now();
  globalThis.Date = class extends RealDate {
    constructor(...args) { if (args.length === 0) super(RealDate.now() + shift); else super(...args); }
    static now() { return RealDate.now() + shift; }
  };
}

const root = fileURLToPath(new URL("..", import.meta.url));
const SECRET = "test-only-secret";
const SYMBOL = "OANDA:XAUUSD";

async function loadWorker() {
  const out = await build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent",
    alias: { "cloudflare:workers": join(root, "test/support/cloudflare-workers-stub.mjs") }
  });
  const dir = await mkdtemp(join(tmpdir(), "ai-worker-"));
  const file = join(dir, "worker.mjs");
  await writeFile(file, out.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  await rm(dir, { recursive: true, force: true });
  return mod.default;
}

async function d1() {
  const db = new DatabaseSync(":memory:");
  const dir = join(root, "migrations");
  db.exec(await readFile(join(root, "schema.sql"), "utf8"));
  for (const name of (await readdir(dir)).filter(n => n.endsWith(".sql")).sort()) db.exec(await readFile(join(dir, name), "utf8"));
  const statement = (sql, params = []) => ({
    bind: (...args) => statement(sql, args.map(v => (v === undefined ? null : v))),
    async run() { const r = db.prepare(sql).run(...params); return { success: true, meta: { changes: Number(r.changes) } }; },
    async first(column) { const row = db.prepare(sql).get(...params) ?? null; return column && row ? row[column] : row; },
    async all() { return { success: true, results: db.prepare(sql).all(...params) }; }
  });
  return {
    db,
    prepare: (sql) => statement(sql),
    async batch(list) { return Promise.all(list.map(s => s.run())); },
    async exec(sql) { db.exec(sql); return { count: 1 }; }
  };
}

function kv() {
  const map = new Map();
  return {
    map,
    async get(key, type) { if (!map.has(key)) return null; const v = map.get(key); return type === "json" || type?.type === "json" ? JSON.parse(v) : v; },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); },
    async list({ prefix = "" } = {}) { return { keys: [...map.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; }
  };
}

/** Workers AI stand-in: every chat answers with a fail-closed WAIT in the shapes the chain parses. */
function fakeAI() {
  const calls = [];
  const answer = JSON.stringify({
    decision: "WAIT", confidence: 0.4, bias: "NEUTRAL", stance: "WAIT",
    reasoning: "No trade for this candle: the evidence is incomplete.",
    summary: "No trade for this candle: the evidence is incomplete.",
    insight: "No trade for this candle: the evidence is incomplete.",
    refs: ["h1"], risks: [], key_levels: [], trade_plan: null
  });
  return {
    calls,
    async run(model, input) { calls.push(model); return { response: answer, choices: [{ message: { content: answer } }], usage: { total_tokens: 10 } }; }
  };
}

async function workerEnv() {
  const sent = [];
  return {
    sent,
    env: {
      DB: await d1(), WEBHOOK_BUFFER: kv(), SIGNAL_CACHE: kv(), AI: fakeAI(),
      XAUUSD_EVENTS: { async send(body) { sent.push(body); }, async sendBatch(list) { sent.push(...list.map(m => m.body)); } },
      WEBHOOK_SECRET: SECRET, INDICATOR_SOURCE: "local", PARITY_PROMOTE_AFTER: "1", ANALYSIS_TIMEFRAMES: "60"
    }
  };
}

function execution() {
  const pending = [];
  return { ctx: { waitUntil: (p) => pending.push(p), passThroughOnException() {} }, settle: () => Promise.all(pending) };
}

function captureConsole() {
  const lines = { log: [], error: [] };
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => lines.log.push(a.join(" "));
  console.warn = (...a) => lines.log.push(a.join(" "));
  console.error = (...a) => lines.error.push(a.join(" "));
  return { lines, restore: () => Object.assign(console, original) };
}

const values = {
  prophet_r38: { direction: 1, buy_confirmed: true, sell_confirmed: false, buy_high_quality: false, sell_high_quality: false, t_enc: 2, d_enc: -1, structure_subtype: 0 },
  prophet_r37_ssot: { direction: 1, d_enc: -1, b_enc: 2, structure_subtype: 0, bull_event: true, bear_event: false },
  gmi_v12_70: { verdict: 3, gate: 2, gmi_dir: 1, prophet_dir: 1, conflict: false }
};
const bar = { o: 4001.1, h: 4006.2, l: 3999.0, c: 4004.4, volume: 1800 };

function localRecord(engine, candleKey, openMs) {
  const comparable = { mizan: {}, prophet: { prophet_r38: values.prophet_r38, prophet_r37_ssot: values.prophet_r37_ssot }, gmi: { gmi_v12_70: values.gmi_v12_70 } }[engine];
  return {
    schema_version: "cryptophys.local-calculation.v1",
    engine, symbol: SYMBOL, timeframe: "60", candle_time: new Date(openMs).toISOString(), candle_key: candleKey,
    computed_at: new Date().toISOString(), calculation_version: engine + "-test-v1",
    values: { bias: "NEUTRAL", candle: bar, comparable },
    provenance: {
      source: "worker-scheduled-test",
      source_hash: { mizan: "a", prophet: "c", gmi: "e" }[engine].repeat(64),
      implementation_hash: { mizan: "b", prophet: "d", gmi: "f" }[engine].repeat(64),
      ...(engine === "mizan" ? {} : { dependencies: { mizan: { source_hash: "a".repeat(64), implementation_hash: "b".repeat(64) } } })
    }
  };
}

async function post(worker, env, path, body) {
  const { ctx, settle } = execution();
  const response = await worker.fetch(new Request("https://worker.test" + path, {
    method: "POST", headers: { "content-type": "application/json", "x-webhook-secret": SECRET }, body: JSON.stringify(body)
  }), env, ctx);
  await settle();
  return response;
}

const worker = await loadWorker();

/** Seeds the last closed H1 candle through the real handlers, then runs the parity sweep cron. */
async function sweepLastClosedCandle(env) {
  const openMs = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;
  const candleKey = SYMBOL + ":60:" + openMs;

  // Calibration webhooks and local records arrive through the real handlers, but their
  // queue tasks are never consumed: only the cron can reconcile and analyse this candle.
  for (const source of Object.keys(values)) {
    const r = await post(worker, env, "/webhook", { source, ticker: SYMBOL, timeframe: "60", candle_time: String(openMs), ...bar, ...values[source] });
    assert.ok([200, 202].includes(r.status), "webhook " + source + ": " + r.status + " " + await r.text());
  }
  for (const engine of ["mizan", "prophet", "gmi"]) {
    const r = await post(worker, env, "/evidence/local-calculation", localRecord(engine, candleKey, openMs));
    assert.equal(r.status, 202, "local " + engine + ": " + await r.text());
  }
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM analysis_runs").get().n, 0, "nothing analysed before the cron");

  const { ctx, settle } = execution();
  const output = captureConsole();
  try {
    await worker.scheduled({ cron: "10-59/15 * * * *", scheduledTime: Date.now() }, env, ctx);
    await settle();
  } finally { output.restore(); }
  return { candleKey, output };
}

test("parity sweep cron: approves the candle's local records and the backfill runs its analysis", async () => {
  const { env } = await workerEnv();
  const { candleKey, output } = await sweepLastClosedCandle(env);
  assert.deepEqual(output.lines.error.filter(l => /Scheduled parity sweep failed|backfill_failed|backfill_candle_failed|ReferenceError|TypeError/.test(l)), [], "the cron must not fail");
  assert.ok(output.lines.log.some(l => l.startsWith("Scheduled parity sweep completed")), "the sweep reports its result");
  assert.ok(output.lines.log.some(l => l.startsWith("outcome_scoring {\"status\":\"ok\"")), "the sweep runs outcome scoring (P1)");
  assert.ok(!output.lines.error.some(l => l.startsWith("outcome_scoring_failed")), output.lines.error.join("\n"));
  const registry = Object.fromEntries(env.DB.db.prepare("SELECT engine, status FROM engine_parity_registry").all().map(r => [r.engine, r.status]));
  assert.equal(registry.prophet, "approved");
  assert.equal(registry.gmi, "approved");
  const run = env.DB.db.prepare("SELECT status, error_code FROM analysis_runs WHERE candle_key = ?").get(candleKey);
  assert.ok(run, "the backfill must start the candle's analysis");
  // Quorum mode (owner decision 2026-11-09): missing news no longer degrades the bar, so its
  // evidence is parked for the 1H War Room and the decision waits for the room's quorum.
  assert.ok(["complete", "degraded"].includes(run.status) || (run.status === "analyzing" && run.error_code === "awaiting_consensus"), "analysis status: " + run.status + " " + run.error_code);
});

test("news cron: a missing news ingestion fails into a logged error, never an exception", async () => {
  const { env } = await workerEnv();
  const { ctx, settle } = execution();
  const output = captureConsole();
  try {
    await worker.scheduled({ cron: "5 * * * *", scheduledTime: Date.now() }, env, ctx);
    await settle();
  } finally { output.restore(); }
  assert.ok(output.lines.error.some(l => l.startsWith("Scheduled fundamental news analysis failed")), output.lines.error.join("\n"));
  assert.ok(!output.lines.error.some(l => /ReferenceError|is not a function|is not defined/.test(l)), output.lines.error.join("\n"));
});

test("B2: the H1 chain labels the 5m context VERIFIED 5m only while the 5m identities are approved", async () => {
  const closeMs = Math.floor(Date.now() / 300_000) * 300_000;
  const key5 = SYMBOL + ":5:" + (closeMs - 300_000);
  const m5Record = (engine) => ({
    engine, timeframe: "5", candle_key: key5,
    provenance: { source_hash: (engine === "prophet" ? "1" : "2").repeat(64), implementation_hash: (engine === "prophet" ? "3" : "4").repeat(64) },
    values: { comparable: engine === "prophet" ? { prophet_r38: values.prophet_r38, prophet_r37_ssot: values.prophet_r37_ssot } : { gmi_v12_70: values.gmi_v12_70 } }
  });
  const context = { schema_version: "cryptophys.local-context.v1", engine: "prophet_r38_5m", trust_status: "informational_unverified", source: "m5_parity_record", symbol: SYMBOL, timeframe: "5", candle_key: key5, candle_time: new Date(closeMs).toISOString(), bias: "BULLISH", buy_confirmed: true, sell_confirmed: false, d_enc: -1, t_enc: 2, received_at: new Date().toISOString() };
  // The evidence is parked for the 1H War Room (quorum mode, 2026-11-09), or already decided.
  const fusionOf = async (env, candleKey) => {
    const row = env.DB.db.prepare("SELECT ai_analysis FROM ai_syntheses WHERE candle_key = ?").get(candleKey);
    if (row) return JSON.parse(row.ai_analysis).evidence_fusion;
    return JSON.parse(await env.WEBHOOK_BUFFER.get("h1:pending:" + candleKey)).evidence.evidence_fusion;
  };

  for (const approved of [true, false]) {
    const { env } = await workerEnv();
    await env.SIGNAL_CACHE.put("context:m5:latest", JSON.stringify(context));
    for (const engine of ["prophet", "gmi"]) {
      const record = m5Record(engine);
      await env.WEBHOOK_BUFFER.put("localcalc-observed:" + key5 + ":" + engine, JSON.stringify(record));
      const now = new Date().toISOString();
      env.DB.db.prepare("INSERT INTO engine_parity_registry (engine, source_hash, implementation_hash, status, consecutive_matches, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(engine + "_m5", record.provenance.source_hash, record.provenance.implementation_hash, approved ? "approved" : "candidate", approved ? 24 : 19, now, now);
    }
    const { candleKey } = await sweepLastClosedCandle(env);
    const m5 = (await fusionOf(env, candleKey)).informational_5m_context;
    assert.equal(m5.candle_key, key5);
    assert.equal(m5.verification.verified, approved);
    assert.equal(m5.verification.label, approved ? "VERIFIED 5m" : "UNVERIFIED 5m");
    if (!approved) assert.equal(m5.verification.reason, "m5_parity_not_approved");
    assert.equal(m5.recent_bars, undefined, "the H1 chain keeps the compact context");
  }
});

test("exact API routes win over their prefix routes: /api/threads/timeframe and /api/news/daily", async () => {
  // Production 2026-11-06: /api/threads/:id and /api/news/:key answered these two as ids (404).
  const { env } = await workerEnv();
  env.TF_THREADS_ENABLED = "true";
  env.NEWS_DAILY_ENABLED = "true";
  const get = async (path) => {
    const r = await worker.fetch(new Request("https://worker.test" + path), env, execution().ctx);
    return { status: r.status, body: await r.json() };
  };
  const tf = await get("/api/threads/timeframe?chart=4H");
  assert.equal(tf.status, 404);
  assert.deepEqual(tf.body, { status: "not_found", enabled: true, chart: "H4" }, "the timeframe route answered, not /api/threads/:id");
  assert.equal((await get("/api/threads/timeframe?chart=W1")).status, 400);
  const news = await get("/api/news/daily");
  assert.deepEqual(news.body, { status: "not_found", enabled: true }, "the News Daily route answered, not /api/news/:key");
});

test("/api/hud/levels and /api/conclusion/global answer as routes of their own (never as a HUD candle key)", async () => {
  const { env } = await workerEnv();
  const get = async (path) => {
    const r = await worker.fetch(new Request("https://worker.test" + path), env, execution().ctx);
    return { status: r.status, body: await r.json() };
  };
  const none = await get("/api/hud/levels?tf=240");
  assert.equal(none.status, 404);
  assert.deepEqual(none.body, { status: "not_found", timeframe: "240" }, "the levels route answered, not /api/hud/:candle_key");
  assert.equal((await get("/api/hud/levels?tf=5")).status, 400);
  const snap = { schema_version: "cryptophys.hud-snapshot.v1", timeframe: "15", candle_key: "OANDA:XAUUSD:15:1793955600000", computed_at: new Date().toISOString(),
    huds: { interstellar_eyes: { fields: { close: 4050, camarilla: { "15": { h6: 4120, h5: 4100, h4: 4080, h3: 4065, l3: 4035, l4: 4020, l5: 4000, l6: 3980 } }, band: { "15": "l3_h3" } } } } };
  await env.SIGNAL_CACHE.put("hud:15:latest", JSON.stringify(snap));
  const lv = await get("/api/hud/levels?tf=15");
  assert.equal(lv.status, 200);
  assert.equal(lv.body.levels.close, 4050);
  assert.equal(lv.body.levels.camarilla[0].band, "l3_h3");
  const g = await get("/api/conclusion/global");
  assert.equal(g.status, 200);
  assert.equal(g.body.status, "ok");
  assert.equal(g.body.global.action, "WAIT");
  assert.deepEqual(g.body.setups, [], "the live setups travel with the decision (none here)");
});

test("H1 by Consensus Discussion: the sweep has the Reasoner decide a parked bar after its room, once; an empty room is a fail-closed WAIT (owner decision 2026-11-07)", async () => {
  const { env } = await workerEnv();
  const prompts = [];
  const answer = JSON.stringify({ decision: "WAIT", confidence: 0.45, reasoning: "The room leans up but waits for a confirmed buy, so there is no trade for this candle.", entry_price: null, stop_loss: null, take_profit: null, risk_reward: null, position_size_pct: null, confirmation: null, invalidation: null, trade_plan: null });
  env.AI = { async run(model, input) { prompts.push({ model, text: (input?.messages || []).map(m => m.content).join("\n") }); return { response: answer, choices: [{ message: { content: answer }, finish_reason: "stop" }], usage: { total_tokens: 10 } }; } };
  env.AI_MODEL_REASONER = "@cf/test/reasoner";
  const hour = 3_600_000;
  const roomOpen = Math.floor(Date.now() / hour) * hour - hour; // its room concluded
  const lateOpen = roomOpen - 2 * hour; // no room, long past the 45-minute fallback
  const db = env.DB.db;
  for (const open of [roomOpen, lateOpen]) {
    const key = SYMBOL + ":60:" + open;
    db.prepare("INSERT INTO analysis_runs (candle_key, status, attempt_count, started_at, updated_at, result_json) VALUES (?, 'analyzing', 1, datetime('now'), datetime('now'), '{}')").run(key); db.prepare("UPDATE analysis_runs SET error_code = 'awaiting_consensus' WHERE candle_key = ?").run(key);
    await env.WEBHOOK_BUFFER.put("h1:pending:" + key, JSON.stringify({
      candle_key: key, ticker: SYMBOL, timeframe: "60", parked_at: new Date().toISOString(), input_fingerprint: "f", local_primary: true, sources: ["prophet_r38"],
      evidence: { candle_key: key, evidence_fusion: { complete: true, missing_evidence: [], validation_errors: [] }, news_evidence: { available: false } },
      news_evidence: { available: false }, prophet_metrics: "{}", gmi_metrics: "{}"
    }));
  }
  const roomKey = SYMBOL + ":60:" + roomOpen;
  const run = new Date(roomOpen).toISOString(), ts = new Date().toISOString();
  const msg = db.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, agent, ts, stance, confidence, body_json, status) VALUES ('tf:H1', ?, ?, ?, ?, ?, ?, ?, ?)");
  msg.run(run, "brief", "system", ts, null, null, JSON.stringify({ candle_key: roomKey, roster: ["h1", "risk"] }), "info");
  msg.run(run, "open:h1", "h1", ts, "WAIT", 0.7, JSON.stringify({ claim: "The 1-hour Prophet points up without a confirmed buy.", bias: "BULLISH", name: "1H Desk" }), "ok");
  msg.run(run, "open:risk", "risk", ts, "WAIT", 0.5, JSON.stringify({ claim: "No entry is confirmed.", bias: "NEUTRAL", name: "Risk Manager" }), "ok");
  msg.run(run, "conclusion", "moderator", ts, "WAIT", 0.6, JSON.stringify({ summary: "The room leans up and waits for a confirmed buy.", bias: "BULLISH", reasons: ["No confirmation yet."], dissent: [] }), "ok");

  const sweep = async () => {
    const { ctx, settle } = execution();
    const output = captureConsole();
    try { await worker.scheduled({ cron: "10-59/15 * * * *", scheduledTime: Date.now() }, env, ctx); await settle(); } finally { output.restore(); }
    return output;
  };
  const output = await sweep();
  assert.deepEqual(output.lines.error.filter(l => /h1_consensus|ReferenceError|TypeError/.test(l)), [], output.lines.error.join("\n"));
  const reasoner = prompts.filter(p => p.model === "@cf/test/reasoner" && /You are the Reasoner/.test(p.text));
  assert.equal(reasoner.length, 1, "one Reasoner call: the empty room needs none");
  assert.match(reasoner[0].text, /CONSENSUS:\n\{"status":"concluded"/);
  assert.match(reasoner[0].text, /"communication_bus":\[\{"ref":"#1"/, "the Reasoner reads the anonymous bus (owner decisions 2026-11-09)");
  assert.doesNotMatch(reasoner[0].text.split("CONSENSUS:")[1], /1H Desk|Risk Manager/, "never a name");
  assert.ok(!prompts.some(p => /You are the (Analyst|Counselor) stage in an XAUUSD decision-support pipeline/.test(p.text)), "the Analyst and the Counselor are retired");

  const synth = (open) => JSON.parse(db.prepare("SELECT ai_analysis FROM ai_syntheses WHERE candle_key = ?").get(SYMBOL + ":60:" + open).ai_analysis);
  const decided = synth(roomOpen);
  assert.equal(decided.analysis_chain, "consensus_reasoner");
  assert.equal(decided.consensus.status, "concluded");
  assert.equal(decided.consensus.room_bias, "BULLISH");
  assert.equal(decided.decision.decision, "WAIT");
  assert.equal(decided.analyst_output, undefined);
  const empty = synth(lateOpen);
  assert.equal(empty.consensus.status, "empty");
  assert.match(empty.decision.reasoning, /No agent of the 1H War Room spoke within 45 minutes/);
  assert.deepEqual(db.prepare("SELECT status FROM analysis_runs WHERE candle_key IN (?, ?) ORDER BY candle_key").all(SYMBOL + ":60:" + lateOpen, roomKey).map(r => r.status), ["complete", "complete"]);
  assert.equal(db.prepare("SELECT decision FROM trade_decisions WHERE candle_key = ?").get(roomKey).decision, "WAIT");

  await sweep();
  assert.equal(prompts.filter(p => /You are the Reasoner/.test(p.text)).length, 1, "a decided bar is never decided again");
});

test("the h1_room queue task: waits for the HUD snapshot of a fresh bar, then the room and the Reasoner decide at once (owner request 2026-11-07)", async () => {
  const { env } = await workerEnv();
  env.TF_THREADS_ENABLED = "true";
  env.AI_MODEL_REASONER = "@cf/test/reasoner";
  const prompts = [];
  const answer = JSON.stringify({ decision: "WAIT", confidence: 0.45, reasoning: "The room leans up but waits for a confirmed buy, so there is no trade for this candle.", entry_price: null, stop_loss: null, take_profit: null, risk_reward: null, position_size_pct: null, trade_plan: null });
  env.AI = { async run(model, input) { prompts.push({ model, text: (input?.messages || []).map(m => m.content).join("\n") }); return { choices: [{ message: { content: answer }, finish_reason: "stop" }], usage: { total_tokens: 10 } }; } };
  const deliver = async (body) => {
    const msg = { id: "m", body, attempts: 1, acked: false, retried: null, ack() { this.acked = true; }, retry(o) { this.retried = o; } };
    const output = captureConsole();
    try { await worker.queue({ messages: [msg] }, env); } finally { output.restore(); }
    return msg;
  };
  const hour = 3_600_000;

  // A bar whose close is still ahead and has no HUD snapshot: redelivered in 15 seconds (60 until
  // 2026-11-09; the owner wants the decision within 1 to 2 minutes of the close).
  const fresh = SYMBOL + ":60:" + Math.floor(Date.now() / hour) * hour;
  const waiting = await deliver({ kind: "h1_room", event_id: "h1_room:" + fresh, candle_key: fresh, enqueued_at: new Date().toISOString() });
  assert.equal(waiting.acked, false);
  assert.deepEqual(waiting.retried, { delaySeconds: 15 });
  assert.equal(prompts.length, 0);

  // A closed bar with its HUD snapshot, its parked evidence and a concluded room.
  const open = Math.floor(Date.now() / hour) * hour - hour;
  const key = SYMBOL + ":60:" + open;
  const db = env.DB.db;
  db.prepare("INSERT INTO analysis_runs (candle_key, status, attempt_count, started_at, updated_at, error_code, result_json) VALUES (?, 'analyzing', 1, datetime('now'), datetime('now'), 'awaiting_consensus', '{}')").run(key);
  await env.WEBHOOK_BUFFER.put("h1:pending:" + key, JSON.stringify({
    candle_key: key, ticker: SYMBOL, timeframe: "60", parked_at: new Date().toISOString(), input_fingerprint: "f", local_primary: true, sources: [],
    evidence: { candle_key: key, evidence_fusion: { complete: true, missing_evidence: [], validation_errors: [] } }, news_evidence: { available: false }, prophet_metrics: "{}", gmi_metrics: "{}"
  }));
  const candles = Array.from({ length: 20 }, (_, i) => { const o = open - (19 - i) * hour; return { open_time: new Date(o).toISOString(), close_time: new Date(o + hour).toISOString(), open: 4000, high: 4010, low: 3990, close: 4005, volume: 100 }; });
  await env.SIGNAL_CACHE.put("market-data:v2:series:OANDA:XAUUSD|1h", JSON.stringify({ candles }));
  await env.SIGNAL_CACHE.put("hud:60:" + key, JSON.stringify({ schema_version: "cryptophys.hud-snapshot.v1", timeframe: "60", candle_key: key, huds: {} }));
  const run = new Date(open).toISOString(), ts = new Date().toISOString();
  db.exec(`CREATE TABLE IF NOT EXISTS agent_thread_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, step TEXT NOT NULL, parent_id INTEGER, agent TEXT NOT NULL, bar_time TEXT, ts TEXT NOT NULL, stance TEXT, confidence REAL, body_json TEXT NOT NULL, refs_json TEXT, model TEXT, status TEXT NOT NULL, latency_ms INTEGER, fallback_used INTEGER DEFAULT 0, usage_tokens INTEGER, UNIQUE(thread_id, run_id, step))`);
  const msg = db.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, agent, ts, stance, confidence, body_json, status) VALUES ('tf:H1', ?, ?, ?, ?, ?, ?, ?, ?)");
  msg.run(run, "brief", "system", ts, null, null, JSON.stringify({ candle_key: key, roster: ["h1", "risk"], hud_snapshot: true }), "info");
  msg.run(run, "open:h1", "h1", ts, "WAIT", 0.7, JSON.stringify({ claim: "The 1-hour Prophet points up without a confirmed buy.", bias: "BULLISH", name: "1H Desk" }), "ok");
  msg.run(run, "conclusion", "moderator", ts, "WAIT", 0.6, JSON.stringify({ summary: "The room leans up and waits for a confirmed buy.", bias: "BULLISH", reasons: ["No confirmation yet."], dissent: [] }), "ok");

  const done = await deliver({ kind: "h1_room", event_id: "h1_room:" + key, candle_key: key, enqueued_at: new Date().toISOString() });
  assert.equal(done.acked, true, JSON.stringify(done.retried));
  assert.equal(prompts.filter(p => /You are the Reasoner/.test(p.text)).length, 1, "the Reasoner decides right after the room");
  assert.equal(db.prepare("SELECT status FROM analysis_runs WHERE candle_key = ?").get(key).status, "complete");
  const synth = JSON.parse(db.prepare("SELECT ai_analysis FROM ai_syntheses WHERE candle_key = ?").get(key).ai_analysis);
  assert.equal(synth.consensus.status, "concluded");
  assert.ok(Number.isFinite(synth.consensus.decided_after_close_s), "the decision records how long after the close it came");
  assert.equal(env.SIGNAL_CACHE.map.has("h1room:lock:" + key), false, "the room's hold is released");
});

test("P2: GET /api/indicator-agents serves every manifest with its live state", async () => {
  const { env } = await workerEnv();
  const r = await worker.fetch(new Request("https://worker.test/api/indicator-agents"), env, execution().ctx);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, "ok");
  assert.ok(body.agents.length >= 27);
  assert.ok(body.agents.some((a) => a.id === "supertrend" && a.kind === "indicator"), "the P6 agents are registered");
  assert.equal(body.agents.find((a) => a.id === "prophet_r38").lifecycle, "candidate", "no parity approval in an empty database");
  assert.ok(body.lifecycle_counts.active >= 1);
});

test("ledger cron (owner 2026-11-12, every 5 minutes): follows a decision on the 1m bars, alone; no news analysis, and the parity sweep no longer runs it", async () => {
  const { env } = await workerEnv();
  const wrangler = await readFile(join(root, "wrangler.jsonc"), "utf8");
  assert.match(wrangler, /"2-59\/5 \* \* \* \*"/, "the ledger cron is deployed");
  const source = await readFile(join(root, "src/index.ts"), "utf8");
  assert.equal(source.match(/runSignalLedger\(/g)?.length, 1, "the ledger runs in its own step only, not in the parity sweep");
  // A Decision Engine SELL decided 30 s after its 15m bar closed, and the 1m bars after it.
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const barOpen = Math.floor((now - 60 * 60_000) / 900_000) * 900_000;
  const close = barOpen + 900_000;
  const key = `${SYMBOL}:15:${barOpen}`;
  env.DB.db.prepare("INSERT INTO signal_ledger (id, source, candle_key, opened_at, side, entry, stop, tp1, status, updated_at) VALUES (?, 'decision', ?, ?, 'SELL', 4000, 4010, 3985, 'pending', ?)").run("decision:" + key, key, new Date(close + 30_000).toISOString(), new Date(close).toISOString());
  const m1 = [];
  for (let t = close; t + 60_000 <= now; t += 60_000) {
    const i = (t - close) / 60_000;
    const c = i < 3 ? 4000 : i < 6 ? 3995 : 3984;
    m1.push({ open_time: new Date(t).toISOString(), close_time: new Date(t + 60_000).toISOString(), open: i === 0 ? 4000 : c + 0.5, high: Math.max(c + 1, i === 0 ? 4000.5 : c + 1), low: c - 1, close: c });
  }
  await env.SIGNAL_CACHE.put("market-data:v2:series:OANDA:XAUUSD|1m", JSON.stringify({ candles: m1 }));
  const { ctx, settle } = execution();
  const output = captureConsole();
  try { await worker.scheduled({ cron: "2-59/5 * * * *", scheduledTime: now }, env, ctx); await settle(); } finally { output.restore(); }
  assert.deepEqual(output.lines.error.filter((l) => /signal_ledger_failed|ledger_omega_failed|TypeError|ReferenceError/.test(l)), []);
  assert.ok(!output.lines.log.some((l) => /fundamental news analysis/.test(l)) && !output.lines.error.some((l) => /news analysis failed/.test(l)), "the ledger cron runs no news analysis");
  const row = env.DB.db.prepare("SELECT status, filled_at, exit_reason, closed_at, r_tp1, omega_status, omega_filled_at, omega_exit FROM signal_ledger").get();
  // The plan's limit fills in the first minute after the decision; its target (3985) is reached at minute 6.
  assert.equal(row.filled_at, new Date(close + 60_000).toISOString());
  assert.deepEqual([row.status, row.exit_reason, row.r_tp1, row.closed_at], ["closed", "target", 1.5, new Date(close + 7 * 60_000).toISOString()]);
  // Omega sells at the open of the minute after the decision and takes its target the same minute as the plan.
  assert.deepEqual([row.omega_status, row.omega_filled_at, row.omega_exit], ["closed", new Date(close + 60_000).toISOString(), "target"]);
});

test("/api/trading-mode is read only (owner 2026-11-13): a GET with ?mode= changes nothing and points to the Omega POST", async () => {
  const { env } = await workerEnv();
  const get = async (path) => {
    const r = await worker.fetch(new Request("https://worker.test" + path), env, execution().ctx);
    return { status: r.status, body: await r.json() };
  };
  const before = await get("/api/trading-mode");
  assert.equal(before.status, 200);
  const write = await get("/api/trading-mode?mode=swing");
  assert.equal(write.status, 405);
  assert.equal(write.body.error, "read_only");
  assert.equal((await get("/api/trading-mode")).body.mode, before.body.mode, "the mode did not change");
});
