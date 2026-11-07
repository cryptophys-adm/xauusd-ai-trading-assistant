export type LocalCalculationEngine = "mizan" | "prophet" | "gmi";
export interface LocalCalculationPayload {
  schema_version: "cryptophys.local-calculation.v1";
  engine: LocalCalculationEngine;
  symbol: string;
  timeframe: string;
  candle_time: string;
  candle_key: string;
  computed_at: string;
  calculation_version: string;
  values: Record<string, unknown>;
  provenance: Record<string, unknown>;
}
export const EVIDENCE_CONTRACT_VERSION: string;
export const LOCAL_CALCULATION_CONTRACT_VERSION: string;
export const WEBHOOK_EVIDENCE_CONTRACT_VERSION: string;
export const NEWS_ANALYSIS_CONTRACT_VERSION: string;
export const LOCAL_ENGINES: readonly LocalCalculationEngine[];
export const HUD_ENGINES: readonly string[];
export const INGEST_ENGINES: readonly string[];
export const NEWS_MAX_AGE_MS: number;
export const LOCAL_CALC_MAX_AGE_MS: number;
export function deriveCandleKey(symbol: string, timeframe: string, candleTime: string): string;
export function validateLocalCalculation(payload: unknown, expected?: Record<string, string>, now?: number, options?: { staleFrom?: "now" | "candle_close" }): { valid: boolean; errors: string[] };
export function buildEvidenceFusion(input: Record<string, any>, now?: number): Record<string, any>;

export function containsCredentialFields(value: unknown, depth?: number): boolean;
export function stripCredentialFields(value: unknown, depth?: number): unknown;
export function timeframeKey(value: unknown): string;
export function analysisAllowedForTimeframe(timeframe: unknown, configured?: string): boolean;
export function isHudSource(source: unknown): boolean;
export const INDICATOR_SOURCES: Readonly<Record<string, LocalCalculationEngine>>;
export function indicatorPayloadsFromLocal(localCalculations: unknown, context?: { symbol?: string; timeframe?: string; candleKey?: string }): Record<string, Record<string, unknown>>;
