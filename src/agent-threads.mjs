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
import { naturalLanguageErrors, NATURAL_LANGUAGE_RULE, NATURAL_LANGUAGE_CORRECTION, describeDegradedEvidence, calibrationTalk, CALIBRATION_CORRECTION } from "./natural-language.mjs";
import { interpretWebhookRow } from "./webhook-interpretation.mjs";
import { verifiedM5Reading, M5_VERIFIED_LABEL, M5_UNVERIFIED_LABEL } from "./m5-verification.mjs";
import { HUD_NAMES } from "./hud-reading.mjs";
import { memoEligible, memoKind, inputHash, memoLookup, memoStore, roomMemoEnabled, evidenceShadow, evidenceMemoEnabled } from "./room-memo.mjs";
import { recordAiUsage } from "./ai-usage.mjs";
import { callBusModel, roleModels } from "./model-call.mjs";

export const ROOM_STANCES = Object.freeze(["BUY", "SELL", "HOLD", "WAIT", "CLOSE"]);
export const THREAD_WALL_BUDGET_MS = 300_000;
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
  "CREATE INDEX IF NOT EXISTS idx_agent_thread_messages_thread ON agent_thread_messages(thread_id, id)",
  // Resource audit P0 (2026-11-14): the AI calls of the last hour and the health alerts read by time.
  "CREATE INDEX IF NOT EXISTS idx_agent_thread_messages_ts ON agent_thread_messages(ts)",
  // Owner 2026-11-15 (RFC_ROOM_CELLS §6, interim option): a room's messages by bar, so scoring and the weighting
  // replay read only their window (migration 0021; also made here, production applies no migration).
  "CREATE INDEX IF NOT EXISTS idx_agent_thread_messages_thread_bar ON agent_thread_messages(thread_id, bar_time)"
];


export function liveRoomEnabled(env) {
  return String(env?.LIVE_ROOM_ENABLED ?? "false").trim().toLowerCase() === "true";
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

// The independent rooms (owner decisions 2026-11-09): no H1 chain authority, no 5m lane, and sources
// named as metrics, never as another agent.
const ROOM_RULES_INDEPENDENT = [
  "Advisory only: never produce entry, stop loss, take profit or position size, and never place or recommend executing an order. Stances are discussion positions, not orders.",
  "A local_computation engine counts as trusted only when its trust_status is approved_by_parity; untrusted readings are still evidence, read with less weight.",
  "This answer has no refs field: never write refs, evidence paths, field names or JSON keys in your text. Name every source as a metric in plain words (for example \"the 14-bar average range\" or \"the Prophet R38 buy confirmation\").",
  NATURAL_LANGUAGE_RULE,
  "Return only one JSON object that matches the required schema."
].join("\n");

/** Model calls of the last hour (a step answered from the room memo made none). */
async function callsInLastHour(db, now, kindPrefix) {
  const cutoff = new Date(now - 60 * 60 * 1000).toISOString();
  const row = await db.prepare(
    "SELECT COALESCE(SUM(1 + COALESCE(fallback_used, 0) + COALESCE(json_extract(body_json, '$.corrections'), 0)), 0) AS n FROM agent_thread_messages WHERE ts >= ? AND status NOT IN ('budget_exhausted', 'skipped', 'info') AND json_extract(body_json, '$.reused') IS NULL AND thread_id LIKE ?"
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
/** Steps that conclude a room speak on the moderator model; every other step on the agent model. */
export function stepRole(step) {
  return step === "conclusion" || step === "moderator" || step === "tldr" ? "moderator" : "agent";
}

async function runStep(env, db, base, { messages, schemaName, schema, maxTokens, effort, deadline, clock, runState, validate, toBody, budgetOk, role = stepRole(base?.step), inferMetrics = null, evidence = null }) {
  const ts = new Date(clock()).toISOString();
  // A benched agent's shadow answer (step "shadow:<agent>") is metered as a shadow call (src/shadow-switch.mjs).
  const meterSource = String(base?.step ?? "").startsWith("shadow:") ? `shadow:${schemaName}` : null;
  const source = meterSource || schemaName;
  // A5: one session-affinity id per room kind and step (an agent's opening, its rebuttal, the conclusion).
  const affinity = `${memoKind(base?.thread_id ?? "")}:${base?.step ?? schemaName}`;
  // Room memo (src/room-memo.mjs): the same request as a stored answer has that answer. Reused with
  // ROOM_MEMO_ENABLED (after it passes this room's validation again), otherwise only counted.
  const memo = memoEligible(base) ? { kind: memoKind(base.thread_id), step: base.step, hash: await inputHash([roleModels(env, role).primary, schemaName, messages]) } : null;
  const memoRow = memo ? await memoLookup(db, { ...memo, now: clock() }) : null;
  if (memoRow && roomMemoEnabled(env)) {
    const obj = parseJson(memoRow.answer_json, null);
    const again = obj && typeof obj === "object" ? validate(obj) : { valid: false };
    if (again.valid) {
      await recordAiUsage(db, { source, model: memoRow.model, outcome: "reused", now: clock() });
      const { body, refs } = toBody(obj);
      return writeMessage(db, { ...base, ts, model: memoRow.model, fallback_used: false, usage_tokens: 0, latency_ms: 0, status: "ok", stance: obj.stance, confidence: obj.confidence, body: { ...body, reused: true, reused_from: memoRow.message_id ?? null, input_hash: memo.hash }, refs });
    }
  }
  if (memoRow) await recordAiUsage(db, { source, model: memoRow.model, outcome: "memo_hit", now: clock() });
  const stored = await runStepCall(env, db, base, { ts, messages, schemaName, schema, maxTokens, effort, deadline, clock, runState, validate, toBody, budgetOk, role, inferMetrics, meterSource, affinity, memoHash: memo?.hash ?? null });
  const msg = stored.message;
  if (memo && msg?.status === "ok" && stored.memoAnswer) {
    if (memoRow && memoRow.stance === msg.stance && (memoRow.bias ?? null) === (stored.memoAnswer.bias ?? null)) await recordAiUsage(db, { source, model: memoRow.model, outcome: "memo_same", now: clock() });
    await memoStore(db, { ...memo, messageId: msg.id, model: msg.model, answer: stored.memoAnswer, now: clock() });
    // A4, in shadow (src/room-memo.mjs evidenceShadow): would the evidence key have had this answer?
    if (evidence != null && evidenceMemoEnabled(env)) {
      const hash = await inputHash([roleModels(env, role).primary, schemaName, evidence]);
      await evidenceShadow(db, { kind: memo.kind, step: memo.step, hash, schemaName, answer: { stance: msg.stance, bias: stored.memoAnswer.bias ?? null }, model: msg.model, promptHit: Boolean(memoRow), now: clock(), record: (r) => recordAiUsage(db, r) });
    }
  }
  return msg;
}

const cloneObj = (o) => (o && typeof o === "object" ? JSON.parse(JSON.stringify(o)) : null);

/** The model call of one step and its corrections; returns the stored message and, when it may be memoised, the raw answer. */
async function runStepCall(env, db, base, { ts, messages, schemaName, schema, maxTokens, effort, deadline, clock, runState, validate, toBody, budgetOk, role, inferMetrics, memoHash, meterSource = null, affinity = null }) {
  const done = (message, memoAnswer = null) => message.then((m) => ({ message: m, memoAnswer }));
  if (!(await budgetOk())) {
    return done(writeMessage(db, { ...base, ts, status: "budget_exhausted", body: { insight: "budget exhausted" } }));
  }
  const call = await callBusModel(env, { messages, schemaName, schema, maxTokens, effort, deadline, clock, runState, role, meterSource, affinity });
  // The answer as the model gave it, before validation normalises it in place (for the memo).
  const rawOf = new Map([[call, cloneObj(call.obj)]]);
  const meta = { model: call.model, fallback_used: call.fallback_used, usage_tokens: call.usage_tokens, latency_ms: call.latency_ms ?? null };
  const diag = call.primary_error ? { primary_error: call.primary_error } : {};
  if (call.status !== "answered") {
    return done(writeMessage(db, { ...base, ts, ...meta, status: call.status, body: { insight: call.status === "budget_exhausted" ? "budget exhausted" : "agent failed: " + (call.error || "error"), ...diag } }));
  }
  let validation = call.truncated ? { valid: false, errors: ["finish_reason_length"] } : validate(call.obj);
  // An answer that is valid except that its text reads like code (a field name or key path), or a
  // conclusion that breaks a room rule (no support, no confirmation), gets one correction attempt.
  // The extra call is recorded in `corrections` and counted by the hourly budget; it never runs
  // without budget or past the wall deadline.
  let corrections = 0;
  let finalCall = call;
  let retryObj = null;
  const correction = !validation.valid && !call.truncated ? correctionFor(validation.errors) : null;
  if (correction && clock() < deadline && (await budgetOk())) {
    const retry = await callBusModel(env, {
      messages: [...messages, { role: "assistant", content: String(call.text ?? "") }, { role: "user", content: correction }],
      schemaName, schema, maxTokens, effort, deadline, clock, runState, role, meterSource, affinity
    });
    corrections = 1 + (retry.fallback_used ? 1 : 0);
    meta.usage_tokens = sumOrNull(meta.usage_tokens, retry.usage_tokens);
    meta.latency_ms = sumOrNull(meta.latency_ms, retry.latency_ms);
    rawOf.set(retry, cloneObj(retry.obj));
    if (retry.status === "answered" && !retry.truncated) {
      const second = validate(retry.obj);
      if (second.valid) { validation = second; finalCall = retry; meta.model = retry.model; meta.fallback_used = meta.fallback_used || retry.fallback_used; }
      else if (second.errors?.length && second.errors.every((e) => e === "metrics_missing")) retryObj = { call: retry, errors: second.errors };
    }
  }
  // Calibration talk (owner rule "agents never mention calibration"; Aether compliance found it in
  // more than half of the room messages, 2026-11-07): a valid room answer that still talks about
  // parity or calibration gets one soft correction. It is never rejected for it: when the retry
  // fails or still talks about it, the first valid answer is kept (and compliance records it).
  if (validation.valid && !corrections && ROOM_THREAD.test(String(base?.thread_id ?? "")) && calibrationTalk(roomText(finalCall.obj)) && clock() < deadline && (await budgetOk())) {
    const retry = await callBusModel(env, {
      messages: [...messages, { role: "assistant", content: String(call.text ?? "") }, { role: "user", content: CALIBRATION_CORRECTION }],
      schemaName, schema, maxTokens, effort, deadline, clock, runState, role, meterSource, affinity
    });
    corrections = 1 + (retry.fallback_used ? 1 : 0);
    meta.usage_tokens = sumOrNull(meta.usage_tokens, retry.usage_tokens);
    meta.latency_ms = sumOrNull(meta.latency_ms, retry.latency_ms);
    rawOf.set(retry, cloneObj(retry.obj));
    if (retry.status === "answered" && !retry.truncated) {
      const second = validate(retry.obj);
      if (second.valid && !calibrationTalk(roomText(retry.obj)) && retry.obj.stance === finalCall.obj.stance) { validation = second; finalCall = retry; meta.model = retry.model; meta.fallback_used = meta.fallback_used || retry.fallback_used; }
    }
  }
  // A conclusion is what the room is for (production of 2026-11-07, preview-e2e: a gpt-oss-120b
  // moderator answer stayed invalid after its correction). A moderator answer that is still
  // rejected is asked once more from the role's fallback model, within the deadline and budget.
  const roleFallback = roleModels(env, role).fallback;
  if (!validation.valid && role === "moderator" && !finalCall.fallback_used && roleFallback && roleFallback !== call.model && clock() < deadline && (await budgetOk())) {
    const alt = await callBusModel(env, { messages, schemaName, schema, maxTokens, effort, deadline, clock, runState, role, meterSource, affinity, skipPrimary: `invalid_output (${(validation.errors || []).slice(0, 4).join(", ") || "unparseable"})` });
    if (alt.calls) corrections += 1;
    meta.usage_tokens = sumOrNull(meta.usage_tokens, alt.usage_tokens);
    if (alt.status === "answered" && !alt.truncated) {
      const third = validate(alt.obj);
      console.warn("moderator_fallback_after_invalid", JSON.stringify({ step: base?.step, primary: call.model, fallback: alt.model, errors: validation.errors, valid: third.valid }));
      if (third.valid) { validation = third; finalCall = alt; meta.model = alt.model; meta.fallback_used = true; diag.primary_error = alt.primary_error; }
    }
  }
  // Metrics (owner decisions 2026-11-09): an answer whose ONLY remaining problem after its correction
  // is a missing metrics list is kept with the metrics of its own data source, marked
  // metrics_inferred (production 2026-11-09 10:00-12:00 UTC: most room answers were lost this way,
  // the rooms did not conclude and the H1 decision stalled). Every other error still rejects it.
  let inferred = false;
  if (!validation.valid && typeof inferMetrics === "function") {
    const options = [retryObj?.call, (validation.errors || []).length && validation.errors.every((e) => e === "metrics_missing") ? finalCall : null].filter((c) => c?.obj && typeof c.obj === "object");
    for (const c of options) {
      c.obj.metrics = inferMetrics(base);
      const again = validate(c.obj);
      if (again.valid) {
        validation = again; inferred = true;
        if (c !== finalCall) { finalCall = c; meta.model = c.model; meta.fallback_used = meta.fallback_used || c.fallback_used; }
        break;
      }
    }
  }
  const extra = { ...(corrections ? { corrections } : {}), ...(inferred ? { metrics_inferred: true } : {}) };
  if (!validation.valid) {
    return done(writeMessage(db, { ...base, ts, ...meta, status: "invalid_output", body: { insight: clip(call.text, RAW_MAX), errors: validation.errors, ...extra, ...diag, ...(memoHash ? { input_hash: memoHash } : {}) } }));
  }
  const { body, refs } = toBody(finalCall.obj);
  // Memoised only: the primary model's answer, valid without inferred metrics.
  const memoAnswer = memoHash && !inferred && !meta.fallback_used ? (rawOf.get(finalCall) ?? null) : null;
  return done(writeMessage(db, { ...base, ts, ...meta, status: "ok", stance: finalCall.obj.stance, confidence: finalCall.obj.confidence, body: { ...body, ...extra, ...diag, ...(memoHash ? { input_hash: memoHash } : {}) }, refs }), memoAnswer);
}

function sumOrNull(a, b) {
  const xs = [a, b].map(Number).filter(Number.isFinite);
  return xs.length ? xs.reduce((x, y) => x + y, 0) : null;
}

const CORRECTION_PROMPT = NATURAL_LANGUAGE_CORRECTION;

/** Room threads whose agents must never talk about calibration: War Rooms, timeframe rooms, HUD threads. */
const ROOM_THREAD = /^(?:warroom:|tf:|hud)/;
/** The text fields a room answer shows to readers. */
export const roomText = (o) => [o?.claim, o?.argument, o?.summary, ...(Array.isArray(o?.reasons) ? o.reasons : [])];

/** Rule errors a single correction call may fix, each with what to tell the model. */
const RULE_CORRECTIONS = Object.freeze({
  stance_without_support: "A BUY or SELL conclusion needs at least one agent on the bus or in the Consensus Discussion holding that stance; a confirmation alone never overrules the whole room.",
  entry_without_confirmation: "BUY or SELL needs the matching confirmation in the CONFIRMATIONS above; without it the stance is WAIT, or HOLD / CLOSE for a position already open.",
  entry_without_quorum: "BUY or SELL needs the room's quorum: more than half of the agents' weight holding the matching bias (see the QUORUM RULE above); without it the stance is WAIT, or HOLD / CLOSE for a position already open.",
  bias_without_support: "A BULLISH or BEARISH bias needs at least one agent on the bus or in the Consensus Discussion holding that bias; otherwise the bias is NEUTRAL or the side the agents actually lean.",
  names_an_agent: "Your text named another agent or role. Never name an agent: say which metrics the argument rests on instead (for example \"the 14-bar average range\" or \"the Prophet R38 buy confirmation\"), and refer to bus statements only by their # reference in the JSON fields, never in the text.",
  metrics_missing: "Your answer had no \"metrics\": list the one to four metrics you decided from, in plain words."
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

/** The moderator must name the authoritative H1 decision whenever its stance differs from it. */
export function validateRoomModerator(obj, h1Decision) {
  const errors = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { valid: false, errors: ["not_an_object"] };
  if (!ROOM_STANCES.includes(obj.stance)) errors.push("stance_invalid");
  if (!inUnit(obj.confidence)) errors.push("confidence_out_of_range");
  if (typeof obj.summary !== "string" || !obj.summary.trim()) errors.push("summary_missing");
  // An independent room (owner decision 2026-11-09) passes no H1 decision: nothing to reference.
  const h1 = h1Decision == null ? null : String(h1Decision || "WAIT").toUpperCase();
  if (h1 && errors.length === 0 && obj.stance !== h1 && !new RegExp(`H1[^.]{0,40}${h1}`, "i").test(obj.summary)) errors.push("h1_reference_missing");
  if (typeof obj.summary === "string") errors.push(...naturalLanguageErrors(obj.summary));
  return { valid: errors.length === 0, errors };
}

/**
 * The live room's evidence for the 15m close barTime: the closed 15m candles, the 5m execution
 * read (VERIFIED 5m only while parity-approved), the latest H1 decision and the news consensus.
 * Returns { evidence } or { status } when the bar is stale; throws RetryableError while the 5m
 * context of this bar is not visible yet. Used by the War Room (the legacy live room was retired 2026-11-15).
 */
/**
 * The 5m context of the bar that closed at barTime, rebuilt from the cached closed 5m series (the
 * same TradingView bars the pull adapter publishes), or null when that bar is not cached yet.
 * Only the bars: no bias and no confirmation.
 */
export async function m5ContextFromSeries(kv, barTime) {
  const record = parseJson(await kv?.get?.("market-data:v2:series:OANDA:XAUUSD|5m"), null);
  const t = Date.parse(barTime);
  const bars = (Array.isArray(record?.candles) ? record.candles : [])
    .filter((b) => Number.isFinite(Date.parse(b?.close_time ?? "")) && Date.parse(b.close_time) <= t && [b.open, b.high, b.low, b.close].every((v) => typeof v === "number" && Number.isFinite(v)))
    .sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  if (!bars.length || Date.parse(bars.at(-1).close_time) !== t) return null;
  return {
    candle_time: new Date(t).toISOString(), source: "cached 5m series (missed-room fallback)",
    bias: null, buy_confirmed: false, sell_confirmed: false,
    recent_bars: bars.slice(-12).map((b) => ({ t: new Date(Date.parse(b.close_time)).toISOString(), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume ?? null }))
  };
}

export async function liveEvidence(env, task, barTime) {
  const db = env.DB;
  const kv = env.SIGNAL_CACHE;
  const fromTask = task.context && typeof task.context === "object" ? task.context : null;
  let m5Raw = fromTask || parseJson(await kv?.get?.("context:m5:latest"), null);
  // The sweep's missed-room fallback (production 2026-11-10 13:10-14:10: the 5m bars kept arriving in
  // the cache while the 5m local records and their context were not published, so no 15m room met):
  // without the bar's own context, the closed 5m bars of the cached series stand in. No Prophet 5m
  // confirmation is claimed from them.
  if (task.fallback === true && Date.parse(m5Raw?.candle_time ?? "") !== Date.parse(barTime)) {
    const fromSeries = await m5ContextFromSeries(kv, barTime);
    if (!fromSeries) return { status: "no_m5_bars" };
    m5Raw = fromSeries;
  }
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
  // AU1 item 8 (owner 2026-11-28, "jawaban bernomor 1-9 setuju semua"): the news thread is removed; the rooms read
  // News Daily (war-room.mjs newsDeskEvidence) and nothing else, so the live evidence carries no news of its own.
  const news = null;

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
  // setup_state (owner report 2026-11-09): the Prophet setup still READY after its one-bar event.
  const setup = r38.setup_state && typeof r38.setup_state === "object" ? r38.setup_state : null;
  const confirmations = {
    h1_prophet_r38: {
      buy_confirmed: r38.buy_confirmed === true, sell_confirmed: r38.sell_confirmed === true,
      buy_setup_ready: setup?.buy_ready === true, sell_setup_ready: setup?.sell_ready === true,
      ...(setup ? { setup_pass_age: setup.buy_ready ? setup.buy_pass_age : setup.sell_ready ? setup.sell_pass_age : null, setup_window: setup.confirmation_window ?? null, setup_instruction: setup.instruction ?? null } : {})
    },
    m5_prophet_r38: { buy_confirmed: m5Raw.buy_confirmed === true, sell_confirmed: m5Raw.sell_confirmed === true, verified: m5Verified.verified === true }
  };
  return { evidence, synthesis: synth, confirmations };
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
// Threads 1H (`h1:<candle>`): the H1 decision as the post and the HUD agents' messages (Phase C5). The
// retired H1 multi-agent bus (owner 2026-11-15) no longer adds replies; its stored rows are not read.

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

/** The H1 candles whose HUD agents posted, newest first. */
export async function listH1Threads(db, { limit = 20 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
  let rows = [];
  try {
    rows = (await db.prepare("SELECT t.ref_key AS candle_key, t.created_at, (SELECT COUNT(*) FROM agent_thread_messages m WHERE m.thread_id = t.id) AS n, (SELECT m.stance FROM agent_thread_messages m WHERE m.thread_id = t.id AND m.step = 'moderator' AND m.status = 'ok' ORDER BY m.id DESC LIMIT 1) AS consensus FROM agent_threads t WHERE t.kind = 'hud1h' ORDER BY t.created_at DESC LIMIT ?").bind(n).all()).results || [];
  } catch { return []; }
  const out = [];
  for (const r of rows) {
    const synth = await db.prepare("SELECT ai_analysis, prophet_metrics, gmi_metrics FROM ai_syntheses WHERE candle_key = ? ORDER BY id DESC LIMIT 1").bind(r.candle_key).first();
    const post = h1Post(r.candle_key, synth);
    out.push({ id: `h1:${r.candle_key}`, kind: "h1", ref_key: r.candle_key, title: h1Title(r.candle_key, post.decision), created_at: r.created_at, reply_count: Number(r.n) || 0, consensus: r.consensus ?? null, post });
  }
  return out;
}

export async function readH1Thread(db, candleKey) {
  const hudAgents = await readHudThread(db, candleKey);
  if (!hudAgents.length) return null;
  const synth = await db.prepare("SELECT ai_analysis, prophet_metrics, gmi_metrics FROM ai_syntheses WHERE candle_key = ? ORDER BY id DESC LIMIT 1").bind(candleKey).first();
  const post = h1Post(candleKey, synth);
  return { id: `h1:${candleKey}`, kind: "h1", ref_key: candleKey, title: h1Title(candleKey, post.decision), created_at: hudAgents[0]?.ts ?? null, post, messages: [], hud_agents: hudAgents };
}


// ---------------------------------------------------------------- HUD readings (Phase C5)
//
// The per-H1 HUD agents (hud_agent, hud_moderator) are retired (owner 2026-11-15): since 2026-11-05 each HUD
// speaks as a seat of the War Room and of the 1H/4H/D1 rooms. Their stored Threads 1H messages stay readable.

/** Reading lines as the agent sees them: each statement carries its calibration tier. */
export function hudEvidenceLines(reading) {
  return (reading?.lines || []).map((l) => `${l.verified ? "Verified by parity" : l.derived ? "Computed from verified bars" : "Not yet calibrated"}: ${l.text}`);
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
export const threadInternals = Object.freeze({ runStep, writeMessage, upsertThread, callsInLastHour, RULES_NO_REFS, ROOM_RULES_INDEPENDENT, clip, inUnit, parseJson, INSIGHT_MAX });
