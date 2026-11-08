import test from "node:test";
import assert from "node:assert/strict";
import { engineTimeframe, engineBase, shapeRegistry } from "../src/parity-view.mjs";

test("engine ids map to their timeframe and base", () => {
  assert.equal(engineTimeframe("prophet"), "1H");
  assert.equal(engineTimeframe("gmi_m15"), "15m");
  assert.equal(engineTimeframe("prophet_m5"), "5m");
  assert.equal(engineTimeframe("gmi_d1"), "D1");
  assert.equal(engineBase("gmi_h4"), "gmi");
});

test("the registry view marks the current identity per engine and keeps totals and the last detail", () => {
  const rows = [
    { engine: "prophet", status: "candidate", consecutive_matches: 4, total_matches: 4, total_mismatches: 0, total_incomplete: 0, source_hash: "a".repeat(64), implementation_hash: "b".repeat(64), first_seen_at: "2026-11-03T04:00:00Z" },
    { engine: "prophet", status: "approved", consecutive_matches: 15, total_matches: 51, total_mismatches: 0, total_incomplete: 0, source_hash: "a".repeat(64), implementation_hash: "c".repeat(64), first_seen_at: "2026-11-03T15:00:00Z", last_detail: JSON.stringify({ compared: 24, mismatches: [], missing: [] }) },
    { engine: "gmi_m15", status: "approved", consecutive_matches: 31, total_matches: 92, total_mismatches: 1, total_incomplete: 0, source_hash: "d".repeat(64), implementation_hash: "e".repeat(64), first_seen_at: "2026-11-05T16:30:00Z" }
  ];
  const v = shapeRegistry(rows);
  assert.deepEqual(v.filter((r) => r.current).map((r) => [r.engine, r.status]), [["gmi_m15", "approved"], ["prophet", "approved"]]);
  const p = v.find((r) => r.engine === "prophet" && r.current);
  assert.equal(p.implementation, "cccccccc");
  assert.deepEqual(p.last_detail, { compared: 24, mismatches: 0, missing: 0 });
  assert.deepEqual(v.find((r) => r.engine === "gmi_m15").totals, { matches: 92, mismatches: 1, incomplete: 0 });
  assert.equal(v.at(-1).current, false, "an older identity sorts after the current ones");
});
