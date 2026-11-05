import test from "node:test";
import assert from "node:assert/strict";
import { computeMacroAether, consolidationGravity, fvgReservoir, macroKinematics, macroPenalty, macroShift, roc, rsi } from "../src/macro-aether.mjs";

const H = 3600_000, H4 = 4 * H;
const T0 = Date.parse("2026-10-01T00:00:00Z");
function series(n, ms, f, start = T0) {
  return Array.from({ length: n }, (_, i) => {
    const o = f(i), c = f(i + 0.5);
    return { open_time: new Date(start + i * ms).toISOString(), close_time: new Date(start + (i + 1) * ms).toISOString(), open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c, volume: 1000 + (i % 7) * 10 };
  });
}

test("Pine helpers: roc, rsi (Wilder), macro_penalty and the macro shift states", () => {
  assert.deepEqual(roc([100, 110, 121], 1).map((x) => x && Math.round(x)), [null, 10, 10]);
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  assert.equal(rsi(up, 14).at(-1), 100);
  const down = up.map((x) => 300 - x);
  assert.equal(rsi(down, 14).at(-1), 0);
  const zig = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 1 : -1));
  assert.ok(Math.abs(rsi(zig, 14).at(-1) - 50) < 5);
  assert.equal(macroPenalty(false, false), 1.0);
  assert.equal(macroPenalty(true, true), 0.5);
  assert.equal(macroPenalty(true, false), 0.8);
  assert.deepEqual(macroShift(10, -2), { state: "reversal_due", bars_4h: 5 });
  assert.deepEqual(macroShift(1, 0), { state: "stagnant", bars_4h: null });
  assert.equal(macroShift(2, 1).state, "accelerating_dollar_up");
  assert.equal(macroShift(-2, -1).state, "accelerating_dollar_down");
  const k = macroKinematics(Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 6) * 2));
  assert.ok(Number.isFinite(k.theta.at(-1)) && Number.isFinite(k.omega.at(-1)));
});

test("consolidation gravity is positive when the volume profile sits above the close", () => {
  const n = 320;
  const close = Array.from({ length: n }, (_, i) => (i < n - 20 ? 110 : 100));
  const high = close.map((c) => c + 0.5), low = close.map((c) => c - 0.5), hlc3 = close;
  const volume = close.map((c, i) => (i < n - 20 ? 1000 : 0)); // no volume traded near the close
  const atr = close.map(() => 1);
  const g = consolidationGravity({ high, low, volume, hlc3, close, atr }, n - 1, 300, 40, 0.001);
  assert.ok(g > 50, String(g));
  assert.equal(consolidationGravity({ high, low, volume, hlc3, close, atr }, 10, 300, 40), null, "not enough bars");
});

test("FVG reservoir: a filled bullish gap flows in (SMRI rises); an open bearish gap above pulls price up", () => {
  // 500 flat bars of history (SMRI scales to a 500-bar range, as Pine's ta.highest),
  // a bullish FVG at bar 530 (gap 100.5 -> 103), then price falls back into it.
  const bars = [];
  for (let j = 0; j < 560; j++) {
    const i = j - 500;
    let o = 100, h = 100.5, l = 99.5, c = 100;
    if (i === 29) { o = 100; c = 102.5; h = 102.6; l = 99.9; }
    if (i === 30) { o = 103.2; c = 103.5; h = 104; l = 103; }
    if (i > 30 && i < 40) { o = 103.5; c = 103.6; h = 104; l = 103.1; }
    if (i >= 40) { o = 101; c = 100.5; h = 101.2; l = 99.8; }
    bars.push({ o, h, l, c, v: 1000 });
  }
  const r = fvgReservoir({ open: bars.map((b) => b.o), high: bars.map((b) => b.h), low: bars.map((b) => b.l), close: bars.map((b) => b.c), volume: bars.map((b) => b.v), atr: bars.map(() => 1) });
  assert.ok(r.smri.at(-1) > 50, "inflow lifts the reservoir index");
  // A bearish gap left open above the close pulls up.
  const b2 = bars.slice(0, 530).map((b) => ({ ...b, o: 110, h: 110.5, l: 109.5, c: 110 }));
  b2.push({ o: 110, c: 107.5, h: 110.1, l: 107.4, v: 1000 }, { o: 106.8, c: 106.5, h: 107, l: 106, v: 1000 });
  for (let i = 0; i < 10; i++) b2.push({ o: 106.4, c: 106.3, h: 106.8, l: 106, v: 1000 });
  const q = fvgReservoir({ open: b2.map((b) => b.o), high: b2.map((b) => b.h), low: b2.map((b) => b.l), close: b2.map((b) => b.c), volume: b2.map((b) => b.v), atr: b2.map(() => 1) });
  assert.ok(q.g_scale.at(-1) > 0, "an open bear target above price pulls up");
  assert.ok(q.open_targets.bear >= 1, "the bearish gaps stay open above the close");
});

test("computeMacroAether: risk on/off from DXY and USDT, WTI asset gravity, nothing invented when inputs are missing", () => {
  const chartBars = series(400, H, (i) => 2300 + Math.sin(i / 20) * 15);
  const end = Date.parse(chartBars.at(-1).close_time);
  const h4 = (f) => ({ H4: { candles: series(120, H4, f, end - 120 * H4) } });
  const oilUp = { H1: { candles: series(200, H, (i) => 60 + i * 0.1, end - 200 * H) } };
  const falling = computeMacroAether({ chartBars, external: { "TVC:DXY": h4((i) => 110 - i * 0.05), "CRYPTOCAP:USDT": h4((i) => 5 - i * 0.002), "TVC:USOIL": oilUp }, chartKey: "H1" });
  assert.equal(falling.macro_cycle, "risk_on");
  assert.equal(falling.macro_penalty, 1.0);
  assert.equal(falling.asset_gravity, "bias_price_down", "a strong oil RSI is a bias for gold to fall (GMI)");
  assert.ok(falling.oil_rsi > 65);
  assert.ok(falling.kinetic_spread > 0 && falling.kinetic_spread_pct > 0);
  assert.ok(["bullish_pull", "bearish_pull", "balanced"].includes(falling.consolidation_gravity));
  assert.ok(["mark_up", "mark_down", "equilibrium"].includes(falling.smr_phase));
  assert.ok(["pull_up", "pull_down", "balanced"].includes(falling.q_gravity));
  const rising = computeMacroAether({ chartBars, external: { "TVC:DXY": h4((i) => 100 + i * 0.05), "CRYPTOCAP:USDT": h4((i) => 4 + i * 0.002) }, chartKey: "H1" });
  assert.equal(rising.macro_cycle, "risk_off");
  assert.equal(rising.macro_penalty, 0.5);
  assert.equal(rising.asset_gravity, null, "no USOIL series: the row is absent");
  assert.equal(rising.oil_rsi, null);
  const none = computeMacroAether({ chartBars, external: {}, chartKey: "H1" });
  assert.equal(none.macro_cycle, null);
  assert.equal(none.macro_shift, null);
  // Only bars closed at the chart bar's close are read (lookahead off).
  const future = computeMacroAether({ chartBars, external: { "TVC:USOIL": { H1: { candles: series(200, H, (i) => 90 - i * 0.2, end) } } }, chartKey: "H1" });
  assert.equal(future.oil_rsi, null, "bars after the chart close are never used");
});
