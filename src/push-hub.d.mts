export const PUSH_HUB_NAME: string;
export function pushHubOf(env: unknown): any;
export function publishSnapshot(env: unknown, topic: string, data: unknown): Promise<Record<string, any>>;
export const SUBSCRIBERS_TTL_MS: number;
export function resetSubscribersCacheForTests(): void;
export function hubSubscribers(env: unknown, topic: string, options?: { now?: number }): Promise<number>;
