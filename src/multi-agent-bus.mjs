// Multi-agent bus (Phase 2, docs/MULTI_AGENT_BUS.md).
//
// Runs AFTER the H1 decision chain has persisted its synthesis, as a separate
// `multi_agent_bus` queue task. It reads that synthesis, lets two agents
// (technical, news) argue for two rounds, and a moderator writes a consensus.
// It is shadow/advisory only: it never writes into the chain's evidence,
// prompts, decision, entry/SL/TP, size or confidence.

import { chatMessages, cleanModelText, extractJsonObject, extractModelText } from "./model-text.mjs";
import { naturalLanguageErrors, NATURAL_LANGUAGE_RULE, NATURAL_LANGUAGE_CORRECTION, onlyNaturalLanguageErrors } from "./natural-language.mjs";
import { interpretWebhookRow } from "./webhook-interpretation.mjs";

export const BUS_DEFAULT_MODEL = "@cf/zai-org/glm-5.3-flash";
export const BUS_DEFAULT_FALLBACK_MODEL = "@cf/zai-org/glm-4.7-flash";
export const BUS_AGENTS = Object.freeze(["technical", "news"]);
export const BUS_ROUNDS = 2;
export const BUS_MODERATOR_ROUND = 3;
// Wall budget per synthesis. Fallback calls can take about 40 s, so five
// sequential calls need room beyond 180 s; queue consumers may run 15 minutes.
export const BUS_WALL_BUDGET_MS = 300_000;
const PRIMARY_CALL_TIMEOUT_MS = 60_000;
// glm-5.3-flash always reasons (reasoning cannot be disabled), so leave room
// for the hidden trace before the JSON answer.
export const BUS_MAX_TOKENS = Object.freeze({ agent: 3072, moderator: 4096 });
export const BUS_STANCES = Object.freeze(["BUY", "SELL", "WAIT"]);
const INSIGHT_MAX = 600;
const SUMMARY_MAX = 1000;
const RAW_MAX = 2048;

const STATUS_OK = "ok";

export const BUS_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS bus_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  candle_key TEXT NOT NULL,
  round INTEGER NOT NULL,
  agent TEXT NOT NULL,
  ts TEXT NOT NULL,
  insight TEXT NOT NULL,
  confidence REAL,
  refs_json TEXT,
  model TEXT,
  status TEXT,
  latency_ms INTEGER,
  fallback_used INTEGER DEFAULT 0,
  usage_tokens INTEGER,
  UNIQUE(candle_key, run_id, round, agent)
)`,
  "CREATE INDEX IF NOT EXISTS idx_bus_candle ON bus_messages(candle_key)"
];

// Strict-mode schemas use only widely supported keywords (type, enum, required,
// additionalProperties). Ranges (confidence 0..1, round, non-empty refs) are
// enforced by validateAgentOutput / validateModeratorOutput after parsing.
export const AGENT_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    agent: { type: "string", enum: [...BUS_AGENTS] },
    round: { type: "integer" },
    stance: { type: "string", enum: [...BUS_STANCES] },
    confidence: { type: "number" },
    insight: { type: "string" },
    refs: { type: "array", items: { type: "string" } },
    responds_to: { type: ["string", "null"] }
  },
  required: ["agent", "round", "stance", "confidence", "insight", "refs", "responds_to"]
});

export const MODERATOR_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    stance: { type: "string", enum: [...BUS_STANCES] },
    confidence: { type: "number" },
    agreed: { type: "boolean" },
    summary: { type: "string" },
    dissent: { type: "array", items: { type: "string" } }
  },
  required: ["stance", "confidence", "agreed", "summary", "dissent"]
});

export function busEnabled(env) {
  return String(env?.MULTI_AGENT_BUS_ENABLED ?? "false").trim().toLowerCase() === "true";
}

export function buildMultiAgentBusTask({ candleKey, inputFingerprint, enqueuedAt = new Date().toISOString() } = {}) {
  if (typeof candleKey !== "string" || !candleKey.trim() || typeof inputFingerprint !== "string" || !inputFingerprint.trim()) {
    throw new TypeError("multi-agent bus task requires candleKey and inputFingerprint");
  }
  return {
    kind: "multi_agent_bus",
    event_id: `bus:${candleKey}:${inputFingerprint}`,
    candle_key: candleKey,
    input_fingerprint: inputFingerprint,
    enqueued_at: enqueuedAt
  };
}

let schemaReady = false;
/** CREATE TABLE IF NOT EXISTS, once per isolate (the preview D1 has no migration runner). */
export async function ensureBusSchema(db) {
  if (schemaReady) return;
  for (const sql of BUS_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}
export function resetBusSchemaCacheForTests() { schemaReady = false; }

function parseJson(text, fallback = null) {
  if (typeof text !== "string" || !text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function clip(value, max) {
  const s = String(value ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

function pick(object, keys) {
  const out = {};
  if (!object || typeof object !== "object") return out;
  for (const key of keys) if (object[key] !== undefined) out[key] = object[key];
  return out;
}

const WEBHOOK_FIELDS = {
  prophet_r38: ["direction", "buy_confirmed", "sell_confirmed", "buy_high_quality", "sell_high_quality", "t_enc", "d_enc", "structure_subtype", "o", "h", "l", "c", "volume", "candle_time"],
  prophet_r37_ssot: ["direction", "d_enc", "b_enc", "structure_subtype", "bull_event", "bear_event", "candle_time"],
  gmi_v12_70: ["verdict", "gate", "gmi_dir", "prophet_dir", "conflict", "candle_time"]
};

/**
 * Compact, valid evidence per agent built from the persisted synthesis row
 * (never a truncated JSON string). Paths in the object are what agents cite in `refs`.
 */
export function buildBusEvidence(row) {
  const synthesis = parseJson(row?.ai_analysis, {}) || {};
  const fusion = synthesis.evidence_fusion || {};
  const prophet = parseJson(row?.prophet_metrics, {}) || {};
  const gmiRaw = parseJson(row?.gmi_metrics, {}) || {};
  const webhook = {
    prophet_r38: pick(prophet.prophet_r38, WEBHOOK_FIELDS.prophet_r38),
    prophet_r37_ssot: pick(prophet.prophet_r37_ssot, WEBHOOK_FIELDS.prophet_r37_ssot),
    gmi_v12_70: pick(gmiRaw, WEBHOOK_FIELDS.gmi_v12_70)
  };
  const local = {};
  for (const [engine, item] of Object.entries(fusion.local_calculations || {})) {
    local[engine] = { trust_status: item?.trust_status ?? "unknown", values: item?.values?.comparable ?? null };
  }
  const news = fusion.fundamental_news_analysis || null;
  const decision = synthesis.decision || {};
  const common = {
    candle_key: row?.candle_key ?? fusion.candle_key ?? null,
    evidence_status: {
      complete: fusion.complete === true,
      missing_evidence: fusion.missing_evidence || [],
      validation_errors: fusion.validation_errors || []
    },
    h1_chain_decision: { decision: decision.decision ?? "WAIT", confidence: decision.confidence ?? null }
  };
  const m5 = fusion.informational_5m_context
    ? (fusion.informational_5m_context.verification?.verified === true
      ? { ...pick(fusion.informational_5m_context, ["engine", "bias", "buy_confirmed", "sell_confirmed", "d_enc", "candle_time"]), trust_status: "approved_by_parity", label: "VERIFIED 5m", reading: clip(fusion.informational_5m_context.verification.summary ?? "", 400) }
      : { ...pick(fusion.informational_5m_context, ["engine", "bias", "buy_confirmed", "sell_confirmed", "d_enc", "candle_time"]), trust_status: "informational_unverified", label: "UNVERIFIED 5m" })
    : null;
  return {
    technical: {
      ...common,
      tradingview: (({ summary, lines }) => ({ summary, lines }))(interpretWebhookRow(row)),
      tradingview_webhook: webhook,
      local_computation: { trusted_only_when: "approved_by_parity", engines: local },
      informational_5m_context: m5
    },
    news: {
      ...common,
      fundamental_news: news
        ? {
            analysis_key: news.analysis_key ?? null,
            analyzed_at: news.analyzed_at ?? null,
            article_count: news.article_count ?? null,
            recommendation: news.recommendation ?? null,
            headlines: Array.isArray(news.evidence?.articles) ? news.evidence.articles.slice(0, 8).map(a => clip(a?.title ?? a?.headline ?? "", 200)) : []
          }
        : { available: false, reason: "no fresh validated news analysis for this candle" }
    },
    chain_decision: common.h1_chain_decision.decision
  };
}

const TECHNICAL_WEBHOOK_RULE =
  "The tradingview object is the decoded meaning of the three TradingView alerts for this candle; call it \"the TradingView reading\", never by a field name. " +
  "Interpret each indicator by name (Prophet and GMI v12.70) in your own words: what it signals, whether anything is confirmed, and whether they agree. Prophet is one indicator: its signal, direction, structure and trade management come in one reading. " +
  "Do this even when the decision is WAIT, then explain how it fits the rest of the evidence.";

const RULES = [
  "Advisory only: never produce entry, stop loss, take profit or position size; the H1 decision chain owns those.",
  "A local_computation engine counts as trusted only when its trust_status is approved_by_parity.",
  "informational_5m_context is 5m execution timing only. When labelled VERIFIED 5m it is parity-approved and you may weigh it as timing; when labelled UNVERIFIED 5m you may mention it, but it must never be the main reason for a stance. Either way the H1 decision chain owns the direction.",
  "Back every claim with refs: JSON paths into the evidence object you were given (for example \"tradingview_webhook.gmi_v12_70.verdict\").",
  NATURAL_LANGUAGE_RULE,
  "If the evidence is degraded or missing, say so and prefer WAIT.",
  "Return only one JSON object that matches the required schema."
].join("\n");

export function agentMessages(agent, round, evidence, roundOneMessages = []) {
  const role = agent === "technical"
    ? "You are the technical analyst agent on an XAUUSD advisory debate bus."
    : "You are the fundamental news analyst agent on an XAUUSD advisory debate bus.";
  const others = roundOneMessages.filter(m => m && m.agent !== agent && m.status === STATUS_OK)
    .map(m => ({ agent: m.agent, stance: m.stance, confidence: m.confidence, insight: m.insight }));
  const task = [
    RULES,
    `Round ${round} of ${BUS_ROUNDS}.`,
    round === 1
      ? "Give your independent stance on this H1 candle." + (agent === "technical" ? " " + TECHNICAL_WEBHOOK_RULE : "")
      : "Read the other agent's round-1 message below. State whether you agree or dispute it and why, set responds_to to that agent's name, and give your updated stance." + (agent === "technical" ? " Refer to the TradingView indicators by name where they matter." : ""),
    `Required JSON: {"agent":"${agent}","round":${round},"stance":"BUY|SELL|WAIT","confidence":0..1,"insight":"<= ${INSIGHT_MAX} chars","refs":["..."],"responds_to":${round === 1 ? "null" : "\"<agent>\""}}`,
    "EVIDENCE:",
    JSON.stringify(evidence),
    ...(round > 1 ? ["OTHER AGENTS (round 1):", JSON.stringify(others)] : [])
  ];
  return chatMessages([role, ...task]);
}

export function moderatorMessages(evidence, messages) {
  const transcript = messages.filter(m => m && m.agent !== "moderator").map(m => ({
    agent: m.agent, round: m.round, status: m.status, stance: m.stance ?? null, confidence: m.confidence ?? null, insight: m.insight
  }));
  return chatMessages([
    "You are the moderator of an XAUUSD advisory debate bus.",
    RULES,
    "Summarise the debate into one consensus. agreed is true only when every valid agent message in round 2 has the same stance. List any disagreement in dissent.",
    `Required JSON: {"stance":"BUY|SELL|WAIT","confidence":0..1,"agreed":true|false,"summary":"<= ${SUMMARY_MAX} chars","dissent":["..."]}`,
    "H1 CHAIN DECISION (read-only, authoritative): " + JSON.stringify(evidence.technical.h1_chain_decision),
    "EVIDENCE STATUS: " + JSON.stringify(evidence.technical.evidence_status),
    "TRADINGVIEW READING (decoded alerts; mention in one plain sentence what the indicators said): " + JSON.stringify(evidence.technical.tradingview),
    "TRANSCRIPT:",
    JSON.stringify(transcript)
  ]);
}

function inUnitInterval(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function validateAgentOutput(obj, { agent, round }) {
  const errors = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { valid: false, errors: ["not_an_object"] };
  if (obj.agent !== agent) errors.push("agent_mismatch");
  if (Number(obj.round) !== round) errors.push("round_mismatch");
  if (!BUS_STANCES.includes(obj.stance)) errors.push("stance_invalid");
  if (!inUnitInterval(obj.confidence)) errors.push("confidence_out_of_range");
  if (typeof obj.insight !== "string" || !obj.insight.trim()) errors.push("insight_missing");
  if (!Array.isArray(obj.refs) || obj.refs.length === 0 || obj.refs.some(r => typeof r !== "string" || !r.trim())) errors.push("refs_missing");
  if (round > 1 && (typeof obj.responds_to !== "string" || obj.responds_to === agent || !BUS_AGENTS.includes(obj.responds_to))) errors.push("responds_to_invalid");
  errors.push(...naturalLanguageErrors(obj.insight));
  return { valid: errors.length === 0, errors };
}

export function validateModeratorOutput(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { valid: false, errors: ["not_an_object"] };
  if (!BUS_STANCES.includes(obj.stance)) errors.push("stance_invalid");
  if (!inUnitInterval(obj.confidence)) errors.push("confidence_out_of_range");
  if (typeof obj.agreed !== "boolean") errors.push("agreed_missing");
  if (typeof obj.summary !== "string" || !obj.summary.trim()) errors.push("summary_missing");
  if (!Array.isArray(obj.dissent) || obj.dissent.some(d => typeof d !== "string")) errors.push("dissent_invalid");
  else errors.push(...naturalLanguageErrors([obj.summary, ...obj.dissent].join(" ")));
  return { valid: errors.length === 0, errors };
}

/** Parsed JSON object from a model result (string content, or an already-parsed `response`). */
export function parseModelObject(result) {
  if (result && typeof result === "object" && result.response && typeof result.response === "object" && !Array.isArray(result.response)) {
    return { obj: result.response, text: JSON.stringify(result.response) };
  }
  const first = Array.isArray(result?.choices) ? result.choices[0] : null;
  if (first?.finish_reason === "length" && !(typeof first?.message?.content === "string" && first.message.content.trim())) {
    return { obj: null, text: extractModelText(result), truncated: true };
  }
  const text = cleanModelText(extractModelText(result));
  const obj = extractJsonObject(text);
  // An answer cut off by the token limit is recorded as such, not as malformed output.
  return obj || first?.finish_reason !== "length" ? { obj, text } : { obj: null, text, truncated: true };
}

function usageTokens(result) {
  const u = result?.usage;
  if (!u || typeof u !== "object") return null;
  const total = Number(u.total_tokens ?? (Number(u.prompt_tokens || 0) + Number(u.completion_tokens || 0)));
  return Number.isFinite(total) && total > 0 ? Math.round(total) : null;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("bus_call_timeout"), { name: "TimeoutError" })), Math.max(1, ms)); })
  ]).finally(() => clearTimeout(timer));
}

// The fallback (glm-4.7-flash) is a reasoning model without reasoning_effort: its hidden
// trace shares max_tokens with the answer, and at the primary's budget it was cut off
// mid-JSON (preview-e2e, PR #95). It gets twice the budget.
export const FALLBACK_TOKEN_FACTOR = 2;

function requestFor(model, messages, schemaName, schema, maxTokens, effort, primary) {
  // The primary model (glm-5.3-flash) takes the Chat Completions form with a
  // strict json_schema and reasoning_effort (low | high | max; "medium" would
  // map to max). The fallback model gets the plain chat form; its output is
  // validated the same way afterwards.
  return primary
    ? { messages, max_completion_tokens: maxTokens, temperature: 0.1, reasoning_effort: effort, response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } } }
    : { messages, max_tokens: maxTokens * FALLBACK_TOKEN_FACTOR, temperature: 0.1 };
}

/**
 * One model call with a single fallback retry. Returns the parsed object plus
 * call metadata. Never throws.
 */
/**
 * Workers AI per-minute rate limit (error 3021). The limit is shared by every room and by the
 * preview-e2e runs of the same account (production 2026-11-06: a room started right after another
 * lost 14 of 18 openings; a preview run beside the 15m War Room lost two HUD openings). It is
 * transient, so a rate-limited call waits and tries the same model once more, within its deadline,
 * instead of failing the agent or marking the primary model as failed for the rest of the run.
 */
export const RATE_LIMIT_RETRY_MS = 12_000;
export function isRateLimited(error) {
  // 3040 "Capacity temporarily exceeded" (production 2026-11-06 12:01, a whole War Room lost) is
  // as transient as the per-minute limit, so it gets the same single wait-and-retry.
  return /\b3021\b|rate limit|\b3040\b|capacity temporarily exceeded/i.test(String(error?.message || error || ""));
}

/**
 * Fallback reliability (owner decision 2026-11-06, after three preview-e2e failures that day):
 * - A primary TIMEOUT is transient: the step falls back, but the next step tries the primary
 *   again. Only the PRIMARY_TIMEOUTS_TO_PIN-th timeout in a run pins the fallback (each costs up to
 *   60 s of the wall budget). Any other primary error pins it at once, as before.
 * - A fallback answer cut off by its token limit (finish_reason length: the reasoning model spent
 *   the budget on hidden reasoning) is asked once more with twice the budget and a brevity note,
 *   when FALLBACK_RETRY_MIN_MS are left before the deadline.
 */
export const PRIMARY_TIMEOUTS_TO_PIN = 2;
export const FALLBACK_RETRY_MIN_MS = 30_000;
export const FALLBACK_BRIEF_NOTE = "Your previous answer ran out of tokens before the JSON. Reply with the JSON object only. Keep any reasoning very short.";

export async function callBusModel(env, { messages, schemaName, schema, maxTokens, effort, deadline, clock, runState = {} }) {
  const primary = String(env?.MULTI_AGENT_MODEL || BUS_DEFAULT_MODEL);
  const fallback = String(env?.MULTI_AGENT_FALLBACK_MODEL || BUS_DEFAULT_FALLBACK_MODEL);
  const primaryTimeoutMs = Number(env?.BUS_PRIMARY_TIMEOUT_MS) > 0 ? Number(env.BUS_PRIMARY_TIMEOUT_MS) : PRIMARY_CALL_TIMEOUT_MS;
  const attempts = [];
  // Once the primary model is pinned as failed in this run, later steps go straight to
  // the fallback instead of spending the wall budget on the same error again.
  if (!runState.primaryError) attempts.push({ model: primary, primary: true });
  if (fallback && fallback !== primary) attempts.push({ model: fallback, primary: false });
  if (!attempts.length) attempts.push({ model: primary, primary: true });
  let lastError = null;
  let usage = 0;
  let callPrimaryError = null;
  let extraCalls = 0;
  const meta = (i) => ({ fallback_used: !attempts[i].primary, primary_error: callPrimaryError || runState.primaryError || null });
  const waitMs = Number.isFinite(Number(env?.MODEL_RATE_LIMIT_RETRY_MS)) ? Number(env.MODEL_RATE_LIMIT_RETRY_MS) : RATE_LIMIT_RETRY_MS;
  let rateRetried = false;
  for (let i = 0; i < attempts.length; i++) {
    const { model, primary: isPrimary } = attempts[i];
    const remaining = deadline - clock();
    if (remaining <= 0) return { status: "budget_exhausted", model, ...meta(i), usage_tokens: usage || null, calls: i };
    const t0 = clock();
    try {
      const timeout = isPrimary ? Math.min(remaining, primaryTimeoutMs) : remaining;
      const result = await withTimeout(env.AI.run(model, requestFor(model, messages, schemaName, schema, maxTokens, effort, isPrimary)), timeout);
      usage += usageTokens(result) || 0;
      let parsed = parseModelObject(result);
      if (!isPrimary && parsed.truncated === true && deadline - clock() > FALLBACK_RETRY_MIN_MS) {
        // The fallback spent its budget on hidden reasoning: once more, briefly, with twice the budget.
        console.warn("bus_fallback_truncated_retry", JSON.stringify({ model }));
        const brief = [...messages.slice(0, -1), { ...messages.at(-1), content: `${messages.at(-1)?.content ?? ""}\n\n${FALLBACK_BRIEF_NOTE}` }];
        const request = { ...requestFor(model, brief, schemaName, schema, maxTokens, effort, false) };
        request.max_tokens = request.max_tokens * 2;
        extraCalls += 1;
        try {
          const retry = await withTimeout(env.AI.run(model, request), Math.max(1, deadline - clock()));
          usage += usageTokens(retry) || 0;
          parsed = parseModelObject(retry);
        } catch (retryError) {
          console.warn("bus_fallback_retry_failed", JSON.stringify({ model, error: clip(retryError?.message || String(retryError), 200) }));
        }
      }
      return { status: "answered", model, ...meta(i), usage_tokens: usage || null, latency_ms: clock() - t0, obj: parsed.obj, text: parsed.text, truncated: parsed.truncated === true, calls: i + 1 + extraCalls };
    } catch (error) {
      lastError = error;
      const message = error?.name === "TimeoutError" ? "timeout" : clip(error?.message || String(error) || "model_error", 300);
      if (!rateRetried && isRateLimited(error) && deadline - clock() > waitMs + 5_000) {
        rateRetried = true;
        console.warn("bus_model_rate_limited", JSON.stringify({ model, retry_in_ms: waitMs }));
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        i -= 1; // the same model once more
        continue;
      }
      if (isPrimary) {
        callPrimaryError = `${model}: ${message}`;
        const timedOut = error?.name === "TimeoutError";
        if (timedOut) runState.primaryTimeouts = (runState.primaryTimeouts || 0) + 1;
        // A timeout pins the fallback only once it repeats in this run; other errors pin at once.
        if (!timedOut || runState.primaryTimeouts >= PRIMARY_TIMEOUTS_TO_PIN) runState.primaryError = callPrimaryError;
        console.warn("bus_primary_model_failed", JSON.stringify({ model, error: message, pinned: Boolean(runState.primaryError) }));
        continue;
      }
      return { status: "agent_failed", model, ...meta(i), usage_tokens: usage || null, latency_ms: clock() - t0, error: message, calls: i + 1 };
    }
  }
  const last = attempts.length - 1;
  return { status: "agent_failed", model: attempts[last].model, ...meta(last), usage_tokens: usage || null, error: clip(lastError?.message || "model_error", 300), calls: attempts.length };
}

async function callsInLastHour(db, now) {
  // ts is stored as an ISO string; compare against an ISO cutoff (not datetime('now')).
  const cutoff = new Date(now - 60 * 60 * 1000).toISOString();
  const row = await db.prepare("SELECT COALESCE(SUM(1 + COALESCE(fallback_used, 0) + CASE WHEN json_valid(insight) THEN COALESCE(json_extract(insight, '$.corrections'), 0) ELSE 0 END), 0) AS n FROM bus_messages WHERE ts >= ? AND status <> 'budget_exhausted'").bind(cutoff).first();
  const n = Number(row?.n);
  if (!Number.isFinite(n)) throw new Error("bus_budget_unavailable");
  return n;
}

async function writeMessage(db, msg) {
  await db.prepare(
    "INSERT OR IGNORE INTO bus_messages (run_id, candle_key, round, agent, ts, insight, confidence, refs_json, model, status, latency_ms, fallback_used, usage_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    msg.run_id, msg.candle_key, msg.round, msg.agent, msg.ts, msg.insight, msg.confidence ?? null,
    JSON.stringify(msg.refs ?? []), msg.model ?? null, msg.status, msg.latency_ms ?? null, msg.fallback_used ? 1 : 0, msg.usage_tokens ?? null
  ).run();
}

/** Stored row -> message object (insight of agent rows is JSON with stance etc.). */
export function rowToMessage(row) {
  const body = parseJson(row?.insight, null);
  const structured = body && typeof body === "object" && !Array.isArray(body);
  return {
    id: row?.id ?? null,
    run_id: row?.run_id,
    candle_key: row?.candle_key,
    round: Number(row?.round),
    agent: row?.agent,
    ts: row?.ts,
    status: row?.status,
    model: row?.model ?? null,
    fallback_used: Number(row?.fallback_used || 0) === 1,
    usage_tokens: row?.usage_tokens ?? null,
    latency_ms: row?.latency_ms ?? null,
    confidence: row?.confidence ?? null,
    refs: parseJson(row?.refs_json, []) || [],
    ...(structured ? body : { insight: String(row?.insight ?? "") })
  };
}

/**
 * Validates an answer; one that is valid except that its text reads like code gets one
 * correction call (the same rule as the Thread rooms in agent-threads.mjs). Never runs past the
 * wall deadline or without budget. Returns the call to record, its validation and the extra calls.
 */
async function validateWithCorrection(env, opts, call, validate, { budgetOk, clock, deadline }) {
  if (call.status !== "answered") return { call, validation: null, extraCalls: 0, corrections: 0 };
  const validation = call.truncated ? { valid: false, errors: [] } : validate(call.obj);
  if (validation.valid || call.truncated || !onlyNaturalLanguageErrors(validation.errors) || clock() >= deadline || !(await budgetOk())) {
    return { call, validation, extraCalls: 0, corrections: 0 };
  }
  const retry = await callBusModel(env, { ...opts, messages: [...opts.messages, { role: "assistant", content: String(call.text ?? "") }, { role: "user", content: NATURAL_LANGUAGE_CORRECTION }] });
  const extraCalls = retry.calls || 0;
  const sum = (a, b) => { const xs = [a, b].map(Number).filter(Number.isFinite); return xs.length ? xs.reduce((x, y) => x + y, 0) : null; };
  if (retry.status === "answered" && !retry.truncated) {
    const second = validate(retry.obj);
    if (second.valid) {
      return { call: { ...retry, usage_tokens: sum(call.usage_tokens, retry.usage_tokens), latency_ms: sum(call.latency_ms, retry.latency_ms), fallback_used: Boolean(call.fallback_used || retry.fallback_used) }, validation: second, extraCalls, corrections: Math.max(1, extraCalls) };
    }
  }
  return { call: { ...call, usage_tokens: sum(call.usage_tokens, retry.usage_tokens), latency_ms: sum(call.latency_ms, retry.latency_ms) }, validation, extraCalls, corrections: Math.max(1, extraCalls) };
}

function messageFromCall(base, call, obj, validation, kind, extra = {}) {
  const diag = { ...(call.primary_error ? { primary_error: call.primary_error } : {}), ...extra };
  if (call.status !== "answered") {
    return { ...base, status: call.status, insight: JSON.stringify({ insight: call.status === "budget_exhausted" ? "budget exhausted" : "agent failed: " + (call.error || "error"), ...diag }), confidence: null, refs: [], model: call.model, fallback_used: call.fallback_used, usage_tokens: call.usage_tokens, latency_ms: call.latency_ms ?? null };
  }
  if (!validation.valid) {
    return { ...base, status: "invalid_output", insight: JSON.stringify({ insight: clip(call.text, RAW_MAX), errors: call.truncated ? ["finish_reason_length", ...validation.errors] : validation.errors, ...diag }), confidence: null, refs: [], model: call.model, fallback_used: call.fallback_used, usage_tokens: call.usage_tokens, latency_ms: call.latency_ms };
  }
  const body = kind === "moderator"
    ? { stance: obj.stance, agreed: obj.agreed, summary: clip(obj.summary, SUMMARY_MAX), dissent: obj.dissent.map(d => clip(d, 300)).slice(0, 10) }
    : { stance: obj.stance, insight: clip(obj.insight, INSIGHT_MAX), responds_to: obj.responds_to ?? null };
  Object.assign(body, diag);
  return { ...base, status: STATUS_OK, insight: JSON.stringify(body), confidence: obj.confidence, refs: kind === "moderator" ? [] : obj.refs.slice(0, 12).map(r => clip(r, 200)), model: call.model, fallback_used: call.fallback_used, usage_tokens: call.usage_tokens, latency_ms: call.latency_ms };
}

/**
 * Runs the bus for one persisted synthesis. Idempotent per (candle_key, run_id):
 * stored rows are reused, so a redelivered queue message makes no new model calls
 * for the steps that already exist. Never throws for model/output problems.
 */
export async function runMultiAgentBus(env, task, { clock = () => Date.now() } = {}) {
  if (!busEnabled(env)) return { status: "disabled", calls: 0 };
  const db = env.DB;
  await ensureBusSchema(db);
  const runId = String(task.input_fingerprint);
  const candleKey = String(task.candle_key);
  const row = await db.prepare("SELECT candle_key, ai_analysis, prophet_metrics, gmi_metrics FROM ai_syntheses WHERE candle_key = ? ORDER BY id DESC LIMIT 1").bind(candleKey).first();
  if (!row) return { status: "no_synthesis", calls: 0 };
  const evidence = buildBusEvidence(row);

  const existingRows = (await db.prepare("SELECT * FROM bus_messages WHERE candle_key = ? AND run_id = ? ORDER BY round, id").bind(candleKey, runId).all()).results || [];
  const existing = new Map(existingRows.map(r => [`${r.round}:${r.agent}`, rowToMessage(r)]));
  if (existing.has(`${BUS_MODERATOR_ROUND}:moderator`)) return { status: "already_complete", calls: 0 };

  const started = clock();
  const runState = { primaryError: null };
  const deadline = started + BUS_WALL_BUDGET_MS;
  const maxPerHour = Number(env.MULTI_AGENT_MAX_CALLS_PER_HOUR ?? 20);
  let calls = 0;

  const budgetOk = async () => {
    if (clock() >= deadline) return false;
    try {
      return (await callsInLastHour(db, clock())) < (Number.isFinite(maxPerHour) ? maxPerHour : 0);
    } catch {
      return false; // fail closed
    }
  };

  const transcript = [];
  for (let round = 1; round <= BUS_ROUNDS; round++) {
    const roundOne = transcript.filter(m => m.round === 1);
    for (const agent of BUS_AGENTS) {
      const key = `${round}:${agent}`;
      if (existing.has(key)) { transcript.push(existing.get(key)); continue; }
      const base = { run_id: runId, candle_key: candleKey, round, agent, ts: new Date(clock()).toISOString() };
      let msg;
      if (!(await budgetOk())) {
        msg = messageFromCall(base, { status: "budget_exhausted", model: null, fallback_used: false, usage_tokens: null }, null, null, "agent");
      } else {
        const opts = {
          messages: agentMessages(agent, round, evidence[agent], roundOne), schemaName: "bus_agent", schema: AGENT_JSON_SCHEMA,
          maxTokens: BUS_MAX_TOKENS.agent, effort: "low", deadline, clock, runState
        };
        const first = await callBusModel(env, opts);
        calls += first.calls || 0;
        const { call, validation, extraCalls, corrections } = await validateWithCorrection(env, opts, first, (o) => validateAgentOutput(o, { agent, round }), { budgetOk, clock, deadline });
        calls += extraCalls;
        msg = messageFromCall(base, call, call.obj, validation || { valid: false, errors: [] }, "agent", corrections ? { corrections } : {});
      }
      await writeMessage(db, msg);
      transcript.push(rowToMessage(msg));
    }
  }

  const modBase = { run_id: runId, candle_key: candleKey, round: BUS_MODERATOR_ROUND, agent: "moderator", ts: new Date(clock()).toISOString() };
  let modMsg;
  if (!(await budgetOk())) {
    modMsg = messageFromCall(modBase, { status: "budget_exhausted", model: null, fallback_used: false, usage_tokens: null }, null, null, "moderator");
  } else {
    const opts = {
      messages: moderatorMessages(evidence, transcript), schemaName: "bus_moderator", schema: MODERATOR_JSON_SCHEMA,
      maxTokens: BUS_MAX_TOKENS.moderator, effort: "high", deadline, clock, runState
    };
    const first = await callBusModel(env, opts);
    calls += first.calls || 0;
    const { call, validation, extraCalls, corrections } = await validateWithCorrection(env, opts, first, validateModeratorOutput, { budgetOk, clock, deadline });
    calls += extraCalls;
    modMsg = messageFromCall(modBase, call, call.obj, validation || { valid: false, errors: [] }, "moderator", corrections ? { corrections } : {});
  }
  await writeMessage(db, modMsg);
  transcript.push(rowToMessage(modMsg));
  return { status: "complete", calls, messages: transcript.length };
}

/** Read model for GET /api/bus. */
export async function readBus(db, candleKey) {
  await ensureBusSchema(db);
  const stmt = candleKey
    ? db.prepare("SELECT * FROM bus_messages WHERE candle_key = ? ORDER BY id").bind(candleKey)
    : db.prepare("SELECT * FROM bus_messages ORDER BY id DESC LIMIT 50");
  const items = ((await stmt.all()).results || []).map(rowToMessage);
  if (!candleKey) return { items, consensus: null, agreement_with_chain: null, chain_decision: null };
  const latestRun = items.length ? items[items.length - 1].run_id : null;
  const runItems = items.filter(m => m.run_id === latestRun);
  const moderator = runItems.find(m => m.agent === "moderator" && m.status === STATUS_OK) || null;
  const synth = await db.prepare("SELECT ai_analysis FROM ai_syntheses WHERE candle_key = ? ORDER BY id DESC LIMIT 1").bind(candleKey).first();
  const chainDecision = parseJson(synth?.ai_analysis, {})?.decision?.decision ?? null;
  const consensus = moderator ? { stance: moderator.stance, confidence: moderator.confidence, agreed: moderator.agreed, summary: moderator.summary, dissent: moderator.dissent || [], model: moderator.model } : null;
  return {
    run_id: latestRun,
    items: runItems,
    consensus,
    chain_decision: chainDecision,
    agreement_with_chain: consensus && chainDecision ? consensus.stance === String(chainDecision).toUpperCase() : null
  };
}
