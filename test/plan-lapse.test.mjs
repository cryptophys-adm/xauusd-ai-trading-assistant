// Track A PR 6 (orchestrator queue A6): the plan learner replays a plan's lapse (valid_until_ms). At the first close at
// or after it, a filled trade in profit closes there; a losing one keeps its stop and target. Without a lapse every arm
// and the Signal Ledger are exactly as before. A per pattern@chart record is evidence only.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { simulateSignal } from "../src/signal-ledger.mjs";
import { replaySetup, decisionPlans, setupsFrom, agentRecords, ensurePlanLearningSchema, resetPlanLearningSchemaCacheForTests, CONTROL_ARM } from "../src/plan-learning.mjs";
import { slimPlan } from "../src/strategy-agents.mjs";

const T0 = Date.parse("2026-11-20T10:00:00Z"), M15 = 15 * 60_000;
const bar = (i, o, h, l, c) => ({ open_time: new Date(T0 + i * M15).toISOString(), close_time: new Date(T0 + (i + 1) * M15).toISOString(), open: o, high: h, low: l, close: c });
// A long at 100, stop 98, target 106: filled on bar 0, then drifting.
const SIGNAL = { side: "BUY", entry: 100, stop: 98, tp1: 106, opened_at: new Date(T0).toISOString() };
const UP = [bar(0, 100.2, 100.5, 99.8, 100.3), bar(1, 100.3, 101.2, 100.2, 101), bar(2, 101, 101.6, 100.8, 101.4), bar(3, 101.4, 102, 101.2, 101.8), bar(4, 101.8, 103, 101.5, 102.5)];
const DOWN = [bar(0, 100.2, 100.5, 99.8, 100.1), bar(1, 100.1, 100.3, 99.2, 99.5), bar(2, 99.5, 99.7, 99, 99.3), bar(3, 99.3, 99.4, 97.5, 97.9), bar(4, 97.9, 98.5, 97.6, 98.2)];
const NOW = T0 + 10 * M15;

test("PL6-1 the lapse: a winner closes at the first close at or after it; a loser keeps its stop and target; without it, today's result", () => {
  const lapse = T0 + 2 * M15 + 1;   // inside bar 2: its close (101.4) is the first close at or after it
  const up = simulateSignal(SIGNAL, UP, { now: NOW, lapseMs: lapse });
  assert.deepEqual([up.status, up.exit_reason, up.r_tp1, up.closed_at], ["closed", "lapse", 0.7, UP[2].close_time]);
  const down = simulateSignal(SIGNAL, DOWN, { now: NOW, lapseMs: lapse });
  assert.equal(down.exit_reason, "stop", "a losing trade keeps its stop (bar 3 reaches 98)");
  assert.deepEqual(down, simulateSignal(SIGNAL, DOWN, { now: NOW }), "the loser is exactly today's");
  // Without lapseMs (or with one beyond the bars), the result is exactly today's.
  assert.deepEqual(simulateSignal(SIGNAL, UP, { now: NOW, lapseMs: undefined }), simulateSignal(SIGNAL, UP, { now: NOW }));
  assert.deepEqual(simulateSignal(SIGNAL, UP, { now: NOW, lapseMs: T0 + 50 * M15 }), simulateSignal(SIGNAL, UP, { now: NOW }));
  // A lapse before the fill: checked at the first close after the fill.
  assert.equal(simulateSignal(SIGNAL, UP, { now: NOW, lapseMs: T0 - M15 }).exit_reason, "lapse");
});

test("PL6-2 the plan carries chart and valid_until_ms from slimPlan through decisionPlans and setupsFrom into the replay", () => {
  const plan = { entry: 100, stop: 98, tp1: 106, tp2: 110, at_level: false, rrr: { tp1: 3, tp2: 5 }, setup: "x", pattern: "flag", chart: "15m", valid_until_ms: T0 + 2 * M15 + 1 };
  const slim = slimPlan(plan);
  assert.deepEqual([slim.chart, slim.valid_until_ms], ["15m", T0 + 2 * M15 + 1]);
  const { pattern, ...noPattern } = plan;
  assert.ok(!("chart" in slimPlan(noPattern)), "no pattern: no chart");
  const { chart, valid_until_ms, ...plain } = plan;
  assert.deepEqual(Object.keys(slimPlan(plain)), Object.keys(slimPlan(plan)).filter((k) => k !== "chart" && k !== "valid_until_ms"));
  const row = { decision_key: `OANDA:XAUUSD:15:${T0 - M15}`, decided_at: new Date(T0).toISOString(), side: "BUY", atr_h1: 4, mode: "intraday", regime: "trend_up", plans: JSON.stringify({ long: { pattern_flags: slim } }) };
  const [d] = decisionPlans(row);
  assert.deepEqual([d.chart, d.valid_until_ms, d.pattern], ["15m", T0 + 2 * M15 + 1, "flag"]);
  const [s] = setupsFrom([d]);
  assert.deepEqual([s.chart, s.valid_until_ms], ["15m", T0 + 2 * M15 + 1]);
  const [plainSetup] = setupsFrom([{ ...d, chart: undefined, valid_until_ms: undefined }]);
  assert.ok(!("chart" in plainSetup) && !("valid_until_ms" in plainSetup), "a setup without them has today's shape");
  // The replay: the control arm with the lapse exits at it; the same setup without the lapse runs to its own exit.
  const lapsed = replaySetup({ ...s, decided_ms: T0, opened_ms: T0, last_seen_ms: T0 }, UP, { now: NOW });
  const today = replaySetup({ ...plainSetup, decided_ms: T0, opened_ms: T0, last_seen_ms: T0 }, UP, { now: NOW });
  assert.equal(lapsed.results[CONTROL_ARM]?.s, "lapse");
  assert.notEqual(today.results?.[CONTROL_ARM]?.s, "lapse");
});

test("PL6-3 agentRecords: a record per pattern@chart, evidence only; agents without one are as before", () => {
  const res = (s, r) => ({ [CONTROL_ARM]: { s, r, f: 1 } });
  const setups = [
    { agent: "pattern_flags", pattern: "flag", chart: "15m", context: "c", results: res("lapse", 0.7) },
    { agent: "pattern_flags", pattern: "flag", chart: "15m", context: "c", results: res("stop", -1) },
    { agent: "pattern_flags", pattern: "flag", chart: "1H", context: "c", results: res("target", 3) },
    { agent: "zone_pullback", context: "c", results: res("target", 2) }
  ];
  const rec = agentRecords(setups);
  const flags = rec.find((r) => r.agent === "pattern_flags");
  assert.deepEqual(flags.pattern_charts.map((x) => [x.key, x.setups, x.lapse_exits]), [["flag@15m", 2, 1], ["flag@1H", 1, 0]]);
  assert.equal(flags.patterns.length, 1, "the breaker's per-pattern record is unchanged");
  assert.ok(!("pattern_charts" in rec.find((r) => r.agent === "zone_pullback")));
});

test("PL6-4 the ALTERs are idempotent", async () => {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  const d1 = { prepare: (sql) => { let p = []; const st = { bind: (...a) => { p = a; return st; }, run: async () => db.prepare(sql).run(...p), all: async () => ({ results: db.prepare(sql).all(...p) }), first: async () => db.prepare(sql).get(...p) ?? null }; return st; } };
  for (let i = 0; i < 2; i += 1) { resetPlanLearningSchemaCacheForTests(); await ensurePlanLearningSchema(d1); }
  const cols = db.prepare("PRAGMA table_info(plan_setups)").all().map((c) => c.name);
  assert.ok(cols.includes("chart") && cols.includes("valid_until_ms"));
});
