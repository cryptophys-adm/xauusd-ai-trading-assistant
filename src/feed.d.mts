export function keyCloseOf(candleKey: unknown): number | null;
export function fallbackSinceMs(env: unknown): Promise<number | null>;
export function feedAt(env: unknown, closeMs: number): Promise<"mt5_fallback" | "tradingview">;
