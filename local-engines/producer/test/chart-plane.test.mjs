import test from "node:test";
import assert from "node:assert/strict";
import { buildHudSnapshot } from "../src/hud-snapshot.mjs";
import { validateHudSnapshot } from "../../../src/hud-store.mjs";
import {
  buildChartPlane, fibGrid, fibStructure, fvgTargets, whaleZones, sessionProfile, trueOpenings, macroBaselines, tdmProfile, nyParts, FIB_RATIOS
} from "../src/chart-plane.mjs";

const MIN = 60_000, HOUR = 3_600_000;

/** One base path aggregated to every timeframe; D1 and W1 anchored at 22:00 UTC as OANDA's. */
function bundleFrom({ endMs, baseMin, days }) {
  const n = Math.floor((days * 1440) / baseMin);
  const startMs = endMs - n * baseMin * MIN;
  const base = [];
  for (let i = 0; i < n; i++) {
    const t = startMs + i * baseMin * MIN;
    const o = 3900 + Math.sin(i / 97) * 18 + Math.sin(i / 13) * 3 + i * 0.001;
    const c = o + Math.sin(i / 5) * 0.8;
    base.push({ t, o, h: Math.max(o, c) + 0.4, l: Math.min(o, c) - 0.4, c, v: 50 + (i % 11) * 7 });
  }
  const anchor22 = 22 * HOUR;
  const agg = (periodMin, anchor = 0) => {
    const ms = periodMin * MIN, out = new Map();
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
  const tf = { M15: { candles: agg(15) }, H1: { candles: agg(60) }, H4: { candles: agg(240, anchor22 % (240 * MIN)) }, D1: { candles: agg(1440, anchor22) }, W1: { candles: agg(10080, anchor22) } };
  if (baseMin <= 5) tf.M5 = { candles: agg(5) };
  if (baseMin === 1) tf.M1 = { candles: agg(1) };
  return { timeframes: tf };
}

const bar = (ms, o, h, l, c, v = 100, mins = 60) => ({ open_time: new Date(ms).toISOString(), close_time: new Date(ms + mins * MIN).toISOString(), open: o, high: h, low: l, close: c, volume: v });
const seriesOf = (bars, extra = {}) => ({
  open: bars.map((b) => b.open), high: bars.map((b) => b.high), low: bars.map((b) => b.low), close: bars.map((b) => b.close),
  volume: bars.map((b) => b.volume), atr: bars.map(() => 2), volSma: bars.map(() => 100), entropy: bars.map(() => 0.5), ...extra
});

test("the H1 snapshot carries the chart plane: bands, liquidity, projection and session, and stays valid for the store", () => {
  const end = Date.parse("2026-11-04T15:00:00Z");
  const snap = buildHudSnapshot(bundleFrom({ endMs: end, baseMin: 1, days: 16 }), { chart: "H1", now: end + MIN });
  const p = snap.chart_plane;
  assert.ok(p, "the plane is computed");
  assert.equal(p.version, "cryptophys.chart-plane.v1");
  const k = p.bands.kww;
  assert.ok(k.minus_1618 < k.minus_1 && k.minus_1 < k.ma && k.ma < k.plus_1 && k.plus_1 < k.plus_1618, "KWW bands are ordered");
  assert.ok(Math.abs(k.zscore - (p.close - k.ma) / ((k.plus_1 - k.ma) || 1)) < 0.01, "the z-score is the close against the band");
  assert.ok(Number.isFinite(p.bands.ema_114) && Number.isFinite(p.bands.vwap), "EMA 114 and the session VWAP");
  assert.ok(p.bands.tva.lower < p.bands.tva.mid && p.bands.tva.mid < p.bands.tva.upper && p.bands.tva.period >= 10 && p.bands.tva.period <= 500);
  const prof = p.liquidity.profile;
  assert.ok(prof.val <= prof.poc && prof.poc <= prof.vah, "TDM value area holds its POC");
  assert.equal(Object.keys(p.projection.fib.levels).length, FIB_RATIOS.length, "all 15 Fibonacci ratios");
  assert.ok(p.projection.cone.p10 < p.close && p.close < p.projection.cone.p90, "the cone brackets the close");
  const sp = p.session.profile;
  assert.equal(sp.intrabars, "M1");
  assert.ok(sp.current && sp.current.val <= sp.current.poc && sp.current.poc <= sp.current.vah, "the session profile is computed from 1m bars");
  assert.ok(Number.isFinite(p.session.opens.day) && Number.isFinite(p.session.baselines.day_open));
  assert.equal(snap.huds.chart_plane, undefined, "the plane is not a HUD section, so it adds no room agent");
  assert.deepEqual(validateHudSnapshot(snap, end + MIN), { valid: true, errors: [] });
  assert.ok(JSON.stringify(snap).length < 64 * 1024, "the snapshot stays under the store's 64 KB limit");
});

test("the H4 and D1 snapshots read the session profile from 5m and 15m bars", () => {
  const e4 = Date.parse("2026-11-04T02:00:00Z");
  const s4 = buildHudSnapshot(bundleFrom({ endMs: e4, baseMin: 5, days: 60 }), { chart: "H4", now: e4 + MIN });
  assert.equal(s4.chart_plane.session.profile.intrabars, "M5");
  assert.ok(s4.chart_plane.session.profile.current?.poc);
  assert.equal(validateHudSnapshot(s4, e4 + MIN).valid, true);
  const eD = Date.parse("2026-11-03T22:00:00Z");
  const sD = buildHudSnapshot(bundleFrom({ endMs: eD, baseMin: 15, days: 340 }), { chart: "D1", now: eD + MIN });
  assert.equal(sD.chart_plane.session.profile.intrabars, "M15");
  assert.ok(sD.chart_plane.bands.kww && sD.chart_plane.projection.fib);
  assert.equal(validateHudSnapshot(sD, eD + MIN).valid, true);
});

test("a short window yields no plane rather than an invented one", () => {
  const bars = Array.from({ length: 100 }, (_, i) => bar(i * HOUR, 1, 2, 0.5, 1.5));
  assert.equal(buildChartPlane({ timeframes: {} }, { chart: "H1", chartBars: bars }), null);
});

test("Fibonacci grid: up from the struct low, down from the struct high, warped around 0.5", () => {
  const up = fibGrid({ dir: 2, high: 110, low: 100 }, 1);
  assert.equal(up.direction, "up");
  assert.equal(up.levels["0"], 100);
  assert.equal(up.levels["1"], 110);
  assert.equal(up.levels["0.618"], 106.18);
  const down = fibGrid({ dir: 1, high: 110, low: 100 }, 1);
  assert.equal(down.levels["0"], 110);
  assert.equal(down.levels["0.618"], 103.82);
  const warped = fibGrid({ dir: 2, high: 110, low: 100 }, 0.5);
  assert.equal(warped.levels["0.5"], 105, "0.5 is fixed by the warp");
  assert.equal(warped.levels["1"], 107.5, "1.0 moves to 0.75 at warp 0.5");
});

test("Fibonacci structure: a close above the struct high after three bars below turns the grid up", () => {
  const bars = [];
  for (let i = 0; i < 20; i++) bars.push(bar(i * HOUR, 100, 101, 99, 100));
  bars.push(bar(20 * HOUR, 100, 106, 100, 105));
  const s = fibStructure(seriesOf(bars), bars.length - 1);
  assert.equal(s.dir, 2);
  assert.equal(s.high, 106);
  assert.equal(s.low, 99);
});

test("FVG: a bull gap with volume leaves an open target at the gap top until price trades back to it", () => {
  const bars = [bar(0, 100, 101, 99, 100), bar(HOUR, 100, 104, 100, 104), bar(2 * HOUR, 104, 106, 103, 105), bar(3 * HOUR, 105, 107, 104, 106)];
  let f = fvgTargets(seriesOf(bars), 3);
  assert.deepEqual(f.bull.map((x) => x.price), [101]);
  assert.ok(f.bull[0].mass > 0);
  bars.push(bar(4 * HOUR, 106, 106, 100.5, 101));
  f = fvgTargets(seriesOf(bars), 4);
  assert.equal(f.bull.length, 0, "filled");
});

test("Whale zones: a high-volume bar opens a support zone; a close below it turns it into a mitigation block that resists", () => {
  const bars = [bar(0, 100, 101, 99, 100), bar(HOUR, 100, 103, 100, 102.5, 300), bar(2 * HOUR, 102.5, 103, 102, 102.8)];
  let z = whaleZones(seriesOf(bars), 2);
  assert.equal(z.length, 1);
  assert.deepEqual([z[0].role, z[0].state, z[0].top, z[0].bottom], ["support", "active", 102.8, 102.2]);
  bars.push(bar(3 * HOUR, 102.5, 102.6, 101, 101.5));
  z = whaleZones(seriesOf(bars), 3);
  assert.deepEqual([z[0].role, z[0].state], ["resistance", "mitigation"]);
  bars.push(bar(4 * HOUR, 101.5, 103.5, 101.5, 103.2));
  assert.equal(whaleZones(seriesOf(bars), 4).length, 0, "a close back above invalidates the block");
});

test("TDM profile: POC inside the value area; HVN and LVN split around the close", () => {
  const bars = [];
  for (let i = 0; i < 300; i++) {
    const c = 100 + (i % 3 === 0 ? 0 : i % 7) * 0.5;
    bars.push(bar(i * HOUR, c, c + 0.5, c - 0.5, c, i % 3 === 0 ? 500 : 50));
  }
  const p = tdmProfile(seriesOf(bars), 299, 300, 40, 0.001);
  assert.ok(p.val <= p.poc && p.poc <= p.vah);
  assert.ok(p.lvn_bull.length + p.lvn_bear.length > 0);
});

test("session profile: Mizan ext_profile POC and a 70 % value area", () => {
  const bars = [];
  for (let i = 0; i < 60; i++) bars.push(bar(i * MIN, 100, 100.5, 99.5, 100.2, i < 40 ? 1000 : 10, 1));
  bars.push(bar(60 * MIN, 104, 105, 104, 104.5, 10, 1));
  const p = sessionProfile(bars);
  assert.equal(p.bars, 61);
  assert.ok(p.poc > 99.5 && p.poc < 100.5, "the POC is where the volume traded");
  assert.ok(p.val <= p.poc && p.poc <= p.vah && p.vah < 105);
});

test("True Openings and baselines are read at their New York times", () => {
  // 2026-11-02 is a Monday; New York is UTC-5 after 2026-11-01.
  const start = Date.parse("2026-11-01T22:00:00Z");
  const m15 = [];
  for (let i = 0; i < 4 * 24 * 2; i++) { const ms = start + i * 15 * MIN; m15.push(bar(ms, 1000 + i, 1001 + i, 999 + i, 1000.5 + i, 10, 15)); }
  const closeMs = Date.parse("2026-11-03T18:00:00Z");
  const o = trueOpenings({ m15 }, closeMs);
  const openAt = (iso) => m15.find((b) => b.open_time === iso).open;
  assert.equal(o.day, openAt("2026-11-03T05:00:00.000Z"), "00:00 New York");
  assert.equal(o.london, openAt("2026-11-03T06:30:00.000Z"), "01:30 New York");
  assert.equal(o.ny_am, openAt("2026-11-03T12:30:00.000Z"), "07:30 New York");
  assert.equal(o.week, openAt("2026-11-02T23:00:00.000Z"), "Monday 18:00 New York");
  assert.equal(o.asia, openAt("2026-11-03T00:30:00.000Z"), "19:30 New York, the evening before");
  assert.equal(nyParts(Date.parse("2026-11-03T05:00:00Z")).minutes, 0);
  const d1 = [bar(Date.parse("2026-11-01T22:00:00Z"), 1, 2, 0.5, 1.5, 1, 1440), bar(Date.parse("2026-11-02T22:00:00Z"), 1, 3, 0.2, 1.5, 1, 1440)];
  const b = macroBaselines({ fine: m15, d1 }, Date.parse("2026-11-03T22:00:00Z"), Date.parse("2026-11-03T23:00:00Z"));
  assert.equal(b.prev_day_high, 3);
  assert.equal(b.prev_day_low, 0.2);
});
