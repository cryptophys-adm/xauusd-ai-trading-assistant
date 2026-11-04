import test from "node:test";
import assert from "node:assert/strict";
import { buildM5ProphetContext } from "../src/m5-producer.mjs";

function bars(n) {
  const out = [];
  let t = Date.parse("2026-11-04T00:00:00.000Z");
  for (let i = 0; i < n; i++) {
    out.push({ open: 3950 + i * 0.1, high: 3955 + i * 0.1, low: 3948 + i * 0.1, close: 3953 + i * 0.1, volume: 100, open_time: new Date(t).toISOString(), close_time: new Date(t + 5 * 60 * 1000).toISOString() });
    t += 5 * 60 * 1000;
  }
  return out;
}

test("throws on insufficient history", () => {
  assert.throws(() => buildM5ProphetContext(bars(10)), /insufficient 5m history/);
});

test("returns informational 5m context", () => {
  const r = buildM5ProphetContext(bars(60));
  assert.equal(r.trust_status, "informational_unverified");
  assert.equal(r.timeframe, "5");
  assert.ok(["BULLISH","BEARISH","NEUTRAL"].includes(r.bias));
});
