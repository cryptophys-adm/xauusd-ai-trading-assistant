import test from "node:test";
import assert from "node:assert/strict";
import { computeGmi } from "../local-engines/gmi/src/gmi-core.mjs";
import { replayProphetR37ClosedBars } from "../src/prophet-r37-oscillator.mjs";
import { replayProphetR37Structure } from "../src/prophet-r37-kernel.mjs";
import { regateGmi } from "../src/gmi-regate.mjs";

/** A seeded, regime-switching bundle (trends, chop, traps) so many GMI branches occur. */
function bundle(seed, hours = 1100) {
  let s = seed, p = 3900;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const end = Date.parse("2026-11-03T09:00:00Z") / 1000;
  const H = 3600;
  const h1 = [];
  for (let i = 0; i < hours; i++) {
    const drift = Math.sin(i / 37) * 2.5 + Math.sin(i / 9) * 1.2;
    const o = p; p = o + drift + (rnd() - 0.5) * 12;
    const t = end - (hours - 1 - i) * H;
    h1.push({ time: t, open_time: new Date(t * 1000).toISOString(), close_time: new Date((t + H) * 1000).toISOString(), open: o, high: Math.max(o, p) + rnd() * 6, low: Math.min(o, p) - rnd() * 6, close: p, volume: 800 + Math.round(rnd() * 900) });
  }
  const resample = (sec) => {
    const out = [];
    for (const b of h1) {
      const t = Math.floor(b.time / sec) * sec, last = out.at(-1);
      if (last && last.time === t) { last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close; last.volume += b.volume; last.close_time = new Date((t + sec) * 1000).toISOString(); }
      else out.push({ ...b, time: t, open_time: new Date(t * 1000).toISOString(), close_time: new Date((t + sec) * 1000).toISOString() });
    }
    return out;
  };
  const m15 = h1.flatMap((b) => [0, 1, 2, 3].map((k) => { const t = b.time + k * 900; const f = (x) => b.open + (b.close - b.open) * x; return { time: t, open_time: new Date(t * 1000).toISOString(), close_time: new Date((t + 900) * 1000).toISOString(), open: f(k / 4), close: f((k + 1) / 4), high: Math.max(f(k / 4), f((k + 1) / 4)) + 1, low: Math.min(f(k / 4), f((k + 1) / 4)) - 1, volume: b.volume / 4 }; }));
  const m1 = h1.slice(-50).flatMap((b) => Array.from({ length: 60 }, (_, k) => { const t = b.time + k * 60; const f = (x) => b.open + (b.close - b.open) * x; const up = rnd() > 0.5; return { time: t, open_time: new Date(t * 1000).toISOString(), close_time: new Date((t + 60) * 1000).toISOString(), open: f(k / 60), close: f((k + 1) / 60) + (up ? 0.2 : -0.2), high: Math.max(f(k / 60), f((k + 1) / 60)) + 0.5, low: Math.min(f(k / 60), f((k + 1) / 60)) - 0.5, volume: b.volume / 60 }; }));
  return { timeframes: { H1: { candles: h1 }, M15: { candles: m15 }, M1: { candles: m1 }, H4: { candles: resample(4 * H) }, D1: { candles: resample(86400) }, W1: { candles: resample(604800) } } };
}

/** The bundle cut at H1 bar index `end` (inclusive), like the producer sees it then. */
function cut(b, end) {
  const closeMs = Date.parse(b.timeframes.H1.candles[end].close_time);
  const tf = {};
  for (const [k, v] of Object.entries(b.timeframes)) tf[k] = { candles: v.candles.filter((c) => Date.parse(c.close_time) <= closeMs) };
  return { timeframes: tf };
}

test("with the active structure, the re-gate reproduces GMI's comparable fields exactly", () => {
  const branches = new Map();
  let cases = 0;
  for (const seed of [3, 11, 29]) {
    const b = bundle(seed);
    const n = b.timeframes.H1.candles.length;
    for (let end = n - 40; end < n; end += 3) {
      const g = computeGmi(cut(b, end), { mintick: 0.001 });
      const chart = cut(b, end).timeframes.H1.candles.slice(-1000);
      const r = replayProphetR37ClosedBars(chart.map((c, i) => ({ bar_index: i, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })), { mintick: 0.001 });
      const st = r.structure.at(-1);
      const re = regateGmi({ diagnostics: g.diagnostics, close: g.candle.c, proFast: r.pro_fast.at(-1), subtype: st.subtype, dEnc: st.d_enc });
      assert.deepEqual(re, g.comparable, `seed ${seed} bar ${end} branch ${g.diagnostics.branch}`);
      branches.set(g.diagnostics.branch, (branches.get(g.diagnostics.branch) || 0) + 1);
      cases += 1;
    }
  }
  assert.ok(cases >= 30);
  assert.ok(branches.size >= 2, "the fixture must exercise more than one branch: " + JSON.stringify([...branches]));
  assert.ok(branches.has("initial"), "the initial cascade (where the structure matters) must be covered");
});

test("a structure change flips only what the structure feeds: the risk hold and mtf_state", () => {
  const diagnostics = { branch: "initial", htf_state: 1, ltf_state: 0, ext_state: 0, vah: 110, val: 90, poc: 100 };
  // Bull trap latched (subtype 1): risk hold forces a conflict, verdict 0, gate -1.
  assert.deepEqual(regateGmi({ diagnostics, close: 100, proFast: 0.2, subtype: 1, dEnc: 3 }), { verdict: 0, gate: -1, gmi_dir: 0, prophet_dir: 0, conflict: true });
  // The same bar after the latch expired (subtype 0, d_enc 0): no risk hold; htf up but mtf
  // and ltf neutral, so verdict 0 and the gate is open (1), prophet_dir follows pro_fast.
  assert.deepEqual(regateGmi({ diagnostics, close: 100, proFast: 0.2, subtype: 0, dEnc: 0 }), { verdict: 0, gate: 1, gmi_dir: 0, prophet_dir: 1, conflict: false });
  // A bullish sweep (subtype 3) feeds mtf_state +1: verdict 3, aligned only when the value area agrees.
  assert.deepEqual(regateGmi({ diagnostics, close: 100, proFast: 0.2, subtype: 3, dEnc: -3 }), { verdict: 3, gate: 1, gmi_dir: 1, prophet_dir: 1, conflict: false });
  assert.deepEqual(regateGmi({ diagnostics, close: 111, proFast: 0.2, subtype: 3, dEnc: -3 }), { verdict: 3, gate: 2, gmi_dir: 1, prophet_dir: 1, conflict: false });
  // An override branch keeps its verdict whatever the structure.
  assert.equal(regateGmi({ diagnostics: { ...diagnostics, branch: "entropy_trap" }, close: 100, proFast: 0.2, subtype: 3, dEnc: -3 }).verdict, 0);
  assert.equal(regateGmi({ diagnostics: { ...diagnostics, branch: "unknown" }, close: 100, proFast: 0.2, subtype: 0, dEnc: 0 }), null);
});
