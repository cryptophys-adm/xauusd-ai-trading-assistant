export const SCORING_VERSION: string;
export const SCORING: Readonly<{ horizon: number; atrPeriod: number; thresholdAtr: number; stuckCandles: number; stuckRangeAtr: number }>;
export const MAX_BAR_GAP_MS: number;
export function crossesGap(bars: unknown[], i: number, horizon?: number): boolean;
export function scoreRecentStatements(env: unknown, options?: { now?: number }): Promise<Record<string, unknown>>;
export function detectRecentStuckStates(env: unknown, options?: { now?: number; lookback?: number }): Promise<Record<string, unknown>>;
export function scorecards(db: unknown, options?: { days?: number; now?: number; snapshot?: boolean }): Promise<Record<string, any>[]>;
export const SCORECARD_SNAPSHOT_MAX_AGE_MS: number;
export function refreshScorecardSnapshots(db: unknown, options?: { now?: number }): Promise<number[]>;
export function listStuckStates(db: unknown, options?: { limit?: number }): Promise<Record<string, any>[]>;
export const ENGINE_SUBJECT: string;
export const ENGINE_RUN: string;
export function engineStatements(env: unknown, sinceIso: string): Promise<Map<number, Record<string, unknown>[]>>;
export interface OutcomeWindow { n_directional: number; hit: number; miss: number; hit_rate: number | null; wait_n: number; wait_accuracy: number | null }
export function outcomeSummary(db: unknown, options: { subject: string; timeframe: string; now?: number }): Promise<{ scoring_version: string; subject: string; timeframe: string; windows: Record<"7d" | "30d", OutcomeWindow>; as_of: string }>;
