import test from "node:test";
import assert from "node:assert/strict";
import { readHud } from "../src/hud-reading.mjs";

test("prophet reading emits sentences, no raw codes echoed as identifiers", () => {
  const r = readHud("prophet", { cshi_score: 0.7, cycle_intensity: 3, d_enc: -1, t_enc: 4 });
  assert.equal(r.available, true);
  assert.ok(r.lines.some(l => /Market composite score/.test(l)));
  assert.ok(r.lines.some(l => /Cycle intensity/.test(l)));
});

test("trade_management reading includes alignment", () => {
  const r = readHud("trade_management", { zone_state_code: 2, kww_zscore: 1.2, prophet_dir: 1, gmi_dir: -1, conflict: true, gate: -1 });
  assert.ok(r.lines.some(l => /Prophet direction 1/.test(l)));
});

test("unknown hud falls back to numeric/boolean fields only", () => {
  const r = readHud("unknown_agent", { foo: 5, bar: true, baz: "should_not_echo" });
  assert.equal(r.lines.length, 2);
  assert.ok(!r.lines.some(l => /should_not_echo/.test(l)));
});

test("empty data is unavailable", () => {
  const r = readHud("prophet", {});
  assert.equal(r.available, false);
});
