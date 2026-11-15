// The public analysis (src/public-analysis.mjs): what cryptophys-cta may show in real time. Owner 2026-11-15:
// "tidak perlu dicantumkan sumber playbook, cukup nama metrics sumbernya": a zone carries the names of its
// metrics, never a price or a trade word among them.
import test from "node:test";
import assert from "node:assert/strict";
import { publicAnalysis, zoneMetrics, analysisLeaks } from "../src/public-analysis.mjs";

const zone = (members, extra = {}) => ({ low: 3898, high: 3902.4, role: "resistance", strength: "strong", sources: 4, members, ...extra });

test("a zone's metric names: its heaviest levels by name, unique, at most three, no price and no trade word", () => {
  assert.deepEqual(zoneMetrics(zone([
    { label: "4H Camarilla H4", weight: 1 }, { label: "daily pivot", weight: 1 }, { label: "daily pivot", weight: 0.9 },
    { label: "round 3900", weight: 0.8 }, { label: "1H swing high", weight: 0.7 }
  ])), ["4H Camarilla H4", "daily pivot", "round number"]);
  assert.deepEqual(zoneMetrics(zone([{ label: "4H Ascending Triangle: measured target" }, { label: "1H entry 3901.5 level" }])), ["4H Ascending Triangle: measured projection"]);
  assert.deepEqual(zoneMetrics(zone([])), []);
  assert.deepEqual(zoneMetrics(null), []);
});

test("the public analysis carries each zone's metric names and nothing a trade needs", () => {
  const a = publicAnalysis({
    price: 3884.7, atr_h1: 6.2,
    candidates: [
      zone([{ label: "4H Camarilla H4" }, { label: "weekly pivot" }, { label: "1H bearish order block top" }]),
      zone([{ label: "daily CPR bottom" }, { label: "previous day low" }], { low: 3861.1, high: 3866.8, role: "support" })
    ],
    patterns: []
  }, { now: Date.parse("2026-11-16T06:09:00Z") });
  assert.deepEqual(a.zones.map((z) => z.metrics), [["4H Camarilla H4", "weekly pivot", "1H bearish order block top"], ["daily CPR bottom", "previous day low"]]);
  assert.deepEqual(analysisLeaks(a), []);
  assert.doesNotMatch(JSON.stringify(a.zones.map((z) => z.metrics)), /\b\d{3,5}\b|entry|stop|target|take profit/i);
});

test("a pattern carries its two lines as drawn: start and last bar times, each line's price at both ends", async () => {
  const { detectPatterns } = await import("../src/chart-patterns.mjs");
  // A symmetrical triangle: falling highs, rising lows, on H4 bars with close times.
  const bars = [];
  const t0 = Date.parse("2026-11-01T04:00:00Z");
  for (let i = 0; i < 80; i += 1) {
    const amp = 40 * (1 - i / 100), wave = Math.sin(i / 3);
    const mid = 3900 + amp * wave;
    bars.push({ high: mid + 3, low: mid - 3, close: mid, open: mid, close_time: new Date(t0 + i * 4 * 3_600_000).toISOString() });
  }
  const found = detectPatterns(bars, { recent: 80 });
  const withLines = found.filter((p) => p.line_from);
  assert.ok(withLines.length, `a pattern with lines: ${found.map((p) => p.id).join(", ")}`);
  for (const p of withLines) {
    assert.ok(Date.parse(p.line_from) < Date.parse(p.line_to));
    assert.equal(p.line_to, bars.at(-1).close_time.replace(".000Z", ".000Z"));
    assert.ok(Number.isFinite(p.upper_from) && Number.isFinite(p.lower_from));
  }
  const a = publicAnalysis({ price: 3900, candidates: [], patterns: withLines.map((p) => ({ tf: "240", ...p, status: "forming" })) }, { now: Date.parse("2026-11-14T10:00:00Z") });
  const pub = a.patterns[0];
  assert.deepEqual(Object.keys(pub.lines), ["from", "to", "upper", "lower"]);
  assert.equal(pub.lines.upper[1], pub.upper, "the upper line ends at the pattern's upper level");
  assert.equal(pub.lines.lower[1], pub.lower);
  assert.deepEqual(analysisLeaks(a), []);
  // Without bar times (older data), no lines: the card draws the levels flat.
  const flat = publicAnalysis({ price: 3900, candidates: [], patterns: [{ tf: "240", id: "triangle_symmetrical", status: "forming", upper: 3920, lower: 3880 }] });
  assert.equal(flat.patterns[0].lines, undefined);
});
