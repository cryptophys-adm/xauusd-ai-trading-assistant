import { WorkerEntrypoint, tracing } from "cloudflare:workers";
import { buildEvidenceFusion, indicatorPayloadsFromLocal, analysisAllowedForTimeframe, isHudSource, LOCAL_ENGINES, INGEST_ENGINES, validateLocalCalculation, WEBHOOK_EVIDENCE_CONTRACT_VERSION, NEWS_ANALYSIS_CONTRACT_VERSION, NEWS_MAX_AGE_MS, containsCredentialFields, stripCredentialFields } from "./evidence-fusion.mjs";
import { validateM5Context, freshM5Context } from "./m5-context.mjs";
import { filterRecentUniqueArticles } from "./news-filter.mjs";
import { parseTradingViewJson } from "./tradingview-json.mjs";
import { chatMessages, cleanModelText, extractJsonObject, extractModelText, MAX_TOKENS, runModel } from "./model-text.mjs";
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

export interface Env {
  NEXUS_DASHBOARD_URL?: string;
  /** "off" turns the Decision Engine off: the EA, Telegram and the ledger follow the H1 decision again. */
  DECISION_ENGINE?: string;
  DECISION_TELEGRAM_MODE?: string;
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
  // Cryptophys Platform AI Kernel (RFC_INDICATOR_AGENT_PLATFORM P4). Production only; the
  // caller identity is pinned in the binding props, there is no secret.
  AGENTS?: {
    whoami(agentId: string): Promise<Record<string, unknown>>;
    syscall(agentId: string, capability: string, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  // Aether, the Knowledge Guardian (RFC_AETHER_KNOWLEDGE_GUARDIAN A5): cryptophys-aether
  // KnowledgeIngress. Production only; no secret. Receives decision cards (no levels).
  AETHER?: {
    ingestCards(cards: unknown[]): Promise<{ accepted: number; rejected: Array<{ card_id: string | null; errors: string[] }>; truncated: number }>;
    canonInfo(): Promise<Record<string, unknown>>;
    // Phase A7: the items a person approved for shadow testing (never a live prompt).
    learnedPack(): Promise<Record<string, unknown>>;
  };
  // Aether's read-only sync checks (hardening 2026-11-09, src/aether-sync.mjs). Production only.
  AETHER_READER?: {
    sync(): Promise<Record<string, unknown>>;
  };
  XAUUSD_EVENTS: Queue<QueueTask>;
  INGEST_URL?: string;
  INGEST_SECRET?: string;
  AI_MODEL_ANALYST: string;
  AI_MODEL_COUNSELOR: string;
  AI_MODEL_REASONER: string;
  REQUIRED_SOURCES: string;
  INDICATOR_SOURCE?: string;
  CALIBRATION_INTERVAL_DAYS?: string;
  ANALYSIS_TIMEFRAMES?: string;
  MULTI_AGENT_BUS_ENABLED?: string;
  MULTI_AGENT_MAX_CALLS_PER_HOUR?: string;
  MULTI_AGENT_MODEL?: string;
  MULTI_AGENT_FALLBACK_MODEL?: string;
  ROOM_AGENT_MODEL?: string;
  ROOM_AGENT_FALLBACK_MODEL?: string;
  MODERATOR_MODEL?: string;
  MODERATOR_FALLBACK_MODEL?: string;
  LIVE_ROOM_ENABLED?: string;
  LIVE_ROOM_MAX_CALLS_PER_HOUR?: string;
  WAR_ROOM_ENABLED?: string;
  WAR_ROOM_MAX_CALLS_PER_HOUR?: string;
  TF_THREADS_ENABLED?: string;
  TF_THREADS_MAX_CALLS_PER_HOUR?: string;
  MACRO_ROOM_ENABLED?: string;
  MACRO_ROOM_MAX_CALLS_PER_HOUR?: string;
  NEWS_DAILY_ENABLED?: string;
  NEWS_DAILY_MAX_CALLS_PER_HOUR?: string;
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
  "gmi v12.70": "gmi_v12_70",
  prophet_r38_hud: "prophet_r38_hud",
  "prophet-r38-hud": "prophet_r38_hud",
  "prophet r38 hud": "prophet_r38_hud",
  gmi_v12_70_hud: "gmi_v12_70_hud",
  "gmi-v12.70-hud": "gmi_v12_70_hud",
  "gmi v12.70 hud": "gmi_v12_70_hud"
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

import { m5ParityApproved, verifiedM5Reading, M5_VERIFIED_LABEL, M5_UNVERIFIED_LABEL } from "./m5-verification.mjs";
import { storeHudSnapshot, loadHudSnapshot, hudReadings, approvedComparable, barsVerified } from "./hud-store.mjs";
import { hudLevels, LEVEL_TIMEFRAMES } from "./hud-levels.mjs";
import { readGlobalConclusion } from "./global-conclusion.mjs";
import { readStrategy, loadStrategyInputs, buildStrategy, ownTimeframePlan, loadOwnTimeframePlanInputs } from "./strategy-engine.mjs";
import { captureStrategyInputs, scoreStrategyCaptures, strategyInputsStatus } from "./strategy-inputs.mjs";
import { replayStrategyCaptures, readStrategyReplay } from "./strategy-replay.mjs";
import { runSignalLedger, readLedger, ingestStrategy, ingestDecision, ensureLedgerSchema } from "./signal-ledger.mjs";
import { runDecisionEngine, runPendingDecision, decisionEngineEnabled, readLatestDecision, readDecisions } from "./decision-engine.mjs";
import { runComplianceChecks, readCompliance } from "./compliance.mjs";
import { pushDecisionCards, aetherPushStatus, pushWeightingReport } from "./aether-push.mjs";
import { aetherSyncStatus } from "./aether-sync.mjs";
import { pullLearnedPack, shadowCandidates, packStatus } from "./aether-pack.mjs";
import { loadDecisionCards } from "./decision-cards.mjs";
import { reconcileLocalComputation, reconcileRecentCandles, backfillRecentAnalyses, closedH1CandleKeys, decisionLocalRecords, OBSERVED_PREFIX, LOCAL_TTL, PARITY_SWEEP_CRON } from "./parity-sweep.mjs";
import { loadWebhookPayloadsFromD1 } from "./webhook-payloads.mjs";
import { busEnabled, runMultiAgentBus, readBus } from "./multi-agent-bus.mjs";
import { liveRoomEnabled, isFifteenMinuteClose, buildNewsThreadTask, buildLiveRoomTask, runNewsThread, runLiveRoomBar, listThreads, readThread, readLive, listH1Threads, readH1Thread, buildHudAgentsTask, runHudAgents, m15KeyForClose } from "./agent-threads.mjs";
import { hudAgentsEnabled } from "./hud-agents.mjs";
import { warRoomEnabled, runWarRoomBar, readWarRoom, readTldr, agentName } from "./war-room.mjs";
import { reputationOf, familyOf, REPUTATION_VERSION, REPUTATION_PRIOR, WEIGHT_RANGE } from "./reputation.mjs";
import { indicatorAgents } from "./indicator-registry.mjs";
import { scoreRecentStatements, detectRecentStuckStates, scorecards, listStuckStates, SCORING, SCORING_VERSION } from "./outcome-scoring.mjs";
import { publishPlatformReports, platformStatus } from "./platform-reports.mjs";
import { runShadowVersions, readShadowVersions } from "./shadow-versions.mjs";
import { tuningView } from "./tuning.mjs";
import { readCorrelations } from "./correlations.mjs";
import { refreshCalendar, readCalendar } from "./econ-calendar.mjs";
import { sendLedgerAlerts, readLedgerAlerts } from "./ledger-alerts.mjs";
import { notifyH1Decision } from "./h1-telegram.mjs";
import { runPendingMacroRooms, readMacroRoom } from "./macro-room.mjs";
import { readParityView } from "./parity-view.mjs";
import { readCrowdReplay } from "./tuning-replay.mjs";
import { applyWeighting, weightingMessage, WEIGHTING_TIMEFRAMES } from "./weighting.mjs";
import { eaSignal, eaStatus, storeHeartbeat } from "./ea-signal.mjs";
import { listDeals, omegaOverview, setControl, storeDeal } from "./ea-execution.mjs";
import { readWeightingReplay } from "./weighting-replay.mjs";
import { runPendingTimeframeThreads, runTimeframeThread, runShadowJob, readTimeframeThread, tfThreadsEnabled, tfAgentName } from "./timeframe-threads.mjs";
import { scoreShadowKnowledge, pruneShadowKnowledge, readShadowKnowledge } from "./shadow-knowledge.mjs";
import {
  H1_CHAIN, H1_CONSENSUS_FALLBACK_MS, H1_PENDING_PREFIX, H1_PENDING_TTL_S, H1_ROOM_RETRY_S, H1_ROOM_LOCK_PREFIX, H1_ROOM_LOCK_TTL_S, buildH1RoomTask, h1RoomGate, AWAITING_CONSENSUS, H1_REASONER_GIVE_UP_MS, H1_PENDING_LOOKBACK_MS,
  h1BarTimes, finalizeDue, consensusInput, reasonerLines, quorumOf, applyQuorum, emptyConsensusDecision, reasonerUnavailableDecision, consensusSummary
} from "./h1-consensus.mjs";
import { runNewsDaily, readNewsDaily, newsDailyEnabled } from "./news-daily.mjs";
import { runHealthAlerts, readHealthAlerts } from "./health-alerts.mjs";
import { classifyRejection, recordRejection, webhookLaneStatus } from "./webhook-rejections.mjs";
import { describeDegradedEvidence } from "./natural-language.mjs";
import { interpretWebhookRow, storedIndicatorMetrics } from "./webhook-interpretation.mjs";
import { DECISION_TEXT_RULE, plainDecisionText } from "./plain-decision.mjs";
import { TRADE_PLAN_RULE, validateTradePlan } from "./trade-plan.mjs";

function safeKeyPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 180);
}

// reconcileLocalComputation now lives in ./parity-sweep.mjs (shared by the queue
// tasks and the scheduled parity sweep); OBSERVED_PREFIX and LOCAL_TTL come from
// there too so the lane's KV layout has a single owner.

/**
 * One chat call in the request form of its model family (model-text.mjs modelRequests): gpt-oss
 * takes reasoning_effort (or the Responses form), gemma-4 runs with thinking off.
 */
async function aiRun(env: Env, model: string, opts: { messages: unknown[]; maxTokens: number; effort?: string }): Promise<unknown> {
  return (await runModel(env.AI as unknown as { run: (model: string, input: unknown) => Promise<unknown> }, model, opts)).result;
}

function extractText(result: unknown): string {
  return cleanModelText(extractRawText(result));
}

function extractRawText(result: unknown): string {
  return extractModelText(result);
}

/**
 * Owner rule: the decision text a trader reads is natural language. Only the reasoning,
 * confirmation and invalidation sentences may be rewritten; the decision, prices and
 * conditions never change, and the raw reasoner output is kept in the synthesis.
 */
async function plainDecision(env: Env, decision: JsonObject): Promise<JsonObject> {
  try {
    return (await plainDecisionText(env, decision)).decision as JsonObject;
  } catch (error) {
    console.warn("plain_decision_failed", error instanceof Error ? error.message : String(error));
    return decision;
  }
}

/**
 * The Reasoner's answer on the quorum path (owner decision 2026-11-09): only its words and its
 * confidence count; the direction comes from the room's quorum and the prices from the plan
 * (applyQuorum), so no price check of the model can downgrade or rewrite its text.
 */
function modelDecision(text: string): JsonObject {
  const parsed = extractJsonObject(text);
  if (!parsed) return { decision: "WAIT", confidence: null, reasoning: "", confirmation: null, invalidation: null };
  const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence) && parsed.confidence >= 0 && parsed.confidence <= 1 ? parsed.confidence : null;
  const decision = asText(parsed.decision).toUpperCase();
  return {
    decision: ["BUY", "SELL", "WAIT", "NO_TRADE"].includes(decision) ? decision : "WAIT",
    confidence,
    reasoning: asText(parsed.reasoning),
    confirmation: typeof parsed.confirmation === "string" ? parsed.confirmation : null,
    invalidation: typeof parsed.invalidation === "string" ? parsed.invalidation : null
  };
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
            risk_reward: null, position_size_pct: null, trade_plan: null,
            reasoning: "Actionable model output lacks valid directional prices, confidence, positive risk/reward, or a positive position size within 0–100%; downgraded to WAIT.",
            raw_response: text
          };
        }
        if (positionSize !== null && (positionSize < 0 || positionSize > 100)) {
          return { decision: "WAIT", confidence: null, entry_price: null, stop_loss: null, take_profit: null, risk_reward: null, position_size_pct: null, trade_plan: null, reasoning: "Model position_size_pct was outside the permitted 0–100 range; downgraded to WAIT.", raw_response: text };
        }
        // trade_plan (RFC_HUD_AGENTS §7) is validated against the decision prices; an invalid plan is dropped, never the decision.
        const planCheck = validateTradePlan(parsed.trade_plan, { decision, entry_price: entry, stop_loss: stop, take_profit: target });
        const tradePlan = planCheck.plan;
        return {
          ...parsed,
          decision,
          confidence,
          entry_price: entry,
          stop_loss: stop,
          take_profit: target,
          risk_reward: riskReward,
          position_size_pct: positionSize,
          trade_plan: tradePlan,
          ...(planCheck.errors.length ? { trade_plan_errors: planCheck.errors } : {}),
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
    trade_plan: null,
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
    return aiRun(env, env.AI_MODEL_ANALYST, {
    messages: chatMessages([
      "You are the Fundamental News Analyst for XAUUSD decision support.",
      "Analyze only the supplied news articles. Do not infer current price action, technical indicators, or unpublished facts.",
      "Assess direct and indirect potential impact on gold (XAUUSD), US dollar (DXY), and oil (USOIL). Distinguish reported facts from interpretation and note publication-time limitations.",
      "Write your thesis as plain prose (4-6 sentences, no JSON, no markdown). Cover: gold bias (BULLISH, BEARISH or NEUTRAL), dollar bias, oil bias, risk sentiment, key catalysts, key risks, evidence quality (LOW, MEDIUM, HIGH) and whether the evidence is stale or uncertain. Cite article titles.",
      "Do not produce entry, stop-loss, take-profit, position size, or a technical BUY/SELL order.",
      "NEWS EVIDENCE:", JSON.stringify(evidence)
    ]),
    maxTokens: MAX_TOKENS.analyst,
    effort: "low"
  }); });
  const analystText = extractText(analystResult);

  const counselorResult = await tracing.enterSpan("chat", async (span) => {
    span.setAttributes({
      "gen_ai.operation.name": "chat",
      "gen_ai.agent.name": "xauusd-decision-agent",
      "gen_ai.agent.id": "xauusd-ai-trading-assistant-production",
      "gen_ai.conversation.id": traceConversationId,
      "gen_ai.request.model": String(env.AI_MODEL_COUNSELOR as keyof AiModels)
    });
    return aiRun(env, env.AI_MODEL_COUNSELOR, {
    messages: chatMessages([
      "You are the Fundamental News Counselor.",
      "Use only the news evidence and analyst output. Provide balanced conditional scenarios, not trade execution instructions.",
      "Challenge the analyst's thesis in plain prose (4-6 sentences, no JSON, no markdown). Cover: bullish, bearish and neutral scenarios, what would confirm or invalidate the thesis, watchlist events, and conflicts or missing evidence.",
      "Do not invent prices, technical confirmation, or unsupported causal claims.",
      "NEWS EVIDENCE:", JSON.stringify(evidence),
      "ANALYST:", analystText
    ]),
    maxTokens: MAX_TOKENS.counselor,
    effort: "low"
  }); });
  const counselorText = extractText(counselorResult);

  const reasonerResult = await tracing.enterSpan("chat", async (span) => {
    span.setAttributes({
      "gen_ai.operation.name": "chat",
      "gen_ai.agent.name": "xauusd-decision-agent",
      "gen_ai.agent.id": "xauusd-ai-trading-assistant-production",
      "gen_ai.conversation.id": traceConversationId,
      "gen_ai.request.model": String(env.AI_MODEL_REASONER as keyof AiModels)
    });
    return aiRun(env, env.AI_MODEL_REASONER, {
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
    maxTokens: MAX_TOKENS.reasoner,
    effort: "medium"
  }); });
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

/** Phase C5: HUD agents post in Threads 1H after each H1 synthesis (behind HUD_AGENTS_ENABLED). */
async function enqueueHudAgents(env: Env, candleKey: string): Promise<void> {
  // The War Room replaces the per-H1 HUD agents (owner decision 2026-11-05): their budget moves there.
  if (!hudAgentsEnabled(env) || warRoomEnabled(env) || candleKey.split(":")[2] !== "60") return;
  try {
    await sendQueueTask(env.XAUUSD_EVENTS, buildHudAgentsTask({ candleKey }) as unknown as QueueTask);
  } catch (error) {
    console.error("hud_agents_enqueue_failed", JSON.stringify({ candle_key: candleKey, error: error instanceof Error ? error.message : String(error) }));
  }
}


/**
 * Calibration status per approved identity: when TradingView last confirmed it (a parity
 * comparison) and whether a calibration run is due (owner decision: webhooks are used for
 * periodic calibration, for example monthly, not for decisions).
 */
function calibrationStatus(rows: JsonObject[], now: number, intervalDays: number): JsonObject {
  const out: JsonObject = { interval_days: intervalDays, engines: {} as JsonObject, due: false };
  for (const row of rows) {
    const last = asText(row.last_compared_at);
    const lastMs = Date.parse(last);
    const days = Number.isFinite(lastMs) ? Math.floor((now - lastMs) / 86_400_000) : null;
    const due = days === null || days >= intervalDays;
    (out.engines as JsonObject)[asText(row.engine)] = { status: asText(row.status), consecutive_matches: Number(row.consecutive_matches) || 0, last_calibrated_at: last || null, days_since_calibration: days, calibration_due: due };
    if (due) out.due = true;
  }
  return out;
}

/** How long a local_calculation_reconcile task retries while the other approved records become visible. */
const LOCAL_TRIGGER_RETRY_MS = 4 * 60 * 1000;

/** "local" (default): parity-approved local records drive the chain; "webhook": legacy webhook-driven chain. */
function indicatorSourceMode(env: Env): "local" | "webhook" {
  return asText(env.INDICATOR_SOURCE).toLowerCase() === "webhook" ? "webhook" : "local";
}

/** ISO bar open time from a "<symbol>:<timeframe>:<open ms>" candle key, or "". */
function candleTimeFromKey(candleKey: string): string {
  const ms = Number(String(candleKey).split(":").pop());
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : "";
}

function laneRule(localPrimary: boolean): string {
  return localPrimary
    ? "Evidence lanes (see input_lanes): source_payloads hold the Prophet R38, Prophet R37 and GMI v12.70 indicator outputs computed locally from raw TradingView OHLCV (each record's trust_status says whether parity with TradingView approved its engine identity; not_parity_approved records are still evidence) (the same fields the TradingView alerts carry, plus prophet_r38.setup_state: the Prophet setup state behind the HUD's READY line, local lane only); local_calculation_evidence holds those local records; tradingview_webhook is calibration only and is not decision evidence; fundamental_news = completed news analysis. Never merge, average, or relabel values across lanes, and attribute every technical claim to its lane."
    : "Evidence arrives in three separate input lanes (see input_lanes): tradingview_webhook = indicator outputs computed by TradingView (source_payloads); local_computation = outputs computed locally from raw TradingView OHLCV (local_calculation_evidence); fundamental_news = completed news analysis. Never merge, average, or relabel values across lanes. Attribute every technical claim to its lane, and state explicitly where the tradingview_webhook and local_computation lanes agree or disagree.";
}

async function runAnalysis(
  env: Env,
  candleKey: string,
  ticker: string,
  timeframe: string,
  webhookPayloads: Record<string, WebhookPayload>
): Promise<{ status: string; missing_evidence: string[] }> {
  return tracing.enterSpan("invoke_agent", async (agentSpan) => {
    agentSpan.setAttributes({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "xauusd-decision-agent",
      "gen_ai.agent.id": "xauusd-ai-trading-assistant-production",
      "gen_ai.conversation.id": candleKey
    });
  // Local-primary architecture (owner decision 2026-11-05): the indicator values the chain reads
  // are the local records. Owner decision 2026-11-09: approved by parity or not (a record parity
  // has not approved is labelled not_parity_approved and read with less weight); the H1 decision
  // never waits on the TradingView webhooks. INDICATOR_SOURCE="webhook" restores the legacy chain.
  const localPrimary = indicatorSourceMode(env) === "local";
  const [newsAnalysis, localCalculations] = await Promise.all([
    fetchLatestNewsAnalysis(env),
    decisionLocalRecords(env, safeKeyPart(candleKey)) as Promise<unknown[]>
  ]);
  const payloads: Record<string, WebhookPayload> = localPrimary
    ? indicatorPayloadsFromLocal(localCalculations, { symbol: ticker, timeframe, candleKey }) as Record<string, WebhookPayload>
    : webhookPayloads;
  const candleTime = asText(payloads.prophet_r38?.candle_time || payloads.prophet_r37_ssot?.candle_time || payloads.gmi_v12_70?.candle_time || payloads.prophet_r38?.timestamp || payloads.prophet_r37_ssot?.timestamp || payloads.gmi_v12_70?.timestamp) || candleTimeFromKey(candleKey);
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
      if (fresh) {
        const { recent_bars: _bars, ...compact } = fresh as JsonObject;
        // B2: the context's bar is labelled VERIFIED 5m only while prophet_m5 and gmi_m5 are
        // approved and that bar's observed 5m records come from them (as in the live room).
        // Either way it stays context: it never changes the H1 decision or prices.
        let verification: JsonObject = { verified: false, label: M5_UNVERIFIED_LABEL };
        try {
          const reading = await verifiedM5Reading(env, String(compact.candle_time)) as JsonObject;
          verification = reading.verified
            ? { verified: true, label: M5_VERIFIED_LABEL, trust_status: "approved_by_parity", summary: reading.summary as string }
            : { verified: false, label: M5_UNVERIFIED_LABEL, reason: (reading.reason as string) || "unverified" };
        } catch { /* stays unverified */ }
        informational5mContext = { ...compact, verification };
      }
    }
  } catch { informational5mContext = null; }

  const fusion = buildEvidenceFusion({
    candleKey,
    symbol: ticker,
    timeframe,
    candleTime,
    webhookPayloads,
    localCalculations,
    newsAnalysis,
    informational5mContext,
    webhookLane: localPrimary ? "calibration" : "required",
    // Owner decision 2026-11-09: the H1 decision is the agents' quorum; only an unusable candle stops it.
    decisionMode: localPrimary ? "quorum" : "evidence"
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
    indicator_source: localPrimary ? "local_computation" : "tradingview_webhook",
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
        prophet_r38: storedIndicatorMetrics(payloads.prophet_r38),
        prophet_r37_ssot: storedIndicatorMetrics(payloads.prophet_r37_ssot)
      }),
      gmiMetrics: JSON.stringify(storedIndicatorMetrics(payloads.gmi_v12_70)),
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
      await notifyH1Decision(env, { candleKey, action: "WAIT", send: (text: string) => sendTelegram(env, text),
        text: ["XAUUSD AI DECISION SUPPORT", "Symbol: " + ticker, "Timeframe: " + timeframe, "Candle: " + candleKey, "Decision: WAIT", "Reason: " + reasoning.slice(0, 900), "Note: advisory only; no trade was executed."].join("\n") });
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
    await enqueueHudAgents(env, candleKey);
    return { status: "degraded", missing_evidence: fusion.missing_evidence };
  }

  // The H1 decision by Consensus Discussion (owner decision 2026-11-07): no model runs at the
  // close. The fused evidence is parked until the 1H War Room has spoken; the Reasoner then
  // decides last, from the room's consensus (finalizeH1Decision). Analyst and Counselor are retired.
  const parkedAt = new Date().toISOString();
  await env.WEBHOOK_BUFFER.put(H1_PENDING_PREFIX + safeKeyPart(candleKey), JSON.stringify({
    candle_key: candleKey, ticker, timeframe, parked_at: parkedAt, input_fingerprint: inputFingerprint, local_primary: localPrimary,
    sources: Object.keys(payloads), evidence, news_evidence: newsEvidence,
    prophet_metrics: JSON.stringify({ prophet_r38: storedIndicatorMetrics(payloads.prophet_r38), prophet_r37_ssot: storedIndicatorMetrics(payloads.prophet_r37_ssot) }),
    gmi_metrics: JSON.stringify(storedIndicatorMetrics(payloads.gmi_v12_70))
  }), { expirationTtl: H1_PENDING_TTL_S });
  await setAnalysisRunStatus(env, candleKey, "analyzing", { input_fingerprint: inputFingerprint, parked_at: parkedAt, chain: H1_CHAIN, stage: AWAITING_CONSENSUS }, AWAITING_CONSENSUS);
  // A chart without a War Room (only H1 has one) never gets a consensus: decide now (fail-closed).
  if (candleKey.split(":")[2] !== "60" || !h1BarTimes(candleKey)) await finalizeH1Decision(env, candleKey, { force: true });
  // The 1H room right away (owner request 2026-11-07), not at the next sweep.
  else await enqueueH1Room(env, candleKey);
  return { status: AWAITING_CONSENSUS, missing_evidence: fusion.missing_evidence };
  });
}

/** Enqueues the 1H room of a parked bar (src/h1-consensus.mjs). The sweep stays the fallback. */
async function enqueueH1Room(env: Env, candleKey: string): Promise<void> {
  if (!tfThreadsEnabled(env)) return;
  try {
    await sendQueueTask(env.XAUUSD_EVENTS, buildH1RoomTask({ candleKey }) as unknown as QueueTask);
  } catch (error) {
    console.error("h1_room_enqueue_failed", JSON.stringify({ candle_key: candleKey, error: error instanceof Error ? error.message : String(error) }));
  }
}

/**
 * The h1_room task: waits (redelivered every minute) for the bar's HUD snapshot until
 * H1_ROOM_HUD_WAIT_MS after the close, runs the 1H War Room, and the Reasoner decides as soon as
 * the room concludes. A room still waiting for its bar or its quorum is redelivered; the sweep
 * finishes anything the task could not.
 */
async function processH1RoomTask(env: Env, task: { candle_key: string }): Promise<void> {
  const key = task.candle_key;
  const retry = (why: string) => Object.assign(new Error("h1 room " + why), { name: "H1RoomPending", retryDelaySeconds: H1_ROOM_RETRY_S });
  if (!tfThreadsEnabled(env)) return;
  let hud: string | null = null;
  try { hud = await env.SIGNAL_CACHE.get("hud:60:" + key); } catch { hud = null; }
  if (h1RoomGate({ candleKey: key, now: Date.now(), hudReady: Boolean(hud) }) === "wait_for_hud") throw retry("waiting for its HUD snapshot");
  try { await env.SIGNAL_CACHE.put(H1_ROOM_LOCK_PREFIX + key, new Date().toISOString(), { expirationTtl: H1_ROOM_LOCK_TTL_S }); } catch { /* best effort */ }
  let result: Record<string, unknown>;
  try {
    result = await runTimeframeThread(env, { chart: "H1", candleKey: key });
  } finally {
    try { await env.SIGNAL_CACHE.delete(H1_ROOM_LOCK_PREFIX + key); } catch { /* expires on its own */ }
  }
  console.log("h1_room", JSON.stringify({ candle_key: key, ...result }));
  if (result.status === "no_bar" || result.status === "waiting_for_quorum") throw retry(String(result.status));
  if (result.status === "complete" || result.status === "already_complete") {
    const finalized = await finalizeH1Decision(env, key);
    console.log("h1_consensus_decision", JSON.stringify({ candle_key: key, via: "h1_room", ...finalized }));
  }
  // Aether A7: the shadow calls of approved notes, after the decision (a no-op when disabled).
  const shadow = await runShadowJob(result);
  if (shadow) console.log("shadow_knowledge", JSON.stringify({ candle_key: key, ...shadow }));
}

/** Evidence-fusion fields kept in analysis_runs.result_json. */
function fusionDetails(fusion: any): JsonObject {
  return {
    schema_version: fusion.schema_version,
    candle_key: fusion.candle_key,
    symbol: fusion.symbol,
    timeframe: fusion.timeframe,
    candle_time: fusion.candle_time,
    webhook_sources: fusion.webhook_sources,
    local_calculation_versions: Object.fromEntries(Object.entries(fusion.local_calculations || {}).map(([name, item]: [string, any]) => [name, item?.calculation_version])),
    news_analysis_key: asText(fusion.fundamental_news_analysis?.analysis_key),
    news_analyzed_at: asText(fusion.fundamental_news_analysis?.analyzed_at)
  };
}

/**
 * The Reasoner decides LAST (owner decision 2026-11-07): once the 1H War Room of the bar has
 * concluded, or H1_CONSENSUS_FALLBACK_MS (45 minutes) after the close with whoever spoke, it reads
 * the room's communication bus, Consensus Discussion and conclusion beside the parked evidence
 * and writes the H1 decision. An empty room gives a fail-closed WAIT without a model call.
 * Idempotent: only the caller that moves the run's stage (error_code) from awaiting_consensus to
 * finalizing decides; status stays "analyzing" until the decision is written (CHECK constraint).
 */
async function finalizeH1Decision(env: Env, candleKey: string, { now = Date.now(), force = false }: { now?: number; force?: boolean } = {}): Promise<JsonObject> {
  let room: any = null;
  try { room = await readTimeframeThread(env.DB, "H1", { candleKey, env }); } catch { room = null; }
  const consensus = consensusInput(room);
  if (!force && !finalizeDue({ candleKey, now, roomConcluded: consensus.status === "concluded" })) return { status: "waiting_for_room", consensus: consensus.status };
  const claim = await env.DB.prepare(
    "UPDATE analysis_runs SET error_code = 'finalizing', updated_at = datetime('now') WHERE candle_key = ? AND status = 'analyzing' AND (error_code = 'awaiting_consensus' OR (error_code = 'finalizing' AND updated_at < datetime('now', '-10 minutes')))"
  ).bind(candleKey).run();
  if (!Number(claim?.meta?.changes || 0)) return { status: "not_pending" };
  let parked: any = null;
  try { parked = JSON.parse((await env.WEBHOOK_BUFFER.get(H1_PENDING_PREFIX + safeKeyPart(candleKey))) || "null"); } catch { parked = null; }
  if (!parked?.evidence) {
    // A failed run is re-analysed by the backfill, which parks the evidence again.
    await setAnalysisRunStatus(env, candleKey, "failed", { reason: "The parked evidence of the bar is missing." }, "h1_pending_evidence_missing");
    return { status: "failed", error: "h1_pending_evidence_missing" };
  }
  const evidence = parked.evidence;
  const fusion = evidence.evidence_fusion || {};
  const ticker = asText(parked.ticker), timeframe = asText(parked.timeframe);
  const isH1 = candleKey.split(":")[2] === "60";

  let decision: JsonObject;
  let reasonerText: string | null = null;
  let overridden = false;
  // Owner decision 2026-11-09: the H1 decision is the room's quorum; a BUY or SELL takes its prices
  // from the Key Level Agent's zones (the strategy engine's tradeLevels), or stays WAIT without them.
  const quorum = quorumOf(consensus);
  let plan: JsonObject | null = null;
  if (quorum.stance === "BUY" || quorum.stance === "SELL") {
    try {
      // The 1-hour chart's own levels only (owner decisions 2026-11-09: independent timeframes).
      plan = ownTimeframePlan(await loadOwnTimeframePlanInputs(env), quorum.stance === "BUY" ? 1 : -1) as JsonObject | null;
    } catch (error) {
      console.error("h1_quorum_plan_failed", JSON.stringify({ candle_key: candleKey, message: error instanceof Error ? error.message : String(error) }));
      plan = null;
    }
  }
  if (consensus.status === "empty") {
    decision = isH1 ? emptyConsensusDecision() : { ...emptyConsensusDecision(), reasoning: "This chart has no War Room, so there is no consensus to decide from. The decision stays WAIT." };
  } else {
    try {
      const result = await tracing.enterSpan("chat", async (span) => {
        span.setAttributes({
          "gen_ai.operation.name": "chat",
          "gen_ai.agent.name": "xauusd-decision-agent",
          "gen_ai.agent.id": "xauusd-ai-trading-assistant-production",
          "gen_ai.conversation.id": candleKey,
          "gen_ai.request.model": String(env.AI_MODEL_REASONER as keyof AiModels)
        });
        return aiRun(env, env.AI_MODEL_REASONER, {
          messages: chatMessages(reasonerLines({ evidence, consensus, quorum, plan, laneRule: laneRule(parked.local_primary !== false), decisionTextRule: DECISION_TEXT_RULE, tradePlanRule: TRADE_PLAN_RULE })),
          maxTokens: MAX_TOKENS.reasoner,
          effort: "medium"
        });
      });
      reasonerText = extractText(result);
      // parseDecision may turn a priced model answer into WAIT (its own price checks); the quorum and
      // the plan decide regardless, so the model's text and confidence are what it contributes.
      const guarded = applyQuorum(modelDecision(reasonerText), { quorum, plan });
      overridden = guarded.overridden;
      decision = await plainDecision(env, guarded.decision as JsonObject);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const bar = h1BarTimes(candleKey);
      if (!bar || now - bar.close < H1_REASONER_GIVE_UP_MS) {
        // Back to the queue of the sweep: the next one retries.
        await setAnalysisRunStatus(env, candleKey, "analyzing", { input_fingerprint: parked.input_fingerprint, parked_at: parked.parked_at, chain: H1_CHAIN, stage: AWAITING_CONSENSUS, last_error: message.slice(0, 300) }, AWAITING_CONSENSUS);
        return { status: "reasoner_failed", message: message.slice(0, 200) };
      }
      decision = reasonerUnavailableDecision();
    }
  }

  const timestamp = new Date().toISOString();
  const synthesis = {
    candle_key: candleKey, ticker, timeframe, timestamp,
    evidence_fusion: fusion,
    analysis_chain: H1_CHAIN,
    consensus: consensusSummary(consensus, { overridden, quorum, plan, decidedAfterCloseS: h1BarTimes(candleKey) ? Math.round((Date.now() - (h1BarTimes(candleKey) as { close: number }).close) / 1000) : null }),
    reasoner_model: env.AI_MODEL_REASONER,
    reasoner_output: reasonerText,
    news_evidence: parked.news_evidence ?? evidence.news_evidence ?? null,
    decision
  };
  await upsertSynthesis(env, {
    candleKey, ticker, timeframe, timestamp,
    prophetMetrics: asText(parked.prophet_metrics) || "{}",
    gmiMetrics: asText(parked.gmi_metrics) || "{}",
    analysis: JSON.stringify(synthesis),
    model: env.AI_MODEL_REASONER
  });
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const confidence = num(decision.confidence);
  const reasoning = asText(decision.reasoning) || asText(reasonerText);
  const action = asText(decision.decision) || "WAIT";
  await upsertTradeDecision(env, {
    candleKey, decision: action, confidence,
    entry: num(decision.entry_price), stop: num(decision.stop_loss), target: num(decision.take_profit),
    riskReward: num(decision.risk_reward), size: num(decision.position_size_pct), reasoning
  });
  await env.SIGNAL_CACHE.put("latest:" + safeKeyPart(ticker) + ":" + safeKeyPart(timeframe), JSON.stringify(synthesis), { expirationTtl: 60 * 60 * 24 * 7 });
  try {
    // Owner decision 2026-11-08: only a BUY/SELL or a changed decision is sent (src/h1-telegram.mjs).
    await notifyH1Decision(env, { candleKey, action, send: (text: string) => sendTelegram(env, text), text: [
      "XAUUSD AI DECISION SUPPORT",
      "Symbol: " + ticker,
      "Timeframe: " + timeframe,
      "Candle: " + candleKey,
      "Decision: " + action,
      "Confidence: " + (confidence === null ? "not provided" : Math.round(confidence * 100) + "%"),
      "Reason: " + reasoning.slice(0, 900),
      "Note: advisory only; no trade was executed."
    ].join("\n") });
  } catch (error) {
    console.error("telegram_delivery_failed", JSON.stringify({ candle_key: candleKey, message: error instanceof Error ? error.message : "Unknown notification error" }));
  }
  await env.WEBHOOK_BUFFER.put("analysis:" + safeKeyPart(candleKey), JSON.stringify({
    status: "complete", created_at: timestamp, sources: parked.sources ?? [], decision: synthesis,
    missing_evidence: fusion.missing_evidence ?? [], validation_errors: fusion.validation_errors ?? []
  }), { expirationTtl: 60 * 60 * 24 * 14 });
  await setAnalysisRunStatus(env, candleKey, "complete", {
    input_fingerprint: parked.input_fingerprint,
    chain: H1_CHAIN,
    consensus: synthesis.consensus,
    missing_evidence: fusion.missing_evidence ?? [],
    validation_errors: fusion.validation_errors ?? [],
    decision: synthesis.decision,
    evidence_fusion: fusionDetails(fusion)
  }, null);
  await enqueueHudAgents(env, candleKey);
  return { status: "complete", decision: action, consensus: consensus.status, guard_overridden: overridden };
}

/** The Reasoner's H1 decision of one bar, for the 1H tab: decided, awaiting the room, or not started. */
async function reasonerDecisionOf(env: Env, candleKey: string): Promise<JsonObject> {
  try {
    const run = await env.DB.prepare("SELECT status, error_code FROM analysis_runs WHERE candle_key = ?").bind(candleKey).first<{ status: string; error_code: string | null }>();
    if (!run) return { status: "not_started" };
    if (run.status === "analyzing") return { status: run.error_code === "finalizing" ? "deciding" : "awaiting_consensus", fallback_minutes: H1_CONSENSUS_FALLBACK_MS / 60_000 };
    const row = await env.DB.prepare("SELECT ai_analysis FROM ai_syntheses WHERE candle_key = ? ORDER BY id DESC LIMIT 1").bind(candleKey).first<{ ai_analysis: string }>();
    const synth = row ? JSON.parse(row.ai_analysis || "{}") : {};
    const d = synth.decision || {};
    return {
      status: run.status === "complete" ? "decided" : run.status, chain: synth.analysis_chain ?? null,
      decision: asText(d.decision) || null, confidence: typeof d.confidence === "number" ? d.confidence : null,
      reasoning: asText(d.reasoning) || null, consensus: synth.consensus ?? null, decided_at: synth.timestamp ?? null
    };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * The sweep's side of the 45-minute fallback: every H1 bar still awaiting its decision is
 * finalized once its room concluded or 45 minutes passed since the close.
 */
async function finalizePendingH1Decisions(env: Env, now = Date.now()): Promise<JsonObject> {
  const since = new Date(now - H1_PENDING_LOOKBACK_MS).toISOString().replace("T", " ").slice(0, 19);
  const rows = ((await env.DB.prepare(
    "SELECT candle_key FROM analysis_runs WHERE status = 'analyzing' AND (error_code = 'awaiting_consensus' OR (error_code = 'finalizing' AND updated_at < datetime('now', '-10 minutes'))) AND updated_at >= ? ORDER BY candle_key LIMIT 6"
  ).bind(since).all<{ candle_key: string }>()).results) || [];
  const out: JsonObject = {};
  for (const row of rows) {
    try { out[row.candle_key] = await finalizeH1Decision(env, row.candle_key, { now }); }
    catch (error) { out[row.candle_key] = { status: "error", message: error instanceof Error ? error.message.slice(0, 200) : String(error) }; }
  }
  return { pending: rows.length, results: out };
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
    // Keep why (no part of either secret) so a 401 in TradingView's log can be explained.
    await recordRejection(env.DB, classifyRejection({ headerSecret, bodySecret, expected: env.WEBHOOK_SECRET }), {
      source: asText(body.source), timeframe: asText(body.timeframe), candleTime: asText(body.candle_time || body.timestamp),
      contentType: request.headers.get("content-type"), userAgent: request.headers.get("user-agent"),
      receivedSecret: bodySecret || headerSecret, expectedSecret: env.WEBHOOK_SECRET
    });
    return json({ error: "Unauthorized" }, 401);
  }

  const source = normalizeSource(body.source);
  if (!source) {
    return json({
      error: "Unsupported source",
      accepted_sources: ["prophet_r38", "prophet_r37_ssot", "gmi_v12_70", "prophet_r38_hud", "gmi_v12_70_hud"]
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
  // Only analysis timeframes (H1 in production) start the AI chain. Other timeframes,
  // such as 5m or 15m parity comparators, are stored for parity and nothing else.
  // HUD comparator sources (*_hud) are parity evidence only: they never start the AI chain.
  const storedOnlyReason = isHudSource(source)
    ? "hud_comparator_source"
    : !analysisAllowedForTimeframe(timeframe, env.ANALYSIS_TIMEFRAMES || "60") ? "timeframe_not_analysed" : null;
  if (storedOnlyReason) {
    return json({
      status: "accepted", candle_key: candleKey, source,
      analysis_status: "stored_only", queued: false, reason: storedOnlyReason,
      normalized_non_finite_tokens: normalizedTokens
    }, 202);
  }
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
  // HUD parity identities (gmi_hud) are accepted for parity only; the decision lane reads LOCAL_ENGINES.
  if (!key || !INGEST_ENGINES.includes(engine)) {
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
      return aiRun(env, env.AI_MODEL_ANALYST, {
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
      maxTokens: MAX_TOKENS.analyst,
      effort: "low"
    });
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
      return aiRun(env, env.AI_MODEL_COUNSELOR, {
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
      maxTokens: MAX_TOKENS.counselor,
      effort: "low"
    });
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
      return aiRun(env, env.AI_MODEL_REASONER, {
      messages: chatMessages([
        "You are the final Deep Reasoner stage for XAUUSD decision support.",
        "Use only the supplied evidence, analyst output, and counselor output. Do not invent market prices or claim the models verified facts they did not receive.",
        "Decode every numeric field with POLICY.field_dictionary (derived from the Pine sources) before reasoning, and quote the decoded meaning. Apply POLICY.decision_policy. Never infer a field meaning that is not in the dictionary.",
        "Prophet remains the base bias. GMI may validate, block, or wait on a setup. Do not silently reverse Prophet's bias.",
        "If news_evidence.available is false, state fundamental news analysis was not performed. Do NOT claim news supported or contradicted the setup.",
        "If news_evidence.available is true, incorporate the supplied articles into final reasoning.",
        "Return ONLY a JSON object with keys: decision (BUY, SELL, WAIT, or NO_TRADE), confidence (number 0-1 or null), entry_price, stop_loss, take_profit, risk_reward, position_size_pct, reasoning, confirmation, invalidation, trade_plan.", DECISION_TEXT_RULE, TRADE_PLAN_RULE,
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
      maxTokens: MAX_TOKENS.reasoner,
      effort: "medium"
    });
    });
    reasonerText = extractText(reasonerResult);
    decision = await plainDecision(env, parseDecision(reasonerText));
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
    // Owner decision 2026-11-08: only a BUY/SELL or a changed decision is sent (src/h1-telegram.mjs).
    notified = (await notifyH1Decision(env, { candleKey, action: asText(decision.decision) || "WAIT", text: message, send: (text: string) => sendTelegram(env, text) })).sent;
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
  // Parity runs on every timeframe; only analysis timeframes (H1 in production) start the AI chain.
  if (!analysisAllowedForTimeframe(task.timeframe, env.ANALYSIS_TIMEFRAMES || "60")) return;
  // Local-primary: a webhook only calibrates the local engines and never starts the chain.
  if (indicatorSourceMode(env) === "local") return;
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
  // Parity runs on every timeframe; only analysis timeframes (H1 in production) start the AI chain.
  if (!analysisAllowedForTimeframe(task.timeframe, env.ANALYSIS_TIMEFRAMES || "60")) return;
  const required = (env.REQUIRED_SOURCES || "prophet_r38,prophet_r37_ssot,gmi_v12_70").split(",").map(value => value.trim()).filter(Boolean);
  const localRecords = await decisionLocalRecords(env, task.candle_key);
  if (localRecords.length < LOCAL_ENGINES.length) {
    // Local-primary: these records are the trigger. Right after publication the other
    // engines' records may not be visible here yet (KV across locations), so retry for a
    // few minutes instead of waiting for the 15-minute sweep; the sweep stays the backstop.
    const enqueuedMs = Date.parse(asText(task.enqueued_at));
    if (indicatorSourceMode(env) === "local" && Number.isFinite(enqueuedMs) && Date.now() - enqueuedMs < LOCAL_TRIGGER_RETRY_MS) {
      throw Object.assign(new Error("local records not all visible yet"), { name: "RetryableError" });
    }
    return;
  }
  const payloads = await loadWebhookPayloadsFromD1(env, task.candle_key, required);
  // Local-primary: the local records are enough; webhooks are calibration only.
  if (indicatorSourceMode(env) !== "local" && !required.every(source => payloads[source])) return;
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
      // The Live War Room 15m replaces the legacy live room when WAR_ROOM_ENABLED is on.
      const result = warRoomEnabled(env) ? await runWarRoomBar(env, task) : await runLiveRoomBar(env, task);
      console.log(warRoomEnabled(env) ? "war_room" : "live_room", JSON.stringify({ bar_time: task.bar_time, ...result }));
      // Quorum (production 2026-11-06): redeliver after a model minute; the ok openings are kept.
      if (result?.status === "waiting_for_quorum") throw Object.assign(new Error("war room waiting for quorum"), { name: "WarRoomQuorumPending", retryDelaySeconds: 60 });
      // Decision Engine (owner decisions 2026-11-09): the single decision, as soon as the 15m room has concluded.
      if (result?.status === "complete" || result?.status === "already_complete") await decideBar(env, String(task.bar_time));
      return;
    }
    if (task.kind === "hud_agents") {
      const result = await runHudAgents(env, task, {
        loadReadings: async (e, key) => {
          const snapshot = await loadHudSnapshot(e, { timeframe: "60", candleKey: key });
          return snapshot ? hudReadings(e, snapshot) : null;
        }
      });
      console.log("hud_agents", JSON.stringify({ candle_key: task.candle_key, ...result }));
      return;
    }
    if (task.kind === "h1_room") return processH1RoomTask(env, task);
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
/**
 * Owner decision 2026-11-08 ("the confirmation is critical"): the strategy engine is evaluated at every
 * closed 5m bar, with that bar's verified Prophet confirmation and close, not only when the 15m room
 * meets. Deterministic, no model call. A TRIGGERED setup goes to the Signal Ledger at once (the ledger
 * keeps one per hour and none while one of the same side is open) and its alert to Telegram.
 */
/**
 * The Decision Engine for one 15m bar (src/decision-engine.mjs): the AI council within guardrails,
 * stored once per bar; its message to Telegram and a BUY or SELL to the Signal Ledger. Never throws.
 */
async function decideBar(env: Env, barClose: string | null, now = Date.now()): Promise<void> {
  const deps = {
    send: (text: string) => sendTelegram(env, text),
    recordSignal: async (d: unknown) => { await ensureLedgerSchema(env.DB); return ingestDecision(env, d); }
  };
  try {
    const result = barClose ? await runDecisionEngine(env, { barClose, now, ...deps }) : await runPendingDecision(env, { now, ...deps });
    if (result.status !== "disabled" && result.status !== "already_decided" && result.status !== "too_soon" && result.status !== "market_closed") console.log("decision_engine", JSON.stringify(result));
  } catch (error) {
    console.error("decision_engine_failed", error instanceof Error ? error.message : String(error));
  }
}

async function evaluateStrategyAtM5Close(env: Env, context: Record<string, unknown>): Promise<void> {
  // While the Decision Engine is on, it is the only decision: the strategy engine is one of its witnesses.
  if (decisionEngineEnabled(env)) return;
  try {
    const now = Date.now();
    const strategy = await readStrategy(env, { now, m5Context: context });
    if (strategy?.decision !== "BUY" && strategy?.decision !== "SELL") return;
    await ensureLedgerSchema(env.DB);
    const added = await ingestStrategy(env, strategy, { now });
    let alerts: unknown = null;
    if (added) alerts = await sendLedgerAlerts(env, { send: (text: string) => sendTelegram(env, text) });
    console.log("strategy_m5", JSON.stringify({ candle_time: context.candle_time, decision: strategy.decision, state: strategy.state, recorded: added, alerts }));
  } catch (error) {
    console.error("strategy_m5_failed", error instanceof Error ? error.message : String(error));
  }
}

async function ingestM5Context(env: Env, payload: unknown, waitUntil?: (p: Promise<unknown>) => void): Promise<{ status: number; body: JsonObject }> {
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
  // Owner decision 2026-11-08: the 5m trigger is checked at every closed 5m bar, beside the reply.
  const evaluation = evaluateStrategyAtM5Close(env, stored);
  if (waitUntil) waitUntil(evaluation); else await evaluation;
  // The live room meets at each 15m candle close; every 5m context still refreshes the KV
  // execution context above.
  if ((liveRoomEnabled(env) || warRoomEnabled(env)) && isFifteenMinuteClose(p.candle_time)) {
    // Phase C6: the 15m HUD snapshot is read here, where it was just written, and carried
    // in the task (the consumer may run where the KV write has not propagated yet).
    let hud: unknown = null;
    if (hudAgentsEnabled(env) || warRoomEnabled(env)) {
      try { hud = await loadHudSnapshot(env, { timeframe: "15", candleKey: m15KeyForClose(String(p.candle_time)) }); } catch { hud = null; }
    }
    try {
      await sendQueueTask(env.XAUUSD_EVENTS, buildLiveRoomTask({ barTime: String(p.candle_time), context: stored, hud: hud as Record<string, unknown> | null }) as unknown as QueueTask);
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
    return ingestM5Context(this.env, record, (p) => this.ctx.waitUntil(p));
  }
  /** Phase C2: HUD snapshot of a closed H1 or 15m bar (HUD agents only, never decision evidence). */
  async submitHud(snapshot: unknown): Promise<{ status: number; body: JsonObject }> {
    return storeHudSnapshot(this.env, snapshot) as Promise<{ status: number; body: JsonObject }>;
  }
}

/**
 * Omega Execution Engine (omega.cryptophys.work, workers/xauusd-omega): the only caller, over its
 * Service Binding. Reads the EA overview and sets the EA control (active, paused, killed). Omega
 * verifies the Access JWT and passes the person's identity as the actor; the change is audited.
 */
export class OmegaGateway extends WorkerEntrypoint<Env> {
  async overview(): Promise<JsonObject> {
    return omegaOverview(this.env) as Promise<JsonObject>;
  }
  async deals(options: { limit?: number } = {}): Promise<JsonObject> {
    return { deals: await listDeals(this.env, { limit: options?.limit ?? 200 }) } as JsonObject;
  }
  async setControl(input: { mode?: string; reason?: string; actor?: string }): Promise<JsonObject> {
    return setControl(this.env, input ?? {}) as Promise<JsonObject>;
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
    let calibration: JsonObject = {};
    try {
      await ensureSchema(env.DB);
      const row = await env.DB.prepare("SELECT MAX(compared_at) AS last FROM engine_parity_comparisons").first<{ last: string | null }>();
      lastComparison = row?.last ?? null;
      const recent = await env.DB.prepare("SELECT engine, candle_key, result, compared_at FROM engine_parity_comparisons ORDER BY compared_at DESC LIMIT 5").all<JsonObject>();
      recentComparisons = recent.results || [];
      const entries = await env.DB.prepare("SELECT engine, status, consecutive_matches, last_candle_key, last_result, updated_at FROM engine_parity_registry ORDER BY updated_at DESC LIMIT 10").all<JsonObject>();
      registry = entries.results || [];
      const perEngine = await env.DB.prepare(
        "SELECT r.engine, r.status, r.consecutive_matches, (SELECT MAX(c.compared_at) FROM engine_parity_comparisons c WHERE c.engine = r.engine AND c.source_hash = r.source_hash AND c.implementation_hash = r.implementation_hash) AS last_compared_at FROM engine_parity_registry r WHERE r.status = 'approved' AND r.engine IN ('prophet', 'gmi', 'prophet_m5', 'gmi_m5')"
      ).all<JsonObject>();
      calibration = calibrationStatus(perEngine.results || [], Date.now(), Number(env.CALIBRATION_INTERVAL_DAYS) || 30);
    } catch { /* registry unavailable */ }
    // Local-primary: the lane is fresh while approved local records exist for a recent closed H1 candle.
    let localRecordFresh = false;
    try {
      const recent = closedH1CandleKeys(Date.now(), { lookback: 2 });
      localRecordFresh = (await Promise.all(recent.map(key => env.WEBHOOK_BUFFER.get("localcalc:" + key + ":prophet")))).some(Boolean);
    } catch { localRecordFresh = false; }
    const lastMs = lastComparison ? Date.parse(lastComparison) : NaN;
    // The TradingView alert lane: the last accepted alert and the last hour's 401s (never the secret).
    const webhook = await webhookLaneStatus(env.DB).catch(() => null);
    return dashboardJson({
      ai_worker: {
        status: "ok",
        webhook,
        ingest_url: asText(env.INGEST_URL),
        ingest_secret: Boolean(env.INGEST_SECRET),
        webhook_secret: Boolean(env.WEBHOOK_SECRET),
        // Analyst and Counselor serve the news analysis only; the H1 decision is the Reasoner's,
        // after the 1H War Room's Consensus Discussion (owner decision 2026-11-07).
        models: { analyst: env.AI_MODEL_ANALYST, counselor: env.AI_MODEL_COUNSELOR, reasoner: env.AI_MODEL_REASONER },
        h1_chain: H1_CHAIN,
        // local_computation arrives over the LocalComputationIngress RPC entrypoint;
        // "fresh" means a local-vs-webhook parity comparison ran in the last 2 hours.
        // A scheduled sweep (cron 10-59/15) re-reconciles the last closed H1 candles
        // so a candle is not lost when the per-event tasks run before KV settles.
        local_lane: {
          rpc_entrypoint: "LocalComputationIngress",
          indicator_source: indicatorSourceMode(env),
          last_parity_comparison_at: lastComparison,
          // Local-primary: fresh = approved local records for a recent H1 candle. Legacy webhook
          // mode keeps the old meaning (a parity comparison in the last 2 hours).
          fresh: indicatorSourceMode(env) === "local" ? localRecordFresh : Number.isFinite(lastMs) && Date.now() - lastMs < LOCAL_LANE_FRESH_MS,
          calibration,
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
  // Exact routes under a prefix route are excluded here, or the prefix route would answer them
  // as an id (production 2026-11-06: /api/news/daily and /api/threads/timeframe read as ids).
  if (url.pathname.startsWith("/api/news/") && url.pathname !== "/api/news/daily") {
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
    const row = await env.DB.prepare("SELECT candle_key, timestamp, ai_analysis, prophet_metrics, gmi_metrics FROM ai_syntheses WHERE candle_key = ? ORDER BY timestamp DESC LIMIT 1").bind(key).first<JsonObject>();
    if (!row) return dashboardJson({ status: "not_found" }, 404);
    return dashboardJson({ status: "ok", candle_key: row.candle_key, timestamp: row.timestamp, synthesis: parseJsonText(row.ai_analysis, null), tradingview_reading: interpretWebhookRow(row) });
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
  if (url.pathname.startsWith("/api/threads/") && url.pathname !== "/api/threads/timeframe") {
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
  if (url.pathname === "/api/war-room/latest") {
    try {
      const bar = url.searchParams.get("bar");
      const room = await readWarRoom(env.DB, { barTime: bar && Number.isFinite(Date.parse(bar)) ? bar : null });
      if (!room) return dashboardJson({ status: "not_found", enabled: warRoomEnabled(env) }, 404);
      return dashboardJson({ status: "ok", enabled: warRoomEnabled(env), room });
    } catch (error) {
      console.error("war_room_read_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/health/alerts") {
    // The Nexus Priority Queue: open health alerts and those resolved in the last 24 hours.
    try {
      return dashboardJson({ status: "ok", ...(await readHealthAlerts(env.DB)) });
    } catch (error) {
      console.error("health_alerts_read_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/news/daily") {
    // The News tab: the last 24 hours of news, each headline with its gold bias, and the TLDR.
    try {
      const daily = await readNewsDaily(env.DB);
      if (!daily) return dashboardJson({ status: "not_found", enabled: newsDailyEnabled(env) }, 404);
      return dashboardJson({ status: "ok", enabled: newsDailyEnabled(env), daily });
    } catch (error) {
      console.error("news_daily_read_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/tldr") {
    try {
      return dashboardJson({ status: "ok", ...(await readTldr(env.DB)) });
    } catch (error) {
      console.error("tldr_read_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/live") {
    try {
      const items = await readLive(env.DB, { since: Number(url.searchParams.get("since") || "0"), limit: Number(url.searchParams.get("limit") || "50") });
      const m5Verified = await m5ParityApproved(env.DB);
      return dashboardJson({ status: "ok", enabled: liveRoomEnabled(env), cadence: "15m", label: m5Verified ? M5_VERIFIED_LABEL : M5_UNVERIFIED_LABEL, m5_verified: m5Verified, items });
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
  // Exact routes before the /api/hud/:candle_key prefix (the #110 lesson): levels and regime of
  // the latest HUD snapshot of one timeframe, for the Nexus level ladder and regime radar.
  if (url.pathname === "/api/hud/levels") {
    const timeframe = url.searchParams.get("tf") || "60";
    if (!LEVEL_TIMEFRAMES.includes(timeframe)) return dashboardJson({ status: "error", error: "tf must be 15, 60, 240 or 1D" }, 400);
    try {
      const snapshot = await loadHudSnapshot(env, { timeframe });
      if (!snapshot) return dashboardJson({ status: "not_found", timeframe }, 404);
      const verified = (await approvedComparable(env, snapshot.candle_key)) ? await barsVerified(env, snapshot.candle_key) : false;
      return dashboardJson({ status: "ok", levels: hudLevels(snapshot, { barsVerified: verified }) });
    } catch (error) {
      console.error("hud_levels_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/key-levels") {
    // Key Level Agent (owner decision 2026-11-06): the zones where the key levels of every chart stack.
    try {
      return dashboardJson({ status: "ok", key_levels: (await readStrategy(env)).key_levels });
    } catch (error) {
      console.error("key_levels_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/strategy") {
    // Strategy engine (owner decision 2026-11-06): the decision from the consensus of all agents
    // across D1 to 5m, with its key levels and reward-to-risk. Advisory only.
    try {
      return dashboardJson({ status: "ok", strategy: await readStrategy(env) });
    } catch (error) {
      console.error("strategy_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/ledger") {
    // Signal Ledger: every directional signal followed to its outcome in R (advisory, never money).
    try {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") || "30") || 30));
      return dashboardJson({ status: "ok", ledger: await readLedger(env, { days }) });
    } catch (error) {
      console.error("ledger_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/parity") {
    // Nexus System status (owner request 2026-11-08): every parity identity, the recent comparisons and the last 24 hours.
    try {
      return dashboardJson({ status: "ok", parity: await readParityView(env.DB) });
    } catch (error) {
      console.error("parity_view_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/macro") {
    // Macro War Room (owner decision 2026-11-08): the latest session, with its bus, discussion and conclusion.
    try {
      return dashboardJson({ status: "ok", macro: await readMacroRoom(env.DB) });
    } catch (error) {
      console.error("macro_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/alerts") {
    // Backlog 11.2: the Telegram alerts of the Signal Ledger (recorded and pending events). Read-only;
    // says whether the bot is configured, never a secret value.
    try {
      const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") || "7") || 7));
      return dashboardJson({ status: "ok", alerts: await readLedgerAlerts(env, { days }) });
    } catch (error) {
      console.error("alerts_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/compliance") {
    // Agent compliance (RFC_AETHER_KNOWLEDGE_GUARDIAN A1): rule breaks per 100 room messages.
    try {
      const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") || "7") || 7));
      return dashboardJson({ status: "ok", compliance: await readCompliance(env, { days }) });
    } catch (error) {
      console.error("compliance_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/aether/status") {
    // Aether A5: the push ledger of decision cards sent to cryptophys-aether (no card content).
    try {
      return dashboardJson({ status: "ok", aether: { ...(await aetherPushStatus(env)), learned_pack: await packStatus(env), sync: await aetherSyncStatus(env) } });
    } catch (error) {
      console.error("aether_status_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/decision-cards") {
    // Decision cards for Aether (RFC_AETHER_KNOWLEDGE_GUARDIAN §6.1): no levels, prices or sizes.
    try {
      const chart = url.searchParams.get("chart") || "60";
      return dashboardJson({ status: "ok", cards: await loadDecisionCards(env, { chart, limit: Number(url.searchParams.get("limit") || "6") || 6 }) });
    } catch (error) {
      console.error("decision_cards_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/engine/decision") {
    // The Decision Engine's latest decision (owner decisions 2026-11-09: the single SSOT).
    try {
      return dashboardJson({ status: "ok", enabled: decisionEngineEnabled(env), decision: await readLatestDecision(env) });
    } catch (error) {
      console.error("engine_decision_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/engine/decisions") {
    try {
      return dashboardJson({ status: "ok", enabled: decisionEngineEnabled(env), decisions: await readDecisions(env, { limit: Number(url.searchParams.get("limit") || "24") || 24 }) });
    } catch (error) {
      console.error("engine_decisions_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/conclusion/global") {
    try {
      // The Decision Engine's decision travels with the witnesses (the rooms, news, macro, strategy).
      const [global, engine] = await Promise.all([readGlobalConclusion(env), decisionEngineEnabled(env) ? readLatestDecision(env) : Promise.resolve(null)]);
      return dashboardJson({ status: "ok", global, engine });
    } catch (error) {
      console.error("global_conclusion_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/hud/latest" || url.pathname.startsWith("/api/hud/")) {
    try {
      const askedTf = url.searchParams.get("tf") || "60";
      const timeframe = LEVEL_TIMEFRAMES.includes(askedTf) ? askedTf : "60";
      const tail = decodeURIComponent(url.pathname.slice("/api/hud/".length));
      const candleKey = tail === "latest" ? null : tail;
      const snapshot = await loadHudSnapshot(env, { timeframe: candleKey ? candleKey.split(":")[2] || timeframe : timeframe, candleKey });
      if (!snapshot) return dashboardJson({ status: "not_found" }, 404);
      return dashboardJson({ status: "ok", hud: await hudReadings(env, snapshot) });
    } catch (error) {
      console.error("hud_read_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/scorecards") {
    try {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") || "30") || 30));
      const subjects = await scorecards(env.DB, { days }) as JsonObject[];
      // P7 (RFC §7): the room agents' track records, by chart, best weight first.
      const agents = (tf: string, nameOf: (id: string) => string) => subjects
        .filter(c => c.timeframe === tf && String(c.subject).startsWith("agent:"))
        .map((c): JsonObject => { const id = String(c.subject).slice(6); return { id, name: nameOf(id), family: familyOf(id), ...reputationOf(c) }; })
        .sort((x, y) => Number(y.weight) - Number(x.weight) || Number(y.decisive) - Number(x.decisive));
      return dashboardJson({
        status: "ok", version: SCORING_VERSION, scoring: SCORING, window_days: days, subjects,
        reputation: { version: REPUTATION_VERSION, prior: REPUTATION_PRIOR, weight_range: WEIGHT_RANGE, rooms: { "15m": agents("15", agentName), "1H": agents("60", tfAgentName) } },
        stuck_states: (await listStuckStates(env.DB, { limit: 20 })).filter(s => s.status === "open")
      });
    } catch (error) {
      console.error("scorecards_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/threads/timeframe") {
    // The 1H, 4H and D1 tabs of the Nexus right panel (15m reads /api/war-room/latest).
    const asked = (url.searchParams.get("chart") || "").toUpperCase();
    const chart = ({ "1H": "H1", "4H": "H4", D: "D1", "1D": "D1" } as Record<string, string>)[asked] ?? asked;
    if (!["H1", "H4", "D1"].includes(chart)) return dashboardJson({ status: "error", error: "chart must be H1, H4 or D1" }, 400);
    try {
      const thread = await readTimeframeThread(env.DB, chart, { env });
      if (!thread) return dashboardJson({ status: "not_found", enabled: tfThreadsEnabled(env), chart }, 404);
      // The 1H tab ends with the Reasoner's H1 decision of that bar (owner decision 2026-11-07).
      if (chart === "H1" && thread.candle_key) thread.reasoner_decision = await reasonerDecisionOf(env, String(thread.candle_key));
      return dashboardJson({ status: "ok", enabled: tfThreadsEnabled(env), thread });
    } catch (error) {
      console.error("tf_thread_read_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/indicator-agents") {
    // P2 (RFC_INDICATOR_AGENT_PLATFORM §9): every indicator agent's manifest with its live state.
    try {
      return dashboardJson({ status: "ok", ...(await indicatorAgents(env)) });
    } catch (error) {
      console.error("indicator_agents_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/shadow-versions") {
    try {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") || "30") || 30));
      return dashboardJson({ status: "ok", ...(await readShadowVersions(env, { days, candidates: await shadowCandidates(env) })) });
    } catch (error) {
      console.error("shadow_versions_read_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/calendar") {
    // Backlog 11.1: the week's economic events (ForexFactory export, cached hourly) and the event-risk gate.
    try { return dashboardJson({ status: "ok", ...(await readCalendar(env)) }); }
    catch (error) {
      console.error("calendar_read_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/correlations") {
    // Backlog 11.3: DXY, US10Y and silver beside gold on the cached 4h series (context only).
    try { return dashboardJson({ status: "ok", ...(await readCorrelations(env)) }); }
    catch (error) {
      console.error("correlations_read_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/ea/signal") {
    // The MT5 Expert Advisor's signal (owner decisions 2026-11-09, src/ea-signal.mjs): one flat object.
    // Behind Cloudflare Access (ai.cryptophys.work/api/*): the EA sends a service token.
    try { return dashboardJson(await eaSignal(env)); }
    catch (error) { console.error("ea_signal_failed", error instanceof Error ? error.message : String(error)); return dashboardJson({ kill: true, side: "NONE", error: "unavailable" }, 500); }
  }
  if (url.pathname === "/api/ea/status") {
    try { return dashboardJson({ status: "ok", ...(await eaStatus(env)) }); }
    catch (error) { console.error("ea_status_failed", error instanceof Error ? error.message : String(error)); return dashboardJson({ status: "error" }, 500); }
  }
  if (url.pathname === "/api/weighting") {
    // The H1 quorum weighting (src/weighting.mjs): the active point, each agent's own weight, the replay
    // of the neighbouring grid points (discovery with Holm, holdout), the reverse shadow and the history.
    try {
      const tf = url.searchParams.get("timeframe") || "60";
      if (!(WEIGHTING_TIMEFRAMES as readonly string[]).includes(tf)) return dashboardJson({ status: "error", error: "timeframe must be one of 15, 60, 240, 1D" }, 400);
      return dashboardJson({ status: "ok", ...(await readWeightingReplay(env, { timeframe: tf })) });
    } catch (error) {
      console.error("weighting_read_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/tuning") {
    // Aether A8 (RFC §9, K7): every TUNING_GRID point, running (discovery test with Holm, holdout),
    // stopped or untested. Read-only, built from the cached 30-day shadow view.
    try {
      const shadow = await readShadowVersions(env, { days: 30, candidates: await shadowCandidates(env) });
      // A8 part 2: the deterministic replay of the reputation parameters (src/tuning-replay.mjs). Non-fatal.
      let crowd: unknown = null;
      try { crowd = await readCrowdReplay(env, { days: 30 }); } catch (error) { console.error("crowd_replay_failed", error instanceof Error ? error.message : String(error)); }
      let strategyInputs: unknown = null, strategy: unknown = null;
      try { strategyInputs = await strategyInputsStatus(env); } catch { strategyInputs = null; }
      try { strategy = await readStrategyReplay(env); } catch (error) { console.error("strategy_replay_failed", error instanceof Error ? error.message : String(error)); }
      let knowledge: unknown = null;
      try { knowledge = await readShadowKnowledge(env); } catch (error) { console.error("shadow_knowledge_read_failed", error instanceof Error ? error.message : String(error)); }
      return dashboardJson({ status: "ok", ...tuningView(shadow, { crowd, strategy, knowledge }), strategy_inputs: strategyInputs });
    } catch (error) {
      console.error("tuning_read_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/platform/status") {
    try {
      return dashboardJson({ status: "ok", ...(await platformStatus(env)) });
    } catch (error) {
      console.error("platform_status_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
    }
  }
  if (url.pathname === "/api/stuck-states") {
    try {
      return dashboardJson({ status: "ok", scoring: SCORING, items: await listStuckStates(env.DB, { limit: limitParam() }) });
    } catch (error) {
      console.error("stuck_states_failed", error instanceof Error ? error.message : String(error));
      return dashboardJson({ status: "error" }, 500);
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
      // The old debate/raw-output page is retired: Nexus (threads + live room) is the only dashboard.
      return Response.redirect(String(env.NEXUS_DASHBOARD_URL || "https://nexus.cryptophys.work/"), 302);
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
    if (request.method === "POST" && url.pathname === "/api/ea/heartbeat") {
      // The EA's state for monitoring (src/ea-signal.mjs); behind Cloudflare Access like every /api/* path.
      let body: unknown;
      try {
        const limited = await readBodyLimited(request, 16384);
        if (limited.tooLarge) return json({ error: "Payload exceeds 16 KiB limit" }, 413);
        body = JSON.parse(limited.text);
      } catch { return json({ error: "Request body must be valid JSON" }, 400); }
      const r = await storeHeartbeat(env, body);
      return json(r, r.ok ? 200 : 400);
    }
    if (request.method === "POST" && url.pathname === "/api/ea/deal") {
      // A position the EA closed (src/ea-execution.mjs, D1 ea_deals, stored once per deal); behind Access.
      let body: unknown;
      try {
        const limited = await readBodyLimited(request, 4096);
        if (limited.tooLarge) return json({ error: "Payload exceeds 4 KiB limit" }, 413);
        body = JSON.parse(limited.text);
      } catch { return json({ error: "Request body must be valid JSON" }, 400); }
      try {
        const r = await storeDeal(env, body);
        return json(r, r.ok ? 200 : 400);
      } catch (error) {
        console.error("ea_deal_store_failed", error instanceof Error ? error.message : String(error));
        return json({ ok: false, error: "store_failed" }, 500);
      }
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
    if (request.method === "POST" && url.pathname === "/preview/hud-snapshot") {
      // Preview-only HTTP twin of the RPC LocalComputationIngress.submitHud, for the
      // preview-e2e proof of the HUD agents. Production never sets PREVIEW_FIXTURES_ENABLED.
      if (String(env.PREVIEW_FIXTURES_ENABLED || "false") !== "true") return json({ error: "Not found" }, 404);
      if (!env.WEBHOOK_SECRET || request.headers.get("x-webhook-secret") !== env.WEBHOOK_SECRET) {
        return json({ error: "Unauthorized" }, 401);
      }
      const limitedBody = await readBodyLimited(request, 65536);
      if (limitedBody.tooLarge) return json({ error: "Payload exceeds 64 KiB limit" }, 413);
      let payload: unknown;
      try { payload = JSON.parse(limitedBody.text); } catch { return json({ error: "Request body must be valid JSON" }, 400); }
      const result = await storeHudSnapshot(env, payload);
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
    if (request.method === "POST" && url.pathname === "/preview/reasoner-probe") {
      // Preview only (PREVIEW_FIXTURES_ENABLED): one call in the H1 Reasoner's request form, so
      // preview-e2e proves the Reasoner model (model migration 2026-11-07) before production.
      if (String(env.PREVIEW_FIXTURES_ENABLED || "false") !== "true") return json({ error: "Not found" }, 404);
      if (!env.WEBHOOK_SECRET || request.headers.get("x-webhook-secret") !== env.WEBHOOK_SECRET) {
        return json({ error: "Unauthorized" }, 401);
      }
      const t0 = Date.now();
      try {
        const { result, variant } = await runModel(env.AI as unknown as { run: (model: string, input: unknown) => Promise<unknown> }, env.AI_MODEL_REASONER, {
          messages: chatMessages([
            "You are the Reasoner of an XAUUSD advisory test. Use only the data below.",
            "The 1H War Room concluded WAIT with a NEUTRAL bias and no confirmed signal.",
            "Return ONLY a JSON object with keys: decision (BUY, SELL, WAIT, or NO_TRADE), confidence (number 0-1 or null), entry_price, stop_loss, take_profit, risk_reward, position_size_pct, reasoning.",
            "Set prices to null without exact price evidence. Never imply automatic execution."
          ]),
          maxTokens: MAX_TOKENS.reasoner,
          effort: "medium"
        });
        const text = extractText(result);
        return json({ status: "ok", model: env.AI_MODEL_REASONER, request_form: variant, latency_ms: Date.now() - t0, decision: parseDecision(text), text: text.slice(0, 600) });
      } catch (error) {
        return json({ status: "error", model: env.AI_MODEL_REASONER, latency_ms: Date.now() - t0, error: error instanceof Error ? error.message.slice(0, 300) : String(error) }, 502);
      }
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
      // Timeframe War Rooms (owner decision 2026-11-06): the D1, 4H and 1H rooms of the bars that
      // just closed, one after another, beside the sweep (a room takes up to about 5.5 minutes).
      // Behind TF_THREADS_ENABLED; idempotent per bar.
      // The H1 decision follows its room (owner decision 2026-11-07): the Reasoner runs as soon as
      // the 1H room concludes, and the sweep finalizes any bar still waiting 45 minutes after its close.
      const onRoom = async ({ chart, key, result }: { chart: string; key: string; result: Record<string, unknown> }) => {
        if (chart !== "H1" || (result?.status !== "complete" && result?.status !== "already_complete")) return;
        const finalized = await finalizeH1Decision(env, key);
        if (finalized.status !== "not_pending") console.log("h1_consensus_decision", JSON.stringify({ candle_key: key, ...finalized }));
      };
      ctx.waitUntil(runPendingTimeframeThreads(env, { onRoom }).then(tf => {
        if (tf.status !== "disabled") console.log("tf_threads", JSON.stringify(tf));
      }).catch(e => console.error("tf_threads_failed", e instanceof Error ? e.message : String(e))));
      // Decision Engine fallback: a 15m bar whose room did not trigger the engine is decided by the sweep.
      ctx.waitUntil(decideBar(env, null));
      ctx.waitUntil(finalizePendingH1Decisions(env).then(r => {
        if (Number(r.pending)) console.log("h1_consensus_pending", JSON.stringify(r));
      }).catch(e => console.error("h1_consensus_pending_failed", e instanceof Error ? e.message : String(e))));
      // Macro War Room (owner decision 2026-11-08): 20 minutes after a 4-hour close and 30 minutes
      // after a High-impact USD event; at most one session per sweep, in its own waitUntil.
      ctx.waitUntil(runPendingMacroRooms(env).then(m => {
        if (m.status !== "disabled" && m.status !== "idle") console.log("macro_room", JSON.stringify(m));
      }).catch(e => console.error("macro_room_failed", e instanceof Error ? e.message : String(e))));
      ctx.waitUntil(reconcileRecentCandles(env).then(async result => {
        try { await backfillRecentAnalyses(env, { loadPayloads: loadWebhookPayloadsFromD1, runAnalysis, setStatus: setAnalysisRunStatus }); } catch (e) { console.error("backfill_failed", e instanceof Error ? e.message : String(e)); }
        // RFC_INDICATOR_AGENT_PLATFORM P1: score statements whose horizon has closed, and
        // detect stuck states once an hour (the first sweep after the hour). Never touches
        // a decision; failures are logged and retried by the next sweep.
        try {
          const scored = await scoreRecentStatements(env);
          if (new Date(event.scheduledTime || Date.now()).getUTCMinutes() < 25) await detectRecentStuckStates(env);
          console.log("outcome_scoring", JSON.stringify(scored));
        } catch (e) { console.error("outcome_scoring_failed", e instanceof Error ? e.message : String(e)); }
        // RFC_INDICATOR_AGENT_PLATFORM P3: shadow versions, once an hour (first sweep after the
        // H1 close). Computed and scored only; never shown in a room or used by a decision.
        if (new Date(event.scheduledTime || Date.now()).getUTCMinutes() < 25) {
          // Aether A7: pull the learned pack first; approved parameter candidates in TUNING_GRID run
          // as extra shadow versions (scored only, never in a room). Non-fatal.
          try {
            const pulled = await pullLearnedPack(env);
            if (pulled.status !== "disabled" && (pulled.status !== "ok" || pulled.changed)) console.log("aether_pack", JSON.stringify(pulled));
          } catch (e) { console.error("aether_pack_failed", e instanceof Error ? e.message : String(e)); }
          try { console.log("shadow_versions", JSON.stringify(await runShadowVersions(env, { candidates: await shadowCandidates(env) }))); }
          catch (e) { console.error("shadow_versions_failed", e instanceof Error ? e.message : String(e)); }
          // Auto-tuning per timeframe (owner decisions 2026-11-09: no operator; each timeframe independent):
          // replay each room's quorum under the grid points next to its active weighting, activate the best
          // point the replay rates better on discovery and holdout, roll back one the reverse shadow finds
          // worse, tell the owner on Telegram, and report to Aether (audit). The 15m and 1H rooms every
          // hour, the 4H room every four hours, the daily room once a day.
          const hourNow = new Date(event.scheduledTime || Date.now()).getUTCHours();
          for (const timeframe of ["15", "60", ...(hourNow % 4 === 2 ? ["240"] : []), ...(hourNow === 23 ? ["1D"] : [])]) {
            try {
              let replay = await readWeightingReplay(env, { timeframe, useCache: false });
              const applied = await applyWeighting(env, { timeframe, replay });
              if (applied.status !== "unchanged") console.log("weighting", JSON.stringify(applied));
              const line = weightingMessage(applied);
              if (line) {
                try { await sendTelegram(env, line); } catch (e) { console.error("weighting_telegram_failed", e instanceof Error ? e.message : String(e)); }
                replay = await readWeightingReplay(env, { timeframe, useCache: false });
              }
              const pushed = await pushWeightingReport(env, replay);
              if (pushed.status !== "disabled" && pushed.status !== "unchanged") console.log("weighting_report", JSON.stringify({ timeframe, ...pushed }));
            } catch (e) { console.error("weighting_failed", JSON.stringify({ timeframe, message: e instanceof Error ? e.message : String(e) })); }
          }
        }
        // Signal Ledger (owner request 2026-11-07): new H1 decisions and strategy setups, each
        // followed to its outcome in R on the closed bars. Never feeds a room or a decision.
        try {
          // While the Decision Engine is on, only its decisions are new signals (src/decision-engine.mjs).
          const engineOn = decisionEngineEnabled(env);
          const ledger = await runSignalLedger(env, { readStrategy: engineOn ? null : readStrategy, h1Decisions: !engineOn });
          if (ledger.status === "ok" && (Number((ledger.added as Record<string, number>).h1_decision) || Number((ledger.added as Record<string, number>).strategy) || Number(ledger.changed))) console.log("signal_ledger", JSON.stringify(ledger));
          // Backlog 11.2 (owner decision 2026-11-08): each new ledger event to the owner's Telegram, once.
          const alerts = await sendLedgerAlerts(env, { send: (text: string) => sendTelegram(env, text) });
          if (alerts.status !== "disabled" && (Number(alerts.sent) || Number(alerts.seeded) || Number(alerts.failed))) console.log("ledger_alerts", JSON.stringify(alerts));
        } catch (e) { console.error("signal_ledger_failed", e instanceof Error ? e.message : String(e)); }
        // Aether A8 (owner go 2026-11-08): the strategy engine's inputs once per closed H1 bar (from 40
        // minutes after the close), and the outcomes of earlier captures, for the threshold replay.
        // D1 only; never feeds a room or a decision. Non-fatal.
        try {
          const captured = await captureStrategyInputs(env, { load: loadStrategyInputs, build: buildStrategy });
          const scoredInputs = await scoreStrategyCaptures(env);
          // A8 part 4: each threshold arm's decision on the stored hours, computed once (a few hours per sweep).
          const replayed = await replayStrategyCaptures(env);
          // Backlog 11.1: the economic calendar, refreshed at most once an hour (non-fatal).
          const calendar = await refreshCalendar(env);
          if (calendar.status !== "fresh") console.log("econ_calendar", JSON.stringify(calendar));
          // Aether A7: score the shadow note answers and their controls; drop those older than 60 days.
          const shadowScored = await scoreShadowKnowledge(env);
          if (Number(shadowScored.scored)) console.log("shadow_knowledge_scored", JSON.stringify(shadowScored));
          if (new Date(event.scheduledTime || Date.now()).getUTCMinutes() < 25) await pruneShadowKnowledge(env);
          if (captured.status === "captured" || Number(scoredInputs.scored) || Number(replayed.hours) || Number(replayed.failed)) console.log("strategy_inputs", JSON.stringify({ captured, scored: scoredInputs, replayed }));
        } catch (e) { console.error("strategy_inputs_failed", e instanceof Error ? e.message : String(e)); }
        // Agent compliance (RFC_AETHER_KNOWLEDGE_GUARDIAN A1): deterministic rule checks of the room
        // messages stored since the last run. Read-only over the rooms; never changes a decision.
        try {
          const compliance = await runComplianceChecks(env);
          if (compliance.status === "ok" && Number(compliance.violations)) console.log("compliance_checks", JSON.stringify(compliance));
        } catch (e) { console.error("compliance_checks_failed", e instanceof Error ? e.message : String(e)); }
        // Aether A5: push the decision cards whose content changed to cryptophys-aether, once an
        // hour (first sweep after the H1 close). Never waits on Aether; a no-op without the binding.
        if (new Date(event.scheduledTime || Date.now()).getUTCMinutes() < 25) {
          try {
            const pushed = await pushDecisionCards(env);
            if (pushed.status !== "disabled" && (pushed.status !== "ok" || Number(pushed.pushed))) console.log("aether_push", JSON.stringify(pushed));
          } catch (e) { console.error("aether_push_failed", e instanceof Error ? e.message : String(e)); }
        }
        // Health alerts (gap 2, owner decision 2026-11-06): detect operational problems, keep
        // them as open alerts for the Nexus Priority Queue and report state changes to the
        // platform kernel (warning / info, never critical). Non-fatal by design.
        try {
          const health = await runHealthAlerts(env);
          if (health.opened || health.resolved || (Array.isArray(health.published) && health.published.length)) console.log("health_alerts", JSON.stringify(health));
        } catch (e) { console.error("health_alerts_failed", e instanceof Error ? e.message : String(e)); }
        // RFC_INDICATOR_AGENT_PLATFORM P4: advisory reports to the Cryptophys Platform kernel.
        // Non-fatal by design; a no-op without the AGENTS binding (preview, tests).
        try {
          const published = await publishPlatformReports(env);
          if (published.status !== "disabled") console.log("platform_reports", JSON.stringify(published));
        } catch (e) { console.error("platform_reports_failed", e instanceof Error ? e.message : String(e)); }
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
    }).then(async () => {
      // News Daily (owner decision 2026-11-06): the rolling 24-hour analysis, after the hourly
      // batch is stored (it also runs when the hour brought no new article).
      try {
        const daily = await runNewsDaily(env);
        if (daily.status !== "disabled") console.log("news_daily", JSON.stringify(daily));
      } catch (e) { console.error("news_daily_failed", e instanceof Error ? e.message : String(e)); }
    }));
  }
};
