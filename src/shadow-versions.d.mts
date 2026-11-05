export const SHADOW_WARMUP_BARS: number;
export const SHADOW_MIN_SAMPLE: number;
export function runShadowVersions(env: unknown, options?: { now?: number; candidates?: unknown[] }): Promise<Record<string, unknown>>;
export function readShadowVersions(env: unknown, options?: { days?: number; now?: number; candidates?: unknown[] }): Promise<Record<string, unknown>>;
