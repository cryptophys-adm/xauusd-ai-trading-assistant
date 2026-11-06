export function tfThreadsEnabled(env: unknown): boolean;
export function runPendingTimeframeThreads(env: unknown, options?: { now?: number }): Promise<Record<string, unknown>>;
export function readTimeframeThread(db: unknown, chart: string): Promise<Record<string, unknown> | null>;
