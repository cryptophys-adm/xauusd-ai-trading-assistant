export const STRATEGY_VERSION: string;
export const MIN_RRR: number;
export function roomLean(openings: unknown[] | null | undefined): number | null;
export function atr(candles: unknown[], n?: number): number | null;
export function keyLevels(input?: Record<string, any>): Array<{ price: number | null; label: string; kind: string }>;
export function tradeLevels(input: Record<string, any>): Record<string, any> | null;
export function buildStrategy(input?: Record<string, any>): Record<string, any>;
export function loadStrategyInputs(env: any, options?: { now?: number }): Promise<Record<string, any>>;
export function readStrategy(env: any, options?: { now?: number }): Promise<Record<string, any>>;
