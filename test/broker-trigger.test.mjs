// 5m execution for Omega (docs/RFC_OMEGA_5M_EXECUTION.md; owner 2026-11-12: 3-bar window, lot cap 1.5x, all on).
import test from "node:test";
import assert from "node:assert/strict";
import { storeBrokerTrigger, readBrokerTrigger, brokerTriggerFields, triggerFrom, exec5mMode, BROKER_TRIGGER_KEY } from "../src/broker-trigger.mjs";
import { entryTriggerFor } from "../src/ea-signal.mjs";
import { planIntents, manageIntents, OMEGA_DEFAULTS, settingsFrom } from "../src/omega-engine.mjs";

const kv = () => { const m = new Map(); return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } }; };
const CLOSE = Date.parse("2026-11-12T10:15:00Z"); // the decision's 15m close
const M5 = 5 * 60_000;
const bar = (i, over = {}) => ({ close_ms: CLOSE + i * M5, ready: true, buy_confirmed: false, sell_confirmed: false, swing_high: 4012, swing_low: 4003, atr: 2, bars: 500, source: "mt5:monex-demo:XAUUSD.M", ...over });
const DECISION = { decision_key: `OANDA:XAUUSD:15:${CLOSE - 15 * 60_000}`, stance: "BUY", trade: { side: "BUY", action: "ENTER_MARKET", entry: 4005, stop: 3995, tp: 4025 }, guardrails: { long: { entry_trigger: { fired: false, source: null } } } };

test("the broker trigger: stored with the last bars, fresh for 6 minutes, off with the switch", async () => {
  assert.equal(triggerFrom({ close_ms: CLOSE + 1000, swing_high: 1, swing_low: 1, atr: 1 }), null, "a 5m close only");
  assert.equal(triggerFrom({ ...bar(1), swing_low: 5000 }, CLOSE + M5), null, "low above high is refused");
  assert.equal(triggerFrom({ ...bar(1), ready: false, buy_confirmed: true }, CLOSE + M5).buy_confirmed, false, "no confirmation before the lane is ready");
  const env = { SIGNAL_CACHE: kv() };
  await storeBrokerTrigger(env, bar(1), { now: CLOSE + M5 + 70_000 });
  await storeBrokerTrigger(env, bar(2, { buy_confirmed: true }), { now: CLOSE + 2 * M5 + 70_000 });
  const read = await readBrokerTrigger(env, { now: CLOSE + 2 * M5 + 90_000 });
  assert.deepEqual(read.recent.map((b) => b.close_ms), [CLOSE + 2 * M5, CLOSE + M5]);
  assert.equal(await readBrokerTrigger(env, { now: CLOSE + 2 * M5 + 7 * 60_000 }), null, "stale after 6 minutes");
  assert.equal(await readBrokerTrigger({ ...env, OMEGA_EXEC_5M: "off" }, { now: CLOSE + 2 * M5 + 90_000 }), null);
  assert.equal(exec5mMode({}), "on");
  assert.deepEqual(brokerTriggerFields(read), { m5_source: "broker", m5_close_ms: CLOSE + 2 * M5, m5_ready: true, m5_buy: true, m5_sell: false, m5_swing_high: 4012, m5_swing_low: 4003, m5_atr: 2 });
  assert.ok(JSON.parse(env.SIGNAL_CACHE.m.get(BROKER_TRIGGER_KEY)).latest);
});

test("the entry's timing: a broker 5m confirmation on one of the 3 bars after the decision; TradingView's 5m only while the broker lane is not ready", () => {
  const broker = (recent) => ({ latest: recent[0], recent });
  const fired = entryTriggerFor(DECISION, { broker: broker([bar(2, { buy_confirmed: true }), bar(1)]) });
  assert.deepEqual([fired.fired, fired.source, fired.at_ms], [true, "broker_5m", CLOSE + 2 * M5]);
  const waiting = entryTriggerFor(DECISION, { broker: broker([bar(2), bar(1)]), live: { verified: true, buy_confirmed: true } });
  assert.equal(waiting.fired, false, "the broker lane is the trigger once ready; TradingView's live 5m does not stand in");
  assert.match(waiting.note, /broker 5m Prophet buy confirmation \(3 bars/);
  assert.equal(entryTriggerFor(DECISION, { broker: broker([bar(4, { buy_confirmed: true }), bar(3)]) }).fired, false, "the fourth bar is outside the window");
  assert.equal(entryTriggerFor(DECISION, { broker: broker([bar(0, { buy_confirmed: true })]) }).fired, false, "the decision's own bar is not after it");
  assert.equal(entryTriggerFor(DECISION, { broker: broker([bar(2, { sell_confirmed: true })]) }).fired, false, "the other side does not count");
  const notReady = entryTriggerFor(DECISION, { broker: broker([bar(1, { ready: false })]), live: { verified: true, buy_confirmed: true, candle_time: "2026-11-12T10:20:00Z" } });
  assert.deepEqual([notReady.fired, notReady.source], [true, "5m"], "TradingView's 5m stands in");
});

const ISSUED = CLOSE;
const NOW = CLOSE + 2 * M5 + 80_000;
const EXECUTOR = {
  connected: true, received_ms: NOW - 2000,
  account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4007, ask: 4007.2, spread_points: 20, atr_value: 6 },
  positions: []
};
const SIGNAL = { side: "BUY", action: "ENTER_MARKET", entry: 4005, stop: 3995, tp1: 4025, issued_ms: ISSUED, expires_ms: ISSUED + 15 * 60_000, decided_ms: CLOSE + 2 * M5, blackout: false, kill: false, paused: false, trigger_source: "broker_5m" };
const ON = { ...OMEGA_DEFAULTS, enabled: true };
const plan = (signal, settings = ON) => planIntents({ signal, control: { mode: "active" }, settings, executor: EXECUTOR, now: NOW, engineEnabled: true });

test("the 5m stop: the broker's 5m swing beyond a buffer, never wider than the plan's, the target kept, the lot capped at 1.5x", () => {
  const plain = plan(SIGNAL).intents[0];
  assert.deepEqual([plain.sl, plain.tp, plain.volume, plain.stop_source], [3997.2, 4027.2, 0.05, "plan"], "without the broker fields: the plan's 10.00 stop");
  const m5 = { ...SIGNAL, ...brokerTriggerFields({ latest: bar(2, { swing_low: 4003, atr: 2 }) }) };
  const r = plan(m5);
  const o = r.intents[0];
  // buffer = max(2 x 0.20 spread, 0.1 x 2 ATR) = 0.40; stop 4003 - 0.40 = 4002.60; distance 4.60 from 4007.20.
  assert.deepEqual([o.sl, o.tp, o.stop_source, o.trigger_source], [4002.6, 4027.2, "stop_5m", "broker_5m"], "the target stays the plan's 20.00");
  // At 4.60 the lot would be 0.10; the cap is 1.5 x 0.05 = 0.07.
  assert.equal(o.volume, 0.07);
  assert.ok(r.notes.some((n) => n.code === "stop_5m") && r.notes.some((n) => n.code === "lot_capped_5m"));
  assert.equal(plan(m5, { ...ON, tight_stop_max_lot_factor: 2 }).intents[0].volume, 0.1, "cap 2: the full risk-sized lot");
  const tooTight = plan({ ...SIGNAL, ...brokerTriggerFields({ latest: bar(2, { swing_low: 4006.8, atr: 2 }) }) }).intents[0];
  assert.equal(tooTight.stop_source, "plan", "closer than 0.5 x the 5m ATR: the plan's stop");
  const limit = plan({ ...m5, action: "ENTER_LIMIT", entry: 4007 }).intents[0];
  assert.equal(limit?.stop_source ?? "plan", "plan", "a limit at the key level keeps the plan's stop");
  assert.equal(settingsFrom({ tight_stop_max_lot_factor: 3 }).error, "tight_stop_max_lot_factor must be a number from 1 to 2");
});

test("5m management: trail from 1R or once protected, only in the position's favour; close on an opposite confirmation from 0.5R", () => {
  const sym = { ...EXECUTOR.symbol, bid: 4015, ask: 4015.2 };
  const pos = (over = {}) => ({ ticket: 77, side: "BUY", volume: 0.01, open_price: 4005, sl: 3995, tp: 4025, source: "omega", ...over });
  const fields = (over = {}) => brokerTriggerFields({ latest: bar(3, { swing_low: 4009, atr: 2, ...over }) });
  // 1R (+10 on a 10 risk): the stop goes to 4009 - 0.40 = 4008.60.
  const trail = manageIntents({ positions: [pos()], sym, settings: ON, signal: fields() });
  assert.deepEqual(trail.map((i) => [i.kind, i.sl, i.reason]), [["modify_sl", 4008.6, "trail_5m"]]);
  assert.ok(trail[0].id.length <= 31, "the bridge's intent id limit");
  assert.equal(manageIntents({ positions: [pos({ sl: 4010 })], sym, settings: ON, signal: fields() }).length, 0, "never backwards");
  assert.equal(manageIntents({ positions: [pos()], sym: { ...sym, bid: 4009, ask: 4009.2 }, settings: ON, signal: fields() }).length, 0, "below 1R: no trail");
  // An opposite (sell) confirmation at 0.5R or more closes it; below 0.5R it does not.
  const opp = manageIntents({ positions: [pos()], sym, settings: ON, signal: fields({ sell_confirmed: true }) });
  assert.deepEqual(opp.map((i) => [i.kind, i.reason]), [["close", "opposite_5m"]]);
  assert.equal(manageIntents({ positions: [pos()], sym: { ...sym, bid: 4008, ask: 4008.2 }, settings: ON, signal: fields({ sell_confirmed: true }) }).length, 0, "0.3R: the stop decides");
  assert.equal(manageIntents({ positions: [pos({ source: "manual", magic: 0 })], sym, settings: ON, signal: fields({ sell_confirmed: true }) }).length, 0, "never a manual position");
  assert.equal(manageIntents({ positions: [pos()], sym, settings: ON, signal: { tp1: 4025 } }).length, 0, "without the broker fields: nothing new");
});
