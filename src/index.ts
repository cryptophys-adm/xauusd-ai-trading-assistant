export interface Env {
  DB: D1Database;
  SIGNAL_CACHE: KVNamespace;
  WEBHOOK_BUFFER: KVNamespace;
  KNOWLEDGE_BASE: KVNamespace;
  AI: Ai;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  WEBHOOK_SECRET?: string;
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
    const choices = r.choices;
    if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
      const message = (choices[0] as JsonObject).message;
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

async function runAnalysis(
  env: Env,
  candleKey: string,
  ticker: string,
  timeframe: string,
  payloads: Record<string, WebhookPayload>
): Promise<void> {
  const [knowledgeText] = await Promise.all([
    env.KNOWLEDGE_BASE.get("knowledge-base:v3"),
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
    policy: knowledge
  };

  const analystResult = await env.AI.run(env.AI_MODEL_ANALYST as keyof AiModels, {
    model: "clef-flash",
    state: evidence,
    questions: {
      directional_bias: {
        type: "choice",
        instructions: "Based only on the supplied indicator evidence, classify the current XAUUSD directional state. Do not invent missing values.",
        criteria: {
          BULLISH: "Evidence supports bullish direction.",
          BEARISH: "Evidence supports bearish direction.",
          NEUTRAL: "Evidence is mixed, insufficient, stale, or conflicting."
        }
      },
      setup_quality: {
        type: "score",
        instructions: "Score the evidence quality for a potential setup, not the probability of profit.",
        criteria: [
          "Insufficient or contradictory evidence",
          "Weak evidence; confirmation required",
          "Moderate evidence; material risks remain",
          "Strong aligned evidence; invalidation still required"
        ]
      },
      missing_evidence: {
        type: "noul",
        instructions: "Is important evidence missing or conflicting enough that the system should wait?",
        criteria: {
          true: "Important required fields are missing or source evidence conflicts.",
          false: "The supplied payloads contain sufficient, reasonably aligned evidence for further review."
        }
      }
    }
  } as never);

  const analystText = extractText(analystResult);
  const counselorResult = await env.AI.run(env.AI_MODEL_COUNSELOR as keyof AiModels, {
    prompt: [
      "You are the Counselor stage in an XAUUSD decision-support pipeline.",
      "Use only the JSON evidence and analyst output below. Do not invent prices or indicator definitions.",
      "Prophet is the base bias. GMI may validate, block, or defer a Prophet setup; it must not silently overwrite Prophet's bias.",
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
          telegram_chat_id: Boolean(env.TELEGRAM_CHAT_ID)
        }
      });
    }
    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }
    return json({ error: "Not found", endpoints: ["GET /health", "POST /webhook"] }, 404);
  }
};
