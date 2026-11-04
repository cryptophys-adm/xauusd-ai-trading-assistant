import { WorkerEntrypoint, tracing } from "cloudflare:workers";
import { buildEvidenceFusion, LOCAL_ENGINES, validateLocalCalculation, WEBHOOK_EVIDENCE_CONTRACT_VERSION, NEWS_ANALYSIS_CONTRACT_VERSION, NEWS_MAX_AGE_MS, containsCredentialFields, stripCredentialFields } from "./evidence-fusion.mjs";
import { validateM5Context, freshM5Context } from "./m5-context.mjs";
import { filterRecentUniqueArticles } from "./news-filter.mjs";
import { parseTradingViewJson } from "./tradingview-json.mjs";
import { chatMessages, cleanModelText, extractJsonObject, extractModelText, MAX_TOKENS } from "./model-text.mjs";
import { knowledgeForPrompt } from "./knowledge-prompt.mjs";

// knowledge-base v4 is generated from the Pine SSOT sources and bundled with the Worker
// (scripts/build-knowledge-base.mjs); it no longer depends on a hand-maintained KV value.
const TECHNICAL_KNOWLEDGE = JSON.parse(knowledgeForPrompt("technical")) as JsonObject;
const NEWS_KNOWLEDGE = JSON.parse(knowledgeForPrompt("news")) as JsonObject;
const KNOWLEDGE_SHA = asText((TECHNICAL_KNOWLEDGE.provenance as JsonObject | undefined)?.content_sha256);
import { identityOf, ensureSchema, registerIdentity, listRegistry, policyFromEnv, PARITY_REGISTRY_VERSION } from "./parity-registry.mjs";
import { buildWebhookQueueTask, buildLocalCalculationQueueTask, sendQueueTask, createQueueConsumer } from "./queue-runtime.mjs";
import type { QueueTask } from "./queue-runtime.mjs";
import type { EvidenceBundle, HandoffResponse } from "../lib/contracts.ts";
import { buildCandleKey, nowIso } from "../lib/contracts.ts";
import { verifyHandoffRequest, REPLAY_RECORD_TTL_SECONDS } from "../lib/auth.ts";
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
  CONFLUENCE_HANDOFF_SECRET?: string;
  NEWS_INGESTION?: {
    pull(options?: { forceRefresh?: boolean; origin?: string }): Promise<Record<string, unknown>>;
  };
  XAUUSD_EVENTS: Queue<QueueTask>;
  INGEST_URL?: string;
  INGEST_SECRET?: string;
  AI_MODEL_ANALYST: string;
  AI_MODEL_COUNSELOR: string;
  AI_MODEL_REASONER: string;
  REQUIRED_SOURCES: string;
  MULTI_AGENT_BUS_ENABLED?: string;
  MULTI_AGENT_MAX_CALLS_PER_HOUR?: string;
  MULTI_AGENT_MODEL?: string;
  MULTI_AGENT_FALLBACK_MODEL?: string;
  LIVE_ROOM_ENABLED?: string;
  LIVE_ROOM_MAX_CALLS_PER_HOUR?: string;
  PREVIEW_FIXTURES_ENABLED?: string;
  PARITY_PROMOTE_AFTER?: string;
  PARITY_ABS_TOLERANCE?: string;
  PARITY_REL_TOLERANCE?: string;
}

type JsonObject = Record<string, unknown>;

type WebhookPayload = {
  schema_version?: string;
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

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const replaySeen = new Map<string, number>();
function pruneReplaySeen(): void {
  const cutoff = Date.now() - REPLAY_RECORD_TTL_SECONDS * 1000;
  for (const [id, timestamp] of replaySeen) if (timestamp < cutoff) replaySeen.delete(id);
}
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

async function readBodyLimited(request: Request, maxBytes: number): Promise<{ text: string; tooLarge: boolean }> {
  if (!request.body) return { text: "", tooLarge: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request body exceeds configured limit").catch(() => undefined);
        return { text: "", tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(body), tooLarge: false };
}

function normalizeSource(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return SOURCE_ALIASES[value.trim().toLowerCase()] || null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

import { reconcileLocalComputation, reconcileRecentCandles, backfillRecentAnalyses, closedH1CandleKeys, OBSERVED_PREFIX, LOCAL_TTL, PARITY_SWEEP_CRON } from "./parity-sweep.mjs";
import { loadWebhookPayloadsFromD1 } from "./webhook-payloads.mjs";
import { busEnabled, buildMultiAgentBusTask, runMultiAgentBus, readBus } from "./multi-agent-bus.mjs";
import { liveRoomEnabled, buildNewsThreadTask, buildLiveRoomTask, runNewsThread, runLiveRoomBar, listThreads, readThread, readLive, listH1Threads, readH1Thread } from "./agent-threads.mjs";
import { describeDegradedEvidence } from "./natural-language.mjs";

function safeKeyPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 180);
}

// reconcileLocalComputation now lives in ./parity-sweep.mjs (shared by the queue
// tasks and the scheduled parity sweep); OBSERVED_PREFIX and LOCAL_TTL come from
// there too so the lane's KV layout has a single owner.

function extractText(result: unknown): string {
  return cleanModelText(extractRawText(result));
}

function extractRawText(result: unknown): string {
  return extractModelText(result);
}

function parseDecision(text: string): JsonObject {
  const extracted = extractJsonObject(text);
  if (extracted) {
    try {
      const parsed = extracted;
      const decision = asText(parsed.decision).toUpperCase();
      const nullableNumber = (value: unknown): number | null =>
        typeof value === "number" && Number.isFinite(value) ? value : null;
      const confidence = nullableNumber(parsed.confidence);
      const entry = nullableNumber(parsed.entry_price);
      const stop = nullableNumber(parsed.stop_loss);
      const target = nullableNumber(parsed.take_profit);
      const riskReward = nullableNumber(parsed.risk_reward);
      const positionSize = nullableNumber(parsed.position_size_pct);
      const confidenceValid = parsed.confidence == null || (confidence !== null && confidence >= 0 && confidence <= 1);
      const numericFieldsValid = [parsed.entry_price, parsed.stop_loss, parsed.take_profit, parsed.risk_reward, parsed.position_size_pct]
        .every(value => value == null || (typeof value === "number" && Number.isFinite(value)));
      const pricesValid = entry !== null && entry > 0 && stop !== null && stop > 0 && target !== null && target > 0;
      const directionalPricesValid = decision === "BUY"
        ? entry !== null && stop !== null && target !== null && stop < entry && entry < target
        : decision === "SELL"
          ? entry !== null && stop !== null && target !== null && target < entry && entry < stop
          : true;
      if (["BUY", "SELL", "WAIT", "NO_TRADE"].includes(decision) && confidenceValid && numericFieldsValid) {
        if ((decision === "BUY" || decision === "SELL") &&
          (!pricesValid || !directionalPricesValid || confidence === null || riskReward === null || riskReward <= 0 || positionSize === null || positionSize <= 0 || positionSize > 100)) {
          return {
            decision: "WAIT", confidence: null, entry_price: null, stop_loss: null, take_profit: null,
            risk_reward: null, position_size_pct: null,
            reasoning: "Actionable model output lacks valid directional prices, confidence, positive risk/reward, or a positive position size within 0–100%; downgraded to WAIT.",
            raw_response: text
          };
        }
        if (positionSize !== null && (positionSize < 0 || positionSize > 100)) {
          return { decision: "WAIT", confidence: null, entry_price: null, stop_loss: null, take_profit: null, risk_reward: null, position_size_pct: null, reasoning: "Model position_size_pct was outside the permitted 0–100 range; downgraded to WAIT.", raw_response: text };
        }
        return {
          ...parsed,
          decision,
          confidence,
          entry_price: entry,
          stop_loss: stop,
          take_profit: target,
          risk_reward: riskReward,
          position_size_pct: positionSize,
          reasoning: asText(parsed.reasoning) || "No reasoning supplied."
        };
      }
    } catch {
      // Fall through to conservative WAIT decision.
    }
  }
  return {
    decision: "WAIT",
    confidence: null,
    entry_price: null,
    stop_loss: null,
    take_profit: null,
    risk_reward: null,
    position_size_pct: null,
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

async function fetchNews(env: Env): Promise<{ available: boolean; articles: unknown[]; article_count: number; reason?: string; fetched_at: string }> {
  const fetchedAt = new Date().toISOString();
  let body: Record<string, unknown>;
  try {
    if (env.NEWS_INGESTION) {
      body = await env.NEWS_INGESTION.pull({ forceRefresh: false });
    } else {
      if (!env.INGEST_URL || !env.INGEST_SECRET) {
        return { available: false, articles: [], article_count: 0, reason: "News ingestion RPC or HTTP credentials are not configured.", fetched_at: fetchedAt };
      }
      const pullUrl = env.INGEST_URL.replace(/\/+$/, "") + "/pull";
      const response = await fetch(pullUrl, { method: "POST", headers: { "Authorization": "Bearer " + env.INGEST_SECRET, "Accept": "application/json" } });
      if (!response.ok) return { available: false, articles: [], article_count: 0, reason: "Ingestion endpoint returned HTTP " + response.status + " " + response.statusText, fetched_at: fetchedAt };
      body = await response.json() as Record<string, unknown>;
    }
  } catch (error) {
    return { available: false, articles: [], article_count: 0, reason: "Failed to reach ingestion service: " + (error instanceof Error ? error.message : "Unknown error"), fetched_at: fetchedAt };
  }
  let rawArticles: unknown[] | null = null;
  for (const key of ["articles", "data", "results", "items"]) {
    if (Array.isArray(body[key])) { rawArticles = body[key] as unknown[]; break; }
  }
  if (!rawArticles || rawArticles.length === 0) return { available: false, articles: [], article_count: 0, reason: "Ingestion service returned no articles.", fetched_at: fetchedAt };
  const articles = filterRecentUniqueArticles(rawArticles, Date.now());
  if (articles.length === 0) return { available: false, articles: [], article_count: 0, reason: "No unique articles with a valid publication timestamp from the last hour were available.", fetched_at: fetchedAt };
  return { available: true, articles, article_count: articles.length, fetched_at: fetchedAt };
}


async function runNewsAnalysis(env: Env): Promise<JsonObject> {
  const traceConversationId = crypto.randomUUID();
  return tracing.enterSpan("invoke_agent", async (agentSpan) => {
    agentSpan.setAttributes({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "xauusd-decision-agent",
      "gen_ai.agent.id": "xauusd-ai-trading-assistant-production",
      "gen_ai.conversation.id": traceConversationId
    });
  const newsEvidence = await fetchNews(env);
  if (!newsEvidence.available || newsEvidence.articles.length === 0) {
    throw new Error("News ingestion unavailable: " + (newsEvidence.reason || "no articles returned"));
  }

  const articles = newsEvidence.articles;
  const digestInput = JSON.stringify(articles.map((item: unknown) => {
    if (item && typeof item === "object") {
      const article = item as JsonObject;
      return { id: article.id, url: article.url, title: article.title, published_at: article.published_at };
    }
    return item;
  }).sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(digestInput));
  const analysisKey = Array.from(new Uint8Array(digest)).map(v => v.toString(16).padStart(2, "0")).join("");

  const cached = await env.DB.prepare(
    "SELECT analysis_key, analyzed_at, fetched_at, article_count, recommendation_json FROM news_analyses WHERE analysis_key = ? LIMIT 1"
  ).bind(analysisKey).first<JsonObject>();
  if (cached) {
    const refreshedAt = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE news_analyses SET fetched_at = ?, analyzed_at = ? WHERE analysis_key = ?"
    ).bind(newsEvidence.fetched_at, refreshedAt, analysisKey).run();
    const latest = {
      status: "ok",
      analysis_type: "fundamental_news",
      deduplicated: true,
      analysis_key: analysisKey,
      fetched_at: newsEvidence.fetched_at,
      analyzed_at: refreshedAt,
      article_count: cached.article_count,
      recommendation: JSON.parse(asText(cached.recommendation_json) || "{}")
    };
    await env.SIGNAL_CACHE.put("latest:news:fundamental", JSON.stringify(latest), { expirationTtl: 60 * 60 * 24 * 7 });
    return latest;
  }

  const evidence = {
    analysis_type: "fundamental_news",
    fetched_at: newsEvidence.fetched_at,
    article_count: newsEvidence.article_count,
    symbols: ["OANDA:XAUUSD", "TVC:USOIL", "TVC:DXY"],
    articles,
    policy: NEWS_KNOWLEDGE
  };

  const analystResult = await tracing.enterSpan("chat", async (span) => {
    span.setAttributes({
      "gen_ai.operation.name": "chat",
      "gen_ai.agent.name": "xauusd-decision-agent",
      "gen_ai.agent.id": "xauusd-ai-trading-assistant-production",
      "gen_ai.conversation.id": traceConversationId,
      "gen_ai.request.model": String(env.AI_MODEL_ANALYST as keyof AiModels)
    });
    return env.AI.run(env.AI_MODEL_ANALYST as keyof AiModels, {
    messages: chatMessages([
      "You are the Fundamental News Analyst for XAUUSD decision support.",
      "Analyze only the supplied news articles. Do not infer current price action, technical indicators, or unpublished facts.",
      "Assess direct and indirect potential impact on gold (XAUUSD), US dollar (DXY), and oil (USOIL). Distinguish reported facts from interpretation and note publication-time limitations.",
      "Write your thesis as plain prose (4-6 sentences, no JSON, no markdown). Cover: gold bias (BULLISH, BEARISH or NEUTRAL), dollar bias, oil bias, risk sentiment, key catalysts, key risks, evidence quality (LOW, MEDIUM, HIGH) and whether the evidence is stale or uncertain. Cite article titles.",
      "Do not produce entry, stop-loss, take-profit, position size, or a technical BUY/SELL order.",
      "NEWS EVIDENCE:", JSON.stringify(evidence)
    ]),
    max_tokens: MAX_TOKENS.analyst,
    temperature: 0.1
  } as never); });
  const analystText = extractText(analystResult);

  const counselorResult = await tracing.enterSpan("chat", async (span) => {
    span.setAttributes({
      "gen_ai.operation.name": "chat",
      "gen_ai.agent.name": "xauusd-decision-agent",
      "gen_ai.agent.id": "xauusd-ai-trading-assistant-production",
      "gen_ai.conversation.id": traceConversationId,
      "gen_ai.request.model": String(env.AI_MODEL_COUNSELOR as keyof AiModels)
    });
    return env.AI.run(env.AI_MODEL_COUNSELOR as keyof AiModels, {
    messages: chatMessages([
      "You are the Fundamental News Counselor.",
      "Use only the news evidence and analyst output. Provide balanced conditional scenarios, not trade execution instructions.",
      "Challenge the analyst's thesis in plain prose (4-6 sentences, no JSON, no markdown). Cover: bullish, bearish and neutral scenarios, what would confirm or invalidate the thesis, watchlist events, and conflicts or missing evidence.",
      "Do not invent prices, technical confirmation, or unsupported causal claims.",
      "NEWS EVIDENCE:", JSON.stringify(evidence),
      "ANALYST:", analystText
    ]),
    max_tokens: MAX_TOKENS.counselor,
    temperature: 0.1
  } as never); });
  const counselorText = extractText(counselorResult);

  const reasonerResult = await tracing.enterSpan("chat", async (span) => {
    span.setAttributes({
      "gen_ai.operation.name": "chat",
      "gen_ai.agent.name": "xauusd-decision-agent",
      "gen_ai.agent.id": "xauusd-ai-trading-assistant-production",
      "gen_ai.conversation.id": traceConversationId,
      "gen_ai.request.model": String(env.AI_MODEL_REASONER as keyof AiModels)
    });
    return env.AI.run(env.AI_MODEL_REASONER as keyof AiModels, {
    messages: chatMessages([
      "You are the final Fundamental News Reasoner for XAUUSD decision support.",
      "Synthesize only the supplied article evidence, analyst output, and counselor output. This is a fundamental outlook, not a technical trade signal.",
      "Your entire response must be one JSON object: start with { and end with }. No markdown, no text outside the JSON.",
      "Return JSON only with keys: recommendation (BULLISH_BIAS, BEARISH_BIAS, NEUTRAL, WAIT_FOR_TECHNICAL_CONFIRMATION), confidence (0 to 1 or null), horizon, rationale, supporting_evidence, opposing_evidence, risks, confirmation_needed, invalidation_conditions.",
      "Do not output numeric entry, stop-loss, take-profit, risk/reward, or position size. Do not claim an executable BUY/SELL without technical evidence.",
      "If evidence is mixed, stale, or insufficient, choose WAIT_FOR_TECHNICAL_CONFIRMATION or NEUTRAL and lower confidence.",
      "NEWS EVIDENCE:", JSON.stringify(evidence),
      "ANALYST:", analystText,
      "COUNSELOR:", counselorText
    ]),
    max_tokens: MAX_TOKENS.reasoner,
    temperature: 0.1
  } as never); });
  const reasonerText = extractText(reasonerResult);

  let recommendation: JsonObject;
  const extractedRecommendation = extractJsonObject(reasonerText);
  try {
    recommendation = extractedRecommendation ? extractedRecommendation : {
      recommendation: "WAIT_FOR_TECHNICAL_CONFIRMATION",
      confidence: null,
      rationale: "Reasoner response was not valid JSON; no trade signal generated.",
      raw_response: reasonerText
    };
  } catch {
    recommendation = {
      recommendation: "WAIT_FOR_TECHNICAL_CONFIRMATION",
      confidence: null,
      rationale: "Reasoner response was not valid JSON; no trade signal generated.",
      raw_response: reasonerText
    };
  }

  const analyzedAt = new Date().toISOString();
  const result: JsonObject = {
    status: "ok",
    analysis_type: "fundamental_news",
    deduplicated: false,
    analysis_key: analysisKey,
    fetched_at: newsEvidence.fetched_at,
    analyzed_at: analyzedAt,
    article_count: newsEvidence.article_count,
    symbols: evidence.symbols,
    analyst_model: env.AI_MODEL_ANALYST,
    analyst_output: analystText,
    counselor_model: env.AI_MODEL_COUNSELOR,
    counselor_output: counselorText,
    reasoner_model: env.AI_MODEL_REASONER,
    reasoner_output: reasonerText,
    recommendation
  };

  await env.DB.prepare(
    "INSERT INTO news_analyses (analysis_key, fetched_at, analyzed_at, article_count, evidence_json, analyst_output, counselor_output, reasoner_output, recommendation_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    analysisKey, newsEvidence.fetched_at, analyzedAt, newsEvidence.article_count,
    JSON.stringify(evidence), analystText, counselorText, reasonerText, JSON.stringify(recommendation)
  ).run();
  await env.SIGNAL_CACHE.put("latest:news:fundamental", JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 7 });
  await enqueueNewsThread(env, analysisKey);
  return result;

  });
}

async function fetchLatestNewsAnalysis(env: Env): Promise<JsonObject | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT analysis_key, fetched_at, analyzed_at, article_count, evidence_json, analyst_output, counselor_output, reasoner_output, recommendation_json FROM news_analyses ORDER BY analyzed_at DESC LIMIT 1"
    ).first<JsonObject>();
    if (!row) return null;
    let evidence: JsonObject | null = null;
    try {
      const parsed = JSON.parse(asText(row.evidence_json));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) evidence = parsed as JsonObject;
    } catch { /* malformed historical row is treated as missing evidence */ }
    let recommendation: JsonObject = {};
    try {
      const parsed = JSON.parse(asText(row.recommendation_json));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) recommendation = parsed as JsonObject;
    } catch { /* malformed recommendation is not trusted */ }
    return {
      schema_version: NEWS_ANALYSIS_CONTRACT_VERSION,
      status: "ok",
      analysis_type: "fundamental_news",
      analysis_key: asText(row.analysis_key),
      fetched_at: asText(row.fetched_at),
      analyzed_at: asText(row.analyzed_at),
      article_count: Number(row.article_count) || 0,
      symbols: Array.isArray(evidence?.symbols) ? evidence.symbols : [],
      evidence,
      analyst_output: asText(row.analyst_output),
      counselor_output: asText(row.counselor_output),
      reasoner_output: asText(row.reasoner_output),
      recommendation
    };
  } catch {
    return null;
  }
}

async function upsertSynthesis(
  env: Env,
  values: { candleKey: string; ticker: string; timeframe: string; timestamp: string; prophetMetrics: string; gmiMetrics: string; analysis: string; model: string }
): Promise<void> {
  const existing = await env.DB.prepare("SELECT id FROM ai_syntheses WHERE candle_key = ? ORDER BY id DESC LIMIT 1")
    .bind(values.candleKey).first<{ id: number }>();
  if (existing) {
    await env.DB.prepare("UPDATE ai_syntheses SET ticker = ?, timeframe = ?, timestamp = ?, prophet_metrics = ?, gmi_metrics = ?, ai_analysis = ?, ai_model = ? WHERE id = ?")
      .bind(values.ticker, values.timeframe, values.timestamp, values.prophetMetrics, values.gmiMetrics, values.analysis, values.model, existing.id).run();
  } else {
    await env.DB.prepare("INSERT INTO ai_syntheses (candle_key, ticker, timeframe, timestamp, prophet_metrics, gmi_metrics, ai_analysis, ai_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(values.candleKey, values.ticker, values.timeframe, values.timestamp, values.prophetMetrics, values.gmiMetrics, values.analysis, values.model).run();
  }
}

async function upsertTradeDecision(
  env: Env,
  values: { candleKey: string; decision: string; confidence: number | null; entry: number | null; stop: number | null; target: number | null; riskReward: number | null; size: number | null; reasoning: string }
): Promise<void> {
  const existing = await env.DB.prepare("SELECT id FROM trade_decisions WHERE candle_key = ? ORDER BY id DESC LIMIT 1")
    .bind(values.candleKey).first<{ id: number }>();
  if (existing) {
    await env.DB.prepare("UPDATE trade_decisions SET decision = ?, confidence = ?, entry_price = ?, stop_loss = ?, take_profit = ?, risk_reward = ?, position_size_pct = ?, reasoning = ? WHERE id = ?")
      .bind(values.decision, values.confidence, values.entry, values.stop, values.target, values.riskReward, values.size, values.reasoning, existing.id).run();
  } else {
    await env.DB.prepare("INSERT INTO trade_decisions (candle_key, decision, confidence, entry_price, stop_loss, take_profit, risk_reward, position_size_pct, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(values.candleKey, values.decision, values.confidence, values.entry, values.stop, values.target, values.riskReward, values.size, values.reasoning).run();
  }
}

async function claimAnalysisRun(env: Env, candleKey: string, inputFingerprint: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "INSERT INTO analysis_runs (candle_key, status, attempt_count, started_at, updated_at, result_json) VALUES (?, 'analyzing', 1, datetime('now'), datetime('now'), json_object('input_fingerprint', ?)) " +
    "ON CONFLICT(candle_key) DO UPDATE SET status = 'analyzing', attempt_count = analysis_runs.attempt_count + 1, started_at = datetime('now'), updated_at = datetime('now'), completed_at = NULL, error_code = NULL, result_json = json_object('input_fingerprint', ?) " +
    "WHERE (analysis_runs.status = 'degraded' AND COALESCE(json_extract(analysis_runs.result_json, '$.input_fingerprint'), '') != ?) OR analysis_runs.status = 'failed' OR (analysis_runs.status = 'analyzing' AND analysis_runs.updated_at < datetime('now', '-10 minutes'))"
  ).bind(candleKey, inputFingerprint, inputFingerprint, inputFingerprint).run();
  return Number(result.meta.changes) > 0;
}

async function setAnalysisRunStatus(env: Env, candleKey: string, status: string, details: JsonObject, errorCode: string | null = null): Promise<void> {
  try {
    const result = await env.DB.prepare(
      "UPDATE analysis_runs SET status = ?, updated_at = datetime('now'), completed_at = CASE WHEN ? = 'complete' THEN datetime('now') ELSE NULL END, error_code = ?, result_json = ? WHERE candle_key = ?"
    ).bind(status, status, errorCode, JSON.stringify(details), candleKey).run();
    if (!Number(result?.meta?.changes || 0)) {
      await env.DB.prepare(
        "INSERT INTO analysis_runs (candle_key, status, attempt_count, started_at, updated_at, completed_at, error_code, result_json) VALUES (?, ?, 1, datetime('now'), datetime('now'), CASE WHEN ? = 'complete' THEN datetime('now') ELSE NULL END, ?, ?)"
      ).bind(candleKey, status, status, errorCode, JSON.stringify(details)).run();
    }
  } catch (error) {
    console.error("analysis_run_status_update_failed", JSON.stringify({
      candle_key: candleKey,
      status,
      message: error instanceof Error ? error.message : "Unknown status update error"
    }));
  }
}

/**
 * Shadow multi-agent bus (docs/MULTI_AGENT_BUS.md): enqueued only after the H1
 * synthesis is persisted and only when MULTI_AGENT_BUS_ENABLED is "true". It
 * never feeds back into the chain's evidence, prompts or decision.
 */
/** Phase 3 news thread for a completed news analysis (shadow, behind MULTI_AGENT_BUS_ENABLED). */
async function enqueueNewsThread(env: Env, analysisKey: string): Promise<void> {
  if (!busEnabled(env)) return;
  try {
    await sendQueueTask(env.XAUUSD_EVENTS, buildNewsThreadTask({ analysisKey }) as unknown as QueueTask);
  } catch (error) {
    console.error("news_thread_enqueue_failed", JSON.stringify({ analysis_key: analysisKey, error: error instanceof Error ? error.message : String(error) }));
  }
}

async function enqueueMultiAgentBus(env: Env, candleKey: string, inputFingerprint: string): Promise<void> {
  if (!busEnabled(env)) return;
  try {
    await sendQueueTask(env.XAUUSD_EVENTS, buildMultiAgentBusTask({ candleKey, inputFingerprint }) as unknown as QueueTask);
  } catch (error) {
    console.error("bus_enqueue_failed", JSON.stringify({ candle_key: candleKey, error: error instanceof Error ? error.message : String(error) }));
  }
}

async function runAnalysis(
  env: Env,
  candleKey: string,
  ticker: string,
  timeframe: string,
  payloads: Record<string, WebhookPayload>
): Promise<{ status: string; missing_evidence: string[] }> {
  return tracing.enterSpan("invoke_agent", async (agentSpan) => {
    agentSpan.setAttributes({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "xauusd-decision-agent",
      "gen_ai.agent.id": "xauusd-ai-trading-assistant-production",
      "gen_ai.conversation.id": candleKey
    });
  const [newsAnalysis, localCalculationRaw] = await Promise.all([
    fetchLatestNewsAnalysis(env),
    Promise.all(LOCAL_ENGINES.map(engine => env.WEBHOOK_BUFFER.get("localcalc:" + safeKeyPart(candleKey) + ":" + engine)))
  ]);
  const candleTime = asText(payloads.prophet_r38?.candle_time || payloads.prophet_r37_ssot?.candle_time || payloads.gmi_v12_70?.candle_time || payloads.prophet_r38?.timestamp || payloads.prophet_r37_ssot?.timestamp || payloads.gmi_v12_70?.timestamp);
  const localCalculations: unknown[] = [];
  for (const raw of localCalculationRaw) {
    if (!raw) continue;
    try { localCalculations.push(JSON.parse(raw)); } catch { /* malformed KV evidence is excluded and reported as missing */ }
  }
  const fingerprintLocalCalculations = localCalculations.map((item: any) => ({
    engine: item.engine,
    schema_version: item.schema_version,
    symbol: item.symbol,
    timeframe: item.timeframe,
    candle_time: item.candle_time,
    candle_key: item.candle_key,
    computed_at: item.computed_at,
    calculation_version: item.calculation_version,
    values: item.values,
    provenance: item.provenance
  })).sort((a: any, b: any) => String(a.engine).localeCompare(String(b.engine)));
  const newsAnalyzedAt = Date.parse(asText(newsAnalysis?.analyzed_at));
  const newsFetchedAt = Date.parse(asText(newsAnalysis?.fetched_at));
  const newsNow = Date.now();
  const newsFreshness = Number.isFinite(newsAnalyzedAt) && Number.isFinite(newsFetchedAt) &&
    newsNow - newsAnalyzedAt <= NEWS_MAX_AGE_MS &&
    newsNow - newsFetchedAt <= NEWS_MAX_AGE_MS &&
    newsAnalyzedAt <= newsNow + 5 * 60 * 1000 &&
    newsFetchedAt <= newsNow + 5 * 60 * 1000;
  const fingerprintInput = JSON.stringify({
    candleKey, ticker, timeframe, payloads, localCalculations: fingerprintLocalCalculations, knowledge_sha256: KNOWLEDGE_SHA,
    news: {
      analysis_key: newsAnalysis?.analysis_key,
      status: newsAnalysis?.status,
      article_count: newsAnalysis?.article_count,
      recommendation: newsAnalysis?.recommendation,
      fresh: newsFreshness
    }
  });
  const fingerprintDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprintInput));
  const inputFingerprint = Array.from(new Uint8Array(fingerprintDigest)).map(value => value.toString(16).padStart(2, "0")).join("");
  const claimed = await claimAnalysisRun(env, candleKey, inputFingerprint);
  if (!claimed) return { status: "already_processed", missing_evidence: [] };

  let informational5mContext: unknown = null;
  try {
    const raw = await env.SIGNAL_CACHE?.get("context:m5:latest");
    if (raw) {
      const parsed = JSON.parse(raw);
      const fresh = freshM5Context(parsed, Date.now());
      // recent_bars feed only the live room; the H1 chain keeps the compact context.
      if (fresh) { const { recent_bars: _bars, ...compact } = fresh as JsonObject; informational5mContext = compact; }
    }
  } catch { informational5mContext = null; }

  const fusion = buildEvidenceFusion({
    candleKey,
    symbol: ticker,
    timeframe,
    candleTime,
    webhookPayloads: payloads,
    localCalculations,
    newsAnalysis,
    informational5mContext
  });
  const newsEvidence = {
    available: Boolean(fusion.fundamental_news_analysis),
    article_count: Number(fusion.fundamental_news_analysis?.article_count) || 0,
    fetched_at: asText(fusion.fundamental_news_analysis?.fetched_at),
    analyzed_at: asText(fusion.fundamental_news_analysis?.analyzed_at),
    analysis_key: asText(fusion.fundamental_news_analysis?.analysis_key),
    reason: fusion.fundamental_news_analysis ? undefined : "No fresh, valid completed fundamental news analysis is available."
  };

  const evidence = {
    schema_version: fusion.schema_version,
    candle_key: candleKey,
    ticker,
    timeframe,
    candle_time: candleTime,
    input_lanes: fusion.input_lanes,
    source_payloads: payloads,
    local_calculation_evidence: fusion.local_calculations,
    fundamental_news_analysis: fusion.fundamental_news_analysis,
    informational_5m_context: fusion.informational_5m_context,
    evidence_fusion: fusion,
    policy: TECHNICAL_KNOWLEDGE,
    news_evidence: newsEvidence
  };

  if (!fusion.complete) {
    const timestamp = new Date().toISOString();
    // Plain language for the dashboard and Telegram; the machine-readable lists stay in evidence_fusion.
    const reasoning = describeDegradedEvidence(fusion.missing_evidence, fusion.validation_errors);
    const decision: JsonObject = {
      decision: "WAIT", confidence: null, entry_price: null, stop_loss: null, take_profit: null,
      risk_reward: null, position_size_pct: null, reasoning, confirmation: null, invalidation: null
    };
    const synthesis = {
      candle_key: candleKey, ticker, timeframe, timestamp, evidence_fusion: fusion,
      analysis_chain_status: "not_invoked_due_to_degraded_evidence",
      analyst_model: env.AI_MODEL_ANALYST, analyst_output: null,
      counselor_model: env.AI_MODEL_COUNSELOR, counselor_output: null,
      reasoner_model: env.AI_MODEL_REASONER, reasoner_output: null,
      news_evidence: newsEvidence, decision
    };
    // Persist the fail-closed WAIT synthesis to the same read models used by the dashboard.
    // This is not an AI invocation and never promotes incomplete evidence into a trade.
    await upsertSynthesis(env, {
      candleKey,
      ticker,
      timeframe,
      timestamp,
      prophetMetrics: JSON.stringify({
        prophet_r38: payloads.prophet_r38?.metrics ?? payloads.prophet_r38,
        prophet_r37_ssot: payloads.prophet_r37_ssot?.metrics ?? payloads.prophet_r37_ssot
      }),
      gmiMetrics: JSON.stringify(payloads.gmi_v12_70?.metrics ?? payloads.gmi_v12_70),
      analysis: JSON.stringify(synthesis),
      model: [env.AI_MODEL_ANALYST, env.AI_MODEL_COUNSELOR, env.AI_MODEL_REASONER].join(",")
    });
    await upsertTradeDecision(env, {
      candleKey,
      decision: "WAIT",
      confidence: null,
      entry: null,
      stop: null,
      target: null,
      riskReward: null,
      size: null,
      reasoning
    });
    await env.SIGNAL_CACHE.put("latest:" + safeKeyPart(ticker) + ":" + safeKeyPart(timeframe), JSON.stringify(synthesis), { expirationTtl: 60 * 60 * 24 * 7 });
    try {
      await sendTelegram(env, ["XAUUSD AI DECISION SUPPORT", "Symbol: " + ticker, "Timeframe: " + timeframe, "Candle: " + candleKey, "Decision: WAIT", "Reason: " + reasoning.slice(0, 900), "Note: advisory only; no trade was executed."].join("\n"));
    } catch (error) {
      console.error("telegram_delivery_failed", JSON.stringify({ candle_key: candleKey, message: error instanceof Error ? error.message : "Unknown notification error" }));
    }
    const details: JsonObject = {
      input_fingerprint: inputFingerprint,
      status: "degraded",
      missing_evidence: fusion.missing_evidence,
      validation_errors: fusion.validation_errors,
      timestamp,
      decision,
      evidence_fusion: {
        schema_version: fusion.schema_version,
        candle_key: fusion.candle_key,
        symbol: fusion.symbol,
        timeframe: fusion.timeframe,
        candle_time: fusion.candle_time,
        webhook_sources: fusion.webhook_sources,
        local_calculation_versions: Object.fromEntries(Object.entries(fusion.local_calculations).map(([name, item]: [string, any]) => [name, item.calculation_version])),
        news_analysis_key: asText(fusion.fundamental_news_analysis?.analysis_key),
        news_analyzed_at: asText(fusion.fundamental_news_analysis?.analyzed_at)
      }
    };
    await env.WEBHOOK_BUFFER.put("analysis:" + safeKeyPart(candleKey), JSON.stringify({ ...details, created_at: timestamp, sources: Object.keys(payloads), decision: synthesis }), { expirationTtl: 60 * 60 * 24 * 14 });
    await setAnalysisRunStatus(env, candleKey, "degraded", details, "required_evidence_unavailable");
    await enqueueMultiAgentBus(env, candleKey, inputFingerprint);
    return { status: "degraded", missing_evidence: fusion.missing_evidence };
  }

  const analystResult = await tracing.enterSpan("chat", async (span) => {
    span.setAttributes({
      "gen_ai.operation.name": "chat",
      "gen_ai.agent.name": "xauusd-decision-agent",
      "gen_ai.agent.id": "xauusd-ai-trading-assistant-production",
      "gen_ai.conversation.id": candleKey,
      "gen_ai.request.model": String(env.AI_MODEL_ANALYST as keyof AiModels)
    });
    return env.AI.run(env.AI_MODEL_ANALYST as keyof AiModels, {
    messages: chatMessages([
      "You are the Analyst stage in an XAUUSD decision-support pipeline.",
      "Classify the supplied indicator evidence without inventing missing values or prices.",
      "Decode every numeric field with EVIDENCE.policy.field_dictionary (derived from the Pine sources) before reasoning, and quote the decoded meaning. Apply EVIDENCE.policy.decision_policy. Never infer a field meaning that is not in the dictionary.",
      "Prophet is the base directional bias. GMI can validate, block, or defer a setup but must not silently overwrite Prophet's bias.",
      "Evidence includes the versioned evidence_fusion result, technical source_payloads, all local calculation evidence, and completed fundamental_news_analysis.",
      "Evidence arrives in three separate input lanes (see input_lanes): tradingview_webhook = indicator outputs computed by TradingView (source_payloads); local_computation = outputs computed locally from raw TradingView OHLCV (local_calculation_evidence); fundamental_news = completed news analysis. Never merge, average, or relabel values across lanes. Attribute every technical claim to its lane, and state explicitly where the tradingview_webhook and local_computation lanes agree or disagree.",
      "If evidence_fusion.complete is false, set directional_bias to NEUTRAL and missing_evidence to true; list every missing_evidence and validation_errors item.",
      "If news_evidence.available is false, state that completed fundamental news analysis is unavailable. Do NOT invent news.",
      "If news_evidence.available is true, consider the completed analysis and its underlying article evidence alongside technical evidence.",
      "If informational_5m_context is present, treat it as unverified 5m context only; it must not change the decision or prices.",
      "Return JSON only with keys: directional_bias (BULLISH, BEARISH, or NEUTRAL), setup_quality (integer 0-3), missing_evidence (boolean), reasoning.",
      "Set directional_bias to NEUTRAL and missing_evidence to true if evidence is missing, stale, contradictory, or insufficient.",
      "EVIDENCE:",
      JSON.stringify(evidence)
    ]),
    max_tokens: MAX_TOKENS.analyst,
    temperature: 0.1
  } as never); });

  const analystText = extractText(analystResult);
  const counselorResult = await tracing.enterSpan("chat", async (span) => {
    span.setAttributes({
      "gen_ai.operation.name": "chat",
      "gen_ai.agent.name": "xauusd-decision-agent",
      "gen_ai.agent.id": "xauusd-ai-trading-assistant-production",
      "gen_ai.conversation.id": candleKey,
      "gen_ai.request.model": String(env.AI_MODEL_COUNSELOR as keyof AiModels)
    });
    return env.AI.run(env.AI_MODEL_COUNSELOR as keyof AiModels, {
    messages: chatMessages([
      "You are the Counselor stage in an XAUUSD decision-support pipeline.",
      "Use only the JSON evidence and analyst output below. Do not invent prices or indicator definitions.",
      "Decode every numeric field with EVIDENCE.policy.field_dictionary (derived from the Pine sources) before reasoning, and quote the decoded meaning. Apply EVIDENCE.policy.decision_policy. Never infer a field meaning that is not in the dictionary.",
      "Prophet is the base bias. GMI may validate, block, or defer a Prophet setup; it must not silently overwrite Prophet's bias.",
      "Use the complete versioned evidence_fusion bundle as the canonical evidence set, including local_calculation_evidence and fundamental_news_analysis.",
      "Evidence arrives in three separate input lanes (see input_lanes): tradingview_webhook = indicator outputs computed by TradingView (source_payloads); local_computation = outputs computed locally from raw TradingView OHLCV (local_calculation_evidence); fundamental_news = completed news analysis. Never merge, average, or relabel values across lanes. Attribute every technical claim to its lane, and state explicitly where the tradingview_webhook and local_computation lanes agree or disagree.",
      "If evidence_fusion.complete is false, explicitly mark the result degraded and enumerate missing evidence and validation errors.",
      "If news_evidence.available is false, acknowledge completed fundamental news analysis is unavailable. Do NOT fabricate news.",
      "If news_evidence.available is true, weigh the completed news analysis and its underlying article evidence in scenarios.",
      "If informational_5m_context is present, treat it as unverified 5m context only; it must not change the decision or prices.",
      "Return concise JSON with keys: evidence_summary, bullish_scenario, bearish_scenario, neutral_scenario, confirmations, invalidation, risks, missing_data.",
      "If the source payloads conflict or fields are unclear, say so explicitly.",
      "EVIDENCE:",
      JSON.stringify(evidence),
      "ANALYST:",
      analystText
    ]),
    max_tokens: MAX_TOKENS.counselor,
    temperature: 0.1
  } as never); });
  const counselorText = extractText(counselorResult);

  const reasonerResult = await tracing.enterSpan("chat", async (span) => {
    span.setAttributes({
      "gen_ai.operation.name": "chat",
      "gen_ai.agent.name": "xauusd-decision-agent",
      "gen_ai.agent.id": "xauusd-ai-trading-assistant-production",
      "gen_ai.conversation.id": candleKey,
      "gen_ai.request.model": String(env.AI_MODEL_REASONER as keyof AiModels)
    });
    return env.AI.run(env.AI_MODEL_REASONER as keyof AiModels, {
    messages: chatMessages([
      "You are the final Deep Reasoner stage for XAUUSD decision support.",
      "Use only the supplied evidence, analyst output, and counselor output. Do not invent market prices or claim the models verified facts they did not receive.",
      "Decode every numeric field with EVIDENCE.policy.field_dictionary (derived from the Pine sources) before reasoning, and quote the decoded meaning. Apply EVIDENCE.policy.decision_policy. Never infer a field meaning that is not in the dictionary.",
      "Prophet remains the base bias. GMI may validate, block, or wait on a setup. Do not silently reverse Prophet's bias.",
      "Evidence arrives in three separate input lanes (see input_lanes): tradingview_webhook = indicator outputs computed by TradingView (source_payloads); local_computation = outputs computed locally from raw TradingView OHLCV (local_calculation_evidence); fundamental_news = completed news analysis. Never merge, average, or relabel values across lanes. Attribute every technical claim to its lane, and state explicitly where the tradingview_webhook and local_computation lanes agree or disagree.",
      "If evidence_fusion.complete is false, decision MUST be WAIT or NO_TRADE, confidence and all price/risk fields MUST be null, and reasoning must enumerate missing_evidence and validation_errors.",
      "If news_evidence.available is false, state completed fundamental news analysis was unavailable. Do NOT claim news supported or contradicted the setup.",
      "If news_evidence.available is true, incorporate the completed news analysis and its underlying article evidence into final reasoning.",
      "If informational_5m_context is present, treat it as unverified 5m context only; it must not change the decision or prices.",
      "Return ONLY a JSON object with keys: decision (BUY, SELL, WAIT, or NO_TRADE), confidence (number 0-1 or null), entry_price, stop_loss, take_profit, risk_reward, position_size_pct, reasoning, confirmation, invalidation.",
      "Set decision to WAIT or NO_TRADE and prices to null if exact price evidence is absent. Never imply automatic execution.",
      "EVIDENCE:",
      JSON.stringify(evidence),
      "ANALYST:",
      analystText,
      "COUNSELOR:",
      counselorText
    ]),
    max_tokens: MAX_TOKENS.reasoner,
    temperature: 0.1
  } as never); });
  const reasonerText = extractText(reasonerResult);
  const parsedDecision = parseDecision(reasonerText);
  const decision = fusion.complete ? parsedDecision : {
    ...parsedDecision,
    decision: "WAIT",
    confidence: null,
    entry_price: null,
    stop_loss: null,
    take_profit: null,
    risk_reward: null,
    position_size_pct: null,
    reasoning: describeDegradedEvidence(fusion.missing_evidence, fusion.validation_errors)
  };

  const timestamp = new Date().toISOString();
  const synthesis = {
    candle_key: candleKey,
    ticker,
    timeframe,
    timestamp,
    evidence_fusion: fusion,
    analyst_model: env.AI_MODEL_ANALYST,
    analyst_output: analystText,
    counselor_model: env.AI_MODEL_COUNSELOR,
    counselor_output: counselorText,
    reasoner_model: env.AI_MODEL_REASONER,
    reasoner_output: reasonerText,
    news_evidence: newsEvidence,
    decision
  };

  await upsertSynthesis(env, {
    candleKey, ticker, timeframe, timestamp,
    prophetMetrics: JSON.stringify({
      prophet_r38: payloads.prophet_r38?.metrics ?? payloads.prophet_r38,
      prophet_r37_ssot: payloads.prophet_r37_ssot?.metrics ?? payloads.prophet_r37_ssot
    }),
    gmiMetrics: JSON.stringify(payloads.gmi_v12_70?.metrics ?? payloads.gmi_v12_70),
    analysis: JSON.stringify(synthesis),
    model: [env.AI_MODEL_ANALYST, env.AI_MODEL_COUNSELOR, env.AI_MODEL_REASONER].join(",")
  });

  const confidence = typeof decision.confidence === "number" ? decision.confidence : null;
  const entry = typeof decision.entry_price === "number" ? decision.entry_price : null;
  const stop = typeof decision.stop_loss === "number" ? decision.stop_loss : null;
  const target = typeof decision.take_profit === "number" ? decision.take_profit : null;
  const rr = typeof decision.risk_reward === "number" ? decision.risk_reward : null;
  const size = typeof decision.position_size_pct === "number" ? decision.position_size_pct : null;
  const reasoning = asText(decision.reasoning) || reasonerText;

  await upsertTradeDecision(env, {
    candleKey,
    decision: asText(decision.decision) || "WAIT",
    confidence,
    entry,
    stop,
    target,
    riskReward: rr,
    size,
    reasoning
  });

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
  try {
    await sendTelegram(env, message);
  } catch (error) {
    console.error("telegram_delivery_failed", JSON.stringify({ candle_key: candleKey, message: error instanceof Error ? error.message : "Unknown notification error" }));
  }

  const analysisStatus = fusion.complete ? "complete" : "degraded";
  await env.WEBHOOK_BUFFER.put("analysis:" + safeKeyPart(candleKey), JSON.stringify({
    status: analysisStatus,
    created_at: timestamp,
    sources: Object.keys(payloads),
    decision: synthesis,
    missing_evidence: fusion.missing_evidence,
    validation_errors: fusion.validation_errors
  }), { expirationTtl: 60 * 60 * 24 * 14 });
  await setAnalysisRunStatus(env, candleKey, analysisStatus, {
    input_fingerprint: inputFingerprint,
    missing_evidence: fusion.missing_evidence,
    validation_errors: fusion.validation_errors,
    decision: synthesis.decision,
    evidence_fusion: {
      schema_version: fusion.schema_version,
      candle_key: fusion.candle_key,
      symbol: fusion.symbol,
      timeframe: fusion.timeframe,
      candle_time: fusion.candle_time,
      webhook_sources: fusion.webhook_sources,
      local_calculation_versions: Object.fromEntries(Object.entries(fusion.local_calculations).map(([name, item]: [string, any]) => [name, item.calculation_version])),
      news_analysis_key: asText(fusion.fundamental_news_analysis?.analysis_key),
      news_analyzed_at: asText(fusion.fundamental_news_analysis?.analyzed_at)
    }
  }, null);
  await enqueueMultiAgentBus(env, candleKey, inputFingerprint);
  return { status: analysisStatus, missing_evidence: fusion.missing_evidence };
  });
}
async function handleWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.WEBHOOK_SECRET) {
    return json({ error: "WEBHOOK_SECRET is not configured" }, 503);
  }

  const limitedBody = await readBodyLimited(request, 65536).catch(() => null);
  if (!limitedBody) return json({ error: "Unable to read request body" }, 400);
  if (limitedBody.tooLarge) return json({ error: "Payload exceeds 64 KiB limit" }, 413);
  let body: WebhookPayload;
  let normalizedTokens = 0;
  try {
    // TradingView alerts can contain bare NaN/Infinity (Pine str.tostring(na)); map them to null.
    const parsed = parseTradingViewJson(limitedBody.text);
    body = parsed.value as WebhookPayload;
    normalizedTokens = parsed.normalized_tokens;
  } catch {
    return json({ error: "Request body must be valid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Request body must be a JSON object" }, 400);
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
  if (asText(body.candle_key) && asText(body.candle_key) !== safeKeyPart(asText(body.candle_key))) {
    return json({ error: "candle_key contains unsupported characters" }, 400);
  }
  const cleanBody = stripCredentialFields(body) as WebhookPayload;
  const storedPayload: WebhookPayload = { ...cleanBody, schema_version: WEBHOOK_EVIDENCE_CONTRACT_VERSION, source, ticker, timeframe, candle_time: candleTime, candle_key: candleKey };
  delete storedPayload.secret;

  await env.DB.prepare(
    "INSERT INTO webhook_sources (candle_key, source, payload) VALUES (?, ?, ?) ON CONFLICT(candle_key, source) DO UPDATE SET payload = excluded.payload, received_at = datetime('now')"
  ).bind(candleKey, source, JSON.stringify(storedPayload)).run();

  await env.WEBHOOK_BUFFER.put("candle:" + candleKey + ":" + source, JSON.stringify(storedPayload), {
    expirationTtl: 60 * 60 * 24 * 14
  });
  const task = buildWebhookQueueTask({
    candleKey, source, ticker, timeframe, enqueuedAt: new Date().toISOString()
  });
  try {
    await sendQueueTask(env.XAUUSD_EVENTS, task);
  } catch (error) {
    console.error("webhook_queue_send_failed", JSON.stringify({
      event_id: task.event_id, source,
      error_name: error instanceof Error ? error.name : "UnknownError"
    }));
    return json({ error: "Failed to durably enqueue webhook event", event_id: task.event_id }, 503);
  }
  return json({
    status: "accepted", candle_key: candleKey, source,
    analysis_status: "queued", queued: true, event_id: task.event_id,
    normalized_non_finite_tokens: normalizedTokens
  }, 202);
}

/**
 * local_computation ingest shared by the authenticated HTTP endpoint and the
 * RPC entrypoint (LocalComputationIngress). Records are stored as observed;
 * only parity-approved identities enter the trusted lane.
 */
async function ingestLocalCalculation(env: Env, payload: unknown): Promise<{ status: number; body: JsonObject }> {
  const preliminary = validateLocalCalculation(payload);
  if (!preliminary.valid && preliminary.errors.some(error => error !== "calculation_stale" && error !== "computed_at_in_future")) {
    return { status: 400, body: { error: "Invalid local calculation contract", validation_errors: preliminary.errors } };
  }
  const record = payload as Record<string, unknown>;
  if (containsCredentialFields(record)) {
    return { status: 400, body: { error: "Credential-like fields are not permitted in evidence payloads" } };
  }
  const key = safeKeyPart(asText(record.candle_key));
  const engine = asText(record.engine);
  if (!key || !LOCAL_ENGINES.includes(engine as typeof LOCAL_ENGINES[number])) {
    return { status: 400, body: { error: "Invalid candle_key or engine" } };
  }
  const validation = validateLocalCalculation(record, {
    symbol: asText(record.symbol),
    timeframe: asText(record.timeframe),
    candle_key: key,
    candle_time: asText(record.candle_time)
  });
  if (!validation.valid) return { status: 400, body: { error: "Invalid or stale local calculation contract", validation_errors: validation.errors } };
  const identity = identityOf(record);
  if (!identity) return { status: 400, body: { error: "Local calculation provenance must carry SHA-256 source_hash and implementation_hash" } };
  const stored = {
    schema_version: record.schema_version,
    engine,
    symbol: record.symbol,
    timeframe: record.timeframe,
    candle_time: record.candle_time,
    candle_key: key,
    computed_at: record.computed_at,
    calculation_version: record.calculation_version,
    values: record.values,
    provenance: record.provenance,
    received_at: new Date().toISOString()
  };
  // Persist the observed output and identity before queueing reconciliation.
  await ensureSchema(env.DB);
  await registerIdentity(env.DB, identity);
  await env.WEBHOOK_BUFFER.put(OBSERVED_PREFIX + key + ":" + engine, JSON.stringify(stored), LOCAL_TTL);

  const task = buildLocalCalculationQueueTask({
    candleKey: key,
    engine,
    ticker: asText(record.symbol),
    timeframe: asText(record.timeframe),
    candleTime: asText(record.candle_time),
    enqueuedAt: new Date().toISOString()
  });
  try {
    await sendQueueTask(env.XAUUSD_EVENTS, task);
  } catch (error) {
    console.error("local_calculation_queue_send_failed", JSON.stringify({
      event_id: task.event_id, engine,
      error_name: error instanceof Error ? error.name : "UnknownError"
    }));
    return { status: 503, body: { error: "Failed to durably enqueue local calculation" } };
  }
  return {
    status: 202,
    body: {
      status: "accepted", schema_version: record.schema_version, engine,
      candle_key: key, trust_status: "candidate_pending_parity",
      analysis_status: "queued", queued: true, event_id: task.event_id
    }
  };
}

async function runAnalysisFromBundle(
  env: Env,
  bundle: EvidenceBundle
): Promise<HandoffResponse> {
  return tracing.enterSpan("invoke_agent", async (agentSpan) => {
    agentSpan.setAttributes({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "xauusd-decision-agent",
      "gen_ai.agent.id": "xauusd-ai-trading-assistant-production",
      "gen_ai.conversation.id": bundle.request_id
    });
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

    // Bundled knowledge base v4 (generated from the Pine SSOT); never a hand-maintained KV value.
    const knowledge = JSON.stringify(TECHNICAL_KNOWLEDGE);

    const analystResult = await tracing.enterSpan("chat", async (span) => {
      span.setAttributes({
        "gen_ai.operation.name": "chat",
        "gen_ai.agent.name": "xauusd-decision-agent",
        "gen_ai.agent.id": "xauusd-ai-trading-assistant-production",
        "gen_ai.conversation.id": bundle.request_id,
        "gen_ai.request.model": String(env.AI_MODEL_ANALYST)
      });
      return env.AI.run(env.AI_MODEL_ANALYST as keyof AiModels, {
      messages: chatMessages([
        "You are the Analyst stage in an XAUUSD decision-support pipeline.",
        "Classify the supplied indicator evidence without inventing missing values or prices.",
        "Decode every numeric field with POLICY.field_dictionary (derived from the Pine sources) before reasoning, and quote the decoded meaning. Apply POLICY.decision_policy. Never infer a field meaning that is not in the dictionary.",
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
      ]),
      max_tokens: MAX_TOKENS.analyst,
      temperature: 0.1
    } as never);
    });
    analystText = extractText(analystResult);

    const counselorResult = await tracing.enterSpan("chat", async (span) => {
      span.setAttributes({
        "gen_ai.operation.name": "chat",
        "gen_ai.agent.name": "xauusd-decision-agent",
        "gen_ai.agent.id": "xauusd-ai-trading-assistant-production",
        "gen_ai.conversation.id": bundle.request_id,
        "gen_ai.request.model": String(env.AI_MODEL_COUNSELOR)
      });
      return env.AI.run(env.AI_MODEL_COUNSELOR as keyof AiModels, {
      messages: chatMessages([
        "You are the Counselor stage in an XAUUSD decision-support pipeline.",
        "Use only the JSON evidence and analyst output below. Do not invent prices or indicator definitions.",
        "Decode every numeric field with POLICY.field_dictionary (derived from the Pine sources) before reasoning, and quote the decoded meaning. Apply POLICY.decision_policy. Never infer a field meaning that is not in the dictionary.",
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
      ]),
      max_tokens: MAX_TOKENS.counselor,
      temperature: 0.1
    } as never);
    });
    counselorText = extractText(counselorResult);

    const reasonerResult = await tracing.enterSpan("chat", async (span) => {
      span.setAttributes({
        "gen_ai.operation.name": "chat",
        "gen_ai.agent.name": "xauusd-decision-agent",
        "gen_ai.agent.id": "xauusd-ai-trading-assistant-production",
        "gen_ai.conversation.id": bundle.request_id,
        "gen_ai.request.model": String(env.AI_MODEL_REASONER)
      });
      return env.AI.run(env.AI_MODEL_REASONER as keyof AiModels, {
      messages: chatMessages([
        "You are the final Deep Reasoner stage for XAUUSD decision support.",
        "Use only the supplied evidence, analyst output, and counselor output. Do not invent market prices or claim the models verified facts they did not receive.",
        "Decode every numeric field with POLICY.field_dictionary (derived from the Pine sources) before reasoning, and quote the decoded meaning. Apply POLICY.decision_policy. Never infer a field meaning that is not in the dictionary.",
        "Prophet remains the base bias. GMI may validate, block, or wait on a setup. Do not silently reverse Prophet's bias.",
        "If news_evidence.available is false, state fundamental news analysis was not performed. Do NOT claim news supported or contradicted the setup.",
        "If news_evidence.available is true, incorporate the supplied articles into final reasoning.",
        "Return ONLY a JSON object with keys: decision (BUY, SELL, WAIT, or NO_TRADE), confidence (number 0-1 or null), entry_price, stop_loss, take_profit, risk_reward, position_size_pct, reasoning, confirmation, invalidation.",
        "Set decision to WAIT or NO_TRADE and prices to null if exact price evidence is absent. Never imply automatic execution.",
        "EVIDENCE:",
        JSON.stringify(evidence),
        "POLICY:",
        knowledge,
        "ANALYST:",
        analystText,
        "COUNSELOR:",
        counselorText
      ]),
      max_tokens: MAX_TOKENS.reasoner,
      temperature: 0.1
    } as never);
    });
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
  await upsertSynthesis(env, {
    candleKey, ticker, timeframe, timestamp,
    prophetMetrics: JSON.stringify({ sources: bundle.sources, engines: bundle.engines }),
    gmiMetrics: JSON.stringify({ engines: bundle.engines }),
    analysis: JSON.stringify(synthesis),
    model: [env.AI_MODEL_ANALYST, env.AI_MODEL_COUNSELOR, env.AI_MODEL_REASONER].join(",")
  });

  const confidence = typeof decision.confidence === "number" ? decision.confidence : null;
  const entry = typeof decision.entry_price === "number" ? decision.entry_price : null;
  const stop = typeof decision.stop_loss === "number" ? decision.stop_loss : null;
  const target = typeof decision.take_profit === "number" ? decision.take_profit : null;
  const rr = typeof decision.risk_reward === "number" ? decision.risk_reward : null;
  const size = typeof decision.position_size_pct === "number" ? decision.position_size_pct : null;
  const reasoning = asText(decision.reasoning) || reasonerText;

  await upsertTradeDecision(env, {
    candleKey, decision: asText(decision.decision) || "WAIT",
    confidence, entry, stop, target, riskReward: rr, size, reasoning
  });

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
  });
}



async function handleAnalyze(request: Request, env: Env): Promise<Response> {
  if (!env.CONFLUENCE_HANDOFF_SECRET) {
    return json({ error: "Handoff secret not configured on AI Worker" }, 503);
  }
  if (!env.XAUUSD_EVENTS) {
    return json({ error: "XAUUSD_EVENTS queue is not configured" }, 503);
  }

  const limited = await readBodyLimited(request, 262144).catch(() => null);
  if (!limited || limited.tooLarge) return json({ error: "Request body too large or unreadable" }, 413);
  const body = limited.text;

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
  const candleKey = task.candle_key;
  const claimed = await claimAnalysisRun(env, candleKey, bundle.evidence_fingerprint);
  if (!claimed) return;
  try {
    const result = await runAnalysisFromBundle(env, bundle);
    const failedClosed = result.errors.some(error => error.startsWith("fail_closed:"));
    await setAnalysisRunStatus(env, candleKey, failedClosed ? "degraded" : "complete", {
      input_fingerprint: bundle.evidence_fingerprint,
      request_id: task.request_id,
      decision: result.decision,
      errors: result.errors,
      schema_version: bundle.schema_version
    }, failedClosed ? "required_evidence_unavailable" : null);
  } catch (error) {
    await setAnalysisRunStatus(env, candleKey, "failed", {
      input_fingerprint: bundle.evidence_fingerprint,
      request_id: task.request_id,
      message: error instanceof Error ? error.message : "Unknown analysis error"
    }, "analysis_failed");
    throw error;
  }
}

async function processWebhookReconcileTask(env: Env, task: Extract<QueueTask, { kind: "webhook_reconcile" }>): Promise<void> {
  await reconcileLocalComputation(env, task.candle_key);
  const required = (env.REQUIRED_SOURCES || "prophet_r38,prophet_r37_ssot,gmi_v12_70").split(",").map(value => value.trim()).filter(Boolean);
  const payloads = await loadWebhookPayloadsFromD1(env, task.candle_key, required);
  const missing = required.filter(source => !payloads[source]);
  await env.WEBHOOK_BUFFER.put("reconciled:" + safeKeyPart(task.candle_key) + ":" + task.source, JSON.stringify({
    status: missing.length ? "waiting_for_sources" : "sources_complete",
    candle_key: task.candle_key, source: task.source,
    received_sources: Object.keys(payloads), missing_sources: missing,
    reconciled_at: new Date().toISOString()
  }), LOCAL_TTL);
  if (missing.length) return;
  const existing = await env.WEBHOOK_BUFFER.get("analysis:" + safeKeyPart(task.candle_key));
  if (existing) {
    try { if ((JSON.parse(existing) as JsonObject).status === "complete") return; } catch { /* retry */ }
  }
  try {
    await runAnalysis(env, task.candle_key, task.ticker, task.timeframe, payloads);
  } catch (error) {
    await setAnalysisRunStatus(env, task.candle_key, "failed", {
      message: error instanceof Error ? error.message : "Unknown analysis error", event_id: task.event_id
    }, "analysis_failed");
    throw error;
  }
}

async function processLocalCalculationReconcileTask(env: Env, task: Extract<QueueTask, { kind: "local_calculation_reconcile" }>): Promise<void> {
  await reconcileLocalComputation(env, task.candle_key);
  const required = (env.REQUIRED_SOURCES || "prophet_r38,prophet_r37_ssot,gmi_v12_70").split(",").map(value => value.trim()).filter(Boolean);
  const localRecords = await Promise.all(LOCAL_ENGINES.map(engine => env.WEBHOOK_BUFFER.get("localcalc:" + task.candle_key + ":" + engine)));
  if (!localRecords.every(Boolean)) return;
  const payloads = await loadWebhookPayloadsFromD1(env, task.candle_key, required);
  if (!required.every(source => payloads[source])) return;
  const existing = await env.WEBHOOK_BUFFER.get("analysis:" + safeKeyPart(task.candle_key));
  if (existing) {
    try { if ((JSON.parse(existing) as JsonObject).status === "complete") return; } catch { /* retry */ }
  }
  try {
    await runAnalysis(env, task.candle_key, task.ticker, task.timeframe, payloads);
  } catch (error) {
    await setAnalysisRunStatus(env, task.candle_key, "failed", {
      message: error instanceof Error ? error.message : "Unknown analysis error", event_id: task.event_id
    }, "analysis_failed");
    throw error;
  }
}

async function processQueueTask(env: Env, task: QueueTask): Promise<void> {
  await tracing.enterSpan("process_queue", async span => {
    span.setAttributes({
      "messaging.system": "cloudflare_queues",
      "messaging.destination.name": "xauusd-webhook-events",
      "messaging.operation.type": "process",
      "messaging.message.id": task.event_id,
      "cryptophys.queue.task_kind": task.kind,
      "cryptophys.candle_key": task.candle_key
    });
    if (task.kind === "webhook_reconcile") return processWebhookReconcileTask(env, task);
    if (task.kind === "local_calculation_reconcile") return processLocalCalculationReconcileTask(env, task);
    if (task.kind === "analysis") return processAnalysisTask(env, task);
    if (task.kind === "news_thread") {
      const result = await runNewsThread(env, task);
      console.log("news_thread", JSON.stringify({ analysis_key: task.analysis_key, ...result }));
      return;
    }
    if (task.kind === "live_room") {
      const result = await runLiveRoomBar(env, task);
      console.log("live_room", JSON.stringify({ bar_time: task.bar_time, ...result }));
      return;
    }
    if (task.kind === "multi_agent_bus") {
      const result = await runMultiAgentBus(env, task);
      console.log("multi_agent_bus", JSON.stringify({ candle_key: task.candle_key, ...result }));
      return;
    }
    throw new Error("Unsupported queue task kind");
  });
}

async function consumeQueue(batch: MessageBatch<QueueTask>, env: Env): Promise<void> {
  const consumer = createQueueConsumer(task => processQueueTask(env, task), {
    retryDelaySeconds: 30,
    onFailure: details => console.error("queue_task_failed", JSON.stringify(details))
  });
  await consumer(batch);
}

/**
 * RPC-only ingress for the local_computation lane (Service Binding with
 * entrypoint "LocalComputationIngress"). RPC methods are not reachable over
 * public HTTP, so internal producers need no shared secret.
 */
async function ingestM5Context(env: Env, payload: unknown): Promise<{ status: number; body: JsonObject }> {
  const p = (payload && typeof payload === "object" && !Array.isArray(payload)) ? (payload as Record<string, unknown>) : null;
  if (!p) return { status: 400, body: { error: "Invalid 5m context payload" } };
  const validation = validateM5Context(p, Date.now());
  if (!validation.valid) {
    const first = validation.errors[0] || "invalid";
    return { status: 400, body: { error: first, validation_errors: validation.errors } };
  }
  const kv = env.SIGNAL_CACHE;
  if (!kv || typeof kv.put !== "function") return { status: 503, body: { error: "kv_not_configured" } };
  const stored = { ...p, received_at: new Date().toISOString() };
  await kv.put("context:m5:latest", JSON.stringify(stored), { expirationTtl: 900 });
  if (liveRoomEnabled(env)) {
    try {
      await sendQueueTask(env.XAUUSD_EVENTS, buildLiveRoomTask({ barTime: String(p.candle_time), context: stored }) as unknown as QueueTask);
    } catch (error) {
      console.error("live_room_enqueue_failed", error instanceof Error ? error.message : String(error));
    }
  }
  return { status: 200, body: { status: "ok", key: "context:m5:latest" } };
}

export class LocalComputationIngress extends WorkerEntrypoint<Env> {
  async submit(record: unknown): Promise<{ status: number; body: JsonObject }> {
    return ingestLocalCalculation(this.env, record);
  }
  async submitContext(record: unknown): Promise<{ status: number; body: JsonObject }> {
    return ingestM5Context(this.env, record);
  }
}

const DASHBOARD_CORS = { "access-control-allow-origin": "*" };

function dashboardJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...DASHBOARD_CORS, "cache-control": "no-store" } });
}

function parseJsonText(value: unknown, fallback: unknown): unknown {
  try { return JSON.parse(asText(value) || "null") ?? fallback; } catch { return fallback; }
}

const LOCAL_LANE_FRESH_MS = 2 * 60 * 60 * 1000;

/**
 * Read-only API for the Nexus dashboard (nexus.cryptophys.work proxies /api/*).
 * Exposes analysis summaries only: no secrets, no write operations.
 */
async function handleDashboardApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method !== "GET" || !url.pathname.startsWith("/api/")) return null;
  const limitParam = () => Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || "20") || 20));
  if (url.pathname === "/api/status") {
    let ingestion: unknown = { error: "unreachable" };
    try {
      const r = await fetch(asText(env.INGEST_URL || "https://news.cryptophys.work").replace(/\/+$/, "") + "/health", { signal: AbortSignal.timeout(5000) });
      ingestion = await r.json();
    } catch { /* reported as unreachable */ }
    let lastComparison: string | null = null;
    let recentComparisons: unknown[] = [];
    let registry: unknown[] = [];
    try {
      await ensureSchema(env.DB);
      const row = await env.DB.prepare("SELECT MAX(compared_at) AS last FROM engine_parity_comparisons").first<{ last: string | null }>();
      lastComparison = row?.last ?? null;
      const recent = await env.DB.prepare("SELECT engine, candle_key, result, compared_at FROM engine_parity_comparisons ORDER BY compared_at DESC LIMIT 5").all<JsonObject>();
      recentComparisons = recent.results || [];
      const entries = await env.DB.prepare("SELECT engine, status, consecutive_matches, last_candle_key, last_result, updated_at FROM engine_parity_registry ORDER BY updated_at DESC LIMIT 10").all<JsonObject>();
      registry = entries.results || [];
    } catch { /* registry unavailable */ }
    const lastMs = lastComparison ? Date.parse(lastComparison) : NaN;
    return dashboardJson({
      ai_worker: {
        status: "ok",
        ingest_url: asText(env.INGEST_URL),
        ingest_secret: Boolean(env.INGEST_SECRET),
        webhook_secret: Boolean(env.WEBHOOK_SECRET),
        models: { analyst: env.AI_MODEL_ANALYST, counselor: env.AI_MODEL_COUNSELOR, reasoner: env.AI_MODEL_REASONER },
        // local_computation arrives over the LocalComputationIngress RPC entrypoint;
        // "fresh" means a local-vs-webhook parity comparison ran in the last 2 hours.
        // A scheduled sweep (cron 10-59/15) re-reconciles the last closed H1 candles
        // so a candle is not lost when the per-event tasks run before KV settles.
        local_lane: {
          rpc_entrypoint: "LocalComputationIngress",
          last_parity_comparison_at: lastComparison,
          fresh: Number.isFinite(lastMs) && Date.now() - lastMs < LOCAL_LANE_FRESH_MS,
          parity_sweep_cron: PARITY_SWEEP_CRON,
          recent_comparisons: recentComparisons,
          registry
        }
      },
      ingestion_worker: ingestion,
      timestamp: new Date().toISOString()
    });
  }
  if (url.pathname === "/api/news") {
    const rows = await env.DB.prepare("SELECT analysis_key, fetched_at, analyzed_at, article_count, recommendation_json FROM news_analyses ORDER BY analyzed_at DESC LIMIT ?").bind(limitParam()).all<JsonObject>();
    const items = (rows.results || []).map(r => {
      const rec = parseJsonText(r.recommendation_json, {}) as JsonObject;
      return { analysis_key: r.analysis_key, fetched_at: r.fetched_at, analyzed_at: r.analyzed_at, article_count: r.article_count, recommendation: rec?.recommendation ?? null, confidence: rec?.confidence ?? null };
    });
    return dashboardJson({ status: "ok", count: items.length, items });
  }
  if (url.pathname.startsWith("/api/news/")) {
    const key = decodeURIComponent(url.pathname.slice("/api/news/".length));
    const row = await env.DB.prepare("SELECT analysis_key, fetched_at, analyzed_at, article_count, evidence_json, analyst_output, counselor_output, reasoner_output, recommendation_json FROM news_analyses WHERE analysis_key = ? LIMIT 1").bind(key).first<JsonObject>();
    if (!row) return dashboardJson({ status: "not_found" }, 404);
    return dashboardJson({
      status: "ok", analysis_key: row.analysis_key, fetched_at: row.fetched_at, analyzed_at: row.analyzed_at, article_count: row.article_count,
      evidence: parseJsonText(row.evidence_json, null),
      analyst_model: env.AI_MODEL_ANALYST, analyst_output: asText(row.analyst_output),
      counselor_model: env.AI_MODEL_COUNSELOR, counselor_output: asText(row.counselor_output),
      reasoner_model: env.AI_MODEL_REASONER, reasoner_output: asText(row.reasoner_output),
      recommendation: parseJsonText(row.recommendation_json, {})
    });
  }
  if (url.pathname === "/api/decisions") {
    const rows = await env.DB.prepare("SELECT candle_key, created_at, decision, confidence, entry_price, stop_loss, take_profit, risk_reward, position_size_pct, reasoning FROM trade_decisions ORDER BY created_at DESC LIMIT ?").bind(limitParam()).all<JsonObject>();
    const items = (rows.results || []).map(r => ({ candle_key: r.candle_key, timestamp: r.created_at, decision: r.decision, confidence: r.confidence, entry_price: r.entry_price, stop_loss: r.stop_loss, take_profit: r.take_profit, risk_reward: r.risk_reward, position_size_pct: r.position_size_pct, reasoning: asText(r.reasoning).slice(0, 300) }));
    return dashboardJson({ status: "ok", count: items.length, items });
  }
  if (url.pathname.startsWith("/api/decision/")) {
    const key = decodeURIComponent(url.pathname.slice("/api/decision/".length));
    const row = await env.DB.prepare("SELECT candle_key, timestamp, ai_analysis FROM ai_syntheses WHERE candle_key = ? ORDER BY timestamp DESC LIMIT 1").bind(key).first<JsonObject>();
    if (!row) return dashboardJson({ status: "not_found" }, 404);
    return dashboardJson({ status: "ok", candle_key: row.candle_key, timestamp: row.timestamp, synthesis: parseJsonText(row.ai_analysis, null) });
  }
  if (url.pathname === "/api/threads") {
    try {
      const kind = url.searchParams.get("kind") || "news";
      const limit = Number(url.searchParams.get("limit") || "20");
      const items = kind === "h1" ? await listH1Threads(env.DB, { limit }) : await listThreads(env.DB, { kind, limit });
      return dashboardJson({ status: "ok", count: items.length, items });
    } catch (error) {
      console.error("threads_read_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error", error: "threads_unavailable" }, 500);
    }
  }
  if (url.pathname.startsWith("/api/threads/")) {
    try {
      const threadId = decodeURIComponent(url.pathname.slice("/api/threads/".length));
      const thread = threadId.startsWith("h1:") ? await readH1Thread(env.DB, threadId.slice(3)) : await readThread(env.DB, threadId);
      if (!thread) return dashboardJson({ status: "not_found" }, 404);
      return dashboardJson({ status: "ok", thread });
    } catch (error) {
      console.error("thread_read_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error", error: "thread_unavailable" }, 500);
    }
  }
  if (url.pathname === "/api/live") {
    try {
      const items = await readLive(env.DB, { since: Number(url.searchParams.get("since") || "0"), limit: Number(url.searchParams.get("limit") || "50") });
      return dashboardJson({ status: "ok", enabled: liveRoomEnabled(env), label: "UNVERIFIED 5m", items });
    } catch (error) {
      console.error("live_read_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error", error: "live_unavailable" }, 500);
    }
  }
  if (url.pathname === "/api/bus") {
    try {
      const bus = await readBus(env.DB, url.searchParams.get("candle_key"));
      return dashboardJson({ status: "ok", enabled: busEnabled(env), ...bus });
    } catch (error) {
      console.error("bus_read_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error", error: "bus_unavailable" }, 500);
    }
  }
  if (url.pathname === "/api/m5-context") {
    try {
      const raw = await env.SIGNAL_CACHE?.get("context:m5:latest");
      if (!raw) return dashboardJson({ status: "not_found" }, 404);
      return dashboardJson({ status: "ok", context: JSON.parse(raw) });
    } catch {
      return dashboardJson({ status: "error" }, 500);
    }
  }
  return dashboardJson({ error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: { ...DASHBOARD_CORS, "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" } });
    }
    if (request.method === "GET" && url.pathname === "/dashboard") {
      return new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    const dashboardResponse = await handleDashboardApi(request, env, url).catch(() => dashboardJson({ status: "error", error: "dashboard_api_failed" }, 500));
    if (dashboardResponse) return dashboardResponse;
    if (request.method === "GET" && url.pathname === "/ready") {
      try {
        await env.DB.prepare("SELECT status FROM analysis_runs LIMIT 1").first<{ status: string }>();
      } catch {
        return json({ status: "not_ready", d1_analysis_runs: false, reason: "Required analysis_runs D1 migration is not available." }, 503);
      }
      try {
        await ensureSchema(env.DB);
        const counts = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM engine_parity_registry GROUP BY status").all<{ status: string; n: number }>();
        return json({
          status: env.XAUUSD_EVENTS ? "ready" : "not_ready",
          schema_version: "cryptophys.evidence-fusion.v1",
          local_calculation_contract: "cryptophys.local-calculation.v1",
          d1_analysis_runs: true,
          event_queue: Boolean(env.XAUUSD_EVENTS),
          provenance_mode: "autonomous_parity_registry",
          parity_registry: PARITY_REGISTRY_VERSION,
          parity_policy: policyFromEnv(env as unknown as Record<string, unknown>),
          registry_status_counts: Object.fromEntries((counts.results || []).map(row => [row.status, Number(row.n)]))
        });
      } catch {
        return json({ status: "not_ready", d1_analysis_runs: true, reason: "Engine parity registry is not available." }, 503);
      }
    }
    if (request.method === "GET" && url.pathname === "/provenance/registry") {
      if (!env.WEBHOOK_SECRET || request.headers.get("x-webhook-secret") !== env.WEBHOOK_SECRET) {
        return json({ error: "Unauthorized" }, 401);
      }
      await ensureSchema(env.DB);
      return json({ registry: PARITY_REGISTRY_VERSION, policy: policyFromEnv(env as unknown as Record<string, unknown>), entries: await listRegistry(env.DB) });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        status: "ok",
        service: "xauusd-ai-trading-assistant",
        knowledge_base: { version: 4, source: "bundled, generated from pinescript/ssot", content_sha256: KNOWLEDGE_SHA },
        bindings: {
          d1: Boolean(env.DB),
          signal_cache: Boolean(env.SIGNAL_CACHE),
          webhook_buffer: Boolean(env.WEBHOOK_BUFFER),
          knowledge_base: Boolean(env.KNOWLEDGE_BASE),
          workers_ai: Boolean(env.AI),
          event_queue: Boolean(env.XAUUSD_EVENTS),
          news_ingestion_rpc: Boolean(env.NEWS_INGESTION)
        },
        secrets_configured: {
          webhook_secret: Boolean(env.WEBHOOK_SECRET),
          confluence_handoff_secret: Boolean(env.CONFLUENCE_HANDOFF_SECRET),
          telegram_bot_token: Boolean(env.TELEGRAM_BOT_TOKEN),
          telegram_chat_id: Boolean(env.TELEGRAM_CHAT_ID),
          ingest_secret: Boolean(env.INGEST_SECRET)
        },
        ingest_configured: {
          ingest_url: asText(env.INGEST_URL),
          ingest_secret: Boolean(env.INGEST_SECRET)
        }
      });
    }
    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/analyze") {
      return handleAnalyze(request, env);
    }
    if (request.method === "POST" && url.pathname === "/evidence/local-calculation") {
      if (!env.WEBHOOK_SECRET || request.headers.get("x-webhook-secret") !== env.WEBHOOK_SECRET) {
        return json({ error: "Unauthorized" }, 401);
      }
      const declaredLength = Number.parseInt(request.headers.get("content-length") || "0", 10);
      if (Number.isFinite(declaredLength) && declaredLength > 65536) return json({ error: "Payload exceeds 64 KiB limit" }, 413);
      let bodyText: string;
      try {
        const limitedBody = await readBodyLimited(request, 65536);
        if (limitedBody.tooLarge) return json({ error: "Payload exceeds 64 KiB limit" }, 413);
        bodyText = limitedBody.text;
      } catch { return json({ error: "Request body could not be read" }, 400); }
      let payload: unknown;
      try { payload = JSON.parse(bodyText); } catch { return json({ error: "Request body must be valid JSON" }, 400); }
      const result = await ingestLocalCalculation(env, payload);
      return json(result.body, result.status);
    }
    if (request.method === "POST" && url.pathname === "/evidence/m5-context") {
      if (!env.WEBHOOK_SECRET || request.headers.get("x-webhook-secret") !== env.WEBHOOK_SECRET) {
        return json({ error: "Unauthorized" }, 401);
      }
      let bodyText: string;
      try {
        const limitedBody = await readBodyLimited(request, 65536);
        if (limitedBody.tooLarge) return json({ error: "Payload exceeds 64 KiB limit" }, 413);
        bodyText = limitedBody.text;
      } catch { return json({ error: "Request body could not be read" }, 400); }
      let payload: unknown;
      try { payload = JSON.parse(bodyText); } catch { return json({ error: "Request body must be valid JSON" }, 400); }
      const result = await ingestM5Context(env, payload);
      return json(result.body, result.status);
    }
    if (request.method === "POST" && url.pathname === "/preview/news-analysis-fixture") {
      // Exists only where PREVIEW_FIXTURES_ENABLED is "true" (wrangler.preview.jsonc). Production never sets it.
      if (String(env.PREVIEW_FIXTURES_ENABLED || "false") !== "true") return json({ error: "Not found" }, 404);
      if (!env.WEBHOOK_SECRET || request.headers.get("x-webhook-secret") !== env.WEBHOOK_SECRET) {
        return json({ error: "Unauthorized" }, 401);
      }
      const now = new Date().toISOString();
      const analysisKey = "preview-fixture-" + crypto.randomUUID();
      const evidence = { articles: [
        { title: "Fed signals patience on rate cuts as inflation cools", published_at: now, source: "preview-fixture" },
        { title: "Dollar index slips; gold steadies near session highs", published_at: now, source: "preview-fixture" }
      ] };
      const recommendation = { stance: "WAIT_FOR_TECHNICAL_CONFIRMATION", confidence: 0.4, summary: "Preview fixture: mixed macro signals, no clear driver." };
      await env.DB.prepare(
        "INSERT INTO news_analyses (analysis_key, fetched_at, analyzed_at, article_count, evidence_json, analyst_output, counselor_output, reasoner_output, recommendation_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(analysisKey, now, now, 2, JSON.stringify(evidence), "preview fixture", "preview fixture", "Preview fixture reasoner: wait for technical confirmation.", JSON.stringify(recommendation)).run();
      await enqueueNewsThread(env, analysisKey);
      return json({ status: "ok", analysis_key: analysisKey, thread_id: "news:" + analysisKey }, 202);
    }
    if (url.pathname === "/news/analyze" && request.method === "POST") {
      if (!env.WEBHOOK_SECRET || request.headers.get("x-webhook-secret") !== env.WEBHOOK_SECRET) {
        return json({ error: "Unauthorized" }, 401);
      }
      try {
        return json(await runNewsAnalysis(env));
      } catch (error) {
        return json({ status: "error", error: error instanceof Error ? error.message : "Unknown news analysis error" }, 502);
      }
    }
    if (url.pathname === "/news/latest" && request.method === "GET") {
      if (!env.WEBHOOK_SECRET || request.headers.get("x-webhook-secret") !== env.WEBHOOK_SECRET) {
        return json({ error: "Unauthorized" }, 401);
      }
      const latest = await env.SIGNAL_CACHE.get("latest:news:fundamental");
      if (latest) return new Response(latest, { headers: JSON_HEADERS });
      const row = await env.DB.prepare("SELECT analysis_key, fetched_at, analyzed_at, article_count, recommendation_json FROM news_analyses ORDER BY analyzed_at DESC LIMIT 1").first<JsonObject>();
      if (!row) return json({ status: "not_found", message: "No fundamental news analysis has completed yet." }, 404);
      return json({ status: "ok", analysis_type: "fundamental_news", ...row, recommendation: JSON.parse(asText(row.recommendation_json) || "{}") });
    }
    return json({ error: "Not found", endpoints: ["GET /health", "GET /ready", "GET /dashboard", "POST /webhook", "POST /v1/analyze", "POST /evidence/local-calculation", "POST /news/analyze", "GET /news/latest", "GET /api/status", "GET /api/news", "GET /api/news/:key", "GET /api/decisions", "GET /api/decision/:key"] }, 404);
  },
  async queue(batch: MessageBatch<QueueTask>, env: Env): Promise<void> {
    return consumeQueue(batch, env);
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === PARITY_SWEEP_CRON) {
      // Idempotent re-reconciliation of the most recently closed H1 candles. The
      // per-event reconcile tasks run within seconds of evidence arrival and can
      // all miss a candle when KV has not yet settled (cached misses); without a
      // later sweep those parity comparisons would be lost permanently.
      ctx.waitUntil(reconcileRecentCandles(env).then(async result => {
        try { await backfillRecentAnalyses(env, { loadPayloads: loadWebhookPayloadsFromD1, runAnalysis, setStatus: setAnalysisRunStatus }); } catch (e) { console.error("backfill_failed", e instanceof Error ? e.message : String(e)); }
        console.log("Scheduled parity sweep completed", JSON.stringify({
          swept_at: result.swept_at,
          candle_keys: result.candle_keys,
          results: Object.fromEntries(Object.entries(result.results).map(([key, value]) => [key,
            "comparisons" in value
              ? Object.fromEntries(Object.entries(value.comparisons).map(([engine, outcome]) => [engine, `${outcome.result}${outcome.counted ? "" : " (not counted)"}`]))
              : { error: value.error }
          ]))
        }));
      }).catch(error => {
        console.error("Scheduled parity sweep failed", error instanceof Error ? error.message : String(error));
      }));
      return;
    }
    ctx.waitUntil(runNewsAnalysis(env).then(result => {
      console.log("Scheduled fundamental news analysis completed", JSON.stringify({
        analysis_key: result.analysis_key,
        article_count: result.article_count,
        analyzed_at: result.analyzed_at
      }));
    }).catch(error => {
      console.error("Scheduled fundamental news analysis failed", error instanceof Error ? error.message : String(error));
    }));
  }
};
