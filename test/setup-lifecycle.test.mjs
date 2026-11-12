// Owner 2026-11-12: "ya kerjakan semua nomor jika memang lebih baik, awas jangan sampai regresi, redundancy
// dan duplikasi" (after comparing Nexus with another assistant's screen): the live setup with its levels
// locked and its lifecycle, and the swing structure beside the decision.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { simulateSignal, setupLifecycle, activeSetups, ensureLedgerSchema, resetLedgerSchemaCacheForTests } from "../src/signal-ledger.mjs";
import { swingStructure, marketStructure } from "../src/market-structure.mjs";
import { DECISION_SCHEMA_SQL } from "../src/decision-engine.mjs";

const M = 15 * 60_000;
const OPEN = Date.parse("2026-11-12T14:00:00Z");
const key = (open) => `OANDA:XAUUSD:15:${open}`;
const min = (start, rows) => rows.map(([open, high, low, close], i) => ({ open_time: new Date(start + i * 60_000).toISOString(), close_time: new Date(start + (i + 1) * 60_000).toISOString(), open, high, low, close }));

test("L1. each policy keeps its own exit time: TP1 reached while the TP2 part runs on, then TP2", () => {
  const sig = { side: "SELL", entry: 4000, stop: 4010, tp1: 3985, tp2: 3970, opened_at: new Date(OPEN + M).toISOString() };
  const bars = min(OPEN + M, [[3999, 4001, 3998, 3999], [3999, 4000, 3990, 3991], [3991, 3992, 3984, 3986], [3986, 3987, 3975, 3976]]);
  const mid = simulateSignal(sig, bars, { now: OPEN + M + 4 * 60_000 });
  assert.deepEqual([mid.status, mid.exit_reason, mid.tp1_closed_at, mid.tp2_closed_at], ["open", "target", new Date(OPEN + M + 3 * 60_000).toISOString(), null]);
  const done = simulateSignal(sig, [...bars, ...min(OPEN + M + 4 * 60_000, [[3976, 3977, 3969, 3970]])], { now: OPEN + 2 * M });
  assert.deepEqual([done.status, done.tp2_exit_reason, done.tp2_closed_at, done.r_tp2], ["closed", "target", new Date(OPEN + M + 5 * 60_000).toISOString(), 3]);
});

test("L2. the lifecycle of a ledger row: locked levels, steps with times, decisions since, Omega's side", () => {
  const row = { id: "decision:" + key(OPEN), source: "decision", candle_key: key(OPEN), opened_at: new Date(OPEN + M + 30_000).toISOString(), side: "SELL", entry: 4000, stop: 4010, tp1: 3985, tp2: 3970, progressive_stop: 4000,
    status: "open", filled_at: "2026-11-12T14:16:00.000Z", exit_reason: "target", r_tp1: 1.5, tp1_closed_at: "2026-11-12T14:19:00.000Z", sl_plus_at: "2026-11-12T14:18:00.000Z", sl_plus_triggered: 1, trading_mode: "scalp",
    omega_status: "closed", omega_exit: "target", r_omega: 1.4, omega_filled_at: "2026-11-12T14:16:00.000Z", omega_closed_at: "2026-11-12T14:19:00.000Z" };
  const decisions = [{ close_ms: OPEN + M, stance: "SELL" }, { close_ms: OPEN + 2 * M, stance: "SELL" }, { close_ms: OPEN + 3 * M, stance: "WAIT" }, { close_ms: OPEN + 4 * M, stance: "BUY" }];
  const s = setupLifecycle(row, { decisions, now: OPEN + 5 * M });
  assert.equal(s.phase, "tp1");
  assert.deepEqual(s.locked, { entry: 4000, stop: 4010, tp1: 3985, tp2: 3970, progressive_stop: 4000 });
  assert.deepEqual(s.steps, { signal: row.opened_at, entry: row.filled_at, sl_plus: row.sl_plus_at, tp1: row.tp1_closed_at, tp2: null, invalidated: null, cancelled: null });
  assert.deepEqual(s.decisions_since, { same: 1, opposite: 1, wait: 1 }, "its own decision is not counted again");
  assert.deepEqual(s.omega, { status: "closed", gate: null, exit: "target", r: 1.4, filled_at: row.omega_filled_at, closed_at: row.omega_closed_at });
  const stopped = setupLifecycle({ ...row, status: "closed", exit_reason: "stop", r_tp1: -1, sl_plus_triggered: 0, sl_plus_at: null, closed_at: "2026-11-12T14:30:00.000Z", tp1_closed_at: "2026-11-12T14:30:00.000Z", tp2_exit_reason: "stop" }, { now: OPEN + 5 * M });
  assert.deepEqual([stopped.phase, stopped.steps.invalidated, stopped.steps.tp1], ["stopped", "2026-11-12T14:30:00.000Z", null]);
  const cancelled = setupLifecycle({ ...row, status: "cancelled", exit_reason: "unfilled", filled_at: null, closed_at: "2026-11-12T22:15:00.000Z" }, { now: OPEN + 40 * M });
  assert.deepEqual([cancelled.phase, cancelled.steps.cancelled], ["cancelled", { at: "2026-11-12T22:15:00.000Z", reason: "unfilled" }]);
  assert.equal(setupLifecycle({ ...row, status: "pending", filled_at: null, exit_reason: null }).phase, "awaiting_entry");
});

test("L3. activeSetups from D1: the live setups and those ended within 2 hours, newest first", async () => {
  resetLedgerSchemaCacheForTests();
  const raw = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort()) raw.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  for (const sql of DECISION_SCHEMA_SQL) raw.exec(sql);
  const db = { prepare(sql) { let p = []; const st = { bind(...a) { p = a; return st; }, async run() { raw.prepare(sql).run(...p); return { meta: { changes: 1 } }; }, async first() { return raw.prepare(sql).get(...p) ?? null; }, async all() { return { results: raw.prepare(sql).all(...p) }; } }; return st; } };
  await ensureLedgerSchema(db);
  const ins = raw.prepare("INSERT INTO signal_ledger (id, source, candle_key, opened_at, side, entry, stop, tp1, status, closed_at, updated_at) VALUES (?, 'decision', ?, ?, ?, 4000, 4010, 3985, ?, ?, '')");
  ins.run("a", key(OPEN), new Date(OPEN + M).toISOString(), "SELL", "open", null);
  ins.run("b", key(OPEN - 20 * M), new Date(OPEN - 19 * M).toISOString(), "SELL", "closed", new Date(OPEN - M).toISOString());
  ins.run("c", key(OPEN - 60 * M), new Date(OPEN - 59 * M).toISOString(), "SELL", "closed", new Date(OPEN - 40 * M).toISOString());
  raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, 'SELL', 0.6, 'council', '{}')").run(key(OPEN + M), new Date(OPEN + 2 * M).toISOString(), new Date(OPEN + 2 * M).toISOString());
  const out = await activeSetups({ DB: db }, { now: OPEN + 3 * M });
  assert.deepEqual(out.map((s) => s.id), ["a", "b"], "c ended more than 2 hours ago");
  assert.equal(out[0].decisions_since.same, 1);
  assert.deepEqual(await activeSetups({}), []);
});

test("L4. swing structure: the last two confirmed highs and lows; labels only", () => {
  const bars = (closes) => closes.map((c, i) => ({ open: c, high: c + 1, low: c - 1, close: c, close_time: new Date(OPEN + i * M).toISOString() }));
  const up = bars([10, 12, 14, 12, 11, 13, 16, 18, 15, 14, 16, 20, 22, 19, 18, 20]);
  assert.deepEqual(swingStructure(up), { label: "HH/HL", trend: "up" });
  const down = bars([22, 20, 18, 20, 21, 19, 16, 14, 17, 18, 16, 12, 10, 13, 14, 12]);
  assert.deepEqual(swingStructure(down), { label: "LH/LL", trend: "down" });
  assert.equal(swingStructure(bars([10, 11, 12])), null, "too few turns");
  const m = marketStructure({ h1Bars: up, m15Bars: down });
  assert.deepEqual([m.h4, m.h1.label, m.m15.label], [null, "HH/HL", "LH/LL"]);
  assert.ok(!/\d/.test(JSON.stringify(Object.values(m))), "no price leaves the structure: labels only");
});
