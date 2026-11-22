// Track A PR 4: the pattern calibration v2. The same pooled block and factors as v1 (checked against the v1 module,
// copied verbatim from main into test/support/pattern-calibration-v1.mjs), plus by_tf (bars to target per chart,
// each pattern's split and its rate shrunk toward the chart's rate) and open (the breakouts still pending, frozen at
// their breakout). horizonFor reads them; PATTERN_HORIZON_MODE "off" strips them on read.
import test from "node:test";
import assert from "node:assert/strict";
import { replayOccurrences, calibrationFrom, calibratePatterns, horizonFor, barsSummary, patternHorizonMode, readPatternCalibration, runPatternCalibration, PATTERN_CALIBRATION_KEY, PATTERN_CALIBRATION_VERSION, HORIZON_DEFAULT_BARS, CALIBRATION } from "../src/pattern-calibration.mjs";
import * as v1 from "./support/pattern-calibration-v1.mjs";

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

test("PC1 by_tf on a hand fixture: bars to target from targets only, the split, and the rate shrunk toward the chart's rate", () => {
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
  assert.deepEqual([dt.n, dt.target, dt.failed, dt.expired, dt.raw_rate, dt.active], [25, 15, 8, 2, 0.6, true]);
  assert.equal(dt.rate, r3((15 + 10 * (20 / 30)) / (25 + 10)), "shrunk toward the chart's rate, prior 10");
  assert.deepEqual(dt.bars_to_target, { n: 15, median: 8, p90: 14 });
  const fl = chart.patterns.flag;
  assert.deepEqual([fl.n, fl.target, fl.active, fl.bars_to_target], [5, 5, false, { n: 5, median: 30, p90: 50 }], "the pending flag is not counted");
  assert.deepEqual(Object.keys(chart.patterns), ["double_top", "flag"], "most breakouts first");
  assert.deepEqual(c.by_tf["60"], { resolved: 1, rate: 0, bars_to_target: null, patterns: { flag: { n: 1, target: 0, failed: 1, expired: 0, raw_rate: 0, rate: 0, active: false, bars_to_target: null } } });
  assert.equal("240" in c.by_tf, false, "a chart with no resolved breakout has no record");
  assert.deepEqual([barsSummary([]), barsSummary([7]), barsSummary([4, 1, 3, 2])], [null, { n: 1, median: 7, p90: 7 }, { n: 4, median: 2, p90: 4 }]);
});

test("PC2 horizonFor: the pattern's own p90 when active, else the chart's p90 from 20 targets, else 30; never above h", () => {
  const cal = { by_tf: {
    "15": { bars_to_target: { n: 25, median: 9, p90: 22 }, patterns: { double_top: { active: true, bars_to_target: { n: 15, median: 8, p90: 14 } }, flag: { active: false, bars_to_target: { n: 5, median: 30, p90: 50 } } } },
    "60": { bars_to_target: { n: 12, median: 5, p90: 11 }, patterns: { flag: { active: true, bars_to_target: null } } }
  } };
  assert.equal(horizonFor(cal, "15", "double_top"), 14, "active: its own p90");
  assert.equal(horizonFor(cal, "15", "double_top", 10), 10, "never above h");
  assert.equal(horizonFor(cal, "15", "flag"), 22, "inactive: the chart's p90 (25 targets)");
  assert.equal(horizonFor(cal, "15", "triple_top", 60), 22, "unknown pattern: the chart's p90");
  assert.equal(horizonFor(cal, "60", "triple_top"), HORIZON_DEFAULT_BARS, "12 targets on the chart are too few: 30");
  assert.equal(horizonFor(cal, "60", "flag"), HORIZON_DEFAULT_BARS, "active with no target yet: the chart's, too few: 30");
  assert.equal(horizonFor(cal, "240", "flag", 25), 25);
  assert.equal(horizonFor(null, "15", "flag"), 30);
  assert.equal(HORIZON_DEFAULT_BARS, 30);
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

test("PC4 open: each pending breakout, frozen at its breakout, with the bars since it", () => {
  const bars = wave(700);
  const cal = calibratePatterns({ "15": bars }, { now: 0 });
  const pending = replayOccurrences(bars, { tf: "15" }).filter((o) => o.outcome === "pending");
  assert.ok(pending.length >= 1, "the fixture ends with a breakout still open");
  assert.equal(cal.open["15"].length, pending.length);
  for (const o of cal.open["15"]) {
    assert.deepEqual(Object.keys(o), ["id", "name", "direction", "status", "upper", "lower", "target", "height", "breakout_close", "bars_since_breakout", "h"]);
    assert.ok(typeof o.name === "string" && [1, -1].includes(o.direction) && typeof o.target === "number" && typeof o.breakout_close === "string");
    assert.ok(o.bars_since_breakout < o.h, "still inside its horizon");
    assert.equal(Date.parse(o.breakout_close) + o.bars_since_breakout * M, Date.parse(bars.at(-1).close_time));
  }
  assert.deepEqual([cal.open["60"], cal.open["240"], cal.open.D], [[], [], []]);
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
