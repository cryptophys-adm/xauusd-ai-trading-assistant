// Omega broker engine, storage and the bridge sync (owner decisions 2026-11-09, docs/OMEGA_BRIDGE_PROTOCOL.md).
//
// D1 tables (created lazily, one row each where noted):
//   omega_settings    (one row) the engine settings set on the Omega page
//   omega_connection  (one row) the broker connection: server name, version, status and the envelope
//                     the browser encrypted to the bridge's public key. The server cannot read the
//                     login or the password: only the bridge holds the private key.
//   omega_bridge      (one row) the bridge's key id, public key, its last executor state (never a login)
//   omega_intents     order intents planned by src/omega-engine.mjs and their results
//   omega_events      audit: who changed what, and each sync's planner notes when they change
// Statuses: connection none | stored | needs_reentry | cleared; intent pending → sent → done | failed,
// or expired when the bridge did not report it within INTENT_TTL_MS.

import { ingestCorpus, ingestCorpusMacro, ingestMt5Calendar } from "./corpus-oracle.mjs";
import { goldClosedAt } from "./market-hours.mjs";
import { eaSignal, readControl, blackoutWindow } from "./ea-signal.mjs";
import { storeDeal, dealStats, FIRST_OF_DEAL } from "./ea-execution.mjs";
import { gatedEvents } from "./econ-calendar.mjs";
import { OMEGA_DEFAULTS, planIntents, settingsFrom } from "./omega-engine.mjs";
import { pendingPositionActions, markPositionActions } from "./position-actions.mjs";
import { strategyArmMode, readArmState, disarmAll, dailyLossHit } from "./strategy-arm.mjs";
import { goldSymbolCheck, goldSymbolText } from "./gold-symbol.mjs";
import { runProfileAgent, ownerSetProfile, accountHistory } from "./profile-agent.mjs";
import { reviewProfileChange, downgradeCouncilOn, lastCouncilReviews } from "./profile-council.mjs";
import { brokerLabelFor, dailyLossExecutor, onboardingDayRef } from "./account-spec.mjs";
import { syncAccount, readAccounts, resetAccountSpecSchemaForTests, specStatusText, eaVersionGateOn, versionAtLeast as specVersionAtLeast, EXECUTOR_ENTRY_MIN_VERSION, PROFILES, effectiveLimits } from "./account-spec.mjs";

export const OMEGA_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS omega_settings (id INTEGER PRIMARY KEY CHECK (id = 1), settings TEXT NOT NULL, version INTEGER NOT NULL, updated_by TEXT, updated_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS omega_connection (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, status TEXT NOT NULL, server TEXT, kid TEXT, envelope TEXT, updated_by TEXT, updated_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS omega_bridge (id INTEGER PRIMARY KEY CHECK (id = 1), kid TEXT, public_key TEXT, bridge_version TEXT, state TEXT, synced_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS omega_intents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS omega_intents_created ON omega_intents (created_ms)",
  // Resource audit P0 (2026-11-14): the bridge sync reads the pending and sent intents every 5 seconds.
  "CREATE INDEX IF NOT EXISTS omega_intents_status ON omega_intents (status, created_ms)",
  `CREATE TABLE IF NOT EXISTS omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT)`,
  // Resource audit (owner 2026-11-14, "B. penuh"): the sync's last plan note and the last recovery are read by
  // action, newest first; without it each read walked back over every newer event.
  "CREATE INDEX IF NOT EXISTS omega_events_action ON omega_events (action, id)"
];
export const INTENT_TTL_MS = 2 * 60_000;
export const STATE_MAX_BYTES = 64 * 1024;
export const ENVELOPE_MAX_BYTES = 8 * 1024;
const BRIDGE_SEEN_MS = 2 * 60_000;
/**
 * The bridge row is written when something that matters changed (key, version, connection, trading
 * permission, error, executor, account mode or currency, the open positions' and orders' tickets and stops,
 * the deals)
 * and otherwise at most every BRIDGE_WRITE_EVERY_MS (resource audit, owner 2026-11-14: "B. penuh tanpa fase
 * shadow"). Every sync wrote it, about 17,000 writes a day, because the quote and the equity change at
 * every tick. The planner never reads it: it plans on the state of the sync itself. The readers (Omega's
 * page, the health check, the watchdog) see the last quote and the sync time at most this much later; the
 * watchdog's thresholds (2 minutes for the bridge, 1 minute for the terminal state) stay well above it.
 */
export const BRIDGE_WRITE_EVERY_MS = 30_000;
/** Pure: the part of the executor state whose change is written at once (prices, equity and times excluded). */
export function bridgeStateKey(executor) {
  if (!executor) return "null";
  const positions = Array.isArray(executor.positions)
    ? executor.positions.map((p) => [p?.ticket ?? null, p?.side ?? null, p?.volume ?? null, p?.sl ?? null, p?.tp ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    : null;
  const orders = Array.isArray(executor.orders)
    ? executor.orders.map((o) => [o?.ticket ?? null, o?.type ?? null, o?.volume_current ?? null, o?.price_open ?? null, o?.sl ?? null, o?.tp ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    : null;
  const deals = Array.isArray(executor.deals) ? executor.deals.map((d) => d?.deal_ticket ?? null).sort() : null;
  return JSON.stringify([executor.connected, executor.trade_allowed, executor.server, executor.terminal_error, executor.executor, executor.account?.trade_mode, executor.account?.currency, executor.symbol?.name, executor.symbol?.currency_profit ?? null, executor.symbol?.contract_size ?? null, executor.symbol_error ?? null, executor.bridge_symbol?.status ?? null, executor.bridge_symbol?.chart_symbol ?? null, positions, orders, deals]);
}
// The deal tickets stored (or found stored with their source) per database binding: the bridge reports each
// closed deal on every sync (2026-11-13: 36 deals), and each report cost an insert attempt and an update.
const STORED_DEALS = new WeakMap();
function storedDeals(db) {
  let set = STORED_DEALS.get(db);
  if (!set) { set = new Set(); STORED_DEALS.set(db, set); }
  if (set.size > 2000) set.clear();
  return set;
}
const SERVER_RE = /^[A-Za-z0-9._ -]{1,64}$/;
const KID_RE = /^[0-9a-f]{16}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

let schemaReady = false;
export function resetOmegaBrokerSchemaForTests() { schemaReady = false; resetAccountSpecSchemaForTests(); }
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of OMEGA_SCHEMA_SQL) await db.prepare(sql).run();
  await db.prepare("INSERT OR IGNORE INTO omega_settings (id, settings, version) VALUES (1, ?, 0)").bind(JSON.stringify(OMEGA_DEFAULTS)).run();
  await db.prepare("INSERT OR IGNORE INTO omega_connection (id, version, status) VALUES (1, 0, 'none')").run();
  await db.prepare("INSERT OR IGNORE INTO omega_bridge (id) VALUES (1)").run();
  schemaReady = true;
}
const parse = (text, fallback = null) => { try { return text == null ? fallback : JSON.parse(text); } catch { return fallback; } };
const event = (db, ms, actor, action, detail) =>
  db.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, ?, ?, ?)").bind(ms, String(actor || "system"), action, detail == null ? null : JSON.stringify(detail)).run();
export const engineEnvEnabled = (env) => env?.OMEGA_ENGINE_ENABLED === "true";

/** The strategy agent each open position's open intent recorded ({ intent id: agent }); {} when none can be read. */
export async function positionAgents(db, executor) {
  const ids = [...new Set((Array.isArray(executor?.positions) ? executor.positions : []).map((p) => p?.intent_id).filter((x) => typeof x === "string" && x.startsWith("open:")))].slice(0, 50);
  if (!ids.length) return {};
  try {
    const rows = (await db.prepare(`SELECT id, payload FROM omega_intents WHERE kind = 'open' AND id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).all()).results ?? [];
    const out = {};
    for (const r of rows) { const a = parse(r.payload)?.strategy; if (typeof a === "string" && a) out[r.id] = a; }
    return out;
  } catch {
    return {};
  }
}

/**
 * An open the terminal filled but whose result line never reached the Worker (2026-11-18: ticket 389746494 was
 * open with its intent id while the intent had no result and expired). The open position that carries the intent id
 * is the terminal's own word that it ran, so the intent is recorded as done from the position, once, with an event
 * and the executed line on Telegram. A result that arrives later does not overwrite it (status 'done' is final).
 */
export async function reconcileFilledOpens(env, db, executor, now) {
  const byId = new Map();
  for (const p of Array.isArray(executor?.positions) ? executor.positions : []) {
    if (typeof p?.intent_id === "string" && p.intent_id.startsWith("open:") && Number(p?.ticket) > 0 && !byId.has(p.intent_id)) byId.set(p.intent_id, p);
  }
  if (!byId.size) return 0;
  const ids = [...byId.keys()].slice(0, 50);
  let rows = [];
  try {
    rows = (await db.prepare(`SELECT id, payload, created_ms FROM omega_intents WHERE kind = 'open' AND result IS NULL AND status IN ('pending', 'sent', 'expired') AND id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).all()).results ?? [];
  } catch {
    return 0;
  }
  let count = 0;
  for (const row of rows) {
    const pos = byId.get(row.id);
    const p = parse(row.payload, {});
    const openedMs = Number(pos.opened_ms);
    const fill = Number(pos.open_price);
    const result = {
      ok: true,
      ticket: Number(pos.ticket),
      error: null,
      executed_ms: Number.isFinite(openedMs) && openedMs > 0 ? openedMs : null,
      fill_price: Number.isFinite(fill) && fill > 0 ? fill : null,
      slippage_pts: null,
      latency_ms: Number.isFinite(openedMs) && openedMs > 0 && Number.isFinite(row.created_ms) ? Math.max(0, openedMs - Number(row.created_ms)) : null,
      reconciled: true,
    };
    const res = await db.prepare("UPDATE omega_intents SET status = 'done', result = ?, updated_ms = ? WHERE id = ? AND result IS NULL")
      .bind(JSON.stringify(result), now, row.id).run();
    if (!(Number(res?.meta?.changes ?? 1) > 0)) continue;
    count += 1;
    await event(db, now, "bridge", "intent_reconciled", { id: row.id, ticket: result.ticket });
    const label = await brokerLabelFor(db, executor);
    await sendOmegaTelegram(env, `🟢 <b>Omega Order Executed · ${label}</b>\nTicket: <code>#${result.ticket}</code>\nSide: <b>${p.side ?? pos.side ?? "—"}</b> | Volume: <code>${p.volume ?? pos.volume ?? "—"}</code>\nEntry: <code>${p.entry || "—"}</code> | Fill: <code>${result.fill_price ?? "—"}</code>\nSL: <code>${pos.sl ?? p.sl ?? "—"}</code> | TP: <code>${pos.tp ?? p.tp ?? "—"}</code>\nRecorded from the open position: the EA's result line did not arrive.`);
  }
  return count;
}

export async function sendOmegaTelegram(env, message) {
  if (!env?.TELEGRAM_BOT_TOKEN || !env?.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
  } catch {
    /* non-blocking notification */
  }
}

// ---------------------------------------------------------------- settings

export async function readSettings(env) {
  await ensureSchema(env.DB);
  const row = await env.DB.prepare("SELECT settings, version, updated_by, updated_ms FROM omega_settings WHERE id = 1").first();
  return { settings: { ...OMEGA_DEFAULTS, ...parse(row?.settings, {}) }, version: Number(row?.version ?? 0), updated_by: row?.updated_by ?? null, updated_ms: row?.updated_ms ?? null };
}

export async function writeSettings(env, { body, actor }, { now = Date.now() } = {}) {
  const current = await readSettings(env);
  const r = settingsFrom(body, current.settings);
  if (r.error) return { ok: false, error: r.error };
  const version = current.version + 1;
  await env.DB.prepare("UPDATE omega_settings SET settings = ?, version = ?, updated_by = ?, updated_ms = ? WHERE id = 1").bind(JSON.stringify(r.settings), version, actor, now).run();
  await event(env.DB, now, actor, "settings", r.settings);
  return { ok: true, settings: r.settings, version };
}

// ---------------------------------------------------------------- connection

function envelopeError(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return "envelope must be an object";
  if (envelope.v !== 1) return "envelope.v must be 1";
  if (typeof envelope.kid !== "string" || !KID_RE.test(envelope.kid)) return "envelope.kid is invalid";
  for (const k of ["wrapped_key", "iv", "ciphertext"]) if (typeof envelope[k] !== "string" || !envelope[k] || !B64_RE.test(envelope[k])) return `envelope.${k} must be base64`;
  if (atob(envelope.iv).length !== 12) return "envelope.iv must be 12 bytes";
  if (atob(envelope.wrapped_key).length !== 384) return "envelope.wrapped_key must be an RSA-3072 block";
  if (atob(envelope.ciphertext).length < 17) return "envelope.ciphertext is too short";
  return null;
}

export async function connectionStatus(env) {
  await ensureSchema(env.DB);
  const row = await env.DB.prepare("SELECT version, status, server, kid, updated_by, updated_ms FROM omega_connection WHERE id = 1").first();
  return { version: Number(row.version), status: row.status, server: row.server ?? null, kid: row.kid ?? null, updated_by: row.updated_by ?? null, updated_ms: row.updated_ms ?? null };
}

export async function setConnection(env, { envelope, server, actor }, { now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  const name = typeof server === "string" ? server.trim() : "";
  if (!SERVER_RE.test(name)) return { ok: false, error: "server must be 1-64 letters, digits, dot, dash, underscore or space" };
  const bad = envelopeError(envelope);
  if (bad) return { ok: false, error: bad };
  const text = JSON.stringify(envelope);
  if (text.length > ENVELOPE_MAX_BYTES) return { ok: false, error: "envelope_too_large" };
  const bridge = await env.DB.prepare("SELECT kid FROM omega_bridge WHERE id = 1").first();
  if (!bridge?.kid) return { ok: false, error: "bridge_not_seen" };
  if (bridge.kid !== envelope.kid) return { ok: false, error: "kid_mismatch" };
  const cur = await connectionStatus(env);
  const version = cur.version + 1;
  await env.DB.prepare("UPDATE omega_connection SET version = ?, status = 'stored', server = ?, kid = ?, envelope = ?, updated_by = ?, updated_ms = ? WHERE id = 1")
    .bind(version, name, envelope.kid, text, actor, now).run();
  await event(env.DB, now, actor, "connection_set", { server: name, version });
  return { ok: true, version, status: "stored", server: name };
}

export async function clearConnection(env, { actor, reason }, { now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  const why = typeof reason === "string" ? reason.trim().slice(0, 200) : "";
  if (!why) return { ok: false, error: "a reason is required to disconnect" };
  const cur = await connectionStatus(env);
  const version = cur.version + 1;
  await env.DB.prepare("UPDATE omega_connection SET version = ?, status = 'cleared', server = NULL, envelope = NULL, updated_by = ?, updated_ms = ? WHERE id = 1").bind(version, actor, now).run();
  await env.DB.prepare("UPDATE omega_bridge SET state = NULL WHERE id = 1").run();
  await event(env.DB, now, actor, "connection_cleared", { reason: why, version });
  return { ok: true, version, status: "cleared" };
}

/** GET /api/bridge/key: the key the page encrypts the credentials to. */
export async function bridgeKey(env, { now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  const row = await env.DB.prepare("SELECT kid, public_key, synced_ms FROM omega_bridge WHERE id = 1").first();
  if (!row?.kid || !row?.public_key) return null;
  return { kid: row.kid, public_key: row.public_key, synced_age_ms: now - Number(row.synced_ms) };
}

// ---------------------------------------------------------------- bridge sync

/** The minimum OmegaExecutor that leaves stop and target to Omega and reports it (owner 2026-11-12). */
export const EXECUTOR_MIN_VERSION = "1.12";
const versionAtLeast = (v, min) => {
  const a = String(v).split(".").map(Number), b = String(min).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x > y; }
  return true;
};

/**
 * Pure: the executor's self-report (OmegaExecutor 1.12+): { name, version, auto_break_even, trailing_stop,
 * dynamic_atr_stop, local_management, up_to_date }, or null when the EA reports nothing (1.11 and older).
 * `local_management` is true while the EA still moves stops on the terminal beside Omega.
 */
export function executorInfoFrom(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const version = typeof x.version === "string" && /^\d+(\.\d+){0,3}$/.test(x.version) ? x.version : null;
  const flag = (v) => (typeof v === "boolean" ? v : null);
  const be = flag(x.auto_break_even), tr = flag(x.trailing_stop);
  return {
    name: typeof x.name === "string" ? x.name.replace(/[^\w.-]/g, "").slice(0, 32) : null,
    version, auto_break_even: be, trailing_stop: tr, dynamic_atr_stop: flag(x.dynamic_atr_stop),
    local_management: be === true || tr === true,
    up_to_date: version != null && versionAtLeast(version, EXECUTOR_MIN_VERSION)
  };
}

const BRIDGE_SYMBOL_STATUSES = new Set(["confirmed", "trial", "exhausted", "stopped", "none"]);
/** The bridge's chart-symbol resolution for the applied server (omega-bridge 1.3.0+), checked; else null. */
export function bridgeSymbolFrom(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const s = (x, k) => (typeof x === "string" && x ? x.slice(0, k) : null);
  return {
    status: BRIDGE_SYMBOL_STATUSES.has(v.status) ? v.status : null,
    server: s(v.server, 64),
    chart_symbol: s(v.chart_symbol, 32),
    learned: s(v.learned, 32),
    tried: Array.isArray(v.tried) ? v.tried.filter((x) => typeof x === "string").slice(0, 20).map((x) => x.slice(0, 32)) : [],
    error: s(v.error, 120),
    since_ms: typeof v.since_ms === "number" && Number.isFinite(v.since_ms) ? v.since_ms : null
  };
}

/** The executor state as the bridge reports it; anything malformed is null (the engine then waits). */
export function executorFrom(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const a = state.account ?? {}, s = state.symbol ?? {};
  return {
    connected: state.connected === true,
    trade_allowed: typeof state.trade_allowed === "boolean" ? state.trade_allowed : (state.connected === true ? true : null),
    server: typeof state.server === "string" ? state.server.slice(0, 64) : null,
    received_ms: n(state.received_ms),
    terminal_error: typeof state.terminal_error === "string" ? state.terminal_error.slice(0, 200) : null,
    // OmegaExecutor 1.12+: its version and whether it still moves stops by itself (null when not reported).
    executor: executorInfoFrom(state.executor),
    account: {
      trade_mode: ["demo", "real", "contest"].includes(a.trade_mode) ? a.trade_mode : null, currency: typeof a.currency === "string" ? a.currency.slice(0, 8) : null, balance: n(a.balance), equity: n(a.equity), day_start_balance: n(a.day_start_balance), day_realized_pl: n(a.day_realized_pl),
      // OmegaExecutor 1.15+ (docs/RFC_ACCOUNT_PROFILES.md §1): the account spec, and an opaque hash in place of the login.
      leverage: n(a.leverage),
      margin_mode: ["hedging", "netting", "exchange", "unknown"].includes(a.margin_mode) ? a.margin_mode : null,
      margin_free: n(a.margin_free),
      login_hash: typeof a.login_hash === "string" && /^[0-9a-f]{64}$/.test(a.login_hash) ? a.login_hash : null
    },
    symbol: {
      name: typeof s.name === "string" ? s.name.slice(0, 32) : null,
      digits: Number.isInteger(s.digits) ? s.digits : null,
      point: n(s.point),
      tick_size: n(s.tick_size),
      tick_value: n(s.tick_value),
      volume_min: n(s.volume_min),
      volume_max: n(s.volume_max),
      volume_step: n(s.volume_step),
      stops_level_points: n(s.stops_level_points),
      bid: n(s.bid),
      ask: n(s.ask),
      spread_points: n(s.spread_points),
      atr_value: n(s.atr_value),
      atr_points: n(s.atr_points),
      // OmegaExecutor 1.14+ (PR #405): the contract, checked by goldSymbolCheck before any entry.
      chart: typeof s.chart === "string" ? s.chart.slice(0, 32) : null,
      currency_profit: typeof s.currency_profit === "string" ? s.currency_profit.slice(0, 8) : null,
      currency_base: typeof s.currency_base === "string" ? s.currency_base.slice(0, 8) : null,
      contract_size: n(s.contract_size),
      // OmegaExecutor 1.15+: the freeze level, the symbol's trade mode and the margin one lot needs (OrderCalcMargin).
      freeze_level_points: n(s.freeze_level_points),
      trade_mode: ["full", "long_only", "short_only", "close_only", "disabled", "unknown"].includes(s.trade_mode) ? s.trade_mode : null,
      margin_per_lot: n(s.margin_per_lot)
    },
    // The EA's own refusal when no allowed USD gold symbol trades on the server (1.14+), else null.
    symbol_error: typeof state.symbol_error === "string" && state.symbol_error ? state.symbol_error.slice(0, 96) : null,
    // The bridge's per-server chart-symbol resolution (omega-bridge 1.3.0+), else null.
    bridge_symbol: bridgeSymbolFrom(state.bridge_symbol),
    positions: (Array.isArray(state.positions) ? state.positions : []).slice(0, 50).map((p) => ({
      ticket: n(p?.ticket),
      symbol: typeof p?.symbol === "string" ? p.symbol.slice(0, 32) : null,
      side: p?.side === "BUY" || p?.side === "SELL" ? p.side : null,
      volume: n(p?.volume),
      open_price: n(p?.open_price),
      sl: n(p?.sl),
      tp: n(p?.tp),
      profit: n(p?.profit),
      intent_id: typeof p?.intent_id === "string" ? p.intent_id.slice(0, 31) : null,
      magic: Number.isInteger(p?.magic) ? p.magic : null,
      source: typeof p?.source === "string" ? p.source.slice(0, 16) : null,
      opened_ms: n(p?.opened_ms)
    })),
    orders: (Array.isArray(state.orders) ? state.orders : []).slice(0, 50).map((o) => ({
      ticket: n(o?.ticket),
      symbol: typeof o?.symbol === "string" ? o.symbol.slice(0, 32) : null,
      type: typeof o?.type === "string" ? o.type.slice(0, 16) : null,
      volume_initial: n(o?.volume_initial),
      volume_current: n(o?.volume_current),
      price_open: n(o?.price_open),
      sl: n(o?.sl),
      tp: n(o?.tp),
      comment: typeof o?.comment === "string" ? o.comment.slice(0, 64) : null,
      magic: Number.isInteger(o?.magic) ? o.magic : null,
      source: typeof o?.source === "string" ? o.source.slice(0, 16) : null,
      placed_ms: n(o?.placed_ms)
    })),
    deals: (Array.isArray(state.deals) ? state.deals : []).slice(0, 100).map((d) => ({
      deal_ticket: n(d?.deal_ticket),
      position_ticket: n(d?.position_ticket),
      symbol: typeof d?.symbol === "string" ? d.symbol.slice(0, 32) : null,
      side: d?.side === "BUY" || d?.side === "SELL" ? d.side : null,
      volume: n(d?.volume),
      entry_price: n(d?.entry_price),
      exit_price: n(d?.exit_price),
      profit: n(d?.profit),
      commission: n(d?.commission),
      swap: n(d?.swap),
      reason: typeof d?.reason === "string" ? d.reason.slice(0, 16) : null,
      signal_id: typeof d?.signal_id === "string" ? d.signal_id.slice(0, 80) : null,
      magic: Number.isInteger(d?.magic) ? d.magic : null,
      source: typeof d?.source === "string" ? d.source.slice(0, 16) : null,
      opened_ms: n(d?.opened_ms),
      closed_ms: n(d?.closed_ms)
    }))
  };
}

export const CLOSE_MAX_ATTEMPTS = 10;
/**
 * The bridge never executes an id twice. An open is planned once per signal and never retried. A
 * close or close_all that is still needed after its attempts ended (failed, expired, or done while the
 * position is still there) gets the next attempt id `<id>:<n>`; none while an attempt is in flight.
 */
async function withAttempt(db, it) {
  if (it.kind === "open") return it;
  const rows = (await db.prepare("SELECT id, status FROM omega_intents WHERE id = ? OR id LIKE ?").bind(it.id, `${it.id}:%`).all()).results ?? [];
  if (!rows.length) return it;
  if (rows.some((r) => r.status === "pending" || r.status === "sent")) return null;
  if (rows.length >= CLOSE_MAX_ATTEMPTS) return null;
  return { ...it, id: `${it.id}:${rows.length}` };
}

/**
 * Pure: what Omega makes of the executor's self-report, for the pages: `status` "ok" (current, local
 * management off), "local_management" (the EA still moves stops beside Omega), "outdated" (older than
 * EXECUTOR_MIN_VERSION) or "unknown" (it reports nothing: 1.11 or older), with a line to show.
 */
export function executorStatus(info) {
  if (!info) return { status: "unknown", version: null, auto_break_even: null, trailing_stop: null, note: `OmegaExecutor does not report its version or inputs: install ${EXECUTOR_MIN_VERSION} or newer` };
  const base = { version: info.version, auto_break_even: info.auto_break_even, trailing_stop: info.trailing_stop, dynamic_atr_stop: info.dynamic_atr_stop };
  if (info.local_management) {
    const on = [info.auto_break_even ? "AutoBreakEvenEnabled" : null, info.trailing_stop ? "TrailingStopEnabled" : null].filter(Boolean).join(" and ");
    return { status: "local_management", ...base, note: `${on} still on in the EA: it moves stops beside Omega; set false in its inputs (F7)` };
  }
  if (!info.up_to_date) return { status: "outdated", ...base, note: `OmegaExecutor ${info.version ?? "?"} is older than ${EXECUTOR_MIN_VERSION}` };
  return { status: "ok", ...base, note: `OmegaExecutor ${info.version}: stop and target left to Omega` };
}

/**
 * One bridge sync: store its key and state, apply its results, plan, and return what it must do.
 * @returns {{ intents: object[], connection: null | object, settings_version: number }}
 */
export async function bridgeSync(env, { state, results, publicKey, kid, bridgeVersion, corpus = null, corpusMacro = null, calendar = null, bridgeSymbol = null } = {}, { now = Date.now(), signal: signalIn } = {}) {
  await ensureSchema(env.DB);
  const db = env.DB;
  if (typeof kid !== "string" || !KID_RE.test(kid) || typeof publicKey !== "string" || !B64_RE.test(publicKey) || publicKey.length > 1024) return { ok: false, error: "kid and public_key are required" };
  const executor = executorFrom(state);
  // omega-bridge 1.3.0+ reports its chart-symbol resolution beside the state (also while no EA runs).
  const resolution = bridgeSymbolFrom(bridgeSymbol);
  if (executor && resolution) executor.bridge_symbol = resolution;
  // The account's opaque login hash (OmegaExecutor 1.15) is used for its reference in this sync only, never stored
  // with the state that the pages, the health check and the watchdog read.
  const stateText = JSON.stringify(executor, (k, v) => (k === "login_hash" ? undefined : v));
  if (stateText.length > STATE_MAX_BYTES) return { ok: false, error: "state_too_large" };

  const prev = await db.prepare("SELECT kid, public_key, bridge_version, state, synced_ms FROM omega_bridge WHERE id = 1").first();
  const version = String(bridgeVersion ?? "").slice(0, 32);
  const changed = !prev || prev.kid !== kid || prev.public_key !== publicKey || (prev.bridge_version ?? "") !== version
    || bridgeStateKey(parse(prev.state)) !== bridgeStateKey(executor);
  const due = !(Number(prev?.synced_ms) > 0) || now - Number(prev.synced_ms) >= BRIDGE_WRITE_EVERY_MS || now < Number(prev.synced_ms);
  if (changed || due) {
    await db.prepare("UPDATE omega_bridge SET kid = ?, public_key = ?, bridge_version = ?, state = ?, synced_ms = ? WHERE id = 1")
      .bind(kid, publicKey, version, stateText, now).run();
  }
  if (prev?.kid && prev.kid !== kid) await event(db, now, "bridge", "bridge_key_changed", { from: prev.kid, to: kid });
  // The bridge found no chart symbol the server has (exhausted) or stopped on a login failure: an event once per
  // change, which the health alert reads while no fresh, verified state says otherwise.
  if (resolution && (resolution.status === "exhausted" || resolution.status === "stopped")) {
    const last = await db.prepare("SELECT detail FROM omega_events WHERE action = 'bridge_symbol' ORDER BY id DESC LIMIT 1").first();
    const was = parse(last?.detail, {});
    if (was?.status !== resolution.status || was?.server !== resolution.server) await event(db, now, "bridge", "bridge_symbol", resolution);
  }
  // The traded symbol is never silent (owner 2026-11-17, PR #405): a change on the same server and a refusal
  // (not USD gold, or the EA's own symbol_error) are events on the Omega page; the health alert says it too.
  if (executor) {
    const before = parse(prev?.state);
    const name = executor.symbol?.name ?? null, prevName = before?.symbol?.name ?? null;
    if (name && prevName && name !== prevName && before?.server === executor.server) {
      await event(db, now, "bridge", "symbol_changed", { server: executor.server, from: prevName, to: name });
    }
    const check = goldSymbolCheck(executor.symbol, executor.symbol_error);
    const prevCheck = before ? goldSymbolCheck(before.symbol, before.symbol_error) : null;
    if (!check.ok && (prevCheck?.ok !== false || prevCheck.problem !== check.problem || prevName !== name)) {
      await event(db, now, "bridge", "symbol_refused", { server: executor.server, symbol: name, problem: check.problem, currency_profit: executor.symbol?.currency_profit ?? null, contract_size: executor.symbol?.contract_size ?? null });
    }
  }

  // Persist closed deals reported by MT5 terminal
  if (Array.isArray(executor?.deals) && executor.deals.length > 0) {
    const known = storedDeals(db);
    for (const d of executor.deals) {
      if (!d?.deal_ticket || !d?.closed_ms) continue;
      // Stored before, with its source when it has one: nothing to write.
      const seenKey = `${d.deal_ticket}|${d.source ?? ""}`;
      if (known.has(seenKey)) continue;
      try {
        const stored = await storeDeal(env, {
          deal_ticket: d.deal_ticket,
          position_ticket: d.position_ticket,
          mode: executor?.account?.trade_mode || "unknown",
          side: d.side || "BUY",
          volume: d.volume || 0.01,
          entry_price: d.entry_price,
          exit_price: d.exit_price,
          profit: d.profit || 0,
          commission: d.commission || 0,
          swap: d.swap || 0,
          reason: d.reason || "closed",
          signal_id: d.signal_id,
          opened_ms: d.opened_ms,
          closed_ms: d.closed_ms,
          currency: executor?.account?.currency || "USD",
          source: d.source
        }, { now });
        if (stored?.ok) known.add(seenKey);
      } catch {
        // Ignored; deals persistence should not disrupt sync cycle
      }
    }
  }

  for (const r of Array.isArray(results) ? results.slice(0, 100) : []) {
    if (typeof r?.id !== "string") continue;
    const existing = await db.prepare("SELECT status, payload, created_ms FROM omega_intents WHERE id = ?").bind(r.id).first();
    const p = parse(existing?.payload, {});
    const latencyMs = (Number.isFinite(r.executed_ms) && Number.isFinite(existing?.created_ms)) ? Math.max(0, Number(r.executed_ms) - Number(existing.created_ms)) : null;
    const result = {
      ok: r.ok === true,
      ticket: Number.isFinite(r.ticket) ? r.ticket : null,
      error: typeof r.error === "string" ? r.error.slice(0, 200) : null,
      executed_ms: Number.isFinite(r.executed_ms) ? r.executed_ms : null,
      fill_price: Number.isFinite(r.fill_price) ? r.fill_price : null,
      slippage_pts: Number.isFinite(r.slippage_pts) ? r.slippage_pts : null,
      latency_ms: latencyMs,
    };
    // A late result still lands on an expired intent: the terminal is the truth about what happened.
    await db.prepare("UPDATE omega_intents SET status = ?, result = ?, updated_ms = ? WHERE id = ? AND status IN ('pending', 'sent', 'expired')")
      .bind(result.ok ? "done" : "failed", JSON.stringify(result), now, r.id).run();
    if (existing && (existing.status === "pending" || existing.status === "sent")) {
      // The broker label of this terminal, e.g. "FxPro (DEMO) · GOLD"; "broker unknown" until its spec is validated.
      const label = await brokerLabelFor(db, executor);
      if (result.ok) {
        if (p?.kind === "open") {
          const tcaText = (result.slippage_pts != null || latencyMs != null)
            ? `\nLatency: <code>${latencyMs != null ? `${latencyMs}ms` : "—"}</code> | Slippage: <code>${result.slippage_pts != null ? `${result.slippage_pts} pts` : "0 pts"}</code>`
            : "";
          await sendOmegaTelegram(env, `🟢 <b>Omega Order Executed · ${label}</b>\nTicket: <code>#${result.ticket || "—"}</code>\nSide: <b>${p.side}</b> | Volume: <code>${p.volume}</code>\nEntry: <code>${p.entry || "—"}</code> | Fill: <code>${result.fill_price || p.entry || "—"}</code>\nSL: <code>${p.sl}</code> | TP: <code>${p.tp}</code>${tcaText}`);
        } else if (p?.kind === "close" || p?.kind === "partial_close") {
          await sendOmegaTelegram(env, `💰 <b>Omega Position ${p.kind === "partial_close" ? `Scaled Out (${p.volume ?? "part"} lot)` : "Closed"} · ${label}</b>\nTicket: <code>#${result.ticket || p.ticket || "—"}</code>\nReason: <code>${p.reason || "executed"}</code>`);
        } else if (p?.kind === "modify_tp") {
          await sendOmegaTelegram(env, `🎯 <b>Extended TP Expanded (Runner) · ${label}</b>\nTicket: <code>#${p.ticket}</code>\nNew TP: <code>${p.tp}</code>`);
        }
      } else if (result.error) {
        await sendOmegaTelegram(env, `⚠️ <b>Omega Intent Rejected · ${label}</b>\nTicket: <code>#${result.ticket || p?.ticket || "—"}</code>\nKind: <code>${p?.kind || "—"}</code>\nError: <code>${result.error}</code>`);
      }
    }
  }
  await reconcileFilledOpens(env, db, executor, now);
  await db.prepare("UPDATE omega_intents SET status = 'expired', updated_ms = ? WHERE status IN ('pending', 'sent') AND created_ms < ?").bind(now, now - INTENT_TTL_MS).run();

  // The connection the bridge must apply.
  const conn = await db.prepare("SELECT version, status, server, kid, envelope FROM omega_connection WHERE id = 1").first();
  let connection = null;
  if (conn.status === "stored" && conn.kid !== kid) {
    await db.prepare("UPDATE omega_connection SET status = 'needs_reentry', envelope = NULL, updated_ms = ? WHERE id = 1").bind(now).run();
    await event(db, now, "bridge", "connection_needs_reentry", { reason: "bridge key changed" });
  } else if (conn.status === "stored") {
    connection = { version: Number(conn.version), server: conn.server, envelope: parse(conn.envelope) };
  } else if (conn.status === "cleared") {
    connection = { version: Number(conn.version), cleared: true };
  }

  // Plan.
  const { settings, version: settingsVersion } = await readSettings(env);
  let signal = signalIn ?? null;
  // The kill switch is read once a sync and is never cached: a KILL takes effect at the next sync.
  const control = await readControl(env);
  if (!signal) { try { signal = await eaSignal(env, { now, control }); } catch { signal = null; } }
  const recent = await db.prepare("SELECT id FROM omega_intents WHERE created_ms > ?").bind(now - 2 * 86_400_000).all();
  // Each open position's strategy agent, from its open intent (owner 2026-11-16, docs/RFC_STRATEGY_EXECUTION.md).
  const agents = await positionAgents(db, executor);
  // The strategy arm's auto-disarm (owner 2026-11-17, ADR-0020): the daily loss floor, or the kill from the environment
  // (EA_SIGNALS_ENABLED "false"; Omega's own kill disarms in OmegaGateway.setControl). A D1 write only while something
  // is armed and a trigger holds; the KV read is the hot path.
  // The account's broker spec and profile (docs/RFC_ACCOUNT_PROFILES.md, phase 1): a new or changed spec opens nothing
  // until it validates. A failure here fails closed for new entries only (management and closes still run).
  let account = null;
  if (executor?.connected === true) {
    try {
      account = await syncAccount(db, executor, { settings, now, log: (action, detail) => event(db, now, "engine", action, detail), notify: (t) => sendOmegaTelegram(env, t) });
    } catch { account = { account_ref: null, spec_status: "unknown", spec_problem: "account_sync_failed" }; }
  }
  // On the day Omega first saw the account its daily loss counts from onboarding (owner 2026-11-18): every daily-loss
  // check below (the arm's auto-disarm, the profile agent, the planner) reads this executor.
  const dayExec = account?.row ? dailyLossExecutor(executor, account.row, now) : executor;
  if (strategyArmMode(env) === "live") {
    const trigger = dailyLossHit(dayExec, settings?.max_daily_loss_pct) ? "daily_loss_limit" : signal?.kill_source === "env" ? "kill_switch" : null;
    if (trigger && (await readArmState(env)).ids.length) {
      try { await disarmAll(env, { reason: trigger, now, send: (t) => sendOmegaTelegram(env, t) }); } catch { /* retried at the next sync */ }
    }
  }
  // The Position Manager's fresh actions (src/position-manager.mjs, owner 2026-11-17), checked again in the plan.
  const pmActions = await pendingPositionActions(db, { now });
  let reviewStarted = false;
  if (executor?.connected === true) {
    // The profile agent's immediate steps (phase 3, src/profile-agent.mjs): the kill switch or the daily loss -> Safe,
    // a drawdown step, an extreme-volatility step. No deal is read here; the loss streak and the upgrades run in the
    // 5-minute ledger cron. A switch applies to this very plan (new entries only).
    if (account?.row) {
      const killed = signal?.kill === true || control?.mode === "killed";
      // The daily loss is the profile's own limit (phase 2: the smaller of the profile's and the setting's).
      const dailyPct = effectiveLimits(account.row.profile, settings ?? {}).max_daily_loss_pct ?? settings?.max_daily_loss_pct;
      // The profile council (src/profile-council.mjs) does not run here: an upgrade waits for the cron, and a soft
      // downgrade under OMEGA_PROFILE_COUNCIL_DOWNGRADE "on" waits for its review with new entries held.
      const step = await runProfileAgent(db, account.row, { executor, killed, dailyLoss: dailyLossHit(dayExec, dailyPct), onboardingDay: dayExec !== executor || onboardingDayRef(account.row, now) != null, now, downgradeCouncil: downgradeCouncilOn(env),
        log: (action, detail) => event(db, now, "agent:profile", action, detail), notify: (t) => sendOmegaTelegram(env, t) });
      if (step.status === "changed") account = { ...account, profile: step.change.to };
      if (step.review_pending === true) account = { ...account, review_pending: true };
      if (step.review_started === true) reviewStarted = true;
    }
  }
  const eaGate = eaVersionGateOn(env);
  const plan = planIntents({ signal, control, settings, executor: dayExec, now, engineEnabled: engineEnvEnabled(env), recentIntentIds: (recent.results ?? []).map((r) => r.id), agents, pmActions, account, eaGate });
  if (pmActions.length) {
    // An action that became an intent is applied; one the live price no longer allows is skipped (never retried).
    const planned = new Set(plan.intents.filter((it) => String(it.id).startsWith("pm:")).map((it) => { const [, t, , b] = String(it.id).split(":"); return `pm:${t}:${b}`; }));
    await markPositionActions(db, pmActions.filter((a) => planned.has(a.id)).map((a) => a.id), "applied");
    await markPositionActions(db, pmActions.filter((a) => !planned.has(a.id)).map((a) => a.id), "skipped");
  }
  for (const planned of plan.intents) {
    const it = await withAttempt(db, planned);
    if (!it) continue;
    await db.prepare("INSERT OR IGNORE INTO omega_intents (id, kind, payload, status, created_ms, updated_ms) VALUES (?, ?, ?, 'pending', ?, ?)").bind(it.id, it.kind, JSON.stringify(it), now, now).run();
  }
  const notesKey = plan.notes.map((x) => x.code).join(",");
  const lastNotes = await db.prepare("SELECT detail FROM omega_events WHERE action = 'plan' ORDER BY id DESC LIMIT 1").first();
  // A note's reason in numbers (phase 2: the minimum lot, the open risk) rides along, as it stood when the codes changed.
  const noteDetails = Object.fromEntries(plan.notes.filter((x) => typeof x.detail === "string").map((x) => [x.code, x.detail.slice(0, 200)]));
  if ((parse(lastNotes?.detail, {})?.notes ?? null) !== notesKey) await event(db, now, "engine", "plan", Object.keys(noteDetails).length ? { notes: notesKey, details: noteDetails } : { notes: notesKey });

  const open = await db.prepare("SELECT id, payload FROM omega_intents WHERE status IN ('pending', 'sent') ORDER BY created_ms, id").all();
  const intents = (open.results ?? []).map((r) => parse(r.payload)).filter(Boolean);
  await db.prepare("UPDATE omega_intents SET status = 'sent', updated_ms = ? WHERE status = 'pending'").bind(now).run();

  // Cerebrum Autonomous Watchdog: evaluate MT5 terminal health & dispatch self-healing directives
  let recovery = null;
  if (conn?.status === "stored") {
    const recentFailedAlgo = (Array.isArray(results) ? results : []).some(
      (r) => typeof r?.error === "string" && (r.error.includes("algo_trading_disabled") || r.error.includes("automated trading disabled"))
    );
    const algoDisabled = executor?.trade_allowed === false || recentFailedAlgo;

    // Gold's weekly close in New York time (2026-11-15: a fixed Friday/Sunday 22:00 UTC was an hour off
    // half the year); a stale terminal while gold is closed is expected, not a reason to restart it.
    const isWeekend = goldClosedAt(now);
    const terminalDisconnected = executor?.connected === false;
    const isStale = Number.isFinite(executor?.received_ms) && (now - Number(executor.received_ms) > 60_000);

    let candidateDirective = null;
    let candidateReason = null;

    if (algoDisabled) {
      candidateDirective = "remediate_algo_trading";
      candidateReason = recentFailedAlgo ? "recent_intent_algo_disabled" : "trade_allowed_false";
    } else if (!isWeekend && (terminalDisconnected || isStale)) {
      candidateDirective = "restart_terminal";
      candidateReason = terminalDisconnected ? "terminal_disconnected" : "chart_frozen_stale_quote";
    }

    if (candidateDirective) {
      const lastRec = await db.prepare("SELECT ms FROM omega_events WHERE actor = 'agent:cerebrum' AND action = 'autonomous_recovery' ORDER BY id DESC LIMIT 1").first();
      const lastMs = Number(lastRec?.ms || 0);
      if (now - lastMs >= 180_000) {
        const actionId = `rec:${now}`;
        recovery = {
          directive: candidateDirective,
          reason: candidateReason,
          action_id: actionId,
        };
        await event(db, now, "agent:cerebrum", "autonomous_recovery", {
          directive: candidateDirective,
          reason: candidateReason,
          action_id: actionId,
          status: "dispatched",
        });
        // Owner 2026-11-16: EA health goes to the Cryptophys-Cerebrum chat, not Nexus. The event above is relayed
        // through the platform kernel (src/ea-heartbeat-relay.mjs, topic "ea_heartbeat"); nothing is sent here.
      }
    }
  }

  // Corpus Oracle (owner 2026-11-11): the broker's closed M1 bars of Omega's active broker, pair and
  // user, kept for the local lane's phase 2; off unless CORPUS_ORACLE_MODE = "shadow". Never blocks a sync.
  let corpusCursor = null;
  if (corpus) {
    try { corpusCursor = (await ingestCorpus(env, corpus, { executor, now })).cursor_ms ?? null; } catch { corpusCursor = null; }
  }
  // The MT5 fallback, stage 2 (2026-11-11): the macro symbols' bars and the MQL5 calendar, same rules.
  let macroCursors = null, calendarSeen = null;
  if (corpusMacro) {
    try { macroCursors = (await ingestCorpusMacro(env, corpusMacro, { executor, now })).cursors ?? null; } catch { macroCursors = null; }
  }
  if (calendar) {
    try { const r = await ingestMt5Calendar(env, calendar, { executor, now }); calendarSeen = r.events != null && Number.isFinite(Number(calendar.written_ms)) ? Number(calendar.written_ms) : null; } catch { calendarSeen = null; }
  }

  return { ok: true, intents, connection, settings_version: settingsVersion, notes: plan.notes, corpus_cursor_ms: corpusCursor, corpus_macro_cursors: macroCursors, calendar_seen_ms: calendarSeen, ...(recovery ? { recovery } : {}), ...(reviewStarted ? { profile_review_started: true } : {}) };
}

// ---------------------------------------------------------------- overview (for the page)

/**
 * The light status of the Omega badge on every Nexus page (UI audit DEF-10, 2026-11-14): whether the terminal is
 * connected, whether the engine is armed, the server and how many positions are open. One bridge row and the
 * settings, never the full overview (deals, intents, events): the badge reads it every 60 seconds.
 */
/**
 * The profile agent's evidence steps (phase 3), from the 5-minute ledger cron: the loss streak and the upgrades, on
 * the last bridge state of the connected account. Nothing runs on a stale terminal (no state in 2 minutes): an
 * upgrade needs a live view of the open positions and orders.
 */
export async function profileAgentTick(env, { now = Date.now(), call = undefined } = {}) {
  await ensureSchema(env.DB);
  const db = env.DB;
  const b = await db.prepare("SELECT state FROM omega_bridge WHERE id = 1").first();
  const executor = parse(b?.state);
  if (!executor || executor.connected !== true || !(Number(executor.received_ms) > 0) || now - Number(executor.received_ms) > BRIDGE_SEEN_MS) return { status: "stale" };
  const accounts = await readAccounts(db);
  const acct = accounts.find((a) => a.server && a.server === executor.server);
  if (!acct) return { status: "no_account" };
  const row = await db.prepare("SELECT * FROM omega_accounts WHERE account_ref = ?").bind(acct.account_ref).first();
  const control = await readControl(env);
  const { settings } = await readSettings(env);
  const killed = control?.mode === "killed" || String(env?.EA_SIGNALS_ENABLED ?? "true").trim().toLowerCase() === "false";
  const dailyPct = effectiveLimits(row?.profile, settings ?? {}).max_daily_loss_pct ?? settings?.max_daily_loss_pct;
  const dayExec = dailyLossExecutor(executor, row, now);
  return runProfileAgent(db, row, { executor, killed, dailyLoss: dailyLossHit(dayExec, dailyPct), onboardingDay: onboardingDayRef(row, now) != null, withEvidence: true, now,
    downgradeCouncil: downgradeCouncilOn(env), review: (r, change, { deals }) => reviewProfileChange(env, r, change, { executor, deals, now, call }),
    log: (action, detail) => event(db, now, "agent:profile", action, detail), notify: (t) => sendOmegaTelegram(env, t) });
}

/** The owner's profile controls (the caller checked OWNER_ACCESS_SUB): ceiling, profile, agent mode, accept, decline. */
export async function setAccountProfile(env, { account_ref, action, value, actor = "owner" } = {}, { now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  // The baseline reset needs the connected account's live state and the kill switch.
  let executor = null, connectedRef = null, killed = false;
  if (action === "reset") {
    const b = await env.DB.prepare("SELECT state FROM omega_bridge WHERE id = 1").first();
    const st = parse(b?.state);
    if (st?.connected === true && Number(st?.received_ms) > 0 && now - Number(st.received_ms) <= BRIDGE_SEEN_MS) {
      executor = st;
      const accounts = await readAccounts(env.DB);
      connectedRef = accounts.find((a) => a.server && a.server === st.server && (a.account_ref === account_ref))?.account_ref ?? null;
    }
    const control = await readControl(env);
    killed = control?.mode === "killed" || String(env?.EA_SIGNALS_ENABLED ?? "true").trim().toLowerCase() === "false";
  }
  return ownerSetProfile(env.DB, { account_ref, action, value, actor: String(actor || "owner").slice(0, 120), now, executor, connectedRef, killed,
    log: (what, detail) => event(env.DB, now, actor || "owner", what, detail), notify: (t) => sendOmegaTelegram(env, t) });
}

export async function brokerStatus(env, { now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  const settings = await readSettings(env);
  const connection = await connectionStatus(env);
  const b = await env.DB.prepare("SELECT state, synced_ms FROM omega_bridge WHERE id = 1").first();
  const st = parse(b?.state);
  const fresh = Number.isFinite(st?.received_ms) && now - Number(st.received_ms) < 60_000;
  return {
    connected: Boolean(st?.connected === true && connection.status === "stored" && fresh),
    armed: settings.settings?.enabled === true,
    server: connection.status === "stored" ? (st?.server ?? connection.server ?? null) : null,
    positions: Array.isArray(st?.positions) ? st.positions.length : 0,
    synced_age_ms: b?.synced_ms ? now - Number(b.synced_ms) : null
  };
}

export async function brokerOverview(env, { now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  const db = env.DB;
  const settings = await readSettings(env);
  const connection = await connectionStatus(env);
  const b = await db.prepare("SELECT kid, bridge_version, state, synced_ms FROM omega_bridge WHERE id = 1").first();
  const st = parse(b?.state);
  const syncedAge = b?.synced_ms ? now - Number(b.synced_ms) : null;
  const intents = (await db.prepare("SELECT payload, status, result, created_ms, updated_ms FROM omega_intents ORDER BY created_ms DESC, id DESC LIMIT 50").all()).results ?? [];
  const events = (await db.prepare("SELECT ms, actor, action, detail FROM omega_events ORDER BY id DESC LIMIT 20").all()).results ?? [];
  const lastRec = await db.prepare("SELECT ms, detail FROM omega_events WHERE actor = 'agent:cerebrum' AND action = 'autonomous_recovery' ORDER BY id DESC LIMIT 1").first();
  // The planner's current notes (written only when they change): why Omega is or is not entering now.
  const lastPlan = await db.prepare("SELECT ms, detail FROM omega_events WHERE action = 'plan' ORDER BY id DESC LIMIT 1").first();
  // Account Profiles phase 1: the accounts seen, their broker spec status and profile (never a login).
  let accounts = [];
  try { accounts = await readAccounts(db); } catch { accounts = []; }
  const councilReviews = {}, histories = {};
  for (const a of accounts.slice(0, 5)) {
    councilReviews[a.account_ref] = await lastCouncilReviews(db, a.account_ref);
    const r = await db.prepare("SELECT * FROM omega_accounts WHERE account_ref = ?").bind(a.account_ref).first();
    histories[a.account_ref] = r ? await accountHistory(db, r, { now }) : null;
  }

  // TCA: Transaction Cost Analysis aggregation over completed intents
  let tcaLatencySum = 0, tcaLatencyCount = 0;
  let tcaSlippageSum = 0, tcaSlippageCount = 0;
  let tcaMaxSlippage = 0;
  for (const row of intents) {
    if (row.status !== "done") continue;
    const res = parse(row.result);
    if (!res) continue;
    if (Number.isFinite(res.latency_ms)) {
      tcaLatencySum += res.latency_ms;
      tcaLatencyCount++;
    }
    if (Number.isFinite(res.slippage_pts)) {
      const sp = Math.abs(res.slippage_pts);
      tcaSlippageSum += sp;
      tcaSlippageCount++;
      if (sp > tcaMaxSlippage) tcaMaxSlippage = sp;
    }
  }
  const avgLatency = tcaLatencyCount > 0 ? Math.round(tcaLatencySum / tcaLatencyCount) : null;
  const avgSlippage = tcaSlippageCount > 0 ? Number((tcaSlippageSum / tcaSlippageCount).toFixed(1)) : null;
  const executionQuality = (avgSlippage != null && avgSlippage <= 5 && (avgLatency == null || avgLatency <= 1500))
    ? "PRIME"
    : (avgSlippage != null && avgSlippage <= 15) ? "ACCEPTABLE" : "DEGRADED";

  const tca = {
    samples_count: tcaSlippageCount,
    avg_latency_ms: avgLatency,
    avg_slippage_points: avgSlippage,
    max_slippage_points: tcaSlippageCount > 0 ? tcaMaxSlippage : null,
    quality: executionQuality
  };

  // The order route (owner 2026-11-12: no invented broker names or failover). One route: the owner's stored
  // connection on the bridge's terminal. No standby broker and no failover exist, so none is claimed.
  const stateFresh = Number.isFinite(st?.received_ms) && now - Number(st.received_ms) < 60_000;
  const route = {
    active_route: connection.status === "stored" ? (st?.server ?? null) : null,
    status: connection.status !== "stored" ? "no_connection" : !stateFresh ? "unknown" : st?.connected !== true ? "disconnected" : st?.trade_allowed === true ? "trading" : "trade_disabled",
    failover: "none",
    bridge_sync_age_ms: syncedAge
  };

  // Macro Risk & Real-Time Economic Calendar
  // The news gate's window is the EA signal's own (BLACKOUT_*), returned so the page never hardcodes it.
  const gate = blackoutWindow(env);
  const windowMinutes = { before: Math.round(gate.beforeMs / 60_000), after: Math.round(gate.afterMs / 60_000) };
  let macroRisk = { blackout: false, reason: null, upcoming_count: 0, upcoming_24h: 0, next_event: null, window_minutes: windowMinutes };
  try {
    const evts = await gatedEvents(env, { now });
    const active = (evts || []).filter((e) => {
      const t = Date.parse(e?.time ?? "");
      return Number.isFinite(t) && now >= t - gate.beforeMs && now <= t + gate.afterMs;
    });
    const nextList = (evts || []).filter((e) => {
      const t = Date.parse(e?.time ?? "");
      return Number.isFinite(t) && t > now;
    }).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

    macroRisk = {
      blackout: active.length > 0,
      reason: active.length > 0 ? active.map((e) => e.title).join("; ").slice(0, 160) : null,
      upcoming_count: nextList.length,
      upcoming_24h: nextList.filter((e) => Date.parse(e.time) - now <= 24 * 3600000).length,
      next_event: nextList[0] ? { title: nextList[0].title, time: nextList[0].time, currency: nextList[0].currency, impact: nextList[0].impact } : null,
      window_minutes: windowMinutes
    };
  } catch {
    macroRisk = { blackout: false, reason: null, upcoming_count: 0, upcoming_24h: 0, next_event: null, window_minutes: windowMinutes };
  }

  // How Omega manages an open position (src/omega-engine.mjs manageIntents and keyLevelPlan), from the
  // settings in force, so the page describes the real rules (owner 2026-11-13: nothing hardcoded).
  const S = settings.settings ?? {};
  const management = {
    key_levels: "SL+ behind the key levels price has passed; trailing TP to the next key level with a strong power; close a winner when the power turns strongly against it",
    break_even_r: Number(S.trailing_stop_r) > 0 ? Number(S.trailing_stop_r) : null,
    fallback: "without key levels: the stop trails the broker's 5m swing",
    scale_out: "a position of 0.02 lots or more banks half at 1.5R or its target, once",
    adaptive_stop: S.adaptive_volatility !== false ? "a stop closer than 0.75 x ATR widens to it; the target keeps the plan's reward-to-risk (scalp: the target stays at the key level)" : null,
    no_stacking: "a second position on a side opens only once the first is protected"
  };

  // Volatility Telemetry
  const atrVal = st?.symbol?.atr_value ?? null;
  const atrPts = st?.symbol?.atr_points ?? null;
  const volRegime = atrPts == null ? "NORMAL" : (atrPts > 500 ? "HIGH" : atrPts < 150 ? "LOW" : "NORMAL");
  const volatility = {
    atr_points: atrPts,
    atr_value: atrVal,
    regime: volRegime,
    adaptive_enabled: settings.settings?.adaptive_volatility !== false
  };

  return {
    engine: { env_enabled: engineEnvEnabled(env), ...settings.settings, settings_version: settings.version, updated_by: settings.updated_by, updated_ms: settings.updated_ms },
    connection: { version: connection.version, status: connection.status, server: connection.server, updated_by: connection.updated_by, updated_ms: connection.updated_ms },
    bridge: {
      seen: syncedAge != null && syncedAge < BRIDGE_SEEN_MS, synced_age_ms: syncedAge, kid: b?.kid ?? null, bridge_version: b?.bridge_version ?? null,
      terminal_connected: Boolean(st?.connected === true && connection.status === "stored" && (now - Number(st?.received_ms || 0) < 60_000)),
      trade_allowed: Boolean(st?.trade_allowed === true && connection.status === "stored" && (now - Number(st?.received_ms || 0) < 60_000)),
      terminal_error: st?.connected !== true ? (st?.terminal_error ?? null) : null,
      // The EA's self-report (1.12+): its version, its local break-even and trailing, and what Omega makes of it.
      executor: executorStatus(st?.executor),
      // The entry gate on the EA version (OMEGA_EA_VERSION_GATE, off until OmegaExecutor 1.15 runs on the VPS).
      ea_version_gate: { on: eaVersionGateOn(env), min_version: EXECUTOR_ENTRY_MIN_VERSION, met: specVersionAtLeast(st?.executor?.version ?? null, EXECUTOR_ENTRY_MIN_VERSION) },
      leverage: st?.account?.leverage ?? null, margin_mode: st?.account?.margin_mode ?? null, margin_free: st?.account?.margin_free ?? null,
      freeze_level_points: st?.symbol?.freeze_level_points ?? null, symbol_trade_mode: st?.symbol?.trade_mode ?? null, margin_per_lot: st?.symbol?.margin_per_lot ?? null,
      server: connection.status === "stored" ? (st?.server ?? null) : null, trade_mode: st?.account?.trade_mode ?? null, currency: st?.account?.currency ?? null,
      balance: st?.account?.balance ?? null, equity: st?.account?.equity ?? null, day_start_balance: st?.account?.day_start_balance ?? null, day_realized_pl: st?.account?.day_realized_pl ?? null,
      symbol: st?.symbol?.name ?? null, bid: st?.symbol?.bid ?? null, ask: st?.symbol?.ask ?? null, spread_points: st?.symbol?.spread_points ?? null,
      digits: st?.symbol?.digits ?? null, point: st?.symbol?.point ?? null, tick_size: st?.symbol?.tick_size ?? null, tick_value: st?.symbol?.tick_value ?? null,
      volume_min: st?.symbol?.volume_min ?? null, volume_max: st?.symbol?.volume_max ?? null, volume_step: st?.symbol?.volume_step ?? null, stops_level_points: st?.symbol?.stops_level_points ?? null,
      atr_value: atrVal, atr_points: atrPts,
      // The traded symbol, checked (PR #405): USD gold or no new entries; the bridge's chart-symbol resolution.
      symbol_check: st ? (() => {
        const check = goldSymbolCheck(st.symbol, st.symbol_error);
        return {
          ok: check.ok, problem: check.problem, text: goldSymbolText(check, st.symbol),
          chart_symbol: st.symbol?.chart ?? st.bridge_symbol?.chart_symbol ?? null,
          currency_profit: st.symbol?.currency_profit ?? null, contract_size: st.symbol?.contract_size ?? null,
          symbol_error: st.symbol_error ?? null, resolution: st.bridge_symbol ?? null
        };
      })() : null,
      positions: Array.isArray(st?.positions) ? st.positions : [],
      orders: Array.isArray(st?.orders) ? st.orders : [],
      deals: Array.isArray(st?.deals) ? st.deals : [],
      state_age_ms: Number.isFinite(st?.received_ms) ? now - st.received_ms : null
    },
    // Account Profiles (docs/RFC_ACCOUNT_PROFILES.md): each account's opaque reference, broker spec status and profile.
    accounts: accounts.map((a) => ({
      account_ref: a.account_ref, server: a.server, legacy_ref: a.legacy,
      spec_status: a.spec_status, spec_problem: a.spec_problem, spec_hash: a.spec_hash, spec_since_ms: a.spec_since_ms, spec_validated_ms: a.spec_validated_ms,
      spec_text: specStatusText(a),
      profile: a.profile, profile_label: PROFILES[a.profile]?.label ?? a.profile, ceiling: a.ceiling, agent_mode: a.agent_mode, custom: a.custom,
      profile_by: a.profile_by, profile_ms: a.profile_ms,
      // The profile agent (phase 3): its proposal in approval mode, the block after a kill or the daily loss, the last upgrade.
      pending_upgrade: a.pending_upgrade, upgrade_block_until_ms: a.upgrade_block_until_ms, last_upgrade_ms: a.last_upgrade_ms,
      // The profile council: a soft downgrade waiting for review, a veto in force, the last reviews.
      pending_downgrade: a.pending_downgrade ?? null, council_veto: a.council_veto ?? null, council_reviews: councilReviews[a.account_ref] ?? [],
      // The owner's reset (owner 2026-11-18): whether Omega saw this account before, its baseline, its streak.
      history: histories[a.account_ref] ?? null, connected: Boolean(st?.connected === true && a.server && a.server === st?.server),
      upgrade_block_reason: a.upgrade_block_reason ?? null,
      // The day's P&L in % against the daily-loss reference (the onboarding balance on the day Omega first saw it).
      day_pl_pct: (() => { if (!(st?.connected === true && a.server === st?.server)) return null; const x = dailyLossExecutor(st, a, now)?.account; const ref = Number(x?.day_start_balance), eq = Number(x?.equity); return ref > 0 && Number.isFinite(eq) ? Math.round(((eq - ref) / ref) * 1000) / 10 : null; })()
    })),
    autonomous_watchdog: {
      active: true,
      agent: "agent:cerebrum",
      policy: "self_healing_v1",
      anti_flapping_cooldown_sec: 180,
      last_recovery: lastRec ? { ms: lastRec.ms, ...parse(lastRec.detail, {}) } : null,
    },
    tca,
    route,
    management,
    macro_risk: macroRisk,
    volatility,
    intents: intents.map((r) => ({ ...parse(r.payload, {}), status: r.status, result: parse(r.result), created_ms: r.created_ms, updated_ms: r.updated_ms })),
    events: events.map((r) => ({ ms: r.ms, actor: r.actor, action: r.action, detail: parse(r.detail) })),
    planner: lastPlan ? { since_ms: lastPlan.ms, codes: String(parse(lastPlan.detail, {})?.notes ?? "").split(",").filter(Boolean), details: parse(lastPlan.detail, {})?.details ?? {} } : null
  };
}


/**
 * Pure: the live numbers of one bridge sync (quote, account, open positions and orders), in the shape of
 * brokerOverview's `bridge`. Since the bridge row is written only on a change that matters or every 30 seconds
 * (BRIDGE_WRITE_EVERY_MS), the overview read from D1 can hold a quote up to 30 seconds old; the overview pushed
 * to the open Omega pages after each sync carries these instead (owner 2026-11-14: realtime chart, no added
 * cost). Nothing is written. Null for a state without a quote.
 */
export function liveBridgeFields(state, { now = Date.now() } = {}) {
  const st = executorFrom(state);
  if (!st || typeof st?.symbol?.bid !== "number") return null;
  return {
    bid: st.symbol.bid ?? null, ask: st.symbol.ask ?? null, spread_points: st.symbol.spread_points ?? null,
    balance: st.account?.balance ?? null, equity: st.account?.equity ?? null, day_realized_pl: st.account?.day_realized_pl ?? null,
    positions: Array.isArray(st.positions) ? st.positions : [], orders: Array.isArray(st.orders) ? st.orders : [],
    atr_value: st.symbol.atr_value ?? null, atr_points: st.symbol.atr_points ?? null,
    synced_age_ms: 0, state_age_ms: Number.isFinite(st.received_ms) ? Math.max(0, now - st.received_ms) : 0,
    live: true
  };
}

// ---------------------------------------------------------------- Aether-governed policy (proposal #227)

export const OMEGA_POLICY_BOUNDS = Object.freeze({
  risk_pct: { min: 0.1, max: 2.0 },
  max_positions: { min: 1, max: 3 },
  max_daily_loss_pct: { min: 1, max: 5 },
  max_spread_points: { min: 30, max: 120 },
  max_signal_age_ms: { min: 300000, max: 600000 }
});

function clamp(v, b) { return Math.min(b.max, Math.max(b.min, v)); }

// B-12 (issue #227, owner 2026-11-11 "All"): Aether's policy pack, pulled hourly by pullOmegaPolicy
// (src/omega-policy.mjs) into KV omega:policy, applied here within the hard bounds above only while the
// owner's switch is on (OMEGA_POLICY_AUTO or the page's policy_auto). Each change is audited
// (omega_events "settings", actor aether) and reported; after OMEGA_POLICY_ROLLBACK_TRADES Omega trades
// under it, a policy whose profit factor is below 1 and below the one before it is reverted (actor
// aether-rollback) and its doctrine sha is not applied again.
export const OMEGA_POLICY_KEY = "omega:policy";
export const OMEGA_POLICY_APPLIED_KEY = "omega:policy:applied";
export const OMEGA_POLICY_ROLLBACK_TRADES = 50;
const POLICY_FIELDS = Object.keys(OMEGA_POLICY_BOUNDS);
const pick = (o) => Object.fromEntries(POLICY_FIELDS.filter((k) => o?.[k] != null).map((k) => [k, o[k]]));

async function omegaTradeStats(env, { sinceMs = null, beforeMs = null, limit = OMEGA_POLICY_ROLLBACK_TRADES } = {}) {
  try {
    // One row per deal (FIRST_OF_DEAL): the policy's rollback check counts each Omega trade once.
    const where = ["source = 'omega'", FIRST_OF_DEAL], args = [];
    if (sinceMs != null) { where.push("closed_ms > ?"); args.push(sinceMs); }
    if (beforeMs != null) { where.push("closed_ms <= ?"); args.push(beforeMs); }
    const order = sinceMs != null ? "ASC" : "DESC";
    const rows = (await env.DB.prepare(`SELECT profit, commission, swap FROM ea_deals WHERE ${where.join(" AND ")} ORDER BY closed_ms ${order} LIMIT ?`).bind(...args, limit).all())?.results || [];
    return dealStats(rows);
  } catch { return dealStats([]); }
}

export async function applyOmegaPolicy(env, { now = Date.now(), notify = null } = {}) {
  const current = await readSettings(env);
  const envOn = String(env?.OMEGA_POLICY_AUTO ?? "").trim().toLowerCase() === "true";
  if (!envOn && current.settings?.policy_auto !== true) return { status: "disabled" };
  const kv = env?.SIGNAL_CACHE;
  let applied = null;
  try { applied = JSON.parse((await kv?.get?.(OMEGA_POLICY_APPLIED_KEY)) || "null"); } catch { applied = null; }

  // The rollback check of the policy in force.
  if (applied && !applied.evaluated) {
    const after = await omegaTradeStats(env, { sinceMs: Date.parse(applied.at) });
    if (after.trades >= OMEGA_POLICY_ROLLBACK_TRADES) {
      const before = applied.baseline;
      const worse = after.profit_factor != null && after.profit_factor < 1 && (before?.profit_factor == null || after.profit_factor < before.profit_factor);
      const record = { ...applied, evaluated: true, evaluated_at: new Date(now).toISOString(), after };
      if (worse) {
        const r = await writeSettings(env, { body: { ...current.settings, ...applied.from }, actor: "aether-rollback" }, { now });
        record.rolled_back = r.ok === true;
        record.rejected_shas = [...new Set([...(applied.rejected_shas || []), applied.sha])];
        await kv?.put?.(OMEGA_POLICY_APPLIED_KEY, JSON.stringify(record));
        if (typeof notify === "function") await notify(`XAUUSD SYSTEM · Omega policy rolled back: after ${after.trades} trades its profit factor was ${after.profit_factor} (before: ${before?.profit_factor ?? "—"}). The previous risk settings are back; this doctrine version will not be applied again.`).catch(() => {});
        return { status: "rolled_back", after, before };
      }
      await kv?.put?.(OMEGA_POLICY_APPLIED_KEY, JSON.stringify(record));
    }
  }

  let raw = null;
  try { raw = await kv?.get?.(OMEGA_POLICY_KEY); } catch { raw = null; }
  if (!raw) return { status: "no_policy" };
  let policy = null;
  try { policy = JSON.parse(raw); } catch { return { status: "invalid_policy" }; }
  if (!policy || typeof policy !== "object") return { status: "invalid_policy" };
  if (policy.doctrine_sha && (applied?.rejected_shas || []).includes(policy.doctrine_sha)) return { status: "rejected_sha" };
  const body = { ...current.settings };
  for (const k of POLICY_FIELDS) {
    if (policy[k] != null && Number.isFinite(Number(policy[k]))) body[k] = clamp(Number(policy[k]), OMEGA_POLICY_BOUNDS[k]);
  }
  const from = pick(current.settings), to = pick(body);
  if (POLICY_FIELDS.every((k) => from[k] === to[k])) return { status: "unchanged" };
  const r = await writeSettings(env, { body, actor: "aether" }, { now });
  if (!r.ok) return { status: "failed", error: r.error };
  const baseline = await omegaTradeStats(env, { beforeMs: now });
  await kv?.put?.(OMEGA_POLICY_APPLIED_KEY, JSON.stringify({ sha: policy.doctrine_sha ?? null, at: new Date(now).toISOString(), from, to, baseline, evaluated: false, rejected_shas: applied?.rejected_shas || [] }));
  if (typeof notify === "function") {
    const changes = POLICY_FIELDS.filter((k) => from[k] !== to[k]).map((k) => `${k.replace(/_/g, " ")} ${from[k] ?? "—"} → ${to[k]}`).join(", ");
    await notify(`XAUUSD SYSTEM · Omega policy applied from Aether's doctrine: ${changes}. It is checked after ${OMEGA_POLICY_ROLLBACK_TRADES} Omega trades and rolled back if it loses.`).catch(() => {});
  }
  return { status: "applied", settings: r.settings, version: r.version, from, to };
}

/**
 * Manual user interrupt / exit: queue a close intent for an open MT5 position (ticket).
 * Dispatched immediately via bridgeSync on the next bridge poll cycle (<=2s).
 */
export async function closePosition(env, { ticket, reason = "manual_user_exit", actor = "user" } = {}, { now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  const db = env.DB;
  const numTicket = Number(ticket);
  if (!Number.isFinite(numTicket) || numTicket <= 0) {
    return { ok: false, error: "invalid_ticket" };
  }
  const cleanReason = String(reason || "manual_user_exit").slice(0, 64);
  const id = `manual:close:${numTicket}:${now}`;
  const payload = {
    id,
    kind: "close",
    ticket: numTicket,
    reason: cleanReason,
    actor: String(actor || "user").slice(0, 64)
  };

  await db.prepare("INSERT INTO omega_intents (id, kind, payload, status, created_ms, updated_ms) VALUES (?, ?, ?, 'pending', ?, ?)").bind(id, "close", JSON.stringify(payload), now, now).run();
  await event(db, now, actor, "position_manual_close_requested", { ticket: numTicket, reason: cleanReason, intent_id: id });

  return { ok: true, intent_id: id, ticket: numTicket };
}
