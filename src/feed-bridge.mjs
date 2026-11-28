// F1 (OF1, owner 2026-11-27: "gunakan vps existing dikerjakan sekarang sebagai prioritas utama"; orchestrator brief): a
// second MT5 terminal on the owner's VPS as a DATA-ONLY feed. A feed bridge (bridge role "feed", one row per bridge id)
// syncs its terminal's state and gold M1 bars and gets its own sealed login back; it never receives an intent, never
// plans, never touches an account, a position, a deal or the executor's tables (omega_bridge / omega_connection stay
// the executor's, byte for byte). Its bars are stored as their own corpus source (mt5:<feed server>:<symbol>, marked a
// feed in corpus_feeds), which the MT5 fallback prefers while fresh: the gold reference (MX1) then comes from another
// broker than the executor's. Inert without a feed bridge: nothing here runs until one syncs.
import { envelopeError, SERVER_RE, KID_RE, B64_RE, ENVELOPE_MAX_BYTES } from "./omega-broker.mjs";
import { ingestFeedCorpus } from "./corpus-oracle.mjs";
import { feedContentStale, newStaleEpisode, staleDetail } from "./feed-stale.mjs";

/** A feed's id: lower-case letters, digits and dashes, 1-24 (the bridge unit's instance name, e.g. "oanda"). */
export const FEED_ID_RE = /^[a-z0-9-]{1,24}$/;
/** A feed whose last sync is older than this is shown stale (the fallback has its own freshness rule). */
export const FEED_SEEN_MS = 120_000;

const FEED_SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS omega_feed_bridges (bridge_id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'feed' CHECK (role = 'feed'), kid TEXT, public_key TEXT, bridge_version TEXT, state TEXT, synced_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS omega_feed_connections (bridge_id TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL, server TEXT, kid TEXT, envelope TEXT, updated_by TEXT, updated_ms INTEGER)`
]);
let ready = false;
export function resetFeedSchemaForTests() { ready = false; }
async function ensureFeedSchema(db) {
  if (ready) return;
  for (const sql of FEED_SCHEMA_SQL) await db.prepare(sql).run();
  // The audit trail is the executor's omega_events table (its schema is created by omega-broker); written only when it exists.
  ready = true;
}
const parse = (t) => { try { return t == null ? null : JSON.parse(t); } catch { return null; } };
const clip = (v, n) => (typeof v === "string" ? v.replace(/[^\x20-\x7E]/g, "").trim().slice(0, n) : "");
const finite = (v) => typeof v === "number" && Number.isFinite(v);

async function audit(db, ms, actor, action, detail) {
  try { await db.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, ?, ?, ?)").bind(ms, String(actor || "system"), action, JSON.stringify(detail)).run(); } catch { /* no events table yet */ }
}

/**
 * Pure: the part of a feed terminal's state that is kept: whether it is connected, its server and its quote. Nothing
 * about an account (balance, equity, positions, deals, login) is kept, whatever the terminal sends.
 */
export function feedStateFrom(state, now = Date.now()) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const s = state.symbol && typeof state.symbol === "object" ? state.symbol : {};
  const n = (v) => (finite(v) ? v : null);
  return {
    connected: state.connected === true,
    server: clip(state.server, 64) || null,
    // The contract is recorded, never checked (a feed is a price source only; OANDA's "XAUUSD.sml" may be a smaller lot).
    symbol: { name: clip(s.name, 32) || null, bid: n(s.bid), ask: n(s.ask), digits: Number.isInteger(s.digits) ? s.digits : null,
      contract_size: n(s.contract_size), currency_profit: clip(s.currency_profit, 8) || null },
    terminal_error: clip(state.terminal_error, 120) || null,
    received_ms: now
  };
}

/** The feed's connection row (never the envelope): { version, status, server, kid, updated_ms }. */
async function feedConnection(db, bridgeId) {
  const row = await db.prepare("SELECT version, status, server, kid, envelope, updated_by, updated_ms FROM omega_feed_connections WHERE bridge_id = ?").bind(bridgeId).first();
  return row ? { version: Number(row.version), status: row.status, server: row.server ?? null, kid: row.kid ?? null, envelope: row.envelope ?? null, updated_ms: row.updated_ms ?? null } : { version: 0, status: "none", server: null, kid: null, envelope: null, updated_ms: null };
}

/**
 * One feed bridge sync (POST /api/bridge/feed-sync, the feed's own Access service token). Stores the bridge's key and
 * its state (feedStateFrom), ingests its gold M1 bars as the feed's corpus source, and returns its sealed login when it
 * has one. The answer never has an `intents` key: a feed cannot be told to trade.
 */
export async function feedSync(env, { bridgeId, state, publicKey, kid, bridgeVersion, corpus = null } = {}, { now = Date.now() } = {}) {
  const db = env.DB;
  const id = typeof bridgeId === "string" ? bridgeId.trim().toLowerCase() : "";
  if (!FEED_ID_RE.test(id)) return { ok: false, error: "bridge_id must be 1-24 lower-case letters, digits or dashes" };
  if (typeof kid !== "string" || !KID_RE.test(kid) || typeof publicKey !== "string" || !B64_RE.test(publicKey) || publicKey.length > 1024) return { ok: false, error: "kid and public_key are required" };
  await ensureFeedSchema(db);
  const st = feedStateFrom(state, now);
  const version = typeof bridgeVersion === "string" ? clip(bridgeVersion, 16) || null : null;
  await db.prepare(`INSERT INTO omega_feed_bridges (bridge_id, role, kid, public_key, bridge_version, state, synced_ms) VALUES (?, 'feed', ?, ?, ?, ?, ?)
    ON CONFLICT(bridge_id) DO UPDATE SET kid = excluded.kid, public_key = excluded.public_key, bridge_version = excluded.bridge_version, state = excluded.state, synced_ms = excluded.synced_ms`)
    .bind(id, kid, publicKey, version, st ? JSON.stringify(st) : null, now).run();
  const conn = await feedConnection(db, id);
  // The login is sealed to this bridge's key: a bridge with another key (reinstalled) gets none until it is set again.
  const connection = conn.status === "stored" && conn.kid === kid && conn.envelope ? { version: conn.version, server: conn.server, envelope: parse(conn.envelope) } : null;
  let corpusCursor = null, corpusError = null, corpusBackfill = null;
  if (corpus) {
    try { const r = await ingestFeedCorpus(env, corpus, { bridgeId: id, connection: conn, state: st, now }); corpusCursor = r.cursor_ms ?? null; corpusError = r.error ?? null; corpusBackfill = r.backfill_from_ms ?? null; } catch { corpusCursor = null; }
  }
  await checkFeedStale(db, { bridgeId: id, now });
  return { ok: true, role: "feed", bridge_id: id, connection, connection_version: conn.version, corpus_cursor_ms: corpusCursor, corpus_backfill_from_ms: corpusBackfill, ...(corpusError ? { corpus_error: corpusError } : {}) };
}

// Feed content staleness (src/feed-stale.mjs): checked at most once a minute per bridge and isolate. Never throws.
const STALE_CHECKED = new Map();
const STALE_CHECK_MS = 60_000;
async function lastFeedBarMs(db, bridgeId) {
  try {
    const r = await db.prepare("SELECT MAX(s.last_minute_ms) AS ms FROM corpus_sources s JOIN corpus_feeds f ON f.source = s.source WHERE f.bridge_id = ?").bind(bridgeId).first();
    return Number.isFinite(Number(r?.ms)) && Number(r?.ms) > 0 ? Number(r.ms) : null;
  } catch { return null; }
}
// FS3: the executor's corpus (gold sources that are not a feed; mt5macro:* never matches 'mt5:%'): its newest bar, or
// null when there is none, so a market-wide stop does not page (src/feed-stale.mjs).
async function executorBarMs(db) {
  try {
    const r = await db.prepare("SELECT MAX(last_minute_ms) AS ms FROM corpus_sources WHERE source LIKE 'mt5:%' AND source NOT IN (SELECT source FROM corpus_feeds)").first();
    return Number.isFinite(Number(r?.ms)) && Number(r?.ms) > 0 ? Number(r.ms) : null;
  } catch { return null; }
}
async function checkFeedStale(db, { bridgeId, now }) {
  const at = STALE_CHECKED.get(bridgeId);
  if (Number.isFinite(at) && now >= at && now - at < STALE_CHECK_MS) return;
  STALE_CHECKED.set(bridgeId, now);
  try {
    const lastBarMs = await lastFeedBarMs(db, bridgeId);
    if (!feedContentStale({ syncedMs: now, lastBarMs, now })) return;
    // FS3: the executor's corpus is read only when the feed's own bars look stale (no extra read otherwise).
    if (!feedContentStale({ syncedMs: now, lastBarMs, now, executorBarMs: await executorBarMs(db) })) return;
    const ev = await db.prepare("SELECT ms FROM omega_events WHERE action = 'feed_stale' AND json_extract(detail, '$.bridge_id') = ? ORDER BY id DESC LIMIT 1").bind(bridgeId).first();
    if (!newStaleEpisode({ lastEventMs: Number(ev?.ms || 0), lastBarMs })) return;
    await audit(db, now, "agent:cerebrum", "feed_stale", staleDetail({ bridgeId, lastBarMs, now }));
  } catch { /* the next check tries again */ }
}
export function resetFeedStaleForTests() { STALE_CHECKED.clear(); }

/** Store a feed's login (sealed in the browser to the feed bridge's key). A person only (the Omega Worker checks). */
export async function setFeedConnection(env, { bridgeId, envelope, server, actor }, { now = Date.now() } = {}) {
  const db = env.DB;
  const id = typeof bridgeId === "string" ? bridgeId.trim().toLowerCase() : "";
  if (!FEED_ID_RE.test(id)) return { ok: false, error: "bridge_id must be 1-24 lower-case letters, digits or dashes" };
  const name = typeof server === "string" ? server.trim() : "";
  if (!SERVER_RE.test(name)) return { ok: false, error: "server must be 1-64 letters, digits, dot, dash, underscore or space" };
  const bad = envelopeError(envelope);
  if (bad) return { ok: false, error: bad };
  const text = JSON.stringify(envelope);
  if (text.length > ENVELOPE_MAX_BYTES) return { ok: false, error: "envelope_too_large" };
  await ensureFeedSchema(db);
  const bridge = await db.prepare("SELECT kid FROM omega_feed_bridges WHERE bridge_id = ?").bind(id).first();
  if (!bridge?.kid) return { ok: false, error: "feed_bridge_not_seen" };
  if (bridge.kid !== envelope.kid) return { ok: false, error: "kid_mismatch" };
  const cur = await feedConnection(db, id);
  const version = cur.version + 1;
  await db.prepare(`INSERT INTO omega_feed_connections (bridge_id, version, status, server, kid, envelope, updated_by, updated_ms) VALUES (?, ?, 'stored', ?, ?, ?, ?, ?)
    ON CONFLICT(bridge_id) DO UPDATE SET version = excluded.version, status = 'stored', server = excluded.server, kid = excluded.kid, envelope = excluded.envelope, updated_by = excluded.updated_by, updated_ms = excluded.updated_ms`)
    .bind(id, version, name, envelope.kid, text, actor, now).run();
  await audit(db, now, actor, "feed_connection_set", { bridge_id: id, server: name, version });
  return { ok: true, bridge_id: id, version, status: "stored", server: name };
}

/** Clear a feed's login (a reason is required). Its bars already stored stay; new ones are refused until it is set. */
export async function clearFeedConnection(env, { bridgeId, actor, reason }, { now = Date.now() } = {}) {
  const db = env.DB;
  const id = typeof bridgeId === "string" ? bridgeId.trim().toLowerCase() : "";
  if (!FEED_ID_RE.test(id)) return { ok: false, error: "bridge_id must be 1-24 lower-case letters, digits or dashes" };
  const why = typeof reason === "string" ? reason.trim().slice(0, 200) : "";
  if (!why) return { ok: false, error: "a reason is required to disconnect" };
  await ensureFeedSchema(db);
  const cur = await feedConnection(db, id);
  const version = cur.version + 1;
  await db.prepare(`INSERT INTO omega_feed_connections (bridge_id, version, status, server, kid, envelope, updated_by, updated_ms) VALUES (?, ?, 'cleared', NULL, NULL, NULL, ?, ?)
    ON CONFLICT(bridge_id) DO UPDATE SET version = excluded.version, status = 'cleared', server = NULL, kid = NULL, envelope = NULL, updated_by = excluded.updated_by, updated_ms = excluded.updated_ms`)
    .bind(id, version, actor, now).run();
  await audit(db, now, actor, "feed_connection_cleared", { bridge_id: id, reason: why, version });
  return { ok: true, bridge_id: id, version, status: "cleared" };
}

/** The feeds for the Omega page: each bridge's key (for the browser to seal to), state, freshness and connection. */
export async function feedOverview(env, { now = Date.now() } = {}) {
  const db = env?.DB;
  if (!db) return [];
  try {
    await ensureFeedSchema(db);
    const rows = (await db.prepare("SELECT b.bridge_id, b.kid, b.public_key, b.bridge_version, b.state, b.synced_ms, c.version, c.status, c.server, c.kid AS conn_kid, c.updated_ms FROM omega_feed_bridges b LEFT JOIN omega_feed_connections c ON c.bridge_id = b.bridge_id ORDER BY b.bridge_id").all()).results ?? [];
    const out = [];
    const execBar = rows.length ? await executorBarMs(db) : null;
    for (const r of rows) {
      const st = parse(r.state);
      const age = finite(Number(r.synced_ms)) ? now - Number(r.synced_ms) : null;
      // Feed content staleness (src/feed-stale.mjs): syncing, but its bars stopped (the feed EA not attached).
      const lastBarMs = await lastFeedBarMs(db, r.bridge_id);
      out.push({
        bridge_id: r.bridge_id, role: "feed", kid: r.kid, public_key: r.public_key, bridge_version: r.bridge_version ?? null,
        synced_age_ms: age, fresh: age != null && age <= FEED_SEEN_MS,
        terminal_connected: st?.connected === true, server: st?.server ?? null, symbol: st?.symbol?.name ?? null,
        connection: { version: Number(r.version) || 0, status: r.status ?? "none", server: r.server ?? null, sealed_to_current_key: r.status === "stored" && r.conn_kid === r.kid, updated_ms: r.updated_ms ?? null },
        last_bar_age_ms: lastBarMs != null ? now - lastBarMs : null,
        content_stale: feedContentStale({ syncedMs: Number(r.synced_ms), lastBarMs, now, executorBarMs: execBar })
      });
    }
    return out;
  } catch { return []; }
}
