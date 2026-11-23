// Track A PR 4: the pattern calibration v2. The same pooled block and factors as v1 (checked against the v1 module,
// copied verbatim from main into test/support/pattern-calibration-v1.mjs), plus by_tf (bars to target per chart,
// each pattern's split, its raw rate and its rate shrunk toward the chart's rate) and open (the breakouts still
// pending, as on the bar first detected broken out, with the bars to the run). horizonFor reads them;
// PATTERN_HORIZON_MODE "off" strips them on read.
import test from "node:test";
import assert from "node:assert/strict";
import { replayOccurrences, calibrationFrom, calibratePatterns, horizonFor, barsSummary, patternHorizonMode, readPatternCalibration, runPatternCalibration, PATTERN_CALIBRATION_KEY, PATTERN_CALIBRATION_VERSION, HORIZON_DEFAULT_BARS, CALIBRATION } from "../src/pattern-calibration.mjs";
import * as v1 from "./support/pattern-calibration-v1.mjs";
import { detectPatterns } from "../src/chart-patterns.mjs";

const M = 15 * 60_000;
function wave(n, { step = M, start = Date.parse("2026-10-01T00:00:00Z"), base = 3900, seed: s0 = 7 } = {}) {
  let p = base, seed = s0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p += Math.sin(i / 9) * 3 + Math.sin(i / 37) * 2 + (rnd() - 0.5) * 5;
    return { open_time: new Date(start + i * step).toISOString(), close_time: new Date(start + (i + 1) * step).toISOString(), open: o, high: Math.max(o, p) + rnd() * 2, low: Math.min(o, p) - rnd() * 2, close: p };
  });
}
const r3 = (x) => Math.round(x * 1000) / 1000;

test("PC1 by_tf on a hand fixture: bars to target from targets only, the split, the raw rate and the rate shrunk toward the chart's rate", () => {
  const rows = (tf, id, outcome, bars) => bars.map((b) => ({ tf, id, outcome, bars: b }));
  const occ = [
    ...rows("15", "double_top", "target", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
    ...rows("15", "double_top", "failed", [3, 3, 3, 3, 3, 3, 3, 3]),
    ...rows("15", "double_top", "expired", [30, 30]),
    ...rows("15", "flag", "target", [10, 20, 30, 40, 50]),
    ...rows("60", "flag", "failed", [4]),
    { tf: "15", id: "flag", outcome: "pending", bars: 2 }
  ];
  const c = calibrationFrom(occ);
  const chart = c.by_tf["15"];
  assert.deepEqual([chart.resolved, chart.rate], [30, r3(20 / 30)]);
  // 20 target bar counts: 1..15 and 10,20,30,40,50; nearest rank.
  assert.deepEqual(chart.bars_to_target, { n: 20, median: 10, p90: 30 });
  const dt = chart.patterns.double_top;
  assert.deepEqual([dt.n, dt.target, dt.failed, dt.expired, dt.rate, dt.active], [25, 15, 8, 2, 0.6, true], "rate is raw, as in the pooled block");
  assert.equal("raw_rate" in dt, false);
  assert.equal(dt.shrunk_rate, r3((15 + 10 * (20 / 30)) / (25 + 10)), "shrunk toward the chart's rate, prior 10");
  assert.equal(c.patterns.double_top.rate, dt.rate, "the pooled and the per-chart rate mean the same");
  assert.deepEqual(dt.bars_to_target, { n: 15, median: 8, p90: 14 });
  const fl = chart.patterns.flag;
  assert.deepEqual([fl.n, fl.target, fl.active, fl.bars_to_target], [5, 5, false, { n: 5, median: 30, p90: 50 }], "the pending flag is not counted");
  assert.deepEqual(Object.keys(chart.patterns), ["double_top", "flag"], "most breakouts first");
  assert.deepEqual(c.by_tf["60"], { resolved: 1, rate: 0, bars_to_target: null, patterns: { flag: { n: 1, target: 0, failed: 1, expired: 0, rate: 0, shrunk_rate: 0, active: false, bars_to_target: null } } });
  assert.equal("240" in c.by_tf, false, "a chart with no resolved breakout has no record");
  assert.deepEqual([barsSummary([]), barsSummary([7]), barsSummary([4, 1, 3, 2])], [null, { n: 1, median: 7, p90: 7 }, { n: 4, median: 2, p90: 4 }]);
});

test("PC2 horizonFor: the pattern's own p90 when active and from 20 targets, else the chart's p90 from 20 targets, else 30; never above h", () => {
  const btt = (n, p90) => ({ n, median: Math.ceil(p90 / 2), p90 });
  const cal = { by_tf: {
    "15": { bars_to_target: btt(25, 22), patterns: { double_top: { active: true, bars_to_target: btt(20, 14) }, flag: { active: false, bars_to_target: btt(25, 50) } } },
    "60": { bars_to_target: btt(12, 11), patterns: { flag: { active: true, bars_to_target: null } } }
  } };
  assert.equal(horizonFor(cal, "15", "double_top"), 14, "active, 20 targets: its own p90");
  assert.equal(horizonFor(cal, "15", "double_top", 10), 10, "never above h");
  assert.equal(horizonFor(cal, "15", "flag"), 22, "inactive: the chart's p90 (25 targets), whatever its own sample");
  assert.equal(horizonFor(cal, "15", "triple_top", 60), 22, "unknown pattern: the chart's p90");
  assert.equal(horizonFor(cal, "60", "triple_top"), HORIZON_DEFAULT_BARS, "12 targets on the chart are too few: 30");
  assert.equal(horizonFor(cal, "60", "flag"), HORIZON_DEFAULT_BARS, "active with no target yet: the chart's, too few: 30");
  assert.equal(horizonFor(cal, "240", "flag", 25), 25);
  assert.equal(horizonFor(null, "15", "flag"), 30);
  assert.equal(HORIZON_DEFAULT_BARS, 30);
  // The review's repro: active from 20 resolved but 1 target, p90 2 bars; the chart's p90 is 40. The chart wins.
  const thin = { by_tf: { "15": { bars_to_target: btt(30, 40), patterns: { pipe_bottom: { active: true, bars_to_target: btt(1, 2) } } } } };
  assert.equal(horizonFor(thin, "15", "pipe_bottom"), 40);
  // The boundaries, at both levels: 19 targets are too few, 20 are enough.
  const at = (own, chart) => horizonFor({ by_tf: { "15": { bars_to_target: btt(chart, 40), patterns: { p: { active: true, bars_to_target: btt(own, 12) } } } } }, "15", "p");
  assert.deepEqual([at(19, 20), at(20, 20), at(19, 19), at(20, 19)], [40, 12, 30, 12]);
  // min_sample is one option for both levels.
  const opt = { by_tf: { "15": { bars_to_target: btt(8, 40), patterns: { p: { active: true, bars_to_target: btt(5, 12) } } } } };
  assert.deepEqual([horizonFor(opt, "15", "p"), horizonFor(opt, "15", "p", null, { min_sample: 5 }), horizonFor(opt, "15", "p", null, { min_sample: 6 }), horizonFor(opt, "15", "p", null, { min_sample: 9 })], [30, 12, 40, 30]);
});

test("PC3 the pooled block and its factors are byte-identical to v1; v2 only adds by_tf and open", () => {
  const series = { "15": wave(600), "60": wave(400, { step: 4 * M, seed: 11 }), "240": wave(300, { step: 16 * M, seed: 13 }), D: wave(200, { step: 96 * M, seed: 17 }) };
  const now = Date.parse("2026-11-22T21:00:00Z");
  const a = v1.calibratePatterns(series, { now });
  const b = calibratePatterns(series, { now });
  const { version: va, ...restA } = a;
  const { version: vb, by_tf, open, ...restB } = b;
  assert.deepEqual([va, vb], ["cryptophys.pattern-calibration.v1", PATTERN_CALIBRATION_VERSION]);
  assert.equal(JSON.stringify(restB), JSON.stringify(restA), "same keys, same order, same values");
  assert.ok(Object.keys(by_tf).length >= 1);
  assert.deepEqual(Object.keys(open), ["15", "60", "240", "D"]);
  // The replay rows keep bars and h; v1's fields are unchanged.
  const occ = replayOccurrences(series["15"], { tf: "15" });
  const old = v1.replayOccurrences(series["15"], { tf: "15" });
  assert.equal(occ.length, old.length);
  occ.forEach((o, i) => {
    const { bars, h, name, upper, lower, target, height, breakout_close, ...base } = o;
    assert.deepEqual(base, old[i]);
    assert.ok(Number.isInteger(bars) && bars >= 0 && Number.isInteger(h) && h >= CALIBRATION.horizon && h <= CALIBRATION.horizon_max);
    if (o.outcome !== "pending") assert.ok(bars >= 1 && bars <= h, `${o.key} ${bars}/${h}`);
  });
});

test("PC4 open: each pending breakout, as the detector saw it on the bar first detected broken out, with the bars to the run", () => {
  const bars = wave(700);
  const cal = calibratePatterns({ "15": bars }, { now: 0 });
  const pending = replayOccurrences(bars, { tf: "15" }).filter((o) => o.outcome === "pending");
  assert.ok(pending.length >= 1, "the fixture ends with a breakout still open");
  assert.equal(cal.open["15"].length, pending.length);
  for (const o of cal.open["15"]) {
    assert.deepEqual(Object.keys(o), ["id", "name", "direction", "status", "upper", "lower", "target", "height", "breakout_close", "bars_at_calibration", "h"]);
    assert.ok(o.bars_at_calibration < o.h, "still inside its horizon");
    assert.equal(Date.parse(o.breakout_close) + o.bars_at_calibration * M, Date.parse(bars.at(-1).close_time));
    // By value: the detector on the 60-bar window ending at that bar (the replay's own window) gives the same pattern.
    const i = bars.findIndex((b) => b.close_time === o.breakout_close);
    assert.ok(i >= CALIBRATION.window - 1);
    const p = detectPatterns(bars.slice(i - CALIBRATION.window + 1, i + 1)).find((x) => x.id === o.id && x.direction === o.direction && x.status !== "forming");
    assert.ok(p, `${o.id} at ${o.breakout_close}`);
    assert.deepEqual([o.name, o.status, o.upper, o.lower, o.target, o.height], [p.name, p.status, p.upper ?? null, p.lower ?? null, p.target, p.height ?? null]);
  }
  assert.deepEqual([cal.open["60"], cal.open["240"], cal.open.D], [[], [], []]);
  assert.equal(JSON.stringify(cal).includes("bars_since_breakout"), false, "the name is reserved for A10's live count");
});

test("PC5 PATTERN_HORIZON_MODE off strips only by_tf and open on read; the key and its TTL are unchanged", async () => {
  const store = new Map([["market-data:v2:series:OANDA:XAUUSD|15m", JSON.stringify({ candles: wave(400) })]]);
  const ttls = [];
  const env = { SIGNAL_CACHE: { get: async (k) => store.get(k) ?? null, put: async (k, v, o) => { store.set(k, v); ttls.push([k, o?.expirationTtl]); } } };
  assert.equal((await runPatternCalibration(env, { now: Date.parse("2026-11-22T21:00:00Z") })).status, "ok");
  assert.deepEqual(ttls, [[PATTERN_CALIBRATION_KEY, 3 * 86_400]]);
  assert.equal(PATTERN_CALIBRATION_KEY, "chart-patterns:calibration:v1");
  const on = await readPatternCalibration(env);
  assert.ok("by_tf" in on && "open" in on);
  const off = await readPatternCalibration({ ...env, PATTERN_HORIZON_MODE: "off" });
  const { by_tf: _b, open: _o, ...expected } = on;
  assert.deepEqual(off, expected);
  assert.deepEqual([patternHorizonMode({}), patternHorizonMode({ PATTERN_HORIZON_MODE: " OFF " }), patternHorizonMode({ PATTERN_HORIZON_MODE: "x" })], ["on", "off", "on"]);
  assert.equal(await readPatternCalibration({ ...env, PATTERN_CALIBRATION_MODE: "off" }), null, "the calibration switch still wins");
});

test("PC6 a v1-shaped stored value read by v2: on and off unchanged, and horizonFor falls back to 30", async () => {
  const series = { "15": wave(400) };
  const stored = v1.calibratePatterns(series, { now: Date.parse("2026-11-22T21:00:00Z") });
  assert.equal("by_tf" in stored || "open" in stored, false);
  const store = new Map([[PATTERN_CALIBRATION_KEY, JSON.stringify(stored)]]);
  const env = { SIGNAL_CACHE: { get: async (k) => store.get(k) ?? null } };
  assert.deepEqual(await readPatternCalibration(env), stored);
  assert.deepEqual(await readPatternCalibration({ ...env, PATTERN_HORIZON_MODE: "off" }), stored);
  const id = Object.keys(stored.patterns)[0] ?? "double_top";
  assert.equal(horizonFor(stored, "15", id), 30);
  assert.equal(horizonFor(stored, "15", id, 18), 18, "min(h, 30)");
  assert.equal(horizonFor(stored, "15", id, 45), 30);
});
