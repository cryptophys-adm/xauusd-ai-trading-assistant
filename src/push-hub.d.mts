export const PUSH_HUB_NAME: string;
export function pushHubOf(env: unknown): any;
export function publishSnapshot(env: unknown, topic: string, data: unknown): Promise<Record<string, any>>;
export function hubSubscribers(env: unknown, topic: string): Promise<number>;
