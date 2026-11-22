// Performance equity and drawdown charts (owner-approved mockup "Nexus data states", part B, 2026-11-22: "lanjutkan
// semua dan tetap berkoordinasi dengan orkestrator"): drawn at the measured width, x by close time on one UTC axis
// (Mondays), R ticks on clean steps, equity as a step from 0, the drawdown's deepest point marked, one crosshair.
// The scale and tick rules are pure (ui/src/lib/chartScale.ts) and run here in Node.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  equityRows, linear, localStamp, maxDrawdownIndex, nearestIndex, niceStep, niceTicks, rTick, rValue, stepPath, stepPoints,
  utcDayLabel, utcDayTicks, utcStamp
} from "../workers/xauusd-nexus-dashboard/ui/src/lib/chartScale.ts";

const src = (p) => readFileSync(new URL(`../workers/xauusd-nexus-dashboard/ui/src/${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const DAY = 86_400_000;
const now = Date.parse("2026-11-22T14:00:00Z");

test("PC1 R ticks on clean steps (1, 2, 5 × 10^k), always through 0, snapped outward", () => {
  assert.deepEqual([0.4, 1, 1.3, 2, 3, 6, 13, 40].map((s) => niceStep(s, 4)), [0.1, 0.5, 0.5, 0.5, 1, 2, 5, 10]);
  assert.deepEqual(niceTicks(0, 6.6, 5), { lo: 0, hi: 8, step: 2, ticks: [0, 2, 4, 6, 8] }, "the mockup's 0 … +8R");
  assert.deepEqual(niceTicks(-4.4, 0, 3).ticks, [-6, -4, -2, 0], "the drawdown's 0 … −6R");
  assert.deepEqual(niceTicks(-1.3, 2.2, 5).ticks, [-2, -1, 0, 1, 2, 3]);
  assert.deepEqual(niceTicks(1.5, 4, 4).ticks, [0, 1, 2, 3, 4], "0 is always on the axis");
  assert.deepEqual(niceTicks(0, 0, 4).ticks, [0, 0.5, 1], "a flat line still gets one step");
  assert.deepEqual(niceTicks(-1, 0, 3).ticks, [-1, -0.5, 0]);
  assert.ok(niceTicks(-0.3, 0.7, 5).ticks.every((v) => Object.is(v, 0) || v !== 0), "no −0 tick");
  assert.deepEqual([0, 2, -2, 0.5, -0.25].map(rTick), ["0", "+2R", "−2R", "+0.5R", "−0.25R"]);
  assert.deepEqual([2.7, -1.8, 0, -0.001, 6.6].map(rValue), ["+2.70R", "−1.80R", "0.00R", "0.00R", "+6.60R"]);
});

test("PC2 x ticks at 00:00 UTC: Mondays in 30D, thinned when they would crowd, days in a short window", () => {
  const m30 = utcDayTicks(now - 30 * DAY, now, 1014, 72);
  assert.equal(m30.stride, 7);
  assert.deepEqual(m30.ticks.map(utcDayLabel), ["Oct 26", "Nov 02", "Nov 09", "Nov 16"], "the mockup's Mondays");
  for (const t of m30.ticks) { const d = new Date(t); assert.equal(d.getUTCDay(), 1); assert.equal(t % DAY, 0); }
  assert.deepEqual(utcDayTicks(now - 30 * DAY, now, 252, 56).ticks.map(utcDayLabel), ["Oct 26", "Nov 02", "Nov 09", "Nov 16"], "phone 390: still four");
  const m90 = utcDayTicks(now - 90 * DAY, now, 252, 56);
  assert.equal(m90.stride, 28, "phone 90D: every 4th Monday");
  assert.ok(m90.ticks.length <= 4 && m90.ticks.every((t) => new Date(t).getUTCDay() === 1));
  const d7 = utcDayTicks(now - 7 * DAY, now, 1014, 72);
  assert.equal(d7.stride, 1);
  assert.deepEqual(d7.ticks.map(utcDayLabel), ["Nov 16", "Nov 17", "Nov 18", "Nov 19", "Nov 20", "Nov 21", "Nov 22"]);
  assert.equal(utcDayTicks(now - 7 * DAY, now, 252, 56).stride, 2, "phone 7D: every 2nd day");
  assert.deepEqual(utcDayTicks(now, now, 500).ticks, [], "an empty window has no ticks");
});

test("PC3 close stamps in UTC and the browser's zone", () => {
  const t = Date.parse("2026-11-11T08:12:30Z");
  assert.equal(utcStamp(t), "Nov 11 08:12 UTC");
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  assert.ok(localStamp(t).endsWith(`${hm} local`), localStamp(t));
});

test("PC4 equity rows: close time in ms, the trade's own R, the peak from 0 and the drawdown, as the ledger counts them", () => {
  const rows = equityRows([
    { t: "2026-11-03T10:00:00Z", r: 1.5, id: "b" },
    { t: "2026-11-02T10:00:00Z", r: -1, id: "a" },
    { t: null, r: 9, id: "x" },
    { t: "2026-11-04T10:00:00Z", r: 0.5, id: "c" }
  ]);
  assert.deepEqual(rows.map((x) => x.id), ["a", "b", "c"], "sorted by close time; no time, no point");
  assert.deepEqual(rows.map((x) => x.trade), [-1, 2.5, -1]);
  assert.deepEqual(rows.map((x) => x.peak), [0, 1.5, 1.5], "the peak starts at 0 (src/signal-ledger.mjs)");
  assert.deepEqual(rows.map((x) => x.dd), [-1, 0, -1]);
  assert.equal(rows[0].t, Date.parse("2026-11-02T10:00:00Z"));
});

test("PC5 equity is a step from 0 at the window start: it moves only at a close and holds to the window end", () => {
  const pts = stepPoints([10, 20], [1, -0.5], 0, 30);
  assert.deepEqual(pts, [{ t: 0, v: 0 }, { t: 10, v: 0 }, { t: 10, v: 1 }, { t: 20, v: 1 }, { t: 20, v: -0.5 }, { t: 30, v: -0.5 }]);
  const X = linear(0, 30, 48, 348), Y = linear(-1, 1, 200, 0);
  assert.equal(stepPath(pts.map((p) => ({ x: X(p.t), y: Y(p.v) }))), "M48.0,100.0H148.0V0.0H248.0V150.0H348.0", "only H and V segments");
  assert.deepEqual(stepPoints([], [], 0, 30), [{ t: 0, v: 0 }, { t: 30, v: 0 }]);
  assert.equal(stepPoints([40], [2], 0, 30).at(-1).t, 40, "a close past the window end still shows");
});

test("PC6 the deepest drawdown's index (first on a tie, -1 with none) and the nearest close for the crosshair", () => {
  assert.equal(maxDrawdownIndex([0, -1, -4.4, -2, -4.4, 0]), 2);
  assert.equal(maxDrawdownIndex([0, 0, 0]), -1);
  assert.equal(maxDrawdownIndex([]), -1);
  const times = [10, 20, 40];
  assert.deepEqual([0, 14, 15, 16, 29, 31, 99].map((t) => nearestIndex(times, t)), [0, 0, 0, 1, 1, 2, 2]);
  assert.equal(nearestIndex([], 5), -1);
});

test("PC7 Performance.tsx draws at the measured width, no stretched SVG, one crosshair, keys and a summary", () => {
  const p = src("pages/Performance.tsx");
  assert.doesNotMatch(p, /preserveAspectRatio="none"/, "text never stretches");
  assert.match(p, /new ResizeObserver\(/, "the real width");
  assert.match(p, /from "\.\.\/lib\/chartScale"/);
  assert.match(p, /e\.key === "ArrowRight"/);
  assert.match(p, /e\.key === "ArrowLeft"/);
  assert.match(p, /tabIndex=\{0\}/);
  assert.match(p, /aria-label=\{summary\}/);
  assert.match(p, /stroke=\{T\.off\} strokeOpacity=\{0\.7\} strokeWidth=\{1\}/, "the peak: a thin grey line");
  assert.match(p, /const lineColor = \(last\?\.r \?\? 0\) >= 0 \? T\.bullFill : T\.bearFill;/);
  assert.doesNotMatch(p, /strokeDasharray/, "solid grid, zero and peak; no dashes in the charts");
  assert.doesNotMatch(p, /Equity \(R\)/, "the legend left the panel title row");
  assert.equal((p.match(/onPointerMove=\{pick\}/g) ?? []).length, 2, "one crosshair through both charts");
});
