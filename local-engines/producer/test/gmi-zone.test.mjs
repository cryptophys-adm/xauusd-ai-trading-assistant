// Z1b (docs/RFC_DEMAND_SUPPLY_ZONES.md §4b): GMI's Aegis validated order blocks as demand/supply boxes in the chart
// plane, through a duplicate of the core's loop (adopt/gmi-zone.mjs). The GMI core and mizan.mjs are not edited; the
// HUD sections, hud-reading and the rest of the snapshot are byte-identical to Z1a's.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { computeGmi, computeGmiOnChart as coreOnChart, GMI_DEFAULTS } from "../../gmi/src/gmi-core.mjs";
import { computeGmiOnChart, GMI_DEFAULTS as TF_DEFAULTS } from "../../gmi/src/gmi-core-tf.mjs";
import { computeGmiOnHtfChart, GMI_DEFAULTS as HTF_DEFAULTS } from "../../gmi/src/gmi-core-htf.mjs";
import { aegisBoxes, GMI_ZONE_RULES, GMI_ZONE_ADOPT_VERSION } from "../src/adopt/gmi-zone.mjs";
import { buildHudSnapshot } from "../src/hud-snapshot.mjs";
import { ENGINE_PROVENANCE } from "../src/provenance.generated.mjs";
import { validateHudSnapshot, hudReadings } from "../../../src/hud-store.mjs";
import { HUD_IDS } from "../../../src/hud-reading.mjs";

const MIN = 60_000, HOUR = 3_600_000;
const sha = (v) => createHash("sha256").update(typeof v === "string" || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest("hex");

/** The GMI fixture (local-engines/gmi/test/gmi.test.mjs syntheticBundle): 1000 H1 bars and their MTF series. */
function gmiFixture() {
  const H = 3600;
  const end = Date.parse("2026-11-03T09:00:00Z") / 1000;
  const bar = (t, i, sec) => {
    const o = 3900 + Math.sin(i / 11) * 20 + i * 0.03;
    const c = o + Math.sin(i / 3) * 4;
    return { time: t, open_time: new Date(t * 1000).toISOString(), close_time: new Date((t + sec) * 1000).toISOString(), open: o, high: Math.max(o, c) + 2, low: Math.min(o, c) - 2, close: c, volume: 1000 + (i % 13) * 90 };
  };
  const series = (count, sec, lastOpen) => Array.from({ length: count }, (_, i) => bar(lastOpen - (count - 1 - i) * sec, i, sec));
  return {
    timeframes: {
      H1: { candles: series(1000, H, end) }, M15: { candles: series(2000, 900, end + 2700) }, H4: { candles: series(500, 4 * H, end - 4 * H) },
      D1: { candles: series(500, 86400, end - 86400 - 3600 * 11) }, W1: { candles: series(260, 604800, end - 604800) }
    }
  };
}

/** The HUD snapshot tests' bundle: one base path aggregated to every timeframe; H4, D1 and W1 anchored at 22:00 UTC. */
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

/** 1000 closed 15m bars, Z1a's random walk (prophet-ob.test.mjs): up, then down over the last 100, 9 supply blocks. */
function walk({ n = 1000, seed = 1, turn = 900 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  let p = 4000;
  const end = Date.parse("2026-11-20T13:00:00Z");
  return Array.from({ length: n }, (_, i) => {
    const open = p, close = open + (i < turn ? 1.0 : -0.8) + (rnd() - 0.5) * 6;
    const high = Math.max(open, close) + rnd() * 2.5, low = Math.min(open, close) - rnd() * 2.5;
    const t = end - (n - i) * 15 * MIN;
    p = close;
    return { time: t / 1000, open_time: new Date(t).toISOString(), close_time: new Date(t + 15 * MIN).toISOString(), open, high, low, close, volume: 100 + Math.floor(rnd() * 80) + (i % 17 === 0 ? 400 : 0) };
  });
}

/**
 * The core's own flags at bar k - 1: computeGmi (the H1 lane) on the first k bars. The core evaluates only its last
 * bar, so every bar is its own run on the growing prefix. Below 320 bars the core refuses the history (n < vp_lookback
 * + 20); those prefixes lower only vp_lookback, the TDM volume profile's depth, which the Aegis loop never reads.
 */
const coreFlagsAt = (bundle, chart, k) => {
  const candles = bundle.timeframes[chart].candles.slice(0, k);
  const run = chart === "H4" || chart === "D1" ? computeGmiOnHtfChart : computeGmiOnChart;
  const options = k < GMI_DEFAULTS.vp_lookback + 20 ? { vp_lookback: 1 - 20 } : {};
  const z = run({ timeframes: { ...bundle.timeframes, [chart]: { candles } } }, { chart, mintick: 0.001, options }).diagnostics.zones;
  return [z.in_ob_bull, z.in_ob_bear];
};

test("Z1b-G1 the duplicate's in_ob_bull / in_ob_bear equal the GMI core's on every bar of the GMI fixture (1000 H1 bars, one core run per bar)", () => {
  const bundle = gmiFixture();
  const bars = bundle.timeframes.H1.candles;
  const dup = aegisBoxes(bars, { mintick: 0.001 });
  assert.equal(dup.in_ob_bull.length, 1000);
  assert.equal(dup.in_ob_bear.length, 1000);
  const mismatches = [];
  for (let k = 1; k <= bars.length; k++) {
    const [bull, bear] = coreFlagsAt(bundle, "H1", k);
    if (bull !== dup.in_ob_bull[k - 1] || bear !== dup.in_ob_bear[k - 1]) mismatches.push(k - 1);
  }
  assert.deepEqual(mismatches, [], "bars where the duplicate and the core differ");
  assert.ok(dup.in_ob_bull.filter(Boolean).length >= 20 && dup.in_ob_bear.filter(Boolean).length >= 20, "the fixture holds both flags on many bars");
  // The last bar is the core's own output as the H1 lane runs it (the default cfg, the 1000-bar window).
  const last = computeGmi(bundle).diagnostics.zones;
  assert.deepEqual([last.in_ob_bull, last.in_ob_bear], [dup.in_ob_bull.at(-1), dup.in_ob_bear.at(-1)]);
});

test("Z1b-G2 one core on every chart: the tf and htf modules re-export gmi-core's function and GMI_DEFAULTS; the duplicate equals it on the 15m and 4H charts too", () => {
  assert.equal(computeGmiOnChart, coreOnChart, "gmi-core-tf.mjs (5m, 15m, 1H) is gmi-core.mjs's computeGmiOnChart");
  assert.equal(computeGmiOnHtfChart, coreOnChart, "gmi-core-htf.mjs (4H, 1D) is the same function");
  assert.equal(TF_DEFAULTS, GMI_DEFAULTS);
  assert.equal(HTF_DEFAULTS, GMI_DEFAULTS);
  // The Aegis constants (gmi-core.mjs:35-36), unchanged.
  const { ob_pivot_len, max_nodes_ob, ob_max_age, max_ob_per_direction, ob_close_only, mitig_buffer, max_wick_atr } = GMI_DEFAULTS;
  assert.deepEqual({ ob_pivot_len, max_nodes_ob, ob_max_age, max_ob_per_direction, ob_close_only, mitig_buffer, max_wick_atr },
    { ob_pivot_len: 5, max_nodes_ob: 60, ob_max_age: 120, max_ob_per_direction: 30, ob_close_only: false, mitig_buffer: 0.25, max_wick_atr: 3.0 });
  assert.equal(Object.isFrozen(GMI_DEFAULTS), true);
  // The loop text the duplicate copies is the core's (it fails on drift, with G1).
  const core = readFileSync(new URL("../../gmi/src/gmi-core.mjs", import.meta.url), "utf8");
  const dupSrc = readFileSync(new URL("../src/adopt/gmi-zone.mjs", import.meta.url), "utf8");
  const loop = (src) => src.slice(src.indexOf("const P = cfg.ob_pivot_len;"), src.indexOf("if (!node.top?.active && !node.bot?.active) nodes.splice(k, 1);"))
    .replace(/, touches: 0 \}/g, " }").replace(/ z\.touches\+\+; \}/g, " }").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
  assert.ok(loop(core).length > 40);
  assert.deepEqual(loop(dupSrc), loop(core), "the duplicate is the core's loop plus the touches counter");
  // The 15m and 4H charts, the last 40 bars each (one core run per bar).
  const m15 = bundleFrom({ endMs: Date.parse("2026-11-04T15:00:00Z"), baseMin: 1, days: 16 });
  const h4 = bundleFrom({ endMs: Date.parse("2026-11-04T02:00:00Z"), baseMin: 5, days: 60 });
  for (const [bundle, chart] of [[m15, "M15"], [h4, "H4"]]) {
    const bars = bundle.timeframes[chart].candles.slice(-1000);
    const local = { timeframes: { ...bundle.timeframes, [chart]: { candles: bars } } };
    const dup = aegisBoxes(bars, { mintick: 0.001 });
    for (let k = bars.length - 39; k <= bars.length; k++) {
      assert.deepEqual(coreFlagsAt(local, chart, k), [dup.in_ob_bull[k - 1], dup.in_ob_bear[k - 1]], `${chart} bar ${k - 1}`);
    }
  }
});

test("Z1b-G3 the boxes: the 4 nearest per side, demand first, nearest first, 3 dp, the shape; perSide widens it", () => {
  const bars = walk();
  const all = aegisBoxes(bars, { perSide: 1000 }).boxes;
  const out = aegisBoxes(bars).boxes;
  assert.equal(GMI_ZONE_RULES.per_side, 4);
  assert.equal(GMI_ZONE_ADOPT_VERSION, "cryptophys.adopt.gmi-zone.v1");
  assert.ok(all.filter((z) => z.side === "supply").length > 4, "the fixture has more than 4 supply blocks");
  const close = bars.at(-1).close;
  const dist = (z) => (close < z.bottom ? z.bottom - close : close > z.top ? close - z.top : 0);
  for (const side of ["demand", "supply"]) {
    const mine = out.filter((z) => z.side === side), every = all.filter((z) => z.side === side);
    assert.deepEqual(mine, every.slice(0, 4), side);
    for (let i = 1; i < mine.length; i++) assert.ok(dist(mine[i - 1]) <= dist(mine[i]) + 0.002, `${side} nearest first`);
  }
  assert.equal(out.filter((z) => z.side === "supply").length, 4);
  const firstSupply = out.findIndex((z) => z.side === "supply");
  assert.ok(out.slice(0, Math.max(firstSupply, 0)).every((z) => z.side === "demand"), "demand first");
  for (const z of all) {
    assert.deepEqual(Object.keys(z), ["side", "top", "bottom", "age_bars", "touches"]);
    assert.ok(z.top >= z.bottom && Number.isInteger(z.age_bars) && z.age_bars >= 0 && z.age_bars <= GMI_DEFAULTS.ob_max_age && Number.isInteger(z.touches) && z.touches >= 0);
    for (const v of [z.top, z.bottom]) assert.equal(Math.round(v * 1000) / 1000, v);
  }
  assert.deepEqual(aegisBoxes(bars, { perSide: 0 }).boxes, []);
});

/**
 * 46 flat bars (high 4011, low 4009, close 4010, volume 100) with one volume pivot: bar 20 (volume 500) wicks to 4000,
 * so at bar 25 (its activation) the core opens a bullish block [4000, 4005.5] (top = the bar's mid). `touch` gives
 * the lows of the bars that wick into it.
 */
function oneBlock(touch = {}, { flip = false } = {}) {
  const bars = Array.from({ length: 46 }, (_, i) => {
    const low = i === 20 ? 4000 : touch[i] ?? 4009;
    const b = { high: 4011, low, close: touch[`c${i}`] ?? 4010, volume: i === 20 ? 500 : 100 };
    b.open = b.close;
    return b;
  });
  // flip mirrors every price about 4010 (a bearish block above price).
  return flip ? bars.map((b) => ({ open: 8020 - b.open, high: 8020 - b.low, low: 8020 - b.high, close: 8020 - b.close, volume: b.volume })) : bars;
}

test("Z1b-G4 touches are obProgressiveUpdate's own touched events that left the block valid: hand counts on a one-block fixture (demand and supply)", () => {
  // No touch after activation: the source bar itself (bar 20) and the bars before activation never count.
  assert.deepEqual(aegisBoxes(oneBlock()).boxes, [{ side: "demand", top: 4005.5, bottom: 4000, age_bars: 20, touches: 0 }]);
  // Wicks into it at bars 30 and 31 (consecutive: one each) and 36; each trims the top to the wick's low.
  const touched = aegisBoxes(oneBlock({ 30: 4004, 31: 4003.5, 36: 4003 }));
  assert.deepEqual(touched.boxes, [{ side: "demand", top: 4003, bottom: 4000, age_bars: 20, touches: 3 }]);
  assert.deepEqual(touched.in_ob_bull.flatMap((v, i) => (v ? [i] : [])), [30, 31, 36], "in_ob_bull on exactly the touched bars");
  assert.equal(touched.in_ob_bear.some(Boolean), false);
  // A wick through the bottom invalidates it: no box, and no flag on that bar.
  const broken = aegisBoxes(oneBlock({ 30: 4004, 40: 3999.5 }));
  assert.deepEqual(broken.boxes, []);
  assert.deepEqual(broken.in_ob_bull.flatMap((v, i) => (v ? [i] : [])), [30]);
  // The mirror: a bearish block above price is supply, with the same count.
  const supply = aegisBoxes(oneBlock({ 30: 4004, 31: 4003.5, 36: 4003 }, { flip: true }));
  assert.deepEqual(supply.boxes, [{ side: "supply", top: 4020, bottom: 4017, age_bars: 20, touches: 3 }]);
  assert.deepEqual(supply.in_ob_bear.flatMap((v, i) => (v ? [i] : [])), [30, 31, 36]);
});

test("Z1b-G5 no price is invented: no bars or no last close gives null; bars without volume give no box", () => {
  assert.equal(aegisBoxes([]), null);
  assert.equal(aegisBoxes(null), null);
  assert.equal(aegisBoxes([{ high: 2, low: 1, close: null }]), null);
  const noVolume = oneBlock().map(({ volume, ...b }) => b);
  assert.deepEqual(aegisBoxes(noVolume).boxes, [], "no volume pivot, no block");
  assert.deepEqual(aegisBoxes([{ high: 2, low: 1, close: 1.5, volume: 1 }]), { boxes: [], in_ob_bull: [false], in_ob_bear: [false] });
});

// The snapshots before Z1b, on b779c07 (main, Z1a): the whole snapshot (with `computed_at` from `now`) and the HUD
// sections. With chart_plane.zones.aegis stripped, Z1b's snapshot is that one byte for byte.
const SNAP_CASES = [
  { chart: "H1", end: "2026-11-04T15:00:00Z", baseMin: 1, days: 16, snap: "fef84b8470d1e6480eaeb8ac334248a58ce1082a7e516596b46f8f1686e400f8", huds: "6e4197dc2300378ef89505fc8c488a4496217d065cd889d306c428c7038949dd" },
  { chart: "M15", end: "2026-11-04T15:00:00Z", baseMin: 1, days: 16, snap: "eae83fec6d12f45e9d7da5223d6baf7d451b8027dff03f11ea0b5166edf6376a", huds: "a35623cb3e2ec3997d1ac7f8a6a081657f4f6454f50a1b89e00922502767ec77" },
  { chart: "H4", end: "2026-11-04T02:00:00Z", baseMin: 5, days: 60, snap: "7b07539a944c9b729fdeee57212cc2d2bd9b203cefc749cc753f9ea9bd012b40", huds: "00515dbbfc3fa4db9a6317a864c054b7be06f020dda15eff9e49ae43726fdbf0" }
];
const stripAegis = (snap) => {
  const c = structuredClone(snap);
  if (c.chart_plane?.zones) { delete c.chart_plane.zones.aegis; if (!Object.keys(c.chart_plane.zones).length) delete c.chart_plane.zones; }
  return c;
};

test("Z1b-G6 the snapshot: chart_plane.zones.aegis on every chart GMI runs on; stripped, the snapshot, the HUD sections and hud-reading are Z1a's byte for byte; <= 48 KiB; the duplicate's CPU within +15%", async () => {
  for (const c of SNAP_CASES) {
    const end = Date.parse(c.end);
    const bundle = bundleFrom({ endMs: end, baseMin: c.baseMin, days: c.days });
    const t0 = performance.now();
    const snap = buildHudSnapshot(bundle, { chart: c.chart, now: end + MIN });
    const snapMs = performance.now() - t0;
    assert.equal(snap.gmi_error, null, `${c.chart}: GMI ran`);
    const before = stripAegis(snap);
    assert.equal(sha(before), c.snap, `${c.chart}: the snapshot without aegis is Z1a's`);
    assert.equal(sha(snap.huds), c.huds, `${c.chart}: HUD sections`);
    assert.deepEqual(Object.keys(snap.huds).sort(), [...HUD_IDS].sort(), "no new HUD section, so no new room agent");
    assert.deepEqual(await hudReadings({}, snap), await hudReadings({}, before), `${c.chart}: hud-reading`);
    // The boxes are the duplicate's on the bars and mintick GMI ran on (the chart's last 1000 bars).
    const chartBars = bundle.timeframes[c.chart].candles.slice(-1000);
    const t1 = performance.now();
    const again = aegisBoxes(chartBars, { mintick: 0.001, perSide: 4 });
    const adoptMs = performance.now() - t1;
    assert.deepEqual(snap.chart_plane.zones.aegis, again.boxes, `${c.chart}: zones.aegis`);
    assert.ok(snap.chart_plane.zones.aegis.length > 0 || c.chart === "H1", `${c.chart}: the fixture holds blocks`);
    assert.deepEqual(Object.keys(snap.chart_plane.zones), ["prophet", "aegis"]);
    assert.ok(JSON.stringify(snap).length <= 48 * 1024, `${c.chart} snapshot <= 48 KiB`);
    assert.deepEqual(validateHudSnapshot(snap, end + MIN), { valid: true, errors: [] });
    // Z1b's added work is the duplicate alone: against the whole snapshot, far inside +15%.
    assert.ok(adoptMs <= 0.15 * snapMs, `${c.chart}: duplicate ${adoptMs.toFixed(2)} ms vs snapshot ${snapMs.toFixed(0)} ms`);
  }
});

test("Z1b-G7 a chart where GMI did not run has no aegis, and prophet is as it was", () => {
  const end = Date.parse("2026-11-04T15:00:00Z");
  const bundle = bundleFrom({ endMs: end, baseMin: 1, days: 16 });
  const normal = buildHudSnapshot(bundle, { chart: "M15", now: end + MIN });
  // GMI alone reads a series one bar short (its stack names gmi-core.mjs), so its bar does not match the chart's.
  const full = bundle.timeframes.M15.candles;
  const timeframes = { ...bundle.timeframes };
  Object.defineProperty(timeframes, "M15", { enumerable: true, get: () => ({ candles: /gmi-core\.mjs/.test(new Error().stack) ? full.slice(0, -1) : full }) });
  const snap = buildHudSnapshot({ timeframes }, { chart: "M15", now: end + MIN });
  assert.equal(snap.gmi_error, "gmi_bar_mismatch");
  assert.deepEqual(Object.keys(snap.chart_plane.zones), ["prophet"]);
  assert.deepEqual(snap.chart_plane.zones.prophet, normal.chart_plane.zones.prophet);
});

test("Z1b-G8 provenance: gmi-core*.mjs, mizan.mjs and pine.mjs hash to their records; hud-snapshot.mjs is in none, adopt/ only in the adopt identities (B11)", () => {
  const records = new Map();
  const adoptIdentities = new Set(["gmi_adopt", "prophet_adopt"]);
  for (const [id, engine] of Object.entries(ENGINE_PROVENANCE)) {
    for (const f of [...(engine.files?.sources || []), ...(engine.files?.implementation || [])]) {
      assert.equal(sha(readFileSync(new URL(`../../../${f.path}`, import.meta.url))), f.sha256, f.path);
      assert.doesNotMatch(f.path, /hud-snapshot\.mjs/, `${id}: ${f.path}`);
      if (!adoptIdentities.has(id)) records.set(f.path, f.sha256);
    }
  }
  for (const p of ["local-engines/gmi/src/gmi-core.mjs", "local-engines/gmi/src/gmi-core-tf.mjs", "local-engines/gmi/src/gmi-core-htf.mjs", "local-engines/gmi/src/mizan.mjs", "local-engines/gmi/src/pine.mjs"]) {
    assert.ok(records.has(p), p);
    assert.equal(sha(readFileSync(new URL(`../../../${p}`, import.meta.url))), records.get(p), p);
  }
  for (const p of records.keys()) assert.doesNotMatch(p, /hud-snapshot\.mjs|\/adopt\//, p);
});
