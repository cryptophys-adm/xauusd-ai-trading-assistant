// Aether phase A7, the shadow knowledge arm (RFC_AETHER_KNOWLEDGE_GUARDIAN §9.4, K6, O8, O13).
//
// For each text item of the learned pack (caution, role_reminder; at most MAX_ITEMS at once) whose
// audience includes an agent of the 1H room, of the 15m War Room, or the Decision Engine council (since
// 2026-11-13, owner: "1-3"; 15m subjects end in "@15"), that agent makes ONE extra opening call on the
// same bar, with the same data and prompt plus the note. The answer is stored in D1
// shadow_agent_outputs (migration 0016) with that agent's real opening stance on the same bar (the
// control), as "shadow-agent:<agent>@<item>v<version>". Both stances are scored with the outcome
// scoring once the horizon closes, in that table (never in outcome_scores, so no scorecard or
// reputation sees them). It is never shown in a room, never on the bus, never in the crowd line, the
// moderator, the Reasoner or a decision.
//
// A/A noise check (O13): while the first item runs, the same agent also makes the same call WITHOUT
// the note ("shadow-agent:<agent>@aa"). How often that changes the stance against the real opening is
// the model's noise rate, reported next to every verdict.
//
// Off unless SHADOW_KNOWLEDGE_ENABLED = "true". At most SHADOW_KNOWLEDGE_MAX_CALLS_PER_HOUR calls an
// hour (default 8). The calls run after the room and the H1 decision, never before them.
// Promotion (owner 2026-11-13: "buat agar autonomous"): a note this arm finds better goes live by itself for the
// tested agents on the 1H chart (src/learned-live.mjs), and retires by itself; the bundled pack still changes by PR.
// Self-judging (KA1, owner 2026-11-24: "buka arm, biarkan system menilai dirinya sendiri"): a note whose final verdict
// is not better, failed its holdout or is worse closes by itself and frees its slot (runShadowClosures, below).
// KA3: an item whose agent no longer opens in its room (no shadow call for 72 hours of the arm running) closes as
// not_tested and leaves the queue with a verdict (planIdleClosures, below).

import { storedPack } from "./aether-pack.mjs";
import { promotedKeys, closeShadowItems } from "./learned-live.mjs";
import { callBusModel } from "./model-call.mjs";
import { shadowAllowed } from "./shadow-switch.mjs";
import { SCORING_VERSION, scoreStance } from "./outcome-scoring.mjs";
import { pairedTally, holmAdjust, holmMonth, signTestP, SHADOW_MIN_SAMPLE, SHADOW_SIGNIFICANCE, HOLDOUT_BARS } from "./shadow-versions.mjs";

export const SHADOW_KNOWLEDGE_VERSION = "cryptophys.shadow-knowledge.v1";
// Owner 2026-11-16 ("opsi A"): 6 items at once (was 2), so the curator's daily items do not queue for weeks behind
// the two oldest; the hourly cap is doubled to match. The kill switch and the daily neuron breaker still bound it.
export const MAX_ITEMS = 6;
/** Shared by the 1H room, the 15m War Room and the council (16 since 2026-11-13; 32 since 2026-11-16, owner "opsi A"). */
export const DEFAULT_MAX_CALLS_PER_HOUR = 32;
export const MAX_CALLS_PER_HOUR_CAP = 48;
const TEXT_KINDS = new Set(["caution", "role_reminder"]);
const NOTE_MAX = 400;

export function shadowKnowledgeEnabled(env) { return String(env?.SHADOW_KNOWLEDGE_ENABLED ?? "").trim().toLowerCase() === "true"; }
export function maxCallsPerHour(env) {
  const n = Number(env?.SHADOW_KNOWLEDGE_MAX_CALLS_PER_HOUR ?? DEFAULT_MAX_CALLS_PER_HOUR);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_CALLS_PER_HOUR_CAP) : DEFAULT_MAX_CALLS_PER_HOUR;
}

export const SHADOW_KNOWLEDGE_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS shadow_agent_outputs (
    subject TEXT NOT NULL,
    candle_key TEXT NOT NULL,
    agent TEXT NOT NULL,
    item_id TEXT,
    item_version INTEGER,
    arm TEXT NOT NULL,
    statement_close TEXT NOT NULL,
    stance TEXT,
    bias TEXT,
    confidence REAL,
    control_stance TEXT,
    status TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL,
    result TEXT,
    control_result TEXT,
    scoring_version TEXT,
    scored_at TEXT,
    PRIMARY KEY (subject, candle_key)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_shadow_agent_outputs_created ON shadow_agent_outputs(created_at)"
];
let schemaReady = false;
export function resetShadowKnowledgeSchemaCacheForTests() { schemaReady = false; }
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of SHADOW_KNOWLEDGE_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}

/**
 * The charts the arm runs on (owner 2026-11-13: the 15m War Room and the Decision Engine council too). The
 * 1H subjects keep their original form; a 15m subject ends in "@15".
 */
export const SHADOW_CHARTS = Object.freeze({ H1: "60", M15: "15" });
const chartSuffix = (chart) => (chart && chart !== "60" ? `@${chart}` : "");
export const subjectOf = (agent, item, chart = "60") => (item ? `shadow-agent:${agent}@${item.item_id}v${item.version}` : `shadow-agent:${agent}@aa`) + chartSuffix(chart);
/** Pure: the chart of a shadow subject ("60" or "15"). */
export const chartOfSubject = (subject) => (/@15$/.test(String(subject ?? "")) ? "15" : "60");
const SHADOW_CODES = new Set(Object.values(SHADOW_CHARTS));
/** Audiences that are not room agents: the shadow arm can never call them. */
const OUTSIDE_ROOMS = new Set(["omega"]);

/** Pure: why a pack item can never be tested by the shadow arm here (a token), or null when it can be (KA2's not_tested). */
export function untestableReason(it) {
  const agents = Array.isArray(it?.audience?.agents) ? it.audience.agents.map(String) : [];
  const testers = agents.filter((a) => a !== "moderator");
  if (agents.length && !testers.length) return "moderator_only";
  if (testers.length && testers.every((a) => OUTSIDE_ROOMS.has(a))) return "audience_omega";
  const charts = Array.isArray(it?.audience?.charts) ? it.audience.charts.map(String) : [];
  if (charts.length && !charts.some((c) => SHADOW_CODES.has(c))) return charts.length === 1 && charts[0] === "240" ? "chart_4h_only" : charts.length === 1 && charts[0] === "1D" ? "chart_1d_only" : "chart_unshadowed";
  return null;
}
const ascii = (s) => String(s ?? "").replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);

/** The note line added to the agent's prompt (plain words; the item text is reviewed and has no levels). */
export function noteLine(item) {
  return `LEARNED NOTE (reviewed by a person; apply it only if it fits your data): ${ascii(item.text)}`;
}

/**
 * Pure: the shadow calls of one room. `items` are the pack's items (oldest first-seen first), `roster`
 * the room's agents, `openings` its stored openings. Only agents that answered get a shadow call
 * (the control must exist). The A/A arm runs with the first item, once per bar.
 */
export function planShadowCalls({ items = [], roster = [], openings = [], chart = "H1" } = {}) {
  const code = SHADOW_CHARTS[chart];
  if (!code) return [];
  const answered = new Map((openings || []).filter((m) => m?.status === "ok").map((m) => [String(m.agent ?? m.id), m.stance]));
  const text = (items || []).filter((it) => TEXT_KINDS.has(it?.kind) && typeof it.text === "string" && it.text.trim())
    .filter((it) => !Array.isArray(it.audience?.charts) || !it.audience.charts.length || it.audience.charts.includes(code))
    // A slot goes only to an item this room can test: the moderator is never called (below), so a moderator-only
    // item would take one of the MAX_ITEMS slots, make no call and hold it forever (KA1 review).
    .filter((it) => (it.audience?.agents || []).some((a) => a !== "moderator" && roster.includes(a)))
    .slice(0, MAX_ITEMS);
  const calls = [];
  text.forEach((item, i) => {
    for (const agent of item.audience?.agents || []) {
      if (agent === "moderator" || !roster.includes(agent) || !answered.has(agent)) continue;
      const control_stance = answered.get(agent);
      calls.push({ subject: subjectOf(agent, item, code), agent, item, arm: "note", control_stance });
      if (i === 0 && !calls.some((c) => c.arm === "aa" && c.agent === agent)) calls.push({ subject: subjectOf(agent, null, code), agent, item: null, arm: "aa", control_stance });
    }
  });
  return calls;
}

/** The pack's text items in first-seen order. */
export async function shadowItems(env) {
  let stored = null;
  try { stored = await storedPack(env); } catch { stored = null; }
  const items = Array.isArray(stored?.pack?.items) ? stored.pack.items : [];
  const seen = stored?.firstSeen || {};
  // Promoted (live or retired) versions are no longer tested (src/learned-live.mjs, owner 2026-11-13).
  const done = await promotedKeys(env);
  return items.filter((it) => TEXT_KINDS.has(it?.kind) && !done.has(`${it.item_id}@${it.version}`))
    .sort((a, b) => String(seen[`${a.item_id}@${a.version}`] ?? "").localeCompare(String(seen[`${b.item_id}@${b.version}`] ?? "")) || String(a.item_id).localeCompare(String(b.item_id)));
}

/**
 * Runs the planned shadow calls of one bar. `messagesFor(agent, note|null)` builds the agent's opening
 * prompt (the room's own builder), `validate(obj, agent)` the room's opening validator. Idempotent per
 * (subject, bar); bounded by the hourly cap. Never throws for a model problem.
 */
export async function runShadowCalls(env, { calls, candleKey, statementClose, messagesFor, validate, schema, schemaName = "tf_room_opening", maxTokens = 400, clock = () => Date.now(), deadlineMs = 60_000, role = "agent", toStance = (o) => o.stance } = {}) {
  if (!shadowKnowledgeEnabled(env) || !env?.DB || !calls?.length) return { status: shadowKnowledgeEnabled(env) ? "nothing_to_do" : "disabled" };
  // The shadow kill switch (src/shadow-switch.mjs): off, no model is called.
  if (!(await shadowAllowed(env))) return { status: "shadow_off" };
  await ensureSchema(env.DB);
  const sinceHour = new Date(clock() - 3_600_000).toISOString();
  const used = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM shadow_agent_outputs WHERE created_at >= ?").bind(sinceHour).first())?.n ?? 0);
  let budget = maxCallsPerHour(env) - used;
  const out = { status: "ok", called: 0, stored: 0, skipped: 0 };
  const deadline = clock() + deadlineMs;
  for (const c of calls) {
    if (await env.DB.prepare("SELECT 1 AS x FROM shadow_agent_outputs WHERE subject = ? AND candle_key = ?").bind(c.subject, candleKey).first()) { out.skipped += 1; continue; }
    if (budget <= 0 || clock() >= deadline) { out.status = "budget_exhausted"; break; }
    budget -= 1;
    out.called += 1;
    let row = { stance: null, bias: null, confidence: null, status: "agent_failed", model: null };
    try {
      const call = await callBusModel(env, { messages: messagesFor(c.agent, c.item ? noteLine(c.item) : null), schemaName, schema, maxTokens, effort: "low", deadline, clock, runState: { primaryError: null }, role, meterSource: `shadow:${schemaName}` });
      if (call.status === "answered" && !call.truncated) {
        const v = validate(call.obj, c.agent);
        row = v.valid ? { stance: toStance(call.obj), bias: call.obj.bias ?? null, confidence: call.obj.confidence ?? null, status: "ok", model: call.model } : { ...row, status: "invalid_output", model: call.model };
      } else row = { ...row, status: call.status === "answered" ? "invalid_output" : call.status, model: call.model ?? null };
    } catch { /* stored as agent_failed */ }
    await env.DB.prepare("INSERT INTO shadow_agent_outputs (subject, candle_key, agent, item_id, item_version, arm, statement_close, stance, bias, confidence, control_stance, status, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(subject, candle_key) DO NOTHING")
      .bind(c.subject, candleKey, c.agent, c.item?.item_id ?? null, c.item?.version ?? null, c.arm, statementClose, row.stance, row.bias, row.confidence, c.control_stance ?? null, row.status, row.model, new Date(clock()).toISOString()).run();
    out.stored += 1;
  }
  return out;
}

/** Sweep step: scores the stored shadow answers and their controls once the horizon has closed, on the H1 bars. */
export async function scoreShadowKnowledge(env, { now = Date.now() } = {}) {
  if (!env?.DB) return { status: "unavailable" };
  await ensureSchema(env.DB);
  const pending = (await env.DB.prepare("SELECT subject, candle_key, statement_close, stance, control_stance FROM shadow_agent_outputs WHERE status = 'ok' AND scored_at IS NULL ORDER BY statement_close LIMIT 200").all()).results || [];
  if (!pending.length) return { status: "ok", scored: 0 };
  // Each row on its own chart's bars: the 1H rooms on the 1H series, the 15m War Room and the council on 15m.
  const seriesOf = async (interval) => {
    try {
      const record = JSON.parse((await env.SIGNAL_CACHE?.get?.(`market-data:v2:series:OANDA:XAUUSD|${interval}`)) || "null");
      return (Array.isArray(record?.candles) ? record.candles : []).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close_time && Date.parse(c.close_time) <= now).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
    } catch { return []; }
  };
  const series = { "60": await seriesOf("1h"), "15": pending.some((r) => chartOfSubject(r.subject) === "15") ? await seriesOf("15m") : [] };
  const at = new Date(now).toISOString();
  const final = (r) => (["pending", "no_data", "not_scored"].includes(r) ? null : r);
  let scored = 0;
  for (const r of pending) {
    const closeMs = Date.parse(r.statement_close);
    const bars = series[chartOfSubject(r.subject)];
    const mine = final(scoreStance({ stance: r.stance, bars, closeMs }).result);
    const ctrl = r.control_stance ? final(scoreStance({ stance: r.control_stance, bars, closeMs }).result) : null;
    if (!mine || (r.control_stance && !ctrl)) continue;
    await env.DB.prepare("UPDATE shadow_agent_outputs SET result = ?, control_result = ?, scoring_version = ?, scored_at = ? WHERE subject = ? AND candle_key = ?").bind(mine, ctrl, SCORING_VERSION, at, r.subject, r.candle_key).run();
    scored += 1;
  }
  return { status: "ok", scored };
}

/** Sweep step: drops shadow answers older than 60 days. */
export async function pruneShadowKnowledge(env, { now = Date.now(), days = 60 } = {}) {
  if (!env?.DB) return { status: "unavailable" };
  await ensureSchema(env.DB);
  await env.DB.prepare("DELETE FROM shadow_agent_outputs WHERE statement_close < ?").bind(new Date(now - days * 86_400_000).toISOString()).run();
  return { status: "ok" };
}

/** Pure: the comparison per shadow subject against the agent's real opening on the same bars (rows of shadow_agent_outputs). */
export function compareShadowKnowledge(outputs = [], { now = Date.now() } = {}) {
  const ok = outputs.filter((o) => o.status === "ok");
  const aa = ok.filter((o) => o.arm === "aa" && o.control_stance);
  const aaChanged = aa.filter((o) => o.stance !== o.control_stance).length;
  const subjects = [...new Set(outputs.filter((o) => o.arm !== "aa").map((o) => o.subject))];
  const entries = subjects.map((subject) => {
    const rows = outputs.filter((o) => o.subject === subject).sort((a, b) => String(a.statement_close).localeCompare(String(b.statement_close)));
    const pairs = rows.filter((o) => o.status === "ok" && o.result && o.control_result).map((o) => [{ stance: o.stance, result: o.result }, { stance: o.control_stance, result: o.control_result }]);
    const cut = Math.max(0, pairs.length - HOLDOUT_BARS);
    const all = pairedTally(pairs), discovery = pairedTally(pairs.slice(0, cut)), holdout = pairedTally(pairs.slice(cut));
    return {
      subject, agent: rows[0]?.agent ?? null, chart: chartOfSubject(subject), item_id: rows[0]?.item_id ?? null, item_version: rows[0]?.item_version ?? null,
      calls: rows.length, answered: rows.filter((o) => o.status === "ok").length,
      same_bars: pairs.length, changed_stance: pairs.filter(([a, b]) => a.stance !== b.stance).length,
      paired: { candidate_better: all.candidate_better, control_better: all.control_better, p_value: all.p_value, significance: SHADOW_SIGNIFICANCE },
      discovery: { ...discovery, p_holm: null }, holdout: { ...holdout, required_bars: HOLDOUT_BARS, complete: holdout.bars >= HOLDOUT_BARS },
      criteria: { minimum_sample: discovery.bars >= SHADOW_MIN_SAMPLE, higher_outcome_score: null, holdout_no_worse: null },
      verdict: "collecting"
    };
  });
  const live = entries.filter((k) => k.criteria.minimum_sample);
  const adjusted = holmAdjust(live.map((k) => k.discovery.p_value));
  live.forEach((k, i) => { k.discovery.p_holm = adjusted[i]; });
  for (const k of live) {
    const d = k.discovery, h = k.holdout;
    k.criteria.higher_outcome_score = d.accuracy !== null && d.control_accuracy !== null ? d.accuracy > d.control_accuracy && d.p_holm !== null && d.p_holm < SHADOW_SIGNIFICANCE : null;
    k.criteria.holdout_no_worse = h.complete && (h.accuracy !== null && h.control_accuracy !== null ? h.accuracy >= h.control_accuracy : h.candidate_better >= h.control_better);
    k.verdict = k.criteria.higher_outcome_score !== true ? "not_better" : k.criteria.holdout_no_worse ? "better_than_active: ready for owner review" : "holdout_failed";
  }
  return {
    version: SHADOW_KNOWLEDGE_VERSION, family: "knowledge", name: "Learned notes (shadow agent calls)",
    // O13: how often the same prompt, asked again without a note, changes the agent's stance.
    aa_noise: { bars: aa.length, changed: aaChanged, rate: aa.length ? Math.round((aaChanged / aa.length) * 1000) / 1000 : null },
    holm: { month: holmMonth(now), alpha: SHADOW_SIGNIFICANCE, tests: adjusted.filter((p) => p !== null).length, live: live.map((k) => k.subject) },
    candidates: entries
  };
}

const OUTPUTS_SQL = "SELECT subject, candle_key, agent, item_id, item_version, arm, statement_close, stance, control_stance, status, result, control_result FROM shadow_agent_outputs WHERE statement_close >= ?";

/** Read model for /api/tuning (replays.knowledge). */
export async function readShadowKnowledge(env, { now = Date.now(), days = 60 } = {}) {
  await ensureSchema(env.DB);
  const since = new Date(now - days * 86_400_000).toISOString();
  const outputs = (await env.DB.prepare(OUTPUTS_SQL).bind(since).all()).results || [];
  return { enabled: shadowKnowledgeEnabled(env), max_calls_per_hour: maxCallsPerHour(env), ...compareShadowKnowledge(outputs, { now }) };
}

// ------------------------------------------------------------------ self-judging (KA1)
//
// Owner 2026-11-24 (relayed by the orchestrator): "buka arm, biarkan system menilai dirinya sendiri". An item that
// reaches a final verdict leaves the queue by itself and frees its slot:
//   better          goes live through src/learned-live.mjs runLearnedPromotion (unchanged; it runs first);
//   not_better      the discovery slice is not better (accuracy or Holm-adjusted sign test);
//   holdout_failed  better in discovery, worse in the newest HOLDOUT_BARS bars;
//   worse           the control is significantly better: the reverse one-sided sign test on the discovery slice,
//                   Holm-adjusted over the same family, below SHADOW_SIGNIFICANCE;
// each of the last three is recorded in D1 learned_live as 'retired' (closeShadowItems) with the evidence (counts and
// p only), so promotedKeys skips it and that version is never tested again. A subject below the minimum sample
// (SHADOW_MIN_SAMPLE discovery bars, i.e. HOLDOUT_BARS more scored pairs) is still collecting. An item is judged on
// its first final subject, like a promotion (the first better subject promotes it and stops the others): one look
// at the fixed sample, never a second chance on more bars. Runs only with SHADOW_KNOWLEDGE_ENABLED.

export const CLOSURE_VERSION = "cryptophys.knowledge-closure.v1";
/** The one-shot settle of the items the arm tested until #492 (2026-11-19), on the rows stored before it stopped. */
export const SHADOW_SETTLE = Object.freeze({ key: "shadow-knowledge:settle:v1", until: "2026-11-20T00:00:00.000Z" });
const CLOSING = ["worse", "holdout_failed", "not_better"];

/**
 * Pure: every item of the stored rows with its outcome ("live" when a subject is better, "retired" with a reason on a
 * final verdict, "collecting" otherwise) and the evidence per subject. `done` holds the versions learned_live already
 * has (live or retired): they are reported, never closed again. `packItems` lends the closure its item.
 */
export function planShadowClosures(outputs = [], { now = Date.now(), done = new Set(), packItems = [] } = {}) {
  const view = compareShadowKnowledge(outputs, { now });
  const family = view.candidates.filter((k) => k.criteria.minimum_sample);
  const worseP = family.map((k) => signTestP(k.discovery.control_better, k.discovery.candidate_better));
  const worseHolm = holmAdjust(worseP);
  const worse = new Map(family.map((k, i) => [k.subject, { p: worseP[i], p_holm: worseHolm[i] }]));
  const ok = outputs.filter((o) => o.status === "ok");
  const outcomeOf = (k) => {
    if (!k.criteria.minimum_sample) return "collecting";
    if (String(k.verdict).startsWith("better_than_active")) return "better";
    const w = worse.get(k.subject);
    if (k.discovery.control_better > k.discovery.candidate_better && w?.p_holm != null && w.p_holm < SHADOW_SIGNIFICANCE) return "worse";
    return k.verdict === "holdout_failed" ? "holdout_failed" : "not_better";
  };
  const evidenceOf = (k) => {
    const scored = ok.filter((o) => o.subject === k.subject && o.result && o.control_result);
    const aa = ok.filter((o) => o.arm === "aa" && o.control_stance && o.agent === k.agent && chartOfSubject(o.subject) === k.chart);
    const w = worse.get(k.subject);
    return {
      subject: k.subject, agent: k.agent, chart: k.chart, outcome: outcomeOf(k),
      rows: k.calls, scored: k.same_bars, treat_hits: scored.filter((o) => o.result === "hit").length, control_hits: scored.filter((o) => o.control_result === "hit").length,
      changed_stance: k.changed_stance,
      discovery: { bars: k.discovery.bars, candidate_better: k.discovery.candidate_better, control_better: k.discovery.control_better },
      holdout: { bars: k.holdout.bars, candidate_better: k.holdout.candidate_better, control_better: k.holdout.control_better },
      p_value: k.discovery.p_value ?? null, p_holm: k.discovery.p_holm ?? null, p_value_worse: w?.p ?? null, p_holm_worse: w?.p_holm ?? null,
      aa: { changed: aa.filter((o) => o.stance !== o.control_stance).length, total: aa.length }
    };
  };
  const byItem = new Map();
  for (const k of view.candidates) {
    if (!k.item_id || !Number.isInteger(Number(k.item_version))) continue;
    const key = `${k.item_id}@${Number(k.item_version)}`;
    byItem.set(key, [...(byItem.get(key) || []), evidenceOf(k)]);
  }
  const inPack = new Map(packItems.map((it) => [`${it.item_id}@${it.version}`, it]));
  const items = [...byItem].sort(([a], [b]) => a.localeCompare(b)).map(([key, subjects]) => {
    const [item_id, version] = [key.slice(0, key.lastIndexOf("@")), Number(key.slice(key.lastIndexOf("@") + 1))];
    const finals = subjects.filter((s) => s.outcome !== "collecting");
    const reason = subjects.some((s) => s.outcome === "better") ? null : CLOSING.find((r) => finals.some((s) => s.outcome === r)) ?? null;
    const outcome = subjects.some((s) => s.outcome === "better") ? "live" : reason ? "retired" : "collecting";
    return {
      key, item_id, version, outcome, reason, already: done.has(key), item: inPack.get(key) ?? null,
      evidence: { schema: CLOSURE_VERSION, item_id, version, outcome, reason, judged_at: new Date(now).toISOString(), subjects }
    };
  });
  // KA2 (src/knowledge-verdicts.mjs): each subject's first and last bar, kept apart from the closure evidence so the
  // learned_live rows stay as KA1 writes them.
  const windows = {};
  for (const o of outputs) {
    const t = Date.parse(o?.statement_close);
    if (!o?.subject || !Number.isFinite(t)) continue;
    const w = windows[o.subject] ??= { start: t, end: t };
    if (t < w.start) w.start = t;
    if (t > w.end) w.end = t;
  }
  for (const w of Object.values(windows)) { w.start = new Date(w.start).toISOString(); w.end = new Date(w.end).toISOString(); }
  return { version: CLOSURE_VERSION, items, windows };
}

// ------------------------------------------------------------------ idle items (KA3)
//
// An item whose agent no longer opens in its room (benched by the neuron allocation, gone from the roster, or its
// openings fail) gets no shadow call, never reaches a verdict and stays in the queue for good. KA3 closes it as
// 'retired', reason shadow:not_tested, through the same closeShadowItems path (KA2 then posts not_tested with rule
// untestable.agent_inactive). "Idle for 72h while the arm is on" is read from the arm's own call log, the stored rows:
//   idle since   the item's newest shadow_agent_outputs row (any subject, any status), or when the pack first carried it
//                if it has none in the 60-day window;
//   an hour      counts when, after that, the arm stored a note row on a bar of a room the item can be tested in (its
//                charts; the council apart from the rooms) for an item that ranks AFTER it in the queue (first seen,
//                then id: shadowItems' order). planShadowCalls and runShadowCalls serve the items in that order, so on
//                that bar the arm was on, the room met, the slots and the hourly budget reached past this item, and it
//                still got no call: none of its agents was in the roster or answered;
//   closes       at IDLE_RULES.active_hours such hours. With the arm off, the kill switch or the breaker on, the market
//                closed or the room down, no row is stored and no hour counts; a queue-mate that ranks earlier proves
//                nothing (it may have taken the last slot or the budget), so it never counts.
// Never closed: a version learned_live already has (live or retired), an item KA1 can judge (a final outcome in the
// plan, or a subject with the rows for the sample once scored), an item no shadow call can ever test (KA2 posts it
// not_tested by its own rule), an item not in the stored pack (it holds no slot). Counts and ids only.

export const IDLE_RULES = Object.freeze({ active_hours: 72, reason: "not_tested", rule: "untestable.agent_inactive" });
const HOUR_MS = 3_600_000;
const roomKey = (chart, agent) => `${chart}:${agent === "council" ? "council" : "room"}`;

/** Pure: the idle items to close now, in key order, shaped like planShadowClosures' items (outcome retired, reason not_tested). */
export function planIdleClosures(outputs = [], { now = Date.now(), packItems = [], firstSeen = {}, done = new Set(), plan = null, rules = IDLE_RULES } = {}) {
  const keyOf = (id, v) => `${id}@${Number(v)}`;
  const idOf = (k) => k.slice(0, k.lastIndexOf("@"));
  const seenIso = (k) => String(firstSeen?.[k] ?? "");
  // shadowItems' order: first seen, then id.
  const after = (w, x) => (seenIso(w).localeCompare(seenIso(x)) || idOf(w).localeCompare(idOf(x))) > 0;
  const bars = new Map();
  const mine = new Map();
  for (const o of outputs) {
    const t = Date.parse(o?.statement_close);
    if (!o?.item_id || o.arm === "aa" || !Number.isFinite(t) || !Number.isInteger(Number(o.item_version))) continue;
    const k = keyOf(o.item_id, o.item_version);
    mine.set(k, [...(mine.get(k) || []), o]);
    const room = roomKey(chartOfSubject(o.subject), o.agent);
    const perBar = bars.get(room) ?? new Map();
    bars.set(room, perBar);
    perBar.set(t, [...(perBar.get(t) || []), k]);
  }
  const planned = new Map((plan?.items || []).map((i) => [i.key, i]));
  const sample = SHADOW_MIN_SAMPLE + HOLDOUT_BARS;
  const out = [];
  const seenKeys = new Set();
  for (const it of packItems) {
    if (!TEXT_KINDS.has(it?.kind) || typeof it.text !== "string" || !it.text.trim() || !Number.isInteger(it.version)) continue;
    const k = keyOf(it.item_id, it.version);
    if (seenKeys.has(k) || done.has(k) || untestableReason(it)) continue;
    seenKeys.add(k);
    const p = planned.get(k);
    if (p && p.outcome !== "collecting") continue;
    const rows = mine.get(k) || [];
    const okBySubject = new Map();
    for (const o of rows) if (o.status === "ok") okBySubject.set(o.subject, (okBySubject.get(o.subject) || 0) + 1);
    if ([...okBySubject.values()].some((n) => n >= sample)) continue;
    const times = rows.map((o) => Date.parse(o.statement_close));
    const last = times.length ? Math.max(...times) : null;
    const seen = Date.parse(seenIso(k));
    const since = Math.max(last ?? -Infinity, Number.isFinite(seen) ? seen : -Infinity);
    if (!Number.isFinite(since)) continue;
    const testers = (it.audience?.agents || []).map(String).filter((a) => a !== "moderator" && !OUTSIDE_ROOMS.has(a));
    const listed = Array.isArray(it.audience?.charts) ? it.audience.charts.map(String).filter((c) => SHADOW_CODES.has(c)) : [];
    const charts = listed.length ? [...new Set(listed)].sort() : [...SHADOW_CODES].sort();
    const rooms = new Set();
    for (const c of charts) {
      if (testers.some((a) => a !== "council")) rooms.add(roomKey(c, "agent"));
      if (c === "15" && testers.includes("council")) rooms.add(roomKey(c, "council"));
    }
    const hours = new Set();
    for (const room of rooms) {
      for (const [t, keys] of bars.get(room) || []) {
        if (t > since && t <= now && keys.some((w) => w !== k && after(w, k))) hours.add(Math.floor(t / HOUR_MS));
      }
    }
    if (hours.size < rules.active_hours) continue;
    const subjects = (p?.evidence?.subjects || []).map((s) => ({ ...s, outcome: rules.reason }));
    const sum = (f) => subjects.reduce((n, s) => n + (Number.isInteger(s[f]) ? s[f] : 0), 0);
    const iso = (ms) => new Date(ms).toISOString();
    out.push({
      key: k, item_id: it.item_id, version: it.version, outcome: "retired", reason: rules.reason, already: false, item: it,
      evidence: {
        schema: CLOSURE_VERSION, item_id: it.item_id, version: it.version, outcome: "retired", reason: rules.reason, rule: rules.rule, judged_at: iso(now),
        idle: { since: iso(since), last_row: last === null ? null : iso(last), first_seen: Number.isFinite(seen) ? iso(seen) : null, active_hours: hours.size, required_hours: rules.active_hours, agents: testers, charts },
        rows: rows.length, scored: sum("scored"),
        window_start: times.length ? iso(Math.min(...times)) : null, window_end: last === null ? null : iso(last),
        subjects
      }
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Pure: the owner's Telegram line for the items closed in one run (null when none). Counts and p only. */
export function closureMessage(closed = []) {
  if (!closed.length) return null;
  const lines = ["🧠 Learned notes (judged in shadow)"];
  for (const c of closed) {
    if (c.reason === IDLE_RULES.reason) {
      const e = c.evidence;
      lines.push(`− closed: ${c.item_id} v${c.version}: not tested (${(e.idle.agents || []).join(", ") || "its agent"} no longer opens in its room: no shadow call for ${e.idle.active_hours} hours of the arm running; ${e.rows} rows, ${e.scored} scored).`);
      continue;
    }
    const s = c.evidence.subjects.filter((x) => x.outcome === c.reason)[0] ?? c.evidence.subjects[0];
    lines.push(`− closed: ${c.item_id} v${c.version}: ${c.reason} (${s.agent} on ${s.chart === "15" ? "15m" : "1H"}: ${s.scored} scored, note ${s.treat_hits} vs control ${s.control_hits} hits; on changed bars ${s.discovery.candidate_better} vs ${s.discovery.control_better}, p_holm ${s.p_holm ?? "?"}).`);
  }
  return lines.join("\n");
}

/**
 * Hourly sweep step, after runLearnedPromotion: closes the items with a final verdict other than better. The first run
 * settles the items tested until #492 on their rows stored before SHADOW_SETTLE.until (one-shot, KV SIGNAL_CACHE
 * SHADOW_SETTLE.key, written only here; the marker keeps the report); every run then judges all stored rows by the
 * same rule. Off unless SHADOW_KNOWLEDGE_ENABLED: with the arm off nothing is read or written. Never throws.
 */
export async function runShadowClosures(env, { now = Date.now(), days = 60, settle = SHADOW_SETTLE } = {}) {
  if (!shadowKnowledgeEnabled(env)) return { status: "disabled" };
  if (!env?.DB) return { status: "unavailable" };
  try {
    await ensureSchema(env.DB);
    const since = new Date(now - days * 86_400_000).toISOString();
    let packItems = [], firstSeen = {};
    try { const stored = await storedPack(env); packItems = stored?.pack?.items || []; firstSeen = stored?.firstSeen || {}; } catch { packItems = []; firstSeen = {}; }
    const judge = async (until) => {
      const rows = (await (until ? env.DB.prepare(`${OUTPUTS_SQL} AND created_at < ?`).bind(since, until) : env.DB.prepare(OUTPUTS_SQL).bind(since)).all()).results || [];
      const plan = planShadowClosures(rows, { now, done: await promotedKeys(env), packItems });
      const closed = await closeShadowItems(env, plan.items.filter((i) => i.outcome === "retired" && !i.already), { now });
      return { plan, closed, rows };
    };
    const out = { status: "ok", closed: [], settle: null };
    const kv = env.SIGNAL_CACHE;
    if (typeof kv?.get === "function" && typeof kv?.put === "function" && !(await kv.get(settle.key))) {
      const { plan, closed } = await judge(settle.until);
      const count = (o) => plan.items.filter((i) => i.outcome === o).length;
      const report = {
        at: new Date(now).toISOString(), until: settle.until, items: plan.items.length, live: count("live"), retired: count("retired"), collecting: count("collecting"),
        closed: closed.map((c) => c.key),
        per_item: plan.items.map((i) => ({ key: i.key, outcome: i.outcome, reason: i.reason, subjects: i.evidence.subjects.map((s) => ({ agent: s.agent, chart: s.chart, outcome: s.outcome, scored: s.scored })) }))
      };
      await kv.put(settle.key, JSON.stringify(report), { expirationTtl: 90 * 86_400 });
      out.settle = report;
      out.closed.push(...closed);
    }
    const { plan, closed, rows } = await judge(null);
    out.closed.push(...closed);
    // KA3: the items whose agent no longer opens in their room (idle 72 hours of the arm running), after KA1's verdicts.
    const idle = await closeShadowItems(env, planIdleClosures(rows, { now, packItems, firstSeen, done: await promotedKeys(env), plan }), { now });
    out.closed.push(...idle);
    const idleKeys = new Set(idle.map((c) => c.key));
    out.collecting = plan.items.filter((i) => i.outcome === "collecting" && !idleKeys.has(i.key)).length;
    const result = { ...out, closed: out.closed.map((c) => c.key), message: closureMessage(out.closed) };
    // The whole-row plan, for the verdict posts (KA2, src/knowledge-verdicts.mjs). Not enumerable: logs never show it.
    Object.defineProperty(result, "plan", { enumerable: false, value: plan });
    return result;
  } catch (e) { return { status: "failed", error: String(e?.message ?? e).slice(0, 200) }; }
}
