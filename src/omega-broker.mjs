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
import { eaSignal, readControl } from "./ea-signal.mjs";
import { storeDeal } from "./ea-execution.mjs";
import { gatedEvents } from "./econ-calendar.mjs";
import { OMEGA_DEFAULTS, planIntents, settingsFrom } from "./omega-engine.mjs";

export const OMEGA_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS omega_settings (id INTEGER PRIMARY KEY CHECK (id = 1), settings TEXT NOT NULL, version INTEGER NOT NULL, updated_by TEXT, updated_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS omega_connection (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, status TEXT NOT NULL, server TEXT, kid TEXT, envelope TEXT, updated_by TEXT, updated_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS omega_bridge (id INTEGER PRIMARY KEY CHECK (id = 1), kid TEXT, public_key TEXT, bridge_version TEXT, state TEXT, synced_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS omega_intents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS omega_intents_created ON omega_intents (created_ms)",
  `CREATE TABLE IF NOT EXISTS omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT)`
];
export const INTENT_TTL_MS = 2 * 60_000;
export const STATE_MAX_BYTES = 64 * 1024;
export const ENVELOPE_MAX_BYTES = 8 * 1024;
const BRIDGE_SEEN_MS = 2 * 60_000;
const SERVER_RE = /^[A-Za-z0-9._ -]{1,64}$/;
const KID_RE = /^[0-9a-f]{16}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

let schemaReady = false;
export function resetOmegaBrokerSchemaForTests() { schemaReady = false; }
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
    account: { trade_mode: ["demo", "real", "contest"].includes(a.trade_mode) ? a.trade_mode : null, currency: typeof a.currency === "string" ? a.currency.slice(0, 8) : null, balance: n(a.balance), equity: n(a.equity), day_start_balance: n(a.day_start_balance), day_realized_pl: n(a.day_realized_pl) },
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
      atr_points: n(s.atr_points)
    },
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
 * One bridge sync: store its key and state, apply its results, plan, and return what it must do.
 * @returns {{ intents: object[], connection: null | object, settings_version: number }}
 */
export async function bridgeSync(env, { state, results, publicKey, kid, bridgeVersion, corpus = null, corpusMacro = null, calendar = null } = {}, { now = Date.now(), signal: signalIn } = {}) {
  await ensureSchema(env.DB);
  const db = env.DB;
  if (typeof kid !== "string" || !KID_RE.test(kid) || typeof publicKey !== "string" || !B64_RE.test(publicKey) || publicKey.length > 1024) return { ok: false, error: "kid and public_key are required" };
  const executor = executorFrom(state);
  const stateText = JSON.stringify(executor);
  if (stateText.length > STATE_MAX_BYTES) return { ok: false, error: "state_too_large" };

  const prev = await db.prepare("SELECT kid FROM omega_bridge WHERE id = 1").first();
  await db.prepare("UPDATE omega_bridge SET kid = ?, public_key = ?, bridge_version = ?, state = ?, synced_ms = ? WHERE id = 1")
    .bind(kid, publicKey, String(bridgeVersion ?? "").slice(0, 32), stateText, now).run();
  if (prev?.kid && prev.kid !== kid) await event(db, now, "bridge", "bridge_key_changed", { from: prev.kid, to: kid });

  // Persist closed deals reported by MT5 terminal
  if (Array.isArray(executor?.deals) && executor.deals.length > 0) {
    for (const d of executor.deals) {
      if (!d?.deal_ticket || !d?.closed_ms) continue;
      try {
        await storeDeal(env, {
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
          currency: executor?.account?.currency || "USD"
        }, { now });
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
      if (result.ok) {
        if (p?.kind === "open") {
          const tcaText = (result.slippage_pts != null || latencyMs != null)
            ? `\nLatency: <code>${latencyMs != null ? `${latencyMs}ms` : "—"}</code> | Slippage: <code>${result.slippage_pts != null ? `${result.slippage_pts} pts` : "0 pts"}</code>`
            : "";
          await sendOmegaTelegram(env, `🟢 <b>Omega Order Executed (Monex)</b>\nTicket: <code>#${result.ticket || "—"}</code>\nSide: <b>${p.side}</b> | Volume: <code>${p.volume}</code>\nEntry: <code>${p.entry || "—"}</code> | Fill: <code>${result.fill_price || p.entry || "—"}</code>\nSL: <code>${p.sl}</code> | TP: <code>${p.tp}</code>${tcaText}`);
        } else if (p?.kind === "close" || p?.kind === "partial_close") {
          await sendOmegaTelegram(env, `💰 <b>Omega Position ${p.kind === "partial_close" ? "Scaled Out (50%)" : "Closed"}</b>\nTicket: <code>#${result.ticket || p.ticket || "—"}</code>\nReason: <code>${p.reason || "executed"}</code>`);
        } else if (p?.kind === "modify_tp") {
          await sendOmegaTelegram(env, `🎯 <b>Extended TP Expanded (Runner)</b>\nTicket: <code>#${p.ticket}</code>\nNew TP: <code>${p.tp}</code>`);
        }
      } else if (result.error) {
        await sendOmegaTelegram(env, `⚠️ <b>Omega Intent Rejected</b>\nTicket: <code>#${result.ticket || p?.ticket || "—"}</code>\nKind: <code>${p?.kind || "—"}</code>\nError: <code>${result.error}</code>`);
      }
    }
  }
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
  if (!signal) { try { signal = await eaSignal(env, { now }); } catch { signal = null; } }
  const control = await readControl(env);
  const recent = await db.prepare("SELECT id FROM omega_intents WHERE created_ms > ?").bind(now - 2 * 86_400_000).all();
  const plan = planIntents({ signal, control, settings, executor, now, engineEnabled: engineEnvEnabled(env), recentIntentIds: (recent.results ?? []).map((r) => r.id) });
  for (const planned of plan.intents) {
    const it = await withAttempt(db, planned);
    if (!it) continue;
    await db.prepare("INSERT OR IGNORE INTO omega_intents (id, kind, payload, status, created_ms, updated_ms) VALUES (?, ?, ?, 'pending', ?, ?)").bind(it.id, it.kind, JSON.stringify(it), now, now).run();
  }
  const notesKey = plan.notes.map((x) => x.code).join(",");
  const lastNotes = await db.prepare("SELECT detail FROM omega_events WHERE action = 'plan' ORDER BY id DESC LIMIT 1").first();
  if ((parse(lastNotes?.detail, {})?.notes ?? null) !== notesKey) await event(db, now, "engine", "plan", { notes: notesKey });

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

    const d = new Date(now);
    const day = d.getUTCDay(), hour = d.getUTCHours();
    const isWeekend = (day === 5 && hour >= 22) || day === 6 || (day === 0 && hour < 22);
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
        await sendOmegaTelegram(env, `🤖 <b>Cerebrum Self-Healing Action</b>\nDirective: <code>${candidateDirective}</code>\nReason: <code>${candidateReason}</code>\nStatus: <b>Dispatched to VPS Host Bridge</b>`);
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

  return { ok: true, intents, connection, settings_version: settingsVersion, notes: plan.notes, corpus_cursor_ms: corpusCursor, corpus_macro_cursors: macroCursors, calendar_seen_ms: calendarSeen, ...(recovery ? { recovery } : {}) };
}

// ---------------------------------------------------------------- overview (for the page)

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

  // Smart Order Router (SOR) & Redundancy
  const sor = {
    mode: settings.settings?.sor_mode || "auto_failover",
    primary_broker: "Monex-Demo",
    standby_broker: "HotStandby-Backup",
    active_route: connection.status === "stored" ? (st?.server ?? "Monex-Demo") : "None",
    status: (st?.connected === true && st?.trade_allowed === true) ? "OPTIMAL" : "STANDBY_TRIGGER_READY",
    failover_ready: true,
    bridge_latency_ms: syncedAge != null ? syncedAge : null,
  };

  // Macro Risk & Real-Time Economic Calendar
  let macroRisk = { blackout: false, reason: null, upcoming_count: 0, next_event: null };
  try {
    const evts = await gatedEvents(env, { now });
    const active = (evts || []).filter((e) => {
      const t = Date.parse(e?.time ?? "");
      return Number.isFinite(t) && now >= t - 2 * 3600000 && now <= t + 30 * 60000;
    });
    const nextList = (evts || []).filter((e) => {
      const t = Date.parse(e?.time ?? "");
      return Number.isFinite(t) && t > now;
    }).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

    macroRisk = {
      blackout: active.length > 0,
      reason: active.length > 0 ? active.map((e) => e.title).join("; ").slice(0, 160) : null,
      upcoming_count: nextList.length,
      next_event: nextList[0] ? { title: nextList[0].title, time: nextList[0].time, currency: nextList[0].currency, impact: nextList[0].impact } : null
    };
  } catch {
    macroRisk = { blackout: false, reason: null, upcoming_count: 0, next_event: null };
  }

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
      server: connection.status === "stored" ? (st?.server ?? null) : null, trade_mode: st?.account?.trade_mode ?? null, currency: st?.account?.currency ?? null,
      balance: st?.account?.balance ?? null, equity: st?.account?.equity ?? null, day_start_balance: st?.account?.day_start_balance ?? null, day_realized_pl: st?.account?.day_realized_pl ?? null,
      symbol: st?.symbol?.name ?? null, bid: st?.symbol?.bid ?? null, ask: st?.symbol?.ask ?? null, spread_points: st?.symbol?.spread_points ?? null,
      digits: st?.symbol?.digits ?? null, point: st?.symbol?.point ?? null, tick_size: st?.symbol?.tick_size ?? null, tick_value: st?.symbol?.tick_value ?? null,
      volume_min: st?.symbol?.volume_min ?? null, volume_max: st?.symbol?.volume_max ?? null, volume_step: st?.symbol?.volume_step ?? null, stops_level_points: st?.symbol?.stops_level_points ?? null,
      atr_value: atrVal, atr_points: atrPts,
      positions: Array.isArray(st?.positions) ? st.positions : [],
      orders: Array.isArray(st?.orders) ? st.orders : [],
      deals: Array.isArray(st?.deals) ? st.deals : [],
      state_age_ms: Number.isFinite(st?.received_ms) ? now - st.received_ms : null
    },
    autonomous_watchdog: {
      active: true,
      agent: "agent:cerebrum",
      policy: "self_healing_v1",
      anti_flapping_cooldown_sec: 180,
      last_recovery: lastRec ? { ms: lastRec.ms, ...parse(lastRec.detail, {}) } : null,
    },
    tca,
    sor,
    macro_risk: macroRisk,
    volatility,
    intents: intents.map((r) => ({ ...parse(r.payload, {}), status: r.status, result: parse(r.result), created_ms: r.created_ms, updated_ms: r.updated_ms })),
    events: events.map((r) => ({ ms: r.ms, actor: r.actor, action: r.action, detail: parse(r.detail) }))
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

export async function applyOmegaPolicy(env, { now = Date.now() } = {}) {
  const current = await readSettings(env);
  const envOn = String(env?.OMEGA_POLICY_AUTO ?? "").trim().toLowerCase() === "true";
  if (!envOn && current.settings?.policy_auto !== true) return { status: "disabled" };
  let raw = null;
  try { raw = await env?.SIGNAL_CACHE?.get?.("omega:policy"); } catch { raw = null; }
  if (!raw) return { status: "no_policy" };
  let policy = null;
  try { policy = JSON.parse(raw); } catch { return { status: "invalid_policy" }; }
  if (!policy || typeof policy !== "object") return { status: "invalid_policy" };
  const body = { ...current.settings };
  for (const k of Object.keys(OMEGA_POLICY_BOUNDS)) {
    if (policy[k] != null && Number.isFinite(Number(policy[k]))) {
      body[k] = clamp(Number(policy[k]), OMEGA_POLICY_BOUNDS[k]);
    }
  }
  const r = await writeSettings(env, { body, actor: "aether" }, { now });
  if (!r.ok) return { status: "failed", error: r.error };
  return { status: "applied", settings: r.settings, version: r.version };
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
