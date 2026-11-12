// Owner 2026-11-12: "ya kerjakan kebijakan Omega di Signal Ledger sesuai dengan mode intraday, swing, dan
// scalping. Ini digunakan untuk inputan ke aether dan selanjutnya akan menjadi knowledge." The Signal
// Ledger measures a third policy on the Decision Engine's signals: what Omega would have done with them
// (market entry on the next bar, the day's gates in R, key-level management by the quorum power), per
// trading mode, and reports it to Aether in R only.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  simulateOmega, omegaEntry, omegaGate, brokerDayStart, decisionLevels, ledgerView, executionReport,
  ingestDecision, evaluateOpenSignals, readLedger, readExecutionReport, resetLedgerSchemaCacheForTests, ensureLedgerSchema
} from "../src/signal-ledger.mjs";
import { pushExecutionReport } from "../src/aether-push.mjs";
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
const OPEN = Date.parse("2026-11-12T09:00:00Z"); // the decided bar's open; it closes at 09:15
const key = (open) => `OANDA:XAUUSD:15:${open}`;
/** 15m bars from the decided bar's close: [open, high, low, close] each. */
const bars = (ohlc, start = OPEN + M) => ohlc.map(([open, high, low, close], i) => ({ open_time: new Date(start + i * M).toISOString(), close_time: new Date(start + (i + 1) * M).toISOString(), open, high, low, close }));
const SELL = { side: "SELL", entry: 4000, stop: 4010, tp1: 3985, candle_key: key(OPEN), opened_at: new Date(OPEN + M + 60_000).toISOString(), trading_mode: "scalp", entry_action: "ENTER_MARKET" };
const late = OPEN + 400 * M;
const dec = (barOpen, stance, power, levels = []) => ({ key: key(barOpen), close_ms: barOpen + M, stance, power, levels });

test("O1. Omega enters at market on the bar after the decision, keeps the plan's distances, and takes the target", () => {
  const o = simulateOmega(SELL, bars([[3999, 4002, 3995, 3996], [3996, 3997, 3983, 3984]]), { now: late });
  assert.equal(o.omega_status, "closed");
  assert.equal(o.exit, "target");
  assert.equal(o.r, 1.5, "fill 3999, stop 4009, target 3984: (3999 - 3984) / 10");
  assert.equal(o.filled_at, new Date(OPEN + M).toISOString());
  // A limit plan waits for price within 0.35 x the stop distance (3.5) of the entry: a sell at 3996.5 or higher.
  const limit = { ...SELL, entry_action: "ENTER_LIMIT" };
  assert.deepEqual(omegaEntry(limit, bars([[3990, 3995, 3988, 3992]]), { now: late }), { status: "skipped", gate: "waiting_for_pullback", bar: 0 });
  assert.equal(omegaEntry(limit, bars([[3990, 3997, 3988, 3992]]), { now: late }).fill, 3996.5);
  // The next bar opening past the stop: no trade. No bar yet: pending. A gap over the next close: expired.
  assert.equal(omegaEntry(SELL, bars([[4011, 4012, 4005, 4006]]), { now: late }).gate, "stop_breached");
  assert.equal(omegaEntry(SELL, bars([[3999, 4002, 3995, 3996]]), { now: OPEN + M + 60_000 }).status, "pending");
  assert.equal(omegaEntry(SELL, bars([[3999, 4002, 3995, 3996]], OPEN + 3 * M), { now: late }).gate, "expired");
});

test("O2. SL+ behind a passed key level by the quorum power; the stop then exits in profit as sl_plus", () => {
  // A short from 3999 passes the zone 3990-3992 by bar 2; the power stays with it (normal band), so the
  // stop moves behind the zone (3992 + buffer), locking profit; bar 3 comes back and takes it.
  const levels = [{ low: 3990, high: 3992 }];
  const decisions = [dec(OPEN, "SELL", -0.3, levels), dec(OPEN + M, "WAIT", -0.3, levels), dec(OPEN + 2 * M, "WAIT", -0.3, levels)];
  const o = simulateOmega({ ...SELL, tp1: 3970 }, bars([[3999, 4001, 3994, 3995], [3995, 3996, 3986, 3987], [3987, 3994, 3986, 3993]]), { decisions, now: late });
  assert.equal(o.exit, "sl_plus");
  assert.ok(o.r > 0, JSON.stringify(o));
  assert.equal(o.protected_at, new Date(OPEN + 3 * M).toISOString());
  assert.equal(o.sl_moves, 1);
});

test("O3. a reversed power closes a winner; an opposite decision closes the trade; time ends it after 72 h", () => {
  const levels = [{ low: 3950, high: 3952 }];
  const rev = simulateOmega(SELL, bars([[3999, 4000, 3994, 3995], [3995, 3996, 3992, 3993]]), { decisions: [dec(OPEN, "SELL", -0.4, levels), dec(OPEN + M, "WAIT", 0.6, levels)], now: late });
  assert.deepEqual([rev.exit, rev.r], ["power_reversal", 0.38], "closed at the bar's ask 3995.2 (close plus the fixed spread) against the fill 3999");
  const opp = simulateOmega(SELL, bars([[3999, 4003, 3997, 4002], [4002, 4004, 4001, 4003]]), { decisions: [dec(OPEN, "SELL", -0.4), dec(OPEN + M, "BUY", 0.6)], now: late });
  assert.deepEqual([opp.exit, opp.r], ["opposite", -0.3]);
  const flat = Array.from({ length: 300 }, () => [3999, 4001, 3997, 3999]);
  assert.equal(simulateOmega(SELL, bars(flat), { now: late }).exit, "time");
});

test("O4. the day's gates in R: 2 % / 2 % is one loss a day; an open unprotected trade takes its 1R; the budget caps the size", () => {
  const fillMs = Date.parse("2026-11-12T09:15:00Z");
  const S = { max_daily_loss_pct: 2, risk_pct: 2, max_positions: 2 };
  const lost = { id: "a", side: "BUY", filled_at: "2026-11-12T01:00:00Z", closed_at: "2026-11-12T02:00:00Z", r: -1, size: 1 };
  assert.deepEqual(omegaGate({ side: "SELL", fillMs, others: [lost], settings: S }), { code: "daily_loss_limit" });
  // Yesterday's loss (before the 22:00 UTC broker day) does not count.
  assert.deepEqual(omegaGate({ side: "SELL", fillMs, others: [{ ...lost, filled_at: "2026-11-11T20:00:00Z", closed_at: "2026-11-11T21:00:00Z" }], settings: S }), { size: 1 });
  const openBuy = { id: "b", side: "BUY", filled_at: "2026-11-12T08:00:00Z", closed_at: null, r: null, size: 1 };
  assert.deepEqual(omegaGate({ side: "SELL", fillMs, others: [openBuy], settings: S }), { code: "daily_risk_budget" });
  assert.deepEqual(omegaGate({ side: "BUY", fillMs, others: [openBuy], settings: { ...S, max_daily_loss_pct: 4 } }), { code: "same_side_unprotected" });
  assert.deepEqual(omegaGate({ side: "BUY", fillMs, others: [{ ...openBuy, protected_at: "2026-11-12T09:00:00Z" }], settings: S }), { size: 1 }, "a protected trade risks nothing more");
  assert.deepEqual(omegaGate({ side: "SELL", fillMs, others: [{ ...lost, r: -0.4 }], settings: S }), { size: 0.6 });
  assert.deepEqual(omegaGate({ side: "SELL", fillMs, others: [openBuy, { ...openBuy, id: "c", protected_at: "2026-11-12T08:30:00Z" }], settings: { ...S, max_daily_loss_pct: 6 } }), { code: "max_positions" });
  assert.equal(new Date(brokerDayStart(fillMs)).toISOString(), "2026-11-11T22:00:00.000Z");
  assert.equal(new Date(brokerDayStart(Date.parse("2026-11-12T22:30:00Z"))).toISOString(), "2026-11-12T22:00:00.000Z");
  const skipped = simulateOmega(SELL, bars([[3999, 4002, 3995, 3996]]), { gate: { code: "daily_loss_limit" }, now: late });
  assert.deepEqual([skipped.omega_status, skipped.gate], ["skipped", "daily_loss_limit"]);
  assert.deepEqual(decisionLevels('[{"low":3990,"high":3992},{"low":"x"},{"low":3980,"high":3981}]'), [{ low: 3980, high: 3981 }, { low: 3990, high: 3992 }]);
});

test("O5. the view and the report per mode: plan and Omega paired on the same signals, R only, no price", () => {
  const row = (i, mode, r_tp1, r_omega, over = {}) => ({ id: `decision:${key(OPEN + i * M)}`, source: "decision", candle_key: key(OPEN + i * M), opened_at: new Date(OPEN + i * M + M).toISOString(), side: "SELL", entry: 4000, stop: 4010, tp1: 3985, status: "closed", closed_at: new Date(OPEN + i * M + 3 * M).toISOString(), exit_reason: r_tp1 > 0 ? "target" : "stop", r_tp1, trading_mode: mode, omega_status: "closed", omega_closed_at: new Date(OPEN + i * M + 2 * M).toISOString(), r_omega, omega_exit: "power_reversal", omega_size: 1, ...over });
  const rows = [row(0, "scalp", 1.5, 0.4), row(1, "scalp", -1, -1), row(2, "intraday", 2, 2.5), row(3, "scalp", -1, 0.2, { omega_size: 0.5 }), row(4, "swing", -1, null, { omega_status: "skipped", omega_gate: "daily_loss_limit", r_omega: null, omega_closed_at: null })];
  const view = ledgerView(rows, { days: 30 });
  assert.equal(view.by_mode.scalp.omega.trades, 3);
  assert.equal(view.by_mode.scalp.omega.total_r, -0.5, "0.4 - 1 + 0.2 x 0.5");
  assert.deepEqual(view.by_mode.scalp.omega.paired, { trades: 3, omega_r: -0.4, plan_r: -0.5, omega_better: 1, plan_better: 1 });
  assert.deepEqual(view.by_mode.swing.omega.skipped, { daily_loss_limit: 1 });
  assert.equal(view.by_mode.intraday.tp1.total_r, 2);
  const rep = executionReport(rows, { now: OPEN + 86_400_000 });
  assert.equal(rep.schema, "cryptophys.execution-report.v1");
  assert.equal(rep.trades.length, 5);
  assert.deepEqual(rep.trades[0], { chart: "15", bar_open: new Date(OPEN).toISOString(), session: "london", mode: "scalp", side: "SELL", plan_r: 1.5, plan_exit: "target", omega_r: 0.4, omega_exit: "power_reversal", omega_size: 1 });
  assert.deepEqual(rep.modes.scalp.paired, { trades: 3, omega_better: 1, plan_better: 1, omega_r: -0.4, plan_r: -0.5 });
  assert.deepEqual(rep.modes.swing.omega_skipped, { daily_loss_limit: 1 });
  // Nothing in the report is a price: no entry, stop, target, level or size field, no 4-digit number.
  const text = JSON.stringify(rep);
  for (const k of ["entry", "stop", "tp1", "tp2", "exit_price", "key_levels", "lots", "volume"]) assert.ok(!text.includes(`"${k}":`), k);
  assert.ok(!/\b\d{4}\.\d|\b39\d\d\b|\b40\d\d\b/.test(text.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "")), "no price-like number outside the ISO times");
});

test("O6. D1: a decision is ingested with its mode, followed under Omega to its close, and pushed to Aether once", async () => {
  resetLedgerSchemaCacheForTests();
  const db = d1();
  const env = { DB: db };
  await ensureLedgerSchema(db);
  const decision = { decision_key: key(OPEN), stance: "SELL", decided_at: new Date(OPEN + M + 30_000).toISOString(), trading_mode: "scalp", confidence: 0.6, trade: { side: "SELL", action: "ENTER_MARKET", entry: 4000, stop: 4010, tp: 3985, target: "tp1" }, quorum: { score: -0.5 }, key_levels: [{ low: 3990, high: 3992 }] };
  db.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(decision.decision_key, new Date(OPEN + M).toISOString(), decision.decided_at, "SELL", 0.6, "council", JSON.stringify(decision));
  assert.equal(await ingestDecision(env, decision, { now: OPEN + M + 60_000 }), 1);
  let row = db.raw.prepare("SELECT trading_mode, entry_action, omega_status FROM signal_ledger").get();
  assert.deepEqual({ ...row }, { trading_mode: "scalp", entry_action: "ENTER_MARKET", omega_status: "pending" });
  // Omega sells at 3999 at the open of the bar after the decision; the plan's limit at 4000 (from the
  // decision's time, 30 s after that open) fills in the next bar; both reach their targets in the third.
  const b = bars([[3999, 4001, 3994, 3995], [3995, 4000.5, 3993, 3996], [3996, 3997, 3983, 3984]]);
  await evaluateOpenSignals(env, { now: late, bars: b });
  row = db.raw.prepare("SELECT status, r_tp1, omega_status, omega_exit, r_omega, omega_size, omega_json FROM signal_ledger").get();
  assert.deepEqual([row.status, row.r_tp1, row.omega_status, row.omega_exit, row.r_omega, row.omega_size], ["closed", 1.5, "closed", "target", 1.5, 1]);
  assert.deepEqual(JSON.parse(row.omega_json).gate, { size: 1 });
  const view = await readLedger(env, { now: late });
  assert.equal(view.by_mode.scalp.omega.trades, 1);
  const report = await readExecutionReport(env, { now: late });
  assert.equal(report.modes.scalp.paired.trades, 1);
  const sent = [];
  const aether = { ...env, AETHER: { ingestExecutionReport: async (r) => { sent.push(r); return { accepted: true }; } } };
  assert.equal((await pushExecutionReport(aether, report)).status, "accepted");
  assert.equal((await pushExecutionReport(aether, { ...report, generated_at: "2026-11-13T00:00:00.000Z" })).status, "unchanged");
  assert.equal(sent.length, 1);
  assert.equal((await pushExecutionReport(env, report)).status, "disabled");
});

test("O7. 1m bars (owner 2026-11-12, \"ya kerjakan keduanya\"): stitched after the 15m bars; Omega fills the minute after the decision and waits for a limit only within the signal's age", async () => {
  const { stitchBars } = await import("../src/signal-ledger.mjs");
  const one = (start, n, span, px = 4000) => Array.from({ length: n }, (_, i) => ({ open_time: new Date(start + i * span).toISOString(), close_time: new Date(start + (i + 1) * span).toISOString(), open: px, high: px + 1, low: px - 1, close: px }));
  const T = OPEN + 4 * M;
  const s = stitchBars({ h1: one(OPEN - 4 * 3600_000, 4, 3600_000), m15: one(OPEN, 8, M), m1: one(T, 30, 60_000) });
  assert.deepEqual([s.length, s[0].open_time, s.at(-31).close_time, s.at(-30).open_time], [4 + 4 + 30, new Date(OPEN - 4 * 3600_000).toISOString(), new Date(T).toISOString(), new Date(T).toISOString()], "1H, then 15m up to the first 1m bar, then 1m");
  // Decided 2.5 minutes after the decided bar's close: Omega's market entry is the open of the third minute.
  const decided = { ...SELL, opened_at: new Date(OPEN + M + 150_000).toISOString() };
  const m1 = (rows, start = OPEN + M) => rows.map(([open, high, low, close], i) => ({ open_time: new Date(start + i * 60_000).toISOString(), close_time: new Date(start + (i + 1) * 60_000).toISOString(), open, high, low, close }));
  const e = omegaEntry(decided, m1([[3999, 4000, 3998, 3999], [3999, 4000, 3998, 3999], [3998, 3999, 3997, 3998], [3998, 3999, 3997, 3998]]), { now: late });
  assert.deepEqual([e.status, e.fill, e.filled_at], ["filled", 3998, new Date(OPEN + M + 3 * 60_000).toISOString()]);
  // A limit plan waits up to max_signal_age (10 minutes) for price to come back within 0.35 x the stop distance.
  const limit = { ...decided, entry_action: "ENTER_LIMIT" };
  const away = Array.from({ length: 6 }, () => [3990, 3991, 3989, 3990]);
  const back = m1([...away, [3990, 3997, 3989, 3996], [3996, 3997, 3995, 3996]]);
  const f = omegaEntry(limit, back, { now: late });
  assert.deepEqual([f.status, f.fill, f.filled_at], ["filled", 3996.5, new Date(OPEN + M + 6 * 60_000).toISOString()]);
  const never = m1(Array.from({ length: 20 }, () => [3990, 3991, 3989, 3990]));
  assert.equal(omegaEntry(limit, never, { now: late }).gate, "waiting_for_pullback");
  assert.equal(omegaEntry(limit, never.slice(0, 5), { now: OPEN + M + 8 * 60_000 }).status, "pending", "the window is still open");
  // A decision counts from when it was made: an opposite decision decided 3 minutes after its close
  // closes the trade at the minute it is known, not at its bar's close.
  const bars1 = m1(Array.from({ length: 25 }, () => [3999, 4000, 3998, 3999]));
  const opp = simulateOmega(decided, bars1, { decisions: [{ ...dec(OPEN, "SELL", -0.4), at_ms: OPEN + M + 150_000 }, { ...dec(OPEN + M, "BUY", 0.6), at_ms: OPEN + 2 * M + 180_000 }], now: late });
  assert.deepEqual([opp.exit, opp.closed_at], ["opposite", new Date(OPEN + 2 * M + 180_000).toISOString()]);
});
