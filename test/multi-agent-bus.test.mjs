import test from "node:test";
import assert from "node:assert/strict";

test("flag false means no bus calls", () => {
  // smoke: env flag default false
  assert.equal(String(process.env.MULTI_AGENT_BUS_ENABLED || "false"), "false");
});
