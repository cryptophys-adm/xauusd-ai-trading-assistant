// Aether phase A7, the shadow knowledge arm (RFC_AETHER_KNOWLEDGE_GUARDIAN §9.4, K6, O8, O13).
//
// For each approved text item of the learned pack (caution, role_reminder; at most MAX_ITEMS at once)
// whose audience includes an agent of the 1H room, that agent makes ONE extra opening call on the
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

import { storedPack } from "./aether-pack.mjs";
import { promotedKeys } from "./learned-live.mjs";
import { callBusModel } from "./multi-agent-bus.mjs";
import { SCORING_VERSION, scoreStance } from "./outcome-scoring.mjs";
import { pairedTally, holmAdjust, holmMonth, SHADOW_MIN_SAMPLE, SHADOW_SIGNIFICANCE, HOLDOUT_BARS } from "./shadow-versions.mjs";

export const SHADOW_KNOWLEDGE_VERSION = "cryptophys.shadow-knowledge.v1";
export const MAX_ITEMS = 2;
export const DEFAULT_MAX_CALLS_PER_HOUR = 8;
const TEXT_KINDS = new Set(["caution", "role_reminder"]);
const NOTE_MAX = 400;

export function shadowKnowledgeEnabled(env) { return String(env?.SHADOW_KNOWLEDGE_ENABLED ?? "").trim().toLowerCase() === "true"; }
export function maxCallsPerHour(env) {
  const n = Number(env?.SHADOW_KNOWLEDGE_MAX_CALLS_PER_HOUR ?? DEFAULT_MAX_CALLS_PER_HOUR);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 24) : DEFAULT_MAX_CALLS_PER_HOUR;
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

export const subjectOf = (agent, item) => (item ? `shadow-agent:${agent}@${item.item_id}v${item.version}` : `shadow-agent:${agent}@aa`);
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
  if (chart !== "H1") return [];
  const answered = new Map((openings || []).filter((m) => m?.status === "ok").map((m) => [String(m.agent ?? m.id), m.stance]));
  const text = (items || []).filter((it) => TEXT_KINDS.has(it?.kind) && typeof it.text === "string" && it.text.trim())
    .filter((it) => !Array.isArray(it.audience?.charts) || !it.audience.charts.length || it.audience.charts.includes("60"))
    .slice(0, MAX_ITEMS);
  const calls = [];
  text.forEach((item, i) => {
    for (const agent of item.audience?.agents || []) {
      if (agent === "moderator" || !roster.includes(agent) || !answered.has(agent)) continue;
      const control_stance = answered.get(agent);
      calls.push({ subject: subjectOf(agent, item), agent, item, arm: "note", control_stance });
      if (i === 0 && !calls.some((c) => c.arm === "aa" && c.agent === agent)) calls.push({ subject: subjectOf(agent, null), agent, item: null, arm: "aa", control_stance });
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
export async function runShadowCalls(env, { calls, candleKey, statementClose, messagesFor, validate, schema, schemaName = "tf_room_opening", maxTokens = 400, clock = () => Date.now(), deadlineMs = 60_000 } = {}) {
  if (!shadowKnowledgeEnabled(env) || !env?.DB || !calls?.length) return { status: shadowKnowledgeEnabled(env) ? "nothing_to_do" : "disabled" };
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
      const call = await callBusModel(env, { messages: messagesFor(c.agent, c.item ? noteLine(c.item) : null), schemaName, schema, maxTokens, effort: "low", deadline, clock, runState: { primaryError: null }, role: "agent" });
      if (call.status === "answered" && !call.truncated) {
        const v = validate(call.obj, c.agent);
        row = v.valid ? { stance: call.obj.stance, bias: call.obj.bias ?? null, confidence: call.obj.confidence ?? null, status: "ok", model: call.model } : { ...row, status: "invalid_output", model: call.model };
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
  let bars = [];
  try {
    const record = JSON.parse((await env.SIGNAL_CACHE?.get?.("market-data:v2:series:OANDA:XAUUSD|1h")) || "null");
    bars = (Array.isArray(record?.candles) ? record.candles : []).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close_time && Date.parse(c.close_time) <= now).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  } catch { bars = []; }
  const at = new Date(now).toISOString();
  const final = (r) => (["pending", "no_data", "not_scored"].includes(r) ? null : r);
  let scored = 0;
  for (const r of pending) {
    const closeMs = Date.parse(r.statement_close);
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
      subject, agent: rows[0]?.agent ?? null, item_id: rows[0]?.item_id ?? null, item_version: rows[0]?.item_version ?? null,
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

/** Read model for /api/tuning (replays.knowledge). */
export async function readShadowKnowledge(env, { now = Date.now(), days = 60 } = {}) {
  await ensureSchema(env.DB);
  const since = new Date(now - days * 86_400_000).toISOString();
  const outputs = (await env.DB.prepare("SELECT subject, candle_key, agent, item_id, item_version, arm, statement_close, stance, control_stance, status, result, control_result FROM shadow_agent_outputs WHERE statement_close >= ?").bind(since).all()).results || [];
  return { enabled: shadowKnowledgeEnabled(env), max_calls_per_hour: maxCallsPerHour(env), ...compareShadowKnowledge(outputs, { now }) };
}
