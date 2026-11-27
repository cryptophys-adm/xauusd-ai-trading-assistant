export const FEED_ID_RE: RegExp;
export const FEED_SEEN_MS: number;
export function resetFeedSchemaForTests(): void;
export function feedStateFrom(state: unknown, now?: number): Record<string, unknown> | null;
export function feedSync(env: any, input?: Record<string, unknown>, options?: { now?: number }): Promise<Record<string, unknown>>;
export function setFeedConnection(env: any, input: { bridgeId?: unknown; envelope?: unknown; server?: unknown; actor: string }, options?: { now?: number }): Promise<Record<string, unknown>>;
export function clearFeedConnection(env: any, input: { bridgeId?: unknown; reason?: unknown; actor: string }, options?: { now?: number }): Promise<Record<string, unknown>>;
export function feedOverview(env: any, options?: { now?: number }): Promise<Array<Record<string, unknown>>>;
