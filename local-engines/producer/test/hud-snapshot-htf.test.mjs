import test from "node:test";
import assert from "node:assert/strict";
import { buildHudSnapshot } from "../src/hud-snapshot.mjs";
import { validateHudSnapshot } from "../../../src/hud-store.mjs";

/** One base path aggregated to every timeframe; H4 and D1 anchored at 22:00 UTC as OANDA's. */
function bundleFrom({ endMs, baseMin, days }) {
  const n = Math.floor((days * 1440) / baseMin);
  const startMs = endMs - n * baseMin * 60_000;
  const base = [];
  for (let i = 0; i < n; i++) {
    const t = startMs + i * baseMin * 60_000;
    const o = 3900 + Math.sin(i / 97) * 18 + Math.sin(i / 13) * 3 + i * 0.001;
    const c = o + Math.sin(i / 5) * 0.8;
    base.push({ t, o, h: Math.max(o, c) + 0.4, l: Math.min(o, c) - 0.4, c, v: 50 + (i % 11) * 7 });
  }
  const anchor22 = 22 * 3600_000;
  const agg = (periodMin, anchor = 0) => {
    const ms = periodMin * 60_000, out = new Map();
    for (const b of base) {
      const open = Math.floor((b.t - anchor) / ms) * ms + anchor;
      const cur = out.get(open);
      if (!cur) out.set(open, { open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, openMs: open, ms });
      else { cur.high = Math.max(cur.high, b.h); cur.low = Math.min(cur.low, b.l); cur.close = b.c; cur.volume += b.v; }
    }
    return [...out.values()].filter((b) => b.openMs >= startMs && b.openMs + b.ms <= endMs).map((b) => ({
      time: b.openMs / 1000, open_time: new Date(b.openMs).toISOString(), close_time: new Date(b.openMs + b.ms).toISOString(),
      open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume
    }));
  };
  const tf = { M15: { candles: agg(15) }, H1: { candles: agg(60) }, H4: { candles: agg(240, anchor22 % (240 * 60_000)) }, D1: { candles: agg(1440, anchor22) }, W1: { candles: agg(10080, anchor22) } };
  if (baseMin <= 5) tf.M5 = { candles: agg(5) };
  return { timeframes: tf };
}

test("an H4 HUD snapshot: timeframe 240, every HUD with GMI from 5-minute intrabars, valid for the store", () => {
  const end = Date.parse("2026-11-04T02:00:00Z");
  const snap = buildHudSnapshot(bundleFrom({ endMs: end, baseMin: 5, days: 60 }), { chart: "H4", now: end + 60_000 });
  assert.equal(snap.timeframe, "240");
  assert.equal(snap.candle_key, "OANDA:XAUUSD:240:" + (end - 4 * 3600_000));
  assert.equal(snap.gmi_error, null);
  assert.ok(snap.huds.decision_matrix && snap.huds.kinetic_engine, "GMI HUDs are computed");
  assert.ok(snap.huds.interstellar_eyes.fields.camarilla["240"], "the chart's own Camarilla is the previous bar's");
  assert.deepEqual(validateHudSnapshot(snap, end + 60_000), { valid: true, errors: [] });
});

test("a D1 HUD snapshot uses timeframe 1D and 15-minute intrabars", () => {
  const end = Date.parse("2026-11-03T22:00:00Z");
  const snap = buildHudSnapshot(bundleFrom({ endMs: end, baseMin: 15, days: 340 }), { chart: "D1", now: end + 60_000 });
  assert.equal(snap.timeframe, "1D");
  assert.equal(snap.candle_key, "OANDA:XAUUSD:1D:" + (end - 24 * 3600_000));
  assert.equal(snap.gmi_error, null);
  assert.ok(!("D" in snap.huds.interstellar_eyes.fields.camarilla), "no duplicate daily entry on the daily chart");
  assert.equal(validateHudSnapshot(snap, end + 60_000).valid, true);
});
