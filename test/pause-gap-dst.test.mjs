import test from "node:test";
import assert from "node:assert/strict";
import { barAfterPause, rolloverQuarantineAt, ROLLOVER_QUARANTINE_NY } from "../src/market-hours.mjs";
import { isRolloverQuarantine } from "../src/omega-engine.mjs";
import { breakoutAgeBars, breakoutAfterPause } from "../src/fresh-pattern.mjs";
import { freshPatternPlans } from "../src/strategy-agents.mjs";
import { breakoutCloseMs } from "../src/public-patterns.mjs";
import { publicPatterns } from "../src/public-analysis.mjs";

const M15 = 15 * 60_000;
const at = (iso) => Date.parse(iso);

// ------------------------------------------------------------------ DQ: the rollover quarantine follows US daylight time
test("DQ-1 winter (US standard time): 21:55-23:15 UTC", () => {
  assert.equal(ROLLOVER_QUARANTINE_NY, "16:55-18:15");
  const q = (iso) => rolloverQuarantineAt(at(iso));
  assert.deepEqual(["21:54", "21:55", "22:05", "22:14", "22:15", "23:00", "23:14", "23:15"].map((h) => q(`2026-11-24T${h}:00Z`)),
    [false, true, true, true, true, true, true, false]);
  assert.equal(q("2026-11-24T23:14:59Z"), true);
});

test("DQ-2 summer (US daylight time): 20:55-22:15 UTC, its 21:55-22:15 part as before", () => {
  const q = (iso) => rolloverQuarantineAt(at(iso));
  assert.deepEqual(["20:54", "20:55", "21:30", "21:55", "22:00", "22:14", "22:15", "23:00"].map((h) => q(`2026-07-14T${h}:00Z`)),
    [false, true, true, true, true, true, false, false]);
});

test("DQ-3 the Sunday reopen and the DST switch dates", () => {
  const q = (iso) => rolloverQuarantineAt(at(iso));
  // Sunday 29 Nov 2026, standard time: the reopen at 23:00 UTC, quarantined to 23:15.
  assert.deepEqual([q("2026-11-29T23:10:00Z"), q("2026-11-29T23:15:00Z")], [true, false]);
  // 8 Mar 2026, daylight time starts: that Sunday's reopen is 22:00 UTC (18:00 New York).
  assert.deepEqual([q("2026-03-08T22:10:00Z"), q("2026-03-08T22:15:00Z"), q("2026-03-08T23:10:00Z")], [true, false, false]);
  assert.deepEqual([q("2026-03-09T20:55:00Z"), q("2026-03-09T22:14:00Z"), q("2026-03-09T22:20:00Z")], [true, true, false], "the Monday after");
  // 1 Nov 2026, standard time again: the reopen is 23:00 UTC.
  assert.deepEqual([q("2026-11-01T23:10:00Z"), q("2026-11-01T23:15:00Z")], [true, false]);
  assert.deepEqual([q("2026-11-02T21:54:00Z"), q("2026-11-02T21:55:00Z"), q("2026-11-02T23:20:00Z")], [false, true, false], "the Monday after");
  assert.equal(rolloverQuarantineAt(NaN), false);
});

test("DQ-4 Omega's gate reads the same clock", () => {
  for (const iso of ["2026-11-24T21:54:00Z", "2026-11-24T22:05:00Z", "2026-11-24T23:10:00Z", "2026-11-24T23:15:00Z", "2026-07-14T20:58:00Z", "2026-07-14T22:20:00Z"]) {
    assert.equal(isRolloverQuarantine(at(iso)), rolloverQuarantineAt(at(iso)), iso);
  }
});

// ------------------------------------------------------------------ PG: a breakout that came with a trading pause
test("PG-1 barAfterPause: the weekend and the daily break, never contiguous bars or a data hole", () => {
  assert.equal(barAfterPause(at("2026-11-27T21:45:00Z"), at("2026-11-29T23:00:00Z"), M15), true, "the weekend");
  assert.equal(barAfterPause(at("2026-11-24T21:45:00Z"), at("2026-11-24T23:00:00Z"), M15), true, "the daily break");
  assert.equal(barAfterPause(at("2026-11-24T21:30:00Z"), at("2026-11-24T21:45:00Z"), M15), false, "contiguous");
  assert.equal(barAfterPause(at("2026-11-24T03:00:00Z"), at("2026-11-24T05:00:00Z"), M15), false, "a data hole in trading hours");
  assert.equal(barAfterPause(at("2026-11-23T22:00:00Z"), at("2026-11-24T22:00:00Z"), 86_400_000), false, "contiguous D1 bars span the break");
  assert.equal(barAfterPause(null, at("2026-11-24T23:00:00Z"), M15), false);
});

// The FP fixture's wedge (test/fresh-pattern.test.mjs): the upper line at 4000, 40 quiet bars below it (range 6).
const WEDGE = { tf: "15", chart: "15m", id: "broadening_wedge_descending", name: "descending broadening wedge", status: "confirmed", direction: 1, upper: 4000, lower: 3985, height: 15, target: 4020, bars_ago: 8 };
const QUIET = [3990, 3996, 3993], BEYOND = [3999, 4005, 4003];
/** 15m bars from rows, the first `before` opening contiguously up to `lastBefore` (an open time), the rest from `firstAfter`. */
function series(rows, before, lastBefore, firstAfter) {
  return rows.map(([low, high, close], i) => {
    const open = i < before ? at(lastBefore) - (before - 1 - i) * M15 : at(firstAfter) + (i - before) * M15;
    return { open_time: new Date(open).toISOString(), open: close, low, high, close };
  });
}
const quiet = (n) => Array.from({ length: n }, () => QUIET);
const ctx = (bars) => ({ price: 4003, atr: 10, levels: [], scalp: false, keyZone: true, patterns: [WEDGE], calibration: null, suspendedPatterns: [], bars });
const freshOf = (bars) => freshPatternPlans(1, ctx(bars), { pattern_lines: "live" });

test("PG-2 a breakout on the first bar after the weekend is not fresh", () => {
  const bars = series([...quiet(40), BEYOND], 40, "2026-11-27T21:45:00Z", "2026-11-29T23:00:00Z");
  assert.equal(breakoutAgeBars(bars, WEDGE), 0);
  assert.equal(breakoutAfterPause(bars, WEDGE), true);
  assert.deepEqual(freshOf(bars), {});
});

test("PG-3 a breakout on the first bar after the daily break is not fresh", () => {
  const bars = series([...quiet(40), BEYOND], 40, "2026-11-24T21:45:00Z", "2026-11-24T23:00:00Z");
  assert.equal(breakoutAfterPause(bars, WEDGE), true);
  assert.deepEqual(freshOf(bars), {});
});

test("PG-4 a normal age-0 breakout, and a data hole, stay fresh", () => {
  const normal = series([...quiet(40), BEYOND], 41, "2026-11-24T20:00:00Z", "2026-11-24T20:15:00Z");
  assert.equal(breakoutAfterPause(normal, WEDGE), false);
  assert.equal(freshOf(normal).pattern_lines.plan.fresh_pattern.breakout_age_bars, 0);
  const hole = series([...quiet(40), BEYOND], 40, "2026-11-24T03:00:00Z", "2026-11-24T05:00:00Z");
  assert.equal(breakoutAfterPause(hole, WEDGE), false, "no pause in the hole");
  assert.equal(freshOf(hole).pattern_lines.plan.fresh_pattern.breakout_age_bars, 0);
});

test("PG-5 the second bar after the reopen: the normal rules when it makes the first close beyond", () => {
  // The gap bar closed beyond and the second continued: the run still starts on the gap bar, not fresh at age 1.
  const cont = series([...quiet(40), BEYOND, BEYOND], 40, "2026-11-27T21:45:00Z", "2026-11-29T23:00:00Z");
  assert.deepEqual([breakoutAgeBars(cont, WEDGE), breakoutAfterPause(cont, WEDGE)], [1, true]);
  assert.deepEqual(freshOf(cont), {});
  // The gap bar closed inside; the second bar is the first close beyond: a fresh breakout at age 0.
  const real = series([...quiet(40), QUIET, BEYOND], 40, "2026-11-27T21:45:00Z", "2026-11-29T23:00:00Z");
  assert.deepEqual([breakoutAgeBars(real, WEDGE), breakoutAfterPause(real, WEDGE)], [0, false]);
  assert.equal(freshOf(real).pattern_lines.plan.fresh_pattern.breakout_age_bars, 0);
});

test("PG-6 public patterns: a gap-bar breakout has no confirming close (the CTA post's fresh check)", () => {
  const rows = (lastBefore, firstAfter, extra = [BEYOND]) => series([...quiet(40), ...extra], 40, lastBefore, firstAfter)
    .map((b) => ({ ...b, close_time: new Date(Date.parse(b.open_time) + M15).toISOString() }));
  const p = { direction: 1, upper: 4000, end_bar: 30 };
  const gap = rows("2026-11-27T21:45:00Z", "2026-11-29T23:00:00Z");
  assert.equal(breakoutCloseMs(gap, p), at("2026-11-29T23:15:00Z"), "without barMs: as before");
  assert.equal(breakoutCloseMs(gap, p, { barMs: M15 }), null);
  const real = rows("2026-11-27T21:45:00Z", "2026-11-29T23:00:00Z", [QUIET, BEYOND]);
  assert.equal(breakoutCloseMs(real, p, { barMs: M15 }), at("2026-11-29T23:30:00Z"), "the second bar's real breakout");
  const normal = rows("2026-11-24T20:00:00Z", "2026-11-24T20:15:00Z");
  assert.equal(breakoutCloseMs(normal, p, { barMs: M15 }), at("2026-11-24T20:30:00Z"));
});

test("PG-7 the public projection keeps the flag, and only when set", () => {
  const base = { tf: "15", id: "broadening_wedge_descending", status: "confirmed", direction: 1, upper: 4000, lower: 3985, height: 15, target: 4020 };
  const [gap] = publicPatterns([{ ...base, confirmed_at_ms: null, breakout_after_pause: true }]);
  assert.deepEqual([gap.confirmed_at_ms, gap.breakout_after_pause], [null, true]);
  const [normal] = publicPatterns([{ ...base, confirmed_at_ms: at("2026-11-24T20:30:00Z") }]);
  assert.deepEqual([normal.confirmed_at_ms, Object.hasOwn(normal, "breakout_after_pause")], [at("2026-11-24T20:30:00Z"), false]);
});
