// Gold's trading week follows New York time (2026-11-15: the engine and the War Room read a fixed Sunday/Friday
// 22:00 UTC, an hour early for the reopen in US standard time and an hour late for the close in daylight time).
import test from "node:test";
import assert from "node:assert/strict";
import { goldClosedAt, nextGoldChange } from "../src/market-hours.mjs";
import { marketOpenAt, sessionAt } from "../src/decision-engine.mjs";
import { goldClosedAt as fromSweep } from "../src/parity-sweep.mjs";
import { pushIdleAt, combineSync } from "../src/aether-sync.mjs";

const at = (iso) => Date.parse(iso);

test("US standard time (November): reopen Sunday 23:00 UTC, close Friday 22:00 UTC", () => {
  assert.equal(marketOpenAt(at("2026-11-15T22:30:00Z")), false, "22:30 UTC Sunday is still 17:30 New York");
  assert.equal(marketOpenAt(at("2026-11-15T22:59:59Z")), false);
  assert.equal(marketOpenAt(at("2026-11-15T23:00:00Z")), true);
  assert.equal(marketOpenAt(at("2026-11-20T21:59:59Z")), true);
  assert.equal(marketOpenAt(at("2026-11-20T22:00:00Z")), false);
  assert.equal(marketOpenAt(at("2026-11-21T12:00:00Z")), false, "Saturday");
});

test("US daylight time (July): reopen Sunday 22:00 UTC, close Friday 21:00 UTC", () => {
  assert.equal(marketOpenAt(at("2026-07-12T21:59:59Z")), false);
  assert.equal(marketOpenAt(at("2026-07-12T22:00:00Z")), true);
  assert.equal(marketOpenAt(at("2026-07-17T20:59:59Z")), true);
  assert.equal(marketOpenAt(at("2026-07-17T21:00:00Z")), false, "the fixed 22:00 UTC rule kept this hour open");
});

test("the next change is the real reopen or close, and parity-sweep keeps exporting the same rule", () => {
  assert.deepEqual(nextGoldChange(at("2026-11-15T22:52:00Z")), { to: "open", at: at("2026-11-15T23:00:00Z") });
  assert.deepEqual(nextGoldChange(at("2026-11-16T00:10:00Z")), { to: "closed", at: at("2026-11-20T22:00:00Z") });
  const s = sessionAt(at("2026-11-15T22:52:00Z"));
  assert.equal(s.market_open, false);
  assert.deepEqual([s.next_change.to, s.next_change.at, s.next_change.minutes], ["open", "2026-11-15T23:00:00.000Z", 8]);
  assert.equal(fromSweep, goldClosedAt);
});

test("the Aether push check is idle while closed and in the first 2 hours after the reopen", () => {
  assert.equal(pushIdleAt(at("2026-11-15T22:10:39Z")), true, "the false alert of 2026-11-15");
  assert.equal(pushIdleAt(at("2026-11-16T00:59:00Z")), true);
  assert.equal(pushIdleAt(at("2026-11-16T01:01:00Z")), false);
  const old = "2026-11-14T04:11:38Z";
  assert.equal(combineSync({ aether: null, lastPushAt: old, now: at("2026-11-15T22:10:39Z") }).checks.local_push.status, "idle");
  assert.equal(combineSync({ aether: null, lastPushAt: old, now: at("2026-11-16T03:00:00Z") }).checks.local_push.status, "warn");
});
