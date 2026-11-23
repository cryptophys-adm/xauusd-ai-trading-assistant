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
import { storeDeal, dealStats, FIRST_OF_DEAL, ensureSchema as ensureDealsSchema } from "./ea-execution.mjs";
import { gatedEvents } from "./econ-calendar.mjs";
import { spikeSince, recordSpikeBlock } from "./lens-steps.mjs";
import { liveSpreadSpike } from "./liquidity-lens.mjs";
import { OMEGA_DEFAULTS, STOP_COMMAND_MS, commandedStops, loosenRecords, planIntents, settingsFrom, omegaPendingOrders, openId, fillGapR, LIMIT_ENTRY_AVAILABLE, LIMIT_EA_MIN_VERSION, ENTRY_ORDERS } from "./omega-engine.mjs";
import { requestEntryCouncil, readEntryCouncil, pendingLimitActions, markLimitActions, placeLimitRows, ensureLimitCouncilSchema } from "./limit-council.mjs";
import { pendingPositionActions, markPositionActions, positionActionRows, expireStalePositionActions, actionIdOfIntent, actionMessage, ACTION_TTL_MS } from "./position-actions.mjs";
import { announceExits } from "./position-exit.mjs";
import { strategyArmMode, readArmState, disarmAll, dailyLossHit } from "./strategy-arm.mjs";
import { goldCheckOf, goldSymbolText, accountMoney, moneyText, ownerTradeSymbol, TRADE_SYMBOL_RE, DEAL_MONEY_COLUMNS_SQL, DEAL_NET_SQL, positionExposure, exposureText, referenceFrom } from "./gold-symbol.mjs";
import { fallbackSinceMs } from "./feed.mjs";
import { PROBATION, PROBATION_KEY, probationFrom, probationVerdict } from "./htf-cells.mjs";
import { delegationsForSync, withDelegated, delegatedStopIntents, markDelegatedIntents, plannerIds, hitlSupported, readDelegations, HITL_EA_MIN_VERSION } from "./omega-hitl.mjs";
import { runProfileAgent, ownerSetProfile, accountHistory } from "./profile-agent.mjs";
import { reviewProfileChange, downgradeCouncilOn, lastCouncilReviews } from "./profile-council.mjs";
import { runModeSelector, modeStatus, capOf, rangeExitTick } from "./mode-selector.mjs";
import { readCorpusBars, CORPUS_READ_MAX } from "./corpus-oracle.mjs";
import { gatesFor, gateReadSince, gateMode, profitLockGateOn, PROFIT_LOCK_GATE, GATE_LOOKBACK_MIN } from "./profit-lock-gate.mjs";
import { readLatestDecision } from "./decision-engine.mjs";
import { runFastProtect, pmFastOn, spikeHolds } from "./pm-fast.mjs";
import { brokerLabelFor, dailyLossExecutor, onboardingDayRef, accountRef, accountIdentity } from "./account-spec.mjs";
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
  return JSON.stringify([executor.connected, executor.trade_allowed, executor.server, executor.terminal_error, executor.executor, executor.account?.trade_mode, executor.account?.currency, executor.symbol?.name, executor.symbol?.currency_profit ?? null, executor.symbol?.contract_size ?? null, executor.symbol_error ?? null, executor.bridge_symbol?.status ?? null, executor.bridge_symbol?.chart_symbol ?? null, executor.bridge_symbol?.terminal_error ?? null, executor.owner_symbol ?? null, executor.account_ref ?? null, positions, orders, deals]);
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
  // Cent accounts (owner 2026-11-18): the account's gold symbol the owner sets with the connection, or NULL.
  try { await db.prepare("ALTER TABLE omega_connection ADD COLUMN trade_symbol TEXT").run(); } catch { /* already there */ }
  // The account's units per US dollar the owner gave with the connection (2026-11-19), for an account whose currency is
  // not USD and that has no trade yet to measure it (src/gold-symbol.mjs accountMoney). Null: none given.
  try { await db.prepare("ALTER TABLE omega_connection ADD COLUMN units_per_usd REAL").run(); } catch { /* already there */ }
  // Fail closed on limit results (2026-11-21): the open fault, and the owner's own last save (an Aether write is not one).
  try { await db.prepare("ALTER TABLE omega_settings ADD COLUMN limit_fault TEXT").run(); } catch { /* already there */ }
  try { await db.prepare("ALTER TABLE omega_settings ADD COLUMN owner_saved_ms INTEGER").run(); } catch { /* already there */ }
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
    const rows = (await db.prepare(`SELECT id, payload FROM omega_intents WHERE kind IN ('open', 'place_limit') AND id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).all()).results ?? [];
    const out = {};
    for (const r of rows) { const a = parse(r.payload)?.strategy; if (typeof a === "string" && a) out[r.id] = a; }
    return out;
  } catch {
    return {};
  }
}

/** Each open position's mode at entry and its stop distance there ({ intent id: { mode, r_dist } }), for the ladder. */
export async function positionMeta(db, executor) {
  const ids = [...new Set((Array.isArray(executor?.positions) ? executor.positions : []).map((p) => p?.intent_id).filter((x) => typeof x === "string" && x.startsWith("open:")))].slice(0, 50);
  if (!ids.length) return {};
  try {
    const rows = (await db.prepare(`SELECT id, payload FROM omega_intents WHERE kind IN ('open', 'place_limit') AND id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).all()).results ?? [];
    const out = {};
    for (const r of rows) {
      const p = parse(r.payload, {});
      const rDist = Number.isFinite(Number(p.r_dist)) ? Number(p.r_dist) : (Number.isFinite(Number(p.entry)) && Number.isFinite(Number(p.sl)) ? Math.abs(Number(p.entry) - Number(p.sl)) : null);
      // SLG1: the plan's TP distance at entry, the range gate's measure (src/profit-lock-gate.mjs).
      const tpDist = Number.isFinite(Number(p.entry)) && Number(p.tp) > 0 ? Math.abs(Number(p.tp) - Number(p.entry)) : null;
      out[r.id] = { mode: typeof p.mode === "string" ? p.mode : null, r_dist: rDist, ...(p.probation === true ? { probation: true } : {}), ...(tpDist > 0 ? { tp_dist: tpDist } : {}) };
    }
    return out;
  } catch { return {}; }
}

/**
 * What ADR-0020 Amendment 8 reads at each sync with positions (src/omega-engine.mjs planIntents `pmLoosen`): the
 * loosenings already sent (`loosened`, loosenRecords: a position there counts as unprotected and is never loosened
 * again, whatever the switch says now) and each Omega position's original entry stop (`original`, by ticket: the open
 * or place_limit intent's sl, its mode and its stop distance at entry). Never throws: an unreadable record gives no
 * original stop, so nothing is loosened.
 */
export async function pmLoosenInputs(db, executor, now = Date.now()) {
  const out = { loosened: {}, original: {} };
  const positions = (Array.isArray(executor?.positions) ? executor.positions : []).filter((p) => typeof p?.intent_id === "string" && p.intent_id.startsWith("open:") && Number(p?.ticket) > 0);
  try {
    const rows = (await db.prepare("SELECT payload, status, result FROM omega_intents WHERE kind IN ('modify_sl', 'modify_sltp') AND json_extract(payload, '$.loosen') = 1 AND created_ms > ?").bind(now - 30 * 86_400_000).all()).results ?? [];
    out.loosened = loosenRecords(rows);
  } catch { return out; }
  const ids = [...new Set(positions.map((p) => p.intent_id))].slice(0, 50);
  if (!ids.length) return out;
  try {
    const rows = (await db.prepare(`SELECT id, payload FROM omega_intents WHERE kind IN ('open', 'place_limit') AND id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).all()).results ?? [];
    const byId = Object.fromEntries(rows.map((r) => [r.id, parse(r.payload, {})]));
    for (const p of positions) {
      const it = byId[p.intent_id];
      const sl = Number(it?.sl);
      if (!(sl > 0)) continue;
      out.original[String(p.ticket)] = { sl, mode: typeof it.mode === "string" ? it.mode : null, r_dist: Number(it.r_dist) > 0 ? Number(it.r_dist) : null };
    }
  } catch { /* no original stop: nothing is loosened */ }
  return out;
}

/**
 * Pure: the last CLOSED candle of `tfMin` minutes from broker M1 bars ({ t: minute open ms, o, h, l, c }), as
 * { o, c, close_ms }, or null when that candle is not complete (fewer than 80% of its minutes or its last minute missing).
 */
export function lastClosedCandle(bars, tfMin, now) {
  const tf = tfMin * 60_000;
  const end = Math.floor(now / tf) * tf, start = end - tf;
  const inside = (Array.isArray(bars) ? bars : []).filter((b) => Number.isFinite(b?.t) && b.t >= start && b.t < end).sort((a, b) => a.t - b.t);
  if (inside.length < Math.ceil(tfMin * 0.8) || inside.at(-1).t !== end - 60_000) return null;
  const o = Number(inside[0].o), c = Number(inside.at(-1).c);
  return Number.isFinite(o) && Number.isFinite(c) ? { o, c, close_ms: end } : null;
}

// The ladder's closed candles (M5, M15, H1) from the broker's M1 corpus, built at most once a minute per isolate.
// Only the connected terminal's own server and symbol (a switch never confirms on another broker's prices).
let candleCache = { key: null, candles: null };
export function resetCandleCacheForTests() { candleCache = { key: null, candles: null }; }
export async function ladderCandles(env, now, { read = readCorpusBars, server = null, symbol = null } = {}) {
  const ident = `${String(server ?? "").trim().toLowerCase()}|${String(symbol ?? "").trim().toLowerCase()}`;
  const key = `${Math.floor(now / 60_000)}|${ident}`;
  if (candleCache.key === key && candleCache.candles) return candleCache.candles;
  let res = null;
  try { res = await read(env, { sinceMs: now - 125 * 60_000, limit: 200 }); } catch { res = null; }
  const same = res && `${String(res.server ?? "").trim().toLowerCase()}|${String(res.symbol ?? "").trim().toLowerCase()}` === ident && ident !== "|";
  const bars = same ? res.bars ?? [] : [];
  const candles = { M5: lastClosedCandle(bars, 5, now), M15: lastClosedCandle(bars, 15, now), H1: lastClosedCandle(bars, 60, now) };
  candleCache = { key, candles };
  return candles;
}

// SLG1, the profit-lock gate (owner 2026-11-23, src/profit-lock-gate.mjs): the broker's M1 bars since the earliest fill
// of the open positions, at most GATE_LOOKBACK_MIN minutes back (CORPUS_READ_MAX bars, about a day), read at most once
// a minute per isolate, from the connected terminal's own server and symbol only (like the ladder's candles).
let gateBarsCache = { key: null, bars: null };
export function resetGateBarsCacheForTests() { gateBarsCache = { key: null, bars: null }; }
export async function gateBars(env, now, { positions = [], read = readCorpusBars, server = null, symbol = null } = {}) {
  const since = gateReadSince(positions, now);
  if (since == null) return [];
  const ident = `${String(server ?? "").trim().toLowerCase()}|${String(symbol ?? "").trim().toLowerCase()}`;
  const key = `${Math.floor(now / 60_000)}|${since}|${ident}`;
  if (gateBarsCache.key === key && gateBarsCache.bars) return gateBarsCache.bars;
  let res = null;
  try { res = await read(env, { sinceMs: since - 1, limit: Math.min(CORPUS_READ_MAX, GATE_LOOKBACK_MIN) }); } catch { res = null; }
  const same = res && `${String(res.server ?? "").trim().toLowerCase()}|${String(res.symbol ?? "").trim().toLowerCase()}` === ident && ident !== "|";
  const bars = same && Array.isArray(res.bars) ? res.bars : [];
  gateBarsCache = { key, bars };
  return bars;
}

/**
 * The profit-lock gate's facts of the open positions ({ [ticket]: facts }), from the bars above, the terminal's ATR(14,
 * M15) (symbol.atr_value) and, only when a swing position is open, the latest decision's ATR(H1) (strategy.atr_h1, as
 * v4 reads it from the same record). `metaOf(p)` gives { mode, r_dist, tp_dist } of its open intent. Unreadable bars or
 * ATR give closed gates (src/profit-lock-gate.mjs). Never throws.
 */
export async function profitLockGates(env, { executor, metaOf = () => null, now = Date.now(), read = readCorpusBars, atrH1 = undefined } = {}) {
  const positions = (Array.isArray(executor?.positions) ? executor.positions : []).filter((p) => p?.ticket != null && (p.side === "BUY" || p.side === "SELL"));
  if (!positions.length) return {};
  try {
    const bars = await gateBars(env, now, { positions, read, server: executor?.server, symbol: executor?.symbol?.name });
    let h1 = atrH1;
    if (h1 === undefined) {
      h1 = null;
      if (positions.some((p) => PROFIT_LOCK_GATE[gateMode(metaOf(p)?.mode)].atr_tf === "H1")) {
        try { h1 = Number((await readLatestDecision(env))?.strategy?.atr_h1); } catch { h1 = null; }
      }
    }
    return gatesFor({ positions, metaOf, bars, atrM15: Number(executor?.symbol?.atr_value), atrH1: h1, now });
  } catch { return {}; }
}

/**
 * A stop or target change the terminal applied but whose result line never arrived (2026-11-18: ticket 389881390's TP
 * moved to 3774.65 while its intent expired): the position now showing that stop or target is the terminal's word that
 * it ran, so the intent is recorded as done (reconciled), once. No Telegram line: a modify sends none on success either.
 */
export async function reconcileModifies(db, executor, now) {
  const positions = (Array.isArray(executor?.positions) ? executor.positions : []).filter((p) => Number(p?.ticket) > 0);
  if (!positions.length) return 0;
  let rows = [];
  try {
    rows = (await db.prepare("SELECT id, kind, payload FROM omega_intents WHERE kind IN ('modify_sl', 'modify_tp') AND result IS NULL AND status IN ('pending', 'sent', 'expired') AND created_ms > ? LIMIT 50").bind(now - 86_400_000).all()).results ?? [];
  } catch { return 0; }
  const tol = (Number(executor?.symbol?.point) > 0 ? Number(executor.symbol.point) : 0.01) / 2 + 1e-9;
  let n = 0;
  for (const row of rows) {
    const it = parse(row.payload, {});
    const pos = positions.find((p) => Number(p.ticket) === Number(it.ticket));
    if (!pos) continue;
    const want = row.kind === "modify_sl" ? Number(it.sl) : Number(it.tp), have = row.kind === "modify_sl" ? Number(pos.sl) : Number(pos.tp);
    if (!Number.isFinite(want) || !Number.isFinite(have) || Math.abs(want - have) > tol) continue;
    const res = await db.prepare("UPDATE omega_intents SET status = 'done', result = ?, updated_ms = ? WHERE id = ? AND result IS NULL")
      .bind(JSON.stringify({ ok: true, ticket: Number(pos.ticket), error: null, executed_ms: null, fill_price: null, slippage_pts: null, latency_ms: null, reconciled: true }), now, row.id).run();
    if (Number(res?.meta?.changes ?? 1) > 0) { n += 1; await event(db, now, "bridge", "intent_reconciled", { id: row.id, ticket: Number(pos.ticket) }); }
  }
  return n;
}

/**
 * An open the terminal filled but whose result line never reached the Worker (2026-11-18: ticket 389746494 was
 * open with its intent id while the intent had no result and expired). The open position that carries the intent id
 * is the terminal's own word that it ran, so the intent is recorded as done from the position, once, with an event
 * and the executed line on Telegram. A result that arrives later does not overwrite it (status 'done' is final).
 */
export async function reconcileFilledOpens(env, db, executor, now) {
  await reconcileModifies(db, executor, now);
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

/**
 * What planIntents needs for live limit entries (RFC §3-§5), read once a sync while entry_order is "limit" or "council":
 * `entryCouncil` (the stored answer for the current signal), `limitActions` (the council's fresh moves, cancels and
 * conversions), `pendingMeta` (each resting order's and each just-filled position's place_limit payload, by ticket),
 * `limitFills` (positions whose ticket is an order Omega placed and whose fill is not yet recorded) and `conversion`
 * (the last limit->market delete within the hour: its result and whether the order filled first). Never throws.
 */
export async function limitInputs(db, executor, signal, now) {
  const out = { entryCouncil: null, limitActions: [], pendingMeta: {}, limitFills: [], conversion: null };
  try {
    await ensureLimitCouncilSchema(db);
    if (signal?.side === "BUY" || signal?.side === "SELL") out.entryCouncil = await readEntryCouncil(db, openId(signal.issued_ms, signal.side));
    out.limitActions = await pendingLimitActions(db, { now });
    const orders = omegaPendingOrders(executor);
    const positions = (Array.isArray(executor?.positions) ? executor.positions : []).filter((p) => typeof p?.intent_id === "string" && p.intent_id.startsWith("open:"));
    const rows = await placeLimitRows(db, { ids: [...orders.map((o) => o.comment), ...positions.map((p) => p.intent_id)], tickets: [...orders.map((o) => o.ticket), ...positions.map((p) => p.ticket)] });
    for (const r of rows) {
      const t = Number(r.result?.ticket);
      const o = orders.find((x) => x.comment === r.id || Number(x.ticket) === t);
      if (o) { out.pendingMeta[o.ticket] = r.payload; continue; }
      // The fill: the position whose ticket is the order's (or, when the placement's result line never arrived, the
      // position carrying the intent id, as reconcileFilledOpens reads an open).
      const p = positions.find((x) => (r.result?.ok === true && Number(x.ticket) === t) || (r.result == null && x.intent_id === r.id));
      if (p) {
        out.pendingMeta[p.ticket] = r.payload;
        if (!Number.isFinite(Number(r.payload?.filled_ms))) out.limitFills.push(p.ticket);
      }
    }
    const cv = await db.prepare("SELECT payload, status, result FROM omega_intents WHERE kind = 'delete_order' AND id LIKE 'del:%:cv%' AND created_ms > ? ORDER BY created_ms DESC LIMIT 1").bind(now - 3_600_000).first();
    if (cv) {
      const it = parse(cv.payload, {}), res = parse(cv.result, null);
      const ticket = Number(it.ticket);
      const filled = (Array.isArray(executor?.positions) ? executor.positions : []).some((p) => Number(p?.ticket) === ticket);
      out.conversion = { ticket, side: it.side ?? null, signal_issued_ms: Number(it.signal_issued_ms) || null, filled,
        deleted: cv.status === "done" && res?.ok === true ? true : cv.status === "failed" || cv.status === "expired" || (cv.status === "done" && res?.ok !== true) ? false : null };
    }
  } catch { /* a limit input that cannot be read is absent: no council answer, no fill check, no conversion */ }
  return out;
}

/** A council move the terminal applied: the order's place_limit payload follows it (the planned entry, stop and target). */
async function recordLimitMove(db, it, now) {
  try {
    const row = (await placeLimitRows(db, { tickets: [it.ticket] })).find((x) => Number(x.result?.ticket) === Number(it.ticket));
    if (!row || Number.isFinite(Number(row.payload?.filled_ms))) return;
    const p = row.payload ?? {};
    const next = { ...p, entry: Number(it.volume), sl: Number(it.sl) > 0 ? Number(it.sl) : p.sl, tp: Number(it.tp) > 0 ? Number(it.tp) : p.tp, moves: (Number(p.moves) || 0) + 1 };
    await db.prepare("UPDATE omega_intents SET payload = ?, updated_ms = ? WHERE id = ?").bind(JSON.stringify(next), now, row.id).run();
  } catch { /* the snapshot of the order still shows its price */ }
}

async function eaDeletedLine(env, db, executor, r, now) {
  const key = `omega:limit:eadel:${r.id}`;
  try { if (await env.SIGNAL_CACHE?.get?.(key)) return; await env.SIGNAL_CACHE?.put?.(key, "1", { expirationTtl: 86_400 }); } catch { /* said anyway */ }
  const ticket = Number(r.ticket) || Number(String(r.id).split(":").pop()) || null;
  const why = typeof r.error === "string" && r.error ? r.error.slice(0, 40) : "by the EA";
  await event(db, now, "bridge", "limit_cancelled", { intent_id: r.id, ticket, reason: `ea_${why}` });
  await sendOmegaTelegram(env, limitLine("cancelled", { label: await brokerLabelFor(db, executor), ticket, reason: `deleted by the EA (${why})` }));
}

/** Pure: the Telegram line of a limit event (placed, moved, cancelled, filled). The owner's private chat only: it carries levels. */
export function limitLine(kind, { label = "", side = "", ticket = null, lot = null, price = null, sl = null, tp = null, reason = null, expiry_ms = null, from = null, fill = null, gap_r = null, guard = null } = {}) {
  const t = ticket != null ? ` #${ticket}` : "";
  if (kind === "placed") return `⏳ <b>Omega Limit Placed · ${label}</b>\nOrder:<code>${t}</code> ${side} ${lot ?? "—"} lot @ <code>${price}</code>\nSL: <code>${sl}</code> | TP: <code>${tp}</code>\nExpires: <code>${expiry_ms ? new Date(expiry_ms).toISOString().slice(11, 16) : "—"} UTC</code>`;
  if (kind === "moved") return `↔️ <b>Omega Limit Moved · ${label}</b>\nOrder:<code>${t}</code> ${side} <code>${from ?? "—"}</code> → <code>${price}</code>\nSL: <code>${sl}</code> | TP: <code>${tp}</code>${reason ? `\nReason: <code>${escHtml(reason)}</code>` : ""}`;
  if (kind === "cancelled") return `✖️ <b>Omega Limit Cancelled · ${label}</b>\nOrder:<code>${t}</code>${side ? ` ${side}` : ""}\nReason: <code>${escHtml(reason ?? "—")}</code>`;
  return `🟢 <b>Omega Limit Filled · ${label}</b>\nTicket:<code>${t}</code> ${side} ${lot ?? "—"} lot\nLimit: <code>${price ?? "—"}</code> | Fill: <code>${fill ?? "—"}</code>${gap_r != null ? ` (gap ${gap_r >= 0 ? "+" : ""}${gap_r}R)` : ""}\nSL: <code>${sl ?? "—"}</code> | TP: <code>${tp ?? "—"}</code>${guard ? `\n<b>Closed at once:</b> <code>fill_guard_${guard}</code>` : ""}`;
}

/**
 * After the plan (stage 3): the entry request filed for the council, the council's actions marked, and each limit fill
 * recorded once (RFC §5): the place_limit payload gets the fill (time, price, the gap in R, the guard), its stop and target
 * as filled, an event (R and times only) and the owner's line. The position is the Position Manager's from here, as any
 * Omega open.
 */
async function limitAfterPlan(env, db, { plan, limitIn, executor, now }) {
  try {
    if (plan.entry_request) await requestEntryCouncil(db, plan.entry_request, { now });
    const acts = limitIn.limitActions ?? [];
    if (acts.length) {
      const used = new Set(plan.limit_used ?? []);
      await markLimitActions(db, acts.filter((a) => used.has(a.id)).map((a) => a.id), "applied", { now });
      await markLimitActions(db, acts.filter((a) => !used.has(a.id)).map((a) => a.id), "skipped", { now });
    }
    if (plan.fill_checks?.length) {
      const label = await brokerLabelFor(db, executor);
      for (const fc of plan.fill_checks) {
        const pos = (executor?.positions ?? []).find((p) => Number(p.ticket) === Number(fc.ticket));
        const row = (await placeLimitRows(db, { ids: [pos?.intent_id], tickets: [fc.ticket] })).find((r) => Number(r.result?.ticket) === Number(fc.ticket) || (r.result == null && r.id === pos?.intent_id));
        if (!pos || !row) continue;
        const p = row.payload ?? {};
        const rDist = Number(p.r_dist) > 0 ? Number(p.r_dist) : Math.abs(Number(p.entry) - Number(p.sl));
        const gap = fillGapR({ side: p.side, planned: Number(p.entry), filled: Number(pos.open_price), rDist });
        const filledMs = Number(pos.opened_ms) > 0 ? Number(pos.opened_ms) : now;
        const next = { ...p, planned_entry: p.entry, sl: Number(pos.sl) > 0 ? Number(pos.sl) : p.sl, tp: Number(pos.tp) > 0 ? Number(pos.tp) : p.tp, filled_ms: filledMs, fill_price: Number(pos.open_price), fill_gap_r: gap, fill_guard: fc.guard ?? null };
        const res = await db.prepare("UPDATE omega_intents SET payload = ?, updated_ms = ? WHERE id = ? AND json_extract(payload, '$.filled_ms') IS NULL").bind(JSON.stringify(next), now, row.id).run();
        if (!(Number(res?.meta?.changes ?? 1) > 0)) continue;
        await event(db, now, "engine", "limit_filled", { intent_id: row.id, ticket: pos.ticket, signal_issued_ms: p.signal_issued_ms ?? null, stop_source: p.stop_source ?? null, mode: p.mode ?? null, entry_order: p.entry_order ?? null, gap_r: gap,
          wait_min: Number(p.placed_ms) > 0 ? Math.round((filledMs - Number(p.placed_ms)) / 60_000) : null, guard: fc.guard ?? null });
        await sendOmegaTelegram(env, limitLine("filled", { label, side: p.side, ticket: pos.ticket, lot: pos.volume, price: p.entry, fill: pos.open_price, gap_r: gap, sl: pos.sl, tp: pos.tp, guard: fc.guard }));
      }
    }
  } catch { /* retried at the next sync (a fill is recorded once) */ }
}

/**
 * The latest Position Manager exit for weakening or a cut loss in the last 6 hours, for the re-entry guard
 * (src/omega-engine.mjs reentryGate): { side, exit_price, exit_ms, entry_conf, ticket }, or null. The side and the exit
 * come from the closing deal, the entry confidence from the position's open intent (recorded since 2026-11-18).
 */
export async function lastWeakeningExit(db, now) {
  try {
    const row = await db.prepare("SELECT payload, updated_ms FROM omega_intents WHERE kind = 'close' AND status = 'done' AND json_extract(payload, '$.reason') IN ('pm_take_profit_weakening', 'pm_cut_loss') AND created_ms > ? ORDER BY created_ms DESC LIMIT 1").bind(now - 6 * 3_600_000).first();
    if (!row) return null;
    const ticket = Number(parse(row.payload, {}).ticket);
    if (!(ticket > 0)) return null;
    let deal = null;
    try { deal = await db.prepare("SELECT side, exit_price, closed_ms FROM ea_deals WHERE position_ticket = ? ORDER BY closed_ms DESC LIMIT 1").bind(ticket).first(); } catch { deal = null; }
    const open = await db.prepare("SELECT payload FROM omega_intents WHERE kind IN ('open', 'place_limit') AND json_extract(result, '$.ticket') = ? LIMIT 1").bind(ticket).first();
    const p = parse(open?.payload, {});
    const side = deal?.side ?? p.side ?? null;
    if (side !== "BUY" && side !== "SELL") return null;
    return { side, ticket, exit_price: Number.isFinite(Number(deal?.exit_price)) ? Number(deal.exit_price) : null, exit_ms: Number(deal?.closed_ms) || Number(row.updated_ms) || null, entry_conf: Number.isFinite(Number(p.agent_conf)) ? Number(p.agent_conf) : null };
  } catch { return null; }
}

/**
 * One Position Manager line (src/position-actions.mjs actionMessage). An applied or refused action is always said; the
 * same "not applied" reason for the same ticket and rule is said once an hour (PM PR 2: no line every five minutes).
 */
export const PM_NOT_APPLIED_REPEAT_MS = 3_600_000;
async function sendPmLine(env, row, outcome) {
  if (outcome?.applied !== true && env?.SIGNAL_CACHE?.get) {
    const key = `pm:na:${row.ticket}:${row.rule}:${String(outcome?.reason ?? "").slice(0, 80)}`;
    try {
      if (await env.SIGNAL_CACHE.get(key)) return;
      await env.SIGNAL_CACHE.put(key, "1", { expirationTtl: Math.round(PM_NOT_APPLIED_REPEAT_MS / 1000) });
    } catch { /* said anyway */ }
  }
  await sendOmegaTelegram(env, escHtml(actionMessage(row, outcome)));
}

/** Pure: plain text made safe for Telegram's HTML mode. */
export const escHtml = (t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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

export const LIMIT_FAULT_KINDS = Object.freeze(["place_limit", "modify_order", "delete_order"]);
/** The two faults (owner 2026-11-21, split): no ticket → market entries until the owner saves; no answer → no entry until the EA answers again. */
export const LIMIT_FAULT_NO_TICKET = "the EA answered without a ticket";
export const LIMIT_FAULT_NO_ANSWER = "the EA never answered";
/**
 * Pure: why a limit intent's EA result is missing or malformed, or null. Missing: expired with no result line (the EA
 * never answered). Malformed: a place_limit the EA said was placed without a ticket.
 */
export function limitFault(row) {
  if (!row || !LIMIT_FAULT_KINDS.includes(row.kind)) return null;
  const result = parse(row.result, null);
  if (row.status === "expired" && result == null) return LIMIT_FAULT_NO_ANSWER;
  if (row.kind === "place_limit" && result && result.ok === true && !(Number(result.ticket) > 0)) return LIMIT_FAULT_NO_TICKET;
  return null;
}
/**
 * Opens the limit fault (once per episode: none while one is open), only while entry_order is limit or council and for an
 * intent created after the owner's last save: omega_settings.limit_fault, one limit_fail_closed audit row and one
 * Telegram line. Read by the sync from the settings row it reads anyway (no query per sync). Never throws.
 */
export async function recordLimitFault(env, db, fault, { now = Date.now() } = {}) {
  try {
    const res = await db.prepare("UPDATE omega_settings SET limit_fault = ? WHERE id = 1 AND limit_fault IS NULL AND json_extract(settings, '$.entry_order') IN ('limit', 'council') AND ? > COALESCE(owner_saved_ms, 0)")
      .bind(JSON.stringify({ ...fault, at_ms: now }), Number(fault.created_ms) || now).run();
    if (!(Number(res?.meta?.changes) > 0)) return false;
    await event(db, now, "engine", "limit_fail_closed", fault);
    await sendOmegaTelegram(env, escHtml(fault.why === LIMIT_FAULT_NO_ANSWER
      ? `XAUUSD SYSTEM · Entries stopped (fail closed): a ${fault.kind} intent, ${fault.why}. No new entry and no loosening until the EA answers again${fault.ea_silent ? " (its heartbeat counts)" : ""} or you save the Omega settings; closes and protection still go out, resting limits are deleted. Check the terminal and the EA (OmegaExecutor 1.21).`
      : `XAUUSD SYSTEM · Limit entries stopped (fail closed): a ${fault.kind} intent, ${fault.why}. Omega enters at market and deletes its resting limits until you save the Omega settings again; check the EA (OmegaExecutor 1.21) and its result lines first.`));
    return true;
  } catch { return false; }
}

/** Clears an open "never answered" fault when the EA answers again: one audit row and one Telegram line. Never throws. */
export async function clearNoAnswerFault(env, db, { now = Date.now(), by = "a result line" } = {}) {
  try {
    const res = await db.prepare("UPDATE omega_settings SET limit_fault = NULL WHERE id = 1 AND json_extract(limit_fault, '$.why') = ?").bind(LIMIT_FAULT_NO_ANSWER).run();
    if (!(Number(res?.meta?.changes) > 0)) return false;
    await event(db, now, "engine", "limit_fault_cleared", { why: "the EA answers again", by });
    await sendOmegaTelegram(env, escHtml("XAUUSD SYSTEM · The EA answers again: entries resume (the fail-closed stop of a limit the EA never answered is lifted)."));
    return true;
  } catch { return false; }
}

export async function readSettings(env) {
  await ensureSchema(env.DB);
  const row = await env.DB.prepare("SELECT settings, version, updated_by, updated_ms, limit_fault, owner_saved_ms FROM omega_settings WHERE id = 1").first();
  return { settings: { ...OMEGA_DEFAULTS, ...parse(row?.settings, {}) }, version: Number(row?.version ?? 0), updated_by: row?.updated_by ?? null, updated_ms: row?.updated_ms ?? null,
    limit_fault: parse(row?.limit_fault, null), owner_saved_ms: Number(row?.owner_saved_ms) || null };
}

export async function writeSettings(env, { body, actor }, { now = Date.now() } = {}) {
  const current = await readSettings(env);
  // The terminal's OmegaExecutor version (its self-report in the last bridge state): "limit" and "council" need 1.21.
  let eaVersion = null;
  try { eaVersion = parse((await env.DB.prepare("SELECT state FROM omega_bridge WHERE id = 1").first())?.state, null)?.executor?.version ?? null; } catch { eaVersion = null; }
  const r = settingsFrom(body, current.settings, { ea_version: eaVersion });
  if (r.error) return { ok: false, error: r.error };
  const version = current.version + 1;
  // A save by a person (not Aether's policy write nor its rollback) clears an open limit fault: the owner looked at it.
  const byOwner = !/^aether/i.test(String(actor ?? ""));
  await env.DB.prepare("UPDATE omega_settings SET settings = ?, version = ?, updated_by = ?, updated_ms = ?, limit_fault = CASE WHEN ? = 1 THEN NULL ELSE limit_fault END, owner_saved_ms = CASE WHEN ? = 1 THEN ? ELSE owner_saved_ms END WHERE id = 1")
    .bind(JSON.stringify(r.settings), version, actor, now, byOwner ? 1 : 0, byOwner ? 1 : 0, now).run();
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
  const row = await env.DB.prepare("SELECT version, status, server, kid, updated_by, updated_ms, trade_symbol, units_per_usd FROM omega_connection WHERE id = 1").first();
  return { version: Number(row.version), status: row.status, server: row.server ?? null, kid: row.kid ?? null, updated_by: row.updated_by ?? null, updated_ms: row.updated_ms ?? null, trade_symbol: row.status === "stored" ? ownerTradeSymbol(row.trade_symbol) : null, units_per_usd: row.status === "stored" && Number(row.units_per_usd) > 0 ? Number(row.units_per_usd) : null };
}

/**
 * Store the connection. `trade_symbol` (optional, owner 2026-11-18 for cent accounts): the exact name of the account's
 * gold symbol when it is not on the USD gold list (e.g. "GoldOne"). It is not a secret, so it travels beside the
 * envelope: the bridge opens its chart first and the EA may trade it, still only under the contract checks, and the
 * engine opens nothing on it until it prices within 2% of the reference gold price. Empty means the list only.
 */
export async function setConnection(env, { envelope, server, actor, trade_symbol = null, units_per_usd = null }, { now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  const name = typeof server === "string" ? server.trim() : "";
  if (!SERVER_RE.test(name)) return { ok: false, error: "server must be 1-64 letters, digits, dot, dash, underscore or space" };
  const symText = typeof trade_symbol === "string" ? trade_symbol.trim() : "";
  if (trade_symbol != null && typeof trade_symbol !== "string") return { ok: false, error: "trade_symbol must be text" };
  if (symText && !TRADE_SYMBOL_RE.test(symText)) return { ok: false, error: "trade_symbol must be 1-32 letters, digits, dot, dash, underscore, # or +" };
  const tradeSymbol = symText || null;
  // Optional: how many units of the account currency make one US dollar (e.g. 100 for a cent account), for an account
  // that is not in USD and has not traded yet. Its trades measure it from then on; a disagreement opens nothing.
  if (units_per_usd != null && (typeof units_per_usd !== "number" || !Number.isFinite(units_per_usd) || units_per_usd <= 0 || units_per_usd > 1_000_000)) return { ok: false, error: "units_per_usd must be a positive number" };
  const unitsPerUsd = units_per_usd ?? null;
  const bad = envelopeError(envelope);
  if (bad) return { ok: false, error: bad };
  const text = JSON.stringify(envelope);
  if (text.length > ENVELOPE_MAX_BYTES) return { ok: false, error: "envelope_too_large" };
  const bridge = await env.DB.prepare("SELECT kid FROM omega_bridge WHERE id = 1").first();
  if (!bridge?.kid) return { ok: false, error: "bridge_not_seen" };
  if (bridge.kid !== envelope.kid) return { ok: false, error: "kid_mismatch" };
  const cur = await connectionStatus(env);
  const version = cur.version + 1;
  await env.DB.prepare("UPDATE omega_connection SET version = ?, status = 'stored', server = ?, kid = ?, envelope = ?, updated_by = ?, updated_ms = ?, trade_symbol = ?, units_per_usd = ? WHERE id = 1")
    .bind(version, name, envelope.kid, text, actor, now, tradeSymbol, unitsPerUsd).run();
  await event(env.DB, now, actor, "connection_set", { server: name, version, trade_symbol: tradeSymbol, units_per_usd: unitsPerUsd });
  return { ok: true, version, status: "stored", server: name, trade_symbol: tradeSymbol, units_per_usd: unitsPerUsd };
}

export async function clearConnection(env, { actor, reason }, { now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  const why = typeof reason === "string" ? reason.trim().slice(0, 200) : "";
  if (!why) return { ok: false, error: "a reason is required to disconnect" };
  const cur = await connectionStatus(env);
  const version = cur.version + 1;
  await env.DB.prepare("UPDATE omega_connection SET version = ?, status = 'cleared', server = NULL, envelope = NULL, trade_symbol = NULL, units_per_usd = NULL, updated_by = ?, updated_ms = ? WHERE id = 1").bind(version, actor, now).run();
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

/**
 * Pure: a terminal journal line without an account number. MT5 writes the login in its authorization lines
 * ("'5012345': authorization on ... failed"); a run of 5 or more digits becomes "[account]" (prices have a dot).
 */
export function redactAccount(text) {
  return typeof text === "string" ? text.replace(/(^|[^\d.])\d{5,}(?![\d.])/g, "$1[account]") : text;
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
    // omega-bridge 1.4.0+: the terminal's last login or start error (e.g. the EA failed to start on a chart symbol
    // the account lacks), sent also while no EA state exists. Never a login, password or account number.
    terminal_error: redactAccount(s(v.terminal_error, 160)),
    since_ms: typeof v.since_ms === "number" && Number.isFinite(v.since_ms) ? v.since_ms : null
  };
}

/** The executor state as the bridge reports it; anything malformed is null (the engine then waits). */
export function executorFrom(state, { ownerUnitsPerUsd = null, stored = false } = {}) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const a = state.account ?? {}, s = state.symbol ?? {};
  const out = {
    connected: state.connected === true,
    trade_allowed: typeof state.trade_allowed === "boolean" ? state.trade_allowed : (state.connected === true ? true : null),
    server: typeof state.server === "string" ? state.server.slice(0, 64) : null,
    received_ms: n(state.received_ms),
    terminal_error: typeof state.terminal_error === "string" ? redactAccount(state.terminal_error.slice(0, 200)) : null,
    // OmegaExecutor 1.12+: its version and whether it still moves stops by itself (null when not reported).
    executor: executorInfoFrom(state.executor),
    account: {
      trade_mode: ["demo", "real", "contest"].includes(a.trade_mode) ? a.trade_mode : null, currency: typeof a.currency === "string" ? a.currency.slice(0, 8) : null, balance: n(a.balance), equity: n(a.equity), day_start_balance: n(a.day_start_balance), day_realized_pl: n(a.day_realized_pl),
      // OmegaExecutor 1.15+ (docs/RFC_ACCOUNT_PROFILES.md §1): the account spec, and an opaque hash in place of the login.
      leverage: n(a.leverage),
      margin_mode: ["hedging", "netting", "exchange", "unknown"].includes(a.margin_mode) ? a.margin_mode : null,
      margin_free: n(a.margin_free),
      login_hash: typeof a.login_hash === "string" && /^[0-9a-f]{64}$/.test(a.login_hash) ? a.login_hash : null,
      // OmegaExecutor 1.19+: the broker's company as the terminal reports it (the label; never a login).
      company: typeof a.company === "string" && a.company.trim() ? a.company.trim().slice(0, 64) : null
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
    symbol_error: typeof state.symbol_error === "string" && state.symbol_error ? state.symbol_error.slice(0, 200) : null,
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
  // The state D1 keeps (omega_bridge.state) is this function's own output, already in US dollars. Read back with
  // `stored`, it keeps the money and tick figures it was converted with and is never divided again (orchestrator review
  // of #477: a cent account with the owner's value and no trade would otherwise be divided by 100 twice).
  if (stored) {
    const m = a.money && typeof a.money === "object" ? a.money : null;
    out.account.money = m ? { ...m } : null;
    out.account.cent = a.cent === true;
    out.symbol.tick_value_reported = n(s.tick_value_reported);
    out.symbol.tick_value_problem = typeof s.tick_value_problem === "string" ? s.tick_value_problem : null;
    return out;
  }
  return toUsd(out, { ownerUnitsPerUsd });
}

/**
 * Every amount Omega works with is in US dollars, on any account (owner 2026-11-19: "Harusnya bisa universal apapun
 * broker, nama pair maupun servernya"). The account's units per dollar come from accountMoney (src/gold-symbol.mjs):
 * one for a USD account, otherwise measured from its own trades or, before it has traded, the owner's value; never
 * from a list of currency codes. Each amount is divided by it once, here, where the bridge's state enters: balance,
 * equity, the day's start and result, free margin, a lot's margin (in the deposit currency), and each position's and
 * deal's profit, commission and swap. The account keeps its currency for the label and carries `money` (the ratio,
 * where it came from and any problem) and `cent` (100 units a dollar). Ratios (risk %, daily loss %) are unchanged.
 * With no verified ratio nothing is converted and the engine opens nothing (gate money_unverified).
 */
const near = (a, b) => Math.abs(a - b) <= Math.max(1e-12, Math.abs(b) * 0.01);
export function toUsd(ex, { ownerUnitsPerUsd = null } = {}) {
  if (!ex) return ex;
  const money = accountMoney({ currency: ex.account?.currency, positions: ex.positions, deals: ex.deals, symbol: ex.symbol, ownerUnitsPerUsd });
  const k = money.units_per_usd;
  if (ex.account) { ex.account.money = money; ex.account.cent = typeof k === "number" && Math.abs(k - 100) <= 1; }
  const scale = typeof k === "number" && k > 0 && k !== 1 ? 1 / k : null;
  const c = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * scale * 1e6) / 1e6 : v);
  if (scale) {
    const a = ex.account;
    for (const key of ["balance", "equity", "day_start_balance", "day_realized_pl", "margin_free"]) a[key] = c(a[key]);
    ex.symbol.margin_per_lot = c(ex.symbol.margin_per_lot);
    for (const p of ex.positions) p.profit = c(p.profit);
    for (const d of ex.deals) { d.profit = c(d.profit); d.commission = c(d.commission); d.swap = c(d.swap); }
  }
  usdTickValue(ex, k);
  return ex;
}

/**
 * The tick value Omega sizes on (incident 2026-11-18: a 3-lot GoldOne SELL on a $54.50 cent account risked about 82%
 * of it at the stop, because the broker reported a tick value in dollars while the account was in cents). For a
 * USD-priced instrument one tick of one lot is worth exactly contract_size × tick_size dollars, on any broker, so
 * Omega uses that. The broker's figure is kept as `tick_value_reported`; when it is neither that value in the
 * account's units (× units per dollar) nor that value in dollars, `tick_value_problem` is set and the engine opens
 * nothing (gate tick_value_mismatch).
 */
function usdTickValue(ex, k) {
  const s = ex.symbol, raw = s.tick_value;
  const fin = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
  s.tick_value_problem = null;
  if (s.currency_profit === "USD" && fin(s.contract_size) && fin(s.tick_size)) {
    const expected = Math.round(s.contract_size * s.tick_size * 1e9) / 1e9;
    if (fin(raw)) {
      s.tick_value_reported = raw;
      const ok = near(raw, expected) || (fin(k) && near(raw, expected * k));
      if (!ok) s.tick_value_problem = "tick_value_mismatch";
    }
    s.tick_value = expected;
    return;
  }
  // Not priced in USD: never traded (goldSymbolCheck); the reported figure in dollars where the ratio is known.
  if (fin(raw) && fin(k) && k !== 1) s.tick_value = Math.round((raw / k) * 1e9) / 1e9;
}

export const CLOSE_MAX_ATTEMPTS = 10;
/**
 * The bridge never executes an id twice. An open is planned once per signal and never retried. A
 * close or close_all that is still needed after its attempts ended (failed, expired, or done while the
 * position is still there) gets the next attempt id `<id>:<n>`; none while an attempt is in flight.
 */
async function withAttempt(db, it) {
  // An entry (a market open or a resting limit) is planned once per signal and never retried.
  if (it.kind === "open" || it.kind === "place_limit") return it;
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
// The reference's inputs, read at most once a minute per isolate (the bridge syncs every 5 seconds; the 4h series and
// the fallback state change far slower): the cached 4h series, the running fallback's start, and the last recorded
// fallback interval (D1 health_alerts market_data_fallback), whose 4h bars were built on the broker's own prices.
const DEALS_TAGGED = new Set();
let REFERENCE_SOURCES = null;
export function resetReferenceSourcesForTests() { REFERENCE_SOURCES = null; }
async function referenceSources(env, now) {
  if (REFERENCE_SOURCES && now - REFERENCE_SOURCES.at < 60_000 && REFERENCE_SOURCES.env === env) return REFERENCE_SOURCES;
  let h4 = null, excluded = [];
  try { h4 = JSON.parse((await env.SIGNAL_CACHE?.get?.("market-data:v2:series:OANDA:XAUUSD|4h")) || "null"); } catch { h4 = null; }
  try {
    const row = await env.DB.prepare("SELECT opened_at, resolved_at FROM health_alerts WHERE alert_key = 'market_data_fallback'").first();
    const a = Date.parse(row?.opened_at ?? ""), b = row?.resolved_at ? Date.parse(row.resolved_at) : null;
    // The alert opens on a health check after the fallback starts: 15 minutes of margin before it.
    if (Number.isFinite(a)) excluded = [[a - 900_000, Number.isFinite(b) ? b : null]];
  } catch { excluded = []; }
  REFERENCE_SOURCES = { at: now, env, h4, fallbackSince: await fallbackSinceMs(env), excluded };
  return REFERENCE_SOURCES;
}

/**
 * The light sync (owner 2026-11-19: "Keduanya, bertahap", step 1 of cutting the bridge stream's cost). The bridge
 * syncs on every state.json write, about 1.7 times a second, and each full sync plans with about 15 D1 statements.
 * A sync may reuse this isolate's last full plan, and only deliver the open intents, when all of these hold:
 * - the last full plan is at most LIGHT_SYNC_MAX_AGE_MS old;
 * - the state that matters (bridgeStateKey), the connection, the key and the bridge version are unchanged;
 * - the terminal is connected with no open position and no pending order;
 * - the request carries no result and no corpus, macro or calendar data.
 * Anything else, including any open position, runs the full plan, so the management of a position is never slower.
 */
export const LIGHT_SYNC_MAX_AGE_MS = 5_000;
const LIGHT_SYNC = new WeakMap();
export function lightSyncEligible({ last, lightKey, executor, results, corpus, corpusMacro, calendar, now }) {
  if (!last || last.lightKey !== lightKey || !(now >= last.at) || now - last.at >= LIGHT_SYNC_MAX_AGE_MS) return false;
  if (Array.isArray(results) && results.length) return false;
  if (corpus || corpusMacro || calendar) return false;
  if (executor?.connected !== true) return false;
  if ((Array.isArray(executor.positions) && executor.positions.length) || (Array.isArray(executor.orders) && executor.orders.length)) return false;
  return true;
}

/**
 * The bridge's stream mode (owner 2026-11-19: "Keduanya, bertahap", step 2; omega-bridge 1.7.0+). "calm": nothing to
 * manage (the terminal connected, no position, no pending order, no open intent, no recovery or review), so the
 * bridge may skip the syncs its state.json writes would start and sync on its own period (OMEGA_SYNC_MS, 5 s).
 * "fast" otherwise. The bridge also goes fast by itself when its own state shows a position or an order, or a
 * result waits. OMEGA_BRIDGE_CALM "off" always answers "fast". An older bridge ignores the field.
 */
export function bridgeStreamMode(env, { executor, intents = [], recovery = null, reviewStarted = false } = {}) {
  if (String(env?.OMEGA_BRIDGE_CALM ?? "").toLowerCase() === "off") return "fast";
  if (executor?.connected !== true || recovery || reviewStarted) return "fast";
  if ((Array.isArray(executor.positions) && executor.positions.length) || (Array.isArray(executor.orders) && executor.orders.length)) return "fast";
  return Array.isArray(intents) && intents.length ? "fast" : "calm";
}

export async function bridgeSync(env, { state, results, publicKey, kid, bridgeVersion, corpus = null, corpusMacro = null, calendar = null, bridgeSymbol = null } = {}, { now = Date.now(), signal: signalIn } = {}) {
  await ensureSchema(env.DB);
  const db = env.DB;
  if (typeof kid !== "string" || !KID_RE.test(kid) || typeof publicKey !== "string" || !B64_RE.test(publicKey) || publicKey.length > 1024) return { ok: false, error: "kid and public_key are required" };
  // The connection the bridge must apply (read once: its owner-set gold symbol and money value go with the state too).
  const conn = await db.prepare("SELECT version, status, server, kid, envelope, trade_symbol, units_per_usd FROM omega_connection WHERE id = 1").first();
  const executor = executorFrom(state, { ownerUnitsPerUsd: conn?.status === "stored" ? Number(conn.units_per_usd) || null : null });
  const ownerSymbol = conn?.status === "stored" ? ownerTradeSymbol(conn.trade_symbol) : null;
  if (executor) executor.owner_symbol = ownerSymbol;
  // omega-bridge 1.3.0+ reports its chart-symbol resolution beside the state (also while no EA runs).
  const resolution = bridgeSymbolFrom(bridgeSymbol);
  if (executor && resolution) executor.bridge_symbol = resolution;
  // The account's opaque login hash (OmegaExecutor 1.15) is used for its reference in this sync only, never stored
  // with the state that the pages, the health check and the watchdog read. The reference itself (account_ref, the
  // opaque id the pages show) is stored, so the cron and the owner's controls find this very account (connectedAccount).
  if (executor) executor.account_ref = (await accountRef(executor)).ref;
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
  // The light path (owner 2026-11-19: "Keduanya, bertahap", step 1): a sync with nothing to manage and nothing new
  // reuses the last full plan of this isolate, at most LIGHT_SYNC_MAX_AGE_MS old, and only delivers the open intents.
  const lightKey = `${bridgeStateKey(executor)}|${conn?.version ?? ""}|${conn?.status ?? ""}|${kid}|${version}`;
  const last = LIGHT_SYNC.get(db);
  if (lightSyncEligible({ last, lightKey, executor, results, corpus, corpusMacro, calendar, now })) {
    const open = (await db.prepare("SELECT id, status, payload FROM omega_intents WHERE status IN ('pending', 'sent') ORDER BY created_ms, id").all()).results ?? [];
    if (open.some((r) => r.status === "pending")) await db.prepare("UPDATE omega_intents SET status = 'sent', updated_ms = ? WHERE status = 'pending'").bind(now).run();
    const openIntents = open.map((r) => parse(r.payload)).filter(Boolean);
    return { ...last.response, intents: openIntents, corpus_cursor_ms: null, corpus_macro_cursors: null, calendar_seen_ms: null, stream_mode: bridgeStreamMode(env, { executor, intents: openIntents }), light: true };
  }
  // The bridge found no chart symbol the server has (exhausted) or stopped on a login failure: an event once per
  // change, which the health alert reads while no fresh, verified state says otherwise.
  if (resolution && (resolution.status === "exhausted" || resolution.status === "stopped")) {
    const last = await db.prepare("SELECT detail FROM omega_events WHERE action = 'bridge_symbol' ORDER BY id DESC LIMIT 1").first();
    const was = parse(last?.detail, {});
    if (was?.status !== resolution.status || was?.server !== resolution.server) await event(db, now, "bridge", "bridge_symbol", resolution);
  }
  // The terminal's own error while no EA runs (e.g. "symbol synchronization timeout" on a chart the account lacks):
  // an event once per change, so the Omega page says why nothing trades instead of showing a blank state.
  if (!executor && resolution?.terminal_error) {
    const last = await db.prepare("SELECT detail FROM omega_events WHERE action = 'terminal_error' ORDER BY id DESC LIMIT 1").first();
    if (parse(last?.detail, {})?.error !== resolution.terminal_error) await event(db, now, "bridge", "terminal_error", { server: resolution.server, chart_symbol: resolution.chart_symbol, error: resolution.terminal_error });
  }
  // The traded symbol is never silent (owner 2026-11-17, PR #405): a change on the same server and a refusal
  // (not USD gold, or the EA's own symbol_error) are events on the Omega page; the health alert says it too.
  if (executor) {
    const before = parse(prev?.state);
    const name = executor.symbol?.name ?? null, prevName = before?.symbol?.name ?? null;
    if (name && prevName && name !== prevName && before?.server === executor.server) {
      await event(db, now, "bridge", "symbol_changed", { server: executor.server, from: prevName, to: name });
    }
    const check = goldCheckOf(executor);
    const prevCheck = before ? goldCheckOf(before) : null;
    if (!check.ok && (prevCheck?.ok !== false || prevCheck.problem !== check.problem || prevName !== name)) {
      await event(db, now, "bridge", "symbol_refused", { server: executor.server, symbol: name, problem: check.problem, currency_profit: executor.symbol?.currency_profit ?? null, contract_size: executor.symbol?.contract_size ?? null });
    }
  }

  // The deals this account reports (its last 100 from the terminal) are its own: one stored before the account was
  // recorded takes it now, once per isolate and ticket (owner 2026-11-19: pages show the connected account's deals).
  if (Array.isArray(executor?.deals) && executor.deals.length > 0 && typeof executor.account_ref === "string") {
    const untagged = executor.deals.map((d) => Number(d?.deal_ticket)).filter((t) => Number.isInteger(t) && t > 0 && !DEALS_TAGGED.has(`${executor.account_ref}|${t}`));
    if (untagged.length) {
      try {
        await ensureDealsSchema(db);
        // D1 binds at most 100 parameters a statement: 50 tickets (and the reference) at a time.
        for (let i = 0; i < untagged.length; i += 50) {
          const part = untagged.slice(i, i + 50);
          await db.prepare(`UPDATE ea_deals SET account_ref = ? WHERE account_ref IS NULL AND deal_ticket IN (${part.map(() => "?").join(",")})`).bind(executor.account_ref, ...part).run();
          for (const t of part) DEALS_TAGGED.add(`${executor.account_ref}|${t}`);
        }
      } catch { /* tried again by the next isolate */ }
    }
  }

  // Persist closed deals reported by MT5 terminal
  const newDeals = [];
  if (Array.isArray(executor?.deals) && executor.deals.length > 0) {
    const known = storedDeals(db);
    for (const d of executor.deals) {
      if (!d?.deal_ticket || !d?.closed_ms) continue;
      // Stored before, with its source when it has one: nothing to write.
      const seenKey = `${d.deal_ticket}|${d.source ?? ""}`;
      if (known.has(seenKey)) continue;
      try {
        const stored = await storeDeal(env, {
          account_ref: executor.account_ref ?? null,
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
          // Deals were converted to USD in executorFrom (toUsd) when the account's units per dollar are known.
          currency: Number(executor?.account?.money?.units_per_usd) > 0 ? "USD" : (executor?.account?.currency || "USD"),
          source: d.source
        }, { now });
        if (stored?.ok) known.add(seenKey);
        if (stored?.ok && stored.stored === true) newDeals.push(d);
      } catch {
        // Ignored; deals persistence should not disrupt sync cycle
      }
    }
  }

  let eaAnswered = false;
  for (const r of Array.isArray(results) ? results.slice(0, 100) : []) {
    if (typeof r?.id !== "string") continue;
    // OmegaExecutor 1.21 deletes its own pending limits by itself (expired, max_life, the dead-man switch): said once.
    if (r.id.startsWith("ea:del:") && r.ok === true) { await eaDeletedLine(env, db, executor, r, now); continue; }
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
    // The EA answers again: a "never answered" fault clears itself (owner 2026-11-21: "until the EA answers again").
    if (!eaAnswered) { eaAnswered = true; await clearNoAnswerFault(env, db, { now }); }
    // A placement the EA reports as placed without a ticket: the limit fault (fail closed).
    if (p?.kind === "place_limit" && limitFault({ kind: "place_limit", status: result.ok ? "done" : "failed", result: JSON.stringify(result) })) {
      await recordLimitFault(env, db, { intent_id: r.id, kind: "place_limit", why: LIMIT_FAULT_NO_TICKET, created_ms: Number(existing?.created_ms) || now }, { now });
    }
    if (existing && (existing.status === "pending" || existing.status === "sent")) {
      // A Position Manager intent: its own line, as the broker answered (owner 2026-11-19: say what reached the broker).
      const pmId = actionIdOfIntent(r.id);
      if (pmId) {
        const row = (await positionActionRows(db, [pmId]))[pmId];
        if (row) await sendPmLine(env, row, result.ok ? { applied: true } : { applied: false, reason: `the broker refused it (${result.error || "no reason given"})` });
        // ADR-0020 Amendment 8: every loosening and council target move, as the broker answered, in omega_events (R and
        // the rule, no price, no account).
        if (p?.loosen === true || /^pm_tp_(nearer|further)_/.test(String(p?.reason ?? ""))) {
          await event(db, now, "engine", p.loosen === true ? "pm_stop_loosened" : "pm_tp_moved", { intent_id: r.id, ticket: Number(p.ticket) || null, rule: String(p.reason ?? "").replace(/^pm_/, ""), mode: p.mode ?? null, applied: result.ok,
            ...(p.loosen === true ? { risk_r_before: p.risk_r_before ?? null, risk_r_after: p.risk_r_after ?? null } : { tp_r_from: p.tp_r_from ?? null, tp_r_to: p.tp_r_to ?? null }), ...(result.ok ? {} : { error: result.error ?? null }) });
        }
        continue;
      }
      // The broker label of this terminal, e.g. "FxPro (DEMO) · GOLD"; "broker unknown" until its spec is validated.
      const label = await brokerLabelFor(db, executor);
      if (result.ok) {
        if (p?.kind === "open") {
          const tcaText = (result.slippage_pts != null || latencyMs != null)
            ? `\nLatency: <code>${latencyMs != null ? `${latencyMs}ms` : "—"}</code> | Slippage: <code>${result.slippage_pts != null ? `${result.slippage_pts} pts` : "0 pts"}</code>`
            : "";
          // The exposure in USD (owner 2026-11-18): the lot alone is ambiguous across brokers and cent accounts.
          const xp = positionExposure({ side: p.side, volume: p.volume, open_price: result.fill_price || p.entry, sl: p.sl }, executor?.symbol, executor?.account?.equity);
          const xpText = xp ? `\nExposure: <code>${exposureText(xp)}</code>` : "";
          await sendOmegaTelegram(env, `🟢 <b>Omega Order Executed · ${label}</b>${p.probation === true ? " · <b>PROBATION ½ risk</b> (counter-trend reversal)" : ""}\nTicket: <code>#${result.ticket || "—"}</code>\nSide: <b>${p.side}</b> | Volume: <code>${p.volume}</code> lot ${executor?.symbol?.name ?? ""}\nEntry: <code>${p.entry || "—"}</code> | Fill: <code>${result.fill_price || p.entry || "—"}</code>\nSL: <code>${p.sl}</code> | TP: <code>${p.tp}</code>${xpText}${tcaText}`);
        } else if (p?.kind === "partial_close") {
          // A full close is said from its exit deal (announceExits above, at this or the next sync): entry, exit, result.
          await sendOmegaTelegram(env, `💰 <b>Omega Position Scaled Out (${p.volume ?? "part"} lot) · ${label}</b>\nTicket: <code>#${result.ticket || p.ticket || "—"}</code>\nReason: <code>${p.reason || "executed"}</code>`);
        } else if (p?.kind === "modify_tp") {
          await sendOmegaTelegram(env, `🎯 <b>Extended TP Expanded (Runner) · ${label}</b>\nTicket: <code>#${p.ticket}</code>\nNew TP: <code>${p.tp}</code>`);
        } else if (p?.kind === "place_limit") {
          // Limit entries (docs/RFC_OMEGA_LIMIT_ENTRY.md §5): placed, moved, cancelled and filled, to the owner's private chat.
          await event(db, now, "engine", "limit_placed", { intent_id: r.id, ticket: result.ticket, side: p.side, mode: p.mode ?? null, entry_order: p.entry_order ?? null, away_r: p.away_r ?? null, life_min: p.knobs?.max_pending_life ?? null });
          await sendOmegaTelegram(env, limitLine("placed", { label, side: p.side, ticket: result.ticket, lot: p.lot, price: p.entry, sl: p.sl, tp: p.tp, expiry_ms: p.expiry_ms }));
        } else if (p?.kind === "delete_order") {
          await event(db, now, "engine", "limit_cancelled", { intent_id: r.id, ticket: p.ticket, reason: p.reason ?? null });
          await sendOmegaTelegram(env, limitLine("cancelled", { label, ticket: p.ticket, side: p.side ?? "", reason: p.reason }));
        } else if (p?.kind === "modify_order" && String(r.id).startsWith("mo:")) {
          await recordLimitMove(db, p, now);
          await event(db, now, "engine", "limit_moved", { intent_id: r.id, ticket: p.ticket, reason: p.reason ?? null });
          await sendOmegaTelegram(env, limitLine("moved", { label, ticket: p.ticket, from: p.from_price, price: p.volume, sl: p.sl, tp: p.tp, reason: p.reason }));
        }
      } else if (result.error) {
        await sendOmegaTelegram(env, `⚠️ <b>Omega Intent Rejected · ${label}</b>\nTicket: <code>#${result.ticket || p?.ticket || "—"}</code>\nKind: <code>${p?.kind || "—"}</code>\nError: <code>${result.error}</code>`);
      }
    }
  }
  await reconcileFilledOpens(env, db, executor, now);
  // Every Omega (or delegated) position that left the book, the broker's take-profit and stop included, is said once
  // with its reason, entry, exit and result (owner 2026-11-19; src/position-exit.mjs). After the results above, so an
  // Omega close answered in this same sync gives its reason.
  if (newDeals.length) {
    try {
      let delegatedTickets = [];
      if (newDeals.some((d) => d?.source !== "omega")) delegatedTickets = (await readDelegations(db)).tickets;
      const label = await brokerLabelFor(db, executor);
      await announceExits(db, newDeals, { openTickets: (Array.isArray(executor?.positions) ? executor.positions : []).map((p) => p?.ticket), delegated: delegatedTickets, now, label,
        send: (t) => sendOmegaTelegram(env, t), log: (action, detail) => event(db, now, "engine", action, detail) });
    } catch { /* the deals are stored; the notices are lost */ }
  }
  // A Position Manager intent the terminal never answered is said as not applied (the expiry below).
  // The intents about to expire, read once: a Position Manager one is said as not applied; a limit one the EA never
  // answered is the limit fault (fail closed).
  const expiring = (await db.prepare("SELECT id, kind, created_ms FROM omega_intents WHERE status IN ('pending', 'sent') AND created_ms < ? AND (id LIKE 'pm:%' OR id LIKE 'd:pm:%' OR id LIKE 'pm1:%' OR id LIKE 'd:pm1:%' OR kind IN ('place_limit', 'modify_order', 'delete_order')) LIMIT 100").bind(now - INTENT_TTL_MS).all()).results ?? [];
  const pmExpiring = expiring.filter((r) => /^(d:)?pm1?:/.test(String(r.id))).map((r) => r.id);
  const limitExpiring = expiring.find((r) => LIMIT_FAULT_KINDS.includes(r.kind));
  // ea_silent: the EA's own state was stale too (a VPS restart, the terminal down), so its heartbeat coming back lifts the
  // stop; an EA alive that did not answer needs a real answer or the owner's save.
  if (limitExpiring) await recordLimitFault(env, db, { intent_id: limitExpiring.id, kind: limitExpiring.kind, why: LIMIT_FAULT_NO_ANSWER, created_ms: Number(limitExpiring.created_ms) || now,
    ea_silent: !(Number(executor?.received_ms) > 0) || now - Number(executor.received_ms) > 60_000 }, { now });
  await db.prepare("UPDATE omega_intents SET status = 'expired', updated_ms = ? WHERE status IN ('pending', 'sent') AND created_ms < ?").bind(now, now - INTENT_TTL_MS).run();
  if (pmExpiring.length) {
    const rows = await positionActionRows(db, pmExpiring.map(actionIdOfIntent).filter(Boolean));
    for (const row of Object.values(rows)) await sendPmLine(env, row, { applied: false, reason: `the terminal did not answer within ${Math.round(INTENT_TTL_MS / 60_000)} minutes` });
  }

  // The connection the bridge must apply (read above).
  let connection = null;
  if (conn.status === "stored" && conn.kid !== kid) {
    await db.prepare("UPDATE omega_connection SET status = 'needs_reentry', envelope = NULL, updated_ms = ? WHERE id = 1").bind(now).run();
    await event(db, now, "bridge", "connection_needs_reentry", { reason: "bridge key changed" });
  } else if (conn.status === "stored") {
    connection = { version: Number(conn.version), server: conn.server, envelope: parse(conn.envelope), ...(ownerSymbol ? { trade_symbol: ownerSymbol } : {}) };
  } else if (conn.status === "cleared") {
    connection = { version: Number(conn.version), cleared: true };
  }

  // Plan.
  const { settings: storedSettings, version: settingsVersion, limit_fault: limitFaultOpen } = await readSettings(env);
  // Fail closed (owner 2026-11-20, the demo test skipped): a limit intent the EA never answered, or answered without a
  // ticket (recordLimitFault, above), sends Omega back to market entries (resting Omega limits are deleted,
  // entry_order_market) until the owner saves the settings again.
  // The EA answers again by its heartbeat (orchestrator review of #511): a fault opened while the EA was silent lifts once
  // the EA writes its state again, fresh, at 1.21 or later; the next limit is the probe (unanswered, the fault opens again).
  let faultOpen = limitFaultOpen;
  if (faultOpen?.why === LIMIT_FAULT_NO_ANSWER && faultOpen.ea_silent === true && Number(executor?.received_ms) > Number(faultOpen.at_ms) && now - Number(executor.received_ms) <= 60_000
    && versionAtLeast(executor?.executor?.version ?? null, "1.21")) {
    if (await clearNoAnswerFault(env, db, { now, by: "the EA's heartbeat" })) faultOpen = null;
  }
  const limitStop = faultOpen && (storedSettings?.entry_order === "limit" || storedSettings?.entry_order === "council") ? faultOpen : null;
  const settings = limitStop ? { ...storedSettings, entry_order: "market" } : storedSettings;
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
  let pmActions = await pendingPositionActions(db, { now });
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
      const step = await runProfileAgent(db, account.row, { executor, killed, dailyLoss: dailyLossHit(dayExec, dailyPct), dailyPct, onboardingDay: dayExec !== executor || onboardingDayRef(account.row, now) != null, now, downgradeCouncil: downgradeCouncilOn(env),
        log: (action, detail) => event(db, now, "agent:profile", action, detail), notify: (t) => sendOmegaTelegram(env, t) });
      if (step.status === "changed") account = { ...account, profile: step.change.to };
      if (step.review_pending === true) account = { ...account, review_pending: true };
      if (step.review_started === true) reviewStarted = true;
    }
  }
  const eaGate = eaVersionGateOn(env);
  const reentry = await lastWeakeningExit(db, now);
  // The ladder per mode (owner 2026-11-18): each position's mode and R at entry, and the closed candles it confirms on.
  const hasPositions = Array.isArray(executor?.positions) && executor.positions.length > 0;
  const meta = hasPositions ? await positionMeta(db, executor) : {};
  const candles = hasPositions ? await ladderCandles(env, now, { server: executor?.server, symbol: executor?.symbol?.name }) : {};
  // Delegated manual positions (owner 2026-11-19, src/omega-hitl.mjs): managed like Omega's own, with "d:" intents,
  // only on an OmegaExecutor that accepts them (1.18+).
  let delegated = [];
  if (hasPositions && executor?.connected === true) {
    try { delegated = await delegationsForSync(db, executor, { now, log: (action, detail) => event(db, now, "agent:delegate", action, detail) }); } catch { delegated = []; }
  }
  const delegateOk = delegated.length > 0 && hitlSupported(executor);
  const dlg = delegateOk ? withDelegated(dayExec, delegated, { mode: signal?.trading_mode ?? null }) : { executor: dayExec, meta: {} };
  // The stops Omega commanded in the last minutes (commandedStops): a snapshot older than a modification never loosens it.
  const stops = hasPositions ? commandedStops((await db.prepare("SELECT payload, status, result FROM omega_intents WHERE kind IN ('modify_sl', 'modify_sltp') AND created_ms > ? AND status IN ('pending', 'sent', 'done')").bind(now - STOP_COMMAND_MS).all()).results ?? []) : {};
  // Limit entries (docs/RFC_OMEGA_LIMIT_ENTRY.md, stage 3): only with entry_order "limit" or "council". The council's
  // stored answers (src/limit-council.mjs), each resting order's place_limit intent, the fills not yet re-checked and
  // the last limit->market conversion. With "market" none of this is read and planIntents gets none of it.
  const limitIn = settings?.entry_order === "limit" || settings?.entry_order === "council" ? await limitInputs(db, executor, signal, now) : {};
  // ADR-0020 Amendment 8: the loosenings already sent and the original entry stops (read whatever the switch says: a
  // loosened position stays unprotected after the switch goes off).
  const pmLoosen = hasPositions ? await pmLoosenInputs(db, executor, now) : null;
  // The liquidity lens (docs/RFC_POSITIONING_LIQUIDITY.md §6): the start of a live spread spike, the deferral's clock.
  let liquiditySpikeSince = null;
  if (signal?.liquidity_on === true && settings?.liquidity_enabled !== false) {
    try { liquiditySpikeSince = await spikeSince(env, liveSpreadSpike(signal, executor?.symbol ?? {}), { now }); } catch { liquiditySpikeSince = null; }
  }
  // The EA never answered (owner 2026-11-21: "no answer → no entries"): the plan runs as paused, so it opens nothing and
  // loosens nothing while closes and protection still go out; a kill stays a kill.
  const planControl = limitStop?.why === LIMIT_FAULT_NO_ANSWER && control?.mode !== "killed" ? { ...(control ?? {}), mode: "paused", reason: "limit_fail_closed" } : control;
  // SLG1: the profit-lock gate's facts per ticket, only while profit_lock_gate is "on" ("legacy" reads nothing).
  const allMeta = { ...meta, ...dlg.meta };
  const gates = hasPositions && profitLockGateOn(settings) ? await profitLockGates(env, { executor: { ...dlg.executor, server: executor?.server }, metaOf: (p) => allMeta[p.intent_id] ?? null, now }) : null;
  // PM-1M (owner 2026-11-23, src/pm-fast.mjs): the 1m fast-protect layer, once per newly closed broker minute, on this
  // sync (no cron of its own), while the engine runs; an action it records is pending now and planned below. Off
  // (pm_fast_1m "off"): nothing is read or written, today's sync.
  if (hasPositions && executor?.connected === true && engineEnvEnabled(env) && settings?.enabled === true && control?.mode !== "killed" && signal?.kill !== true && pmFastOn(settings)) {
    const fast = await runFastProtect(env, { executor, gates, spike: spikeHolds({ signal, sym: executor?.symbol ?? {}, settings, spikeSinceMs: liquiditySpikeSince, now }), now });
    if (fast.status === "ran" && fast.positions.some((x) => x.status === "act")) pmActions = await pendingPositionActions(db, { now });
  }
  const plan = planIntents({ signal, control: planControl, settings, executor: dlg.executor, now, engineEnabled: engineEnvEnabled(env), recentIntentIds: plannerIds((recent.results ?? []).map((r) => r.id)), agents, pmActions, account, eaGate, reentry, positionMeta: allMeta, candles, stops, ...limitIn, ...(pmLoosen ? { pmLoosen } : {}), liquiditySpikeSince, ...(gates ? { gates } : {}) });
  if (limitStop) plan.notes.push({ code: "limit_fail_closed", detail: limitStop.why === LIMIT_FAULT_NO_ANSWER ? `${limitStop.kind}: ${limitStop.why}; no new entry until the EA answers again (or the owner saves the settings)` : `${limitStop.kind}: ${limitStop.why}; market entries until the owner saves the settings again` });
  // A new entry the spread spike held back is a reading of the lens (scored later from the v4 replay).
  if (plan.notes.some((x) => x.code === "liquidity_spread_spike")) { try { await recordSpikeBlock(db, signal, { now }); } catch { /* the plan stands */ } }
  if (plan.entry_request || plan.limit_used || plan.fill_checks) await limitAfterPlan(env, db, { plan, limitIn, executor, now });
  if (delegated.length && !delegateOk) plan.notes.push({ code: "delegate_needs_ea_1_18", detail: `${delegated.length} delegated position${delegated.length > 1 ? "s wait" : " waits"} for OmegaExecutor 1.18` });
  if (pmActions.length) {
    // An action that became an intent is applied; one the live price no longer allows is skipped (never retried).
    const planned = new Set(plan.intents.filter((it) => String(it.id).startsWith("pm:")).map((it) => { const [, t, , b] = String(it.id).split(":"); return `pm:${t}:${b}`; }));
    // PM-1M: a fast intent carries its action's id (pm1:<ticket>:<bar minute>).
    for (const it of plan.intents) if (String(it.id).startsWith("pm1:")) planned.add(actionIdOfIntent(it.id));
    await markPositionActions(db, pmActions.filter((a) => planned.has(a.id)).map((a) => a.id), "applied");
    const skipped = pmActions.filter((a) => !planned.has(a.id));
    await markPositionActions(db, skipped.map((a) => a.id), "skipped");
    // A skipped action is said with its reason; an applied one is said when the broker answers (above).
    if (skipped.length) {
      const why = Object.fromEntries((plan.pm_dropped ?? []).map((d) => [d.id, d.reason]));
      const fallback = `Omega's plan stopped first (${plan.notes.map((x) => x.code).join(", ") || "no reason recorded"})`;
      const rows = await positionActionRows(db, skipped.map((a) => a.id));
      for (const a of skipped) if (rows[a.id]) await sendPmLine(env, rows[a.id], { applied: false, reason: why[a.id] ?? fallback });
    }
  }
  // An action older than its time to live was never read by a sync: said as not applied, once.
  for (const row of await expireStalePositionActions(db, { now })) await sendPmLine(env, row, { applied: false, reason: `it was older than ${Math.round(ACTION_TTL_MS / 60_000)} minutes when Omega's sync came (the price moved on)` });
  if (delegateOk) {
    // A delegated position without a stop gets the plan's stop (once), then its intents carry the "d:" id.
    const recentIds = new Set(plannerIds((recent.results ?? []).map((r) => r.id)));
    for (const s of delegatedStopIntents({ positions: dlg.executor.positions, sym: dlg.executor.symbol, signal })) if (!recentIds.has(s.id) && !plan.intents.some((x) => x.ticket === s.ticket && x.kind === "modify_sl")) plan.intents.push(s);
    plan.intents = markDelegatedIntents(plan.intents, delegated);
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

  // The reference gold price in USD (the feed's last closed 5-minute close), for OmegaExecutor 1.19+ to find gold on any
  // broker by its price (bridge 1.5.0+ writes it to MQL5/Files/omega/reference.txt). Null when the feed has none.
  // The reference the EA finds gold by: the feed's price and its time, with past 4h closes; none while the feed runs
  // on the broker's own bars (the MT5 fallback). `reference_price` stays for bridge 1.5.0.
  let reference = null;
  try {
    const src = await referenceSources(env, now);
    reference = referenceFrom({ price: signal?.market_price, marketMs: signal?.market_ms, h4: src.h4, fallbackSince: src.fallbackSince, excluded: src.excluded, now });
  } catch { reference = null; }
  const referencePrice = reference?.price ?? null;
  const response = { ok: true, intents, connection, settings_version: settingsVersion, notes: plan.notes, corpus_cursor_ms: corpusCursor, corpus_macro_cursors: macroCursors, calendar_seen_ms: calendarSeen, reference_price: referencePrice, reference, stream_mode: bridgeStreamMode(env, { executor, intents, recovery, reviewStarted }), ...(recovery ? { recovery } : {}), ...(reviewStarted ? { profile_review_started: true } : {}) };
  // A full plan that ended with nothing to manage is what the light path may reuse (never a recovery or a review).
  if (!recovery && !reviewStarted) LIGHT_SYNC.set(db, { at: now, lightKey, response: { ...response, intents: [] } });
  else LIGHT_SYNC.delete(db);
  return response;
}

// ---------------------------------------------------------------- overview (for the page)

/**
 * The light status of the Omega badge on every Nexus page (UI audit DEF-10, 2026-11-14): whether the terminal is
 * connected, whether the engine is armed, the server and how many positions are open. One bridge row and the
 * settings, never the full overview (deals, intents, events): the badge reads it every 60 seconds.
 */
/**
 * The stored account the terminal is connected to: the one whose reference is the terminal's own (the login hash the
 * EA sends, as syncAccount files it), never the first row on the same server. Two accounts on one server (2026-11-19:
 * a USD account and a cent account on FxPro-MT5) were mixed up by the server match: the cron applied the connected
 * account's balance, deposits and daily loss to the other row, and the owner's controls landed there too.
 */
export async function connectedAccount(accounts, executor) {
  if (!executor || typeof executor.server !== "string" || !executor.server) return null;
  // The reference bridgeSync stored with the state; a state from before it (or a live executor) derives it.
  const ref = typeof executor.account_ref === "string" && executor.account_ref ? executor.account_ref : (await accountRef(executor)).ref;
  return (accounts ?? []).find((a) => a.account_ref === ref) ?? null;
}

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
  const acct = await connectedAccount(accounts, executor);
  if (!acct) return { status: "no_account" };
  const row = await db.prepare("SELECT * FROM omega_accounts WHERE account_ref = ?").bind(acct.account_ref).first();
  const control = await readControl(env);
  const { settings } = await readSettings(env);
  const killed = control?.mode === "killed" || String(env?.EA_SIGNALS_ENABLED ?? "true").trim().toLowerCase() === "false";
  const dailyPct = effectiveLimits(row?.profile, settings ?? {}).max_daily_loss_pct ?? settings?.max_daily_loss_pct;
  const dayExec = dailyLossExecutor(executor, row, now);
  return runProfileAgent(db, row, { executor, killed, dailyLoss: dailyLossHit(dayExec, dailyPct), dailyPct, onboardingDay: onboardingDayRef(row, now) != null, withEvidence: true, now,
    downgradeCouncil: downgradeCouncilOn(env), review: (r, change, { deals }) => reviewProfileChange(env, r, change, { executor, deals, now, call }),
    log: (action, detail) => event(db, now, "agent:profile", action, detail), notify: (t) => sendOmegaTelegram(env, t) });
}

/**
 * Reversal probation's revert check (src/htf-cells.mjs, owner 2026-11-18), in the 5-minute ledger step: each probation
 * open that has closed (its deals by position ticket, in USD) gives one R (its net over the money it risked at the stop);
 * a cell whose last PROBATION.revert_last_n probation trades average under 0R is reverted (KV PROBATION_KEY), with an
 * event and a Telegram line. A reverted cell trades against the trend again only once its record passes (graduated) or
 * the owner switches probation off and on. Never throws.
 */
export async function probationTick(env, { now = Date.now() } = {}) {
  try {
    await ensureSchema(env.DB);
    const db = env.DB;
    const rows = (await db.prepare("SELECT id, payload, result, created_ms FROM omega_intents WHERE kind IN ('open', 'place_limit') AND status = 'done' AND json_extract(payload, '$.probation') = 1 ORDER BY created_ms LIMIT 200").all()).results ?? [];
    if (!rows.length) return { status: "idle" };
    // A position still open (a partial close already made a deal) is counted once it has gone.
    const st = parse((await db.prepare("SELECT state FROM omega_bridge WHERE id = 1").first())?.state);
    const open = new Set((Array.isArray(st?.positions) ? st.positions : []).map((p) => Number(p?.ticket)));
    const byCell = {};
    for (const r of rows) {
      const p = parse(r.payload, {}), res = parse(r.result, {});
      const ticket = Number(res?.ticket), risk = Number(p.risk_usd);
      if (!(ticket > 0) || !(risk > 0) || typeof p.cell !== "string") continue;
      let net = null;
      try { net = (await db.prepare(`SELECT COUNT(*) AS n, SUM(${DEAL_NET_SQL}) AS net FROM ea_deals WHERE position_ticket = ?`).bind(ticket).first()); } catch { net = null; }
      if (!(Number(net?.n) > 0) || open.has(ticket)) continue;
      (byCell[p.cell] ??= []).push({ r: Math.round((Number(net.net) / risk) * 1000) / 1000, ticket });
    }
    const control = probationFrom((await env.SIGNAL_CACHE?.get?.(PROBATION_KEY)) ?? null);
    const reverted = { ...control.reverted };
    const changed = [];
    for (const [cell, trades] of Object.entries(byCell)) {
      const v = probationVerdict(trades);
      if (v.revert && !reverted[cell]) { reverted[cell] = { at_ms: now, mean_r: v.mean_r, trades: v.trades }; changed.push({ cell, ...v }); }
    }
    if (!changed.length) return { status: "unchanged", cells: Object.keys(byCell).length };
    await env.SIGNAL_CACHE?.put?.(PROBATION_KEY, JSON.stringify({ enabled: control.enabled, reverted }));
    for (const c of changed) {
      await event(db, now, "agent:probation", "probation_reverted", c);
      await sendOmegaTelegram(env, `XAUUSD SYSTEM · Reversal probation reverted for ${c.cell.replace(/\|/g, " ")}: its last ${PROBATION.revert_last_n} probation trades averaged ${c.mean_r}R. No more counter-trend trades for it until its record passes (or the owner switches probation off and on).`);
    }
    return { status: "changed", reverted: changed.map((c) => c.cell) };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** The owner's probation switch (owner only; on clears every reverted cell). */
export async function setProbation(env, { enabled, actor = "owner" } = {}, { now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be true or false" };
  const control = probationFrom((await env.SIGNAL_CACHE?.get?.(PROBATION_KEY)) ?? null);
  const next = { enabled, reverted: enabled ? {} : control.reverted };
  await env.SIGNAL_CACHE?.put?.(PROBATION_KEY, JSON.stringify(next));
  await event(env.DB, now, actor, "probation_set", { enabled, cleared: enabled ? Object.keys(control.reverted) : [] });
  try { await sendOmegaTelegram(env, `XAUUSD SYSTEM · Reversal probation ${enabled ? "ON (half risk, one at a time; reverted cells cleared)" : "OFF: no counter-trend trades until a cell's record passes"} (owner).`); } catch { /* best effort */ }
  return { ok: true, probation: next };
}

/**
 * The trading-mode selector's daily step (phase 4, src/mode-selector.mjs), with the connected account's feasibility
 * inputs, the latest 1H regime and whether the kill switch or the daily loss limit fired today.
 */
export async function modeSelectorTick(env, { now = Date.now(), call = undefined } = {}) {
  await ensureSchema(env.DB);
  const db = env.DB;
  const b = await db.prepare("SELECT state FROM omega_bridge WHERE id = 1").first();
  const st = parse(b?.state);
  let account = null, forcedDay = false;
  if (st?.connected === true && Number(st?.received_ms) > 0 && now - Number(st.received_ms) <= BRIDGE_SEEN_MS) {
    const acct = await connectedAccount(await readAccounts(db), st);
    const { settings } = await readSettings(env);
    if (acct) {
      account = { equity: Number(st.account?.equity), volume_min: Number(st.symbol?.volume_min) || 0.01, contract_size: Number(st.symbol?.contract_size) || 100, cap_pct: capOf(acct.profile, settings) };
      forcedDay = Number(acct.upgrade_block_until_ms) > now;
    }
  }
  const control = await readControl(env);
  if (control?.mode === "killed") forcedDay = true;
  let regime = null;
  try { regime = (await readLatestDecision(env))?.context?.regime_1h ?? null; } catch { regime = null; }
  return runModeSelector(env, { now, account, regime, forcedDay, ...(call ? { call } : {}),
    log: (action, detail) => event(db, now, "agent:mode", action, detail), notify: (t) => sendOmegaTelegram(env, t) });
}

/** Range's breakout exit (src/mode-selector.mjs rangeExitTick) with the Omega event and Telegram line. Every 5 minutes. */
export async function rangeExitStep(env, { now = Date.now(), regime = undefined } = {}) {
  await ensureSchema(env.DB);
  return rangeExitTick(env, { now, regime, log: (action, detail) => event(env.DB, now, "agent:mode", action, detail), notify: (t) => sendOmegaTelegram(env, t) });
}

/** The owner's profile controls (the caller checked OWNER_ACCESS_SUB): ceiling, profile, agent mode, accept, decline. */
export async function setAccountProfile(env, { account_ref, action, value, actor = "owner" } = {}, { now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  // Every owner control acts on the connected account only (owner 2026-11-19: "harus bisa membedakan mana akun sen
  // dan usd"): the account the live terminal is logged in to, found by its own reference (connectedAccount).
  let executor = null, connectedRef = null, killed = false;
  const b = await env.DB.prepare("SELECT state FROM omega_bridge WHERE id = 1").first();
  const st = parse(b?.state);
  if (st?.connected === true && Number(st?.received_ms) > 0 && now - Number(st.received_ms) <= BRIDGE_SEEN_MS) {
    executor = st;
    connectedRef = (await connectedAccount(await readAccounts(env.DB), st))?.account_ref ?? null;
  }
  // The baseline reset also needs the kill switch.
  if (action === "reset" || action === "reset_override") {
    const control = await readControl(env);
    killed = control?.mode === "killed" || String(env?.EA_SIGNALS_ENABLED ?? "true").trim().toLowerCase() === "false";
  }
  const result = await ownerSetProfile(env.DB, { account_ref, action, value, actor: String(actor || "owner").slice(0, 120), now, executor, connectedRef, killed, requireConnected: true,
    log: (what, detail) => event(env.DB, now, actor || "owner", what, detail), notify: (t) => sendOmegaTelegram(env, t) });
  // A refused owner control is recorded too (2026-11-19: the owner's attempts after 03:50 UTC left no trace), so the
  // page's message can be traced: the action, the value, the account and the reason; never a login.
  if (result?.ok === false) {
    try {
      await event(env.DB, now, String(actor || "owner").slice(0, 120), "profile_control_refused", { account_ref: String(account_ref ?? "").slice(0, 40), action: String(action ?? "").slice(0, 20), value: value == null ? null : String(value).slice(0, 20), connected_ref: connectedRef, terminal_live: executor != null, error: String(result.error ?? "").slice(0, 200) });
    } catch { /* the refusal still reaches the page */ }
  }
  return result;
}

export async function brokerStatus(env, { now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  const settings = await readSettings(env);
  const connection = await connectionStatus(env);
  const b = await env.DB.prepare("SELECT state, synced_ms FROM omega_bridge WHERE id = 1").first();
  const st = parse(b?.state);
  const fresh = Number.isFinite(st?.received_ms) && now - Number(st.received_ms) < 60_000;
  const control = await readControl(env);
  const killedByEnv = String(env?.EA_SIGNALS_ENABLED ?? "true").trim().toLowerCase() === "false";
  return {
    connected: Boolean(st?.connected === true && connection.status === "stored" && fresh),
    armed: settings.settings?.enabled === true,
    server: connection.status === "stored" ? (st?.server ?? connection.server ?? null) : null,
    // The broker as the terminal names itself (OmegaExecutor 1.19 ACCOUNT_COMPANY): the pages' label, never the server.
    broker: connection.status === "stored" ? (st?.account?.company ?? null) : null,
    positions: Array.isArray(st?.positions) ? st.positions.length : 0,
    synced_age_ms: b?.synced_ms ? now - Number(b.synced_ms) : null,
    // The real execution state for the Nexus header (owner 2026-11-22, frontend session: "Ya status sebenarnya"). Read
    // only, no secret: the typed LIVE arm, the EA control as the engine reads it (EA_SIGNALS_ENABLED "false" is a
    // kill), the fail-closed stop's short reason, the account's trade mode and the engine's environment switch.
    live_armed: settings.settings?.live_armed === true,
    control_mode: killedByEnv ? "killed" : control.mode,
    control_reason: killedByEnv ? "env_kill_switch" : (control.reason ? String(control.reason).slice(0, 60) : null),
    limit_fault: settings.limit_fault ? { why: settings.limit_fault.why === LIMIT_FAULT_NO_ANSWER ? "no_answer" : settings.limit_fault.why === LIMIT_FAULT_NO_TICKET ? "no_ticket" : "limit_fault" } : null,
    account_mode: ["demo", "real", "contest"].includes(st?.account?.trade_mode) ? st.account.trade_mode : null,
    engine_enabled: engineEnvEnabled(env)
  };
}

/** The entry_order switch for the Omega page: the options the terminal allows, and Omega's resting limits. Never throws. */
export async function entryOrderView(db, st, settings, now = Date.now()) {
  const version = st?.executor?.version ?? null;
  const eaOk = specVersionAtLeast(version, LIMIT_EA_MIN_VERSION);
  const why = !LIMIT_ENTRY_AVAILABLE ? "not available yet" : eaOk ? null : `needs OmegaExecutor ${LIMIT_EA_MIN_VERSION} (the terminal reports ${version ?? "no version"})`;
  const view = { mode: settings?.entry_order ?? "market", ea_version: version, ea_min_version: LIMIT_EA_MIN_VERSION, ea_ok: eaOk,
    options: ENTRY_ORDERS.map((value) => ({ value, enabled: value === "market" || why == null, reason: value === "market" ? null : why })), pending: [], recent: [] };
  try {
    const orders = omegaPendingOrders(st);
    if (orders.length) {
      const rows = await placeLimitRows(db, { ids: orders.map((o) => o.comment), tickets: orders.map((o) => o.ticket) });
      await ensureLimitCouncilSchema(db);
      for (const o of orders) {
        const m = rows.find((r) => r.id === o.comment || Number(r.result?.ticket) === Number(o.ticket))?.payload ?? null;
        const last = await db.prepare("SELECT at_ms, choice, rule, reason FROM limit_council WHERE kind = 'pending' AND ticket = ? ORDER BY at_ms DESC LIMIT 1").bind(o.ticket).first();
        view.pending.push({ ticket: o.ticket, side: o.type === "BUY_LIMIT" ? "BUY" : "SELL", intent_id: o.comment ?? null, placed_ms: o.placed_ms ?? m?.placed_ms ?? null, expiry_ms: m?.expiry_ms ?? null,
          status: m ? (last ? `council: ${last.choice}` : "resting") : "unrecorded", reason: last ? `${last.rule}${last.reason ? `: ${String(last.reason).slice(0, 160)}` : ""}` : null, council_ms: last?.at_ms ?? null });
      }
    }
    view.recent = ((await db.prepare("SELECT ms, action, detail FROM omega_events WHERE action IN ('limit_placed', 'limit_moved', 'limit_cancelled', 'limit_filled') ORDER BY id DESC LIMIT 6").all()).results ?? [])
      .map((e) => { const d = parse(e.detail, {}); return { ms: e.ms, action: e.action.replace("limit_", ""), ticket: d.ticket ?? null, reason: d.reason ?? d.guard ?? null, gap_r: d.gap_r ?? null }; });
  } catch { /* the switch is still shown */ }
  return view;
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
  // While no EA state exists, the terminal's own last error the bridge reported (an event, 30 minutes at most).
  const lastTermErr = !st && connection.status === "stored" ? await db.prepare("SELECT ms, detail FROM omega_events WHERE action = 'terminal_error' ORDER BY id DESC LIMIT 1").first() : null;
  const termErrNoState = lastTermErr && now - Number(lastTermErr.ms) < 30 * 60_000 && Number(lastTermErr.ms) >= Number(connection.updated_ms ?? 0) ? (parse(lastTermErr.detail, {})?.error ?? null) : null;
  // Account Profiles phase 1: the accounts seen, their broker spec status and profile (never a login).
  let accounts = [];
  try { accounts = await readAccounts(db); } catch { accounts = []; }
  // The connected account by its own reference (connectedAccount), not by the server it shares with others.
  const liveRef = st?.connected === true ? (await connectedAccount(accounts, st))?.account_ref ?? null : null;
  // Only the account the terminal is connected to now is read and served (owner 2026-11-19, relayed: "akun sen udah
  // disconnect kok masih dibaca"): an account that is not connected appears on no page; its stored row stays in D1
  // and is used again if it connects.
  accounts = liveRef ? accounts.filter((a) => a.account_ref === liveRef) : [];
  const councilReviews = {}, histories = {};
  for (const a of accounts.slice(0, 1)) {
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
    // OMEGA_DEFAULTS for the Engine form's Default button: what it fills where the active profile sets nothing.
    engine_defaults: { risk_pct: OMEGA_DEFAULTS.risk_pct, max_positions: OMEGA_DEFAULTS.max_positions, max_daily_loss_pct: OMEGA_DEFAULTS.max_daily_loss_pct, max_spread_points: OMEGA_DEFAULTS.max_spread_points, max_signal_age_min: Math.round(OMEGA_DEFAULTS.max_signal_age_ms / 60_000) },
    // Limit entries (docs/RFC_OMEGA_LIMIT_ENTRY.md): the owner's entry_order switch, what the terminal allows, and Omega's
    // resting limit with its status, last council reason and expiry.
    entry_order: await entryOrderView(db, st, settings.settings, now),
    // The owner's edits and delegation (owner 2026-11-19, src/omega-hitl.mjs): the delegated tickets, the toggle, and
    // whether the terminal's OmegaExecutor takes them (1.18+).
    delegation: { ...(await readDelegations(db)), supported: hitlSupported(executorFrom(st, { stored: true })), ea_min_version: HITL_EA_MIN_VERSION },
    // ADR-0020 Amendment 8: the owner's switch and the positions whose stop the council loosened (once each).
    pm_loosen: { enabled: settings.settings?.pm_loosen_enabled === true, loosened: Object.keys((await pmLoosenInputs(db, { positions: [] }, now)).loosened).map(Number) },
    // Reversal probation (src/htf-cells.mjs): the owner's switch and the reverted cells.
    probation: { ...probationFrom((await env.SIGNAL_CACHE?.get?.(PROBATION_KEY)) ?? null), risk_scale: PROBATION.risk_scale, revert_last_n: PROBATION.revert_last_n, agents: PROBATION.agents },
    connection: { version: connection.version, status: connection.status, server: connection.server, trade_symbol: connection.trade_symbol, units_per_usd: connection.units_per_usd, updated_by: connection.updated_by, updated_ms: connection.updated_ms },
    bridge: {
      seen: syncedAge != null && syncedAge < BRIDGE_SEEN_MS, synced_age_ms: syncedAge, kid: b?.kid ?? null, bridge_version: b?.bridge_version ?? null,
      terminal_connected: Boolean(st?.connected === true && connection.status === "stored" && (now - Number(st?.received_ms || 0) < 60_000)),
      trade_allowed: Boolean(st?.trade_allowed === true && connection.status === "stored" && (now - Number(st?.received_ms || 0) < 60_000)),
      terminal_error: st?.connected !== true ? (st?.terminal_error ?? termErrNoState ?? null) : null,
      // The broker as the terminal names itself (OmegaExecutor 1.19 ACCOUNT_COMPANY); null before 1.19.
      broker: st?.account?.company ?? null,
      // The EA's self-report (1.12+): its version, its local break-even and trailing, and what Omega makes of it.
      executor: executorStatus(st?.executor),
      // The entry gate on the EA version (OMEGA_EA_VERSION_GATE, off until OmegaExecutor 1.15 runs on the VPS).
      ea_version_gate: { on: eaVersionGateOn(env), min_version: EXECUTOR_ENTRY_MIN_VERSION, met: specVersionAtLeast(st?.executor?.version ?? null, EXECUTOR_ENTRY_MIN_VERSION) },
      leverage: st?.account?.leverage ?? null, margin_mode: st?.account?.margin_mode ?? null, margin_free: st?.account?.margin_free ?? null,
      freeze_level_points: st?.symbol?.freeze_level_points ?? null, symbol_trade_mode: st?.symbol?.trade_mode ?? null, margin_per_lot: st?.symbol?.margin_per_lot ?? null,
      server: connection.status === "stored" ? (st?.server ?? null) : null, trade_mode: st?.account?.trade_mode ?? null, currency: st?.account?.currency ?? null,
      // Every amount here is in USD (toUsd) once the account's units per dollar are known; `money` says how they were found.
      cent: st?.account?.cent === true, owner_symbol: st?.owner_symbol ?? null,
      // How the account's money was read (owner 2026-11-19, universal): its units per dollar and where they came from.
      money: st?.account?.money ?? null, money_text: st?.account?.money ? moneyText(st.account.money) : null,
      balance: st?.account?.balance ?? null, equity: st?.account?.equity ?? null, day_start_balance: st?.account?.day_start_balance ?? null, day_realized_pl: st?.account?.day_realized_pl ?? null,
      symbol: st?.symbol?.name ?? null, bid: st?.symbol?.bid ?? null, ask: st?.symbol?.ask ?? null, spread_points: st?.symbol?.spread_points ?? null,
      digits: st?.symbol?.digits ?? null, point: st?.symbol?.point ?? null, tick_size: st?.symbol?.tick_size ?? null, tick_value: st?.symbol?.tick_value ?? null,
      volume_min: st?.symbol?.volume_min ?? null, volume_max: st?.symbol?.volume_max ?? null, volume_step: st?.symbol?.volume_step ?? null, stops_level_points: st?.symbol?.stops_level_points ?? null,
      atr_value: atrVal, atr_points: atrPts,
      // The traded symbol, checked (PR #405): USD gold or no new entries; the bridge's chart-symbol resolution.
      symbol_check: st ? (() => {
        const check = goldCheckOf(st);
        return {
          ok: check.ok, problem: check.problem, text: goldSymbolText(check, st.symbol),
          chart_symbol: st.symbol?.chart ?? st.bridge_symbol?.chart_symbol ?? null,
          currency_profit: st.symbol?.currency_profit ?? null, contract_size: st.symbol?.contract_size ?? null,
          symbol_error: st.symbol_error ?? null, resolution: st.bridge_symbol ?? null
        };
      })() : null,
      // Each position's exposure in USD (owner 2026-11-18, "baris eksposur"): per $1 move, and the risk at its stop.
      positions: Array.isArray(st?.positions) ? st.positions.map((p) => ({ ...p, exposure: positionExposure(p, st.symbol, st.account?.equity) })) : [],
      orders: Array.isArray(st?.orders) ? st.orders : [],
      deals: Array.isArray(st?.deals) ? st.deals : [],
      state_age_ms: Number.isFinite(st?.received_ms) ? now - st.received_ms : null
    },
    // Account Profiles (docs/RFC_ACCOUNT_PROFILES.md): each account's opaque reference, broker spec status and profile.
    accounts: accounts.map((a) => ({
      account_ref: a.account_ref, server: a.server, legacy_ref: a.legacy,
      // Which account this is (owner 2026-11-19): USD or cent, its currency and gold symbol, e.g. "Cent account (USX) · GoldOne".
      identity: accountIdentity(a.spec, liveRef != null && a.account_ref === liveRef ? st?.account?.money ?? null : null),
      spec_status: a.spec_status, spec_problem: a.spec_problem, spec_hash: a.spec_hash, spec_since_ms: a.spec_since_ms, spec_validated_ms: a.spec_validated_ms,
      spec_text: specStatusText(a),
      profile: a.profile, profile_label: PROFILES[a.profile]?.label ?? a.profile, ceiling: a.ceiling, agent_mode: a.agent_mode, custom: a.custom,
      // The profile's own values (PROFILES, Safe for an unknown id as effectiveLimits reads it; null each for Custom):
      // the Engine form's Default button and its "set, applied" notes (owner 2026-11-20: "Follow the active profile").
      profile_limits: (() => { const P = PROFILES[a.profile] ?? PROFILES.safe; return { target_risk_pct: P.target_risk_pct, max_positions: P.max_positions, daily_loss_pct: P.daily_loss_pct }; })(),
      profile_by: a.profile_by, profile_ms: a.profile_ms,
      // The profile agent (phase 3): its proposal in approval mode, the block after a kill or the daily loss, the last upgrade.
      pending_upgrade: a.pending_upgrade, upgrade_block_until_ms: a.upgrade_block_until_ms, last_upgrade_ms: a.last_upgrade_ms,
      // The profile council: a soft downgrade waiting for review, a veto in force, the last reviews.
      pending_downgrade: a.pending_downgrade ?? null, council_veto: a.council_veto ?? null, council_reviews: councilReviews[a.account_ref] ?? [],
      // The owner's reset (owner 2026-11-18): whether Omega saw this account before, its baseline, its streak.
      history: histories[a.account_ref] ?? null, connected: liveRef != null && a.account_ref === liveRef,
      upgrade_block_reason: a.upgrade_block_reason ?? null,
      // The day's P&L in % against the daily-loss reference (the onboarding balance on the day Omega first saw it).
      day_pl_pct: (() => { if (liveRef == null || a.account_ref !== liveRef) return null; const x = dailyLossExecutor(st, a, now)?.account; const ref = Number(x?.day_start_balance), eq = Number(x?.equity); return ref > 0 && Number.isFinite(eq) ? Math.round(((eq - ref) / ref) * 1000) / 10 : null; })()
    })),
    // The trading mode and its selector (phase 4): Auto (council) or pinned by the owner, the last switch, the history.
    trading_mode: await modeStatus(env),
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
    // An event of another account (its id in the detail) is not shown: only the connected account appears.
    events: events.map((r) => ({ ms: r.ms, actor: r.actor, action: r.action, detail: parse(r.detail) }))
      .filter((e) => !(typeof e.detail?.account_ref === "string" && e.detail.account_ref !== liveRef)),
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
export function liveBridgeFields(state, { now = Date.now(), ownerUnitsPerUsd = null } = {}) {
  const st = executorFrom(state, { ownerUnitsPerUsd });
  if (!st || typeof st?.symbol?.bid !== "number") return null;
  return {
    bid: st.symbol.bid ?? null, ask: st.symbol.ask ?? null, spread_points: st.symbol.spread_points ?? null,
    balance: st.account?.balance ?? null, equity: st.account?.equity ?? null, day_realized_pl: st.account?.day_realized_pl ?? null,
    positions: Array.isArray(st.positions) ? st.positions.map((p) => ({ ...p, exposure: positionExposure(p, st.symbol, st.account?.equity) })) : [], orders: Array.isArray(st.orders) ? st.orders : [],
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
    const rows = (await env.DB.prepare(`SELECT ${DEAL_MONEY_COLUMNS_SQL} FROM ea_deals WHERE ${where.join(" AND ")} ORDER BY closed_ms ${order} LIMIT ?`).bind(...args, limit).all())?.results || [];
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
        // The owner's A8 switch is carried as stored (Aether never writes it, ADR-0020 Amendment 8), and so are the
        // profit-lock gate's (SLG1), the change thresholds' (CH1) and the 1m fast layer's (PM-1M).
        const back = { ...current.settings, ...applied.from };
        delete back.pm_loosen_enabled;
        delete back.profit_lock_gate;
        delete back.change_thresholds;
        delete back.pm_fast_1m;
        const r = await writeSettings(env, { body: back, actor: "aether-rollback" }, { now });
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
  // Aether's policy never writes entry_order (docs/RFC_OMEGA_LIMIT_ENTRY.md §2) nor pm_loosen_enabled (ADR-0020
  // Amendment 8) nor profit_lock_gate (SLG1) nor change_thresholds (CH1) nor pm_fast_1m (PM-1M): the owner's switches
  // are carried as stored.
  delete body.entry_order;
  delete body.pm_loosen_enabled;
  delete body.profit_lock_gate;
  delete body.change_thresholds;
  delete body.pm_fast_1m;
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
