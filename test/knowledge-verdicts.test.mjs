// KA2 (platform PF3, capability knowledge.verdict): the shadow arm's verdicts posted to the platform as the kernel
// agent shadow-knowledge, for Aether's curator (src/knowledge-verdicts.mjs). No network: the kernel is a stub.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  KNOWLEDGE_VERDICT_AGENT_ID, KNOWLEDGE_VERDICT_CAPABILITY, KNOWLEDGE_VERDICTS, KNOWLEDGE_VERDICT_EVIDENCE_KEYS, KNOWLEDGE_VERDICT_RULES, KNOWLEDGE_VERDICT_TIMEOUT_MS,
  knowledgeVerdictPostsEnabled, verdictPayloadProblems, subjectEvidence, untestableReason, verdictEntries, planVerdictPosts,
  postKnowledgeVerdicts, resetKnowledgeVerdictsForTests, KNOWLEDGE_VERDICT_SCHEMA_SQL, supersededBy
} from "../src/knowledge-verdicts.mjs";
import { planShadowClosures, runShadowClosures, resetShadowKnowledgeSchemaCacheForTests, CLOSURE_VERSION } from "../src/shadow-knowledge.mjs";
import { resetLearnedLiveForTests, LEARNED_LIVE_SCHEMA_SQL } from "../src/learned-live.mjs";
import { pullLearnedPack, resetAetherPackSchemaCacheForTests } from "../src/aether-pack.mjs";
import { resetPlatformBackoffForTests, kernelSyscall, PLATFORM_CALL_TIMEOUT_MS } from "../src/platform-reports.mjs";
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
  const items = [packItem(CHRONOS, ["chronos_matrix", "moderator"]), ...COLLECTING.map(([id, agent, chart]) => packItem(id, [agent], chart === "60" ? ["60"] : [])), ...UNTESTABLE_ITEMS.map((u) => packItem(u.item_id, u.agents, u.charts)), packItem("k-new-untested-yet", ["risk"])];
  const env = {
    DB: d1(), SHADOW_KNOWLEDGE_ENABLED: "true", KNOWLEDGE_VERDICT_POSTS: posts,
    SIGNAL_CACHE: { async get(k) { return kv.get(k) ?? null; }, async put(k, v) { kv.set(k, v); } },
    AETHER: { learnedPack: async () => ({ version: "cryptophys.learned-pack.v1", sha256: "a".repeat(64), items }) },
    AGENTS: { syscall: async (agent, capability, input) => { calls.push({ agent, capability, input }); return answer(input, calls.length); }, ...(whoami ? { whoami } : {}) }
  };
  // KA3: the untested item is new (first seen an hour ago), so its no rows are not an idle agent.
  const untested = items.pop();
  await pullLearnedPack(env, { now: NOW - 12 * DAY });
  items.push(untested);
  await pullLearnedPack({ ...env, AETHER: { learnedPack: async () => ({ version: "cryptophys.learned-pack.v1", sha256: "b".repeat(64), items }) } }, { now: NOW - H });
  const ins = env.DB.raw.prepare("INSERT INTO shadow_agent_outputs (subject, candle_key, agent, item_id, item_version, arm, statement_close, stance, control_stance, status, created_at, result, control_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const put = (rows) => rows.forEach((r) => ins.run(r.subject, r.candle_key, r.agent, r.item_id, r.item_version, r.arm, r.statement_close, r.stance, r.control_stance, r.status, r.created_at, r.result, r.control_result));
  put(rowsOf(CHRONOS_15, "chronos_matrix", CHRONOS, 404, same, { start: Date.parse("2026-11-12T19:15:00Z") }));
  // KA3: aegis's rows end where its queue-mates' do (fewer than 72 hours of later items tested after it): still collecting.
  for (const [id, agent, chart, n] of COLLECTING) put(rowsOf(`shadow-agent:${agent}@${id}v1${chart === "15" ? "@15" : ""}`, agent, id, n, same, { step: chart === "15" ? Q : H, ...(agent === "aegis_footprint" ? { start: Date.parse("2026-11-15T00:00:00Z") } : {}) }));
  // KA1's settle already closed chronos (learned_live), with the real evidence.
  for (const sql of LEARNED_LIVE_SCHEMA_SQL) env.DB.raw.exec(sql);
  const c = chronosLive();
  env.DB.raw.prepare("INSERT INTO learned_live (item_id, version, status, item_json, verdict_json, promoted_at, retired_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(c.item_id, c.version, c.status, JSON.stringify(items[0]), c.verdict_json, c.promoted_at, c.retired_at, c.reason);
  kv.set("shadow-knowledge:settle:v1", JSON.stringify({ items: 11 }));
  // mapPlan: the plan the sender is given (default: runShadowClosures' own), e.g. one an item has left.
  const run = async (now, { mapPlan = (p) => p, ...opts } = {}) => {
    const closures = await runShadowClosures(env, { now });
    assert.equal(closures.status, "ok");
    return postKnowledgeVerdicts(env, { plan: mapPlan(closures.plan), now, ...opts });
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

test("KV-9b. a timeout is unknown: pending, an attempt but no strike, the run stops; a later deduplicated reply marks it posted; other errors count too", async () => {
  // KA2 fix (2026-11-25): a timeout now counts an attempt (it used to count none, so a row that kept timing out was
  // retried without bound). Still no strike: the call may have landed.
  let mode = "slow";
  const w = await world({ answer: (input) => (mode === "slow" ? new Promise(() => {}) : mode === "error" ? { outcome: "failed", reason: "kernel_error" } : { outcome: "succeeded", result: { verdict_id: "kv", deduplicated: input.item_id === CHRONOS } }) });
  for (let i = 0; i < 2; i++) {
    const out = await w.run(NOW + i * 2 * H, { limit: 20, timeoutMs: 5 });
    assert.deepEqual([out.stopped, out.reason, out.failed, out.posted.length], ["transport", "timeout", 0, 0], "one call a run, then the run stops");
  }
  assert.equal(w.calls.length, 2);
  assert.ok(w.calls.every((c) => c.input.item_id === CHRONOS));
  assert.deepEqual(w.markers().map((m) => [m.item_id, m.status, m.attempts]), [[CHRONOS, "pending", 2]], "each timeout counts toward the cap");
  assert.equal(w.env.DB.raw.prepare("SELECT reason FROM knowledge_verdict_posts").get().reason, "timeout");
  assert.equal(w.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM knowledge_verdict_strikes").get().n, 0, "no strike: the call may have landed");
  // A non-timeout error counts too, with a strike.
  mode = "error";
  const failed = await w.run(NOW + 4 * H, { limit: 20, timeoutMs: 5 });
  assert.deepEqual([failed.stopped, failed.failed], ["failed", 1]);
  assert.deepEqual(w.markers().map((m) => [m.item_id, m.status, m.attempts]), [[CHRONOS, "pending", 3]]);
  // The platform kept the first call: the repeat answers deduplicated: true, which is posted.
  mode = "ok";
  const later = await w.run(NOW + 6 * H, { limit: 20, timeoutMs: 5 });
  assert.equal(later.posted[0], `${CHRONOS}@1:not_better`);
  const chronos = w.env.DB.raw.prepare("SELECT status, reason, attempts FROM knowledge_verdict_posts WHERE item_id = ?").get(CHRONOS);
  assert.deepEqual({ ...chronos }, { status: "posted", reason: "deduplicated", attempts: 4 });
});

test("KV-9d. timeouts are bounded: max_attempts timeouts make the row final failed (attempts_exhausted:timeout), never retried, no strike", async () => {
  const w = await world({ answer: () => new Promise(() => {}) });
  const outs = [];
  for (let i = 0; i < KNOWLEDGE_VERDICT_RULES.max_attempts + 2; i++) outs.push(await w.run(NOW + i * 2 * H, { limit: 20, timeoutMs: 5 }));
  const chronos = w.env.DB.raw.prepare("SELECT status, reason, attempts FROM knowledge_verdict_posts WHERE item_id = ?").get(CHRONOS);
  assert.deepEqual({ ...chronos }, { status: "failed", reason: "attempts_exhausted:timeout", attempts: KNOWLEDGE_VERDICT_RULES.max_attempts });
  assert.equal(w.calls.filter((c) => c.input.item_id === CHRONOS).length, KNOWLEDGE_VERDICT_RULES.max_attempts, "bounded");
  assert.deepEqual(outs[KNOWLEDGE_VERDICT_RULES.max_attempts - 1].exhausted, [`${CHRONOS}@1:not_better`]);
  assert.equal(w.calls.at(-1).input.item_id, COLLECTING.map(([id]) => id).sort()[0], "then the next item");
  assert.equal(w.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM knowledge_verdict_strikes").get().n, 0);
});

test("KV-9c. the 20 s timeout is knowledge.verdict's own; the other kernel calls keep PLATFORM_CALL_TIMEOUT_MS", async () => {
  assert.equal(KNOWLEDGE_VERDICT_TIMEOUT_MS, 20_000);
  assert.equal(PLATFORM_CALL_TIMEOUT_MS, 5000);
  const delays = [];
  const realSetTimeout = globalThis.setTimeout;
  const w = await world();
  globalThis.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, ms, ...rest); };
  try {
    await w.run(NOW, { limit: 1 });
    const verdictDelays = delays.splice(0);
    assert.deepEqual(verdictDelays.filter((ms) => ms === KNOWLEDGE_VERDICT_TIMEOUT_MS || ms === PLATFORM_CALL_TIMEOUT_MS), [KNOWLEDGE_VERDICT_TIMEOUT_MS], "the verdict call waits 20 s");
    await kernelSyscall({ AGENTS: { syscall: async () => ({ outcome: "succeeded" }) } }, "xauusd-reasoner", "reports.publish", {});
    assert.deepEqual(delays, [PLATFORM_CALL_TIMEOUT_MS], "kernelSyscall's default is unchanged");
  } finally { globalThis.setTimeout = realSetTimeout; }
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

// ------------------------------------------------------------------ KA2 fix (2026-11-25): pending rows the plan no longer makes
// Production D1 (read-only, 2026-11-25): one row stuck since 00:11:58Z, never touched again: k-caution-h1-60-new-york
// v1, collecting, window_end 00:00Z, pending, reason timeout, attempts 1. A collecting entry's row keys on window_end
// and each run makes a new window_end, so the old row was never among the current entries, and only those were tried.
const H1 = "k-caution-h1-60-new-york";
const H1_SUBJECT = `shadow-agent:h1@${H1}v1`;
const STUCK_END = "2026-11-25T00:00:00.000Z", STUCK_AT = "2026-11-25T00:11:58.000Z";
const iso = (t) => new Date(t).toISOString();
const at = (hhmm) => Date.parse(`2026-11-25T${hhmm}:00Z`);
const row = (w, item_id, verdict, window_end = "") => w.env.DB.raw.prepare("SELECT status, reason, attempts, payload_json, updated_at FROM knowledge_verdict_posts WHERE item_id = ? AND verdict = ? AND window_end = ?").get(item_id, verdict, window_end);
function insertRow(w, { item_id = H1, verdict = "collecting", window_end, status = "pending", reason = "timeout", attempts = 1, payload, updated_at, posted_at = null }) {
  w.env.DB.raw.prepare("INSERT INTO knowledge_verdict_posts (item_id, item_version, verdict, window_end, status, attempts, reason, payload_json, created_at, updated_at, posted_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(item_id, verdict, window_end, status, attempts, reason, typeof payload === "string" ? payload : JSON.stringify(payload), updated_at, updated_at, posted_at);
}
/** The plan once h1 has left it (production: after 00:11Z no other row for the h1 item was ever written). */
const withoutH1 = (p) => ({ ...p, items: p.items.filter((it) => it.item_id !== H1) });
const strikes = (w) => w.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM knowledge_verdict_strikes").get().n;
const h1Rows = (w) => w.env.DB.raw.prepare("SELECT window_end, status FROM knowledge_verdict_posts WHERE item_id = ? ORDER BY window_end").all(H1).map((r) => [r.window_end, r.status]);
/** The h1 collecting payload the sender posted, moved to another window_end (the payload of an older run). */
const h1PayloadAt = (w, window_end) => {
  const p = JSON.parse(w.env.DB.raw.prepare("SELECT payload_json FROM knowledge_verdict_posts WHERE item_id = ? AND verdict = 'collecting' AND status = 'posted'").get(H1).payload_json);
  return { ...p, evidence: { ...p.evidence, window_end } };
};
/** The h1 payload moved to another item that has left the pack and the plan (an orphan nothing can supersede). */
const gonePayloadAt = (w, window_end, item_id = "k-caution-gone-60-new-york") => ({ ...h1PayloadAt(w, window_end), item_id });
const callsFor = (w, item_id, window_end) => w.calls.filter((c) => c.input.item_id === item_id && (window_end === undefined || c.input.evidence?.window_end === window_end));

async function productionRow(reply) {
  const w = await world({ answer: (input, n) => (input.item_id === H1 && input.evidence?.window_end === STUCK_END ? reply(input, n) : { outcome: "succeeded", result: { verdict_id: "kv" } }) });
  await w.run(NOW, { limit: 20 });
  assert.equal(w.calls.length, 14, "the 24th: everything posted");
  // The h1 agent keeps opening: one row an hour up to 00:00Z, the window of the 00:11 run, whose post timed out.
  const hour = (t, tag) => w.put(rowsOf(H1_SUBJECT, "h1", H1, 1, same, { start: t, step: H, tag }));
  for (let t = Date.parse("2026-11-24T19:00:00Z"); t <= Date.parse(STUCK_END); t += H) hour(t, `p${t}`);
  insertRow(w, { window_end: STUCK_END, payload: h1PayloadAt(w, STUCK_END), updated_at: STUCK_AT });
  return { w, hour };
}

const H1_FIRST = iso(Date.parse("2026-11-13T00:00:00Z") + 15 * H); // the h1 window posted on the 24th (16 hourly rows)

test("KV-14. the production row (no newer row posted for the item): retried from payload_json after the gap, up to max_attempts, then final failed", async () => {
  const { w } = await productionRow(() => new Promise(() => {}));
  const stored = JSON.parse(row(w, H1, "collecting", STUCK_END).payload_json);
  // 00:40, inside the gap: the row is still the current entry (its window is the newest), so it waits like any pending row.
  assert.equal(verdictEntries({ plan: (await runShadowClosures(w.env, { now: at("00:40") })).plan }).find((e) => e.item_id === H1).window_end, STUCK_END);
  const early = await w.run(at("00:40"), { limit: 20, timeoutMs: 5 });
  assert.deepEqual([w.calls.length, early.due, early.orphans], [14, 0, 0], "not retried inside the gap");
  // 01:11: the plan no longer makes an h1 entry, and the only other h1 row is the 24th's, an older window (rule (4)).
  assert.deepEqual(h1Rows(w), [[H1_FIRST, "posted"], [STUCK_END, "pending"]]);
  const closures = await runShadowClosures(w.env, { now: at("01:11") });
  const entries = verdictEntries({ plan: withoutH1(closures.plan), live: [chronosLive()] });
  assert.equal(entries.some((e) => e.item_id === H1), false, "the stuck row is not among the current entries");
  const markers = w.env.DB.raw.prepare("SELECT * FROM knowledge_verdict_posts").all();
  const plan = planVerdictPosts({ entries, markers, now: at("01:11") });
  // The old code posted planVerdictPosts' current entries only: the stuck row was never among them.
  assert.equal(plan.filter((e) => !e.orphan).some((e) => e.item_id === H1), false, "before the fix: skipped for ever");
  assert.deepEqual(plan.filter((e) => e.orphan).map((e) => [e.item_id, e.verdict, e.window_end, e.superseded ?? null]), [[H1, "collecting", STUCK_END, null]], "now: retried, not superseded (only an older window was posted)");
  const first = await w.run(at("01:11"), { limit: 20, timeoutMs: 5, mapPlan: withoutH1 });
  assert.deepEqual([first.orphans, first.posted, first.superseded, first.stopped, first.reason], [1, [], [], "transport", "timeout"]);
  assert.deepEqual(callsFor(w, H1, STUCK_END).map((c) => c.input), [stored], "retried from its stored payload, byte for byte");
  assert.deepEqual([row(w, H1, "collecting", STUCK_END).status, row(w, H1, "collecting", STUCK_END).attempts], ["pending", 2]);
  // Every hour at :11 it times out again: 3, 4, then 5 = max_attempts, final failed; never tried after that.
  for (const [hh, attempts] of [["02", 3], ["03", 4], ["04", 5], ["05", 5], ["06", 5]]) {
    await w.run(at(`${hh}:11`), { limit: 20, timeoutMs: 5, mapPlan: withoutH1 });
    assert.equal(row(w, H1, "collecting", STUCK_END).attempts, attempts, hh);
  }
  const final = row(w, H1, "collecting", STUCK_END);
  assert.deepEqual([final.status, final.reason, final.attempts], ["failed", "attempts_exhausted:timeout", KNOWLEDGE_VERDICT_RULES.max_attempts]);
  assert.equal(callsFor(w, H1, STUCK_END).length, KNOWLEDGE_VERDICT_RULES.max_attempts - 1, "four retries after the first attempt");
  assert.equal(callsFor(w, H1).length, 1 + KNOWLEDGE_VERDICT_RULES.max_attempts - 1, "the 24th's post and the retries, nothing else for h1");
  assert.deepEqual(h1Rows(w), [[H1_FIRST, "posted"], [STUCK_END, "failed"]], "no other h1 row written");
  assert.equal(w.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM knowledge_verdict_posts WHERE status = 'pending'").get().n, 0, "nothing left pending");
  assert.equal(strikes(w), 0, "timeouts never strike");
});

test("KV-15. the production row, answered deduplicated: true on its first retry, is marked posted and never sent again", async () => {
  const { w } = await productionRow(() => ({ outcome: "succeeded", result: { verdict_id: "kv", deduplicated: true } }));
  const out = await w.run(at("01:11"), { limit: 20, mapPlan: withoutH1 });
  assert.deepEqual([out.orphans, out.posted, out.superseded, out.stopped], [1, [`${H1}@1:collecting`], [], null], "the stuck row, retried");
  const r = row(w, H1, "collecting", STUCK_END);
  assert.deepEqual([r.status, r.reason, r.attempts], ["posted", "deduplicated", 2]);
  for (const hh of ["02", "03"]) await w.run(at(`${hh}:11`), { limit: 20, mapPlan: withoutH1 });
  assert.equal(callsFor(w, H1, STUCK_END).length, 1);
});

// ------------------------------------------------------------------ superseded (orchestrator ruling on the KA2 fix)
// An orphan collecting row is closed `superseded`, without a call, once the same item@version has a posted collecting
// row with a later window_end (case a, in an earlier run or earlier in the same run) or a posted final verdict (case b).
test("KV-14a. case (a), a later window posted in an earlier run: the orphan is superseded:<that window_end>, no call, no attempt, no strike, never retried", async () => {
  const { w, hour } = await productionRow(() => new Promise(() => {}));
  // The code before this fix posted the 01:00Z window at 01:11 and passed the stuck row by.
  const NEWER = "2026-11-25T01:00:00.000Z";
  hour(at("01:00"), "p1");
  insertRow(w, { window_end: NEWER, status: "posted", reason: null, attempts: 1, payload: h1PayloadAt(w, NEWER), updated_at: iso(at("01:11")), posted_at: iso(at("01:11")) });
  const out = await w.run(at("02:11"), { limit: 20, timeoutMs: 5 });
  assert.deepEqual([out.orphans, out.posted, out.superseded, out.stopped], [1, [], [`${H1}@1:${STUCK_END}`], null]);
  assert.equal(callsFor(w, H1, STUCK_END).length, 0, "no call");
  const r = row(w, H1, "collecting", STUCK_END);
  assert.deepEqual([r.status, r.reason, r.attempts, r.updated_at], ["superseded", `superseded:${NEWER}`, 1, iso(at("02:11"))], "the attempts it had, no more");
  assert.equal(strikes(w), 0);
  // (6) Never retried, never touched again, on any later run.
  for (const hh of ["03", "04", "05", "06", "07", "08"]) await w.run(at(`${hh}:11`), { limit: 20, timeoutMs: 5 });
  assert.equal(callsFor(w, H1, STUCK_END).length, 0);
  const later = row(w, H1, "collecting", STUCK_END);
  assert.deepEqual([later.status, later.attempts, later.updated_at], ["superseded", 1, iso(at("02:11"))]);
  assert.equal(strikes(w), 0);
});

test("KV-14b. case (a), the newer window posted earlier in the same run: the orphan is superseded in that run; the platform never gets the older window after the newer one", async () => {
  const { w, hour } = await productionRow(() => new Promise(() => {}));
  const NEWER = "2026-11-25T01:00:00.000Z";
  hour(at("01:00"), "p1");
  // The plan alone cannot tell (the newer row is not yet posted): the orphan comes due, then the run supersedes it.
  const closures = await runShadowClosures(w.env, { now: at("01:11") });
  const plan = planVerdictPosts({ entries: verdictEntries({ plan: closures.plan, live: [chronosLive()] }), markers: w.env.DB.raw.prepare("SELECT * FROM knowledge_verdict_posts").all(), now: at("01:11") });
  assert.deepEqual(plan.filter((e) => e.item_id === H1).map((e) => [e.window_end, Boolean(e.orphan), e.superseded ?? null]), [[NEWER, false, null], [STUCK_END, true, null]]);
  const out = await w.run(at("01:11"), { limit: 20, timeoutMs: 5 });
  assert.deepEqual([out.orphans, out.posted, out.superseded, out.stopped], [1, [`${H1}@1:collecting`], [`${H1}@1:${STUCK_END}`], null], "the current entry posts, then the stuck row is closed");
  assert.deepEqual(callsFor(w, H1).slice(1).map((c) => c.input.evidence.window_end), [NEWER], "the newer window only: the stuck one is never sent");
  const r = row(w, H1, "collecting", STUCK_END);
  assert.deepEqual([r.status, r.reason, r.attempts], ["superseded", `superseded:${NEWER}`, 1]);
  assert.equal(strikes(w), 0);
  for (const hh of ["02", "03", "04", "05", "06"]) { hour(at(`${hh}:00`), `p${hh}`); await w.run(at(`${hh}:11`), { limit: 20, timeoutMs: 5 }); }
  assert.equal(callsFor(w, H1, STUCK_END).length, 0, "(6) never retried");
  assert.deepEqual([row(w, H1, "collecting", STUCK_END).status, row(w, H1, "collecting", STUCK_END).attempts], ["superseded", 1]);
});

test("KV-14c. case (b), a posted final verdict: the orphan is superseded:<verdict>, no call; a final-verdict orphan is never superseded", async () => {
  const { w } = await productionRow(() => new Promise(() => {}));
  const closed = { item_id: H1, item_version: 1, verdict: "not_better", reason: "Closed in shadow: the note did not make h1 better than its own answer on the hourly chart (Holm-adjusted sign test on the discovery bars).", evidence: { arm: "h1", charts: ["60"], rule: "sign_holm.better" } };
  insertRow(w, { verdict: "not_better", window_end: "", status: "posted", reason: null, payload: closed, updated_at: iso(at("01:11")), posted_at: iso(at("01:11")) });
  // Inside the orphan's own gap too: no call is made, so there is nothing to wait for.
  insertRow(w, { verdict: "collecting", window_end: "2026-11-25T00:30:00.000Z", payload: h1PayloadAt(w, "2026-11-25T00:30:00.000Z"), updated_at: iso(at("01:50")) });
  const out = await w.run(at("02:11"), { limit: 20, timeoutMs: 5, mapPlan: withoutH1 });
  assert.deepEqual([out.posted, [...out.superseded].sort(), out.stopped], [[], [`${H1}@1:${STUCK_END}`, `${H1}@1:2026-11-25T00:30:00.000Z`], null]);
  assert.equal(callsFor(w, H1).length, 1, "only the 24th's post");
  assert.deepEqual([row(w, H1, "collecting", STUCK_END).status, row(w, H1, "collecting", STUCK_END).reason], ["superseded", "superseded:not_better"]);
  assert.equal(row(w, H1, "collecting", "2026-11-25T00:30:00.000Z").reason, "superseded:not_better");
  assert.equal(strikes(w), 0);

  // (5) A pending final verdict (not_tested) whose item has a posted later collecting window and a posted final verdict
  // is still retried, and ends final failed like any other.
  const gone = { item_id: "k-gone-moderator-note", item_version: 1, verdict: "not_tested", reason: "Never tested here: the note is for the moderator only, and the shadow arm never calls the moderator.", evidence: { rule: "untestable.moderator_only" } };
  const o = await world({ answer: (input) => (input.item_id === gone.item_id ? new Promise(() => {}) : { outcome: "succeeded", result: {} }) });
  await o.run(NOW, { limit: 20 });
  insertRow(o, { item_id: gone.item_id, verdict: "collecting", window_end: "2026-11-24T23:00:00.000Z", status: "posted", reason: null, payload: { ...gone, verdict: "collecting" }, updated_at: iso(NOW - 2 * H), posted_at: iso(NOW - 2 * H) });
  insertRow(o, { item_id: gone.item_id, verdict: "live", window_end: "", status: "posted", reason: null, payload: { ...gone, verdict: "live" }, updated_at: iso(NOW - 2 * H), posted_at: iso(NOW - 2 * H) });
  insertRow(o, { item_id: gone.item_id, verdict: "not_tested", window_end: "", attempts: 0, payload: gone, updated_at: iso(NOW - H) });
  for (let i = 1; i <= KNOWLEDGE_VERDICT_RULES.max_attempts + 2; i++) {
    const r = await o.run(NOW + i * H, { limit: 20, timeoutMs: 5 });
    assert.deepEqual(r.superseded, [], `run ${i}`);
  }
  assert.deepEqual(callsFor(o, gone.item_id).map((c) => c.input), Array(KNOWLEDGE_VERDICT_RULES.max_attempts).fill(gone));
  const r = row(o, gone.item_id, "not_tested");
  assert.deepEqual([r.status, r.reason], ["failed", "attempts_exhausted:timeout"]);
});

test("KV-16. a timed-out final verdict: still current, it waits the gap and then posts; no longer current, it is retried from payload_json and ends final", async () => {
  // Current: the four-hour not_tested times out; inside the gap the run passes it by; after the gap it posts.
  let slow = true;
  const w = await world({ answer: (input) => (slow && input.item_id === "k-caution-macro-four-hour" ? new Promise(() => {}) : { outcome: "succeeded", result: {} }) });
  const first = await w.run(NOW, { limit: 20, timeoutMs: 5 });
  assert.deepEqual([first.posted.length, first.stopped, first.reason], [11, "transport", "timeout"]);
  assert.deepEqual([row(w, "k-caution-macro-four-hour", "not_tested").status, row(w, "k-caution-macro-four-hour", "not_tested").attempts], ["pending", 1]);
  const inside = await w.run(NOW + 30 * 60_000, { limit: 20, timeoutMs: 5 });
  assert.deepEqual(inside.posted, ["k-exec-plan-scalp-london@1:not_tested", "k-moderator-london-reminder@1:not_tested"], "inside the gap: the others, not it");
  assert.equal(callsFor(w, "k-caution-macro-four-hour").length, 1);
  slow = false;
  const after = await w.run(NOW + H, { limit: 20, timeoutMs: 5 });
  assert.deepEqual(after.posted, ["k-caution-macro-four-hour@1:not_tested"]);
  assert.deepEqual([row(w, "k-caution-macro-four-hour", "not_tested").status, row(w, "k-caution-macro-four-hour", "not_tested").attempts], ["posted", 2]);

  // No longer current (the item left the pack): a pending not_tested row (window_end "") is retried on its own and
  // ends failed after max_attempts timeouts.
  const gone = { item_id: "k-gone-moderator-note", item_version: 1, verdict: "not_tested", reason: "Never tested here: the note is for the moderator only, and the shadow arm never calls the moderator.", evidence: { rule: "untestable.moderator_only" } };
  const o = await world({ answer: (input) => (input.item_id === gone.item_id ? new Promise(() => {}) : { outcome: "succeeded", result: {} }) });
  await o.run(NOW, { limit: 20 });
  insertRow(o, { item_id: gone.item_id, verdict: "not_tested", window_end: "", attempts: 0, payload: gone, updated_at: iso(NOW - H) });
  for (let i = 1; i <= KNOWLEDGE_VERDICT_RULES.max_attempts + 2; i++) await o.run(NOW + i * H, { limit: 20, timeoutMs: 5 });
  assert.deepEqual(callsFor(o, gone.item_id).map((c) => c.input), Array(KNOWLEDGE_VERDICT_RULES.max_attempts).fill(gone));
  const r = row(o, gone.item_id, "not_tested");
  assert.deepEqual([r.status, r.reason, r.attempts], ["failed", "attempts_exhausted:timeout", KNOWLEDGE_VERDICT_RULES.max_attempts]);
  // A kernel failure on the last attempt keeps its own reason.
  const f = await world({ answer: (input) => (input.item_id === gone.item_id ? { outcome: "failed", reason: "kernel_error" } : { outcome: "succeeded", result: {} }) });
  await f.run(NOW, { limit: 20 });
  insertRow(f, { item_id: gone.item_id, verdict: "not_tested", window_end: "", attempts: KNOWLEDGE_VERDICT_RULES.max_attempts - 1, payload: gone, updated_at: iso(NOW - H) });
  const last = await f.run(NOW + H, { limit: 20 });
  assert.deepEqual([last.failed, last.exhausted, row(f, gone.item_id, "not_tested").status, row(f, gone.item_id, "not_tested").reason], [1, [`${gone.item_id}@1:not_tested`], "failed", "attempts_exhausted:kernel_error"]);
});

test("KV-17. an orphan row goes through the same gates: per_run, strikes, not_found, not_registered, the denial, the payload check, the cap, the switch", async () => {
  // The orphan is a collecting row of an item the plan no longer makes and that has no other row, so it is never
  // superseded (KV-14a to KV-14c) and each gate is the one that decides.
  const GONE = "k-caution-gone-60-new-york";
  const STALE = "2026-11-13T10:00:00.000Z";
  const orphanWorld = async (answer, { post = true } = {}) => {
    const w = await world({ answer: (input, n) => (input.item_id === GONE && input.evidence?.window_end === STALE ? answer(input, n) : { outcome: "succeeded", result: {} }) });
    if (post) await w.run(NOW, { limit: 20 });
    return w;
  };
  const ok = () => ({ outcome: "succeeded", result: {} });
  // per_run: the current entries first; the orphan waits for the next run.
  const p = await orphanWorld(ok, { post: false });
  p.env.DB.raw.exec(KNOWLEDGE_VERDICT_SCHEMA_SQL.join(";"));
  insertRow(p, { item_id: GONE, window_end: STALE, payload: { item_id: GONE, item_version: 1, verdict: "collecting", reason: "Still collecting in shadow: h1 on the hourly chart has fewer scored bars than the sample a verdict needs.", evidence: { window_start: "2026-11-13T00:00:00.000Z", window_end: STALE, rows: 11, scored: 11, charts: ["60"], rule: "min_sample.discovery" } }, updated_at: iso(NOW - 2 * H) });
  const capped = await p.run(NOW, { limit: 14 });
  assert.deepEqual([capped.due, capped.orphans, capped.stopped, p.calls.length, callsFor(p, GONE, STALE).length], [15, 1, "per_run", 14, 0]);
  const next = await p.run(NOW + H, { limit: 14 });
  assert.deepEqual([next.posted, next.superseded, row(p, GONE, "collecting", STALE).status], [[`${GONE}@1:collecting`], [], "posted"]);

  // The rest start from a posted world and an orphan two hours old.
  const withOrphan = async (answer, extra = {}) => {
    const w = await orphanWorld(answer);
    insertRow(w, { item_id: GONE, window_end: STALE, payload: gonePayloadAt(w, STALE), updated_at: iso(NOW - 2 * H), ...extra });
    return w;
  };
  const untouched = (w, attempts = 1) => {
    const r = row(w, GONE, "collecting", STALE);
    assert.deepEqual([r.status, r.attempts, r.updated_at], ["pending", attempts, iso(NOW - 2 * H)]);
  };
  // Strikes: three refusals in the hour stop the run before the orphan.
  const s = await withOrphan(ok);
  for (const t of [NOW + H - 30 * 60_000, NOW + H - 20 * 60_000, NOW + H - 10 * 60_000]) s.env.DB.raw.prepare("INSERT INTO knowledge_verdict_strikes (at_ms) VALUES (?)").run(t);
  assert.equal((await s.run(NOW + H, { limit: 20 })).stopped, "local_budget");
  assert.equal(callsFor(s, GONE, STALE).length, 0);
  untouched(s);
  // An item marked not_found: its orphan is never sent.
  const nf = await withOrphan(ok);
  insertRow(nf, { item_id: GONE, verdict: "live", window_end: "", status: "not_found", reason: "knowledge_proposal_not_found", payload: {}, updated_at: iso(NOW - H) });
  assert.equal((await nf.run(NOW + H, { limit: 20 })).due, 0);
  assert.equal(callsFor(nf, GONE, STALE).length, 0);
  // The orphan answered not_found: marked, a strike, never again.
  const nf2 = await withOrphan(() => ({ outcome: "failed", reason: "knowledge_proposal_not_found" }));
  assert.deepEqual((await nf2.run(NOW + H, { limit: 20 })).not_found, [`${GONE}@1`]);
  assert.equal(row(nf2, GONE, "collecting", STALE).status, "not_found");
  assert.equal(nf2.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM knowledge_verdict_strikes").get().n, 1);
  await nf2.run(NOW + 3 * H, { limit: 20 });
  assert.equal(callsFor(nf2, GONE, STALE).length, 1);
  // Not registered: nothing is marked, the row keeps its attempts and its updated_at.
  const nr = await withOrphan(() => ({ outcome: "denied", reason: "unknown_agent" }));
  assert.deepEqual([(await nr.run(NOW + H, { limit: 20 })).status, callsFor(nr, GONE, STALE).length], ["not_registered", 1]);
  untouched(nr);
  // A denial backs the agent off: the next run inside the backoff calls nothing.
  const dn = await withOrphan(() => ({ outcome: "denied", reason: "capability_not_granted" }));
  assert.equal((await dn.run(NOW + H, { limit: 20 })).stopped, "denied");
  assert.equal((await dn.run(NOW + H + 20 * 60_000, { limit: 20 })).status, "backoff");
  assert.equal(callsFor(dn, GONE, STALE).length, 1);
  untouched(dn);
  // The payload check: an unreadable payload_json, or one that is not the row's own, is marked invalid without a call.
  const bad = await withOrphan(ok, { payload: "{not json" });
  insertRow(bad, { item_id: GONE, verdict: "collecting", window_end: "2026-11-13T11:00:00.000Z", payload: { ...gonePayloadAt(bad, "2026-11-13T11:00:00.000Z"), item_id: "k-other-item" }, updated_at: iso(NOW - 2 * H) });
  const checked = await bad.run(NOW + H, { limit: 20 });
  assert.deepEqual([checked.invalid, checked.superseded], [[`${GONE}@1:collecting`, `${GONE}@1:collecting`], []]);
  assert.deepEqual([row(bad, GONE, "collecting", STALE).reason, row(bad, GONE, "collecting", STALE).payload_json], ["not_an_object", "{not json"], "the stored payload is kept as it was");
  assert.equal(row(bad, GONE, "collecting", "2026-11-13T11:00:00.000Z").reason, "payload_not_the_row");
  assert.equal(callsFor(bad, GONE).length, 0, "no call for either");
  // A pending row already at the cap (left by the code before this fix) is final now, without a call.
  const cap = await withOrphan(ok, { attempts: KNOWLEDGE_VERDICT_RULES.max_attempts });
  const capOut = await cap.run(NOW + H, { limit: 20 });
  assert.deepEqual([capOut.exhausted, callsFor(cap, GONE, STALE).length, row(cap, GONE, "collecting", STALE).reason], [[`${GONE}@1:collecting`], 0, "attempts_exhausted:timeout"]);
  // Switch off: nothing read, written or called, the pending row as it was.
  const off = await world({ posts: "off" });
  off.env.DB.raw.exec(KNOWLEDGE_VERDICT_SCHEMA_SQL.join(";"));
  insertRow(off, { item_id: GONE, window_end: STALE, payload: { item_id: GONE }, updated_at: iso(NOW - 2 * H) });
  const closures = await runShadowClosures(off.env, { now: NOW + H });
  assert.deepEqual(await postKnowledgeVerdicts(off.env, { plan: closures.plan, now: NOW + H }), { status: "disabled" });
  assert.deepEqual(off.calls, []);
  untouched(off);
});

test("KV-18. the plan: a pending row waits retry_gap_ms on its own updated_at; orphans come after the current entries, oldest first", () => {
  assert.equal(KNOWLEDGE_VERDICT_RULES.retry_gap_ms, 50 * 60_000);
  const e = (item_id, verdict, window_end = "") => ({ key: `${item_id}@1`, item_id, version: 1, verdict, window_end, payload: {} });
  const m = (item_id, verdict, window_end, status, updated_at, created_at = updated_at) => ({ item_id, item_version: 1, verdict, window_end, status, attempts: 1, payload_json: JSON.stringify({ item_id }), created_at, updated_at });
  const now = Date.parse("2026-11-25T01:11:00Z");
  const fresh = "2026-11-25T00:30:00.000Z", old = "2026-11-25T00:11:58.000Z";
  assert.equal(planVerdictPosts({ entries: [e("k-a", "not_better")], markers: [m("k-a", "not_better", "", "pending", fresh)], now }).length, 0, "41 minutes: waits");
  assert.equal(planVerdictPosts({ entries: [e("k-a", "not_better")], markers: [m("k-a", "not_better", "", "pending", old)], now }).length, 1, "59 minutes: due");
  const plan = planVerdictPosts({
    entries: [e("k-z", "not_tested"), e("k-c", "collecting", "w9")],
    markers: [
      m("k-b", "collecting", "w1", "pending", old, "2026-11-24T20:00:00.000Z"), m("k-a", "collecting", "w1", "pending", old, "2026-11-24T23:00:00.000Z"),
      m("k-d", "collecting", "w1", "pending", fresh), m("k-e", "worse", "", "failed", old), m("k-c", "collecting", "w1", "posted", old)
    ],
    now
  });
  assert.deepEqual(plan.map((x) => [x.item_id, x.window_end, Boolean(x.orphan)]), [["k-z", "", false], ["k-c", "w9", false], ["k-b", "w1", true], ["k-a", "w1", true]], "current first, then the oldest orphans; a fresh or a final row waits");
  assert.deepEqual(plan[2].payload, { item_id: "k-b" });
});

test("KV-19. supersededBy and the plan: a later posted window or a posted final verdict supersedes a collecting orphan, at once; nothing else does", () => {
  const m = (verdict, window_end, status, updated_at = "2026-11-25T00:11:58.000Z") => ({ item_id: "k-a", item_version: 1, verdict, window_end, status, attempts: 1, payload_json: "{}", created_at: updated_at, updated_at });
  const orphan = m("collecting", "2026-11-25T00:00:00.000Z", "pending");
  assert.equal(supersededBy(orphan, [orphan]), null, "nothing else: retried");
  assert.equal(supersededBy(orphan, [orphan, m("collecting", "2026-11-24T23:00:00.000Z", "posted")]), null, "(4) only an older window posted: retried");
  assert.equal(supersededBy(orphan, [orphan, m("collecting", "2026-11-25T02:00:00.000Z", "pending"), m("collecting", "2026-11-25T03:00:00.000Z", "failed")]), null, "a later window not posted does not count");
  assert.equal(supersededBy(orphan, [orphan, m("collecting", "2026-11-25T01:00:00.000Z", "posted"), m("collecting", "2026-11-25T02:00:00.000Z", "posted")]), "superseded:2026-11-25T02:00:00.000Z", "(a) the newest later window");
  assert.equal(supersededBy(orphan, [orphan, m("not_tested", "", "posted")]), "superseded:not_tested", "(b)");
  assert.equal(supersededBy(orphan, [orphan, m("not_better", "", "pending")]), null, "a final verdict not posted does not count");
  // (5) A final-verdict orphan is never superseded.
  const finalOrphan = m("not_tested", "", "pending");
  assert.equal(supersededBy(finalOrphan, [finalOrphan, m("collecting", "2026-11-25T09:00:00.000Z", "posted"), m("live", "", "posted")]), null);
  // The plan: inside its gap, a superseded orphan is still closed now (no call); a plain one waits; a final one waits.
  const now = Date.parse("2026-11-25T01:11:00Z"), fresh = "2026-11-25T00:50:00.000Z";
  const plan = planVerdictPosts({ entries: [], markers: [m("collecting", "2026-11-25T00:00:00.000Z", "pending", fresh), m("collecting", "2026-11-25T01:00:00.000Z", "posted", fresh), { ...m("collecting", "w0", "pending", fresh), item_id: "k-b" }, { ...m("worse", "", "pending", fresh), item_id: "k-b" }], now });
  assert.deepEqual(plan.map((x) => [x.item_id, x.window_end, x.superseded]), [["k-a", "2026-11-25T00:00:00.000Z", "superseded:2026-11-25T01:00:00.000Z"]]);
  // (6) A superseded row is done: never an orphan again, and a current entry with its window is not posted.
  const done = m("collecting", "2026-11-25T00:00:00.000Z", "superseded");
  assert.deepEqual(planVerdictPosts({ entries: [], markers: [done], now }), []);
  assert.deepEqual(planVerdictPosts({ entries: [{ key: "k-a@1", item_id: "k-a", version: 1, verdict: "collecting", window_end: "2026-11-25T00:00:00.000Z", payload: {} }], markers: [done], now }), []);
});
