export function tfThreadsEnabled(env: unknown): boolean;
export function runPendingTimeframeThreads(env: unknown, options?: { now?: number; onRoom?: (room: { chart: string; key: string; result: Record<string, unknown> }) => Promise<unknown> | unknown }): Promise<Record<string, unknown>>;
export function readTimeframeThread(db: unknown, chart: string, options?: { candleKey?: string; env?: unknown }): Promise<Record<string, any> | null>;
export function runTimeframeThread(env: unknown, input: { chart: string; candleKey: string }, options?: { clock?: () => number }): Promise<Record<string, any>>;
export function tfAgentName(id: string): string;
export function runShadowJob(result: unknown): Promise<Record<string, unknown> | null>;
