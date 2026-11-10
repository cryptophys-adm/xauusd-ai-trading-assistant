import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  runNewsThread, runLiveRoomBar, listThreads, readThread, readLive, buildMessageTree, validateRoomModerator,
  buildNewsThreadTask, buildLiveRoomTask, liveRoomEnabled, resetThreadSchemaCacheForTests, ROOM_STANCES,
  isFifteenMinuteClose, buildFifteenMinuteCandles
  , runHudAgents, readH1Thread as readH1ThreadForHud, hudEvidenceLines, validateHudAgent, buildHudAgentsTask
} from "../src/agent-threads.mjs";
import { BUS_DEFAULT_MODEL, BUS_DEFAULT_FALLBACK_MODEL, MODERATOR_DEFAULT_MODEL, MODERATOR_DEFAULT_FALLBACK_MODEL } from "../src/multi-agent-bus.mjs";
// Per-role models (owner decision 2026-11-07): agents on the room agent model, the moderator on its own.
const modelsOf = (calls) => calls.map(c => c.model).sort();

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE ai_syntheses (id INTEGER PRIMARY KEY AUTOINCREMENT, candle_key TEXT NOT NULL, ticker TEXT, timeframe TEXT, timestamp TEXT, prophet_metrics TEXT, gmi_metrics TEXT, ai_analysis TEXT, ai_model TEXT)`);
  db.exec(`CREATE TABLE news_analyses (id INTEGER PRIMARY KEY AUTOINCREMENT, analysis_key TEXT NOT NULL UNIQUE, fetched_at TEXT NOT NULL, analyzed_at TEXT NOT NULL, article_count INTEGER NOT NULL, evidence_json TEXT NOT NULL, analyst_output TEXT NOT NULL, counselor_output TEXT NOT NULL, reasoner_output TEXT NOT NULL, recommendation_json TEXT NOT NULL)`);
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
function fakeKV(init = {}) {
  const m = new Map(Object.entries(init));
  return { map: m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); } };
}

const NEWS_KEY = "news-abc";
const BAR = "2026-11-04T15:15:00.000Z"; // a 15m candle close

function seed(d1, decision = "WAIT") {
  d1.raw.prepare("INSERT INTO ai_syntheses (candle_key, ai_analysis, prophet_metrics, gmi_metrics) VALUES (?, ?, ?, ?)").run(
    "OANDA:XAUUSD:60:1793800800000",
    JSON.stringify({ decision: { decision, confidence: null }, evidence_fusion: { complete: false, missing_evidence: ["local_calculation:gmi"], validation_errors: [], local_calculations: {} } }),
    JSON.stringify({ prophet_r38: { direction: 1 }, prophet_r37_ssot: { direction: 1 } }),
    JSON.stringify({ verdict: 0, gate: 1 })
  );
  d1.raw.prepare("INSERT INTO news_analyses (analysis_key, fetched_at, analyzed_at, article_count, evidence_json, analyst_output, counselor_output, reasoner_output, recommendation_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    NEWS_KEY, "2026-11-04T15:00:00Z", "2026-11-04T15:02:00Z", 2,
    JSON.stringify({ articles: [{ title: "Fed holds rates" }, { title: "Dollar slips" }] }), "a", "c", "reasoner says wait",
    JSON.stringify({ stance: "WAIT_FOR_TECHNICAL_CONFIRMATION", confidence: 0.3 })
  );
}

function m5(extra = {}) {
  return JSON.stringify({ schema_version: "cryptophys.local-context.v1", trust_status: "informational_unverified", symbol: "OANDA:XAUUSD", timeframe: "5", candle_time: BAR, bias: "BULLISH", buy_confirmed: true, sell_confirmed: false, d_enc: 1, recent_bars: Array.from({ length: 12 }, (_, i) => ({ t: new Date(Date.parse(extra.candle_time || BAR) - (11 - i) * 300_000).toISOString(), o: 4000 + i, h: 4002 + i, l: 3999 + i, c: 4001 + i, v: 10 })), ...extra });
}

/** Chat Completions-shaped fake that answers each prompt from its "Required JSON" line. */
function fakeAI(override) {
  const calls = [];
  return {
    calls,
    run: async (model, request) => {
      calls.push({ model, request });
      const user = request.messages[1].content;
      const sys = request.messages[0].content;
      let content;
      if (override) {
        const o = await override({ model, request, n: calls.length, user, sys });
        if (o instanceof Error) throw o;
        if (o !== undefined) content = o;
      }
      if (content === undefined) {
        if (/moderator of a live/i.test(sys)) content = { stance: "HOLD", confidence: 0.5, summary: "Hold for now; H1 decision: WAIT." };
        else if (/moderator of an XAUUSD forum/i.test(sys)) content = { stance: "WAIT", confidence: 0.5, agreed: true, summary: "Both wait.", dissent: [] };
        else {
          const agent = (user.match(/Required JSON: \{"agent":"(\w+)"/) || [])[1];
          const round = /Round 2 of 2/.test(user) ? 2 : 1;
          const isRoom = /live XAUUSD trading room/.test(sys);
          content = isRoom
            ? { agent, stance: agent === "technical" ? "BUY" : "HOLD", confidence: 0.6, insight: `${agent} 5m read`, refs: ["m5.bias"], responds_to: agent === "risk" ? "technical" : null }
            : { agent, round, stance: "WAIT", confidence: 0.4, insight: `${agent} r${round}`, refs: ["post.headlines"], responds_to: round === 1 ? null : (agent === "news" ? "technical" : "news") };
        }
      }
      return { choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { total_tokens: 100 } };
    }
  };
}

function env(overrides = {}) {
  const d1 = fakeD1();
  seed(d1);
  return { DB: d1, AI: fakeAI(), SIGNAL_CACHE: fakeKV({ "context:m5:latest": m5() }), MULTI_AGENT_BUS_ENABLED: "true", LIVE_ROOM_ENABLED: "true", MULTI_AGENT_MAX_CALLS_PER_HOUR: "20", LIVE_ROOM_MAX_CALLS_PER_HOUR: "36", ...overrides };
}

test.beforeEach(() => resetThreadSchemaCacheForTests());

test("task builders are deterministic", () => {
  assert.equal(buildNewsThreadTask({ analysisKey: NEWS_KEY }).event_id, `news_thread:${NEWS_KEY}`);
  assert.equal(buildLiveRoomTask({ barTime: BAR }).event_id, `live_room:${BAR}`);
  assert.throws(() => buildLiveRoomTask({ barTime: "nope" }));
  assert.equal(liveRoomEnabled({}), false);
});

test("news thread: flag off means no calls", async () => {
  const e = env({ MULTI_AGENT_BUS_ENABLED: "false" });
  assert.equal((await runNewsThread(e, { analysis_key: NEWS_KEY })).status, "disabled");
  assert.equal(e.AI.calls.length, 0);
});

test("news thread: post + 5 nested replies, round 2 answers the other agent", async () => {
  const e = env();
  const result = await runNewsThread(e, { analysis_key: NEWS_KEY });
  assert.equal(result.status, "complete");
  assert.equal(e.AI.calls.length, 5);
  assert.deepEqual(modelsOf(e.AI.calls), [...Array(4).fill(BUS_DEFAULT_MODEL), MODERATOR_DEFAULT_MODEL].sort(), "four agent steps, one moderator");
  const thread = await readThread(e.DB, `news:${NEWS_KEY}`);
  assert.equal(thread.title, "Fed holds rates");
  assert.deepEqual(thread.post.headlines, ["Fed holds rates", "Dollar slips"]);
  // Roots: r1:news, r1:technical, moderator. Each r1 holds the other agent's r2 reply.
  const roots = thread.messages.map(m => m.step);
  assert.deepEqual(roots, ["r1:news", "r1:technical", "moderator"]);
  const r1news = thread.messages[0];
  assert.deepEqual(r1news.replies.map(m => m.step), ["r2:technical"]);
  assert.equal(r1news.replies[0].responds_to, "news");
  const r1tech = thread.messages[1];
  assert.deepEqual(r1tech.replies.map(m => m.step), ["r2:news"]);
  assert.match(e.AI.calls[2].request.messages[1].content, /OTHER AGENT \(round 1\)[\s\S]*technical r1/);
  const list = await listThreads(e.DB, { kind: "news" });
  assert.equal(list[0].reply_count, 5);
  assert.equal(list[0].consensus, "WAIT");
});

test("news thread: redelivery makes no new calls", async () => {
  const e = env();
  await runNewsThread(e, { analysis_key: NEWS_KEY });
  assert.equal((await runNewsThread(e, { analysis_key: NEWS_KEY })).status, "already_complete");
  assert.equal(e.AI.calls.length, 5);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM agent_thread_messages").get().n, 5);
});

test("news thread never writes the H1 chain read models", async () => {
  const e = env();
  const before = e.DB.raw.prepare("SELECT ai_analysis FROM ai_syntheses").get().ai_analysis;
  await runNewsThread(e, { analysis_key: NEWS_KEY });
  assert.equal(e.DB.raw.prepare("SELECT ai_analysis FROM ai_syntheses").get().ai_analysis, before);
});

test("news thread: unknown analysis does nothing", async () => {
  const e = env();
  assert.equal((await runNewsThread(e, { analysis_key: "missing" })).status, "no_news_analysis");
  assert.equal(e.AI.calls.length, 0);
});

test("live room: technical, risk (reply to technical), moderator; each on its role's primary model", async () => {
  const e = env();
  const result = await runLiveRoomBar(e, { bar_time: BAR });
  assert.equal(result.status, "complete");
  assert.equal(e.AI.calls.length, 3);
  assert.deepEqual(modelsOf(e.AI.calls), [BUS_DEFAULT_MODEL, BUS_DEFAULT_MODEL, MODERATOR_DEFAULT_MODEL].sort());
  const items = await readLive(e.DB, {});
  assert.deepEqual(items.map(m => m.step), ["technical", "risk", "moderator"]);
  assert.equal(items[1].parent_id, items[0].id);
  assert.ok(items.every(m => m.bar_time === BAR && m.status === "ok"));
  assert.equal(items[2].h1_decision, "WAIT");
  assert.ok(ROOM_STANCES.includes(items[0].stance));
  const evidence = JSON.parse(e.AI.calls[0].request.messages[1].content.split("EVIDENCE:\n")[1].split("\n")[0]);
  assert.equal(evidence.m5.label, "UNVERIFIED 5m");
  assert.equal(evidence.m5.recent_bars.length, 12);
  assert.equal(evidence.h1.decision, "WAIT");
  assert.equal(evidence.m15.close_time, BAR);
  assert.equal(evidence.m15.candles.length, 4, "12 closed 5m bars make 4 closed 15m candles");
  assert.deepEqual(evidence.m15.candles.at(-1), { close_time: BAR, o: 4009, h: 4013, l: 4008, c: 4012, v: 30 });
  assert.equal(evidence.m5.role, "execution timing from the local lane");
  assert.match(evidence.h1.tradingview, /TradingView indicators/, "the room sees the H1 TradingView reading");
  const prompts = e.AI.calls.map(c => c.request.messages.map(m => m.content).join("\n")).join("\n");
  assert.doesNotMatch(prompts, /tradingview_reading/, "no snake_case key the model could echo into its text");
});

test("live room: a failing model falls back to its role's fallback; both failing records agent_failed", async () => {
  // The glm-4.7 fallback was paid and slow, so the room ran primary only; the per-role fallbacks
  // (owner decision 2026-11-07) are free-plan models.
  const e = env({ AI: fakeAI(() => new Error("primary down")) });
  await runLiveRoomBar(e, { bar_time: BAR });
  assert.ok(e.AI.calls.some(c => c.model === BUS_DEFAULT_FALLBACK_MODEL), "the agents try their fallback");
  assert.ok(e.AI.calls.some(c => c.model === MODERATOR_DEFAULT_FALLBACK_MODEL || c.model === MODERATOR_DEFAULT_MODEL));
  const items = await readLive(e.DB, {});
  assert.ok(items.every(m => m.status === "agent_failed"));
});

test("live room meets only at 15m candle closes, every 15m close even when nothing changed", async () => {
  const e = env();
  assert.equal((await runLiveRoomBar(e, { bar_time: BAR })).status, "complete");
  for (const mid of ["2026-11-04T15:20:00.000Z", "2026-11-04T15:25:00.000Z"]) {
    await e.SIGNAL_CACHE.put("context:m5:latest", m5({ candle_time: mid }));
    assert.equal((await runLiveRoomBar(e, { bar_time: mid })).status, "not_15m_close");
  }
  assert.equal(e.AI.calls.length, 3, "5m bars inside a 15m candle make no calls");
  const next = "2026-11-04T15:30:00.000Z";
  await e.SIGNAL_CACHE.put("context:m5:latest", m5({ candle_time: next }));
  assert.equal((await runLiveRoomBar(e, { bar_time: next })).status, "complete", "the next 15m close runs even with an unchanged picture");
  assert.equal(e.AI.calls.length, 6);
  const live = await readLive(e.DB, {});
  assert.ok(live.every(m => m.thread_id.startsWith("live15m:")));
});

test("15m close detection and 15m candles from 5m bars", () => {
  assert.equal(isFifteenMinuteClose("2026-11-04T15:15:00.000Z"), true);
  assert.equal(isFifteenMinuteClose("2026-11-04T16:00:00.000Z"), true);
  assert.equal(isFifteenMinuteClose("2026-11-04T15:20:00.000Z"), false);
  assert.equal(isFifteenMinuteClose("not a time"), false);
  const bar = (t, o, h, l, c, v) => ({ t, o, h, l, c, v });
  const candles = buildFifteenMinuteCandles([
    bar("2026-11-04T15:05:00.000Z", 1, 5, 0, 2, 1), // incomplete 15:15 candle (only two bars)
    bar("2026-11-04T15:10:00.000Z", 2, 3, 1, 2, 1),
    bar("2026-11-04T15:20:00.000Z", 10, 12, 9, 11, 2),
    bar("2026-11-04T15:25:00.000Z", 11, 15, 10, 14, 3),
    bar("2026-11-04T15:30:00.000Z", 14, 14, 8, 9, null)
  ]);
  assert.deepEqual(candles, [{ close_time: "2026-11-04T15:30:00.000Z", o: 10, h: 15, l: 8, c: 9, v: null }]);
});

test("live room uses the context carried by the task (no KV dependency)", async () => {
  const e = env({ SIGNAL_CACHE: fakeKV({}) });
  const task = buildLiveRoomTask({ barTime: BAR, context: JSON.parse(m5()) });
  assert.equal((await runLiveRoomBar(e, task)).status, "complete");
  assert.equal(e.AI.calls.length, 3);
});

test("live room retries while the 5m context is not visible yet", async () => {
  const e = env({ SIGNAL_CACHE: fakeKV({}) });
  await assert.rejects(() => runLiveRoomBar(e, { bar_time: BAR }), /not visible yet/);
  const e2 = env({ SIGNAL_CACHE: fakeKV({ "context:m5:latest": m5({ candle_time: "2026-11-04T15:00:00.000Z" }) }) });
  await assert.rejects(() => runLiveRoomBar(e2, { bar_time: BAR }), /not visible yet/);
  assert.equal(e.AI.calls.length + e2.AI.calls.length, 0);
});

test("live room ignores a stale bar and respects its hourly budget (fail closed)", async () => {
  const e = env();
  assert.equal((await runLiveRoomBar(e, { bar_time: "2026-11-04T14:00:00.000Z" })).status, "stale_bar");
  resetThreadSchemaCacheForTests(); // a second, fresh D1 in the same isolate
  const e2 = env({ LIVE_ROOM_MAX_CALLS_PER_HOUR: "0" });
  await runLiveRoomBar(e2, { bar_time: BAR });
  assert.equal(e2.AI.calls.length, 0);
  assert.ok((await readLive(e2.DB, {})).every(m => m.status === "budget_exhausted"));
  assert.equal((await runLiveRoomBar(env({ LIVE_ROOM_ENABLED: "false" }), { bar_time: BAR })).status, "disabled");
});

test("room moderator must name the H1 decision when it disagrees", () => {
  assert.equal(validateRoomModerator({ stance: "BUY", confidence: 0.6, summary: "Momentum is up." }, "WAIT").valid, false);
  assert.equal(validateRoomModerator({ stance: "BUY", confidence: 0.6, summary: "5m leans long but H1 decision: WAIT." }, "WAIT").valid, true);
  assert.equal(validateRoomModerator({ stance: "WAIT", confidence: 0.6, summary: "Stay flat." }, "WAIT").valid, true);
  assert.ok(validateRoomModerator({ stance: "LONG", confidence: 2, summary: "x" }, "WAIT").errors.includes("stance_invalid"));
});

test("an invalid room moderator answer is stored as invalid_output", async () => {
  const e = env({ AI: fakeAI(({ sys }) => (/moderator of a live/i.test(sys) ? { stance: "BUY", confidence: 0.7, summary: "Go long." } : undefined)) });
  await runLiveRoomBar(e, { bar_time: BAR });
  const items = await readLive(e.DB, {});
  assert.equal(items[2].status, "invalid_output");
  assert.ok(items[2].errors.includes("h1_reference_missing"));
});

test("readLive pages forward with since", async () => {
  const e = env();
  await runLiveRoomBar(e, { bar_time: BAR });
  const all = await readLive(e.DB, {});
  const newer = await readLive(e.DB, { since: all[0].id });
  assert.deepEqual(newer.map(m => m.step), ["risk", "moderator"]);
});

test("buildMessageTree nests replies under their parent", () => {
  const tree = buildMessageTree([{ id: 1, parent_id: null }, { id: 2, parent_id: 1 }, { id: 3, parent_id: 2 }, { id: 4, parent_id: 99 }]);
  assert.deepEqual(tree.map(m => m.id), [1, 4]);
  assert.equal(tree[0].replies[0].replies[0].id, 3);
});

import { listH1Threads, readH1Thread } from "../src/agent-threads.mjs";

test("H1 threads are built from the bus: post = decision, round 2 nested under the other agent", async () => {
  const d1 = fakeD1();
  seed(d1);
  d1.raw.exec(`CREATE TABLE bus_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, candle_key TEXT NOT NULL, round INTEGER NOT NULL, agent TEXT NOT NULL, ts TEXT NOT NULL, insight TEXT NOT NULL, confidence REAL, refs_json TEXT, model TEXT, status TEXT, latency_ms INTEGER, fallback_used INTEGER DEFAULT 0, usage_tokens INTEGER, UNIQUE(candle_key, run_id, round, agent))`);
  const key = "OANDA:XAUUSD:60:1793800800000";
  const ins = d1.raw.prepare("INSERT INTO bus_messages (run_id, candle_key, round, agent, ts, insight, confidence, model, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const [round, agent, text] of [[1, "technical", "Engines lean bullish."], [1, "news", "No clear driver."], [2, "technical", "I agree with News."], [2, "news", "I dispute the bullish read."], [3, "moderator", null]]) {
    const body = agent === "moderator" ? { stance: "WAIT", agreed: false, summary: "Wait for news.", dissent: ["Technical leaned bullish."] } : { stance: "WAIT", insight: text, responds_to: round === 2 ? (agent === "technical" ? "news" : "technical") : null };
    ins.run("run1", key, round, agent, "2026-11-04T15:00:30Z", JSON.stringify(body), 0.5, "@cf/zai-org/glm-5.3-flash", "ok");
  }
  const list = await listH1Threads(d1, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].id, `h1:${key}`);
  assert.equal(list[0].consensus, "WAIT");
  assert.match(list[0].title, /^H1 candle 2026-11-04 14:00 UTC · decision WAIT$/);
  const t = await readH1Thread(d1, key);
  assert.deepEqual(t.messages.map(m => m.step), ["r1:technical", "r1:news", "moderator"]);
  assert.equal(t.messages[0].replies[0].step, "r2:news", "news' round-2 reply sits under technical's round-1 message");
  assert.equal(t.messages[1].replies[0].step, "r2:technical");
  assert.match(t.post.reasoning, /^No trade for this candle/);
  assert.deepEqual(t.post.tradingview.lines.map(l => l.source), ["Prophet", "GMI v12.70"]);
  assert.match(list[0].post.tradingview.summary, /TradingView indicators/);
  assert.equal(await readH1Thread(d1, "OANDA:XAUUSD:60:1"), null);
});

test("an answer that only fails the natural-language rule gets one correction, counted in the budget", async () => {
  const codeLike = { stance: "WAIT", confidence: 0.6, summary: "H1 decision: WAIT because h1.decision says so." };
  const fixed = { stance: "WAIT", confidence: 0.6, summary: "H1 decision: WAIT. The hourly picture says stand aside." };
  const e = env({ AI: fakeAI(({ sys, request }) => /moderator of a live/i.test(sys) ? (request.messages.length > 2 ? fixed : codeLike) : undefined) });
  const result = await runLiveRoomBar(e, { bar_time: BAR });
  assert.equal(result.status, "complete");
  assert.equal(e.AI.calls.length, 4, "technical, risk, moderator, one correction");
  const correction = e.AI.calls[3].request.messages;
  assert.equal(correction.at(-2).role, "assistant");
  assert.match(correction.at(-1).content, /reads like code/);
  const mod = (await readLive(e.DB, {})).find(m => m.step === "moderator");
  assert.equal(mod.status, "ok");
  assert.equal(mod.summary, fixed.summary);
  assert.equal(mod.corrections, 1);
  const n = e.DB.raw.prepare("SELECT SUM(1 + COALESCE(fallback_used, 0) + COALESCE(json_extract(body_json, '$.corrections'), 0)) AS n FROM agent_thread_messages").get().n;
  assert.equal(n, 4, "the hourly budget counts the correction call");
});

test("a correction that still reads like code stays invalid_output; schema errors get no correction", async () => {
  const codeLike = { stance: "WAIT", confidence: 0.6, summary: "H1 decision: WAIT per h1.decision." };
  const e = env({ AI: fakeAI(({ sys }) => /moderator of a live/i.test(sys) ? codeLike : undefined) });
  await runLiveRoomBar(e, { bar_time: BAR });
  const mod = (await readLive(e.DB, {})).find(m => m.step === "moderator");
  assert.equal(mod.status, "invalid_output");
  assert.equal(mod.corrections, 2, "one correction, then one answer from the moderator's fallback model");
  assert.equal(e.AI.calls.length, 5, "exactly one correction attempt and one fallback attempt");
  assert.deepEqual(e.AI.calls.slice(2).map(c => c.model), [MODERATOR_DEFAULT_MODEL, MODERATOR_DEFAULT_MODEL, MODERATOR_DEFAULT_FALLBACK_MODEL]);

  resetThreadSchemaCacheForTests();
  const e2 = env({ AI: fakeAI(({ sys }) => /moderator of a live/i.test(sys) ? { stance: "LONG", confidence: 0.6, summary: "Plain words." } : undefined) });
  await runLiveRoomBar(e2, { bar_time: BAR });
  assert.equal(e2.AI.calls.length, 4, "a schema error gets no correction, only the moderator's fallback model once");
});

// C0 step 4: the 5m read is VERIFIED only while prophet_m5 and gmi_m5 are parity-approved.
async function seedVerifiedM5(e, { approve = true } = {}) {
  const { ensureSchema, registerIdentity, identityOf, resetSchemaCacheForTests } = await import("../src/parity-registry.mjs");
  resetSchemaCacheForTests();
  const H = (c) => c.repeat(64);
  const key = `OANDA:XAUUSD:5:${Date.parse(BAR) - 300_000}`;
  const base = { schema_version: "cryptophys.local-calculation.v1", symbol: "OANDA:XAUUSD", timeframe: "5", candle_key: key };
  const records = {
    prophet: { ...base, engine: "prophet", provenance: { source_hash: H("a"), implementation_hash: H("5") }, values: { comparable: {
      prophet_r38: { direction: -1, buy_confirmed: false, sell_confirmed: true, buy_high_quality: false, sell_high_quality: false, t_enc: 0, d_enc: -1, structure_subtype: 1 },
      prophet_r37_ssot: { direction: -1, d_enc: -1, b_enc: 0, structure_subtype: 1, bull_event: false, bear_event: true } } } },
    gmi: { ...base, engine: "gmi", provenance: { source_hash: H("b"), implementation_hash: H("6") }, values: { comparable: {
      gmi_v12_70: { verdict: -3, gate: 2, gmi_dir: -1, prophet_dir: -1, conflict: false } } } }
  };
  e.WEBHOOK_BUFFER = fakeKV(Object.fromEntries(Object.entries(records).map(([engine, r]) => [`localcalc-observed:${key}:${engine}`, JSON.stringify(r)])));
  await ensureSchema(e.DB);
  for (const r of Object.values(records)) await registerIdentity(e.DB, identityOf(r));
  if (approve) e.DB.raw.prepare("UPDATE engine_parity_registry SET status = 'approved' WHERE engine IN ('prophet_m5', 'gmi_m5')").run();
  return key;
}

test("live room labels the 5m read VERIFIED 5m only while the 5m implementations are parity-approved", async () => {
  const e = env();
  await seedVerifiedM5(e);
  await runLiveRoomBar(e, { bar_time: BAR });
  const evidence = JSON.parse(e.AI.calls[0].request.messages[1].content.split("EVIDENCE:\n")[1].split("\n")[0]);
  assert.equal(evidence.m5.label, "VERIFIED 5m");
  assert.equal(evidence.m5.trust_status, "approved_by_parity");
  assert.equal(evidence.m5.bias, "bearish", "the verified read replaces the unverified BULLISH context");
  assert.match(evidence.m5.reading.summary, /verified 5m indicators/);
  assert.equal(evidence.m5.reading.lines.length, 2, "Prophet (R38 and R37 as one) and GMI");
  assert.equal(evidence.m5.recent_bars.length, 12);
});

test("live room keeps UNVERIFIED 5m while the 5m identities are only candidates", async () => {
  const e = env();
  await seedVerifiedM5(e, { approve: false });
  await runLiveRoomBar(e, { bar_time: BAR });
  const evidence = JSON.parse(e.AI.calls[0].request.messages[1].content.split("EVIDENCE:\n")[1].split("\n")[0]);
  assert.equal(evidence.m5.label, "UNVERIFIED 5m");
  assert.equal(evidence.m5.bias, "BULLISH");
});

test("an approved H1 identity never verifies a 5m record", async () => {
  const { verifiedM5Reading, m5ParityApproved } = await import("../src/m5-verification.mjs");
  const e = env();
  await seedVerifiedM5(e, { approve: false });
  // Same hashes approved under the bare H1 ids must not count for 5m.
  e.DB.raw.prepare("INSERT INTO engine_parity_registry (engine, source_hash, implementation_hash, status, first_seen_at, updated_at) SELECT REPLACE(engine, '_m5', ''), source_hash, implementation_hash, 'approved', first_seen_at, updated_at FROM engine_parity_registry WHERE engine IN ('prophet_m5', 'gmi_m5')").run();
  assert.equal((await verifiedM5Reading(e, BAR)).reason, "m5_parity_not_approved");
  assert.equal(await m5ParityApproved(e.DB), false);
  e.DB.raw.prepare("UPDATE engine_parity_registry SET status = 'approved' WHERE engine IN ('prophet_m5', 'gmi_m5')").run();
  assert.equal((await verifiedM5Reading(e, BAR)).verified, true);
  assert.equal(await m5ParityApproved(e.DB), true);
  assert.equal((await verifiedM5Reading(e, "2026-11-04T15:10:00.000Z")).reason, "no_local_5m_record");
});

test("the 5m trigger needs the Prophet 5m parity only: a revoked GMI 5m leaves the reading unverified, not the confirmation", async () => {
  const { verifiedM5Reading, verifiedM5Confirmation } = await import("../src/m5-verification.mjs");
  const e = env();
  await seedVerifiedM5(e, { approve: false });
  assert.equal((await verifiedM5Confirmation(e, BAR)).reason, "prophet_m5_parity_not_approved");
  e.DB.raw.prepare("UPDATE engine_parity_registry SET status = 'approved' WHERE engine = 'prophet_m5'").run();
  e.DB.raw.prepare("UPDATE engine_parity_registry SET status = 'revoked' WHERE engine = 'gmi_m5'").run();
  assert.equal((await verifiedM5Confirmation(e, BAR)).verified, true, "production 2026-11-09: gmi_m5 revoked, prophet_m5 approved");
  assert.equal((await verifiedM5Reading(e, BAR)).verified, false, "the combined reading still needs both");
  assert.equal((await verifiedM5Confirmation(e, "2026-11-04T15:10:00.000Z")).reason, "no_local_5m_record");
});

// ---------------------------------------------------------------- HUD agents (Phase C5)
const HUD_KEY = "OANDA:XAUUSD:60:1793804400000";
function hudReadingsFixture() {
  const line = (text, verified) => ({ text, verified });
  return {
    candle_key: HUD_KEY, timeframe: "60", not_computed: ["grid_bot_protocol"], verified_against_approved_record: true,
    readings: {
      prophet: { agent_id: "prophet", name: "Prophet", available: true, lines: [line("Prophet's structure shows a bullish divergence.", true), line("On the cycle read, all three Prophet cycles point up.", false)] },
      decision_matrix: { agent_id: "decision_matrix", name: "Decision Matrix", available: true, lines: [line("The action verdict is wait and observe.", true)] },
      tactical_muscles: { agent_id: "tactical_muscles", name: "Tactical Muscles", available: false, lines: [] }
    }
  };
}
function hudAI() {
  return fakeAI(({ sys, user }) => {
    if (/moderator of the HUD agents/.test(sys)) return { stance: "WAIT", confidence: 0.5, summary: "Prophet and the Decision Matrix both support waiting." };
    if (/one agent per Pine HUD/.test(sys)) {
      const agent = (user.match(/Required JSON: \{"agent":"(\w+)"/) || [])[1];
      return { agent, stance: "WAIT", confidence: 0.5, insight: "My reading supports waiting, in line with the H1 decision." };
    }
    return undefined;
  });
}
function hudEnv(overrides = {}) {
  const e = env({ AI: hudAI(), HUD_AGENTS_ENABLED: "true", ...overrides });
  e.DB.raw.prepare("INSERT INTO ai_syntheses (candle_key, ai_analysis) VALUES (?, ?)").run(HUD_KEY, JSON.stringify({ decision: { decision: "WAIT", confidence: 0.4 } }));
  return e;
}
const loadReadings = async () => hudReadingsFixture();

test("schemas without refs never ask for refs; schemas with refs still do", async () => {
  // preview-e2e (#95): told to back claims with refs but given no refs field, the HUD
  // moderator wrote the paths into its summary and failed the natural-language check.
  const e = hudEnv();
  await runHudAgents(e, { candle_key: HUD_KEY }, { loadReadings });
  for (const call of e.AI.calls) {
    const prompt = call.request.messages.map(m => m.content).join("\n");
    assert.doesNotMatch(prompt, /Back every claim with refs/);
    assert.match(prompt, /no refs field: never write refs, evidence paths/);
  }
  resetThreadSchemaCacheForTests();
  const room = env();
  await runLiveRoomBar(room, buildLiveRoomTask({ barTime: BAR }));
  const [technical, , moderator] = room.AI.calls.map(c => c.request.messages.map(m => m.content).join("\n"));
  assert.match(technical, /Back every claim with refs/, "the room agents keep their refs field and rule");
  assert.match(moderator, /no refs field/);
});

test("a retried step replaces its stored failure, keeps its id, and never overwrites an ok message", async () => {
  // preview-e2e (#95): the HUD moderator failed once; every later retry spent a call and
  // the INSERT OR IGNORE kept the old invalid_output row forever.
  let broken = true;
  const e = env({ HUD_AGENTS_ENABLED: "true", AI: fakeAI(({ sys, user }) => {
    if (/moderator of the HUD agents/.test(sys)) return broken ? { stance: "WAIT", confidence: 0.5, summary: "Refs: h1.decision and agents[0].stance." } : { stance: "WAIT", confidence: 0.5, summary: "Prophet and the Decision Matrix both support waiting." };
    if (/one agent per Pine HUD/.test(sys)) return { agent: (user.match(/Required JSON: \{"agent":"(\w+)"/) || [])[1], stance: "WAIT", confidence: 0.5, insight: "My reading supports waiting, in line with the H1 decision." };
    return undefined;
  }) });
  e.DB.raw.prepare("INSERT INTO ai_syntheses (candle_key, ai_analysis) VALUES (?, ?)").run(HUD_KEY, JSON.stringify({ decision: { decision: "WAIT", confidence: 0.4 } }));
  const row = () => e.DB.raw.prepare("SELECT id, status, ts FROM agent_thread_messages WHERE thread_id = ? AND step = 'moderator'").get("hud1h:" + HUD_KEY);
  await runHudAgents(e, { candle_key: HUD_KEY }, { loadReadings });
  const failed = row();
  assert.equal(failed.status, "invalid_output");
  const prophetBefore = e.DB.raw.prepare("SELECT ts FROM agent_thread_messages WHERE step = 'hud:prophet'").get().ts;
  broken = false;
  await runHudAgents(e, { candle_key: HUD_KEY }, { loadReadings });
  const fixed = row();
  assert.equal(fixed.status, "ok", "the retry's valid answer is stored");
  assert.equal(fixed.id, failed.id, "the row keeps its id");
  assert.equal(e.DB.raw.prepare("SELECT ts FROM agent_thread_messages WHERE step = 'hud:prophet'").get().ts, prophetBefore, "an ok message is never rewritten");
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM agent_thread_messages WHERE step = 'moderator'").get().n, 1);
});

test("HUD agents: flag off means no calls", async () => {
  const e = env({ AI: hudAI() });
  assert.equal((await runHudAgents(e, { candle_key: HUD_KEY }, { loadReadings })).status, "disabled");
  assert.equal(e.AI.calls.length, 0);
});

test("HUD agents: one post per computed HUD, then a moderator; each sees only its own reading with verification", async () => {
  const e = hudEnv();
  const result = await runHudAgents(e, { candle_key: HUD_KEY }, { loadReadings });
  assert.equal(result.status, "complete");
  assert.equal(result.answered, 2, "tactical_muscles has no reading and is skipped");
  assert.equal(e.AI.calls.length, 3);
  assert.deepEqual(modelsOf(e.AI.calls), [BUS_DEFAULT_MODEL, BUS_DEFAULT_MODEL, MODERATOR_DEFAULT_MODEL].sort(), "each role on its primary model");
  const prophetPrompt = e.AI.calls[0].request.messages.map(m => m.content).join("\n");
  assert.match(prophetPrompt, /You are Prophet/);
  assert.match(prophetPrompt, /Verified by parity: Prophet's structure/);
  assert.match(prophetPrompt, /Not yet calibrated: On the cycle read/);
  assert.doesNotMatch(prophetPrompt, /action verdict/i, "an agent never sees another HUD's reading");
  const thread = await readH1ThreadForHud(e.DB, HUD_KEY);
  const hud = thread?.hud_agents ?? [];
  assert.deepEqual(hud.map(m => m.name), ["Prophet", "Decision Matrix", "Moderator"]);
  assert.ok(hud.every(m => m.status === "ok"));
  assert.equal(hud[0].verified_lines, 1);
  assert.equal(hud[0].total_lines, 2);
});

test("HUD agents: redelivery reuses stored messages and spends nothing", async () => {
  const e = hudEnv();
  await runHudAgents(e, { candle_key: HUD_KEY }, { loadReadings });
  const before = e.AI.calls.length;
  const again = await runHudAgents(e, { candle_key: HUD_KEY }, { loadReadings });
  assert.equal(again.status, "already_complete");
  assert.equal(e.AI.calls.length, before);
});

test("HUD agents: the hourly cap fails closed", async () => {
  const e = hudEnv({ HUD_AGENTS_MAX_CALLS_PER_HOUR: "1" });
  await runHudAgents(e, { candle_key: HUD_KEY }, { loadReadings });
  const statuses = (await readH1ThreadForHud(e.DB, HUD_KEY))?.hud_agents?.map(m => m.status) ?? [];
  assert.equal(e.AI.calls.length, 1);
  assert.ok(statuses.includes("budget_exhausted"));
});

test("HUD agents: a missing snapshot or synthesis is retried, never invented", async () => {
  const e = hudEnv();
  await assert.rejects(() => runHudAgents(e, { candle_key: HUD_KEY }, { loadReadings: async () => null }), /HUD snapshot not visible yet/);
  const noSynth = env({ AI: hudAI(), HUD_AGENTS_ENABLED: "true" });
  await assert.rejects(() => runHudAgents(noSynth, { candle_key: HUD_KEY }, { loadReadings }), /H1 synthesis not visible yet/);
});

test("HUD agent validation and evidence lines", () => {
  assert.deepEqual(hudEvidenceLines({ lines: [{ text: "A.", verified: true }, { text: "B.", verified: false }] }), ["Verified by parity: A.", "Not yet calibrated: B."]);
  assert.equal(validateHudAgent({ agent: "prophet", stance: "WAIT", confidence: 0.5, insight: "Plain words." }, "prophet").valid, true);
  assert.ok(validateHudAgent({ agent: "prophet", stance: "HOLD", confidence: 0.5, insight: "Plain words." }, "prophet").errors.includes("stance_invalid"));
  assert.ok(validateHudAgent({ agent: "prophet", stance: "WAIT", confidence: 0.5, insight: "see d_enc" }, "prophet").errors.some(e => e.startsWith("not_natural_language")));
  assert.equal(buildHudAgentsTask({ candleKey: HUD_KEY }).event_id, `hud_agents:${HUD_KEY}`);
});

test("live room: with HUD agents on, the 15m HUD agents speak from their 15m reading before the moderator", async () => {
  const openMs = Date.parse(BAR) - 15 * 60_000;
  const key15 = "OANDA:XAUUSD:15:" + openMs;
  const snapshot = {
    schema_version: "cryptophys.hud-snapshot.v1", timeframe: "15", candle_key: key15, computed_at: BAR, not_computed: ["grid_bot_protocol"],
    huds: {
      trade_management: { fields: { prophet_dir: 1, gmi_dir: 1, conflict: false, gate: 2, cycle_intensity: 3 }, parity: {} },
      kinetic_engine: { fields: { theta: 12.5, omega: 0.4, alpha: 0.1, entropy: 0.5, is_chaos: false }, parity: {} },
      prophet: { fields: { d_enc: 1 }, parity: {} }
    }
  };
  const ai = fakeAI(({ sys, user }) => {
    if (/one agent per Pine HUD, in a live XAUUSD trading room/.test(sys)) {
      const agent = (user.match(/Required JSON: \{"agent":"(\w+)"/) || [])[1];
      return { agent, stance: "HOLD", confidence: 0.5, insight: "My 15m reading is not yet calibrated and leans toward holding." };
    }
    return undefined;
  });
  const e = env({ AI: ai, HUD_AGENTS_ENABLED: "true", LIVE_ROOM_MAX_CALLS_PER_HOUR: "48" });
  e.SIGNAL_CACHE.map.set(`hud:15:${key15}`, JSON.stringify(snapshot));
  const result = await runLiveRoomBar(e, { bar_time: BAR });
  assert.equal(result.status, "complete");
  const items = await readLive(e.DB, {});
  assert.deepEqual(items.map(m => m.step), ["technical", "risk", "hud:trade_management", "hud:kinetic_engine", "moderator"], "only live-room HUDs with a reading speak; prophet is not a live-room HUD");
  const tm = items.find(m => m.step === "hud:trade_management");
  assert.equal(tm.hud, "Trade Management");
  assert.equal(tm.status, "ok");
  assert.equal(tm.verified_lines, 0, "the 15m HUD has no calibrated comparator");
  const modPrompt = ai.calls.at(-1).request.messages.map(m => m.content).join("\n");
  assert.match(modPrompt, /Trade Management/);
  assert.match(modPrompt, /Kinetic Engine/);
});

test("live room: HUD agents off means no HUD posts", async () => {
  const e = env();
  await runLiveRoomBar(e, { bar_time: BAR });
  const items = await readLive(e.DB, {});
  assert.ok(!items.some(m => String(m.step).startsWith("hud:")));
});

test("live room: a 15m HUD snapshot carried in the task is used without any KV read", async () => {
  const key15 = "OANDA:XAUUSD:15:" + (Date.parse(BAR) - 15 * 60_000);
  const snapshot = { schema_version: "cryptophys.hud-snapshot.v1", timeframe: "15", candle_key: key15, computed_at: BAR, huds: { fabio_amt: { fields: { close: 4005, poc: 4001, vah: 4010, val: 3995, footprint_status: "BUY CONTROL" }, parity: {} } } };
  const ai = fakeAI(({ sys, user }) => {
    if (/one agent per Pine HUD, in a live XAUUSD trading room/.test(sys)) {
      const agent = (user.match(/Required JSON: \{"agent":"(\w+)"/) || [])[1];
      return { agent, stance: "WAIT", confidence: 0.4, insight: "Price sits inside the value area, which is not yet calibrated on this chart." };
    }
    return undefined;
  });
  const e = env({ AI: ai, HUD_AGENTS_ENABLED: "true" });
  await runLiveRoomBar(e, { bar_time: BAR, hud: snapshot });
  const steps = (await readLive(e.DB, {})).map(m => m.step);
  assert.deepEqual(steps, ["technical", "risk", "hud:fabio_amt", "moderator"]);
  // A snapshot for another bar is ignored.
  const other = { ...snapshot, candle_key: "OANDA:XAUUSD:15:1" };
  resetThreadSchemaCacheForTests();
  const e2 = env({ AI: ai, HUD_AGENTS_ENABLED: "true" });
  await runLiveRoomBar(e2, { bar_time: BAR, hud: other });
  assert.ok(!(await readLive(e2.DB, {})).some(m => String(m.step).startsWith("hud:")));
});

test("clip ends at the last full sentence that fits, else at a word with an ellipsis; short text is untouched", async () => {
  const { threadInternals } = await import("../src/agent-threads.mjs");
  const { clip } = threadInternals;
  const text = "H1 decision: WAIT, and the room agrees. No confirmed buy or sell signal exists. We stay flat until the hourly chain confirms a direction.";
  assert.equal(clip(text, 400), text);
  assert.equal(clip(text, 120), "H1 decision: WAIT, and the room agrees. No confirmed buy or sell signal exists.", "production cut this mid-word as 'confirms a d'");
  assert.equal(clip("one long sentence without any full stop inside the limit at all", 30), "one long sentence without…");
  assert.ok(clip("x".repeat(50), 20).length <= 20);
  assert.equal(clip(null, 10), "");
});

test("the strategy reads the latest closed 5m bar: its confirmation counts only while verified, and its close is the price", async () => {
  const { liveM5Inputs } = await import("../src/strategy-engine.mjs");
  const e = env();
  const now = Date.parse(BAR) + 60_000;
  const before = await liveM5Inputs(e, { now });
  assert.deepEqual(before.confirmation, { buy_confirmed: true, sell_confirmed: false, verified: false, candle_time: BAR }, "no approved 5m record: unverified");
  assert.equal(before.price, 4012, "the last 5m close");
  await seedVerifiedM5(e);
  assert.equal((await liveM5Inputs(e, { now })).confirmation.verified, true, "the 5m implementations approved: verified");
  assert.equal(await liveM5Inputs(e, { now: Date.parse(BAR) + 17 * 60_000 }), null, "older than 16 minutes: not live");
  const ctx = JSON.parse(m5({ sell_confirmed: true, buy_confirmed: false }));
  assert.equal((await liveM5Inputs({}, { now, context: ctx })).confirmation.sell_confirmed, true, "the context handed in by the 5m ingress wins over the cache");
});
