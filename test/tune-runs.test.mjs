// The record of every auto-tuning step (owner 2026-11-11: "ya buat catatan hasil auto-tune di D1"). src/tune-runs.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runTuneStep, recordTuneRun, readTuneRuns, replaySummary, tuneRunRow, resetTuneRunsSchemaCacheForTests, TUNE_RUNS_KEEP_DAYS } from "../src/tune-runs.mjs";

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args.map((v) => (v === undefined ? null : v))),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
test.beforeEach(() => resetTuneRunsSchemaCacheForTests());
const T0 = Date.parse("2026-11-11T12:10:00Z");
const replay = {
  active: { id: "ww:8732704b", source: "default" }, rooms: 187, control: { scored_rooms: 150, accuracy: 0.52 },
  replay_fidelity: { share: 0.97, checks: 300 }, reverse: null,
  candidates: [{ id: "a", verdict: "collecting", discovery: { bars: 80 }, holdout: { bars: 70 } }, { id: "b", verdict: "not_better", discovery: { bars: 210 }, holdout: { bars: 100 } }]
};

test("R1. a step's row: when, how long, the deployed version, what the replay saw, applied and pushed", () => {
  const r = tuneRunRow({ step: "witness", startedMs: T0, finishedMs: T0 + 840, versionId: "v-1", replay, applied: { status: "unchanged", reason: "no candidate is better" }, pushed: { status: "accepted", candidates: 2 } });
  assert.deepEqual([r.status, r.apply_status, r.push_status, r.duration_ms, r.version_id, r.ran_at], ["ok", "unchanged", "accepted", 840, "v-1", "2026-11-11T12:10:00.000Z"]);
  assert.deepEqual(r.detail.replay.verdicts, { collecting: 1, not_better: 1 });
  assert.deepEqual(r.detail.replay.most_paired, { id: "b", discovery: 210, holdout: 100 });
  assert.equal(r.detail.replay.fidelity, 0.97);
  assert.equal(replaySummary(null), null);
  assert.equal(tuneRunRow({ step: "witness", startedMs: T0, finishedMs: T0, error: "boom" }).status, "failed");
});

test("R2. runTuneStep records success and failure, never throws, and the reader returns the latest of each step", async () => {
  const env = { DB: fakeD1(), CF_VERSION_METADATA: { id: "ver-abc" } };
  let t = T0;
  const clock = () => (t += 500);
  const ok = await runTuneStep(env, "witness", async () => ({ replay, applied: { status: "unchanged" }, pushed: { status: "transport_failed", error: "rpc down" } }), { clock });
  assert.equal(ok.error, null);
  const bad = await runTuneStep(env, "weighting:15", async () => { throw new Error("replay exploded"); }, { clock });
  assert.equal(bad.error, "replay exploded");
  await runTuneStep(env, "witness", async () => ({ replay, applied: { status: "activated", id: "ww:1", from: "ww:0", reason: "News Daily up" }, pushed: { status: "accepted" } }), { clock });
  const all = await readTuneRuns(env);
  assert.equal(all.runs.length, 3);
  assert.deepEqual(all.latest.map((r) => [r.step, r.status, r.apply_status]), [["weighting:15", "failed", null], ["witness", "ok", "activated"]]);
  assert.equal(all.runs.at(-1).push_status, "transport_failed");
  assert.equal(all.runs.at(-1).pushed.reason, "rpc down", "the push's error is kept, so a silent Aether failure shows");
  assert.equal(all.latest[0].error, "replay exploded");
  assert.equal(all.latest[1].version_id, "ver-abc");
  assert.equal((await readTuneRuns(env, { step: "weighting:15" })).runs.length, 1);
  assert.equal((await recordTuneRun(env, { step: "bogus" })).status, "skipped");
  assert.equal((await recordTuneRun({}, { step: "witness" })).status, "skipped");
  assert.doesNotMatch(JSON.stringify(all), /"(price|entry|stop|tp1|tp2|lots|size)"/);
});

test("R3. rows older than the keep window are dropped on write", async () => {
  const env = { DB: fakeD1() };
  await recordTuneRun(env, { step: "witness", startedMs: T0 - (TUNE_RUNS_KEEP_DAYS + 1) * 86_400_000, finishedMs: T0 - (TUNE_RUNS_KEEP_DAYS + 1) * 86_400_000 }, { now: T0 - (TUNE_RUNS_KEEP_DAYS + 1) * 86_400_000 });
  await recordTuneRun(env, { step: "witness", startedMs: T0, finishedMs: T0 }, { now: T0 });
  assert.equal((await readTuneRuns(env)).runs.length, 1);
});
