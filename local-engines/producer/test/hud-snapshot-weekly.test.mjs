// ZF2 (owner 2026-11-26: "ZF2 snapshot Weekly"): the weekly (W1) HUD snapshot, for the AI Worker's zone typing only.
// The bundle carries 260 closed weekly bars (market-data-ingestion SERIES retain 260; production KV 2026-11-26: 260),
// fewer than GMI's 320, so the weekly snapshot has no GMI: the Prophet R38 / R37 HUDs, the Mizan rows, the whale map and
// the Prophet zones only. The four other charts are pinned byte for byte to their snapshots before ZF2.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildHudSnapshot, GMI_NOT_ON_WEEKLY } from "../src/hud-snapshot.mjs";
import { buildChartPlane, buildWeeklyPlane, CHART_PLANE_WEEKLY_VERSION, WEEKLY_PLANE_MIN_BARS } from "../src/chart-plane.mjs";
import { validateHudSnapshot } from "../../../src/hud-store.mjs";
import { weeklyBars, WEEK, WEEKLY_END } from "../../../test/support/hud-weekly-fixture.mjs";

/** One base path aggregated to every timeframe; H4, D1 and W1 anchored at 22:00 UTC as OANDA's (hud-snapshot-htf.test.mjs). */
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
const sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

test("ZF2-P1 a W1 snapshot from 260 weekly bars: timeframe 1W, no GMI, the weekly plane with whales and Prophet zones, valid for the store", () => {
  const now = WEEKLY_END + 60_000;
  const snap = buildHudSnapshot({ timeframes: { W1: { candles: weeklyBars() } } }, { chart: "W1", now });
  assert.equal(snap.timeframe, "1W");
  assert.equal(snap.candle_key, "OANDA:XAUUSD:1W:" + (WEEKLY_END - WEEK));
  assert.equal(snap.gmi_error, GMI_NOT_ON_WEEKLY);
  for (const id of ["kinetic_engine", "fabio_amt", "tactical_muscles", "gabfx_price_action", "playbook_execution", "decision_matrix", "grid_bot_protocol"]) {
    assert.equal(id in snap.huds, false, id);
    assert.ok(snap.not_computed.includes(id), id);
  }
  for (const id of ["prophet", "r37_funnel", "order_blocks", "interstellar_eyes", "chronos_matrix", "supertrend", "macro_aether"]) assert.ok(snap.huds[id], id);
  assert.ok(snap.huds.interstellar_eyes.fields.camarilla["1W"], "the chart's own Camarilla is the previous week's");
  assert.ok(!("W" in snap.huds.interstellar_eyes.fields.camarilla), "no duplicate weekly entry on the weekly chart");
  const plane = snap.chart_plane;
  assert.equal(plane.version, CHART_PLANE_WEEKLY_VERSION);
  assert.deepEqual(Object.keys(plane).sort(), ["atr", "close", "liquidity", "version", "zones"]);
  assert.deepEqual(Object.keys(plane.liquidity), ["whale_zones"], "no GMI drawing but the whale map");
  assert.ok(Array.isArray(plane.liquidity.whale_zones) && plane.liquidity.whale_zones.length > 0);
  assert.ok(Array.isArray(plane.zones.prophet) && plane.zones.prophet.length > 0, "the Prophet zones of the weekly chart");
  assert.equal("aegis" in plane.zones, false, "GMI did not run: no Aegis boxes");
  assert.deepEqual(validateHudSnapshot(snap, now), { valid: true, errors: [] });
  assert.ok(JSON.stringify(snap).length < 48 * 1024);
});

test("ZF2-P2 W1 refuses short history and a still-forming bar, never guessing", () => {
  const short = weeklyBars(199);
  assert.throws(() => buildHudSnapshot({ timeframes: { W1: { candles: short } } }, { chart: "W1", now: WEEKLY_END + 60_000 }), (e) => e.code === "insufficient_hud_history");
  assert.throws(() => buildHudSnapshot({ timeframes: { W1: { candles: weeklyBars() } } }, { chart: "W1", now: WEEKLY_END - 60_000 }), (e) => e.code === "hud_bar_not_closed");
  assert.equal(buildHudSnapshot({ timeframes: { W1: { candles: weeklyBars(200) } } }, { chart: "W1", now: WEEKLY_END + 60_000 }).timeframe, "1W", "200 bars suffice");
});

test("ZF2-P3 the weekly plane's whale map is buildChartPlane's own (same function, same inputs); null below its minimum", () => {
  const end = Date.parse("2026-11-04T02:00:00Z");
  const b = bundleFrom({ endMs: end, baseMin: 60, days: 30 });
  const chartBars = b.timeframes.H1.candles;
  assert.ok(chartBars.length >= 320);
  const full = buildChartPlane(b, { chart: "H1", chartBars });
  const weekly = buildWeeklyPlane({ chartBars });
  assert.deepEqual(weekly.liquidity.whale_zones, full.liquidity.whale_zones);
  assert.equal(weekly.atr, full.atr);
  assert.equal(weekly.close, full.close);
  assert.equal(buildWeeklyPlane({ chartBars: chartBars.slice(-(WEEKLY_PLANE_MIN_BARS - 1)) }), null);
  assert.equal(buildWeeklyPlane({}), null);
});

test("ZF2-P4 the four other charts are byte for byte their snapshots before ZF2 (pinned at main f5f3141)", () => {
  const end = Date.parse("2026-11-04T02:00:00Z");
  const b5 = bundleFrom({ endMs: end, baseMin: 5, days: 60 });
  const pins = {
    H1: "69d5e8da565e5ad22ef20eabd02fe89ace2e56d4a946604cb5ed203735c87c40",
    M15: "7abfc2e1c3de440a93bd44c695db32164fdced07c751ad9016053f0f88bbf244",
    H4: "970e11499905b6b6631a03f83af865e7557f3ce7bc37c41981553dcc95775d72"
  };
  for (const [chart, pin] of Object.entries(pins)) assert.equal(sha(buildHudSnapshot(b5, { chart, now: end + 60_000 })), pin, chart);
  const endD = Date.parse("2026-11-03T22:00:00Z");
  const b15 = bundleFrom({ endMs: endD, baseMin: 15, days: 340 });
  assert.equal(sha(buildHudSnapshot(b15, { chart: "D1", now: endD + 60_000 })), "ddc450c1a3e00101fc774a5dd53b61c88664ce4af2bc52fc1790da62b91b4422", "D1");
});
