// Omega Execution Engine, server side (owner decisions 2026-11-09: "Omega Execution Engine pada page
// terpisah dari Nexus dan Aether"; monitor + control; its own subdomain; per-position data from the EA).
//
// The EA on the owner's MT5 terminal executes (ea/mt5/CryptophysXAUUSD.mq5). This module keeps what
// Omega shows and the one thing Omega changes:
//   control   active | paused | killed (KV EA_CONTROL_KEY, read by the signal, src/ea-signal.mjs):
//             paused stops new entries, killed makes the EA close its positions and stop. Every change
//             is audited in D1 ea_control_events with the Access identity that made it.
//   deals     each closed position the EA reports (POST /api/ea/deal), D1 ea_deals, once per deal
//             ticket: side, volume, entry and exit, P&L, the reason and the signal it came from.
//   overview  the signal, the heartbeat with its open positions, the control, the deals and their
//             statistics, for omega.cryptophys.work (RPC entrypoint OmegaGateway, src/index.ts).
// The server still never sizes a position, never places an order and never holds a broker credential.
// Unrelated to the legacy "omega" execution swarm of cryptophys-cloud-platform (prohibited, never
// migrated): nothing here signs, submits or touches anyone else's transactions.

import { CONTROL_MODES, EA_CONTROL_KEY, EA_HEARTBEAT_KEY, eaSignal, readControl } from "./ea-signal.mjs";

export const EA_EXECUTION_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS ea_deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_ticket INTEGER NOT NULL,
    position_ticket INTEGER,
    mode TEXT NOT NULL,
    side TEXT NOT NULL,
    volume REAL NOT NULL,
    entry_price REAL,
    exit_price REAL,
    stop_loss REAL,
    take_profit REAL,
    profit REAL NOT NULL,
    commission REAL NOT NULL DEFAULT 0,
    swap REAL NOT NULL DEFAULT 0,
    reason TEXT NOT NULL,
    signal_id TEXT,
    opened_ms INTEGER,
    closed_ms INTEGER NOT NULL,
    currency TEXT,
    received_at TEXT NOT NULL,
    UNIQUE (deal_ticket, closed_ms)
  )`,
  "CREATE INDEX IF NOT EXISTS ea_deals_closed ON ea_deals (closed_ms)",
  `CREATE TABLE IF NOT EXISTS ea_control_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    mode TEXT NOT NULL,
    previous_mode TEXT NOT NULL,
    reason TEXT NOT NULL,
    actor TEXT NOT NULL
  )`
];
let schemaReady = false;
export function resetEaExecutionSchemaForTests() { schemaReady = false; }
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of EA_EXECUTION_SCHEMA_SQL) await db.prepare(sql).run();
  // B-12 (2026-11-11): who opened the position (omega, manual, external, ea), for Omega's policy rollback.
  try { await db.prepare("ALTER TABLE ea_deals ADD COLUMN source TEXT").run(); } catch { /* already there */ }
  schemaReady = true;
}

const DAY_MS = 86_400_000;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
export const DEAL_SOURCES = Object.freeze(["omega", "manual", "external", "ea"]);
export const DEAL_REASONS = Object.freeze(["tp", "sl", "opposite", "kill", "expiry", "manual", "stopout", "stop_out", "expert", "closed", "other"]);

/** Pure: a closed deal from the EA's POST body (known fields only, no account number), or an error. */
export function dealFrom(body, { now = Date.now() } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body must be a JSON object" };
  const side = text(body.side, 8).toUpperCase();
  if (!(side === "BUY" || side === "SELL")) return { error: "side must be BUY or SELL" };
  if (!Number.isInteger(body.deal_ticket) || body.deal_ticket <= 0) return { error: "deal_ticket must be a positive integer" };
  if (!isNum(body.volume) || body.volume <= 0) return { error: "volume must be positive" };
  if (!isNum(body.profit)) return { error: "profit must be a number" };
  const closed = isNum(body.closed_ms) && body.closed_ms > 0 ? Math.round(body.closed_ms) : now;
  const reason = text(body.reason, 16).toLowerCase();
  const mode = text(body.mode, 10).toLowerCase();
  const price = (v) => (isNum(v) && v > 0 ? v : null);
  return {
    deal: {
      deal_ticket: body.deal_ticket,
      position_ticket: Number.isInteger(body.position_ticket) ? body.position_ticket : null,
      mode: ["demo", "live", "contest"].includes(mode) ? mode : "unknown",
      side, volume: body.volume,
      entry_price: price(body.entry_price), exit_price: price(body.exit_price),
      stop_loss: price(body.stop_loss), take_profit: price(body.take_profit),
      profit: body.profit, commission: isNum(body.commission) ? body.commission : 0, swap: isNum(body.swap) ? body.swap : 0,
      reason: DEAL_REASONS.includes(reason) ? reason : "other",
      signal_id: text(body.signal_id, 80) || null,
      opened_ms: isNum(body.opened_ms) && body.opened_ms > 0 ? Math.round(body.opened_ms) : null,
      closed_ms: closed,
      currency: text(body.currency, 8) || null
    }
  };
}

/**
 * Stores a closed deal once (a repeated report of the same deal changes nothing). Once per deal ticket:
 * the Omega bridge reports each closed deal on every sync, and its times can move by a second from one
 * sync to the next (seen 2026-11-13: 116,821 rows for 36 deals), so (deal_ticket, closed_ms) alone did not
 * hold a repeat back. An MT5 deal ticket is unique on its account.
 */
export async function storeDeal(env, body, { now = Date.now() } = {}) {
  const { deal, error } = dealFrom(body, { now });
  if (error) return { ok: false, error };
  await ensureSchema(env.DB);
  const d = deal;
  const r = await env.DB.prepare(
    `INSERT INTO ea_deals (deal_ticket, position_ticket, mode, side, volume, entry_price, exit_price, stop_loss, take_profit, profit, commission, swap, reason, signal_id, opened_ms, closed_ms, currency, received_at, source)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM ea_deals WHERE deal_ticket = ?)
     ON CONFLICT DO NOTHING`
  ).bind(d.deal_ticket, d.position_ticket, d.mode, d.side, d.volume, d.entry_price, d.exit_price, d.stop_loss, d.take_profit, d.profit, d.commission, d.swap, d.reason, d.signal_id, d.opened_ms, d.closed_ms, d.currency, new Date(now).toISOString(), DEAL_SOURCES.includes(body?.source) ? body.source : null, d.deal_ticket).run();
  return { ok: true, stored: Number(r?.meta?.changes ?? 0) > 0 };
}

/**
 * The clean-up of the duplicate deal rows stored before 2026-11-13 (owner 2026-11-13: "setuju, bersihkan
 * duplikat deal lewat PR"). Run from the 5-minute ledger step: each run deletes at most `batch` rows that are
 * not the first stored row of their deal ticket; once none is left it adds a unique index on the deal ticket,
 * after which a run only reads sqlite_master. Never throws.
 */
export const DEAL_TICKET_INDEX = "ea_deals_ticket";
export async function dedupeDeals(env, { batch = 20_000 } = {}) {
  try {
    await ensureSchema(env.DB);
    const done = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").bind(DEAL_TICKET_INDEX).first();
    if (done) return { status: "clean" };
    const n = Math.max(1, Math.min(50_000, Math.round(Number(batch) || 20_000)));
    const del = await env.DB.prepare(`DELETE FROM ea_deals WHERE id IN (SELECT id FROM ea_deals WHERE NOT (${FIRST_OF_DEAL}) LIMIT ?)`).bind(n).run();
    const deleted = Number(del?.meta?.changes ?? 0);
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ea_deals WHERE NOT (${FIRST_OF_DEAL})`).first();
    if (Number(left?.n) > 0) return { status: "cleaning", deleted, left: Number(left.n) };
    await env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS ${DEAL_TICKET_INDEX} ON ea_deals (deal_ticket)`).run();
    return { status: "cleaned", deleted };
  } catch (e) { return { status: "failed", error: String(e?.message ?? e).slice(0, 200) }; }
}

/** SQL: only the first stored row of each deal ticket (older duplicates are skipped wherever deals are read). */
export const FIRST_OF_DEAL = "id IN (SELECT MIN(id) FROM ea_deals GROUP BY deal_ticket)";

/** Recent closed deals, newest first. Never throws. */
export async function listDeals(env, { limit = 50, sinceMs = null } = {}) {
  try {
    await ensureSchema(env.DB);
    const n = Math.max(1, Math.min(500, Math.round(Number(limit) || 50)));
    // One row per deal ticket (the first stored): rows stored twice before 2026-11-13 are not counted again.
    const q = sinceMs == null
      ? env.DB.prepare(`SELECT * FROM ea_deals WHERE ${FIRST_OF_DEAL} ORDER BY closed_ms DESC LIMIT ?`).bind(n)
      : env.DB.prepare(`SELECT * FROM ea_deals WHERE closed_ms >= ? AND ${FIRST_OF_DEAL} ORDER BY closed_ms DESC LIMIT ?`).bind(sinceMs, n);
    return (await q.all())?.results || [];
  } catch { return []; }
}

/** Pure: the statistics of a list of deals (net = profit + commission + swap). */
export function dealStats(deals) {
  const nets = deals.map((d) => (d.profit ?? 0) + (d.commission ?? 0) + (d.swap ?? 0));
  const wins = nets.filter((x) => x > 0), losses = nets.filter((x) => x < 0);
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const r2 = (x) => Math.round(x * 100) / 100;
  let peak = 0, equity = 0, maxDrawdown = 0;
  for (const x of [...nets].reverse()) { equity += x; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); }
  return {
    trades: nets.length, wins: wins.length, losses: losses.length,
    win_rate: nets.length ? r2(wins.length / nets.length) : null,
    net: r2(sum(nets)),
    profit_factor: losses.length ? r2(sum(wins) / Math.abs(sum(losses))) : null,
    average_win: wins.length ? r2(sum(wins) / wins.length) : null,
    average_loss: losses.length ? r2(sum(losses) / losses.length) : null,
    max_drawdown: r2(maxDrawdown)
  };
}

/**
 * Sets the EA control. `actor` is the verified Access identity Omega passes on (a person: Omega
 * refuses a service token for a change). Returns the new control or an error.
 */
export async function setControl(env, { mode, reason = "", actor = "" } = {}, { now = Date.now() } = {}) {
  if (!CONTROL_MODES.includes(mode)) return { ok: false, error: `mode must be one of ${CONTROL_MODES.join(", ")}` };
  const who = text(actor, 200);
  if (!who) return { ok: false, error: "actor is required" };
  const why = text(reason, 200);
  if (mode !== "active" && !why) return { ok: false, error: "a reason is required to pause or kill" };
  const previous = await readControl(env);
  const control = { mode, reason: why, actor: who, at: new Date(now).toISOString() };
  await env.SIGNAL_CACHE.put(EA_CONTROL_KEY, JSON.stringify(control));
  try {
    await ensureSchema(env.DB);
    await env.DB.prepare("INSERT INTO ea_control_events (at, mode, previous_mode, reason, actor) VALUES (?, ?, ?, ?, ?)").bind(control.at, mode, previous.mode, why, who).run();
  } catch (error) {
    console.error("ea_control_audit_failed", error instanceof Error ? error.message : String(error));
  }
  return { ok: true, control, previous_mode: previous.mode };
}

/** The latest control changes, newest first. Never throws. */
export async function controlEvents(env, { limit = 20 } = {}) {
  try {
    await ensureSchema(env.DB);
    return (await env.DB.prepare("SELECT at, mode, previous_mode, reason, actor FROM ea_control_events ORDER BY id DESC LIMIT ?").bind(Math.max(1, Math.min(100, limit))).all())?.results || [];
  } catch { return []; }
}

export const HEARTBEAT_STALE_MS = 15 * 60_000;

/** Everything Omega shows, in one read. */
export async function omegaOverview(env, { now = Date.now() } = {}) {
  let heartbeat = null;
  try { heartbeat = JSON.parse((await env.SIGNAL_CACHE?.get?.(EA_HEARTBEAT_KEY)) || "null"); } catch { heartbeat = null; }
  const age = heartbeat?.received_at ? now - Date.parse(heartbeat.received_at) : null;
  const deals = await listDeals(env, { limit: 50 });
  const month = await listDeals(env, { limit: 500, sinceMs: now - 30 * DAY_MS });
  const startOfDay = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  return {
    server_ms: now,
    signal: await eaSignal(env, { now }),
    control: await readControl(env),
    heartbeat,
    ea: {
      connected: age != null && age <= HEARTBEAT_STALE_MS,
      heartbeat_age_ms: age,
      stale_after_ms: HEARTBEAT_STALE_MS
    },
    deals,
    stats: {
      today: dealStats(month.filter((d) => d.closed_ms >= startOfDay)),
      week: dealStats(month.filter((d) => d.closed_ms >= now - 7 * DAY_MS)),
      month: dealStats(month)
    },
    control_events: await controlEvents(env, { limit: 20 })
  };
}
