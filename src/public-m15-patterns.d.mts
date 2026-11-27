export const M15_PATTERNS_VERSION: string;
export const M15_PATTERNS_KEY: string;
export const M15_SERIES_KEY: string;
export const M15_PATTERN_BARS: number;
export const M15_PATTERNS_TTL_S: number;
export function barCloseMs(bar: unknown): number | null;
export function m15PatternsOf(bars: unknown, options?: { events?: unknown[]; mode?: string }): { version: string; at_close_ms: number | null; mode: string; patterns: Record<string, any>[] };
export function runM15PatternsStep(env: unknown, options?: { now?: number }): Promise<Record<string, unknown>>;
export function readM15Patterns(env: unknown, options?: { sinceCloseMs?: number | null }): Promise<Record<string, unknown>>;
