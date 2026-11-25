// B5, the Position Manager lines, each behind a breaker (Track B v2 B5 with erratum E7; docs/RFC_INDICATOR_ADOPTION.md,
// "The Position Manager line breaker"). Track B is live, no shadow (owner 2026-11-22: "tidak perlu shadow, langsung
// integrasikan kamu tentukan designnya yang cocok untuk memperkuat council dan kontribusi lainnya decision, strategi, key
// level, position dan lainnya seperti agen lainnya"), so each Position Manager rule that sends a broker action (a close, a
// stop, a target) is a LINE with an id (its position_actions `rule`) and a version, and each line stands behind its own
// breaker instead of a shadow arm:
//   - D1 position_actions.lines_json = { present, cause }: `present` the on lines whose input the evaluation had ("id@v",
//     sorted), `cause` the line whose reason or level set the action ("id@v"), or null. Off lines are never in either.
//   - A close counts for line L when L sent it, else when L made the position's last applied stop or target change
//     before it (the final close of a position whose last applied SL/TP change was L's). One line per close.
//   - R = the position's ea_deals net (DEAL_NET_SQL) / risk_usd: the open intent's own `risk_usd` (probation), else the
//     risk at its stop as the live parity counts it (src/ledger-omega4.mjs liveTradesFrom: r_dist / 0.01 x
//     LIVE_TICK_VALUE_PER_001 x the open volume).
//   - r_vs_hold = R minus the R of holding to the plan's SL/TP (the open intent's sl and tp) from the line's action on,
//     on the broker's 1m bars (broker_bars_1m, the exit price's bars: fastBars), with the Position Manager report's rule
//     (heldExitPrice: the first of the stop or the target touched, else the last close). Recorded, never a trigger.
//   - A line goes off by itself when its last 15 closes average below 0R (lineBreakerVerdict): KV PM_LINE_BREAKER_KEY,
//     one omega_events `pm_line_off` row and one Telegram line (the Omega path), once per trip.
//   - An off line is not acted on: the Position Manager and PM-1M skip that rule's action exactly as if the rule had not
//     fired (positionAction's and fastProtect's `off`). Nothing else changes.
//   - A line comes back only by a version bump here (PM_LINES) or by the owner (POST /api/pm-lines on the Omega Worker,
//     OmegaGateway.setPmLine): either opens a fresh window (closes 0, the last-15 window empty, counted from then on).
//   - PM_LINES_OFF (AI Worker variable, FS1 row; comma- or space-separated ids) switches lines off by hand.
//   - v4 (src/ledger-omega4.mjs) cannot replay a KV state: every change of the set of off lines is an omega_events row
//     carrying the whole set (`off`), and v4 replays the set in force at each minute (linesOffAt).
// Every KV key is written only by this Worker at run time.

import { ensurePositionSchema, actionIdOfIntent } from "./position-actions.mjs";
import { DEAL_NET_SQL } from "./gold-symbol.mjs";

export const PM_LINE_BREAKER_KEY = "pm:line-breaker:v1";
export const PM_LINE_BREAKER_VERSION = "cryptophys.pm-line-breaker.v1";
/** The breaker's rule: a line goes off when the mean R of its last `n` closes is below `floor`. */
export const PM_LINE_RULE = Object.freeze({ n: 15, floor: 0 });
/** The omega_events actions that change the set of off lines (each detail carries the whole set, `off`). */
export const PM_LINE_EVENTS = Object.freeze(["pm_line_off", "pm_line_on", "pm_lines_env"]);
export const PM_LINE_ACTOR = "agent:pm-line-breaker";

/**
 * The lines: { id, version }. `id` is the position_actions rule id; `liquidity` (the spec's liquidity@1) is lens B's
 * management reason in the Position Manager (cut_loss's liquidity_sweep_against reason and A8's
 * tp_nearer_liquidity_sweep_against), the cause whenever lens B's reading set the action. A bump of `version` turns a
 * line back on and opens a fresh window. Lines of later PRs (A13 setup, B25, B28) are registered when they land.
 */
export const PM_LINES = Object.freeze([
  // The fixed rules (src/position-manager.mjs ruleCore).
  Object.freeze({ id: "take_profit_weakening", version: 1 }),
  Object.freeze({ id: "lock_tp1", version: 1 }),
  Object.freeze({ id: "breakeven", version: 1 }),
  Object.freeze({ id: "tp2_target", version: 1 }),
  Object.freeze({ id: "tp2_breakeven", version: 1 }),
  Object.freeze({ id: "cut_loss", version: 1 }),
  // ADR-0020 Amendment 8, the council's bounded loosening and two-way target (behind pm_loosen_enabled).
  Object.freeze({ id: "loosen_atr_expansion", version: 1 }),
  Object.freeze({ id: "loosen_key_level_outside", version: 1 }),
  Object.freeze({ id: "loosen_high_impact_release", version: 1 }),
  Object.freeze({ id: "tp_nearer_momentum_fading", version: 1 }),
  Object.freeze({ id: "tp_nearer_key_level_before", version: 1 }),
  Object.freeze({ id: "tp_nearer_confidence_drop", version: 1 }),
  Object.freeze({ id: "tp_further_atr_expansion_trend", version: 1 }),
  Object.freeze({ id: "tp_further_key_level_beyond", version: 1 }),
  // Lens B in the Position Manager (docs/RFC_POSITIONING_LIQUIDITY.md §6).
  Object.freeze({ id: "liquidity", version: 1 }),
  // PM-1M, the 1m fast-protect layer (src/pm-fast.mjs PM_FAST_RULES).
  Object.freeze({ id: "pm_fast_tp", version: 1 }),
  Object.freeze({ id: "pm_fast_cut", version: 1 })
]);
export const PM_LINE_IDS = Object.freeze(PM_LINES.map((l) => l.id));
/** The 1m layer's own lines (pm-fast skips only these). */
export const PM_FAST_LINE_IDS = Object.freeze(["pm_fast_tp", "pm_fast_cut"]);
/** How long a close's hold counterfactual waits for the plan's stop or target before it is marked at the last close. */
export const HOLD_HORIZON_MS = 24 * 3600_000;
/** The applied line actions the tick looks back over, and the most tickets it settles per run. */
export const PM_LINE_LOOKBACK_MS = 30 * 86_400_000;
const TICKETS_PER_RUN = 40;
/** A close intent not (yet) done within this window before the deal's close may be that close with its ack lost: the
 * ticket waits (no credit, not seen) until the intent is done (CA1 reconciles it from ea_deals), at most PM_LINE_DEFER_MS
 * after the close, after which it is credited from the done intents as before. */
export const PM_LINE_ACK_WINDOW_MS = 5_000;
export const PM_LINE_DEFER_MS = 30 * 60_000;
const M1 = 60_000;
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const parse = (s, fallback = null) => { if (s == null) return fallback; if (typeof s !== "string") return s; try { return JSON.parse(s); } catch { return fallback; } };

/** Pure: whether an id is a registered line. */
export const isPmLine = (id) => typeof id === "string" && PM_LINE_IDS.includes(id);
/** Pure: a line's registry entry, or null. */
export const pmLine = (id) => PM_LINES.find((l) => l.id === id) ?? null;
/** Pure: a line's tag at its current version ("cut_loss@1"), or null for an unknown id. */
export function lineTag(id) {
  const l = pmLine(id);
  return l ? `${l.id}@${l.version}` : null;
}
/** Pure: a tag's { id, version }, or null. */
export function parseTag(tag) {
  const m = /^([a-z0-9_]+)@(\d+)$/.exec(String(tag ?? ""));
  return m ? { id: m[1], version: Number(m[2]) } : null;
}
/** Pure: whether a line is an A8 rule (its input present only with pm_loosen_enabled on). */
export const isA8Line = (id) => /^(loosen_|tp_nearer_|tp_further_)/.test(String(id ?? ""));

/** Pure: the lines PM_LINES_OFF names (known ids only, registry order). */
export function pmLinesOffEnv(env) {
  const given = new Set(String(env?.PM_LINES_OFF ?? "").split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean));
  return PM_LINE_IDS.filter((id) => given.has(id));
}

/**
 * Pure: the breaker's verdict over a line's closes (oldest first; numbers or { r }): { n, mean_r, trip }. It trips when
 * the last `n` closes are in and their mean R is below `floor`.
 */
export function lineBreakerVerdict(closes = [], { n = PM_LINE_RULE.n, floor = PM_LINE_RULE.floor } = {}) {
  const rs = (Array.isArray(closes) ? closes : []).map((c) => (typeof c === "number" ? c : Number(c?.r))).filter(finite).slice(-n);
  const mean = rs.length ? rs.reduce((a, x) => a + x, 0) / rs.length : null;
  return { n: rs.length, mean_r: r3(mean), trip: rs.length >= n && mean < floor - 1e-12 };
}

/** Pure: a fresh line entry (its window opens at `since`). */
const freshLine = (l, since) => ({ version: l.version, since_ms: since, off_since: null, trip_mean_r: null, closes: 0, last: [] });

/**
 * Pure: the stored document normalized against the registry: every line present; a line stored at another version
 * than the registry's starts fresh at `now` (`bumped` lists those). { doc, bumped }.
 */
export function normalizeDoc(raw, { now = Date.now() } = {}) {
  const d = raw && typeof raw === "object" ? raw : {};
  const lines = {}, bumped = [];
  for (const l of PM_LINES) {
    const s = d.lines?.[l.id];
    if (s && typeof s === "object" && Number(s.version) === l.version) {
      lines[l.id] = { version: l.version, since_ms: finite(Number(s.since_ms)) ? Number(s.since_ms) : 0, off_since: finite(Number(s.off_since)) && s.off_since != null ? Number(s.off_since) : null,
        trip_mean_r: finite(Number(s.trip_mean_r)) && s.trip_mean_r != null ? Number(s.trip_mean_r) : null, closes: Math.max(0, Math.floor(Number(s.closes) || 0)), last: Array.isArray(s.last) ? s.last.filter((c) => c && typeof c === "object").slice(-PM_LINE_RULE.n) : [] };
    } else {
      if (s && typeof s === "object") bumped.push(l.id);
      lines[l.id] = freshLine(l, s ? now : 0);
    }
  }
  const seen = d.seen && typeof d.seen === "object" && !Array.isArray(d.seen) ? { ...d.seen } : {};
  const envOff = Array.isArray(d.env_off) ? d.env_off.filter(isPmLine) : [];
  return { doc: { version: PM_LINE_BREAKER_VERSION, updated_ms: finite(Number(d.updated_ms)) ? Number(d.updated_ms) : null, env_off: envOff, lines, seen }, bumped };
}

/** Pure: the lines the breaker holds off at their current version (registry order). */
export function breakerOff(doc) {
  return PM_LINE_IDS.filter((id) => { const s = doc?.lines?.[id]; return s && Number(s.version) === pmLine(id).version && s.off_since != null; });
}
/** Pure: the off lines in force: PM_LINES_OFF's and the breaker's (registry order). */
export function offLinesOf(doc, envOff = []) {
  const off = new Set([...(Array.isArray(envOff) ? envOff : []), ...breakerOff(doc)]);
  return PM_LINE_IDS.filter((id) => off.has(id));
}

let liveMemo = new WeakMap();
const LIVE_MEMO_MS = M1;
export function clearPmLineMemo() { liveMemo = new WeakMap(); }
/**
 * The off lines for a run ({ off: [ids] }): PM_LINES_OFF and the breaker's state (KV, read at most once a minute per
 * isolate). A missing or unreadable state reads as no breaker off: every line acts, as before B5.
 */
export async function readPmLinesLive(env, { now = Date.now() } = {}) {
  const envOff = pmLinesOffEnv(env);
  const kv = env?.SIGNAL_CACHE;
  let breaker = [];
  const m = kv && typeof kv === "object" ? liveMemo.get(kv) : null;
  if (m && now - m.at < LIVE_MEMO_MS) breaker = m.off;
  else {
    try { breaker = breakerOff(normalizeDoc(parse(await kv?.get?.(PM_LINE_BREAKER_KEY), null), { now }).doc); } catch { breaker = []; }
    if (kv && typeof kv === "object") liveMemo.set(kv, { at: now, off: breaker });
  }
  const off = new Set([...envOff, ...breaker]);
  return { off: PM_LINE_IDS.filter((id) => off.has(id)) };
}

/** Pure (v4): the off lines in force at `t` from the events' history ([{ at_ms, off }], any order); [] before the first. */
export function linesOffAt(history, t) {
  if (!Array.isArray(history) || !finite(t)) return [];
  let hit = null;
  for (const h of history) if (finite(h?.at_ms) && h.at_ms <= t && (!hit || h.at_ms >= hit.at_ms)) hit = h;
  return hit && Array.isArray(hit.off) ? PM_LINE_IDS.filter((id) => hit.off.includes(id)) : [];
}

/** The events' history for v4 ([{ at_ms, off }], oldest first; [] when none or unreadable). */
export async function readPmLineHistory(db, { limit = 2000 } = {}) {
  try {
    const rows = (await db.prepare(`SELECT ms, detail FROM omega_events WHERE action IN (${PM_LINE_EVENTS.map(() => "?").join(", ")}) ORDER BY ms, id LIMIT ?`).bind(...PM_LINE_EVENTS, limit).all()).results ?? [];
    return rows.map((r) => ({ at_ms: Number(r.ms), off: parse(r.detail, {})?.off })).filter((h) => finite(h.at_ms) && Array.isArray(h.off));
  } catch { return []; }
}

// ---------------------------------------------------------------- the close's R and its hold counterfactual

/** Pure: the money risked at the open's stop: its own risk_usd (probation), else r_dist / 0.01 x tickValue x volume. */
export function riskUsdOf(open, { tickValuePer001 = 1 } = {}) {
  const own = Number(open?.risk_usd);
  if (finite(own) && own > 0) return own;
  const rd = Number(open?.r_dist) > 0 ? Number(open.r_dist) : Math.abs(Number(open?.entry) - Number(open?.sl));
  const vol = Number(open?.volume);
  const risk = (rd / 0.01) * tickValuePer001 * vol;
  return finite(risk) && risk > 0 ? Math.round(risk * 100) / 100 : null;
}

/**
 * Pure: a close intent that is not done (pending, sent or expired; a failed one closed nothing) created within
 * PM_LINE_ACK_WINDOW_MS before the deal's close `closeMs`: the close may be its own, with the ack lost.
 */
export function unackedCloseBefore(intents = [], closeMs) {
  return (Array.isArray(intents) ? intents : []).some((i) => i?.kind === "close" && i.status !== "done" && i.status !== "failed"
    && finite(Number(i.created_ms)) && Number(i.created_ms) <= closeMs && closeMs - Number(i.created_ms) <= PM_LINE_ACK_WINDOW_MS);
}

/**
 * Pure: the close a line gets from a position's applied intents ([{ id, kind, created_ms }], status done) and its close
 * time: the final close's own intent when one sent it, else the last applied stop or target change before the close.
 * Returns { intent_id, at_ms, via: "close" | "change" } or null. The caller maps the intent to its stored action.
 */
export function closeCause(intents = [], closeMs = Infinity) {
  const list = (Array.isArray(intents) ? intents : []).filter((i) => typeof i?.id === "string" && finite(Number(i.created_ms)) && Number(i.created_ms) <= closeMs).sort((a, b) => Number(a.created_ms) - Number(b.created_ms));
  const close = list.filter((i) => i.kind === "close").at(-1);
  if (close) return { intent_id: close.id, at_ms: Number(close.created_ms), via: "close" };
  const change = list.filter((i) => i.kind === "modify_sl" || i.kind === "modify_tp" || i.kind === "modify_sltp").at(-1);
  return change ? { intent_id: change.id, at_ms: Number(change.created_ms), via: "change" } : null;
}

/**
 * Pure: the R of holding to the plan's stop and target from `fromMs` on. `bars` the broker's closed 1m bars in the exit
 * price ({ t, h, l, c }), `heldExit` the Position Manager report's rule (src/position-manager.mjs heldExitPrice).
 * { r, final }: final once the stop or the target was touched, or the horizon passed (marked at its last close).
 */
export function holdR({ side, entry, sl, tp, r_dist, fromMs, bars = [], now = Date.now(), horizonMs = HOLD_HORIZON_MS, heldExit }) {
  const dir = side === "BUY" ? 1 : -1;
  if (!finite(entry) || !(r_dist > 0) || typeof heldExit !== "function") return { r: null, final: true };
  const after = (Array.isArray(bars) ? bars : []).filter((b) => finite(b?.t) && b.t >= Math.floor(fromMs / M1) * M1 && b.t <= fromMs + horizonMs).map((b) => ({ high: b.h, low: b.l, close: b.c }));
  const touched = after.length ? heldExit(after, { dir, sl: finite(sl) && sl > 0 ? sl : null, tp: finite(tp) && tp > 0 ? tp : null }) : null;
  if (touched != null) return { r: r3((dir * (touched - entry)) / r_dist), final: true };
  const done = now >= fromMs + horizonMs;
  if (!done || !after.length) return { r: null, final: done && !after.length };
  return { r: r3((dir * (after.at(-1).close - entry)) / r_dist), final: true };
}

// ---------------------------------------------------------------- the tick

const EVENTS_SQL = "CREATE TABLE IF NOT EXISTS omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT)";
async function lineEvent(db, now, actor, action, detail) {
  try { await db.prepare(EVENTS_SQL).run(); await db.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, ?, ?, ?)").bind(now, String(actor || "system"), action, JSON.stringify(detail)).run(); } catch { /* best effort */ }
}

/** Pure: the Telegram line of a trip (R only, no price, no account). */
export function lineOffMessage(id, v) {
  const s = (x) => `${x > 0 ? "+" : ""}${x}R`;
  return `XAUUSD SYSTEM · Position Manager line ${id}@${pmLine(id)?.version ?? "?"} off: its last ${v.n} closes averaged ${s(v.mean_r)} (below ${PM_LINE_RULE.floor}R). The Position Manager no longer acts on it; it comes back with a new version or when the owner turns it on.`;
}

/**
 * The breaker's step, beside probationTick on the 5-minute ledger cron: the version bumps and PM_LINES_OFF changes
 * (each an event with the whole off set), the closes of positions a line acted on (R, r_vs_hold), the holds still open,
 * then the verdict per line (an off line: KV, one event, one Telegram line, once per trip). `send(text)` is the Omega
 * Telegram path. Returns { status: unavailable | unchanged | changed | failed, ... }. Never throws.
 */
export async function pmLineBreakerTick(env, { now = Date.now(), send = null } = {}) {
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db || !kv) return { status: "unavailable" };
  try {
    await ensurePositionSchema(db);
    const { heldExitPrice } = await import("./position-manager.mjs");
    const { fastBars } = await import("./pm-fast.mjs");
    const { corpusSource } = await import("./corpus-oracle.mjs");
    const { LIVE_TICK_VALUE_PER_001 } = await import("./ledger-omega4.mjs");
    const stored = parse(await kv.get(PM_LINE_BREAKER_KEY), null);
    const { doc, bumped } = normalizeDoc(stored, { now });
    let dirty = !stored || bumped.length > 0;
    const envOff = pmLinesOffEnv(env);
    for (const id of bumped) await lineEvent(db, now, PM_LINE_ACTOR, "pm_line_on", { line: id, version: pmLine(id).version, by: "version", off: offLinesOf(doc, envOff) });
    if (JSON.stringify(doc.env_off) !== JSON.stringify(envOff)) {
      doc.env_off = envOff;
      dirty = true;
      await lineEvent(db, now, PM_LINE_ACTOR, "pm_lines_env", { env_off: envOff, off: offLinesOf(doc, envOff) });
    }
    // Prune the settled tickets past the look-back (their actions are no longer read).
    for (const [t, ms] of Object.entries(doc.seen)) if (!(Number(ms) > now - PM_LINE_LOOKBACK_MS - 86_400_000)) { delete doc.seen[t]; dirty = true; }
    const rows = (await db.prepare("SELECT id, ticket, at_ms, lines_json FROM position_actions WHERE lines_json IS NOT NULL AND json_extract(lines_json, '$.cause') IS NOT NULL AND status = 'applied' AND action IN ('close', 'sl', 'tp') AND at_ms > ? ORDER BY at_ms LIMIT 1000").bind(now - PM_LINE_LOOKBACK_MS).all()).results ?? [];
    const exec = parse((await db.prepare("SELECT state FROM omega_bridge WHERE id = 1").first().catch(() => null))?.state, null);
    const open = new Set((Array.isArray(exec?.positions) ? exec.positions : []).map((p) => Number(p?.ticket)));
    const identity = typeof exec?.account_ref === "string" && exec.account_ref && Number.isInteger(exec?.symbol?.digits) && String(exec?.server ?? "").trim() && String(exec?.symbol?.name ?? "").trim()
      ? { ref: exec.account_ref, source: corpusSource(exec.server, exec.symbol.name), digits: exec.symbol.digits, point: Number(exec.symbol.point) > 0 ? Number(exec.symbol.point) : 0.01 } : null;
    const barsFor = async (side, fromMs) => {
      if (!identity) return [];
      const to = Math.min(now, fromMs + HOLD_HORIZON_MS);
      const list = (await db.prepare("SELECT minute_ms AS t, o, h, l, c, spread_points AS s FROM broker_bars_1m WHERE account_ref = ? AND source = ? AND digits = ? AND minute_ms >= ? AND minute_ms <= ? ORDER BY minute_ms LIMIT 1500")
        .bind(identity.ref, identity.source, identity.digits, Math.floor(fromMs / M1) * M1, to - M1).all().catch(() => ({ results: [] }))).results ?? [];
      return fastBars(list.map((b) => ({ t: Number(b.t), o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c), s: b.s == null ? null : Number(b.s) })), { side, point: identity.point });
    };
    const holdOf = async (c) => holdR({ side: c.side, entry: c.entry, sl: c.plan_sl, tp: c.plan_tp, r_dist: c.r_dist, fromMs: c.action_ms, bars: await barsFor(c.side, c.action_ms), now, heldExit: heldExitPrice });
    const tickets = [...new Set(rows.map((r) => Number(r.ticket)).filter((t) => t > 0 && doc.seen[String(t)] == null && !open.has(t)))].slice(0, TICKETS_PER_RUN);
    const counted = [];
    for (const ticket of tickets) {
      const deal = await db.prepare(`SELECT COUNT(*) AS n, SUM(${DEAL_NET_SQL}) AS net, SUM(volume) AS vol, MAX(closed_ms) AS closed_ms, MIN(entry_price) AS lo, MAX(entry_price) AS hi FROM ea_deals WHERE position_ticket = ?`).bind(ticket).first().catch(() => null);
      if (!(Number(deal?.n) > 0)) continue;
      const openRow = await db.prepare("SELECT payload FROM omega_intents WHERE kind IN ('open', 'place_limit') AND json_extract(result, '$.ticket') = ? ORDER BY created_ms DESC LIMIT 1").bind(ticket).first().catch(() => null);
      const it = parse(openRow?.payload, null);
      if (it && Number(it.volume) > 0 && Number(deal.vol) + 1e-9 < Number(it.volume)) continue; // a partial exit: still open
      const closeMs = Number(deal.closed_ms);
      const all = (await db.prepare("SELECT id, kind, status, created_ms FROM omega_intents WHERE json_extract(payload, '$.ticket') = ? AND kind IN ('close', 'modify_sl', 'modify_tp', 'modify_sltp') ORDER BY created_ms").bind(ticket).all().catch(() => ({ results: [] }))).results ?? [];
      // A close whose ack was lost (pending or expired, not failed) right before the deal: wait for it to read done rather
      // than credit the position's last stop or target change, and leave the ticket unseen so a later tick credits it.
      if (finite(closeMs) && now - closeMs < PM_LINE_DEFER_MS && unackedCloseBefore(all, closeMs)) continue;
      doc.seen[String(ticket)] = finite(closeMs) ? closeMs : now;
      dirty = true;
      const intents = all.filter((i) => i.status === "done");
      const cause = closeCause(intents, finite(closeMs) ? closeMs : Infinity);
      const actionId = cause ? actionIdOfIntent(cause.intent_id) : null;
      if (!actionId) continue;
      const act = rows.find((r) => r.id === actionId) ?? (await db.prepare("SELECT id, ticket, at_ms, lines_json FROM position_actions WHERE id = ?").bind(actionId).first().catch(() => null));
      const tag = parseTag(parse(act?.lines_json, null)?.cause);
      const line = tag ? doc.lines[tag.id] : null;
      if (!line || tag.version !== pmLine(tag.id).version || Number(act.at_ms) < line.since_ms) continue;
      const risk = riskUsdOf(it, { tickValuePer001: LIVE_TICK_VALUE_PER_001 });
      const r = risk ? r3(Number(deal.net) / risk) : null;
      if (r == null) continue;
      const side = it?.side === "SELL" ? "SELL" : "BUY";
      const entry = Number(deal.lo) > 0 && Number(deal.hi) === Number(deal.lo) ? Number(deal.lo) : Number(it?.entry);
      const rd = Number(it?.r_dist) > 0 ? Number(it.r_dist) : Math.abs(Number(it?.entry) - Number(it?.sl));
      const c = { ticket, r, close_ms: finite(closeMs) ? closeMs : now, action_ms: cause.at_ms, via: cause.via, side, entry, plan_sl: Number(it?.sl) || null, plan_tp: Number(it?.tp) || null, r_dist: rd > 0 ? rd : null, r_hold: null, hold_final: false };
      const h = await holdOf(c);
      c.r_hold = h.r; c.hold_final = h.final;
      line.closes += 1;
      line.last = [...line.last, c].slice(-PM_LINE_RULE.n);
      counted.push({ line: tag.id, ticket, r });
    }
    // The holds still open (each line's window only): looked at again until the stop or target is touched or the horizon passes.
    for (const id of PM_LINE_IDS) {
      for (const c of doc.lines[id].last) {
        if (c.hold_final === true) continue;
        const h = await holdOf(c);
        if (h.final || h.r !== c.r_hold) { c.r_hold = h.r; c.hold_final = h.final; dirty = true; }
      }
    }
    // The verdict per line: a trip is logged once (the line stays off until a version bump or the owner).
    const tripped = [];
    for (const id of PM_LINE_IDS) {
      const s = doc.lines[id];
      if (s.off_since != null) continue;
      const v = lineBreakerVerdict(s.last);
      if (!v.trip) continue;
      s.off_since = now; s.trip_mean_r = v.mean_r;
      dirty = true;
      tripped.push({ id, ...v });
    }
    if (counted.length) dirty = true;
    if (dirty) { doc.updated_ms = now; await kv.put(PM_LINE_BREAKER_KEY, JSON.stringify(doc)); clearPmLineMemo(); }
    for (const t of tripped) {
      await lineEvent(db, now, PM_LINE_ACTOR, "pm_line_off", { line: t.id, version: pmLine(t.id).version, closes: t.n, mean_r: t.mean_r, off: offLinesOf(doc, envOff) });
      console.log("pm_line_off", JSON.stringify({ line: t.id, mean_r: t.mean_r }));
      if (typeof send === "function") { try { await send(lineOffMessage(t.id, t)); } catch { /* best effort */ } }
    }
    if (!tripped.length && !counted.length && !bumped.length && !dirty) return { status: "unchanged" };
    return { status: tripped.length ? "changed" : "unchanged", counted, tripped: tripped.map((t) => t.id), bumped };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * The owner turns a line back on (POST /api/pm-lines; the Omega Worker checked OWNER_ACCESS_SUB, the origin and the
 * body). Turning a line on is the only action: `enabled` must be true. The line must be in PM_LINES; one PM_LINES_OFF
 * names stays off (the variable is the hand switch). Opens a fresh window. Returns { ok } | { ok: false, error }.
 */
export async function setPmLine(env, { line, enabled, actor = "owner", send = null } = {}, { now = Date.now() } = {}) {
  if (enabled !== true) return { ok: false, error: "enabled must be true (turning a line on is the only action)" };
  if (!isPmLine(line)) return { ok: false, error: "unknown_line" };
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db || !kv) return { ok: false, error: "unavailable" };
  const envOff = pmLinesOffEnv(env);
  if (envOff.includes(line)) return { ok: false, error: "off_by_PM_LINES_OFF" };
  try {
    const { doc } = normalizeDoc(parse(await kv.get(PM_LINE_BREAKER_KEY), null), { now });
    const was = doc.lines[line];
    doc.lines[line] = freshLine(pmLine(line), now);
    doc.updated_ms = now;
    await kv.put(PM_LINE_BREAKER_KEY, JSON.stringify(doc));
    clearPmLineMemo();
    await lineEvent(db, now, actor, "pm_line_on", { line, version: pmLine(line).version, by: "owner", was_off: was?.off_since != null, off: offLinesOf(doc, envOff) });
    if (typeof send === "function") { try { await send(`XAUUSD SYSTEM · Position Manager line ${lineTag(line)} on (owner): a fresh window of ${PM_LINE_RULE.n} closes starts now.`); } catch { /* best effort */ } }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 160) };
  }
}

/**
 * Pure: the lines as GET /api/omega/position-manager shows them (the frontend's C5 shape exactly): [{ id, version,
 * enabled, off_since, closes, mean_r_last15, r_vs_hold }] in registry order. `doc` the stored state (normalized),
 * `envOff` PM_LINES_OFF's lines. mean_r_last15 over the window's last 15 closes; r_vs_hold the mean of R minus the hold
 * R over those whose hold is settled; null without any.
 */
export function pmLinesView(doc, envOff = []) {
  const off = new Set(offLinesOf(doc, envOff));
  return PM_LINES.map((l) => {
    const s = doc?.lines?.[l.id] ?? freshLine(l, 0);
    const last = (Array.isArray(s.last) ? s.last : []).slice(-PM_LINE_RULE.n);
    const v = lineBreakerVerdict(last);
    const settled = last.filter((c) => c.hold_final === true && finite(Number(c.r)) && finite(c.r_hold));
    return {
      id: l.id, version: l.version, enabled: !off.has(l.id), off_since: s.off_since ?? null, closes: Math.max(0, Math.floor(Number(s.closes) || 0)),
      mean_r_last15: v.n ? v.mean_r : null, r_vs_hold: settled.length ? r3(settled.reduce((a, c) => a + (Number(c.r) - c.r_hold), 0) / settled.length) : null
    };
  });
}

/** The lines for the read route (KV and PM_LINES_OFF); every line fresh when the state cannot be read. Never throws. */
export async function readPmLines(env, { now = Date.now() } = {}) {
  let raw = null;
  try { raw = parse(await env?.SIGNAL_CACHE?.get?.(PM_LINE_BREAKER_KEY), null); } catch { raw = null; }
  return pmLinesView(normalizeDoc(raw, { now }).doc, pmLinesOffEnv(env));
}
