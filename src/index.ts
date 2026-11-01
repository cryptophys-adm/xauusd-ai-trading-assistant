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
}

type JsonObject = Record<string, unknown>;

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

async function fetchNews(env: Env): Promise<{ available: boolean; articles: unknown[]; article_count: number; reason?: string; fetched_at: string }> {
  const fetchedAt = new Date().toISOString();
  if (!env.INGEST_URL || !env.INGEST_SECRET) return { available: false, articles: [], article_count: 0, reason: "INGEST_URL or INGEST_SECRET is not configured on this Worker.", fetched_at: fetchedAt };
  const pullUrl = env.INGEST_URL.replace(/\/+$/, "") + "/pull";
  try {
    const response = await fetch(pullUrl, { method: "POST", headers: { "Authorization": "Bearer " + env.INGEST_SECRET, "Accept": "application/json" } });
    if (!response.ok) return { available: false, articles: [], article_count: 0, reason: "Ingestion endpoint returned HTTP " + response.status + " " + response.statusText, fetched_at: fetchedAt };
    const body = await response.json() as Record<string, unknown>;
    let articles: unknown[] | null = null;
    for (const key of ["articles", "data", "results", "items"]) { if (Array.isArray(body[key])) { articles = body[key] as unknown[]; break; } }
    if (!articles && Array.isArray(body)) articles = body as unknown[];
    if (!articles || articles.length === 0) return { available: false, articles: [], article_count: 0, reason: "Ingestion endpoint returned no articles.", fetched_at: fetchedAt };
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
    "SELECT analysis_key, analyzed_at, article_count, recommendation_json FROM news_analyses WHERE analysis_key = ? LIMIT 1"
  ).bind(analysisKey).first<JsonObject>();
  if (cached) {
    const latest = {
      status: "ok",
      analysis_type: "fundamental_news",
      deduplicated: true,
      analysis_key: analysisKey,
      analyzed_at: cached.analyzed_at,
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

async function runAnalysis(
  env: Env,
  candleKey: string,
  ticker: string,
  timeframe: string,
  payloads: Record<string, WebhookPayload>
): Promise<void> {
  const [knowledgeText, newsEvidence] = await Promise.all([
    env.KNOWLEDGE_BASE.get("knowledge-base:v3"),
    fetchNews(env)
  ]);
  const knowledge = knowledgeText || JSON.stringify({
    status: "kv_key_missing",
    message: "No knowledge-base:v3 value was found in the bound KV namespace. Use the checked-in knowledge-base-v3.json after reviewing it."
  });

  const evidence = {
    candle_key: candleKey,
    ticker,
    timeframe,
    source_payloads: payloads,
    policy: knowledge,
    news_evidence: newsEvidence
  };

  const analystResult = await env.AI.run(env.AI_MODEL_ANALYST as keyof AiModels, {
    prompt: [
      "You are the Analyst stage in an XAUUSD decision-support pipeline.",
      "Classify the supplied indicator evidence without inventing missing values or prices.",
      "Prophet is the base directional bias. GMI can validate, block, or defer a setup but must not silently overwrite Prophet's bias.",
      "Evidence includes technical source_payloads and fundamental news_evidence.",
      "If news_evidence.available is false, state that fundamental news data is unavailable. Do NOT invent news.",
      "If news_evidence.available is true, consider the supplied articles alongside technical evidence.",
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
      "If news_evidence.available is false, acknowledge fundamental news is unavailable. Do NOT fabricate news.",
      "If news_evidence.available is true, weigh the supplied articles in scenarios.",
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
  const reasonerText = extractText(reasonerResult);
  const decision = parseDecision(reasonerText);

  const timestamp = new Date().toISOString();
  const synthesis = {
    candle_key: candleKey,
    ticker,
    timeframe,
    timestamp,
    analyst_model: env.AI_MODEL_ANALYST,
    analyst_output: analystText,
    counselor_model: env.AI_MODEL_COUNSELOR,
    counselor_output: counselorText,
    reasoner_model: env.AI_MODEL_REASONER,
    reasoner_output: reasonerText,
    news_evidence: newsEvidence,
    decision
  };

  await env.DB.prepare(
    "INSERT INTO ai_syntheses (candle_key, ticker, timeframe, timestamp, prophet_metrics, gmi_metrics, ai_analysis, ai_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    candleKey,
    ticker,
    timeframe,
    timestamp,
    JSON.stringify({
      prophet_r38: payloads.prophet_r38?.metrics ?? payloads.prophet_r38,
      prophet_r37_ssot: payloads.prophet_r37_ssot?.metrics ?? payloads.prophet_r37_ssot
    }),
    JSON.stringify(payloads.gmi_v12_70?.metrics ?? payloads.gmi_v12_70),
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
  await sendTelegram(env, message);

  await env.WEBHOOK_BUFFER.put("analysis:" + safeKeyPart(candleKey), JSON.stringify({
    status: "complete",
    created_at: timestamp,
    sources: Object.keys(payloads),
    decision: synthesis
  }), { expirationTtl: 60 * 60 * 24 * 14 });
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.WEBHOOK_SECRET) {
    return json({ error: "WEBHOOK_SECRET is not configured" }, 503);
  }

  let body: WebhookPayload;
  try {
    body = await request.json() as WebhookPayload;
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
    return json({ status: "accepted", candle_key: candleKey, analysis_status: "already_processed" }, 200);
  }

  try {
    await runAnalysis(env, candleKey, ticker, timeframe, payloads);
    return json({ status: "accepted", candle_key: candleKey, analysis_status: "complete" }, 200);
  } catch (error) {
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
    return json({ error: "Not found", endpoints: ["GET /health", "POST /webhook", "POST /news/analyze", "GET /news/latest"] }, 404);
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
