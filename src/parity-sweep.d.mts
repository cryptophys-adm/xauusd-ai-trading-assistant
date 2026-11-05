export const OBSERVED_PREFIX: string;
export const LOCAL_TTL: { expirationTtl: number };
export const PARITY_SWEEP_CRON: string;
export const PARITY_SWEEP_LOOKBACK_CANDLES: number;
export const PARITY_SWEEP_LOOKBACK_M5_CANDLES: number;

export interface ReconcileEngineOutcome {
  result: string;
  counted: boolean;
  mismatches: Array<Record<string, unknown>>;
  missing: string[];
}
export interface ReconcileResult {
  comparisons: Record<string, ReconcileEngineOutcome>;
  trust: Record<string, boolean>;
}
export interface SweepResult {
  swept_at: string;
  candle_keys: string[];
  m5_candle_keys: string[];
  results: Record<string, ReconcileResult | { error: string }>;
}

export function reconcileLocalComputation(env: unknown, candleKey: string): Promise<ReconcileResult>;
export function closedH1CandleKeys(now?: number, options?: { symbol?: string; timeframe?: string; lookback?: number }): string[];
export function closedM5CandleKeys(now?: number, options?: { symbol?: string; lookback?: number }): string[];
export function reconcileRecentCandles(env: unknown, options?: { now?: number; lookback?: number; m5Lookback?: number }): Promise<SweepResult>;

export function backfillRecentAnalyses(env: unknown, options?: { now?: number; lookback?: number; loadPayloads?: any; runAnalysis?: any; setStatus?: any }): Promise<{ triggered: number; candle_keys: string[] }>;
