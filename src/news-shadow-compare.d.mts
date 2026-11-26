export const NEWS_COMPARE_METER: string;
export const NEWS_COMPARE_HOUR: number;
export const NEWS_READING_SCHEMA: Record<string, unknown>;
export function readingMessages(headlines: Array<{ title: string; published_at?: string | null }>): Array<{ role: string; content: string }>;
export function cleanReading(obj: unknown): { gold_bias: string; dollar_bias: string; impact: string; catalysts: string[] } | null;
export function agreement(tv: unknown, shadow: unknown): { gold: boolean | null; dollar: boolean | null; impact: boolean | null };
export const MODEL_ROUTER_ALLOW: readonly string[];
export function runNewsShadowCompare(env: unknown, options?: { now?: number; call?: unknown; router?: { fetcher?: unknown; clock?: () => number; timeoutMs?: number } }): Promise<Record<string, any>>;
export function readNewsShadowCompare(env: unknown, options?: { days?: number }): Promise<Record<string, any>>;
