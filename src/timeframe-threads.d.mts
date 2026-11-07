export function tfThreadsEnabled(env: unknown): boolean;
export function runPendingTimeframeThreads(env: unknown, options?: { now?: number; onRoom?: (room: { chart: string; key: string; result: Record<string, unknown> }) => Promise<unknown> | unknown }): Promise<Record<string, unknown>>;
export function readTimeframeThread(db: unknown, chart: string, options?: { candleKey?: string }): Promise<Record<string, any> | null>;
