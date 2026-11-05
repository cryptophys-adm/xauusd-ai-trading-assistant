export const SCORING_VERSION: string;
export const SCORING: Readonly<{ horizon: number; atrPeriod: number; thresholdAtr: number; stuckCandles: number; stuckRangeAtr: number }>;
export function scoreRecentStatements(env: unknown, options?: { now?: number }): Promise<Record<string, unknown>>;
export function detectRecentStuckStates(env: unknown, options?: { now?: number; lookback?: number }): Promise<Record<string, unknown>>;
export function scorecards(db: unknown, options?: { days?: number; now?: number }): Promise<Record<string, any>[]>;
export function listStuckStates(db: unknown, options?: { limit?: number }): Promise<Record<string, any>[]>;
