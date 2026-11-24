// KA2 (platform PF3, capability knowledge.verdict): the shadow arm's verdicts posted to the platform as the kernel
// agent shadow-knowledge, for Aether's curator (src/knowledge-verdicts.mjs). No network: the kernel is a stub.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  KNOWLEDGE_VERDICT_AGENT_ID, KNOWLEDGE_VERDICT_CAPABILITY, KNOWLEDGE_VERDICTS, KNOWLEDGE_VERDICT_EVIDENCE_KEYS, KNOWLEDGE_VERDICT_RULES,
  knowledgeVerdictPostsEnabled, verdictPayloadProblems, subjectEvidence, untestableReason, verdictEntries, planVerdictPosts,
  postKnowledgeVerdicts, resetKnowledgeVerdictsForTests
} from "../src/knowledge-verdicts.mjs";
import { planShadowClosures, runShadowClosures, resetShadowKnowledgeSchemaCacheForTests, CLOSURE_VERSION } from "../src/shadow-knowledge.mjs";
import { resetLearnedLiveForTests, LEARNED_LIVE_SCHEMA_SQL } from "../src/learned-live.mjs";
import { pullLearnedPack, resetAetherPackSchemaCacheForTests } from "../src/aether-pack.mjs";
import { resetPlatformBackoffForTests } from "../src/platform-reports.mjs";
import { signTestP } from "../src/shadow-versions.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  const stmt = (sql, params = []) => ({
    bind: (...a) => stmt(sql, a.map((v) => (v === undefined ? null : v))),
    async run() { const r = db.prepare(sql).run(...params); return { success: true, meta: { changes: Number(r.changes) } }; },
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { return { results: db.prepare(sql).all(...params) }; }
  });
  return { raw: db, prepare: (sql) => stmt(sql) };
}
const reset = () => { resetKnowledgeVerdictsForTests(); resetShadowKnowledgeSchemaCacheForTests(); resetLearnedLiveForTests(); resetAetherPackSchemaCacheForTests(); resetPlatformBackoffForTests(); };
const H = 3_600_000, Q = 15 * 60_000, DAY = 86_400_000;
const NOW = Date.parse("2026-11-24T18:05:00Z");
const same = () => ["WAIT", "hit", "WAIT", "hit"];
function rowsOf(subject, agent, itemId, n, pair = same, { start = Date.parse("2026-11-13T00:00:00Z"), step = Q, status = "ok", tag = "k" } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const [stance, result, control_stance, control_result] = pair(i);
    const t = new Date(start + i * step).toISOString();
    return { subject, candle_key: `${tag}${i}`, agent, item_id: itemId, item_version: itemId ? 1 : null, arm: itemId ? "note" : "aa", statement_close: t, created_at: t, stance, control_stance, status, result, control_result };
  });
}
const FORBIDDEN = ["p_holm_worse", "p_value_worse", "subject", "agent", "chart", "outcome", "discovery", "holdout", "changed_stance", "aa", "schema", "judged_at", "version", "key"];

// The real closure of the settle (KA1 study, production D1 read-only 2026-11-24): chronos_matrix on 15m, 404 rows, 404
// scored, note 197 vs control 206 hits, 3 vs 9 changed discovery bars (304), p 0.9807, reverse p 0.073, A/A 17 of 388.
const CHRONOS = "k-role-chronos-matrix-calibration-talk";
const CHRONOS_15 = `shadow-agent:chronos_matrix@${CHRONOS}v1@15`;
const CHRONOS_EVIDENCE = {
  schema: CLOSURE_VERSION, item_id: CHRONOS, version: 1, outcome: "retired", reason: "not_better", judged_at: "2026-11-24T17:05:00.000Z",
  subjects: [
    { subject: CHRONOS_15, agent: "chronos_matrix", chart: "15", outcome: "not_better", rows: 404, scored: 404, treat_hits: 197, control_hits: 206, changed_stance: 19,
      discovery: { bars: 304, candidate_better: 3, control_better: 9 }, holdout: { bars: 100, candidate_better: 2, control_better: 5 },
      p_value: signTestP(3, 9), p_holm: signTestP(3, 9), p_value_worse: signTestP(9, 3), p_holm_worse: signTestP(9, 3), aa: { changed: 17, total: 388 } },
    { subject: `shadow-agent:chronos_matrix@${CHRONOS}v1`, agent: "chronos_matrix", chart: "60", outcome: "collecting", rows: 83, scored: 82, treat_hits: 26, control_hits: 28, changed_stance: 4,
      discovery: { bars: 0, candidate_better: 0, control_better: 0 }, holdout: { bars: 82, candidate_better: 1, control_better: 2 },
      p_value: 1, p_holm: null, p_value_worse: null, p_holm_worse: null, aa: { changed: 11, total: 83 } }
  ]
};
const CHRONOS_WINDOW = { [CHRONOS_15]: { start: "2026-11-12T19:15:00.000Z", end: "2026-11-19T18:00:00.000Z" } };
const chronosLive = () => ({ item_id: CHRONOS, version: 1, status: "retired", verdict_json: JSON.stringify(CHRONOS_EVIDENCE), promoted_at: "2026-11-24T17:05:00.000Z", retired_at: "2026-11-24T17:05:00.000Z", reason: "shadow:not_better" });

function assertSchema(p, label) {
  assert.deepEqual(verdictPayloadProblems(p), [], label);
  assert.deepEqual(Object.keys(p).filter((k) => !["item_id", "item_version", "verdict", "reason", "evidence"].includes(k)), [], label);
  assert.match(p.item_id, /^k-[a-z0-9-]{1,40}$/, label);
  assert.ok(Number.isInteger(p.item_version) && p.item_version >= 1 && p.item_version <= 999, label);
  assert.ok(KNOWLEDGE_VERDICTS.includes(p.verdict), label);
  assert.ok(p.reason.length >= 10 && p.reason.length <= 300, label);
  assert.doesNotMatch(p.reason, /\d{3,}/, `${label}: no price-like number in the reason`);
  for (const [k, v] of Object.entries(p.evidence)) {
    assert.ok(KNOWLEDGE_VERDICT_EVIDENCE_KEYS.includes(k), `${label}: ${k}`);
    assert.ok(v !== null && v !== undefined, `${label}: ${k} is never null`);
  }
  for (const k of FORBIDDEN) assert.equal(k in p.evidence, false, `${label}: ${k}`);
  for (const k of ["window_start", "window_end"]) if (k in p.evidence) assert.match(p.evidence[k], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, label);
  for (const k of ["p_value", "p_holm"]) if (k in p.evidence) assert.ok(p.evidence[k] >= 0 && p.evidence[k] <= 1, label);
  if ("charts" in p.evidence) assert.ok(p.evidence.charts.every((c) => /^[a-z0-9]+$/.test(c)), label);
  assert.match(p.evidence.rule, /^[a-z0-9_.+-]{1,40}$/, label);
  assert.doesNotMatch(p.evidence.rule, /\d{3,}/, label);
}

test("KV-1. the payload of the real chronos closure: the platform's schema exactly, the verdict is the closure's token", () => {
  const [e] = verdictEntries({ plan: { items: [], windows: CHRONOS_WINDOW }, live: [chronosLive()] });
  assert.deepEqual(e.payload, {
    item_id: CHRONOS, item_version: 1, verdict: "not_better",
    reason: "Closed in shadow: the note did not make chronos matrix better than its own answer on the quarter-hour chart (Holm-adjusted sign test on the discovery bars).",
    evidence: {
      arm: "chronos_matrix", window_start: "2026-11-12T19:15:00.000Z", window_end: "2026-11-19T18:00:00.000Z",
      rows: 404, scored: 404, treat_hits: 197, control_hits: 206, aa_changed: 17, aa_total: 388,
      p_value: signTestP(3, 9), p_holm: signTestP(3, 9), charts: ["15"], rule: "sign_holm.better"
    }
  });
  assert.equal(Math.round(e.payload.evidence.p_holm * 10000) / 10000, 0.9807);
  assertSchema(e.payload, "chronos");
  assert.equal(e.window_end, "", "a final verdict's marker has no window");
  // Worse: the reverse test's p goes in p_value / p_holm and the rule says which test; p_holm_worse never appears.
  const worse = subjectEvidence({ ...CHRONOS_EVIDENCE.subjects[0], outcome: "worse" }, "worse");
  assert.deepEqual([worse.p_value, worse.p_holm, worse.rule], [signTestP(9, 3), signTestP(9, 3), "sign_holm.worse"]);
  // Without a window (rows pruned), the window keys are omitted, never null.
  const bare = verdictEntries({ plan: { items: [] }, live: [chronosLive()] })[0].payload.evidence;
  assert.equal("window_start" in bare || "window_end" in bare, false);
  assertSchema({ ...e.payload, evidence: bare }, "no window");
});

test("KV-2. the schema check refuses every key, null, range and pattern the platform refuses", () => {
  const [e] = verdictEntries({ plan: { items: [], windows: CHRONOS_WINDOW }, live: [chronosLive()] });
  const p = e.payload;
  const bad = (patch, evidence = {}) => verdictPayloadProblems({ ...p, ...patch, evidence: { ...p.evidence, ...evidence } });
  assert.ok(bad({}, { p_holm_worse: 0.07 }).includes("evidence_key_not_allowed:p_holm_worse"));
  assert.ok(bad({ subject: "x" }).includes("key_not_allowed:subject"));
  assert.ok(bad({}, { p_holm: null }).includes("evidence_null:p_holm"));
  assert.ok(bad({}, { p_value: 1.2 }).includes("evidence_p_value_invalid"));
  assert.ok(bad({}, { rows: -1 }).includes("evidence_rows_invalid"));
  assert.ok(bad({}, { rule: "untestable.chart_240_only" }).includes("evidence_rule_invalid"), "no run of 3 digits in the rule");
  assert.ok(bad({}, { rule: "Sign Holm" }).includes("evidence_rule_invalid"));
  assert.ok(bad({}, { charts: ["15M"] }).includes("evidence_charts_invalid"));
  assert.ok(bad({}, { window_end: "2026-11-19T18:00:00+00:00" }).includes("evidence_window_end_invalid"));
  assert.ok(bad({}, { window_start: "2026-11-20T00:00:00.000Z" }).includes("evidence_window_order"));
  assert.ok(bad({}, { treat_hits: 500 }).includes("evidence_treat_hits_above_scored"));
  assert.ok(bad({ item_id: "k_role_x" }).includes("item_id_invalid"));
  assert.ok(bad({ item_id: "k-" + "a".repeat(41) }).includes("item_id_invalid"));
  assert.ok(bad({ item_version: 1000 }).includes("item_version_invalid"));
  assert.ok(bad({ item_version: 0 }).includes("item_version_invalid"));
  assert.ok(bad({ verdict: "better" }).includes("verdict_invalid"));
  assert.ok(bad({ reason: "short" }).includes("reason_invalid"));
  assert.ok(bad({ reason: "Gold held above 4095 on the quarter-hour chart." }).includes("reason_invalid"), "no price in the reason");
  assert.ok(bad({ reason: "x".repeat(301) }).includes("reason_invalid"));
  assert.deepEqual(KNOWLEDGE_VERDICT_EVIDENCE_KEYS, ["arm", "window_start", "window_end", "rows", "scored", "treat_hits", "control_hits", "aa_changed", "aa_total", "p_value", "p_holm", "charts", "rule"]);
});

test("KV-3. fuzz: closure evidence from random stored rows always builds a payload inside the schema", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const agents = ["chronos_matrix", "risk", "trade_management", "council", "prophet", "aegis_footprint"];
  const results = ["hit", "miss", "missed_opportunity", "neutral", null];
  const tokens = new Set();
  for (let round = 0; round < 12; round++) {
    const rows = [];
    for (let s = 0; s < 4; s++) {
      const agent = pick(agents), id = `k-fuzz-${round}-${s}`, chart = pick(["60", "15"]);
      const subject = `shadow-agent:${agent}@${id}v1${chart === "15" ? "@15" : ""}`;
      const n = 150 + Math.floor(rnd() * 280), bias = rnd();
      rows.push(...rowsOf(subject, agent, id, n, () => {
        const stance = pick(["WAIT", "BUY", "SELL"]), control = rnd() < 0.8 ? stance : pick(["WAIT", "BUY", "SELL"]);
        const r = rnd() < 0.05 ? null : rnd() < bias ? "hit" : pick(results);
        return [stance, r, control, r === null ? null : pick(results) ?? "hit"];
      }, { step: chart === "15" ? Q : H, status: rnd() < 0.03 ? "agent_failed" : "ok" }));
      rows.push(...rowsOf(`shadow-agent:${agent}@aa${chart === "15" ? "@15" : ""}`, agent, null, 20, () => [pick(["WAIT", "SELL"]), null, "WAIT", null], { tag: `aa${round}${s}` }));
    }
    const plan = planShadowClosures(rows, { now: NOW });
    // What closeShadowItems would write for the closed items, and the rest collecting.
    const live = plan.items.filter((i) => i.outcome === "retired").map((i) => ({ item_id: i.item_id, version: i.version, status: "retired", verdict_json: JSON.stringify(i.evidence), promoted_at: "2026-11-24T00:00:00.000Z", retired_at: "2026-11-24T00:00:00.000Z", reason: `shadow:${i.reason}` }));
    const entries = verdictEntries({ plan, live });
    for (const e of entries) { assertSchema(e.payload, `${e.key} ${e.verdict}`); tokens.add(e.verdict); }
    assert.equal(entries.length, plan.items.filter((i) => i.outcome !== "live").length, "every judged item has a payload (a better one goes through learned-live first)");
  }
  assert.ok(tokens.has("collecting") && tokens.has("not_better"), [...tokens].join(","));
});

test("KV-4. never testable here: moderator only, Omega's audience and the 4H chart only; a testable item has no not_tested", () => {
  const it = (item_id, agents, charts = []) => ({ item_id, version: 1, kind: "caution", audience: { agents, charts }, text: "A note." });
  assert.equal(untestableReason(it("a", ["moderator"])), "moderator_only");
  assert.equal(untestableReason(it("b", ["omega", "moderator"], ["15"])), "audience_omega");
  assert.equal(untestableReason(it("c", ["macro"], ["240"])), "chart_4h_only");
  assert.equal(untestableReason(it("d", ["macro"], ["1D"])), "chart_1d_only");
  assert.equal(untestableReason(it("e", ["risk"], ["60"])), null);
  assert.equal(untestableReason(it("f", ["risk", "moderator"], ["240", "15"])), null);
  const entries = verdictEntries({ plan: { items: [] }, packItems: [it("k-mod-only", ["moderator"]), it("k-omega", ["omega", "moderator"], ["15"]), it("k-four-hour", ["macro"], ["240"]), it("k-ok", ["risk"]), { ...it("k-param", ["moderator"]), kind: "param_candidate" }] });
  assert.deepEqual(entries.map((e) => [e.item_id, e.verdict, e.payload.evidence.rule]), [
    ["k-four-hour", "not_tested", "untestable.chart_4h_only"], ["k-mod-only", "not_tested", "untestable.moderator_only"], ["k-omega", "not_tested", "untestable.audience_omega"]
  ]);
  for (const e of entries) assertSchema(e.payload, e.key);
});

// ------------------------------------------------------------------ the sender, end to end on D1
const COLLECTING = [
  ["k-role-risk-calibration-talk", "risk", "15", 293], ["k-role-chronos-matrix-data-scope", "chronos_matrix", "15", 261],
  ["k-role-trade-management-data-scope", "trade_management", "15", 236], ["k-role-aegis-footprint-data-scope", "aegis_footprint", "15", 71],
  ["k-caution-news-60-new-york", "news", "60", 68], ["k-caution-trade-management-60-new-york", "trade_management", "60", 63],
  ["k-role-decision-matrix-data-scope", "decision_matrix", "15", 40], ["k-role-prophet-data-scope", "prophet", "15", 35],
  ["k-caution-supertrend-60-new-york", "supertrend", "60", 9], ["k-caution-h1-60-new-york", "h1", "60", 16]
];
const UNTESTABLE_ITEMS = [
  { item_id: "k-moderator-london-reminder", agents: ["moderator"], charts: ["60"] },
  { item_id: "k-exec-plan-scalp-london", agents: ["omega", "moderator"], charts: ["15"] },
  { item_id: "k-caution-macro-four-hour", agents: ["macro"], charts: ["240"] }
];
const packItem = (item_id, agents, charts = []) => ({ item_id, version: 1, kind: "role_reminder", label: "learned", audience: { agents, charts }, text: `Note ${item_id}: keep to your own data.`, content_sha256: "c".repeat(64), review: "auto" });
async function world({ answer = () => ({ outcome: "succeeded", result: { verdict_id: "kv" } }), whoami = null, posts = "on" } = {}) {
  reset();
  const calls = [];
  const kv = new Map();
  const items = [packItem(CHRONOS, ["chronos_matrix", "moderator"]), ...COLLECTING.map(([id, agent]) => packItem(id, [agent])), ...UNTESTABLE_ITEMS.map((u) => packItem(u.item_id, u.agents, u.charts)), packItem("k-new-untested-yet", ["risk"])];
  const env = {
    DB: d1(), SHADOW_KNOWLEDGE_ENABLED: "true", KNOWLEDGE_VERDICT_POSTS: posts,
    SIGNAL_CACHE: { async get(k) { return kv.get(k) ?? null; }, async put(k, v) { kv.set(k, v); } },
    AETHER: { learnedPack: async () => ({ version: "cryptophys.learned-pack.v1", sha256: "a".repeat(64), items }) },
    AGENTS: { syscall: async (agent, capability, input) => { calls.push({ agent, capability, input }); return answer(input, calls.length); }, ...(whoami ? { whoami } : {}) }
  };
  await pullLearnedPack(env, { now: NOW - 12 * DAY });
  const ins = env.DB.raw.prepare("INSERT INTO shadow_agent_outputs (subject, candle_key, agent, item_id, item_version, arm, statement_close, stance, control_stance, status, created_at, result, control_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const put = (rows) => rows.forEach((r) => ins.run(r.subject, r.candle_key, r.agent, r.item_id, r.item_version, r.arm, r.statement_close, r.stance, r.control_stance, r.status, r.created_at, r.result, r.control_result));
  put(rowsOf(CHRONOS_15, "chronos_matrix", CHRONOS, 404, same, { start: Date.parse("2026-11-12T19:15:00Z") }));
  for (const [id, agent, chart, n] of COLLECTING) put(rowsOf(`shadow-agent:${agent}@${id}v1${chart === "15" ? "@15" : ""}`, agent, id, n, same, { step: chart === "15" ? Q : H }));
  // KA1's settle already closed chronos (learned_live), with the real evidence.
  for (const sql of LEARNED_LIVE_SCHEMA_SQL) env.DB.raw.exec(sql);
  const c = chronosLive();
  env.DB.raw.prepare("INSERT INTO learned_live (item_id, version, status, item_json, verdict_json, promoted_at, retired_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(c.item_id, c.version, c.status, JSON.stringify(items[0]), c.verdict_json, c.promoted_at, c.retired_at, c.reason);
  kv.set("shadow-knowledge:settle:v1", JSON.stringify({ items: 11 }));
  const run = async (now, opts = {}) => {
    const closures = await runShadowClosures(env, { now });
    assert.equal(closures.status, "ok");
    return postKnowledgeVerdicts(env, { plan: closures.plan, now, ...opts });
  };
  return { env, calls, kv, run, put, markers: () => env.DB.raw.prepare("SELECT item_id, verdict, window_end, status, attempts FROM knowledge_verdict_posts ORDER BY item_id, verdict").all() };
}

test("KV-5. the first backlog: chronos not_better first, then the 10 collecting items, then not_tested once per untestable pack item", async () => {
  const w = await world();
  const out = await w.run(NOW, { limit: 20 });
  assert.equal(out.status, "ok");
  assert.deepEqual(w.calls.map((c) => [c.input.item_id, c.input.verdict]), [
    [CHRONOS, "not_better"],
    ...COLLECTING.map(([id]) => id).sort().map((id) => [id, "collecting"]),
    ["k-caution-macro-four-hour", "not_tested"], ["k-exec-plan-scalp-london", "not_tested"], ["k-moderator-london-reminder", "not_tested"]
  ]);
  assert.ok(w.calls.every((c) => c.agent === KNOWLEDGE_VERDICT_AGENT_ID && c.capability === KNOWLEDGE_VERDICT_CAPABILITY));
  for (const c of w.calls) assertSchema(c.input, `${c.input.item_id} ${c.input.verdict}`);
  // The chronos payload carries the real settle evidence and the window of its stored rows.
  assert.deepEqual(w.calls[0].input.evidence, { arm: "chronos_matrix", window_start: "2026-11-12T19:15:00.000Z", window_end: new Date(Date.parse("2026-11-12T19:15:00Z") + 403 * Q).toISOString(), rows: 404, scored: 404, treat_hits: 197, control_hits: 206, aa_changed: 17, aa_total: 388, p_value: signTestP(3, 9), p_holm: signTestP(3, 9), charts: ["15"], rule: "sign_holm.better" });
  const risk = w.calls.find((c) => c.input.item_id === "k-role-risk-calibration-talk").input;
  assert.deepEqual([risk.evidence.rows, risk.evidence.scored, risk.evidence.charts, risk.evidence.rule, "p_holm" in risk.evidence], [293, 293, ["15"], "min_sample.discovery", false]);
  assert.deepEqual(w.calls.at(-1).input, { item_id: "k-moderator-london-reminder", item_version: 1, verdict: "not_tested", reason: "Never tested here: the note is for the moderator only, and the shadow arm never calls the moderator.", evidence: { rule: "untestable.moderator_only" } });
  assert.equal(w.calls.some((c) => c.input.item_id === "k-new-untested-yet"), false, "a testable item that has no rows yet is not posted");
  assert.deepEqual([out.posted.length, out.not_found, out.invalid, out.stopped], [14, [], [], null]);
  assert.ok(w.markers().every((m) => m.status === "posted"));
  // The default cap: 12 calls a run, the rest in the next run.
  const w2 = await world();
  const first = await w2.run(NOW);
  assert.deepEqual([w2.calls.length, first.stopped], [KNOWLEDGE_VERDICT_RULES.per_run, "per_run"]);
  await w2.run(NOW + H);
  assert.equal(w2.calls.length, 14);
  // Nothing is written to a room, the bus or a decision.
  for (const t of ["agent_thread_messages", "engine_decisions", "outcome_scores"]) {
    if (w.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?").get(t).n) assert.equal(w.env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  }
});

test("KV-6. collecting at most once a UTC day per item; a final verdict once; a new window the next day posts again", async () => {
  const w = await world();
  await w.run(NOW, { limit: 20 });
  assert.equal(w.calls.length, 14);
  await w.run(NOW + H, { limit: 20 });
  await w.run(NOW + 5 * H, { limit: 20 });
  assert.equal(w.calls.length, 14, "same day: nothing again");
  // More rows for one item, the same day: still nothing until the next UTC day.
  w.put(rowsOf("shadow-agent:prophet@k-role-prophet-data-scopev1@15", "prophet", "k-role-prophet-data-scope", 5, same, { start: NOW - 2 * H, tag: "n" }));
  await w.run(NOW + 2 * H, { limit: 20 });
  assert.equal(w.calls.length, 14);
  await w.run(NOW + DAY, { limit: 20 });
  assert.deepEqual(w.calls.slice(14).map((c) => [c.input.item_id, c.input.verdict, c.input.evidence.scored]), [["k-role-prophet-data-scope", "collecting", 40]], "only the item whose window moved; chronos and not_tested never again");
  assert.equal(w.markers().filter((m) => m.item_id === "k-role-prophet-data-scope").length, 2);
});

test("KV-7. not yet registered: the run stops at the first refusal, nothing is marked, the next run tries again", async () => {
  let registered = false;
  const w = await world({ answer: () => (registered ? { outcome: "succeeded", result: {} } : { outcome: "denied", reason: "unknown_agent" }) });
  const out = await w.run(NOW, { limit: 20 });
  assert.deepEqual([out.status, out.stopped, w.calls.length, out.posted.length], ["not_registered", "not_registered", 1, 0]);
  assert.deepEqual(w.markers(), [], "the marker stays unposted");
  assert.equal(w.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM knowledge_verdict_strikes").get().n, 0);
  assert.equal(w.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM platform_backoff").get().n, 0, "no backoff: retried on the next run");
  await w.run(NOW + H, { limit: 20 });
  assert.equal(w.calls.length, 2, "one refused call a run, no more");
  registered = true;
  const later = await w.run(NOW + 2 * H, { limit: 20 });
  assert.deepEqual([later.status, later.posted.length, w.calls[2].input.item_id], ["ok", 14, CHRONOS], "registered: the backlog starts from the top");
});

test("KV-8. knowledge_proposal_not_found marks the item (never retried); three refusals an hour stop the run", async () => {
  const missing = new Set([CHRONOS]);
  const w = await world({ answer: (input) => (missing.has(input.item_id) ? { outcome: "failed", reason: "knowledge_proposal_not_found" } : { outcome: "succeeded", result: {} }) });
  const out = await w.run(NOW, { limit: 20 });
  assert.deepEqual([out.not_found, out.posted.length], [[`${CHRONOS}@1`], 13]);
  assert.equal(w.markers().find((m) => m.item_id === CHRONOS).status, "not_found");
  await w.run(NOW + DAY, { limit: 20 });
  assert.equal(w.calls.filter((c) => c.input.item_id === CHRONOS).length, 1, "never retried");
  // Every item missing: the local budget stops at 3 refusals in the hour (the kernel proposes a suspension at 5).
  const all = await world({ answer: () => ({ outcome: "failed", reason: "knowledge_proposal_not_found" }) });
  const stopped = await all.run(NOW, { limit: 20 });
  assert.deepEqual([all.calls.length, stopped.stopped, stopped.not_found.length], [3, "local_budget", 3]);
});

test("KV-9. a denial backs off and one whoami decides; a transport error is retried at most max_attempts times", async () => {
  let deny = true, status = "suspended";
  const w = await world({ answer: () => (deny ? { outcome: "denied", reason: "capability_not_granted" } : { outcome: "succeeded", result: {} }), whoami: async () => ({ status }) });
  const out = await w.run(NOW, { limit: 20 });
  assert.deepEqual([out.stopped, w.calls.length], ["denied", 1]);
  assert.equal((await w.run(NOW + 10 * 60_000, { limit: 20 })).status, "backoff");
  assert.equal((await w.run(NOW + H, { limit: 20 })).status, "backoff", "whoami: not enabled, wait again");
  assert.equal(w.calls.length, 1);
  deny = false; status = "enabled";
  const back = await w.run(NOW + 2 * H, { limit: 20 });
  assert.deepEqual([back.status, back.posted.length], ["ok", 14]);
  assert.equal(w.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM platform_backoff").get().n, 0, "cleared after a success");

  const t = await world({ answer: () => { throw new Error("network down"); } });
  for (let i = 0; i < KNOWLEDGE_VERDICT_RULES.max_attempts + 2; i++) await t.run(NOW + i * 2 * H, { limit: 20 });
  const chronos = t.markers().find((m) => m.item_id === CHRONOS);
  assert.deepEqual([chronos.status, chronos.attempts], ["failed", KNOWLEDGE_VERDICT_RULES.max_attempts]);
  assert.equal(t.calls.filter((c) => c.input.item_id === CHRONOS).length, KNOWLEDGE_VERDICT_RULES.max_attempts, "bounded");
  assert.equal(t.calls.at(-1).input.item_id, COLLECTING.map(([id]) => id).sort()[0], "then the next item");
});

test("KV-10. off: nothing is read, written or called; the closure result reads as before", async () => {
  const touched = [];
  const spy = {
    DB: { prepare(sql) { touched.push(sql); throw new Error("no D1 when off"); } },
    SIGNAL_CACHE: { async get(k) { touched.push(k); return null; }, async put(k) { touched.push(k); } },
    AGENTS: { syscall: async () => { touched.push("syscall"); return {}; }, whoami: async () => { touched.push("whoami"); return {}; } }
  };
  assert.equal(knowledgeVerdictPostsEnabled({ SHADOW_KNOWLEDGE_ENABLED: "true" }), false, "code default off");
  assert.equal(knowledgeVerdictPostsEnabled({ KNOWLEDGE_VERDICT_POSTS: "on" }), false, "needs the arm");
  assert.equal(knowledgeVerdictPostsEnabled({ SHADOW_KNOWLEDGE_ENABLED: "true", KNOWLEDGE_VERDICT_POSTS: "on" }), true);
  for (const env of [{ ...spy }, { ...spy, SHADOW_KNOWLEDGE_ENABLED: "true" }, { ...spy, SHADOW_KNOWLEDGE_ENABLED: "true", KNOWLEDGE_VERDICT_POSTS: "off" }, { ...spy, KNOWLEDGE_VERDICT_POSTS: "on" }]) {
    assert.deepEqual(await postKnowledgeVerdicts(env, { plan: { items: [] }, now: NOW }), { status: "disabled" });
  }
  assert.deepEqual(touched, []);
  // With the switch off and the arm on, the closures run as KA1 left them: the plan is not enumerable, so the log line
  // and the result are byte-identical, and no verdict table is made.
  const w = await world({ posts: "off" });
  const closures = await runShadowClosures(w.env, { now: NOW });
  assert.deepEqual(Object.keys(closures), ["status", "closed", "settle", "collecting", "message"]);
  assert.equal(JSON.stringify(closures).includes("plan"), false);
  assert.deepEqual(await postKnowledgeVerdicts(w.env, { plan: closures.plan, now: NOW }), { status: "disabled" });
  assert.deepEqual(w.calls, []);
  assert.equal(w.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'knowledge_verdict%'").get().n, 0);
  // Without the kernel binding (preview, local): unavailable, nothing written.
  const { AGENTS, ...noKernel } = w.env;
  assert.deepEqual(await postKnowledgeVerdicts({ ...noKernel, KNOWLEDGE_VERDICT_POSTS: "on" }, { plan: closures.plan, now: NOW }), { status: "unavailable" });
  assert.ok(AGENTS);
});

test("KV-11. wiring: the hourly sweep posts after runShadowClosures (no new cron); production sets the switch on, the code default is off", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const closures = src.indexOf("await runShadowClosures(env)"), posts = src.indexOf("await postKnowledgeVerdicts(env, { plan: closurePlan })");
  assert.ok(closures > 0 && posts > closures && posts - closures < 2000, "right after the closures, in the same hourly block");
  const cfg = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(cfg, /"KNOWLEDGE_VERDICT_POSTS": "on"/);
  assert.doesNotMatch(readFileSync(new URL("../wrangler.preview.jsonc", import.meta.url), "utf8"), /KNOWLEDGE_VERDICT_POSTS/);
  const mod = readFileSync(new URL("../src/knowledge-verdicts.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(mod, /sendTelegram|agent_thread_messages|engine_decisions|outcome_scores/, "no Telegram, room or decision");
});

test("KV-12. the marker store: a posted final verdict and a not_found item are skipped; collecting keys on window_end", () => {
  const e = (verdict, window_end = "") => ({ key: "k-a@1", item_id: "k-a", version: 1, verdict, window_end, payload: {} });
  const m = (verdict, status, window_end = "", posted_at = null) => ({ item_id: "k-a", item_version: 1, verdict, window_end, status, posted_at });
  const today = "2026-11-24T10:00:00.000Z";
  assert.equal(planVerdictPosts({ entries: [e("not_better")], markers: [m("not_better", "posted")], now: NOW }).length, 0);
  assert.equal(planVerdictPosts({ entries: [e("not_better")], markers: [m("not_better", "pending")], now: NOW }).length, 1, "pending is retried");
  assert.equal(planVerdictPosts({ entries: [e("not_better")], markers: [m("collecting", "posted", "w1", today)], now: NOW }).length, 1, "a verdict change posts");
  assert.equal(planVerdictPosts({ entries: [e("collecting", "w2")], markers: [m("collecting", "posted", "w1", today)], now: NOW }).length, 0, "once a UTC day");
  assert.equal(planVerdictPosts({ entries: [e("collecting", "w2")], markers: [m("collecting", "posted", "w1", "2026-11-23T23:05:00.000Z")], now: NOW }).length, 1);
  assert.equal(planVerdictPosts({ entries: [e("collecting", "w1")], markers: [m("collecting", "posted", "w1", "2026-11-23T23:05:00.000Z")], now: NOW }).length, 0, "same window");
  assert.equal(planVerdictPosts({ entries: [e("live")], markers: [m("collecting", "not_found", "w1")], now: NOW }).length, 0, "not_found: never again");
});

test("KV-13. evidence.arm follows the platform's rule (1-32 of [a-z0-9_.-], no run of 3+ digits); an agent outside it is left out, never refused", () => {
  const base = { item_id: "k-role-x", item_version: 1, verdict: "collecting", reason: "Still collecting readings in shadow.", evidence: { rule: "collecting" } };
  for (const arm of ["chronos_matrix", "trade_management", "r37_funnel", "aegis_footprint"]) assert.deepEqual(verdictPayloadProblems({ ...base, evidence: { ...base.evidence, arm } }), [], arm);
  for (const arm of ["a+b", "agent_r380", "x".repeat(33), "Upper"]) assert.ok(verdictPayloadProblems({ ...base, evidence: { ...base.evidence, arm } }).includes("evidence_arm_invalid"), arm);
  assert.equal(subjectEvidence({ agent: "agent_r380", rows: 3, scored: 3 }, "collecting").arm, undefined, "left out, not sent");
  assert.equal(subjectEvidence({ agent: "chronos_matrix", rows: 3, scored: 3 }, "collecting").arm, "chronos_matrix");
});
