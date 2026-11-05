import test from "node:test";
import assert from "node:assert/strict";
import { computeGmi } from "../src/gmi-core.mjs";
import { computeGmiOnChart, GMI_CHART_MINUTES } from "../src/gmi-core-tf.mjs";

// Independent synthetic market: every series is built from the same 1m path, so
// HTF bars aggregate consistently with the chart bars.
function aggregatedBundle({ endMs, minutes = 60 * 24 * 16 }) {
  const startMs = endMs - minutes * 60_000;
  const m1 = [];
  for (let i = 0; i < minutes; i++) {
    const t = startMs + i * 60_000;
    const o = 3900 + Math.sin(i / 97) * 18 + Math.sin(i / 13) * 3 + i * 0.001;
    const c = o + Math.sin(i / 5) * 0.8;
    m1.push({ t, o, h: Math.max(o, c) + 0.4, l: Math.min(o, c) - 0.4, c, v: 50 + (i % 11) * 7 });
  }
  const agg = (periodMin, anchor = 0) => {
    const ms = periodMin * 60_000, out = new Map();
    for (const b of m1) {
      const open = Math.floor((b.t - anchor) / ms) * ms + anchor;
      const cur = out.get(open);
      if (!cur) out.set(open, { open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, openMs: open, ms });
      else { cur.high = Math.max(cur.high, b.h); cur.low = Math.min(cur.low, b.l); cur.close = b.c; cur.volume += b.v; }
    }
    return [...out.values()].filter((b) => b.openMs + b.ms <= endMs).map((b) => ({
      time: b.openMs / 1000, open_time: new Date(b.openMs).toISOString(), close_time: new Date(b.openMs + b.ms).toISOString(),
      open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume
    }));
  };
  return {
    timeframes: {
      M1: { candles: agg(1) }, M5: { candles: agg(5) }, M15: { candles: agg(15) }, H1: { candles: agg(60) },
      H4: { candles: agg(240) }, D1: { candles: agg(1440) }, W1: { candles: agg(10080) }
    }
  };
}

test("computeGmiOnChart on H1 is exactly computeGmi (the approved H1 engine)", () => {
  for (const endIso of ["2026-11-03T10:00:00Z", "2026-11-03T13:00:00Z", "2026-11-04T00:00:00Z"]) {
    const bundle = aggregatedBundle({ endMs: Date.parse(endIso) });
    assert.deepEqual(computeGmiOnChart(bundle, { chart: "H1" }), computeGmi(bundle), endIso);
  }
});

test("computeGmiOnChart on M5 evaluates the last closed 5m bar with 5 one-minute intrabars", () => {
  const endMs = Date.parse("2026-11-03T10:25:00Z");
  const bundle = aggregatedBundle({ endMs });
  const out = computeGmiOnChart(bundle, { chart: "M5" });
  assert.equal(out.open_time, new Date(endMs - 5 * 60_000).toISOString());
  assert.equal(out.diagnostics.intrabars, 5);
  assert.deepEqual(Object.keys(out.comparable), ["verdict", "gate", "gmi_dir", "prophet_dir", "conflict"]);
  assert.ok(Number.isFinite(out.diagnostics.global_h));
});

test("computeGmiOnChart rejects unsupported chart timeframes and short history", () => {
  assert.deepEqual(Object.keys(GMI_CHART_MINUTES), ["M5", "M15", "H1"]);
  assert.throws(() => computeGmiOnChart({ timeframes: {} }, { chart: "H4" }), /unsupported GMI chart timeframe/);
  assert.throws(() => computeGmiOnChart({ timeframes: { M5: { candles: [] } } }, { chart: "M5" }), /insufficient chart history/);
});
