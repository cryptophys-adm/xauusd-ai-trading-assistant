export interface WebhookReading {
  available: boolean;
  bias: "bullish" | "bearish" | "mixed" | "neutral" | "unavailable";
  summary: string;
  lines: Array<{ source: string; text: string }>;
  missing: string[];
}
export function interpretWebhooks(input?: { prophetR38?: unknown; prophetR37?: unknown; gmi?: unknown }): WebhookReading;
export function interpretWebhookRow(row: { prophet_metrics?: unknown; gmi_metrics?: unknown } | null | undefined): WebhookReading;
export function storedIndicatorMetrics(payload: unknown): Record<string, unknown> | null;
