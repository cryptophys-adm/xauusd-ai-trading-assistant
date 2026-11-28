// ET1 (src/event-trigger.mjs): the 5-minute event trigger, record mode. No network: D1 is SQLite, KV a Map.
import test from "node:test";
import assert from "node:assert/strict";
import { eventTriggerMode, eventsOf, candidateSidesOf, sidePlanOf, eventSetup, runEventTrigger, eventTriggerReport, resetEventTriggerSchemaForTests, EVENT_TRIGGER_MODES } from "../src/event-trigger.mjs";
import { switchByKey, readSwitch } from "../src/feature-switches.mjs";
import { d1, kv } from "./fixtures/mode-shadow.mjs";

const M1 = 60_000, M5 = 5 * M1, M15 = 15 * M1;
const iso = (ms) => new Date(ms).toISOString();
const CLOSE = Date.parse("2026-11-27T17:00:00.000Z");
// The 27 Nov 17:00Z shape (made-up prices): WAIT, the long side passes every guardrail and waits for the 5m confirmation.
const recordOf = (extra = {}) => ({
  decision_key: `OANDA:XAUUSD:15:${CLOSE - M15}`, bar_close: iso(CLOSE), stance: "WAIT",
  guardrails: { long: { allowed: true, checks: [], entry_trigger: { fired: false, note: "waiting for a verified 5m (or 15m) Prophet buy confirmation" } }, short: { allowed: false, checks: [], entry_trigger: { fired: false } } },
  strategy_plans: { long: { zone_pullback: { status: "live", entry: 4000, stop: 3990, tp1: 4015, at_level: true } }, short: {} }, strategy: { atr_h1: 10 },
  ...extra
});
const liveAt = (ms, extra = {}) => ({ confirmation: { buy_confirmed: true, sell_confirmed: false, verified: true, candle_time: iso(ms), ...extra }, price: 4002 });

test("ET-1 the event: a WAIT whose passing side waited for the 5m confirmation, a verified 5m confirmation on that side within the bar", () => {
  const now = CLOSE + 6 * M1, at = CLOSE + M5;
  assert.deepEqual(eventsOf(recordOf(), liveAt(at), now), [{ side: "long", event_ms: at, plan: { agent: "zone_pullback", entry: 4000, stop: 3990, tp1: 4015, price: 4002, atr_h1: 10 } }]);
  const none = (r, l, n = now) => assert.deepEqual(eventsOf(r, l, n), []);
  none(recordOf({ stance: "BUY" }), liveAt(at));                                                       // not a WAIT
  none(recordOf(), liveAt(at, { verified: false }));                                                   // unverified 5m
  none(recordOf(), liveAt(at, { buy_confirmed: false, sell_confirmed: true }));                        // the other side (short fails its guardrails)
  none(recordOf({ guardrails: { long: { allowed: false, entry_trigger: { fired: false } }, short: { allowed: false } } }), liveAt(at)); // no side passes
  none(recordOf({ guardrails: { long: { allowed: true, entry_trigger: { fired: true } }, short: { allowed: false } } }), liveAt(at));   // the trigger had already fired
  none(recordOf(), liveAt(CLOSE - M5));                                                                // a 5m bar before the decision
  none(recordOf(), liveAt(at), CLOSE + M15 + M1);                                                      // the next 15m bar: that decision decides
  none(recordOf({ strategy_plans: { long: {} } }), liveAt(at));                                        // no plan to replay
  none(null, liveAt(at));
  assert.equal(sidePlanOf({ strategy_plans: { long: { pattern_lines: { entry: 1, stop: 0, tp1: 3 } } } }, "long").agent, "pattern_lines", "no default agent: the first plan");
  const st = eventSetup({ side: "long", event_ms: at, plan_json: JSON.stringify({ entry: 4000, stop: 3990, tp1: 4015, price: 4002, atr_h1: 10 }) });
  assert.deepEqual([st.side, st.entry, st.stop, st.tp1, st.atr_h1, st.at_level, st.opened_ms], ["BUY", 4002, 3992, 4017, 10, true, at], "at market from the 5m close, the plan's own distances");
});

test("ET-2 the ledger step: one row per decision and side, its counterfactual R once the bars end it; record never runs the council", async () => {
  resetEventTriggerSchemaForTests();
  const env = { DB: d1(), SIGNAL_CACHE: kv(), EVENT_TRIGGER_MODE: "record" };
  const at = CLOSE + M5;
  const first = await runEventTrigger(env, { now: CLOSE + 6 * M1, record: recordOf(), live: liveAt(at), bars: [] });
  assert.deepEqual(first, { status: "ok", mode: "record", recorded: 1, resolved: 0 });
  assert.equal((await runEventTrigger(env, { now: CLOSE + 11 * M1, record: recordOf(), live: liveAt(at), bars: [] })).recorded, 0, "once per decision and side");
  // 1m bars rising 0.25 a minute from the event: the market entry at about 4002 reaches its TP1 (+15) in an hour.
  const bars = Array.from({ length: 240 }, (_, i) => ({ open_time: iso(at + i * M1), close_time: iso(at + (i + 1) * M1), open: 4002 + i * 0.25, high: 4002.5 + i * 0.25, low: 4001.5 + i * 0.25, close: 4002.25 + i * 0.25 }));
  const later = await runEventTrigger(env, { now: at + 3 * 60 * M1, record: recordOf(), live: null, bars });
  assert.equal(later.resolved, 1);
  const row = env.DB.raw.prepare("SELECT decision_key, side, event_ms, mode, status, r FROM event_triggers").get();
  assert.deepEqual([row.side, row.event_ms, row.mode, row.status], ["long", at, "record", "resolved"]);
  assert.ok(row.r > 1, `the counterfactual R (${row.r}) ${env.DB.raw.prepare("SELECT result_json FROM event_triggers").get().result_json}`);
  const rep = await eventTriggerReport(env, { now: at + 4 * 60 * M1 });
  assert.deepEqual([rep.n, rep.resolved, rep.mode], [1, 1, "record"]);
  assert.doesNotMatch(JSON.stringify(rep), /4002|4015|3990/, "the report carries no price");
});

test("ET-3 no mode that does nothing: \"on\" reads as \"record\" (no out-of-cycle run exists yet); off: nothing; the 5m context is read only for a candidate", async () => {
  assert.deepEqual([...EVENT_TRIGGER_MODES], ["record", "off"]);
  assert.equal(eventTriggerMode({ EVENT_TRIGGER_MODE: "on" }), "record");
  resetEventTriggerSchemaForTests();
  const reads = [];
  const store = kv(), getter = store.get;
  store.get = async (k) => { reads.push(k); return getter(k); };
  const env = { DB: d1(), SIGNAL_CACHE: store, EVENT_TRIGGER_MODE: "on" };
  const out = await runEventTrigger(env, { now: CLOSE + 6 * M1, record: recordOf(), live: liveAt(CLOSE + M5), bars: [] });
  assert.deepEqual([out.mode, out.recorded, "runs" in out], ["record", 1, false]);
  // No candidate (a BUY, a side that failed, the trigger already fired, outside the window): no 5m context read.
  for (const r of [recordOf({ stance: "BUY" }), recordOf({ guardrails: { long: { allowed: false }, short: { allowed: false } } }), recordOf({ guardrails: { long: { allowed: true, entry_trigger: { fired: true } }, short: { allowed: false } } })]) {
    assert.deepEqual(candidateSidesOf(r, CLOSE + 6 * M1), []);
    reads.length = 0;
    await runEventTrigger(env, { now: CLOSE + 6 * M1, record: r, bars: [] });
    assert.equal(reads.includes("context:m5:latest"), false, "no 5m read without a candidate");
  }
  assert.deepEqual(candidateSidesOf(recordOf(), CLOSE + M15 + M1), [], "the next 15m bar");
  assert.deepEqual(candidateSidesOf(recordOf(), CLOSE + 6 * M1), ["long"]);
  assert.deepEqual(await runEventTrigger({ DB: d1(), SIGNAL_CACHE: kv() }, { now: CLOSE }), { status: "inactive" });
});

test("ET-4 the switch: FS1 row and accessor", () => {
  const e = switchByKey("EVENT_TRIGGER_MODE");
  assert.deepEqual([e.group, e.default_value, e.config_value, [...e.values]], ["agents", "off", "record", ["record", "off"]]);
  for (const [raw, v] of [["record", "record"], [" ON ", "record"], ["off", "off"], ["x", "off"], [undefined, "off"]]) {
    assert.equal(readSwitch(e, raw), v);
    assert.equal(eventTriggerMode(raw === undefined ? {} : { EVENT_TRIGGER_MODE: raw }), v);
  }
});
