// The pull adapter's daily TradingView call budget, counted atomically (ADR-0015 phase 4, narrow; owner
// 2026-11-14: "lanjut keduanya"). The pull adapter reserved its calls with a KV read-modify-write: two runs
// close together (or a KV read that has not seen the last write yet) could both read the same count and both
// reserve. Here one D1 statement grants min(wanted, daily - used) and adds it, and returns both, so two
// reservations can never pass the cap together. The pull adapter owns no D1: it asks through the
// LocalComputationIngress binding it already has, and falls back to its KV count when the call fails.
// The table also lets the day's count be read from D1 (the KV count could not be read from outside).

export const TV_BUDGET_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS tv_call_budget (
  day TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0,
  last_grant INTEGER NOT NULL DEFAULT 0,
  daily INTEGER,
  updated_at TEXT
)`;
let ready = false;
export function resetTvBudgetSchemaForTests() { ready = false; }
async function ensure(db) {
  if (ready) return;
  await db.prepare(TV_BUDGET_SCHEMA_SQL).run();
  ready = true;
}

const int = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.floor(Number(x)) : 0);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reserves up to `wanted` calls of the day's `daily` budget in one statement. In an UPDATE every expression
 * reads the row as it was, so `last_grant` is the grant computed from the old count. Returns
 * { allowed, used, daily }, the same shape as the pull adapter's KV reservation.
 */
export async function reserveTvCalls(db, { day, wanted, daily, now = Date.now() } = {}) {
  if (!DAY_RE.test(String(day))) throw new Error("day must be YYYY-MM-DD");
  const w = int(wanted), cap = int(daily);
  await ensure(db);
  const row = await db.prepare(
    "INSERT INTO tv_call_budget (day, used, last_grant, daily, updated_at) VALUES (?1, min(?2, ?3), min(?2, ?3), ?3, ?4) " +
    "ON CONFLICT(day) DO UPDATE SET used = used + min(?2, max(0, ?3 - used)), last_grant = min(?2, max(0, ?3 - used)), daily = ?3, updated_at = ?4 " +
    "RETURNING used, last_grant"
  ).bind(day, w, cap, new Date(now).toISOString()).first();
  return { allowed: Number(row?.last_grant) || 0, used: Number(row?.used) || 0, daily: cap };
}

/** Gives back calls reserved for a run the gateway refused before calling TradingView. */
export async function releaseTvCalls(db, { day, count, now = Date.now() } = {}) {
  if (!DAY_RE.test(String(day)) || !(int(count) > 0)) return { used: null };
  await ensure(db);
  const row = await db.prepare("UPDATE tv_call_budget SET used = max(0, used - ?2), updated_at = ?3 WHERE day = ?1 RETURNING used")
    .bind(day, int(count), new Date(now).toISOString()).first();
  return { used: row ? Number(row.used) : null };
}

/** The day's count, or null. */
export async function readTvBudget(db, day) {
  await ensure(db);
  return (await db.prepare("SELECT day, used, daily, updated_at FROM tv_call_budget WHERE day = ?").bind(day).first()) ?? null;
}
