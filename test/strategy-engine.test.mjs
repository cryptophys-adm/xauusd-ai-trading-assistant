import test from "node:test";
import assert from "node:assert/strict";
import { buildStrategy, tradeLevels, planForDirection, atr, roomLean, MIN_RRR } from "../src/strategy-engine.mjs";
import { buildGlobalConclusion } from "../src/global-conclusion.mjs";

const NOW = Date.parse("2026-11-06T14:20:00Z");
const op = (id, bias, confidence = 0.6) => ({ id, status: "ok", stance: "WAIT", bias, confidence });
const room = (biases, bar_close, extra = {}) => ({ bar_close, openings: biases.map((b, i) => op("a" + i, b)), conclusion: { status: "ok", stance: "WAIT", bias: null, confidence: 0.6 }, ...extra });
const bull = ["BULLISH", "BULLISH", "BULLISH", "NEUTRAL"], bear = ["BEARISH", "BEARISH", "BEARISH", "NEUTRAL"];

// Closed 1H bars with a 10-dollar range: ATR 10.
const h1Bars = Array.from({ length: 20 }, (_, i) => ({ open: 4000 + i, high: 4006 + i, low: 3996 + i, close: 4001 + i }));
// 15m bars around 4040 with a swing low at 4031.
const m15Bars = Array.from({ length: 10 }, (_, i) => ({ open: 4040, high: 4045, low: i === 5 ? 4031 : 4036, close: 4040 }));
const snapshot = (tf, close, extra = {}) => ({
  timeframe: tf, candle_key: `OANDA:XAUUSD:${tf}:1`,
  huds: {
    interstellar_eyes: { fields: { close, camarilla: { [tf]: { h3: 4048, h4: 4060, h5: 4075, l3: 4038, l4: 4026, l5: 4010 }, D: { h3: 4090, h4: 4110, h5: 4140, l3: 4000, l4: 3980, l5: 3950 } } } },
    chronos_matrix: { fields: { daily_cpr: { pivot: 4020, tc: 4024, bc: 4016 }, weekly_cpr: { pivot: 3960, tc: 3965, bc: 3955 } } },
    fabio_amt: { fields: { poc: 4052, vah: 4068, val: 4030 } },
    decision_matrix: { fields: { verdict: 1, gate: 1, conflict: false, is_chaos: false } },
    trade_management: { fields: { conflict: false, gate: 1 } },
    prophet: { fields: { t_enc: 1 } },
    kinetic_engine: { fields: { is_chaos: false } },
    r37_funnel: { fields: { buy_confirmed: false, sell_confirmed: false } },
    ...extra
  }
});
const rooms = (d1, h4, h1, m15) => ({
  D1: room(d1, "2026-11-05T22:00:00.000Z"), H4: room(h4, "2026-11-06T14:00:00.000Z"),
  H1: room(h1, "2026-11-06T14:00:00.000Z"), M15: { ...room(m15, null), bar_time: "2026-11-06T14:15:00.000Z" }
});
const input = (over = {}) => ({
  rooms: rooms(bull, bull, bull, bull), news: null, h1Snapshot: snapshot("60", 4040), m15Snapshot: snapshot("15", 4040),
  confirmations: { h1_prophet_r38: { buy_confirmed: false, sell_confirmed: false }, m5_prophet_r38: { buy_confirmed: true, sell_confirmed: false, verified: true } },
  h1Bars, m15Bars, h1Chain: { decision: "WAIT", confidence: 0 }, now: NOW, ...over
});

test("all agents aligned bullish from D1 to 15m, price at a support, a verified 5m buy: BUY with levels and RRR", () => {
  const s = buildStrategy(input());
  assert.equal(s.direction, "LONG");
  assert.equal(s.state, "TRIGGERED", s.headline);
  assert.equal(s.decision, "BUY");
  assert.equal(s.atr_h1, 10);
  assert.equal(s.plan.entry, 4040, "price holds at a level, so the entry is the price");
  assert.ok(s.plan.stop < s.plan.entry && s.plan.tp1 > s.plan.entry && s.plan.tp2 > s.plan.tp1);
  assert.ok(s.plan.rrr.tp2 >= MIN_RRR);
  assert.match(s.plan.stop_note, /beyond /);
  // Key Level Agent zones: the targets are the near edges of the next candidate zones.
  // The 4048-4050 zone (1H and 15m Camarilla H3, round 4050) has 3 sources but scores 2.3, below
  // medium, so it is not a candidate: without a candidate zone ahead the targets are 2R and 3R.
  assert.equal(s.plan.tp1, 4064);
  assert.equal(s.plan.tp1_note, "a 2R projection");
  assert.equal(s.plan.tp2, 4076);
  assert.deepEqual(s.plan.rrr, { tp1: 2, tp2: 3 });
  assert.equal(s.plan.stop, 4028, "beyond the far edge of the 4030-4031 zone (value area low and 15m swing low), padded by 0.2 ATR");
  assert.deepEqual(s.layers.map((l) => l.key), ["D1", "H4", "H1", "M15", "M5"]);
  assert.ok(s.layers.every((l) => l.pass === true));
  assert.equal(s.h1_chain.decision, "WAIT", "the H1 chain is reported beside the engine's decision");
  assert.ok(s.key_levels.zones.length >= 5 && Array.isArray(s.key_levels.candidates), "the Key Level Agent's reading travels with the strategy");
  assert.match(s.advisory, /no orders/);
});

test("the same setup without a trigger is READY, away from a level it is FORMING, and both are WAIT", () => {
  const ready = buildStrategy(input({ confirmations: { m5_prophet_r38: { buy_confirmed: false, verified: true } } }));
  assert.equal(ready.state, "SETUP_READY");
  assert.equal(ready.decision, "WAIT");
  assert.match(ready.headline, /waiting for a verified 5m/);
  const unverified = buildStrategy(input({ confirmations: { m5_prophet_r38: { buy_confirmed: true, verified: false } } }));
  assert.equal(unverified.state, "SETUP_READY", "an unverified 5m confirmation never triggers");
  // Price 4057: the nearest zone below ends at 4052 (1H point of control), more than 0.35 ATR away.
  const away = buildStrategy(input({ m15Bars: m15Bars.map((b) => ({ ...b, close: 4057, high: 4060, low: 4046 })), h1Snapshot: snapshot("60", 4057), m15Snapshot: snapshot("15", 4057) }));
  assert.equal(away.state, "SETUP_FORMING", away.headline);
  assert.ok(away.plan.entry < 4057, "the planned entry is a pullback to the level below");
  assert.match(away.headline, /wait for a pullback/);
  assert.equal(away.plan.entry, 4052, "the pullback is to the top of the 1H point of control zone");
});

test("the trend decides the side: a 1H room against the trend, or a 15m room against both, gives no setup", () => {
  const against = buildStrategy(input({ rooms: rooms(bull, bull, bear, bull) }));
  assert.equal(against.state, "NO_SETUP");
  assert.match(against.headline, /1-hour room leans .*against it/);
  const m15Against = buildStrategy(input({ rooms: rooms(bull, bull, bull, bear) }));
  assert.equal(m15Against.state, "NO_SETUP");
  // Price 4047 sits under the 1H Camarilla H3 (4048): a short at resistance.
  const short = buildStrategy(input({ rooms: rooms(bear, bear, bear, bear), confirmations: { m5_prophet_r38: { sell_confirmed: true, verified: true } },
    m15Bars: m15Bars.map((b) => ({ ...b, close: 4047, high: 4049, low: 4041 })), h1Snapshot: snapshot("60", 4047), m15Snapshot: snapshot("15", 4047) }));
  assert.equal(short.direction, "SHORT");
  assert.equal(short.decision, "SELL", short.headline);
  assert.ok(short.plan.stop > short.plan.entry && short.plan.tp1 < short.plan.entry);
  const neutralTrend = buildStrategy(input({ rooms: rooms(["NEUTRAL", "NEUTRAL"], ["NEUTRAL"], ["BULLISH", "BULLISH"], ["BULLISH", "BULLISH"]) }));
  assert.equal(neutralTrend.direction, "LONG", "a neutral trend lets a strong 1H and 15m agreement through");
});

test("vetoes block the setup: a Prophet cut loss, a strong GMI verdict against the trade", () => {
  for (const extra of [{ prophet: { fields: { t_enc: 4 } } }, { decision_matrix: { fields: { conflict: false, gate: 1, verdict: -3 } } }]) {
    const s = buildStrategy(input({ h1Snapshot: snapshot("60", 4040, extra) }));
    assert.equal(s.state, "BLOCKED", JSON.stringify(extra));
    assert.equal(s.decision, "WAIT");
    assert.ok(s.vetoes.length);
  }
  // Owner decision 2026-11-06 ("longgarkan"): a GMI and Prophet conflict and a closed GMI gate are
  // cautions, not vetoes: each lowers the confidence by 0.1 and the trade may still trigger.
  const base = buildStrategy(input());
  const loosened = buildStrategy(input({ h1Snapshot: snapshot("60", 4040, { decision_matrix: { fields: { conflict: true, gate: -1, verdict: 1 } }, trade_management: { fields: { conflict: true, gate: -1 } } }) }));
  assert.equal(loosened.vetoes.length, 0);
  assert.deepEqual(loosened.cautions, ["GMI and Prophet conflict on the 1-hour chart", "the GMI confluence gate is closed on the 1-hour chart"]);
  assert.equal(loosened.confidence, Math.round((base.confidence - 0.2) * 100) / 100);
  assert.equal(loosened.state, base.confidence - 0.2 >= 0.4 ? "TRIGGERED" : "LOW_CONFIDENCE");
  const caution = buildStrategy(input({ news: { tldr: { status: "ok", stance: "BEARISH", confidence: 0.8 } } }));
  assert.ok(caution.cautions.some((c) => /news/.test(c)));
  assert.ok(caution.confidence < buildStrategy(input()).confidence);
});

test("stale or missing rooms give no setup; the reward must reach the minimum", () => {
  assert.equal(buildStrategy(input({ rooms: {} })).state, "NO_SETUP");
  const stale = buildStrategy(input({ now: NOW + 3 * 86_400_000 }));
  assert.equal(stale.state, "NO_SETUP");
  const plan = tradeLevels({ dir: 1, price: 100, levels: [{ price: 99.5, label: "support" }, { price: 98, label: "lower support" }, { price: 101, label: "near resistance" }], atrH1: 2 });
  assert.equal(plan.entry, 100);
  assert.ok(plan.rrr.tp1 > 0 && plan.rrr.tp2 >= plan.rrr.tp1);
});

test("ATR and lean helpers; a plan on zones uses their edges", () => {
  assert.equal(atr(h1Bars), 10);
  assert.equal(atr([]), null);
  assert.equal(roomLean([op("a", "BULLISH", 1), op("b", "BEARISH", 1)]), 0);
  const zones = [{ low: 96, high: 97, price: 96.5, label: "support zone", major: true }, { low: 99, high: 99.8, price: 99.4, label: "entry zone", major: true }, { low: 103, high: 104, price: 103.5, label: "first target", major: true }, { low: 106, high: 107, price: 106.5, label: "second target", major: true }];
  const plan = tradeLevels({ dir: 1, price: 100, levels: zones, atrH1: 2 });
  assert.equal(plan.entry, 100, "within 0.35 ATR of the entry zone's top");
  assert.equal(plan.stop, 98.6, "beyond the far edge of the entry zone, padded");
  assert.equal(plan.tp1, 103, "the near edge of the first target zone");
  assert.equal(plan.tp2, 106);
  const short = tradeLevels({ dir: -1, price: 102.8, levels: zones, atrH1: 2 });
  assert.equal(short.entry, 102.8, "a short at the near edge of a resistance zone");
  assert.equal(short.stop, 104.4);
  assert.equal(short.tp1, 99.8);
});

test("the global action is the strategy decision; without a strategy it stays the H1 decision", () => {
  const strategy = buildStrategy(input());
  const g = buildGlobalConclusion({ h1Decision: { decision: "WAIT", confidence: 0 }, strategy });
  assert.equal(g.action, "BUY");
  assert.match(g.action_reason, /^Strategy engine: BUY/);
  assert.equal(g.strategy.state, "TRIGGERED");
  assert.equal(g.h1_decision.decision, "WAIT");
  assert.equal(buildGlobalConclusion({ h1Decision: { decision: "WAIT", confidence: 0 } }).action, "WAIT");
});

test("at a 5m close the engine uses that bar's close and names the bar of the confirmation", () => {
  const s = buildStrategy(input({ m5Price: 4041, confirmations: { m5_prophet_r38: { buy_confirmed: true, verified: true, candle_time: "2026-11-06T14:25:00.000Z" } } }));
  assert.equal(s.price, 4041, "the 5m close is the price");
  assert.equal(s.state, "TRIGGERED", s.headline);
  assert.match(s.headline, /verified 5m Prophet buy confirmation on the 5m bar closing 14:25 UTC/);
  assert.equal(buildStrategy(input()).price, 4040, "without a 5m close the 15m close stays the price");
});

test("planForDirection: the plan for the quorum's direction, on the strategy's price, ATR and key zones (owner decision 2026-11-09)", () => {
  const zones = [{ low: 96, high: 97, price: 96.5, label: "support zone", candidate: true }, { low: 99, high: 99.8, price: 99.4, label: "entry zone", candidate: true }, { low: 103, high: 104, price: 103.5, label: "first target", candidate: true }, { low: 106, high: 107, price: 106.5, label: "second target", candidate: true }];
  const strategy = { direction: "NONE", price: 100, atr_h1: 2, key_levels: { zones }, plan: null };
  const long = planForDirection(strategy, 1);
  assert.deepEqual([long.entry, long.stop, long.tp1, long.tp2], [100, 98.6, 103, 106], "the same levels as tradeLevels on the zones");
  const short = planForDirection({ ...strategy, price: 102.8 }, -1);
  assert.deepEqual([short.entry, short.stop, short.tp1], [102.8, 104.4, 99.8]);
  assert.equal(planForDirection(strategy, 0), null);
  assert.equal(planForDirection(null, 1), null);
  assert.equal(planForDirection({ ...strategy, atr_h1: null }, 1), null, "no ATR, no plan");
});
