// Aether phase A8, part 3 (owner go 2026-11-08): the hourly record of the strategy engine's inputs,
// so its thresholds can be replayed later (RFC_AETHER_KNOWLEDGE_GUARDIAN §9.1, §9.4).
//
// Once per closed H1 bar, at the first sweep 40 minutes or more after the close (the 1H room has
// concluded by then), the sweep stores what buildStrategy reads (src/strategy-engine.mjs), slimmed
// to the fields it uses and gzip-compressed:
//   - each room's agents (status, stance, bias, confidence), conclusion and bar times;
//   - News Daily's TLDR stance; the HUD snapshots' fields; the confirmations; the H1 chain decision;
//   - the closed bars the engine reads (H1, M15, H4, D1: the last 60; W1: the last 2).
// Once the 4-hour horizon has closed, the outcome of each stance (BUY, SELL, WAIT) from the capture
// is scored once on the 15m bars and stored, so a replay needs no old bars.
// Kept 60 days. D1 only (migration 0014); never sent to the platform or to Aether, and it changes
// nothing in a room or a decision.

import { SCORING, scoreStance } from "./outcome-scoring.mjs";

export const STRATEGY_INPUTS_VERSION = "cryptophys.strategy-inputs.v1";
export const STRATEGY_INPUTS_DAYS = 60;
/** The capture waits this long after the H1 close: the 1H room and the H1 decision are done. */
export const CAPTURE_AFTER_CLOSE_MS = 40 * 60_000;
/**
 * The outcome yardstick of a capture: the 15m bars from the capture's last closed 15m bar, over 16
 * bars (4 hours, the H1 horizon), with the thresholds doubled (0.5 and 1 H1 ATR are about 1 and 2
 * 15m ATR). The same yardstick for every replayed arm.
 */
export const OUTCOME = Object.freeze({ horizon: 4 * SCORING.horizon, k: 2 * SCORING.thresholdAtr, waitTarget: 2 * SCORING.waitTargetAtr });

export const STRATEGY_INPUTS_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS strategy_inputs (
    candle_key TEXT PRIMARY KEY,
    captured_at TEXT NOT NULL,
    score_close TEXT,
    version TEXT NOT NULL,
    inputs_gz TEXT NOT NULL,
    live_decision TEXT,
    live_state TEXT,
    outcomes_json TEXT,
    scored_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_strategy_inputs_captured ON strategy_inputs(captured_at)"
];
let schemaReady = false;
export function resetStrategyInputsSchemaCacheForTests() { schemaReady = false; }
export async function ensureStrategyInputsSchema(db) {
  if (schemaReady) return;
  for (const sql of STRATEGY_INPUTS_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const bar = (b) => ({ open_time: b.open_time ?? null, close_time: b.close_time ?? null, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? null });
const msg = (m) => (m ? { id: m.id ?? m.agent ?? null, status: m.status ?? null, stance: m.stance ?? null, bias: m.bias ?? null, confidence: isNum(m.confidence) ? m.confidence : null } : null);
const room = (r) => (r ? { bar_close: r.bar_close ?? null, bar_time: r.bar_time ?? null, conclusion: msg(r.conclusion), openings: (r.openings || []).map(msg) } : null);
const snapshot = (s) => (s?.huds ? {
  timeframe: s.timeframe ?? null, computed_at: s.computed_at ?? null, candle_key: s.candle_key ?? null,
  huds: Object.fromEntries(Object.entries(s.huds).map(([id, h]) => [id, { fields: h?.fields ?? {} }])),
  // The chart plane feeds the level readers and the setup type, so the replay must see it too.
  ...(s.chart_plane ? { chart_plane: s.chart_plane } : {})
} : null);

/** Pure: the inputs buildStrategy reads, without the room texts or other unused fields. */
export function slimInputs(inputs) {
  const rooms = inputs?.rooms || {};
  const tldr = inputs?.news?.tldr;
  return {
    rooms: Object.fromEntries(["D1", "H4", "H1", "M15"].map((k) => [k, room(rooms[k])])),
    news: tldr ? { tldr: { status: tldr.status ?? null, stance: tldr.stance ?? null, confidence: isNum(tldr.confidence) ? tldr.confidence : null } } : null,
    h1Snapshot: snapshot(inputs?.h1Snapshot), m15Snapshot: snapshot(inputs?.m15Snapshot), h4Snapshot: snapshot(inputs?.h4Snapshot), d1Snapshot: snapshot(inputs?.d1Snapshot),
    confirmations: inputs?.confirmations ?? null,
    m5Price: isNum(inputs?.m5Price) ? inputs.m5Price : null,
    h1Bars: (inputs?.h1Bars || []).map(bar), m15Bars: (inputs?.m15Bars || []).map(bar), h4Bars: (inputs?.h4Bars || []).map(bar),
    d1Bars: (inputs?.d1Bars || []).map(bar), w1Bars: (inputs?.w1Bars || []).map(bar),
    h1Chain: inputs?.h1Chain ? { decision: inputs.h1Chain.decision ?? null, confidence: inputs.h1Chain.confidence ?? null, candle_key: inputs.h1Chain.candle_key ?? null } : null,
    // The gated economic events (backlog 11.1): the event-risk caution must replay like the live one.
    calendar: Array.isArray(inputs?.calendar?.events) ? { events: inputs.calendar.events.map((e) => ({ title: e.title, currency: e.currency, time: e.time, impact: e.impact })) } : null,
    now: inputs?.now ?? null
  };
}

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export async function gzipJson(value) { return toB64(await pipe(new TextEncoder().encode(JSON.stringify(value)), new CompressionStream("gzip"))); }
export async function gunzipJson(b64) { return JSON.parse(new TextDecoder().decode(await pipe(fromB64(b64), new DecompressionStream("gzip")))); }

const keyOf = (b) => `OANDA:XAUUSD:60:${Date.parse(b.open_time)}`;
const closed = (bars, now) => (bars || []).filter((b) => Date.parse(b.close_time) <= now);

/**
 * Sweep step: stores the strategy inputs of the last closed H1 bar once, at the first call 40 or
 * more minutes after its close. `load` and `build` are loadStrategyInputs and buildStrategy.
 */
export async function captureStrategyInputs(env, { now = Date.now(), load, build } = {}) {
  if (!env?.DB || typeof load !== "function") return { status: "unavailable" };
  await ensureStrategyInputsSchema(env.DB);
  // Cheap checks first, so the inputs are loaded once an hour, not at every sweep.
  const hourClose = Math.floor(now / 3_600_000) * 3_600_000;
  const expectedKey = `OANDA:XAUUSD:60:${hourClose - 3_600_000}`;
  if (now - hourClose < CAPTURE_AFTER_CLOSE_MS) return { status: "waiting", candle_key: expectedKey };
  if (await env.DB.prepare("SELECT 1 AS x FROM strategy_inputs WHERE candle_key = ?").bind(expectedKey).first()) return { status: "already_captured", candle_key: expectedKey };
  const inputs = await load(env, { now });
  const lastH1 = closed(inputs?.h1Bars, now).at(-1);
  if (!lastH1) return { status: "no_h1_bar" };
  // The cached series must hold the bar that closed on this hour (not the case on a weekend or a feed gap).
  if (Date.parse(lastH1.close_time) !== hourClose) return { status: "stale", candle_key: keyOf(lastH1) };
  const key = keyOf(lastH1);
  const slim = slimInputs({ ...inputs, now });
  let live = null;
  try { live = typeof build === "function" ? build(slim) : null; } catch { live = null; }
  const scoreClose = closed(slim.m15Bars, now).at(-1)?.close_time ?? null;
  const gz = await gzipJson(slim);
  await env.DB.prepare("INSERT INTO strategy_inputs (candle_key, captured_at, score_close, version, inputs_gz, live_decision, live_state) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(candle_key) DO NOTHING")
    .bind(key, new Date(now).toISOString(), scoreClose, STRATEGY_INPUTS_VERSION, gz, live?.decision ?? null, live?.state ?? null).run();
  return { status: "captured", candle_key: key, bytes: gz.length, live_decision: live?.decision ?? null };
}

/** Pure: the outcome of each stance from `closeMs` on the 15m bars, or null until all three are final. */
export function stanceOutcomes(m15Bars, closeMs) {
  const out = {};
  for (const stance of ["BUY", "SELL", "WAIT"]) {
    const s = scoreStance({ stance, bars: m15Bars, closeMs, horizon: OUTCOME.horizon, k: OUTCOME.k, waitTarget: OUTCOME.waitTarget });
    // Pending, or a bar still missing from the cache: not final (the caller marks a day-old capture no_data).
    if (s.result === "pending" || s.result === "no_data" || s.result === "not_scored") return null;
    out[stance] = s.result;
  }
  return out;
}

/** Sweep step: scores the captures whose 4-hour horizon has closed, and drops captures older than 60 days. */
export async function scoreStrategyCaptures(env, { now = Date.now(), limit = 50 } = {}) {
  if (!env?.DB) return { status: "unavailable" };
  await ensureStrategyInputsSchema(env.DB);
  const due = new Date(now - OUTCOME.horizon * 900_000).toISOString();
  const rows = (await env.DB.prepare("SELECT candle_key, score_close FROM strategy_inputs WHERE outcomes_json IS NULL AND score_close IS NOT NULL AND score_close <= ? ORDER BY score_close LIMIT ?").bind(due, limit).all()).results || [];
  let scored = 0;
  if (rows.length) {
    let bars = [];
    try {
      const record = JSON.parse((await env.SIGNAL_CACHE?.get?.("market-data:v2:series:OANDA:XAUUSD|15m")) || "null");
      bars = (Array.isArray(record?.candles) ? record.candles : []).filter((c) => [c.open, c.high, c.low, c.close].every(isNum) && c.close_time && Date.parse(c.close_time) <= now)
        .sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
    } catch { bars = []; }
    const at = new Date(now).toISOString();
    for (const r of rows) {
      const outcomes = stanceOutcomes(bars, Date.parse(r.score_close));
      // A capture whose bars left the cache, or never existed, is marked so it is not retried forever.
      const value = outcomes ?? (Date.parse(r.score_close) < now - 86_400_000 ? { no_data: true } : null);
      if (!value) continue;
      await env.DB.prepare("UPDATE strategy_inputs SET outcomes_json = ?, scored_at = ? WHERE candle_key = ?").bind(JSON.stringify(value), at, r.candle_key).run();
      scored += 1;
    }
  }
  const pruned = await env.DB.prepare("DELETE FROM strategy_inputs WHERE captured_at < ?").bind(new Date(now - STRATEGY_INPUTS_DAYS * 86_400_000).toISOString()).run();
  return { status: "ok", scored, pending: rows.length - scored, pruned: pruned?.meta?.changes ?? null };
}

/** Summary for /api/tuning: how many hours are stored and scored. */
export async function strategyInputsStatus(env) {
  if (!env?.DB) return null;
  await ensureStrategyInputsSchema(env.DB);
  const r = await env.DB.prepare("SELECT COUNT(*) AS captured, SUM(CASE WHEN outcomes_json IS NOT NULL AND outcomes_json NOT LIKE '%no_data%' THEN 1 ELSE 0 END) AS scored, MIN(captured_at) AS first, MAX(captured_at) AS last FROM strategy_inputs").first();
  return { version: STRATEGY_INPUTS_VERSION, retention_days: STRATEGY_INPUTS_DAYS, captured: Number(r?.captured ?? 0), scored: Number(r?.scored ?? 0), first: r?.first ?? null, last: r?.last ?? null };
}
