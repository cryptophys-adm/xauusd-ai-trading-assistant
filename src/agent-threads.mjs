// Phase 3 agent social view (docs/RFC_NEXUS_AGENT_SOCIAL.md).
//
// 1. News threads: every completed news analysis becomes a post; the news and
//    technical agents reply, then reply to each other, then a moderator posts
//    the consensus (nested via parent_id).
// 2. Live 5m room: on each closed 5m bar whose picture changed, a technical
//    and a risk agent post, then a moderator posts a one-line consensus.
//
// Both are shadow/advisory only. They never write into the H1 chain's
// evidence, prompts or decision. 5m is UNVERIFIED unless parity-approved on 5m (C0).

import { chatMessages } from "./model-text.mjs";
import { naturalLanguageErrors, NATURAL_LANGUAGE_RULE, NATURAL_LANGUAGE_CORRECTION, describeDegradedEvidence } from "./natural-language.mjs";
import { interpretWebhookRow } from "./webhook-interpretation.mjs";
import { verifiedM5Reading, M5_VERIFIED_LABEL, M5_UNVERIFIED_LABEL } from "./m5-verification.mjs";
import { HUD_IDS, HUD_NAMES, calibrationCounts } from "./hud-reading.mjs";
import { hudAgentsEnabled } from "./hud-agents.mjs";
import { loadHudSnapshot, hudReadings } from "./hud-store.mjs";
import {
  callBusModel, buildBusEvidence, validateAgentOutput, validateModeratorOutput,
  AGENT_JSON_SCHEMA, MODERATOR_JSON_SCHEMA, BUS_DEFAULT_MODEL, BUS_MAX_TOKENS, busEnabled
} from "./multi-agent-bus.mjs";

export const ROOM_STANCES = Object.freeze(["BUY", "SELL", "HOLD", "WAIT", "CLOSE"]);
export const THREAD_WALL_BUDGET_MS = 300_000;
export const LIVE_ROOM_WALL_BUDGET_MS = 150_000;
const INSIGHT_MAX = 600;
const SUMMARY_MAX = 1000;
const RAW_MAX = 2048;

export const THREAD_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS agent_threads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  title TEXT NOT NULL,
  post_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  "CREATE INDEX IF NOT EXISTS idx_agent_threads_kind ON agent_threads(kind, created_at)",
  `CREATE TABLE IF NOT EXISTS agent_thread_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step TEXT NOT NULL,
  parent_id INTEGER,
  agent TEXT NOT NULL,
  bar_time TEXT,
  ts TEXT NOT NULL,
  stance TEXT,
  confidence REAL,
  body_json TEXT NOT NULL,
  refs_json TEXT,
  model TEXT,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  fallback_used INTEGER DEFAULT 0,
  usage_tokens INTEGER,
  UNIQUE(thread_id, run_id, step)
)`,
  "CREATE INDEX IF NOT EXISTS idx_agent_thread_messages_thread ON agent_thread_messages(thread_id, id)"
];

const ROOM_AGENT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    agent: { type: "string", enum: ["technical", "risk"] },
    stance: { type: "string", enum: [...ROOM_STANCES] },
    confidence: { type: "number" },
    insight: { type: "string" },
    refs: { type: "array", items: { type: "string" } },
    responds_to: { type: ["string", "null"] }
  },
  required: ["agent", "stance", "confidence", "insight", "refs", "responds_to"]
});

const ROOM_MODERATOR_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    stance: { type: "string", enum: [...ROOM_STANCES] },
    confidence: { type: "number" },
    summary: { type: "string" }
  },
  required: ["stance", "confidence", "summary"]
});

export function liveRoomEnabled(env) {
  return String(env?.LIVE_ROOM_ENABLED ?? "false").trim().toLowerCase() === "true";
}

export function buildNewsThreadTask({ analysisKey, enqueuedAt = new Date().toISOString() } = {}) {
  if (typeof analysisKey !== "string" || !analysisKey.trim()) throw new TypeError("news thread task requires analysisKey");
  return { kind: "news_thread", event_id: `news_thread:${analysisKey}`, analysis_key: analysisKey, candle_key: `news:${analysisKey}`, enqueued_at: enqueuedAt };
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/** True when a 5m bar close time is also a 15m candle close (:00, :15, :30, :45 UTC). */
export function isFifteenMinuteClose(closeTime) {
  const ms = Date.parse(String(closeTime ?? ""));
  return Number.isFinite(ms) && ms % FIFTEEN_MINUTES_MS === 0;
}

/**
 * Complete 15m candles built from closed 5m bars ({ t: close time, o, h, l, c, v }).
 * A 15m candle is complete only when all three of its 5m bars are present.
 */
export function buildFifteenMinuteCandles(bars5m, { limit = 4 } = {}) {
  const buckets = new Map();
  for (const b of Array.isArray(bars5m) ? bars5m : []) {
    const t = Date.parse(String(b?.t ?? ""));
    if (!Number.isFinite(t)) continue;
    const close = Math.ceil(t / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;
    if (!buckets.has(close)) buckets.set(close, new Map());
    buckets.get(close).set(t, b);
  }
  const candles = [];
  for (const [close, byTime] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const bars = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    if (bars.length !== 3) continue;
    const vols = bars.map(b => (b.v == null ? NaN : Number(b.v))).filter(Number.isFinite);
    candles.push({
      close_time: new Date(close).toISOString(),
      o: Number(bars[0].o), h: Math.max(...bars.map(b => Number(b.h))), l: Math.min(...bars.map(b => Number(b.l))), c: Number(bars[2].c),
      v: vols.length === 3 ? vols.reduce((x, y) => x + y, 0) : null
    });
  }
  return candles.slice(-limit);
}

export function buildLiveRoomTask({ barTime, context = null, hud = null, enqueuedAt = new Date().toISOString() } = {}) {
  if (!Number.isFinite(Date.parse(String(barTime ?? "")))) throw new TypeError("live room task requires a valid barTime");
  const iso = new Date(Date.parse(barTime)).toISOString();
  // The 5m context and the 15m HUD snapshot travel inside the task, so the consumer
  // never depends on a KV read that may not have propagated to its location yet.
  return { kind: "live_room", event_id: `live_room:${iso}`, bar_time: iso, candle_key: `live15m:${iso}`, context, ...(hud ? { hud } : {}), enqueued_at: enqueuedAt };
}

/** Candle key of the 15m bar that closes at closeIso. */
export function m15KeyForClose(closeIso) {
  return `OANDA:XAUUSD:15:${Date.parse(closeIso) - FIFTEEN_MINUTES_MS}`;
}

let schemaReady = false;
export async function ensureThreadSchema(db) {
  if (schemaReady) return;
  for (const sql of THREAD_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}
export function resetThreadSchemaCacheForTests() { schemaReady = false; }

function parseJson(text, fallback = null) {
  if (typeof text !== "string" || !text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}
/**
 * Text shortened to at most `max` characters for storage and display. It ends at the last full
 * sentence that fits when that keeps at least half of the room, else at the last word with an
 * ellipsis: production stored summaries cut mid-word ("until the hourly chain confirms a d").
 */
function clip(value, max) {
  const s = String(value ?? "");
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), /[.!?]$/.test(head) ? head.length - 1 : -1);
  if (sentence >= max / 2) return head.slice(0, sentence + 1);
  const word = head.slice(0, max - 1).lastIndexOf(" ");
  return (word > 0 ? head.slice(0, word) : head.slice(0, max - 1)).replace(/[\s,;:]+$/, "") + "…";
}
function inUnit(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

const RULES = [
  "Advisory only: never produce entry, stop loss, take profit or position size, and never place or recommend executing an order. Stances are discussion positions, not orders.",
  "The H1 decision chain is authoritative. A local_computation engine counts as trusted only when its trust_status is approved_by_parity.",
  "5m data is UNVERIFIED 5m (informational only) unless it is labelled VERIFIED 5m, which means its Prophet and GMI implementations are parity-approved on the 5m chart.",
  "Back every claim with refs: JSON paths into the evidence object you were given.",
  NATURAL_LANGUAGE_RULE,
  "Return only one JSON object that matches the required schema."
].join("\n");

// Schemas without a refs field (moderators, HUD agents). Asked to "back every claim with
// refs" there, the model wrote the paths into its text ("refs: [h1.decision, agents[0]...]")
// and failed the natural-language check (preview-e2e, PR #95).
const RULES_NO_REFS = RULES.replace(
  "Back every claim with refs: JSON paths into the evidence object you were given.",
  "This answer has no refs field: never write refs, evidence paths, field names or JSON keys in your text. Name every source in plain words (for example \"the H1 decision\" or \"the Prophet HUD\")."
);

async function callsInLastHour(db, now, kindPrefix) {
  const cutoff = new Date(now - 60 * 60 * 1000).toISOString();
  const row = await db.prepare(
    "SELECT COALESCE(SUM(1 + COALESCE(fallback_used, 0) + COALESCE(json_extract(body_json, '$.corrections'), 0)), 0) AS n FROM agent_thread_messages WHERE ts >= ? AND status NOT IN ('budget_exhausted', 'skipped', 'info') AND thread_id LIKE ?"
  ).bind(cutoff, `${kindPrefix}:%`).first();
  const n = Number(row?.n);
  if (!Number.isFinite(n)) throw new Error("thread_budget_unavailable");
  return n;
}

async function upsertThread(db, { id, kind, refKey, title, post, now }) {
  const ts = new Date(now).toISOString();
  await db.prepare("INSERT OR IGNORE INTO agent_threads (id, kind, ref_key, title, post_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, kind, refKey, clip(title, 300), post ? JSON.stringify(post) : null, ts, ts).run();
  await db.prepare("UPDATE agent_threads SET updated_at = ? WHERE id = ?").bind(ts, id).run();
}

// A step is stored once per (thread, run, step). A stored ok message is final (idempotent
// redelivery). A stored failure (invalid_output, agent_failed, budget_exhausted, ...) is
// replaced by the retry's result, keeping its id so replies stay attached; before, the
// retry spent its calls and the failure stayed forever (preview-e2e, PR #95).
async function writeMessage(db, msg) {
  await db.prepare(
    "INSERT INTO agent_thread_messages (thread_id, run_id, step, parent_id, agent, bar_time, ts, stance, confidence, body_json, refs_json, model, status, latency_ms, fallback_used, usage_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(thread_id, run_id, step) DO UPDATE SET parent_id = excluded.parent_id, agent = excluded.agent, bar_time = excluded.bar_time, ts = excluded.ts, stance = excluded.stance, confidence = excluded.confidence, body_json = excluded.body_json, refs_json = excluded.refs_json, model = excluded.model, status = excluded.status, latency_ms = excluded.latency_ms, fallback_used = excluded.fallback_used, usage_tokens = excluded.usage_tokens " +
    "WHERE agent_thread_messages.status <> 'ok'"
  ).bind(
    msg.thread_id, msg.run_id, msg.step, msg.parent_id ?? null, msg.agent, msg.bar_time ?? null, msg.ts,
    msg.stance ?? null, msg.confidence ?? null, JSON.stringify(msg.body ?? {}), JSON.stringify(msg.refs ?? []),
    msg.model ?? null, msg.status, msg.latency_ms ?? null, msg.fallback_used ? 1 : 0, msg.usage_tokens ?? null
  ).run();
  const row = await db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id = ? AND run_id = ? AND step = ?").bind(msg.thread_id, msg.run_id, msg.step).first();
  return rowToThreadMessage(row);
}

export function rowToThreadMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    thread_id: row.thread_id,
    run_id: row.run_id,
    step: row.step,
    parent_id: row.parent_id ?? null,
    agent: row.agent,
    bar_time: row.bar_time ?? null,
    ts: row.ts,
    stance: row.stance ?? null,
    confidence: row.confidence ?? null,
    status: row.status,
    model: row.model ?? null,
    fallback_used: Number(row.fallback_used || 0) === 1,
    usage_tokens: row.usage_tokens ?? null,
    latency_ms: row.latency_ms ?? null,
    refs: parseJson(row.refs_json, []) || [],
    ...(parseJson(row.body_json, {}) || {})
  };
}

/** One model step → a stored message. Never throws for model/output problems. */
async function runStep(env, db, base, { messages, schemaName, schema, maxTokens, effort, deadline, clock, runState, validate, toBody, budgetOk }) {
  const ts = new Date(clock()).toISOString();
  if (!(await budgetOk())) {
    return writeMessage(db, { ...base, ts, status: "budget_exhausted", body: { insight: "budget exhausted" } });
  }
  const call = await callBusModel(env, { messages, schemaName, schema, maxTokens, effort, deadline, clock, runState });
  const meta = { model: call.model, fallback_used: call.fallback_used, usage_tokens: call.usage_tokens, latency_ms: call.latency_ms ?? null };
  const diag = call.primary_error ? { primary_error: call.primary_error } : {};
  if (call.status !== "answered") {
    return writeMessage(db, { ...base, ts, ...meta, status: call.status, body: { insight: call.status === "budget_exhausted" ? "budget exhausted" : "agent failed: " + (call.error || "error"), ...diag } });
  }
  let validation = call.truncated ? { valid: false, errors: ["finish_reason_length"] } : validate(call.obj);
  // An answer that is valid except that its text reads like code (a field name or key path), or a
  // conclusion that breaks a room rule (no support, no confirmation), gets one correction attempt.
  // The extra call is recorded in `corrections` and counted by the hourly budget; it never runs
  // without budget or past the wall deadline.
  let corrections = 0;
  let finalCall = call;
  const correction = !validation.valid && !call.truncated ? correctionFor(validation.errors) : null;
  if (correction && clock() < deadline && (await budgetOk())) {
    const retry = await callBusModel(env, {
      messages: [...messages, { role: "assistant", content: String(call.text ?? "") }, { role: "user", content: correction }],
      schemaName, schema, maxTokens, effort, deadline, clock, runState
    });
    corrections = 1 + (retry.fallback_used ? 1 : 0);
    meta.usage_tokens = sumOrNull(meta.usage_tokens, retry.usage_tokens);
    meta.latency_ms = sumOrNull(meta.latency_ms, retry.latency_ms);
    if (retry.status === "answered" && !retry.truncated) {
      const second = validate(retry.obj);
      if (second.valid) { validation = second; finalCall = retry; meta.model = retry.model; meta.fallback_used = meta.fallback_used || retry.fallback_used; }
    }
  }
  const extra = corrections ? { corrections } : {};
  if (!validation.valid) {
    return writeMessage(db, { ...base, ts, ...meta, status: "invalid_output", body: { insight: clip(call.text, RAW_MAX), errors: validation.errors, ...extra, ...diag } });
  }
  const { body, refs } = toBody(finalCall.obj);
  return writeMessage(db, { ...base, ts, ...meta, status: "ok", stance: finalCall.obj.stance, confidence: finalCall.obj.confidence, body: { ...body, ...extra, ...diag }, refs });
}

function sumOrNull(a, b) {
  const xs = [a, b].map(Number).filter(Number.isFinite);
  return xs.length ? xs.reduce((x, y) => x + y, 0) : null;
}

const CORRECTION_PROMPT = NATURAL_LANGUAGE_CORRECTION;

/** Rule errors a single correction call may fix, each with what to tell the model. */
const RULE_CORRECTIONS = Object.freeze({
  stance_without_support: "A BUY or SELL conclusion needs at least one agent on the bus or in the Consensus Discussion holding that stance; a confirmation alone never overrules the whole room.",
  entry_without_confirmation: "BUY or SELL needs the matching confirmation in the CONFIRMATIONS above; without it the stance is WAIT, or HOLD / CLOSE for a position already open.",
  bias_without_support: "A BULLISH or BEARISH bias needs at least one agent on the bus or in the Consensus Discussion holding that bias; otherwise the bias is NEUTRAL or the side the agents actually lean."
});

/**
 * The correction request for a rejected answer, or null when its errors are not correctable:
 * text that reads like code, or a conclusion that breaks a room rule (owner decision 2026-11-06).
 */
function correctionFor(errors) {
  if (!Array.isArray(errors) || !errors.length) return null;
  const rules = errors.filter((e) => RULE_CORRECTIONS[e]);
  const wording = errors.filter((e) => String(e).startsWith("not_natural_language:"));
  if (rules.length + wording.length !== errors.length) return null;
  if (!rules.length) return CORRECTION_PROMPT;
  return "Your answer was rejected: " + rules.map((e) => RULE_CORRECTIONS[e]).join(" ") +
    " Return the JSON again with a stance that obeys these rules (WAIT when the room does not support an entry), and rewrite the summary and reasons to match." +
    (wording.length ? " " + CORRECTION_PROMPT : "");
}

// ---------------------------------------------------------------- news thread

function newsPost(row) {
  const evidence = parseJson(row.evidence_json, {}) || {};
  const recommendation = parseJson(row.recommendation_json, {}) || {};
  const articles = Array.isArray(evidence.articles) ? evidence.articles : [];
  const headlines = articles.slice(0, 8).map(a => clip(a?.title ?? a?.headline ?? "", 200)).filter(Boolean);
  return {
    analysis_key: row.analysis_key,
    analyzed_at: row.analyzed_at,
    fetched_at: row.fetched_at,
    article_count: Number(row.article_count) || 0,
    headlines,
    recommendation: {
      stance: recommendation.stance ?? recommendation.recommendation ?? recommendation.bias ?? null,
      confidence: recommendation.confidence ?? null,
      summary: clip(recommendation.summary ?? recommendation.reasoning ?? "", 600)
    },
    reasoner_excerpt: clip(row.reasoner_output, 800)
  };
}

function newsAgentMessages(agent, round, post, technical, others) {
  const role = agent === "news"
    ? "You are the fundamental news analyst agent in an XAUUSD forum thread about one news analysis."
    : "You are the technical analyst agent in an XAUUSD forum thread about one news analysis. Judge how the news fits the current H1 technical evidence.";
  const evidence = { post, technical };
  return chatMessages([
    role,
    RULES,
    `Round ${round} of 2.`,
    round === 1
      ? "Reply to the post with your stance on XAUUSD given this news."
      : "Reply to the other agent's round-1 message below: agree or dispute it with reasons, set responds_to to that agent's name, and give your updated stance.",
    `Required JSON: {"agent":"${agent}","round":${round},"stance":"BUY|SELL|WAIT","confidence":0..1,"insight":"<= ${INSIGHT_MAX} chars","refs":["..."],"responds_to":${round === 1 ? "null" : "\"<agent>\""}}`,
    "EVIDENCE:",
    JSON.stringify(evidence),
    ...(round > 1 ? ["OTHER AGENT (round 1):", JSON.stringify(others)] : [])
  ]);
}

function newsModeratorMessages(post, technical, transcript) {
  return chatMessages([
    "You are the moderator of an XAUUSD forum thread about one news analysis.",
    RULES_NO_REFS,
    "Summarise the thread into one consensus. agreed is true only when both round-2 replies share a stance. List disagreements in dissent.",
    `Required JSON: {"stance":"BUY|SELL|WAIT","confidence":0..1,"agreed":true|false,"summary":"<= ${SUMMARY_MAX} chars","dissent":["..."]}`,
    "H1 CHAIN DECISION (read-only, authoritative): " + JSON.stringify(technical.h1_chain_decision),
    "POST: " + JSON.stringify({ headlines: post.headlines, recommendation: post.recommendation }),
    "THREAD:",
    JSON.stringify(transcript.map(m => ({ agent: m.agent, step: m.step, status: m.status, stance: m.stance, confidence: m.confidence, insight: m.insight })))
  ]);
}

export async function runNewsThread(env, task, { clock = () => Date.now() } = {}) {
  if (!busEnabled(env)) return { status: "disabled", calls: 0 };
  const db = env.DB;
  await ensureThreadSchema(db);
  const analysisKey = String(task.analysis_key);
  const row = await db.prepare("SELECT * FROM news_analyses WHERE analysis_key = ?").bind(analysisKey).first();
  if (!row) return { status: "no_news_analysis", calls: 0 };
  const post = newsPost(row);
  const threadId = `news:${analysisKey}`;
  await upsertThread(db, { id: threadId, kind: "news", refKey: analysisKey, title: post.headlines[0] || `News analysis ${analysisKey.slice(0, 12)}`, post, now: clock() });

  const synth = await db.prepare("SELECT candle_key, ai_analysis, prophet_metrics, gmi_metrics FROM ai_syntheses ORDER BY id DESC LIMIT 1").first();
  const technical = buildBusEvidence(synth || {}).technical;

  const existing = new Map(((await db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id = ? AND run_id = ?").bind(threadId, analysisKey).all()).results || []).map(r => [r.step, rowToThreadMessage(r)]));
  if (existing.has("moderator")) return { status: "already_complete", calls: 0 };

  const deadline = clock() + THREAD_WALL_BUDGET_MS;
  const maxPerHour = Number(env.MULTI_AGENT_MAX_CALLS_PER_HOUR ?? 20);
  const runState = { primaryError: null };
  let calls = 0;
  const budgetOk = async () => {
    if (clock() >= deadline) return false;
    try { return (await callsInLastHour(db, clock(), "news")) < (Number.isFinite(maxPerHour) ? maxPerHour : 0); } catch { return false; }
  };
  const counted = (fn) => async (...args) => { calls += 1; return fn(...args); };
  const step = counted((base, opts) => runStep(env, db, base, { ...opts, deadline, clock, runState, budgetOk }));
  const agentToBody = (obj) => ({ body: { insight: clip(obj.insight, INSIGHT_MAX), responds_to: obj.responds_to ?? null }, refs: obj.refs.slice(0, 12).map(r => clip(r, 200)) });

  const msgs = {};
  for (const agent of ["news", "technical"]) {
    const key = `r1:${agent}`;
    msgs[key] = existing.get(key) || await step({ thread_id: threadId, run_id: analysisKey, step: key, agent, parent_id: null }, {
      messages: newsAgentMessages(agent, 1, post, technical, null), schemaName: "thread_agent", schema: AGENT_JSON_SCHEMA,
      maxTokens: BUS_MAX_TOKENS.agent, effort: "low", validate: (o) => validateAgentOutput(o, { agent, round: 1 }), toBody: agentToBody
    });
  }
  for (const agent of ["news", "technical"]) {
    const key = `r2:${agent}`;
    const other = msgs[`r1:${agent === "news" ? "technical" : "news"}`];
    msgs[key] = existing.get(key) || await step({ thread_id: threadId, run_id: analysisKey, step: key, agent, parent_id: other?.id ?? null }, {
      messages: newsAgentMessages(agent, 2, post, technical, other && other.status === "ok" ? { agent: other.agent, stance: other.stance, confidence: other.confidence, insight: other.insight } : null),
      schemaName: "thread_agent", schema: AGENT_JSON_SCHEMA, maxTokens: BUS_MAX_TOKENS.agent, effort: "low",
      validate: (o) => validateAgentOutput(o, { agent, round: 2 }), toBody: agentToBody
    });
  }
  const transcript = ["r1:news", "r1:technical", "r2:news", "r2:technical"].map(k => msgs[k]).filter(Boolean);
  await step({ thread_id: threadId, run_id: analysisKey, step: "moderator", agent: "moderator", parent_id: null }, {
    messages: newsModeratorMessages(post, technical, transcript), schemaName: "thread_moderator", schema: MODERATOR_JSON_SCHEMA,
    maxTokens: BUS_MAX_TOKENS.moderator, effort: "high", validate: validateModeratorOutput,
    toBody: (obj) => ({ body: { agreed: obj.agreed, summary: clip(obj.summary, SUMMARY_MAX), dissent: obj.dissent.map(d => clip(d, 300)).slice(0, 10) }, refs: [] })
  });
  return { status: "complete", calls };
}

// ---------------------------------------------------------------- live room

function validateRoomAgent(obj, agent) {
  const errors = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { valid: false, errors: ["not_an_object"] };
  if (obj.agent !== agent) errors.push("agent_mismatch");
  if (!ROOM_STANCES.includes(obj.stance)) errors.push("stance_invalid");
  if (!inUnit(obj.confidence)) errors.push("confidence_out_of_range");
  if (typeof obj.insight !== "string" || !obj.insight.trim()) errors.push("insight_missing");
  if (!Array.isArray(obj.refs) || !obj.refs.length || obj.refs.some(r => typeof r !== "string" || !r.trim())) errors.push("refs_missing");
  errors.push(...naturalLanguageErrors(obj.insight));
  return { valid: errors.length === 0, errors };
}

/** The moderator must name the authoritative H1 decision whenever its stance differs from it. */
export function validateRoomModerator(obj, h1Decision) {
  const errors = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { valid: false, errors: ["not_an_object"] };
  if (!ROOM_STANCES.includes(obj.stance)) errors.push("stance_invalid");
  if (!inUnit(obj.confidence)) errors.push("confidence_out_of_range");
  if (typeof obj.summary !== "string" || !obj.summary.trim()) errors.push("summary_missing");
  const h1 = String(h1Decision || "WAIT").toUpperCase();
  if (errors.length === 0 && obj.stance !== h1 && !new RegExp(`H1[^.]{0,40}${h1}`, "i").test(obj.summary)) errors.push("h1_reference_missing");
  if (typeof obj.summary === "string") errors.push(...naturalLanguageErrors(obj.summary));
  return { valid: errors.length === 0, errors };
}

function roomAgentMessages(agent, evidence, technicalMsg) {
  const role = agent === "technical"
    ? "You are the technical agent in a live XAUUSD trading room that meets at every 15m candle close. " +
      "First judge the closed 15m candles: that is the setup. Then use the 5m execution data from the local lane (the 5m read, labelled VERIFIED 5m or UNVERIFIED 5m, and the last 5m bars) for execution timing: is there an entry trigger now, or should an open position be held or closed? " +
      "The H1 TradingView reading (Prophet and GMI v12.70) is the higher-timeframe backdrop: say whether the 15m setup agrees with it. Call things by plain names such as \"the 15m candle\" or \"the H1 TradingView reading\", never by a field name."
    : "You are the risk agent in a live XAUUSD trading room that meets at every 15m candle close. Challenge the technical agent: where do the 15m setup or the 5m execution read conflict with the authoritative H1 decision or the news consensus? Prefer HOLD/WAIT when they do.";
  return chatMessages([
    role,
    RULES,
    "Room stances: BUY, SELL, HOLD (keep any existing position), WAIT (stay flat), CLOSE (exit an existing position). They are discussion positions only.",
    `Required JSON: {"agent":"${agent}","stance":"BUY|SELL|HOLD|WAIT|CLOSE","confidence":0..1,"insight":"<= 400 chars","refs":["..."],"responds_to":${agent === "risk" ? "\"technical\"" : "null"}}`,
    "EVIDENCE:",
    JSON.stringify(evidence),
    ...(technicalMsg ? ["TECHNICAL AGENT:", JSON.stringify({ stance: technicalMsg.stance, confidence: technicalMsg.confidence, insight: technicalMsg.insight })] : [])
  ]);
}

function roomModeratorMessages(evidence, transcript) {
  return chatMessages([
    "You are the moderator of a live XAUUSD trading room that meets at every 15m candle close.",
    RULES_NO_REFS,
    `Give one short consensus line. If your stance differs from the H1 decision (${evidence.h1.decision}), the summary must say "H1 decision: ${evidence.h1.decision}".`,
    `Required JSON: {"stance":"BUY|SELL|HOLD|WAIT|CLOSE","confidence":0..1,"summary":"<= 300 chars"}`,
    "EVIDENCE: " + JSON.stringify({ h1: evidence.h1, news: evidence.news, m15: evidence.m15.candles.at(-1) ?? null, m5: { bias: evidence.m5.bias, label: evidence.m5.label } }),
    "ROOM:",
    JSON.stringify(transcript.map(m => ({ agent: m.agent, status: m.status, stance: m.stance, confidence: m.confidence, insight: m.insight })))
  ]);
}

/**
 * The live room's evidence for the 15m close barTime: the closed 15m candles, the 5m execution
 * read (VERIFIED 5m only while parity-approved), the latest H1 decision and the news consensus.
 * Returns { evidence } or { status } when the bar is stale; throws RetryableError while the 5m
 * context of this bar is not visible yet. Shared by the live room and the War Room.
 */
export async function liveEvidence(env, task, barTime) {
  const db = env.DB;
  const kv = env.SIGNAL_CACHE;
  const fromTask = task.context && typeof task.context === "object" ? task.context : null;
  const m5Raw = fromTask || parseJson(await kv?.get?.("context:m5:latest"), null);
  const m5At = Date.parse(m5Raw?.candle_time ?? "");
  if (!Number.isFinite(m5At)) throw Object.assign(new Error("m5 context not visible yet"), { name: "RetryableError" });
  if (m5At < Date.parse(barTime)) throw Object.assign(new Error("m5 context not visible yet"), { name: "RetryableError" });
  if (new Date(m5At).toISOString() !== barTime) return { status: "stale_bar" };

  const synth = await db.prepare("SELECT candle_key, ai_analysis, prophet_metrics, gmi_metrics FROM ai_syntheses ORDER BY id DESC LIMIT 1").first();
  const decision = parseJson(synth?.ai_analysis, {})?.decision || {};
  const h1 = {
    candle_key: synth?.candle_key ?? null,
    decision: String(decision.decision || "WAIT").toUpperCase(),
    confidence: decision.confidence ?? null,
    tradingview: synth ? interpretWebhookRow(synth).summary : null
  };
  const newsThread = await db.prepare("SELECT t.id, t.ref_key, m.stance, m.confidence, m.body_json FROM agent_threads t LEFT JOIN agent_thread_messages m ON m.thread_id = t.id AND m.step = 'moderator' AND m.status = 'ok' WHERE t.kind = 'news' ORDER BY t.created_at DESC LIMIT 1").first();
  const news = newsThread ? { analysis_key: newsThread.ref_key, consensus: newsThread.stance ?? null, confidence: newsThread.confidence ?? null, summary: clip(parseJson(newsThread.body_json, {})?.summary, 300) } : null;

  const recentBars = Array.isArray(m5Raw.recent_bars) ? m5Raw.recent_bars.slice(-12) : [];
  // C0 step 4: verified only while the 5m implementations are parity-approved.
  let m5Verified = { verified: false };
  try { m5Verified = await verifiedM5Reading(env, barTime); } catch { m5Verified = { verified: false }; }
  const m5 = m5Verified.verified
    ? {
        label: M5_VERIFIED_LABEL,
        role: "execution timing from the local lane",
        trust_status: "approved_by_parity",
        bar_time: barTime,
        bias: m5Verified.bias,
        reading: { summary: m5Verified.summary, lines: m5Verified.lines },
        recent_bars: recentBars
      }
    : {
        label: M5_UNVERIFIED_LABEL,
        role: "execution timing from the local lane",
        trust_status: "informational_unverified",
        bar_time: barTime,
        bias: m5Raw.bias ?? null,
        buy_confirmed: m5Raw.buy_confirmed === true,
        sell_confirmed: m5Raw.sell_confirmed === true,
        d_enc: m5Raw.d_enc ?? null,
        recent_bars: recentBars
      };
  const evidence = {
    m15: {
      label: "closed 15m candles built from TradingView 5m bars",
      close_time: barTime,
      candles: buildFifteenMinuteCandles(recentBars)
    },
    m5,
    h1,
    news
  };
  // Entry confirmations (owner rule: no confirmation, no entry). The H1 one comes from the
  // parity-approved Prophet R38 record behind the latest H1 decision; the 5m one from the bar's
  // 5m context, and it counts only while the 5m lane is VERIFIED.
  const r38 = parseJson(synth?.prophet_metrics, {})?.prophet_r38 || {};
  const confirmations = {
    h1_prophet_r38: { buy_confirmed: r38.buy_confirmed === true, sell_confirmed: r38.sell_confirmed === true },
    m5_prophet_r38: { buy_confirmed: m5Raw.buy_confirmed === true, sell_confirmed: m5Raw.sell_confirmed === true, verified: m5Verified.verified === true }
  };
  return { evidence, synthesis: synth, confirmations };
}

export async function runLiveRoomBar(env, task, { clock = () => Date.now() } = {}) {
  if (!liveRoomEnabled(env)) return { status: "disabled", calls: 0 };
  const db = env.DB;
  await ensureThreadSchema(db);
  const barTime = new Date(Date.parse(task.bar_time)).toISOString();
  // The room meets only at a 15m candle close; the other 5m bars feed execution context only.
  if (!isFifteenMinuteClose(barTime)) return { status: "not_15m_close", calls: 0 };
  const live = await liveEvidence(env, task, barTime);
  if (live.status) return { status: live.status, calls: 0 };
  const { evidence } = live;
  const h1 = evidence.h1;
  const day = barTime.slice(0, 10);
  const threadId = `live15m:${day}`;
  await upsertThread(db, { id: threadId, kind: "live15m", refKey: day, title: `Live room 15m · ${day}`, post: null, now: clock() });
  const existing = new Map(((await db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id = ? AND run_id = ?").bind(threadId, barTime).all()).results || []).map(r => [r.step, rowToThreadMessage(r)]));
  if (existing.has("moderator")) return { status: "already_complete", calls: 0 };

  // The live room never pays for a fallback model: primary only.
  const roomEnv = { ...env, MULTI_AGENT_FALLBACK_MODEL: env.MULTI_AGENT_MODEL || BUS_DEFAULT_MODEL };
  const deadline = clock() + LIVE_ROOM_WALL_BUDGET_MS;
  const maxPerHour = Number(env.LIVE_ROOM_MAX_CALLS_PER_HOUR ?? 36);
  const runState = { primaryError: null };
  let calls = 0;
  const budgetOk = async () => {
    if (clock() >= deadline) return false;
    try { return (await callsInLastHour(db, clock(), "live%")) < (Number.isFinite(maxPerHour) ? maxPerHour : 0); } catch { return false; }
  };
  const step = async (base, opts) => { calls += 1; return runStep(roomEnv, db, { ...base, bar_time: barTime }, { ...opts, deadline, clock, runState, budgetOk }); };
  const toBody = (obj) => ({ body: { insight: clip(obj.insight, INSIGHT_MAX), responds_to: obj.responds_to ?? null }, refs: obj.refs.slice(0, 12).map(r => clip(r, 200)) });

  const technical = existing.get("technical") || await step({ thread_id: threadId, run_id: barTime, step: "technical", agent: "technical", parent_id: null }, {
    messages: roomAgentMessages("technical", evidence, null), schemaName: "room_agent", schema: ROOM_AGENT_SCHEMA,
    maxTokens: BUS_MAX_TOKENS.agent, effort: "low", validate: (o) => validateRoomAgent(o, "technical"), toBody
  });
  const risk = existing.get("risk") || await step({ thread_id: threadId, run_id: barTime, step: "risk", agent: "risk", parent_id: technical?.id ?? null }, {
    messages: roomAgentMessages("risk", evidence, technical?.status === "ok" ? technical : null), schemaName: "room_agent", schema: ROOM_AGENT_SCHEMA,
    maxTokens: BUS_MAX_TOKENS.agent, effort: "low", validate: (o) => validateRoomAgent(o, "risk"), toBody
  });
  // Phase C6: the four HUD agents of the live room speak from their 15m HUD reading.
  const hudPosts = [];
  if (hudAgentsEnabled(env)) {
    let hud = null;
    try {
      const key15 = m15KeyForClose(barTime);
      const carried = task.hud && typeof task.hud === "object" && task.hud.candle_key === key15 ? task.hud : null;
      const snapshot = carried || await loadHudSnapshot(env, { timeframe: "15", candleKey: key15 });
      hud = snapshot ? await hudReadings(env, snapshot) : null;
    } catch { hud = null; }
    for (const id of HUD_LIVE_ROOM_AGENTS) {
      const reading = hud?.readings?.[id];
      if (!reading?.available) continue;
      const stepName = `hud:${id}`;
      const msg = existing.get(stepName) || await step({ thread_id: threadId, run_id: barTime, step: stepName, agent: id, parent_id: null }, {
        messages: liveHudMessages(id, HUD_NAMES[id], reading, evidence.h1), schemaName: "live_hud_agent", schema: LIVE_HUD_AGENT_SCHEMA,
        maxTokens: BUS_MAX_TOKENS.agent, effort: "low", validate: (o) => validateHudAgent(o, id, ROOM_STANCES),
        toBody: (o) => ({ body: { insight: clip(o.insight, INSIGHT_MAX), hud: HUD_NAMES[id], ...calibrationCounts(reading.lines) }, refs: [] })
      });
      hudPosts.push({ ...msg, agent: HUD_NAMES[id] });
    }
  }
  await step({ thread_id: threadId, run_id: barTime, step: "moderator", agent: "moderator", parent_id: null }, {
    messages: roomModeratorMessages(evidence, [technical, risk, ...hudPosts].filter(Boolean)), schemaName: "room_moderator", schema: ROOM_MODERATOR_SCHEMA,
    maxTokens: BUS_MAX_TOKENS.agent, effort: "low", validate: (o) => validateRoomModerator(o, h1.decision),
    toBody: (obj) => ({ body: { summary: clip(obj.summary, 400), h1_decision: h1.decision }, refs: [] })
  });
  return { status: "complete", calls };
}

// ---------------------------------------------------------------- read models

export function buildMessageTree(messages) {
  const byId = new Map(messages.map(m => [m.id, { ...m, replies: [] }]));
  const roots = [];
  for (const m of byId.values()) {
    if (m.parent_id != null && byId.has(m.parent_id)) byId.get(m.parent_id).replies.push(m);
    else roots.push(m);
  }
  const sort = (list) => { list.sort((a, b) => a.id - b.id); list.forEach(m => sort(m.replies)); return list; };
  return sort(roots);
}

export async function listThreads(db, { kind = "news", limit = 20 } = {}) {
  await ensureThreadSchema(db);
  const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const rows = (await db.prepare(
    "SELECT t.*, (SELECT COUNT(*) FROM agent_thread_messages m WHERE m.thread_id = t.id) AS reply_count, (SELECT m.stance FROM agent_thread_messages m WHERE m.thread_id = t.id AND m.step = 'moderator' AND m.status = 'ok' ORDER BY m.id DESC LIMIT 1) AS consensus FROM agent_threads t WHERE t.kind = ? ORDER BY t.created_at DESC LIMIT ?"
  ).bind(kind, n).all()).results || [];
  return rows.map(r => ({ id: r.id, kind: r.kind, ref_key: r.ref_key, title: r.title, created_at: r.created_at, updated_at: r.updated_at, reply_count: Number(r.reply_count) || 0, consensus: r.consensus ?? null, post: parseJson(r.post_json, null) }));
}

export async function readThread(db, id) {
  await ensureThreadSchema(db);
  const t = await db.prepare("SELECT * FROM agent_threads WHERE id = ?").bind(id).first();
  if (!t) return null;
  const messages = (((await db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id = ? ORDER BY id").bind(id).all()).results) || []).map(rowToThreadMessage);
  return { id: t.id, kind: t.kind, ref_key: t.ref_key, title: t.title, created_at: t.created_at, post: parseJson(t.post_json, null), messages: buildMessageTree(messages) };
}

export async function readLive(db, { since = 0, limit = 50 } = {}) {
  await ensureThreadSchema(db);
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const s = Number(since) || 0;
  const rows = s > 0
    ? ((await db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id LIKE 'live%:%' AND id > ? ORDER BY id ASC LIMIT ?").bind(s, n).all()).results || [])
    : (((await db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id LIKE 'live%:%' ORDER BY id DESC LIMIT ?").bind(n).all()).results) || []).reverse();
  return rows.map(rowToThreadMessage);
}

// ---------------------------------------------------------------- H1 threads
// The H1 multi-agent bus (bus_messages) presented as one thread per H1 candle:
// post = the H1 decision, replies = technical/news (round 2 nested under the
// other agent's round-1 message), then the moderator.

const H1_AGENTS = ["technical", "news"];

function busRowToMessage(row) {
  const body = parseJson(row.insight, null);
  const structured = body && typeof body === "object" && !Array.isArray(body) ? body : { insight: String(row.insight ?? "") };
  const round = Number(row.round);
  return {
    id: row.id,
    run_id: row.run_id,
    step: row.agent === "moderator" ? "moderator" : `r${round}:${row.agent}`,
    agent: row.agent,
    round,
    ts: row.ts,
    status: row.status,
    confidence: row.confidence ?? null,
    stance: structured.stance ?? null,
    ...structured
  };
}

function h1Title(candleKey, decision) {
  const ms = Number(String(candleKey).split(":").pop());
  const when = Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : candleKey;
  return `H1 candle ${when} · decision ${decision || "WAIT"}`;
}

function h1Post(candleKey, synth) {
  const synthesis = parseJson(synth?.ai_analysis, {}) || {};
  const decision = synthesis.decision || {};
  const fusion = synthesis.evidence_fusion || {};
  const ms = Number(String(candleKey).split(":").pop());
  const reasoning = fusion.complete === false
    ? describeDegradedEvidence(fusion.missing_evidence || [], fusion.validation_errors || [])
    : String(decision.reasoning || "");
  return {
    candle_key: candleKey,
    candle_open: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
    decision: decision.decision || "WAIT",
    confidence: decision.confidence ?? null,
    reasoning: clip(reasoning, 1200),
    tradingview: interpretWebhookRow(synth)
  };
}

export async function listH1Threads(db, { limit = 20 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
  let rows = [];
  try {
    rows = (await db.prepare("SELECT candle_key, MAX(id) AS last_id, MIN(ts) AS first_ts FROM bus_messages GROUP BY candle_key ORDER BY last_id DESC LIMIT ?").bind(n).all()).results || [];
  } catch { return []; }
  const out = [];
  for (const r of rows) {
    const synth = await db.prepare("SELECT ai_analysis, prophet_metrics, gmi_metrics FROM ai_syntheses WHERE candle_key = ? ORDER BY id DESC LIMIT 1").bind(r.candle_key).first();
    const run = await db.prepare("SELECT run_id FROM bus_messages WHERE id = ?").bind(r.last_id).first();
    const msgs = (await db.prepare("SELECT * FROM bus_messages WHERE candle_key = ? AND run_id = ? ORDER BY id").bind(r.candle_key, run?.run_id).all()).results || [];
    const mod = msgs.map(busRowToMessage).find(m => m.agent === "moderator" && m.status === "ok");
    const post = h1Post(r.candle_key, synth);
    out.push({ id: `h1:${r.candle_key}`, kind: "h1", ref_key: r.candle_key, title: h1Title(r.candle_key, post.decision), created_at: r.first_ts, reply_count: msgs.length, consensus: mod?.stance ?? null, post });
  }
  return out;
}

export async function readH1Thread(db, candleKey) {
  let rows = [];
  try {
    rows = (await db.prepare("SELECT * FROM bus_messages WHERE candle_key = ? ORDER BY id").bind(candleKey).all()).results || [];
  } catch { rows = []; }
  // HUD agents post in the same Threads 1H view, even when the bus did not run.
  const hudAgents = await readHudThread(db, candleKey);
  if (!rows.length && !hudAgents.length) return null;
  const latestRun = rows.at(-1)?.run_id;
  const msgs = rows.filter(r => r.run_id === latestRun).map(busRowToMessage);
  const byStep = new Map(msgs.map(m => [m.step, m]));
  for (const m of msgs) {
    if (m.round === 2 && H1_AGENTS.includes(m.agent)) {
      const other = byStep.get(`r1:${m.agent === "technical" ? "news" : "technical"}`);
      m.parent_id = other ? other.id : null;
    } else {
      m.parent_id = null;
    }
  }
  const synth = await db.prepare("SELECT ai_analysis, prophet_metrics, gmi_metrics FROM ai_syntheses WHERE candle_key = ? ORDER BY id DESC LIMIT 1").bind(candleKey).first();
  const post = h1Post(candleKey, synth);
  return { id: `h1:${candleKey}`, kind: "h1", ref_key: candleKey, title: h1Title(candleKey, post.decision), created_at: msgs[0]?.ts ?? hudAgents[0]?.ts ?? null, post, messages: buildMessageTree(msgs), hud_agents: hudAgents };
}


// ---------------------------------------------------------------- HUD agents (Phase C5)
//
// One agent per Pine HUD section, named after the HUD (owner decision). After each H1
// synthesis, every HUD with a computed reading posts once in Threads 1H, then a moderator
// summarises. Each agent sees only its own HUD reading (with "verified by parity" or "not
// yet calibrated" per statement) and the authoritative H1 decision. Advisory only: no
// entry, stop, target or size; never changes the H1 decision. Behind HUD_AGENTS_ENABLED.

export const HUD_WALL_BUDGET_MS = 240_000;
export const HUD_STANCES = Object.freeze(["BUY", "SELL", "WAIT"]);

const HUD_AGENT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    agent: { type: "string" },
    stance: { type: "string", enum: [...HUD_STANCES] },
    confidence: { type: "number" },
    insight: { type: "string" }
  },
  required: ["agent", "stance", "confidence", "insight"]
});

/** Live 15m room HUD agents (RFC §6.2, owner decision: Aegis included). */
export const HUD_LIVE_ROOM_AGENTS = Object.freeze(["trade_management", "kinetic_engine", "fabio_amt", "aegis_footprint"]);

const LIVE_HUD_AGENT_SCHEMA = Object.freeze({ ...HUD_AGENT_SCHEMA, properties: { ...HUD_AGENT_SCHEMA.properties, stance: { type: "string", enum: [...ROOM_STANCES] } } });

function liveHudMessages(agentId, name, reading, h1) {
  return chatMessages([
    `You are ${name}, one agent per Pine HUD, in a live XAUUSD trading room that meets at every 15m candle close. You speak only about the ${name} HUD on the 15m candle that just closed.`,
    RULES_NO_REFS,
    HUD_TIERS_RULE,
    `The authoritative H1 decision is ${h1.decision}. Room stances: BUY, SELL, HOLD (keep an existing position), WAIT (stay flat), CLOSE (exit an existing position). Never give entry, stop loss, take profit or position size.`,
    `Required JSON: {"agent":"${agentId}","stance":"BUY|SELL|HOLD|WAIT|CLOSE","confidence":0..1,"insight":"<= 400 chars"}`,
    "EVIDENCE:",
    JSON.stringify({ hud: name, timeframe: "15 minutes", reading: hudEvidenceLines(reading), h1: { decision: h1.decision, confidence: h1.confidence } })
  ]);
}

export function buildHudAgentsTask({ candleKey, enqueuedAt = new Date().toISOString() } = {}) {
  if (typeof candleKey !== "string" || !candleKey.trim()) throw new TypeError("HUD agents task requires candleKey");
  return { kind: "hud_agents", event_id: `hud_agents:${candleKey}`, candle_key: candleKey, enqueued_at: enqueuedAt };
}

export function validateHudAgent(obj, agentId, stances = HUD_STANCES) {
  const errors = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { valid: false, errors: ["not_an_object"] };
  if (obj.agent !== agentId) errors.push("agent_mismatch");
  if (!stances.includes(obj.stance)) errors.push("stance_invalid");
  if (!inUnit(obj.confidence)) errors.push("confidence_out_of_range");
  if (typeof obj.insight !== "string" || !obj.insight.trim()) errors.push("insight_missing");
  errors.push(...naturalLanguageErrors(obj.insight));
  return { valid: errors.length === 0, errors };
}

/** Reading lines as the agent sees them: each statement carries its calibration tier. */
export function hudEvidenceLines(reading) {
  return (reading?.lines || []).map((l) => `${l.verified ? "Verified by parity" : l.derived ? "Computed from verified bars" : "Not yet calibrated"}: ${l.text}`);
}

/** How a HUD agent weighs the three calibration tiers of its reading. */
export const HUD_TIERS_RULE = "Read only your HUD reading below. Each statement is marked verified by parity (it equals the parity-approved local computation), computed from verified bars (a pure formula of closed bars, such as Camarilla levels, pivot ranges or sessions, on a bar that matched TradingView), or not yet calibrated (an engine internal no TradingView comparator has checked). Lean on the verified and bar-computed statements, and say plainly when your view rests on statements that are not yet calibrated.";

function hudAgentMessages(agentId, name, reading, h1) {
  return chatMessages([
    `You are ${name}, one agent per Pine HUD in an XAUUSD trading forum. You speak only about the ${name} HUD, for the H1 candle that just closed.`,
    RULES_NO_REFS,
    HUD_TIERS_RULE,
    `The authoritative H1 decision is ${h1.decision}. Say whether your HUD agrees with it. Never give entry, stop loss, take profit or position size.`,
    `Required JSON: {"agent":"${agentId}","stance":"BUY|SELL|WAIT","confidence":0..1,"insight":"<= 400 chars"}`,
    "EVIDENCE:",
    JSON.stringify({ hud: name, timeframe: "1 hour", reading: hudEvidenceLines(reading), h1: { decision: h1.decision, confidence: h1.confidence } })
  ]);
}

function hudModeratorMessages(h1, transcript) {
  return chatMessages([
    "You are the moderator of the HUD agents in an XAUUSD trading forum: one agent per Pine HUD has posted about the H1 candle that just closed.",
    RULES_NO_REFS,
    `Give one short consensus line across the HUDs, naming which HUDs agree and which disagree. If your stance differs from the H1 decision (${h1.decision}), the summary must say "H1 decision: ${h1.decision}".`,
    `Required JSON: {"stance":"BUY|SELL|WAIT","confidence":0..1,"summary":"<= 300 chars"}`,
    "HUD AGENTS:",
    JSON.stringify(transcript.map((m) => ({ hud: m.name, status: m.status, stance: m.stance, confidence: m.confidence, insight: m.insight })))
  ]);
}

/**
 * Runs the HUD agents for one closed H1 candle. Idempotent per (candle, HUD): stored valid
 * messages are reused on redelivery and never re-spend the budget.
 */
export async function runHudAgents(env, task, { clock = () => Date.now(), loadReadings } = {}) {
  if (!hudAgentsEnabled(env)) return { status: "disabled", calls: 0 };
  const db = env.DB;
  const candleKey = task?.candle_key;
  await ensureThreadSchema(db);
  const hud = typeof loadReadings === "function" ? await loadReadings(env, candleKey) : null;
  if (!hud || !hud.readings) throw Object.assign(new Error("HUD snapshot not visible yet"), { name: "RetryableError" });
  const synth = await db.prepare("SELECT ai_analysis FROM ai_syntheses WHERE candle_key = ? ORDER BY id DESC LIMIT 1").bind(candleKey).first();
  if (!synth) throw Object.assign(new Error("H1 synthesis not visible yet"), { name: "RetryableError" });
  const decision = parseJson(synth.ai_analysis, {})?.decision || {};
  const h1 = { decision: String(decision.decision || "WAIT").toUpperCase(), confidence: decision.confidence ?? null };

  const threadId = `hud1h:${candleKey}`;
  await upsertThread(db, { id: threadId, kind: "hud1h", refKey: candleKey, title: `HUD agents · ${candleKey}`, post: { candle_key: candleKey, h1_decision: h1.decision, not_computed: hud.not_computed }, now: clock() });
  const existing = new Map(((await db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id = ? AND run_id = ?").bind(threadId, candleKey).all()).results || []).map((r) => [r.step, rowToThreadMessage(r)]));
  if (existing.get("moderator")?.status === "ok") return { status: "already_complete", calls: 0 };

  const hudEnv = { ...env, MULTI_AGENT_FALLBACK_MODEL: env.MULTI_AGENT_MODEL || BUS_DEFAULT_MODEL };
  const deadline = clock() + HUD_WALL_BUDGET_MS;
  const maxPerHour = Number(env.HUD_AGENTS_MAX_CALLS_PER_HOUR ?? 30);
  const runState = { primaryError: null };
  let calls = 0;
  const budgetOk = async () => {
    if (clock() >= deadline) return false;
    try { return (await callsInLastHour(db, clock(), "hud%")) < (Number.isFinite(maxPerHour) ? maxPerHour : 0); } catch { return false; }
  };
  const transcript = [];
  for (const id of HUD_IDS) {
    const reading = hud.readings[id];
    if (!reading?.available) continue;
    const step = `hud:${id}`;
    let msg = existing.get(step);
    if (msg?.status !== "ok") {
      calls += 1;
      msg = await runStep(hudEnv, db, { thread_id: threadId, run_id: candleKey, step, agent: id, parent_id: null }, {
        messages: hudAgentMessages(id, HUD_NAMES[id], reading, h1), schemaName: "hud_agent", schema: HUD_AGENT_SCHEMA,
        maxTokens: BUS_MAX_TOKENS.agent, effort: "low", deadline, clock, runState, budgetOk,
        validate: (o) => validateHudAgent(o, id),
        toBody: (o) => ({ body: { insight: clip(o.insight, INSIGHT_MAX), hud: HUD_NAMES[id], ...calibrationCounts(reading.lines) }, refs: [] })
      });
    }
    transcript.push({ ...msg, name: HUD_NAMES[id] });
  }
  const answered = transcript.filter((m) => m.status === "ok");
  if (answered.length) {
    calls += 1;
    await runStep(hudEnv, db, { thread_id: threadId, run_id: candleKey, step: "moderator", agent: "moderator", parent_id: null }, {
      messages: hudModeratorMessages(h1, answered), schemaName: "hud_moderator", schema: ROOM_MODERATOR_SCHEMA,
      maxTokens: BUS_MAX_TOKENS.agent, effort: "low", deadline, clock, runState, budgetOk,
      validate: (o) => { const v = validateRoomModerator(o, h1.decision); if (o && !HUD_STANCES.includes(o.stance)) v.errors.push("stance_invalid"); return { valid: v.errors.length === 0, errors: v.errors }; },
      toBody: (o) => ({ body: { summary: clip(o.summary, 400), h1_decision: h1.decision }, refs: [] })
    });
  }
  return { status: "complete", calls, agents: transcript.length, answered: answered.length };
}

/** HUD agent messages of one H1 candle for Threads 1H (display names only, never model names). */
export async function readHudThread(db, candleKey) {
  let rows = [];
  try {
    rows = (await db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id = ? ORDER BY id").bind(`hud1h:${candleKey}`).all()).results || [];
  } catch { return []; }
  return rows.map(rowToThreadMessage).filter(Boolean).map((m) => ({
    id: m.id, step: m.step, agent: m.agent, name: m.agent === "moderator" ? "Moderator" : HUD_NAMES[m.agent] ?? m.agent,
    status: m.status, stance: m.stance, confidence: m.confidence, insight: m.insight ?? null, summary: m.summary ?? null, ts: m.ts,
    verified_lines: m.verified_lines ?? null, derived_lines: m.derived_lines ?? null, total_lines: m.total_lines ?? null
  }));
}

/** Shared with the War Room (src/war-room.mjs): one storage, budget and step runner. */
export const threadInternals = Object.freeze({ runStep, writeMessage, upsertThread, callsInLastHour, RULES_NO_REFS, clip, inUnit, parseJson, INSIGHT_MAX });
