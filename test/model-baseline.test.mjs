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
  const r1 = await runModelBaseline(env, { now: T0, loadRows: async () => rows });
  assert.equal(r1.status, "ok");
  assert.ok(r1.report && r1.skills.tight_long > 0);
  assert.ok(env.SIGNAL_CACHE.m.has(MODEL_BASELINE_KEY));
  assert.equal((await runModelBaseline(env, { now: T0 + 10 * 60_000, loadRows: async () => rows })).status, "fresh");
  assert.equal((await runModelBaseline(env, { now: T0 + BASELINE.retrain_ms + 1, loadRows: async () => rows })).status, "ok");
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
