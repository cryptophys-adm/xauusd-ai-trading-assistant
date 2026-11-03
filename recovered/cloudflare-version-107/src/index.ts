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
/* This endpoint INGESTS indicator source payloads only. It does N