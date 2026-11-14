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
