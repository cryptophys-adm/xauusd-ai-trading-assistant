import test from "node:test";
import assert from "node:assert/strict";
import { ema, linregAt, percentrank, pivot, barssince, crossunder } from "../src/pine.mjs";
import { entropyCalc, hurstRsLast, kwwCalc, tdmProfileAt, footprintFromArrays, fabioDecision, obProgressiveUpdate, jurik } from "../src/mizan.mjs";
import { computeGmi } from "../src/gmi-core.mjs";

test("Pine helpers: ema seeds with sma, linreg evaluates at offset, percentrank uses previous values", () => {
  assert.deepEqual(ema([1, 2, 3, 4], 3), [null, null, 2, 3]);
  const line = [1, 2, 3, 4, 5];
  assert.equal(linregAt(line, 4, 5, 0), 5);
  assert.equal(linregAt(line, 4, 5, 1), 4);
  assert.deepEqual(percentrank([1, 2, 3, 2], 2).slice(2), [100, 50]);
  assert.deepEqual(pivot([1, 3, 1, 1], 1, 1, true), [null, null, 3, null]);
  assert.deepEqual(barssince([false, true, false, false]), [null, 0, 1, 2]);
  assert.equal(crossunder([5, 3], [4, 4], 1), true);
});

test("Mizan ports: flat series edge cases and bounded outputs", () => {
  const flat = Array(60).fill(100);
  assert.equal(entropyCalc(flat, 50).at(-1), 0);
  assert.equal(hurstRsLast(flat, 50), 0.5);
  assert.equal(hurstRsLast(flat.slice(0, 20), 50), 0.5);
  const { ma, sigma } = kwwCalc(flat, 50);
  assert.ok(Math.abs(ma.at(-1) - 100) < 1e-9);
  assert.ok(sigma.at(-1) < 1e-6);
  const j = jurik(35, 2, 2, Array.from({ length: 300 }, () => 50));
  assert.ok(Math.abs(j.at(-1) - 50) < 1e-6);
});

test("TDM profile returns an ordered value area (VAH >= POC >= VAL) inside the range", () => {
  const n = 320;
  const close = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 7) * 3);
  const high = close.map((c) => c + 0.5), low = close.map((c) => c - 0.5);
  const p = tdmProfileAt({ high, low, volume: close.map(() => 10), hlc3: close, entropy: close.map(() => 0.5), close, atr: close.map(() => 1) }, n - 1, 300, 40, 0.001);
  assert.ok(p.vah >= p.poc && p.poc >= p.val, JSON.stringify(p));
  assert.ok(p.val >= Math.min(...low) - 1e-9 && p.vah <= Math.max(...high) + 1e-9);
});

test("footprint splits intrabar volume by candle direction; no intrabars is na", () => {
  assert.deepEqual(footprintFromArrays([{ open: 1, close: 2, volume: 10 }, { open: 2, close: 1, volume: 4 }, { open: 1, close: 1, volume: 2 }]), { buy: 11, sell: 5 });
  assert.deepEqual(footprintFromArrays([]), { buy: null, sell: null });
});

test("Fabio decision and OB progressive mitigation follow the Mizan rules", () => {
  const f = fabioDecision({ close: 100, atr: 1, isNy: true, isLondon: true, imbBull: true, imbBear: false, lvnBull: 98, lvnBear: null, m1Bull: true, m1Bear: false, fakeoutBotSince: 2, fakeoutTopSince: 4, m2Bull: true, m2Bear: true });
  assert.deepEqual(f, { m1Buy: true, m1Sell: false, m2Buy: true, m2Sell: false });
  const u = obProgressiveUpdate(1, 10, 8, 2, 1, 11, 9, 10, 0.25, true, false, 0.001);
  assert.equal(u.top, 9);
  assert.equal(u.touched, true);
  assert.equal(u.invalid, false);
  const broken = obProgressiveUpdate(1, 10, 8, 2, 1, 11, 7.5, 7.6, 0.25, true, false, 0.001);
  assert.equal(broken.invalid, true);
});

function syntheticBundle(withM1) {
  const H = 3600;
  const end = Date.parse("2026-11-03T09:00:00Z") / 1000;
  const bar = (t, i, sec) => {
    const o = 3900 + Math.sin(i / 11) * 20 + i * 0.03;
    const c = o + Math.sin(i / 3) * 4;
    return { time: t, open_time: new Date(t * 1000).toISOString(), close_time: new Date((t + sec) * 1000).toISOString(), open: o, high: Math.max(o, c) + 2, low: Math.min(o, c) - 2, close: c, volume: 1000 + (i % 13) * 90 };
  };
  const series = (count, sec, lastOpen) => Array.from({ length: count }, (_, i) => bar(lastOpen - (count - 1 - i) * sec, i, sec));
  const tf = {
    H1: { candles: series(1000, H, end) },
    M15: { candles: series(2000, 900, end + 2700) },
    H4: { candles: series(500, 4 * H, end - 4 * H) },
    D1: { candles: series(500, 86400, end - 86400 - 3600 * 11) },
    W1: { candles: series(260, 604800, end - 604800) }
  };
  if (withM1) tf.M1 = { candles: series(3000, 60, end + 3540) };
  return { timeframes: tf };
}

test("computeGmi is deterministic, uses M1 intrabars for the footprint, and emits the five webhook fields", () => {
  const a = computeGmi(syntheticBundle(true));
  const b = computeGmi(syntheticBundle(true));
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a.comparable), ["verdict", "gate", "gmi_dir", "prophet_dir", "conflict"]);
  assert.ok([-3, -1, 0, 3, 4].includes(a.comparable.verdict));
  assert.ok([0, -2, -1, 1, 2].includes(a.comparable.gate));
  assert.equal(a.diagnostics.intrabars, 60);
  assert.notEqual(a.diagnostics.fp_status, "NO LTF DATA");
  if (a.comparable.conflict) assert.equal(a.comparable.verdict, 0);
  const noM1 = computeGmi(syntheticBundle(false));
  assert.equal(noM1.diagnostics.fp_status, "NO LTF DATA");
});
