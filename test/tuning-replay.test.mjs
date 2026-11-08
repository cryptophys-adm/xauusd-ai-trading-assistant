import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { CROWD_CONTROL, CROWD_CANDIDATES, weightOf, crowdStance, replayArm, compareCrowd, readCrowdReplay, resetCrowdReplayCacheForTests } from "../src/tuning-replay.mjs";
import { reputationOf, buildCrowdLine } from "../src/reputation.mjs";
import { resetOutcomeSchemaCacheForTests, SCORING_VERSION } from "../src/outcome-scoring.mjs";
import { tuningView } from "../src/tuning.mjs";

const H = 3_600_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");

test("with the active parameters the replay weight equals reputationOf and the stance equals buildCrowdLine", () => {
  for (const [hits, miss] of [[0, 0], [3, 1], [10, 30], [40, 2], [100, 100]]) {
    const card = { n: hits + miss, directional: { hit: hits, miss, neutral: 0 }, wait: { hit: 0, missed_opportunity: 0 } };
    assert.equal(weightOf(hits, hits + miss, CROWD_CONTROL), reputationOf(card).weight, `${hits}/${hits + miss}`);
  }
  const entries = [{ agent: "a", stance: "BUY" }, { agent: "b", stance: "SELL" }, { agent: "c", stance: "WAIT" }, { agent: "d", stance: "BUY" }];
  for (const weights of [{}, { a: 0.25, b: 2, c: 1, d: 0.3 }, { a: 2, b: 0.25, c: 0.5, d: 1.9 }, { a: 1, b: 1.05, c: 1, d: 0.0 }]) {
    const line = buildCrowdLine(entries.map((e) => ({ id: e.agent, stance: e.stance })), Object.fromEntries(Object.entries(weights).map(([k, w]) => [k, { weight: w }])));
    const want = { BULLISH: "BUY", BEARISH: "SELL", NEUTRAL: "WAIT" }[line.weighted_bias];
    assert.equal(crowdStance(entries, weights, CROWD_CONTROL.neutral_band), want, JSON.stringify(weights));
  }
});

test("reputation is point in time: a score counts only once its horizon closed, and drops out after the window", () => {
  const arm = { ...CROWD_CONTROL, days: 1 };
  // Agent a was right 10 times between T0 and T0+9h; agent b was wrong 10 times.
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ agent: "a", candle_key: "k" + i, close_ms: T0 + i * H, stance: "BUY", result: "hit" }, { agent: "b", candle_key: "k" + i, close_ms: T0 + i * H, stance: "SELL", result: "miss" });
  const room = (t) => ({ candle_key: "r" + t, close_ms: T0 + t * H, entries: [{ agent: "a", stance: "BUY" }, { agent: "b", stance: "SELL" }] });
  const out = replayArm(arm, rows, [room(2), room(14), room(40)]);
  assert.equal(out.get("r2"), "WAIT", "at 2h no score has closed its 4-bar horizon: equal weights, an even split");
  assert.equal(out.get("r14"), "BUY", "by 14h every score has closed: a outweighs b");
  assert.equal(out.get("r40"), "WAIT", "after the 1-day window the scores dropped out again");
});

test("the crowd arms are compared on the same rooms with Holm and a holdout; a wider band that waits through good leans is not better", () => {
  // 340 rooms. Agent "good" is right on 80 % of its decisive calls, "bad" on 20 %; they always disagree,
  // and "mid" waits. The active weights (0.25 to 2) let "good" lead; the flatter grid point does too,
  // so the comparison is mostly ties: the replay must never call that a significant improvement.
  const rows = [], rooms = [], results = new Map();
  for (let i = 0; i < 340; i++) {
    const t = T0 + i * H, key = "c" + i, up = i % 5 !== 0;
    const good = { stance: "BUY", result: up ? "hit" : "miss" }, bad = { stance: "SELL", result: up ? "miss" : "hit" };
    rows.push({ agent: "good", candle_key: key, close_ms: t, ...good }, { agent: "bad", candle_key: key, close_ms: t, ...bad }, { agent: "mid", candle_key: key, close_ms: t, stance: "WAIT", result: up ? "missed_opportunity" : "hit" });
    results.set(key, { BUY: good.result, SELL: bad.result, WAIT: up ? "missed_opportunity" : "hit" });
    rooms.push({ candle_key: key, close_ms: t, entries: [{ agent: "good", stance: "BUY" }, { agent: "bad", stance: "SELL" }, { agent: "mid", stance: "WAIT" }] });
  }
  const view = compareCrowd({ rows, rooms, outcome: (k, s) => results.get(k)?.[s] ?? null, now: T0 + 340 * H });
  assert.equal(view.control.scored_rooms, 340);
  assert.equal(view.candidates.length, CROWD_CANDIDATES.length);
  for (const k of view.candidates) {
    assert.equal(k.discovery.bars + k.holdout.bars, k.same_rooms);
    assert.equal(k.holdout.bars, 100);
    assert.equal(k.criteria.minimum_sample, true);
    assert.ok(k.discovery.p_holm === null || k.discovery.p_holm >= k.discovery.p_value, "Holm never lowers a p-value");
    assert.notEqual(k.verdict, "collecting");
  }
  assert.equal(view.holm.tests, view.candidates.filter((k) => k.discovery.p_value !== null).length);
  // The wide neutral band turns the narrow leans into WAIT: on the 80 % up rooms WAIT is a missed opportunity.
  const band = view.candidates.find((k) => k.id === "crowd@band0.2");
  assert.ok(band.paired.control_better >= band.paired.candidate_better);
  assert.equal(band.verdict, "not_better");
});

test("a candidate that is right where the control is wrong is better on discovery and ready once no worse on the holdout", () => {
  // Two agents always disagree; the moves are flat, so WAIT is right and any side is wrong.
  const rows = [], rooms = [];
  for (let i = 0; i < 320; i++) {
    const key = "c" + i, t = T0 + i * H;
    rows.push({ agent: "a", candle_key: key, close_ms: t, stance: "BUY", result: "miss" }, { agent: "b", candle_key: key, close_ms: t, stance: "SELL", result: i % 3 ? "miss" : "hit" });
    rooms.push({ candle_key: key, close_ms: t, entries: [{ agent: "a", stance: "BUY" }, { agent: "b", stance: "SELL" }] });
  }
  const outcome = (_k, s) => (s === "WAIT" ? "hit" : "miss");
  const alwaysWait = { id: "crowd@test-wait", prior: 10, weight_range: [0.25, 2], days: 30, neutral_band: 1.01, change: "test" };
  const view = compareCrowd({ rows, rooms, outcome, candidates: [alwaysWait], now: T0 + 320 * H });
  const k = view.candidates[0];
  assert.ok(k.discovery.candidate_better > 30 && k.discovery.control_better === 0);
  assert.equal(k.discovery.p_holm, k.discovery.p_value, "one test in the family this month");
  assert.equal(k.criteria.higher_outcome_score, true);
  assert.equal(k.criteria.holdout_no_worse, true);
  assert.equal(k.verdict, "better_than_active: ready for owner review");
});

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter(n => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  const stmt = (sql, params = []) => ({
    bind: (...a) => stmt(sql, a.map(v => (v === undefined ? null : v))),
    async run() { db.prepare(sql).run(...params); return { success: true }; },
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { return { results: db.prepare(sql).all(...params) }; }
  });
  return { raw: db, prepare: (sql) => stmt(sql) };
}

test("readCrowdReplay loads the scored 1H agent statements, keeps the moderator apart and feeds /api/tuning", async () => {
  resetOutcomeSchemaCacheForTests(); resetCrowdReplayCacheForTests();
  const env = { DB: d1(), SIGNAL_CACHE: { async get() { return null; } } };
  await readCrowdReplay(env, { now: T0, useCache: false }); // ensures the schema
  const ins = env.DB.raw.prepare("INSERT INTO outcome_scores (subject, source, timeframe, candle_key, statement_close, stance, result, scoring_version, scored_at) VALUES (?, 'room', '60', ?, ?, ?, ?, ?, ?)");
  for (let i = 0; i < 50; i++) {
    const t = new Date(T0 + i * H).toISOString(), key = "OANDA:XAUUSD:60:" + (T0 + (i - 1) * H);
    ins.run("agent:h1", key, t, "BUY", i % 2 ? "hit" : "miss", SCORING_VERSION, t);
    ins.run("agent:prophet", key, t, "SELL", i % 2 ? "miss" : "hit", SCORING_VERSION, t);
    ins.run("agent:moderator", key, t, "WAIT", "hit", SCORING_VERSION, t);
    ins.run("indicator:prophet_r37", key, t, "BUY", "hit", SCORING_VERSION, t); // not an agent: ignored
  }
  const view = await readCrowdReplay(env, { now: T0 + 50 * H, useCache: false });
  assert.equal(view.rooms, 50);
  assert.equal(view.control.scored_rooms, 50, "every crowd stance found its outcome among the room's own scores");
  assert.equal(view.crowd_vs_moderator.rooms, 50);
  assert.ok(view.candidates.every((k) => k.verdict === "collecting"), "50 rooms is far below the discovery minimum");
  const t = tuningView({ families: [] }, { crowd: view });
  assert.equal(t.replays.crowd.family, "crowd");
  assert.deepEqual(t.replays.crowd.candidates.map((k) => k.id), CROWD_CANDIDATES.map((c) => c.id));
});
