import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clockParts, omegaCell, roomCell, ROOM_LIVE_MS } from "../workers/xauusd-nexus-dashboard/ui/src/lib/headerStatus.ts";

const now = Date.parse("2026-11-23T09:52:07Z");

test("header room cell: LIVE with the bar close in UTC, BEHIND with its age, CLOSED, OFFLINE", () => {
  const bar = Date.parse("2026-11-23T09:45:00Z");
  assert.deepEqual(roomCell({ barMs: bar, hasRoom: true, error: false, closed: false, now }).code, "LIVE");
  assert.equal(roomCell({ barMs: bar, hasRoom: true, error: false, closed: false, now }).detail, "09:45");
  const late = roomCell({ barMs: now - ROOM_LIVE_MS - 7 * 60_000, hasRoom: true, error: false, closed: false, now });
  assert.equal(late.code, "BEHIND");
  assert.equal(late.detail, "52m");
  assert.equal(late.tone, "late");
  assert.equal(roomCell({ barMs: now - 5 * 3_600_000, hasRoom: true, error: false, closed: false, now }).detail, "5h");
  assert.equal(roomCell({ barMs: bar, hasRoom: true, error: true, closed: false, now }).code, "BEHIND", "a failed refresh with a room on screen is late, not live");
  assert.equal(roomCell({ barMs: NaN, hasRoom: false, error: true, closed: false, now }).code, "OFFLINE");
  assert.equal(roomCell({ barMs: NaN, hasRoom: false, error: false, closed: true, now }).code, "CLOSED");
});

test("header Omega cell: ARMED, READY, NO BRIDGE (the fault), OFF, and a dash when unreadable", () => {
  const s = (connected, armed, positions = 0) => ({ connected, armed, broker: "Broker Ltd", server: "Srv-Live", positions });
  assert.deepEqual([omegaCell(s(true, true, 2)).code, omegaCell(s(true, true, 2)).positions, omegaCell(s(true, true, 2)).broker], ["ARMED", 2, "Broker Ltd"]);
  assert.equal(omegaCell(s(true, false)).code, "READY");
  assert.equal(omegaCell(s(true, false)).positions, null, "no position count while none is open and the engine is off");
  assert.equal(omegaCell(s(true, false, 1)).positions, 1);
  assert.deepEqual([omegaCell(s(false, true)).code, omegaCell(s(false, true)).tone], ["NO BRIDGE", "fault"]);
  assert.deepEqual([omegaCell(s(false, false)).code, omegaCell(s(false, false)).tone], ["OFF", "off"]);
  assert.equal(omegaCell(null).code, "—");
  for (const c of [omegaCell(s(true, true)), omegaCell(s(false, true)), omegaCell(null)]) assert.doesNotMatch(JSON.stringify(c), /Srv-Live/, "never the server");
});

test("header clock: UTC to the second, then the viewer's local time and offset", () => {
  const c = clockParts(new Date(now));
  assert.equal(c.utc, "09:52:07");
  assert.equal(c.utcShort, "09:52");
  assert.match(c.local, /^\d\d:\d\d$/);
  assert.match(c.zone, /^(local|GMT[+-]\d{1,2}(:\d\d)?)$/);
});

test("the header shows no green and no 'Advisory only' on a system that executes live", () => {
  const dir = new URL("../workers/xauusd-nexus-dashboard/ui/src/components/", import.meta.url);
  const shell = readFileSync(new URL("AppShell.tsx", dir), "utf8");
  const cells = readFileSync(new URL("HeaderStatus.tsx", dir), "utf8");
  assert.doesNotMatch(shell, /Advisory only/);
  const header = shell.slice(shell.indexOf("<header"), shell.indexOf("</header>"));
  assert.doesNotMatch(header + cells, /emerald|green/, "green means bullish; the header carries no direction");
  assert.match(header, /<StatusStrip /);
  assert.match(header, /<StatusRow /, "the phone keeps the clock and the status");
});
