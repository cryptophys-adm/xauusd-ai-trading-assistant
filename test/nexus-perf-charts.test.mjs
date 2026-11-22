// Performance equity and drawdown charts (owner-approved mockup "Nexus data states", part B, 2026-11-22: "lanjutkan
// semua dan tetap berkoordinasi dengan orkestrator"): drawn at the measured width, x by close time on one UTC axis
// (Mondays), R ticks on clean steps, equity as a step from 0, the drawdown's deepest point marked, one crosshair.
// The whole chart model is pure (ui/src/lib/chartScale.ts chartModel) and runs here in Node; Performance.tsx draws it.
// Review of #526: x labels clear both plot edges (the "UTC" tag), the selection follows its trade, the model, card and
// keys are tested, localStamp in a fixed zone, a null R is no trade, tiny spans keep a domain, forced colours.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  CHAR_EM, MAX_X_LABELS, NARROW, cardFields, cardPosition, chartLayout, chartModel, chartSummary, equityRows, fitAxisLabels, indexOfKey,
  keyStep, labelWidth, linear, localStamp, maxDrawdownIndex, nearestIndex, niceStep, niceTicks, pointerIndex, rTick, rValue, rowKey,
  stepPath, stepPoints, utcDayLabel, utcDayTicks, utcStamp
} from "../workers/xauusd-nexus-dashboard/ui/src/lib/chartScale.ts";

const ui = (p) => readFileSync(new URL(`../workers/xauusd-nexus-dashboard/ui/${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const src = (p) => ui(`src/${p}`);
const DAY = 86_400_000;
const now = Date.parse("2026-11-22T14:00:00Z");
/** Monday 05:00 UTC: the 30D window's last Monday tick is 5 hours from the plot's right edge. */
const mon5 = Date.parse("2026-11-23T05:00:00Z");
/** The chart's measured widths (Playwright, this page): 320 → 269, 390 → 339, 1440 → 1172, 1920 → 1608. */
const W = { 320: 269, 390: 339, 1440: 1172, 1920: 1608 };
const labels = (m) => m.xTicks.map((x) => x.label);
/** Ledger points from per-trade R: the ledger's `r` is cumulative R at each close (src/signal-ledger.mjs). */
const fromTrades = (rs, t0 = Date.parse("2026-11-02T10:00:00Z")) => {
  let cum = 0;
  return rs.map((r, i) => ({ t: t0 + i * DAY, r: Math.round((cum += r) * 1000) / 1000, id: `t${i}` }));
};
const POINTS = [["2026-11-02T10:00:00Z", 2, "a"], ["2026-11-05T10:00:00Z", 1, "b"], ["2026-11-09T10:00:00Z", 0.5, "c"], ["2026-11-12T10:00:00Z", 3, "d"], ["2026-11-18T10:00:00Z", 2.2, "e"]]
  .map(([t, r, id]) => ({ t, r, id }));

test("PC1 R ticks on clean steps (1, 2, 5 × 10^k), always through 0, snapped outward; a tiny span keeps a domain", () => {
  assert.deepEqual([0.4, 1, 1.3, 2, 3, 6, 13, 40].map((s) => niceStep(s, 4)), [0.1, 0.5, 0.5, 0.5, 1, 2, 5, 10]);
  assert.deepEqual(niceTicks(0, 6.6, 5), { lo: 0, hi: 8, step: 2, ticks: [0, 2, 4, 6, 8] }, "the mockup's 0 … +8R");
  assert.deepEqual(niceTicks(-4.4, 0, 3).ticks, [-6, -4, -2, 0], "the drawdown's 0 … −6R");
  assert.deepEqual(niceTicks(-1.3, 2.2, 5).ticks, [-2, -1, 0, 1, 2, 3]);
  assert.deepEqual(niceTicks(1.5, 4, 4).ticks, [0, 1, 2, 3, 4], "0 is always on the axis");
  assert.deepEqual(niceTicks(0, 0, 4).ticks, [0, 0.5, 1], "a flat line still gets one step");
  assert.deepEqual(niceTicks(-1, 0, 3).ticks, [-1, -0.5, 0]);
  assert.ok(niceTicks(-0.3, 0.7, 5).ticks.every((v) => Object.is(v, 0) || v !== 0), "no −0 tick");
  // Review of #526: a flat negative line gets a full step, and the step never rounds to 0 (it was a NaN domain).
  assert.deepEqual(niceTicks(-1e-10, -1e-10, 3), { lo: -1, hi: 0, step: 0.5, ticks: [-1, -0.5, 0] }, "flat just below 0: one full step");
  assert.deepEqual(niceTicks(-1e-8, 0, 3), { lo: -0.000001, hi: 0, step: 0.000001, ticks: [-0.000001, 0] }, "the step floors at 1e-6");
  assert.deepEqual(niceTicks(0, 1e-8, 4), { lo: 0, hi: 0.000001, step: 0.000001, ticks: [0, 0.000001] });
  for (const [a, b] of [[-1e-10, -1e-10], [-1e-8, 0], [0, 1e-8], [-3e-7, 2e-7], [5e-8, 5e-8]]) {
    const s = niceTicks(a, b, 3);
    assert.ok([s.lo, s.hi, s.step, ...s.ticks].every(Number.isFinite) && s.step > 0 && s.hi > s.lo, `${a}..${b}: ${JSON.stringify(s)}`);
    assert.ok(Object.is(s.hi, 0) || s.hi > 0, "no −0 domain edge");
  }
  assert.deepEqual([0, 2, -2, 0.5, -0.25].map(rTick), ["0", "+2R", "−2R", "+0.5R", "−0.25R"]);
  assert.deepEqual([2.7, -1.8, 0, -0.001, 6.6].map(rValue), ["+2.70R", "−1.80R", "0.00R", "0.00R", "+6.60R"]);
});

test("PC2 x ticks at 00:00 UTC: Mondays past two weeks, days in a short window, at most 8, at least 2 where they fit", () => {
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

  // The rule at the page's real widths, through the model (layout, tick spacing and the edge guard).
  const at = (vw, d, end = now) => chartModel([], end - d * DAY, end, W[vw]);
  // Phone 7D: every 2nd day at 390; every 3rd at 320 (stride 2 is 54px there; it was one Monday, a single label).
  assert.deepEqual([at(390, 7).stride, labels(at(390, 7))], [2, ["Nov 17", "Nov 19", "Nov 21"]], "phone 390, 7D");
  assert.deepEqual([at(320, 7).stride, labels(at(320, 7))], [3, ["Nov 18", "Nov 21"]], "phone 320, 7D: stride 3, two labels");
  // Desktop 90D: 13 Mondays would be past MAX_X_LABELS, so every 2nd Monday.
  assert.equal(MAX_X_LABELS, 8);
  assert.deepEqual([at(1440, 90).stride, labels(at(1440, 90))], [14, ["Aug 31", "Sep 14", "Sep 28", "Oct 12", "Oct 26", "Nov 09"]], "desktop 1440, 90D");
  assert.equal(at(1920, 90).stride, 14, "desktop 1920, 90D");
  // 1920 30D: a day is 50px there, so stride 2 fit; past two weeks it is Mondays (it drifted to every 2nd day).
  assert.deepEqual([at(1920, 30).stride, labels(at(1920, 30))], [7, ["Oct 26", "Nov 02", "Nov 09", "Nov 16"]], "desktop 1920, 30D: Mondays");
  assert.equal(utcDayTicks(now - 30 * DAY, now, 1488, 72, 0, 99).stride, 7, "Mondays past two weeks without the label cap too");
  assert.equal(utcDayTicks(now - 20 * DAY, now, 1488, 72).stride, 7, "a 20-day window: not every 3rd day");
  assert.equal(utcDayTicks(now - 14 * DAY, now, 1488, 72).stride, 2, "a 14-day window is still short: days");
  assert.deepEqual([at(1440, 30).stride, labels(at(1440, 30))], [7, ["Oct 26", "Nov 02", "Nov 09", "Nov 16"]]);
  assert.equal(at(1920, 7).stride, 1, "1920 7D: every day");
  assert.equal(at(1920, 14, mon5).stride, 2, "14D is a short window: days");
  // Phone 30D at 320: every 2nd Monday, counted from the first that clears the left edge, so two labels, not one.
  assert.deepEqual([at(320, 30).stride, labels(at(320, 30))], [14, ["Nov 02", "Nov 16"]], "phone 320, 30D");
  assert.deepEqual([at(390, 14, mon5).stride, labels(at(390, 14, mon5)).length], [3, 4], "phone 390, 14D: at least two labels");
  for (const vw of [320, 390, 1440, 1920]) for (const d of [7, 30, 90]) {
    const m = at(vw, d);
    assert.ok(m.xTicks.length >= 2 && m.xTicks.length <= MAX_X_LABELS, `${vw} ${d}D: ${labels(m)}`);
    for (let i = 1; i < m.xTicks.length; i++) assert.ok(m.xTicks[i].x - m.xTicks[i - 1].x >= m.minTickPx - 1e-9, `${vw} ${d}D spacing`);
  }
});

test("PC2b the edge guard: no x label passes the plot's right edge (the UTC tag) or reaches its left edge", () => {
  assert.equal(CHAR_EM, 0.62);
  assert.equal(labelWidth("Nov 23", 11), 6 * 11 * 0.62);
  assert.equal(labelWidth("Nov 23", 10), 6 * 10 * 0.62);
  const X = linear(0, 100, 48, 1100);
  const lab = () => "Nov 23"; // 40.92px at 11px, so a centre needs 20.46px on each side
  assert.deepEqual(fitAxisLabels([0, 2, 50, 98, 100], X, lab, 48, 1100, 11), [2, 50, 98], "X 48 and 1100 are on the edges; X 69 and 1079 fit");
  assert.deepEqual(fitAxisLabels([1.9, 98.1], X, lab, 48, 1100, 11), [], "19.98px from an edge does not fit");
  // Monday 05:00 UTC, 30D at 1440: "Nov 23" sat 7px left of the plot's right edge and ran into "UTC" ("Nov 2̶3̶TC").
  const m = chartModel([], mon5 - 30 * DAY, mon5, W[1440]);
  assert.ok(utcDayTicks(m.x0, m.x1, m.plotW, m.minTickPx).ticks.map(utcDayLabel).includes("Nov 23"), "the unguarded rule kept it");
  assert.deepEqual(labels(m), ["Oct 26", "Nov 02", "Nov 09", "Nov 16"], "the guard drops it");
  for (const vw of [320, 390, 1440, 1920]) for (const d of [7, 14, 30, 90]) for (const end of [now, mon5, mon5 - 4 * 3_600_000, mon5 + 7 * 3_600_000]) {
    const g = chartModel([], end - d * DAY, end, W[vw]);
    for (const { x, label } of g.xTicks) {
      const half = labelWidth(label, g.font) / 2;
      assert.ok(x - half >= g.left - 1e-9, `${vw} ${d}D ${label}: clears the left edge (the drawdown's lowest R label)`);
      assert.ok(x + half <= g.left + g.plotW + 1e-9, `${vw} ${d}D ${label}: clears the right edge, so "UTC" at +6px`);
    }
  }
});

test("PC3 close stamps in UTC and the browser's zone (pinned in Asia/Jakarta, UTC+7)", () => {
  const t = Date.parse("2026-11-11T08:12:30Z");
  assert.equal(utcStamp(t), "Nov 11 08:12 UTC");
  const mod = new URL("../workers/xauusd-nexus-dashboard/ui/src/lib/chartScale.ts", import.meta.url).href;
  const code = `const { localStamp } = await import(${JSON.stringify(mod)});
    const ts = ["2026-11-11T08:12:30Z", "2026-11-11T16:59:00Z", "2026-11-11T17:00:00Z", "2026-11-30T20:05:00Z", "2026-12-31T18:30:00Z"];
    console.log(JSON.stringify([Intl.DateTimeFormat().resolvedOptions().timeZone, ...ts.map((x) => localStamp(Date.parse(x)))]));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, TZ: "Asia/Jakarta" }, encoding: "utf8" });
  assert.deepEqual(JSON.parse(out.trim().split("\n").at(-1)), [
    "Asia/Jakarta",
    "15:12 local",          // the same date: no date prefix
    "23:59 local",
    "Nov 12 00:00 local",   // past local midnight: the local date first
    "Dec 01 03:05 local",   // across a month
    "Jan 01 01:30 local"    // across a year
  ]);
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
  // Review of #526: a null R is no trade (Number(null) was a phantom close at 0R).
  const nulls = equityRows([{ t: "2026-11-02T10:00:00Z", r: 1, id: "a" }, { t: "2026-11-03T10:00:00Z", r: null, id: "n" }, { t: "2026-11-04T10:00:00Z", r: undefined, id: "u" }, { t: "2026-11-05T10:00:00Z", r: 1.5, id: "c" }]);
  assert.deepEqual(nulls.map((x) => [x.id, x.r, x.trade, x.dd]), [["a", 1, 1, 0], ["c", 1.5, 0.5, 0]], "no phantom 0R close, no phantom drawdown");
  // The ledger's `r` is cumulative R at each close; these cases are written as per-trade R and summed (fromTrades).
  // Per-trade [2, −1, −0.5]: equity 2, 1, 0.5; peak 2; drawdown 0, −1, −1.5.
  const a = equityRows(fromTrades([2, -1, -0.5]));
  assert.deepEqual(a.map((x) => x.r), [2, 1, 0.5]);
  assert.deepEqual(a.map((x) => x.trade), [2, -1, -0.5], "each row's own R");
  assert.deepEqual(a.map((x) => x.peak), [2, 2, 2]);
  assert.deepEqual(a.map((x) => x.dd), [0, -1, -1.5]);
  // Per-trade [2, −1, 0.5, −0.3]: equity 2, 1, 1.5, 1.2; a partial recovery does not reset the peak.
  const b = equityRows(fromTrades([2, -1, 0.5, -0.3]));
  assert.deepEqual(b.map((x) => x.r), [2, 1, 1.5, 1.2]);
  assert.deepEqual(b.map((x) => x.peak), [2, 2, 2, 2]);
  assert.deepEqual(b.map((x) => x.dd), [0, -1, -0.5, -0.8]);
  assert.equal(maxDrawdownIndex(b.map((x) => x.dd)), 1);
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
  // The pointer: px from the chart's left edge to time, then the nearest close.
  const m = { x0: 0, x1: 100, left: 48, plotW: 200, times: [10, 50, 90] };
  assert.deepEqual([0, 48, 68, 107, 109, 148, 230, 400].map((x) => pointerIndex(m, x)), [0, 0, 0, 0, 1, 1, 2, 2]);
  assert.equal(pointerIndex({ ...m, times: [] }, 100), -1);
});

test("PC7 Performance.tsx draws the pure model at the measured width: no stretched SVG, one crosshair, keys, a summary", () => {
  const p = src("pages/Performance.tsx");
  assert.doesNotMatch(p, /preserveAspectRatio="none"/, "text never stretches");
  assert.match(p, /new ResizeObserver\(/, "the real width");
  assert.match(p, /from "\.\.\/lib\/chartScale"/);
  assert.match(p, /const m = useMemo\(\(\) => chartModel\(points, startMs, endMs, width\), \[points, startMs, endMs, width\]\);/, "one pure model");
  assert.doesNotMatch(p, /niceTicks\(|utcDayTicks\(|equityRows\(|maxDrawdownIndex\(/, "no second copy of the rules in the page");
  assert.match(p, /const next = keyStep\(e\.key, active, n\);\n\s*if \(!next\.handled\) return;\n\s*e\.preventDefault\(\);\n\s*select\(next\.active\);/, "the keys through the reducer");
  assert.match(p, /onKeyDown=\{onKey\}/);
  assert.match(p, /tabIndex=\{0\}/);
  assert.match(p, /const summary = chartSummary\(m, policyLabel, days\);/);
  assert.match(p, /aria-label=\{summary\}/);
  assert.match(p, /aria-live="polite">\{f \? f\.live : ""\}/);
  assert.match(p, /stroke=\{T\.off\} strokeOpacity=\{0\.7\} strokeWidth=\{1\}/, "the peak: a thin grey line");
  assert.match(p, /const lineColor = \(last\?\.r \?\? 0\) >= 0 \? T\.bullFill : T\.bearFill;/);
  assert.doesNotMatch(p, /strokeDasharray/, "solid grid, zero and peak; no dashes in the charts");
  assert.doesNotMatch(p, /Equity \(R\)/, "the legend left the panel title row");
  assert.equal((p.match(/onPointerMove=\{pick\}/g) ?? []).length, 2, "one crosshair through both charts");
  assert.match(p, /const pick = \(e: React\.PointerEvent<SVGSVGElement>\) => select\(pointerIndex\(m, e\.clientX - e\.currentTarget\.getBoundingClientRect\(\)\.left\)\);/);
  assert.match(p, /\{m\.xTicks\.map\(\(\{ t, x, label \}\) => \(/, "the guarded ticks label the axis");
  assert.match(p, /<text x=\{left \+ plotW \+ 6\} y=\{ddAxisY\} \{\.\.\.axisText\}>UTC<\/text>/, "the UTC tag 6px right of the plot");
  assert.match(p, /<span className="mono">\{m\.ddHeadline\}<\/span>/, "the drawdown's headline, on a phone too");
  assert.match(p, /const cardAt = cardPosition\(ax, row \? Ye\(row\.r\) : 0, width, eqH, cardW\);/);
  assert.match(p, /style=\{\{ left: cardAt\.left, top: cardAt\.top, width: cardW \}\}/);
});

test("PC8 the chart model: layout, x domain, both scales, the deepest drawdown, paths", () => {
  assert.equal(NARROW, 560);
  assert.deepEqual([chartLayout(559).narrow, chartLayout(560).narrow, chartLayout(0).narrow], [true, false, false]);
  assert.deepEqual(
    (({ font, left, right, plotW, eqH, eqTop, eqBottom, ddH, ddTop, ddBottom, ddAxisY, minTickPx, eqMaxTicks }) => [font, left, right, plotW, eqH, eqTop, eqBottom, ddH, ddTop, ddBottom, ddAxisY, minTickPx, eqMaxTicks])(chartLayout(1172)),
    [11, 48, 72, 1052, 240, 10, 234, 110, 4, 88, 105, 72, 6]
  );
  assert.deepEqual(
    (({ font, left, right, plotW, eqH, eqBottom, ddH, ddBottom, ddAxisY, minTickPx, eqMaxTicks }) => [font, left, right, plotW, eqH, eqBottom, ddH, ddBottom, ddAxisY, minTickPx, eqMaxTicks])(chartLayout(339)),
    [10, 34, 46, 259, 180, 174, 86, 64, 81, 56, 4]
  );
  const start = now - 30 * DAY;
  const m = chartModel(POINTS, start, now, 1172);
  assert.deepEqual([m.x0, m.x1, m.n], [start, now, 5], "the window");
  assert.equal(m.X(m.x0), 48);
  assert.equal(m.X(m.x1), 1100);
  // x0 / x1 widen to a close outside the window, so it is still drawn.
  const early = chartModel([{ t: start - 2 * DAY, r: -1, id: "z" }, ...POINTS], start, now, 1172);
  assert.equal(early.x0, start - 2 * DAY);
  assert.equal(early.x1, now);
  const late = chartModel([...POINTS, { t: now + DAY, r: 4, id: "y" }], start, now, 1172);
  assert.deepEqual([late.x0, late.x1], [start, now + DAY]);
  // The equity scale: from the lowest point (or 0) to the highest peak; the drawdown scale: from the deepest to 0.
  assert.deepEqual(m.eqScale, { lo: 0, hi: 3, step: 0.5, ticks: [0, 0.5, 1, 1.5, 2, 2.5, 3] });
  assert.deepEqual(m.ddScale, { lo: -1.5, hi: 0, step: 0.5, ticks: [-1.5, -1, -0.5, 0] });
  assert.deepEqual(early.eqScale.ticks, [-1, 0, 1, 2, 3], "a close below 0 widens the equity scale down");
  assert.equal(early.zeroY, 178, "0 is above the bottom when a close is below it");
  assert.ok(early.eqArea.endsWith("V178.0H48.0Z"), "the equity area closes on the zero line, not the bottom");
  assert.deepEqual(chartModel(POINTS, start, now, 339).eqScale.ticks, [0, 1, 2, 3], "fewer R ticks on a phone");
  assert.deepEqual([m.Ye(0), m.Ye(3), m.Yd(0), m.Yd(-1.5)], [234, 10, 4, 88], "y grows upward in both charts");
  assert.equal(m.zeroY, 234);
  assert.equal(m.peakMax, 3);
  assert.deepEqual([m.ddIdx, m.ddRow.id, m.ddRow.dd, m.ddRow.peak], [2, "c", -1.5, 2]);
  assert.equal(m.ddHeadline, "max −1.50R · Nov 09");
  assert.equal(chartModel(POINTS, start, now, 339).ddHeadline, "max −1.50R · Nov 09", "the phone keeps the short date");
  assert.equal(chartModel(fromTrades([1, 0.5]), start, now, 1172).ddHeadline, "no drawdown");
  assert.deepEqual(m.ddMark, { x: m.X(m.ddRow.t), y: 88, labelX: m.X(m.ddRow.t) + 6, labelY: 80, anchor: "start", text: "−1.50R" });
  const atEnd = chartModel([...fromTrades([12]), { t: now - 3_600_000, r: 2, id: "end" }], start, now, 339);
  assert.equal(atEnd.ddMark.text, "−10.00R");
  assert.equal(atEnd.ddMark.anchor, "end", "the value goes left of a point where it would pass the chart's width");
  assert.equal(atEnd.ddMark.labelX, atEnd.ddMark.x - 6);
  assert.equal(m.last.id, "e");
  assert.equal(m.eqLine, "M48.0,234.0H392.8V84.7H498.0V159.3H638.3V196.7H743.5V10.0H953.9V69.7H1100.0");
  assert.equal(m.ddLine, "M48.0,4.0H392.8H498.0V60.0H638.3V88.0H743.5V4.0H953.9V48.8H1100.0");
  assert.equal(m.peakLine, "M48.0,234.0H392.8V84.7H498.0H638.3H743.5V10.0H953.9H1100.0", "the peak steps up only at a new high");
  assert.equal(m.eqArea, `${m.eqLine}V234.0H48.0Z`, "the equity area closes on the zero line");
  assert.equal(m.ddArea, `${m.ddLine}V4.0H48.0Z`, "the drawdown area closes on its 0 at the top");
  assert.deepEqual(chartModel([], start, now, 0).xTicks, [], "no width, no ticks");
});

test("PC9 the selection follows its trade by id (else close time) when the window slides, and clears when it leaves", () => {
  const before = equityRows(fromTrades([1, -1, 0.6, 0.5, -1, 0.6, 2, -1, 0.3, 0.6, -1]));
  const i = 9;
  const key = rowKey(before[i]);
  assert.equal(key, "id:t9");
  assert.deepEqual([cardFields(before, i).ordinal, cardFields(before, i).trade], ["Trade 10 of 11", "+0.60R"]);
  // The window slides on a poll: the oldest close leaves, so index 9 is another trade now.
  const after = equityRows(fromTrades([1, -1, 0.6, 0.5, -1, 0.6, 2, -1, 0.3, 0.6, -1]).slice(1));
  assert.notEqual(after[i].id, before[i].id, "an index would point at another trade");
  const j = indexOfKey(after, key);
  assert.equal(j, 8);
  assert.deepEqual([cardFields(after, j).ordinal, cardFields(after, j).trade, cardFields(after, j).utc], ["Trade 9 of 10", "+0.60R", cardFields(before, i).utc], "the same trade");
  assert.equal(indexOfKey(after, rowKey(before[0])), -1, "it left the window: no selection");
  assert.equal(indexOfKey(after, null), -1);
  assert.equal(rowKey({ id: "", t: 1700000000000 }), "t:1700000000000", "no id: the close time");
  assert.equal(indexOfKey([{ id: "", t: 5 }, { id: "", t: 9 }], "t:9"), 1);
  const p = src("pages/Performance.tsx");
  assert.match(p, /const \[selected, setSelected\] = useState<string \| null>\(null\);/, "the selection is a key, not an index");
  assert.match(p, /const found = indexOfKey\(rows, selected\);/);
  assert.match(p, /useEffect\(\(\) => \{ if \(selected != null && found < 0\) setSelected\(null\); \}, \[selected, found\]\);/, "gone from the window, it clears");
  assert.match(p, /const select = \(i: number \| null\) => setSelected\(i == null \|\| !rows\[i\] \? null : rowKey\(rows\[i\]\)\);/);
  assert.doesNotMatch(p.slice(p.indexOf("function EquityDrawdownCharts"), p.indexOf("type Policy =")), /useState<number \| null>/, "no index state left");
});

test("PC10 the keys: → next (first from none), ← previous (last from none), Home, End, Esc clears; others pass", () => {
  assert.deepEqual(keyStep("ArrowRight", null, 5), { active: 0, handled: true });
  assert.deepEqual(keyStep("ArrowRight", 2, 5), { active: 3, handled: true });
  assert.deepEqual(keyStep("ArrowRight", 4, 5), { active: 4, handled: true }, "stops at the last");
  assert.deepEqual(keyStep("ArrowLeft", null, 5), { active: 4, handled: true });
  assert.deepEqual(keyStep("ArrowLeft", 2, 5), { active: 1, handled: true });
  assert.deepEqual(keyStep("ArrowLeft", 0, 5), { active: 0, handled: true }, "stops at the first");
  assert.deepEqual(keyStep("Home", 3, 5), { active: 0, handled: true });
  assert.deepEqual(keyStep("End", 1, 5), { active: 4, handled: true });
  assert.deepEqual(keyStep("Escape", 2, 5), { active: null, handled: true });
  assert.deepEqual(keyStep("Escape", null, 5), { active: null, handled: false }, "Esc with nothing selected is the browser's");
  assert.deepEqual(keyStep("Tab", 2, 5), { active: 2, handled: false });
  assert.deepEqual(keyStep("a", null, 5), { active: null, handled: false });
  assert.deepEqual(keyStep("ArrowRight", null, 0), { active: null, handled: false }, "no trades, nothing to step");
  assert.deepEqual(keyStep("End", null, 0), { active: null, handled: false });
});

test("PC11 the card: UTC and local close, which trade of how many, its R, equity, peak and drawdown; where it sits", () => {
  const rows = equityRows(POINTS);
  const f = cardFields(rows, 2);
  assert.deepEqual({ ...f, local: undefined }, {
    utc: "Nov 09 10:00 UTC", local: undefined, ordinal: "Trade 3 of 5", trade: "−0.50R", equity: "+0.50R", peak: "+2.00R", dd: "−1.50R",
    live: "Trade 3 of 5, closed Nov 09 10:00 UTC: trade −0.50R, equity at +0.50R, peak +2.00R, drawdown −1.50R."
  });
  assert.equal(f.local, localStamp(rows[2].t));
  assert.equal(cardFields(rows, 0).ordinal, "Trade 1 of 5");
  assert.equal(cardFields(rows, 4).equity, "+2.20R");
  assert.equal(cardFields(rows, null), null);
  assert.equal(cardFields(rows, 5), null);
  // Beside the point: right when it fits, else left; inside the equity chart's height.
  assert.deepEqual(cardPosition(100, 150, 1172, 240), { left: 114, top: 90 });
  assert.deepEqual(cardPosition(1000, 150, 1172, 240), { left: 750, top: 90 }, "left of a point near the right edge");
  assert.deepEqual(cardPosition(922, 30, 1172, 240), { left: 936, top: 0 }, "922 + 14 + 236 = 1172 still fits; the top clamps at 0");
  assert.deepEqual(cardPosition(100, 239, 1172, 240), { left: 114, top: 144 }, "the bottom clamps at eqH − 96");
  assert.deepEqual(cardPosition(200, 100, 300, 240), { left: 0, top: 40 }, "never off the left");
  const m = chartModel(POINTS, now - 30 * DAY, now, 1172);
  assert.equal(chartSummary(m, "TP1", 30),
    "Equity curve, TP1: +2.20R after 5 closed trades in 30 days, peak +3.00R; drawdown max −1.50R on Nov 09. Left and right arrow keys step through the trades.");
  assert.match(chartSummary(chartModel(fromTrades([1]), now - 7 * DAY, now, 1172), "TP2", 7), /after 1 closed trade in 7 days, peak \+1\.00R; drawdown none\./);
});

test("PC12 forced colours, the drawdown label's halo, and the smaller review fixes", () => {
  const css = src("index.css");
  const fc = css.slice(css.indexOf("@media (forced-colors: active) {"));
  assert.ok(fc.length > 40, "a forced-colours block in index.css (no inline style for a media query)");
  assert.match(fc, /\.chart-text \{ fill: CanvasText; \}/);
  assert.match(fc, /\.chart-halo \{ stroke: Canvas; \}/);
  assert.match(fc, /\.chart-grid \{ stroke: GrayText; \}/);
  assert.match(fc, /\.chart-zero, \.chart-cross \{ stroke: CanvasText; \}/);
  assert.match(fc, /\.chart-swatch \{ forced-color-adjust: none; \}/);
  const p = src("pages/Performance.tsx");
  const chart = p.slice(p.indexOf("function EquityDrawdownCharts"), p.indexOf("type Policy ="));
  assert.match(chart, /fontFamily: "JetBrains Mono, ui-monospace, monospace", className: "chart-text"/, "all axis text");
  for (const [re, why] of [[/stroke=\{GRID\}(?! className="chart-grid")/, "grid"], [/stroke=\{CROSS\}(?! className="chart-cross")/, "crosshair"], [/stroke=\{ZERO\}(?! className="chart-zero")/, "zero"], [/stroke=\{T\.panel\} strokeWidth=\{2\}(?! className="chart-halo")/, "marker ring"]]) {
    assert.doesNotMatch(chart, re, `every ${why} carries its forced-colours class`);
  }
  assert.equal((chart.match(/className=\{v === 0 \? "chart-zero" : "chart-grid"\}/g) ?? []).length, 2, "the R grid and zero line in both charts");
  assert.match(chart, /fill=\{T\.fg\} fontFamily=\{axisText\.fontFamily\} className="chart-text">\{rValue\(last\.r\)\}/, "the end value");
  assert.match(p, /<span aria-hidden="true" className="chart-swatch inline-block border-t" style=\{\{ width: w, height: 0, borderTopWidth: h, borderTopColor: color, opacity \}\} \/>/, "swatches are borders");
  assert.doesNotMatch(p, /background: color/);
  // The deepest value reads over the line: a panel-coloured stroke painted under the fill.
  assert.match(chart, /stroke=\{T\.panel\} strokeWidth=\{3\} strokeLinejoin="round" paintOrder="stroke" className="chart-text chart-halo">\{m\.ddMark\.text\}/);
  assert.match(chart, /Point at or tap the chart to see a trade\./, "a mouse layout points");
  assert.doesNotMatch(p, /"Tap the chart/);
  assert.match(p, /<Panel\n\s*title="Equity curve"/, "sentence case");
  assert.doesNotMatch(p, /title="Equity Curve"/);
  assert.match(chart, /<Badge tone="plain">\{policyLabel\}<\/Badge>/, "a policy name is no status");
  assert.doesNotMatch(chart, /<Badge tone="cyan">/);
});
