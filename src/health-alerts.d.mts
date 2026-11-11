export function runHealthAlerts(env: unknown, options?: { now?: number }): Promise<Record<string, unknown>>;
export function readHealthAlerts(db: unknown, options?: { now?: number }): Promise<Record<string, unknown>>;
export function marketDataIssue(env: unknown, now?: number): Promise<Record<string, any> | null>;
export const MARKET_DATA_STALE_MS: number;
