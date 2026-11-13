export const LEARNED_LIVE_VERSION: string;
export function runLearnedPromotion(env: unknown, options?: { knowledge?: unknown; now?: number }): Promise<Record<string, any> & { status: string }>;
export function readLearnedLive(env: unknown): Promise<Record<string, any> | null>;
export function effectiveLearnedPack(env: unknown, options?: { now?: number }): Promise<Record<string, any>>;
