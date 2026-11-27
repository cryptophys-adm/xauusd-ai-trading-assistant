// S3 (parity removal, owner 2026-11-27: "bersihkan juga parity yang sudah tidak digunakan"; TradingView cleanup,
// "Lanjutkan pembersihan ketergantungan tradingview"): the TradingView alert webhooks are retired. Since S2 nothing in
// trust or decisions read them (INDICATOR_SOURCE "local": the H1 chain, the rooms and the Decision Engine read the
// local records), and ~1,390 alerts a day still cost a D1 upsert, a KV put and, on H1, a queue task each.
// POST /webhook answers 410 before it reads the body or checks the secret, and writes nothing. WEBHOOK_INGEST "on"
// restores the old handler unchanged (a one-deploy rollback) until S5 deletes it.

/** "on" (the old handler) or "off" (default: 410, nothing written). */
export function webhookIngestMode(env) {
  return String(env?.WEBHOOK_INGEST ?? "off").trim().toLowerCase() === "on" ? "on" : "off";
}

export const RETIRED_WEBHOOK_BODY = Object.freeze({ error: "gone", reason: "tradingview_webhooks_retired" });

/** The 410 answer: JSON, no body read, nothing stored. */
export function retiredWebhookResponse() {
  return new Response(JSON.stringify(RETIRED_WEBHOOK_BODY), { status: 410, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
