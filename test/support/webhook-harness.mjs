// The AI Worker's real fetch handler for webhook tests: src/index.ts bundled with esbuild (as
// wrangler does), a D1 over node:sqlite with the schema and migrations, Map KVs and a captured queue.
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export async function loadWorker(entry = join(ROOT, "src/index.ts")) {
  const out = await build({
    entryPoints: [entry],
    bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent",
    alias: { "cloudflare:workers": join(ROOT, "test/support/cloudflare-workers-stub.mjs") }
  });
  const dir = await mkdtemp(join(tmpdir(), "ai-worker-webhook-"));
  const file = join(dir, "worker.mjs");
  await writeFile(file, out.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  await rm(dir, { recursive: true, force: true });
  return mod.default;
}

export async function d1() {
  const db = new DatabaseSync(":memory:");
  const dir = join(ROOT, "migrations");
  db.exec(await readFile(join(ROOT, "schema.sql"), "utf8"));
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort()) db.exec(await readFile(join(dir, name), "utf8"));
  const statement = (sql, params = []) => ({
    bind: (...args) => statement(sql, args.map((v) => (v === undefined ? null : v))),
    async run() { const r = db.prepare(sql).run(...params); return { success: true, meta: { changes: Number(r.changes) } }; },
    async first(column) { const row = db.prepare(sql).get(...params) ?? null; return column && row ? row[column] : row; },
    async all() { return { success: true, results: db.prepare(sql).all(...params) }; }
  });
  return { db, prepare: (sql) => statement(sql), async batch(list) { return Promise.all(list.map((s) => s.run())); }, async exec(sql) { db.exec(sql); return { count: 1 }; } };
}

export function kv() {
  const map = new Map();
  return {
    map,
    async get(key, type) { if (!map.has(key)) return null; const v = map.get(key); return type === "json" || type?.type === "json" ? JSON.parse(v) : v; },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); },
    async list({ prefix = "" } = {}) { return { keys: [...map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; }
  };
}

export async function webhookEnv(secret) {
  const sent = [];
  return {
    sent,
    env: {
      DB: await d1(), WEBHOOK_BUFFER: kv(), SIGNAL_CACHE: kv(),
      XAUUSD_EVENTS: { async send(body) { sent.push(body); }, async sendBatch(list) { sent.push(...list.map((m) => m.body)); } },
      WEBHOOK_SECRET: secret, INDICATOR_SOURCE: "local", ANALYSIS_TIMEFRAMES: "60"
    }
  };
}

/** POSTs a raw body (TradingView sends bare NaN) to a path and returns { status, text }. */
export async function postRaw(worker, env, path, text, headers = {}) {
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  const response = await worker.fetch(new Request("https://worker.test" + path, { method: "POST", headers: { "content-type": "text/plain; charset=utf-8", ...headers }, body: text }), env, ctx);
  await Promise.all(pending);
  return { status: response.status, text: await response.text() };
}

/** Everything one webhook leaves behind: the answer, its D1 rows, its KV entries and its queue sends. */
export async function webhookOutcome(worker, secret, text) {
  const { env, sent } = await webhookEnv(secret);
  const response = await postRaw(worker, env, "/webhook", text);
  return {
    response,
    rows: env.DB.db.prepare("SELECT candle_key, source, payload FROM webhook_sources ORDER BY candle_key, source").all().map((r) => ({ ...r })),
    buffer: Object.fromEntries(env.WEBHOOK_BUFFER.map),
    cache: Object.fromEntries(env.SIGNAL_CACHE.map),
    sent
  };
}
