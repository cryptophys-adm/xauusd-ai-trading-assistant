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
  assert.equal(roomCell({ barMs: bar, hasRoom: true, error: true, closed: false, now }).code, "OFFLINE", "a failed read says so, even with an older room on screen");
  assert.equal(roomCell({ barMs: NaN, hasRoom: false, error: true, closed: false, now }).code, "OFFLINE");
  assert.equal(roomCell({ barMs: NaN, hasRoom: false, error: false, closed: true, now }).code, "CLOSED");
});

test("header Omega cell: the real execution state (owner 2026-11-22: \"Ya status sebenarnya\")", () => {
  const base = { connected: true, armed: true, broker: "Broker Ltd", server: "Srv-Live", positions: 2, live_armed: true, control_mode: "active", control_reason: null, limit_fault: null, account_mode: "real", engine_enabled: true };
  const c = (over) => omegaCell({ ...base, ...over });
  assert.deepEqual([c({}).code, c({}).tone, c({}).positions, c({}).broker], ["ARMED", "ok", 2, "Broker Ltd"]);
  assert.deepEqual([c({ live_armed: false }).code, c({ live_armed: false }).tone], ["ON", "late"], "a real account without the LIVE arm is never ARMED");
  assert.equal(c({ live_armed: false, account_mode: "demo" }).code, "ARMED", "a demo account needs no live arm");
  assert.deepEqual([c({ control_mode: "killed", control_reason: "env_kill_switch" }).code, c({ control_mode: "killed" }).tone], ["KILLED", "fault"]);
  assert.match(c({ control_mode: "killed", control_reason: "env_kill_switch" }).title, /env_kill_switch/, "the reason is a tooltip, never a state");
  assert.deepEqual([c({ control_mode: "paused" }).code, c({ control_mode: "paused" }).tone], ["PAUSED", "late"]);
  assert.deepEqual([c({ limit_fault: { why: "no_answer" } }).code, c({ limit_fault: { why: "no_answer" } }).tone], ["STOP", "fault"]);
  assert.equal(c({ connected: false }).code, "NO BRIDGE");
  assert.equal(c({ engine_enabled: false }).code, "READY", "the env switch off: the engine is off whatever the toggle says");
  assert.match(c({ engine_enabled: false }).title, /OMEGA_ENGINE_ENABLED off/);
  assert.equal(c({ armed: false, positions: 0 }).code, "READY");
  assert.equal(c({ armed: false, positions: 0 }).positions, null);
  assert.equal(c({ armed: false, connected: false }).code, "OFF");
  assert.equal(omegaCell(null).code, "—");
  // An older Omega without the #516 fields never claims ARMED.
  assert.equal(omegaCell({ connected: true, armed: true, broker: null, positions: 0 }).code, "ON");
  for (const o of [c({}), c({ connected: false }), c({ control_mode: "killed" })]) assert.doesNotMatch(JSON.stringify(o), /Srv-Live/, "never the server");
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
