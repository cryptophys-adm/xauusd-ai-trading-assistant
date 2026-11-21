import test from "node:test";
import assert from "node:assert/strict";

import {
  ORB_AGENT_ID,
  ORB_AGENT_VERSION,
  ORB_RULES,
  SESSIONS_CONFIG,
  sessionTimeInZone,
  getBarSessionInfo,
  findSessionOpeningRange,
  evaluateOrbSetup,
  orbStrategy
} from "../src/orb-strategy.mjs";
import { AGENT_RULES } from "../src/strategy-agents.mjs";

const zone = (low, high, label, major = true) => ({ low, high, price: (low + high) / 2, major, label });

test("ORB: sessionTimeInZone correctly respects London and New York timezones and DST", () => {
  // 2026-07-15 08:00 UTC -> In summer (BST, UTC+1), London time is 09:00, New York (EDT, UTC-4) is 04:00
  const summerMs = Date.UTC(2026, 6, 15, 8, 0, 0);
  const londonSummer = sessionTimeInZone(summerMs, SESSIONS_CONFIG.london.formatter);
  const nySummer = sessionTimeInZone(summerMs, SESSIONS_CONFIG.new_york.formatter);

  assert.equal(londonSummer.hour, 9);
  assert.equal(nySummer.hour, 4);

  // 2026-01-15 08:00 UTC -> In winter (GMT, UTC+0), London is 08:00, New York (EST, UTC-5) is 03:00
  const winterMs = Date.UTC(2026, 0, 15, 8, 0, 0);
  const londonWinter = sessionTimeInZone(winterMs, SESSIONS_CONFIG.london.formatter);
  const nyWinter = sessionTimeInZone(winterMs, SESSIONS_CONFIG.new_york.formatter);

  assert.equal(londonWinter.hour, 8);
  assert.equal(nyWinter.hour, 3);
});

test("ORB: weekend bars are excluded and marked as market closed", () => {
  // Sunday 08:00 London time -> 2026-01-18 is Sunday
  const sundayMs = Date.UTC(2026, 0, 18, 8, 0, 0);
  const info = getBarSessionInfo(sundayMs, SESSIONS_CONFIG.london);
  assert.equal(info.isWeekend, true);
  assert.equal(info.inSession, false);
});

test("ORB: opening range requires closed bars and detects forming state", () => {
  // London open at 08:00 GMT on Thursday 2026-01-15
  // Only 1 bar at 08:00 GMT -> Range duration is 45m (needs 3 bars), so it should report forming
  const baseTime = Date.UTC(2026, 0, 15, 8, 0, 0);
  const bars = [
    { open_time: new Date(baseTime).toISOString(), open: 2600, high: 2605, low: 2598, close: 2602 }
  ];

  const range = findSessionOpeningRange(bars, 10);
  assert.equal(range.status, "range_forming");
  assert.equal(range.reason, "opening_range_still_forming");
});

test("ORB: range too narrow and too wide are rejected deterministically", () => {
  const baseTime = Date.UTC(2026, 0, 15, 8, 0, 0);
  // 3 bars of 15m covering 08:00, 08:15, 08:30 (45m range)
  // Narrow range: span = 2601 - 2600 = 1.0. With ATR = 10, span/ATR = 0.10 < 0.25 (too narrow)
  const narrowBars = [
    { open_time: new Date(baseTime).toISOString(), open: 2600, high: 2601, low: 2600, close: 2600.5 },
    { open_time: new Date(baseTime + 15 * 60000).toISOString(), open: 2600.5, high: 2601, low: 2600.2, close: 2600.8 },
    { open_time: new Date(baseTime + 30 * 60000).toISOString(), open: 2600.8, high: 2601, low: 2600.4, close: 2600.6 }
  ];

  const narrowRes = findSessionOpeningRange(narrowBars, 10);
  assert.equal(narrowRes.status, "rejected");
  assert.equal(narrowRes.reason, "range_too_narrow");

  // Wide range: span = 2650 - 2600 = 50. With ATR = 10, span/ATR = 5.0 > 3.5 (too wide)
  const wideBars = [
    { open_time: new Date(baseTime).toISOString(), open: 2600, high: 2630, low: 2600, close: 2620 },
    { open_time: new Date(baseTime + 15 * 60000).toISOString(), open: 2620, high: 2650, low: 2615, close: 2640 },
    { open_time: new Date(baseTime + 30 * 60000).toISOString(), open: 2640, high: 2645, low: 2610, close: 2635 }
  ];

  const wideRes = findSessionOpeningRange(wideBars, 10);
  assert.equal(wideRes.status, "rejected");
  assert.equal(wideRes.reason, "range_too_wide");
});

test("ORB: long breakout triggers plan with proper stop and key-level targets", () => {
  const baseTime = Date.UTC(2026, 0, 15, 8, 0, 0);
  const levels = [zone(2625, 2630, "the 2625-2630 resistance", true)];
  // Range: High = 2610, Low = 2600 (Span = 10, Midpoint = 2605). ATR = 8.
  const bars = [
    { open_time: new Date(baseTime).toISOString(), open: 2602, high: 2608, low: 2600, close: 2605 },
    { open_time: new Date(baseTime + 15 * 60000).toISOString(), open: 2605, high: 2610, low: 2601, close: 2607 },
    { open_time: new Date(baseTime + 30 * 60000).toISOString(), open: 2607, high: 2609, low: 2603, close: 2606 },
    // Breakout bar at 08:45: Closes at 2612 (broke above 2610 by 2 > 0.05 * 8 = 0.4)
    { open_time: new Date(baseTime + 45 * 60000).toISOString(), open: 2606, high: 2613, low: 2605.5, close: 2612 }
  ];

  const ctx = {
    price: 2612,
    atr: 8,
    levels,
    bars
  };

  const res = evaluateOrbSetup(1, ctx);
  assert.equal(res.reason, "ok");
  assert.ok(res.plan);
  assert.equal(res.plan.agent, ORB_AGENT_ID);
  assert.equal(res.plan.entry, 2610); // Limit at range edge when not retesting
  assert.ok(res.plan.stop < 2605); // Stop padded below midpoint/breakout low
  assert.equal(res.plan.tp1, 2625);
  assert.equal(res.plan.tp1_note, "the 2625-2630 resistance");
  assert.equal(res.plan.orb.session, "london");
});

test("ORB: short breakout triggers plan on break below opening range low", () => {
  const baseTime = Date.UTC(2026, 0, 15, 8, 0, 0);
  const levels = [zone(2580, 2585, "the 2580-2585 support", true)];
  // Range: High = 2610, Low = 2600. Midpoint = 2605. ATR = 8.
  const bars = [
    { open_time: new Date(baseTime).toISOString(), open: 2608, high: 2610, low: 2602, close: 2604 },
    { open_time: new Date(baseTime + 15 * 60000).toISOString(), open: 2604, high: 2607, low: 2601, close: 2603 },
    { open_time: new Date(baseTime + 30 * 60000).toISOString(), open: 2603, high: 2606, low: 2600, close: 2602 },
    // Breakout short bar at 08:45: Closes at 2598 (broke below 2600 by 2)
    { open_time: new Date(baseTime + 45 * 60000).toISOString(), open: 2602, high: 2603, low: 2597, close: 2598 }
  ];

  const ctx = {
    price: 2598,
    atr: 8,
    levels,
    bars
  };

  const res = evaluateOrbSetup(-1, ctx);
  assert.equal(res.reason, "ok");
  assert.ok(res.plan);
  assert.equal(res.plan.agent, ORB_AGENT_ID);
  assert.equal(res.plan.entry, 2600);
  assert.ok(res.plan.stop > 2605);
  assert.equal(res.plan.tp1, 2585);
  assert.equal(res.plan.tp1_note, "the 2580-2585 support");
});

test("ORB: invalidation occurs when closed bar crosses midpoint after breakout", () => {
  const baseTime = Date.UTC(2026, 0, 15, 8, 0, 0);
  const bars = [
    { open_time: new Date(baseTime).toISOString(), open: 2602, high: 2610, low: 2600, close: 2605 },
    { open_time: new Date(baseTime + 15 * 60000).toISOString(), open: 2605, high: 2609, low: 2601, close: 2607 },
    { open_time: new Date(baseTime + 30 * 60000).toISOString(), open: 2607, high: 2608, low: 2602, close: 2606 },
    // Breakout long at 08:45: Closes at 2612
    { open_time: new Date(baseTime + 45 * 60000).toISOString(), open: 2606, high: 2613, low: 2605, close: 2612 },
    // Reversal bar at 09:00: Closes back at 2603 (below midpoint 2605)
    { open_time: new Date(baseTime + 60 * 60000).toISOString(), open: 2612, high: 2612, low: 2602, close: 2603 }
  ];

  const ctx = { price: 2603, atr: 8, levels: [], bars };
  const res = evaluateOrbSetup(1, ctx);
  assert.equal(res.plan, null);
  assert.equal(res.reason, "breakout_invalidated_by_midpoint_close");
});

test("ORB: orbStrategy object satisfies agent contract and returns null when no setup", () => {
  assert.equal(orbStrategy.id, ORB_AGENT_ID);
  assert.equal(orbStrategy.version, 1);
  assert.ok(typeof orbStrategy.fits === "string" && orbStrategy.fits.length > 50);
  assert.ok(typeof orbStrategy.plan === "function");

  // Empty bars -> returns null
  assert.equal(orbStrategy.plan(1, { bars: [] }), null);
});
