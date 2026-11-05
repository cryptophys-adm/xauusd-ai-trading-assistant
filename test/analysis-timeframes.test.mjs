import test from "node:test";
import assert from "node:assert/strict";
import { analysisAllowedForTimeframe, timeframeKey, isHudSource } from "../src/evidence-fusion.mjs";

test("only configured analysis timeframes may start the AI chain (production default H1)", () => {
  for (const tf of ["60", "1H", "H1", "60m"]) assert.equal(analysisAllowedForTimeframe(tf), true, tf);
  for (const tf of ["5", "M5", "15", "M15", "240", "D", "", "garbage", undefined, null]) assert.equal(analysisAllowedForTimeframe(tf), false, String(tf));
});

test("ANALYSIS_TIMEFRAMES can add timeframes (preview keeps its M5 fixture chain)", () => {
  assert.equal(analysisAllowedForTimeframe("M5", "60,5"), true);
  assert.equal(analysisAllowedForTimeframe("5", "60,5"), true);
  assert.equal(analysisAllowedForTimeframe("15", "60,5"), false);
  assert.equal(analysisAllowedForTimeframe("60", ""), true, "empty config falls back to H1");
});

test("timeframe aliases normalise", () => {
  assert.equal(timeframeKey("15"), "M15");
  assert.equal(timeframeKey("60"), "H1");
  assert.equal(timeframeKey("x"), "");
});

test("HUD comparator sources never start the AI chain", () => {
  assert.equal(isHudSource("prophet_r38_hud"), true);
  assert.equal(isHudSource("gmi_v12_70_hud"), true);
  for (const s of ["prophet_r38", "prophet_r37_ssot", "gmi_v12_70", "", undefined]) assert.equal(isHudSource(s), false, String(s));
});

test("reconcile tasks run parity on every timeframe but start the AI chain only on analysis timeframes", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  for (const handler of ["processWebhookReconcileTask", "processLocalCalculationReconcileTask"]) {
    const start = source.indexOf(`async function ${handler}(`);
    assert.ok(start > 0, handler);
    const body = source.slice(start, source.indexOf("\n}\n", start));
    const reconcile = body.indexOf("reconcileLocalComputation(env, task.candle_key)");
    const gate = body.indexOf('analysisAllowedForTimeframe(task.timeframe, env.ANALYSIS_TIMEFRAMES || "60")');
    const analysis = body.indexOf("runAnalysis(");
    assert.ok(reconcile >= 0 && gate > reconcile && analysis > gate, handler);
  }
});
