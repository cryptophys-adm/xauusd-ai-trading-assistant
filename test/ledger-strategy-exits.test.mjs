// Owner 2026-11-16: "lanjutkan Signal Ledger untuk lean_flip dan confidence_drop". The ledger's Omega policy replays
// Omega's own strategyExits on decisions made with the strategy execution rules (docs/RFC_STRATEGY_EXECUTION.md).
import test from "node:test";
import assert from "node:assert/strict";
import { simulateOmega, OMEGA_POLICY_VERSION } from "../src/signal-ledger.mjs";

const M = 15 * 60_000;
const OPEN = Date.parse("2026-11-16T09:00:00Z");
const key = (open) => `OANDA:XAUUSD:15:${open}`;
const bars = (ohlc, start = OPEN + M) => ohlc.map(([open, high, low, close], i) => ({ open_time: new Date(start + i * M).toISOString(), close_time: new Date(start + (i + 1) * M).toISOString(), open, high, low, close }));
const SELL = { side: "SELL", entry: 4000, stop: 4010, tp1: 3985, candle_key: key(OPEN), opened_at: new Date(OPEN + M + 60_000).toISOString(), trading_mode: "intraday", entry_action: "ENTER_MARKET", agent: "sweep_reversal" };
const late = OPEN + 400 * M;
const conf = (short) => ({ sweep_reversal: { long: 0.3, short } });
const dec = (barOpen, stance, power, { sx = true, now = null, prev = null, levels = [] } = {}) => ({ key: key(barOpen), close_ms: barOpen + M, stance, power, levels, strategy_execution: sx, agent_confidence: now, agent_confidence_prev: prev });

test("the policy version moves with the new exits", () => {
  assert.equal(OMEGA_POLICY_VERSION, "cryptophys.ledger-omega.v3");
});

test("the lean flip closes the trade, in profit or not; neutral and decisions before the rules never do", () => {
  const losing = bars([[3999, 4002, 3995, 4001], [4001, 4003, 3999, 4000]]);
  const flip = simulateOmega(SELL, losing, { decisions: [dec(OPEN, "SELL", -0.4), dec(OPEN + M, "WAIT", 0.2)], now: late });
  assert.deepEqual([flip.exit, flip.r], ["lean_flip", -0.22], "at the bar's ask 4001.2 against the fill 3999");
  assert.notEqual(simulateOmega(SELL, losing, { decisions: [dec(OPEN, "SELL", -0.4), dec(OPEN + M, "WAIT", 0.1)], now: late }).exit, "lean_flip", "inside the band");
  assert.notEqual(simulateOmega(SELL, losing, { decisions: [dec(OPEN, "SELL", -0.4, { sx: false }), dec(OPEN + M, "WAIT", 0.2, { sx: false })], now: late }).exit, "lean_flip", "a decision made before the rules");
});

test("a winner whose agent's confidence dropped is closed; a loser is not; an unknown change holds", () => {
  const winning = bars([[3999, 4000, 3994, 3995], [3995, 3997, 3993, 3996]]);
  const dropped = [dec(OPEN, "SELL", -0.4), dec(OPEN + M, "WAIT", -0.3, { now: conf(0.5), prev: conf(0.7) })];
  const d = simulateOmega(SELL, winning, { decisions: dropped, now: late });
  assert.deepEqual([d.exit, d.r], ["confidence_drop", 0.38], "at the ask 3995.2");
  const losing = bars([[3999, 4002, 3998, 4001], [4001, 4003, 3999, 4002]]);
  assert.notEqual(simulateOmega(SELL, losing, { decisions: dropped, now: late }).exit, "confidence_drop");
  assert.notEqual(simulateOmega({ ...SELL, agent: null }, winning, { decisions: dropped, now: late }).exit, "confidence_drop", "no agent recorded: the default agent's confidence, which is unknown here");
  assert.notEqual(simulateOmega(SELL, winning, { decisions: [dec(OPEN, "SELL", -0.4), dec(OPEN + M, "WAIT", -0.3, { now: conf(0.69), prev: conf(0.7) })], now: late }).exit, "confidence_drop", "stable");
});

test("the trailing TP moves only while the confidence is stable or rising", () => {
  // A short near its 3984 target with a strong power: the target would move to the next key level (3972).
  const levels = [{ low: 3970, high: 3972 }];
  const near = bars([[3999, 4000, 3986.5, 3986.6], [3986.6, 3987, 3986, 3986.5]]);
  const run = (now, prev) => simulateOmega(SELL, near, { decisions: [dec(OPEN, "SELL", -0.6, { levels }), dec(OPEN + M, "WAIT", -0.6, { levels, now, prev })], now: OPEN + 3 * M });
  assert.ok(run(conf(0.7), conf(0.7)).tp_moves >= 1, "stable: extended");
  assert.equal(run(conf(0.7), null).tp_moves, 0, "unknown: the target stays");
  const before = simulateOmega(SELL, near, { decisions: [dec(OPEN, "SELL", -0.6, { levels, sx: false }), dec(OPEN + M, "WAIT", -0.6, { levels, sx: false })], now: OPEN + 3 * M });
  assert.ok(before.tp_moves >= 1, "decisions before the rules: as before");
});
