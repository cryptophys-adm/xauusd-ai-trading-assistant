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
