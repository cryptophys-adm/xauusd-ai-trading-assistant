import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { resetThreadSchemaCacheForTests } from "../src/agent-threads.mjs";
import {
  dueSessions, calendarBiasRule, validateMacroOpening, validateMacroRebuttal, validateMacroConclusion, macroMajorityBias,
  runMacroRoom, runPendingMacroRooms, readMacroRoom, macroDeskEvidence, MACRO_THREAD
} from "../src/macro-room.mjs";
import { buildGlobalConclusion } from "../src/global-conclusion.mjs";
import { CALENDAR_KEY } from "../src/econ-calendar.mjs";

const H = 3_600_000;
const NOW = Date.parse("2026-11-10T08:25:00.000Z");

test("sessions: 20 minutes after a 4-hour close, 30 minutes after a high-impact USD event, each once", () => {
  const close = "2026-11-10T08:00:00.000Z";
  const ev = [
    { title: "CPI m/m", currency: "USD", impact: "High", time: "2026-11-10T07:30:00.000Z" },
    { title: "Core CPI m/m", currency: "USD", impact: "High", time: "2026-11-10T07:30:00.000Z" },
    { title: "ZEW", currency: "EUR", impact: "High", time: "2026-11-10T07:30:00.000Z" },
    { title: "Crude Oil Inventories", currency: "USD", impact: "Medium", time: "2026-11-10T07:30:00.000Z" }
  ];
  assert.deepEqual(dueSessions({ goldLastClose: close, events: ev, now: NOW }).map((s) => s.run_id), ["4h:2026-11-10T08:00:00.000Z", "event:2026-11-10T07:30:00.000Z"], "same-minute events share one session");
  assert.deepEqual(dueSessions({ goldLastClose: close, now: Date.parse("2026-11-10T08:10:00Z") }), [], "too soon after the close");
  assert.deepEqual(dueSessions({ goldLastClose: close, now: Date.parse("2026-11-10T11:30:00Z") }), [], "the window has passed (a weekend close never runs again)");
  assert.deepEqual(dueSessions({ events: ev, now: Date.parse("2026-11-10T07:50:00Z") }), [], "too soon after the event");
  assert.deepEqual(dueSessions({ goldLastClose: close, events: ev, now: NOW, done: new Set(["4h:2026-11-10T08:00:00.000Z"]) }).map((s) => s.kind), ["event"]);
});

test("the Calendar Agent's bias follows the fixed rules before a release and is free after it", () => {
  assert.equal(calendarBiasRule({ events: [] }), "NEUTRAL");
  assert.equal(calendarBiasRule({ events: [{ status: "upcoming" }], consensus_lean: -1 }), "BEARISH");
  assert.equal(calendarBiasRule({ events: [{ status: "upcoming" }], consensus_lean: 0 }), "NEUTRAL");
  assert.equal(calendarBiasRule({ events: [{ status: "released" }, { status: "upcoming" }], consensus_lean: -1 }), null);
});

test("validators: the calendar direction is never reversed, a conclusion needs support, plain words only", () => {
  const op = (o) => ({ agent: "calendar", bias: "BEARISH", confidence: 0.6, claim: "A hotter inflation print is expected, which usually weighs on gold.", ...o });
  assert.equal(validateMacroOpening(op(), "calendar", { requiredBias: "BEARISH" }).valid, true);
  assert.deepEqual(validateMacroOpening(op({ bias: "BULLISH" }), "calendar", { requiredBias: "BEARISH" }).errors, ["calendar_projection_reversed:BEARISH"]);
  assert.ok(validateMacroOpening(op({ claim: "consensus_lean is -1" }), "calendar").errors.some((e) => e.startsWith("not_natural_language")));
  const o = op(); validateMacroOpening(o, "calendar"); assert.equal(o.stance, "BEARISH", "the stored stance is the bias");
  assert.deepEqual(validateMacroRebuttal({ agent: "dollar", bias: "BULLISH", confidence: 0.5, rebuts: ["dollar"], argument: "The dollar is soft." }, "dollar", ["dollar", "news"]).errors, ["rebuts_invalid"]);
  const c = { bias: "BULLISH", confidence: 0.6, summary: "Gold leans up.", reasons: ["A weaker dollar."], drivers: ["dollar"] };
  assert.deepEqual(validateMacroConclusion({ ...c }, { busAgents: ["dollar"], supportBiases: new Set(["BEARISH"]) }).errors, ["bias_without_support"]);
  assert.equal(validateMacroConclusion({ ...c, bias: "NEUTRAL" }, { busAgents: ["dollar"], supportBiases: new Set(["BEARISH"]) }).valid, true);
  assert.deepEqual(validateMacroConclusion({ ...c, drivers: ["nobody"] }, { busAgents: ["dollar"], supportBiases: new Set(["BULLISH"]) }).errors, ["drivers_invalid"]);
  assert.equal(macroMajorityBias([{ bias: "BULLISH", confidence: 0.8 }, { bias: "BEARISH", confidence: 0.3 }, { bias: "NEUTRAL", confidence: 0.5 }]), "BULLISH");
});

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args.map((v) => (v === undefined ? null : v))),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
function series(first, last, count = 40) {
  const end = Date.parse("2026-11-10T08:00:00.000Z");
  return JSON.stringify({ candles: Array.from({ length: count }, (_, i) => {
    const open = end - (count - i) * 4 * H, c = first + ((last - first) * i) / (count - 1) + (i % 3) * 0.1;
    return { open_time: new Date(open).toISOString(), close_time: new Date(open + 4 * H).toISOString(), open: c, high: c + 1, low: c - 1, close: c };
  }) });
}
/** Agents answer from their id: the dollar and yields fall (gold up); the calendar holds its rule. */
function fakeAI() {
  const calls = [];
  const ai = {
    calls,
    run: async (model, request) => {
      const text = request.messages.map((m) => m.content).join("\n");
      calls.push(text);
      let content;
      if (/moderator of the XAUUSD Macro War Room/.test(text)) content = { bias: "BULLISH", confidence: 0.62, summary: "A softer dollar and lower yields support gold, while the coming inflation report is the main risk.", reasons: ["The dollar slipped over the day.", "Yields eased."], drivers: ["dollar", "rates"] };
      else {
        const agent = text.match(/"agent":"(\w+)"/)[1];
        const bias = agent === "calendar" ? (text.match(/Your bias (?:is|stays) (\w+)/)?.[1] ?? "NEUTRAL") : agent === "silver" ? "NEUTRAL" : "BULLISH";
        content = /Consensus Discussion/.test(text)
          ? { agent, bias, confidence: 0.5, rebuts: ["dollar"], argument: "The Dollar Analyst overstates a small move." }
          : { agent, bias, confidence: 0.6, claim: `The ${agent} view points this way for gold.` };
      }
      return { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { total_tokens: 20 } };
    }
  };
  return ai;
}
function makeEnv() {
  const m = new Map(Object.entries({
    "market-data:v2:series:OANDA:XAUUSD|4h": series(4000, 4080),
    "market-data:v2:series:TVC:DXY|4h": series(101, 99),
    "market-data:v2:series:TVC:US10Y|4h": series(4.4, 4.2),
    "market-data:v2:series:OANDA:XAGUSD|4h": series(48, 49),
    [CALENDAR_KEY]: JSON.stringify({ fetched_at: new Date(NOW).toISOString(), events: [{ title: "CPI m/m", currency: "USD", impact: "High", time: "2026-11-10T13:30:00.000Z", forecast: "0.4%", previous: "0.2%" }] })
  }));
  return { DB: fakeD1(), AI: fakeAI(), MACRO_ROOM_ENABLED: "true", MACRO_ROOM_MAX_CALLS_PER_HOUR: "30", SIGNAL_CACHE: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
}

test("a session: bus, Consensus Discussion, conclusion; read back, fed to the desks, shown unweighted in the Global decision", async () => {
  resetThreadSchemaCacheForTests();
  const env = makeEnv();
  const clock = () => NOW;
  const r = await runPendingMacroRooms(env, { now: NOW, clock });
  assert.equal(r.session, "4h:2026-11-10T08:00:00.000Z");
  assert.equal(r.status, "complete");
  assert.equal(r.openings, 5, "no News Daily yet: five agents");
  const calText = env.AI.calls.find((t) => /"agent":"calendar"/.test(t) && !/Consensus Discussion/.test(t));
  assert.match(calText, /Your bias is BEARISH/, "a hotter CPI is expected: the fixed rule says gold down");
  assert.doesNotMatch(calText, /4080|4000\.|"close"/, "no gold price level reaches the agents");
  const m = await readMacroRoom(env.DB, { now: NOW });
  assert.equal(m.conclusion.bias, "BULLISH");
  assert.deepEqual(m.conclusion.drivers, ["Dollar Analyst", "Rates Analyst"]);
  assert.ok(m.debate.some((d) => d.agent === "calendar"), "the dissenting Calendar Agent answers in the discussion");
  assert.equal(m.openings.find((o) => o.agent === "calendar").bias, "BEARISH");
  assert.deepEqual(await macroDeskEvidence(env.DB, { now: NOW }), { macro_bias: "BULLISH", confidence: 0.62, summary: m.conclusion.summary, horizon: "next 4 to 24 hours", session: "after a 4-hour close" });
  assert.equal(await macroDeskEvidence(env.DB, { now: NOW + 9 * H }), null, "stale after 8 hours");
  const before = env.AI.calls.length;
  assert.equal((await runMacroRoom(env, { run_id: r.session, kind: "4h", at: "2026-11-10T08:00:00.000Z" }, { clock, now: NOW })).status, "already_complete");
  assert.equal((await runPendingMacroRooms(env, { now: NOW, clock })).status, "idle");
  assert.equal(env.AI.calls.length, before, "a concluded session never spends again");
  const g = buildGlobalConclusion({ macro: m, now: NOW });
  const row = g.timeframes.find((t) => t.key === "MACRO");
  assert.deepEqual([row.action, row.lean, row.weighted], ["BULLISH", 0.62, false]);
  assert.equal(g.score, null, "the macro row never enters the weighted score");
  assert.equal((await runPendingMacroRooms({ ...env, MACRO_ROOM_ENABLED: "false" }, { now: NOW })).status, "disabled");
});
