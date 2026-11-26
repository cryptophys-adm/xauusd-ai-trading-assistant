// Z1a (docs/RFC_DEMAND_SUPPLY_ZONES.md §4): every active Prophet order block as a demand/supply box in the chart plane,
// through an adapter (adopt/prophet-ob.mjs). The Prophet core is not edited; the HUD sections and the plane's existing
// fields are byte-identical.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { calculateProphetR38Core } from "../../prophet-r38/src/core.mjs";
import { prophetZones, prophetTouches, PROPHET_OB_RULES } from "../src/adopt/prophet-ob.mjs";
import { buildHudSnapshot } from "../src/hud-snapshot.mjs";
import { buildChartPlane } from "../src/chart-plane.mjs";
import { ENGINE_PROVENANCE } from "../src/provenance.generated.mjs";
import { validateHudSnapshot } from "../../../src/hud-store.mjs";
import { HUD_IDS } from "../../../src/hud-reading.mjs";

const MIN = 60_000, HOUR = 3_600_000;
const sha = (v) => createHash("sha256").update(typeof v === "string" || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest("hex");

/** 1000 closed 15m bars: a deterministic random walk up, then down over the last 50 bars, so both sides hold active blocks. */
function walk({ n = 1000, seed = 5, turn = 950, up = 1.0, down = -0.8, end = Date.parse("2026-11-20T13:00:00Z") } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  let p = 4000;
  return Array.from({ length: n }, (_, i) => {
    const open = p, close = open + (i < turn ? up : down) + (rnd() - 0.5) * 6;
    const high = Math.max(open, close) + rnd() * 2.5, low = Math.min(open, close) - rnd() * 2.5;
    const t = end - (n - i) * 15 * MIN;
    p = close;
    return { open_time: new Date(t).toISOString(), close_time: new Date(t + 15 * MIN).toISOString(), open, high, low, close, volume: 100 + Math.floor(rnd() * 80) + (i % 17 === 0 ? 400 : 0), confirmed: true };
  });
}
const core = (bars) => {
  const o = calculateProphetR38Core(bars, { timeframe_minutes: 15, gmi_closed_only: true, mintick: 0.001, higher_timeframes: {} }).outputs.at(-1);
  return { ob: o.order_blocks, atr: o.sensors.atr14 };
};

/** The chart-plane test's bundle: one base path aggregated to every timeframe; D1 and W1 anchored at 22:00 UTC. */
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

test("Z1a-P1 prophetZones equals the core's active_order_block_zones (dir, top, bottom, born, highVolume)", () => {
  const bars = walk();
  const { ob, atr } = core(bars);
  const list = ob.active_order_block_zones;
  assert.ok(list.some((z) => z.dir === 1) && list.some((z) => z.dir === -1), "the fixture holds both sides");
  assert.ok(list.some((z) => z.highVolume) && list.some((z) => !z.highVolume), "and both volume flags");
  const all = prophetZones(ob, bars, { perSide: 1000, atr });
  assert.equal(all.length, list.length, "every active zone");
  const last = bars.length - 1, r3 = (x) => Math.round(x * 1000) / 1000;
  const key = (z) => `${z.dir}:${z.top}:${z.bottom}:${z.born}:${z.high_volume}`;
  const fromCore = list.map((z) => key({ dir: z.dir, top: r3(z.top), bottom: r3(z.bottom), born: z.born, high_volume: z.highVolume })).sort();
  const fromAdapter = all.map((z) => key({ dir: z.side === "demand" ? 1 : -1, top: z.top, bottom: z.bottom, born: last - z.age_bars, high_volume: z.high_volume })).sort();
  assert.deepEqual(fromAdapter, fromCore);
  for (const z of all) {
    assert.deepEqual(Object.keys(z), ["side", "top", "bottom", "age_bars", "high_volume", "touches"]);
    assert.ok(z.top >= z.bottom && Number.isInteger(z.age_bars) && z.age_bars >= 0 && typeof z.high_volume === "boolean" && Number.isInteger(z.touches));
  }
  // The core's own constants are the adapter's (core.mjs orderBlockEngine defaults, unedited).
  const src = readFileSync(new URL("../../prophet-r38/src/core.mjs", import.meta.url), "utf8");
  assert.match(src, /key_level_touch_lookback \?\? 40;/);
  assert.match(src, /ob_retest_band_atr \?\? 0\.15;/);
  assert.match(src, /if \(back - lastTouchBack >= 3\)/);
  assert.deepEqual({ ...PROPHET_OB_RULES }, { per_side: 4, touch_band_atr: 0.15, touch_bars: 40, touch_gap: 3 });
});

test("Z1a-P2 the 4 nearest per side, demand first, nearest first, 3 dp", () => {
  const bars = walk({ seed: 1, turn: 900 });
  const { ob, atr } = core(bars);
  const close = bars.at(-1).close;
  const dist = (z) => (close < z.bottom ? z.bottom - close : close > z.top ? close - z.top : 0);
  const out = prophetZones(ob, bars, { atr });
  const all = prophetZones(ob, bars, { perSide: 1000, atr });
  for (const side of ["demand", "supply"]) {
    const mine = out.filter((z) => z.side === side), every = all.filter((z) => z.side === side);
    assert.ok(mine.length <= 4);
    assert.deepEqual(mine, every.slice(0, 4), side);
    for (let i = 1; i < mine.length; i++) assert.ok(dist(mine[i - 1]) <= dist(mine[i]) + 0.002, `${side} nearest first`);
  }
  assert.ok(all.filter((z) => z.side === "supply").length > 4, "the fixture has more than 4 supply blocks");
  assert.equal(out.filter((z) => z.side === "supply").length, 4);
  const firstSupply = out.findIndex((z) => z.side === "supply");
  assert.ok(out.slice(0, Math.max(firstSupply, 0)).every((z) => z.side === "demand"), "demand first");
  for (const z of out) for (const v of [z.top, z.bottom]) assert.equal(Math.round(v * 1000) / 1000, v);
});

test("Z1a-P3 touches match a hand count with the core's rule (0.15 ATR band, 40 bars, 3-bar gap); the last bar is not counted", () => {
  // 46 bars far above a 3990-3992 box; bars inside it at back 2, 4 (2 bars later: once), 10, 20 and 45 (outside the
  // 40-bar window); one at back 30 within the 0.15 x 10 band; the last bar (back 0) inside does not count.
  const n = 46, at = new Set([2, 4, 10, 20, 45, 0]);
  const bars = Array.from({ length: n }, (_, i) => {
    const back = n - 1 - i;
    if (at.has(back)) return { high: 3991.5, low: 3990.5, close: 3991 };
    if (back === 30) return { high: 3995, low: 3993.4, close: 3994 };
    return { high: 4011, low: 4009, close: 4010 };
  });
  // Hand count: 2 (counted), 4 (2 after: skipped), 10, 20, 30 (band) = 4.
  assert.equal(prophetTouches(3990, 3992, bars, 10), 4);
  assert.equal(prophetTouches(3990, 3992, bars, null), 3, "no ATR: a zero band, as the core's touchBand");
  const ob = { active_order_block_zones: [{ dir: 1, top: 3992, bottom: 3990, mid: 3991, born: 40, highVolume: true }, { dir: -1, top: 4030, bottom: 4028, mid: 4029, born: 44, highVolume: false }] };
  const out = prophetZones(ob, bars, { atr: 10 });
  assert.deepEqual(out, [
    { side: "demand", top: 3992, bottom: 3990, age_bars: 5, high_volume: true, touches: 4 },
    { side: "supply", top: 4030, bottom: 4028, age_bars: 1, high_volume: false, touches: 0 }
  ]);
});

test("Z1a-P4 no list gives null; a malformed zone is skipped, never invented", () => {
  const bars = [{ high: 2, low: 1, close: 1.5 }];
  assert.equal(prophetZones({}, bars), null);
  assert.equal(prophetZones(null, bars), null);
  assert.equal(prophetZones({ active_order_block_zones: [] }, []), null, "no bars");
  assert.deepEqual(prophetZones({ active_order_block_zones: [] }, bars), []);
  assert.deepEqual(prophetZones({ active_order_block_zones: [{ dir: 1, top: null, bottom: 1, born: 0 }, { dir: 1, top: 1, bottom: 2, born: 0 }, { dir: 0, top: 2, bottom: 1, born: 0 }] }, bars), []);
});

test("Z1a-P5 the snapshot: chart_plane.zones.prophet; HUD sections and the plane's other fields byte-identical (pins taken on dc01868, before Z1a); <= 48 KiB; CPU within +15%", () => {
  const end = Date.parse("2026-11-04T15:00:00Z");
  const bundle = bundleFrom({ endMs: end, baseMin: 1, days: 16 });
  const PINS = {
    H1: { huds: "6e4197dc2300378ef89505fc8c488a4496217d065cd889d306c428c7038949dd", plane: "22e179cafd2841132e2c7a471e3dbedbc086a04aae878a258cef325f9b8442b0" },
    M15: { huds: "a35623cb3e2ec3997d1ac7f8a6a081657f4f6454f50a1b89e00922502767ec77", plane: "68cd7c0db74cda501219d0fe2ff8ccb77cf1479b3ccbb6a9f70c30512cf086c0" }
  };
  for (const chart of ["H1", "M15"]) {
    const t0 = performance.now();
    const snap = buildHudSnapshot(bundle, { chart, now: end + MIN });
    const snapMs = performance.now() - t0;
    const { zones, ...plane } = snap.chart_plane;
    assert.equal(sha(snap.huds), PINS[chart].huds, `${chart} HUD sections`);
    assert.equal(sha(plane), PINS[chart].plane, `${chart} the plane's existing fields`);
    assert.deepEqual(Object.keys(snap.huds).sort(), [...HUD_IDS].sort(), "no new HUD section, so no new room agent");
    assert.ok("bull_top" in snap.huds.order_blocks.fields && "bear_top" in snap.huds.order_blocks.fields, "the best-block fields stay");
    // The plane is buildChartPlane's, the zones prophetZones' on the core's own output.
    const chartBars = bundle.timeframes[chart].candles.slice(-1000);
    assert.deepEqual(plane, buildChartPlane(bundle, { chart, chartBars, mintick: 0.001 }));
    const t1 = performance.now();
    const o = calculateProphetR38Core(chartBars.map((b) => ({ ...b, confirmed: true })), {
      timeframe_minutes: chart === "H1" ? 60 : 15, gmi_closed_only: true, mintick: 0.001,
      higher_timeframes: { M15: bundle.timeframes.M15.candles, H1: bundle.timeframes.H1.candles, H4: bundle.timeframes.H4.candles, D1: bundle.timeframes.D1.candles, W1: bundle.timeframes.W1.candles }
    }).outputs.at(-1);
    const coreMs = performance.now() - t1;
    const t2 = performance.now();
    const again = prophetZones(o.order_blocks, chartBars, { perSide: 4, atr: o.sensors.atr14 });
    const adoptMs = performance.now() - t2;
    // Z1b adds zones.aegis beside it (local-engines/producer/test/gmi-zone.test.mjs); prophet is unchanged.
    const { aegis: _aegis, ...z1a } = zones;
    assert.deepEqual(z1a, { prophet: again });
    assert.equal(again.length, o.order_blocks.active_order_block_zones.length, "the fixture holds at most 4 a side");
    // The adapter's cost against the whole snapshot: far inside +15% (the core is already run once by the snapshot).
    assert.ok(adoptMs <= 0.15 * snapMs, `adapter ${adoptMs.toFixed(2)} ms vs snapshot ${snapMs.toFixed(0)} ms (core ${coreMs.toFixed(0)} ms)`);
    assert.ok(JSON.stringify(snap).length <= 48 * 1024, `${chart} snapshot <= 48 KiB`);
    assert.deepEqual(validateHudSnapshot(snap, end + MIN), { valid: true, errors: [] });
  }
  // The M15 fixture holds two supply blocks.
  const m15 = buildHudSnapshot(bundle, { chart: "M15", now: end + MIN }).chart_plane.zones.prophet;
  assert.deepEqual(m15.map((z) => z.side), ["supply", "supply"]);
});

test("Z1a-P6 the worst case, 8 boxes, stays small: about 0.8 KB a chart, so 4 charts add about 3 KB in all", () => {
  const bars = walk({ seed: 1, turn: 900 });
  const { ob, atr } = core(bars);
  const boxes = prophetZones(ob, bars, { atr });
  const filled = [...boxes, ...boxes.map((z) => ({ ...z, side: "demand" }))].slice(0, 8);
  assert.ok(JSON.stringify({ prophet: filled }).length <= 900, String(JSON.stringify({ prophet: filled }).length));
});

/** B11 (orchestrator 2026-11-26, Q3): only the adoption records' identities may list adopt/ files. */
const ADOPT_IDENTITIES = new Set(["gmi_adopt", "prophet_adopt"]);
test("Z1a-P7 the Prophet core and the hashed engines are unedited: every provenance file hashes to its record; hud-snapshot.mjs is in none, adopt/ only in the adopt identities (B11)", () => {
  const paths = new Set();
  for (const [id, engine] of Object.entries(ENGINE_PROVENANCE)) {
    for (const f of [...(engine.files?.sources || []), ...(engine.files?.implementation || [])]) {
      if (!ADOPT_IDENTITIES.has(id)) paths.add(f.path);
      assert.doesNotMatch(f.path, /hud-snapshot\.mjs/, `${id}: ${f.path}`);
      assert.equal(sha(readFileSync(new URL(`../../../${f.path}`, import.meta.url))), f.sha256, f.path);
    }
  }
  for (const p of ["local-engines/prophet-r38/src/core.mjs", "local-engines/gmi/src/gmi-core.mjs", "local-engines/gmi/src/gmi-core-tf.mjs", "local-engines/gmi/src/gmi-core-htf.mjs", "local-engines/gmi/src/mizan.mjs"]) assert.ok(paths.has(p), p);
  for (const p of paths) assert.doesNotMatch(p, /hud-snapshot\.mjs|\/adopt\//, p);
});
