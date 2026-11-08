import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  planShadowCalls, runShadowCalls, scoreShadowKnowledge, compareShadowKnowledge, readShadowKnowledge, pruneShadowKnowledge,
  shadowKnowledgeEnabled, maxCallsPerHour, noteLine, subjectOf, resetShadowKnowledgeSchemaCacheForTests, MAX_ITEMS
} from "../src/shadow-knowledge.mjs";
import { tuningView } from "../src/tuning.mjs";

const item = (id, agents, kind = "caution", extra = {}) => ({ item_id: id, version: 1, kind, label: "learned", audience: { agents, charts: ["60"] }, text: `Note ${id}: in the London session this HUD has been wrong 60% of the time.`, ...extra });
const openings = [
  { agent: "r37_funnel", status: "ok", stance: "BUY" }, { agent: "gmi", status: "ok", stance: "WAIT" },
  { agent: "risk", status: "invalid_output", stance: null }, { agent: "moderator", status: "ok", stance: "WAIT" }
];
const roster = ["h1", "technical", "risk", "r37_funnel", "gmi"];

test("off by default; on only with SHADOW_KNOWLEDGE_ENABLED=true; the hourly cap defaults to 8", () => {
  assert.equal(shadowKnowledgeEnabled({}), false);
  assert.equal(shadowKnowledgeEnabled({ SHADOW_KNOWLEDGE_ENABLED: "false" }), false);
  assert.equal(shadowKnowledgeEnabled({ SHADOW_KNOWLEDGE_ENABLED: "true" }), true);
  assert.equal(maxCallsPerHour({}), 8);
  assert.equal(maxCallsPerHour({ SHADOW_KNOWLEDGE_MAX_CALLS_PER_HOUR: "100" }), 24, "capped");
});

test("the plan: H1 only, text items only, at most 2 items, agents that spoke in the room, an A/A call with the first item", () => {
  const items = [item("c1", ["r37_funnel", "moderator", "risk", "absent"]), item("p1", ["gmi"], "param_candidate"), item("c2", ["gmi"], "role_reminder"), item("c3", ["gmi"]), item("c4", ["r37_funnel"], "caution", { audience: { agents: ["r37_funnel"], charts: ["15"] } })];
  assert.deepEqual(planShadowCalls({ items, roster, openings, chart: "H4" }), [], "only the 1H room is scored per agent");
  const plan = planShadowCalls({ items, roster, openings });
  assert.deepEqual(plan.map((c) => [c.subject, c.arm, c.control_stance]), [
    ["shadow-agent:r37_funnel@c1v1", "note", "BUY"],
    ["shadow-agent:r37_funnel@aa", "aa", "BUY"],
    ["shadow-agent:gmi@c2v1", "note", "WAIT"]
  ], "the moderator, an agent whose opening failed and an absent agent get no call; c3 waits (2 items at once); c4 is for the 15m chart");
  assert.equal(MAX_ITEMS, 2);
  assert.match(noteLine(item("c1", [])), /^LEARNED NOTE \(reviewed by a person; apply it only if it fits your data\): Note c1/);
  assert.equal(subjectOf("gmi", null), "shadow-agent:gmi@aa");
});

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter(n => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  const stmt = (sql, params = []) => ({
    bind: (...a) => stmt(sql, a.map(v => (v === undefined ? null : v))),
    async run() { const r = db.prepare(sql).run(...params); return { success: true, meta: { changes: Number(r.changes) } }; },
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { return { results: db.prepare(sql).all(...params) }; }
  });
  return { raw: db, prepare: (sql) => stmt(sql) };
}
const NOW = Date.parse("2026-11-09T10:00:00Z");
const answer = (stance) => ({ choices: [{ message: { content: JSON.stringify({ agent: "r37_funnel", stance, bias: stance === "SELL" ? "BEARISH" : "NEUTRAL", confidence: 0.5, claim: "The funnel reads flat on this candle." }) }, finish_reason: "stop" }] });

test("the calls carry the note (the A/A call does not), are stored once per bar, never touch the room, and respect the cap", async () => {
  resetShadowKnowledgeSchemaCacheForTests();
  const prompts = [];
  const env = {
    DB: d1(), SHADOW_KNOWLEDGE_ENABLED: "true", SHADOW_KNOWLEDGE_MAX_CALLS_PER_HOUR: "3", MULTI_AGENT_MODEL: "m", MULTI_AGENT_FALLBACK_MODEL: "",
    AI: { run: async (_model, input) => { prompts.push(JSON.stringify(input.messages)); return answer(JSON.stringify(input.messages).includes("LEARNED NOTE") ? "SELL" : "WAIT"); } }
  };
  const plan = planShadowCalls({ items: [item("c1", ["r37_funnel"])], roster, openings });
  const run = (candleKey, calls = plan) => runShadowCalls(env, {
    calls, candleKey, statementClose: "2026-11-09T09:00:00.000Z", clock: () => NOW, schema: { type: "object" },
    messagesFor: (agent, note) => [{ role: "system", content: `opening of ${agent}` }, { role: "user", content: note ? `${note}\nDATA` : "DATA" }],
    validate: (o) => ({ valid: ["BUY", "SELL", "WAIT", "HOLD", "CLOSE"].includes(o?.stance), errors: [] })
  });
  const first = await run("k1");
  assert.deepEqual(first, { status: "ok", called: 2, stored: 2, skipped: 0 });
  assert.ok(prompts[0].includes("LEARNED NOTE") && !prompts[1].includes("LEARNED NOTE"), "the note arm carries the note, the A/A arm the same prompt without it");
  const rows = env.DB.raw.prepare("SELECT subject, arm, stance, control_stance, status FROM shadow_agent_outputs ORDER BY subject").all();
  assert.deepEqual(rows.map((r) => [r.subject, r.arm, r.stance, r.control_stance, r.status]), [
    ["shadow-agent:r37_funnel@aa", "aa", "WAIT", "BUY", "ok"],
    ["shadow-agent:r37_funnel@c1v1", "note", "SELL", "BUY", "ok"]
  ]);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'agent_thread_messages'").get().n === 0 || env.DB.raw.prepare("SELECT COUNT(*) AS n FROM agent_thread_messages").get().n === 0, true, "nothing is written to the room");
  assert.equal((await run("k1")).skipped, 2, "idempotent per bar");
  const capped = await run("k2");
  assert.equal(capped.status, "budget_exhausted", "3 calls an hour: the second bar gets one call");
  assert.equal(capped.called, 1);
  assert.equal((await runShadowCalls({ ...env, SHADOW_KNOWLEDGE_ENABLED: "" }, { calls: plan })).status, "disabled");
});

test("both stances are scored on the H1 bars once the horizon closes; the comparison reports the A/A noise rate", async () => {
  resetShadowKnowledgeSchemaCacheForTests();
  const start = Date.parse("2026-11-09T00:00:00Z");
  // H1 bars: flat, then a fall after 16:00 (a SELL from 16:00 hits, a BUY misses); 15 bars of ATR history first.
  const bars = Array.from({ length: 24 }, (_, i) => { const p = i <= 15 ? 4000 : 4000 - (i - 15) * 12; return { open_time: new Date(start + i * 3_600_000).toISOString(), close_time: new Date(start + (i + 1) * 3_600_000).toISOString(), open: p, high: p + 3, low: p - 3, close: p }; });
  const env = { DB: d1(), SIGNAL_CACHE: { async get(k) { return k === "market-data:v2:series:OANDA:XAUUSD|1h" ? JSON.stringify({ candles: bars }) : null; } } };
  await pruneShadowKnowledge(env, { now: NOW });
  const ins = env.DB.raw.prepare("INSERT INTO shadow_agent_outputs (subject, candle_key, agent, item_id, item_version, arm, statement_close, stance, control_stance, status, created_at) VALUES (?, ?, 'r37_funnel', ?, 1, ?, ?, ?, ?, 'ok', ?)");
  const close = new Date(start + 16 * 3_600_000).toISOString();
  ins.run("shadow-agent:r37_funnel@c1v1", "k7", "c1", "note", close, "SELL", "BUY", close);
  ins.run("shadow-agent:r37_funnel@aa", "k7", null, "aa", close, "BUY", "BUY", close);
  const r = await scoreShadowKnowledge(env, { now: Date.parse(bars.at(-1).close_time) });
  assert.equal(r.scored, 2);
  const row = env.DB.raw.prepare("SELECT result, control_result FROM shadow_agent_outputs WHERE arm = 'note'").get();
  assert.deepEqual([row.result, row.control_result], ["hit", "miss"]);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM outcome_scores WHERE subject LIKE 'shadow-agent:%'").get().n, 0, "never in outcome_scores: no scorecard or reputation sees them");
  const view = await readShadowKnowledge(env, { now: NOW + 86_400_000 });
  assert.equal(view.enabled, false);
  assert.deepEqual(view.aa_noise, { bars: 1, changed: 0, rate: 0 });
  assert.equal(view.candidates.length, 1, "the A/A arm is noise, not a candidate");
  assert.equal(view.candidates[0].paired.candidate_better, 1);
  assert.equal(view.candidates[0].verdict, "collecting");
  assert.equal(tuningView({ families: [] }, { knowledge: view }).replays.knowledge.family, "knowledge");
});

test("a note that is right where the opening was wrong, over the sample, is better; the noise rate travels with it", () => {
  const rows = [];
  for (let i = 0; i < 320; i++) {
    const t = new Date(Date.parse("2026-11-01T00:00:00Z") + i * 3_600_000).toISOString();
    const differ = i % 8 === 0;
    rows.push({ subject: "shadow-agent:gmi@c2v1", candle_key: "k" + i, agent: "gmi", item_id: "c2", item_version: 1, arm: "note", statement_close: t, stance: differ ? "SELL" : "WAIT", control_stance: "WAIT", status: "ok", result: differ ? "hit" : "hit", control_result: differ ? "missed_opportunity" : "hit" });
    rows.push({ subject: "shadow-agent:gmi@aa", candle_key: "k" + i, agent: "gmi", item_id: null, item_version: null, arm: "aa", statement_close: t, stance: i % 10 === 0 ? "BUY" : "WAIT", control_stance: "WAIT", status: "ok", result: null, control_result: null });
  }
  const view = compareShadowKnowledge(rows, { now: Date.parse("2026-11-20T00:00:00Z") });
  const k = view.candidates[0];
  assert.equal(k.criteria.minimum_sample, true);
  assert.equal(k.discovery.control_better, 0);
  assert.equal(k.verdict, "better_than_active: ready for owner review");
  assert.deepEqual(view.aa_noise, { bars: 320, changed: 32, rate: 0.1 });
});
