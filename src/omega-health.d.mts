export const OMEGA_HEALTH_SCHEMA: string;
export const EA_STALE_AFTER_MS: number;
export const BRIDGE_STALE_AFTER_MS: number;
export const EXECUTOR_STALE_AFTER_MS: number;
export const TERMINAL_STATE_FRESH_MS: number;
export function omegaHealth(env: unknown, options?: { now?: number }): Promise<Record<string, any>>;
