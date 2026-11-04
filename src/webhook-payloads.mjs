export async function loadWebhookPayloadsFromD1(env, candleKey, required) {
  const payloads = {};
  try {
    const rows = await env.DB.prepare("SELECT source, payload FROM webhook_sources WHERE candle_key = ?").bind(candleKey).all();
    for (const row of rows.results || []) {
      if (!required.includes(row.source)) continue;
      try { payloads[row.source] = JSON.parse(row.payload); } catch { /* malformed */ }
    }
  } catch { /* fall back */ }
  if (required.every(source => payloads[source])) return payloads;
  await Promise.all(required.map(async (source) => {
    if (payloads[source]) return;
    try {
      const raw = await env.WEBHOOK_BUFFER.get("candle:" + candleKey + ":" + source);
      if (raw) payloads[source] = JSON.parse(raw);
    } catch { /* ignore */ }
  }));
  return payloads;
}
