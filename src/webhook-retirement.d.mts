export function webhookIngestMode(env: any): "on" | "off";
export const RETIRED_WEBHOOK_BODY: Readonly<{ error: string; reason: string }>;
export function retiredWebhookResponse(): Response;
