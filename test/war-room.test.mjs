import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { resetThreadSchemaCacheForTests, buildLiveRoomTask } from "../src/agent-threads.mjs";
import {
  runWarRoomBar, readWarRoom, readTldr, warRoomEnabled, majorityStance, selectRebutters,
  validateOpening, validateRebuttal, validateConclusion, WAR_ROOM_DEBATE_MS, DESK_AGENTS, entryAllowed
} from "../src/war-room.mjs";

const BAR = "2026-11-05T14:45:00.000Z";
const H1_KEY = "OANDA:XAUUSD:60:1793883600000";
const K15 = "OANDA:XAUUSD:15:" + (Date.parse(BAR) - 900_000);

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE ai_syntheses (id INTEGER PRIMARY KEY AUTOINCREMENT, candle_key TEXT NOT NULL, ticker TEXT, timeframe TEXT, timestamp TEXT, prophet_metrics TEXT, gmi_metrics TEXT, ai_analysis TEXT, ai_model TEXT)`);
  db.exec(`CREATE TABLE bus_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, candle_key TEXT NOT NULL, round INTEGER NOT NULL, agent TEXT NOT NULL, ts TEXT NOT NULL, insight TEXT NOT NULL, confidence REAL, refs_json TEXT, model TEXT, status TEXT, latency_ms INTEGER, fallback_used INTEGER DEFAULT 0, usage_tokens INTEGER)`);
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
const kv = (init = {}) => { const m = new Map(Object.entries(init)); return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); } }; };

function m5Context() {
  const bars = Array.from({ length: 12 }, (_, i) => ({ t: new Date(Date.parse(BAR) - (11 - i) * 300_000).toISOString(), o: 4100 + i, h: 4103 + i, l: 4098 + i, c: 4101 + i, v: 10 }));
  return { schema_version: "cryptophys.local-context.v1", trust_status: "informational_unverified", symbol: "OANDA:XAUUSD", timeframe: "5", candle_time: BAR, bias: "BEARISH", buy_confirmed: false, sell_confirmed: false, d_enc: -1, recent_bars: bars };
}
function hudSnapshot() {
  return {
    schema_version: "cryptophys.hud-snapshot.v1", symbol: "OANDA:XAUUSD", timeframe: "15", candle_key: K15, computed_at: BAR, not_computed: ["grid_bot_protocol"],
    huds: {
      kinetic_engine: { fields: { theta: 43, omega: -0.4, alpha: -0.1, entropy: 0.86, is_chaos: true }, parity: {} },
      fabio_amt: { fields: { vah: 4071, val: 3894, poc: 3948 }, parity: {} }
    }
  };
}

/** Each agent answers from its Required JSON line; `stances` overrides an agent's opening stance. */
function fakeAI({ stances = {}, conclusion = null, fail = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    run: async (model, request) => {
      calls.push({ model, request });
      const sys = request.messages[0].content, user = request.messages[1].content;
      const agent = (user.match(/Required JSON: \{"agent":"(\w+)"/) || [])[1];
      let content;
      if (/moderator of the XAUUSD Live War Room/.test(sys)) content = conclusion || { stance: "WAIT", confidence: 0.6, summary: "Stay flat: the flush has no confirmation and the higher timeframe still says wait.", reasons: ["The 5m read gives no trigger.", "Volatility is high after the flush."], dissent: ["kinetic_engine"] };
      else if (fail.has(agent)) throw new Error("model down");
      else if (/debate/.test(sys)) content = { agent, stance: stances[agent] || "WAIT", confidence: 0.55, rebuts: [agent === "technical" ? "risk" : "technical"], argument: "The flush was on rising volume, which argues against reading it as a stop hunt." };
      else content = { agent, stance: stances[agent] || "WAIT", confidence: agent === "kinetic_engine" ? 0.7 : 0.5, claim: "My own data supports waiting for the next candle." };
      return { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { total_tokens: 50 } };
    }
  };
}

function env(ai, overrides = {}) {
  const d1 = fakeD1();
  d1.raw.prepare("INSERT INTO ai_syntheses (candle_key, timeframe, ai_analysis, prophet_metrics, gmi_metrics) VALUES (?, '60', ?, ?, ?)").run(
    H1_KEY, JSON.stringify({ decision: { decision: "WAIT", confidence: 0, reasoning: "No trade for this candle: GMI blocks the setup." } }), JSON.stringify({ prophet_r38: { direction: 0 } }), JSON.stringify({ verdict: 0, gate: -1 })
  );
  return { DB: d1, AI: ai, SIGNAL_CACHE: kv({ ["hud:15:" + K15]: JSON.stringify(hudSnapshot()) }), WEBHOOK_BUFFER: kv(), WAR_ROOM_ENABLED: "true", WAR_ROOM_MAX_CALLS_PER_HOUR: "112", ...overrides };
}
const task = () => buildLiveRoomTask({ barTime: BAR, context: m5Context() });

test.beforeEach(() => resetThreadSchemaCacheForTests());

test("flag off means no calls; the debate window is three minutes", async () => {
  const ai = fakeAI();
  assert.equal((await runWarRoomBar(env(ai, { WAR_ROOM_ENABLED: "false" }), task())).status, "disabled");
  assert.equal(ai.calls.length, 0);
  assert.equal(warRoomEnabled({}), false);
  assert.equal(WAR_ROOM_DEBATE_MS, 180_000);
});

test("every agent opens on the bus, the minority and the Risk Manager rebut, the moderator concludes", async () => {
  const ai = fakeAI({ stances: { kinetic_engine: "SELL", technical: "SELL" } });
  const e = env(ai);
  const result = await runWarRoomBar(e, task());
  assert.equal(result.status, "complete");
  const room = await readWarRoom(e.DB);
  assert.equal(room.phase, "closed");
  assert.deepEqual(room.roster.map(r => r.id), ["h1", "news", "technical", "risk", "kinetic_engine", "fabio_amt"], "desks, then one agent per computed 15m HUD");
  assert.equal(room.openings.length, 6);
  assert.ok(room.openings.every(o => o.status === "ok" && o.claim));
  assert.deepEqual(room.debate.map(d => d.id).sort(), ["kinetic_engine", "risk", "technical"], "the two SELL agents (minority) and the Risk Manager");
  assert.ok(room.debate.every(d => d.rebuts.length && d.rebuts_names.length));
  assert.equal(room.conclusion.stance, "WAIT");
  assert.deepEqual(room.conclusion.dissent, [{ id: "kinetic_engine", name: "Kinetic Engine (TVA)" }]);
  assert.equal(room.conclusion.majority, "WAIT");
  assert.equal(room.h1.decision, "WAIT");
  assert.equal(ai.calls.length, 6 + 3 + 1);
  assert.ok(ai.calls.every(c => c.model === "@cf/zai-org/glm-5.3-flash"), "primary model only");

  // Openings stay inside their own role: the HUD agent sees only its HUD reading.
  const kinetic = ai.calls.find(c => /"agent":"kinetic_engine"/.test(c.request.messages[1].content) && !/debate/.test(c.request.messages[0].content));
  const data = JSON.parse(kinetic.request.messages[1].content.split("YOUR DATA:\n")[1]);
  assert.deepEqual(Object.keys(data), ["hud", "timeframe", "reading"]);
  // The debate sees the whole bus.
  const rebuttal = ai.calls.find(c => /debate/.test(c.request.messages[0].content));
  assert.equal(JSON.parse(rebuttal.request.messages[1].content.split("COMMUNICATION BUS (id, name, stance, confidence, evidence, claim):\n")[1]).length, 6);

  assert.equal((await runWarRoomBar(e, task())).status, "already_complete", "idempotent per bar");
});

test("a unanimous room: the Risk Manager stress-tests the consensus", async () => {
  const ai = fakeAI();
  const e = env(ai);
  await runWarRoomBar(e, task());
  const room = await readWarRoom(e.DB);
  assert.deepEqual(room.debate.map(d => [d.id, d.status]), [["risk", "ok"]]);
  const prompt = ai.calls.find(c => /debate/.test(c.request.messages[0].content)).request.messages.map(m => m.content).join("\n");
  assert.match(prompt, /The bus is unanimous\. Stress-test the consensus/);
});

test("openings read back in roster order, whatever order the parallel steps finished in", async () => {
  // The news desk answers last; the bus still lists h1, news, technical, risk, then the HUDs.
  const slow = fakeAI();
  const run = slow.run;
  slow.run = async (model, request) => { if (/"agent":"h1"/.test(request.messages[1].content) && !/debate/.test(request.messages[0].content)) await new Promise(r => setTimeout(r, 20)); return run(model, request); };
  const e = env(slow);
  await runWarRoomBar(e, task());
  assert.deepEqual((await readWarRoom(e.DB)).openings.map(o => o.id), ["h1", "news", "technical", "risk", "kinetic_engine", "fabio_amt"]);
});

test("no confirmation, no entry: the Risk Manager enforces it and a BUY conclusion needs a confirmed buy", async () => {
  const none = { h1_prophet_r38: { buy_confirmed: false, sell_confirmed: false }, m5_prophet_r38: { buy_confirmed: true, sell_confirmed: false, verified: false } };
  assert.equal(entryAllowed("WAIT", none), true);
  assert.equal(entryAllowed("BUY", none), false, "an UNVERIFIED 5m confirmation does not count");
  assert.equal(entryAllowed("BUY", { ...none, m5_prophet_r38: { ...none.m5_prophet_r38, verified: true } }), true, "a VERIFIED 5m confirmation candle does");
  assert.equal(entryAllowed("SELL", { ...none, h1_prophet_r38: { buy_confirmed: false, sell_confirmed: true } }), true);

  const buy = { stance: "BUY", confidence: 0.6, summary: "H1 decision: WAIT, but the room buys the dip.", reasons: ["Momentum turned up."], dissent: [] };
  const ai = fakeAI({ conclusion: buy });
  const e = env(ai);
  await runWarRoomBar(e, task());
  const room = await readWarRoom(e.DB);
  assert.equal(room.conclusion.status, "invalid_output", "no confirmed buy in this bar: the BUY conclusion is rejected");
  assert.deepEqual(room.confirmations.h1_prophet_r38, { buy_confirmed: false, sell_confirmed: false });
  const riskOpening = ai.calls.find(c => /"agent":"risk"/.test(c.request.messages[1].content) && !/debate/.test(c.request.messages[0].content)).request.messages.map(m => m.content).join("\n");
  assert.match(riskOpening, /Rule: no confirmation, no entry/);
  assert.ok(JSON.parse(riskOpening.split("YOUR DATA:\n")[1]).confirmations, "the Risk Manager sees the confirmations");
  const moderator = ai.calls.find(c => /moderator of the XAUUSD Live War Room/.test(c.request.messages[0].content)).request.messages.map(m => m.content).join("\n");
  assert.match(moderator, /no confirmation, no entry[\s\S]*CONFIRMATIONS/);

  // With a confirmed H1 buy the same conclusion is accepted.
  resetThreadSchemaCacheForTests();
  const e2 = env(fakeAI({ conclusion: buy }));
  e2.DB.raw.prepare("UPDATE ai_syntheses SET prophet_metrics = ?").run(JSON.stringify({ prophet_r38: { direction: 1, buy_confirmed: true } }));
  await runWarRoomBar(e2, task());
  assert.equal((await readWarRoom(e2.DB)).conclusion.status, "ok");
});

test("calibration status is shown once: no disclaimer asked, uncalibrated HUD confidence capped, evidence on the bus", async () => {
  const ai = fakeAI({ stances: { kinetic_engine: "SELL" } });
  const run = ai.run;
  // The model writes the agent id with a space, as production did for interstellar_eyes.
  ai.run = async (model, request) => {
    const r = await run(model, request);
    const body = JSON.parse(r.choices[0].message.content);
    if (body.agent === "fabio_amt") body.agent = "fabio amt";
    r.choices[0].message.content = JSON.stringify(body);
    return r;
  };
  const e = env(ai);
  await runWarRoomBar(e, task());
  const room = await readWarRoom(e.DB);
  const kinetic = room.openings.find(o => o.id === "kinetic_engine");
  assert.equal(kinetic.confidence, 0.4, "no verified statement: confidence capped at 0.4 (the model said 0.7)");
  assert.equal(room.openings.find(o => o.id === "fabio_amt").status, "ok", "an id written with a space still names the agent");
  assert.deepEqual(room.roster.find(r => r.id === "kinetic_engine").calibration, { verified_lines: 0, derived_lines: 0, total_lines: room.roster.find(r => r.id === "kinetic_engine").calibration.total_lines });
  const hudPrompt = ai.calls.find(c => /"agent":"kinetic_engine"/.test(c.request.messages[1].content) && !/debate/.test(c.request.messages[0].content)).request.messages.map(m => m.content).join("\n");
  assert.match(hudPrompt, /never mention calibration, verification or comparators/);
  const debate = ai.calls.find(c => /debate/.test(c.request.messages[0].content)).request.messages.map(m => m.content).join("\n");
  const bus = JSON.parse(debate.split("COMMUNICATION BUS (id, name, stance, confidence, evidence, claim):\n")[1]);
  assert.equal(bus.find(b => b.id === "kinetic_engine").evidence, "no statement calibrated yet");
  assert.equal(bus.find(b => b.id === "h1").evidence, "parity-approved H1 chain");
  assert.match(debate, /call agents by their names/);
});

test("computed from verified bars: Camarilla and session statements lift the 0.4 cap only when the candle's bar matched TradingView", async () => {
  const snapshot = {
    ...hudSnapshot(),
    huds: {
      interstellar_eyes: { fields: { close: 4050, camarilla: { D: { h4: 4100, h3: 4070, l3: 4010, l4: 3990 } }, band: { D: "l3_h3" } }, parity: {} },
      kinetic_engine: { fields: { theta: 43, omega: -0.4, alpha: -0.1, entropy: 0.86, is_chaos: true }, parity: {} }
    }
  };
  const run = async ({ approved, comparison }) => {
    resetThreadSchemaCacheForTests();
    const ai = fakeAI();
    const run0 = ai.run;
    ai.run = async (model, request) => {
      const r = await run0(model, request);
      const body = JSON.parse(r.choices[0].message.content);
      if (body.agent === "interstellar_eyes" && body.claim) { body.confidence = 0.7; r.choices[0].message.content = JSON.stringify(body); }
      return r;
    };
    const e = env(ai, { SIGNAL_CACHE: kv({ ["hud:15:" + K15]: JSON.stringify(snapshot) }) });
    e.DB.raw.exec("CREATE TABLE engine_parity_comparisons (engine TEXT, candle_key TEXT, result TEXT)");
    if (comparison) e.DB.raw.prepare("INSERT INTO engine_parity_comparisons VALUES ('prophet_m15', ?, ?)").run(K15, comparison);
    if (approved) await e.WEBHOOK_BUFFER.put("localcalc:" + K15 + ":prophet", JSON.stringify({ values: { comparable: { prophet_r38: { direction: 0 } } } }));
    await runWarRoomBar(e, task());
    return { room: await readWarRoom(e.DB), ai };
  };

  const ok = await run({ approved: true, comparison: "match" });
  assert.deepEqual(ok.room.roster.find(r => r.id === "interstellar_eyes").calibration, { verified_lines: 0, derived_lines: 1, total_lines: 1 });
  assert.equal(ok.room.openings.find(o => o.id === "interstellar_eyes").confidence, 0.7, "a statement computed from verified bars lifts the cap");
  assert.equal(ok.room.openings.find(o => o.id === "kinetic_engine").confidence, 0.4, "engine internals stay capped");
  const prompt = ok.ai.calls.find(c => /"agent":"interstellar_eyes"/.test(c.request.messages[1].content) && !/debate/.test(c.request.messages[0].content)).request.messages[1].content;
  assert.match(prompt, /Computed from verified bars: On the daily Camarilla levels/);
  const debate = ok.ai.calls.find(c => /debate/.test(c.request.messages[0].content)).request.messages.map(m => m.content).join("\n");
  const bus = JSON.parse(debate.split("COMMUNICATION BUS (id, name, stance, confidence, evidence, claim):\n")[1]);
  assert.equal(bus.find(b => b.id === "interstellar_eyes").evidence, "1 computed from verified bars (of 1 statement)");

  for (const [label, args] of [["no comparison yet", { approved: true }], ["the bar differed from TradingView", { approved: true, comparison: "input_mismatch" }], ["no approved record", { approved: false, comparison: "match" }]]) {
    const r = await run(args);
    assert.deepEqual(r.room.roster.find(x => x.id === "interstellar_eyes").calibration, { verified_lines: 0, derived_lines: 0, total_lines: 1 }, label);
    assert.equal(r.room.openings.find(o => o.id === "interstellar_eyes").confidence, 0.4, label);
  }
});

test("a persuaded dissenter concedes in the debate and stays on the record", async () => {
  // Production 2026-11-06: the News Analyst dropped SELL for WAIT and wrote rebuts ["news"]; the
  // concession was rejected as rebuts_invalid every half hour.
  const ai = fakeAI({ stances: { kinetic_engine: "SELL" } });
  const run = ai.run;
  ai.run = async (model, request) => {
    const r = await run(model, request);
    const body = JSON.parse(r.choices[0].message.content);
    if (/debate/.test(request.messages[0].content) && body.agent === "kinetic_engine") {
      Object.assign(body, { stance: "WAIT", rebuts: ["kinetic_engine"], argument: "The H1 decision is WAIT and my channel read is not calibrated, so I drop my SELL and stay flat." });
      r.choices[0].message.content = JSON.stringify(body);
    }
    return r;
  };
  const e = env(ai);
  await runWarRoomBar(e, task());
  const room = await readWarRoom(e.DB);
  const k = room.debate.find(d => d.id === "kinetic_engine");
  assert.equal(k.status, "ok");
  assert.equal(k.conceded, true);
  assert.equal(k.stance, "WAIT");
  assert.deepEqual(k.rebuts, []);
  assert.equal(room.debate.find(d => d.id === "risk").conceded, false);
  const prompt = ai.calls.find(c => /debate/.test(c.request.messages[0].content)).request.messages.map(m => m.content).join("\n");
  assert.match(prompt, /never your own id/);
});

test("a failed opening stays out of the bus; the room still concludes", async () => {
  const e = env(fakeAI({ fail: new Set(["news"]) }));
  await runWarRoomBar(e, task());
  const room = await readWarRoom(e.DB);
  assert.equal(room.openings.find(o => o.id === "news").status, "agent_failed");
  assert.equal(room.conclusion.status, "ok");
});

test("a conclusion that differs from the H1 decision must name it", async () => {
  const bad = { stance: "SELL", confidence: 0.6, summary: "Sell the flush.", reasons: ["Momentum is down."], dissent: [] };
  const e = env(fakeAI({ conclusion: bad }));
  await runWarRoomBar(e, task());
  const room = await readWarRoom(e.DB);
  assert.equal(room.conclusion.status, "invalid_output");
  assert.equal(validateConclusion({ ...bad, summary: "H1 decision: WAIT, but the room sells the flush." }, "WAIT", ["h1"]).valid, true);
});

test("blank reasons are dropped before the conclusion is judged; an all-blank list still fails", () => {
  const c = { stance: "WAIT", confidence: 0.75, summary: "H1 decision: WAIT. The room agrees.", reasons: ["The H1 decision is WAIT.", "News is mixed.", "The 5m flag is unverified.", ""], dissent: [] };
  const r = validateConclusion(c, "WAIT", ["h1"]);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.deepEqual(c.reasons, ["The H1 decision is WAIT.", "News is mixed.", "The 5m flag is unverified."]);
  assert.deepEqual(validateConclusion({ ...c, reasons: ["", "  "] }, "WAIT", ["h1"]).errors.includes("reasons_invalid"), true);
});

test("the hourly budget caps the whole room", async () => {
  const e = env(fakeAI(), { WAR_ROOM_MAX_CALLS_PER_HOUR: "3" });
  await runWarRoomBar(e, task());
  const statuses = e.DB.raw.prepare("SELECT status FROM agent_thread_messages WHERE step <> 'brief'").all().map(r => r.status);
  assert.equal(statuses.filter(s => s !== "budget_exhausted").length, 3);
});

test("selection and validators", () => {
  const o = (agent, stance, confidence) => ({ agent, stance, confidence });
  const openings = [o("h1", "WAIT", 0.5), o("risk", "WAIT", 0.5), o("a", "SELL", 0.9), o("b", "SELL", 0.4), o("c", "WAIT", 0.5)];
  assert.equal(majorityStance(openings), "WAIT");
  assert.equal(majorityStance([o("a", "BUY", 1), o("b", "WAIT", 1)], "WAIT"), "WAIT", "ties prefer WAIT");
  assert.deepEqual(selectRebutters(openings, "WAIT"), ["a", "b", "risk"]);
  assert.equal(selectRebutters(Array.from({ length: 12 }, (_, i) => o("x" + i, "BUY", i / 12)), "WAIT").length, 7, "at most 7 minority agents (plus risk when present)");
  assert.equal(validateOpening({ agent: "h1", stance: "WAIT", confidence: 0.5, claim: "refs: h1.decision" }, "h1").valid, false, "natural language only");
  assert.equal(validateRebuttal({ agent: "risk", stance: "WAIT", confidence: 0.5, rebuts: ["risk"], argument: "No." }, "risk", ["risk", "h1"]).valid, false, "an agent that keeps its stance never rebuts only itself");
  assert.equal(validateRebuttal({ agent: "risk", stance: "WAIT", confidence: 0.5, rebuts: ["ghost"], argument: "No." }, "risk", ["risk", "h1"]).valid, false, "rebuts must name a bus agent");
  assert.ok(Object.keys(DESK_AGENTS).every(k => DESK_AGENTS[k].role));
  const named = { agent: "risk", stance: "WAIT", confidence: 0.5, rebuts: ["H1 Desk"], argument: "The higher timeframe could flip." };
  assert.equal(validateRebuttal(named, "risk", ["risk", "h1"]).valid, true, "a display name maps to its id");
  assert.deepEqual(named.rebuts, ["h1"]);
  const empty = { agent: "risk", stance: "WAIT", confidence: 0.5, rebuts: [], argument: "Nothing to rebut, but a volatility spike would invalidate waiting." };
  assert.equal(validateRebuttal(empty, "risk", ["risk", "h1"]).valid, false, "a split room needs named targets");
  assert.equal(validateRebuttal(empty, "risk", ["risk", "h1"], { unanimous: true }).valid, true, "a unanimous room lets the Risk Manager stress-test without a target");

  // A dissenter persuaded by the bus concedes: production wrote rebuts ["news"] (itself) or [] when
  // the News Analyst dropped SELL for WAIT, and the concession was lost as rebuts_invalid.
  const bus = ["h1", "news", "risk"];
  const selfRebut = { agent: "news", stance: "WAIT", confidence: 0.55, rebuts: ["news"], argument: "My bearish read stands, but the H1 decision is WAIT, so I drop my SELL and stay flat." };
  assert.equal(validateRebuttal(selfRebut, "news", bus, { ownStance: "SELL" }).valid, true, "changing stance is a concession");
  assert.deepEqual(selfRebut.rebuts, []);
  assert.equal(selfRebut.conceded, true);
  const noTarget = { agent: "news", stance: "WAIT", confidence: 0.55, rebuts: [], argument: "I drop my SELL and stay flat until the H1 chain confirms." };
  assert.equal(validateRebuttal(noTarget, "news", bus, { ownStance: "SELL" }).valid, true);
  const kept = { agent: "news", stance: "SELL", confidence: 0.6, rebuts: ["news"], argument: "I keep my SELL: the dollar bid is real." };
  assert.equal(validateRebuttal(kept, "news", bus, { ownStance: "SELL" }).valid, false, "keeping the stance still needs a named target");
  const mixed = { agent: "news", stance: "WAIT", confidence: 0.55, rebuts: ["news", "Risk Manager"], argument: "The Risk Manager is right about volatility, so I move to WAIT." };
  assert.equal(validateRebuttal(mixed, "news", bus, { ownStance: "SELL" }).valid, true, "its own id beside real targets is dropped");
  assert.deepEqual(mixed.rebuts, ["risk"]);
  assert.equal(mixed.conceded, true);
  assert.equal(validateRebuttal({ ...noTarget, rebuts: ["ghost"] }, "news", bus, { ownStance: "SELL" }).valid, false, "an unknown agent is still invalid");
});

test("TLDR for the right panel: H1 decision with the bus consensus, and the latest news thread", async () => {
  const e = env(fakeAI());
  e.DB.raw.prepare("INSERT INTO bus_messages (run_id, candle_key, round, agent, ts, insight, confidence, status) VALUES ('r', ?, 3, 'moderator', '1', ?, 0.5, 'ok')").run(H1_KEY, JSON.stringify({ stance: "WAIT", summary: "Both agents wait." }));
  const t = await readTldr(e.DB);
  assert.deepEqual([t.h1.decision, t.h1.consensus.summary], ["WAIT", "Both agents wait."]);
  assert.match(t.h1.tldr, /GMI blocks/);
  assert.equal(t.news, null);
});
