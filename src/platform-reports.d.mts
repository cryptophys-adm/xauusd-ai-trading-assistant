export const PLATFORM_HOST_WORKER: string;
export function platformEnabled(env: unknown): boolean;
export function publishPlatformReports(env: unknown, options?: { now?: number }): Promise<{ status: string; published?: Record<string, unknown>[] }>;
export function platformStatus(env: unknown, options?: { now?: number }): Promise<Record<string, unknown>>;
