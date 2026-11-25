// The room guardrail waived on a with-trend breakout close (RM1b, owner 2026-11-25, relayed by the orchestrator: "Turn
// variant (d) on now"; the study RM1a, its variant (d6), scripts/studies/rm1a/). The room check (src/decision-engine.mjs
// guardrailsFor, squeezeOf in src/strategy-engine.mjs) holds a side back while the nearest candidate key zones below and
// above price are less than the mode's room apart. RM1a: 238 room-only WAITs from 2026-11-17 to 11-25, 92 of them with the
// 15m close beyond the facing edge of a corridor recorded in the last hour (b4), 90 of those with the trend (d6).
//
// ROOM_BREAKOUT_WAIVE (wrangler.jsonc): "on" | "off"; the code default (unset or anything else) is "off": the room check
// as before, byte for byte. Under "on" a side's failing room check passes (roomWaiverFor) only when ALL of these hold:
//   1. room is the side's only failing check (every other guardrail passes as it is; the room check is unchanged in
//      every other case);
//   2. the decision's 15m close (strategy.price, the close its own corridor is measured around) is beyond the facing
//      edge, in the side's direction, of the corridor recorded by a decision whose bar_close is exactly k x 15 minutes
//      before (k = 1..4, RM1a's b4): below.high for a SELL, above.low for a BUY, as that decision recorded it; a missing
//      or unreadable record does not count;
//   3. the side is WITH the trend: the TREND_TF witness's lean x the side's direction >= ROOM_WAIVE_RULE.trend_lean
//      (LEAN, 0.15). Counter-trend, neutral or a missing trend is never waived.
// The room check's detail then says it was waived; a BUY or SELL that trades on that side keeps
// room_waived = { corridor: { k, width_atr, words }, broke_at, trend } (ATR and words only, never a price) on the decision,
// its Omega entry intent (bridgeSync) and its Signal Ledger row (signal_ledger.room_waived), as SV1b's veto_softened.
//
// The value in force: the owner's FS1 override, else the automatic revert while its hold lasts (KV ROOM_WAIVE_AUTO_KEY),
// else the env (wrangler) value. The value itself is read from the FS1-resolved env only (withFeatureSwitches copies an
// override on); whether it is an override comes from the same copy (overriddenKeys). The automatic revert
// (runRoomWaiveRevert, once a UTC day on the 5-minute ledger step beside SV1b's): once at least 15 closed waived trades
// exist (Omega R, the entry intents joined to signal_ledger.r_omega, as SV1b counts), the mean of the latest 15; below 0R
// the waiver is off for 7 days, with one Telegram line and one Omega event. After the hold only trades opened since count.
// While held, decisions behave exactly as with "off". Every KV key is written only by this Worker at run time.

import { overriddenKeys } from "./feature-switches.mjs";
import { revertVerdict } from "./agent-veto.mjs";

export const ROOM_WAIVE_SWITCH = "ROOM_BREAKOUT_WAIVE";
export const ROOM_WAIVE_AUTO_KEY = "room-waive:auto:v1";
/** RM1a's d6: the last hour's corridors (1..4 bars of 15 minutes before) and the trend's lean (LEAN). */
export const ROOM_WAIVE_RULE = Object.freeze({ bars: 4, bar_ms: 15 * 60_000, trend_lean: 0.15 });
export const ROOM_WAIVE_REVERT = Object.freeze({ min_trades: 15, below_r: 0, hold_days: 7 });
/** The earlier decisions read per decision: the 4 bars of the last hour (bar_close is unique per decision). */
export const ROOM_CORRIDOR_ROWS = 8;
const DAY = 86_400_000;
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r2 = (x) => Math.round(x * 100) / 100;
const parse = (s) => { try { return typeof s === "string" ? JSON.parse(s) : (s ?? null); } catch { return null; } };
const isoAt = (ms) => new Date(ms).toISOString();

/** Pure: the switch as the code reads it ("on" only when it says so; unset or anything else is "off"). */
export function roomBreakoutWaiveOf(env) {
  return String(env?.ROOM_BREAKOUT_WAIVE ?? "").trim().toLowerCase() === "on" ? "on" : "off";
}

/** Pure: the facing edge of a recorded corridor for a side (dir +1: above.low; -1: below.high), or null. */
export function facingEdge(squeeze, dir) {
  if (!squeeze || typeof squeeze !== "object") return null;
  const e = dir < 0 ? squeeze.below?.high : squeeze.above?.low;
  return finite(e) ? e : null;
}

/** Pure: the earlier corridors that count: { k, bar_close, squeeze } with bar_close exactly k x 15 minutes before, k = 1..4. */
export function earlierCorridors(corridors) {
  const t0 = Date.parse(String(corridors?.bar_close ?? ""));
  if (!Number.isFinite(t0) || !Array.isArray(corridors?.earlier)) return [];
  const out = [];
  for (const e of corridors.earlier) {
    const t = Date.parse(String(e?.bar_close ?? ""));
    if (!Number.isFinite(t)) continue;
    const k = (t0 - t) / ROOM_WAIVE_RULE.bar_ms;
    if (!Number.isInteger(k) || k < 1 || k > ROOM_WAIVE_RULE.bars || (t0 - t) % ROOM_WAIVE_RULE.bar_ms !== 0) continue;
    const squeeze = parse(e.squeeze);
    if (squeeze && typeof squeeze === "object") out.push({ k, bar_close: isoAt(t), squeeze });
  }
  return out.sort((a, b) => a.k - b.k);
}

const barsWord = (k) => `${k} bar${k === 1 ? "" : "s"} (${k * 15} minutes)`;

/**
 * Pure (RM1a d6): the waiver of a side's failing room check, or null. `checks`: the side's other checks as guardrailsFor
 * made them (room not among them); `price`: the decision's 15m close (strategy.price); `cards`: the witnesses (TREND_TF);
 * `corridors`: { bar_close, earlier: [{ bar_close, squeeze }] } (loadRoomCorridors). Returns { tag, words } where tag is
 * the decision's room_waived: { corridor: { k, width_atr, words }, broke_at, trend }. The nearest broken corridor counts.
 */
export function roomWaiverFor(dir, { checks = [], price = null, cards = [], corridors = null } = {}) {
  if (dir !== 1 && dir !== -1) return null;
  if (!Array.isArray(checks) || checks.some((c) => c?.id === "room") || !checks.every((c) => c?.pass === true)) return null;
  if (!finite(price)) return null;
  const trendCard = (cards || []).find((c) => c?.key === "TREND_TF");
  const lean = trendCard && trendCard.available !== false ? trendCard.lean : null;
  if (!finite(lean) || dir * lean < ROOM_WAIVE_RULE.trend_lean - 1e-12) return null;
  const broken = earlierCorridors(corridors).find(({ squeeze }) => { const e = facingEdge(squeeze, dir); return e != null && dir * (price - e) > 0; });
  if (!broken) return null;
  const width = finite(broken.squeeze.corridor_atr) ? r2(broken.squeeze.corridor_atr) : null;
  const way = dir > 0 ? "above" : "below";
  const corridorWords = `the corridor recorded ${barsWord(broken.k)} before, ${width == null ? "open on its far side" : `${width} times the 1H average range wide`}`;
  const trend = r2(lean);
  const tag = { corridor: { k: broken.k, width_atr: width, words: corridorWords }, broke_at: broken.bar_close, trend };
  const words = `waived (RM1b): the 15m close is ${way} ${corridorWords}, with the trend (TREND_TF ${trend > 0 ? "+" : ""}${trend})`;
  return { tag, words };
}

/** Pure: a stored room_waived as the intent and the ledger keep it (words clipped), or null when it is not one. */
export function roomWaivedTagOf(v) {
  const t = parse(v);
  if (!t || typeof t !== "object" || !t.corridor || !Number.isInteger(t.corridor.k) || t.corridor.k < 1 || t.corridor.k > ROOM_WAIVE_RULE.bars || typeof t.broke_at !== "string") return null;
  return { corridor: { k: t.corridor.k, width_atr: finite(t.corridor.width_atr) ? t.corridor.width_atr : null, words: String(t.corridor.words ?? "").slice(0, 200) }, broke_at: t.broke_at.slice(0, 40), trend: finite(t.trend) ? t.trend : null };
}

/**
 * The corridors recorded by the decisions of the last hour before `closeIso`: { bar_close, earlier: [{ bar_close,
 * squeeze }] }. One D1 read, only while the waiver is in force: the 4 bar_close values exactly 15, 30, 45 and 60 minutes
 * before (an IN on the bar_close index, idx_engine_decisions_close), at most ROOM_CORRIDOR_ROWS rows, each only its
 * squeeze (json_extract; a record that is not valid JSON gives none). Unreadable: none.
 */
export async function loadRoomCorridors(db, closeIso) {
  const t0 = Date.parse(String(closeIso ?? ""));
  if (!db?.prepare || !Number.isFinite(t0)) return { bar_close: null, earlier: [] };
  const closes = Array.from({ length: ROOM_WAIVE_RULE.bars }, (_, i) => isoAt(t0 - (i + 1) * ROOM_WAIVE_RULE.bar_ms));
  try {
    // json_valid first: one unreadable record is left out (it does not count), the others still do.
    const rows = (await db.prepare(`SELECT bar_close, CASE WHEN json_valid(decision_json) THEN json_extract(decision_json, '$.squeeze') END AS squeeze FROM engine_decisions WHERE bar_close IN (${closes.map(() => "?").join(", ")}) ORDER BY bar_close DESC LIMIT ${ROOM_CORRIDOR_ROWS}`).bind(...closes).all()).results ?? [];
    return { bar_close: isoAt(t0), earlier: rows.map((r) => ({ bar_close: r.bar_close, squeeze: parse(r.squeeze) })) };
  } catch {
    return { bar_close: isoAt(t0), earlier: [] };
  }
}

// ---------------------------------------------------------------- the value in force and the automatic revert

/** Pure: the automatic revert in force at `now` (a stored { value: "off", until }), or null. */
export function roomHoldAt(doc, now = Date.now()) {
  return doc?.value === "off" && Date.parse(String(doc.until ?? "")) > now ? doc : null;
}

/**
 * Pure: the value in force: the owner's override (the FS1-resolved env says so), else "off" while the automatic revert
 * holds, else the env value. { value, source: "owner" | "auto_revert" | "env", env_value }.
 */
export function resolveRoomWaive({ env = null, auto = null, now = Date.now() } = {}) {
  const value = roomBreakoutWaiveOf(env);
  if (overriddenKeys(env).includes(ROOM_WAIVE_SWITCH)) return { value, source: "owner", env_value: value };
  if (value === "on" && roomHoldAt(auto, now)) return { value: "off", source: "auto_revert", env_value: value };
  return { value, source: "env", env_value: value };
}

/**
 * The value in force for a decision. Reads the hold only when it could matter (the env says "on" and no override). An
 * unreadable KV gives "off" (source "unreadable"): the room check as before, never a waiver by accident. Never throws.
 */
export async function resolveRoomBreakoutWaive(env, { now = Date.now() } = {}) {
  const value = roomBreakoutWaiveOf(env);
  if (value !== "on" || overriddenKeys(env).includes(ROOM_WAIVE_SWITCH)) return resolveRoomWaive({ env, now });
  try {
    return resolveRoomWaive({ env, auto: parse(await env?.SIGNAL_CACHE?.get?.(ROOM_WAIVE_AUTO_KEY)), now });
  } catch {
    return { value: "off", source: "unreadable", env_value: value };
  }
}

/**
 * The closed waived trades in Omega's own R, newest first, as SV1b counts its softened trades: the Omega entry intents
 * (a market open or a resting limit) that carry room_waived, joined to the Signal Ledger row of their decision where
 * Omega's policy has closed it (r_omega); one per decision. Only intents created at or after `sinceMs` count. [] when
 * unreadable.
 */
export async function roomWaivedTrades(db, { sinceMs = 0, limit = 500 } = {}) {
  try {
    const rows = (await db.prepare("SELECT l.candle_key AS k, l.r_omega AS r, MAX(i.created_ms) AS at FROM omega_intents i JOIN signal_ledger l ON l.candle_key = 'OANDA:XAUUSD:15:' || CAST(json_extract(i.payload, '$.signal_issued_ms') AS INTEGER) WHERE i.kind IN ('open', 'place_limit') AND json_extract(i.payload, '$.room_waived') IS NOT NULL AND l.omega_status = 'closed' AND i.created_ms >= ? GROUP BY l.candle_key ORDER BY at DESC LIMIT ?")
      .bind(finite(sinceMs) ? sinceMs : 0, limit).all()).results ?? [];
    return rows.map((x) => ({ key: x.k, r: Number(x.r), at: Number(x.at) })).filter((x) => finite(x.r));
  } catch { return []; }
}

const verdictOf = (rs) => revertVerdict(rs, { minTrades: ROOM_WAIVE_REVERT.min_trades, belowR: ROOM_WAIVE_REVERT.below_r });

async function omegaEvent(db, now, action, detail) {
  try { await db.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, ?, ?, ?)").bind(now, "agent:room", action, JSON.stringify(detail)).run(); } catch { /* best effort */ }
}

/** The Telegram line of a revert (no price, no person). */
export function roomWaiveRevertLine(v) {
  return `XAUUSD SYSTEM · Room breakout waiver (ROOM_BREAKOUT_WAIVE) off for ${ROOM_WAIVE_REVERT.hold_days} days: the last ${v.n} trades it let through averaged ${v.mean_r > 0 ? "+" : ""}${v.mean_r}R in Omega R, below ${ROOM_WAIVE_REVERT.below_r}R. The room check is as before meanwhile; checked again daily after the hold.`;
}

/**
 * Once a UTC day (the 5-minute ledger step, beside SV1b's runAgentVetoRevert; no cron of its own): the hold's end, then
 * the revert check. `env` is the FS1-resolved env of the run. Returns { status, ... }: inactive (the waiver is "off" by
 * env and no hold is stored), fresh (already today), held, owner_force (the owner's override wins: no revert), kept,
 * reverted, unavailable or failed. Never throws.
 */
export async function runRoomWaiveRevert(env, { now = Date.now(), send = null, force = false } = {}) {
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db || !kv) return { status: "unavailable" };
  try {
    const value = roomBreakoutWaiveOf(env);
    const owner = overriddenKeys(env).includes(ROOM_WAIVE_SWITCH);
    let auto = parse(await kv.get(ROOM_WAIVE_AUTO_KEY)) ?? {};
    const day = isoAt(now).slice(0, 10);
    if (value !== "on" && !auto.value) return { status: "inactive" };
    if (!force && auto.day === day) return { status: "fresh" };
    const put = async (doc) => { await kv.put(ROOM_WAIVE_AUTO_KEY, JSON.stringify(doc)); return doc; };
    // The hold ends: the env value is back, and only the trades opened from here on count.
    if (auto.value === "off" && !roomHoldAt(auto, now)) {
      await omegaEvent(db, now, "room_waive_released", { value, held_since: auto.since ?? null, held_until: auto.until ?? null });
      auto = { value: null, window_since: auto.until ?? isoAt(now), released_at: isoAt(now), previous: { since: auto.since ?? null, until: auto.until ?? null, n: auto.n ?? null, mean_r: auto.mean_r ?? null } };
    }
    if (roomHoldAt(auto, now)) { await put({ ...auto, day }); return { status: "held", until: auto.until }; }
    const sinceMs = Date.parse(String(auto.window_since ?? "")) || 0;
    const v = verdictOf((await roomWaivedTrades(db, { sinceMs })).map((x) => x.r));
    const last = { n: v.n, mean_r: v.mean_r, at: isoAt(now) };
    if (owner) { await put({ ...auto, day, last }); return { status: "owner_force", value, ...v }; }
    if (value !== "on") { await put({ ...auto, day }); return { status: "inactive" }; }
    if (!v.revert) { await put({ ...auto, day, last }); return { status: "kept", ...v }; }
    const until = isoAt(now + ROOM_WAIVE_REVERT.hold_days * DAY);
    const doc = await put({ value: "off", since: isoAt(now), until, n: v.n, mean_r: v.mean_r, window_since: auto.window_since ?? null, day, reason: `the last ${v.n} waived trades averaged ${v.mean_r}R` });
    await omegaEvent(db, now, "room_waive_reverted", { value: "off", from: "on", until, n: v.n, mean_r: v.mean_r });
    if (typeof send === "function") { try { await send(roomWaiveRevertLine(v)); } catch { /* best effort */ } }
    return { status: "reverted", until: doc.until, ...v };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}

/** The hold as the FS1 row shows it ({ since, until } while it holds, else null). Throws when the KV cannot be read. */
export async function readRoomHold(kv, now = Date.now()) {
  const h = roomHoldAt(parse(await kv?.get?.(ROOM_WAIVE_AUTO_KEY)), now);
  return h ? { since: h.since ?? null, until: h.until ?? null } : null;
}

/**
 * Read only (GET /api/weighting/room `breakout_waive`): the value in force and its source, the env value, the hold, the
 * waived decisions the Signal Ledger holds, and the closed waived trades counted since the last hold with their mean R.
 */
export async function roomWaiveStatus(env, { now = Date.now() } = {}) {
  const resolved = await resolveRoomBreakoutWaive(env, { now });
  let auto = null;
  try { auto = parse(await env?.SIGNAL_CACHE?.get?.(ROOM_WAIVE_AUTO_KEY)); } catch { auto = null; }
  let waived = null;
  try { waived = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM signal_ledger WHERE room_waived IS NOT NULL").first())?.n ?? 0); } catch { waived = null; }
  const sinceMs = Date.parse(String(auto?.window_since ?? "")) || 0;
  const v = env?.DB ? verdictOf((await roomWaivedTrades(env.DB, { sinceMs })).map((x) => x.r)) : { n: 0, mean_r: null, ready: false, revert: false };
  const hold = roomHoldAt(auto, now);
  return {
    value: resolved.value, source: resolved.source, env_value: resolved.env_value,
    owner_force: resolved.source === "owner" ? { value: resolved.value } : null,
    auto_revert: hold ? { since: hold.since ?? null, until: hold.until ?? null, n: hold.n ?? null, mean_r: hold.mean_r ?? null } : null,
    waived, closed: v.n, mean_r: v.mean_r, counted_since: auto?.window_since ?? null, last_check: auto?.day ?? null,
    rule: { bars: ROOM_WAIVE_RULE.bars, trend_lean: ROOM_WAIVE_RULE.trend_lean },
    revert_rule: { min_trades: ROOM_WAIVE_REVERT.min_trades, below_r: ROOM_WAIVE_REVERT.below_r, hold_days: ROOM_WAIVE_REVERT.hold_days }
  };
}

/**
 * The entry intent's tag: the decision's room_waived (read once per decision key and isolate), or null. Only an entry
 * intent (a market open or a resting limit) is tagged; the decision is the one whose close the intent's signal carries.
 */
let tagMemo = { key: null, db: null, tag: null };
export function resetRoomWaivedTagMemoForTests() { tagMemo = { key: null, db: null, tag: null }; }
export async function roomWaivedTag(db, intent) {
  if (!db || !(intent?.kind === "open" || intent?.kind === "place_limit") || !finite(intent.signal_issued_ms)) return null;
  const key = `OANDA:XAUUSD:15:${intent.signal_issued_ms}`;
  if (tagMemo.key === key && tagMemo.db === db) return tagMemo.tag;
  let tag = null;
  try {
    const row = await db.prepare("SELECT json_extract(decision_json, '$.room_waived') AS v FROM engine_decisions WHERE decision_key = ?").bind(key).first();
    tag = roomWaivedTagOf(row?.v);
  } catch { tag = null; }
  tagMemo = { key, db, tag };
  return tag;
}
