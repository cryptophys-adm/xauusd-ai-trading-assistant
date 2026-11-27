export declare const FEED_CONTENT_STALE_MS: number;
export declare function feedContentStale(input: { syncedMs: number; lastBarMs: number | null; now: number; seenMs?: number }): boolean;
export declare function newStaleEpisode(input: { lastEventMs: number | null; lastBarMs: number | null }): boolean;
export declare function staleDetail(input: { bridgeId: string; lastBarMs: number | null; now: number }): Record<string, unknown>;
