export const STRATEGY_VERSION: string;
export const MIN_RRR: number;
export function roomLean(openings: unknown[] | null | undefined): number | null;
export function atr(candles: unknown[], n?: number): number | null;

export function tradeLevels(input: Record<string, any>): Record<string, any> | null;
export const STRATEGY_PARAMS: Readonly<{ min_rrr: number; min_confidence: number; lean: number; strong_h1: number; near_atr: number }>;
export function buildStrategy(input?: Record<string, any>, params?: Partial<{ min_rrr: number; min_confidence: number; lean: number; strong_h1: number; near_atr: number }>): Record<string, any>;
export function loadStrategyInputs(env: any, options?: { now?: number }): Promise<Record<string, any>>;
export function readStrategy(env: any, options?: { now?: number }): Promise<Record<string, any>>;
