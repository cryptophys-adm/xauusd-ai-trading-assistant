export const STRATEGY_MEMO_MS: number;
export function intelViewsOn(env: unknown): boolean;
export function resetStrategyMemoForTests(): void;
export function readStrategyMemo(env: unknown, options?: { now?: number; read?: (env: unknown, options: { now: number }) => Promise<Record<string, any> | null> }): Promise<Record<string, any> | null>;
