// The Position Manager's stored actions (src/position-manager.mjs): the table, and what the Omega sync reads and marks.
// Kept apart so the Omega Worker reads them without the model call. Owner 2026-11-17.

/** An action older than this is not applied by Omega (the price moved on). */
export const ACTION_TTL_MS = 6 * 60_000;

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS position_actions (id TEXT PRIMARY KEY, ticket INTEGER NOT NULL, bar INTEGER NOT NULL, at_ms INTEGER NOT NULL,
    side TEXT NOT NULL, pips REAL, price REAL, action TEXT NOT NULL, rule TEXT NOT NULL, sl REAL, tp REAL, why TEXT, council TEXT,
    orig_sl REAL, orig_tp REAL, basis REAL, status TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS position_actions_status ON position_actions (status, at_ms)"
];
let ready = null;
/** Creates the table once per isolate (the Omega sync reads every few seconds). */
export async function ensurePositionSchema(db) {
  if (ready === db) return;
  for (const q of SCHEMA_SQL) await db.prepare(q).run();
  ready = db;
}
export function resetPositionSchemaCacheForTests() { ready = null; }

/** The pending actions Omega applies (fresh, newest per ticket), read by the Omega sync. */
export async function pendingPositionActions(db, { now = Date.now() } = {}) {
  try {
    await ensurePositionSchema(db);
    const rows = (await db.prepare("SELECT id, ticket, action, rule, sl, tp, at_ms FROM position_actions WHERE status = 'pending' AND at_ms > ? ORDER BY at_ms DESC").bind(now - ACTION_TTL_MS).all()).results ?? [];
    const seen = new Set(), out = [];
    for (const r of rows) { if (seen.has(r.ticket)) continue; seen.add(r.ticket); out.push(r); }
    return out;
  } catch { return []; }
}
export async function markPositionActions(db, ids, status) {
  for (const id of ids) await db.prepare("UPDATE position_actions SET status = ? WHERE id = ?").bind(status, id).run();
}

