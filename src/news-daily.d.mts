export function newsDailyEnabled(env: unknown): boolean;
export function runNewsDaily(env: unknown, options?: { now?: number }): Promise<Record<string, unknown>>;
export function readNewsDaily(db: unknown): Promise<Record<string, unknown> | null>;
