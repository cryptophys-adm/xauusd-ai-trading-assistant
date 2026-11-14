// Resource audit P0 (2026-11-14): the hot queries search an index instead of scanning their table.
// The schema is the one production runs (schema.sql, every migration, then the run-time Omega schema),
// and each query is the exact text the Worker sends.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OMEGA_SCHEMA_SQL } from "../src/omega-broker.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

async function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(await readFile(join(root, "schema.sql"), "utf8"));
  const dir = join(root, "migrations");
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort()) db.exec(await readFile(join(dir, name), "utf8"));
  for (const sql of OMEGA_SCHEMA_SQL) db.exec(sql);
  return db;
}

const plan = (db, sql, params) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail).join(" | ");

const QUERIES = [
  ["decision cards' outcomes (src/decision-cards.mjs)", "SELECT subject, result, direction FROM outcome_scores WHERE timeframe = ? AND candle_key = ? AND (subject LIKE 'agent:%' OR subject = 'chain:h1')", ["15", "k"], "idx_outcome_scores_tf_candle"],
  ["AI calls in the last hour (src/agent-threads.mjs)", "SELECT COUNT(*) AS n FROM agent_thread_messages WHERE ts >= ? AND status NOT IN ('budget_exhausted', 'skipped', 'info')", ["2026-11-14T00:00:00Z"], "idx_agent_thread_messages_ts"],
  ["latest parity comparisons (src/parity-view.mjs)", "SELECT * FROM engine_parity_comparisons ORDER BY compared_at DESC LIMIT ?", [5], "idx_parity_comparisons_at"],
  ["a candle's parity comparisons (src/hud-store.mjs)", "SELECT engine, result FROM engine_parity_comparisons WHERE candle_key = ?", ["k"], "idx_parity_comparisons_candle"],
  ["the last webhook (src/webhook-rejections.mjs)", "SELECT source, candle_key, received_at FROM webhook_sources ORDER BY received_at DESC LIMIT 1", [], "idx_webhook_sources_received"],
  ["pending Omega intents (src/omega-broker.mjs)", "SELECT id FROM omega_intents WHERE status IN ('pending', 'sent') ORDER BY created_ms, id", [], "omega_intents_status"]
];

test("every hot query searches its index", async () => {
  const db = await database();
  for (const [label, sql, params, index] of QUERIES) {
    const detail = plan(db, sql, params);
    assert.match(detail, new RegExp(`USING (COVERING )?INDEX ${index}`), `${label}: ${detail}`);
  }
});

// The latest room and News Daily runs (src/war-room.mjs, src/news-daily.mjs, src/health-alerts.mjs,
// src/decision-cards.mjs): a thread's id carries its run's date, so the latest run is the first entry of
// the (thread_id, run_id, step) index read backwards over the thread range, no sort, no full scan
// (production 2026-11-14: 20,906 rows read before, 1 after).
const LATEST = [
  "SELECT run_id AS r FROM agent_thread_messages WHERE thread_id >= 'warroom:' AND thread_id < 'warroom;' ORDER BY thread_id DESC, run_id DESC LIMIT 1",
  "SELECT run_id AS r FROM agent_thread_messages WHERE thread_id >= 'newsdaily:' AND thread_id < 'newsdaily;' AND step = 'brief' ORDER BY thread_id DESC, run_id DESC LIMIT 1",
  "SELECT run_id FROM agent_thread_messages WHERE thread_id >= 'warroom:' AND thread_id < 'warroom;' AND step = 'conclusion' ORDER BY thread_id DESC, run_id DESC LIMIT 12"
];

test("the latest-run lookups walk an index backwards with no sort", async () => {
  const db = await database();
  for (const sql of LATEST) {
    const detail = plan(db, sql, []);
    assert.match(detail, /SEARCH agent_thread_messages USING (COVERING )?INDEX sqlite_autoindex_agent_thread_messages_1 \(thread_id>\? AND thread_id<\?\)/, detail);
    assert.doesNotMatch(detail, /TEMP B-TREE/, detail);
  }
});

test("the latest-run lookups find the run MAX(run_id) found, across days and threads", async () => {
  const db = await database();
  const put = db.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, agent, ts, body_json, status) VALUES (?, ?, ?, 'a', ?, '{}', 'ok')");
  for (const run of ["2026-11-12T23:45:00.000Z", "2026-11-13T20:00:00.000Z", "2026-11-13T09:15:00.000Z"]) {
    for (const step of ["brief", "open:a", "conclusion"]) put.run(`warroom:${run.slice(0, 10)}`, run, step, run);
    put.run(`newsdaily:${run.slice(0, 10)}`, run, "brief", run);
  }
  put.run("tf:H1", "2026-11-14T01:00:00.000Z", "brief", "2026-11-14T01:00:00.000Z");
  put.run("warroom:2026-11-13", "2026-11-13T21:00:00.000Z", "open:a", "2026-11-13T21:00:00.000Z"); // a run still without its conclusion
  const one = (sql) => db.prepare(sql).get();
  assert.equal(one(LATEST[0]).r, one("SELECT MAX(run_id) AS r FROM agent_thread_messages WHERE thread_id LIKE 'warroom:%'").r);
  assert.equal(one(LATEST[1]).r, one("SELECT MAX(run_id) AS r FROM agent_thread_messages WHERE thread_id LIKE 'newsdaily:%' AND step = 'brief'").r);
  assert.deepEqual(db.prepare(LATEST[2]).all().map((r) => r.run_id), db.prepare("SELECT DISTINCT run_id FROM agent_thread_messages WHERE thread_id LIKE 'warroom:%' AND step = 'conclusion' ORDER BY run_id DESC LIMIT 12").all().map((r) => r.run_id));
});
