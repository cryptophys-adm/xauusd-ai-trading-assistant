export const EXECUTOR_SILENT_MS: number;
export const EXECUTOR_SILENT_KEY: string;
export function lastSyncMs(row: { synced_ms?: unknown; state?: unknown } | null | undefined): number | null;
export function executorSilent(input: { syncedMs: unknown; now: number; silentMs?: number }): boolean;
export function exposureOf(state: unknown): { positions: number; orders: number; severity: "critical" | "warning" };
export function silentLine(input: { syncedMs: number; now: number; positions: number; orders: number; severity: string }): string;
export function backLine(input: { sinceMs: number; now: number }): string;
export function runExecutorSilentCheck(env: unknown, options?: { now?: number; send?: ((text: string) => unknown) | null }): Promise<{ status: string; [k: string]: unknown }>;
