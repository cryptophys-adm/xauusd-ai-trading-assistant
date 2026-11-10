// The parity view of the Nexus System status page (owner request 2026-11-08): every registry
// identity with its totals, which identity is current per engine, the recent comparisons and the
// counts of the last 24 hours. Read-only.
import { ensureSchema, DEFAULT_POLICY } from "./parity-registry.mjs";
import { engineTimeframe, engineBase, engineName, engineLabel } from "./engine-names.mjs";

export { engineTimeframe, engineBase };

const short = (h) => (typeof h === "string" ? h.slice(0, 8) : null);
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * Pure: the registry rows shaped for display. An engine can hold several identities (one per
 * source and implementation hash); the current one is the most recently first seen.
 */
export function shapeRegistry(rows) {
  const latest = new Map();
  for (const r of rows) {
    const prev = latest.get(r.engine);
    if (!prev || String(r.first_seen_at) > String(prev.first_seen_at)) latest.set(r.engine, r);
  }
  return rows.map((r) => {
    const detail = parse(r.last_detail);
    return {
      engine: r.engine, base: engineBase(r.engine), timeframe: engineTimeframe(r.engine),
      name: engineName(r.engine), label: engineLabel(r.engine),
      current: latest.get(r.engine) === r,
      status: r.status, consecutive_matches: Number(r.consecutive_matches) || 0, promote_after: DEFAULT_POLICY.promoteAfter,
      totals: { matches: Number(r.total_matches) || 0, mismatches: Number(r.total_mismatches) || 0, incomplete: Number(r.total_incomplete) || 0 },
      source: short(r.source_hash), implementation: short(r.implementation_hash),
      last_candle_key: r.last_candle_key ?? null, last_result: r.last_result ?? null,
      last_detail: detail ? { compared: detail.compared ?? null, mismatches: Array.isArray(detail.mismatches) ? detail.mismatches.length : 0, missing: Array.isArray(detail.missing) ? detail.missing.length : 0 } : null,
      first_seen_at: r.first_seen_at ?? null, approved_at: r.approved_at ?? null, revoked_at: r.revoked_at ?? null, updated_at: r.updated_at ?? null
    };
  }).sort((a, b) => Number(b.current) - Number(a.current) || a.base.localeCompare(b.base) || a.timeframe.localeCompare(b.timeframe));
}

/** GET /api/parity. */
export async function readParityView(db, { now = Date.now(), limit = 40 } = {}) {
  await ensureSchema(db);
  const rows = (await db.prepare("SELECT * FROM engine_parity_registry").all()).results || [];
  const recent = (await db.prepare("SELECT engine, candle_key, result, detail, compared_at FROM engine_parity_comparisons ORDER BY compared_at DESC LIMIT ?").bind(limit).all()).results || [];
  const since = new Date(now - 86_400_000).toISOString();
  const day = (await db.prepare("SELECT engine, result, COUNT(*) AS n FROM engine_parity_comparisons WHERE compared_at >= ? GROUP BY engine, result").bind(since).all()).results || [];
  const last24h = {};
  for (const d of day) (last24h[d.engine] ||= {})[d.result] = Number(d.n) || 0;
  const health = shapeRegistry(rows)
    .filter((r) => r.current)
    .map((r) => ({
      engine: r.engine, base: r.base, timeframe: r.timeframe, label: r.label,
      status: r.status, consecutive_matches: r.consecutive_matches, promote_after: r.promote_after,
      mismatches_24h: (last24h[r.engine]?.mismatch || 0) + (last24h[r.engine]?.input_mismatch || 0),
      revoked: Boolean(r.revoked_at),
      ok: r.status === "approved" && !r.revoked_at && ((last24h[r.engine]?.mismatch || 0) === 0)
    }))
    .sort((a, b) => Number(a.ok) - Number(b.ok) || a.engine.localeCompare(b.engine));
  return {
    policy: { promote_after: DEFAULT_POLICY.promoteAfter, rule: "an identity is approved after consecutive matching candles; any indicator mismatch revokes it; an incomplete comparison neither advances nor resets the streak" },
    registry: shapeRegistry(rows),
    recent: recent.map((c) => {
      const d = parse(c.detail);
      return { engine: c.engine, timeframe: engineTimeframe(c.engine), label: engineLabel(c.engine), candle_key: c.candle_key, result: c.result, compared_at: c.compared_at, mismatches: Array.isArray(d?.mismatches) ? d.mismatches.slice(0, 3).map((m) => m?.field ?? m?.path ?? String(m)).filter(Boolean) : [] };
    }),
    last_24h: last24h,
    health
  };
}
