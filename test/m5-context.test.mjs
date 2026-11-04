import test from "node:test";
import assert from "node:assert/strict";
import { validateM5Context, freshM5Context } from "../src/m5-context.mjs";

const now = Date.parse("2026-11-04T10:00:00.000Z");
function valid() {
  return {
    schema_version: "cryptophys.local-context.v1",
    trust_status: "informational_unverified",
    symbol: "OANDA:XAUUSD",
    timeframe: "5",
    candle_time: new Date(now - 2 * 60 * 1000).toISOString(),
    received_at: new Date(now - 1 * 60 * 1000).toISOString()
  };
}

test("validateM5Context accepts valid payload", () => {
  assert.equal(validateM5Context(valid(), now).valid, true);
});
test("schema rejection: wrong schema_version", () => {
  const p = { ...valid(), schema_version: "x" };
  assert.equal(validateM5Context(p, now).valid, false);
});
test("schema rejection: wrong trust_status", () => {
  const p = { ...valid(), trust_status: "trusted" };
  assert.equal(validateM5Context(p, now).valid, false);
});
test("schema rejection: timeframe != 5", () => {
  const p = { ...valid(), timeframe: "M5" };
  assert.equal(validateM5Context(p, now).valid, false);
});
test("schema rejection: missing symbol", () => {
  const p = { ...valid(), symbol: "" };
  assert.equal(validateM5Context(p, now).valid, false);
});
test("schema rejection: invalid candle_time", () => {
  const p = { ...valid(), candle_time: "nope" };
  assert.equal(validateM5Context(p, now).valid, false);
});
test("schema rejection: future candle_time", () => {
  const p = { ...valid(), candle_time: new Date(now + 10 * 60 * 1000).toISOString() };
  assert.equal(validateM5Context(p, now).valid, false);
});

test("freshM5Context accepts fresh record", () => {
  assert.ok(freshM5Context(valid(), now));
});
test("freshM5Context null when old candle_time with fresh received_at", () => {
  const p = { ...valid(), candle_time: new Date(now - 20 * 60 * 1000).toISOString(), received_at: new Date(now - 1 * 60 * 1000).toISOString() };
  assert.equal(freshM5Context(p, now), null);
});
test("freshM5Context null when old received_at", () => {
  const p = { ...valid(), received_at: new Date(now - 20 * 60 * 1000).toISOString() };
  assert.equal(freshM5Context(p, now), null);
});
test("freshM5Context null on malformed record", () => {
  assert.equal(freshM5Context({ foo: 1 }, now), null);
});
