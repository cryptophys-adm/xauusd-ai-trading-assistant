import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCandidate, formatPrReport, parseArgs } from "../scripts/propose-learned-promotion.mjs";

test("P3-M5 parseArgs parses CLI parameters correctly", () => {
  const args = parseArgs(["--check", "--items", "caution_1@1,reminder_2@2", "--export", "exp.json", "--tuning", "tun.json", "--apply"]);
  assert.equal(args.check, true);
  assert.equal(args.apply, true);
  assert.deepEqual(args.items, ["caution_1@1", "reminder_2@2"]);
  assert.equal(args.exportPath, "exp.json");
  assert.equal(args.tuningPath, "tun.json");
});

test("P3-M5 validateCandidate enforces empirical shadow verdict and advisory purity", () => {
  const valid = {
    item_id: "caution_fake_breakout",
    version: 1,
    kind: "caution",
    label: "Asian Session False Breakout",
    text: "M15 Asian high sweeps followed by candle closure inside range indicate rejection.",
  };
  assert.equal(validateCandidate(valid, "better_than_active: ready for owner review"), true);

  // Verdict not satisfied
  assert.throws(() => {
    validateCandidate(valid, "inconclusive: holdout regression");
  }, /has not satisfied empirical verification/);

  // Forbidden terms
  const tainted = { ...valid, text: "Buy market order with stop loss at level" };
  assert.throws(() => {
    validateCandidate(tainted, "better_than_active");
  }, /Forbidden financial execution term/);
});

test("P3-M5 formatPrReport generates structured PR proposal with statistical proof", () => {
  const item = {
    item_id: "role_m15_bias",
    version: 2,
    kind: "role_reminder",
    label: "Prophet Structure Drift",
    audience: "room",
    text: "Prioritize higher-timeframe confluence before issuing directional bias.",
  };
  const report = formatPrReport(item, "better_than_active", { sample_size: 75, holdout_bars: 120 });
  assert.ok(report.includes("Empirical Shadow Performance Proof"));
  assert.ok(report.includes("Discovery Sample**: 75 bars"));
  assert.ok(report.includes("Holdout Verification**: 120 bars"));
  assert.ok(report.includes("Contract & Safety Compliance"));
});
