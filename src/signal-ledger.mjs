// Signal Ledger (owner request 2026-11-07, "Nexus vs KIRA" item 1): every directional signal the
// system gives, followed to its outcome in R on the closed bars that came after it. Advisory only:
// R multiples of the advice itself, never money, lots, balances or positions.
//
// Sources:
//   h1_decision  the H1 Reasoner's BUY/SELL (trade_decisions: entry, stop, one take profit);
//   strategy     the strategy engine's TRIGGERED setups (entry, stop, TP1, TP2), snapshotted by the
//                sweep, at most one open per side;
//   decision     the Decision Engine's BUY/SELL (owner decisions 2026-11-09: the single SSOT; entry,
//                stop and the chosen target), at most one open per side. While the engine is on
//                (DECISION_ENGINE not "off") it is the only new source; h1_decision and strategy
//                rows stay for the history.
//
// Simulation (deterministic, on closed 15m bars, else 1H bars where 15m bars do not reach):
//   - The entry is a limit at `entry`. It fills on the first bar whose range reaches it, within
//     FILL_WINDOW_MS of the signal. Before the fill, a stop touch cancels it (invalidated) and a
//     TP1 touch cancels it (target_before_entry). An unfilled signal expires (unfilled).
//   - Once filled, two independent policies run: "tp1" (the whole position exits at TP1) and "tp2"
//     (it exits at TP2; only when a TP2 exists). Each exits at its target (+R), at the stop (-1R),
//     or after HOLD_MAX_MS at the bar's close (time exit, mark to market).
//   - A bar that reaches both the stop and the target counts as the stop (conservative) and is
//     flagged ambiguous. The fill bar itself can stop out but only reaches its target when the
//     stop is not touched.
//   - R = (exit - entry) x side / |entry - stop|. MFE and MAE are kept in R.
// The ledger never feeds a room, a prompt or a decision.

import { keyLevelPlan, isProtected, strategyExits, OMEGA_DEFAULTS } from "./omega-engine.mjs";
import { flatConfidences } from "./agent-confidence.mjs";

export const LEDGER_VERSION = "cryptophys.signal-ledger.v1";
/** The ledger's own schedule (owner 2026-11-12): every 5 minutes, 2 minutes past each 5m close. */
export const LEDGER_CRON = "2-59/5 * * * *";
export const FILL_WINDOW_MS = 8 * 3600_000;
export const HOLD_MAX_MS = 72 * 3600_000;
export const SOURCES = Object.freeze(["decision", "h1_decision", "strategy"]);

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const iso = (ms) => new Date(ms).toISOString();
/** D1 datetime('now') text ("YYYY-MM-DD HH:MM:SS", UTC) or ISO, to epoch ms. */
export const toMs = (t) => (typeof t === "string" ? Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(" ", "T") + "Z") : NaN);

/** A signal is valid when its prices are ordered for its side. */
export function validSignal(s) {
  const dir = s?.side === "BUY" ? 1 : s?.side === "SELL" ? -1 : 0;
  if (!dir || ![s.entry, s.stop, s.tp1].every(finite)) return false;
  if (dir * (s.entry - s.stop) <= 0 || dir * (s.tp1 - s.entry) <= 0) return false;
  if (s.tp2 != null && (!finite(s.tp2) || dir * (s.tp2 - s.tp1) < 0)) return false;
  return true;
}

/**
 * Pure: the outcome of one signal on `bars` (closed bars, oldest first, { open_time, close_time,
 * high, low, close }). `now` bounds the windows: a signal whose window is still running stays
 * pending or open.
 */
export function simulateSignal(signal, bars, { now = Date.now(), fillWindowMs = FILL_WINDOW_MS, holdMaxMs = HOLD_MAX_MS } = {}) {
  const dir = signal.side === "BUY" ? 1 : -1;
  const { entry, stop, tp1 } = signal, tp2 = finite(signal.tp2) ? signal.tp2 : null;
  const risk = Math.abs(entry - stop);
  const R = (price) => r3(((price - entry) * dir) / risk);
  const reaches = (b, price) => b.low <= price && price <= b.high;
  const beyond = (b, price, up) => (up ? b.high >= price : b.low <= price);
  const opened = toMs(signal.opened_at);
  const after = bars.filter((b) => toMs(b.open_time) >= opened && toMs(b.close_time) <= now);

  // Progressive stop (SL+): when price reaches halfway to TP1, move the stop to breakeven (entry)
  // or to the provided progressive_stop level. This simulates locking profit.
  const hasPlus = finite(signal.progressive_stop);
  const ps = hasPlus ? signal.progressive_stop : stop;
  const trigger = hasPlus ? (entry + dir * 0.5 * Math.abs(tp1 - entry)) : (dir > 0 ? Infinity : -Infinity);

  let filledAt = null, i = 0;
  for (; i < after.length; i++) {
    const b = after[i];
    if (toMs(b.close_time) - opened > fillWindowMs && !reaches(b, entry)) break;
    if (reaches(b, entry)) { filledAt = b.open_time; break; }
    if (beyond(b, stop, dir < 0)) return { status: "cancelled", exit_reason: "invalidated", closed_at: b.close_time };
    if (beyond(b, tp1, dir > 0)) return { status: "cancelled", exit_reason: "target_before_entry", closed_at: b.close_time };
  }
  if (filledAt == null) {
    const windowOver = now - opened > fillWindowMs;
    return windowOver ? { status: "cancelled", exit_reason: "unfilled", closed_at: iso(opened + fillWindowMs) } : { status: "pending" };
  }

  const fillMs = toMs(filledAt);
  const policy = (target) => {
    let mfe = 0, mae = 0, ambiguous = false, slPlus = false, slPlusAt = null;
    let currentStop = stop;
    for (let k = i; k < after.length; k++) {
      const b = after[k];
      const favorable = dir > 0 ? b.high : b.low, adverse = dir > 0 ? b.low : b.high;
      mfe = Math.max(mfe, R(favorable)); mae = Math.min(mae, R(adverse));
      // trigger SL+ when price reaches halfway to target
      if (!slPlus && beyond(b, trigger, dir > 0)) { slPlus = true; slPlusAt = b.close_time; currentStop = ps; }
      const hitStop = beyond(b, currentStop, dir < 0), hitTarget = beyond(b, target, dir > 0);
      if (hitStop) { ambiguous = hitTarget; return { result: "stop", r: R(currentStop), exit_price: currentStop, closed_at: b.close_time, bars: k - i + 1, mfe, mae: R(currentStop), ambiguous, sl_plus: slPlus, sl_plus_at: slPlusAt }; }
      if (hitTarget) return { result: "target", r: R(target), exit_price: target, closed_at: b.close_time, bars: k - i + 1, mfe: Math.max(mfe, R(target)), mae, ambiguous, sl_plus: slPlus, sl_plus_at: slPlusAt };
      if (toMs(b.close_time) - fillMs >= holdMaxMs) return { result: "time", r: R(b.close), exit_price: b.close, closed_at: b.close_time, bars: k - i + 1, mfe, mae, ambiguous, sl_plus: slPlus, sl_plus_at: slPlusAt };
    }
    return { result: "open", r: after.length > i ? R(after.at(-1).close) : 0, mfe, mae, bars: after.length - i, sl_plus: slPlus, sl_plus_at: slPlusAt };
  };
  const p1 = policy(tp1), p2 = tp2 != null ? policy(tp2) : null;
  const done = p1.result !== "open" && (p2 == null || p2.result !== "open");
  return {
    status: done ? "closed" : "open", filled_at: filledAt,
    exit_reason: p1.result === "open" ? null : p1.result, closed_at: done ? [p1.closed_at, p2?.closed_at].filter(Boolean).sort().at(-1) : null,
    r_tp1: p1.result === "open" ? null : p1.r, r_tp2: p2 && p2.result !== "open" ? p2.r : null,
    open_r: p1.result === "open" ? p1.r : null,
    exit_price: p1.exit_price ?? null, bars_held: p1.bars, mfe_r: r3(p1.mfe), mae_r: r3(p1.mae),
    ambiguous: Boolean(p1.ambiguous || p2?.ambiguous),
    sl_plus_triggered: p1.sl_plus ? 1 : 0, sl_plus_at: p1.sl_plus_at ?? null,
    // Each policy's own exit time (the setup's lifecycle: TP1 reached while the TP2 part runs on).
    tp1_closed_at: p1.result === "open" ? null : p1.closed_at, tp2_closed_at: p2 && p2.result !== "open" ? p2.closed_at : null,
    tp2_exit_reason: p2 && p2.result !== "open" ? p2.result : null
  };
}

// ---------------------------------------------------------------------------
// The Omega policy (owner 2026-11-12: "kerjakan kebijakan Omega di Signal Ledger sesuai dengan mode
// intraday, swing, dan scalping. Ini digunakan untuk inputan ke aether dan selanjutnya akan menjadi
// knowledge"). A third policy on the same Decision Engine signals: what the Omega engine
// (src/omega-engine.mjs) would have done with each one, replayed on the feed's closed 15m bars.
//   entry     at market on the first bar after the decision's time (on 1m bars the minute after it was
//             decided; on older 15m bars the bar after the decided bar). Omega trades a signal only
//             until the next close and within max_signal_age of the decision: an ENTER_LIMIT plan waits
//             that long for price within 0.35 x the stop distance of the entry. The stop and the target
//             keep the plan's distances from the fill.
//   gates     the day's loss limit and risk budget in R (max_daily_loss_pct / risk_pct of the Omega
//             settings), the open positions' risk at their stops, max_positions and no stacking on an
//             unprotected position; the budget caps the size (a fraction of 1R) like the lot cap.
//   manage    at every bar close (every minute on 1m bars), the latest decision already made then:
//             its quorum power and key levels drive
//             keyLevelPlan (SL+ behind passed levels, trailing TP, the close on a reversed power); an
//             opposite decision closes the trade; HOLD_MAX_MS ends it at the bar's close. A decision made
//             with the strategy execution rules (owner 2026-11-16, docs/RFC_STRATEGY_EXECUTION.md) also runs
//             Omega's strategyExits: the lean flip (lean_flip), a winner's agent confidence drop
//             (confidence_drop), and the trailing TP only while that confidence is stable or rising.
// Every trade carries its trading mode (scalp, intraday, swing: the mode decides the target and Omega's
// rules follow it), so the policy is measured per mode. Approximations, said in the view's rules: the
// feed's bars (no broker basis, no spread but a fixed one), no 5m stop or adaptive stop, the 5m ATR
// as the 15m ATR(14) / sqrt 3 and the 5m swing as the last 15 minutes, no scale-out (Omega trades 0.01
// lot), no wait for the 5m entry trigger.
export const OMEGA_POLICY_VERSION = "cryptophys.ledger-omega.v3";
/** The replay through the live engine's own functions (src/ledger-omega4.mjs), kept beside v3 (owner 2026-11-20). */
export const OMEGA4_VERSION = "cryptophys.ledger-omega.v4";
/** "Omega with limit entry" (src/ledger-omega-limit.mjs, docs/RFC_OMEGA_LIMIT_ENTRY.md §8 stage 2): the maker counterfactual beside v4. */
export const OMEGA_LIMIT_VERSION = "cryptophys.ledger-omega-limit.v1";
/** The latest v4 parity check against the live account (src/ledger-omega4.mjs runOmegaParity), in SIGNAL_CACHE. */
export const OMEGA4_PARITY_KEY = "ledger:omega4:parity:v1";
export const OMEGA_SIM = Object.freeze({ spread: 0.2, atr_period: 14, limit_pullback: 0.35, broker_day_utc: 22 });
export const TRADING_MODES = Object.freeze(["scalp", "intraday", "swing", "range"]);
const M15 = 15 * 60_000;

/** The close of a Decision Engine key's bar ("...:<bar open ms>"), as decision-engine.mjs keyCloseMs. */
export const decisionCloseMs = (key) => { const open = Number(String(key ?? "").split(":").pop()); return Number.isFinite(open) && open > 0 ? open + M15 : NaN; };
/** Trading session of a bar open (UTC hours), as decision-cards.mjs sessionOf. */
export const sessionAt = (ms) => { const h = new Date(ms).getUTCHours(); return h < 7 ? "asia" : h < 13 ? "london" : h < 21 ? "new_york" : "late"; };
/** The start of the broker day holding `ms` (MT5 server midnight at 22:00 UTC). */
export const brokerDayStart = (ms) => { const h = OMEGA_SIM.broker_day_utc * 3600_000, day = 86_400_000; return Math.floor((ms - h) / day) * day + h; };

/** Pure: the mean true range of `bars` over the `period` bars ending at index `k` (null before bar 1). */
export function atrAt(bars, k, period = OMEGA_SIM.atr_period) {
  const from = Math.max(1, k - period + 1);
  let sum = 0, n = 0;
  for (let j = from; j <= k; j++) { const b = bars[j], p = bars[j - 1]; sum += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)); n += 1; }
  return n ? sum / n : null;
}

/** Pure: the key levels of a decision row ({ low, high } lowest first) from its JSON array text or array. */
export function decisionLevels(raw) {
  let list = raw;
  if (typeof raw === "string") { try { list = JSON.parse(raw); } catch { list = null; } }
  return (Array.isArray(list) ? list : []).map((z) => ({ low: Number(z?.low), high: Number(z?.high) }))
    .filter((z) => z.low > 0 && z.high >= z.low).sort((a, b) => a.low - b.low);
}

const spanMs = (b) => toMs(b.close_time) - toMs(b.open_time);

/**
 * Pure: the fill of a signal under Omega's entry rule, or why it did not trade. The window runs from the
 * decision (`opened_at`, never before the decided bar's close) to the next close or `maxAgeMs` after the
 * decision, whichever comes first. On 1m bars the first bar is the one opening after the decision; on a
 * 15m (or longer) bar, the bar that opens at the decided bar's close.
 */
export function omegaEntry(signal, bars, { now = Date.now(), maxAgeMs = OMEGA_DEFAULTS.max_signal_age_ms } = {}) {
  const closeMs = decisionCloseMs(signal.candle_key);
  if (!finite(closeMs)) return { status: "skipped", gate: "no_decision_bar" };
  const opened = toMs(signal.opened_at);
  const decidedMs = finite(opened) ? Math.max(closeMs, opened) : closeMs;
  const until = Math.min(closeMs + M15, decidedMs + maxAgeMs);
  const k = bars.findIndex((b) => toMs(b.open_time) >= closeMs && (spanMs(b) >= M15 || toMs(b.open_time) >= decidedMs));
  if (k < 0 || toMs(bars[k].close_time) > now) return now - closeMs > HOLD_MAX_MS ? { status: "skipped", gate: "no_bars" } : { status: "pending" };
  if (toMs(bars[k].open_time) >= until) return { status: "skipped", gate: "expired" };
  const dir = signal.side === "BUY" ? 1 : -1, stopDist = Math.abs(signal.entry - signal.stop);
  const limitPlan = String(signal.entry_action || "").toUpperCase() === "ENTER_LIMIT";
  // A limit plan fills only within 0.35 x the stop distance of its entry, on either side: beyond it toward
  // the target it waits for a pullback, beyond it toward the stop it waits for price to come back (owner
  // 2026-11-13, "setuju": no entry next to the plan's stop with a stop moved past the key level).
  const limit = signal.entry + dir * OMEGA_SIM.limit_pullback * stopDist;
  const chase = signal.entry - dir * OMEGA_SIM.limit_pullback * stopDist;
  for (let j = k; j < bars.length && toMs(bars[j].open_time) < until; j++) {
    const b = bars[j];
    if (toMs(b.close_time) > now) return { status: "pending" };
    let fill = b.open;
    if (limitPlan && dir * (b.open - limit) > 0) {
      if (!(dir > 0 ? b.low <= limit : b.high >= limit)) continue;
      fill = limit;
    } else if (limitPlan && dir * (chase - b.open) > 0) {
      if (!(dir > 0 ? b.high >= chase : b.low <= chase)) continue;
      fill = chase;
    }
    if (!finite(fill) || dir * (fill - signal.stop) <= 0) return { status: "skipped", gate: "stop_breached", bar: j };
    return { status: "filled", bar: j, fill, filled_at: b.open_time };
  }
  // The window passed (or the data ends inside it while it is still open).
  const lastOpen = bars.filter((b) => toMs(b.close_time) <= now).at(-1);
  if (now < until && (!lastOpen || toMs(lastOpen.close_time) < until)) return { status: "pending" };
  return { status: "skipped", gate: limitPlan ? "waiting_for_pullback" : "expired", bar: k };
}

/**
 * Pure: one signal under the Omega policy. `bars` closed bars oldest first (with open); `decisions`
 * the engine's decisions oldest first ({ close_ms, stance, power, levels }); `gate` the account gate
 * at the fill ({ code } to skip, { size } to trade a fraction of 1R), decided once by the caller.
 */
export function simulateOmega(signal, bars, { decisions = [], gate = null, now = Date.now(), holdMaxMs = HOLD_MAX_MS, atrBars = null, maxAgeMs = OMEGA_DEFAULTS.max_signal_age_ms } = {}) {
  const e = omegaEntry(signal, bars, { now, maxAgeMs });
  if (e.status !== "filled") return { omega_status: e.status, gate: e.gate ?? null };
  if (gate?.code) return { omega_status: "skipped", gate: gate.code, filled_at: e.filled_at };
  const size = finite(gate?.size) ? Math.max(0, Math.min(1, gate.size)) : 1;
  const dir = signal.side === "BUY" ? 1 : -1, buy = dir > 0;
  const stopDist = Math.abs(signal.entry - signal.stop), tpDist = Math.abs(signal.tp1 - signal.entry);
  const fill = e.fill, fillMs = toMs(e.filled_at), ownClose = decisionCloseMs(signal.candle_key);
  let sl = fill - dir * stopDist, tp = fill + dir * tpDist;
  const R = (price) => r3((dir * (price - fill)) / stopDist);
  let protectedAt = null, slMoves = 0, tpMoves = 0, mfe = 0, mae = 0, band = null;
  const out = (exit, price, b, k) => ({
    omega_status: "closed", exit, r: R(price), size: r3(size), filled_at: e.filled_at, closed_at: b.close_time, bars: k - e.bar + 1,
    mfe_r: r3(Math.max(mfe, R(price))), mae_r: r3(Math.min(mae, R(price))), protected_at: protectedAt, sl_moves: slMoves, tp_moves: tpMoves, band
  });
  // The 5m ATR from the 15m bars closed by then; the 5m swing from the last 15 minutes of bars.
  const m15 = (atrBars ?? bars).filter((b) => spanMs(b) === M15);
  let a = -1;
  const atr5At = (t) => { while (a + 1 < m15.length && toMs(m15[a + 1].close_time) <= t) a += 1; const v = a >= 1 ? atrAt(m15, a) : null; return v ? v / Math.sqrt(3) : null; };
  const swingAt = (k, t) => { let lo = bars[k].low, hi = bars[k].high; for (let j = k - 1; j >= 0 && toMs(bars[j].close_time) > t - M15; j--) { lo = Math.min(lo, bars[j].low); hi = Math.max(hi, bars[j].high); } return { lo, hi }; };
  // A decision counts from when it was made (at_ms), not from its bar's close.
  const known = (x) => (finite(x.at_ms) ? x.at_ms : x.close_ms);
  let d = -1;
  for (let k = e.bar; k < bars.length; k++) {
    const b = bars[k], closeMs = toMs(b.close_time);
    if (closeMs > now) break;
    // A later bar that opens beyond a level exits at the open (a gap); within the bar, the stop first.
    if (k > e.bar && dir * (b.open - sl) <= 0) return out("stop", b.open, b, k);
    if (k > e.bar && dir * (b.open - tp) >= 0) return out("target", b.open, b, k);
    const adverse = buy ? b.low : b.high, favorable = buy ? b.high : b.low;
    mae = Math.min(mae, R(adverse)); mfe = Math.max(mfe, R(favorable));
    if (dir * (adverse - sl) <= 0) return out(protectedAt ? "sl_plus" : "stop", sl, b, k);
    if (dir * (favorable - tp) >= 0) return out(tpMoves ? "trailed_target" : "target", tp, b, k);
    if (closeMs - fillMs >= holdMaxMs) return out("time", b.close, b, k);
    while (d + 1 < decisions.length && known(decisions[d + 1]) <= closeMs) d += 1;
    const dec = d >= 0 ? decisions[d] : null;
    if (!dec) continue;
    if (dec.close_ms > ownClose && (dec.stance === "BUY" || dec.stance === "SELL") && dec.stance !== signal.side) return out("opposite", b.close, b, k);
    const sym = { digits: 2, point: 0.01, spread_points: Math.round(OMEGA_SIM.spread / 0.01), stops_level_points: 0, bid: b.close, ask: b.close + OMEGA_SIM.spread };
    const power = finite(dec.power) ? Math.max(-1, Math.min(1, dec.power)) : 0;
    // Execution per the strategy agents, exactly as Omega runs it (strategyExits): the trade's agent is its own
    // decision's (trade.agent); without one, the default agent's.
    let extend = true;
    if (dec.strategy_execution === true) {
      const position = { ticket: 1, side: signal.side, open_price: fill, sl, tp, source: "omega", intent_id: "open:ledger" };
      const flat = { strategy_execution: true, power, power_ms: dec.close_ms, agent_conf: flatConfidences(dec.agent_confidence), agent_conf_prev: flatConfidences(dec.agent_confidence_prev) };
      const ex = strategyExits({ positions: [position], signal: flat, sym, agents: signal.agent ? { "open:ledger": signal.agent } : {}, now: closeMs });
      const exit = ex.intents[0];
      if (exit) return out(exit.reason, buy ? sym.bid : sym.ask, b, k);
      extend = ex.extendOf(position);
    }
    if (!dec.levels?.length) continue;
    const swing = swingAt(k, closeMs);
    const sig = { power, power_ms: finite(dec.power) ? dec.close_ms : 0, m5_atr: atr5At(closeMs), m5_swing_low: swing.lo, m5_swing_high: swing.hi };
    const plan = keyLevelPlan({ position: { side: signal.side, open_price: fill, sl, tp }, sym, signal: sig, levels: dec.levels, now: closeMs, extend });
    band = plan.band;
    if (plan.close) return out("power_reversal", buy ? sym.bid : sym.ask, b, k);
    if (plan.sl != null) { sl = plan.sl; slMoves += 1; if (!protectedAt && isProtected({ side: signal.side, open_price: fill, sl })) protectedAt = b.close_time; }
    if (plan.tp != null) { tp = plan.tp; tpMoves += 1; }
  }
  const last = bars.filter((b) => toMs(b.close_time) <= now).at(-1);
  return { omega_status: "open", size: r3(size), filled_at: e.filled_at, open_r: last ? R(last.close) : 0, protected_at: protectedAt, sl_moves: slMoves, tp_moves: tpMoves, mfe_r: r3(mfe), mae_r: r3(mae), band };
}

/**
 * Pure: the account gate of Omega at `fillMs`, in R, from the other Omega trades (rows with
 * omega_status, filled_at/closed_at of the Omega policy, r_omega, size and protected_at). The day's
 * loss limit is max_daily_loss_pct / risk_pct R (2 % / 2 % = 1R); the budget left caps the size.
 */
export function omegaGate({ side, fillMs, others = [], settings = OMEGA_DEFAULTS }) {
  const limitR = Number(settings.max_daily_loss_pct) / Number(settings.risk_pct);
  if (!(limitR > 0)) return { code: "settings" };
  const dayStart = brokerDayStart(fillMs);
  let realized = 0, openRisk = 0, open = 0, sameUnprotected = false;
  for (const o of others) {
    const filled = toMs(o.filled_at), closed = toMs(o.closed_at), size = finite(o.size) ? o.size : 1;
    if (!finite(filled) || filled >= fillMs) continue;
    if (finite(closed) && closed <= fillMs) { if (closed >= dayStart && finite(o.r)) realized += o.r * size; continue; }
    const prot = finite(toMs(o.protected_at)) && toMs(o.protected_at) <= fillMs;
    open += 1;
    if (!prot) openRisk += size;
    if (o.side === side && !prot) sameUnprotected = true;
  }
  if (realized <= -limitR + 1e-9) return { code: "daily_loss_limit" };
  if (open >= (Number(settings.max_positions) || 1)) return { code: "max_positions" };
  if (sameUnprotected) return { code: "same_side_unprotected" };
  const left = limitR + realized - openRisk;
  if (!(left > 0.01)) return { code: "daily_risk_budget" };
  return { size: r3(Math.min(1, left)) };
}

/** Pure: performance of closed, filled signals under one policy ("tp1" or "tp2"). */
export function performance(items, policy = "tp1") {
  // The Omega policy closes on its own clock (omega_closed_at) and its R is sized by the day's budget. v4 ("omega4")
  // counts each trade in its own R: the lot planIntents sized is the trade's risk, and R is the unit of the live parity.
  const omega = policy === "omega", v4 = policy === "omega4";
  const key = policy === "tp2" ? "r_tp2" : "r_tp1";
  const rOf = (x) => (v4 ? x.r_omega4 : omega ? r3(x.r_omega * (finite(x.omega_size) ? x.omega_size : 1)) : x[key]);
  const at = (x) => (v4 ? x.omega4_closed_at : omega ? x.omega_closed_at : x.closed_at);
  const closed = items.filter((x) => (v4 ? x.omega4_status === "closed" && finite(x.r_omega4) : omega ? x.omega_status === "closed" && finite(x.r_omega) : x.status === "closed" && finite(x[key]))).sort((a, b) => toMs(at(a)) - toMs(at(b)));
  const rs = closed.map(rOf);
  const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r < 0);
  let cum = 0, peak = 0, maxDd = 0;
  const equity = closed.map((x, i) => { cum += rs[i]; peak = Math.max(peak, cum); maxDd = Math.max(maxDd, peak - cum); return { t: at(x), r: r3(cum), id: x.id }; });
  const sumWin = wins.reduce((a, b) => a + b, 0), sumLoss = -losses.reduce((a, b) => a + b, 0);
  return {
    policy, trades: rs.length, wins: wins.length, losses: losses.length,
    win_rate: rs.length ? r3(wins.length / rs.length) : null,
    avg_win_r: wins.length ? r3(sumWin / wins.length) : null, avg_loss_r: losses.length ? r3(-sumLoss / losses.length) : null,
    expectancy_r: rs.length ? r3(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
    total_r: r3(cum), profit_factor: sumLoss > 0 ? r3(sumWin / sumLoss) : null,
    max_drawdown_r: r3(maxDd), equity
  };
}

/** Pure: the Omega policy of the decision rows in `list`: its performance, exits and gates. */
function omegaBlock(list) {
  const rows = list.filter((x) => x.source === "decision" && x.omega_status);
  const tally = (key, pick) => { const o = {}; for (const x of rows.filter(pick)) { const k = x[key] || "unknown"; o[k] = (o[k] || 0) + 1; } return o; };
  const both = rows.filter((x) => x.omega_status === "closed" && finite(x.r_omega) && x.status === "closed" && finite(x.r_tp1));
  return {
    ...performance(rows, "omega"),
    pending: rows.filter((x) => x.omega_status === "pending").length, open: rows.filter((x) => x.omega_status === "open").length,
    exits: tally("omega_exit", (x) => x.omega_status === "closed"), skipped: tally("omega_gate", (x) => x.omega_status === "skipped"),
    // The same signals under both policies: what Omega's management did against holding to the plan's target.
    paired: { trades: both.length, omega_r: r3(both.reduce((a, x) => a + x.r_omega, 0)), plan_r: r3(both.reduce((a, x) => a + x.r_tp1, 0)), omega_better: both.filter((x) => x.r_omega > x.r_tp1 + 1e-9).length, plan_better: both.filter((x) => x.r_tp1 > x.r_omega + 1e-9).length }
  };
}

/**
 * Pure: the v4 policy (src/ledger-omega4.mjs) of the v4 rows `v4` (D1 ledger_omega4: every BUY/SELL decision the replay
 * saw, the ones the ledger's own no-stacking rule held back included), paired with v3 on the ledger rows `list` both
 * policies closed.
 */
function omega4Block(v4, list) {
  const tally = (key, pick) => { const o = {}; for (const x of v4.filter(pick)) { const k = x[key] || "unknown"; o[k] = (o[k] || 0) + 1; } return o; };
  const both = list.filter((x) => x.source === "decision" && x.omega_status === "closed" && finite(x.r_omega) && x.omega4_status === "closed" && finite(x.r_omega4));
  return {
    ...performance(v4, "omega4"),
    decisions: v4.length, pending: v4.filter((x) => x.omega4_status === "pending").length, open: v4.filter((x) => x.omega4_status === "open").length,
    exits: tally("omega4_exit", (x) => x.omega4_status === "closed"), skipped: tally("omega4_gate", (x) => x.omega4_status === "skipped"),
    in_ledger: v4.filter((x) => x.in_ledger).length,
    // The same ledger signals under v3 and v4 (v3 R sized by its budget, v4 in its own R).
    paired: { trades: both.length, v4_r: r3(both.reduce((a, x) => a + x.r_omega4, 0)), v3_r: r3(both.reduce((a, x) => a + x.r_omega * (finite(x.omega_size) ? x.omega_size : 1), 0)), v4_better: both.filter((x) => x.r_omega4 > x.r_omega * (finite(x.omega_size) ? x.omega_size : 1) + 1e-9).length, v3_better: both.filter((x) => x.r_omega * (finite(x.omega_size) ? x.omega_size : 1) > x.r_omega4 + 1e-9).length }
  };
}

/**
 * Pure: one decision under both entries, maker (the limit policy, limit_*) against taker (v4, omega4_*), or null while
 * either is still undecided or neither traded. A missed or skipped side counts 0R: in limit mode a missed limit is a
 * missed trade (RFC §3), so the pair says what the entry style cost or saved on that signal.
 */
export function makerTaker(row) {
  const makerFinal = row?.limit_status === "closed" || row?.limit_status === "missed" || row?.limit_status === "skipped";
  const takerFinal = row?.omega4_status === "closed" || row?.omega4_status === "skipped";
  if (!makerFinal || !takerFinal) return null;
  const makerTraded = row.limit_status === "closed" && finite(row.r_limit), takerTraded = row.omega4_status === "closed" && finite(row.r_omega4);
  if (!makerTraded && !takerTraded) return null;
  const maker = makerTraded ? row.r_limit : 0, taker = takerTraded ? row.r_omega4 : 0, dr = r3(maker - taker);
  return { maker_r: r3(maker), taker_r: r3(taker), dr, better: dr > 1e-9 ? "maker" : dr < -1e-9 ? "taker" : "even", both_traded: makerTraded && takerTraded };
}

/** Pure: the limit entry's fill, misses and R on ledger_omega4 rows, and the pairs against v4's market entry (makerTaker). */
export function limitStats(rows) {
  const list = rows.filter((x) => typeof x?.limit_status === "string");
  const count = (s) => list.filter((x) => x.limit_status === s).length;
  const tally = (status) => { const o = {}; for (const x of list.filter((x) => x.limit_status === status)) { const k = x.limit_gate || "unknown"; o[k] = (o[k] || 0) + 1; } return o; };
  const filled = count("open") + count("closed"), missed = count("missed");
  const missedBy = tally("missed");
  const pairs = list.map(makerTaker).filter(Boolean);
  const sum = (k) => r3(pairs.reduce((a, p) => a + p[k], 0));
  return {
    decisions: list.length, pending: count("pending"), resting: count("resting"), filled, open: count("open"), missed,
    placed: filled + count("resting") + missed - (missedBy.limit_through_price || 0) - (missedBy.zone_passed || 0) - (missedBy.zone_tight || 0) - (missedBy.zone_rr || 0) - (missedBy.limit_out_of_band || 0),
    fill_rate: filled + missed ? r3(filled / (filled + missed)) : null,
    missed_by: missedBy, skipped: tally("skipped"),
    paired: { n: pairs.length, both_traded: pairs.filter((p) => p.both_traded).length, maker_better: pairs.filter((p) => p.better === "maker").length, taker_better: pairs.filter((p) => p.better === "taker").length, even: pairs.filter((p) => p.better === "even").length, maker_r: sum("maker_r"), taker_r: sum("taker_r"), mean_dr: pairs.length ? r3(pairs.reduce((a, p) => a + p.dr, 0) / pairs.length) : null }
  };
}

/** Pure: the limit policy of the v4 rows (D1 ledger_omega4 with its limit_* columns): limitStats with its performance. */
function limitBlock(v4) {
  const perf = performance(v4.map((x) => ({ omega4_status: x.limit_status, r_omega4: x.r_limit, omega4_closed_at: x.limit_closed_at })), "omega4");
  return { ...perf, policy: "limit", ...limitStats(v4), exits: (() => { const o = {}; for (const x of v4.filter((x) => x.limit_status === "closed")) { const k = x.limit_exit || "unknown"; o[k] = (o[k] || 0) + 1; } return o; })() };
}

/** The limit policy's rules, said in the view and in the execution report (no price). */
export const OMEGA_LIMIT_RULES = Object.freeze({
  version: OMEGA_LIMIT_VERSION,
  placement: "a resting limit at the decision's level (feed scale, basis 0), placed at the first minute planIntents' gates pass, sized by planIntents as if filled at the limit; filled when a 1m bar's range reaches it (a BUY when the ask's low does, a SELL when the bid's high does); never a market fallback",
  missed: "limit_through_price (price already through the level at placement, with no entry zone), zone_passed (price through the whole entry zone, EZ1), zone_tight (a limit moved inside the entry zone keeps under half the plan's risk), zone_rr (a limit moved inside the entry zone pays under 1R), limit_out_of_band (further than placement_band x the plan's stop from price), pending_expired (max_pending_life minutes), decision_against, quorum_share_drop (its side's quorum share fell by more than cancel_share_drop from the placing decision), blackout, daily_loss_limit, profile_downgrade, kill, paused",
  management: "after the fill exactly v4: planIntents, the TP ladder and the Position Manager on the same simulated account (replayOmega4 with the limit entry policy)",
  knobs: "per mode, the RFC's start values clamped to ADR-0020 A7's bounds: max_pending_life 30/60/240/60 minutes (scalp/intraday/swing/range), move_max_atr 0.25/0.5/0.5/0.25 (recorded; no council moves in a replay), cancel_share_drop 0.05, placement_band 0.35; no platform reader of omega.limit_* yet",
  pairing: "per decision, maker (limit) against taker (v4's market entry); a missed or skipped side counts 0R; pairs only once both are final and at least one traded",
  one_order: "one resting order at a time: a second signal while one rests is pending_order_exists",
  not_modelled: "the council's place, keep and move; the Decision Engine veto and disarm; the fill-time re-check of the hard guards"
});

/** The v4 rules and their approximations, said in the view (owner: "pastikan omega performance sama dengan omega yang live sekarang"). */
export const OMEGA4_RULES = Object.freeze({
  version: OMEGA4_VERSION,
  engine: "the live functions themselves: eaSignalFromDecision and managementFields (the signal), planIntents (every gate and every management step in the live order), positionFacts and positionAction (the Position Manager), reentryGate, the TP ladder and its lock, the profile's risk caps",
  account: "one simulated account over every Decision Engine BUY/SELL, the ledger's held-back signals included; the live USD account's profile at that time (omega_profile_changes) and its balance rebuilt from its deals; without a live account the current profile and a 1000 USD start",
  unit: "R per trade: realised P/L over the risk at the open (|entry - stop| x the volume at the open); partials count their share; size 1 (the lot's risk share of the profile target is kept in omega4_json)",
  granularity: "1m: planIntents at each minute's open (live syncs every 5 s), the broker's stop and target inside the minute (stop first; a SELL closes at the ask), the Position Manager at 3 minutes past each 5m close (live about 2.5)",
  approximations: [
    "the feed's 1m bars instead of the broker's, with a fixed 0.2 spread and the key levels on the feed's scale (basis 0)",
    "1m granularity instead of 5 s syncs: an entry or a lock inside a minute waits for the next minute's open",
    "the Position Council's recorded verdict for that position and 5m bar where the live account had one, else no answer: the mechanical fallback (locks apply, nothing is cut or closed on weakening)",
    "the M15 ATR (atr_value), the 5m structure (structureOf) and the ladder's closed candles rebuilt from the feed's 1m bars",
    "the Omega settings as stored now (their history is not kept); the engine switch and the live arm taken as on; the EA control (pause, kill) from ea_control_events; the news blackout from the week's calendar",
    "the account's balance rebuilt from its last known balance and its deals: deposits, withdrawals and the owner's daily-loss resets are not told apart"
  ],
  not_reconstructable: {
    strategy_arm: "the arm state as it is now, applied to every replayed decision (its history is not stored)",
    grid_choice: "the grid's current choices (GRID_ADAPT_MODE live), applied to every replayed decision",
    cell_gate: "the range strategies' H4/D1 cell gate is not stored: their decisions are not traded (cell_gate_unreconstructable)",
    probation: "follows the cell gate: no probation trade is replayed",
    broker_5m_trigger: "the broker's 5m Prophet confirmations are not stored: m5_ready is false, so no opposite_5m close, and a market entry still waiting for its confirmation is not traded (entry_trigger_unreconstructable)",
    news_blackout: "from the cached week's calendar (High-impact USD, the blackout window in force); outside that week none",
    kill_switch: "Omega's control history only; EA_SIGNALS_ENABLED is read as never off"
  },
  bars: "the feed's 1m bars from KV (about two days), and before that from the D1 archive ledger_bars_1m (each run appends only the new minutes, 120 days kept), so a replay stays reproducible",
  run: "from the checkpoint (the whole replay state at its next minute), at most 720 replay minutes a 5-minute run; a longer catch-up goes on at the next run",
  parity: "omegaParity against the live USD account: only the live trades opened under the current engine and Position Manager code count (its era, from the code's hash; a later change starts a new window at its deploy); at least 20 of them, else insufficient; passes with the same exit on at least 90 % of the trades compared and a mean |dR| of at most 0.1; the trades since 2026-11-19 12:00 UTC under earlier code are shown apart, not counted"
});

/** Pure: the ledger view of `items` (rows of signal_ledger, with their outcome fields) and `omega4` (D1 ledger_omega4 rows). */
export function ledgerView(items, { days, omega4 = [] } = {}) {
  const by = (source) => items.filter((x) => source == null || x.source === source);
  const ledgerIds = new Set(items.map((x) => x.id));
  const v4All = omega4.map((x) => ({ ...x, in_ledger: ledgerIds.has(`decision:${x.decision_key}`) }));
  const block = (list, v4 = []) => {
    const count = (s) => list.filter((x) => x.status === s).length;
    const cancelled = {};
    for (const x of list.filter((x) => x.status === "cancelled")) cancelled[x.exit_reason] = (cancelled[x.exit_reason] || 0) + 1;
    const filled = list.filter((x) => x.filled_at).length;
    return {
      signals: list.length, pending: count("pending"), open: count("open"), closed: count("closed"), cancelled,
      fill_rate: list.length - count("pending") ? r3(filled / (list.length - count("pending"))) : null,
      ambiguous: list.filter((x) => x.ambiguous).length,
      sl_plus: list.filter((x) => x.sl_plus_triggered).length,
      tp1: performance(list, "tp1"), tp2: performance(list.filter((x) => finite(x.tp2)), "tp2"),
      omega: omegaBlock(list),
      omega4: omega4Block(v4, list),
      limit: limitBlock(v4)
    };
  };
  const decisions = by("decision");
  return {
    version: LEDGER_VERSION, window_days: days,
    rules: {
      fill_window_hours: FILL_WINDOW_MS / 3600_000, hold_max_hours: HOLD_MAX_MS / 3600_000, same_bar: "stop first (conservative)", unit: "R, never money",
      bars: "1m where the 1m series reaches (about two days), else 15m, else 1H; followed every 5 minutes",
      omega: { version: OMEGA_POLICY_VERSION, entry: "market the minute after the decision (a limit plan waits up to the signal's age for price within 0.35 x the stop distance)", management: "every minute: key levels by quorum power (SL+, trailing TP, close on a reversed power), the opposite decision once made, 72 h; with the strategy execution rules, the lean flip, a winner's agent confidence drop, and the trailing TP only while that confidence holds", gates: "daily loss limit and risk budget in R, max positions, no stacking", approximations: "feed bars, fixed spread, no 5m or adaptive stop, no 5m entry trigger, no scale-out" },
      omega4: OMEGA4_RULES,
      limit: OMEGA_LIMIT_RULES
    },
    all: block(by(null), v4All), by_source: Object.fromEntries(SOURCES.map((s) => [s, block(by(s), s === "decision" ? v4All : [])])),
    by_mode: Object.fromEntries(TRADING_MODES.map((m) => [m, block(decisions.filter((x) => x.trading_mode === m), v4All.filter((x) => x.trading_mode === m))])),
    items: items.slice().sort((a, b) => toMs(b.opened_at) - toMs(a.opened_at)).slice(0, 100)
  };
}

// ---------------------------------------------------------------------------
// D1 persistence.

export const LEDGER_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS signal_ledger (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    candle_key TEXT,
    opened_at TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    entry REAL NOT NULL, stop REAL NOT NULL, tp1 REAL NOT NULL, tp2 REAL,
    progressive_stop REAL,
    confidence REAL, note TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'open', 'closed', 'cancelled')),
    filled_at TEXT, closed_at TEXT, exit_reason TEXT, exit_price REAL,
    r_tp1 REAL, r_tp2 REAL, open_r REAL, mfe_r REAL, mae_r REAL, bars_held INTEGER, ambiguous INTEGER NOT NULL DEFAULT 0,
    sl_plus_triggered INTEGER NOT NULL DEFAULT 0, sl_plus_at TEXT,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_signal_ledger_opened ON signal_ledger(opened_at)",
  "CREATE INDEX IF NOT EXISTS idx_signal_ledger_status ON signal_ledger(status)",
  // The decisions the no-stacking rule held back (owner 2026-11-13: "pastikan semua ada visualisasi"):
  // until then they left no trace, so nobody could see why a BUY or SELL never reached the ledger.
  `CREATE TABLE IF NOT EXISTS signal_ledger_held (
    decision_key TEXT PRIMARY KEY,
    side TEXT NOT NULL,
    held_at TEXT NOT NULL,
    blocking_id TEXT,
    reason TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_signal_ledger_held_at ON signal_ledger_held(held_at)",
  // The v4 Omega policy (src/ledger-omega4.mjs, owner 2026-11-20): one row per Decision Engine BUY/SELL the replay saw,
  // also those the ledger's own no-stacking rule held back (Omega's own rules decide there, as live).
  `CREATE TABLE IF NOT EXISTS ledger_omega4 (
    decision_key TEXT PRIMARY KEY,
    side TEXT NOT NULL,
    issued_ms INTEGER NOT NULL,
    trading_mode TEXT, agent TEXT,
    omega4_status TEXT NOT NULL, omega4_gate TEXT, omega4_filled_at TEXT, omega4_closed_at TEXT, omega4_exit TEXT,
    r_omega4 REAL, omega4_size REAL, omega4_json TEXT,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_ledger_omega4_issued ON ledger_omega4(issued_ms)",
  // The feed's 1m bars the v4 replay reads, kept past the KV series' two days (src/ledger-omega4.mjs archiveMinuteBars).
  "CREATE TABLE IF NOT EXISTS ledger_bars_1m (minute_ms INTEGER PRIMARY KEY, o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL)"
];
/**
 * The limit policy's columns on ledger_omega4 (src/ledger-omega-limit.mjs), added in place: on v4's own row of each
 * decision, so maker and taker pair on one row (makerTaker), and v4's upsert never touches them.
 */
export const LIMIT_COLUMNS = Object.freeze(["regime TEXT", "limit_status TEXT", "limit_gate TEXT", "limit_filled_at TEXT", "limit_closed_at TEXT", "limit_exit TEXT", "r_limit REAL", "limit_json TEXT"]);
/** The Omega policy's columns (src/signal-ledger.mjs simulateOmega), added in place. */
const OMEGA_COLUMNS = ["trading_mode TEXT", "entry_action TEXT", "omega_status TEXT", "omega_gate TEXT", "omega_filled_at TEXT", "omega_closed_at TEXT", "omega_exit TEXT", "r_omega REAL", "omega_size REAL", "omega_json TEXT",
  // v4 (src/ledger-omega4.mjs), on the ledger's own rows beside v3, so the two are paired on the same signals.
  "omega4_status TEXT", "omega4_exit TEXT", "r_omega4 REAL", "omega4_size REAL", "omega4_filled_at TEXT", "omega4_closed_at TEXT", "omega4_json TEXT"];
let schemaReady = false;
export function resetLedgerSchemaCacheForTests() { schemaReady = false; }
export async function ensureLedgerSchema(db) {
  if (schemaReady) return;
  for (const sql of LEDGER_SCHEMA_SQL) await db.prepare(sql).run();
  for (const col of ["progressive_stop REAL", "sl_plus_triggered INTEGER NOT NULL DEFAULT 0", "sl_plus_at TEXT", "tp1_closed_at TEXT", "tp2_closed_at TEXT", "tp2_exit_reason TEXT", ...OMEGA_COLUMNS]) {
    try { await db.prepare(`ALTER TABLE signal_ledger ADD COLUMN ${col}`).run(); } catch { /* exists */ }
  }
  for (const col of LIMIT_COLUMNS) {
    try { await db.prepare(`ALTER TABLE ledger_omega4 ADD COLUMN ${col}`).run(); } catch { /* exists */ }
  }
  schemaReady = true;
}

async function series(env, interval) {
  try {
    const r = JSON.parse((await env.SIGNAL_CACHE?.get?.(`market-data:v2:series:OANDA:XAUUSD|${interval}`)) || "null");
    return (Array.isArray(r?.candles) ? r.candles : []).filter((c) => [c.high, c.low, c.close].every(finite) && c.open_time && c.close_time)
      .sort((a, b) => toMs(a.open_time) - toMs(b.open_time));
  } catch { return []; }
}

/**
 * Pure: one bar series of the finest bars available at each time, oldest first: 1m bars where the 1m
 * series reaches (about two days), 15m bars before them, 1H bars before those (owner 2026-11-12: "ya
 * kerjakan keduanya" — entries and exits at the minute they happen, not at the 15m close).
 */
export function stitchBars({ m1 = [], m15 = [], h1 = [] } = {}) {
  const m1Start = m1.length ? toMs(m1[0].open_time) : Infinity;
  const m15Part = m15.filter((b) => toMs(b.close_time) <= m1Start);
  const m15Start = m15Part.length ? toMs(m15Part[0].open_time) : m1Start;
  return [...h1.filter((b) => toMs(b.close_time) <= m15Start), ...m15Part, ...m1];
}

/** The ledger's bars ({ bars: stitched 1m, 15m and 1H; m15: the 15m bars for the ATR }). */
export async function ledgerSeries(env) {
  const [m1, m15, h1] = await Promise.all([series(env, "1m"), series(env, "15m"), series(env, "1h")]);
  return { bars: stitchBars({ m1, m15, h1 }), m15 };
}

/** The stitched closed bars (1m, then 15m, then 1H further back). */
export async function ledgerBars(env) {
  return (await ledgerSeries(env)).bars;
}

const insertSql = "INSERT OR IGNORE INTO signal_ledger (id, source, candle_key, opened_at, side, entry, stop, tp1, tp2, progressive_stop, confidence, note, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)";

/** New H1 Reasoner BUY/SELL decisions since `sinceIso` (each candle once). */
export async function ingestH1Decisions(env, { sinceIso, now = Date.now() }) {
  const rows = (await env.DB.prepare("SELECT candle_key, decision, confidence, entry_price, stop_loss, take_profit, created_at FROM trade_decisions WHERE decision IN ('BUY', 'SELL') AND created_at >= ? ORDER BY id").bind(sinceIso.replace("T", " ").slice(0, 19)).all()).results || [];
  let added = 0;
  for (const r of rows) {
    const s = { side: r.decision, entry: r.entry_price, stop: r.stop_loss, tp1: r.take_profit, tp2: null };
    if (!validSignal(s)) continue;
    const res = await env.DB.prepare(insertSql).bind("h1_decision:" + r.candle_key, "h1_decision", r.candle_key, iso(toMs(r.created_at)), s.side, s.entry, s.stop, s.tp1, null, null, r.confidence ?? null, null, iso(now)).run();
    added += Number(res?.meta?.changes) || 0;
  }
  return added;
}

/** The strategy engine's TRIGGERED setup, once per H1 bar, and only without an open one of the same side. */
export async function ingestStrategy(env, strategy, { now = Date.now() } = {}) {
  const plan = strategy?.plan;
  if (!plan || (strategy.decision !== "BUY" && strategy.decision !== "SELL")) return 0;
  const s = { side: strategy.decision, entry: plan.entry, stop: plan.stop, tp1: plan.tp1, tp2: plan.tp2 ?? null };
  if (!validSignal(s)) return 0;
  const live = await env.DB.prepare("SELECT COUNT(*) AS n FROM signal_ledger WHERE source = 'strategy' AND side = ? AND status IN ('pending', 'open')").bind(s.side).first();
  if (Number(live?.n) > 0) return 0;
  const hour = Math.floor(now / 3600_000) * 3600_000;
  const res = await env.DB.prepare(insertSql).bind(`strategy:${iso(hour)}`, "strategy", strategy.h1_chain?.candle_key ?? null, iso(now), s.side, s.entry, s.stop, s.tp1, s.tp2, finite(plan.progressive_stop) ? plan.progressive_stop : null, finite(strategy.confidence) ? r3(strategy.confidence) : null, String(strategy.headline ?? "").slice(0, 300), iso(now)).run();
  return Number(res?.meta?.changes) || 0;
}

/**
 * A Decision Engine BUY or SELL (src/decision-engine.mjs), once per 15m key, and only without an open
 * decision of the same side. TP1 is the chosen target; TP2 the other one when it lies beyond it.
 */
export async function ingestDecision(env, d, { now = Date.now() } = {}) {
  const t = d?.trade;
  if (!t || (d.stance !== "BUY" && d.stance !== "SELL") || t.side !== d.stance) return 0;
  const dir = d.stance === "BUY" ? 1 : -1;
  const other = t.target === "tp1" ? t.tp2 : null;
  const s = { side: d.stance, entry: t.entry, stop: t.stop, tp1: t.tp, tp2: finite(other) && dir * (other - t.tp) > 0 ? other : null };
  if (!validSignal(s)) return 0;
  // No stacking, as Omega (owner 2026-11-13, "setuju"): a row on the same side holds new signals back only
  // while it waits for its fill or is open and unprotected. A row past TP1 (still followed to TP2) or with
  // its stop at break-even (SL+) no longer does: on 2026-11-12 one such row held back every SELL for 10 hours.
  const live = await env.DB.prepare("SELECT id, status FROM signal_ledger WHERE source = 'decision' AND side = ? AND (status = 'pending' OR (status = 'open' AND tp1_closed_at IS NULL AND COALESCE(sl_plus_triggered, 0) = 0)) ORDER BY opened_at DESC LIMIT 1").bind(s.side).first();
  if (live?.id) {
    const reason = live.status === "pending" ? "an earlier signal of the same side still waits for its fill" : "an earlier signal of the same side is open and not yet protected (no TP1, no SL+)";
    await env.DB.prepare("INSERT OR IGNORE INTO signal_ledger_held (decision_key, side, held_at, blocking_id, reason) VALUES (?, ?, ?, ?, ?)").bind(String(d.decision_key), s.side, d.decided_at ?? iso(now), String(live.id), reason).run();
    return 0;
  }
  const res = await env.DB.prepare(insertSql).bind(`decision:${d.decision_key}`, "decision", d.decision_key, d.decided_at ?? iso(now), s.side, s.entry, s.stop, s.tp1, s.tp2, finite(t.progressive_stop) ? t.progressive_stop : null, finite(d.confidence) ? r3(d.confidence) : null, String(d.summary ?? "").slice(0, 300), iso(now)).run();
  const added = Number(res?.meta?.changes) || 0;
  // The Omega policy follows the decision's trading mode and entry type.
  if (added) await env.DB.prepare("UPDATE signal_ledger SET trading_mode = ?, entry_action = ?, omega_status = 'pending' WHERE id = ?").bind(TRADING_MODES.includes(d.trading_mode) ? d.trading_mode : null, t.action === "ENTER_LIMIT" ? "ENTER_LIMIT" : "ENTER_MARKET", `decision:${d.decision_key}`).run();
  return added;
}

/** The engine's decisions from `sinceIso` on, oldest first, with what Omega's management reads. */
export async function loadDecisionStream(env, sinceIso) {
  let rows = [];
  try {
    rows = (await env.DB.prepare("SELECT decision_key, stance, decided_at, json_extract(decision_json, '$.quorum.score') AS power, json_extract(decision_json, '$.key_levels') AS levels, json_extract(decision_json, '$.trading_mode') AS mode, json_extract(decision_json, '$.trade.action') AS action, json_extract(decision_json, '$.trade.agent') AS agent, json_extract(decision_json, '$.strategy_execution') AS sx, json_extract(decision_json, '$.agent_confidence') AS conf, json_extract(decision_json, '$.agent_confidence_prev') AS conf_prev FROM engine_decisions WHERE bar_close >= ? ORDER BY bar_close").bind(sinceIso).all()).results || [];
  } catch { return []; }
  return rows.map((r) => ({ key: r.decision_key, close_ms: decisionCloseMs(r.decision_key), at_ms: finite(toMs(r.decided_at)) ? toMs(r.decided_at) : null, stance: r.stance, power: r.power == null || !Number.isFinite(Number(r.power)) ? null : Number(r.power), levels: decisionLevels(r.levels), mode: TRADING_MODES.includes(r.mode) ? r.mode : null, action: r.action ?? null,
    agent: typeof r.agent === "string" && r.agent ? r.agent : null, strategy_execution: r.sx === 1 || r.sx === true, agent_confidence: parseJson(r.conf), agent_confidence_prev: parseJson(r.conf_prev) }))
    .filter((d) => finite(d.close_ms)).sort((a, b) => a.close_ms - b.close_ms);
}

async function omegaSettings(env) {
  try {
    const row = await env.DB.prepare("SELECT settings FROM omega_settings WHERE id = 1").first();
    return { ...OMEGA_DEFAULTS, ...(row?.settings ? JSON.parse(row.settings) : {}) };
  } catch { return { ...OMEGA_DEFAULTS }; }
}

const parseJson = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
const bookOf = (r) => { const j = parseJson(r.omega_json) || {}; return { id: r.id, side: r.side, filled_at: r.omega_filled_at ?? null, closed_at: r.omega_closed_at ?? null, r: r.r_omega ?? null, size: r.omega_size ?? null, protected_at: j.protected_at ?? null }; };

/**
 * The Omega policy of the decision rows `rows` (oldest first) on the closed 15m bars. Each trade's
 * account gate is decided once, at its fill, from the other Omega trades, and kept in omega_json.
 */
export async function evaluateOmega(env, rows, bars, { now = Date.now(), m15 = null } = {}) {
  if (!rows.length) return 0;
  const atrBars = m15 ?? bars.filter((b) => spanMs(b) === M15);
  const since = Math.min(...rows.map((r) => toMs(r.opened_at)).filter(finite));
  if (!finite(since)) return 0;
  const decisions = await loadDecisionStream(env, iso(since - 2 * M15));
  const settings = await omegaSettings(env);
  const ctx = (await env.DB.prepare("SELECT id, side, omega_filled_at, omega_closed_at, r_omega, omega_size, omega_json FROM signal_ledger WHERE source = 'decision' AND omega_filled_at IS NOT NULL AND omega_filled_at >= ?").bind(iso(brokerDayStart(since) - HOLD_MAX_MS)).all()).results || [];
  const book = new Map(ctx.map((r) => [r.id, bookOf(r)]));
  const byKey = new Map(decisions.map((d) => [d.key, d]));
  let changed = 0;
  for (const s of rows.slice().sort((a, b) => toMs(a.opened_at) - toMs(b.opened_at))) {
    const own = byKey.get(s.candle_key);
    const sig = { ...s, trading_mode: s.trading_mode || own?.mode || null, entry_action: s.entry_action || own?.action || null, agent: own?.agent ?? null };
    const stored = parseJson(s.omega_json);
    let gate = stored?.gate ?? null;
    if (!gate) {
      const e = omegaEntry(sig, bars, { now, maxAgeMs: settings.max_signal_age_ms });
      if (e.status === "filled") gate = omegaGate({ side: s.side, fillMs: toMs(e.filled_at), others: [...book.values()].filter((o) => o.id !== s.id), settings });
    }
    const o = simulateOmega(sig, bars, { decisions, gate, now, atrBars, maxAgeMs: settings.max_signal_age_ms });
    const traded = o.omega_status === "open" || o.omega_status === "closed";
    book.set(s.id, { id: s.id, side: s.side, filled_at: traded ? o.filled_at : null, closed_at: o.omega_status === "closed" ? o.closed_at : null, r: o.r ?? null, size: o.size ?? null, protected_at: o.protected_at ?? null });
    const json = { gate, protected_at: o.protected_at ?? null, sl_moves: o.sl_moves ?? 0, tp_moves: o.tp_moves ?? 0, mfe_r: o.mfe_r ?? null, mae_r: o.mae_r ?? null, open_r: o.open_r ?? null, band: o.band ?? null, bars: o.bars ?? null };
    await env.DB.prepare("UPDATE signal_ledger SET trading_mode = ?, entry_action = ?, omega_status = ?, omega_gate = ?, omega_filled_at = ?, omega_closed_at = ?, omega_exit = ?, r_omega = ?, omega_size = ?, omega_json = ?, updated_at = ? WHERE id = ?")
      .bind(sig.trading_mode, sig.entry_action, o.omega_status, o.gate ?? null, traded ? o.filled_at : null, o.omega_status === "closed" ? o.closed_at : null, o.exit ?? null, o.omega_status === "closed" ? o.r : null, traded ? o.size : null, JSON.stringify(json), iso(now), s.id).run();
    if (o.omega_status !== s.omega_status) changed += 1;
  }
  return changed;
}

/** Re-simulates every pending or open signal on the latest closed bars. */
export async function evaluateOpenSignals(env, { now = Date.now(), bars = null, m15 = null } = {}) {
  const live = (await env.DB.prepare("SELECT * FROM signal_ledger WHERE status IN ('pending', 'open')").all()).results || [];
  const loaded = bars ? { bars, m15 } : await ledgerSeries(env);
  const closed = loaded.bars;
  // The Omega policy: live decision trades, and decisions from before it existed while their bars are
  // still in the 15m or 1m series (omega_status NULL), once.
  const firstM15 = closed.find((b) => spanMs(b) <= M15);
  const omegaRows = (await env.DB.prepare("SELECT * FROM signal_ledger WHERE source = 'decision' AND (omega_status IN ('pending', 'open') OR (omega_status IS NULL AND opened_at >= ?))").bind(firstM15 ? firstM15.open_time : iso(now)).all()).results || [];
  if (!live.length && !omegaRows.length) return 0;
  let changed = 0;
  for (const s of live) {
    const o = simulateSignal(s, closed, { now });
    await env.DB.prepare("UPDATE signal_ledger SET status = ?, filled_at = ?, closed_at = ?, exit_reason = ?, exit_price = ?, r_tp1 = ?, r_tp2 = ?, open_r = ?, mfe_r = ?, mae_r = ?, bars_held = ?, ambiguous = ?, sl_plus_triggered = ?, sl_plus_at = ?, tp1_closed_at = ?, tp2_closed_at = ?, tp2_exit_reason = ?, updated_at = ? WHERE id = ?")
      .bind(o.status, o.filled_at ?? null, o.closed_at ?? null, o.exit_reason ?? null, o.exit_price ?? null, o.r_tp1 ?? null, o.r_tp2 ?? null, o.open_r ?? null, o.mfe_r ?? null, o.mae_r ?? null, o.bars_held ?? null, o.ambiguous ? 1 : 0, o.sl_plus_triggered ? 1 : 0, o.sl_plus_at ?? null, o.tp1_closed_at ?? null, o.tp2_closed_at ?? null, o.tp2_exit_reason ?? null, iso(now), s.id).run();
    if (o.status !== s.status) changed += 1;
  }
  try { changed += await evaluateOmega(env, omegaRows, closed, { now, m15: loaded.m15 }); } catch (e) { console.error("ledger_omega_failed", String(e?.message ?? e).slice(0, 200)); }
  return changed;
}

/**
 * v4 (src/ledger-omega4.mjs): the replay from its last flat minute to now on the 1m bars, then the parity check against
 * the live account at most once an hour. Loaded on demand (it pulls the live engine's modules in). Never throws.
 */
export async function runOmega4Step(env, { now = Date.now(), bars = null } = {}) {
  try {
    const v4 = await import("./ledger-omega4.mjs");
    const shared = {};
    const replay = await v4.runOmega4(env, { now, bars, shared });
    const parity = await v4.runOmegaParity(env, { now });
    // SLG1's brake (read-only, one Telegram line per gate era at most), with the hourly parity check.
    const brake = parity?.status === "checked" ? await v4.runProfitLockBrake(env, { now }) : { status: "waits_parity" };
    // CH1's brake (read-only, one Telegram line per change-threshold token and era at most), with it.
    const changeBrake = parity?.status === "checked" ? await v4.runChangeThresholdBrake(env, { now }) : { status: "waits_parity" };
    // The limit entry (src/ledger-omega-limit.mjs): after v4, never past the minute v4 has replayed, within what v4 left
    // of the run's bound (MAX_REPLAY_MINUTES minutes between them), so the run's CPU bound is unchanged.
    let limit = { status: "off" };
    try {
      const lim = await import("./ledger-omega-limit.mjs");
      if (lim.omegaLimitEnabled(env)) limit = await lim.runOmegaLimit(env, { now, bars, shared, maxMinutes: v4.MAX_REPLAY_MINUTES - (Number(replay?.minutes) || 0) });
    } catch (e) { limit = { status: "failed", error: String(e?.message ?? e).slice(0, 200) }; }
    return { replay, parity, limit, brake, change_brake: changeBrake };
  } catch (e) {
    return { replay: { status: "failed", error: String(e?.message ?? e).slice(0, 200) }, parity: null };
  }
}

/** The sweep's ledger step: ingest new signals, then follow every live one. Never fatal. */
export async function runSignalLedger(env, { now = Date.now(), readStrategy = null, h1Decisions = true } = {}) {
  if (!env?.DB) return { status: "unavailable" };
  await ensureLedgerSchema(env.DB);
  const added = { h1_decision: h1Decisions ? await ingestH1Decisions(env, { sinceIso: iso(now - 7 * 86_400_000), now }) : 0, strategy: 0 };
  if (readStrategy) { try { added.strategy = await ingestStrategy(env, await readStrategy(env, { now }), { now }); } catch { added.strategy = 0; } }
  const loaded = await ledgerSeries(env);
  const changed = await evaluateOpenSignals(env, { now, bars: loaded.bars, m15: loaded.m15 });
  const omega4 = omega4Enabled(env) ? await runOmega4Step(env, { now, bars: loaded.bars }) : { replay: { status: "off" }, parity: null };
  return { status: "ok", added, changed, omega4 };
}

/** LEDGER_OMEGA4 "off" stops the v4 replay and its parity check (default on). */
export const omega4Enabled = (env) => String(env?.LEDGER_OMEGA4 ?? "on").trim().toLowerCase() !== "off";

/** GET /api/ledger: the ledger of the last `days` days. */
export async function readLedger(env, { days = 30, now = Date.now() } = {}) {
  await ensureLedgerSchema(env.DB);
  const since = iso(now - days * 86_400_000);
  const rows = (await env.DB.prepare("SELECT * FROM signal_ledger WHERE opened_at >= ? ORDER BY opened_at").bind(since).all()).results || [];
  const held = (await env.DB.prepare("SELECT decision_key, side, held_at, blocking_id, reason FROM signal_ledger_held WHERE held_at >= ? ORDER BY held_at DESC LIMIT 50").bind(since).all()).results || [];
  const heldCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM signal_ledger_held WHERE held_at >= ?").bind(since).first();
  const omega4 = (await env.DB.prepare("SELECT decision_key, side, issued_ms, trading_mode, agent, omega4_status, omega4_gate, omega4_filled_at, omega4_closed_at, omega4_exit, r_omega4, omega4_size, regime, limit_status, limit_gate, limit_filled_at, limit_closed_at, limit_exit, r_limit FROM ledger_omega4 WHERE issued_ms >= ? ORDER BY issued_ms").bind(now - days * 86_400_000).all()).results || [];
  let parity = null;
  try { parity = JSON.parse((await env.SIGNAL_CACHE?.get?.(OMEGA4_PARITY_KEY)) || "null"); } catch { parity = null; }
  return { ...ledgerView(rows.map((r) => ({ ...r, ambiguous: Boolean(r.ambiguous) })), { days, omega4 }), held: { count: Number(heldCount?.n) || 0, items: held }, parity };
}

// ---------------------------------------------------------------------------
// The execution report to Aether (owner 2026-11-12: "Ini digunakan untuk inputan ke aether dan
// selanjutnya akan menjadi knowledge"). Per trading mode, the closed Decision Engine signals under the
// plan's target (tp1) and under the Omega policy, paired on the same signals, and each trade's bar,
// session and R. No price, level, size or money ever leaves: R multiples and times only.

// v2 (2026-11-20, docs/RFC_OMEGA_LIMIT_ENTRY.md stage 2): the top-level `limit` block, the limit entry against v4's
// market entry per mode and regime. Everything v1 carried is unchanged.
export const EXECUTION_REPORT_SCHEMA = "cryptophys.execution-report.v1";
export const EXECUTION_REPORT_DAYS = 30;
export const EXECUTION_REPORT_MAX_TRADES = 400;

const summary = (rs) => {
  const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r < 0);
  const sumWin = wins.reduce((a, b) => a + b, 0), sumLoss = -losses.reduce((a, b) => a + b, 0);
  let cum = 0, peak = 0, dd = 0;
  for (const r of rs) { cum += r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return { trades: rs.length, wins: wins.length, losses: losses.length, win_rate: rs.length ? r3(wins.length / rs.length) : null, expectancy_r: rs.length ? r3(cum / rs.length) : null, total_r: r3(cum), profit_factor: sumLoss > 0 ? r3(sumWin / sumLoss) : null, max_drawdown_r: r3(dd) };
};

/** Keys no report carries at any depth (price wording, size and money; Aether's FORBIDDEN is a superset of the first nine). */
export const REPORT_FORBIDDEN_KEYS = Object.freeze(["entry", "stop", "sl", "tp", "tp1", "tp2", "take_profit", "level", "price", "levels", "prices", "stop_loss", "entry_price", "exit_price", "key_levels", "zones", "lots", "volume", "size_lots", "balance", "equity", "profit", "money"]);
const safeKeys = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [REPORT_FORBIDDEN_KEYS.includes(k) ? `code_${k}` : k, v]));
const closedRs = (list, status, rKey, atKey) => list.filter((x) => x[status] === "closed" && finite(x[rKey])).sort((a, b) => toMs(a[atKey]) - toMs(b[atKey])).map((x) => x[rKey]);
/** Pure: one mode's or regime's limit block of the execution report (R multiples and counts only). */
function limitReportBlock(list) {
  const st = limitStats(list);
  return {
    decisions: st.decisions, placed: st.placed, filled: st.filled, missed: st.missed, resting: st.resting, pending: st.pending, fill_rate: st.fill_rate,
    missed_by: safeKeys(st.missed_by), skipped: safeKeys(st.skipped),
    maker: summary(closedRs(list, "limit_status", "r_limit", "limit_closed_at")), taker: summary(closedRs(list, "omega4_status", "r_omega4", "omega4_closed_at")),
    paired: st.paired
  };
}
/**
 * Pure: the limit entry (src/ledger-omega-limit.mjs, maker) against v4's market entry (taker) per mode and regime, from
 * ledger_omega4 rows issued since `since`. R multiples, counts and reason codes only: no price key at any depth.
 */
export function limitReport(omega4 = [], { since = -Infinity } = {}) {
  const rows = (Array.isArray(omega4) ? omega4 : []).filter((x) => TRADING_MODES.includes(x?.trading_mode) && finite(Number(x.issued_ms)) && Number(x.issued_ms) >= since);
  const modes = {};
  for (const m of TRADING_MODES) {
    const list = rows.filter((x) => x.trading_mode === m);
    const regimes = {};
    const regimeOf = (x) => (typeof x.regime === "string" && x.regime ? x.regime : "unknown");
    for (const g of [...new Set(list.map(regimeOf))].sort()) regimes[REPORT_FORBIDDEN_KEYS.includes(g) ? `code_${g}` : g] = limitReportBlock(list.filter((x) => regimeOf(x) === g));
    modes[m] = { ...limitReportBlock(list), regimes };
  }
  return {
    version: OMEGA_LIMIT_VERSION, knobs_source: "start_values",
    rules: { unit: "R per trade", placement: OMEGA_LIMIT_RULES.placement, missed: OMEGA_LIMIT_RULES.missed, management: OMEGA_LIMIT_RULES.management, pairing: OMEGA_LIMIT_RULES.pairing, fill_rate: "filled / (filled + missed)" },
    modes
  };
}

/** Pure: the execution report of the ledger rows (any source; only Decision Engine rows count) and the ledger_omega4 rows (`omega4`). */
export function executionReport(rows, { now = Date.now(), days = EXECUTION_REPORT_DAYS, omega4 = [] } = {}) {
  const since = now - days * 86_400_000;
  const decisions = rows.filter((x) => x.source === "decision" && TRADING_MODES.includes(x.trading_mode) && toMs(x.opened_at) >= since);
  const trades = decisions
    .filter((x) => (x.status === "closed" && finite(x.r_tp1)) || (x.omega_status === "closed" && finite(x.r_omega)))
    .map((x) => {
      const open = decisionCloseMs(x.candle_key) - M15;
      return {
        chart: "15", bar_open: finite(open) ? iso(open) : null, session: finite(open) ? sessionAt(open) : null,
        mode: x.trading_mode, side: x.side,
        plan_r: x.status === "closed" && finite(x.r_tp1) ? x.r_tp1 : null, plan_exit: x.status === "closed" ? x.exit_reason ?? null : null,
        omega_r: x.omega_status === "closed" && finite(x.r_omega) ? x.r_omega : null, omega_exit: x.omega_status === "closed" ? x.omega_exit ?? null : null,
        omega_size: x.omega_status === "closed" && finite(x.omega_size) ? x.omega_size : null
      };
    })
    .filter((t) => t.bar_open)
    .sort((a, b) => a.bar_open.localeCompare(b.bar_open))
    .slice(-EXECUTION_REPORT_MAX_TRADES);
  const modes = {};
  for (const m of TRADING_MODES) {
    const list = trades.filter((t) => t.mode === m);
    const paired = list.filter((t) => finite(t.plan_r) && finite(t.omega_r));
    const skipped = {};
    for (const x of decisions.filter((x) => x.trading_mode === m && x.omega_status === "skipped")) skipped[x.omega_gate || "unknown"] = (skipped[x.omega_gate || "unknown"] || 0) + 1;
    modes[m] = {
      signals: decisions.filter((x) => x.trading_mode === m).length,
      plan: summary(list.filter((t) => finite(t.plan_r)).map((t) => t.plan_r)),
      omega: summary(list.filter((t) => finite(t.omega_r)).map((t) => r3(t.omega_r * (finite(t.omega_size) ? t.omega_size : 1)))),
      omega_skipped: skipped,
      paired: { trades: paired.length, omega_better: paired.filter((t) => t.omega_r > t.plan_r + 1e-9).length, plan_better: paired.filter((t) => t.plan_r > t.omega_r + 1e-9).length, omega_r: r3(paired.reduce((a, t) => a + t.omega_r, 0)), plan_r: r3(paired.reduce((a, t) => a + t.plan_r, 0)) }
    };
  }
  return {
    schema: EXECUTION_REPORT_SCHEMA, generated_at: iso(now), window_days: days, ledger_version: LEDGER_VERSION, omega_policy_version: OMEGA_POLICY_VERSION,
    rules: { unit: "R", plan: "limit at the plan's entry, held to the chosen target or the stop", omega: "src/signal-ledger.mjs simulateOmega", same_bar: "stop first" },
    modes, trades,
    limit: limitReport(omega4, { since })
  };
}

/** The execution report of the last EXECUTION_REPORT_DAYS days, from D1. */
export async function readExecutionReport(env, { now = Date.now() } = {}) {
  await ensureLedgerSchema(env.DB);
  const rows = (await env.DB.prepare("SELECT * FROM signal_ledger WHERE source = 'decision' AND opened_at >= ?").bind(iso(now - EXECUTION_REPORT_DAYS * 86_400_000)).all()).results || [];
  const omega4 = (await env.DB.prepare("SELECT issued_ms, trading_mode, regime, omega4_status, omega4_closed_at, r_omega4, limit_status, limit_gate, limit_closed_at, r_limit FROM ledger_omega4 WHERE issued_ms >= ?").bind(now - EXECUTION_REPORT_DAYS * 86_400_000).all()).results || [];
  return executionReport(rows, { now, omega4 });
}

// ---------------------------------------------------------------------------
// The live setup (owner 2026-11-12: "ya kerjakan semua nomor jika memang lebih baik": a signal's lifecycle
// in one card, its levels locked from the moment it was given). A Decision Engine setup is the ledger's
// row: its entry, stop and targets never change after the decision that opened it, whatever the later
// 15m decisions say; those count as confirmations (same side) or opposite calls while it lives.

export const SETUP_RECENT_MS = 2 * 3600_000;

/** Pure: one ledger row as a setup's lifecycle (steps with their times, the R so far, Omega's side of it). */
export function setupLifecycle(row, { decisions = [], now = Date.now() } = {}) {
  const opened = toMs(row.opened_at);
  const end = toMs(row.closed_at) || now;
  const since = decisions.filter((d) => d.close_ms > decisionCloseMs(row.candle_key) && d.close_ms <= end);
  const tp1Hit = row.exit_reason === "target" && (row.tp1_closed_at || row.closed_at);
  const stopped = row.exit_reason === "stop";
  const phase = row.status === "pending" ? "awaiting_entry"
    : row.status === "cancelled" ? "cancelled"
    : row.status === "open" ? (tp1Hit ? "tp1" : "open")
    : row.exit_reason === "target" ? (row.tp2_exit_reason === "target" ? "tp2" : "tp1")
    : stopped ? (row.sl_plus_triggered ? "sl_plus" : "stopped") : (row.exit_reason ?? "closed");
  return {
    id: row.id, side: row.side, mode: row.trading_mode ?? null, opened_at: row.opened_at, status: row.status, phase,
    locked: { entry: row.entry, stop: row.stop, tp1: row.tp1, tp2: row.tp2 ?? null, progressive_stop: row.progressive_stop ?? null },
    steps: {
      signal: row.opened_at,
      entry: row.filled_at ?? null,
      sl_plus: row.sl_plus_at ?? null,
      tp1: tp1Hit ? (row.tp1_closed_at ?? row.closed_at) : null,
      tp2: row.tp2_exit_reason === "target" ? row.tp2_closed_at : null,
      invalidated: stopped ? (row.tp1_closed_at ?? row.closed_at) : null,
      cancelled: row.status === "cancelled" ? { at: row.closed_at, reason: row.exit_reason } : null
    },
    fill_deadline: finite(opened) ? iso(opened + FILL_WINDOW_MS) : null,
    r: { tp1: row.r_tp1 ?? null, tp2: row.r_tp2 ?? null, open: row.open_r ?? null, mfe: row.mfe_r ?? null, mae: row.mae_r ?? null },
    omega: row.omega_status ? { status: row.omega_status, gate: row.omega_gate ?? null, exit: row.omega_exit ?? null, r: row.r_omega ?? null, filled_at: row.omega_filled_at ?? null, closed_at: row.omega_closed_at ?? null } : null,
    decisions_since: { same: since.filter((d) => d.stance === row.side).length, opposite: since.filter((d) => (d.stance === "BUY" || d.stance === "SELL") && d.stance !== row.side).length, wait: since.filter((d) => d.stance === "WAIT").length }
  };
}

/** The Decision Engine setups still live, and those that ended in the last SETUP_RECENT_MS, newest first. */
export async function activeSetups(env, { now = Date.now(), limit = 3 } = {}) {
  if (!env?.DB) return [];
  // A read path: no schema work (the ledger step owns it); a missing column reads as undefined.
  try {
    const rows = (await env.DB.prepare("SELECT * FROM signal_ledger WHERE source = 'decision' AND (status IN ('pending', 'open') OR closed_at >= ?) ORDER BY opened_at DESC LIMIT ?").bind(iso(now - SETUP_RECENT_MS), limit).all()).results || [];
    if (!rows.length) return [];
    const oldest = Math.min(...rows.map((r) => decisionCloseMs(r.candle_key)).filter(finite));
    let decisions = [];
    if (finite(oldest)) {
      try { decisions = ((await env.DB.prepare("SELECT decision_key, stance FROM engine_decisions WHERE bar_close > ? ORDER BY bar_close").bind(iso(oldest)).all()).results || []).map((d) => ({ close_ms: decisionCloseMs(d.decision_key), stance: d.stance })); } catch { decisions = []; }
    }
    return rows.map((r) => setupLifecycle(r, { decisions, now }));
  } catch { return []; }
}
