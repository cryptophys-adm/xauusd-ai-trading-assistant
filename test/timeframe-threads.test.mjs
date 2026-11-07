import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { resetThreadSchemaCacheForTests } from "../src/agent-threads.mjs";
import {
  runTimeframeThread, runPendingTimeframeThreads, readTimeframeThread, validateTfConclusion, tfEvidence,
  tfThreadsEnabled, tfEntryAllowed, closedH1Key, TF_THREAD_CHARTS, TF_DESKS, TF_HUD_WAIT_MS, TF_ROOM_GAP_MS, TF_QUORUM_WAIT_MS
} from "../src/timeframe-threads.mjs";

const H4_MS = 4 * 3600_000;
// OANDA H4 bars open at 22:00 UTC (17:00 New York), so 02:00, 06:00, ... 22:00.
const LAST_OPEN = Date.parse("2026-11-05T18:00:00.000Z");
const H4_KEY = "OANDA:XAUUSD:240:" + LAST_OPEN;
const NOW = LAST_OPEN + H4_MS + 5 * 60_000;

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE ai_syntheses (id INTEGER PRIMARY KEY AUTOINCREMENT, candle_key TEXT NOT NULL, ticker TEXT, timeframe TEXT, timestamp TEXT, prophet_metrics TEXT, gmi_metrics TEXT, ai_analysis TEXT, ai_model TEXT)`);
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args.map((v) => (v === undefined ? null : v))),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
const kv = (init = {}) => { const m = new Map(Object.entries(init)); return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); } }; };

function series(lastOpen, stepMs, count = 60) {
  const candles = Array.from({ length: count }, (_, i) => {
    const open = lastOpen - (count - 1 - i) * stepMs;
    const base = 4000 + Math.sin(i / 3) * 20 + i;
    return { open_time: new Date(open).toISOString(), close_time: new Date(open + stepMs).toISOString(), open: base, high: base + 12, low: base - 9, close: base + 3, volume: 1000 + i };
  });
  return JSON.stringify({ candles });
}
const prophetRecord = ({ buy = false } = {}) => JSON.stringify({ engine: "prophet", timeframe: "240", values: { comparable: {
  prophet_r38: { direction: 1, buy_confirmed: buy, sell_confirmed: false, t_enc: 2, d_enc: 1, structure_subtype: 0 }
} } });
function hudSnapshot(candleKey, timeframe) {
  return JSON.stringify({
    schema_version: "cryptophys.hud-snapshot.v1", symbol: "OANDA:XAUUSD", timeframe, candle_key: candleKey, computed_at: new Date(NOW).toISOString(), not_computed: ["grid_bot_protocol"],
    huds: {
      kinetic_engine: { fields: { theta: 43, omega: -0.4, alpha: -0.1, entropy: 0.86, is_chaos: true }, parity: {} },
      fabio_amt: { fields: { vah: 4071, val: 3894, poc: 3948 }, parity: {} }
    }
  });
}

/** Each agent answers from its Required JSON line; the moderator writes the TLDR. */
function fakeAI({ conclusion = null, confidence = 0.35, stances = {}, fail = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    run: async (model, request) => {
      calls.push({ model, request });
      const sys = request.messages[0].content, user = request.messages[1].content;
      const agent = (user.match(/Required JSON: \{"agent":"(\w+)"/) || [])[1];
      let content;
      if (/moderator of the XAUUSD/.test(sys)) content = conclusion || { stance: "WAIT", confidence: 0.5, summary: "The four-hour room leans up but has no confirmation yet, so it prefers to wait.", reasons: ["Structure points up without a confirmed signal.", "Volatility is normal for this chart."], dissent: [] };
      else if (fail.has(agent)) throw new Error("3021: rate limiting: inference request per min rate reached");
      else if (/Consensus Discussion/.test(sys)) content = { agent, stance: stances[agent] || "WAIT", confidence: 0.5, rebuts: [agent === "technical" ? "risk" : "technical"], argument: "The last candles closed near their highs, which argues against fading the move." };
      else content = { agent, stance: stances[agent] || "WAIT", confidence, claim: "My own data on this chart supports waiting for the next candle." };
      return { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { total_tokens: 40 } };
    }
  };
}

function env(ai, { records = true, hud = true, overrides = {}, buy = false } = {}) {
  const buffer = records ? { ["localcalc-observed:" + H4_KEY + ":prophet"]: prophetRecord({ buy }) } : {};
  const cache = { "market-data:v2:series:OANDA:XAUUSD|4h": series(LAST_OPEN, H4_MS) };
  if (hud) cache["hud:240:" + H4_KEY] = hudSnapshot(H4_KEY, "240");
  return { DB: fakeD1(), AI: ai, WEBHOOK_BUFFER: kv(buffer), SIGNAL_CACHE: kv(cache), TF_THREADS_ENABLED: "true", TF_THREADS_MAX_CALLS_PER_HOUR: "120", MODEL_RATE_LIMIT_RETRY_MS: "0", ...overrides };
}
const fixedClock = () => NOW;

test.beforeEach(() => resetThreadSchemaCacheForTests());

test("1H, 4H and D1 run here as War Rooms; desks have one role each", () => {
  assert.deepEqual(Object.keys(TF_THREAD_CHARTS), ["H1", "H4", "D1"]);
  assert.deepEqual(Object.values(TF_THREAD_CHARTS).map((c) => c.tab), ["1H", "4H", "D1"]);
  assert.deepEqual(Object.keys(TF_DESKS), ["h1", "h4", "d1", "htf", "news", "technical", "risk"]);
  assert.deepEqual(["h1", "h4", "d1"].map((id) => TF_DESKS[id].name), ["1H Desk", "4H Desk", "D1 Desk"], "each room has its own timeframe desk");
  assert.equal(tfThreadsEnabled({ TF_THREADS_ENABLED: "true" }), true);
  assert.equal(tfThreadsEnabled({}), false);
  assert.equal(closedH1Key(Date.parse("2026-11-06T01:10:00Z")), "OANDA:XAUUSD:60:" + Date.parse("2026-11-06T00:00:00Z"));
});

test("the TLDR: plain summary, one to three reasons, dissent by id, no entry without confirmation, 1H names the H1 decision", () => {
  const ok = { stance: "WAIT", confidence: 0.5, summary: "The room waits for confirmation.", reasons: ["Structure points up.", " "], dissent: ["Technical Analyst"] };
  assert.equal(validateTfConclusion(ok, { busAgents: ["technical", "risk"] }).valid, true);
  assert.deepEqual(ok.dissent, ["technical"], "a name in dissent maps to its id");
  const buy = { stance: "BUY", confidence: 0.6, summary: "The room leans to buy.", reasons: ["Momentum is up."], dissent: [] };
  const none = { chart_prophet_r38: { buy_confirmed: false, sell_confirmed: false } };
  assert.ok(validateTfConclusion({ ...buy }, { confirmations: none }).errors.includes("entry_without_confirmation"));
  assert.equal(validateTfConclusion({ ...buy }, { confirmations: { chart_prophet_r38: { buy_confirmed: true } } }).valid, true);
  assert.ok(validateTfConclusion({ ...ok, dissent: [] }, { h1Decision: "BUY" }).errors.includes("h1_reference_missing"));
  assert.equal(validateTfConclusion({ ...ok, dissent: [], summary: "H1 decision: BUY, but the room waits for confirmation." }, { h1Decision: "BUY" }).valid, true);
  assert.equal(tfEntryAllowed("HOLD", none), true);
});

test("evidence is the closed bar, its HUD snapshot and its local Prophet R38 confirmation; a bar not in the series gives none", async () => {
  const e = await tfEvidence(env(fakeAI(), { buy: true }), "H4", H4_KEY);
  assert.equal(e.bar_open, new Date(LAST_OPEN).toISOString());
  assert.equal(e.technical.candles.length, 12);
  assert.ok(e.hud.readings.kinetic_engine.available);
  assert.equal(e.confirmations.chart_prophet_r38.buy_confirmed, true);
  assert.equal(e.confirmations.chart_prophet_r38.approved_by_parity, false);
  assert.ok(!("h1" in e), "no room reads an H1 decision: the Reasoner decides after the 1H room (owner decision 2026-11-07)");
  assert.equal(await tfEvidence(env(fakeAI()), "H4", "OANDA:XAUUSD:240:" + (LAST_OPEN + H4_MS)), null);
});

test("a 4H War Room: every agent opens, the debate runs, the moderator concludes; the rerun spends nothing", async () => {
  const ai = fakeAI({ stances: { kinetic_engine: "SELL" } });
  const e = env(ai);
  const r = await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock });
  assert.equal(r.status, "complete");
  assert.equal(r.openings, 5, "the 4H Desk, technical, risk and the two HUD agents");
  assert.equal(r.rebuttals, 2, "the minority HUD agent and the Risk Manager");
  for (const call of ai.calls) assert.doesNotMatch(call.request.messages.map((m) => m.content).join("\n"), /lot size|take_profit/i);

  const thread = await readTimeframeThread(e.DB, "H4");
  assert.equal(thread.tab, "4H");
  assert.equal(thread.phase, "closed");
  assert.equal(thread.conclusion.stance, "WAIT");
  assert.ok(["BULLISH", "BEARISH", "NEUTRAL"].includes(thread.conclusion.bias), "the conclusion carries the bias beside the decision");
  assert.equal(thread.conclusion.majority_bias, thread.conclusion.bias);
  assert.deepEqual(thread.openings.map((p) => p.id), ["h4", "technical", "risk", "kinetic_engine", "fabio_amt"]);
  assert.equal(thread.openings[0].name, "4H Desk");
  assert.equal(thread.openings[3].calibration, "not yet calibrated");
  assert.deepEqual(thread.debate.map((d) => d.id), ["risk", "kinetic_engine"]);
  assert.ok(thread.debate[0].rebuts_names.length >= 1);

  assert.deepEqual(await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock }), { status: "already_complete", calls: 0 });
  assert.equal(await readTimeframeThread(e.DB, "D1"), null);
  assert.equal(await readTimeframeThread(e.DB, "W1"), null);
});

test("HUD agents with no verified statement speak at confidence <= 0.4; desks keep theirs", async () => {
  const e = env(fakeAI({ confidence: 0.9 }));
  await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock });
  const by = Object.fromEntries((await readTimeframeThread(e.DB, "H4")).openings.map((p) => [p.id, p]));
  assert.equal(by.kinetic_engine.confidence, 0.4);
  assert.equal(by.technical.confidence, 0.9);
  assert.equal(by.h4.confidence, 0.4, "a 4H Desk on records parity has not approved speaks at 0.4 or lower");
  assert.equal(by.h4.calibration, "4H local records, not parity approved");
});

test("openings carry a bias; a BUY or SELL conclusion needs an agent holding it", async () => {
  const conf = { chart_prophet_r38: { buy_confirmed: true, sell_confirmed: false } };
  const c = { stance: "BUY", confidence: 0.6, summary: "The room buys the confirmed signal.", reasons: ["Prophet R38 confirmed a buy."], dissent: [] };
  assert.ok(validateTfConclusion({ ...c }, { busAgents: ["technical"], confirmations: conf, supportStances: new Set(["WAIT"]) }).errors.includes("stance_without_support"));
  assert.equal(validateTfConclusion({ ...c }, { busAgents: ["technical"], confirmations: conf, supportStances: new Set(["BUY", "WAIT"]) }).valid, true);

  const ai = fakeAI();
  const run0 = ai.run;
  ai.run = async (model, request) => {
    const r = await run0(model, request);
    const body = JSON.parse(r.choices[0].message.content);
    if (body.claim && body.agent === "kinetic_engine") { body.bias = "BEARISH"; r.choices[0].message.content = JSON.stringify(body); }
    return r;
  };
  const e = env(ai);
  await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock });
  const t = await readTimeframeThread(e.DB, "H4");
  assert.equal(t.openings.find((o) => o.id === "kinetic_engine").bias, "BEARISH");
  assert.equal(t.openings.find((o) => o.id === "technical").bias, "NEUTRAL");
  const prompt = ai.calls.find((x) => /"agent":"technical"/.test(x.request.messages[1].content) && !/Consensus Discussion/.test(x.request.messages[0].content)).request.messages[1].content;
  assert.match(prompt, /"bias":"BULLISH\|BEARISH\|NEUTRAL"/);
  const mod = ai.calls.find((x) => /moderator of the XAUUSD/.test(x.request.messages[0].content)).request.messages.map((m) => m.content).join("\n");
  assert.match(mod, /needs at least one agent on the bus or in the Consensus Discussion holding that stance/);
});

test("the 4H Desk reads only its own bar, in words; without local records the room has no 4H Desk", async () => {
  const ai = fakeAI();
  const e = env(ai, { buy: true });
  await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock });
  const call = ai.calls.find((c) => /"agent":"h4"/.test(c.request.messages[1].content) && !/Consensus Discussion/.test(c.request.messages[0].content));
  const data = JSON.parse(call.request.messages[1].content.split("EVIDENCE:\n").at(-1).split("YOUR DATA:\n").at(-1));
  assert.equal(data.timeframe, "4-hour");
  assert.equal(data.approved_by_parity, false);
  assert.ok(data.reading.some((s) => /confirmed BUY/.test(s)));
  resetThreadSchemaCacheForTests();
  const none = env(fakeAI(), { records: false });
  await runTimeframeThread(none, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock });
  assert.ok(!(await readTimeframeThread(none.DB, "H4")).roster.some((a) => a.id === "h4"));
});

test("the 4H room's Higher-Timeframe Desk reads the D1 Thread's conclusion", async () => {
  const e = env(fakeAI());
  const d1Open = Date.parse("2026-11-04T22:00:00.000Z");
  e.SIGNAL_CACHE.put("market-data:v2:series:OANDA:XAUUSD|1D", series(d1Open, 24 * 3600_000));
  await runTimeframeThread(e, { chart: "D1", candleKey: "OANDA:XAUUSD:1D:" + d1Open }, { clock: fixedClock });
  const ev = await tfEvidence(e, "H4", H4_KEY);
  assert.equal(ev.higher.timeframe, "daily");
  assert.equal(ev.higher.stance, "WAIT");
});

test("the hourly budget caps the calls: the rest are stored as budget_exhausted", async () => {
  const ai = fakeAI();
  const e = env(ai, { overrides: { TF_THREADS_MAX_CALLS_PER_HOUR: "2" } });
  await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock });
  assert.equal(ai.calls.length, 2);
  const thread = await readTimeframeThread(e.DB, "H4");
  assert.equal(thread.openings.filter((p) => p.status === "budget_exhausted").length, thread.openings.length - 2);
});

test("the pending runner is off behind the flag, waits for the HUD snapshot, then runs the latest closed 4H bar", async () => {
  const ai = fakeAI();
  assert.deepEqual(await runPendingTimeframeThreads(env(ai, { overrides: { TF_THREADS_ENABLED: "false" } }), { now: NOW }), { status: "disabled" });
  const waiting = await runPendingTimeframeThreads(env(ai, { hud: false }), { now: NOW, clock: fixedClock });
  assert.deepEqual(waiting.charts, {}, "no HUD snapshot yet and the close is recent: wait");
  assert.equal(ai.calls.length, 0);
  const late = await runPendingTimeframeThreads(env(ai, { hud: false }), { now: LAST_OPEN + H4_MS + TF_HUD_WAIT_MS + 1, clock: fixedClock });
  assert.equal(late.charts.H4.status, "complete", "after the wait it runs with the desks only");
  resetThreadSchemaCacheForTests(); // a fresh database follows
  const out = await runPendingTimeframeThreads(env(fakeAI()), { now: NOW, clock: fixedClock });
  assert.equal(out.charts.H4.status, "complete");
  assert.equal(out.charts.D1, undefined, "no daily series cached: no D1 key");
});

test("due rooms run one after another, the higher timeframe first: the 4H room reads the D1 conclusion just written", async () => {
  const ai = fakeAI();
  const e = env(ai);
  const d1Open = Date.parse("2026-11-04T22:00:00.000Z"); // closes with the 4H bar, at 22:00
  const d1Key = "OANDA:XAUUSD:1D:" + d1Open;
  await e.SIGNAL_CACHE.put("market-data:v2:series:OANDA:XAUUSD|1D", series(d1Open, 24 * 3600_000));
  await e.SIGNAL_CACHE.put("hud:1D:" + d1Key, hudSnapshot(d1Key, "1D"));
  const slept = [];
  const out = await runPendingTimeframeThreads(e, { now: NOW, clock: fixedClock, sleep: async (ms) => { slept.push(ms); } });
  assert.deepEqual(Object.keys(out.charts), ["D1", "H4"]);
  assert.deepEqual(slept, [TF_ROOM_GAP_MS], "one gap between the two rooms, for the per-minute model limit");
  assert.equal(out.charts.D1.status, "complete");
  const h4 = await readTimeframeThread(e.DB, "H4");
  assert.ok(h4.roster.some((a) => a.id === "htf"), "the 4H room has the Higher-Timeframe Desk");
  const firstH4Call = ai.calls.findIndex((c) => /4-hour War Room/.test(c.request.messages[0].content));
  const lastD1Call = ai.calls.map((c) => /daily War Room/.test(c.request.messages[0].content)).lastIndexOf(true);
  assert.ok(lastD1Call < firstH4Call, "no 4H call before the D1 room is done");
});

test("a room with fewer than half of its agents heard waits for the next sweep, which retries only the failed openings", async () => {
  const e = env(fakeAI({ fail: new Set(["technical", "risk", "kinetic_engine"]) }));
  const first = await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock });
  assert.equal(first.status, "waiting_for_quorum");
  assert.equal((await readTimeframeThread(e.DB, "H4")).conclusion, null, "no TLDR from one agent out of four");
  const ai = fakeAI();
  e.AI = ai;
  const second = await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock });
  assert.equal(second.status, "complete");
  const openingCalls = ai.calls.filter((c) => /Required JSON: \{"agent":"\w+","stance":"BUY\|SELL\|HOLD\|WAIT\|CLOSE","bias":"BULLISH\|BEARISH\|NEUTRAL","confidence":0\.\.1,"claim"/.test(c.request.messages[1].content));
  assert.equal(openingCalls.length, 3, "only the three failed openings are asked again");
});

test("past the quorum wait a room concludes with whoever spoke", async () => {
  const e = env(fakeAI({ fail: new Set(["technical", "risk", "kinetic_engine"]) }));
  const late = () => LAST_OPEN + H4_MS + TF_QUORUM_WAIT_MS + 1;
  assert.equal((await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: late })).status, "complete");
});

test("a room that concluded without its HUD snapshot re-convenes once when the snapshot arrives late", async () => {
  const ai = fakeAI();
  const e = env(ai, { hud: false });
  assert.equal((await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock })).status, "complete");
  const before = await readTimeframeThread(e.DB, "H4");
  assert.equal(before.hud_snapshot, false);
  assert.deepEqual(before.roster.map((a) => a.id), ["h4", "technical", "risk"]);
  assert.deepEqual(await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock }), { status: "already_complete", calls: 0 }, "no snapshot yet: nothing to add");

  // Owner decision 2026-11-06 (D1 catch-up): the pull adapter publishes the missed snapshot late.
  await e.SIGNAL_CACHE.put("hud:240:" + H4_KEY, hudSnapshot(H4_KEY, "240"));
  const again = await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock });
  assert.equal(again.status, "complete");
  assert.equal(again.reconvened, true);
  const after = await readTimeframeThread(e.DB, "H4");
  assert.equal(after.hud_snapshot, true);
  assert.deepEqual(after.roster.map((a) => a.id), ["h4", "technical", "risk", "kinetic_engine", "fabio_amt"]);
  assert.equal(after.bar_open, before.bar_open, "the same bar, one room");
  assert.equal(after.bar_close, before.bar_close);
  assert.equal(after.phase, "closed");
  assert.deepEqual(await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock }), { status: "already_complete", calls: 0 }, "once only");
});

test("the 1H room meets before the H1 decision: its desk reads the local records, nobody reads an H1 decision (owner decision 2026-11-07)", async () => {
  const H1 = 3600_000;
  const h1Open = Date.parse("2026-11-07T09:00:00.000Z");
  const h1Key = "OANDA:XAUUSD:60:" + h1Open;
  const now = h1Open + H1 + 10 * 60_000;
  const ai = fakeAI();
  const e = env(ai, { records: false });
  // A stale H1 synthesis of an earlier bar must not reach the room.
  e.DB.raw.prepare("INSERT INTO ai_syntheses (candle_key, timeframe, ai_analysis) VALUES (?, '60', ?)").run("OANDA:XAUUSD:60:" + (h1Open - H1), JSON.stringify({ decision: { decision: "SELL", confidence: 0.9, reasoning: "old" } }));
  await e.SIGNAL_CACHE.put("market-data:v2:series:OANDA:XAUUSD|1h", series(h1Open, H1));
  await e.SIGNAL_CACHE.put("hud:60:" + h1Key, hudSnapshot(h1Key, "60"));
  await e.WEBHOOK_BUFFER.put("localcalc:" + h1Key + ":prophet", prophetRecord());
  const rooms = [];
  const out = await runPendingTimeframeThreads(e, { now, clock: () => now, sleep: async () => {}, onRoom: async (r) => { rooms.push(r); } });
  assert.equal(out.charts.H1.status, "complete");
  assert.deepEqual(rooms.filter((r) => r.chart === "H1").map((r) => [r.key, r.result.status]), [[h1Key, "complete"]], "the caller hears the 1H room conclude");

  const room = await readTimeframeThread(e.DB, "H1", { candleKey: h1Key });
  assert.equal(room.openings[0].id, "h1");
  assert.equal(room.openings[0].name, "1H Desk");
  assert.equal(room.roster[0].calibration, "parity-approved 1H chain");
  assert.equal(room.conclusion.status, "ok");
  assert.equal(await readTimeframeThread(e.DB, "H1", { candleKey: "OANDA:XAUUSD:60:" + (h1Open - H1) }), null, "the room of another bar is not this one");
  const prompts = ai.calls.map((c) => c.request.messages.map((m) => m.content).join("\n"));
  assert.ok(prompts.every((p) => !/h1_decision|H1 decision chain decided|"SELL","confidence":0.9/.test(p)), "no prompt carries an H1 decision");
  const desk = prompts.find((p) => /"agent":"h1"/.test(p) && !/Consensus Discussion/.test(p));
  assert.match(desk, /local Prophet .* of the 1-hour candle that just closed/);
  assert.match(prompts.find((p) => /moderator of the XAUUSD 1-hour War Room/.test(p)), /The Consensus Discussion is closed\. .*The Reasoner writes the H1 decision after you/);
});

test("an onRoom failure is recorded on the room and never stops the sweep", async () => {
  const h1Open = Date.parse("2026-11-07T09:00:00.000Z");
  const h1Key = "OANDA:XAUUSD:60:" + h1Open;
  const now = h1Open + 3600_000 + 10 * 60_000;
  const e = env(fakeAI(), { records: false });
  await e.SIGNAL_CACHE.put("market-data:v2:series:OANDA:XAUUSD|1h", series(h1Open, 3600_000));
  await e.SIGNAL_CACHE.put("hud:60:" + h1Key, hudSnapshot(h1Key, "60"));
  const out = await runPendingTimeframeThreads(e, { now, clock: () => now, sleep: async () => {}, onRoom: async () => { throw new Error("reasoner down"); } });
  assert.equal(out.charts.H1.status, "complete");
  assert.equal(out.charts.H1.on_room_error, "reasoner down");
});

test("a moderator answer that stays invalid is asked once from the moderator's fallback model (preview-e2e 2026-11-07)", async () => {
  const base = fakeAI();
  const ai = {
    calls: base.calls,
    run: async (model, request) => {
      if (/moderator of the XAUUSD/.test(request.messages[0].content) && model === "@cf/openai/gpt-oss-120b") {
        base.calls.push({ model, request });
        return { choices: [{ message: { content: JSON.stringify({ stance: "WAIT", confidence: 0.5, summary: "", reasons: [], dissent: [] }) }, finish_reason: "stop" }] };
      }
      return base.run(model, request);
    }
  };
  const e = env(ai);
  const r = await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock });
  assert.equal(r.status, "complete");
  const thread = await readTimeframeThread(e.DB, "H4");
  assert.equal(thread.conclusion.status, "ok");
  assert.equal(thread.conclusion.model, "@cf/google/gemma-4-26b-a4b-it");
  assert.equal(thread.conclusion.fallback_used, true);
  const moderatorCalls = ai.calls.filter((c) => /moderator of the XAUUSD/.test(c.request.messages[0].content)).map((c) => c.model);
  assert.deepEqual(moderatorCalls, ["@cf/openai/gpt-oss-120b", "@cf/google/gemma-4-26b-a4b-it"], "the primary once (no rule correction for a missing summary), then the fallback once");
});

test("a conclusion that failed shows its errors and model for diagnosis", async () => {
  const ai = fakeAI({ conclusion: { stance: "WAIT", confidence: 0.5, summary: "", reasons: [], dissent: [] } });
  const e = env(ai);
  await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock });
  const c = (await readTimeframeThread(e.DB, "H4")).conclusion;
  assert.equal(c.status, "invalid_output");
  assert.ok(c.errors.includes("summary_missing"), JSON.stringify(c));
  assert.ok(c.model);
});
