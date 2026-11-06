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
  const run = env.DB.db.prepare("SELECT status FROM analysis_runs WHERE candle_key = ?").get(candleKey);
  assert.ok(run, "the backfill must start the candle's analysis");
  assert.ok(["complete", "degraded"].includes(run.status), "analysis status: " + run.status);
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
  const fusionOf = (env, candleKey) => JSON.parse(env.DB.db.prepare("SELECT ai_analysis FROM ai_syntheses WHERE candle_key = ?").get(candleKey).ai_analysis).evidence_fusion;

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
    const m5 = fusionOf(env, candleKey).informational_5m_context;
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
});
