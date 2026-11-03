import type { EvidenceBundle, HandoffResponse } from "../lib/contracts.ts";
import {
  SCHEMA_VERSION,
  buildCandleKey,
  nowIso,
} from "../lib/contracts.ts";
import {
  verifyHandoffRequest,
  AUTH_SCHEME,
  REPLAY_RECORD_TTL_SECONDS,
} from "../lib/auth.ts";
import { validateBundle } from "../lib/validation.ts";
import { DASHBOARD_HTML } from "./dashboard.ts";

export interface Env {
  DB: D1Database;
  SIGNAL_CACHE: KVNamespace;
  WEBHOOK_BUFFER: KVNamespace;
  KNOWLEDGE_BASE: KVNamespace;
  AI: Ai;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  WEBHOOK_SECRET?: string;
  INGEST_URL?: string;
  INGEST_SECRET?: string;
  AI_MODEL_ANALYST: string;
  AI_MODEL_COUNSELOR: string;
  AI_MODEL_REASONER: string;
  REQUIRED_SOURCES: string;
  /** Shared secret for authenticated Controller -> AI Worker handoff. */
  CONFLUENCE_HANDOFF_SECRET?: string;
  /** RPC service binding to the News Ingestion Worker (replaces HTTP + INGEST_SECRET). */
  NEWS_INGESTION?: {
    pull(options?: { forceRefresh?: boolean; origin?: string }): Promise<Record<string, unknown>>;
  };
  /** Durable queue for webhook reconciliation and canonical AI analysis. */
  XAUUSD_EVENTS?: Queue<QueueTask>;
}

type QueueTask =
  | {
      kind: "webhook_reconcile";
      event_id: string;
      candle_key: string;
      source: string;
      ticker: string;
      timeframe: string;
      enqueued_at: string;
    }
  | {
      kind: "analysis";
      event_id: string;
      request_id: string;
      candle_key: string;
      enqueued_at: string;
      bundle: EvidenceBundle;
    };

type JsonObject = Record<string, unknown>;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const SOURCE_ALIASES: Record<string, string> = {
  prophet_r38: "prophet_r38",
  "prophet-r38": "prophet_r38",
  "prophet r38": "prophet_r38",
  prophet_r37_ssot: "prophet_r37_ssot",
  "prophet-r37-ssot": "prophet_r37_ssot",
  "prophet r37 ssot": "prophet_r37_ssot",
  gmi_v12_70: "gmi_v12_70",
  "gmi-v12.70": "gmi_v12_70",
  "gmi v12.70": "gmi_v12_70"
};

/** Maximum body size accepted on mutation endpoints (1 MiB). */
const MAX_BODY_BYTES = 1024 * 1024;

function json(data: unknown, status = 200, request?: Request): Response {
  const response = new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
  if (request) applyCors(response, request);
  return response;
}

const ALLOWED_CORS_ORIGINS = new Set([
  "https://nexus.cryptophys.work",
  "https://ai.cryptophys.work"
]);

function corsOrigin(request: Request): string | null {
  const origin = request.headers.get("Origin");
  return origin && ALLOWED_CORS_ORIGINS.has(origin) ? origin : null;
}

function applyCors(response: Response, request: Request): Response {
  const origin = corsOrigin(request);
  if (origin) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Vary", "Origin");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "content-type, x-webhook-secret, x-request-id, x-request-timestamp, x-content-sha256, x-signature, x-auth-scheme");
  }
  return response;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Fetch fundamental news via the News Ingestion Worker over RPC (Service Binding).
 * Replaces the previous HTTP call to https://news.cryptophys.work/pull which
 * required a shared INGEST_SECRET. Returns null when the binding is unavailable
 * or the call fails, so callers can degrade gracefully.
 */
async function fetchNewsViaIngestion(env: Env, options?: { forceRefresh?: boolean }): Promise<Record<string, unknown> | null> {
  if (!env.NEWS_INGESTION) return null;
  try {
    return await env.NEWS_INGESTION.pull({ forceRefresh: options?.forceRefresh });
  } catch (error) {
    console.error("news_ingestion_rpc_failed", error instanceof Error ? error.message : "unknown");
    return null;
  }
}

function safeKeyPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 180);
}

function extractText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as JsonObject;
    for (const key of ["response", "output_text", "text"]) {
      if (typeof r[key] === "string") return r[key] as string;
    }
    const choices = r.choices;
    if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
      const first = choices[0] as JsonObject;
      if (typeof first.text === "string") return first.text;
      const message = first.message;
      if (message && typeof message === "object") {
        const content = (message as JsonObject).content;
        if (typeof content === "string") return content;
      }
    }
    return JSON.stringify(result);
  }
  return String(result ?? "");
}

function parseDecision(text: string): JsonObject {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as JsonObject;
      const decision = asText(parsed.decision).toUpperCase();
      if (["BUY", "SELL", "WAIT", "NO_TRADE"].includes(decision)) {
        return { ...parsed, decision };
      }
    } catch {
      // Fall through to conservative WAIT decision.
    }
  }
  return {
    decision: "WAIT",
    confidence: null,
    reasoning: "Model response did not contain a valid decision JSON object.",
    raw_response: text
  };
}

async function sendTelegram(env: Env, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true
    })
  });
  if (!response.ok) {
    throw new Error("Telegram delivery failed with HTTP " + response.status);
  }
}

/** Read request body bounded by MAX_BODY_BYTES; aborts the stream when exceeded. */
async function readBoundedBody(request: Request): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const len = Number.parseInt(contentLength, 10);
    if (!Number.isFinite(len) || len < 0 || len > MAX_BODY_BYTES) {
      throw new Error("Request body too large");
    }
  }
  const chunks: Uint8Array[] = [];
  const reader = request.body?.getReader();
  if (!reader) return "";
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        reader.releaseLock();
        throw new Error("Request body too large");
      }
      chunks.push(value);
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function normalizeSource(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return SOURCE_ALIASES[value.trim().toLowerCase()] || null;
}

/* ------------------------------------------------------------------ */
/* Legacy TradingView webhook (transitional, backward compatible).    */
/*                                                                    */
/* This endpoint INGESTS indicator source payloads only. It does NOT  */
/* perform evidence fusion or AI analysis. Fusion is owned by the     */
/* Confluence Controller, which pushes validated bundles to           */
/* POST /v1/analyze. The webhook path is kept operational so no       */
/* TradingView alert flow is cut during the migration.                */
/* ------------------------------------------------------------------ */

type WebhookPayload = {
  secret?: string;
  source?: string;
  ticker?: string;
  symbol?: string;
  timeframe?: string;
  timestamp?: string;
  candle_time?: string;
  candle_key?: string;
  metrics?: unknown;
  [key: string]: unknown;
};

function requiredSources(env: Env): string[] {
  return (env.REQUIRED_SOURCES || "prophet_r38,prophet_r37_ssot,gmi_v12_70")
    .split(",").map(s => s.trim()).filter(Boolean);
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.WEBHOOK_SECRET) {
    return json({ error: "WEBHOOK_SECRET is not configured" }, 503);
  }
  if (!env.XAUUSD_EVENTS) {
    return json({ error: "XAUUSD_EVENTS queue is not configured" }, 503);
  }

  let body: WebhookPayload;
  try {
    const raw = await readBoundedBody(request);
    body = JSON.parse(raw) as WebhookPayload;
  } catch {
    return json({ error: "Request body must be valid JSON" }, 400);
  }

  const headerSecret = request.headers.get("x-webhook-secret") || "";
  const bodySecret = asText(body.secret);
  if (headerSecret !== env.WEBHOOK_SECRET && bodySecret !== env.WEBHOOK_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  const source = normalizeSource(body.source);
  if (!source) {
    return json({
      error: "Unsupported source",
      accepted_sources: ["prophet_r38", "prophet_r37_ssot", "gmi_v12_70"]
    }, 400);
  }

  const ticker = asText(body.ticker || body.symbol);
  const timeframe = asText(body.timeframe);
  const candleTime = asText(body.candle_time || body.timestamp);
  if (!ticker || !timeframe || !candleTime) {
    return json({ error: "ticker/symbol, timeframe, and candle_time/timestamp are required" }, 400);
  }

  const candleKey = safeKeyPart(asText(body.candle_key) || [ticker, timeframe, candleTime].join(":"));
  const storedPayload: WebhookPayload = { ...body, source, ticker, timeframe, candle_time: candleTime };
  delete storedPayload.secret;

  // Persist first. The UNIQUE(candle_key, source) D1 constraint and deterministic
  // KV key make duplicate webhook deliveries idempotent.
  await env.DB.prepare(
    "INSERT INTO webhook_sources (candle_key, source, payload) VALUES (?, ?, ?) ON CONFLICT(candle_key, source) DO UPDATE SET payload = excluded.payload, received_at = datetime('now')"
  ).bind(candleKey, source, JSON.stringify(storedPayload)).run();

  await env.WEBHOOK_BUFFER.put("candle:" + candleKey + ":" + source, JSON.stringify(storedPayload), {
    expirationTtl: 60 * 60 * 24 * 14
  });

  const task: QueueTask = {
    kind: "webhook_reconcile",
    event_id: `webhook:${candleKey}:${source}`,
    candle_key: candleKey,
    source,
    ticker,
    timeframe,
    enqueued_at: nowIso()
  };
  try {
    await env.XAUUSD_EVENTS.send(task, { contentType: "json" });
  } catch (error) {
    // Return 503 so TradingView retries. Evidence is already durable and the
    // deterministic event id plus candle_key+source persistence dedups retries.
    return json({
      error: "Failed to enqueue webhook event",
      candle_key: candleKey,
      source,
      reason: error instanceof Error ? error.message : "Unknown queue error"
    }, 503);
  }

  // ACK immediately after the durable enqueue. No source reconciliation or AI
  // work runs on the TradingView request path.
  return json({
    status: "accepted",
    analysis_status: "queued",
    queued: true,
    event_id: task.event_id,
    candle_key: candleKey,
    source
  }, 202);
}

async function reconcileWebhookTask(env: Env, task: Extract<QueueTask, { kind: "webhook_reconcile" }>): Promise<void> {
  const required = requiredSources(env);
  const receivedSources: string[] = [];
  for (const source of required) {
    const raw = await env.WEBHOOK_BUFFER.get("candle:" + task.candle_key + ":" + source);
    if (raw) receivedSources.push(source);
  }
  const missingSources = required.filter(source => !receivedSources.includes(source));
  const reconciledAt = nowIso();

  // Deterministic marker key makes repeated queue deliveries idempotent. Fusion
  // and AI analysis are not reintroduced into this legacy reconciliation path.
  await env.WEBHOOK_BUFFER.put(`reconciled:${task.candle_key}:${task.source}`, JSON.stringify({
    status: missingSources.length === 0 ? "sources_complete" : "waiting_for_sources",
    candle_key: task.candle_key,
    source: task.source,
    received_sources: receivedSources,
    missing_sources: missingSources,
    reconciled_at: reconciledAt
  }), { expirationTtl: 60 * 60 * 24 * 14 });
}

/* ------------------------------------------------------------------ */
/* Authenticated handoff: Confluence Controller -> AI Worker          */
/* ------------------------------------------------------------------ */

let replaySeen = new Map<string, number>(); // request_id -> timestamp ms

function pruneReplaySeen(): void {
  const cutoff = Date.now() - REPLAY_RECORD_TTL_SECONDS * 1000;
  for (const [id, ts] of replaySeen) {
    if (ts < cutoff) replaySeen.delete(id);
  }
}

/**
 * Atomically claim one analysis per candle and evidence fingerprint.
 * Complete/degraded runs with the same fingerprint are skipped; failed runs,
 * expired analyzing claims, and changed evidence are eligible for retry.
 */
async function claimAnalysisRun(env: Env, candleKey: string, fingerprint: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "INSERT INTO analysis_runs (candle_key, status, attempt_count, started_at, updated_at, result_json) " +
    "VALUES (?, 'analyzing', 1, datetime('now'), datetime('now'), json_object('input_fingerprint', ?)) " +
    "ON CONFLICT(candle_key) DO UPDATE SET status = 'analyzing', attempt_count = analysis_runs.attempt_count + 1, " +
    "started_at = datetime('now'), updated_at = datetime('now'), completed_at = NULL, error_code = NULL, " +
    "result_json = json_object('input_fingerprint', ?) " +
    "WHERE analysis_runs.status = 'failed' " +
    "OR (analysis_runs.status IN ('complete', 'degraded') AND COALESCE(json_extract(analysis_runs.result_json, '$.input_fingerprint'), '') != ?) " +
    "OR (analysis_runs.status = 'analyzing' AND analysis_runs.updated_at < datetime('now', '-10 minutes'))"
  ).bind(candleKey, fingerprint, fingerprint, fingerprint).run();
  return Number(result.meta?.changes || 0) > 0;
}

async function setAnalysisRunStatus(
  env: Env,
  candleKey: string,
  status: "complete" | "degraded" | "failed",
  fingerprint: string,
  errorCode: string | null = null
): Promise<void> {
  await env.DB.prepare(
    "UPDATE analysis_runs SET status = ?, updated_at = datetime('now'), " +
    "completed_at = CASE WHEN ? IN ('complete', 'degraded') THEN datetime('now') ELSE NULL END, " +
    "error_code = ?, result_json = json_object('input_fingerprint', ?) WHERE candle_key = ?"
  ).bind(status, status, errorCode, fingerprint, candleKey).run();
}

async function runAnalysisFromBundle(
  env: Env,
  bundle: EvidenceBundle
): Promise<HandoffResponse> {
  const requestId = bundle.request_id;
  const candle = bundle.candle;
  const ticker = candle.symbol;
  const timeframe = candle.timeframe;
  const candleKey = candle.candle_key || buildCandleKey(ticker, timeframe, candle.candle_ts);

  const errors: string[] = [...bundle.validation.errors];

  // Fail-closed: when evidence is incomplete, stale, conflicting, or provenance
  // is unverified, do not emit a trade signal and do not invoke the AI models.
  // WAIT / NO_TRADE with null price/risk parameters.
  const failClosed = !bundle.validation.ok ||
    bundle.validation.completeness === "incomplete" ||
    bundle.validation.missing_evidence.length > 0 ||
    !bundle.provenance_verified ||
    bundle.validation.errors.length > 0;

  let decision: JsonObject;
  let analystText = "";
  let counselorText = "";
  let reasonerText = "";

  if (failClosed) {
    const reason = (bundle.validation.errors.length > 0
      ? bundle.validation.errors.join("; ")
      : bundle.validation.missing_evidence.length > 0
        ? "Missing required evidence: " + bundle.validation.missing_evidence.join(", ")
        : "Evidence incomplete or provenance unverified.");
    errors.push("fail_closed: " + reason);
    decision = {
      decision: "WAIT",
      confidence: null,
      entry_price: null,
      stop_loss: null,
      take_profit: null,
      risk_reward: null,
      position_size_pct: null,
      reasoning: "FAIL_CLOSED: " + reason,
      confirmation: null,
      invalidation: null
    };
    analystText = "FAIL_CLOSED: evidence not sufficient for AI analysis.";
    counselorText = analystText;
    reasonerText = analystText;
  } else {
    const evidence = {
      candle_key: candleKey,
      ticker,
      timeframe,
      symbol: bundle.symbol,
      candle: bundle.candle,
      engines: bundle.engines,
      sources: bundle.sources,
      news: bundle.news,
      validation: bundle.validation,
      evidence_fingerprint: bundle.evidence_fingerprint,
      provenance_verified: bundle.provenance_verified,
      schema_version: bundle.schema_version
    };

    const [knowledgeText] = await Promise.all([
      env.KNOWLEDGE_BASE.get("knowledge-base:v4").then(value => value || env.KNOWLEDGE_BASE.get("knowledge-base:v3"))
    ]);
    const knowledge = knowledgeText || JSON.stringify({
      status: "kv_key_missing",
      message: "No knowledge-base:v4 or knowledge-base:v3 value was found in the bound KV namespace."
    });

    const analystResult = await env.AI.run(env.AI_MODEL_ANALYST as keyof AiModels, {
      prompt: [
        "You are the Analyst stage in an XAUUSD decision-support pipeline.",
        "Classify the supplied indicator evidence without inventing missing values or prices.",
        "Prophet is the base directional bias. GMI can validate, block, or defer a setup but must not silently overwrite Prophet's bias.",
        "Evidence includes technical engine results, source provenance, and fundamental news_evidence.",
        "If news_evidence.available is false, state that fundamental news data is unavailable. Do NOT invent news.",
        "If news_evidence.available is true, consider the supplied articles alongside technical evidence.",
        "Return JSON only with keys: directional_bias (BULLISH, BEARISH, or NEUTRAL), setup_quality (integer 0-3), missing_evidence (boolean), reasoning.",
        "Set directional_bias to NEUTRAL and missing_evidence to true if evidence is missing, stale, contradictory, or insufficient.",
        "EVIDENCE:",
        JSON.stringify(evidence),
        "POLICY:",
        knowledge
      ].join("\n"),
      max_tokens: 700,
      temperature: 0.1
    } as never);
    analystText = extractText(analystResult);

    const counselorResult = await env.AI.run(env.AI_MODEL_COUNSELOR as keyof AiModels, {
      prompt: [
        "You are the Counselor stage in an XAUUSD decision-support pipeline.",
        "Use only the JSON evidence and analyst output below. Do not invent prices or indicator definitions.",
        "Prophet is the base bias. GMI may validate, block, or defer a Prophet setup; it must not silently overwrite Prophet's bias.",
        "If news_evidence.available is false, acknowledge fundamental news is unavailable. Do NOT fabricate news.",
        "If news_evidence.available is true, weigh the supplied articles in scenarios.",
        "Return concise JSON with keys: evidence_summary, bullish_scenario, bearish_scenario, neutral_scenario, confirmations, invalidation, risks, missing_data.",
        "If the source payloads conflict or fields are unclear, say so explicitly.",
        "EVIDENCE:",
        JSON.stringify(evidence),
        "POLICY:",
        knowledge,
        "ANALYST:",
        analystText
      ].join("\n"),
      max_tokens: 1400,
      temperature: 0.1
    } as never);
    counselorText = extractText(counselorResult);

    const reasonerResult = await env.AI.run(env.AI_MODEL_REASONER as keyof AiModels, {
      prompt: [
        "You are the final Deep Reasoner stage for XAUUSD decision support.",
        "Use only the supplied evidence, analyst output, and counselor output. Do not invent market prices or claim the models verified facts they did not receive.",
        "Prophet remains the base bias. GMI may validate, block, or wait on a setup. Do not silently reverse Prophet's bias.",
        "If news_evidence.available is false, state fundamental news analysis was not performed. Do NOT claim news supported or contradicted the setup.",
        "If news_evidence.available is true, incorporate the supplied articles into final reasoning.",
        "Return ONLY a JSON object with keys: decision (BUY, SELL, WAIT, or NO_TRADE), confidence (number 0-1 or null), entry_price, stop_loss, take_profit, risk_reward, position_size_pct, reasoning, confirmation, invalidation.",
        "Set decision to WAIT or NO_TRADE and prices to null if exact price evidence is absent. Never imply automatic execution.",
        "EVIDENCE:",
        JSON.stringify(evidence),
        "ANALYST:",
        analystText,
        "COUNSELOR:",
        counselorText
      ].join("\n"),
      max_tokens: 1200,
      temperature: 0.1
    } as never);
    reasonerText = extractText(reasonerResult);
    decision = parseDecision(reasonerText);
  }

  const timestamp = nowIso();
  const synthesis = {
    candle_key: candleKey,
    ticker,
    timeframe,
    timestamp,
    request_id: requestId,
    schema_version: bundle.schema_version,
    symbol: bundle.symbol,
    candle: bundle.candle,
    analyst_model: env.AI_MODEL_ANALYST,
    analyst_output: analystText,
    counselor_model: env.AI_MODEL_COUNSELOR,
    counselor_output: counselorText,
    reasoner_model: env.AI_MODEL_REASONER,
    reasoner_output: reasonerText,
    news_evidence: bundle.news,
    engines: bundle.engines,
    sources: bundle.sources,
    validation: bundle.validation,
    evidence_fingerprint: bundle.evidence_fingerprint,
    provenance_verified: bundle.provenance_verified,
    decision
  };

  // Persist synthesis (fail-closed records are still stored for audit).
  await env.DB.prepare(
    "INSERT INTO ai_syntheses (candle_key, ticker, timeframe, timestamp, prophet_metrics, gmi_metrics, ai_analysis, ai_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    candleKey,
    ticker,
    timeframe,
    timestamp,
    JSON.stringify({ sources: bundle.sources, engines: bundle.engines }),
    JSON.stringify({ engines: bundle.engines }),
    JSON.stringify(synthesis),
    [env.AI_MODEL_ANALYST, env.AI_MODEL_COUNSELOR, env.AI_MODEL_REASONER].join(",")
  ).run();

  const confidence = typeof decision.confidence === "number" ? decision.confidence : null;
  const entry = typeof decision.entry_price === "number" ? decision.entry_price : null;
  const stop = typeof decision.stop_loss === "number" ? decision.stop_loss : null;
  const target = typeof decision.take_profit === "number" ? decision.take_profit : null;
  const rr = typeof decision.risk_reward === "number" ? decision.risk_reward : null;
  const size = typeof decision.position_size_pct === "number" ? decision.position_size_pct : null;
  const reasoning = asText(decision.reasoning) || reasonerText;

  await env.DB.prepare(
    "INSERT INTO trade_decisions (candle_key, decision, confidence, entry_price, stop_loss, take_profit, risk_reward, position_size_pct, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(candleKey, asText(decision.decision) || "WAIT", confidence, entry, stop, target, rr, size, reasoning).run();

  await env.SIGNAL_CACHE.put("latest:" + safeKeyPart(ticker) + ":" + safeKeyPart(timeframe), JSON.stringify(synthesis), {
    expirationTtl: 60 * 60 * 24 * 7
  });

  const message = [
    "XAUUSD AI DECISION SUPPORT",
    "Symbol: " + ticker,
    "Timeframe: " + timeframe,
    "Candle: " + candleKey,
    "Decision: " + (asText(decision.decision) || "WAIT"),
    "Confidence: " + (confidence === null ? "not provided" : Math.round(confidence * 100) + "%"),
    "Reason: " + reasoning.slice(0, 900),
    "Note: advisory only; no trade was executed."
  ].join("\n");
  let notified = false;
  try {
    await sendTelegram(env, message);
    notified = true;
  } catch {
    notified = false;
  }

  await env.WEBHOOK_BUFFER.put("analysis:" + safeKeyPart(candleKey), JSON.stringify({
    status: "complete",
    created_at: timestamp,
    request_id: requestId,
    sources: bundle.engines.map((e) => e.engine),
    decision: synthesis
  }), { expirationTtl: 60 * 60 * 24 * 14 });

  return {
    schema_version: bundle.schema_version,
    request_id: requestId,
    decision: asText(decision.decision) || "WAIT",
    confidence,
    entry_price: entry,
    stop_loss: stop,
    take_profit: target,
    risk_reward: rr,
    position_size_pct: size,
    reasoning,
    confirmation: decision.confirmation && typeof decision.confirmation === "string" ? decision.confirmation : null,
    invalidation: decision.invalidation && typeof decision.invalidation === "string" ? decision.invalidation : null,
    models: {
      analyst: env.AI_MODEL_ANALYST,
      counselor: env.AI_MODEL_COUNSELOR,
      reasoner: env.AI_MODEL_REASONER
    },
    stored: true,
    notified,
    errors
  } as HandoffResponse;
}

async function handleAnalyze(request: Request, env: Env): Promise<Response> {
  if (!env.CONFLUENCE_HANDOFF_SECRET) {
    return json({ error: "Handoff secret not configured on AI Worker" }, 503);
  }
  if (!env.XAUUSD_EVENTS) {
    return json({ error: "XAUUSD_EVENTS queue is not configured" }, 503);
  }

  let body: string;
  try {
    body = await readBoundedBody(request);
  } catch {
    return json({ error: "Request body too large" }, 413);
  }

  const headers = {
    get: (name: string) => request.headers.get(name)
  };
  // Replay protection: reject duplicate request_ids within the TTL window.
  // The Worker is single-threaded per isolate, so a Map is sufficient; entries
  // are pruned on each request instead of relying on a module-level timer.
  pruneReplaySeen();
  const requestId = headers.get("x-request-id") || "";
  if (requestId && replaySeen.has(requestId)) {
    return json({ error: "Authentication failed", reason: "Duplicate request_id (replay)", request_id: requestId }, 401);
  }

  const verification = await verifyHandoffRequest(env.CONFLUENCE_HANDOFF_SECRET, body, headers, Date.now());
  if (!verification.ok) {
    return json({
      error: "Authentication failed",
      reason: verification.reason,
      request_id: verification.request_id
    }, 401);
  }
  let bundle: unknown;
  try {
    bundle = JSON.parse(body);
  } catch {
    return json({ error: "Request body must be valid JSON" }, 400);
  }

  const problems = validateBundle(bundle);
  if (problems.length > 0) {
    return json({
      error: "Invalid evidence bundle",
      request_id: verification.request_id,
      problems
    }, 400);
  }

  const validatedBundle = bundle as EvidenceBundle;
  const task: QueueTask = {
    kind: "analysis",
    event_id: `analysis:${validatedBundle.request_id}`,
    request_id: validatedBundle.request_id,
    candle_key: validatedBundle.candle.candle_key,
    enqueued_at: nowIso(),
    bundle: validatedBundle
  };
  try {
    await env.XAUUSD_EVENTS.send(task, { contentType: "json" });
  } catch (error) {
    return json({
      error: "Failed to enqueue analysis",
      request_id: validatedBundle.request_id,
      reason: error instanceof Error ? error.message : "Unknown queue error"
    }, 503);
  }

  // Mark replay only after durable enqueue; a failed enqueue must remain
  // retryable by the Controller with the same authenticated request_id.
  if (requestId) replaySeen.set(requestId, Date.now());

  return json({
    schema_version: validatedBundle.schema_version,
    request_id: validatedBundle.request_id,
    status: "accepted",
    analysis_status: "queued",
    queued: true,
    event_id: task.event_id,
    candle_key: validatedBundle.candle.candle_key
  }, 202);
}

async function processAnalysisTask(env: Env, task: Extract<QueueTask, { kind: "analysis" }>): Promise<void> {
  const bundle = task.bundle;
  const candleKey = bundle.candle.candle_key;
  const claimed = await claimAnalysisRun(env, candleKey, bundle.evidence_fingerprint);
  if (!claimed) return;

  try {
    const result = await runAnalysisFromBundle(env, bundle);
    const failedClosed = result.errors.some(error => error.startsWith("fail_closed:"));
    await setAnalysisRunStatus(env, candleKey, failedClosed ? "degraded" : "complete", bundle.evidence_fingerprint);
  } catch (error) {
    await setAnalysisRunStatus(env, candleKey, "failed", bundle.evidence_fingerprint, "analysis_failed");
    throw error;
  }
}

async function handleRequest(request: Request, env: Env): Promise<Response> {

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        status: "ok",
        service: "xauusd-ai-trading-assistant",
        schema_version: SCHEMA_VERSION,
        bindings: {
          d1: Boolean(env.DB),
          signal_cache: Boolean(env.SIGNAL_CACHE),
          webhook_buffer: Boolean(env.WEBHOOK_BUFFER),
          knowledge_base: Boolean(env.KNOWLEDGE_BASE),
          workers_ai: Boolean(env.AI),
          event_queue: Boolean(env.XAUUSD_EVENTS)
        },
        secrets_configured: {
          webhook_secret: Boolean(env.WEBHOOK_SECRET),
          telegram_bot_token: Boolean(env.TELEGRAM_BOT_TOKEN),
          telegram_chat_id: Boolean(env.TELEGRAM_CHAT_ID),
          confluence_handoff_secret: Boolean(env.CONFLUENCE_HANDOFF_SECRET)
        },
        ingest_configured: {
          ingest_url: asText(env.INGEST_URL),
          ingest_secret: Boolean(env.INGEST_SECRET),
          news_ingestion_rpc: Boolean(env.NEWS_INGESTION)
        },
        endpoints: ["GET /health", "POST /webhook (legacy ingest)", "POST /v1/analyze (authenticated handoff)"]
      });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/analyze") {
      return handleAnalyze(request, env);
    }

    if (request.metho