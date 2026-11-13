// GET /api/organism/status, measured only (owner 2026-11-12: "ya bersihkan sekalian"). The old route returned a
// fixed $500 treasury, a burn and runway derived from it, an AI quota of 150% and labels such as "canon sync:
// synchronized" that nothing measured. This Worker holds no treasury (the platform's Metabolism does), so none
// is shown. Every value below is read from where it lives; a value nobody measured is null.
import { decisionEngineEnabled, marketOpenAt, readLatestDecision } from "./decision-engine.mjs";
import { omegaHealth } from "./omega-health.mjs";

export const ORGANISM_STATUS_SCHEMA = "organism-status.v2";

export async function organismStatus(env, { now = Date.now() } = {}) {
  const enabled = decisionEngineEnabled(env);
  let latest = null;
  try { latest = enabled ? await readLatestDecision(env) : null; } catch { latest = null; }
  // Counted here, not through listDeals (which answers [] on any error): a failed read is null, not 0.
  let recentDeals = null;
  try {
    const row = await env.DB.prepare("SELECT COUNT(DISTINCT deal_ticket) AS n FROM ea_deals WHERE closed_ms >= ?").bind(now - 7 * 86_400_000).first();
    recentDeals = Number.isFinite(Number(row?.n)) ? Number(row.n) : null;
  } catch { recentDeals = null; }
  const health = await omegaHealth(env, { now });
  return {
    schema: ORGANISM_STATUS_SCHEMA,
    market_state: marketOpenAt(now) ? "open" : "closed",
    decision_engine: {
      enabled,
      latest_bar_close: typeof latest?.bar_close === "string" ? latest.bar_close : null,
      latest_decided_at: typeof latest?.decided_at === "string" ? latest.decided_at : null
    },
    omega: {
      engine_enabled: health.engine_enabled,
      control_mode: health.control?.mode ?? null,
      ea_connected: health.ea.connected,
      ea_heartbeat_age_ms: health.ea.heartbeat_age_ms,
      bridge_connected: health.bridge.connected,
      bridge_sync_age_ms: health.bridge.synced_age_ms
    },
    deals: { recent_count: recentDeals, window: "closed in the last 7 days" },
    observed_at: new Date(now).toISOString()
  };
}
