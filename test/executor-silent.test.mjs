// Executor silence (ES1, orchestrator 2026-11-27): a VPS, terminal or bridge that stops syncing in trading hours is
// told once per episode on the Omega Telegram, critical with an open position or pending order; an early close (bars
// stop, syncs go on) is not. In-memory SQLite D1 and KV; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EXECUTOR_SILENT_MS, EXECUTOR_SILENT_KEY, executorSilent, exposureOf, lastSyncMs, silentLine, backLine, runExecutorSilentCheck } from "../src/executor-silent.mjs";

const MIN = 60_000;
const FRI = Date.parse("2026-11-27T04:00:00Z"); // a Friday morning: gold trades
const SAT = Date.parse("2026-11-28T12:00:00Z");
const BREAK = Date.parse("2026-11-26T22:30:00Z"); // the daily break (17:00-18:00 New York)

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE omega_bridge (id INTEGER PRIMARY KEY CHECK (id = 1), kid TEXT, public_key TEXT, bridge_version TEXT, state TEXT, synced_ms INTEGER)");
  db.exec("CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER, actor TEXT, action TEXT, detail TEXT)");
  return { raw: db, prepare(sql) { let params = []; const stmt = {
    bind(...a) { params = a.map((v) => (v === undefined ? null : v)); return stmt; },
    async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { return { results: db.prepare(sql).all(...params) }; } }; return stmt; } };
}
const kv = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } }; };
const env = () => ({ DB: d1(), SIGNAL_CACHE: kv(), OMEGA_ENGINE_ENABLED: "true" });
const sync = (e, ms, state = { connected: true, received_ms: ms, positions: [], orders: [] }) =>
  e.DB.raw.prepare("INSERT INTO omega_bridge (id, state, synced_ms) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, synced_ms = excluded.synced_ms").run(JSON.stringify(state), ms);
const events = (e) => e.DB.raw.prepare("SELECT action, detail FROM omega_events ORDER BY id").all();

test("ES-1: silent only in trading hours, after a first sync, past 5 minutes", () => {
  assert.equal(EXECUTOR_SILENT_MS, 5 * MIN);
  assert.equal(executorSilent({ syncedMs: FRI - 4 * MIN, now: FRI }), false);
  assert.equal(executorSilent({ syncedMs: FRI - 6 * MIN, now: FRI }), true);
  assert.equal(executorSilent({ syncedMs: null, now: FRI }), false, "a bridge that never synced is not silent");
  assert.equal(executorSilent({ syncedMs: SAT - 60 * MIN, now: SAT }), false, "the weekend");
  assert.equal(executorSilent({ syncedMs: BREAK - 30 * MIN, now: BREAK }), false, "the daily break");
  assert.equal(lastSyncMs({ synced_ms: 5, state: null }), 5);
  assert.equal(lastSyncMs({ synced_ms: null, state: JSON.stringify({ received_ms: 7 }) }), 7, "the state's received_ms when synced_ms is missing");
  assert.deepEqual(exposureOf(JSON.stringify({ positions: [{}], orders: [] })), { positions: 1, orders: 0, severity: "critical" });
  assert.deepEqual(exposureOf(JSON.stringify({ positions: [], orders: [{}, {}] })), { positions: 0, orders: 2, severity: "critical" });
  assert.deepEqual(exposureOf(null), { positions: 0, orders: 0, severity: "warning" });
  const w = silentLine({ syncedMs: FRI - 7 * MIN, now: FRI, positions: 0, orders: 0, severity: "warning" });
  assert.match(w, /^XAUUSD SYSTEM · Omega executor silent for 7 min \(last sync 03:53 UTC\): no position or pending order is open/);
  const c = silentLine({ syncedMs: FRI - 7 * MIN, now: FRI, positions: 1, orders: 1, severity: "critical" });
  assert.match(c, /^XAUUSD SYSTEM · CRITICAL · Omega executor silent for 7 min .*1 open position and 1 pending order are not managed/);
  assert.match(backLine({ sinceMs: FRI - 12 * MIN, now: FRI }), /syncing again after 12 min of silence/);
});

test("ES-2: one critical line per episode with a position open, one line when it syncs again", async () => {
  const e = env(), sent = [];
  const send = async (t) => { sent.push(t); };
  sync(e, FRI - 10 * MIN, { connected: true, received_ms: FRI - 10 * MIN, positions: [{ ticket: 1 }], orders: [] });
  assert.equal((await runExecutorSilentCheck(e, { now: FRI - 6 * MIN, send })).status, "ok", "4 minutes: not yet");
  const opened = await runExecutorSilentCheck(e, { now: FRI, send });
  assert.equal(opened.status, "opened");
  assert.equal(opened.severity, "critical");
  for (let t = FRI + 5 * MIN; t <= FRI + 30 * MIN; t += 5 * MIN) assert.equal((await runExecutorSilentCheck(e, { now: t, send })).status, "silent");
  assert.equal(sent.length, 1, "once per episode");
  assert.match(sent[0], /CRITICAL/);
  sync(e, FRI + 31 * MIN);
  const back = await runExecutorSilentCheck(e, { now: FRI + 31 * MIN, send });
  assert.equal(back.status, "back");
  assert.equal(sent.length, 2);
  assert.match(sent[1], /syncing again after 41 min/);
  assert.equal(e.SIGNAL_CACHE.m.has(EXECUTOR_SILENT_KEY), false);
  const ev = events(e);
  assert.deepEqual(ev.map((r) => r.action), ["executor_silent", "executor_back"]);
  assert.deepEqual(Object.keys(JSON.parse(ev[0].detail)).sort(), ["orders", "positions", "severity", "silent_min"], "minutes and counts only");
  // A later silence is a new episode.
  assert.equal((await runExecutorSilentCheck(e, { now: FRI + 40 * MIN, send })).status, "opened");
  assert.equal(sent.length, 3);
  assert.match(sent[2], /^XAUUSD SYSTEM · Omega executor silent/, "flat: a warning");
});

test("ES-3: the 27 Nov early close: bars stopped at 19:43Z, the bridge kept syncing: no alert", async () => {
  const e = env(), sent = [];
  for (let t = Date.parse("2026-11-27T19:40:00Z"); t <= Date.parse("2026-11-27T22:00:00Z"); t += 5 * MIN) {
    // The bridge syncs every few seconds whatever the bars do (calm mode: every 5 s).
    sync(e, t - 5_000, { connected: true, received_ms: t - 5_000, positions: [], orders: [] });
    assert.equal((await runExecutorSilentCheck(e, { now: t, send: async (x) => { sent.push(x); } })).status, "ok");
  }
  assert.equal(sent.length, 0);
  assert.equal(events(e).length, 0);
});

test("ES-4: off without the engine, quiet when the bridge never synced, never throws", async () => {
  const e = env();
  assert.equal((await runExecutorSilentCheck({ ...e, OMEGA_ENGINE_ENABLED: "false" }, { now: FRI })).status, "off");
  assert.equal((await runExecutorSilentCheck(e, { now: FRI })).status, "never_synced");
  assert.equal((await runExecutorSilentCheck({ OMEGA_ENGINE_ENABLED: "true" }, { now: FRI })).status, "unavailable");
  const broken = { ...e, SIGNAL_CACHE: { get: async () => { throw new Error("kv down"); } } };
  sync(e, FRI - 10 * MIN);
  assert.equal((await runExecutorSilentCheck(broken, { now: FRI })).status, "failed");
});

test("ES-5: wired into the 5-minute ledger step with the Omega Telegram", async () => {
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"));
  assert.match(src, /runExecutorSilentCheck\(env, \{ send: \(text: string\) => sendOmegaTelegram\(env, escHtml\(text\)\) \}\)/);
});
