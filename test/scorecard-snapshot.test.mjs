// Scorecard snapshots (resource audit P0, 2026-11-14): the hot readers read one stored row instead of
// every score of the window, and the copy follows new scores.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { scorecards, refreshScorecardSnapshots, agentReputation, SCORECARD_SNAPSHOT_MAX_AGE_MS, resetOutcomeSchemaCacheForTests, OUTCOME_SCHEMA_SQL } from "../src/outcome-scoring.mjs";
import { SCORING_VERSION } from "../src/outcome-scoring.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  const count = { scoreRows: 0 };
  const statement = (sql, params = []) => ({
    bind: (...args) => statement(sql, args),
    async run() { db.prepare(sql).run(...params); return { success: true }; },
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { const results = db.prepare(sql).all(...params); if (/FROM outcome_scores/.test(sql)) count.scoreRows += results.length; return { results }; }
  });
  return { db, count, prepare: (sql) => statement(sql) };
}

const NOW = Date.parse("2026-11-12T12:00:00Z");
function score(db, i, result = "hit") {
  db.db.prepare("INSERT INTO outcome_scores (subject, source, timeframe, candle_key, statement_close, stance, confidence, result, direction, scoring_version, scored_at, session) VALUES (?, 'room', '15', ?, ?, 'BUY', 0.6, ?, 1, ?, ?, 'london')")
    .run("agent:a", `k${i}`, new Date(NOW - i * 900_000).toISOString(), result, SCORING_VERSION, new Date(NOW).toISOString());
}

test("a fresh snapshot is read instead of the scores; an old one is computed again", async () => {
  resetOutcomeSchemaCacheForTests();
  const db = d1();
  for (const sql of OUTCOME_SCHEMA_SQL) db.db.exec(sql);
  for (let i = 0; i < 40; i++) score(db, i);
  const first = await scorecards(db, { days: 30, now: NOW, snapshot: true });
  assert.equal(db.count.scoreRows, 40, "the first read computes");
  const again = await scorecards(db, { days: 30, now: NOW + 60_000, snapshot: true });
  assert.deepEqual(again, first);
  assert.equal(db.count.scoreRows, 40, "a fresh snapshot reads no score");
  await scorecards(db, { days: 30, now: NOW + SCORECARD_SNAPSHOT_MAX_AGE_MS + 1, snapshot: true });
  assert.equal(db.count.scoreRows, 80, "an old snapshot is computed again");
  // Without `snapshot` (the default), every call computes, as before.
  await scorecards(db, { days: 30, now: NOW + SCORECARD_SNAPSHOT_MAX_AGE_MS + 2 });
  assert.equal(db.count.scoreRows, 120);
  // A window that is not stored is always computed.
  await scorecards(db, { days: 3, now: NOW, snapshot: true });
  await scorecards(db, { days: 3, now: NOW, snapshot: true });
  assert.ok(!db.db.prepare("SELECT 1 FROM scorecard_snapshots WHERE days = 3").get());
});

test("new scores refresh the stored windows, so the readers see them at once", async () => {
  resetOutcomeSchemaCacheForTests();
  const db = d1();
  for (const sql of OUTCOME_SCHEMA_SQL) db.db.exec(sql);
  for (let i = 0; i < 10; i++) score(db, i, "hit");
  const before = (await scorecards(db, { days: 30, now: NOW, snapshot: true })).find((c) => c.subject === "agent:a");
  assert.equal(before.directional.hit, 10);
  for (let i = 10; i < 15; i++) score(db, i, "miss");
  assert.deepEqual(await refreshScorecardSnapshots(db, { now: NOW + 1000 }), [30]);
  const after = (await scorecards(db, { days: 30, now: NOW + 2000, snapshot: true })).find((c) => c.subject === "agent:a");
  assert.equal(after.directional.miss, 5);
  // The rooms' reputation reads the same copy: no score row is read for it.
  const read = db.count.scoreRows;
  await agentReputation(db, "15", { now: NOW + 3000 });
  assert.equal(db.count.scoreRows, read);
});
