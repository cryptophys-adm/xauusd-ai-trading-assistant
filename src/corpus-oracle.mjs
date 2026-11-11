// Corpus Oracle (owner 2026-11-11: "persiapkan engine baru bernama corpus oracle yang akan melakukan
// feeding data ke local lane dari live mt5 terminal sesuai dengan broker, pair dan user active dari
// omega"). Phase 1: the corpus.
//
// The Omega executor on the owner's MT5 terminal writes the broker's closed M1 bars of the symbol it
// trades (omega/corpus.json); the Omega bridge sends the new ones with each sync (outbound only, the
// same Access service token); the AI Worker keeps them only when they come from Omega's active user:
//   broker  the terminal's server equals the server of Omega's stored connection;
//   pair    the bars' symbol equals the symbol the executor reports (the pair Omega trades);
//   user    Omega's connection is stored and applied (its version is recorded with every bar).
// A bar from any other server, symbol or connection is refused and counted, never stored.
//
// Phase 1 stores the broker corpus (D1 corpus_bars, 14 days of M1), aggregates it to M5/M15/H1 and
// measures it against the TradingView feed the local lane computes from (the basis: offset, spread of
// the offset, return correlation, missing minutes). Nothing reads it for a decision yet. Phase 2 (a
// reviewed PR, docs/RFC_CORPUS_ORACLE.md): the pull adapter computes the local engines on the broker
// bars as shadow identities; they enter the decision lane only by earning parity (doctrine
// parity_trust_only). No price leaves this Worker for the kernel or Aether.
//
// Switch: CORPUS_ORACLE_MODE = "off" (default; the bars are ignored) | "shadow" (collect and measure).

export const CORPUS_TIMEFRAME = "M1";
export const CORPUS_MAX_BARS_PER_SYNC = 240;
export const CORPUS_KEEP_MS = 14 * 86_400_000;
const MINUTE = 60_000;
const SERIES_KEY = "market-data:v2:series:OANDA:XAUUSD|15m";

export function corpusMode(env) {
  const m = String(env?.CORPUS_ORACLE_MODE ?? "off").trim().toLowerCase();
  return m === "shadow" ? "shadow" : "off";
}

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const clean = (s, n = 64) => String(s ?? "").replace(/[^\x20-\x7E]/g, "").trim().slice(0, n);
/** The corpus source id: one per broker server and symbol. */
export const corpusSource = (server, symbol) => `mt5:${clean(server).toLowerCase()}:${clean(symbol).toUpperCase()}`;

/**
 * Pure: the corpus a bridge sent, checked against Omega's active broker, pair and user. Returns
 * { ok, source, bars, refused } or { ok: false, error }. A bar is [t_ms, o, h, l, c, tick_volume, spread].
 */
export function validateCorpus(corpus, { executor = null, connection = null, now = Date.now() } = {}) {
  if (!corpus || typeof corpus !== "object") return { ok: false, error: "no_corpus" };
  if (corpus.timeframe !== CORPUS_TIMEFRAME) return { ok: false, error: "timeframe_must_be_M1" };
  if (!connection || connection.status !== "stored" || !finite(Number(connection.version))) return { ok: false, error: "no_active_user" };
  const server = clean(corpus.server), symbol = clean(corpus.symbol, 32);
  if (!server || !symbol) return { ok: false, error: "server_and_symbol_required" };
  if (server !== clean(connection.server)) return { ok: false, error: "broker_mismatch" };
  if (!executor || clean(executor.server) !== server) return { ok: false, error: "executor_broker_mismatch" };
  if (clean(executor.symbol?.name, 32) !== symbol) return { ok: false, error: "pair_mismatch" };
  const { bars, refused } = validBars(corpus.bars, now);
  return { ok: true, source: corpusSource(server, symbol), server, symbol, connection_version: Number(connection.version), bars, refused };
}

/** Pure: closed, aligned, ordered, consistent M1 bars of the last 14 days; the others are counted. */
function validBars(rowsIn, now) {
  const rows = Array.isArray(rowsIn) ? rowsIn.slice(-CORPUS_MAX_BARS_PER_SYNC) : [];
  const bars = [];
  let refused = 0, last = -Infinity;
  for (const b of rows) {
    const [t, o, h, l, c, v, s] = Array.isArray(b) ? b : [];
    const ok = finite(t) && t % MINUTE === 0 && t + MINUTE <= now && t > now - CORPUS_KEEP_MS && t > last
      && [o, h, l, c].every((x) => finite(x) && x > 0) && l <= Math.min(o, c) && h >= Math.max(o, c);
    if (!ok) { refused += 1; continue; }
    last = t;
    bars.push({ t, o, h, l, c, v: finite(v) && v >= 0 ? Math.round(v) : null, s: finite(s) && s >= 0 ? Math.round(s) : null });
  }
  return { bars, refused };
}

/** Pure: M1 bars aggregated to `minutes` (5, 15, 60), keyed by the bar's close; only complete bars. */
export function aggregateBars(bars, minutes) {
  const span = minutes * MINUTE;
  const groups = new Map();
  for (const b of bars) {
    const open = Math.floor(b.t / span) * span;
    (groups.get(open) || groups.set(open, []).get(open)).push(b);
  }
  const out = [];
  for (const [open, list] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (list.length !== minutes) continue; // a missing minute leaves the bar incomplete
    list.sort((a, b) => a.t - b.t);
    out.push({ open_ms: open, close_ms: open + span, open: list[0].o, high: Math.max(...list.map((x) => x.h)), low: Math.min(...list.map((x) => x.l)), close: list.at(-1).c, tick_volume: list.reduce((n, x) => n + (x.v ?? 0), 0) });
  }
  return out;
}

/**
 * Pure: the broker corpus against the TradingView feed on matching closed bars. The offset is broker
 * minus TradingView close (brokers quote their own price); the correlation is of bar-to-bar returns.
 */
export function corpusBasis(broker, reference) {
  const ref = new Map(reference.map((r) => [r.close_ms, r]));
  const pairs = broker.filter((b) => ref.has(b.close_ms)).map((b) => [b, ref.get(b.close_ms)]);
  if (pairs.length < 2) return { matched: pairs.length, offset_mean: null, offset_sd: null, offset_max_abs: null, return_correlation: null };
  const offs = pairs.map(([b, r]) => b.close - r.close);
  const mean = offs.reduce((s, x) => s + x, 0) / offs.length;
  const sd = Math.sqrt(offs.reduce((s, x) => s + (x - mean) ** 2, 0) / offs.length);
  const rb = [], rr = [];
  for (let i = 1; i < pairs.length; i++) { rb.push(pairs[i][0].close - pairs[i - 1][0].close); rr.push(pairs[i][1].close - pairs[i - 1][1].close); }
  const m = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const mb = m(rb), mr = m(rr);
  const cov = rb.reduce((s, x, i) => s + (x - mb) * (rr[i] - mr), 0);
  const vb = rb.reduce((s, x) => s + (x - mb) ** 2, 0), vr = rr.reduce((s, x) => s + (x - mr) ** 2, 0);
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return { matched: pairs.length, offset_mean: r3(mean), offset_sd: r3(sd), offset_max_abs: r3(Math.max(...offs.map(Math.abs))), return_correlation: vb > 0 && vr > 0 ? r3(cov / Math.sqrt(vb * vr)) : null };
}

// ---------------------------------------------------------------- storage

export const CORPUS_SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS corpus_bars (
    source TEXT NOT NULL,
    minute_ms INTEGER NOT NULL,
    o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
    tick_volume INTEGER,
    spread_points INTEGER,
    connection_version INTEGER NOT NULL,
    received_ms INTEGER NOT NULL,
    PRIMARY KEY (source, minute_ms)
  )`,
  `CREATE TABLE IF NOT EXISTS corpus_sources (
    source TEXT PRIMARY KEY,
    server TEXT NOT NULL,
    symbol TEXT NOT NULL,
    connection_version INTEGER NOT NULL,
    last_minute_ms INTEGER,
    stored INTEGER NOT NULL DEFAULT 0,
    refused INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_ms INTEGER NOT NULL
  )`
]);
let ready = false;
export function resetCorpusSchemaCacheForTests() { ready = false; }
async function ensureSchema(db) {
  if (ready) return;
  for (const sql of CORPUS_SCHEMA_SQL) await db.prepare(sql).run();
  ready = true;
}

/**
 * Bridge sync step: stores the new bars of Omega's active broker, pair and user. Returns the cursor
 * (the newest stored minute) so the bridge sends only newer bars. Never throws; off by default.
 */
export async function ingestCorpus(env, corpus, { executor = null, now = Date.now() } = {}) {
  if (corpusMode(env) === "off" || !corpus) return { mode: corpusMode(env), cursor_ms: null };
  const db = env.DB;
  await ensureSchema(db);
  const connection = await db.prepare("SELECT version, status, server FROM omega_connection WHERE id = 1").first().catch(() => null);
  const v = validateCorpus(corpus, { executor, connection, now });
  if (!v.ok) {
    const source = corpusSource(corpus?.server, corpus?.symbol);
    await db.prepare(`INSERT INTO corpus_sources (source, server, symbol, connection_version, refused, last_error, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET refused = refused + excluded.refused, last_error = excluded.last_error, updated_ms = excluded.updated_ms`)
      .bind(source, clean(corpus?.server), clean(corpus?.symbol, 32), Number(connection?.version) || 0, Array.isArray(corpus?.bars) ? corpus.bars.length : 0, v.error, now).run();
    return { mode: "shadow", error: v.error, cursor_ms: null };
  }
  let stored = 0;
  for (const b of v.bars) {
    const r = await db.prepare("INSERT OR IGNORE INTO corpus_bars (source, minute_ms, o, h, l, c, tick_volume, spread_points, connection_version, received_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(v.source, b.t, b.o, b.h, b.l, b.c, b.v, b.s, v.connection_version, now).run();
    if (Number(r?.meta?.changes)) stored += 1;
  }
  const last = await db.prepare("SELECT MAX(minute_ms) AS t FROM corpus_bars WHERE source = ?").bind(v.source).first();
  await db.prepare(`INSERT INTO corpus_sources (source, server, symbol, connection_version, last_minute_ms, stored, refused, last_error, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(source) DO UPDATE SET connection_version = excluded.connection_version, last_minute_ms = excluded.last_minute_ms, stored = stored + excluded.stored, refused = refused + excluded.refused, last_error = NULL, updated_ms = excluded.updated_ms`)
    .bind(v.source, v.server, v.symbol, v.connection_version, last?.t ?? null, stored, v.refused, now).run();
  if (stored && new Date(now).getUTCMinutes() === 0) await db.prepare("DELETE FROM corpus_bars WHERE minute_ms < ?").bind(now - CORPUS_KEEP_MS).run();
  return { mode: "shadow", source: v.source, stored, refused: v.refused, cursor_ms: last?.t ?? null };
}

/** The most bars one corpusBars read returns (about a day of M1). */
export const CORPUS_READ_MAX = 1500;

/**
 * The MT5 fallback's read (docs/RFC_MT5_FALLBACK.md; owner 2026-11-11): the closed M1 bars of the
 * active source (the one updated last) opening after `sinceMs`, oldest first, at most `limit`.
 * Only bars from Omega's active broker, pair and user are ever stored, so the source is that user's.
 * Returns { source, bars: [{ t, o, h, l, c, v }] }; an empty list when the corpus is off or empty.
 */
export async function readCorpusBars(env, { sinceMs = 0, limit = CORPUS_READ_MAX } = {}) {
  const db = env?.DB;
  if (corpusMode(env) === "off" || !db) return { source: null, bars: [] };
  try {
    await ensureSchema(db);
    // The traded pair's source (mt5:...), never a macro symbol's (mt5macro:...).
    const src = await db.prepare("SELECT source, server, symbol FROM corpus_sources WHERE last_minute_ms IS NOT NULL AND source LIKE 'mt5:%' ORDER BY updated_ms DESC LIMIT 1").first();
    if (!src) return { source: null, bars: [] };
    const n = Math.max(1, Math.min(CORPUS_READ_MAX, Number(limit) || CORPUS_READ_MAX));
    const since = finite(Number(sinceMs)) ? Number(sinceMs) : 0;
    const rows = ((await db.prepare("SELECT minute_ms AS t, o, h, l, c, tick_volume AS v FROM corpus_bars WHERE source = ? AND minute_ms > ? ORDER BY minute_ms LIMIT ?").bind(src.source, since, n).all()).results) || [];
    return { source: src.source, server: src.server, symbol: src.symbol, bars: rows.map((r) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: r.v == null ? null : Number(r.v) })) };
  } catch {
    return { source: null, bars: [] };
  }
}

/** The status for GET /api/corpus/status: sources, freshness, completeness and the basis. Never throws. */
export async function corpusStatus(env, { now = Date.now() } = {}) {
  const mode = corpusMode(env);
  const db = env?.DB;
  if (!db) return { mode, sources: [] };
  try { await ensureSchema(db); } catch { return { mode, sources: [] }; }
  const rows = ((await db.prepare("SELECT * FROM corpus_sources WHERE source NOT LIKE 'mt5macro:%' ORDER BY updated_ms DESC LIMIT 8").all().catch(() => ({ results: [] }))).results) || [];
  // The macro symbols (MT5 fallback, stage 2): freshness and counts only; their basis is not gold's.
  const macro = (((await db.prepare("SELECT source, symbol, last_minute_ms, stored, refused FROM corpus_sources WHERE source LIKE 'mt5macro:%' ORDER BY source").all().catch(() => ({ results: [] }))).results) || [])
    .map((m) => ({ source: m.source, symbol: m.symbol, last_bar_age_s: finite(m.last_minute_ms) ? Math.max(0, Math.round((now - m.last_minute_ms - MINUTE) / 1000)) : null, stored: m.stored, refused: m.refused }));
  let reference = [];
  try {
    const rec = JSON.parse((await env.SIGNAL_CACHE?.get?.(SERIES_KEY)) || "null");
    reference = (Array.isArray(rec?.candles) ? rec.candles : []).map((c) => ({ close_ms: Date.parse(c.close_time), close: Number(c.close) })).filter((c) => Number.isFinite(c.close_ms) && finite(c.close));
  } catch { reference = []; }
  const sources = [];
  for (const s of rows) {
    const since = now - 86_400_000;
    const bars = ((await db.prepare("SELECT minute_ms AS t, o, h, l, c, tick_volume AS v FROM corpus_bars WHERE source = ? AND minute_ms >= ? ORDER BY minute_ms").bind(s.source, since).all().catch(() => ({ results: [] }))).results) || [];
    const m15 = aggregateBars(bars, 15);
    const span = bars.length ? Math.round((bars.at(-1).t - bars[0].t) / MINUTE) + 1 : 0;
    sources.push({
      source: s.source, server: s.server, symbol: s.symbol, connection_version: s.connection_version,
      last_bar_age_s: finite(s.last_minute_ms) ? Math.max(0, Math.round((now - s.last_minute_ms - MINUTE) / 1000)) : null,
      bars_24h: bars.length, missing_minutes_24h: Math.max(0, span - bars.length), m15_complete_24h: m15.length,
      stored: s.stored, refused: s.refused, last_error: s.last_error ?? null,
      basis_m15: corpusBasis(m15.map((b) => ({ close_ms: b.close_ms, close: b.close })), reference)
    });
  }
  return { mode, phase: 1, feeds_local_lane: false, sources, macro };
}

// ---------------------------------------------------------------- the MT5 fallback, stage 2 (2026-11-11)
// Owner 2026-11-11: the AI Worker's input as with TradingView, no regression. Besides the traded pair,
// the executor sends the broker's closed M1 bars of the macro symbols the pull adapter reads from
// TradingView (silver, oil, and the six pairs of the ICE dollar index, from which DXY is computed) and
// the USD economic calendar of MQL5 with its released values. Same rules: only from Omega's active
// broker and user (the terminal's server equals the stored connection's and the executor's); only the
// listed bases; the bars validated as the pair's. Sources `mt5macro:<server>:<BASE>`, so the pair's
// source is never mistaken for one. Read by the pull adapter (corpusBars with a base) and by the
// economic-calendar step when TradingView's calendar fails.

export const MACRO_BASES = Object.freeze(["XAGUSD", "USOIL", "EURUSD", "USDJPY", "GBPUSD", "USDCAD", "USDSEK", "USDCHF"]);
export const macroSource = (server, base) => `mt5macro:${clean(server).toLowerCase()}:${base}`;
const baseOf = (b) => clean(b, 16).toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Pure: the macro corpus checked against Omega's active broker and user. */
export function validateCorpusMacro(payload, { executor = null, connection = null, now = Date.now() } = {}) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.series)) return { ok: false, error: "no_corpus_macro" };
  if (!connection || connection.status !== "stored" || !finite(Number(connection.version))) return { ok: false, error: "no_active_user" };
  const server = clean(payload.server);
  if (!server) return { ok: false, error: "server_required" };
  if (server !== clean(connection.server)) return { ok: false, error: "broker_mismatch" };
  if (!executor || clean(executor.server) !== server) return { ok: false, error: "executor_broker_mismatch" };
  const series = [];
  let refusedSeries = 0;
  for (const s of payload.series.slice(0, 16)) {
    const base = baseOf(s?.base);
    if (!MACRO_BASES.includes(base) || series.some((x) => x.base === base)) { refusedSeries += 1; continue; }
    const { bars, refused } = validBars(s.bars, now);
    series.push({ base, symbol: clean(s?.symbol, 32), source: macroSource(server, base), bars, refused });
  }
  return { ok: true, server, connection_version: Number(connection.version), series, refused_series: refusedSeries };
}

/** Bridge sync step: stores the macro bars; returns each base's cursor. Never throws; off with the corpus. */
export async function ingestCorpusMacro(env, payload, { executor = null, now = Date.now() } = {}) {
  if (corpusMode(env) === "off" || !payload) return { mode: corpusMode(env), cursors: null };
  try {
    const db = env.DB;
    await ensureSchema(db);
    const connection = await db.prepare("SELECT version, status, server FROM omega_connection WHERE id = 1").first().catch(() => null);
    const v = validateCorpusMacro(payload, { executor, connection, now });
    if (!v.ok) return { mode: "shadow", error: v.error, cursors: null };
    const cursors = {};
    let stored = 0;
    for (const s of v.series) {
      let n = 0;
      for (const b of s.bars) {
        const r = await db.prepare("INSERT OR IGNORE INTO corpus_bars (source, minute_ms, o, h, l, c, tick_volume, spread_points, connection_version, received_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(s.source, b.t, b.o, b.h, b.l, b.c, b.v, b.s, v.connection_version, now).run();
        if (Number(r?.meta?.changes)) n += 1;
      }
      const last = await db.prepare("SELECT MAX(minute_ms) AS t FROM corpus_bars WHERE source = ?").bind(s.source).first();
      await db.prepare(`INSERT INTO corpus_sources (source, server, symbol, connection_version, last_minute_ms, stored, refused, last_error, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(source) DO UPDATE SET symbol = excluded.symbol, connection_version = excluded.connection_version, last_minute_ms = excluded.last_minute_ms, stored = stored + excluded.stored, refused = refused + excluded.refused, last_error = NULL, updated_ms = excluded.updated_ms`)
        .bind(s.source, v.server, s.symbol || s.base, v.connection_version, last?.t ?? null, n, s.refused, now).run();
      if (last?.t != null) cursors[s.base] = Number(last.t);
      stored += n;
    }
    return { mode: "shadow", stored, cursors };
  } catch (error) {
    return { mode: "shadow", error: String(error?.message ?? error).slice(0, 120), cursors: null };
  }
}

/** The active broker's M1 bars of one macro base after a time, oldest first. Never throws. */
export async function readMacroBars(env, { base, sinceMs = 0, limit = CORPUS_READ_MAX } = {}) {
  const db = env?.DB;
  const b = baseOf(base);
  if (corpusMode(env) === "off" || !db || !MACRO_BASES.includes(b)) return { source: null, bars: [] };
  try {
    await ensureSchema(db);
    const src = await db.prepare("SELECT source, server, symbol FROM corpus_sources WHERE last_minute_ms IS NOT NULL AND source LIKE ? ORDER BY updated_ms DESC LIMIT 1").bind(`mt5macro:%:${b}`).first();
    if (!src) return { source: null, bars: [] };
    const n = Math.max(1, Math.min(CORPUS_READ_MAX, Number(limit) || CORPUS_READ_MAX));
    const rows = ((await db.prepare("SELECT minute_ms AS t, o, h, l, c, tick_volume AS v FROM corpus_bars WHERE source = ? AND minute_ms > ? ORDER BY minute_ms LIMIT ?").bind(src.source, finite(Number(sinceMs)) ? Number(sinceMs) : 0, n).all()).results) || [];
    return { source: src.source, server: src.server, symbol: src.symbol, base: b, bars: rows.map((r) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: r.v == null ? null : Number(r.v) })) };
  } catch {
    return { source: null, bars: [] };
  }
}

// The USD economic calendar of MQL5 (the terminal's built-in calendar, with released values).
const CALENDAR_SCHEMA = `CREATE TABLE IF NOT EXISTS mt5_calendar (
  value_id TEXT PRIMARY KEY, title TEXT NOT NULL, time TEXT NOT NULL, currency TEXT NOT NULL, importance INTEGER,
  actual REAL, forecast REAL, previous REAL, unit TEXT, received_ms INTEGER NOT NULL)`;
const CALENDAR_KEEP_MS = 30 * 86_400_000;
const numOrNull = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** Pure: MQL5 calendar events from Omega's active broker, USD only, within 30 days back and 3 ahead. */
export function validateMt5Calendar(payload, { executor = null, connection = null, now = Date.now() } = {}) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.events)) return { ok: false, error: "no_calendar" };
  if (!connection || connection.status !== "stored") return { ok: false, error: "no_active_user" };
  const server = clean(payload.server);
  if (!server || server !== clean(connection.server) || !executor || clean(executor.server) !== server) return { ok: false, error: "broker_mismatch" };
  const events = [];
  for (const e of payload.events.slice(0, 400)) {
    const t = Number(e?.time_ms), title = clean(e?.title, 140), currency = clean(e?.currency, 4).toUpperCase();
    if (!title || currency !== "USD" || !finite(t) || t < now - CALENDAR_KEEP_MS || t > now + 3 * 86_400_000) continue;
    events.push({ value_id: clean(String(e?.value_id ?? ""), 32) || `${t}:${title}`, title, time: new Date(t).toISOString(), currency, importance: finite(Number(e?.importance)) ? Number(e.importance) : null, actual: numOrNull(e?.actual), forecast: numOrNull(e?.forecast), previous: numOrNull(e?.previous), unit: clean(e?.unit, 16) || null });
  }
  return { ok: true, events };
}

/** Bridge sync step: stores the MQL5 calendar. Never throws; off with the corpus. */
export async function ingestMt5Calendar(env, payload, { executor = null, now = Date.now() } = {}) {
  if (corpusMode(env) === "off" || !payload) return { mode: corpusMode(env) };
  try {
    const db = env.DB;
    const connection = await db.prepare("SELECT version, status, server FROM omega_connection WHERE id = 1").first().catch(() => null);
    const v = validateMt5Calendar(payload, { executor, connection, now });
    if (!v.ok) return { mode: "shadow", error: v.error };
    await db.prepare(CALENDAR_SCHEMA).run();
    for (const e of v.events) {
      await db.prepare(`INSERT INTO mt5_calendar (value_id, title, time, currency, importance, actual, forecast, previous, unit, received_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(value_id) DO UPDATE SET actual = COALESCE(excluded.actual, actual), forecast = COALESCE(excluded.forecast, forecast), previous = COALESCE(excluded.previous, previous), received_ms = excluded.received_ms`)
        .bind(e.value_id, e.title, e.time, e.currency, e.importance, e.actual, e.forecast, e.previous, e.unit, now).run();
    }
    await db.prepare("DELETE FROM mt5_calendar WHERE time < ?").bind(new Date(now - CALENDAR_KEEP_MS).toISOString()).run();
    return { mode: "shadow", events: v.events.length };
  } catch (error) {
    return { mode: "shadow", error: String(error?.message ?? error).slice(0, 120) };
  }
}

/** The MQL5 calendar's USD events in a window, in the gateway's normalized shape. Never throws. */
export async function readMt5Calendar(env, { fromMs, toMs } = {}) {
  try {
    await env.DB.prepare(CALENDAR_SCHEMA).run();
    const rows = (await env.DB.prepare("SELECT * FROM mt5_calendar WHERE time >= ? AND time <= ? ORDER BY time").bind(new Date(fromMs).toISOString(), new Date(toMs).toISOString()).all())?.results || [];
    return rows.map((r) => ({ id: r.value_id, title: r.title, time: r.time, country: "US", currency: "USD", importance: r.importance, actual: r.actual, forecast: r.forecast, previous: r.previous, unit: r.unit, source: "mt5" }));
  } catch {
    return [];
  }
}
