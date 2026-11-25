// KA3: an item whose agent no longer opens in its room closes as not_tested (src/shadow-knowledge.mjs
// planIdleClosures), and KA2 posts it with rule untestable.agent_inactive. No network: the kernel is a stub.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { planIdleClosures, planShadowClosures, runShadowClosures, closureMessage, shadowItems, IDLE_RULES, CLOSURE_VERSION, resetShadowKnowledgeSchemaCacheForTests } from "../src/shadow-knowledge.mjs";
import { resetLearnedLiveForTests, promotedKeys, readLearnedLive, LEARNED_LIVE_SCHEMA_SQL } from "../src/learned-live.mjs";
import { verdictPayloadProblems, verdictEntries, postKnowledgeVerdicts, resetKnowledgeVerdictsForTests, idleEvidence } from "../src/knowledge-verdicts.mjs";
import { pullLearnedPack, resetAetherPackSchemaCacheForTests } from "../src/aether-pack.mjs";
import { resetPlatformBackoffForTests } from "../src/platform-reports.mjs";

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
const T0 = Date.parse("2026-11-16T00:00:00Z");
const iso = (t) => new Date(t).toISOString();

// The production shape (KA3 study): supertrend's 1H note stopped when the neuron allocation benched supertrend in the 1H
// room; h1's note, first seen later (it ranks after), kept being tested on the same bars.
const ST = "k-caution-supertrend-60-new-york", H1 = "k-caution-h1-60-new-york", EARLY = "k-caution-early-60", ROLE = "k-role-chronos-matrix-data-scope";
const caution = (item_id, agents, charts = ["60"]) => ({ item_id, version: 1, kind: "caution", label: "learned", audience: { agents, charts }, text: `Note ${item_id}: keep to your own data.`, content_sha256: "c".repeat(64), review: "auto" });
const subj = (agent, id, chart = "60") => `shadow-agent:${agent}@${id}v1${chart === "15" ? "@15" : ""}`;
/** n rows of one subject, every `step` from `start`, scored (hit) unless `scored` is false. */
function rows(agent, id, n, { start = T0, step = H, chart = "60", scored = true, tag = "" } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const t = iso(start + i * step);
    return { subject: subj(agent, id, chart), candle_key: `${tag}${id}:${i}`, agent, item_id: id, item_version: 1, arm: "note", statement_close: t, created_at: t, stance: "WAIT", control_stance: "WAIT", status: "ok", result: scored ? "hit" : null, control_result: scored ? "hit" : null };
  });
}
const seenAt = { [`${EARLY}@1`]: iso(T0 - 2 * DAY), [`${ST}@1`]: iso(T0 - DAY), [`${H1}@1`]: iso(T0 - DAY + 60_000), [`${ROLE}@1`]: iso(T0 - DAY + 120_000) };
const PACK = [caution(ST, ["supertrend", "moderator"]), caution(H1, ["h1", "moderator"]), caution(EARLY, ["news", "moderator"]), { ...caution(ROLE, ["chronos_matrix", "moderator"], []), kind: "role_reminder" }];
// The pack without the early note (it would close too when it has no rows); the earlier-ranked case adds it.
const MAIN = PACK.filter((it) => it.item_id !== EARLY);
const idle = (outputs, now, extra = {}) => planIdleClosures(outputs, { now, packItems: MAIN, firstSeen: seenAt, plan: planShadowClosures(outputs, { now, packItems: PACK }), ...extra });

test("KA3-1. idle 72 hours of the arm running: closes as not_tested with the rows and scored pairs it had", () => {
  // supertrend: 18 rows, then benched; h1 (ranks after) is tested on every 1H bar for 100 more hours.
  const out = [...rows("supertrend", ST, 18), ...rows("h1", H1, 118)];
  const now = T0 + 118 * H;
  const closed = idle(out, now);
  assert.deepEqual(closed.map((c) => [c.key, c.outcome, c.reason]), [[`${ST}@1`, "retired", "not_tested"]], "h1 itself is busy; only supertrend closes");
  const e = closed[0].evidence;
  assert.equal(e.schema, CLOSURE_VERSION);
  assert.deepEqual([e.rule, e.rows, e.scored, e.window_start, e.window_end, e.idle.last_row, e.idle.active_hours, e.idle.required_hours, e.idle.agents, e.idle.charts],
    [IDLE_RULES.rule, 18, 18, iso(T0), iso(T0 + 17 * H), iso(T0 + 17 * H), 100, 72, ["supertrend"], ["60"]]);
  assert.deepEqual(e.subjects.map((s) => [s.subject, s.outcome, s.rows, s.scored]), [[subj("supertrend", ST), "not_tested", 18, 18]]);
  // 71 hours: not yet. Exactly 72: closes.
  assert.equal(idle([...rows("supertrend", ST, 18), ...rows("h1", H1, 18 + 71)], T0 + 200 * H).length, 0);
  assert.equal(idle([...rows("supertrend", ST, 18), ...rows("h1", H1, 18 + 72)], T0 + 200 * H).length, 1);
  // Rows after `now` never count.
  assert.equal(idle([...rows("supertrend", ST, 18), ...rows("h1", H1, 18 + 72)], T0 + 80 * H).length, 0);
  // A never-tested item for an agent that never opens closes too, from when the pack first carried it (no rows, no window).
  const never = idle(rows("h1", H1, 120), T0 + 120 * H);
  assert.deepEqual(never.map((c) => [c.key, c.evidence.rows, c.evidence.scored, c.evidence.window_start, c.evidence.idle.since]), [[`${ST}@1`, 0, 0, null, iso(T0 - DAY)]]);
  // No price anywhere in the evidence: counts and ids only.
  assert.doesNotMatch(JSON.stringify(e), /price|entry|stop|target|level/i);
  assert.match(closureMessage(closed), /closed: k-caution-supertrend-60-new-york v1: not tested \(supertrend no longer opens in its room: no shadow call for 100 hours of the arm running; 18 rows, 18 scored\)/);
});

test("KA3-2. idle only while the arm was off or the market closed: never closes; a queue-mate ranked earlier proves nothing", () => {
  // 30 hours tested beside h1, then five days with no row at all (arm off, a weekend), then 30 more hours: 60 < 72.
  const back = T0 + 48 * H + 5 * DAY;
  const out = [...rows("supertrend", ST, 18), ...rows("h1", H1, 48), ...rows("h1", H1, 30, { start: back, tag: "b" })];
  assert.equal(idle(out, back + 30 * H).length, 0, "wall clock past 72h, but only 60 hours of the arm running");
  assert.equal(idle([...out, ...rows("h1", H1, 12, { start: back + 30 * H, tag: "c" })], back + 50 * H).length, 1, "12 more running hours: 72");
  // Only an earlier-ranked item kept being tested (it may have taken the last slot or the budget): no hour counts.
  assert.equal(idle([...rows("supertrend", ST, 18), ...rows("news", EARLY, 200)], T0 + 200 * H, { packItems: PACK }).length, 0);
  // A later item on another chart proves nothing for a 1H-only note; nor does the council for the War Room.
  assert.equal(idle([...rows("supertrend", ST, 18), ...rows("chronos_matrix", ROLE, 400, { chart: "15", step: Q })], T0 + 200 * H).length, 0);
  const warRoom = { ...caution("k-role-zz-room", ["risk"], ["15"]), kind: "role_reminder" }, council = caution("k-caution-zzz-council", ["council"], ["15"]);
  const seen = { ...seenAt, "k-role-zz-room@1": iso(T0 - DAY), "k-caution-zzz-council@1": iso(T0) };
  const cRows = rows("council", "k-caution-zzz-council", 200, { chart: "15", step: Q });
  assert.equal(planIdleClosures(cRows, { now: T0 + 60 * H, packItems: [warRoom, council], firstSeen: seen }).length, 0, "council rows are not War Room bars");
  // A final verdict pending (300 rows answered, not yet scored) is left to KA1.
  const pending = [...rows("supertrend", ST, 300, { step: Q, scored: false }), ...rows("h1", H1, 200, { start: T0 + 80 * H })];
  assert.equal(idle(pending, T0 + 300 * H).length, 0);
});

test("KA3-3. a live or retired item, and an item KA2 posts as untestable, is never touched", async () => {
  const out = [...rows("supertrend", ST, 18), ...rows("h1", H1, 118)];
  for (const status of ["live", "retired"]) assert.equal(idle(out, T0 + 118 * H, { done: new Set([`${ST}@1`]) }).length, 0, status);
  const omega = caution("k-exec-scalp", ["omega", "moderator"], ["15"]), modOnly = caution("k-mod-only", ["moderator"]), fourHour = caution("k-four-hour", ["macro"], ["240"]);
  const seen = { "k-exec-scalp@1": iso(T0 - DAY), "k-mod-only@1": iso(T0 - DAY), "k-four-hour@1": iso(T0 - DAY), [`${H1}@1`]: iso(T0) };
  assert.equal(planIdleClosures(rows("h1", H1, 200), { now: T0 + 200 * H, packItems: [omega, modOnly, fourHour, caution(H1, ["h1"])], firstSeen: seen }).length, 0);
  // On D1: a live row and a retired row stay exactly as they were.
  for (const status of ["live", "retired"]) {
    const w = await world();
    w.env.DB.raw.prepare("INSERT INTO learned_live (item_id, version, status, item_json, verdict_json, promoted_at, retired_at, reason) VALUES (?, 1, ?, ?, '[]', ?, ?, ?)")
      .run(ST, status, JSON.stringify(PACK[0]), iso(T0), status === "retired" ? iso(T0 + H) : null, status === "retired" ? "no longer in Aether's pack" : null);
    const before = JSON.stringify(w.env.DB.raw.prepare("SELECT * FROM learned_live").all());
    const r = await runShadowClosures(w.env, { now: T0 + 118 * H });
    assert.deepEqual(r.closed, [], status);
    assert.equal(JSON.stringify(w.env.DB.raw.prepare("SELECT * FROM learned_live").all()), before, status);
  }
});

async function world() {
  reset();
  const kv = new Map(), calls = [];
  const env = {
    DB: d1(), SHADOW_KNOWLEDGE_ENABLED: "true", KNOWLEDGE_VERDICT_POSTS: "on",
    SIGNAL_CACHE: { async get(k) { return kv.get(k) ?? null; }, async put(k, v) { kv.set(k, v); } },
    AETHER: { learnedPack: async () => ({ version: "cryptophys.learned-pack.v1", sha256: "a".repeat(64), items: PACK }) },
    AGENTS: { syscall: async (agent, capability, input) => { calls.push({ agent, capability, input }); return { outcome: "succeeded", result: {} }; } }
  };
  // First seen in the study's order: the early note, supertrend's, then h1's and the role note (they rank after).
  const pull = (items, sha, now) => pullLearnedPack({ ...env, AETHER: { learnedPack: async () => ({ version: "cryptophys.learned-pack.v1", sha256: sha.repeat(64), items }) } }, { now });
  await pull([PACK[2]], "d", T0 - 2 * DAY);
  await pull([PACK[0], PACK[2]], "e", T0 - DAY);
  await pull(PACK, "a", T0 - DAY + 60_000);
  for (const sql of LEARNED_LIVE_SCHEMA_SQL) env.DB.raw.exec(sql);
  kv.set("shadow-knowledge:settle:v1", JSON.stringify({ items: 0 }));
  const ins = env.DB.raw.prepare("INSERT INTO shadow_agent_outputs (subject, candle_key, agent, item_id, item_version, arm, statement_close, stance, control_stance, status, created_at, result, control_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const r of [...rows("supertrend", ST, 18), ...rows("h1", H1, 118), ...rows("news", EARLY, 118)]) ins.run(r.subject, r.candle_key, r.agent, r.item_id, r.item_version, r.arm, r.statement_close, r.stance, r.control_stance, r.status, r.created_at, r.result, r.control_result);
  const dump = () => JSON.stringify(env.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(({ name }) => [name, env.DB.raw.prepare(`SELECT * FROM "${name}"`).all()]));
  return { env, kv, calls, dump };
}

test("KA3-4. end to end: learned_live retired shadow:not_tested through closeShadowItems; the slot frees; KA2 posts not_tested inside the schema", async () => {
  const w = await world();
  const now = T0 + 118 * H + 5 * 60_000;
  assert.ok((await shadowItems(w.env)).some((i) => i.item_id === ST));
  const r = await runShadowClosures(w.env, { now });
  assert.deepEqual([r.status, r.closed, Object.keys(r)], ["ok", [`${ST}@1`], ["status", "closed", "settle", "collecting", "message"]]);
  assert.equal(r.collecting, 2, "h1 and the early note still collect");
  const row = w.env.DB.raw.prepare("SELECT status, reason, verdict_json, promoted_at, retired_at FROM learned_live WHERE item_id = ?").get(ST);
  assert.deepEqual([row.status, row.reason, row.promoted_at, row.retired_at], ["retired", "shadow:not_tested", iso(now), iso(now)]);
  const ev = JSON.parse(row.verdict_json);
  assert.deepEqual([ev.schema, ev.reason, ev.rule, ev.rows, ev.scored], [CLOSURE_VERSION, "not_tested", "untestable.agent_inactive", 18, 18]);
  assert.ok((await promotedKeys(w.env)).has(`${ST}@1`));
  assert.equal((await shadowItems(w.env)).some((i) => i.item_id === ST), false, "promotedKeys skips it: the slot is free");
  assert.equal((await readLearnedLive(w.env)).items.find((i) => i.item_id === ST).closure.reason, "not_tested");
  // KA2: the not_tested post, exactly the platform's schema.
  const posted = await postKnowledgeVerdicts(w.env, { plan: r.plan, now, limit: 20 });
  assert.equal(posted.status, "ok");
  const p = w.calls.find((c) => c.input.item_id === ST).input;
  assert.deepEqual(verdictPayloadProblems(p), []);
  assert.deepEqual(p, {
    item_id: ST, item_version: 1, verdict: "not_tested",
    reason: "Not tested to a verdict: its agent stopped opening in its room, so the shadow arm made no call with the note for 72 hours while it ran.",
    evidence: { arm: "supertrend", window_start: iso(T0), window_end: iso(T0 + 17 * H), rows: 18, scored: 18, charts: ["60"], rule: "untestable.agent_inactive" }
  });
  assert.doesNotMatch(p.evidence.rule, /\d{3,}/);
  // Once: the next run closes nothing and posts no second not_tested.
  const again = await runShadowClosures(w.env, { now: now + H });
  assert.deepEqual(again.closed, []);
  await postKnowledgeVerdicts(w.env, { plan: again.plan, now: now + H, limit: 20 });
  assert.equal(w.calls.filter((c) => c.input.item_id === ST).length, 1);
  // A never-tested idle item: no window, rows 0, still inside the schema.
  const e0 = idleEvidence({ rule: IDLE_RULES.rule, rows: 0, scored: 0, window_start: null, window_end: null, idle: { agents: ["htf"], charts: ["15", "60"] }, subjects: [] });
  assert.deepEqual(e0, { arm: "htf", rows: 0, scored: 0, charts: ["15", "60"], rule: "untestable.agent_inactive" });
  const entries = verdictEntries({ live: [{ item_id: "k-role-htf-calibration-talk", version: 1, status: "retired", reason: "shadow:not_tested", verdict_json: JSON.stringify({ schema: CLOSURE_VERSION, rule: IDLE_RULES.rule, rows: 0, scored: 0, idle: { agents: ["htf"], charts: ["15", "60"] }, subjects: [] }), retired_at: iso(now) }] });
  assert.deepEqual(entries.map((x) => [x.verdict, verdictPayloadProblems(x.payload)]), [["not_tested", []]]);
});

test("KA3-5. with the arm off nothing is read or written: D1 and KV stay byte-identical", async () => {
  const w = await world();
  const before = w.dump(), kvBefore = JSON.stringify([...w.kv]);
  const off = { ...w.env, SHADOW_KNOWLEDGE_ENABLED: "false" };
  assert.deepEqual(await runShadowClosures(off, { now: T0 + 118 * H }), { status: "disabled" });
  assert.deepEqual(await postKnowledgeVerdicts(off, { plan: { items: [] }, now: T0 + 118 * H }), { status: "disabled" });
  assert.equal(w.dump(), before);
  assert.equal(JSON.stringify([...w.kv]), kvBefore);
  assert.deepEqual(w.calls, []);
});
