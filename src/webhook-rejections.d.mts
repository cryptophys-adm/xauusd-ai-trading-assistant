export type WebhookRejection = { reason: string; secret_field: string; received_len: number; expected_len: number };
export const WEBHOOK_REJECTIONS_SQL: string;
export const MAX_PER_HOUR: number;
export const REJECTION_TEXT: Readonly<Record<string, string>>;
export function classifyRejection(input?: { headerSecret?: string; bodySecret?: string; expected?: string }): WebhookRejection | null;
export function recordRejection(db: unknown, rejection: WebhookRejection | null, meta?: { source?: string | null; timeframe?: string | null; candleTime?: string | null; contentType?: string | null; userAgent?: string | null }, now?: number): Promise<boolean>;
export function webhookLaneStatus(db: unknown, now?: number): Promise<Record<string, unknown>>;
export function rejectionSummary(db: unknown, sinceMs: number): Promise<Record<string, unknown>>;
