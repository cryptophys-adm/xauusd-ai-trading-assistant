export function keyCloseOf(candleKey: unknown): number | null;
export function fallbackSinceMs(env: unknown): Promise<number | null>;
export function feedAt(env: unknown, closeMs: number): Promise<"mt5_fallback" | "tradingview">;
export const FEED_FALLBACK_KEY: string;
export const FEED_FALLBACK_MODES: readonly string[];
export function readFeedFallback(env: unknown, options?: { now?: number }): Promise<Record<string, any>>;
export function setFeedFallback(env: unknown, input?: { mode?: string; reason?: string; actor?: string }, options?: { now?: number }): Promise<Record<string, any>>;
