import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { buildStrategy, STRATEGY_PARAMS } from "../src/strategy-engine.mjs";
import { slimInputs, gzipJson, resetStrategyInputsSchemaCacheForTests } from "../src/strategy-inputs.mjs";
import { STRATEGY_ARMS, STRATEGY_CONTROL, STRATEGY_CANDIDATES, replayHour, replayStrategyCaptures, compareStrategy, readStrategyReplay, resetStrategyReplaySchemaCacheForTests, resetStrategyReplayCacheForTests } from "../src/strategy-replay.mjs";
import { tuningView } from "../src/tuning.mjs";

// The triggered BUY of test/strategy-engine.test.mjs: aligned rooms, price at a support, a verified 5m buy.
const NOW = Date.parse("2026-11-06T14:20:00Z");
const op = (id, bias, confidence = 0.6) => ({ id, status: "ok", stance: "WAIT", bias, confidence });
const room = (biases, bar_close) => ({ bar_close, openings: biases.map((b, i) => op("a" + i, b)), conclusion: { status: "ok", stance: "WAIT", bias: null, confidence: 0.6 } });
const bull = ["BULLISH", "BULLISH", "BULLISH", "NEUTRAL"];
const h1Bars = Array.from({ length: 20 }, (_, i) => ({ open: 4000 + i, high: 4006 + i, low: 3996 + i, close: 4001 + i }));
const m15Bars = Array.from({ length: 10 }, (_, i) => ({ open: 4040, high: 4045, low: i === 5 ? 4031 : 4036, close: 4040 }));
const snapshot = (tf, close) => ({
  timeframe: tf, candle_key: `OANDA:XAUUSD:${tf}:1`,
  huds: {
    interstellar_eyes: { fields: { close, camarilla: { [tf]: { h3: 4048, h4: 4060, h5: 4075, l3: 4038, l4: 4026, l5: 4010 }, D: { h3: 4090, h4: 4110, h5: 4140, l3: 4000, l4: 3980, l5: 3950 } } } },
    chronos_matrix: { fields: { daily_cpr: { pivot: 4020, tc: 4024, bc: 4016 }, weekly_cpr: { pivot: 3960, tc: 3965, bc: 3955 } } },
    fabio_amt: { fields: { poc: 4052, vah: 4068, val: 4030 } },
    decision_matrix: { fields: { verdict: 1, gate: 1, conflict: false } }, trade_management: { fields: { conflict: false, gate: 1 } },
    prophet: { fields: { t_enc: 1 } }, kinetic_engine: { fields: { is_chaos: false } }, r37_funnel: { fields: { buy_confirmed: false, sell_confirmed: false } }
  }
});
const triggered = () => slimInputs({
  rooms: { D1: room(bull, "2026-11-05T22:00:00.000Z"), H4: room(bull, "2026-11-06T14:00:00.000Z"), H1: room(bull, "2026-11-06T14:00:00.000Z"), M15: { ...room(bull, null), bar_time: "2026-11-06T14:15:00.000Z" } },
  news: null, h1Snapshot: snapshot("60", 4040), m15Snapshot: snapshot("15", 4040),
  confirmations: { h1_prophet_r38: { buy_confirmed: false, sell_confirmed: false }, m5_prophet_r38: { buy_confirmed: true, sell_confirmed: false, verified: true } },
  h1Bars, m15Bars, h1Chain: { decision: "WAIT", confidence: 0 }, now: NOW
});

test("the control replays the live engine exactly; a candidate set reaches the thresholds", () => {
  const inputs = triggered();
  const live = buildStrategy(inputs);
  assert.equal(live.state, "TRIGGERED");
  assert.deepEqual(buildStrategy(inputs, STRATEGY_PARAMS), live, "explicit live params change nothing");
  assert.deepEqual(replayHour(inputs)[STRATEGY_CONTROL.id], { decision: live.decision, state: live.state });
  assert.equal(buildStrategy(inputs, { min_rrr: 99 }).state, "LOW_REWARD");
  assert.equal(buildStrategy(inputs, { min_confidence: 0.99 }).state, "LOW_CONFIDENCE");
  assert.equal(buildStrategy(inputs, { lean: 0.9 }).state, "NO_SETUP", "a 0.9 neutral band leaves no trend");
  assert.equal(STRATEGY_CANDIDATES.length <= 3, true, "at most 3 candidates in the family (RFC O6)");
  assert.equal(new Set(STRATEGY_ARMS.map((a) => a.id)).size, STRATEGY_ARMS.length);
  for (const c of STRATEGY_CANDIDATES) assert.equal(Object.entries(c.params).filter(([k, v]) => STRATEGY_PARAMS[k] !== v).length, 1, `${c.id} changes exactly one threshold`);
});

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter(n => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  const stmt = (sql, params = []) => ({
    bind: (...a) => stmt(sql, a.map(v => (v === undefined ? null : v))),
    async run() { const r = db.prepare(sql).run(...params); return { success: true, meta: { changes: Number(r.changes) } }; },
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { return { results: db.prepare(sql).all(...params) }; }
  });
  return { raw: db, prepare: (sql) => stmt(sql) };
}

test("the sweep computes each arm once per stored hour, skips no_data hours and feeds /api/tuning", async () => {
  resetStrategyInputsSchemaCacheForTests(); resetStrategyReplaySchemaCacheForTests(); resetStrategyReplayCacheForTests();
  const env = { DB: d1() };
  const gz = await gzipJson(triggered());
  const ins = env.DB.raw.prepare("INSERT INTO strategy_inputs (candle_key, captured_at, score_close, version, inputs_gz, live_decision, live_state, outcomes_json) VALUES (?, ?, ?, 'v', ?, ?, ?, ?)");
  ins.run("h1", "2026-11-06T14:40:00.000Z", "2026-11-06T14:30:00.000Z", gz, "BUY", "TRIGGERED", JSON.stringify({ BUY: "hit", SELL: "miss", WAIT: "missed_opportunity" }));
  ins.run("h2", "2026-11-06T15:40:00.000Z", "2026-11-06T15:30:00.000Z", gz, "BUY", "TRIGGERED", null);
  ins.run("h3", "2026-11-06T16:40:00.000Z", "2026-11-06T16:30:00.000Z", gz, "WAIT", "NO_SETUP", JSON.stringify({ no_data: true }));
  const first = await replayStrategyCaptures(env, { now: NOW });
  assert.deepEqual(first, { status: "ok", hours: 2, failed: 0 }, "the unscored hour is replayed too; the no_data hour is skipped");
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM strategy_replays").get().n, 2 * STRATEGY_ARMS.length);
  assert.equal((await replayStrategyCaptures(env, { now: NOW })).hours, 0, "nothing is recomputed");
  const view = await readStrategyReplay(env, { now: NOW, useCache: false });
  assert.equal(view.hours, 1, "only scored hours are compared");
  assert.equal(view.control.scored_hours, 1);
  assert.equal(view.control.matches_live, 1, "the stored inputs reproduce the live decision");
  assert.deepEqual(view.control.drift, []);
  assert.ok(view.candidates.every((k) => k.verdict === "collecting"));
  env.DB.raw.prepare("DELETE FROM strategy_inputs WHERE candle_key = 'h2'").run();
  await replayStrategyCaptures(env, { now: NOW });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM strategy_replays WHERE candle_key = 'h2'").get().n, 0, "replays of pruned hours are dropped");
  const t = tuningView({ families: [] }, { strategy: view });
  assert.equal(t.replays.strategy.family, "strategy");
});

test("a candidate that trades where the control waited, and wins, is better once the sample allows; drift is reported", () => {
  const hours = [];
  for (let i = 0; i < 330; i++) {
    const trade = i % 6 === 0;
    hours.push({
      candle_key: "k" + i, live_decision: i === 7 ? "SELL" : "WAIT",
      outcomes: { BUY: trade ? "hit" : "miss", SELL: "miss", WAIT: trade ? "missed_opportunity" : "hit" },
      decisions: { [STRATEGY_CONTROL.id]: "WAIT", "strategy@rrr1.2": trade ? "BUY" : "WAIT", "strategy@conf0.3": "WAIT", "strategy@near0.5": "WAIT" }
    });
  }
  const view = compareStrategy(hours, { now: NOW });
  const rrr = view.candidates.find((k) => k.id === "strategy@rrr1.2");
  assert.equal(rrr.differing_decisions, 55);
  assert.equal(rrr.discovery.control_better, 0);
  assert.equal(rrr.criteria.higher_outcome_score, true);
  assert.equal(rrr.verdict, "better_than_active: ready for owner review");
  assert.equal(view.candidates.find((k) => k.id === "strategy@conf0.3").verdict, "not_better", "identical decisions are never better");
  assert.deepEqual(view.control.drift, ["k7"], "the hour whose live decision the replay does not reproduce");
  assert.equal(view.holm.tests, 1, "only candidates with decisive pairs are tested");
});
