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


/** Pure: the stored action id ("pm:<ticket>:<bar>") of a Position Manager intent id ("pm:<ticket>:<c|s|t>:<bar>", with
 * an attempt suffix ":<n>" or the delegated prefix "d:"), or null for any other intent. */
export function actionIdOfIntent(intentId) {
  const parts = String(intentId ?? "").replace(/^d:/, "").split(":");
  if (parts[0] !== "pm" || parts.length < 4 || !/^\d+$/.test(parts[1]) || !["c", "s", "t"].includes(parts[2]) || !/^\d+$/.test(parts[3])) return null;
  return `pm:${parts[1]}:${parts[3]}`;
}

/** The stored actions of these ids (for their Telegram line), {} when none can be read. */
export async function positionActionRows(db, ids) {
  const list = [...new Set(ids.filter((x) => typeof x === "string"))].slice(0, 50);
  if (!list.length) return {};
  try {
    await ensurePositionSchema(db);
    const rows = (await db.prepare(`SELECT id, ticket, side, pips, action, rule, sl, tp, why, council, status FROM position_actions WHERE id IN (${list.map(() => "?").join(", ")})`).bind(...list).all()).results ?? [];
    return Object.fromEntries(rows.map((r) => [r.id, r]));
  } catch { return {}; }
}

/** The pending actions older than ACTION_TTL_MS, marked "expired" and returned (each once): never applied. */
export async function expireStalePositionActions(db, { now = Date.now() } = {}) {
  try {
    await ensurePositionSchema(db);
    const rows = (await db.prepare("SELECT id, ticket, side, pips, action, rule, sl, tp, why, council, status FROM position_actions WHERE status = 'pending' AND at_ms <= ? LIMIT 20").bind(now - ACTION_TTL_MS).all()).results ?? [];
    const out = [];
    for (const r of rows) {
      const res = await db.prepare("UPDATE position_actions SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(r.id).run();
      if (Number(res?.meta?.changes ?? 1) > 0) out.push(r);
    }
    return out;
  } catch { return []; }
}

/**
 * Pure: the Telegram line of one action, as it reached the broker or not (owner 2026-11-19: the line says what the
 * broker did). `outcome` is { applied: true } or { applied: false, reason }. Plain text: the sender escapes it.
 */
export function actionMessage(row, outcome = { applied: true }) {
  const what = { close: "close", sl: `stop to ${row.sl}`, tp: row.sl != null ? `target to ${row.tp} and stop to ${row.sl}` : `target to ${row.tp}` }[row.action] ?? row.action;
  const pips = row.pips == null ? "" : ` · ${row.pips >= 0 ? "+" : ""}${row.pips} pips`;
  const head = outcome?.applied === true ? `${what} · applied at the broker` : `${what} · NOT applied: ${outcome?.reason || "unknown"}`;
  return `XAUUSD POSITION MANAGER · #${row.ticket} ${row.side}${pips} · ${head}\n${row.why}${row.council ? `\nCouncil: ${row.council}` : ""}`;
}
