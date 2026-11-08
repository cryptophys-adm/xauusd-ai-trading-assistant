import test from "node:test";
import assert from "node:assert/strict";
import { parseValue, ruleOf, projectEvent, calendarOutlook } from "../src/calendar-agent.mjs";

test("calendar values parse, with units", () => {
  assert.equal(parseValue("0.3%"), 0.3);
  assert.equal(parseValue("-0.5%"), -0.5);
  assert.equal(parseValue("250K"), 250000);
  assert.equal(parseValue("1.2M"), 1200000);
  assert.equal(parseValue("4.50%"), 4.5);
  assert.equal(parseValue(""), null);
  assert.equal(parseValue(undefined), null);
});

test("event kinds: data above forecast lifts the dollar (gold down), except unemployment and claims", () => {
  const dir = (t) => projectEvent({ title: t, currency: "USD", time: "2026-11-10T13:30:00.000Z", impact: "High", forecast: "", previous: "" }, Date.parse("2026-11-09T00:00:00Z"));
  for (const t of ["CPI m/m", "Core PCE Price Index m/m", "Non-Farm Employment Change", "Average Hourly Earnings m/m", "Retail Sales m/m", "ISM Manufacturing PMI", "Advance GDP q/q", "Federal Funds Rate"]) {
    assert.equal(dir(t).gold_if_above_forecast, -1, t);
    assert.equal(dir(t).gold_if_below_forecast, 1, t);
  }
  for (const t of ["Unemployment Rate", "Unemployment Claims"]) assert.equal(dir(t).gold_if_above_forecast, 1, t);
  const fomc = dir("FOMC Statement");
  assert.equal(fomc.kind, "fed_speech");
  assert.equal(fomc.gold_if_above_forecast, null);
  assert.match(fomc.text, /hawkish tone means gold down/);
  assert.equal(ruleOf("Some New Index").kind, "other");
  assert.equal(projectEvent({ title: "CPI", currency: "EUR", time: "2026-11-10T10:00:00.000Z" }), null, "only USD events are projected");
});

test("the consensus lean and the status follow the forecast and the time", () => {
  const e = { title: "CPI m/m", currency: "USD", time: "2026-11-10T13:30:00.000Z", impact: "High", forecast: "0.4%", previous: "0.2%" };
  const t = Date.parse(e.time);
  const p = projectEvent(e, t - 5 * 3_600_000);
  assert.equal(p.consensus_lean, -1, "a hotter CPI is expected: the consensus leans gold down");
  assert.equal(p.status, "upcoming");
  assert.match(p.text, /Above forecast: gold down; below forecast: gold up/);
  assert.match(p.text, /consensus already leans gold down/);
  assert.equal(projectEvent(e, t - 3_600_000).status, "imminent");
  assert.equal(projectEvent(e, t + 3_600_000).status, "released");
  assert.match(projectEvent(e, t + 3_600_000).text, /read from the headlines/);
  assert.equal(projectEvent(e, t + 5 * 3_600_000).status, "past");
  assert.equal(projectEvent({ ...e, title: "Unemployment Rate", forecast: "4.3%", previous: "4.1%" }, t - 5 * 3_600_000).consensus_lean, 1);
  assert.equal(projectEvent({ ...e, forecast: "0.2%" }, t - 5 * 3_600_000).consensus_lean, 0, "unchanged forecast: no lean");
  assert.equal(projectEvent(e, t).horizon.to, "2026-11-10T17:30:00.000Z");
});

test("the outlook: high-impact USD events in the window and the net lean of the next 24 hours", () => {
  const now = Date.parse("2026-11-10T08:00:00Z");
  const ev = [
    { title: "CPI m/m", currency: "USD", time: "2026-11-10T13:30:00.000Z", impact: "High", forecast: "0.4%", previous: "0.2%" },
    { title: "Unemployment Claims", currency: "USD", time: "2026-11-10T13:30:00.000Z", impact: "High", forecast: "220K", previous: "220K" },
    { title: "German ZEW", currency: "EUR", time: "2026-11-10T10:00:00.000Z", impact: "High", forecast: "", previous: "" },
    { title: "Crude Oil Inventories", currency: "USD", time: "2026-11-10T15:30:00.000Z", impact: "Medium", forecast: "", previous: "" },
    { title: "Retail Sales m/m", currency: "USD", time: "2026-11-13T13:30:00.000Z", impact: "High", forecast: "", previous: "" }
  ];
  const o = calendarOutlook(ev, now);
  assert.deepEqual(o.events.map((e) => e.title), ["CPI m/m", "Unemployment Claims"]);
  assert.equal(o.next_24h, 2);
  assert.equal(o.consensus_lean, -0.5);
  assert.match(o.summary, /2 high-impact USD events in the next 24 hours; the consensus leans gold down/);
  assert.match(calendarOutlook([], now).summary, /No high-impact USD event/);
});
