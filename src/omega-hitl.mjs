// Human-AI interaction on the Omega Trade tab (owner 2026-11-19: "di tab trade perlu ditambah modify untuk manual
// interuption Entry/TP/SL dan juga delegate supaya entry manual selanjutnya dihandle oleh omega"; confirmed:
// "Posisi + pending order", "Omega lanjut biasa", "Tombol + toggle", "Kelola penuh").
//
// Modify: the owner sets a position's stop and target, or a pending order's price, stop and target, from Nexus. The
// request is checked against the live price and the broker's stop distance here, queued as one intent with a
// "manual:" id (OmegaExecutor 1.18 acts on a position or order without its own magic only for such ids) and audited.
// Omega keeps managing an Omega position as before afterwards: a later ladder lock or trail may move the stop again.
//
// Delegate: the owner hands a manual position to Omega, one by one ("Delegate" on the row), or every manual position
// opened while "Delegate my next manual entries" is on. A delegated position is managed like Omega's own: a stop from
// the plan when it has none, break-even, the TP ladder and lock, the Position Manager's take-profit and cut-loss, the
// closes on an opposite signal. Omega never adds to it, never sizes it up and never reverses it. Its intents carry a
// "d:" id. Both need OmegaExecutor 1.18; an older EA leaves delegated positions alone (note `delegate_needs_ea_1_18`).
import { versionAtLeast } from "./account-spec.mjs";

export const HITL_EA_MIN_VERSION = "1.18";
export const DELEGATE_PREFIX = "d:";
const INTENT_ID_MAX = 31;
const ORDER_TYPES = Object.freeze(["BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP"]);
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const parse = (t, d = null) => { try { return t == null ? d : JSON.parse(t); } catch { return d; } };
const roundTo = (v, digits) => (Number.isInteger(digits) ? Number(v.toFixed(digits)) : v);

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS omega_delegations (ticket INTEGER PRIMARY KEY, actor TEXT NOT NULL, at_ms INTEGER NOT NULL, auto INTEGER NOT NULL DEFAULT 0, released_ms INTEGER)",
  "CREATE TABLE IF NOT EXISTS omega_delegate_mode (id INTEGER PRIMARY KEY CHECK (id = 1), on_flag INTEGER NOT NULL, since_ms INTEGER, actor TEXT, at_ms INTEGER NOT NULL)"
];
let ready = false;
export function resetHitlSchemaForTests() { ready = false; }
export async function ensureHitlSchema(db) {
  if (ready) return;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  ready = true;
}

/** Whether the executor runs an OmegaExecutor that takes the owner's edits and delegated positions (1.18+). */
export const hitlSupported = (executor) => versionAtLeast(executor?.executor?.version ?? null, HITL_EA_MIN_VERSION);
const isManual = (p) => p?.source === "manual" || p?.magic === 0;

/** Pure: the broker's minimum stop distance in price (stops level), 0 when unknown. */
function stopsDistance(sym) {
  const pt = finite(sym?.point) && sym.point > 0 ? sym.point : 0;
  return finite(sym?.stops_level_points) && pt ? sym.stops_level_points * pt : 0;
}

/**
 * Pure: the owner's new stop and target of an open position, checked against the live price, or { error }. A null or
 * 0 level removes it. A BUY closes at the bid (its stop below, its target above), a SELL at the ask.
 */
export function checkPositionModify({ position: p, sym, sl, tp }) {
  if (!p || (p.side !== "BUY" && p.side !== "SELL")) return { error: "position_not_found" };
  const bid = num(sym?.bid), ask = num(sym?.ask);
  if (!finite(bid) || !finite(ask) || bid <= 0) return { error: "no_live_price" };
  const nsl = num(sl), ntp = num(tp);
  if ((nsl != null && !(nsl >= 0)) || (ntp != null && !(ntp >= 0))) return { error: "levels_must_be_prices" };
  const buy = p.side === "BUY", px = buy ? bid : ask, d = stopsDistance(sym);
  if (nsl) {
    if (buy ? !(nsl < px - d) : !(nsl > px + d)) return { error: `stop_${buy ? "below" : "above"}_price`, detail: `a ${p.side} stop must be ${buy ? "below the bid" : "above the ask"} ${d ? `by at least ${roundTo(d, sym?.digits)}` : ""}`.trim() };
  }
  if (ntp) {
    if (buy ? !(ntp > px + d) : !(ntp < px - d)) return { error: `target_${buy ? "above" : "below"}_price`, detail: `a ${p.side} target must be ${buy ? "above the bid" : "below the ask"} ${d ? `by at least ${roundTo(d, sym?.digits)}` : ""}`.trim() };
  }
  const digits = Number.isInteger(sym?.digits) ? sym.digits : null;
  return { sl: nsl ? roundTo(nsl, digits) : 0, tp: ntp ? roundTo(ntp, digits) : 0 };
}

/** Pure: the owner's new price, stop and target of a pending order, checked against the live price, or { error }. */
export function checkOrderModify({ order: o, sym, price, sl, tp }) {
  if (!o || !ORDER_TYPES.includes(o.type)) return { error: o ? "order_type_not_supported" : "order_not_found" };
  const bid = num(sym?.bid), ask = num(sym?.ask);
  if (!finite(bid) || !finite(ask) || bid <= 0) return { error: "no_live_price" };
  const p = num(price) || num(o.price_open), nsl = num(sl), ntp = num(tp), d = stopsDistance(sym);
  if (!finite(p) || p <= 0) return { error: "price_required" };
  const buy = o.type.startsWith("BUY");
  const ok = { BUY_LIMIT: p < ask - d, SELL_LIMIT: p > bid + d, BUY_STOP: p > ask + d, SELL_STOP: p < bid - d }[o.type];
  if (!ok) return { error: "price_wrong_side", detail: `a ${o.type.replace("_", " ")} must be ${{ BUY_LIMIT: "below the ask", SELL_LIMIT: "above the bid", BUY_STOP: "above the ask", SELL_STOP: "below the bid" }[o.type]}` };
  if (nsl && (buy ? !(nsl < p - d) : !(nsl > p + d))) return { error: `stop_${buy ? "below" : "above"}_price` };
  if (ntp && (buy ? !(ntp > p + d) : !(ntp < p - d))) return { error: `target_${buy ? "above" : "below"}_price` };
  const digits = Number.isInteger(sym?.digits) ? sym.digits : null;
  return { price: roundTo(p, digits), sl: nsl ? roundTo(nsl, digits) : 0, tp: ntp ? roundTo(ntp, digits) : 0 };
}

async function latestExecutor(db) {
  const row = await db.prepare("SELECT state FROM omega_bridge WHERE id = 1").first();
  return parse(row?.state, null);
}
const shortNow = (now) => Math.floor(now / 1000).toString(36);
const audit = (db, now, actor, action, detail) =>
  db.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, ?, ?, ?)").bind(now, String(actor || "owner").slice(0, 120), action, JSON.stringify(detail)).run();
const queue = (db, now, intent) =>
  db.prepare("INSERT OR IGNORE INTO omega_intents (id, kind, payload, status, created_ms, updated_ms) VALUES (?, ?, ?, 'pending', ?, ?)").bind(intent.id, intent.kind, JSON.stringify(intent), now, now).run();

/** The owner's edit of a position's stop and target, or of a pending order: one "manual:" intent, audited. */
export async function ownerModify(env, { target = "position", ticket, sl = null, tp = null, price = null, actor = "owner" } = {}, { now = Date.now(), executor: exIn } = {}) {
  const db = env.DB;
  const t = Number(ticket);
  if (!Number.isInteger(t) || t <= 0) return { ok: false, error: "invalid_ticket" };
  const ex = exIn ?? (await latestExecutor(db));
  if (!ex?.connected) return { ok: false, error: "executor_offline" };
  if (!hitlSupported(ex)) return { ok: false, error: "ea_1_18_required", detail: `OmegaExecutor ${HITL_EA_MIN_VERSION} or later takes edits from Nexus; the terminal runs ${ex?.executor?.version ?? "an older version"}.` };
  if (target === "order") {
    const o = (ex.orders ?? []).find((x) => Number(x?.ticket) === t);
    const c = checkOrderModify({ order: o, sym: ex.symbol, price, sl, tp });
    if (c.error) return { ok: false, ...c };
    // The bridge's line has no price field: a modify_order carries the new price in the volume field (OmegaExecutor 1.18).
    const intent = { id: `manual:mo:${t}:${shortNow(now)}`.slice(0, INTENT_ID_MAX), kind: "modify_order", ticket: t, volume: c.price, sl: c.sl, tp: c.tp, reason: "owner_modify", actor: String(actor).slice(0, 64) };
    await queue(db, now, intent);
    await audit(db, now, actor, "owner_modify_order", { ticket: t, from: { price: o.price_open ?? null, sl: o.sl ?? null, tp: o.tp ?? null }, to: { price: c.price, sl: c.sl || null, tp: c.tp || null }, intent_id: intent.id });
    return { ok: true, intent_id: intent.id, ticket: t, price: c.price, sl: c.sl || null, tp: c.tp || null };
  }
  const p = (ex.positions ?? []).find((x) => Number(x?.ticket) === t);
  const c = checkPositionModify({ position: p, sym: ex.symbol, sl, tp });
  if (c.error) return { ok: false, ...c };
  const intent = { id: `manual:mp:${t}:${shortNow(now)}`.slice(0, INTENT_ID_MAX), kind: "modify_sltp", ticket: t, sl: c.sl, tp: c.tp, reason: "owner_modify", actor: String(actor).slice(0, 64) };
  await queue(db, now, intent);
  await audit(db, now, actor, "owner_modify_position", { ticket: t, side: p.side, from: { sl: p.sl ?? null, tp: p.tp ?? null }, to: { sl: c.sl || null, tp: c.tp || null }, intent_id: intent.id });
  return { ok: true, intent_id: intent.id, ticket: t, sl: c.sl || null, tp: c.tp || null };
}

/** The delegations in force and the toggle, for the plan and the overview. Never throws. */
export async function readDelegations(db) {
  try {
    await ensureHitlSchema(db);
    const rows = (await db.prepare("SELECT ticket, actor, at_ms, auto FROM omega_delegations WHERE released_ms IS NULL ORDER BY at_ms DESC LIMIT 100").all()).results ?? [];
    const mode = await db.prepare("SELECT on_flag, since_ms, actor, at_ms FROM omega_delegate_mode WHERE id = 1").first();
    return { tickets: rows.map((r) => Number(r.ticket)), rows, mode: { on: Number(mode?.on_flag) === 1, since_ms: mode?.since_ms ?? null, actor: mode?.actor ?? null, at_ms: mode?.at_ms ?? null } };
  } catch {
    return { tickets: [], rows: [], mode: { on: false, since_ms: null, actor: null, at_ms: null } };
  }
}

/** The owner hands one manual position to Omega, or takes it back. Audited. */
export async function setDelegation(env, { ticket, on, actor = "owner" } = {}, { now = Date.now(), executor: exIn } = {}) {
  const db = env.DB;
  await ensureHitlSchema(db);
  const t = Number(ticket);
  if (!Number.isInteger(t) || t <= 0) return { ok: false, error: "invalid_ticket" };
  if (typeof on !== "boolean") return { ok: false, error: "on must be true or false" };
  if (on) {
    const ex = exIn ?? (await latestExecutor(db));
    if (!hitlSupported(ex)) return { ok: false, error: "ea_1_18_required", detail: `OmegaExecutor ${HITL_EA_MIN_VERSION} or later manages a manual position; the terminal runs ${ex?.executor?.version ?? "an older version"}.` };
    const p = (ex?.positions ?? []).find((x) => Number(x?.ticket) === t);
    if (!p) return { ok: false, error: "position_not_found" };
    if (!isManual(p)) return { ok: false, error: "already_omega", detail: "Omega already manages this position." };
    await db.prepare("INSERT INTO omega_delegations (ticket, actor, at_ms, auto, released_ms) VALUES (?, ?, ?, 0, NULL) ON CONFLICT(ticket) DO UPDATE SET actor = excluded.actor, at_ms = excluded.at_ms, auto = 0, released_ms = NULL").bind(t, String(actor).slice(0, 120), now).run();
  } else {
    await db.prepare("UPDATE omega_delegations SET released_ms = ? WHERE ticket = ? AND released_ms IS NULL").bind(now, t).run();
  }
  await audit(db, now, actor, on ? "position_delegated" : "position_delegation_released", { ticket: t });
  return { ok: true, ticket: t, delegated: on };
}

/** The toggle: every manual position opened while it is on is delegated by itself. Audited. */
export async function setDelegateMode(env, { on, actor = "owner" } = {}, { now = Date.now() } = {}) {
  const db = env.DB;
  await ensureHitlSchema(db);
  if (typeof on !== "boolean") return { ok: false, error: "on must be true or false" };
  await db.prepare("INSERT INTO omega_delegate_mode (id, on_flag, since_ms, actor, at_ms) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET on_flag = excluded.on_flag, since_ms = excluded.since_ms, actor = excluded.actor, at_ms = excluded.at_ms")
    .bind(on ? 1 : 0, on ? now : null, String(actor).slice(0, 120), now).run();
  await audit(db, now, actor, on ? "delegate_mode_on" : "delegate_mode_off", {});
  return { ok: true, on, since_ms: on ? now : null };
}

/**
 * The plan's view of delegation at one sync: manual positions opened while the toggle is on are delegated first
 * (event `position_delegated` with auto). Returns the delegated tickets still open. Never throws.
 */
export async function delegationsForSync(db, executor, { now = Date.now(), log = null } = {}) {
  const d = await readDelegations(db);
  const open = Array.isArray(executor?.positions) ? executor.positions : [];
  const tickets = new Set(d.tickets);
  if (d.mode.on && Number.isFinite(Number(d.mode.since_ms))) {
    for (const p of open) {
      if (!isManual(p) || tickets.has(Number(p.ticket)) || !(Number(p.opened_ms) >= Number(d.mode.since_ms))) continue;
      try {
        // A position the owner took back keeps its row (released): the toggle never adopts it again.
        const r = await db.prepare("INSERT OR IGNORE INTO omega_delegations (ticket, actor, at_ms, auto, released_ms) VALUES (?, 'auto', ?, 1, NULL)").bind(Number(p.ticket), now).run();
        if (!(Number(r?.meta?.changes ?? 0) > 0)) continue;
        tickets.add(Number(p.ticket));
        if (log) await log("position_delegated", { ticket: Number(p.ticket), auto: true });
      } catch { /* the next sync tries again */ }
    }
  }
  return [...tickets].filter((t) => open.some((p) => Number(p.ticket) === t));
}

/**
 * Pure: the executor with each delegated manual position marked (`delegated`, an `intent_id` of `deleg:<ticket>` for
 * its meta) so the plan manages it like Omega's own, and the meta of each (the mode now, R from its stop if any).
 */
export function withDelegated(executor, tickets = [], { mode = null } = {}) {
  const set = new Set(tickets.map(Number));
  if (!set.size || !Array.isArray(executor?.positions)) return { executor, meta: {} };
  const meta = {};
  const positions = executor.positions.map((p) => {
    if (!set.has(Number(p.ticket)) || !isManual(p)) return p;
    const id = `deleg:${p.ticket}`;
    const rDist = finite(p.sl) && p.sl > 0 && finite(p.open_price) ? Math.abs(p.open_price - p.sl) : null;
    meta[id] = { mode, r_dist: rDist };
    return { ...p, delegated: true, intent_id: id };
  });
  return { executor: { ...executor, positions }, meta };
}

/**
 * Pure: a stop for each delegated position that has none (owner: "SL from the plan if none is set"): the current
 * signal's plan stop distance when it is on the position's side, else 1.5 × ATR(M15), never inside the broker's stop
 * distance, from the open price, and only where it still lies beyond the live price.
 */
export function delegatedStopIntents({ positions = [], sym = {}, signal = null }) {
  const out = [];
  const bid = num(sym?.bid), ask = num(sym?.ask), digits = Number.isInteger(sym?.digits) ? sym.digits : null;
  if (!finite(bid) || !finite(ask)) return out;
  for (const p of positions) {
    if (p?.delegated !== true || (finite(p.sl) && p.sl > 0) || !finite(p.open_price)) continue;
    const buy = p.side === "BUY";
    const planDist = signal?.side === p.side && finite(signal?.entry) && finite(signal?.stop) ? Math.abs(signal.entry - signal.stop) : null;
    const atrDist = finite(sym?.atr_value) && sym.atr_value > 0 ? 1.5 * sym.atr_value : null;
    let dist = planDist ?? atrDist;
    if (!(dist > 0)) continue;
    dist = Math.max(dist, stopsDistance(sym) * 1.1);
    const sl = roundTo(buy ? p.open_price - dist : p.open_price + dist, digits);
    const px = buy ? bid : ask;
    if (buy ? !(sl < px) : !(sl > px)) continue;
    out.push({ id: `ds:${p.ticket}`, kind: "modify_sl", ticket: p.ticket, sl, tp: finite(p.tp) && p.tp > 0 ? p.tp : null, reason: planDist ? "delegated_stop_plan" : "delegated_stop_atr" });
  }
  return out;
}

/** Pure: the intents on delegated tickets carry the "d:" id OmegaExecutor 1.18 accepts on a manual position. */
export function markDelegatedIntents(intents = [], tickets = []) {
  const set = new Set(tickets.map(Number));
  return intents.map((it) => (it?.ticket != null && set.has(Number(it.ticket)) && !String(it.id).startsWith(DELEGATE_PREFIX)
    ? { ...it, id: `${DELEGATE_PREFIX}${it.id}`.slice(0, INTENT_ID_MAX), delegated: true } : it));
}

/** Pure: the ids the planner checks for repeats, with the "d:" ids also under their own id. */
export const plannerIds = (ids = []) => ids.flatMap((id) => (String(id).startsWith(DELEGATE_PREFIX) ? [id, String(id).slice(DELEGATE_PREFIX.length)] : [id]));
