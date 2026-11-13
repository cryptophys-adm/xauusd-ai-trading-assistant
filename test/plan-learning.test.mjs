import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  PLAN_ARMS, CONTROL_ARM, PLAN_RULES, PLAN_LEARNING_KEY, armId, variantOf, setupsFrom, fillWindowOf, replaySetup, learn, pickFor, walkForward,
  planAdviceFor, runPlanLearning, readPlanLearning, planLearningMode, contextOf, resetPlanLearningSchemaCacheForTests
} from "../src/plan-learning.mjs";

const M1 = 60_000, M15 = 15 * M1, HOUR = 60 * M1;
const T0 = Date.parse("2026-11-10T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const key = (closeMs) => `OANDA:XAUUSD:15:${closeMs - M15}`;

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE engine_decisions (decision_key TEXT PRIMARY KEY, bar_close TEXT NOT NULL, decided_at TEXT NOT NULL, stance TEXT NOT NULL, confidence REAL, source TEXT NOT NULL, decision_json TEXT NOT NULL)");
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
function kv() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); }, raw: m };
}
/** 1m bars from `from`, one per entry of `path` ([low, high]); the close is the high. */
const bars = (from, path) => path.map(([low, high], i) => ({ open_time: iso(from + i * M1), close_time: iso(from + (i + 1) * M1), open: low, high, low, close: high }));
const decision = (closeMs, side, { entry, stop, tp, atr = 10, mode = "scalp", regime = "low-ranging" }) => ({ key: key(closeMs), close_ms: closeMs, decided_at: iso(closeMs + M1), side, entry, stop, tp1: tp, atr_h1: atr, mode, action: "ENTER_LIMIT", at_level: true, regime });

test("an arm moves the entry deeper by ATR and scales the stop from the plan's entry; an arm that leaves too little risk does not fit", () => {
  const buy = { side: "BUY", entry: 100, stop: 90, tp1: 115, atr_h1: 10 };
  assert.deepEqual(variantOf(buy, { entry_shift: 0, stop_scale: 1 }), { side: "BUY", entry: 100, stop: 90, tp1: 115, risk: 10, rrr: 1.5 });
  assert.deepEqual(variantOf(buy, { entry_shift: 0.1, stop_scale: 0.8 }), { side: "BUY", entry: 99, stop: 92, tp1: 115, risk: 7, rrr: 2.29 });
  assert.equal(variantOf(buy, { entry_shift: 0.3, stop_scale: 0.5 }), null, "2 points of risk is below 0.25 ATR");
  const sell = { side: "SELL", entry: 100, stop: 110, tp1: 85, atr_h1: 10 };
  assert.deepEqual(variantOf(sell, { entry_shift: 0.2, stop_scale: 1.25 }), { side: "SELL", entry: 102, stop: 112.5, tp1: 85, risk: 10.5, rrr: 1.62 });
  assert.equal(variantOf({ ...buy, atr_h1: null }, PLAN_ARMS[0]), null);
  assert.equal(PLAN_ARMS.length, 20);
  assert.equal(CONTROL_ARM, armId(0, 1));
});

test("a setup is one plan: repeats of the same stop and target extend it; a new stop, a gap or the other side opens another", () => {
  const p = { entry: 100, stop: 90, tp: 115 };
  const list = setupsFrom([
    decision(T0, "BUY", p), decision(T0 + M15, "BUY", { ...p, entry: 101 }), decision(T0 + 2 * M15, "BUY", { ...p, stop: 90.3 }),
    decision(T0 + 3 * M15, "BUY", { ...p, stop: 88 }),
    decision(T0 + 3 * M15, "SELL", { entry: 100, stop: 110, tp: 85 }),
    decision(T0 + 8 * M15, "BUY", { ...p, stop: 88 }),
    { ...decision(T0 + 9 * M15, "BUY", p), stop: 120 }
  ]);
  assert.deepEqual(list.map((s) => [s.side, s.opened_ms - T0, s.last_seen_ms - T0, s.decisions, s.entry]), [
    ["BUY", 0, 2 * M15, 3, 100], ["BUY", 3 * M15, 3 * M15, 1, 100], ["SELL", 3 * M15, 3 * M15, 1, 100], ["BUY", 8 * M15, 8 * M15, 1, 100]
  ], "the entry is the first decision's; an invalid plan is skipped");
  assert.equal(list[0].context, "scalp|low-ranging");
  assert.equal(contextOf({ mode: "x", regime: null }), "none|unknown");
  assert.equal(fillWindowOf(list[0]), 3 * M15, "while the engine repeated it, plus the last bar");
  assert.equal(fillWindowOf({ opened_ms: 0, last_seen_ms: 40 * HOUR }), 8 * HOUR);
  assert.equal(list[0].decided_ms, T0 + M1);
});

test("the replay: each arm on the same bars; a deeper entry that never fills is 0R; resolved at the last exit on the bars", () => {
  const [s] = setupsFrom([decision(T0, "BUY", { entry: 100, stop: 90, tp: 115 })]);
  // Price dips to 98.6 in the first minutes, then rallies through the target.
  const path = [[99.5, 100.2], [98.6, 99.6], [98.9, 101], [101, 104], [104, 108], [108, 112], [112, 116]];
  const series = bars(T0 + M1, path);
  const now = T0 + 2 * HOUR;
  const out = replaySetup(s, series, { now });
  assert.equal(out.status, "resolved");
  assert.deepEqual(out.results[CONTROL_ARM], { s: "target", r: 1.5, f: 1 });
  assert.deepEqual(out.results[armId(0.1, 1)], { s: "target", r: 1.778, f: 1 }, "filled 1 point lower: 16 points of reward on 9 of risk");
  assert.deepEqual(out.results[armId(0.2, 1)], { s: "target_before_entry", r: 0, f: 0 }, "98 was never reached");
  assert.deepEqual(out.results[armId(0, 0.5)], { s: "target", r: 3, f: 1 }, "a 5-point stop held: the dip was 1.4 points");
  assert.equal(out.results[armId(0.3, 0.5)].s, "invalid");
  assert.equal(out.resolved_ms, T0 + 8 * M1, "the bar that reached the target");
  // A tighter stop is hit when the dip goes through it.
  const deep = replaySetup(s, bars(T0 + M1, [[99.5, 100.2], [94.5, 99.6], [96, 101], [101, 116]]), { now });
  assert.deepEqual(deep.results[armId(0, 0.5)], { s: "stop", r: -1, f: 1 });
  assert.equal(deep.results[CONTROL_ARM].s, "target");
  // Still running, or no bars after the decision.
  assert.equal(replaySetup(s, bars(T0 + M1, [[99.5, 100.2], [99, 101]]), { now: T0 + 10 * M1 }).status, "open");
  assert.equal(replaySetup(s, [], { now: T0 + HOUR }).status, "open");
  assert.equal(replaySetup(s, bars(T0 + 5 * HOUR, [[99, 101]]), { now: T0 + 3 * 24 * HOUR }).status, "unavailable");
  // A 1m bar that closed before the decision was made is not used.
  const early = replaySetup({ ...s, decided_ms: T0 + 3 * M1 }, bars(T0, [[80, 100.2], [80, 99], [80, 99], [99.5, 100.2], [100.1, 116]]), { now });
  assert.equal(early.results[CONTROL_ARM].s, "target");
});

const fake = (i, { context = "scalp|low-ranging", gain = {}, base = 0 } = {}) => {
  const results = {};
  for (const arm of PLAN_ARMS) results[arm.id] = { s: "target", r: base + (gain[arm.id] ?? 0), f: 1 };
  return { setup_key: `k${i}`, opened_ms: T0 + i * HOUR, resolved_ms: T0 + i * HOUR + 30 * M1, context, results };
};

test("the learner: a gain is shrunk toward the gain over every context and toward zero; a small gain keeps the plan", () => {
  const tight = armId(0, 0.65);
  const a = Array.from({ length: 40 }, (_, i) => fake(i, { gain: { [tight]: 0.5 } }));
  const b = Array.from({ length: 40 }, (_, i) => fake(100 + i, { context: "scalp|high-trending", gain: { [tight]: -0.5 } }));
  const state = learn([...a, ...b]);
  assert.equal(state.setups, 80);
  assert.equal(state.global.pick, CONTROL_ARM, "over both contexts the gain is zero");
  const ctxA = state.contexts.find((c) => c.context === "scalp|low-ranging"), ctxB = state.contexts.find((c) => c.context === "scalp|high-trending");
  assert.equal(ctxA.pick, tight);
  assert.equal(ctxA.gain, 0.333, "40 x 0.5 over 40 + 20 of prior");
  assert.equal(ctxB.pick, CONTROL_ARM);
  assert.equal(pickFor(state, "scalp|low-ranging"), tight);
  assert.equal(pickFor(state, "swing|never-seen"), CONTROL_ARM, "an unseen context takes the pick over every context");
  // Two setups are not enough to leave the plan.
  assert.equal(learn([fake(1, { gain: { [tight]: 0.5 } }), fake(2, { gain: { [tight]: 0.5 } })]).global.pick, CONTROL_ARM);
  // Nor is one large outlier: an arm needs MIN_PICK setups before it can be picked at all.
  const outlier = learn(Array.from({ length: 19 }, (_, i) => fake(i, { gain: { [tight]: 3 } })));
  assert.equal(outlier.global.pick, CONTROL_ARM);
  assert.equal(outlier.arms.find((x) => x.id === tight).gain, 1.462, "the gain is still reported");
  assert.equal(learn(Array.from({ length: 20 }, (_, i) => fake(i, { gain: { [tight]: 3 } }))).global.pick, tight);
  const arm = state.arms.find((x) => x.id === tight);
  assert.deepEqual([arm.n, arm.mean_diff, arm.fill_rate, arm.target_rate], [80, 0, 1, 1]);
  assert.equal(learn([]).global.pick, CONTROL_ARM);
});

test("the referee: walk-forward only, the newest part held out; a steady gain is better than the plan, noise is not", () => {
  const tight = armId(0, 0.65);
  const good = Array.from({ length: 160 }, (_, i) => fake(i, { gain: { [tight]: i % 5 === 0 ? -0.2 : 0.4 } }));
  const wf = walkForward(good);
  assert.equal(wf.verdict, "better_than_plan");
  assert.equal(wf.setups, 160);
  assert.equal(wf.holdout.setups, 40);
  assert.ok(wf.discovery.picked < 120 && wf.discovery.picked > 80, "the first setups keep the plan: nothing was known yet");
  assert.ok(wf.discovery.p_value < 0.05 && wf.holdout.mean_diff > 0);
  assert.equal(walkForward(good.slice(0, 60)).verdict, "collecting");
  // A gain that existed only in the past: the learner picks the arm, the newer setups punish it.
  const faded = Array.from({ length: 160 }, (_, i) => fake(i, { gain: { [tight]: i < 60 ? 0.6 : -0.3 } }));
  assert.equal(walkForward(faded).verdict, "not_better");
  // No look-ahead: results that resolve only after every setup opened teach nothing in time.
  const late = good.map((s) => ({ ...s, resolved_ms: T0 + 1000 * HOUR }));
  assert.equal(walkForward(late).discovery.picked, 0);
  assert.equal(walkForward(late).verdict, "collecting");
});

test("the run: setups from the engine's decisions, the replay of the ended ones, the state in KV; nothing twice; off is off", async () => {
  resetPlanLearningSchemaCacheForTests();
  const env = { DB: d1(), SIGNAL_CACHE: kv() };
  const row = (closeMs, side, t) => env.DB.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, 0.6, 'council', ?)")
    .run(key(closeMs), iso(closeMs), iso(closeMs + M1), side, JSON.stringify({ trade: { side, action: "ENTER_LIMIT", entry: t.entry, stop: t.stop, tp: t.tp, at_level: true, rrr: 1.5 }, strategy: { atr_h1: 10 }, trading_mode: "scalp", context: { regime_1h: "low-ranging" } }));
  row(T0, "BUY", { entry: 100, stop: 90, tp: 115 });
  row(T0 + M15, "BUY", { entry: 100.5, stop: 90, tp: 115 });
  env.DB.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, 'WAIT', 0.2, 'council', '{}')").run(key(T0 + 2 * M15), iso(T0 + 2 * M15), iso(T0 + 2 * M15));
  const series = bars(T0 + M1, [[99.5, 100.2], [98.6, 99.6], [98.9, 101], [101, 104], [104, 108], [108, 112], [112, 116]]);
  // While the engine still repeats the plan, it is stored but not replayed.
  const first = await runPlanLearning(env, { now: T0 + M15 + 5 * M1, bars: series });
  assert.deepEqual([first.status, first.added, first.resolved], ["ok", 1, 0]);
  const run = await runPlanLearning(env, { now: T0 + 3 * HOUR, bars: series });
  assert.deepEqual([run.status, run.added, run.resolved, run.setups, run.verdict, run.global_pick], ["ok", 0, 1, 1, "collecting", CONTROL_ARM]);
  const stored = env.DB.raw.prepare("SELECT * FROM plan_setups").get();
  assert.deepEqual([stored.status, stored.decisions, stored.context, stored.resolved_at, stored.entry], ["resolved", 2, "scalp|low-ranging", iso(T0 + 8 * M1), 100]);
  assert.equal(JSON.parse(stored.results_json)[CONTROL_ARM].r, 1.5);
  const state = await readPlanLearning(env);
  assert.equal(state.mode, "shadow");
  assert.deepEqual(state.setups, { resolved: 1, open: 0, unavailable: 0, since: iso(T0) });
  assert.equal(state.learned.arms.length, 20);
  assert.equal(state.grid.control, CONTROL_ARM);
  assert.equal((await runPlanLearning(env, { now: T0 + 4 * HOUR, bars: series })).status, "unchanged");
  // Later runs read two days of decisions: a plan already running where that window starts is the tail of
  // an older setup and opens none; a plan that starts inside the window does.
  const T1 = T0 + 5 * 24 * HOUR;
  row(T1, "SELL", { entry: 100, stop: 110, tp: 85 });
  assert.equal((await runPlanLearning(env, { now: T1 + 2 * 24 * HOUR - 30 * M1, bars: series })).status, "unchanged");
  row(T1 + 3 * HOUR, "SELL", { entry: 100, stop: 111, tp: 85 });
  // With D1's batch the writes of a run go in batches (the first run stores the whole stored history).
  let batches = 0;
  env.DB.batch = async (statements) => { batches += 1; for (const st of statements) await st.run(); };
  assert.equal((await runPlanLearning(env, { now: T1 + 4 * HOUR, bars: series })).added, 2, "both are inside this window");
  assert.equal(batches, 1);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM plan_setups").get().n, 3);
  assert.equal((await runPlanLearning({ ...env, PLAN_LEARNING_MODE: "off" })).status, "disabled");
  assert.equal(planLearningMode({ PLAN_LEARNING_MODE: " OFF " }), "off");
  assert.equal(planLearningMode({}), "shadow");
  assert.equal((await runPlanLearning({})).status, "unavailable");
  assert.ok(env.SIGNAL_CACHE.raw.has(PLAN_LEARNING_KEY));
});

test("the advice beside a decision: the learned entry and stop for its context, or the plan kept; never without a trade", () => {
  const tight = armId(0.1, 0.8);
  const learned = learn(Array.from({ length: 60 }, (_, i) => fake(i, { gain: { [tight]: 0.4 } })));
  const state = { learned, walk_forward: { verdict: "collecting" } };
  const d = { trade: { side: "BUY", entry: 100, stop: 90, tp: 115, rrr: 1.5 }, strategy: { atr_h1: 10 }, trading_mode: "scalp", context: { regime_1h: "low-ranging" } };
  assert.deepEqual(planAdviceFor(d, state), { context: "scalp|low-ranging", arm: tight, keeps_plan: false, entry_shift: 0.1, stop_scale: 0.8, entry: 99, stop: 92, tp: 115, rrr: 2.29, plan_rrr: 1.5, gain: 0.375, context_setups: 60, verdict: "collecting" });
  assert.deepEqual(planAdviceFor({ ...d, context: { regime_1h: "high-trending" } }, { learned: learn([]), walk_forward: null }), { context: "scalp|high-trending", arm: CONTROL_ARM, keeps_plan: true });
  assert.equal(planAdviceFor({ stance: "WAIT", trade: null }, state), null);
  assert.equal(planAdviceFor(d, null), null);
  assert.equal(PLAN_RULES.margin_r, 0.05);
});
