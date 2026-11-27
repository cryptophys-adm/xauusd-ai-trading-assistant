// BP1 (2026-11-27, CTA bug report): a confirmed H1 gap (no measure, target null) went out on Threads as
// "Measured projection: 0.00": public-analysis' r2 read Number(null) as 0. PublicProjection never emits a non-positive,
// wrong-side or absurd projection, and a null level never becomes 0.
import test from "node:test";
import assert from "node:assert/strict";
import { publicAnalysis, publicProjectionOf, PROJECTION_MAX_HEIGHTS } from "../src/public-analysis.mjs";

const pat = (o) => ({ tf: "60", id: "gap", status: "confirmed", direction: 1, upper: 3632, lower: 3627, target: null, ...o });

test("BP1-1. the production case: a confirmed gap without a measure has no projection (not 0)", () => {
  const a = publicAnalysis({ price: 3650, candidates: [], patterns: [pat({})] });
  assert.equal(a.patterns.length, 1);
  assert.equal(a.patterns[0].projection, null);
});

test("BP1-2. only a positive target beyond the broken line and within the reach is shown", () => {
  assert.equal(publicProjectionOf(pat({ target: 3640 })), 3640, "up: above the upper line");
  assert.equal(publicProjectionOf(pat({ direction: -1, target: 3620 })), 3620, "down: below the lower line");
  assert.equal(publicProjectionOf(pat({ target: 0 })), null, "zero");
  assert.equal(publicProjectionOf(pat({ target: -5 })), null, "negative");
  assert.equal(publicProjectionOf(pat({ target: "" })), null, "empty string");
  assert.equal(publicProjectionOf(pat({ target: 3630 })), null, "inside the pattern");
  assert.equal(publicProjectionOf(pat({ target: 3620 })), null, "up pattern, target below");
  assert.equal(publicProjectionOf(pat({ direction: -1, target: 3640 })), null, "down pattern, target above");
  assert.equal(publicProjectionOf(pat({ target: 3632 + 5 * PROJECTION_MAX_HEIGHTS + 1 })), null, "absurdly far");
  assert.equal(publicProjectionOf(pat({ status: "forming", target: 3640 })), null, "forming");
  assert.equal(publicProjectionOf(pat({ direction: 0, target: 3640 })), null, "no direction");
});

test("BP1-3. a pattern or zone with a null level is left out instead of drawn at 0", () => {
  const a = publicAnalysis({ price: 3650, candidates: [{ low: null, high: 3660, role: "resistance" }, { low: 3640, high: 3645, role: "support" }],
    patterns: [pat({ upper: null }), pat({ id: "double_top", lower: null })] });
  assert.equal(a.patterns.length, 0);
  assert.deepEqual(a.zones.map((z) => [z.low, z.high]), [[3640, 3645]]);
  assert.equal(publicAnalysis({ price: null, atr_h1: undefined }).price, null, "a missing price stays null");
});
