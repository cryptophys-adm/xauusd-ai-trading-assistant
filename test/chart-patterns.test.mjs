// Owner 2026-11-12: "adopsi semua yang ada di buku untuk main muscle knowledge Projection Agent"; "Fibonacci,
// cone, dan trendline, dan tambahan 53 pola chart ... dan 10 pola event". The catalogue follows Bulkowski's
// "Encyclopedia of Chart Patterns" by chapter; the detectors and these fixtures are written here from scratch
// (no text and no statistics of the book), sized in the chart's own average range.
import test from "node:test";
import assert from "node:assert/strict";
import { path, withBars } from "./support/pattern-fixtures.mjs";
import { PATTERN_CATALOG, detectPatterns, patternLevels, patternInfo, zigzag, normBars } from "../src/chart-patterns.mjs";
import { buildKeyLevels, chartPatterns, familyOf } from "../src/key-level-agent.mjs";
import { chartPatternsMode } from "../src/strategy-engine.mjs";
import { slimInputs } from "../src/strategy-inputs.mjs";
import { READERS } from "../src/level-readers.mjs";

const F = {};
// --- two lines
F.rectangle_top = path([[0, 80], [10, 100], [14, 90], [18, 100], [22, 90], [26, 100], [30, 90], [34, 100], [37, 95]]);
F.rectangle_bottom = path([[0, 120], [10, 100], [14, 110], [18, 100], [22, 110], [26, 100], [30, 110], [34, 100], [37, 105]]);
F.triangle_ascending = path([[0, 70], [10, 100], [14, 84], [18, 100], [22, 89], [26, 100], [30, 94], [34, 100], [36, 97]]);
F.triangle_descending = path([[0, 130], [10, 100], [14, 116], [18, 100], [22, 111], [26, 100], [30, 106], [34, 100], [36, 103]]);
F.triangle_symmetrical = path([[0, 70], [10, 110], [14, 90], [18, 107], [22, 93], [26, 104], [30, 96], [34, 101], [36, 99]]);
F.broadening_top = path([[0, 80], [10, 102], [14, 98], [18, 105], [22, 95], [26, 108], [30, 92], [34, 111], [37, 100]]);
F.broadening_bottom = path([[0, 120], [10, 98], [14, 102], [18, 95], [22, 105], [26, 92], [30, 108], [34, 89], [37, 100]]);
F.broadening_right_angled_ascending = path([[0, 110], [10, 96], [14, 100], [18, 96], [22, 104], [26, 96], [30, 108], [34, 96], [37, 104]]);
F.broadening_right_angled_descending = path([[0, 90], [10, 104], [14, 100], [18, 104], [22, 96], [26, 104], [30, 92], [34, 104], [37, 96]]);
F.wedge_rising = path([[0, 70], [10, 100], [14, 90], [18, 104], [22, 96], [26, 107], [30, 101], [34, 109], [36, 106]]);
F.wedge_falling = path([[0, 130], [10, 100], [14, 110], [18, 96], [22, 104], [26, 93], [30, 99], [34, 91], [36, 94]]);
F.broadening_wedge_ascending = path([[0, 90], [10, 100], [14, 98], [18, 104], [22, 100], [26, 109], [30, 102], [34, 115], [37, 106]]);
F.broadening_wedge_descending = path([[0, 110], [10, 100], [14, 102], [18, 96], [22, 100], [26, 91], [30, 98], [34, 85], [37, 94]]);
F.diamond_top = path([[0, 70], [10, 102], [13, 98], [16, 106], [19, 94], [22, 110], [25, 90], [28, 106], [31, 95], [34, 102], [36, 99]]);
F.diamond_bottom = path([[0, 130], [10, 98], [13, 102], [16, 94], [19, 106], [22, 90], [25, 110], [28, 94], [31, 105], [34, 98], [36, 101]]);


const mirror = (pts) => pts.map(([i, p]) => [i, 200 - p]);
const flip = (bars) => bars.map((b) => ({ ...b, open: 200 - b.open, close: 200 - b.close, high: 200 - b.low, low: 200 - b.high }));
// --- peaks
const DT = {
  adam_adam: [[0, 70], [8, 86], [11, 100], [14, 88], [17, 100], [20, 90], [21, 90]],
  adam_eve: [[0, 70], [8, 86], [11, 100], [14, 88], [16, 96], [20, 100], [24, 96], [26, 90]],
  eve_adam: [[0, 70], [4, 96], [8, 100], [12, 96], [14, 88], [17, 100], [20, 90], [21, 90]],
  eve_eve: [[0, 70], [4, 96], [8, 100], [12, 96], [14, 88], [16, 96], [20, 100], [24, 96], [26, 90]]
};
for (const [k, pts] of Object.entries(DT)) { F[`double_top_${k}`] = path(pts); F[`double_bottom_${k}`] = path(mirror(pts)); }
const TT = [[0, 70], [8, 100], [12, 88], [16, 100], [20, 88], [24, 100], [28, 90]];
F.triple_top = path(TT); F.triple_bottom = path(mirror(TT));
const HS = [[0, 70], [8, 95], [12, 86], [16, 104], [20, 86], [24, 95], [28, 88]];
F.head_and_shoulders_top = path(HS); F.head_and_shoulders_bottom = path(mirror(HS));
const HSC = [[0, 70], [6, 94], [9, 86], [12, 104], [15, 97], [18, 104], [21, 86], [24, 94], [27, 88]];
F.head_and_shoulders_top_complex = path(HSC); F.head_and_shoulders_bottom_complex = path(mirror(HSC));
const TFP = [[0, 70], [8, 110], [12, 98], [16, 105], [20, 94], [24, 100], [28, 92]];
F.three_falling_peaks = path(TFP); F.three_rising_valleys = path(mirror(TFP));
// --- two tall bars
const down = path([[0, 120], [20, 100], [26, 106]]);
F.pipe_bottom = withBars(down, { 19: { low: 92, high: 101.5, close: 100 }, 20: { low: 92, high: 101.5, open: 100, close: 101 } });
F.pipe_top = flip(F.pipe_bottom);
F.horn_bottom = withBars(down, { 18: { low: 92, high: 102.5, close: 101.5 }, 19: { low: 97, high: 102, open: 101.5, close: 100.5 }, 20: { low: 92, high: 101.5, open: 100.5, close: 101 } });
F.horn_top = flip(F.horn_bottom);
// --- a pole and a pause
F.flag = path([[0, 100], [10, 100.5], [15, 112], [23, 110]], { wick: 1 });
F.flag_high_and_tight = path([[0, 100], [10, 100.5], [15, 130], [23, 127]]);
F.pennant = path([[0, 100], [10, 100], [15, 75], [17, 79], [19, 75.5], [21, 78], [23, 76.3], [25, 77.4], [27, 76.8], [28, 77]]);
// --- gaps
F.gap = withBars(path([[0, 100], [10, 104], [11, 110], [20, 113]]), { 11: { open: 109, low: 108.5 } });
F.island_reversal = withBars(path([[0, 100], [10, 104], [11, 110], [13, 110], [14, 103], [20, 98]]), { 11: { open: 109, low: 108.5 }, 14: { open: 103.2, high: 103.5 } });
F.island_long = withBars(path([[0, 100], [10, 104], [11, 110], [19, 110], [20, 103], [26, 98]]), { 11: { open: 109, low: 108.5 }, 20: { open: 103.2, high: 103.5 } });
// --- legs
const MM = [[0, 104], [3, 100], [13, 130], [18, 115], [21, 121]];
F.measured_move_up = path(MM); F.measured_move_down = path(mirror(MM));
// --- curves
const bowl = Array.from({ length: 41 }, (_, i) => [i, 100 + 0.05 * (i - 20) ** 2]);
F.rounding_bottom = path(bowl); F.rounding_top = path(mirror(bowl));
const CUP = [[0, 85], [8, 100], [12, 92], [16, 87], [20, 85], [24, 87], [28, 92], [32, 100], [36, 95], [38, 97]];
F.cup_with_handle = path(CUP); F.cup_with_handle_inverted = path(mirror(CUP));
const SA = [[0, 92], [5, 100], [9, 94], [12, 91], [15, 90], [18, 91], [21, 94], [27, 108], [30, 104]];
F.scallop_ascending = path(SA); F.scallop_descending_inverted = path(mirror(SA));
const SD = [[0, 100], [5, 110], [9, 101], [12, 97], [15, 95], [18, 97], [21, 100], [25, 102], [28, 97]];
F.scallop_descending = path(SD); F.scallop_ascending_inverted = path(mirror(SD));
const BARR = [[0, 103], [4, 102], [8, 107], [12, 106], [16, 111], [20, 110], [24, 116], [30, 140], [36, 146], [44, 128], [49, 127]];
F.bump_and_run_top = path(BARR); F.bump_and_run_bottom = path(mirror(BARR));
// --- events
const DCB = [[0, 100], [19, 101], [20, 80], [26, 88], [30, 86]];
F.dead_cat_bounce = path(DCB); F.dead_cat_bounce_inverted = path(mirror(DCB));
const REL = path([[0, 100], [29, 101], [30, 106], [33, 108]]);
const EV = { event_surprise_bullish: [{ time: REL[30].close_time.replace(":00:00", ":30:00").replace("T" + REL[30].close_time.slice(11, 13), "T" + REL[29].close_time.slice(11, 13)), gold_direction: 1, title: "CPI" }] };
F.event_surprise_bullish = REL; F.event_surprise_bearish = flip(REL);
EV.event_surprise_bearish = [{ ...EV.event_surprise_bullish[0], gold_direction: -1 }];
F.event_flag = path([[0, 100], [29, 100.5], [30, 110], [37, 108.5]]);
EV.event_flag = EV.event_surprise_bullish;

const find = (id, opts = {}) => detectPatterns(F[id], { max: 12, events: EV[id] || [], ...opts }).find((p) => p.id === id);

test("C1. the catalogue: the book's 53 chart patterns and 10 event patterns, by chapter; five event patterns have no gold event", () => {
  assert.equal(PATTERN_CATALOG.length, 63);
  assert.deepEqual(PATTERN_CATALOG.map((p) => p.n), Array.from({ length: 63 }, (_, i) => i + 1));
  assert.equal(new Set(PATTERN_CATALOG.map((p) => p.id)).size, 63);
  assert.equal(PATTERN_CATALOG.filter((p) => p.part === "chart").length, 53);
  assert.equal(PATTERN_CATALOG.filter((p) => p.part === "event").length, 10);
  assert.deepEqual(PATTERN_CATALOG.filter((p) => !p.applies).map((p) => p.id), ["fda_drug_approval", "same_store_sales_bad", "same_store_sales_good", "stock_downgrade", "stock_upgrade"], "stock-only events");
  assert.equal(patternInfo("double_bottom_adam_eve").n, 14);
  assert.equal(patternInfo("nope"), null);
});

test("C2. every pattern that applies to gold is recognised on its own fixture (53 chart patterns, 5 event patterns)", () => {
  const applies = PATTERN_CATALOG.filter((p) => p.applies);
  assert.equal(applies.length, 58);
  for (const p of applies) {
    assert.ok(F[p.id], `a fixture for ${p.id}`);
    const hit = find(p.id);
    assert.ok(hit, `${p.id} (chapter ${p.n}) not recognised`);
    assert.equal(hit.chapter, p.n);
    assert.ok(hit.upper > 0 || hit.lower > 0, `${p.id} gives a breakout line`);
  }
});

test("C3. breakout, measure rule, busted pattern, target reached, and age", () => {
  // A double top: peaks 100.3, valley 87.7, height 12.6.
  const base = [[0, 70], [8, 86], [11, 100], [14, 88], [17, 100]];
  const forming = detectPatterns(path([...base, [20, 90], [21, 90]]), { max: 12 }).find((p) => p.id === "double_top_adam_adam");
  assert.deepEqual([forming.status, forming.direction, forming.upper, forming.lower, forming.target], ["forming", 0, 100.3, 87.7, null]);
  const broke = detectPatterns(path([...base, [20, 88], [22, 84]]), { max: 12 }).find((p) => p.id === "double_top_adam_adam");
  assert.deepEqual([broke.status, broke.direction, broke.target], ["confirmed", -1, 75.1], "a close below the valley: the height projected down from it");
  // (Once price is back at the second peak that peak reads wide, so the shape name may change; the top is the same.)
  const busted = detectPatterns(path([...base, [19, 96], [23, 103]]), { max: 12 }).find((p) => p.id.startsWith("double_top"));
  assert.deepEqual([busted.status, busted.direction, busted.target], ["busted", 1, 112.9], "a close above the peaks busts a top: it then reads upward");
  assert.equal(detectPatterns(path([...base, [20, 88], [26, 74], [28, 76]]), { max: 12 }).find((p) => p.id.startsWith("double_top")), undefined, "the target was reached: the pattern is done");
  assert.equal(detectPatterns(path([...base, [20, 90], [40, 91]]), { max: 12 }).find((p) => p.id.startsWith("double_top")), undefined, "its last turn is more than 15 bars old");
  // Adam is a narrow spike, Eve a wide turn.
  assert.ok(find("double_top_adam_eve") && find("double_top_eve_adam") && find("double_bottom_eve_eve"));
});

test("C4. the levels a pattern gives: its breakout lines while forming; the broken line and the measured target after", () => {
  const forming = patternLevels([{ name: "ascending triangle", status: "forming", direction: 0, upper: 100, lower: 96, target: null }]);
  assert.deepEqual(forming.map((l) => [l.price, l.label, l.weight, l.kind]), [[100, "ascending triangle: upper breakout line", 0.6, "pattern"], [96, "ascending triangle: lower breakout line", 0.6, "pattern"]]);
  const up = patternLevels([{ name: "ascending triangle", status: "confirmed", direction: 1, upper: 100, lower: 96, target: 110 }]);
  assert.deepEqual(up.map((l) => [l.price, l.label, l.weight]), [[100, "ascending triangle: broken upper line (throwback level)", 0.8], [110, "ascending triangle: measured target", 0.7], [96, "ascending triangle: lower line", 0.5]]);
  const bust = patternLevels([{ name: "double top (Adam & Adam)", status: "busted", direction: 1, upper: 100, lower: 88, target: 112 }]);
  assert.deepEqual(bust.slice(0, 2).map((l) => [l.label, l.weight]), [["busted double top (Adam & Adam): broken upper line (throwback level)", 0.8], ["busted double top (Adam & Adam): measured target", 0.6]]);
  assert.deepEqual(patternLevels(null), []);
  assert.deepEqual(patternLevels([{ name: "gap", status: "confirmed", direction: 1, upper: 108.5, lower: 104.3, target: null }]).map((l) => l.price), [108.5, 104.3], "no target, no target level");
});

test("C5. the event patterns read released figures with a direction for gold; without them only the dead-cat bounces remain", () => {
  assert.equal(detectPatterns(F.event_surprise_bullish, { max: 12 }).find((p) => p.id.startsWith("event_")), undefined, "no release, no release pattern");
  assert.equal(detectPatterns(F.event_surprise_bullish, { max: 12, events: [{ time: EV.event_surprise_bullish[0].time, gold_direction: 0, title: "x" }] }).find((p) => p.id.startsWith("event_")), undefined, "a release without a direction is no event");
  const bull = find("event_surprise_bullish");
  assert.deepEqual([bull.event, bull.upper, bull.lower], ["CPI", 106.3, 100.7], "the release bar's high and low are the breakout lines");
  assert.ok(find("dead_cat_bounce") && find("dead_cat_bounce_inverted"), "the event is the bar that moved price");
  assert.equal(find("event_flag").event, "CPI");
});

test("C6. the Projection Agent: pattern levels count in its family, under its name, and CHART_PATTERNS_MODE turns them off", () => {
  assert.match(READERS.projection.role, /chart patterns/);
  assert.equal(familyOf("pattern"), "projection");
  const bars = { H1: F.triangle_ascending };
  assert.deepEqual(Object.keys(chartPatterns(bars)), ["60"]);
  const on = buildKeyLevels({ bars, price: 97, atrH1: 4 });
  const ids = on.patterns.map((p) => p.id);
  assert.ok(ids.includes("triangle_ascending"), JSON.stringify(ids));
  assert.deepEqual([on.patterns[0].tf, on.patterns[0].chart], ["60", "1H"]);
  const members = on.zones.flatMap((z) => z.members).filter((m) => m.kind === "pattern");
  assert.ok(members.length >= 2 && members.every((m) => m.reader === "projection" && m.label.startsWith("1H ")), "the levels are the Projection Agent's, named by chart");
  assert.ok(on.readers.projection.levels >= members.length);
  const off = buildKeyLevels({ bars, price: 97, atrH1: 4, patterns: "off" });
  assert.deepEqual([off.patterns, off.zones.flatMap((z) => z.members).filter((m) => m.kind === "pattern")], [[], []]);
  assert.deepEqual([chartPatternsMode({}), chartPatternsMode({ CHART_PATTERNS_MODE: "OFF" }), chartPatternsMode({ CHART_PATTERNS_MODE: "x" })], ["on", "off", "on"]);
  // One zone counts the projection family once per chart, however many patterns stack there.
  const stacked = buildKeyLevels({ bars: { H1: F.rectangle_top }, price: 95, atrH1: 4 });
  for (const z of stacked.zones) assert.ok(z.families.filter((f) => f === "projection").length <= 1);
  // The stored inputs keep the released figures, so the replay sees the same event patterns.
  assert.deepEqual(slimInputs({ releases: [{ title: "CPI", time: "2026-11-10T13:30:00.000Z", gold_direction: -1, extra: 1 }] }).releases, [{ title: "CPI", time: "2026-11-10T13:30:00.000Z", gold_direction: -1 }]);
});

test("C7. never throws: too few bars, broken bars, a flat series; at most five patterns per chart, the broken-out first", () => {
  assert.deepEqual(detectPatterns(null), []);
  assert.deepEqual(detectPatterns([{ high: 1 }, { foo: 2 }]), []);
  assert.deepEqual(detectPatterns(path([[0, 100], [10, 101]])), [], "fewer than 20 bars");
  assert.deepEqual(detectPatterns(Array.from({ length: 40 }, () => ({ high: 100, low: 100, close: 100 }))), [], "no range, no pattern");
  assert.equal(normBars([{ high: 2, low: 3, close: 2 }, { high: 3, low: 2, close: 2.5 }]).length, 1, "a bar with its high below its low is dropped");
  const many = detectPatterns(F.diamond_top);
  assert.ok(many.length <= 5);
  const firstForming = many.findIndex((p) => p.status === "forming");
  assert.ok(firstForming < 0 || many.slice(firstForming).every((p) => p.status === "forming"), "confirmed and busted patterns come first");
  const piv = zigzag(normBars(F.triple_top));
  assert.ok(piv.every((q, i) => i === 0 || q.t !== piv[i - 1].t), "the turning points alternate");
});
