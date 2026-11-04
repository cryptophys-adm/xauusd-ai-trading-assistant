import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  runNewsThread, runLiveRoomBar, listThreads, readThread, readLive, buildMessageTree, validateRoomModerator,
  buildNewsThreadTask, buildLiveRoomTask, liveRoomEnabled, resetThreadSchemaCacheForTests, ROOM_STANCES
} from "../src/agent-threads.mjs";
import { BUS_DEFAULT_MODEL, BUS_DEFAULT_FALLBACK_MODEL } from "../src/multi-agent-bus.mjs";

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
const BAR = "2026-11-04T15:05:00.000Z";

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
  return JSON.stringify({ schema_version: "cryptophys.local-context.v1", trust_status: "informational_unverified", symbol: "OANDA:XAUUSD", timeframe: "5", candle_time: BAR, bias: "BULLISH", buy_confirmed: true, sell_confirmed: false, d_enc: 1, recent_bars: Array.from({ length: 12 }, (_, i) => ({ t: BAR, o: 4000 + i, h: 4002 + i, l: 3999 + i, c: 4001 + i, v: 10 })), ...extra });
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
          const isRoom = /live XAUUSD 5m/.test(sys);
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
  assert.ok(e.AI.calls.every(c => c.model === BUS_DEFAULT_MODEL));
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

test("live room: technical, risk (reply to technical), moderator; primary model only", async () => {
  const e = env();
  const result = await runLiveRoomBar(e, { bar_time: BAR });
  assert.equal(result.status, "complete");
  assert.equal(e.AI.calls.length, 3);
  assert.ok(e.AI.calls.every(c => c.model === BUS_DEFAULT_MODEL));
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
  assert.match(evidence.h1.tradingview, /TradingView indicators/, "the room sees the H1 TradingView reading");
  const prompts = e.AI.calls.map(c => c.request.messages.map(m => m.content).join("\n")).join("\n");
  assert.doesNotMatch(prompts, /tradingview_reading/, "no snake_case key the model could echo into its text");
});

test("live room never uses the paid fallback model", async () => {
  const e = env({ AI: fakeAI(() => new Error("primary down")) });
  await runLiveRoomBar(e, { bar_time: BAR });
  assert.ok(e.AI.calls.every(c => c.model !== BUS_DEFAULT_FALLBACK_MODEL));
  const items = await readLive(e.DB, {});
  assert.ok(items.every(m => m.status === "agent_failed"));
});

test("live room skips a bar when nothing changed", async () => {
  const e = env();
  await runLiveRoomBar(e, { bar_time: BAR });
  const next = "2026-11-04T15:10:00.000Z";
  await e.SIGNAL_CACHE.put("context:m5:latest", m5({ candle_time: next }));
  const r = await runLiveRoomBar(e, { bar_time: next });
  assert.equal(r.status, "skipped_no_change");
  assert.equal(e.AI.calls.length, 3, "no calls for an unchanged picture");
  await e.SIGNAL_CACHE.put("context:m5:latest", m5({ candle_time: "2026-11-04T15:15:00.000Z", bias: "BEARISH", buy_confirmed: false, sell_confirmed: true }));
  assert.equal((await runLiveRoomBar(e, { bar_time: "2026-11-04T15:15:00.000Z" })).status, "complete");
  assert.equal(e.AI.calls.length, 6);
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
  assert.deepEqual(t.post.tradingview.lines.map(l => l.source), ["Prophet R38", "Prophet R37", "GMI v12.70"]);
  assert.match(list[0].post.tradingview.summary, /TradingView indicators/);
  assert.equal(await readH1Thread(d1, "OANDA:XAUUSD:60:1"), null);
});
