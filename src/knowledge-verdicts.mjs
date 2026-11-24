// KA2: the shadow knowledge arm's verdicts, posted to the platform (capability knowledge.verdict, platform PF3,
// migration 0088), so Aether's curator learns which of its notes the arm found better, not better, worse or could not
// test. The poster is the dedicated kernel agent shadow-knowledge (organism.json: tier 1, no seat, knowledge.verdict
// only, through XAUUSD_CEILING). It reads only what the arm already decided (src/shadow-knowledge.mjs
// planShadowClosures, D1 learned_live, the stored pack) and never changes it: nothing here touches a room, the bus, a
// decision, a prompt or public output.
//
// What is posted, one call per item on each verdict change (the hourly sweep, after runShadowClosures):
//   final      learned_live: a KA1 closure (reason shadow:<token>) posts the token itself as the verdict
//              (not_better, holdout_failed or worse); a promoted note posts live; a live note that retired posts
//              retired. Oldest first.
//   collecting the items still collecting in shadow, at most once a UTC day per item, with rows and scored.
//   not_tested a pack text item no shadow call can ever test: for the moderator only (never called in shadow),
//              for Omega (not a room agent), or for charts the arm does not run on (the 4H or daily chart only).
// The payload is exactly the platform's schema (KNOWLEDGE_VERDICT_SCHEMA below; checked here before any call).
//
// Errors: knowledge_proposal_not_found marks the item (never retried); an unknown, not yet registered agent stops the
// run and leaves everything unposted for the next run (no write, no Telegram); a denial stops the run and backs the
// agent off (the documented exception of AGENTS.md rule 7: one whoami decides after it); a kernel failure or a
// transport error stops the run and is retried, at most KNOWLEDGE_VERDICT_RULES.max_attempts times. At most
// KNOWLEDGE_VERDICT_RULES.strikes_per_hour refused or failed calls an hour, below the kernel's suspension at 5.
// Switch: off unless SHADOW_KNOWLEDGE_ENABLED is "true" and KNOWLEDGE_VERDICT_POSTS is "on"; off, nothing is read,
// written or called.

import { storedPack } from "./aether-pack.mjs";
import { TEXT_KINDS } from "./learned-knowledge.mjs";
import { LEARNED_LIVE_SCHEMA_SQL } from "./learned-live.mjs";
import { shadowKnowledgeEnabled, subjectOf, SHADOW_CHARTS } from "./shadow-knowledge.mjs";
import { kernelSyscall, readAgentBackoff, writeAgentBackoff, clearAgentBackoff, kernelAgentStatus, PLATFORM_CALL_TIMEOUT_MS } from "./platform-reports.mjs";

export const KNOWLEDGE_VERDICT_AGENT_ID = "shadow-knowledge";
export const KNOWLEDGE_VERDICT_CAPABILITY = "knowledge.verdict";
export const KNOWLEDGE_VERDICTS = Object.freeze(["live", "retired", "not_better", "worse", "holdout_failed", "collecting", "inconclusive", "not_tested"]);
export const KNOWLEDGE_VERDICT_EVIDENCE_KEYS = Object.freeze(["arm", "window_start", "window_end", "rows", "scored", "treat_hits", "control_hits", "aa_changed", "aa_total", "p_value", "p_holm", "charts", "rule"]);
export const KNOWLEDGE_VERDICT_RULES = Object.freeze({ per_run: 12, max_attempts: 5, strikes_per_hour: 3, backoff_ms: 55 * 60_000 });

export function knowledgeVerdictPostsEnabled(env) {
  return shadowKnowledgeEnabled(env) && String(env?.KNOWLEDGE_VERDICT_POSTS ?? "off").trim().toLowerCase() === "on";
}

// ------------------------------------------------------------------ the schema (platform PF3), checked before a call
const ITEM_ID = /^k-[a-z0-9-]{1,40}$/;
const TOKEN = /^[a-z0-9_.+-]{1,40}$/;
const CHART_TOKEN = /^[a-z0-9]{1,8}$/;
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const PLAIN = /^[A-Za-z0-9 ,.;:()'-]+$/;
const PRICE_LIKE = /\d{3,}/;
const COUNTS = ["rows", "scored", "treat_hits", "control_hits", "aa_changed", "aa_total"];

/** Pure: why a payload would be refused (empty when it may be sent). */
export function verdictPayloadProblems(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["not_an_object"];
  const out = [];
  for (const k of Object.keys(p)) if (!["item_id", "item_version", "verdict", "reason", "evidence"].includes(k)) out.push(`key_not_allowed:${k}`);
  if (typeof p.item_id !== "string" || !ITEM_ID.test(p.item_id)) out.push("item_id_invalid");
  if (!Number.isInteger(p.item_version) || p.item_version < 1 || p.item_version > 999) out.push("item_version_invalid");
  if (!KNOWLEDGE_VERDICTS.includes(p.verdict)) out.push("verdict_invalid");
  if (typeof p.reason !== "string" || p.reason.length < 10 || p.reason.length > 300 || !PLAIN.test(p.reason) || PRICE_LIKE.test(p.reason)) out.push("reason_invalid");
  const e = p.evidence;
  if (e === undefined) return out;
  if (!e || typeof e !== "object" || Array.isArray(e)) return [...out, "evidence_invalid"];
  for (const [k, v] of Object.entries(e)) {
    if (!KNOWLEDGE_VERDICT_EVIDENCE_KEYS.includes(k)) { out.push(`evidence_key_not_allowed:${k}`); continue; }
    if (v === null || v === undefined) { out.push(`evidence_null:${k}`); continue; }
    if (k === "arm" && (typeof v !== "string" || !TOKEN.test(v))) out.push("evidence_arm_invalid");
    if ((k === "window_start" || k === "window_end") && (typeof v !== "string" || !ISO_Z.test(v) || !Number.isFinite(Date.parse(v)))) out.push(`evidence_${k}_invalid`);
    if (COUNTS.includes(k) && (!Number.isInteger(v) || v < 0)) out.push(`evidence_${k}_invalid`);
    if ((k === "p_value" || k === "p_holm") && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)) out.push(`evidence_${k}_invalid`);
    if (k === "charts" && (!Array.isArray(v) || !v.length || !v.every((c) => typeof c === "string" && CHART_TOKEN.test(c)))) out.push("evidence_charts_invalid");
    if (k === "rule" && (typeof v !== "string" || !TOKEN.test(v) || PRICE_LIKE.test(v))) out.push("evidence_rule_invalid");
  }
  if (typeof e.window_start === "string" && typeof e.window_end === "string" && Date.parse(e.window_start) > Date.parse(e.window_end)) out.push("evidence_window_order");
  if (Number.isInteger(e.scored) && Number.isInteger(e.rows) && e.scored > e.rows) out.push("evidence_scored_above_rows");
  for (const k of ["treat_hits", "control_hits"]) if (Number.isInteger(e[k]) && Number.isInteger(e.scored) && e[k] > e.scored) out.push(`evidence_${k}_above_scored`);
  if (Number.isInteger(e.aa_changed) && Number.isInteger(e.aa_total) && e.aa_changed > e.aa_total) out.push("evidence_aa_changed_above_total");
  return out;
}

// ------------------------------------------------------------------ the verdicts (pure)
const CHART_WORD = Object.freeze({ "15": "quarter-hour", "60": "hourly", "240": "four-hour", "1D": "daily" });
const SHADOW_CODES = new Set(Object.values(SHADOW_CHARTS));
/** Audiences that are not room agents: the shadow arm can never call them. */
const OUTSIDE_ROOMS = new Set(["omega"]);
const CLOSURE_TOKENS = ["not_better", "holdout_failed", "worse"];
const who = (agent) => (agent === "council" ? "the council" : String(agent ?? "the agent").replace(/[_-]+/g, " "));
const chartWord = (c) => CHART_WORD[c] ?? "tested";
/** The test behind each verdict, machine-readable (evidence.rule; no run of 3 digits). */
const RULE = Object.freeze({
  not_better: "sign_holm.better", worse: "sign_holm.worse", holdout_failed: "holdout.no_worse",
  collecting: "min_sample.discovery", live: "sign_holm.better+holdout"
});
const UNTESTABLE = Object.freeze({
  moderator_only: "Never tested here: the note is for the moderator only, and the shadow arm never calls the moderator.",
  audience_omega: "Never tested here: the note is for Omega, which is not a room agent the shadow arm can call.",
  chart_4h_only: "Never tested here: the note is for the four-hour chart only, and the shadow arm runs on the hourly and quarter-hour charts.",
  chart_1d_only: "Never tested here: the note is for the daily chart only, and the shadow arm runs on the hourly and quarter-hour charts.",
  chart_unshadowed: "Never tested here: the note is for charts the shadow arm does not run on (it runs on the hourly and quarter-hour charts)."
});
const RETIRED = [
  [/^worse live/, "live.binomial", "Retired after going live: the agent's scored calls since the promotion were significantly worse than in the shadow test."],
  [/^no longer in Aether/, "pack.withdrawn", "Retired after going live: the note is no longer in Aether's pack (a person rejected it, or Aether withdrew it)."],
  [/^autonomous promotion switched off/, "promotion.off", "Retired after going live: autonomous promotion of learned notes was switched off."]
];

function reasonOf(verdict, s) {
  const a = who(s?.agent), c = chartWord(s?.chart);
  if (verdict === "not_better") return `Closed in shadow: the note did not make ${a} better than its own answer on the ${c} chart (Holm-adjusted sign test on the discovery bars).`;
  if (verdict === "worse") return `Closed in shadow: with the note, ${a} was significantly worse than its own answer on the ${c} chart (reverse sign test, Holm-adjusted).`;
  if (verdict === "holdout_failed") return `Closed in shadow: the note made ${a} better on the discovery bars of the ${c} chart, but not on the newest holdout bars.`;
  if (verdict === "collecting") return `Still collecting in shadow: ${a} on the ${c} chart has fewer scored bars than the sample a verdict needs.`;
  return `Went live by itself: the note made ${a} better than its own answer in shadow on the ${c} chart, on discovery and holdout.`;
}

const intOr = (v) => (Number.isInteger(v) && v >= 0 ? v : undefined);
const pOr = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined);
/** Drops what the arm does not have: the platform refuses a null. */
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length)));
const chartsOf = (list) => [...new Set(list.map((c) => String(c ?? "").toLowerCase()).filter((c) => CHART_TOKEN.test(c)))];

/** Pure: the evidence of one closure subject (src/shadow-knowledge.mjs planShadowClosures evidenceOf). */
export function subjectEvidence(s, verdict, windows = {}) {
  const w = windows?.[s?.subject];
  const worse = verdict === "worse";
  return compact({
    arm: typeof s?.agent === "string" && TOKEN.test(s.agent) ? s.agent : undefined,
    window_start: w?.start, window_end: w?.end,
    rows: intOr(s?.rows), scored: intOr(s?.scored), treat_hits: intOr(s?.treat_hits), control_hits: intOr(s?.control_hits),
    aa_changed: intOr(s?.aa?.changed), aa_total: intOr(s?.aa?.total),
    p_value: pOr(worse ? s?.p_value_worse : s?.p_value), p_holm: pOr(worse ? s?.p_holm_worse : s?.p_holm),
    charts: chartsOf([s?.chart]), rule: RULE[verdict]
  });
}

/** Pure: why a pack item can never be tested by the shadow arm here (a token), or null when it can be. */
export function untestableReason(it) {
  const agents = Array.isArray(it?.audience?.agents) ? it.audience.agents.map(String) : [];
  const testers = agents.filter((a) => a !== "moderator");
  if (agents.length && !testers.length) return "moderator_only";
  if (testers.length && testers.every((a) => OUTSIDE_ROOMS.has(a))) return "audience_omega";
  const charts = Array.isArray(it?.audience?.charts) ? it.audience.charts.map(String) : [];
  if (charts.length && !charts.some((c) => SHADOW_CODES.has(c))) return charts.length === 1 && charts[0] === "240" ? "chart_4h_only" : charts.length === 1 && charts[0] === "1D" ? "chart_1d_only" : "chart_unshadowed";
  return null;
}

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const entry = (item_id, version, verdict, reason, evidence) => ({
  key: `${item_id}@${version}`, item_id, version, verdict, window_end: verdict === "collecting" ? evidence.window_end ?? "" : "",
  payload: { item_id, item_version: version, verdict, reason, evidence }
});

/**
 * Pure: every item's current verdict, in posting order: the final ones (learned_live, oldest first), then the items
 * still collecting (by key), then the pack items that can never be tested (oldest first seen first). `plan` is
 * runShadowClosures' whole-row plan, `live` the learned_live rows, `packItems` and `firstSeen` the stored pack.
 */
export function verdictEntries({ plan = null, live = [], packItems = [], firstSeen = {} } = {}) {
  const windows = plan?.windows ?? {};
  const out = [];
  const decided = new Set();
  const order = (r) => String(r.retired_at ?? r.promoted_at ?? "");
  for (const r of [...live].sort((a, b) => order(a).localeCompare(order(b)) || `${a.item_id}@${a.version}`.localeCompare(`${b.item_id}@${b.version}`))) {
    const version = Number(r.version);
    decided.add(`${r.item_id}@${version}`);
    const reason = String(r.reason ?? "");
    if (r.status === "retired" && reason.startsWith("shadow:")) {
      const token = reason.slice("shadow:".length);
      const ev = parse(r.verdict_json, null);
      const subjects = Array.isArray(ev?.subjects) ? ev.subjects : [];
      if (!CLOSURE_TOKENS.includes(token) || !subjects.length) continue;
      const s = subjects.find((x) => x.outcome === token) ?? subjects[0];
      out.push(entry(r.item_id, version, token, reasonOf(token, s), subjectEvidence(s, token, windows)));
      continue;
    }
    const tested = parse(r.verdict_json, []);
    const list = Array.isArray(tested) ? tested : [];
    const v = list[0] ?? {};
    const w = v.agent ? windows[subjectOf(v.agent, { item_id: r.item_id, version }, v.chart ?? "60")] : null;
    const scored = [v.discovery?.bars, v.holdout?.bars].every((n) => Number.isInteger(n)) ? v.discovery.bars + v.holdout.bars : undefined;
    const base = { arm: typeof v.agent === "string" && TOKEN.test(v.agent) ? v.agent : undefined, window_start: w?.start, window_end: w?.end, scored, charts: chartsOf(list.map((x) => x.chart)) };
    if (r.status === "live") {
      out.push(entry(r.item_id, version, "live", reasonOf("live", v), compact({ ...base, p_value: pOr(v.discovery?.p_value), p_holm: pOr(v.discovery?.p_holm), rule: RULE.live })));
    } else if (r.status === "retired") {
      const [, rule, text] = RETIRED.find(([re]) => re.test(reason)) ?? [null, "live.retired", "Retired after going live (the learned-live record names the reason)."];
      out.push(entry(r.item_id, version, "retired", text, compact({ ...base, rule })));
    }
  }
  const planned = new Set();
  for (const it of [...(plan?.items || [])].sort((a, b) => String(a.key).localeCompare(String(b.key)))) {
    planned.add(it.key);
    if (decided.has(it.key) || it.outcome !== "collecting") continue;
    const subjects = it.evidence?.subjects || [];
    const s = subjects.reduce((best, x) => (best === null || Number(x.scored) > Number(best.scored) ? x : best), null);
    if (s) out.push(entry(it.item_id, Number(it.version), "collecting", reasonOf("collecting", s), subjectEvidence(s, "collecting", windows)));
  }
  const seen = (it) => String(firstSeen?.[`${it.item_id}@${it.version}`] ?? "");
  for (const it of [...packItems].filter((x) => TEXT_KINDS.includes(x?.kind)).sort((a, b) => seen(a).localeCompare(seen(b)) || String(a.item_id).localeCompare(String(b.item_id)))) {
    const key = `${it.item_id}@${it.version}`;
    if (decided.has(key) || planned.has(key)) continue;
    const why = untestableReason(it);
    if (why) out.push(entry(it.item_id, Number(it.version), "not_tested", UNTESTABLE[why], { rule: `untestable.${why}` }));
  }
  // Only what the platform can hold: an id outside its pattern (a bundled item, say) is never sent.
  return out.filter((e) => ITEM_ID.test(e.item_id) && Number.isInteger(e.version));
}

const DONE = new Set(["posted", "failed", "invalid"]);
const utcDay = (iso) => String(iso ?? "").slice(0, 10);
/**
 * Pure: the entries to post now, in order. `markers` are the knowledge_verdict_posts rows. An item marked not_found is
 * never posted again; a final verdict is posted once; collecting at most once a UTC day per item, and once per
 * window_end.
 */
export function planVerdictPosts({ entries = [], markers = [], now = Date.now() } = {}) {
  const byItem = new Map();
  for (const m of markers) { const k = `${m.item_id}@${Number(m.item_version)}`; byItem.set(k, [...(byItem.get(k) || []), m]); }
  const today = utcDay(new Date(now).toISOString());
  return entries.filter((e) => {
    const ms = byItem.get(e.key) || [];
    if (ms.some((m) => m.status === "not_found")) return false;
    if (e.verdict !== "collecting") return !ms.some((m) => m.verdict === e.verdict && m.window_end === "" && DONE.has(m.status));
    if (ms.some((m) => m.verdict === "collecting" && m.status === "posted" && utcDay(m.posted_at) === today)) return false;
    return !ms.some((m) => m.verdict === "collecting" && m.window_end === e.window_end && DONE.has(m.status));
  });
}

// ------------------------------------------------------------------ the store and the sender
export const KNOWLEDGE_VERDICT_SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS knowledge_verdict_posts (
    item_id TEXT NOT NULL,
    item_version INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    window_end TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    payload_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    posted_at TEXT,
    PRIMARY KEY (item_id, item_version, verdict, window_end)
  )`,
  "CREATE TABLE IF NOT EXISTS knowledge_verdict_strikes (at_ms INTEGER NOT NULL)"
]);
let ready = false;
export function resetKnowledgeVerdictsForTests() { ready = false; }
async function ensureSchema(db) {
  if (ready) return;
  for (const sql of [...LEARNED_LIVE_SCHEMA_SQL, ...KNOWLEDGE_VERDICT_SCHEMA_SQL]) await db.prepare(sql).run();
  ready = true;
}
async function strikesLastHour(db, now) {
  await db.prepare("DELETE FROM knowledge_verdict_strikes WHERE at_ms < ?").bind(now - 2 * 3_600_000).run();
  return Number((await db.prepare("SELECT COUNT(*) AS n FROM knowledge_verdict_strikes WHERE at_ms > ?").bind(now - 3_600_000).first())?.n) || 0;
}
const strike = (db, now) => db.prepare("INSERT INTO knowledge_verdict_strikes (at_ms) VALUES (?)").bind(now).run();
async function mark(db, e, status, reason, nowIso, attempts) {
  await db.prepare(
    "INSERT INTO knowledge_verdict_posts (item_id, item_version, verdict, window_end, status, attempts, reason, payload_json, created_at, updated_at, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(item_id, item_version, verdict, window_end) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, reason = excluded.reason, payload_json = excluded.payload_json, updated_at = excluded.updated_at, posted_at = COALESCE(excluded.posted_at, knowledge_verdict_posts.posted_at)"
  ).bind(e.item_id, e.version, e.verdict, e.window_end, status, attempts, reason, JSON.stringify(e.payload), nowIso, nowIso, status === "posted" ? nowIso : null).run();
}

// The kernel's words for an agent it has no row for (the platform has not registered shadow-knowledge yet).
const NOT_REGISTERED = /unknown[_ ]agent|agent[_ ]unknown|agent[_ ]not[_ ]found|no[_ ]such[_ ]agent|not[_ ]registered|unregistered|agent_registered|agent_exists/i;
const NOT_FOUND = /knowledge_proposal_not_found/;

/**
 * Hourly, after runShadowClosures (its non-enumerable `plan`). Never throws. Returns what it did, for one log line:
 * { status: "ok" | "not_registered" | "backoff" | ..., due, posted, not_found, invalid, failed, stopped }.
 */
export async function postKnowledgeVerdicts(env, { plan = null, now = Date.now(), limit = KNOWLEDGE_VERDICT_RULES.per_run, timeoutMs = PLATFORM_CALL_TIMEOUT_MS } = {}) {
  if (!knowledgeVerdictPostsEnabled(env)) return { status: "disabled" };
  if (!env?.DB || typeof env?.AGENTS?.syscall !== "function") return { status: "unavailable" };
  if (!plan || !Array.isArray(plan.items)) return { status: "no_plan" };
  const agent = KNOWLEDGE_VERDICT_AGENT_ID;
  try {
    const db = env.DB;
    await ensureSchema(db);
    const off = await readAgentBackoff(env, agent);
    if (off) {
      if (now < Number(off.until_ms)) return { status: "backoff", until: new Date(Number(off.until_ms)).toISOString() };
      const st = await kernelAgentStatus(env, agent);
      if (st !== null && st !== "enabled") {
        await writeAgentBackoff(env, agent, now + KNOWLEDGE_VERDICT_RULES.backoff_ms, String(off.reason ?? "denied"), now);
        return { status: "backoff", until: new Date(now + KNOWLEDGE_VERDICT_RULES.backoff_ms).toISOString(), agent_status: st };
      }
    }
    const live = (await db.prepare("SELECT item_id, version, status, verdict_json, promoted_at, retired_at, reason FROM learned_live").all()).results || [];
    let stored = null;
    try { stored = await storedPack(env); } catch { stored = null; }
    const markers = (await db.prepare("SELECT item_id, item_version, verdict, window_end, status, attempts, posted_at FROM knowledge_verdict_posts").all()).results || [];
    const entries = verdictEntries({ plan, live, packItems: Array.isArray(stored?.pack?.items) ? stored.pack.items : [], firstSeen: stored?.firstSeen ?? {} });
    const todo = planVerdictPosts({ entries, markers, now });
    const attemptsOf = (e) => Number(markers.find((m) => m.item_id === e.item_id && Number(m.item_version) === e.version && m.verdict === e.verdict && m.window_end === e.window_end)?.attempts ?? 0);
    const at = new Date(now).toISOString();
    const out = { status: "ok", due: todo.length, posted: [], not_found: [], invalid: [], failed: 0, stopped: null };
    let calls = 0, cleared = !off;
    for (const e of todo) {
      const problems = verdictPayloadProblems(e.payload);
      if (problems.length) { await mark(db, e, "invalid", problems.slice(0, 3).join(","), at, 0); out.invalid.push(`${e.key}:${e.verdict}`); continue; }
      if (calls >= limit) { out.stopped = "per_run"; break; }
      if (await strikesLastHour(db, now) >= KNOWLEDGE_VERDICT_RULES.strikes_per_hour) { out.stopped = "local_budget"; break; }
      calls += 1;
      const r = await kernelSyscall(env, agent, KNOWLEDGE_VERDICT_CAPABILITY, e.payload, { timeoutMs });
      const reason = String(r?.reason ?? r?.error ?? r?.outcome ?? "").slice(0, 200);
      if (r?.outcome === "succeeded" || r?.outcome === "success") {
        await mark(db, e, "posted", r?.result?.deduplicated ? "deduplicated" : null, at, attemptsOf(e) + 1);
        out.posted.push(`${e.key}:${e.verdict}`);
        if (!cleared) { await clearAgentBackoff(env, agent); cleared = true; }
        continue;
      }
      // Not yet registered on the platform: nothing is marked, the next run tries again.
      if (NOT_REGISTERED.test(reason)) { out.status = "not_registered"; out.stopped = "not_registered"; break; }
      await strike(db, now);
      if (NOT_FOUND.test(reason)) { await mark(db, e, "not_found", reason, at, attemptsOf(e) + 1); out.not_found.push(e.key); continue; }
      if (r?.outcome === "denied") {
        await writeAgentBackoff(env, agent, now + KNOWLEDGE_VERDICT_RULES.backoff_ms, reason, now);
        Object.assign(out, { stopped: "denied", reason });
        break;
      }
      const attempts = attemptsOf(e) + 1;
      await mark(db, e, attempts >= KNOWLEDGE_VERDICT_RULES.max_attempts ? "failed" : "pending", reason, at, attempts);
      out.failed += 1;
      Object.assign(out, { stopped: r?.outcome === "transport" ? "transport" : "failed", reason });
      break;
    }
    return out;
  } catch (e) { return { status: "failed", error: String(e?.message ?? e).slice(0, 200) }; }
}
