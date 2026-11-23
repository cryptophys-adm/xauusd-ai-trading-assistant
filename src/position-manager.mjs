// The 5-minute position manager for the open Omega positions (owner 2026-11-17, confirmed in the session: "Ya,
// benar semua", "Setuju semua", USD 5 a day). Profit-oriented and risk-reducing only: every 5 minutes, for each
// position the system opened, the Position Council (a model call on measured inputs) judges the momentum and the
// thesis, and fixed rules turn that into at most one action:
//   profit >= +30 pips, momentum weakening        close now, without waiting for TP1
//   profit >= +30 pips, still strong               stop to break-even plus the spread
//   price >= 30 pips beyond TP1                    stop to TP1 (locks it), the position runs on to TP2; closed
//     instead when the council reads the momentum weakening
// The stop locks (break-even, TP1) go through the council; when it does not answer they apply as the mechanical
// fallback (owner 2026-11-19: "Lewat council juga", then "ya" to the fallback).
//   loss <= -30 pips, a measured reason and the    cut the loss now
//     council agrees: the decision on the other side, or the agent's measured confidence or the quorum's share
//     on the position's side dropped; and the council answered with the thesis weakening or broken
//   loss <= -30 pips, otherwise                    hold to the original stop (the broker's stop stays)
// A WAIT decision alone is never a reason to cut (owner 2026-11-19: "WAIT bisa jadi HOLD, harus divalidasi jangan
// langsung diexit"): it is said in the reason when it stands beside a measured one. Without the council's answer
// nothing is cut; the stop stays.
// TP1 is the plan's target (the open intent's tp), watched here; TP2 is the next key level beyond it, set as the
// broker's take-profit once. 1 pip = 0.10.
//
// In R since 2026-11-18 (owner, confirmed: "Per mode"; docs/RFC_ACCOUNT_PROFILES.md section 8): the +/-30 pip band
// of the profit and loss rules is the position's own stop distance at entry (the open intent's r_dist) times
// PM_R_BAND of the mode it opened in: scalp 0.3R, intraday and range 0.5R, swing 0.7R. A position whose stop distance
// is unknown keeps 30 pips. The 30 pips beyond TP1 of lock_tp1 stay in pips.
//
// SLG1, one profit-lock gate (owner 2026-11-23, src/profit-lock-gate.mjs), while the Omega setting profit_lock_gate is
// "on" (the default; the runner passes `gate` into positionFacts): the break-even, the TP1 lock and TP2 (with or without
// its break-even stop) wait until the position's MFE on closed bars of its mode's timeframe reaches the mode's
// threshold (the scalp, intraday, swing and range rules there); a lock waiting is a hold (lock_waits_gate,
// tp2_waits_gate). At the gate the break-even is break-even plus the spread plus 0.1 x ATR(M5), and TP2 is no longer
// reached at any profit inside the band: the gate is its trigger. take_profit_weakening, cut_loss and lock_tp1's level
// are unchanged. "legacy" (no `gate`): the rules as they were.
//
// Guardrails (owner): only close, or a stop moved in the position's favour (never widened), or the take-profit
// moved out to TP2; never an add, a reversal or an open. Inputs are measured: the strategy agent's confidence on the
// position's side against the bar before, the quorum's shares, the decision's stance. Never the council's own
// confidence. A missing input, a council timeout or failure, or the daily cap means no action (the broker's stop
// and target stay), except the stop locks, which apply as the fallback. POSITION_MANAGER_MODE "live" runs it, "off" stops it. Metered as "position_council" with its own
// daily cap (POSITION_COUNCIL_DAILY_USD, default 5), apart from the Decision Engine and the War Rooms.
//
// Here: the pure rules, the council's messages and schema, and the runner on the main Worker's 5-minute cron. Omega
// (src/omega-engine.mjs positionManagerIntents) turns a stored action into an intent at its next sync, checking it
// against the live price again.
import { callBusModel } from "./model-call.mjs";
import { ensureAiUsageSchema, neuronsOf, USD_PER_1K_NEURONS } from "./ai-usage.mjs";
import { confidenceTrend } from "./agent-confidence.mjs";
import { eaSignal } from "./ea-signal.mjs";
import { SWEEP_WITH_MAX_AGE_MIN } from "./liquidity-lens.mjs";
import { ensurePositionSchema, ACTION_TTL_MS } from "./position-actions.mjs";
import { readDelegations, hitlSupported } from "./omega-hitl.mjs";
import { OMEGA_DEFAULTS, ladderTp1Locked, loosenRecords } from "./omega-engine.mjs";
import { pmLoosenKnobs } from "./pm-loosen-knobs.mjs";
import { gatedEvents, eventRisk } from "./econ-calendar.mjs";
import { gateBreakEven, gateAtrM5, gateText, profitLockGateOn, GATE_UNMEASURED } from "./profit-lock-gate.mjs";
export { ensurePositionSchema, pendingPositionActions, markPositionActions, ACTION_TTL_MS, actionMessage, actionIdOfIntent } from "./position-actions.mjs";

export const PIP = 0.1;
export const THRESHOLD_PIPS = 30;
/** The profit and loss band in R of the stop distance at entry, per trading mode (owner 2026-11-18: "Per mode"). */
export const PM_R_BAND = Object.freeze({ scalp: 0.3, intraday: 0.5, range: 0.5, swing: 0.7 });
const DEFAULT_MODE = "intraday";

/**
 * Pure: the band of one position, { pips, r, mode, r_dist_pips }: its mode's R band times its stop distance at entry
 * (`openIntent.r_dist`, else |entry − sl| of the intent), or THRESHOLD_PIPS with r null when that distance is unknown.
 * The mode is the intent's, else the decision's (`fallbackMode`), else intraday.
 */
export function pmBand(openIntent, fallbackMode = null) {
  const mode = [openIntent?.mode, fallbackMode].find((m) => typeof m === "string" && Object.hasOwn(PM_R_BAND, m)) ?? DEFAULT_MODE;
  const given = Number(openIntent?.r_dist);
  const dist = Number.isFinite(given) && given > 0 ? given : Math.abs(Number(openIntent?.entry) - Number(openIntent?.sl));
  if (!(Number.isFinite(dist) && dist > 0)) return { pips: THRESHOLD_PIPS, r: null, mode, r_dist_pips: null };
  return { pips: r1(PM_R_BAND[mode] * dist / PIP), r: PM_R_BAND[mode], mode, r_dist_pips: r1(dist / PIP) };
}
export const POSITION_COUNCIL_METER = "position_council";
export const POSITION_COUNCIL_DAILY_USD = 5;
/** A quorum share on the position's side that fell by more than this since the bar before is a confluence drop. */
export const SHARE_DROP = 0.05;
const DEFAULT_AGENT = "zone_pullback";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r1 = (v) => Math.round(v * 10) / 10;

export function positionManagerMode(env) {
  return String(env?.POSITION_MANAGER_MODE ?? "off").trim().toLowerCase() === "live" ? "live" : "off";
}
export function dailyCapUsd(env) {
  const v = Number(env?.POSITION_COUNCIL_DAILY_USD ?? POSITION_COUNCIL_DAILY_USD);
  return Number.isFinite(v) && v >= 0 ? v : POSITION_COUNCIL_DAILY_USD;
}

/** Pure: a price distance in pips (1 pip = 0.10). */
export const pipsOf = (dist) => r1(dist / PIP);

/**
 * Pure: what the manager knows of one position. `openIntent` is its open intent's payload (entry, sl, tp = TP1,
 * strategy); `levels` the key levels on the broker's scale (low first); `decision` the latest Decision Engine record
 * (stance, quorum, agent_confidence and agent_confidence_prev). Returns null when an input the rules need is missing.
 * `gate` (SLG1, profit_lock_gate "on"): the position's profit-lock gate facts (src/profit-lock-gate.mjs gateFacts; null
 * reads as closed, unmeasured); the facts then carry `gate` { open, mfe_r, mfe_atr, ..., be } with `be` the gate's
 * first lock. Absent ("legacy"): the facts are today's.
 */
export function positionFacts({ position: p, sym, openIntent, levels = [], decision, ladder = false, signal = null, loosen = null, gate = undefined }) {
  if (!p || (p.side !== "BUY" && p.side !== "SELL") || !isNum(sym?.bid) || !isNum(sym?.ask)) return null;
  const buy = p.side === "BUY", dir = buy ? 1 : -1;
  const open = Number(p.open_price ?? p.entry), sl = Number(p.sl), tp = Number(p.tp);
  const tp1 = Number(openIntent?.tp);
  if (!Number.isFinite(open) || !Number.isFinite(tp1) || tp1 <= 0 || !decision?.stance || !decision?.quorum) return null;
  const price = buy ? sym.bid : sym.ask;
  const point = isNum(sym.point) && sym.point > 0 ? sym.point : 0.01;
  const spreadPx = (isNum(sym.spread_points) ? sym.spread_points : 0) * point;
  const agent = typeof openIntent?.strategy === "string" && openIntent.strategy ? openIntent.strategy : DEFAULT_AGENT;
  const k = buy ? "long" : "short";
  const conf = decision.agent_confidence?.[agent]?.[k], prev = decision.agent_confidence_prev?.[agent]?.[k];
  const share = buy ? decision.quorum.long_share : decision.quorum.short_share;
  const prevShare = buy ? decision.quorum_prev?.long_share : decision.quorum_prev?.short_share;
  const beyond = levels.filter((z) => (buy ? z.low > tp1 + spreadPx : z.high < tp1 - spreadPx)).sort((a, b) => (buy ? a.low - b.low : b.high - a.high))[0];
  const band = pmBand(openIntent, decision.trading_mode ?? null);
  const pips = pipsOf(dir * (price - open));
  const out = {
    ticket: p.ticket, side: p.side, dir, open, price, sl: Number.isFinite(sl) ? sl : null, tp: Number.isFinite(tp) ? tp : null,
    tp1, tp2: beyond ? (buy ? beyond.low : beyond.high) : null, spread: spreadPx, point,
    pips, beyond_tp1_pips: pipsOf(dir * (price - tp1)),
    band_pips: band.pips, band_r: band.r, mode: band.mode, r_dist_pips: band.r_dist_pips, r: band.r_dist_pips ? Math.round((pips / band.r_dist_pips) * 100) / 100 : null,
    agent, agent_conf: isNum(conf) ? conf : null, agent_conf_prev: isNum(prev) ? prev : null, agent_trend: confidenceTrend(conf, prev),
    stance: decision.stance, with_decision: decision.stance === p.side, against_decision: decision.stance === (buy ? "SELL" : "BUY"),
    share: isNum(share) ? share : null, share_prev: isNum(prevShare) ? prevShare : null,
    // Under the TP ladder an outward target waits until the stop locks the ladder's TP1 (ADR-0020 Amendment 4).
    ladder_hold: ladder === true && !ladderTp1Locked({ position: p, levels: levels.length ? levels : null, sym, signal })
  };
  // ADR-0020 Amendment 8: only with its switch on (`loosen` given by the runner); otherwise the facts are today's.
  if (loosen && typeof loosen === "object") out.loosen = loosenFacts(loosen, { openIntent, mode: band.mode, levels });
  // The liquidity lens (docs/RFC_POSITIONING_LIQUIDITY.md §6), only while it is on (the signal's liquidity_on: the
  // owner's switch, the weight above its floor, a fresh state); otherwise the facts are today's.
  const liq = liquidityOf(signal, p.side);
  if (liq) out.liquidity = liq;
  if (gate !== undefined) {
    const g = gate && typeof gate === "object" ? gate : GATE_UNMEASURED;
    out.gate = { ...g, open: g.open === true, be: gateBreakEven({ open, dir, spread: spreadPx, atrM5: gateAtrM5(signal, sym), digits: Number.isInteger(sym.digits) ? sym.digits : 2 }) };
  }
  return out;
}

/**
 * Pure: the liquidity lens's reading for a position (RFC §6): a reclaimed sweep on a volume spike in the last 15
 * minutes, `against` the position (a buy-side sweep for a long, a sell-side one for a short) or `with` it; the lens
 * weight. Null while the lens is off or no sweep stands.
 */
export function liquidityOf(signal, side) {
  if (signal?.liquidity_on !== true || (signal.liquidity_sweep !== "buy_side" && signal.liquidity_sweep !== "sell_side")) return null;
  const age = Number(signal.liquidity_sweep_age_min);
  if (!(isNum(age) && age >= 0 && age <= SWEEP_WITH_MAX_AGE_MIN)) return null;
  const against = signal.liquidity_sweep === (side === "BUY" ? "buy_side" : "sell_side");
  return { sweep: against ? "against" : "with", sweep_side: signal.liquidity_sweep, age_min: age, weight: isNum(Number(signal.liquidity_weight)) ? Number(signal.liquidity_weight) : null };
}
const sweepAgainstText = (f) => `a reclaimed ${f.liquidity.sweep_side === "buy_side" ? "buy-side" : "sell-side"} sweep on a volume spike ${f.liquidity.age_min} minutes ago argues against the ${f.side === "BUY" ? "long" : "short"} (liquidity_sweep_against)`;

/**
 * Pure: what the bounded loosening and the two-way target read (ADR-0020 Amendment 8). `loosen` is what the runner
 * found: { orig_sl (the open or place_limit intent's sl), atr_now (ATR(14, 15m) the terminal reports), atr_ref and
 * atr_ref_source (the ATR at the last Omega tighten, else at entry), loosened (a loosening already sent for this
 * position), release (a high-impact USD release in the calendar gate's window, or null), delegated, unreadable }.
 */
export function loosenFacts(loosen, { openIntent = null, mode = DEFAULT_MODE, levels = [] } = {}) {
  const num = (v) => (isNum(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const atrEntry = num(openIntent?.atr_entry);
  const atrRef = num(loosen.atr_ref) ?? atrEntry;
  return {
    orig_sl: num(loosen.orig_sl ?? openIntent?.sl), atr_now: num(loosen.atr_now),
    atr_ref: atrRef, atr_ref_source: num(loosen.atr_ref) != null ? (loosen.atr_ref_source ?? "last_tighten") : atrEntry != null ? "entry" : null,
    knobs: pmLoosenKnobs(mode), loosened: loosen.loosened === true, from_sl: num(loosen.from_sl), unreadable: loosen.unreadable === true, delegated: loosen.delegated === true,
    release: loosen.release && typeof loosen.release.title === "string" ? { title: loosen.release.title.slice(0, 80), time: String(loosen.release.time ?? "") } : null,
    levels: Array.isArray(levels) ? levels : []
  };
}

/**
 * Pure: the action of one position from its facts and the council's answer ({ momentum, thesis }, or null when the
 * council failed or was not asked). Returns { action: "close" | "sl" | "tp" | "hold" | "none", rule, sl?, tp?, why }.
 * "none" means no action for want of an input; "hold" is a decision to keep the position as it is.
 */
export function positionAction(f, council) {
  const base = ruleAction(f, council);
  // ADR-0020 Amendment 8 (owner 2026-11-20), only with its switch on (the facts then carry `loosen`) and only on the
  // council's answer: a silent council changes nothing, and nothing loosens mechanically. After a loosening a lock
  // waits until it passes the stop before it (as Omega would drop it).
  if (!f?.loosen) return base;
  const held = loosenHold(f, base);
  return council ? a8Action(f, council, held) : held;
}

/** Pure: the fixed rules of today (before ADR-0020 Amendment 8), as positionAction gave them. */
export function ruleAction(f, council) {
  if (!f) return { action: "none", rule: "inputs_missing", why: "an input the rules need is missing" };
  const better = (x) => f.sl == null || (f.dir > 0 ? x > f.sl + f.point / 2 : x < f.sl - f.point / 2);
  const room = (x) => (f.dir > 0 ? x < f.price - f.spread : x > f.price + f.spread);
  // TP2 at the broker once: a take-profit still at TP1 moves out to the next key level.
  const tpAtTp1 = f.tp != null && Math.abs(f.tp - f.tp1) <= PIP / 2;
  // The stop locks go through the council too (owner 2026-11-19: "Lewat council juga"; and "ya" to the fallback): the
  // council's answer decides between locking and taking the profit now (momentum weakening). When it does not answer
  // (a failure, a timeout, the daily cap), the lock is applied as the mechanical fallback: a lock only reduces risk.
  const silent = council ? "" : " (the council did not answer: the lock applies as the fallback)";
  const reading = council ? `; the council reads ${council.momentum}, thesis ${council.thesis}` : silent;
  // SLG1: the profit-lock gate (only with `f.gate`, profit_lock_gate "on"). Closed, no stop moves into profit and TP2
  // waits; each lock made at or after it records the MFE it was made at.
  const G = f.gate ?? null;
  const shut = G != null && G.open !== true;
  const waits = (rule, what) => ({ action: "hold", rule, why: `${what} waits for the profit-lock gate: ${gateText(G)}` });
  const mfe = (a) => (G && (a.action === "sl" || a.action === "tp") ? { ...a, mfe_r: G.mfe_r ?? null, mfe_atr: G.mfe_atr ?? null, why: `${a.why}; at the profit-lock gate (${gateText(G)})` } : a);
  // The gate's first lock follows the spread and the M5 ATR: a stop already past the entry is not moved again by a few
  // cents to it (as the ladder takes its break-even once).
  const pastEntry = G != null && f.sl != null && f.dir * (f.sl - f.open) > f.point / 2;
  // Beyond TP1 by 30 pips: the stop locks TP1, or the position closes when the council reads the momentum weakening.
  if (f.beyond_tp1_pips >= THRESHOLD_PIPS && better(f.tp1) && room(f.tp1)) {
    if (council?.momentum === "weakening") return { action: "close", rule: "take_profit_weakening", why: `${f.beyond_tp1_pips} pips beyond TP1 and the momentum is weakening: closed instead of locking TP1` };
    if (shut) return waits("lock_waits_gate", `${f.beyond_tp1_pips} pips beyond TP1: the TP1 lock`);
    return mfe({ action: "sl", rule: "lock_tp1", sl: f.tp1, why: `${f.beyond_tp1_pips} pips beyond TP1: stop to TP1${reading}` });
  }
  // TP2 (owner 2026-11-19, PM PR 2): the target moves out only when the council answered with the momentum not
  // weakening and the thesis intact, and, under the TP ladder, once the stop locks its TP1. Otherwise the target holds
  // and nothing is sent (no action, so no "not applied" line every five minutes).
  const tp2 = (fallback) => {
    if (!tpAtTp1 || f.tp2 == null) return fallback;
    if (shut) return waits("tp2_waits_gate", "TP2");
    if (!council) return { action: "hold", rule: "tp2_waits_council", why: "TP2 waits: the council did not answer" };
    if (council.momentum === "weakening" || council.thesis !== "intact") return { action: "hold", rule: "tp2_waits_council", why: `TP2 waits: the council reads ${council.momentum}, thesis ${council.thesis}` };
    if (f.ladder_hold) {
      // ADR-0020 Amendment 6 (owner 2026-11-19, "Merge #490 + kerjakan opsi BE"): before the ladder's TP1 lock, TP2 goes
      // out in profit together with the stop at break-even plus the spread or better, in one modification (both or
      // neither): the worst case is about zero instead of the TP1 profit, never below the entry.
      // SLG1: at the gate, break-even is the gate's first lock (plus the spread and 0.1 x ATR(M5)).
      const be = G ? G.be : f.open + f.dir * f.spread;
      if (f.pips > 0 && room(be)) {
        const sl = better(be) && !pastEntry ? be : f.sl;
        return mfe({ action: "tp", rule: "tp2_breakeven", tp: f.tp2, sl, why: `target out to TP2 with the stop at ${better(be) && !pastEntry ? `break-even plus the spread${G ? " and 0.1 x ATR(M5)" : ""}` : "its level, already past break-even"} (one modification); the council reads ${council.momentum}, thesis intact` });
      }
      return { action: "hold", rule: "tp2_waits_ladder", why: "TP2 waits: no room for a break-even stop yet" };
    }
    return mfe({ action: "tp", rule: "tp2_target", tp: f.tp2, why: `target out to TP2 (the next key level); the council reads ${council.momentum}, thesis intact` });
  };
  const band = isNum(f.band_pips) && f.band_pips > 0 ? f.band_pips : THRESHOLD_PIPS;
  const at = (sign) => `${sign > 0 ? "+" : ""}${f.pips} pips${f.r != null ? ` (${sign > 0 ? "+" : ""}${f.r}R, band ${f.band_r}R ${f.mode})` : ""}`;
  if (f.pips >= band) {
    if (council?.momentum === "weakening") return { action: "close", rule: "take_profit_weakening", why: `${at(1)} and the momentum is weakening: closed without waiting for TP1` };
    // SLG1: with the gate on, the break-even waits for it and is then the gate's first lock.
    const be = G ? G.be : f.open + f.dir * f.spread;
    if (better(be) && room(be) && !pastEntry) {
      if (shut) return waits("lock_waits_gate", `${at(1)}: the break-even`);
      return mfe({ action: "sl", rule: "breakeven", sl: be, why: `${at(1)}${council ? " and still strong" : ""}: stop to break-even plus the spread${G ? " and 0.1 x ATR(M5)" : ""}${reading}` });
    }
    if (!council) return { action: "none", rule: "council_unavailable", why: "the council did not answer: the stop and target stay" };
    return tp2({ action: "hold", rule: "protected", why: `${at(1)}, the stop already protects it` });
  }
  if (f.pips <= -band) {
    if (f.agent_conf == null || f.agent_conf_prev == null || f.share == null) return { action: "none", rule: "inputs_missing", why: "the agent's confidence or the quorum is missing: the stop stays" };
    const shareDrop = f.share_prev != null && f.share_prev - f.share > SHARE_DROP;
    // Measured reasons only. A WAIT decision is not one (owner 2026-11-19): it is said beside one, never alone.
    const reasons = [
      ...(f.against_decision ? [`the decision is ${f.stance}`] : []),
      ...(f.agent_trend === "drop" ? [`the ${f.agent} confidence dropped ${f.agent_conf_prev} to ${f.agent_conf}`] : []),
      ...(shareDrop ? [`the quorum's ${f.side === "BUY" ? "bullish" : "bearish"} share fell ${Math.round(f.share_prev * 100)}% to ${Math.round(f.share * 100)}%`] : []),
      // The liquidity lens (RFC §6): a measured reason beside the others; the cut still needs the council's thesis.
      ...(f.liquidity?.sweep === "against" ? [sweepAgainstText(f)] : [])
    ];
    const wait = !f.with_decision && !f.against_decision ? `the decision is ${f.stance}` : null;
    if (!reasons.length) return { action: "hold", rule: "hold_to_stop", why: `${at(-1)} but no measured reason to cut${wait ? ` (${wait}, not a reason alone)` : ""}: held to the original stop` };
    // The cut goes through the council: without its answer, or with the thesis intact, the position holds.
    if (!council) return { action: "none", rule: "council_unavailable", why: `${at(-1)} and ${reasons.join("; ")}, but the council did not answer: the stop stays` };
    if (council.thesis === "intact") return { action: "hold", rule: "hold_thesis_intact", why: `${at(-1)} and ${reasons.join("; ")}, but the council calls the thesis intact: held to the original stop` };
    return { action: "close", rule: "cut_loss", why: `${at(-1)} and ${[...reasons, ...(wait ? [wait] : [])].join("; ")}; the council calls the thesis ${council.thesis}: loss cut` };
  }
  // TP2 inside the band: at any profit before SLG1; with the gate on, the gate is its trigger (tp2_breakeven's any-profit
  // trigger is gone, owner 2026-11-23).
  if (tpAtTp1 && f.tp2 != null && (G ? G.open === true : f.pips > 0)) return tp2(null);
  return { action: "hold", rule: "inside_band", why: `${f.pips} pips: inside the ±${band} pip band${f.r != null ? ` (±${f.band_r}R ${f.mode})` : ""}` };
}

/* ---------- ADR-0020 Amendment 8 (owner 2026-11-20): the council's bounded loosening and two-way target ---------- */

/** The measured reasons the council may name, per change (docs/RFC_PM_A8.md §2). */
export const LOOSEN_REASONS = Object.freeze(["atr_expansion", "key_level_outside", "high_impact_release"]);
export const TP_NEARER_REASONS = Object.freeze(["momentum_fading", "key_level_before", "confidence_drop", "liquidity_sweep_against"]);
export const TP_FURTHER_REASONS = Object.freeze(["atr_expansion_trend", "key_level_beyond"]);
/** The holds an A8 change may replace: never a close, a lock, TP2, an input missing, or a loss at the cut band. */
const A8_BASE_RULES = Object.freeze(["inside_band", "protected", "tp2_waits_council", "tp2_waits_ladder"]);
const roundPt = (v, point) => Number((Math.round(v / point) * point).toFixed(6));

/** Pure: the risk at a stop in R of the stop distance at entry (1R: the original stop), or null without it. */
function riskR(f, sl) {
  const rd = isNum(f.r_dist_pips) && f.r_dist_pips > 0 ? f.r_dist_pips * PIP : null;
  return rd ? Math.round(((f.dir * (f.open - sl)) / rd) * 100) / 100 : null;
}
const rText = (v) => (v == null ? "" : `${v >= 0 ? "+" : ""}${v}R`);
const riskText = (v) => (v == null ? "an unknown R" : v > 0 ? `${v}R at risk` : v === 0 ? "break-even" : `${Math.abs(v)}R locked`);

/** Pure: after a loosening (`f.loosen.from_sl`), a lock not tighter than the stop before it becomes a hold. */
export function loosenHold(f, a) {
  const from = f?.loosen?.from_sl;
  if (!isNum(from) || (a?.action !== "sl" && a?.action !== "tp") || !isNum(a.sl) || String(a.rule).startsWith("loosen_")) return a;
  if (f.dir * (a.sl - from) > f.point / 2) return a;
  return { action: "hold", rule: "lock_waits_loosened", why: `${a.why}; held: the council loosened this stop from ${from}, and a lock waits until it is tighter than that` };
}

/** Pure: whether ATR(14, 15m) now is at least the mode's expansion ratio times its reference. */
export function atrExpanded(L) {
  return isNum(L?.atr_now) && isNum(L?.atr_ref) && L.atr_ref > 0 && L.atr_now >= L.knobs.atr_expand * L.atr_ref - 1e-9;
}

/**
 * Pure: the council's stop loosening checked against the amendment's bounds, or null when it did not ask for one.
 * { ok: true, action } or { ok: false, why }. The stop moves back toward the original entry stop by at most the mode's
 * back_share of the way, never past it; from break-even or better never back into loss; once per position; only on
 * the council's consensus (thesis intact, momentum not weakening) with a measured reason that holds.
 */
export function loosenPlan(f, council) {
  if (council?.stop !== "loosen") return null;
  const L = f.loosen, dir = f.dir, cur = f.sl, orig = L.orig_sl, reason = council.stop_reason;
  const no = (why) => ({ ok: false, why: `the council asked to loosen the stop (${reason}), refused: ${why}` });
  if (L.delegated) return no("a delegated position's stop is never loosened");
  if (L.unreadable) return no("the record of earlier loosenings cannot be read");
  if (L.loosened) return no("this position was loosened once already");
  if (council.thesis !== "intact" || council.momentum === "weakening") return no(`its reading (${council.momentum}, thesis ${council.thesis}) is no consensus to give the position room`);
  if (!LOOSEN_REASONS.includes(reason)) return no("no measured reason named");
  if (!isNum(orig) || cur == null) return no("the original entry stop is unknown");
  const dist = dir * (cur - orig);
  if (!(dist > f.point / 2)) return no("the stop was never tightened");
  // The bound: back_share of the way from the current stop to the original one, never past it; from break-even or
  // better never back into loss (the entry is the floor).
  let bound = cur - dir * L.knobs.back_share * dist;
  if (dir * (cur - f.open) >= -1e-9) bound = dir > 0 ? Math.max(bound, f.open) : Math.min(bound, f.open);
  bound = dir > 0 ? Math.max(bound, orig) : Math.min(bound, orig);
  let sl = bound, measured = null;
  if (reason === "atr_expansion") {
    if (atrExpanded(L)) measured = `ATR(14, 15m) ${L.atr_now} is ${Math.round((L.atr_now / L.atr_ref) * 100) / 100}x the ${L.atr_ref} at ${L.atr_ref_source === "entry" ? "entry" : "the last tighten"} (threshold ${L.knobs.atr_expand}x)`;
    else return no(L.atr_ref == null ? "no ATR reference was recorded (entry or last tighten)" : `ATR(14, 15m) ${L.atr_now ?? "unknown"} is below ${L.knobs.atr_expand}x the reference ${L.atr_ref}`);
  } else if (reason === "key_level_outside") {
    // A key level just outside the stop: its near edge between the stop and the bound; the stop clears it by a buffer,
    // never past the bound.
    const edge = (z) => (dir > 0 ? z.high : z.low), far = (z) => (dir > 0 ? z.low : z.high);
    const z = L.levels.filter((x) => dir * (cur - edge(x)) > 0 && dir * (edge(x) - bound) >= 0).sort((a, b) => dir * (edge(b) - edge(a)))[0];
    if (!z) return no("no key level lies just outside the stop, within the bound");
    const clear = far(z) - dir * Math.max(2 * f.spread, f.point);
    sl = dir > 0 ? Math.max(bound, clear) : Math.min(bound, clear);
    measured = `a key level ${z.low}-${z.high} sits just outside the stop`;
  } else if (L.release) measured = `a high-impact release is scheduled (${L.release.title}, ${L.release.time.slice(11, 16)} UTC)`;
  else return no("no high-impact release is in the calendar's window");
  sl = roundPt(sl, f.point);
  if (!(dir * (cur - sl) > f.point / 2)) return no("no room between the stop and its bound");
  const before = riskR(f, cur), after = riskR(f, sl);
  return { ok: true, action: { action: "sl", rule: `loosen_${reason}`, sl,
    why: `stop loosened ${cur} → ${sl} (${measured}); ${f.mode}; the stop from ${riskText(before)} to ${riskText(after)} (1R at entry); ${f.pips} pips${f.r != null ? ` (${rText(f.r)})` : ""}; the council reads ${council.momentum}, thesis intact` } };
}

/**
 * Pure: the council's target move (nearer or further) checked against its measured reason, or null when it asked none.
 * Nearer: the agent's confidence dropped, the quorum's share fell, or a key level stands before the target; the new
 * target is the nearest key level ahead of price before it, else TP1 when the target is beyond it. Further: a key
 * level beyond the target, or ATR expansion with the agent's confidence rising, on the council's consensus; the new
 * target is the next key level beyond. Never on the wrong side of price; under the TP ladder an outward move waits for
 * the TP1 lock (Amendment 4).
 */
export function targetPlan(f, council) {
  const kind = council?.target;
  if (kind !== "nearer" && kind !== "further") return null;
  const L = f.loosen, dir = f.dir, reason = council.target_reason;
  const no = (why) => ({ ok: false, why: `the council asked to move the target ${kind} (${reason}), refused: ${why}` });
  if (L.delegated) return no("a delegated position keeps its own target rules");
  if (f.tp == null) return no("the position has no target");
  const buffer = Math.max(2 * f.spread, f.point);
  const near = (z) => (dir > 0 ? z.low : z.high);
  const ahead = (x) => dir * (x - f.price) > f.spread + buffer;
  let tp = null, measured = null;
  if (kind === "nearer") {
    if (!TP_NEARER_REASONS.includes(reason)) return no("no measured reason named");
    const before = L.levels.filter((z) => ahead(near(z)) && dir * (f.tp - near(z)) > buffer).sort((a, b) => dir * (near(a) - near(b)))[0];
    if (reason === "momentum_fading") {
      if (!(f.share != null && f.share_prev != null && f.share_prev - f.share > SHARE_DROP)) return no("the quorum's share on the side did not fall");
      measured = `the quorum's share fell ${Math.round(f.share_prev * 100)}% to ${Math.round(f.share * 100)}%`;
    } else if (reason === "confidence_drop") {
      if (f.agent_trend !== "drop") return no(`the ${f.agent} confidence did not drop`);
      measured = `the ${f.agent} confidence dropped ${f.agent_conf_prev} to ${f.agent_conf}`;
    } else if (reason === "liquidity_sweep_against") {
      if (f.liquidity?.sweep !== "against") return no("no reclaimed sweep against the position in the last 15 minutes (or the liquidity lens is off)");
      measured = sweepAgainstText(f);
    } else {
      if (!before) return no("no key level stands before the target");
      measured = `a key level ${before.low}-${before.high} stands before the target`;
    }
    if (before) tp = near(before);
    else if (dir * (f.tp - f.tp1) > PIP / 2 && ahead(f.tp1)) tp = f.tp1;
    else return no("no key level ahead of price before the target, and the target is not beyond TP1");
  } else {
    if (!TP_FURTHER_REASONS.includes(reason)) return no("no measured reason named");
    if (council.thesis !== "intact" || council.momentum === "weakening") return no(`its reading (${council.momentum}, thesis ${council.thesis}) is no consensus to extend`);
    if (f.ladder_hold) return no("the TP ladder holds the target until the stop locks TP1 (ADR-0020 Amendment 4)");
    const beyond = L.levels.filter((z) => dir * (near(z) - f.tp) > buffer).sort((a, b) => dir * (near(a) - near(b)))[0];
    if (!beyond) return no("no key level beyond the target");
    if (reason === "atr_expansion_trend") {
      if (!atrExpanded(L)) return no(L.atr_ref == null ? "no ATR reference was recorded" : `ATR(14, 15m) ${L.atr_now ?? "unknown"} is below ${L.knobs.atr_expand}x the reference ${L.atr_ref}`);
      if (f.agent_trend !== "rising") return no(`the ${f.agent} confidence is not rising`);
      measured = `ATR(14, 15m) ${L.atr_now} is ${Math.round((L.atr_now / L.atr_ref) * 100) / 100}x the reference and the ${f.agent} confidence rose ${f.agent_conf_prev} to ${f.agent_conf}`;
    } else measured = `a key level ${beyond.low}-${beyond.high} lies beyond the target`;
    tp = near(beyond);
  }
  tp = roundPt(tp, f.point);
  const rd = isNum(f.r_dist_pips) && f.r_dist_pips > 0 ? f.r_dist_pips * PIP : null;
  const tpR = (x) => (rd ? Math.round(((f.dir * (x - f.open)) / rd) * 100) / 100 : null);
  return { ok: true, action: { action: "tp", rule: `tp_${kind}_${reason}`, tp,
    why: `target moved ${kind} ${f.tp} → ${tp} (${measured}); ${f.mode}; the target ${rText(tpR(f.tp))} → ${rText(tpR(tp))}; ${f.pips} pips${f.r != null ? ` (${rText(f.r)})` : ""}; the council reads ${council.momentum}, thesis ${council.thesis}` } };
}

/**
 * Pure: the amendment's change on top of the fixed rules' hold. A close, a lock, TP2 or a cut comes first; at the loss
 * band nothing is loosened or moved. One change per position and bar: the stop first, and a target moved further
 * never with a looser stop. A refused request keeps the hold and says why.
 */
export function a8Action(f, council, base) {
  if (base?.action !== "hold" || !A8_BASE_RULES.includes(base.rule)) return base;
  const stop = loosenPlan(f, council);
  if (stop?.ok) {
    const waits = council.target === "further" ? "; the target waits: a target moved further never comes with a looser stop" : council.target === "nearer" ? "; the target waits for the next bar (one change at a time)" : "";
    return { ...stop.action, why: `${stop.action.why}${waits}` };
  }
  const target = targetPlan(f, council);
  if (target?.ok) return stop ? { ...target.action, why: `${target.action.why}; ${stop.why}` } : target.action;
  const refused = [stop, target].filter(Boolean).map((x) => x.why);
  return refused.length ? { ...base, why: `${base.why}; ${refused.join("; ")}` } : base;
}

export const POSITION_COUNCIL_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["momentum", "thesis", "reason"],
  properties: {
    momentum: { type: "string", enum: ["strengthening", "holding", "weakening"] },
    thesis: { type: "string", enum: ["intact", "weakening", "broken"] },
    reason: { type: "string", maxLength: 240 }
  }
});

/** With ADR-0020 Amendment 8 switched on: the same answer, plus the stop and target the council asks for, each with one measured reason. */
export const POSITION_COUNCIL_SCHEMA_A8 = Object.freeze({
  type: "object", additionalProperties: false, required: ["momentum", "thesis", "reason", "stop", "stop_reason", "target", "target_reason"],
  properties: {
    ...POSITION_COUNCIL_SCHEMA.properties,
    stop: { type: "string", enum: ["keep", "loosen"] },
    stop_reason: { type: "string", enum: ["none", ...LOOSEN_REASONS] },
    target: { type: "string", enum: ["keep", "nearer", "further"] },
    target_reason: { type: "string", enum: ["none", ...TP_NEARER_REASONS, ...TP_FURTHER_REASONS] }
  }
});
const A8_SYSTEM = " Since ADR-0020 Amendment 8 you may also ask for ONE change, each with one measured reason, and fixed rules check the reason and set the price: stop \"loosen\" moves a stop that was tightened since entry back toward the original entry stop (never past it, never back into loss from break-even, once per position; reasons atr_expansion, key_level_outside, high_impact_release), only with the thesis intact; target \"nearer\" (momentum_fading, key_level_before, confidence_drop) or \"further\" (atr_expansion_trend, key_level_beyond). Answer \"keep\" and \"none\" when nothing is warranted; a loosening never comes with a target further.";

/** Pure: the council's messages for one position (measured inputs only; never a size, never the council's own confidence). */
export function positionCouncilMessages(f, { m5 = null, levels = [] } = {}) {
  const evidence = {
    position: { side: f.side, open: f.open, price: f.price, pips: f.pips, r: f.r ?? null, mode: f.mode ?? null, band_pips: f.band_pips ?? null, stop: f.sl, target: f.tp, tp1: f.tp1, tp2: f.tp2, beyond_tp1_pips: f.beyond_tp1_pips },
    measured: { agent: f.agent, agent_confidence_now: f.agent_conf, agent_confidence_15m_ago: f.agent_conf_prev, agent_trend: f.agent_trend, decision_stance: f.stance, quorum_share_with_position: f.share, quorum_share_15m_ago: f.share_prev },
    m5: m5 ? { atr: m5.m5_atr ?? null, swing_low: m5.m5_swing_low ?? null, swing_high: m5.m5_swing_high ?? null, confirmation_buy: m5.m5_buy === true, confirmation_sell: m5.m5_sell === true } : null,
    key_levels: levels.slice(0, 12)
  };
  const L = f.loosen;
  if (L) {
    evidence.amendment_8 = { original_stop: L.orig_sl, stop_tightened: L.orig_sl != null && f.sl != null && f.dir * (f.sl - L.orig_sl) > f.point / 2, loosened_once: L.loosened, atr_15m_now: L.atr_now, atr_15m_reference: L.atr_ref,
      atr_reference_from: L.atr_ref_source, atr_expand_threshold: L.knobs.atr_expand, back_share: L.knobs.back_share, high_impact_release: L.release ? `${L.release.title} ${L.release.time}` : null };
  }
  const system = "You are the Position Council of the XAUUSD system. Every 5 minutes you judge ONE open position from measured inputs only: the strategy agent's confidence on the position's side now and 15 minutes ago, the quorum's share on its side, the Decision Engine's stance, the broker's 5m structure and the key levels. Answer momentum (strengthening, holding or weakening: is price still moving the position's way with the agents and the quorum behind it?) and thesis (intact, weakening or broken: does the reason the position was opened still hold?). Fixed rules turn your answer into an action; you never choose the action, a size or a price. Return only the JSON object, with one short reason in plain words.";
  // The liquidity lens (RFC §6), only while it is on and a sweep stands: one measured fact and one sentence.
  if (f.liquidity) evidence.liquidity = { sweep: f.liquidity.sweep, sweep_side: f.liquidity.sweep_side, age_min: f.liquidity.age_min, lens_weight: f.liquidity.weight };
  const liq = f.liquidity ? ` liquidity is the broker's own tick volume: a reclaimed sweep on a volume spike in the last 15 minutes, with or against the position; weigh it at ${f.liquidity.weight ?? "its lens weight"}. Against the position it is a measured reason (liquidity_sweep_against) for a cut in the loss band${L ? " or a target nearer" : ""}; it never decides alone.` : "";
  return [
    { role: "system", content: `${system}${L ? A8_SYSTEM : ""}${liq}` },
    { role: "user", content: JSON.stringify(evidence) }
  ];
}

/** The council's answer reduced to the schema, or null. */
export function cleanCouncil(o) {
  if (!o || !["strengthening", "holding", "weakening"].includes(o.momentum) || !["intact", "weakening", "broken"].includes(o.thesis)) return null;
  return { momentum: o.momentum, thesis: o.thesis, reason: String(o.reason ?? "").slice(0, 240) };
}

/** The council's answer under ADR-0020 Amendment 8, reduced to its schema (an unknown change or reason reads as none), or null. */
export function cleanCouncilA8(o) {
  const base = cleanCouncil(o);
  if (!base) return null;
  const stop = o.stop === "loosen" ? "loosen" : "keep", target = ["nearer", "further"].includes(o.target) ? o.target : "keep";
  const stopReason = stop === "loosen" && LOOSEN_REASONS.includes(o.stop_reason) ? o.stop_reason : "none";
  const targetReason = target !== "keep" && [...TP_NEARER_REASONS, ...TP_FURTHER_REASONS].includes(o.target_reason) ? o.target_reason : "none";
  return { ...base, stop, stop_reason: stopReason, target, target_reason: targetReason };
}

/** Pure: the council's reading as stored (position_actions.council); the amendment's asks ride after the reason. */
export function councilText(c) {
  if (!c) return null;
  const asks = [...(c.stop === "loosen" ? [`stop loosen: ${c.stop_reason}`] : []), ...(c.target === "nearer" || c.target === "further" ? [`target ${c.target}: ${c.target_reason}`] : [])];
  return `${c.momentum}, thesis ${c.thesis}: ${c.reason}${asks.length ? ` [${asks.join("; ")}]` : ""}`;
}

/**
 * Today's spend of the position council in USD (from ai_usage_daily), with the limit entry's council since stage 3 of
 * docs/RFC_OMEGA_LIMIT_ENTRY.md (meter "entry_council"): both sit inside one daily cap (RFC §11).
 */
export const ENTRY_COUNCIL_METER = "entry_council";
export async function positionCouncilSpendUsd(db, { now = Date.now() } = {}) {
  await ensureAiUsageSchema(db);
  const day = new Date(now).toISOString().slice(0, 10);
  const rows = (await db.prepare("SELECT model, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c, SUM(cached_tokens) AS k FROM ai_usage_daily WHERE day = ? AND source IN (?, ?) GROUP BY model").bind(day, POSITION_COUNCIL_METER, ENTRY_COUNCIL_METER).all()).results || [];
  let neurons = 0;
  for (const r of rows) neurons += neuronsOf(r.model, Number(r.p) || 0, Number(r.c) || 0, Number(r.k) || 0) ?? 0;
  return Math.round((neurons / 1000) * USD_PER_1K_NEURONS * 10_000) / 10_000;
}

/**
 * The runner, on the main Worker's 5-minute cron: each open Omega position once per 5-minute bar. `deps` lets the
 * tests give the executor, the open intents, the signal, the decision, the model call and Telegram. Never throws.
 */
export async function runPositionManager(env, { now = Date.now(), call = callBusModel, send = null, executor: executorIn, openIntents: intentsIn, signal: signalIn, decision: decisionIn, events: eventsIn, gates: gatesIn } = {}) {
  if (positionManagerMode(env) !== "live") return { status: "off" };
  const db = env?.DB;
  if (!db) return { status: "unavailable" };
  try {
    await ensurePositionSchema(db);
    const executor = executorIn !== undefined ? executorIn : JSON.parse((await db.prepare("SELECT state FROM omega_bridge WHERE id = 1").first())?.state || "null");
    // Omega's own positions, and the manual ones the owner delegated (owner 2026-11-19, src/omega-hitl.mjs; needs
    // OmegaExecutor 1.18): a delegated position reads its own stop and target as its plan.
    let delegatedTickets = new Set();
    if (hitlSupported(executor)) { try { delegatedTickets = new Set((await readDelegations(db)).tickets); } catch { delegatedTickets = new Set(); } }
    const delegatedOf = (p) => delegatedTickets.has(Number(p?.ticket)) && (p?.source === "manual" || p?.magic === 0);
    const positions = (Array.isArray(executor?.positions) ? executor.positions : [])
      .map((p) => (delegatedOf(p) ? { ...p, intent_id: `deleg:${p.ticket}`, delegated: true } : p))
      .filter((p) => typeof p?.intent_id === "string" && (p.intent_id.startsWith("open:") || p.delegated === true) && (p.side === "BUY" || p.side === "SELL"));
    if (!positions.length) return { status: "no_positions" };
    const sym = executor?.symbol ?? {};
    const ids = positions.filter((p) => !p.delegated).map((p) => p.intent_id);
    const stored = intentsIn ?? (ids.length ? Object.fromEntries(((await db.prepare(`SELECT id, payload FROM omega_intents WHERE kind IN ('open', 'place_limit') AND id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).all()).results ?? []).map((r) => [r.id, JSON.parse(r.payload)])) : {});
    const openIntents = { ...stored };
    for (const p of positions.filter((x) => x.delegated)) {
      openIntents[p.intent_id] ??= { tp: Number(p.tp) > 0 ? p.tp : null, entry: p.open_price, sl: Number(p.sl) > 0 ? p.sl : null, strategy: null,
        ...(Number(p.sl) > 0 && Number.isFinite(Number(p.open_price)) ? { r_dist: Math.abs(Number(p.open_price) - Number(p.sl)) } : {}) };
    }
    let signal = signalIn;
    if (signal === undefined) { try { signal = await eaSignal(env, { now }); } catch { signal = null; } }
    const decision = decisionIn !== undefined ? decisionIn : await latestDecisions(db);
    const levels = brokerLevels(signal);
    // The TP ladder setting (Omega's settings, default on): TP2 waits for its TP1 lock (positionFacts ladder_hold).
    let ladder = OMEGA_DEFAULTS.tp_ladder === true, a8 = false, lockGate = profitLockGateOn(OMEGA_DEFAULTS);
    try { const row = await db.prepare("SELECT settings FROM omega_settings WHERE id = 1").first(); const st = row?.settings ? JSON.parse(row.settings) : {}; if (typeof st.tp_ladder === "boolean") ladder = st.tp_ladder; a8 = st.pm_loosen_enabled === true; lockGate = profitLockGateOn({ ...OMEGA_DEFAULTS, ...st }); } catch { /* the defaults */ }
    // SLG1 (owner 2026-11-23): with profit_lock_gate "on", each position's profit-lock gate, measured as Omega's sync
    // measures it (src/omega-broker.mjs profitLockGates: the broker's M1 corpus since the fill, the terminal's ATR(14,
    // M15), the decision's ATR(H1)); a position without facts reads as closed. "legacy": none, today's rules.
    let gates = null;
    if (lockGate) {
      if (gatesIn !== undefined) gates = gatesIn ?? {};
      else {
        const metaOf = (p) => {
          const it = openIntents[p.intent_id] ?? {};
          const rd = Number(it.r_dist) > 0 ? Number(it.r_dist) : Number.isFinite(Number(it.entry)) && Number.isFinite(Number(it.sl)) ? Math.abs(Number(it.entry) - Number(it.sl)) : null;
          const td = !p.delegated && Number.isFinite(Number(it.entry)) && Number(it.tp) > 0 ? Math.abs(Number(it.tp) - Number(it.entry)) : null;
          return { mode: p.delegated ? signal?.trading_mode ?? null : typeof it.mode === "string" ? it.mode : null, r_dist: rd, tp_dist: td };
        };
        try { gates = await (await import("./omega-broker.mjs")).profitLockGates(env, { executor: { ...executor, positions }, metaOf, now, atrH1: Number(decision?.strategy?.atr_h1) }); } catch { gates = {}; }
      }
    }
    // ADR-0020 Amendment 8 (owner 2026-11-20): with the owner's switch on, what the bounded loosening reads.
    const loosenOf = a8 ? await loosenInputs(env, db, { positions, openIntents, sym, now, events: eventsIn }) : null;
    const bar = Math.floor(now / 300_000);
    const capUsd = dailyCapUsd(env);
    const spent = await positionCouncilSpendUsd(db, { now });
    const out = [];
    // The daily cap reached: said once a day; the broker's stops and targets stay.
    if (spent >= capUsd && send) {
      const key = `pm:cap:${new Date(now).toISOString().slice(0, 10)}`;
      if (!(await env.SIGNAL_CACHE?.get?.(key))) {
        await env.SIGNAL_CACHE?.put?.(key, "1", { expirationTtl: 2 * 86_400 });
        try { await send(`XAUUSD POSITION MANAGER · paused for today\nThe position council reached its daily cap (USD ${capUsd}). No close until 00:00 UTC; the stop locks (break-even, TP1) still apply as the fallback, and the broker's stops and targets stay.`); } catch { /* said next time */ }
      }
    }
    for (const p of positions) {
      const id = `pm:${p.ticket}:${bar}`;
      if (await db.prepare("SELECT id FROM position_actions WHERE id = ?").bind(id).first()) continue;
      const f = positionFacts({ position: p, sym, openIntent: openIntents[p.intent_id], levels, decision, ladder, signal, ...(loosenOf ? { loosen: loosenOf(p) } : {}), ...(gates ? { gate: gates[String(p.ticket)] ?? null } : {}) });
      let council = null, councilNote = null;
      if (f && spent < capUsd) {
        try {
          const r = await call(env, { messages: positionCouncilMessages(f, { m5: signal, levels }), schemaName: "position_council", schema: f.loosen ? POSITION_COUNCIL_SCHEMA_A8 : POSITION_COUNCIL_SCHEMA, maxTokens: f.loosen ? 500 : 400, effort: "low", deadline: Date.now() + 45_000, clock: () => Date.now(), runState: {}, role: "agent", meterSource: POSITION_COUNCIL_METER });
          council = r?.status === "answered" ? (f.loosen ? cleanCouncilA8(r.obj) : cleanCouncil(r.obj)) : null;
          if (!council) councilNote = "council_failed";
        } catch { council = null; councilNote = "council_failed"; }
      } else if (f) councilNote = "daily_cap";
      const a = positionAction(f, council);
      const row = { id, ticket: p.ticket, bar, at_ms: now, side: p.side, pips: f?.pips ?? null, price: f?.price ?? null, action: a.action, rule: councilNote && a.action === "none" ? councilNote : a.rule,
        sl: a.sl ?? null, tp: a.tp ?? null, why: a.why, council: councilText(council),
        orig_sl: f?.sl ?? null, orig_tp: f?.tp ?? null, basis: isNum(signal?.feed_basis) ? signal.feed_basis : null, status: ["close", "sl", "tp"].includes(a.action) ? "pending" : "noted" };
      await db.prepare("INSERT OR IGNORE INTO position_actions (id, ticket, bar, at_ms, side, pips, price, action, rule, sl, tp, why, council, orig_sl, orig_tp, basis, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(row.id, row.ticket, row.bar, row.at_ms, row.side, row.pips, row.price, row.action, row.rule, row.sl, row.tp, row.why, row.council, row.orig_sl, row.orig_tp, row.basis, row.status).run();
      // No Telegram line here: Omega says what reached the broker, or why the action was not applied (owner 2026-11-19).
      out.push({ ticket: row.ticket, action: row.action, rule: row.rule, pips: row.pips });
    }
    return { status: "ran", spent_usd: spent, cap_usd: capUsd, positions: out };
  } catch (error) {
    return { status: "failed", error: String(error?.message ?? error).slice(0, 160) };
  }
}

/**
 * What the bounded loosening reads for each position (ADR-0020 Amendment 8), read once a run with the switch on: the
 * loosenings already sent (omega_intents, a failed one excepted, and this manager's own pending actions), the ATR(14,
 * 15m) at the last Omega tighten, the calendar's high-impact USD release in its window. Returns (position) => loosen
 * input for positionFacts. A record that cannot be read is said as unreadable: nothing is loosened then.
 */
export const LOOSEN_LOOKBACK_MS = 30 * 86_400_000;
export async function loosenInputs(env, db, { positions = [], openIntents = {}, sym = {}, now = Date.now(), events = undefined } = {}) {
  let records = {}, unreadable = false;
  const tickets = positions.map((p) => Number(p.ticket)).filter((t) => t > 0);
  try {
    const rows = (await db.prepare("SELECT payload, status, result FROM omega_intents WHERE kind IN ('modify_sl', 'modify_sltp') AND json_extract(payload, '$.loosen') = 1 AND created_ms > ?").bind(now - LOOSEN_LOOKBACK_MS).all()).results ?? [];
    records = loosenRecords(rows);
    const pending = (await db.prepare("SELECT ticket FROM position_actions WHERE rule LIKE 'loosen%' AND status = 'pending'").all()).results ?? [];
    for (const r of pending) records[String(r.ticket)] ??= { pending: true };
  } catch { unreadable = true; }
  const atrRef = {};
  for (const t of tickets) {
    try {
      const row = await db.prepare("SELECT payload FROM omega_intents WHERE kind IN ('modify_sl', 'modify_sltp') AND status = 'done' AND json_extract(result, '$.ok') = 1 AND json_extract(payload, '$.ticket') = ? AND json_extract(payload, '$.atr') IS NOT NULL AND json_extract(payload, '$.loosen') IS NULL ORDER BY created_ms DESC LIMIT 1").bind(t).first();
      const a = Number(JSON.parse(row?.payload ?? "null")?.atr);
      if (a > 0) atrRef[t] = a;
    } catch { /* the entry's ATR then */ }
  }
  let release = null;
  try {
    const list = events !== undefined ? events : await gatedEvents(env, { now });
    const e = eventRisk(list ?? [], now).active[0];
    if (e) release = { title: e.title, time: e.time };
  } catch { release = null; }
  const atrNow = isNum(sym?.atr_value) && sym.atr_value > 0 ? sym.atr_value : null;
  return (p) => ({ orig_sl: p.delegated ? null : openIntents[p.intent_id]?.sl ?? null, atr_now: atrNow, atr_ref: atrRef[Number(p.ticket)] ?? null, atr_ref_source: atrRef[Number(p.ticket)] ? "last_tighten" : null,
    loosened: Boolean(records[String(p.ticket)]), from_sl: records[String(p.ticket)]?.from_sl ?? null, unreadable, release, delegated: p.delegated === true });
}

/** The latest decision with the quorum of the bar before (quorum_prev), or null. */
export async function latestDecisions(db) {
  try {
    const rows = (await db.prepare("SELECT decision_json FROM engine_decisions ORDER BY bar_close DESC LIMIT 2").all()).results ?? [];
    const [d, prev] = rows.map((r) => JSON.parse(r.decision_json));
    if (!d) return null;
    const fresh = prev && Date.parse(d.bar_close) - Date.parse(prev.bar_close) === 15 * 60_000;
    return { ...d, quorum_prev: fresh ? prev.quorum ?? null : null };
  } catch { return null; }
}

/** Pure: the signal's key levels on the broker's scale (as Omega reads them), [] without a known basis. */
export function brokerLevels(signal) {
  if (signal?.feed_basis_known !== true || !isNum(signal?.feed_basis) || typeof signal?.key_levels !== "string") return [];
  return signal.key_levels.split(",").map((s) => s.split(":").map(Number)).filter(([lo, hi]) => isNum(lo) && isNum(hi) && lo > 0 && lo <= hi).map(([lo, hi]) => ({ low: lo + signal.feed_basis, high: hi + signal.feed_basis })).sort((a, b) => a.low - b.low);
}

/**
 * Pure: the day's report, each action against holding to the original stop and target (owner: no shadow phase, so
 * this is how it is judged). `bars` are closed bars on the feed's scale ({ open_time, high, low, close }); a row's
 * `basis` maps them to the broker's scale. A close is worth its exit pips minus what holding would have made (the
 * first of the original stop or target touched after it; the last close when neither was). A stop or target move is
 * not scored here (its exit is a later close the broker reports).
 */
export function positionReport(rows, bars, { now = Date.now() } = {}) {
  const ms = (b) => (typeof b.open_time === "number" ? b.open_time : Date.parse(b.open_time));
  const items = [];
  let saved = 0, scored = 0;
  for (const r of rows) {
    if (r.action !== "close" || r.status !== "applied") { items.push({ ticket: r.ticket, rule: r.rule, action: r.action, status: r.status ?? null, pips: r.pips, held_pips: null, saved_pips: null }); continue; }
    const dir = r.side === "BUY" ? 1 : -1, basis = isNum(r.basis) ? r.basis : 0;
    const after = bars.filter((b) => ms(b) >= r.at_ms && ms(b) <= now);
    let heldExit = null;
    for (const b of after) {
      const hi = b.high + basis, lo = b.low + basis;
      const hitSl = isNum(r.orig_sl) && (dir > 0 ? lo <= r.orig_sl : hi >= r.orig_sl);
      const hitTp = isNum(r.orig_tp) && (dir > 0 ? hi >= r.orig_tp : lo <= r.orig_tp);
      if (hitSl) { heldExit = r.orig_sl; break; }
      if (hitTp) { heldExit = r.orig_tp; break; }
    }
    if (heldExit == null && after.length) heldExit = after.at(-1).close + basis;
    const open = isNum(r.price) && isNum(r.pips) ? r.price - dir * r.pips * PIP : null;
    const held = heldExit != null && open != null ? pipsOf(dir * (heldExit - open)) : null;
    const s = held != null && isNum(r.pips) ? r1(r.pips - held) : null;
    if (s != null) { saved += s; scored += 1; }
    items.push({ ticket: r.ticket, rule: r.rule, action: r.action, status: r.status ?? null, pips: r.pips, held_pips: held, saved_pips: s });
  }
  return { actions: rows.length, scored, saved_pips: r1(saved), items };
}

/** The UTC hour of the daily report (after New York's close). */
export const REPORT_HOUR = 21;

/** Pure: the daily report as a Telegram text. */
export function reportMessage(day, rep) {
  const lines = rep.items.filter((i) => ["close", "sl", "tp"].includes(i.action)).map((i) => `#${i.ticket} ${i.rule}${i.status && i.status !== "applied" ? ` (not applied: ${i.status})` : ""}: ${i.pips >= 0 ? "+" : ""}${i.pips} pips${i.saved_pips != null ? ` · held to the original stop/target: ${i.held_pips >= 0 ? "+" : ""}${i.held_pips} → ${i.saved_pips >= 0 ? "saved" : "lost"} ${Math.abs(i.saved_pips)} pips` : ""}`);
  return [`XAUUSD POSITION MANAGER · report ${day}`, lines.length ? `${lines.length} action${lines.length === 1 ? "" : "s"}; closes against holding: ${rep.saved_pips >= 0 ? "+" : ""}${rep.saved_pips} pips (${rep.scored} scored)` : "No action today.", ...lines.slice(0, 20)].join("\n");
}

/** The daily report, once after REPORT_HOUR UTC: today's actions against holding to the original stop and target. Never throws. */
export async function runPositionReport(env, { now = Date.now(), send = null, bars: barsIn } = {}) {
  if (positionManagerMode(env) !== "live" || !env?.DB || new Date(now).getUTCHours() < REPORT_HOUR) return { status: "waiting" };
  const day = new Date(now).toISOString().slice(0, 10), key = `pm:report:${day}`;
  try {
    if (await env.SIGNAL_CACHE?.get?.(key)) return { status: "done" };
    await ensurePositionSchema(env.DB);
    const from = Date.parse(`${day}T00:00:00Z`);
    const rows = (await env.DB.prepare("SELECT * FROM position_actions WHERE at_ms >= ? AND action IN ('close', 'sl', 'tp') ORDER BY at_ms").bind(from).all()).results ?? [];
    let bars = barsIn;
    if (bars === undefined) { try { bars = await (await import("./signal-ledger.mjs")).ledgerBars(env); } catch { bars = []; } }
    const rep = positionReport(rows, bars ?? [], { now });
    await env.SIGNAL_CACHE?.put?.(key, "1", { expirationTtl: 3 * 86_400 });
    if (send && rows.length) { try { await send(reportMessage(day, rep)); } catch { /* the report is in /api/omega/position-manager */ } }
    return { status: "reported", ...rep };
  } catch (error) {
    return { status: "failed", error: String(error?.message ?? error).slice(0, 160) };
  }
}

/** The recent actions and today's report (GET /api/omega/position-manager). Never throws. */
export async function readPositionManager(env, { now = Date.now(), limit = 50 } = {}) {
  try {
    await ensurePositionSchema(env.DB);
    const rows = (await env.DB.prepare("SELECT * FROM position_actions ORDER BY at_ms DESC LIMIT ?").bind(Math.max(1, Math.min(200, Number(limit) || 50))).all()).results ?? [];
    return { version: "cryptophys.position-manager.v1", mode: positionManagerMode(env), cap_usd: dailyCapUsd(env), spent_usd: await positionCouncilSpendUsd(env.DB, { now }), threshold_pips: THRESHOLD_PIPS, band_r: PM_R_BAND, rows };
  } catch (error) {
    return { version: "cryptophys.position-manager.v1", error: String(error?.message ?? error).slice(0, 160), rows: [] };
  }
}
