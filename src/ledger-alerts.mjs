// Alerts to the owner (backlog 11.2, owner decision 2026-11-08: Telegram). Each Signal Ledger event is
// sent once over the AI Worker's existing Telegram bot:
//   setup      a strategy-engine setup triggered (the H1 decision and the Decision Engine send their
//              own Telegram message, so their rows start at the entry);
//   entry      the entry price was reached;
//   exit       the first target, the stop or the time limit was reached;
//   closed     the final target or exit of a two-target setup;
//   cancelled  a setup that will no longer fill (invalidated, target first, or unfilled in its window).
// Advisory only: no order is placed and no position size is given. On the first run (empty
// ledger_alerts) every existing event is recorded as seeded without sending, so a deploy never
// floods the chat. Off with LEDGER_ALERTS_ENABLED = "false"; nothing is sent without the bot secrets.

export const LEDGER_ALERTS_VERSION = "cryptophys.ledger-alerts.v1";
export const LEDGER_ALERTS_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS ledger_alerts (
    signal_id TEXT NOT NULL,
    event TEXT NOT NULL,
    status TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (signal_id, event)
  )`
];
let schemaReady = false;
export function resetLedgerAlertsSchemaCacheForTests() { schemaReady = false; }
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of LEDGER_ALERTS_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}

export function ledgerAlertsEnabled(env) {
  return String(env?.LEDGER_ALERTS_ENABLED ?? "true").trim().toLowerCase() !== "false" && Boolean(env?.TELEGRAM_BOT_TOKEN && env?.TELEGRAM_CHAT_ID);
}

const SOURCE = { decision: "Decision Engine", strategy: "Strategy engine", h1_decision: "H1 decision" };
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const px = (x) => (finite(x) ? x.toFixed(2) : "n/a");
const rr = (x) => (finite(x) ? `${x > 0 ? "+" : ""}${Math.round(x * 100) / 100}R` : "n/a");
const hm = (t) => (typeof t === "string" ? `${t.slice(0, 16).replace("T", " ")} UTC` : "");

/** Pure: the events a ledger row has reached (in order). */
export function signalEvents(row) {
  const out = [];
  if (row.source === "strategy") out.push("setup");
  if (row.status === "cancelled") { out.push("cancelled"); return out; }
  if (row.filled_at) out.push("entry");
  if (row.exit_reason && row.status !== "cancelled") out.push("exit");
  if (row.status === "closed" && finite(row.tp2)) out.push("closed");
  return out;
}

const EXIT_WORD = { target: "TP1 reached", stop: "Stop reached", time: "Closed at the time limit" };
const CANCEL_WORD = { invalidated: "the stop level traded before the entry", target_before_entry: "the target traded before the entry", unfilled: "the entry was not reached in its window" };

/** Pure: the Telegram text of one event. */
export function formatAlert(row, event) {
  const side = row.side, who = SOURCE[row.source] ?? row.source;
  const head = `XAUUSD ALERT · ${who}`;
  const levels = `entry ${px(row.entry)}, stop ${px(row.stop)}, TP1 ${px(row.tp1)}${finite(row.tp2) ? `, TP2 ${px(row.tp2)}` : ""}`;
  let line;
  if (event === "setup") line = `Setup active: ${side} (${levels}).${finite(row.confidence) ? ` Confidence ${Math.round(row.confidence * 100)}%.` : ""}`;
  else if (event === "entry") line = `Entry reached: the ${side} from ${hm(row.opened_at)} filled at ${px(row.entry)} (${hm(row.filled_at)}).`;
  else if (event === "exit") line = `${EXIT_WORD[row.exit_reason] ?? "Exit"}: the ${side} from ${hm(row.opened_at)}, ${rr(row.r_tp1)} at ${px(row.exit_price)}.${row.status === "open" && finite(row.tp2) ? " The TP2 part stays open." : ""}`;
  else if (event === "closed") line = `Closed: the ${side} from ${hm(row.opened_at)}, ${rr(row.r_tp2)} on the TP2 part.`;
  else if (event === "cancelled") line = `Setup cancelled: the ${side} from ${hm(row.opened_at)} will not be taken; ${CANCEL_WORD[row.exit_reason] ?? "it is no longer valid"}.`;
  else line = event;
  return [head, line, "Advisory only: no order is placed and no position size is given."].join("\n");
}

/**
 * Sweep step (after runSignalLedger): sends each new event once. `send(text)` is the Telegram sender.
 * Bounded to `max` messages a run; an event whose send fails is retried by the next sweep.
 */
export async function sendLedgerAlerts(env, { send, now = Date.now(), max = 5, days = 7 } = {}) {
  if (!env?.DB) return { status: "unavailable" };
  if (!ledgerAlertsEnabled(env) || typeof send !== "function") return { status: "disabled" };
  await ensureSchema(env.DB);
  const since = new Date(now - days * 86_400_000).toISOString();
  const rows = (await env.DB.prepare("SELECT * FROM signal_ledger WHERE opened_at >= ? ORDER BY opened_at").bind(since).all()).results || [];
  const done = new Set(((await env.DB.prepare("SELECT signal_id, event FROM ledger_alerts").all()).results || []).map((r) => `${r.signal_id}|${r.event}`));
  const seeding = done.size === 0;
  const at = new Date(now).toISOString();
  const record = (id, event, status) => env.DB.prepare("INSERT INTO ledger_alerts (signal_id, event, status, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT(signal_id, event) DO NOTHING").bind(id, event, status, at).run();
  const out = { status: "ok", sent: 0, seeded: 0, failed: 0 };
  for (const row of rows) {
    for (const event of signalEvents(row)) {
      if (done.has(`${row.id}|${event}`)) continue;
      if (seeding) { await record(row.id, event, "seeded"); out.seeded += 1; continue; }
      if (out.sent >= max) { out.status = "deferred"; continue; }
      try { await send(formatAlert(row, event)); await record(row.id, event, "sent"); out.sent += 1; }
      catch { out.failed += 1; }
    }
  }
  // A first run with nothing to seed still marks the start, so the next event is sent, not seeded.
  if (seeding && out.seeded === 0) await record("_start", "seeded", "seeded");
  return out;
}

/**
 * GET /api/alerts: the alert state for the Nexus Alerts page. Read-only: never sends and never
 * creates the table. `recorded` are events already sent (or seeded at the start); `pending` are
 * events the next sweep would send (with the text). No secret value is returned, only whether the
 * bot is configured.
 */
export async function readLedgerAlerts(env, { days = 7, now = Date.now(), limit = 50 } = {}) {
  const switchOn = String(env?.LEDGER_ALERTS_ENABLED ?? "true").trim().toLowerCase() !== "false";
  const out = { version: LEDGER_ALERTS_VERSION, enabled: ledgerAlertsEnabled(env), switch_on: switchOn, bot_configured: Boolean(env?.TELEGRAM_BOT_TOKEN && env?.TELEGRAM_CHAT_ID), started: false, window_days: days, recorded: [], pending: [] };
  const db = env?.DB;
  if (!db) return out;
  const since = new Date(now - days * 86_400_000).toISOString();
  let rows = [];
  try { rows = (await db.prepare("SELECT * FROM signal_ledger WHERE opened_at >= ? ORDER BY opened_at DESC").bind(since).all()).results || []; } catch { rows = []; }
  let done = [];
  try {
    done = (await db.prepare("SELECT signal_id, event, status, sent_at FROM ledger_alerts ORDER BY sent_at DESC LIMIT 500").all()).results || [];
    out.started = true;
  } catch { done = []; }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const doneKeys = new Set(done.map((d) => `${d.signal_id}|${d.event}`));
  out.recorded = done.filter((d) => d.signal_id !== "_start").slice(0, limit).map((d) => {
    const row = byId.get(d.signal_id);
    return { signal_id: d.signal_id, event: d.event, status: d.status, at: d.sent_at, source: row?.source ?? null, side: row?.side ?? null, text: row ? formatAlert(row, d.event) : null };
  });
  // Before the first run every existing event would be seeded, not sent: nothing is pending then.
  if (out.started && done.length) {
    for (const row of [...rows].reverse()) for (const event of signalEvents(row)) {
      if (!doneKeys.has(`${row.id}|${event}`)) out.pending.push({ signal_id: row.id, event, source: row.source, side: row.side, text: formatAlert(row, event) });
    }
    out.pending = out.pending.slice(0, limit);
  }
  return out;
}
