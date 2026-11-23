// PM-1M, a 1m fast-protect layer on the MT5 broker stream (owner decision 2026-11-23, relayed by the orchestrator:
// "deploy semuanya live. Tf 1m diperlukan position manager untuk antisipasi TP lebih cepat dan mengurangi kerugian. Meski
// concern dengan noise perlu penanganan."). A layer beside the 5-minute Position Manager, not a re-base: A8, the R band
// (pmBand) and Omega's buffers keep their calibrations, and the Position Council still runs every 5 minutes. No council
// here: fixed rules on CLOSED broker M1 bars, evaluated once per newly closed minute by Omega's bridge sync (no cron of
// its own; src/omega-broker.mjs bridgeSync calls runFastProtect), and replayed the same way by v4 on its 1m bars.
//
// It may only bring a target nearer, lock profit, tighten a stop, or close early in the loss branch. It never loosens a
// stop, never moves a target further, never opens or adds. Two triggers (per-mode constants in PM_FAST_1M):
//   pm_fast_tp   TP anticipation: price within the mode's near zone of TP1 or the broker's target (in R of the stop
//                distance at entry), the position in profit, and 2 of the last 3 closed 1m bars closed against it with a
//                body of at least 0.5 x ATR1m(14). Then a lock (the stop to protect at least lock_r of the open profit)
//                when the SLG1 profit-lock gate is open; while it is closed (src/profit-lock-gate.mjs: no stop moves into
//                profit before it) the target comes nearer instead, to the recent favourable extreme less the spread
//                (not a stop into profit, so not gated). With no room for either it is recorded as held.
//   pm_fast_cut  loss reduction: a 1m impulse against the position (its true range at least impulse_k x ATR1m) that
//                closes beyond the last 5m swing (the extreme of the last closed 5m bars), confirmed by the next closed
//                1m bar not reclaiming it. Then the stop tightens to the 1m swing (the two bars' extreme) plus
//                max(2 x spread, 0.25 x ATR1m), never beyond the original stop and never looser than the current one;
//                at or below exit_r (-0.5R) the position closes instead. A tightened stop that would sit in profit is a
//                stop into profit and waits for the gate like any other.
// Noise (owner: "Meski concern dengan noise perlu penanganan"), each one inert (no evaluation, no record) unless said:
//   - quarantine: the rollover 21:55-22:15 UTC, the reopen 23:00-23:05 UTC and the first 5 minutes after any daily or
//     weekly reopen (goldPausedAt; the same window in US standard time), the market paused, and the first 3 minutes
//     after a reconnect batch (a bar received more than 60 s after its close);
//   - the latest closed bar must be at most 90 s old (the stream stale or missing: inert, today's 5m behaviour);
//   - ATR1m warm-up: at least 20 contiguous bars since the last missing minute;
//   - a SELL's bars are the bid: the bar's spread is added back (its exit price is the ask);
//   - the liquidity lens's spread-spike deferral (docs/RFC_POSITIONING_LIQUIDITY.md §6): while Omega would defer a
//     modification (a live spike, up to 10 minutes from its start) a fast trigger is held, its close included;
//   - at most one fast action per position per 3 minutes, and hysteresis: no fast action of the other trigger within
//     10 minutes of one (a held trigger is recorded, with the reason);
//   - one manager per 5-minute bar: once the 5-minute Position Manager sent an action for a position in a 5m bar, the
//     fast layer holds that position for the rest of that bar (v4 evaluates both at the same minute).
// Identity: the stream is pinned by account_ref, source (server and symbol) and digits, as the liquidity lens's baseline
// key is (src/liquidity-lens.mjs baselineIdentity), never by connection_version (a reconnect's new version is the same
// source).
// Records: position_actions with id pm1:<ticket>:<bar minute> (the closed bar's open, in minutes), rule pm_fast_tp or
// pm_fast_cut, bar the bar minute, and the reason with ATR1m and its source (atr_source, in the why). Omega's intent id is
// the same id; the Telegram line is the Position Manager's, one per action as the broker answers.
// Switch: the Omega setting `pm_fast_1m`, "on" (default) | "off"; "off" is today's engine byte for byte. The owner's
// switch only (Aether's policy never writes it); it is in ERA_SWITCHES. There is no environment variable for it.

import { goldPausedAt } from "./market-hours.mjs";
import { inRollover, liveSpreadSpike, LIQUIDITY_MODIFY_DEFER_MAX_MS, ensureLiquiditySchema } from "./liquidity-lens.mjs";
import { gateText, stopInProfit, GATE_UNMEASURED } from "./profit-lock-gate.mjs";
import { ensurePositionSchema } from "./position-actions.mjs";
import { corpusSource } from "./corpus-oracle.mjs";

export const PM_FAST_MODES = Object.freeze(["on", "off"]);
export const PM_FAST_RULES = Object.freeze({ tp: "pm_fast_tp", cut: "pm_fast_cut" });
/** Every threshold of the layer, per mode, in one table (a later doctrine can tune it). Times in ms, R of the stop at entry. */
const NOISE = Object.freeze({ atr_period: 14, fresh_ms: 90_000, warmup_bars: 20, late_bar_ms: 60_000, reconnect_ms: 3 * 60_000, reopen_min: 5, rate_ms: 3 * 60_000, hysteresis_ms: 10 * 60_000 });
const row = (x) => Object.freeze({ ...x, ...NOISE });
export const PM_FAST_1M = Object.freeze({
  scalp: row({ near_zone_r: 0.25, against_of: 3, against_min: 2, body_atr: 0.5, lock_r: 0.6, extreme_bars: 15, impulse_k: 2.0, swing_5m_bars: 3, stop_spread_k: 2, stop_atr_k: 0.25, exit_r: -0.5 }),
  intraday: row({ near_zone_r: 0.3, against_of: 3, against_min: 2, body_atr: 0.5, lock_r: 0.5, extreme_bars: 15, impulse_k: 2.0, swing_5m_bars: 3, stop_spread_k: 2, stop_atr_k: 0.25, exit_r: -0.5 }),
  range: row({ near_zone_r: 0.3, against_of: 3, against_min: 2, body_atr: 0.5, lock_r: 0.5, extreme_bars: 15, impulse_k: 2.0, swing_5m_bars: 3, stop_spread_k: 2, stop_atr_k: 0.25, exit_r: -0.5 }),
  swing: row({ near_zone_r: 0.4, against_of: 3, against_min: 2, body_atr: 0.5, lock_r: 0.4, extreme_bars: 15, impulse_k: 2.0, swing_5m_bars: 3, stop_spread_k: 2, stop_atr_k: 0.25, exit_r: -0.5 })
});
/** The bars the live step reads back (the warm-up, the ATR, three 5m swings and the extreme fit well inside). */
export const PM_FAST_READ_MIN = 90;
const M1 = 60_000, M5 = 5 * M1;
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const positive = (v) => finite(v) && v > 0;
const roundTo = (v, digits) => Number(v.toFixed(Math.max(0, Math.min(10, digits))));
const r2 = (v) => Math.round(v * 100) / 100;
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

/** Pure: whether the layer runs in these settings (anything but "off", the default "on" included). */
export function pmFastOn(settings) {
  return settings?.pm_fast_1m !== "off";
}
/** Pure: the layer's mode for a position's mode at entry: one of the four, else intraday (as the R band). */
export function fastMode(mode) {
  return typeof mode === "string" && Object.hasOwn(PM_FAST_1M, mode) ? mode : "intraday";
}
/** Pure: the record and intent id of a fast action: pm1:<ticket>:<the closed bar's open in minutes>. */
export const fastId = (ticket, barMs) => `pm1:${ticket}:${Math.floor(barMs / M1)}`;
/** Pure: whether an id is a fast action's (with Omega's "d:" prefix or an attempt suffix). */
export const isFastId = (id) => /^(d:)?pm1:\d+:\d+(:\d+)?$/.test(String(id ?? ""));

/** Pure: the bars in the position's exit price: a BUY exits at the bid (the bars as they are), a SELL at the ask (plus each bar's spread). */
export function fastBars(bars = [], { side, point = 0.01, spreadPoints = 0 } = {}) {
  const sell = side === "SELL";
  return (Array.isArray(bars) ? bars : []).filter((b) => [b?.t, b?.o, b?.h, b?.l, b?.c].every(finite)).map((b) => {
    if (!sell) return { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, r: finite(b.r) ? b.r : null };
    const s = (finite(b.s) && b.s >= 0 ? b.s : finite(spreadPoints) ? spreadPoints : 0) * point;
    return { t: b.t, o: b.o + s, h: b.h + s, l: b.l + s, c: b.c + s, r: finite(b.r) ? b.r : null };
  });
}

/** Pure: a bar's true range against the close before it. */
const trueRange = (b, prev) => (prev ? Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c)) : b.h - b.l);
/** Pure: ATR1m, the mean of the last `period` true ranges of the bars up to index `end` (inclusive), or null. */
export function atr1m(bars, end = bars.length - 1, period = NOISE.atr_period) {
  if (!(end >= period)) return null;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) sum += trueRange(bars[i], bars[i - 1]);
  return sum / period;
}

/**
 * Pure: why the layer is inert at `now` on these closed bars (oldest first, { t, o, h, l, c, r? }), or null. The
 * stream missing or stale, a quarantine (the rollover, the reopen, the market paused, a reconnect batch), the warm-up.
 */
export function fastNoise(bars, { now, knobs = PM_FAST_1M.intraday } = {}) {
  if (!Array.isArray(bars) || !bars.length) return { code: "no_stream", text: "no closed broker M1 bar" };
  const last = bars.at(-1), closeMs = last.t + M1;
  if (!(closeMs <= now) || now - closeMs > knobs.fresh_ms) return { code: "stale", text: `the latest closed broker M1 bar closed at ${hhmm(closeMs)} UTC, more than ${knobs.fresh_ms / 1000} s ago` };
  for (const ms of [last.t, now]) {
    if (goldPausedAt(ms)) return { code: "market_paused", text: "gold is not trading" };
    if (inRollover(ms)) return { code: "rollover", text: "the rollover quarantine 21:55-22:15 UTC" };
    const d = new Date(ms);
    if (d.getUTCHours() === 23 && d.getUTCMinutes() < knobs.reopen_min) return { code: "reopen", text: `the reopen quarantine 23:00-23:${String(knobs.reopen_min).padStart(2, "0")} UTC` };
    for (let k = 1; k <= knobs.reopen_min; k++) if (goldPausedAt(ms - k * M1)) return { code: "reopen", text: `the first ${knobs.reopen_min} minutes after the reopen` };
  }
  const lateAt = bars.filter((b) => finite(b.r) && b.r - (b.t + M1) > knobs.late_bar_ms).reduce((m, b) => Math.max(m, b.r), -Infinity);
  if (finite(lateAt) && now - lateAt < knobs.reconnect_ms) return { code: "reconnect", text: `the first ${knobs.reconnect_ms / 60_000} minutes after a reconnect batch (received ${hhmm(lateAt)} UTC)` };
  let run = 1;
  for (let i = bars.length - 1; i > 0 && bars[i].t - bars[i - 1].t === M1; i--) run += 1;
  if (run < knobs.warmup_bars) return { code: "warmup", text: `ATR1m warm-up: ${run} of ${knobs.warmup_bars} contiguous bars since the last gap` };
  return null;
}

/** Pure: the extreme of the last `n` closed 5m buckets ending at or before `endMs` (complete ones only), or null. */
function swing5m(bars, endMs, n, dir) {
  const groups = new Map();
  for (const b of bars) {
    if (b.t + M1 > endMs) continue;
    const k = Math.floor(b.t / M5) * M5;
    if (k + M5 > endMs) continue;
    (groups.get(k) || groups.set(k, []).get(k)).push(b);
  }
  const full = [...groups].filter(([, list]) => list.length === 5).sort((a, b) => a[0] - b[0]).slice(-n);
  if (full.length < n) return null;
  const all = full.flatMap(([, list]) => list);
  return dir > 0 ? Math.min(...all.map((b) => b.l)) : Math.max(...all.map((b) => b.h));
}

/**
 * Pure: the fast layer's call for one position at `now`. Inputs:
 *   position  { ticket, side, open_price, sl, tp, opened_ms } as the terminal reports it;
 *   meta      { mode, r_dist, tp1, orig_sl } from its open intent (the plan's TP1, the stop at entry and its distance);
 *   bars      closed broker M1 bars on the bid, oldest first ({ t, o, h, l, c, s: spread points, r: received ms });
 *   sym       { point, digits, spread_points } (the live spread when a bar has none);
 *   gate      the SLG1 profit-lock gate facts (undefined: the gate is "legacy", no gate);
 *   spike     the spread-spike deferral holds modifications now;
 *   history   the position's fast actions sent in the last 10 minutes ([{ bar_ms, branch }]);
 *   pmBar     the 5-minute Position Manager sent an action for it in this 5m bar;
 *   atrSource "broker_m1" live, "feed_m1" in v4.
 * Returns { status: "inert", code, why } (no evaluation, no record), { status: "none" } (no trigger), or a record:
 * { status: "act" | "held", action: "sl" | "tp" | "close" | "hold", rule, sl?, tp?, why, bar_ms, atr, atr_source, branch }.
 */
export function fastProtect({ position: p, meta = null, bars = [], now, sym = {}, gate = undefined, spike = false, history = [], pmBar = false, atrSource = "broker_m1" } = {}) {
  if (p?.side !== "BUY" && p?.side !== "SELL") return { status: "inert", code: "no_position", why: "no position" };
  const mode = fastMode(meta?.mode), K = PM_FAST_1M[mode];
  const point = positive(sym.point) ? sym.point : 0.01, digits = Number.isInteger(sym.digits) ? sym.digits : 2;
  const closed = (Array.isArray(bars) ? bars : []).filter((b) => finite(b?.t) && b.t + M1 <= now).sort((a, b) => a.t - b.t);
  const noise = fastNoise(closed, { now, knobs: K });
  if (noise) return { status: "inert", code: noise.code, why: noise.text };
  const dir = p.side === "BUY" ? 1 : -1, buy = dir > 0;
  const xb = fastBars(closed, { side: p.side, point, spreadPoints: sym.spread_points });
  const n = xb.length, last = xb[n - 1];
  // ATR1m(14) as it stood before the last two bars (an impulse and its confirmation never inflate their own yardstick).
  const atr = atr1m(xb, n - 3, K.atr_period);
  if (!positive(atr)) return { status: "inert", code: "no_atr", why: "ATR1m cannot be measured" };
  const open = Number(p.open_price ?? p.entry), sl = Number(p.sl), tp = Number(p.tp);
  if (!finite(open)) return { status: "inert", code: "no_position", why: "the position's open price is unknown" };
  const curSl = positive(sl) ? sl : null, curTp = positive(tp) ? tp : null;
  const lastSpread = (finite(closed.at(-1).s) && closed.at(-1).s >= 0 ? closed.at(-1).s : finite(sym.spread_points) ? sym.spread_points : 0) * point;
  const rDist = positive(Number(meta?.r_dist)) ? Number(meta.r_dist) : positive(Number(meta?.orig_sl)) ? Math.abs(open - Number(meta.orig_sl)) : null;
  const price = last.c, profit = dir * (price - open);
  const rNow = rDist ? r2(profit / rDist) : null;
  const barMs = closed.at(-1).t;
  const better = (x) => curSl == null || dir * (x - curSl) > point / 2;
  const room = (x) => dir * (price - x) > lastSpread + point;
  const atrTxt = `ATR1m(14) ${r2(atr)} (${atrSource})`;
  const at = `bar ${hhmm(barMs)} UTC, ${mode}, ${rNow != null ? `${rNow >= 0 ? "+" : ""}${rNow}R` : `${r2(profit)} in price`}`;
  const base = { bar_ms: barMs, atr: r2(atr), atr_source: atrSource, mode };
  const hold = (rule, branch, why) => ({ status: "held", action: "hold", rule, branch, why, ...base });
  const holdReason = (branch) => {
    if (spike) return "the spread-spike deferral holds modifications (docs/RFC_POSITIONING_LIQUIDITY.md §6)";
    if (pmBar) return "the 5-minute Position Manager acted on this position in this 5m bar";
    const recent = (Array.isArray(history) ? history : []).filter((h) => finite(h?.bar_ms) && h.bar_ms <= barMs);
    const rate = recent.find((h) => barMs - h.bar_ms < K.rate_ms);
    if (rate) return `a fast action went out at ${hhmm(rate.bar_ms)} UTC: at most one per ${K.rate_ms / 60_000} minutes`;
    const flip = recent.find((h) => h.branch !== branch && barMs - h.bar_ms < K.hysteresis_ms);
    if (flip) return `hysteresis: the other fast trigger acted at ${hhmm(flip.bar_ms)} UTC, within ${K.hysteresis_ms / 60_000} minutes`;
    return null;
  };

  // pm_fast_tp: the near zone of TP1 or the broker's target, in profit, 2 of the last 3 bars closed against it.
  const targets = [Number(meta?.tp1), curTp].filter(positive);
  const near = targets.length ? Math.min(...targets.map((x) => dir * (x - price))) : Infinity;
  const tail = xb.slice(-K.against_of);
  const against = tail.filter((b) => dir * (b.c - b.o) < 0 && Math.abs(b.c - b.o) >= K.body_atr * atr - 1e-9).length;
  if (rDist && profit > 0 && near <= K.near_zone_r * rDist + 1e-9 && against >= K.against_min) {
    const fired = `1m TP anticipation: ${near <= 0 ? "at or past the target" : `${r2(near / rDist)}R from the target`} (zone ${K.near_zone_r}R), ${against} of the last ${K.against_of} closed 1m bars against the ${buy ? "long" : "short"} with a body of at least ${K.body_atr} x ${atrTxt}; ${at}`;
    const held = holdReason("tp");
    if (held) return hold(PM_FAST_RULES.tp, "tp", `${fired}; held: ${held}`);
    const gateShut = gate !== undefined && gate?.open !== true;
    const lock = roundTo(open + K.lock_r * (price - open), digits);
    const lockOk = dir * (lock - open) > lastSpread + point / 2 && better(lock) && room(lock);
    if (lockOk && !gateShut) return { status: "act", action: "sl", rule: PM_FAST_RULES.tp, branch: "tp", sl: lock, why: `${fired}: stop to ${lock} (protects ${K.lock_r} of the open profit)${gate ? `; at the profit-lock gate (${gateText(gate)})` : ""}`, ...base };
    // The target nearer: the favourable extreme of the recent bars since the fill, less the spread (it fills on a retest).
    const fromMs = positive(Number(p.opened_ms)) ? Math.ceil(Number(p.opened_ms) / M1) * M1 : -Infinity;
    const recent = xb.slice(-K.extreme_bars).filter((b) => b.t >= fromMs);
    const extreme = recent.length ? (buy ? Math.max(...recent.map((b) => b.h)) : Math.min(...recent.map((b) => b.l))) : null;
    const tpN = extreme != null ? roundTo(extreme - dir * lastSpread, digits) : null;
    const why = lockOk && gateShut ? `; the lock waits for the profit-lock gate (${gateText(gate)})` : "";
    if (tpN != null && curTp != null && dir * (curTp - tpN) > point / 2 && dir * (tpN - price) > lastSpread + point && dir * (tpN - open) > lastSpread) {
      return { status: "act", action: "tp", rule: PM_FAST_RULES.tp, branch: "tp", tp: tpN, why: `${fired}: target nearer ${curTp} → ${tpN} (the recent extreme less the spread)${why}`, ...base };
    }
    return hold(PM_FAST_RULES.tp, "tp", `${fired}; held: no room for a lock or a nearer target${why}`);
  }

  // pm_fast_cut: an impulse bar beyond the last 5m swing, the next bar not reclaiming it.
  if (n >= 3) {
    const imp = xb[n - 2], conf = xb[n - 1], prev = xb[n - 3];
    const tr = trueRange(imp, prev);
    const swing = swing5m(xb, imp.t, K.swing_5m_bars, dir);
    if (swing != null && dir * (imp.c - imp.o) < 0 && tr >= K.impulse_k * atr - 1e-9 && dir * (imp.c - swing) < 0 && dir * (conf.c - swing) < 0) {
      const fired = `1m impulse against the ${buy ? "long" : "short"}: true range ${r2(tr)} at least ${K.impulse_k} x ${atrTxt}, closed beyond the 5m swing ${r2(swing)} and the next bar did not reclaim it; ${at}`;
      const held = holdReason("cut");
      if (held) return hold(PM_FAST_RULES.cut, "cut", `${fired}; held: ${held}`);
      if (rNow != null && rNow <= K.exit_r + 1e-9) return { status: "act", action: "close", rule: PM_FAST_RULES.cut, branch: "cut", why: `${fired}: closed early at ${rNow}R (at or below ${K.exit_r}R)`, ...base };
      const buf = Math.max(K.stop_spread_k * lastSpread, K.stop_atr_k * atr);
      const swing1 = buy ? Math.min(imp.l, conf.l) : Math.max(imp.h, conf.h);
      const stop = roundTo(swing1 - dir * buf, digits);
      const orig = positive(Number(meta?.orig_sl)) ? Number(meta.orig_sl) : null;
      if (orig != null && dir * (stop - orig) < -point / 2) return hold(PM_FAST_RULES.cut, "cut", `${fired}; held: the 1m swing's stop ${stop} would be beyond the original stop ${orig}`);
      if (!better(stop)) return hold(PM_FAST_RULES.cut, "cut", `${fired}; held: the stop ${curSl} is already at or tighter than the 1m swing's ${stop}`);
      if (!room(stop)) return hold(PM_FAST_RULES.cut, "cut", `${fired}; held: the price leaves no room for a stop at ${stop}`);
      if (gate !== undefined && gate?.open !== true && stopInProfit(stop, open, dir, point)) return hold(PM_FAST_RULES.cut, "cut", `${fired}; held: a stop at ${stop} is in profit and waits for the profit-lock gate (${gateText(gate)})`);
      return { status: "act", action: "sl", rule: PM_FAST_RULES.cut, branch: "cut", sl: stop, why: `${fired}: stop tightened ${curSl ?? "none"} → ${stop} (the 1m swing ${r2(swing1)} plus max(${K.stop_spread_k} x spread, ${K.stop_atr_k} x ATR1m))`, ...base };
    }
  }
  return { status: "none" };
}

// ---------------------------------------------------------------- the live step (Omega's bridge sync)

/** The live step's memo per D1 binding: the bar minute already evaluated and when to look again for a bar not yet in. */
const MEMO = new WeakMap();
/** How often the sync looks again for a closed minute's bar that has not arrived yet. */
export const PM_FAST_RETRY_MS = 5_000;

/**
 * The fast step in Omega's bridge sync, before the plan reads the pending Position Manager actions, once per newly
 * closed broker minute per isolate (a second isolate's run of the same minute writes the same ids: INSERT OR IGNORE).
 * `executor` the terminal's state; `openIntents` { intent id: payload } of its Omega positions; `gates` SLG1's facts
 * (null while the gate is "legacy"); `spike` the spread-spike deferral holds modifications now. Writes each trigger's
 * record (pending for an action, noted for a held one) into position_actions. Never throws.
 */
export async function runFastProtect(env, { executor, openIntents = null, gates = null, spike = false, now = Date.now() } = {}) {
  const db = env?.DB;
  if (!db) return { status: "unavailable" };
  const positions = (Array.isArray(executor?.positions) ? executor.positions : []).filter((p) => Number(p?.ticket) > 0 && (p.side === "BUY" || p.side === "SELL") && typeof p.intent_id === "string" && (p.intent_id.startsWith("open:") || /^re:\d+:\d+(:\d+)?$/.test(p.intent_id)));
  if (!positions.length) return { status: "no_positions" };
  const want = Math.floor(now / M1) * M1 - M1;
  const memo = MEMO.get(db) ?? { done: null, retry: 0 };
  if (memo.done === want || now < memo.retry) return { status: "done" };
  // The stream's identity: the account's opaque reference, the source (server and symbol) and the digits.
  const ref = typeof executor?.account_ref === "string" && executor.account_ref ? executor.account_ref : null;
  const digits = Number.isInteger(executor?.symbol?.digits) ? executor.symbol.digits : null;
  const server = String(executor?.server ?? "").trim(), symbol = String(executor?.symbol?.name ?? "").trim();
  if (!ref || digits == null || !server || !symbol) { MEMO.set(db, { done: want, retry: 0 }); return { status: "no_identity" }; }
  try {
    await ensureLiquiditySchema(db);
    const rows = (await db.prepare("SELECT minute_ms AS t, o, h, l, c, spread_points AS s, received_ms AS r FROM broker_bars_1m WHERE account_ref = ? AND source = ? AND digits = ? AND minute_ms >= ? AND minute_ms <= ? ORDER BY minute_ms")
      .bind(ref, corpusSource(server, symbol), digits, want - PM_FAST_READ_MIN * M1, want).all()).results ?? [];
    const bars = rows.map((r) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), s: r.s == null ? null : Number(r.s), r: r.r == null ? null : Number(r.r) }));
    if (!bars.length || bars.at(-1).t !== want) {
      // The minute's bar is not in yet (it arrives about a second after the close): look again shortly; a stream that
      // stays away leaves the layer inert (the freshness rule) and today's 5-minute behaviour unchanged.
      MEMO.set(db, { done: memo.done, retry: now + PM_FAST_RETRY_MS });
      return { status: "waiting" };
    }
    MEMO.set(db, { done: want, retry: 0 });
    await ensurePositionSchema(db);
    const ids = [...new Set(positions.map((p) => p.intent_id))];
    const intents = openIntents ?? Object.fromEntries(((await db.prepare(`SELECT id, payload FROM omega_intents WHERE kind IN ('open', 'place_limit') AND id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).all()).results ?? []).map((r) => [r.id, JSON.parse(r.payload)]));
    const tickets = positions.map((p) => Number(p.ticket));
    const marks = tickets.map(() => "?").join(", ");
    const sent = (await db.prepare(`SELECT ticket, bar, rule FROM position_actions WHERE id LIKE 'pm1:%' AND ticket IN (${marks}) AND at_ms > ? AND action IN ('close', 'sl', 'tp') AND status IN ('pending', 'applied')`).bind(...tickets, now - PM_FAST_1M.intraday.hysteresis_ms - M1).all()).results ?? [];
    const pmBar = Math.floor(now / M5);
    const pmRows = (await db.prepare(`SELECT ticket FROM position_actions WHERE id LIKE 'pm:%' AND ticket IN (${marks}) AND bar = ? AND action IN ('close', 'sl', 'tp') AND status IN ('pending', 'applied')`).bind(...tickets, pmBar).all()).results ?? [];
    const pmTickets = new Set(pmRows.map((r) => Number(r.ticket)));
    const out = [];
    for (const p of positions) {
      const it = intents[p.intent_id] ?? {};
      const meta = fastMeta(it);
      const history = sent.filter((r) => Number(r.ticket) === Number(p.ticket)).map((r) => ({ bar_ms: Number(r.bar) * M1, branch: r.rule === PM_FAST_RULES.cut ? "cut" : "tp" }));
      // SLG1: a position without gate facts reads as closed while the gate is on; "legacy" (gates null): no gate.
      const gate = gates == null ? undefined : gates[String(p.ticket)] ?? GATE_UNMEASURED;
      const f = fastProtect({ position: p, meta, bars, now, sym: executor.symbol ?? {}, gate, spike, history, pmBar: pmTickets.has(Number(p.ticket)), atrSource: "broker_m1" });
      if (f.status !== "act" && f.status !== "held") { out.push({ ticket: p.ticket, status: f.status, code: f.code ?? null }); continue; }
      const dir = p.side === "BUY" ? 1 : -1, price = dir > 0 ? Number(executor.symbol?.bid) : Number(executor.symbol?.ask);
      const pips = finite(price) && finite(Number(p.open_price)) ? Math.round((dir * (price - Number(p.open_price)) / 0.1) * 10) / 10 : null;
      const id = fastId(p.ticket, f.bar_ms);
      await db.prepare("INSERT OR IGNORE INTO position_actions (id, ticket, bar, at_ms, side, pips, price, action, rule, sl, tp, why, council, orig_sl, orig_tp, basis, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, p.ticket, Math.floor(f.bar_ms / M1), now, p.side, pips, finite(price) ? price : null, f.action, f.rule, f.sl ?? null, f.tp ?? null, f.why, null, positive(Number(p.sl)) ? Number(p.sl) : null, positive(Number(p.tp)) ? Number(p.tp) : null, null, f.status === "act" ? "pending" : "noted").run();
      out.push({ ticket: p.ticket, status: f.status, action: f.action, rule: f.rule });
    }
    return { status: "ran", bar_ms: want, positions: out };
  } catch (error) {
    return { status: "failed", error: String(error?.message ?? error).slice(0, 160) };
  }
}

/** Pure: the layer's facts of an open intent's payload: its mode, the stop at entry and its distance, the plan's TP1. */
export function fastMeta(it = {}) {
  const entry = Number(it?.entry), sl = Number(it?.sl), tp = Number(it?.tp);
  const rd = positive(Number(it?.r_dist)) ? Number(it.r_dist) : finite(entry) && positive(sl) ? Math.abs(entry - sl) : null;
  return { mode: typeof it?.mode === "string" ? it.mode : null, r_dist: rd, tp1: positive(tp) ? tp : null, orig_sl: positive(sl) ? sl : null };
}

/** Pure: whether the spread-spike deferral holds modifications now (the planner's own rule, src/liquidity-lens.mjs deferModifications). */
export function spikeHolds({ signal = null, sym = {}, settings = {}, spikeSinceMs = null, now = Date.now() } = {}) {
  if (signal?.liquidity_on !== true || settings?.liquidity_enabled === false || !liveSpreadSpike(signal, sym)) return false;
  const since = finite(spikeSinceMs) ? spikeSinceMs : now;
  return now - since < LIQUIDITY_MODIFY_DEFER_MAX_MS;
}
