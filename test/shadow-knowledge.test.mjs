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

test("off by default; on only with SHADOW_KNOWLEDGE_ENABLED=true; the hourly cap defaults to 32 (shared by the 1H room, the 15m War Room and the council; 32 since 2026-11-16)", () => {
  assert.equal(shadowKnowledgeEnabled({}), false);
  assert.equal(shadowKnowledgeEnabled({ SHADOW_KNOWLEDGE_ENABLED: "false" }), false);
  assert.equal(shadowKnowledgeEnabled({ SHADOW_KNOWLEDGE_ENABLED: "true" }), true);
  assert.equal(maxCallsPerHour({}), 32);
  assert.equal(maxCallsPerHour({ SHADOW_KNOWLEDGE_MAX_CALLS_PER_HOUR: "100" }), 48, "capped");
  assert.equal(maxCallsPerHour({ SHADOW_KNOWLEDGE_MAX_CALLS_PER_HOUR: "8" }), 8);
});

test("the plan: H1 only, text items only, at most 6 items, agents that spoke in the room, an A/A call with the first item", () => {
  const items = [item("c1", ["r37_funnel", "moderator", "risk", "absent"]), item("p1", ["gmi"], "param_candidate"), item("c2", ["gmi"], "role_reminder"), item("c3", ["gmi"]), item("c4", ["r37_funnel"], "caution", { audience: { agents: ["r37_funnel"], charts: ["15"] } })];
  assert.deepEqual(planShadowCalls({ items, roster, openings, chart: "H4" }), [], "only the 1H room is scored per agent");
  const plan = planShadowCalls({ items, roster, openings });
  assert.deepEqual(plan.map((c) => [c.subject, c.arm, c.control_stance]), [
    ["shadow-agent:r37_funnel@c1v1", "note", "BUY"],
    ["shadow-agent:r37_funnel@aa", "aa", "BUY"],
    ["shadow-agent:gmi@c2v1", "note", "WAIT"],
    ["shadow-agent:gmi@c3v1", "note", "WAIT"]
  ], "the moderator, an agent whose opening failed and an absent agent get no call; c4 is for the 15m chart");
  assert.equal(MAX_ITEMS, 6);
  // Owner 2026-11-16 ("opsi A"): six items at once; the seventh waits.
  const many = Array.from({ length: 8 }, (_, i) => item(`m${i}`, ["gmi"]));
  assert.deepEqual(planShadowCalls({ items: many, roster, openings }).filter((c) => c.arm === "note").map((c) => c.item.item_id), ["m0", "m1", "m2", "m3", "m4", "m5"]);
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

test("since 2026-11-13 the arm also runs on the 15m War Room and the council, with 15m subjects and 15m scoring", async () => {
  const { chartOfSubject, SHADOW_CHARTS } = await import("../src/shadow-knowledge.mjs");
  const m15 = item("w1", ["risk"], "caution", { audience: { agents: ["risk"], charts: ["15"] } });
  const council = item("k1", ["council"], "caution", { audience: { agents: ["council"], charts: ["15"] } });
  const h1Only = item("h1", ["risk"]);
  // The 15m War Room: its own roster and openings; a 1H item is not tested there, nor is the council's.
  const room = planShadowCalls({ items: [h1Only, council, m15], roster: ["risk", "technical"], openings: [{ agent: "risk", status: "ok", stance: "SELL" }], chart: "M15" });
  assert.deepEqual(room.map((c) => [c.subject, c.arm]), [["shadow-agent:risk@w1v1@15", "note"], ["shadow-agent:risk@aa@15", "aa"]]);
  // The council: one call against the decided stance.
  const dec = planShadowCalls({ items: [m15, council], roster: ["council"], openings: [{ agent: "council", status: "ok", stance: "WAIT" }], chart: "M15" });
  assert.deepEqual(dec.map((c) => [c.subject, c.control_stance]), [["shadow-agent:council@k1v1@15", "WAIT"], ["shadow-agent:council@aa@15", "WAIT"]]);
  // The 1H plan is unchanged and the 1H subjects keep their form.
  assert.deepEqual(planShadowCalls({ items: [m15], roster: ["risk"], openings: [{ agent: "risk", status: "ok", stance: "SELL" }] }), []);
  assert.deepEqual([chartOfSubject("shadow-agent:risk@w1v1@15"), chartOfSubject("shadow-agent:risk@w1v1")], ["15", "60"]);
  assert.deepEqual(SHADOW_CHARTS, { H1: "60", M15: "15" });
  // The comparison carries the chart, so a promotion goes live on the chart it was tested on.
  const k = compareShadowKnowledge([{ subject: "shadow-agent:risk@w1v1@15", agent: "risk", item_id: "w1", item_version: 1, arm: "note", statement_close: "2026-11-13T01:00:00Z", status: "ok", stance: "SELL", control_stance: "WAIT", result: "hit", control_result: "neutral" }]);
  assert.equal(k.candidates[0].chart, "15");
});

// ------------------------------------------------------------------ KA1: self-judging
// Owner 2026-11-24 (relayed by the orchestrator): "buka arm, biarkan system menilai dirinya sendiri". An item with a final
// verdict closes by itself: better goes live through learned-live; not better, holdout failed or worse retires.
const H = 3_600_000, Q = 15 * 60_000;
/** `n` stored rows of one subject; `pair(i)` gives [stance, result, control_stance, control_result]. */
function rowsOf(subject, agent, itemId, n, pair, { start = Date.parse("2026-11-13T00:00:00Z"), step = Q, status = "ok" } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const [stance, result, control_stance, control_result] = pair(i);
    const t = new Date(start + i * step).toISOString();
    return { subject, candle_key: `k${i}`, agent, item_id: itemId, item_version: itemId ? 1 : null, arm: itemId ? "note" : "aa", statement_close: t, created_at: t, stance, control_stance, status, result, control_result };
  });
}
const same = () => ["WAIT", "hit", "WAIT", "hit"];
const KNOW_NOW = Date.parse("2026-11-24T12:00:00Z");

test("KA1-1. the closure rule: below the sample it collects; not better, holdout failed and worse retire; better is left to learned-live", async () => {
  const { planShadowClosures, CLOSURE_VERSION } = await import("../src/shadow-knowledge.mjs");
  const plan = (rows) => planShadowClosures(rows, { now: KNOW_NOW }).items;
  // Too few readings: 299 scored pairs (199 discovery bars) stay in the queue.
  assert.deepEqual(plan(rowsOf("shadow-agent:risk@n1v1@15", "risk", "n1", 299, same)).map((i) => [i.key, i.outcome, i.reason]), [["n1@1", "collecting", null]]);
  // 300 pairs with the same stance on every bar: not better.
  const nb = plan(rowsOf("shadow-agent:risk@n1v1@15", "risk", "n1", 300, same))[0];
  assert.deepEqual([nb.outcome, nb.reason], ["retired", "not_better"]);
  // The control right where the note was wrong, on every 8th bar: worse (reverse sign test, Holm-adjusted).
  const worse = plan(rowsOf("shadow-agent:risk@w1v1@15", "risk", "w1", 320, (i) => (i % 8 === 0 ? ["SELL", "miss", "WAIT", "hit"] : same())))[0];
  assert.deepEqual([worse.outcome, worse.reason], ["retired", "worse"]);
  const s = worse.evidence.subjects[0];
  assert.equal(worse.evidence.schema, CLOSURE_VERSION);
  assert.deepEqual([s.rows, s.scored, s.treat_hits, s.control_hits, s.discovery.candidate_better, s.discovery.control_better], [320, 320, 280, 320, 0, 28]);
  assert.ok(s.p_holm_worse < 0.05 && s.p_value === 1);
  assert.deepEqual(s.aa, { changed: 0, total: 0 });
  // Better in discovery, worse in the newest 100 bars: holdout failed.
  const hf = plan(rowsOf("shadow-agent:risk@h1v1@15", "risk", "h1", 320, (i) => (i % 8 !== 0 ? same() : i < 220 ? ["SELL", "hit", "WAIT", "missed_opportunity"] : ["SELL", "miss", "WAIT", "hit"])))[0];
  assert.deepEqual([hf.outcome, hf.reason], ["retired", "holdout_failed"]);
  // Better on both slices: left to learned-live (outcome live, never closed here).
  const better = plan(rowsOf("shadow-agent:risk@b1v1@15", "risk", "b1", 320, (i) => (i % 8 === 0 ? ["SELL", "hit", "WAIT", "missed_opportunity"] : same())))[0];
  assert.deepEqual([better.outcome, better.reason], ["live", null]);
  // An item is judged on its first final subject (the 15m one), the 1H one still collecting; A/A counts per agent and chart.
  const two = plan([
    ...rowsOf("shadow-agent:chronos_matrix@c9v1@15", "chronos_matrix", "c9", 300, same),
    ...rowsOf("shadow-agent:chronos_matrix@c9v1", "chronos_matrix", "c9", 80, same, { step: H }),
    ...rowsOf("shadow-agent:chronos_matrix@aa@15", "chronos_matrix", null, 10, (i) => (i < 3 ? ["SELL", null, "WAIT", null] : ["WAIT", null, "WAIT", null]))
  ]);
  assert.equal(two.length, 1, "the A/A arm is not an item");
  assert.deepEqual([two[0].outcome, two[0].reason], ["retired", "not_better"]);
  assert.deepEqual(two[0].evidence.subjects.map((x) => [x.chart, x.outcome, x.aa.changed, x.aa.total]), [["15", "not_better", 3, 10], ["60", "collecting", 0, 0]]);
  // No price anywhere in the evidence: counts, p and ids only.
  assert.doesNotMatch(JSON.stringify(two[0].evidence), /price|entry|stop|target|level/i);
});

test("KA1-2. with the switch off nothing is read or written (byte-identical to before)", async () => {
  const { runShadowClosures } = await import("../src/shadow-knowledge.mjs");
  const touched = [];
  const env = { DB: { prepare(sql) { touched.push(sql); throw new Error("no D1 with the arm off"); } }, SIGNAL_CACHE: { async get(k) { touched.push(k); return null; }, async put(k) { touched.push(k); } } };
  assert.deepEqual(await runShadowClosures(env, { now: KNOW_NOW }), { status: "disabled" });
  assert.deepEqual(await runShadowClosures({ ...env, SHADOW_KNOWLEDGE_ENABLED: "false" }, { now: KNOW_NOW }), { status: "disabled" });
  assert.deepEqual(touched, []);
});

test("KA1-3. the #492 items are settled once from their stored rows (KV marker); a closed item frees its slot and never returns", async () => {
  const { runShadowClosures, SHADOW_SETTLE, closureMessage } = await import("../src/shadow-knowledge.mjs");
  const { resetLearnedLiveForTests, readLearnedLive, promotedKeys, planPromotions } = await import("../src/learned-live.mjs");
  const { pullLearnedPack, resetAetherPackSchemaCacheForTests } = await import("../src/aether-pack.mjs");
  const { shadowItems } = await import("../src/shadow-knowledge.mjs");
  resetShadowKnowledgeSchemaCacheForTests(); resetLearnedLiveForTests(); resetAetherPackSchemaCacheForTests();
  const text = (id, agents) => ({ item_id: id, version: 1, kind: "role_reminder", label: "learned", audience: { agents, charts: [] }, text: `Note ${id}: keep to your own data.`, content_sha256: "c".repeat(64), review: "auto" });
  const items = [text("k-old-final", ["risk", "moderator"]), text("k-old-short", ["trade_management", "moderator"]), text("k-new", ["prophet", "moderator"])];
  const kv = new Map();
  const env = {
    DB: d1(), SHADOW_KNOWLEDGE_ENABLED: "true",
    SIGNAL_CACHE: { async get(k) { return kv.get(k) ?? null; }, async put(k, v) { kv.set(k, v); } },
    AETHER: { learnedPack: async () => ({ version: "cryptophys.learned-pack.v1", sha256: "a".repeat(64), items }) }
  };
  await pullLearnedPack(env, { now: KNOW_NOW - 10 * 86_400_000 });
  const ins = env.DB.raw.prepare("INSERT INTO shadow_agent_outputs (subject, candle_key, agent, item_id, item_version, arm, statement_close, stance, control_stance, status, created_at, result, control_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const put = (rows) => rows.forEach((r) => ins.run(r.subject, r.candle_key, r.agent, r.item_id, r.item_version, r.arm, r.statement_close, r.stance, r.control_stance, r.status, r.created_at, r.result, r.control_result));
  // Before #492: one item reached its sample (300 pairs on 15m), one did not (120 pairs).
  put(rowsOf("shadow-agent:risk@k-old-finalv1@15", "risk", "k-old-final", 300, same));
  put(rowsOf("shadow-agent:trade_management@k-old-shortv1@15", "trade_management", "k-old-short", 120, same));
  // After the reopening: more rows for the short one, which the settle must not read.
  put(rowsOf("shadow-agent:trade_management@k-old-shortv1@15", "trade_management", "k-old-short", 400, same, { start: Date.parse("2026-11-24T00:00:00Z") }).map((r) => ({ ...r, candle_key: "n" + r.candle_key })));
  assert.deepEqual((await shadowItems(env)).map((i) => i.item_id), ["k-new", "k-old-final", "k-old-short"].sort(), "all three queue before");

  const first = await runShadowClosures(env, { now: KNOW_NOW });
  assert.equal(first.status, "ok");
  const marker = JSON.parse(kv.get(SHADOW_SETTLE.key));
  assert.deepEqual([marker.until, marker.items, marker.live, marker.retired, marker.collecting, marker.closed], [SHADOW_SETTLE.until, 2, 0, 1, 1, ["k-old-final@1"]], "the settle reads only the rows stored before the reopening");
  assert.deepEqual(first.closed, ["k-old-final@1", "k-old-short@1"], "then the hourly rule judges every stored row: the short one has 520 pairs now");
  assert.match(first.message, /closed: k-old-final v1: not_better \(risk on 15m: 300 scored, note 300 vs control 300 hits/);
  // Recorded in learned_live as retired with a machine-readable reason and evidence; never live.
  const row = env.DB.raw.prepare("SELECT status, reason, verdict_json, retired_at FROM learned_live WHERE item_id = 'k-old-final'").get();
  assert.deepEqual([row.status, row.reason], ["retired", "shadow:not_better"]);
  const ev = JSON.parse(row.verdict_json);
  assert.deepEqual([ev.reason, ev.subjects[0].rows, ev.subjects[0].scored, ev.subjects[0].treat_hits, ev.subjects[0].control_hits], ["not_better", 300, 300, 300, 300]);
  assert.ok((await promotedKeys(env)).has("k-old-final@1"));
  assert.deepEqual((await shadowItems(env)).map((i) => i.item_id), ["k-new"], "the slots are free; the closed items are never tested again");
  const view = await readLearnedLive(env);
  assert.equal(view.items.find((i) => i.item_id === "k-old-final").closure.reason, "not_better");
  // A later better verdict never brings a closed version back.
  const better = { subject: "shadow-agent:risk@k-old-finalv1@15", agent: "risk", chart: "15", item_id: "k-old-final", item_version: 1, verdict: "better_than_active: ready for owner review", discovery: {}, holdout: {}, paired: {} };
  assert.equal(planPromotions({ candidates: [better], packItems: items, retired: [{ item_id: "k-old-final", version: 1 }], now: KNOW_NOW }).promote.length, 0);
  // Once: the marker stays, nothing is closed twice.
  const again = await runShadowClosures(env, { now: KNOW_NOW + H });
  assert.deepEqual([again.settle, again.closed, again.message], [null, [], null]);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM learned_live").get().n, 2);
  assert.equal(closureMessage([]), null);
  // Nothing is written to a room, the bus or a decision.
  for (const t of ["agent_thread_messages", "engine_decisions", "outcome_scores"]) {
    const exists = env.DB.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?").get(t).n;
    if (exists) assert.equal(env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  }
});

test("KA1-4. a moderator-only item takes no slot, even when the room's roster lists the moderator (it is never called, so it would hold a slot forever)", () => {
  const withModerator = [...roster, "moderator"];
  const modOnly = Array.from({ length: MAX_ITEMS }, (_, i) => item(`mod${i}`, ["moderator"]));
  const plan = planShadowCalls({ items: [...modOnly, item("g1", ["gmi"])], roster: withModerator, openings });
  assert.deepEqual(plan.filter((c) => c.arm === "note").map((c) => c.item.item_id), ["g1"], "the testable item gets a slot behind six moderator-only items");
  assert.equal(plan.some((c) => c.agent === "moderator"), false, "the moderator is never called");
  // An item for the moderator and a testable agent still takes its slot and calls the testable agent only.
  const mixed = planShadowCalls({ items: [item("m1", ["moderator", "gmi"])], roster: withModerator, openings });
  assert.deepEqual(mixed.map((c) => [c.agent, c.arm]), [["gmi", "note"], ["gmi", "aa"]]);
});
