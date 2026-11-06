import test from "node:test";
import assert from "node:assert/strict";
import { hudLevels, LEVEL_TIMEFRAMES } from "../src/hud-levels.mjs";
import { buildGlobalConclusion, roomLean, GLOBAL_WEIGHTS } from "../src/global-conclusion.mjs";

const snapshot = (huds, extra = {}) => ({ candle_key: "OANDA:XAUUSD:60:1793952000000", timeframe: "60", computed_at: "2026-11-06T10:00:40.000Z", huds, ...extra });
const eyes = { fields: { close: 4050, camarilla: { "60": { h6: 4120, h5: 4100, h4: 4080, h3: 4065, l3: 4035, l4: 4020, l5: 4000, l6: 3980 }, D: { h6: 4300, h5: 4200, h4: 4100, h3: 4070, l3: 4010, l4: 3990, l5: 3900, l6: 3800 }, nope: null }, band: { "60": "l3_h3", D: "l3_h3" } } };
const chronos = { fields: { daily_cpr: { pivot: 4040, tc: 4045, bc: 4035, width: 10, position: "above_tc" }, weekly_cpr: { pivot: 3990, tc: 4000, bc: 3980, width: 20, position: "above_tc" } } };
const prophet = { fields: { hurst: 0.62, efficiency_ratio: 0.31, kww_zscore: -1.2, volume_ratio: 1.4, cycle_intensity: 3 } };
const kinetic = { fields: { entropy: 0.86, is_chaos: true, theta: 12.5, omega: -0.4 } };

test("levels: Camarilla per timeframe nearest first, both pivots, the regime sensors, and their calibration", () => {
  const out = hudLevels(snapshot({ interstellar_eyes: eyes, chronos_matrix: chronos, prophet, kinetic_engine: kinetic }), { barsVerified: true });
  assert.equal(out.close, 4050);
  assert.deepEqual(out.camarilla.map((c) => c.tf), ["60", "D"], "chart timeframe first, invalid entries dropped");
  assert.equal(out.camarilla[1].label, "Daily");
  assert.equal(out.camarilla[0].band, "l3_h3");
  assert.equal(out.camarilla[0].levels.h4, 4080);
  assert.equal(out.cpr.daily.position, "above_tc");
  assert.equal(out.cpr.weekly.pivot, 3990);
  assert.deepEqual(out.regime.axes.map((a) => a.key), ["trend", "efficiency", "stretch", "participation", "cycle_alignment", "order"]);
  const v = Object.fromEntries(out.regime.axes.map((a) => [a.key, a.value]));
  assert.equal(v.trend, 0.62);
  assert.equal(v.efficiency, 0.31);
  assert.equal(v.stretch, 0.4, "|z| 1.2 of 3");
  assert.equal(v.participation, 0.7, "volume 1.4x of 2x");
  assert.equal(v.cycle_alignment, 1, "all three cycles agree");
  assert.equal(v.order, 0.14, "1 - entropy");
  assert.equal(out.regime.chaos, true);
  assert.equal(out.calibration.levels, "computed_from_verified_bars");
  assert.equal(out.calibration.regime, "not_yet_calibrated");
  assert.equal(hudLevels(snapshot({ interstellar_eyes: eyes }), { barsVerified: false }).calibration.levels, "not_yet_calibrated");
});

test("levels: missing HUDs give empty sections, never invented numbers", () => {
  const out = hudLevels(snapshot({}), { barsVerified: true });
  assert.equal(out.close, null);
  assert.deepEqual(out.camarilla, []);
  assert.deepEqual(out.cpr, { daily: null, weekly: null });
  assert.ok(out.regime.axes.every((a) => a.value === null));
  assert.deepEqual(LEVEL_TIMEFRAMES, ["15", "60", "240", "1D"]);
});

const op = (id, stance, confidence, status = "ok") => ({ id, stance, confidence, status });
const room = (stance, openings, extra = {}) => ({ bar_close: "2026-11-06T10:00:00.000Z", conclusion: { status: "ok", stance, confidence: 0.7, summary: `The room says ${stance}.` }, openings, ...extra });

test("room lean is the confidence-weighted mean direction of the agents that spoke", () => {
  assert.equal(roomLean([op("a", "BUY", 0.8), op("b", "WAIT", 0.8), op("c", "SELL", 0.4, "agent_failed")]), 0.5);
  assert.equal(roomLean([]), null);
});

test("global conclusion: bias from the weighted rooms and news, action bound by the H1 decision", () => {
  const bullish = [op("a", "BUY", 0.8), op("b", "BUY", 0.6), op("c", "WAIT", 0.4)];
  const g = buildGlobalConclusion({
    d1: room("WAIT", bullish), h4: room("WAIT", bullish), h1: room("BUY", bullish), m15: room("WAIT", [op("a", "WAIT", 0.5)]),
    news: { tldr: { status: "ok", stance: "BULLISH", confidence: 0.6, summary: "Fed cut bets lift gold." }, counts: { bullish: 12, bearish: 4, neutral: 4 } },
    h1Decision: { decision: "BUY", confidence: 0.72, candle_key: "k" }, now: Date.parse("2026-11-06T10:30:00Z")
  });
  assert.equal(g.bias, "BULLISH");
  assert.equal(g.action, "BUY", "the H1 decision stands when the timeframes do not oppose it");
  assert.ok(g.score > 0.3);
  assert.deepEqual(g.timeframes.map((t) => t.key), ["D1", "H4", "H1", "M15", "NEWS"]);
  assert.equal(g.alignment.with_bias, 4, "D1, 4H, 1H and news lean bullish; 15m is neutral");
  assert.equal(g.alignment.of, 5);
  assert.match(g.summary, /^Global bias strongly bullish \(\+63\), 4 of 5 agreeing: D1 strongly bullish/);
  assert.match(g.summary, /H1 decision is BUY/);
  assert.equal(Object.values(GLOBAL_WEIGHTS).reduce((s, w) => s + w, 0).toFixed(2), "1.00");
});

test("global conclusion: an H1 entry against the other timeframes becomes WAIT; WAIT stays WAIT; missing rooms drop out", () => {
  const bearish = [op("a", "SELL", 0.9), op("b", "SELL", 0.7)];
  const g = buildGlobalConclusion({ d1: room("WAIT", bearish), h4: room("WAIT", bearish), h1: null, m15: null, news: null, h1Decision: { decision: "BUY", confidence: 0.6 } });
  assert.equal(g.bias, "BEARISH");
  assert.equal(g.action, "WAIT");
  assert.match(g.action_reason, /against the H1 BUY/);
  assert.equal(g.timeframes.find((t) => t.key === "H1").available, false);
  const w = buildGlobalConclusion({ d1: room("WAIT", bearish), h1Decision: { decision: "WAIT", confidence: 0 } });
  assert.equal(w.action, "WAIT");
  const empty = buildGlobalConclusion({});
  assert.equal(empty.bias, "NEUTRAL");
  assert.equal(empty.score, null);
  assert.equal(empty.action, "WAIT");
  assert.match(empty.summary, /No timeframe/);
});

test("a neutral global bias says the timeframes are split instead of counting agreement", () => {
  const g = buildGlobalConclusion({ d1: room("WAIT", [op("a", "BUY", 0.8)]), h4: room("WAIT", [op("a", "SELL", 0.8)]), h1Decision: { decision: "WAIT", confidence: 0 } });
  assert.equal(g.bias, "NEUTRAL");
  assert.match(g.summary, /^Global bias neutral \(\+\d+\), the timeframes are split: D1 strongly bullish, 4H strongly bearish\./);
});

test("global conclusion marks a room older than two of its bars as stale", () => {
  const g = buildGlobalConclusion({ h1: room("WAIT", [op("a", "BUY", 0.5)], { bar_close: "2026-11-06T06:00:00.000Z" }), now: Date.parse("2026-11-06T10:30:00Z") });
  assert.equal(g.timeframes.find((t) => t.key === "H1").stale, true);
});
