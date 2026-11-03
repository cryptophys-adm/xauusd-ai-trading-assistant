import { buildEvidenceFusion, LOCAL_ENGINES, validateLocalCalculation, WEBHOOK_EVIDENCE_CONTRACT_VERSION, NEWS_ANALYSIS_CONTRACT_VERSION, NEWS_MAX_AGE_MS, containsCredentialFields, stripCredentialFields } from "./evidence-fusion.mjs";
import { filterRecentUniqueArticles } from "./news-filter.mjs";

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
  LOCAL_CALC_PROVENANCE_ALLOWLIST?: string;
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

function safeKeyPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 180);
}

type LocalCalcProvenancePolicy = Record<string, { source_hashes: string[]; implementation_hashes: string[] }>;

function parseLocalCalcProvenanceAllowlist(raw: string | undefined): LocalCalcProvenancePolicy | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const policy: LocalCalcProvenancePolicy = {};
    for (const engine of LOCAL_ENGINES) {
      const entry = parsed[engine] as Record<string, unknown> | undefined;
      const sourceHashes = Array.isArray(entry?.source_hashes) ? entry!.source_hashes.filter((value): value is string => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)).map(value => value.toLowerCase()) : [];
      const implementationHashes = Array.isArray(entry?.implementation_hashes) ? entry!.implementation_hashes.filter((value): value is string => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)).map(value => value.toLowerCase()) : [];
      if (!sourceHashes.length || !implementationHashes.length) return null;
      policy[engine] = { source_hashes: sourceHashes, implementation_hashes: implementationHashes };
    }
    return policy;
  } catch {
    return null;
  }
}

function extractText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as JsonObject;

    // Workers AI models expose text through different response shapes.
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
  if (!env.INGEST_URL || !env.INGEST_SECRET) return { available: false, articles: [], article_count: 0, reason: "INGEST_URL or INGEST_SECRET is not configured on this Worker.", fetched_at: fetchedAt };
  const pullUrl = env.INGEST_URL.replace(/\/+$/, "") + "/pull";
  try {
    const response = await fetch(pullUrl, { method: "POST", headers: { "Authorization": "Bearer " + env.INGEST_SECRET, "Accept": "application/json" } });
    if (!response.ok) return { available: false, articles: [], article_count: 0, reason: "Ingestion endpoint returned HTTP " + response.status + " " + response.statusText, fetched_at: fetchedAt };
    const body = await response.json() as Record<string, unknown>;
    let rawArticles: unknown[] | null = null;
    for (const key of ["articles", "data", "results", "items"]) {
      if (Array.isArray(body[key])) { rawArticles = body[key] as unknown[]; break; }
    }
    if (!rawArticles && Array.isArray(body)) rawArticles = body as unknown[];
    if (!rawArticles || rawArticles.length === 0) return { available: false, articles: [], article_count: 0, reason: "Ingestion endpoint returned no articles.", fetched_at: fetchedAt };
    const articles = filterRecentUniqueArticles(rawArticles, Date.now());
    if (articles.length === 0) {
      return { available: false, articles: [], article_count: 0, reason: "No unique articles with a valid publication timestamp from the last hour were available.", fetched_at: fetchedAt };
    }
    return { available: true, articles, article_count: articles.length, fetched_at: fetchedAt };
  } catch (error) {
    return { available: false, articles: [], article_count: 0, reason: "Failed to reach ingestion endpoint: " + (error instanceof Error ? error.message : "Unknown error"), fetched_at: fetchedAt };
  }
}


async function runNewsAnalysis(env: Env): Promise<JsonObject> {
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

  const [knowledgeText] = await Promise.all([env.KNOWLEDGE_BASE.get("knowledge-base:v3")]);
  const evidence = {
    analysis_type: "fundamental_news",
    fetched_at: newsEvidence.fetched_at,
    article_count: newsEvidence.article_count,
    symbols: ["OANDA:XAUUSD", "TVC:USOIL", "TVC:DXY"],
    articles,
    policy: knowledgeText || "No knowledge-base:v3 entry is available; use conservative evidence-based reasoning."
  };

  const analystResult = await env.AI.run(env.AI_MODEL_ANALYST as keyof AiModels, {
    prompt: [
      "You are the Fundamental News Analyst for XAUUSD decision support.",
      "Analyze only the supplied news articles. Do not infer current price action, technical indicators, or unpublished facts.",
      "Assess direct and indirect potential impact on gold (XAUUSD), US dollar (DXY), and oil (USOIL). Distinguish reported facts from interpretation and note publication-time limitations.",
      "Return JSON only with keys: gold_bias (BULLISH, BEARISH, NEUTRAL), dollar_bias (BULLISH, BEARISH, NEUTRAL), oil_bias (BULLISH, BEARISH, NEUTRAL), sentiment (RISK_ON, RISK_OFF, MIXED, UNKNOWN), key_catalysts, key_risks, evidence_quality (LOW, MEDIUM, HIGH), stale_or_uncertain (boolean), reasoning.",
      "Do not produce entry, stop-loss, take-profit, position size, or a technical BUY/SELL order.",
      "NEWS EVIDENCE:", JSON.stringify(evidence)
    ].join("\n"),
    max_tokens: 1000,
    temperature: 0.1
  } as never);
  const analystText = extractText(analystResult);

  const counselorResult = await env.AI.run(env.AI_MODEL_COUNSELOR as keyof AiModels, {
    prompt: [
      "You are the Fundamental News Counselor.",
      "Use only the news evidence and analyst output. Provide balanced conditional scenarios, not trade execution instructions.",
      "Return JSON only with keys: bullish_scenario, bearish_scenario, neutral_scenario, what_would_confirm, what_would_invalidate, watchlist_events, conflicts_or_missing_evidence.",
      "Do not invent prices, technical confirmation, or unsupported causal claims.",
      "NEWS EVIDENCE:", JSON.stringify(evidence),
      "ANALYST:", analystText
    ].join("\n"),
    max_tokens: 1100,
    temperature: 0.1
  } as never);
  const counselorText = extractText(counselorResult);

  const reasonerResult = await env.AI.run(env.AI_MODEL_REASONER as keyof AiModels, {
    prompt: [
      "You are the final Fundamental News Reasoner for XAUUSD decision support.",
      "Synthesize only the supplied article evidence, analyst output, and counselor output. This is a fundamental outlook, not a technical trade signal.",
      "Return JSON only with keys: recommendation (BULLISH_BIAS, BEARISH_BIAS, NEUTRAL, WAIT_FOR_TECHNICAL_CONFIRMATION), confidence (0 to 1 or null), horizon, rationale, supporting_evidence, opposing_evidence, risks, confirmation_needed, invalidation_conditions.",
      "Do not output numeric entry, stop-loss, take-profit, risk/reward, or position size. Do not claim an executable BUY/SELL without technical evidence.",
      "If evidence is mixed, stale, or insufficient, choose WAIT_FOR_TECHNICAL_CONFIRMATION or NEUTRAL and lower confidence.",
      "NEWS EVIDENCE:", JSON.stringify(evidence),
      "ANALYST:", analystText,
      "COUNSELOR:", counselorText
    ].join("\n"),
    max_tokens: 1200,
    temperature: 0.1
  } as never);
  const reasonerText = extractText(reasonerResult);

  let recommendation: JsonObject;
  const match = reasonerText.match(/\{[\s\S]*\}/);
  try {
    recommendation = match ? JSON.parse(match[0]) as JsonObject : {
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
  return result;
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
    await env.DB.prepare(
      "UPDATE analysis_runs SET status = ?, updated_at = datetime('now'), completed_at = CASE WHEN ? = 'complete' THEN datetime('now') ELSE NULL END, error_code = ?, result_json = ? WHERE candle_key = ?"
    ).bind(status, status, errorCode, JSON.stringify(details), candleKey).run();
  } catch (error) {
    console.error("analysis_run_status_update_failed", JSON.stringify({
      candle_key: candleKey,
      status,
      message: error instanceof Error ? error.message : "Unknown status update error"
    }));
  }
}

async function runAnalysis(
  env: Env,
  candleKey: string,
  ticker: string,
  timeframe: string,
  payloads: Record<string, WebhookPayload>
): Promise<{ status: string; missing_evidence: string[] }> {
  const [knowledgeText, newsAnalysis, localCalculationRaw] = await Promise.all([
    env.KNOWLEDGE_BASE.get("knowledge-base:v3"),
    fetchLatestNewsAnalysis(env),
    Promise.all(LOCAL_ENGINES.map(engine => env.WEBHOOK_BUFFER.get("localcalc:" + safeKeyPart(candleKey) + ":" + engine)))
  ]);
  const knowledge = knowledgeText || JSON.stringify({
    status: "kv_key_missing",
    message: "No knowledge-base:v3 value was found in the bound KV namespace. Use the checked-in knowledge-base-v3.json after reviewing it."
  });
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
    candleKey, ticker, timeframe, payloads, localCalculations: fingerprintLocalCalculations,
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

  const fusion = buildEvidenceFusion({
    candleKey,
    symbol: ticker,
    timeframe,
    candleTime,
    webhookPayloads: payloads,
    localCalculations,
    newsAnalysis
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
    evidence_fusion: fusion,
    policy: knowledge,
    news_evidence: newsEvidence
  };

  if (!fusion.complete) {
    const timestamp = new Date().toISOString();
    const reasoning = "Evidence fusion is degraded. Missing evidence: " + (fusion.missing_evidence.join(", ") || "none") + ". Validation errors: " + (fusion.validation_errors.join(", ") || "none") + ". AI analysis was not invoked; no actionable trade setup is issued.";
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
    return { status: "degraded", missing_evidence: fusion.missing_evidence };
  }

  const analystResult = await env.AI.run(env.AI_MODEL_ANALYST as keyof AiModels, {
    prompt: [
      "You are the Analyst stage in an XAUUSD decision-support pipeline.",
      "Classify the supplied indicator evidence without inventing missing values or prices.",
      "Prophet is the base directional bias. GMI can validate, block, or defer a setup but must not silently overwrite Prophet's bias.",
      "Evidence includes the versioned evidence_fusion result, technical source_payloads, all local calculation evidence, and completed fundamental_news_analysis.",
      "Evidence arrives in three separate input lanes (see input_lanes): tradingview_webhook = indicator outputs computed by TradingView (source_payloads); local_computation = outputs computed locally from raw TradingView OHLCV (local_calculation_evidence); fundamental_news = completed news analysis. Never merge, average, or relabel values across lanes. Attribute every technical claim to its lane, and state explicitly where the tradingview_webhook and local_computation lanes agree or disagree.",
      "If evidence_fusion.complete is false, set directional_bias to NEUTRAL and missing_evidence to true; list every missing_evidence and validation_errors item.",
      "If news_evidence.available is false, state that completed fundamental news analysis is unavailable. Do NOT invent news.",
      "If news_evidence.available is true, consider the completed analysis and its underlying article evidence alongside technical evidence.",
      "Return JSON only with keys: directional_bias (BULLISH, BEARISH, or NEUTRAL), setup_quality (integer 0-3), missing_evidence (boolean), reasoning.",
      "Set directional_bias to NEUTRAL and missing_evidence to true if evidence is missing, stale, contradictory, or insufficient.",
      "EVIDENCE:",
      JSON.stringify(evidence)
    ].join("\n"),
    max_tokens: 700,
    temperature: 0.1
  } as never);

  const analystText = extractText(analystResult);
  const counselorResult = await env.AI.run(env.AI_MODEL_COUNSELOR as keyof AiModels, {
    prompt: [
      "You are the Counselor stage in an XAUUSD decision-support pipeline.",
      "Use only the JSON evidence and analyst output below. Do not invent prices or indicator definitions.",
      "Prophet is the base bias. GMI may validate, block, or defer a Prophet setup; it must not silently overwrite Prophet's bias.",
      "Use the complete versioned evidence_fusion bundle as the canonical evidence set, including local_calculation_evidence and fundamental_news_analysis.",
      "Evidence arrives in three separate input lanes (see input_lanes): tradingview_webhook = indicator outputs computed by TradingView (source_payloads); local_computation = outputs computed locally from raw TradingView OHLCV (local_calculation_evidence); fundamental_news = completed news analysis. Never merge, average, or relabel values across lanes. Attribute every technical claim to its lane, and state explicitly where the tradingview_webhook and local_computation lanes agree or disagree.",
      "If evidence_fusion.complete is false, explicitly mark the result degraded and enumerate missing evidence and validation errors.",
      "If news_evidence.available is false, acknowledge completed fundamental news analysis is unavailable. Do NOT fabricate news.",
      "If news_evidence.available is true, weigh the completed news analysis and its underlying article evidence in scenarios.",
      "Return concise JSON with keys: evidence_summary, bullish_scenario, bearish_scenario, neutral_scenario, confirmations, invalidation, risks, missing_data.",
      "If the source payloads conflict or fields are unclear, say so explicitly.",
      "EVIDENCE:",
      JSON.stringify(evidence),
      "ANALYST:",
      analystText
    ].join("\n"),
    max_tokens: 1400,
    temperature: 0.1
  } as never);
  const counselorText = extractText(counselorResult);

  const reasonerResult = await env.AI.run(env.AI_MODEL_REASONER as keyof AiModels, {
    prompt: [
      "You are the final Deep Reasoner stage for XAUUSD decision support.",
      "Use only the supplied evidence, analyst output, and counselor output. Do not invent market prices or claim the models verified facts they did not receive.",
      "Prophet remains the base bias. GMI may validate, block, or wait on a setup. Do not silently reverse Prophet's bias.",
      "Evidence arrives in three separate input lanes (see input_lanes): tradingview_webhook = indicator outputs computed by TradingView (source_payloads); local_computation = outputs computed locally from raw TradingView OHLCV (local_calculation_evidence); fundamental_news = completed news analysis. Never merge, average, or relabel values across lanes. Attribute every technical claim to its lane, and state explicitly where the tradingview_webhook and local_computation lanes agree or disagree.",
      "If evidence_fusion.complete is false, decision MUST be WAIT or NO_TRADE, confidence and all price/risk fields MUST be null, and reasoning must enumerate missing_evidence and validation_errors.",
      "If news_evidence.available is false, state completed fundamental news analysis was unavailable. Do NOT claim news supported or contradicted the setup.",
      "If news_evidence.available is true, incorporate the completed news analysis and its underlying article evidence into final reasoning.",
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
    reasoning: "Evidence fusion is degraded. Missing evidence: " + (fusion.missing_evidence.join(", ") || "none") + ". Validation errors: " + (fusion.validation_errors.join(", ") || "none") + ". No actionable trade setup is issued."
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
  return { status: analysisStatus, missing_evidence: fusion.missing_evidence };
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.WEBHOOK_SECRET) {
    return json({ error: "WEBHOOK_SECRET is not configured" }, 503);
  }

  const limitedBody = await readBodyLimited(request, 65536).catch(() => null);
  if (!limitedBody) return json({ error: "Unable to read request body" }, 400);
  if (limitedBody.tooLarge) return json({ error: "Payload exceeds 64 KiB limit" }, 413);
  let body: WebhookPayload;
  try {
    body = JSON.parse(limitedBody.text) as WebhookPayload;
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

  const required = (env.REQUIRED_SOURCES || "prophet_r38,prophet_r37_ssot,gmi_v12_70")
    .split(",").map(s => s.trim()).filter(Boolean);
  const payloads: Record<string, WebhookPayload> = {};
  for (const requiredSource of required) {
    const raw = await env.WEBHOOK_BUFFER.get("candle:" + candleKey + ":" + requiredSource);
    if (raw) {
      try { payloads[requiredSource] = JSON.parse(raw) as WebhookPayload; } catch { /* malformed cache entry is ignored */ }
    }
  }

  const missing = required.filter(s => !payloads[s]);
  if (missing.length > 0) {
    return json({
      status: "accepted",
      candle_key: candleKey,
      source,
      analysis_status: "waiting_for_sources",
      received_sources: Object.keys(payloads),
      missing_sources: missing
    }, 202);
  }

  const existing = await env.WEBHOOK_BUFFER.get("analysis:" + safeKeyPart(candleKey));
  if (existing) {
    try {
      const prior = JSON.parse(existing) as JsonObject;
      if (prior.status === "complete") {
        return json({ status: "accepted", candle_key: candleKey, analysis_status: "already_processed" }, 200);
      }
    } catch { /* malformed marker does not block a retry */ }
  }

  try {
    const outcome = await runAnalysis(env, candleKey, ticker, timeframe, payloads);
    return json({ status: "accepted", candle_key: candleKey, analysis_status: outcome.status, missing_evidence: outcome.missing_evidence }, 200);
  } catch (error) {
    await setAnalysisRunStatus(env, candleKey, "failed", { message: error instanceof Error ? error.message : "Unknown analysis error" }, "analysis_failed");
    return json({
      status: "accepted",
      candle_key: candleKey,
      analysis_status: "failed",
      error: error instanceof Error ? error.message : "Unknown analysis error"
    }, 502);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/ready") {
      const provenancePolicy = parseLocalCalcProvenanceAllowlist(env.LOCAL_CALC_PROVENANCE_ALLOWLIST);
      if (!provenancePolicy) {
        return json({
          status: "not_ready",
          local_calculation_provenance_configured: false,
          reason: "An explicit per-engine source and implementation SHA-256 allowlist is required."
        }, 503);
      }
      try {
        await env.DB.prepare("SELECT status FROM analysis_runs LIMIT 1").first<{ status: string }>();
        return json({
          status: "ready",
          schema_version: "cryptophys.evidence-fusion.v1",
          local_calculation_contract: "cryptophys.local-calculation.v1",
          d1_analysis_runs: true,
          local_calculation_provenance_configured: true
        });
      } catch {
        return json({
          status: "not_ready",
          d1_analysis_runs: false,
          local_calculation_provenance_configured: true,
          reason: "Required analysis_runs D1 migration is not available."
        }, 503);
      }
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        status: "ok",
        service: "xauusd-ai-trading-assistant",
        bindings: {
          d1: Boolean(env.DB),
          signal_cache: Boolean(env.SIGNAL_CACHE),
          webhook_buffer: Boolean(env.WEBHOOK_BUFFER),
          knowledge_base: Boolean(env.KNOWLEDGE_BASE),
          workers_ai: Boolean(env.AI)
        },
        secrets_configured: {
          webhook_secret: Boolean(env.WEBHOOK_SECRET),
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
      const preliminary = validateLocalCalculation(payload);
      if (!preliminary.valid && preliminary.errors.some(error => error !== "calculation_stale" && error !== "computed_at_in_future")) {
        return json({ error: "Invalid local calculation contract", validation_errors: preliminary.errors }, 400);
      }
      const record = payload as Record<string, unknown>;
      if (containsCredentialFields(record)) {
        return json({ error: "Credential-like fields are not permitted in evidence payloads" }, 400);
      }
      const key = safeKeyPart(asText(record.candle_key));
      const engine = asText(record.engine);
      if (!key || !LOCAL_ENGINES.includes(engine as typeof LOCAL_ENGINES[number])) {
        return json({ error: "Invalid candle_key or engine" }, 400);
      }
      const validation = validateLocalCalculation(record, {
        symbol: asText(record.symbol),
        timeframe: asText(record.timeframe),
        candle_key: key,
        candle_time: asText(record.candle_time)
      });
      if (!validation.valid) return json({ error: "Invalid or stale local calculation contract", validation_errors: validation.errors }, 400);
      const provenancePolicy = parseLocalCalcProvenanceAllowlist(env.LOCAL_CALC_PROVENANCE_ALLOWLIST);
      if (!provenancePolicy) return json({ error: "Local calculation provenance allowlist is not configured" }, 503);
      const provenance = record.provenance as Record<string, unknown>;
      const allowedProvenance = provenancePolicy[engine];
      if (!allowedProvenance.source_hashes.includes(asText(provenance.source_hash).toLowerCase()) ||
          !allowedProvenance.implementation_hashes.includes(asText(provenance.implementation_hash).toLowerCase())) {
        return json({ error: "Local calculation source or implementation hash is not approved for this engine" }, 403);
      }
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
      await env.WEBHOOK_BUFFER.put("localcalc:" + key + ":" + engine, JSON.stringify(stored), { expirationTtl: 60 * 60 * 24 * 14 });

      // Trigger fusion only after all three local engines and all configured webhook sources exist.
      const required = (env.REQUIRED_SOURCES || "prophet_r38,prophet_r37_ssot,gmi_v12_70").split(",").map(value => value.trim()).filter(Boolean);
      const [localRecords, webhookRecords] = await Promise.all([
        Promise.all(LOCAL_ENGINES.map(name => env.WEBHOOK_BUFFER.get("localcalc:" + key + ":" + name))),
        Promise.all(required.map(name => env.WEBHOOK_BUFFER.get("candle:" + key + ":" + name)))
      ]);
      if (localRecords.every(Boolean) && webhookRecords.every(Boolean)) {
        const priorAnalysis = await env.WEBHOOK_BUFFER.get("analysis:" + key);
        if (priorAnalysis) {
          try {
            const prior = JSON.parse(priorAnalysis) as JsonObject;
            if (prior.status === "complete") {
              return json({ status: "accepted", schema_version: record.schema_version, engine, candle_key: key, analysis_status: "already_processed" }, 202);
            }
          } catch { /* malformed marker does not block a retry */ }
        }
        const payloads: Record<string, WebhookPayload> = {};
        for (let index = 0; index < required.length; index++) {
          try { payloads[required[index]] = JSON.parse(webhookRecords[index] as string) as WebhookPayload; } catch { /* fusion will report missing/malformed source */ }
        }
        if (required.every(name => payloads[name])) {
          try {
            const outcome = await runAnalysis(env, key, asText(record.symbol), asText(record.timeframe), payloads);
            return json({ status: "accepted", schema_version: record.schema_version, engine, candle_key: key, analysis_status: outcome.status, missing_evidence: outcome.missing_evidence }, 202);
          } catch (error) {
            await setAnalysisRunStatus(env, key, "failed", { message: error instanceof Error ? error.message : "Unknown analysis error" }, "analysis_failed");
            return json({ status: "accepted", schema_version: record.schema_version, engine, candle_key: key, analysis_status: "failed", error: error instanceof Error ? error.message : "Unknown analysis error" }, 502);
          }
        }
      }
      return json({ status: "accepted", schema_version: record.schema_version, engine, candle_key: key, analysis_status: "waiting_for_evidence" }, 202);
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
    return json({ error: "Not found", endpoints: ["GET /health", "GET /ready", "POST /webhook", "POST /evidence/local-calculation", "POST /news/analyze", "GET /news/latest"] }, 404);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
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
