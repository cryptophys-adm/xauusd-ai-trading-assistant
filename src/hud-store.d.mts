export const HUD_SNAPSHOT_VERSION: string;
export const HUD_TIMEFRAMES: readonly string[];
export function validateHudSnapshot(p: unknown, now?: number): { valid: boolean; errors: string[] };
export function storeHudSnapshot(env: unknown, p: unknown, now?: number): Promise<{ status: number; body: Record<string, unknown> }>;
export function loadHudSnapshot(env: unknown, options?: { timeframe?: string; candleKey?: string | null }): Promise<Record<string, any> | null>;
export function approvedComparable(env: unknown, candleKey: string): Promise<Record<string, any> | null>;
export function hudReadings(env: unknown, snapshot: unknown): Promise<Record<string, any> | null>;
