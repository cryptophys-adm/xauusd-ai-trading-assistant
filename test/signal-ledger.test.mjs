import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  simulateSignal, performance, ledgerView, validSignal, ingestH1Decisions, ingestStrategy, evaluateOpenSignals, readLedger,
  runSignalLedger, resetLedgerSchemaCacheForTests, FILL_WINDOW_MS, HOLD_MAX_MS
} from "../src/signal-ledger.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  db.exec("CREATE TABLE IF NOT EXISTS trade_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, candle_key TEXT NOT NULL, decision TEXT NOT NULL, confidence REAL, entry_price REAL, stop_loss REAL, take_profit REAL, risk_reward REAL, position_size_pct REAL, reasoning TEXT, created_at TEXT DEFAULT (datetime('now')))");
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

const T0 = Date.parse("2026-11-09T10:00:00Z");
const M = 15 * 60_000;
/** 15m bars from T0: [high, low, close] each. */
const bars = (hlc, start = T0) => hlc.map(([high, low, close], i) => ({ open_time: new Date(start + i * M).toISOString(), close_time: new Date(start + (i + 1) * M).toISOString(), open: close, high, low, close }));
const BUY = { side: "BUY", entry: 4000, stop: 3990, tp1: 4020, tp2: 4030, opened_at: new Date(T0).toISOString() };
const SELL = { side: "SELL", entry: 4000, stop: 4010, tp1: 3985, tp2: null, opened_at: new Date(T0).toISOString() };
const late = T0 + 200 * M;

test("validSignal needs prices ordered for the side", () => {
  assert.equal(validSignal(BUY), true);
  assert.equal(validSignal(SELL), true);
  assert.equal(validSignal({ ...BUY, stop: 4005 }), false);
  assert.equal(validSignal({ ...SELL, tp1: 4005 }), false);
  assert.equal(validSignal({ ...BUY, tp2: 4010 }), false, "TP2 before TP1");
  assert.equal(validSignal({ ...BUY, side: "WAIT" }), false);
});

test("a filled BUY reaches TP1 (+2R) and then TP2 (+3R); MFE and MAE are in R", () => {
  const o = simulateSignal(BUY, bars([[4006, 4001, 4004], [4004, 3998, 4002], [4012, 4001, 4010], [4021, 4009, 4019], [4031, 4018, 4030]]), { now: late });
  assert.equal(o.status, "closed");
  assert.equal(o.filled_at, new Date(T0 + M).toISOString());
  assert.equal(o.exit_reason, "target");
  assert.equal(o.r_tp1, 2);
  assert.equal(o.r_tp2, 3);
  assert.equal(o.mae_r, -0.2);
  assert.equal(o.ambiguous, false);
});

test("a stop is -1R; a bar reaching both the stop and the target counts as the stop and is flagged", () => {
  const stopped = simulateSignal(SELL, bars([[4001, 3999, 4000], [4011, 3999, 4009]]), { now: late });
  assert.equal(stopped.r_tp1, -1);
  assert.equal(stopped.exit_reason, "stop");
  const both = simulateSignal(SELL, bars([[4001, 3999, 4000], [4012, 3980, 3990]]), { now: late });
  assert.equal(both.r_tp1, -1);
  assert.equal(both.ambiguous, true);
});

test("before the fill: a stop touch invalidates, a TP1 touch cancels, no touch expires unfilled", () => {
  const away = { ...BUY, entry: 3995, stop: 3985, tp1: 4015, tp2: null };
  assert.deepEqual(simulateSignal(away, bars([[4000, 3996, 3998], [4016, 3997, 4014]]), { now: late }).exit_reason, "target_before_entry");
  const sell = { ...SELL, entry: 4005, stop: 4015, tp1: 3990 };
  assert.equal(simulateSignal(sell, bars([[4004, 3999, 4000], [4004, 3989, 3991]]), { now: late }).exit_reason, "target_before_entry");
  const never = simulateSignal(away, bars(Array.from({ length: 40 }, () => [4001, 3996, 3999])), { now: late });
  assert.equal(never.status, "cancelled");
  assert.equal(never.exit_reason, "unfilled");
  const waiting = simulateSignal(away, bars([[4001, 3996, 3999]]), { now: T0 + 2 * M });
  assert.equal(waiting.status, "pending", "the fill window is still running");
  assert.ok(FILL_WINDOW_MS < HOLD_MAX_MS);
});

test("an open signal stays open with its mark-to-market R; after the hold limit it exits at the close", () => {
  const flat = bars([[4001, 3999, 4000], ...Array.from({ length: 10 }, () => [4006, 3995, 4004])]);
  const open = simulateSignal(BUY, flat, { now: late });
  assert.equal(open.status, "open");
  assert.equal(open.open_r, 0.4);
  const long = bars([[4001, 3999, 4000], ...Array.from({ length: HOLD_MAX_MS / M + 2 }, () => [4006, 3995, 4005])]);
  const timed = simulateSignal({ ...BUY, tp2: null }, long, { now: T0 + 400 * M });
  assert.equal(timed.status, "closed");
  assert.equal(timed.exit_reason, "time");
  assert.equal(timed.r_tp1, 0.5);
});

test("performance: win rate, expectancy, profit factor and drawdown in R; the tp2 policy only counts signals with a TP2", () => {
  const items = [
    { id: "a", status: "closed", closed_at: "2026-11-09T11:00:00Z", r_tp1: 2, r_tp2: 3, tp2: 4030 },
    { id: "b", status: "closed", closed_at: "2026-11-09T12:00:00Z", r_tp1: -1, r_tp2: -1, tp2: 4030 },
    { id: "c", status: "closed", closed_at: "2026-11-09T13:00:00Z", r_tp1: -1, r_tp2: null, tp2: null },
    { id: "d", status: "open", r_tp1: null }
  ];
  const p = performance(items, "tp1");
  assert.deepEqual([p.trades, p.wins, p.losses, p.win_rate, p.expectancy_r, p.total_r, p.profit_factor, p.max_drawdown_r], [3, 1, 2, 0.333, 0, 0, 1, 2]);
  assert.deepEqual(p.equity.map((e) => e.r), [2, 1, 0]);
  const v = ledgerView(items.map((x) => ({ ...x, source: "strategy", opened_at: "2026-11-09T10:00:00Z" })), { days: 30 });
  assert.equal(v.all.tp2.trades, 2);
  assert.equal(v.by_source.strategy.signals, 4);
  assert.equal(v.rules.unit, "R, never money");
});

test("ingestion: H1 BUY/SELL decisions once each; a strategy setup only when none of its side is live", async () => {
  resetLedgerSchemaCacheForTests();
  const db = d1();
  const env = { DB: db };
  await runSignalLedger(env, { now: T0 });
  db.raw.prepare("INSERT INTO trade_decisions (candle_key, decision, confidence, entry_price, stop_loss, take_profit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("OANDA:XAUUSD:60:1", "SELL", 0.7, 4000, 4010, 3985, "2026-11-09 10:00:30");
  db.raw.prepare("INSERT INTO trade_decisions (candle_key, decision, confidence, entry_price, stop_loss, take_profit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("OANDA:XAUUSD:60:2", "WAIT", null, null, null, null, "2026-11-09 11:00:30");
  db.raw.prepare("INSERT INTO trade_decisions (candle_key, decision, confidence, entry_price, stop_loss, take_profit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("OANDA:XAUUSD:60:3", "BUY", 0.6, 4000, 4010, 4020, "2026-11-09 12:00:30");
  assert.equal(await ingestH1Decisions(env, { sinceIso: "2026-11-09T00:00:00Z", now: T0 }), 1, "the WAIT and the misordered BUY are skipped");
  assert.equal(await ingestH1Decisions(env, { sinceIso: "2026-11-09T00:00:00Z", now: T0 }), 0, "once per candle");
  const row = db.raw.prepare("SELECT * FROM signal_ledger").get();
  assert.equal(row.opened_at, "2026-11-09T10:00:30.000Z");

  const strategy = { decision: "BUY", confidence: 0.71, headline: "BUY: test", plan: { entry: 4000, stop: 3990, tp1: 4020, tp2: 4030 }, h1_chain: null };
  assert.equal(await ingestStrategy(env, strategy, { now: T0 }), 1);
  assert.equal(await ingestStrategy(env, strategy, { now: T0 + 3600_000 }), 0, "a BUY is already live");
  assert.equal(await ingestStrategy(env, { ...strategy, decision: "WAIT" }, { now: T0 }), 0);

  const closed = bars([[4001, 3999, 4000], [4011, 3984, 3990]], Date.parse("2026-11-09T10:00:00Z"));
  assert.equal(await evaluateOpenSignals(env, { now: late, bars: closed }), 2);
  const view = await readLedger(env, { days: 30, now: late });
  assert.equal(view.all.signals, 2);
  assert.equal(view.by_source.h1_decision.tp1.trades, 1);
  assert.equal(view.by_source.h1_decision.tp1.losses, 1, "SELL stopped on the ambiguous bar");
  assert.equal(view.by_source.strategy.tp1.losses, 1);
});
