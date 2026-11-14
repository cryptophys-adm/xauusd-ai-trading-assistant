// Closed-market idle of the AI Worker's crons (src/market-idle.mjs, 2026-11-14 resource audit): the
// rule, and the deployed entry point's D1 statements and rows on a Saturday sweep, counted with a D1
// over node:sqlite, with the idle on and with CLOSED_MARKET_IDLE "off" (the behaviour before).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { marketIdleAt, idleHeartbeatDue, IDLE_AFTER_CLOSE_MS } from "../src/market-idle.mjs";

// November 2026 is New York standard time: gold closes Friday 22:00 UTC and reopens Sunday 23:00 UTC.
const at = (iso) => Date.parse(iso);

test("the crons stand still from two hours after the Friday close to the Sunday reopen", () => {
  assert.equal(IDLE_AFTER_CLOSE_MS, 2 * 3_600_000);
  assert.equal(marketIdleAt({}, at("2026-11-13T21:59:00Z")), false, "Friday before the close");
  assert.equal(marketIdleAt({}, at("2026-11-13T22:30:00Z")), false, "the last bars' rooms, decisions and scores finish");
  assert.equal(marketIdleAt({}, at("2026-11-13T23:59:00Z")), false);
  assert.equal(marketIdleAt({}, at("2026-11-14T00:00:00Z")), true);
  assert.equal(marketIdleAt({}, at("2026-11-14T12:00:00Z")), true, "Saturday");
  assert.equal(marketIdleAt({}, at("2026-11-15T22:59:00Z")), true, "Sunday before the reopen");
  assert.equal(marketIdleAt({}, at("2026-11-15T23:00:00Z")), false, "the reopen");
  assert.equal(marketIdleAt({}, at("2026-11-18T10:00:00Z")), false, "a Wednesday");
  assert.equal(marketIdleAt({ CLOSED_MARKET_IDLE: "off" }, at("2026-11-14T12:00:00Z")), false, "the switch");
  assert.equal(idleHeartbeatDue(at("2026-11-14T12:10:00Z")), true);
  assert.equal(idleHeartbeatDue(at("2026-11-14T12:25:00Z")), false);
});

// ---------------------------------------------------------------- the deployed entry point on a Saturday
{
  const RealDate = Date;
  const shift = RealDate.UTC(2026, 10, 14, 12, 10, 0) - RealDate.now();
  globalThis.Date = class extends RealDate {
    constructor(...args) { if (args.length === 0) super(RealDate.now() + shift); else super(...args); }
    static now() { return RealDate.now() + shift; }
  };
}
const root = fileURLToPath(new URL("..", import.meta.url));

async function loadWorker() {
  const out = await build({
    entryPoints: [join(root, "src/index.ts")], bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent",
    alias: { "cloudflare:workers": join(root, "test/support/cloudflare-workers-stub.mjs") }
  });
  const dir = await mkdtemp(join(tmpdir(), "ai-worker-idle-"));
  const file = join(dir, "worker.mjs");
  await writeFile(file, out.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  await rm(dir, { recursive: true, force: true });
  return mod.default;
}

/** D1 over node:sqlite that counts the statements run and the rows they returned. */
async function countingD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(await readFile(join(root, "schema.sql"), "utf8"));
  const dir = join(root, "migrations");
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort()) db.exec(await readFile(join(dir, name), "utf8"));
  const count = { statements: 0, rows: 0 };
  const statement = (sql, params = []) => ({
    bind: (...args) => statement(sql, args.map((v) => (v === undefined ? null : v))),
    async run() { count.statements++; const r = db.prepare(sql).run(...params); return { success: true, meta: { changes: Number(r.changes) } }; },
    async first(column) { count.statements++; const row = db.prepare(sql).get(...params) ?? null; if (row) count.rows++; return column && row ? row[column] : row; },
    async all() { count.statements++; const results = db.prepare(sql).all(...params); count.rows += results.length; return { success: true, results }; }
  });
  return { db, count, prepare: (sql) => statement(sql), async batch(list) { return Promise.all(list.map((s) => s.run())); }, async exec(sql) { count.statements++; db.exec(sql); return { count: 1 }; } };
}

function countingKV() {
  const map = new Map();
  const count = { gets: 0 };
  return {
    map, count,
    async get(key, type) { count.gets++; if (!map.has(key)) return null; const v = map.get(key); return type === "json" || type?.type === "json" ? JSON.parse(v) : v; },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); },
    async list({ prefix = "" } = {}) { return { keys: [...map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; }
  };
}

function fakeAI() {
  const answer = JSON.stringify({ decision: "WAIT", confidence: 0.4, bias: "NEUTRAL", stance: "WAIT", reasoning: "No trade.", summary: "No trade.", refs: [], risks: [], key_levels: [], trade_plan: null });
  return { async run() { return { response: answer, choices: [{ message: { content: answer } }], usage: { total_tokens: 10 } }; } };
}

async function workerEnv(extra = {}) {
  return {
    DB: await countingD1(), WEBHOOK_BUFFER: countingKV(), SIGNAL_CACHE: countingKV(), AI: fakeAI(),
    XAUUSD_EVENTS: { async send() {}, async sendBatch() {} },
    WEBHOOK_SECRET: "test-only-secret", INDICATOR_SOURCE: "local", ANALYSIS_TIMEFRAMES: "60", ...extra
  };
}

async function cron(worker, env, expression) {
  const pending = [];
  const lines = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => lines.push(a.join(" "));
  console.warn = console.error = (...a) => lines.push(a.join(" "));
  try {
    await worker.scheduled({ cron: expression, scheduledTime: Date.now() }, env, { waitUntil: (p) => pending.push(p), passThroughOnException() {} });
    await Promise.all(pending);
  } finally { Object.assign(console, original); }
  const kvGets = env.SIGNAL_CACHE.count.gets + env.WEBHOOK_BUFFER.count.gets;
  return { lines, d1: { ...env.DB.count }, kvGets };
}

const worker = await loadWorker();

test("a Saturday sweep keeps the macro rooms and the hourly heartbeat only; the ledger step does nothing", async () => {
  const before = await cron(worker, await workerEnv({ CLOSED_MARKET_IDLE: "off" }), "10-59/15 * * * *");
  const after = await cron(worker, await workerEnv(), "10-59/15 * * * *");
  console.log(`sweep at Saturday 12:10 UTC, before: D1 ${before.d1.statements} statements / ${before.d1.rows} rows, KV ${before.kvGets} reads; after: D1 ${after.d1.statements} / ${after.d1.rows}, KV ${after.kvGets}`);
  assert.ok(before.lines.some((l) => l.startsWith("Scheduled parity sweep completed")), "without the idle the full sweep runs");
  assert.ok(!after.lines.some((l) => l.startsWith("Scheduled parity sweep completed")), "the idle sweep skips the reconcile chain");
  assert.ok(after.lines.some((l) => l.startsWith("sweep_idle")), "the heartbeat runs on the first sweep of the hour");
  // The calendar fetch has no network here (econ_calendar fetch_failed), as in the full sweep.
  assert.deepEqual(after.lines.filter((l) => !l.startsWith("econ_calendar") && /_failed|TypeError|ReferenceError/.test(l)), []);
  assert.ok(after.d1.statements < before.d1.statements / 3, `D1 statements ${after.d1.statements} vs ${before.d1.statements}`);
  assert.ok(after.kvGets < before.kvGets, `KV reads ${after.kvGets} vs ${before.kvGets}`);

  const ledgerBefore = await cron(worker, await workerEnv({ CLOSED_MARKET_IDLE: "off" }), "2-59/5 * * * *");
  const ledgerAfter = await cron(worker, await workerEnv(), "2-59/5 * * * *");
  console.log(`ledger step on Saturday, before: D1 ${ledgerBefore.d1.statements} statements / ${ledgerBefore.d1.rows} rows, KV ${ledgerBefore.kvGets}; after: D1 ${ledgerAfter.d1.statements}, KV ${ledgerAfter.kvGets}`);
  assert.ok(ledgerBefore.d1.statements > 0);
  assert.deepEqual([ledgerAfter.d1.statements, ledgerAfter.kvGets], [0, 0]);
});
