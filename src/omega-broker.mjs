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

import { eaSignal, readControl } from "./ea-signal.mjs";
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
export const STATE_MAX_BYTES = 32 * 1024;
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
    server: typeof state.server === "string" ? state.server.slice(0, 64) : null,
    received_ms: n(state.received_ms),
    terminal_error: typeof state.terminal_error === "string" ? state.terminal_error.slice(0, 200) : null,
    account: { trade_mode: ["demo", "real", "contest"].includes(a.trade_mode) ? a.trade_mode : null, currency: typeof a.currency === "string" ? a.currency.slice(0, 8) : null, balance: n(a.balance), equity: n(a.equity), day_start_balance: n(a.day_start_balance), day_realized_pl: n(a.day_realized_pl) },
    symbol: { name: typeof s.name === "string" ? s.name.slice(0, 32) : null, digits: Number.isInteger(s.digits) ? s.digits : null, point: n(s.point), tick_size: n(s.tick_size), tick_value: n(s.tick_value), volume_min: n(s.volume_min), volume_max: n(s.volume_max), volume_step: n(s.volume_step), stops_level_points: n(s.stops_level_points), bid: n(s.bid), ask: n(s.ask), spread_points: n(s.spread_points) },
    positions: (Array.isArray(state.positions) ? state.positions : []).slice(0, 50).map((p) => ({
      ticket: n(p?.ticket), side: p?.side === "BUY" || p?.side === "SELL" ? p.side : null, volume: n(p?.volume), open_price: n(p?.open_price), sl: n(p?.sl), tp: n(p?.tp), profit: n(p?.profit),
      intent_id: typeof p?.intent_id === "string" ? p.intent_id.slice(0, 31) : null, opened_ms: n(p?.opened_ms)
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
export async function bridgeSync(env, { state, results, publicKey, kid, bridgeVersion } = {}, { now = Date.now(), signal: signalIn } = {}) {
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

  for (const r of Array.isArray(results) ? results.slice(0, 100) : []) {
    if (typeof r?.id !== "string") continue;
    const result = { ok: r.ok === true, ticket: Number.isFinite(r.ticket) ? r.ticket : null, error: typeof r.error === "string" ? r.error.slice(0, 200) : null, executed_ms: Number.isFinite(r.executed_ms) ? r.executed_ms : null };
    // A late result still lands on an expired intent: the terminal is the truth about what happened.
    await db.prepare("UPDATE omega_intents SET status = ?, result = ?, updated_ms = ? WHERE id = ? AND status IN ('pending', 'sent', 'expired')")
      .bind(result.ok ? "done" : "failed", JSON.stringify(result), now, r.id).run();
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
  return { ok: true, intents, connection, settings_version: settingsVersion, notes: plan.notes };
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
      positions: Array.isArray(st?.positions) ? st.positions : [], state_age_ms: Number.isFinite(st?.received_ms) ? now - st.received_ms : null
    },
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
