// Owner 2026-11-13: "strengthen autonomous learning & knowledge looping". The baseline model learns by
// itself from the custom model's dataset every hour, is judged walk-forward and prospectively, predicts
// in shadow only, and reports to Aether as knowledge (no price).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  fitLogistic, predict, auc, judge, decisiveRows, trainBaseline, shadowPredictions, prospectiveRecord, modelReport,
  runModelBaseline, readBaseline, baselineStatus, MODEL_BASELINE_KEY, MODEL_REPORT_SCHEMA, BASELINE
} from "../src/model-baseline.mjs";
import { runModelDataset, loadLabeledRows, resetModelDatasetSchemaForTests, WIDE_RULES } from "../src/model-dataset.mjs";
import { pushModelReport } from "../src/aether-push.mjs";
import { DECISION_SCHEMA_SQL } from "../src/decision-engine.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  for (const sql of DECISION_SCHEMA_SQL) db.exec(sql);
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
const kv = () => { const m = new Map(); return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } }; };

/** A deterministic pseudo-random sequence (no Math.random in tests). */
function rng(seed = 7) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }
const T0 = Date.parse("2026-11-01T00:00:00Z");
/** Rows where the H1 witness's lean predicts the long label and noise does not. */
function syntheticRows(n = 400, seed = 7) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const lean = r() * 2 - 1, noise = r() * 2 - 1;
    const pUp = 1 / (1 + Math.exp(-3 * lean));
    const up = r() < pUp;
    return {
      bar_close: new Date(T0 + i * 900_000).toISOString(),
      features: { w_h1_lean: lean, noise, w_h1_available: 1 },
      labels: {
        tight: { long: { outcome: up ? "target" : "stop", r: up ? 1.5 : -1 }, short: { outcome: up ? "stop" : "target", r: up ? -1 : 1.5 } },
        wide: { long: { outcome: up ? "target" : "stop", r: up ? 1.5 : -1 }, short: { outcome: i % 3 ? "expired" : up ? "stop" : "target", r: 0.1 } }
      }
    };
  });
}

test("B1. the logistic regression learns a real signal, ignores noise, and is judged against the base rate", () => {
  const rows = decisiveRows(syntheticRows(), "tight", "long");
  const m = fitLogistic(rows.slice(0, 280));
  assert.ok(m.keys.includes("w_h1_lean") && m.keys.includes("noise"));
  assert.ok(!m.keys.includes("w_h1_available"), "a constant feature is dropped");
  const wLean = m.weights[m.keys.indexOf("w_h1_lean")], wNoise = m.weights[m.keys.indexOf("noise")];
  assert.ok(wLean > 0.5 && Math.abs(wNoise) < wLean / 3, `lean ${wLean} carries the signal, noise ${wNoise} does not`);
  const j = judge(m, rows.slice(280));
  assert.ok(j.skill > 0.05, `Brier skill ${j.skill} beats the base rate`);
  assert.ok(j.auc > 0.7, `AUC ${j.auc}`);
  assert.ok(j.picked_mean_r > j.all_mean_r, "the rows it picks earn more R than all rows");
  assert.equal(auc([0.9, 0.1], [1, 0]), 1);
  assert.equal(auc([0.5, 0.5], [1, 0]), 0.5);
  assert.equal(auc([0.5], [1]), null);
  assert.equal(predict(null, {}), null);
  assert.ok(predict(m, { w_h1_lean: 0.9 }) > predict(m, { w_h1_lean: -0.9 }));
});

test("B2. the baseline trains every label set and side it has rows for, walk-forward, deterministically", () => {
  const b = trainBaseline(syntheticRows(), { now: T0 });
  assert.equal(b.status, "ok");
  assert.deepEqual(Object.keys(b.models).sort(), ["tight_long", "tight_short", "wide_long"], "wide short has too few decisive rows");
  assert.equal(b.checks.wide_short.status, "not_enough_rows");
  assert.ok(b.checks.tight_long.test_from > b.checks.tight_long.train_from, "judged on newer rows than it trained on");
  assert.equal(b.models.tight_long.top_features[0].feature, "w_h1_lean");
  assert.deepEqual(trainBaseline(syntheticRows(), { now: T0 }), b, "deterministic");
  assert.equal(trainBaseline(syntheticRows(50), { now: T0 }).status, "not_enough_rows");
});

test("B3. shadow predictions, the prospective record and the report for Aether carry no price", () => {
  const b = trainBaseline(syntheticRows(), { now: T0 });
  const s = shadowPredictions(b, { w_h1_lean: 0.8, noise: 0 });
  assert.equal(s.model_id, b.model_id);
  assert.ok(s.tight.long > 0.5 && s.tight.short < 0.5);
  assert.equal(s.tight.long_base, b.models.tight_long.base_rate);
  assert.equal(shadowPredictions(null, {}), null);
  // Prospective: predictions made before the outcome, scored once it came.
  const later = syntheticRows(200, 11).map((r) => ({ ...r, shadow: shadowPredictions(b, r.features) }));
  const p = prospectiveRecord(later);
  assert.ok(p.tight_long.n === 200 && p.tight_long.skill > 0, `prospective skill ${p.tight_long.skill}`);
  const report = modelReport(b, p, { now: T0 });
  assert.equal(report.schema, MODEL_REPORT_SCHEMA);
  assert.ok(report.walk_forward.tight_long.auc > 0.7);
  const text = JSON.stringify(report);
  assert.ok(!/"(entry|stop|tp1|tp2|price|level|weights|scale)"/.test(text), "no price key and no weights table");
  assert.equal(modelReport({ status: "not_enough_rows" }, {}), null);
});

test("B4. the hourly run retrains when stale, keeps the model in KV, and the report reaches Aether", async () => {
  const env = { SIGNAL_CACHE: kv() };
  const rows = syntheticRows();
  const r1 = await runModelBaseline(env, { now: T0, loadRows: async () => rows, loadLiveNotes: async () => [{ item_id: "k-a", version: 1, status: "live", agents: ["risk"], chart: "60", promoted_at: "2026-11-01T00:00:00Z", text: "not sent" }] });
  assert.equal(r1.status, "ok");
  // For Cerebrum: the gate state and the live notes travel with the report (ids and agents, not the text).
  assert.equal(r1.report.promotion.status, "not_promoted");
  assert.equal(r1.report.gate.min_n, 300);
  assert.deepEqual(r1.report.live_notes.map((n) => [n.item_id, n.status, n.agents[0]]), [["k-a", "live", "risk"]]);
  assert.ok(!("text" in r1.report.live_notes[0]));
  assert.ok(r1.report && r1.skills.tight_long > 0);
  assert.ok(env.SIGNAL_CACHE.m.has(MODEL_BASELINE_KEY));
  assert.equal((await runModelBaseline(env, { now: T0 + 10 * 60_000, loadRows: async () => rows })).status, "fresh");
  assert.ok(!("gbm" in r1.report), "no decision model yet: the report is as before");
  // The daily decision model rides along (owner 2026-11-13: "lanjutkan perluas model report gbm ke Aether"); a failing read drops it.
  const gbm = { model_id: "gbm@2026-11-13T04:22Z", trained_at: "2026-11-13T04:22:00Z", rows: 300, features: ["w_h1_lean"], status: "ok", models: {}, checks: {} };
  const r2 = await runModelBaseline(env, { now: T0 + BASELINE.retrain_ms + 1, loadRows: async () => rows, loadGbm: async () => gbm });
  assert.equal(r2.status, "ok");
  assert.equal(r2.report.gbm.model_id, "gbm@2026-11-13T04:22Z");
  assert.equal(r2.report.gbm.connected, false);
  const r3 = await runModelBaseline(env, { now: T0 + 2 * (BASELINE.retrain_ms + 1), loadRows: async () => rows, loadGbm: async () => { throw new Error("kv down"); } });
  assert.ok(r3.report && !("gbm" in r3.report));
  const status = baselineStatus(await readBaseline(env));
  assert.ok(status.checks.tight_long.auc > 0.7);
  assert.ok(!("models" in status), "the API shows scores and top features, not the weights");
  assert.deepEqual(await runModelBaseline({ ...env, MODEL_BASELINE_MODE: "off" }, { loadRows: async () => rows }), { status: "disabled" });
  // Aether: accepted, recorded; a binding without the method is disabled; a transport failure never throws.
  const sent = [];
  const db = d1();
  assert.equal((await pushModelReport({ DB: db, AETHER: { ingestModelReport: async (rep) => { sent.push(rep); return { accepted: true }; } } }, r1.report)).status, "accepted");
  assert.equal(sent[0].model_id, r1.report.model_id);
  assert.equal((await pushModelReport({ DB: db, AETHER: {} }, r1.report)).status, "disabled");
  assert.equal((await pushModelReport({ DB: db, AETHER: { ingestModelReport: async () => { throw new Error("no such method"); } } }, r1.report)).status, "transport_failed");
});

test("B5. the dataset stores the baseline's shadow predictions (point in time) and the wide labels after 12 hours", async () => {
  resetModelDatasetSchemaForTests();
  const M = 15 * 60_000;
  const bars = Array.from({ length: 140 }, (_, i) => { const c = 4000 + i * 0.5, o = c - 0.5; return { open_time: new Date(T0 + i * M).toISOString(), close_time: new Date(T0 + (i + 1) * M).toISOString(), open: o, high: c + 5, low: o - 5, close: c }; });
  const env = { DB: d1(), SIGNAL_CACHE: kv() };
  const baseline = trainBaseline(syntheticRows(), { now: T0 + 30 * M });
  env.SIGNAL_CACHE.m.set(MODEL_BASELINE_KEY, JSON.stringify(baseline));
  for (const k of [20, 40]) {
    const close = new Date(T0 + k * M).toISOString();
    env.DB.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(`OANDA:XAUUSD:15:${T0 + (k - 1) * M}`, close, close, "WAIT", 0, "council", JSON.stringify({ bar_close: close, stance: "WAIT", witnesses: [{ key: "H1", available: true, lean: 0.6 }] }));
  }
  const now = T0 + 140 * M; // 35 hours after T0: the bar at 20 has its 12 hours, so has the one at 40
  const r = await runModelDataset(env, { now, series: { bars, m15: bars } });
  assert.equal(r.added, 2);
  assert.equal(r.wide, 2);
  const rows = env.DB.raw.prepare("SELECT bar_close, shadow_json, wide_status, wide_json FROM model_dataset ORDER BY bar_close").all();
  assert.equal(rows[0].shadow_json, null, "the decision before the model was trained gets no prediction");
  assert.ok(JSON.parse(rows[1].shadow_json).tight.long > 0.5, "the later one does");
  assert.equal(rows[1].wide_status, "labeled");
  assert.ok(["target", "stop", "expired"].includes(JSON.parse(rows[1].wide_json).long.outcome));
  const loaded = await loadLabeledRows(env);
  assert.equal(loaded.length, 2);
  assert.ok(loaded[1].labels.wide && loaded[1].labels.tight.long.outcome);
  assert.equal(WIDE_RULES.stop_atr, 3);
});

test("B6. the model never reads the decision's own outputs (stance, bias, confidence, plan)", () => {
  const rows = syntheticRows().map((r) => ({ ...r, features: { ...r.features, stance: r.labels.tight.long.outcome === "target" ? 1 : -1, confidence: 0.7, plan_rrr: 2, bias: -1 } }));
  const m = fitLogistic(decisiveRows(rows, "tight", "long"));
  assert.ok(!m.keys.some((k) => /^(stance|bias|confidence|plan_)/.test(k)), m.keys.join(","));
});

test("B7. the gate connects a model only on a significant prospective record of both sides, and disconnects it", async () => {
  const { promotionGate, gateMessage, GATE } = await import("../src/model-baseline.mjs");
  const good = { n: 320, skill: 0.08, p_value: 0.004, auc: 0.62 };
  assert.equal(promotionGate({}).status, "not_promoted");
  assert.match(promotionGate({ tight_long: { ...good, n: 120 }, tight_short: good }).reason, /long: 120 of 300 decisions/);
  assert.match(promotionGate({ tight_long: { ...good, p_value: 0.2 }, tight_short: good }).reason, /not better than the base rate/);
  assert.match(promotionGate({ tight_long: { ...good, auc: 0.51 }, tight_short: good }).reason, /AUC 0.51/);
  const on = promotionGate({ tight_long: good, tight_short: good, wide_long: { ...good, skill: 0.12 }, wide_short: { ...good, skill: 0.1 } });
  assert.deepEqual([on.status, on.set], ["promoted", "wide"], "the set with the better weaker side");
  assert.equal(GATE.min_n, 300);
  assert.match(gateMessage(null, on), /connected \(autonomous\)/);
  assert.equal(gateMessage(on, on), null);
  assert.match(gateMessage(on, { status: "not_promoted", reason: "tight: long: AUC 0.5" }), /disconnected \(autonomous\)/);
  // The hourly run stores the gate and says when it changed; the switch keeps it disconnected.
  const env = { SIGNAL_CACHE: kv() };
  const r = await runModelBaseline(env, { now: T0, loadRows: async () => syntheticRows() });
  assert.equal(r.promotion, "not_promoted", "no prospective record yet");
  assert.equal(r.gate_message, null);
});

test("B8. once connected, the council gets the model's probabilities (no price); before, nothing changes", async () => {
  const { modelAdvice } = await import("../src/model-dataset.mjs");
  const { councilMessages } = await import("../src/decision-engine.mjs");
  const env = { SIGNAL_CACHE: kv() };
  const b = trainBaseline(syntheticRows(), { now: T0 });
  const M = 15 * 60_000;
  const bars = Array.from({ length: 120 }, (_, i) => ({ open_time: new Date(T0 + i * M).toISOString(), close_time: new Date(T0 + (i + 1) * M).toISOString(), open: 4000, high: 4006, low: 3994, close: 4001 }));
  const args = { barClose: bars[100].close_time, witnesses: [{ key: "H1", available: true, lean: 0.8 }], quorum: { score: 0.5 }, guardrails: {}, context: {}, series: { m15: bars } };
  env.SIGNAL_CACHE.m.set(MODEL_BASELINE_KEY, JSON.stringify({ ...b, promotion: { status: "not_promoted" } }));
  assert.equal(await modelAdvice(env, args), null, "not connected: no advice");
  assert.ok(!councilMessages({ context: {} })[0].content.includes("context.model"));
  env.SIGNAL_CACHE.m.set(MODEL_BASELINE_KEY, JSON.stringify({ ...b, promotion: { status: "promoted", set: "tight", since: "2026-11-20T00:00:00Z" } }));
  const advice = await modelAdvice(env, args);
  assert.ok(advice.long_target_first > advice.short_target_first, "the H1 lean up favours the long side");
  assert.equal(advice.label_set, "tight");
  assert.ok(!/"(entry|stop|tp1|tp2|price)"/.test(JSON.stringify(advice)));
  assert.ok(councilMessages({ context: { model: advice } })[0].content.includes("context.model is the platform's own model"));
});

test("B9. the dataset stores the decision model's shadow predictions beside the baseline's (point in time)", async () => {
  const { MODEL_GBM_KEY, MODEL_GBM_VERSION, resetGbmCacheForTests } = await import("../src/model-gbm.mjs");
  resetModelDatasetSchemaForTests(); resetGbmCacheForTests();
  const M = 15 * 60_000;
  const bars = Array.from({ length: 60 }, (_, i) => ({ open_time: new Date(T0 + i * M).toISOString(), close_time: new Date(T0 + (i + 1) * M).toISOString(), open: 4000, high: 4005, low: 3995, close: 4001 }));
  const env = { DB: d1(), SIGNAL_CACHE: kv() };
  env.SIGNAL_CACHE.m.set(MODEL_GBM_KEY, JSON.stringify({ version: MODEL_GBM_VERSION, model_id: "gbm@x", trained_at: new Date(T0 + 30 * M).toISOString(), features: ["w_h1_lean"], models: { tight_long: { base_rate: 0.4, trees: [[0, 0, 0, 0, -1, 1]] } } }));
  for (const k of [20, 40]) {
    const close = new Date(T0 + k * M).toISOString();
    env.DB.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, 'WAIT', 0, 'council', ?)").run(`OANDA:XAUUSD:15:${T0 + (k - 1) * M}`, close, close, JSON.stringify({ bar_close: close, witnesses: [{ key: "H1", available: true, lean: 0.6 }] }));
  }
  await runModelDataset(env, { now: T0 + 60 * M, series: { bars, m15: bars } });
  const rows = env.DB.raw.prepare("SELECT shadow_json FROM model_dataset ORDER BY bar_close").all();
  assert.equal(rows[0].shadow_json, null, "before the model was trained: nothing");
  const s = JSON.parse(rows[1].shadow_json);
  assert.equal(s.gbm.model_id, "gbm@x");
  assert.ok(s.gbm.tight.long > 0.5);
});

// ---------------------------------------------------------------- MA1 (orchestrator 2026-11-26)

/** Rows whose label follows a one-hot session (rare London rows win long) and nothing else. */
function sessionRows(n = 400, seed = 11) {
  const r = rng(seed);
  const SESSIONS = ["asia", "asia", "asia", "asia", "london", "new_york", "new_york", "new_york", "new_york", "new_york"];
  return Array.from({ length: n }, (_, i) => {
    const s = SESSIONS[Math.floor(r() * SESSIONS.length)];
    const up = r() < (s === "london" ? 0.9 : 0.25);
    return {
      bar_close: new Date(T0 + i * 900_000).toISOString(),
      features: { [`session_${s}`]: 1, noise: r() * 2 - 1, ...(i % 3 === 0 ? {} : i % 3 === 1 ? { w_h1_state_ready: 1 } : { w_h1_state_wait: 1 }) },
      labels: { tight: { long: { outcome: up ? "target" : "stop", r: up ? 1.5 : -1 }, short: { outcome: up ? "stop" : "target", r: up ? -1 : 1.5 } } }
    };
  });
}

test("MA1-1 one-hot groups: a missing value of a present group reads 0, an absent group stays missing; the selector keeps them", async () => {
  const { oneHotGroup, withOneHotZeros } = await import("../src/model-gbm.mjs");
  const { selectFeatures } = await import("../src/model-baseline.mjs");
  assert.deepEqual(["session_london", "mode_intraday", "regime_trend_up", "w_h1_state_ready", "w_strategy_agents_phase_late", "w_h1_lean", "w_h1_available", "noise", "plan_action_limit"].map(oneHotGroup),
    ["session", "mode", "regime", "w_h1_state", "w_strategy_agents_phase", null, null, null, null]);
  const keys = ["session_asia", "session_london", "regime_range", "w_h1_lean"];
  assert.deepEqual(withOneHotZeros({ session_london: 1, w_h1_lean: 0.3 }, keys), { session_london: 1, w_h1_lean: 0.3, session_asia: 0 }, "regime absent: stays missing");
  const f = { w_h1_lean: 0.3 };
  assert.equal(withOneHotZeros(f, keys), f, "no group present: the same object");
  // Before MA1 the 10 % London rows fell under the 20 % presence rule and every kept one-hot was constant (1).
  const scale = selectFeatures(sessionRows());
  assert.ok(["session_asia", "session_london", "session_new_york", "w_h1_state_ready", "w_h1_state_wait"].every((k) => k in scale), Object.keys(scale).join(","));
  // A group with one value is constant where present (always 1): it carries nothing and stays out.
  assert.ok(!("regime_up" in selectFeatures(sessionRows().map((r) => ({ ...r, features: { ...r.features, regime_up: 1 } })))));
  assert.ok(scale.session_london[0] > 0 && scale.session_london[0] < 0.2, "a 0/1 feature: its mean is its share");
  assert.ok(!Object.keys(scale).some((k) => k.startsWith("plan_")), "decision outputs stay out");
});

test("MA1-2 the baseline learns from a one-hot: the London rows get the higher long probability", () => {
  const b = trainBaseline(sessionRows(), { now: T0 });
  const m = b.models.tight_long;
  assert.ok(m.keys.includes("session_london"));
  assert.ok(predict(m, { session_london: 1 }) > predict(m, { session_new_york: 1 }) + 0.2, "London 0.9 against New York 0.25");
  assert.equal(predict(m, { session_london: 1 }), predict(m, { session_london: 1, session_asia: 0, session_new_york: 0 }), "the live row (one key) reads as the training row (zeros)");
});

test("MA1-3 the gbm evaluator reads one-hot groups as the trainer does", async () => {
  const { predictGbm } = await import("../src/model-gbm.mjs");
  // One tree: split on session_asia (index 0) at 0.5 with NaN going right; 0 must go left.
  const model = { trees: [[0, 0.5, 0, 2, -1, 1]] };
  const names = ["session_asia"];
  assert.ok(predictGbm(model, { session_london: 1 }, names) < 0.5, "London row: session_asia reads 0, left");
  assert.ok(predictGbm(model, { session_asia: 1 }, names) > 0.5);
  assert.ok(predictGbm(model, { noise: 1 }, names) > 0.5, "no session at all: missing, NaN goes right");
});

test("MA1-4 walk-forward: the training rows whose label window reaches the test period are purged (4 h tight, 12 h wide)", () => {
  assert.deepEqual(BASELINE.purge_ms, { tight: 4 * 3_600_000, wide: 12 * 3_600_000 });
  const rows = syntheticRows();
  const b = trainBaseline(rows, { now: T0 });
  // 15-minute rows: the 15 rows less than 4 h before the test's first close go, 47 for 12 h (a row exactly 4 h
  // before it is kept: its label window ends where the test period's first one starts).
  const cut = Math.floor(400 * BASELINE.train_share);
  assert.equal(b.checks.tight_long.purged, 15);
  assert.equal(b.checks.tight_long.train, cut - 15);
  const wideLong = decisiveRows(rows, "wide", "long");
  assert.ok(b.checks.wide_long.purged > 15 && b.checks.wide_long.purged <= 47, String(b.checks.wide_long.purged));
  assert.equal(b.checks.wide_long.train, Math.floor(wideLong.length * BASELINE.train_share) - b.checks.wide_long.purged);
  assert.equal(b.models.tight_long.n, 400, "the final model trains on every row");
  // Without the purge the check is today's.
  const unpurged = trainBaseline(rows, { now: T0, rules: { ...BASELINE, purge_ms: { tight: 0, wide: 0 } } });
  assert.equal(unpurged.checks.tight_long.purged, 0);
  assert.equal(unpurged.checks.tight_long.train, cut);
});

test("MA1-5 skill against the test period's own base rate sits beside the training-base skill; the gate and Aether's report are unchanged", () => {
  const model = { keys: [], scale: {}, weights: [], bias: 0, base_rate: 0.3 };
  // A constant model at the training base rate 0.3 on a test period whose hit rate is 0.6.
  const flat = { ...model, keys: ["x"], scale: { x: [0, 1] }, weights: [0], bias: Math.log(0.3 / 0.7) };
  const rows = Array.from({ length: 10 }, (_, i) => ({ features: { x: 0 }, y: i < 6 ? 1 : 0, r: 0 }));
  const j = judge(flat, rows);
  assert.equal(j.skill, 0, "the training base rate itself: no skill against it");
  assert.equal(j.brier_test_base, 0.24);
  assert.ok(j.skill_test_base < 0, "worse than the test period's own rate");
  const b = trainBaseline(syntheticRows(), { now: T0 });
  b.promotion = null;
  const rep = modelReport(b, {});
  for (const scores of Object.values(rep.walk_forward)) {
    assert.ok(!("skill_test_base" in scores) && !("brier_test_base" in scores) && !("purged" in scores), "Aether's schema refuses other scores");
    assert.ok("skill" in scores && "train" in scores);
  }
  assert.ok("skill_test_base" in baselineStatus(b).checks.tight_long, "the API shows it");
});

test("MA1-6 MODEL_AUTO_CONNECT off disconnects the advice at once, before the next retrain", async () => {
  const { modelAdvice } = await import("../src/model-dataset.mjs");
  const b = trainBaseline(syntheticRows(), { now: T0 });
  const M = 15 * 60_000;
  const bars = Array.from({ length: 120 }, (_, i) => ({ open_time: new Date(T0 + i * M).toISOString(), close_time: new Date(T0 + (i + 1) * M).toISOString(), open: 4000, high: 4006, low: 3994, close: 4001 }));
  const args = { barClose: bars[100].close_time, witnesses: [{ key: "H1", available: true, lean: 0.8 }], quorum: { score: 0.5 }, guardrails: {}, context: {}, series: { m15: bars } };
  const env = { SIGNAL_CACHE: kv() };
  env.SIGNAL_CACHE.m.set(MODEL_BASELINE_KEY, JSON.stringify({ ...b, promotion: { status: "promoted", set: "tight", since: "2026-11-20T00:00:00Z" } }));
  assert.ok(await modelAdvice(env, args), "promoted, the switch on (default)");
  assert.equal(await modelAdvice({ ...env, MODEL_AUTO_CONNECT: "off" }, args), null, "the stored promotion is ignored while off");
  assert.ok(await modelAdvice({ ...env, MODEL_AUTO_CONNECT: "on" }, args));
});

test("MA1-7 the trainer mirrors the one-hot groups, the purge and the test-base skill", () => {
  const py = readFileSync(new URL("../scripts/train_gbm.py", import.meta.url), "utf8");
  const js = readFileSync(new URL("../src/model-gbm.mjs", import.meta.url), "utf8");
  const jsRe = js.match(/const ONE_HOT = \/(.+)\/;/)[1];
  const pyRe = py.match(/ONE_HOT = re\.compile\(r"(.+)"\)/)[1];
  assert.equal(pyRe, jsRe, "the same one-hot rule");
  assert.match(py, /"purge_hours": \{"tight": 4, "wide": 12\}/);
  assert.match(py, /"skill_test_base"/);
  assert.match(py, /matrix\(rows, features\):\n    filled = \[with_one_hot_zeros/);
});

// ---------------------------------------------------------------- MA1 (b) (orchestrator 2026-11-26)

const GBM_NOW = Date.parse("2026-11-26T06:00:00Z");
async function gbmFixture({ trainedAt = "2026-11-26T04:20:00Z", longLeaf = 0.8, shortLeaf = -0.8 } = {}) {
  const { MODEL_GBM_VERSION } = await import("../src/model-gbm.mjs");
  // One split on w_h1_lean (index 0) at 0: above, the leaf; below, its opposite.
  const tree = (leaf) => [0, 0, 0, 2, -leaf, leaf];
  return {
    version: MODEL_GBM_VERSION, model_id: "gbm@2026-11-26T04:20Z", trained_at: trainedAt, rows: 900, features: ["w_h1_lean"], status: "ok",
    models: { tight_long: { base_rate: 0.35, n: 600, trees: [tree(longLeaf)] }, tight_short: { base_rate: 0.35, n: 600, trees: [tree(shortLeaf)] } },
    checks: {}
  };
}
const passing = (skill = 0.06) => ({ tight_long: { n: 320, skill, p_value: 0.01, auc: 0.6 }, tight_short: { n: 310, skill: skill + 0.01, p_value: 0.02, auc: 0.58 } });

test("MA1b-1 the GBM's gate: the baseline's rules on its own record; stale, invalid or MODEL_AUTO_CONNECT off never pass; without the owner's switch a pass is would_promote", async () => {
  const { gbmGate } = await import("../src/model-baseline.mjs");
  const gbm = await gbmFixture();
  const off = gbmGate(gbm, passing(), { now: GBM_NOW });
  assert.equal(off.status, "would_promote", "MODEL_GBM_CONNECT defaults off");
  assert.equal(off.set, "tight");
  assert.equal(off.skill, 0.06, "the worse side's skill");
  assert.match(off.reason, /MODEL_GBM_CONNECT is off/);
  const on = gbmGate(gbm, passing(), { now: GBM_NOW, connect: "on" });
  assert.equal(on.status, "promoted");
  assert.deepEqual(on.record.long, { decisions: 320, skill: 0.06, auc: 0.6 });
  assert.equal(gbmGate(gbm, passing(), { now: GBM_NOW + 3_600_000, connect: "on", previous: on }).since, on.since, "since holds while the status and set hold");
  assert.equal(gbmGate(gbm, passing(), { now: GBM_NOW, autoConnect: "off", connect: "on" }).status, "not_promoted");
  const stale = gbmGate(await gbmFixture({ trainedAt: "2026-11-24T05:00:00Z" }), passing(), { now: GBM_NOW, connect: "on" });
  assert.equal(stale.status, "not_promoted");
  assert.match(stale.reason, /older than 48 hours/);
  const invalid = gbmGate({ ...gbm, version: "other" }, passing(), { now: GBM_NOW, connect: "on" });
  assert.equal(invalid.status, "not_promoted");
  assert.match(invalid.reason, /invalid decision model/);
  assert.equal(gbmGate(null, passing(), { now: GBM_NOW, connect: "on" }).status, "not_promoted");
  const few = { ...passing(), tight_short: { n: 120, skill: 0.2, p_value: 0.001, auc: 0.7 } };
  assert.equal(gbmGate(gbm, few, { now: GBM_NOW, connect: "on" }).status, "not_promoted", "both sides need 300");
  const { tight_short, ...oneSide } = gbm.models;
  assert.equal(gbmGate({ ...gbm, models: oneSide }, passing(), { now: GBM_NOW, connect: "on" }).status, "not_promoted", "a set needs both side models");
});

test("MA1b-2 the hourly run writes the AI Worker's own key and never model:gbm:v1", async () => {
  const { MODEL_GBM_KEY, MODEL_GBM_PROMOTION_KEY } = await import("../src/model-gbm.mjs");
  const gbm = await gbmFixture();
  const store = kv();
  const puts = [];
  const put = store.put.bind(store);
  store.put = async (k, v, o) => { puts.push(k); return put(k, v, o); };
  const stored = JSON.stringify(gbm);
  store.m.set(MODEL_GBM_KEY, stored);
  const out = await runModelBaseline({ SIGNAL_CACHE: store }, { now: GBM_NOW, loadRows: async () => syntheticRows(), loadGbm: async () => gbm });
  assert.equal(out.status, "ok");
  assert.deepEqual([...new Set(puts)].sort(), [MODEL_BASELINE_KEY, MODEL_GBM_PROMOTION_KEY].sort());
  assert.equal(store.m.get(MODEL_GBM_KEY), stored, "the training workflow's key is untouched");
  const p = JSON.parse(store.m.get(MODEL_GBM_PROMOTION_KEY));
  assert.equal(p.status, "not_promoted", "no prospective record yet");
  assert.equal(p.model_id, gbm.model_id);
  assert.equal(out.gbm_promotion, "not_promoted");
  assert.equal(out.report.gbm.connected, false, "Aether's schema: always false in the report");
});

test("MA1b-3 one advice: the GBM only with the owner's switch, a promoted key and a fresh model; both promoted, the higher worse-side skill wins and a tie goes to the baseline", async () => {
  const { modelAdvice } = await import("../src/model-dataset.mjs");
  const { MODEL_GBM_KEY, MODEL_GBM_PROMOTION_KEY, resetGbmCacheForTests } = await import("../src/model-gbm.mjs");
  const { gbmGate } = await import("../src/model-baseline.mjs");
  const b = trainBaseline(syntheticRows(), { now: T0 });
  const M = 15 * 60_000;
  const bars = Array.from({ length: 120 }, (_, i) => ({ open_time: new Date(T0 + i * M).toISOString(), close_time: new Date(T0 + (i + 1) * M).toISOString(), open: 4000, high: 4006, low: 3994, close: 4001 }));
  const args = { barClose: bars[100].close_time, witnesses: [{ key: "H1", available: true, lean: 0.8 }], quorum: { score: 0.5 }, guardrails: {}, context: {}, series: { m15: bars }, now: GBM_NOW };
  const gbm = await gbmFixture();
  const setup = ({ baselineSkill = null, gbmSkill = 0.06, gbmModel = gbm } = {}) => {
    resetGbmCacheForTests();
    const env = { SIGNAL_CACHE: kv() };
    env.SIGNAL_CACHE.m.set(MODEL_GBM_KEY, JSON.stringify(gbmModel));
    env.SIGNAL_CACHE.m.set(MODEL_GBM_PROMOTION_KEY, JSON.stringify(gbmGate(gbmModel, passing(gbmSkill), { now: GBM_NOW, connect: "on" })));
    env.SIGNAL_CACHE.m.set(MODEL_BASELINE_KEY, JSON.stringify({ ...b, prospective: baselineSkill == null ? {} : passing(baselineSkill), promotion: baselineSkill == null ? { status: "not_promoted" } : { status: "promoted", set: "tight", since: "2026-11-20T00:00:00Z" } }));
    return env;
  };
  // The GBM alone: nothing without the owner's switch; with it, the GBM's probabilities.
  assert.equal(await modelAdvice(setup(), args), null, "MODEL_GBM_CONNECT off (default)");
  const g = await modelAdvice({ ...setup(), MODEL_GBM_CONNECT: "on" }, args);
  assert.equal(g.source, "gbm");
  assert.equal(g.reason, "gbm: the only model connected");
  assert.ok(g.long_target_first > 0.5 && g.short_target_first < 0.5, "the H1 lean up: the long leaf");
  assert.equal(g.long_base_rate, 0.35);
  assert.equal(g.record.long.decisions, 320);
  assert.equal(await modelAdvice({ ...setup(), MODEL_GBM_CONNECT: "on", MODEL_AUTO_CONNECT: "off" }, args), null);
  assert.equal(await modelAdvice({ ...setup({ gbmModel: await gbmFixture({ trainedAt: "2026-11-23T00:00:00Z" }) }), MODEL_GBM_CONNECT: "on" }, args), null, "stale at advice time");
  // Both promoted.
  const base = await modelAdvice({ ...setup({ baselineSkill: 0.05, gbmSkill: 0.05 }), MODEL_GBM_CONNECT: "on" }, args);
  assert.equal(base.source, "baseline", "a tie goes to the baseline");
  assert.match(base.reason, /a tie goes to the baseline/);
  assert.equal((await modelAdvice({ ...setup({ baselineSkill: 0.05, gbmSkill: 0.09 }), MODEL_GBM_CONNECT: "on" }, args)).source, "gbm");
  assert.equal((await modelAdvice({ ...setup({ baselineSkill: 0.09, gbmSkill: 0.05 }), MODEL_GBM_CONNECT: "on" }, args)).source, "baseline");
  assert.equal((await modelAdvice(setup({ baselineSkill: 0.05, gbmSkill: 0.09 }), args)).source, "baseline", "the GBM's switch off: the baseline alone");
  assert.ok(!/"(entry|stop|tp1|tp2|price)"/.test(JSON.stringify(g)));
});

test("MA1b-4 the owner hears only of a real connection; /api/model/gbm shows the gate; the FS1 row defaults off", async () => {
  const { gbmGateMessage } = await import("../src/model-baseline.mjs");
  const { gbmStatus } = await import("../src/model-gbm.mjs");
  const { switchByKey } = await import("../src/feature-switches.mjs");
  assert.equal(gbmGateMessage({ status: "not_promoted" }, { status: "would_promote", set: "tight" }), null, "would_promote is no connection");
  assert.match(gbmGateMessage({ status: "would_promote", set: "tight" }, { status: "promoted", set: "tight", reason: "r" }), /Decision model \(GBM\) connected/);
  assert.match(gbmGateMessage({ status: "promoted", set: "tight" }, { status: "not_promoted", reason: "stale" }), /disconnected/);
  const st = gbmStatus(await gbmFixture(), {}, { status: "would_promote", set: "tight", reason: "x", since: "2026-11-26T06:00:00.000Z", checked_at: "2026-11-26T06:00:00.000Z", record: {}, skill: 0.06 });
  assert.deepEqual(st.promotion, { status: "would_promote", set: "tight", reason: "x", since: "2026-11-26T06:00:00.000Z", checked_at: "2026-11-26T06:00:00.000Z" });
  assert.ok(!JSON.stringify(st).includes("trees"));
  const row = switchByKey("MODEL_GBM_CONNECT");
  assert.equal(row.default_value, "off");
  assert.doesNotMatch(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"), /MODEL_GBM_CONNECT/, "off until the owner turns it on in FS1");
});
