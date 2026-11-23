// RE1, a 1m re-entry after a profit-lock stop (owner decision 2026-11-23, relayed by the orchestrator, verbatim:
// "Live: gerbang + re-entry (Rekomendasi)"; SLG1, the gate, went first). When an Omega position is stopped out by a
// stop that locked its entry or a profit (break-even, the ladder's lock, the key-level SL+, the Position Manager's or
// the 1m layer's lock) and price turns back its way, the setup may be entered once more: a NEW position, an open like
// any other, planned by planIntents through every opening check (the engine switch, kill and pause, the live arm, the
// symbol and money checks, tick_value_mismatch, the spread, the rollover, the news blackout, max_positions and the
// platform's cap, the daily loss limit and budget, the profile's caps, the minimum lot) and the same-side cooldown of
// reentryGate. Evaluated once per newly closed broker minute by Omega's bridge sync (no cron of its own;
// src/omega-broker.mjs bridgeSync calls runReentry) on the closed broker M1 bars PM-1M reads (src/pm-fast.mjs:
// the same stream, identity, freshness, ATR1m and quarantine helpers), and replayed the same way by v4 on its 1m bars.
//
// The setup is the latest exit of an Omega position (reentrySetup):
//   eligible   the broker's stop hit (deal reason "sl"; v4 "sl_plus") of an original Omega entry (an "open:" intent, never
//              a re-entry's own exit, never a delegated position), whose last applied stop sat at or beyond the entry and
//              was set by a profit-lock rule (REENTRY_LOCK_PATTERN: break_even, ladder_lock_tp<n>, sl_key_level_<band>,
//              pm_breakeven, pm_tp2_breakeven, pm_lock_tp1, pm_fast_tp);
//   never      the initial stop, a stop in loss (trail_5m, pm_fast_cut, a loosening), a close by Omega (cut_loss,
//              take_profit_weakening and every other close): those keep reentryGate, unchanged.
// Valid while all hold (reentryCheck): the latest decision is on the same side (the signal's side); the original stop
// has not been touched and TP1 has not been reached since the exit (the bars after the exit's minute, on the exit
// price's bars: a BUY's bid, a SELL's ask); within the plan's validity, REENTRY_1M.window_min (240) minutes from the plan's issue (the decisions carry no
// valid_until); no re-entry of this setup yet (at most one) and no other Omega entry since the exit.
// Trigger: the latest closed 1m bar, at least 5 bars after the exit's bar, closes back beyond the lock level.
// Stop: the pullback's extreme since the exit plus max(2 x spread, 0.1 x ATR1m(14)); skipped when its distance is wider
// than the original stop's. Target: the original TP1, which must pay at least 1R (TP1-KZ's TP1_MIN_R) at that stop.
// Risk: at most min(the profile's cap, the original trade's money risk) and, with the original's loss, at most 1.0R of
// the original over the setup (planIntents sizes within max_risk; the profile's caps, the budget and the minimum lot
// as for every entry).
// Blocked: the rollover 21:55-22:15 UTC, the reopen 23:00-23:15 UTC and the first 15 minutes after any daily or weekly
// reopen (fastNoise with reopen_min 15), the market paused, a stale stream or the warm-up, the live spread above 60
// points or above 2 x the median bar spread of the last 60 minutes, the high-impact release window (the signal's
// blackout, also an entry gate of the plan).
// Records: position_actions id re:<ticket>:<bar minute> (the original's ticket, the trigger bar's open in minutes),
// rule pm_reentry, action open, status applied when the plan made the intent, skipped (with the plan's reason) when it
// did not, noted for a trigger blocked or skipped here (once per setup and reason). Omega's open intent has the same id;
// one Telegram line when the broker answers it.
// Switch: the Omega setting `reentry_1m`, "on" (default) | "off"; "off" is today's engine byte for byte. The owner's
// switch only (Aether's policy and its rollback never write it); it is in ERA_SWITCHES. No environment variable.

import { fastBars, atr1m, fastNoise, PM_FAST_1M } from "./pm-fast.mjs";
import { ensureLiquiditySchema } from "./liquidity-lens.mjs";
import { ensurePositionSchema } from "./position-actions.mjs";
import { corpusSource } from "./corpus-oracle.mjs";
import { DEAL_NET_SQL } from "./gold-symbol.mjs";

export const REENTRY_MODES = Object.freeze(["on", "off"]);
export const REENTRY_RULE = "pm_reentry";
/** Every threshold of the re-entry in one table. Minutes, R of the original stop, points. */
export const REENTRY_1M = Object.freeze({
  min_bars: 5, window_min: 240, stop_spread_k: 2, stop_atr_k: 0.1, min_r: 1, max_spread_points: 60, spread_median_k: 2, median_min: 60, median_min_bars: 10,
  reopen_min: 15, per_setup: 1, loss_cap_r: 1.0, atr_period: 14
});
/** The stop rules that lock the entry or a profit (the last applied stop before a stop-out must be one, at or beyond the entry). */
export const REENTRY_LOCK_PATTERN = "^(break_even|ladder_lock_tp\\d+|sl_key_level_[a-z_]+|pm_breakeven|pm_tp2_breakeven|pm_lock_tp1|pm_fast_tp)$";
const LOCK_RE = new RegExp(REENTRY_LOCK_PATTERN);
/** Pure: whether a stop's rule (its intent's reason) is a profit-lock rule. */
export const isLockRule = (rule) => typeof rule === "string" && LOCK_RE.test(rule);
/** The bars the live step reads back: the window, the warm-up and the median fit inside. */
export const REENTRY_READ_MIN = REENTRY_1M.window_min + 30;
const M1 = 60_000;
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const positive = (v) => finite(v) && v > 0;
const roundTo = (v, digits) => Number(v.toFixed(Math.max(0, Math.min(10, digits))));
const r2 = (v) => Math.round(v * 100) / 100;
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

/** Pure: whether the re-entry runs in these settings (anything but "off", the default "on" included). */
export function reentryOn(settings) {
  return settings?.reentry_1m !== "off";
}
/** Pure: the record and intent id of a re-entry: re:<the original's ticket>:<the trigger bar's open in minutes>. */
export const reentryId = (ticket, barMs) => `re:${ticket}:${Math.floor(barMs / M1)}`;
/** Pure: whether an id is a re-entry's (an attempt suffix allowed). */
export const isReentryId = (id) => /^re:\d+:\d+(:\d+)?$/.test(String(id ?? ""));
/** Pure: whether an intent id is one of Omega's own entries (an original "open:" or a re-entry). */
export const isEntryIntentId = (id) => typeof id === "string" && (id.startsWith("open:") || isReentryId(id));

/**
 * Pure: the setup an exit leaves, or { eligible: false, code, why }. Inputs: the position's ticket, side, open price
 * and intent id; `stopHit` the broker's stop closed it; `stop`/`stopRule` its last applied stop and the rule that set
 * it; the exit's time and price; `open` the original open intent's payload (entry, sl, tp, r_dist, volume, mode,
 * signal_issued_ms, strategy); `realized` the position's net result in account money; `moneyPerPriceLot` the money one
 * lot makes per 1.00 of price (tick value / tick size).
 */
export function reentrySetup({ ticket, side, intentId, entry, stopHit = false, stop = null, stopRule = null, exitMs, exitPrice = null, open = {}, realized = 0, moneyPerPriceLot = null } = {}) {
  const no = (code, why) => ({ eligible: false, code, why });
  if (!(Number(ticket) > 0) || (side !== "BUY" && side !== "SELL") || !finite(exitMs)) return no("no_exit", "no exit to re-enter");
  if (typeof intentId !== "string" || !intentId.startsWith("open:")) return no("not_original", "not an original Omega entry (a re-entry's own exit, or not Omega's)");
  if (stopHit !== true) return no("not_stop", "not closed by the broker's stop");
  const dir = side === "BUY" ? 1 : -1, px = Number(entry), sl = Number(stop);
  if (!finite(px) || !positive(sl) || !isLockRule(stopRule) || dir * (sl - px) < -1e-9) return no("not_lock", `the stop it hit was not a profit-lock stop (${stopRule ?? "the initial stop"})`);
  const oEntry = Number(open?.entry), oSl = Number(open?.sl), tp1 = Number(open?.tp), vol = Number(open?.volume);
  const rDist = positive(Number(open?.r_dist)) ? Number(open.r_dist) : finite(oEntry) && positive(oSl) ? Math.abs(oEntry - oSl) : null;
  if (!positive(oSl) || !positive(tp1) || !positive(rDist) || !positive(vol) || !positive(moneyPerPriceLot)) return no("no_plan", "the original entry's stop, target, distance or size is unknown");
  return {
    eligible: true,
    setup: {
      ticket: Number(ticket), side, entry: px, lock: sl, lock_rule: stopRule, exit_ms: exitMs, exit_price: finite(Number(exitPrice)) ? Number(exitPrice) : null,
      orig_sl: oSl, tp1, r_dist: rDist, mode: typeof open?.mode === "string" ? open.mode : null, issued_ms: finite(Number(open?.signal_issued_ms)) ? Number(open.signal_issued_ms) : null,
      strategy: typeof open?.strategy === "string" && open.strategy ? open.strategy : null, risk_money: r2(rDist * vol * moneyPerPriceLot), realized: finite(Number(realized)) ? r2(Number(realized)) : 0
    }
  };
}

/** Pure: the median of finite values, or null. */
function median(xs) {
  const s = xs.filter(finite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Pure: the re-entry's call at `now`. Inputs: `setup` (reentrySetup's), `signal` (the latest decision as the EA signal),
 * `bars` closed broker M1 bars on the bid, oldest first ({ t, o, h, l, c, s: spread points, r: received ms }), `sym`
 * { point, digits, spread_points } (the live spread), `used` a re-entry of this setup exists, `superseded` another Omega
 * entry since the exit. Returns { status, code, why } with status "none" (no setup), "invalid" (the setup no longer
 * holds), "inert" (noise), "wait" (no trigger yet), "blocked" or "skip" (a trigger this minute that may not enter), or
 * "trigger": { id, side, ticket, sl, tp, lock, lock_rule, extreme, atr, spread_points, entry, max_risk, max_stop_dist, mode,
 * issued_ms, strategy, bar_ms, why }.
 */
export function reentryCheck({ setup = null, signal = null, bars = [], now, sym = {}, used = false, superseded = false, knobs = REENTRY_1M } = {}) {
  if (!setup) return { status: "none", code: "no_setup", why: "no profit-lock exit to re-enter" };
  const s = setup, buy = s.side === "BUY", dir = buy ? 1 : -1;
  const out = (status, code, why) => ({ status, code, why, ticket: s.ticket, side: s.side });
  const from = finite(s.issued_ms) ? s.issued_ms : s.exit_ms;
  if (!(now <= from + knobs.window_min * M1)) return out("invalid", "window", `past the plan's ${knobs.window_min} minutes (issued ${hhmm(from)} UTC)`);
  if (used) return out("invalid", "used", `this setup was re-entered already (at most ${knobs.per_setup})`);
  if (superseded) return out("invalid", "superseded", "another Omega entry since the exit");
  if (signal?.side !== s.side) return out("invalid", "decision_side", `the latest decision is not ${s.side} (${signal?.side || "none"})`);
  const point = positive(sym.point) ? sym.point : 0.01, digits = Number.isInteger(sym.digits) ? sym.digits : 2;
  const closed = (Array.isArray(bars) ? bars : []).filter((b) => [b?.t, b?.o, b?.h, b?.l, b?.c].every(finite) && b.t + M1 <= now).sort((a, b) => a.t - b.t);
  const noise = fastNoise(closed, { now, knobs: { ...PM_FAST_1M.intraday, reopen_min: knobs.reopen_min } });
  if (noise) return out("inert", noise.code, noise.text);
  const xb = fastBars(closed, { side: s.side, point, spreadPoints: sym.spread_points });
  const exitBar = Math.floor(s.exit_ms / M1) * M1;
  const since = xb.filter((b) => b.t >= exitBar);
  if (!since.length) return out("wait", "no_bars", "no closed bar since the exit");
  // Since the exit (the bars after the exit's own minute, whose range came partly before it), on the exit price's bars:
  // the original stop untouched, TP1 not reached.
  const after = since.filter((b) => b.t > exitBar);
  if (after.some((b) => dir * ((buy ? b.l : b.h) - s.orig_sl) <= 0)) return out("invalid", "stop_touched", `the original stop ${s.orig_sl} was touched since the exit`);
  if (after.some((b) => dir * ((buy ? b.h : b.l) - s.tp1) >= 0)) return out("invalid", "tp1_reached", `TP1 ${s.tp1} was reached since the exit`);
  const last = xb.at(-1);
  if (last.t < exitBar + knobs.min_bars * M1) return out("wait", "too_soon", `${Math.max(0, (last.t - exitBar) / M1)} of ${knobs.min_bars} bars after the exit (${hhmm(s.exit_ms)} UTC)`);
  if (!(dir * (last.c - s.lock) > 0)) return out("wait", "no_trigger", `the bar ${hhmm(last.t)} UTC closed at ${last.c} (its ${buy ? "bid" : "ask"}), not back beyond the lock ${s.lock}`);
  const fired = `1m re-entry: the bar ${hhmm(last.t)} UTC closed at ${last.c} (its ${buy ? "bid" : "ask"}), back beyond the ${s.lock_rule} stop ${s.lock} ${Math.round((last.t - exitBar) / M1)} bars after the exit (${hhmm(s.exit_ms)} UTC)`;
  const atr = atr1m(xb, xb.length - 1, knobs.atr_period);
  if (!positive(atr)) return out("inert", "no_atr", "ATR1m cannot be measured");
  // Blocked: the live spread (absolute and against the last hour's median bar spread), the high-impact release window.
  const lastRaw = closed.at(-1);
  const spread = finite(sym.spread_points) && sym.spread_points >= 0 ? sym.spread_points : finite(lastRaw.s) && lastRaw.s >= 0 ? lastRaw.s : null;
  if (spread == null) return out("blocked", "spread_unknown", `${fired}; blocked: the spread is unknown`);
  if (spread > knobs.max_spread_points) return out("blocked", "spread", `${fired}; blocked: the spread ${spread} points is above ${knobs.max_spread_points}`);
  const hour = closed.filter((b) => b.t >= now - knobs.median_min * M1 && finite(b.s) && b.s >= 0).map((b) => b.s);
  const med = hour.length >= knobs.median_min_bars ? median(hour) : null;
  if (med == null) return out("blocked", "spread_unmeasured", `${fired}; blocked: the ${knobs.median_min}-minute median spread cannot be measured (${hour.length} bars)`);
  if (spread > knobs.spread_median_k * med) return out("blocked", "spread_spike", `${fired}; blocked: the spread ${spread} points is above ${knobs.spread_median_k} x the ${knobs.median_min}-minute median (${med})`);
  if (signal?.blackout === true) return out("blocked", "release_window", `${fired}; blocked: the high-impact release window${signal.blackout_reason ? ` (${signal.blackout_reason})` : ""}`);
  // The stop beyond the pullback's extreme since the exit; the target the original TP1, at least 1R at that stop.
  const spreadPx = spread * point;
  const extreme = buy ? Math.min(...since.map((b) => b.l)) : Math.max(...since.map((b) => b.h));
  const buf = Math.max(knobs.stop_spread_k * spreadPx, knobs.stop_atr_k * atr);
  const sl = roundTo(extreme - dir * buf, digits);
  const entry = roundTo(buy ? lastRaw.c + spreadPx : lastRaw.c, digits);
  const sd = dir * (entry - sl), td = dir * (s.tp1 - entry);
  const geo = `entry about ${entry}, stop ${sl} (the pullback's extreme ${r2(extreme)} plus max(${knobs.stop_spread_k} x spread, ${knobs.stop_atr_k} x ATR1m(14) ${r2(atr)})), TP1 ${s.tp1}`;
  if (!(sd > 0) || sd > s.r_dist + point / 2) return out("skip", "stop_wide", `${fired}; skipped: ${geo}: the stop distance ${r2(sd)} is wider than the original ${r2(s.r_dist)}`);
  if (!(td + 1e-9 >= knobs.min_r * sd)) return out("skip", "reward", `${fired}; skipped: ${geo}: TP1 pays ${r2(td / sd)}R, under ${knobs.min_r}R (TP1-KZ)`);
  const lost = Math.max(0, -(finite(s.realized) ? s.realized : 0));
  const maxRisk = r2(Math.min(s.risk_money, knobs.loss_cap_r * s.risk_money - lost));
  if (!(maxRisk > 0)) return out("skip", "setup_loss_cap", `${fired}; skipped: the original lost ${r2(lost)}, the setup's cap is ${knobs.loss_cap_r}R (${s.risk_money})`);
  return {
    status: "trigger", code: "trigger", id: reentryId(s.ticket, last.t), side: s.side, ticket: s.ticket, sl, tp: s.tp1, lock: s.lock, lock_rule: s.lock_rule, extreme: r2(extreme), atr: r2(atr), spread_points: spread,
    entry, max_risk: maxRisk, max_stop_dist: s.r_dist, mode: s.mode, issued_ms: s.issued_ms, strategy: s.strategy, bar_ms: last.t,
    why: `${fired}: ${geo}, ${r2(td / sd)}R; money risk at most ${maxRisk} (the original's ${s.risk_money}${lost ? `, less its loss ${r2(lost)}` : ""})`
  };
}

// ---------------------------------------------------------------- the live step (Omega's bridge sync)

/** The live step's memo per D1 binding: the minute evaluated, its trigger, and when to look again for a bar not yet in. */
const MEMO = new WeakMap();
export const REENTRY_RETRY_MS = 5_000;

/**
 * The latest exit of an Omega position as a setup, from what the sync recorded: the newest exit deal in the window
 * whose position is no longer open, its open intent, the last stop Omega applied to it (a done modify_sl or
 * modify_sltp), its net result; with whether a re-entry of it exists and whether another entry came after it. Null
 * when there is none; { setup: null, why } when the latest exit is not eligible. Never throws.
 */
export async function liveSetup(db, executor, now) {
  const ref = typeof executor?.account_ref === "string" && executor.account_ref ? executor.account_ref : null;
  if (!ref) return null;
  const openTickets = new Set((Array.isArray(executor?.positions) ? executor.positions : []).map((p) => Number(p?.ticket)));
  const deals = (await db.prepare("SELECT position_ticket, side, entry_price, exit_price, reason, closed_ms FROM ea_deals WHERE source = 'omega' AND account_ref = ? AND closed_ms > ? ORDER BY closed_ms DESC LIMIT 20").bind(ref, now - REENTRY_1M.window_min * M1).all()).results ?? [];
  const d = deals.find((x) => Number(x.position_ticket) > 0 && !openTickets.has(Number(x.position_ticket)));
  if (!d) return null;
  const ticket = Number(d.position_ticket);
  const openRow = await db.prepare("SELECT id, payload FROM omega_intents WHERE kind IN ('open', 'place_limit') AND json_extract(result, '$.ticket') = ? ORDER BY created_ms DESC LIMIT 1").bind(ticket).first();
  const open = parseJson(openRow?.payload, {});
  const stopRow = await db.prepare("SELECT payload FROM omega_intents WHERE kind IN ('modify_sl', 'modify_sltp') AND status = 'done' AND json_extract(payload, '$.ticket') = ? ORDER BY updated_ms DESC, created_ms DESC LIMIT 1").bind(ticket).first();
  const stop = parseJson(stopRow?.payload, {});
  const net = await db.prepare(`SELECT SUM(${DEAL_NET_SQL}) AS net FROM ea_deals WHERE position_ticket = ?`).bind(ticket).first();
  const sym = executor?.symbol ?? {};
  const mpl = positive(Number(sym.tick_value)) && positive(Number(sym.tick_size)) ? Number(sym.tick_value) / Number(sym.tick_size) : null;
  const side = d.side === "BUY" || d.side === "SELL" ? d.side : open.side;
  const r = reentrySetup({ ticket, side, intentId: openRow?.id ?? null, entry: Number(d.entry_price) > 0 ? Number(d.entry_price) : Number(open.entry), stopHit: String(d.reason ?? "").toLowerCase() === "sl",
    stop: Number(stop.sl), stopRule: typeof stop.reason === "string" ? stop.reason : null, exitMs: Number(d.closed_ms), exitPrice: Number(d.exit_price), open, realized: Number(net?.net), moneyPerPriceLot: mpl });
  if (!r.eligible) return { setup: null, code: r.code, why: r.why, ticket };
  const used = await db.prepare("SELECT id FROM omega_intents WHERE id LIKE ? AND status <> 'failed' LIMIT 1").bind(`re:${ticket}:%`).first();
  const later = await db.prepare("SELECT id FROM omega_intents WHERE kind IN ('open', 'place_limit') AND created_ms > ? AND id NOT LIKE 're:%' AND status <> 'failed' LIMIT 1").bind(r.setup.exit_ms).first();
  return { setup: r.setup, used: Boolean(used), superseded: Boolean(later) };
}

/**
 * The re-entry step in Omega's bridge sync, before the plan: once per newly closed broker minute per isolate, the
 * latest setup checked on the stream's bars (the identity, freshness and quarantines of PM-1M). Returns the trigger to
 * hand to planIntents (`reentry1m`) for every sync of that minute, or null. A trigger blocked or skipped here is
 * recorded once per setup and reason (noted). Never throws.
 */
export async function runReentry(env, { executor, signal = null, now = Date.now() } = {}) {
  const db = env?.DB;
  if (!db) return null;
  const want = Math.floor(now / M1) * M1 - M1;
  const memo = MEMO.get(db);
  if (memo && memo.minute === want) return memo.cand;
  if (memo && now < memo.retry) return null;
  try {
    const ref = typeof executor?.account_ref === "string" && executor.account_ref ? executor.account_ref : null;
    const digits = Number.isInteger(executor?.symbol?.digits) ? executor.symbol.digits : null;
    const server = String(executor?.server ?? "").trim(), symbol = String(executor?.symbol?.name ?? "").trim();
    if (!ref || digits == null || !server || !symbol) { MEMO.set(db, { minute: want, cand: null, retry: 0 }); return null; }
    const found = await liveSetup(db, executor, now);
    if (!found?.setup) { MEMO.set(db, { minute: want, cand: null, retry: 0 }); return null; }
    await ensureLiquiditySchema(db);
    const fromMs = Math.min(Math.floor(found.setup.exit_ms / M1) * M1, want - REENTRY_1M.median_min * M1) - 25 * M1;
    const rows = (await db.prepare("SELECT minute_ms AS t, o, h, l, c, spread_points AS s, received_ms AS r FROM broker_bars_1m WHERE account_ref = ? AND source = ? AND digits = ? AND minute_ms >= ? AND minute_ms <= ? ORDER BY minute_ms")
      .bind(ref, corpusSource(server, symbol), digits, Math.max(fromMs, want - REENTRY_READ_MIN * M1), want).all()).results ?? [];
    const bars = rows.map((r) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), s: r.s == null ? null : Number(r.s), r: r.r == null ? null : Number(r.r) }));
    if (!bars.length || bars.at(-1).t !== want) {
      // The minute's bar is not in yet: look again shortly (a stream that stays away leaves the step inert).
      MEMO.set(db, { minute: memo?.minute ?? null, cand: null, retry: now + REENTRY_RETRY_MS });
      return null;
    }
    const c = reentryCheck({ setup: found.setup, signal, bars, now, sym: executor.symbol ?? {}, used: found.used, superseded: found.superseded });
    const cand = c.status === "trigger" ? { ...c, setup: found.setup } : null;
    MEMO.set(db, { minute: want, cand, retry: 0 });
    if (c.status === "blocked" || c.status === "skip") await recordReentry(db, { cand: { ...c, id: reentryId(found.setup.ticket, want), bar_ms: want, sl: null, tp: null, entry: null }, setup: found.setup, status: "noted", now, once: c.code });
    return cand;
  } catch {
    MEMO.set(db, { minute: want, cand: null, retry: 0 });
    return null;
  }
}

/**
 * One re-entry record in position_actions (never pending, so the Position Manager's step never reads it): `status`
 * applied (the plan made the open intent), skipped (it did not: the plan's reason in the why) or noted (blocked or
 * skipped before the plan). An applied one replaces a skipped one of the same id; `once` records a noted reason once
 * per setup. Never throws.
 */
export async function recordReentry(db, { cand, setup = null, status, reason = null, now = Date.now(), once = null } = {}) {
  try {
    await ensurePositionSchema(db);
    if (once) {
      const prior = (await db.prepare("SELECT why FROM position_actions WHERE id LIKE ? AND rule = ?").bind(`re:${cand.ticket}:%`, REENTRY_RULE).all()).results ?? [];
      if (prior.some((r) => String(r.why ?? "").startsWith(`[${once}] `))) return;
    }
    const why = `${once ? `[${once}] ` : ""}${cand.why}${reason ? `; not entered: ${reason}` : ""}`.slice(0, 900);
    const bind = [cand.id, cand.ticket, Math.floor(cand.bar_ms / M1), now, cand.side, null, finite(cand.entry) ? cand.entry : null, "open", REENTRY_RULE, finite(cand.sl) ? cand.sl : null, finite(cand.tp) ? cand.tp : null, why, null, setup?.orig_sl ?? null, setup?.tp1 ?? null, null, status];
    await db.prepare("INSERT OR IGNORE INTO position_actions (id, ticket, bar, at_ms, side, pips, price, action, rule, sl, tp, why, council, orig_sl, orig_tp, basis, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(...bind).run();
    if (status === "applied") await db.prepare("UPDATE position_actions SET status = 'applied', why = ?, sl = ?, tp = ?, price = ? WHERE id = ?").bind(why, bind[9], bind[10], bind[6], cand.id).run();
  } catch { /* the plan stands; the record is lost */ }
}

/** Pure: the one Telegram line of a re-entry when the broker answers its open intent (plain text; no account number). */
export function reentryMessage({ ticket, side, volume = null, entry = null, fill = null, sl = null, tp = null, lock = null, lockRule = null, newTicket = null }, outcome = { applied: true }) {
  const at = fill ?? entry;
  const what = `re-entered ${volume != null ? `${volume} lot ` : ""}${at != null ? `at ${at}` : ""}${newTicket ? ` (#${newTicket})` : ""}, stop ${sl ?? "—"}, target ${tp ?? "—"} (TP1)${lock != null ? `, after the ${lockRule ? `${String(lockRule).replace(/_/g, " ")} ` : ""}stop at ${lock}` : ""}`;
  return `XAUUSD RE-ENTRY · #${ticket} ${side} · ${what} · ${outcome?.applied === true ? "applied at the broker" : `NOT applied: ${outcome?.reason || "unknown"}`}`;
}

const parseJson = (t, fallback = null) => { if (t == null) return fallback; if (typeof t !== "string") return t; try { return JSON.parse(t); } catch { return fallback; } };
