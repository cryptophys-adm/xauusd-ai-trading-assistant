// The model call shared by every room, thread and council (moved here from the retired H1 multi-agent bus;
// owner 2026-11-15: "setuju semuanya"). callBusModel asks the role's primary model with one fallback, the
// rate-limit and timeout rules below, and meters each call under its schema name (src/ai-usage.mjs). The news
// thread's schemas, validators and technical evidence (buildBusEvidence, from the H1 synthesis) live here too;
// the names keep their BUS_ prefix so the rooms' imports stay as they were. The bus itself (its runner, queue
// task, bus_messages and GET /api/bus) is gone.

import { cleanModelText, extractJsonObject, extractModelText, MODELS, runModel, responsesIncomplete } from "./model-text.mjs";
import { naturalLanguageErrors } from "./natural-language.mjs";
import { interpretWebhookRow } from "./webhook-interpretation.mjs";
import { recordAiUsage } from "./ai-usage.mjs";

// Model migration (owner decision 2026-11-07; glm-5.3-flash stops answering on 2026-11-20): room
// agents speak on gemma-4-26b-a4b-it with thinking off, moderators conclude on gpt-oss-120b.
export const BUS_DEFAULT_MODEL = MODELS.GEMMA_4;
export const BUS_DEFAULT_FALLBACK_MODEL = MODELS.GPT_OSS_20B;
export const MODERATOR_DEFAULT_MODEL = MODELS.GPT_OSS_120B;
export const MODERATOR_DEFAULT_FALLBACK_MODEL = MODELS.GEMMA_4;

/**
 * The model of each role. Per-role variables win; MULTI_AGENT_MODEL / MULTI_AGENT_FALLBACK_MODEL
 * still override every role when set (tests, rollback); otherwise the defaults above. An empty
 * fallback ("") turns the fallback off.
 *   agent      ROOM_AGENT_MODEL, ROOM_AGENT_FALLBACK_MODEL (openings, Consensus Discussion, tags)
 *   moderator  MODERATOR_MODEL, MODERATOR_FALLBACK_MODEL (conclusions, the News Daily TLDR)
 */
export const ROLE_MODEL_VARS = Object.freeze({
  agent: { primary: "ROOM_AGENT_MODEL", fallback: "ROOM_AGENT_FALLBACK_MODEL", defaults: [BUS_DEFAULT_MODEL, BUS_DEFAULT_FALLBACK_MODEL] },
  moderator: { primary: "MODERATOR_MODEL", fallback: "MODERATOR_FALLBACK_MODEL", defaults: [MODERATOR_DEFAULT_MODEL, MODERATOR_DEFAULT_FALLBACK_MODEL] }
});
export function roleModels(env, role = "agent") {
  const r = ROLE_MODEL_VARS[role] || ROLE_MODEL_VARS.agent;
  const set = (k) => env?.[k] != null;
  const primary = String((set(r.primary) && env[r.primary]) || (set("MULTI_AGENT_MODEL") && env.MULTI_AGENT_MODEL) || r.defaults[0]);
  const fallback = String(set(r.fallback) ? env[r.fallback] : set("MULTI_AGENT_FALLBACK_MODEL") ? env.MULTI_AGENT_FALLBACK_MODEL : r.defaults[1]);
  return { primary, fallback };
}
/** The news thread's two agents (its schema's agent enum). */
export const BUS_AGENTS = Object.freeze(["technical", "news"]);
const PRIMARY_CALL_TIMEOUT_MS = 60_000;
// Room for a reasoning model's hidden trace before the JSON answer (gpt-oss reasons at low effort;
// gemma-4 runs with thinking off).
export const BUS_MAX_TOKENS = Object.freeze({ agent: 3072, moderator: 4096 });
export const BUS_STANCES = Object.freeze(["BUY", "SELL", "WAIT"]);

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
  prophet_r38: ["direction", "buy_confirmed", "sell_confirmed", "buy_high_quality", "sell_high_quality", "t_enc", "d_enc", "structure_subtype", "setup_state", "o", "h", "l", "c", "volume", "candle_time"],
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
  const cutOff = first?.finish_reason === "length" || responsesIncomplete(result);
  if (cutOff && /^\[no answer:/.test(extractModelText(result))) {
    return { obj: null, text: extractModelText(result), truncated: true };
  }
  const text = cleanModelText(extractModelText(result));
  const obj = extractJsonObject(text);
  // An answer cut off by the token limit is recorded as such, not as malformed output.
  return obj || !cutOff ? { obj, text } : { obj: null, text, truncated: true };
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

/** One call in the request forms of its model family (model-text.mjs modelRequests). The fallback gets twice the budget. */
/**
 * A5: the session-affinity id of a call: one per agent and step kind (for example "xauusd:warroom:open:technical"),
 * so the bars of one agent's step go to the instance holding its prompt prefix. AI_SESSION_AFFINITY "off" sends none.
 */
export function affinityId(env, key) {
  if (String(env?.AI_SESSION_AFFINITY ?? "on").trim().toLowerCase() === "off" || !key) return null;
  return `xauusd:${String(key).toLowerCase().replace(/[^a-z0-9:_-]/g, "_")}`.slice(0, 120);
}

function callModel(env, model, messages, schemaName, schema, maxTokens, effort, primary, meterSource = null, affinity = null) {
  // The usage meter (src/ai-usage.mjs) labels each call with its schema name: war_room_opening, tf_room_rebuttal, ...
  // A shadow call is labelled "shadow:<schema name>" (src/shadow-switch.mjs counts them against the day's budget).
  const meter = env?.DB?.prepare ? { db: env.DB, source: meterSource || schemaName || "bus" } : null;
  return runModel(env.AI, model, { messages, schemaName, schema, effort, maxTokens: primary ? maxTokens : maxTokens * FALLBACK_TOKEN_FACTOR, meter, affinity: affinityId(env, affinity ?? meterSource ?? schemaName) }).then((r) => r.result);
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
/** Time a primary call leaves for the fallback model after it. */
export const FALLBACK_RESERVE_MS = 20_000;
export const FALLBACK_BRIEF_NOTE = "Your previous answer ran out of tokens before the JSON. Reply with the JSON object only. Keep any reasoning very short.";

export async function callBusModel(env, { messages, schemaName, schema, maxTokens, effort, deadline, clock, runState = {}, role = "agent", skipPrimary = null, meterSource = null, affinity = null }) {
  const { primary, fallback } = roleModels(env, role);
  const primaryTimeoutMs = Number(env?.BUS_PRIMARY_TIMEOUT_MS) > 0 ? Number(env.BUS_PRIMARY_TIMEOUT_MS) : PRIMARY_CALL_TIMEOUT_MS;
  const attempts = [];
  // Once the primary model is pinned as failed in this run, later steps go straight to
  // the fallback instead of spending the wall budget on the same error again.
  // A pin belongs to the model that failed: a room's agents and its moderator use different models.
  const pinned = Boolean(runState.primaryError) && (runState.primaryErrorModel ?? primary) === primary;
  // skipPrimary: the primary answered but its answer was rejected; only the fallback is asked.
  if (!pinned && !skipPrimary) attempts.push({ model: primary, primary: true });
  if (fallback && fallback !== primary) attempts.push({ model: fallback, primary: false });
  if (!attempts.length) attempts.push({ model: primary, primary: true });
  let lastError = null;
  let usage = 0;
  let callPrimaryError = skipPrimary ? `${primary}: ${skipPrimary}` : null;
  let extraCalls = 0;
  const meta = (i) => ({ fallback_used: !attempts[i].primary, primary_error: callPrimaryError || (pinned ? runState.primaryError : null) || null });
  const waitMs = Number.isFinite(Number(env?.MODEL_RATE_LIMIT_RETRY_MS)) ? Number(env.MODEL_RATE_LIMIT_RETRY_MS) : RATE_LIMIT_RETRY_MS;
  let rateRetried = false;
  for (let i = 0; i < attempts.length; i++) {
    const { model, primary: isPrimary } = attempts[i];
    const remaining = deadline - clock();
    // Nothing was asked of this model: the row names no model and no fallback use.
    if (remaining <= 0) return { status: "budget_exhausted", model: null, fallback_used: false, primary_error: meta(i).primary_error, usage_tokens: usage || null, calls: i };
    // The primary leaves FALLBACK_RESERVE_MS for the fallback after it (production 2026-11-09: the
    // 15m conclusion's primary timed out at the deadline, the fallback never ran).
    const reserve = isPrimary && i < attempts.length - 1 ? FALLBACK_RESERVE_MS : 0;
    if (isPrimary && reserve && remaining <= reserve) { callPrimaryError = `${model}: skipped, ${Math.round(remaining / 1000)} s left for the fallback`; continue; }
    const t0 = clock();
    try {
      const timeout = isPrimary ? Math.min(remaining - reserve, primaryTimeoutMs) : remaining;
      const result = await withTimeout(callModel(env, model, messages, schemaName, schema, maxTokens, effort, isPrimary, meterSource, affinity), timeout);
      usage += usageTokens(result) || 0;
      let parsed = parseModelObject(result);
      if (!isPrimary && parsed.truncated === true && deadline - clock() > FALLBACK_RETRY_MIN_MS) {
        // The fallback spent its budget on hidden reasoning: once more, briefly, with twice the budget.
        console.warn("bus_fallback_truncated_retry", JSON.stringify({ model }));
        const brief = [...messages.slice(0, -1), { ...messages.at(-1), content: `${messages.at(-1)?.content ?? ""}\n\n${FALLBACK_BRIEF_NOTE}` }];
        extraCalls += 1;
        try {
          const retry = await withTimeout(callModel(env, model, brief, schemaName, schema, maxTokens * 2, effort, false, meterSource, affinity), Math.max(1, deadline - clock()));
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
      // An abandoned call is still billed when it finishes; the meter counts the abandonment.
      if (error?.name === "TimeoutError") await recordAiUsage(env?.DB, { source: meterSource || schemaName || "bus", model, outcome: "timeout", now: clock() });
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
        if (!timedOut || runState.primaryTimeouts >= PRIMARY_TIMEOUTS_TO_PIN) { runState.primaryError = callPrimaryError; runState.primaryErrorModel = primary; }
        console.warn("bus_primary_model_failed", JSON.stringify({ model, error: message, pinned: Boolean(runState.primaryError) }));
        continue;
      }
      return { status: "agent_failed", model, ...meta(i), usage_tokens: usage || null, latency_ms: clock() - t0, error: message, calls: i + 1 };
    }
  }
  const last = attempts.length - 1;
  return { status: "agent_failed", model: attempts[last].model, ...meta(last), usage_tokens: usage || null, error: clip(lastError?.message || "model_error", 300), calls: attempts.length };
}
