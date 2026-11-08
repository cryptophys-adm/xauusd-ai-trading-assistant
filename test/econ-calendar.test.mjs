import test from "node:test";
import assert from "node:assert/strict";
import { parseCalendar, eventRisk, eventCaution, refreshCalendar, readCalendar, gatedEvents, CALENDAR_KEY, EVENT_GATE } from "../src/econ-calendar.mjs";
import { buildStrategy } from "../src/strategy-engine.mjs";
import { slimInputs } from "../src/strategy-inputs.mjs";

// Rows shaped like the ForexFactory export (checked 2026-11-08).
const ROWS = [
  { title: "CPI y/y", country: "CNY", date: "2026-11-08T20:30:00-05:00", impact: "Low", forecast: "0.8%", previous: "0.9%" },
  { title: "Non-Farm Employment Change", country: "USD", date: "2026-11-13T08:30:00-05:00", impact: "High", forecast: "110K", previous: "95K" },
  { title: "German ZEW", country: "EUR", date: "2026-11-11T05:00:00-05:00", impact: "High", forecast: "", previous: "" },
  { title: "Fed Chair Speaks", country: "USD", date: "2026-11-12T14:00:00-05:00", impact: "High", forecast: "", previous: "" },
  { title: "bad", country: "USD", date: "not a date", impact: "High" }
];
const NFP = Date.parse("2026-11-13T13:30:00Z");

test("the export parses to UTC events, sorted; rows without a time are dropped", () => {
  const ev = parseCalendar(ROWS);
  assert.equal(ev.length, 4);
  assert.deepEqual(ev.at(-1), { title: "Non-Farm Employment Change", currency: "USD", time: "2026-11-13T13:30:00.000Z", impact: "High", forecast: "110K", previous: "95K" });
  assert.deepEqual(parseCalendar(null), []);
});

test("the gate: USD High only, from 2 hours before to 30 minutes after; the next events within 24 hours", () => {
  const ev = parseCalendar(ROWS);
  assert.deepEqual(EVENT_GATE.currencies, ["USD"]);
  assert.equal(eventRisk(ev, NFP - 2 * 3_600_000 - 1).active.length, 0, "just before the window");
  assert.equal(eventRisk(ev, NFP - 2 * 3_600_000).active[0].title, "Non-Farm Employment Change");
  assert.equal(eventRisk(ev, NFP + 30 * 60_000).active.length, 1);
  assert.equal(eventRisk(ev, NFP + 31 * 60_000).active.length, 0, "30 minutes after, the window closes");
  assert.equal(eventRisk(ev, Date.parse("2026-11-11T09:30:00Z")).active.length, 0, "a EUR High event is not gated");
  // 20 hours before NFP (2026-11-12 17:30 UTC): the Fed Chair (19:00 UTC) and NFP are both within 24 hours.
  assert.deepEqual(eventRisk(ev, NFP - 20 * 3_600_000).next.map((e) => e.title), ["Fed Chair Speaks", "Non-Farm Employment Change"]);
  assert.deepEqual(eventRisk(ev, NFP - 3 * 3_600_000).next.map((e) => e.title), ["Non-Farm Employment Change"], "past events are not next");
  assert.match(eventCaution(eventRisk(ev, NFP - 3_600_000)), /high-impact USD event \(Non-Farm Employment Change\)/);
  assert.equal(eventCaution(eventRisk(ev, NFP - 5 * 3_600_000)), null);
});

// The triggered BUY of test/strategy-engine.test.mjs.
const NOW = Date.parse("2026-11-06T14:20:00Z");
const op = (id, bias, confidence = 0.6) => ({ id, status: "ok", stance: "WAIT", bias, confidence });
const room = (biases, bar_close) => ({ bar_close, openings: biases.map((b, i) => op("a" + i, b)), conclusion: { status: "ok", stance: "WAIT", bias: null, confidence: 0.6 } });
const bull = ["BULLISH", "BULLISH", "BULLISH", "NEUTRAL"];
const h1Bars = Array.from({ length: 20 }, (_, i) => ({ open: 4000 + i, high: 4006 + i, low: 3996 + i, close: 4001 + i }));
const m15Bars = Array.from({ length: 10 }, (_, i) => ({ open: 4040, high: 4045, low: i === 5 ? 4031 : 4036, close: 4040 }));
const snapshot = (tf, close) => ({ timeframe: tf, candle_key: `OANDA:XAUUSD:${tf}:1`, huds: {
  interstellar_eyes: { fields: { close, camarilla: { [tf]: { h3: 4048, h4: 4060, h5: 4075, l3: 4038, l4: 4026, l5: 4010 }, D: { h3: 4090, h4: 4110, h5: 4140, l3: 4000, l4: 3980, l5: 3950 } } } },
  chronos_matrix: { fields: { daily_cpr: { pivot: 4020, tc: 4024, bc: 4016 }, weekly_cpr: { pivot: 3960, tc: 3965, bc: 3955 } } },
  fabio_amt: { fields: { poc: 4052, vah: 4068, val: 4030 } }, decision_matrix: { fields: { verdict: 1, gate: 1, conflict: false } },
  trade_management: { fields: { conflict: false, gate: 1 } }, prophet: { fields: { t_enc: 1 } }, kinetic_engine: { fields: { is_chaos: false } }, r37_funnel: { fields: { buy_confirmed: false, sell_confirmed: false } } } });
const input = (calendar) => ({
  rooms: { D1: room(bull, "2026-11-05T22:00:00.000Z"), H4: room(bull, "2026-11-06T14:00:00.000Z"), H1: room(bull, "2026-11-06T14:00:00.000Z"), M15: { ...room(bull, null), bar_time: "2026-11-06T14:15:00.000Z" } },
  news: null, h1Snapshot: snapshot("60", 4040), m15Snapshot: snapshot("15", 4040),
  confirmations: { h1_prophet_r38: { buy_confirmed: false, sell_confirmed: false }, m5_prophet_r38: { buy_confirmed: true, sell_confirmed: false, verified: true } },
  h1Bars, m15Bars, h1Chain: { decision: "WAIT", confidence: 0 }, calendar, now: NOW
});

test("an event in its window is a caution for the strategy (confidence -0.1), never a forced WAIT; the slim record keeps it", () => {
  const event = { events: [{ title: "Core CPI m/m", currency: "USD", time: new Date(NOW + 3_600_000).toISOString(), impact: "High" }] };
  const plain = buildStrategy(input(null)), gated = buildStrategy(input(event));
  assert.equal(plain.cautions.length, 0);
  assert.match(gated.cautions[0], /high-impact USD event \(Core CPI m\/m\)/);
  assert.equal(gated.confidence, Math.round((plain.confidence - 0.1) * 100) / 100);
  assert.equal(gated.direction, plain.direction, "the side never changes");
  assert.deepEqual(buildStrategy(slimInputs(input(event))), gated, "the stored record replays the caution");
  assert.deepEqual(buildStrategy(input({ events: [] })), plain);
});

test("the calendar is fetched at most once an hour, keeps the cache on a failure, and feeds the strategy and /api/calendar", async () => {
  const store = new Map();
  const kv = { async get(k) { return store.get(k) ?? null; }, async put(k, v) { store.set(k, v); } };
  let calls = 0;
  const ok = async () => { calls += 1; return { ok: true, status: 200, async json() { return ROWS; } }; };
  const now = Date.parse("2026-11-12T10:00:00Z");
  assert.deepEqual(await refreshCalendar({ SIGNAL_CACHE: kv }, { now, fetchImpl: ok }), { status: "ok", events: 4 });
  assert.equal((await refreshCalendar({ SIGNAL_CACHE: kv }, { now: now + 30 * 60_000, fetchImpl: ok })).status, "fresh");
  assert.equal(calls, 1);
  const down = async () => { throw new Error("down"); };
  assert.equal((await refreshCalendar({ SIGNAL_CACHE: kv }, { now: now + 2 * 3_600_000, fetchImpl: down })).status, "fetch_failed");
  assert.equal(JSON.parse(store.get(CALENDAR_KEY)).events.length, 4, "the cache is kept");
  const env = { SIGNAL_CACHE: kv };
  assert.deepEqual((await gatedEvents(env, { now })).map((e) => e.title), ["Fed Chair Speaks", "Non-Farm Employment Change"]);
  const view = await readCalendar(env, { now: Date.parse("2026-11-12T18:00:00Z") });
  assert.equal(view.events.length, 4);
  assert.equal(view.risk.active[0].title, "Fed Chair Speaks");
});
