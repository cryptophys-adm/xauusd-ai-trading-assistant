/**
 * @fileoverview Shared evidence-fusion handoff contracts for the XAUUSD AI Trading Assistant.
 *
 * Pure types, constants, and helpers used by the Confluence Controller (sender)
 * and the xauusd-ai-trading-assistant Worker (receiver) for the authenticated,
 * versioned Controller -> AI Worker handoff. Dependency-free and side-effect-free
 * so every Worker can bundle them. Contains no secrets.
 */

export const SCHEMA_VERSION = "1.0.0";

/** Canonical symbol traded by this system. */
export const CANONICAL_SYMBOL = "XAUUSD";

/**
 * Canonical timeframes supported by the target architecture.
 * M5 is the bootstrap source; M15, H1, H4, D1 are aggregated from closed M5 candles.
 * H2/M30/W1 are not canonical timeframes and are rejected by the Controller.
 */
export const SUPPORTED_TIMEFRAMES = ["M1", "M5", "M15", "H1", "H4", "D1"] as const;
export type Timeframe = (typeof SUPPORTED_TIMEFRAMES)[number];

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === "string" && (SUPPORTED_TIMEFRAMES as readonly string[]).includes(value);
}

/** Engines whose evidence is fused by the Confluence Controller. */
export const REQUIRED_ENGINES = ["mizan", "prophet", "gmi"] as const;
export type EngineId = (typeof REQUIRED_ENGINES)[number];

export function isEngineId(value: unknown): value is EngineId {
  return typeof value === "string" && (REQUIRED_ENGINES as readonly string[]).includes(value);
}

/** Advisory-only decisions. Fail-closed defaults to WAIT / NO_TRADE. */
export const ALLOWED_DECISIONS = ["BUY", "SELL", "WAIT", "NO_TRADE"] as const;
export type Decision = (typeof ALLOWED_DECISIONS)[number];

export function isDecision(value: unknown): value is Decision {
  return typeof value === "string" && (ALLOWED_DECISIONS as readonly string[]).includes(value);
}

/** Maximum age (seconds) of an engine result before it is treated as stale. */
export const ENGINE_FRESHNESS_TTL_SECONDS = 60 * 60; // 1 hour

/** Maximum age (seconds) of a news article before it is treated as stale. */
export const NEWS_FRESHNESS_TTL_SECONDS = 60 * 60; // 1 hour

/** A closed candle identity, used as the correlation key across the pipeline. */
export interface CandleRef {
  symbol: string;
  timeframe: Timeframe;
  /** ISO-8601 UTC open time of the closed candle. */
  candle_ts: string;
  /** Canonical correlation key: SYMBOL:TIMEFRAME:ISO_TS. */
  candle_key: string;
}

/** Result produced by a single engine for a candle. */
export interface EngineResult {
  engine: EngineId;
  /** Engine source baseline version (e.g. "mizan-v4", "prophet-r38"). */
  version: string;
  /** SHA-256 of the verified source baseline, when known. null = not verified. */
  source_hash: string | null;
  /** ISO-8601 UTC when this result was computed. */
  computed_at: string;
  candle_ts: string;
  /** Whether the engine produced a usable result. */
  ok: boolean;
  /** Engine-specific output. Only present when ok is true. */
  value: unknown;
  /** Human-readable failure reason when ok is false. */
  error: string | null;
  /** Age of this result in seconds at the time of fusion. */
  freshness_seconds: number | null;
  /** True only when this engine is verified production-ready. */
  production_ready: boolean;
}

/** Freshness snapshot for one engine at fusion time. */
export interface EngineFreshness {
  engine: EngineId;
  computed_at: string;
  /** Age in seconds. null when the engine result is absent/unknown. */
  age_seconds: number | null;
  ok: boolean;
}

/** Fundamental news evidence (produced by xauusd-fundamental-news-ingestion). */
export interface NewsEvidence {
  available: boolean;
  source: string | null;
  fetched_at: string | null;
  articles: unknown[];
  article_count: number;
  reason: string | null;
  /** True when every article is within the configured freshness window. */
  fresh: boolean;
}

/** Per-source provenance evidence. */
export interface SourceEvidence {
  engine: EngineId;
  /** SHA-256 of the source baseline this engine must match. */
  provenance: string;
  /** True when provenance was verified against the allowlist. */
  provenance_verified: boolean;
  freshness_ok: boolean;
  missing_evidence: string[];
}

/** Validation outcome produced by the Confluence Controller. */
export interface BundleValidation {
  ok: boolean;
  completeness: "complete" | "incomplete";
  freshness: Record<EngineId, EngineFreshness>;
  errors: string[];
  missing_evidence: string[];
}

/** The versioned, authenticated bundle sent Controller -> AI Worker. */
export interface EvidenceBundle {
  schema_version: string;
  request_id: string;
  created_at: string; // ISO-8601 UTC
  symbol: string;
  timeframe: Timeframe;
  candle: CandleRef;
  validation: BundleValidation;
  sources: SourceEvidence[];
  engines: EngineResult[];
  news: NewsEvidence;
  /** SHA-256 of the canonical evidence subset (for dedup / fingerprinting). */
  evidence_fingerprint: string;
  provenance_verified: boolean;
  handoff: {
    target_worker: string;
    target_endpoint: string;
    auth_scheme: string;
  };
}

/** Response from the AI Worker /v1/analyze endpoint. */
export interface HandoffResponse {
  schema_version: string;
  request_id: string;
  decision: Decision;
  confidence: number | null;
  entry_price: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  risk_reward: number | null;
  position_size_pct: number | null;
  reasoning: string;
  confirmation: string | null;
  invalidation: string | null;
  models: {
    analyst: string;
    counselor: string;
    reasoner: string;
  };
  stored: boolean;
  notified: boolean;
  errors: string[];
}

/** Build the canonical candle key: SYMBOL:TIMEFRAME:ISO_TS. */
export function buildCandleKey(symbol: string, timeframe: Timeframe, candleTs: string): string {
  const safe = (s: string) => s.trim().replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 180);
  return [safe(symbol), safe(timeframe), safe(candleTs)].join(":");
}

/** ISO-8601 UTC now. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Parse an ISO-8601 timestamp safely. Returns null when invalid. */
export function parseIso(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Is a candle in the future relative to now? */
export function isCandleInFuture(candleTs: string): boolean {
  const d = parseIso(candleTs);
  if (!d) return true;
  return d.getTime() > Date.now();
}

/** Compute SHA-256 hex digest. Available in Workers and Node. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
