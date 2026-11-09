export const AETHER_PUSH_VERSION: string;
export const AETHER_PUSH_LIMITS: Readonly<Record<string, number>>;
export const AETHER_MAX_CARDS_PER_CALL: number;
export function pushDecisionCards(env: unknown, options?: { now?: number; load?: (env: unknown, options: { chart: string; limit: number }) => Promise<unknown[]> }): Promise<{ status: string; pushed?: number; accepted?: number; rejected?: number; [key: string]: unknown }>;
export function aetherPushStatus(env: unknown, options?: { now?: number }): Promise<Record<string, unknown>>;
export function resetAetherPushSchemaCacheForTests(): void;
export const WEIGHTING_REPORT_VERSION: string;
export function weightingReport(replay: unknown, options?: { now?: number }): Record<string, any>;
export function pushWeightingReport(env: unknown, replay: unknown, options?: { now?: number }): Promise<Record<string, any> & { status: string }>;
