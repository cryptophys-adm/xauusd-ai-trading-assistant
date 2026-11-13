// Owner 2026-11-13: the custom model's dataset (docs/RFC_CUSTOM_MODEL.md, step 1): point-in-time features
// and triple-barrier labels per Decision Engine decision, no price in the features.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  datasetFeatures, barFeatures, tripleBarrier, runModelDataset, readModelDataset, readModelDatasetSummary,
  resetModelDatasetSchemaForTests, LABEL_RULES, MODEL_DATASET_VERSION
} from "../src/model-dataset.mjs";
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

const M = 15 * 60_000;
const T0 = Date.parse("2026-11-12T00:00:00Z");
/** 15m bars from T0 with a 10-wide range around `close(i)`. */
const m15 = (n, close = (i) => 4000 + i * 0.5) => Array.from({ length: n }, (_, i) => {
  const c = close(i), o = close(i - 1);
  return { open_time: new Date(T0 + i * M).toISOString(), close_time: new Date(T0 + (i + 1) * M).toISOString(), open: o, high: Math.max(o, c) + 5, low: Math.min(o, c) - 5, close: c };
});

const DECISION = {
  bar_close: new Date(T0 + 40 * M).toISOString(),
  stance: "SELL", bias: "BEARISH", confidence: 0.78, trading_mode: "scalp", feed: "tradingview",
  witnesses: [
    { key: "H1", weight: 0.1469, available: true, stale: false, lean: -0.84, confidence: 0.86, decision: "SELL" },
    { key: "STRATEGY", weight: 0.0735, available: true, stale: false, lean: -0.75, confidence: 0.6, decision: "WAIT", state: "SETUP_READY" },
    { key: "M15", weight: 0.11, available: true, stale: true, lean: -0.5, confidence: 0.8, decision: "SELL" },
    { key: "CALENDAR", weight: 0.08, available: false, lean: null, phase: null }
  ],
  quorum: { score: -0.6, long_share: 0, short_share: 1, neutral_share: 0.13, weight: 0.71, witnesses: 11 },
  guardrails: {
    long: { allowed: false, checks: [{ id: "fresh", pass: true }, { id: "quorum", pass: false }], entry_trigger: { fired: false } },
    short: { allowed: true, checks: [{ id: "fresh", pass: true }, { id: "quorum", pass: true }], entry_trigger: { fired: true } }
  },
  trade: { side: "SELL", action: "ENTER_LIMIT", entry: 3879.75, stop: 3897.7, tp1: 3871.62, risk: 17.95, rrr: 0.45, rrr_all: { tp2: 3 }, at_level: true },
  structure: { h4: { trend: "down" }, h1: { trend: "down" }, m15: { trend: "up" } },
  context: {
    regime_1h: "high-trending",
    events: { active: [], next: [{ title: "PPI", time: new Date(T0 + 40 * M + 6 * 3600_000).toISOString() }] },
    cross_assets: [{ name: "US Dollar Index", change_1d: 0.24, correlation_with_gold: -0.258 }, { name: "Silver", change_1d: -3.83, correlation_with_gold: 0.91 }],
    market: { sentiment: { weighted_lean: -0.6, composite: -0.35 }, calendar: { consensus_lean: 0.24, surprise_lean: 0 } }
  }
};

test("D1. features are numbers only, point in time, with no price", () => {
  const f = datasetFeatures(DECISION, { atr: 10, bars: { px_move_4: -1.2 } });
  for (const [k, v] of Object.entries(f)) assert.equal(typeof v, "number", `${k} is a number`);
  assert.equal(f.stance, -1);
  assert.equal(f.w_h1_lean, -0.84);
  assert.equal(f.w_h1_available, 1);
  assert.equal(f.w_m15_available, 0, "a stale witness did not count");
  assert.equal(f.w_m15_lean, 0);
  assert.equal(f.w_strategy_state_setup_ready, 1);
  assert.equal(f.w_d1_available, 0, "a witness missing from the record reads as not available");
  assert.equal(f.g_long_quorum, 0);
  assert.equal(f.g_short_quorum, 1);
  assert.equal(f.g_short_trigger_fired, 1);
  assert.equal(f.plan_risk_atr, 1.795, "the plan's risk in ATR, not in price");
  assert.equal(f.plan_action_enter_limit, 1);
  assert.equal(f.structure_m15, 1);
  assert.equal(f.regime_high_trending, 1);
  assert.equal(f.events_next_hours, 6);
  assert.equal(f.x_dollar_index_change_1d, 0.24);
  assert.equal(f.px_move_4, -1.2);
  assert.equal(f.session_london, 1, "the bar opened at 09:45 UTC");
  // No price anywhere: neither the plan's levels nor the key-level prices.
  const values = Object.values(f);
  for (const p of [3879.75, 3897.7, 3871.62, 17.95]) assert.ok(!values.includes(p), `price ${p} is not a feature`);
  assert.ok(!Object.keys(f).some((k) => /entry|stop|tp1|tp2|price/.test(k)), "no price-named feature");
});

test("D2. bar features are moves and positions in ATR from the bars up to the decision's close only", () => {
  const bars = m15(120);
  const f = barFeatures(bars, 100, 10);
  assert.equal(f.px_move_1, 0.05, "0.5 per bar over an ATR of 10");
  assert.equal(f.px_move_16, 0.8);
  assert.ok(f.px_range_pos_20 > 0.5 && f.px_range_pos_20 <= 1);
  // Point in time: changing the bars after index 100 changes nothing.
  const later = bars.map((b, i) => (i > 100 ? { ...b, close: 9999, high: 9999, low: 9999 } : b));
  assert.deepEqual(barFeatures(later, 100, 10), f);
  assert.deepEqual(barFeatures(bars, 100, null), {}, "no ATR, no bar features");
});

test("D3. the triple barrier: target or stop first, a bar touching both is the stop, expired in R at the horizon", () => {
  const from = T0;
  const bar = (i, high, low, close) => ({ open_time: new Date(from + i * M).toISOString(), close_time: new Date(from + (i + 1) * M).toISOString(), open: 4000, high, low, close });
  const fill = (n, close = 4001) => Array.from({ length: n }, (_, i) => bar(i, 4004, 3996, close));
  // Long from 4000, ATR 10: target 4015, stop 3990.
  assert.equal(tripleBarrier([bar(0, 4016, 3995, 4012), ...fill(20).slice(1)], { fromMs: from, ref: 4000, atr: 10, side: 1 }).outcome, "target");
  assert.equal(tripleBarrier([bar(0, 4016, 3995, 4012), ...fill(20).slice(1)], { fromMs: from, ref: 4000, atr: 10, side: 1 }).r, 1.5);
  assert.equal(tripleBarrier([bar(0, 4016, 3989, 4000), ...fill(20).slice(1)], { fromMs: from, ref: 4000, atr: 10, side: 1 }).outcome, "stop", "both in one bar: the stop");
  assert.equal(tripleBarrier([bar(0, 4016, 3989, 4000), ...fill(20).slice(1)], { fromMs: from, ref: 4000, atr: 10, side: -1 }).outcome, "stop", "a short's stop is above");
  const exp = tripleBarrier(fill(20, 4005), { fromMs: from, ref: 4000, atr: 10, side: 1 });
  assert.equal(exp.outcome, "expired");
  assert.equal(exp.r, 0.5, "the move at the horizon in R");
  assert.equal(exp.at, new Date(from + LABEL_RULES.horizon_ms).toISOString());
  assert.equal(tripleBarrier(fill(10), { fromMs: from, ref: 4000, atr: 10, side: 1 }).outcome, "pending", "the horizon is not covered yet");
  // A closed market for the whole horizon (bars only after it): no bars.
  assert.equal(tripleBarrier([bar(40, 4004, 3996, 4001)], { fromMs: from, ref: 4000, atr: 10, side: 1 }).outcome, "no_bars");
});

test("D4. the ledger step backfills the stored decisions, labels them after the horizon, and pages the export", async () => {
  resetModelDatasetSchemaForTests();
  const env = { DB: d1() };
  const bars = m15(140);
  for (const k of [40, 41, 130]) {
    const close = new Date(T0 + k * M).toISOString(), open = T0 + (k - 1) * M;
    const d = { ...DECISION, bar_close: close, decision_key: `OANDA:XAUUSD:15:${open}` };
    env.DB.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(d.decision_key, close, close, "SELL", 0.78, "council", JSON.stringify(d));
  }
  const now = T0 + 140 * M;
  const r1 = await runModelDataset(env, { now, series: { bars, m15: bars } });
  assert.deepEqual(r1, { status: "ok", added: 3, labeled: 2, unavailable: 0 }, "the last decision's 4 hours have not passed");
  const again = await runModelDataset(env, { now, series: { bars, m15: bars } });
  assert.deepEqual(again, { status: "ok", added: 0, labeled: 0, unavailable: 0 }, "idempotent");
  const row = env.DB.raw.prepare("SELECT * FROM model_dataset ORDER BY bar_close LIMIT 1").get();
  assert.equal(row.version, MODEL_DATASET_VERSION);
  assert.equal(row.label_status, "labeled");
  assert.equal(row.ref_close, bars[39].close, "the reference is the decision bar's close");
  assert.ok(["target", "stop", "expired"].includes(row.long_outcome));
  const feats = JSON.parse(row.features_json);
  assert.ok(Number.isFinite(feats.px_move_16) && Number.isFinite(feats.atr_rel_96 ?? 1));
  const page = await readModelDataset(env, { limit: 1 });
  assert.equal(page.rows.length, 1);
  assert.equal(typeof page.rows[0].features, "object");
  assert.equal(page.next, page.rows[0].bar_close);
  const rest = await readModelDataset(env, { since: page.next, limit: 10 });
  assert.equal(rest.rows.length, 1, "only labeled rows are exported");
  const summary = await readModelDatasetSummary(env);
  assert.deepEqual(summary.by_status.map((s) => [s.label_status, s.n]).sort(), [["labeled", 2], ["pending", 1]]);
  assert.ok(summary.latest_feature_count > 30);
  // A decision whose 15m bar was never cached: unavailable once its horizon passed.
  env.DB.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run("OANDA:XAUUSD:15:1", "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z", "WAIT", 0, "council", JSON.stringify({ ...DECISION, bar_close: "2026-11-01T00:00:00.000Z" }));
  assert.equal((await runModelDataset(env, { now, series: { bars, m15: bars } })).unavailable, 1);
  assert.deepEqual(await runModelDataset({ DB: env.DB, MODEL_DATASET_MODE: "off" }, { now }), { status: "disabled" });
});
