// The Omega watchdog and the bridge's local recovery use gold's week in New York time (2026-11-15); the bridge's
// copy of the rule stays equal to the Worker's.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { goldClosedAt } from "../src/market-hours.mjs";
import { goldClosedAt as bridgeClosedAt } from "../bridge/omega-bridge/src/market-hours.mjs";

test("the bridge's market hours equal the Worker's across a year of hours", () => {
  for (let t = Date.parse("2026-01-01T00:00:00Z"); t < Date.parse("2027-01-01T00:00:00Z"); t += 30 * 60_000) {
    assert.equal(bridgeClosedAt(t), goldClosedAt(t), new Date(t).toISOString());
  }
});

test("neither the watchdog nor the bridge keeps a fixed UTC weekend rule", () => {
  for (const f of ["src/omega-broker.mjs", "bridge/omega-bridge/src/daemon.mjs"]) {
    const text = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /day === 0 && hour < 22/, f);
    assert.match(text, /goldClosedAt\(/, f);
  }
  // November Sunday 22:30 UTC is still closed (the old rule called it open and could restart a stale terminal).
  assert.equal(goldClosedAt(Date.parse("2026-11-15T22:30:00Z")), true);
  assert.equal(goldClosedAt(Date.parse("2026-07-17T21:30:00Z")), true, "July Friday after the 17:00 New York close");
});
