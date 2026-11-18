// Omega broker engine (owner decisions 2026-11-09: "Omega memegang akses broker"; "Mati sampai Anda
// aktifkan"). Pure: turns the EA signal (GET /api/ea/signal: the Decision Engine's 15m decision since #212), the Omega control, the engine settings and the bridge's last
// executor state into order intents for the owner's MT5 terminal (docs/OMEGA_BRIDGE_PROTOCOL.md).
// It runs only when the bridge syncs (src/omega-broker.mjs), never on a cron, and never calls anything.
//
// Gates, in order (each skip leaves a note with a code):
//   kill      signal.kill (EA_SIGNALS_ENABLED="false") or control "killed" → one close_all when there
//             is a position, whatever else holds (also with the engine off or a stale executor).
//   engine    OMEGA_ENGINE_ENABLED !== "true" or settings.enabled !== true → nothing.
//   executor  missing, not connected, or written more than EXECUTOR_MAX_AGE_MS ago → nothing.
//   opposite  a position against the signal's side is closed (allowed when paused or not armed).
//   open      BUY/SELL, not expired, not older than max_signal_age_ms, no blackout, not paused, a real
//             account only when live_armed, spread, max positions, no stacking on a side whose positions
//             are not yet protected, the daily loss limit, one open per signal; SL/TP keep the signal's
//             distances from the broker's own price; the volume risks risk_pct of equity at the stop,
//             capped by the daily risk budget (equity above the daily loss floor less the open risk at
//             the stops).
// Intent ids are deterministic and at most 31 characters (they become the MT5 order comment).

import { confidenceTrend, parseConfidences } from "./agent-confidence.mjs";
import { goldCheckOf, mappedPriceProblem } from "./gold-symbol.mjs";
import { versionAtLeast, EXECUTOR_ENTRY_MIN_VERSION, effectiveLimits, PROFILES } from "./account-spec.mjs";

export const OMEGA_DEFAULTS = Object.freeze({
  enabled: false,
  live_armed: false,
  risk_pct: 0.5,
  max_positions: 1,
  max_daily_loss_pct: 2,
  max_spread_points: 60,
  // Like the EA (1.11): the Decision Engine decides at every 15m close, so a signal is fresh for 10 minutes.
  max_signal_age_ms: 10 * 60_000,
  policy_auto: false,
  trailing_stop_r: 0,
  // 5m execution (docs/RFC_OMEGA_5M_EXECUTION.md, owner 2026-11-12): a stop tightened to the broker's 5m
  // structure may raise the lot at most to this many times the lot at the plan's stop.
  tight_stop_max_lot_factor: 1.5,
  adaptive_volatility: true,
  sor_mode: "auto_failover",
  // The TP ladder (owner 2026-11-18, relayed and confirmed: "a, langsung live", every mode): see ladderPlan.
  tp_ladder: true,
  partial_min_pct: 25,
  partial_max_pct: 50,
  ladder_lock_pips: 30,
  ladder_max_partials: 3,
  // The same-side re-entry guard (owner 2026-11-18, confirmed: "Setuju"): see reentryGate.
  reentry_cooldown_bars: 1,
  reentry_pullback_atr: 0.5,
  // The ladder's step per mode (owner 2026-11-18, confirmed: "Setuju"): scalp ladder_lock_pips, intraday and swing in R.
  ladder_r_intraday: 0.5,
  ladder_r_swing: 0.3
});
// 10 since 2026-11-18 (owner: "Naikkan ke 10%, dikunci profil", docs/RFC_ACCOUNT_PROFILES.md §4): the setting may go
// to the RFC's 10% maximum; what an entry risks is the smaller of the setting and the account profile's target (Safe 1%,
// Conservative 2%, Aggressive 5%), and Custom uses the setting itself. It was 2, which held every profile at 2%.
export const RISK_PCT_MAX = 10;
export const EXECUTOR_MAX_AGE_MS = 60_000;
export const INTENT_ID_MAX = 31;

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const positive = (v) => finite(v) && v > 0;
const decimals = (v) => { const s = String(v); if (s.includes("e-")) return Number(s.split("e-")[1]); return (s.split(".")[1] || "").length; };
const roundTo = (v, digits) => Number(v.toFixed(Math.max(0, Math.min(10, digits))));
/** Floors v to a multiple of step, without float noise (0.1 / 0.01 stays 0.1). */
export function floorToStep(v, step) {
  const d = decimals(step);
  return roundTo(Math.floor(roundTo(v / step, 8)) * step, d);
}

/**
 * Daily Rollover Quarantine Window (21:55 - 22:15 UTC):
 * Prevents opening new positions when interbank liquidity dries up and broker spreads widen dramatically.
 */
export const ROLLOVER_QUARANTINE_UTC = "21:55-22:15";
export function isRolloverQuarantine(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return (h === 21 && m >= 55) || (h === 22 && m < 15);
}

/**
 * Validates a settings change and merges it onto the stored settings (unspecified fields keep their
 * stored value). `enabled: false` disarms live; arming live needs confirm "LIVE" and enabled.
 */
export function settingsFrom(body, current = OMEGA_DEFAULTS) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body must be a JSON object" };
  const out = { ...OMEGA_DEFAULTS, ...(current && typeof current === "object" ? pickSettings(current) : {}) };
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return { error: "enabled must be true or false" };
    out.enabled = body.enabled;
  }
  const num = (key, lo, hi, { integer = false } = {}) => {
    if (body[key] === undefined) return null;
    const v = body[key];
    if (!finite(v) || v < lo || v > hi || (integer && !Number.isInteger(v))) return `${key} must be ${integer ? "an integer" : "a number"} from ${lo} to ${hi}`;
    out[key] = v;
    return null;
  };
  const err = num("risk_pct", 0.01, RISK_PCT_MAX)
    ?? num("max_positions", 1, 5, { integer: true })
    ?? num("max_daily_loss_pct", 0.1, 20)
    ?? num("max_spread_points", 1, 1000)
    ?? num("max_signal_age_ms", 60_000, 60 * 60_000, { integer: true })
    ?? num("trailing_stop_r", 0, 5)
    ?? num("tight_stop_max_lot_factor", 1, 2)
    ?? num("partial_min_pct", 10, 50)
    ?? num("partial_max_pct", 25, 75)
    ?? num("ladder_lock_pips", 5, 100)
    ?? num("ladder_max_partials", 0, 5, { integer: true })
    ?? num("reentry_cooldown_bars", 0, 8, { integer: true })
    ?? num("reentry_pullback_atr", 0, 3)
    ?? num("ladder_r_intraday", 0.1, 2)
    ?? num("ladder_r_swing", 0.1, 2);
  if (err) return { error: err };
  if (out.partial_min_pct > out.partial_max_pct) return { error: "partial_min_pct must not be above partial_max_pct" };
  if (body.tp_ladder !== undefined) {
    if (typeof body.tp_ladder !== "boolean") return { error: "tp_ladder must be true or false" };
    out.tp_ladder = body.tp_ladder;
  }
  if (body.max_signal_age_min !== undefined) {
    const m = body.max_signal_age_min;
    if (!finite(m) || m < 1 || m > 60) return { error: "max_signal_age_min must be a number from 1 to 60" };
    out.max_signal_age_ms = Math.round(m * 60_000);
  }
  if (body.policy_auto !== undefined) {
    if (typeof body.policy_auto !== "boolean") return { error: "policy_auto must be true or false" };
    out.policy_auto = body.policy_auto;
  }
  if (body.adaptive_volatility !== undefined) {
    if (typeof body.adaptive_volatility !== "boolean") return { error: "adaptive_volatility must be true or false" };
    out.adaptive_volatility = body.adaptive_volatility;
  }
  if (body.sor_mode !== undefined) {
    if (typeof body.sor_mode !== "string" || !["primary_only", "auto_failover"].includes(body.sor_mode)) {
      return { error: "sor_mode must be 'primary_only' or 'auto_failover'" };
    }
    out.sor_mode = body.sor_mode;
  }
  if (body.live_armed !== undefined) {
    if (typeof body.live_armed !== "boolean") return { error: "live_armed must be true or false" };
    if (body.live_armed) {
      if (body.confirm !== "LIVE") return { error: "type LIVE to arm a real account" };
      if (!out.enabled) return { error: "enable the engine before arming live" };
    }
    out.live_armed = body.live_armed;
  }
  if (!out.enabled) out.live_armed = false;
  return { settings: out };
}

function pickSettings(s) {
  const out = {};
  for (const k of Object.keys(OMEGA_DEFAULTS)) if (s[k] !== undefined && s[k] !== null) out[k] = k === "enabled" || k === "live_armed" ? Boolean(s[k]) : s[k];
  return out;
}

/** The stable key of one kill: the control's change time, or "env" for the EA_SIGNALS_ENABLED switch. */
function killKey(signal, control) {
  if (control?.mode === "killed") {
    const at = Date.parse(control.at ?? "");
    return Number.isFinite(at) ? String(at) : "0";
  }
  return "env";
}

export const openId = (issuedMs, side) => `open:${issuedMs}:${side === "BUY" ? "B" : "S"}`;
export const closeId = (ticket) => `cl:${ticket}:opp`;
export const closeAllId = (key) => `ka:${key}`;

/**
 * Distinguish Omega-owned algorithmic positions from discretionary manual/mobile or external positions.
 * Automated trade lifecycle rules (opposite close, mean reversal, trailing SL, scale-out) strictly touch
 * only Omega-owned positions. Discretionary positions are monitored for total account risk but never
 * auto-closed or trailed by the AI engine.
 */
export function isOmegaOwned(p) {
  if (!p) return false;
  if (p.source === "omega") return true;
  if (p.magic === 920200) return true;
  if (typeof p.intent_id === "string" && p.intent_id.startsWith("open:")) return true;
  if (p.source === "manual" || p.source === "external" || p.magic === 0) return false;
  // Fallback for legacy unit tests without source/magic annotations
  return true;
}

/**
 * @returns {{ intents: object[], notes: { code: string }[] }}
 */
// Key-level management (owner 2026-11-12: "semua dikontrol dari omega bukan EA", "atur SL+ dan Trailing
// TP juga harus berdasarkan keylevel menyesuaikan Bull/Bear Power", "Bull/Bear power dihasilkan decision
// engine hasil quorum", "Tutup jika Power berbalik"). Power is the latest decision's quorum score, signed
// for the position (+ with it, - against it).
export const POWER_STRONG = 0.5;
export const POWER_WEAK = 0.2;
export const POWER_FRESH_MS = 35 * 60_000;

/** Pure: the signal's key levels on the broker's scale ({ low, high }, lowest first), or null without a known basis. */
export function brokerKeyLevels(signal) {
  if (signal?.feed_basis_known !== true || !finite(signal.feed_basis) || typeof signal.key_levels !== "string" || !signal.key_levels) return null;
  const out = [];
  for (const part of signal.key_levels.split(",")) {
    const [lo, hi] = part.split(":").map(Number);
    if (positive(lo) && positive(hi) && lo <= hi) out.push({ low: lo + signal.feed_basis, high: hi + signal.feed_basis });
  }
  return out.length ? out.sort((a, b) => a.low - b.low) : null;
}

/** Pure: the power band of a signed power: "strong" (with the position), "weak", "reversed" (strongly against) or "normal". */
export function powerBand(p) {
  if (!finite(p)) return "normal";
  if (p <= -POWER_STRONG) return "reversed";
  if (p >= POWER_STRONG) return "strong";
  if (p < POWER_WEAK) return "weak";
  return "normal";
}

/**
 * Pure: one position's key-level plan: { close } when the power turned strongly against a position in
 * profit; else { sl, tp, band } (each null when unchanged).
 *   SL+          once price has passed a key level beyond the entry, the stop locks a small profit
 *                (break-even plus max(2 spreads, the buffer)) and steps behind the passed levels: with a
 *                strong power behind the one before the last passed (room to run), normally behind the
 *                last passed, with a weak power at the tighter of that and the broker's 5m swing.
 *   trailing TP  near the take-profit (within max(0.5 x 5m ATR, 3 spreads, 0.2 x the open-to-target
 *                distance)) with a strong power, the target moves to the next key level and the stop to
 *                the old target, less the buffer; with a weaker power the target stays and is taken.
 * The stop only moves in the position's favour and keeps the broker's stop distance from price.
 */
export function keyLevelPlan({ position: p, sym, signal, levels, now = Date.now(), extend = true }) {
  const buy = p.side === "BUY", dir = buy ? 1 : -1;
  const open = Number(p.open_price ?? p.entry), curSl = Number(p.sl), curTp = Number(p.tp);
  const digits = Number.isInteger(sym.digits) ? sym.digits : 2;
  const point = positive(sym.point) ? sym.point : Math.pow(10, -digits);
  const spreadPx = (finite(sym.spread_points) ? sym.spread_points : 0) * point;
  const atr5 = positive(signal?.m5_atr) ? signal.m5_atr : null;
  const buffer = Math.max(2 * spreadPx, atr5 ? 0.1 * atr5 : 0, point);
  const floorPx = (finite(sym.stops_level_points) ? sym.stops_level_points : 0) * point + spreadPx;
  const price = buy ? sym.bid : sym.ask;
  const fresh = finite(signal?.power_ms) && signal.power_ms > 0 && now - signal.power_ms <= POWER_FRESH_MS;
  const band = fresh ? powerBand(dir * signal.power) : "normal";
  const move = dir * (price - open);
  if (band === "reversed" && move > 0) return { close: true, band };

  const behind = (z) => (buy ? z.low - buffer : z.high + buffer);
  const better = (a, b) => (!finite(b) ? true : buy ? a > b + point : a < b - point);
  const room = (sl) => (buy ? sl < sym.bid - floorPx : sl > sym.ask + floorPx);
  const candidates = [];
  // SL+: the key levels wholly beyond the entry that price has passed, nearest to price first.
  const passed = levels.filter((z) => (buy ? z.low > open && z.high < price - buffer : z.high < open && z.low > price + buffer)).sort((a, b) => (buy ? b.high - a.high : a.low - b.low));
  if (passed.length) {
    const lock = open + dir * Math.max(2 * spreadPx, buffer);
    let sl = band === "strong" ? (passed[1] ? behind(passed[1]) : lock) : behind(passed[0]);
    if (band === "weak" && positive(buy ? signal?.m5_swing_low : signal?.m5_swing_high)) {
      const swing = buy ? signal.m5_swing_low - buffer : signal.m5_swing_high + buffer;
      if (better(swing, sl)) sl = swing;
    }
    if (!better(sl, lock)) sl = lock;
    candidates.push(sl);
  }
  // Trailing TP: near the target with a strong power, the next key level beyond it.
  let tp = null;
  // Owner 2026-11-16 (docs/RFC_STRATEGY_EXECUTION.md): the target is extended only while the agent's confidence holds.
  if (extend && finite(curTp) && curTp > 0 && band === "strong") {
    const near = Math.max(atr5 ? 0.5 * atr5 : 0, 3 * spreadPx, 0.2 * Math.abs(curTp - open));
    if (dir * (curTp - price) <= near) {
      const next = levels.filter((z) => (buy ? z.low > curTp + buffer : z.high < curTp - buffer)).sort((a, b) => (buy ? a.low - b.low : b.high - a.high))[0];
      if (next) { tp = roundTo(buy ? next.low : next.high, digits); candidates.push(curTp - dir * buffer); }
    }
  }
  const valid = candidates.map((x) => roundTo(x, digits)).filter((x) => x > 0 && room(x) && better(x, curSl));
  const sl = valid.length ? valid.reduce((a, b) => (buy ? Math.max(a, b) : Math.min(a, b))) : null;
  return { sl, tp, band };
}

// The TP ladder (owner 2026-11-18, relayed by the orchestrator and confirmed in the session: "a, langsung live,
// termasuk agent juga bisa dinamis mengatur TP sebagian secara progresive"; every mode, Scalp included).
export const GOLD_PIP = 0.1;

/**
 * Pure: a position's ladder TP1..TPn in its profit direction, nearest first. The rungs are the key levels wholly
 * between the entry and the take-profit (their near edge), then the take-profit itself; without such a level, a third
 * and two thirds of the way to the take-profit, then the take-profit. [] without a take-profit beyond the entry.
 */
export function ladderRungs({ position: p, levels = null, buffer = 0 }) {
  const buy = p.side === "BUY", dir = buy ? 1 : -1;
  const open = Number(p.open_price ?? p.entry), tp = Number(p.tp);
  if (!finite(open) || !positive(tp) || dir * (tp - open) <= buffer) return [];
  const inside = (levels ?? [])
    .map((z) => (buy ? z.low : z.high))
    .filter((x) => dir * (x - open) > buffer && dir * (tp - x) > buffer)
    .sort((a, b) => dir * (a - b));
  const rungs = inside.length ? inside : [open + (tp - open) / 3, open + (2 * (tp - open)) / 3];
  return [...rungs, tp];
}

/** Pure: whether the stop (the current one, or one planned in this sync) locks a profit at or beyond the ladder's TP1. */
export function ladderTp1Locked({ position: p, levels = null, sym = {}, signal = null, plannedSl = null }) {
  const buy = p.side === "BUY";
  const digits = Number.isInteger(sym.digits) ? sym.digits : 2;
  const point = positive(sym.point) ? sym.point : Math.pow(10, -digits);
  const spreadPx = (finite(sym.spread_points) ? sym.spread_points : 0) * point;
  const buffer = Math.max(2 * spreadPx, positive(signal?.m5_atr) ? 0.1 * signal.m5_atr : 0, point);
  const rungs = ladderRungs({ position: p, levels, buffer });
  if (rungs.length < 2) return false;
  const tp1 = rungs[0];
  const sls = [Number(p.sl), Number(plannedSl)].filter((x) => finite(x) && x > 0);
  return sls.some((sl) => (buy ? sl >= tp1 - 1e-9 : sl <= tp1 + 1e-9));
}

/** Pure: the share of the volume a partial takes, by the power behind the position, within the owner's bounds. */
export function partialShare(band, S) {
  const lo = Math.max(0, Math.min(S.partial_min_pct, S.partial_max_pct)) / 100, hi = Math.max(S.partial_min_pct, S.partial_max_pct) / 100;
  if (band === "strong") return lo;          // room to run: bank the least
  if (band === "weak" || band === "reversed") return hi; // fading: bank the most
  return (lo + hi) / 2;
}

/**
 * Pure: one position's ladder step: { sl, sl_rung, partial: { volume, rung, share } | null }.
 *   SL lock   once price is `ladder_lock_pips` past TPx, the stop locks at TPx-1 (TP0 = the entry plus the lock
 *             buffer): only ever tighter than the current stop, with the broker's stop distance from price.
 *   partial   at each rung reached, one partial close of the current volume (partialShare: the power band picks
 *             25% to 50%, the owner's bounds), at most `ladder_max_partials` a position, one per sync. The volume
 *             keeps the broker's step and minimum and leaves at least the minimum open; otherwise no partial.
 * Exposure only goes down: no add, no wider stop, no take-profit moved outward.
 */
/** The closed candle each mode's ladder confirms on (owner 2026-11-18): scalp M5, intraday M15, swing H1. */
export const LADDER_CONFIRM_TF = Object.freeze({ scalp: "M5", intraday: "M15", swing: "H1" });

/**
 * Pure: the ladder's step for a position by the mode it opened in (`meta`: { mode, r_dist } from its open intent):
 * scalp (or unknown) ladder_lock_pips x 0.1; intraday ladder_r_intraday x R; swing ladder_r_swing x R, R being the
 * stop distance at entry. null when an R step has no R (then the ladder locks nothing new).
 */
export function ladderStep(meta, S) {
  const mode = meta?.mode === "intraday" || meta?.mode === "swing" ? meta.mode : "scalp";
  if (mode === "scalp") return { mode, step: S.ladder_lock_pips * GOLD_PIP, unit: "pips" };
  const r = Number(meta?.r_dist);
  if (!(r > 0)) return { mode, step: null, unit: "R" };
  return { mode, step: r * (mode === "intraday" ? S.ladder_r_intraday : S.ladder_r_swing), unit: "R" };
}

export function ladderPlan({ position: p, sym, signal = null, levels = null, settings = OMEGA_DEFAULTS, partialsDone = 0, now = Date.now(), meta = null, candles = undefined }) {
  const S = { ...OMEGA_DEFAULTS, ...pickSettings(settings ?? {}) };
  const buy = p.side === "BUY", dir = buy ? 1 : -1;
  const open = Number(p.open_price ?? p.entry), curSl = Number(p.sl), vol = Number(p.volume);
  const digits = Number.isInteger(sym.digits) ? sym.digits : 2;
  const point = positive(sym.point) ? sym.point : Math.pow(10, -digits);
  const spreadPx = (finite(sym.spread_points) ? sym.spread_points : 0) * point;
  const buffer = Math.max(2 * spreadPx, positive(signal?.m5_atr) ? 0.1 * signal.m5_atr : 0, point);
  const floorPx = (finite(sym.stops_level_points) ? sym.stops_level_points : 0) * point + spreadPx;
  const price = buy ? sym.bid : sym.ask;
  const none = { sl: null, sl_rung: null, partial: null };
  if (!finite(price) || !finite(open)) return none;
  const rungs = ladderRungs({ position: p, levels, buffer });
  if (!rungs.length) return none;
  const reached = rungs.filter((x) => dir * (price - x) >= 0).length;
  // SL lock (owner 2026-11-18, confirmed): one step past the entry, the stop goes to break-even (plus the buffer); one
  // step past TPx, to TPx (below). The step is the mode's (ladderStep). With `candles` (the planner always passes them) the
  // trigger is the mode's last CLOSED candle (LADDER_CONFIRM_TF): its close beyond the level and the candle itself in the
  // trade's direction (no reversal candle); no such candle, no new lock. Without `candles`, the live price (tests).
  const { step: lockPx, mode } = ladderStep(meta, S);
  const candle = candles === undefined ? null : candles?.[LADDER_CONFIRM_TF[mode]] ?? null;
  // A candle that closed before the position opened confirms nothing about it (it needs a close after the entry).
  const openedMs = Number(p.opened_ms);
  const afterEntry = candle && finite(candle.close_ms) && finite(openedMs) && candle.close_ms > openedMs;
  const trigger = candles === undefined ? price
    : afterEntry && finite(candle.c) && finite(candle.o) && (buy ? candle.c >= candle.o : candle.c <= candle.o) ? candle.c : null;
  const L = [open, ...rungs];
  const past = lockPx != null && finite(trigger) ? L.filter((x) => dir * (trigger - x) >= lockPx).length : 0;
  let sl = null, slRung = null;
  // Owner 2026-11-18 (the owner's own words: "TP1+1 langkah geser ke TP1, TP2+1 langkah, geser ke TP2, dan seterusnya"): one
  // step past the entry, break-even (TP0); one step past TPx, TPx.
  if (past >= 1) {
    const rung = past - 1;
    const target = roundTo(rung === 0 ? open + dir * buffer : L[rung], digits);
    const better = !finite(curSl) || curSl <= 0 ? true : buy ? target > curSl + point : target < curSl - point;
    const room = buy ? target < sym.bid - floorPx : target > sym.ask + floorPx;
    if (target > 0 && better && room) { sl = target; slRung = rung; }
  }
  // Partial: one per rung reached, at most ladder_max_partials.
  let partial = null;
  if (reached > partialsDone && partialsDone < S.ladder_max_partials && finite(vol) && vol > 0) {
    const fresh = finite(signal?.power_ms) && signal.power_ms > 0 && now - signal.power_ms <= POWER_FRESH_MS;
    const band = fresh ? powerBand(dir * signal.power) : "normal";
    const share = partialShare(band, S);
    const step = positive(sym.volume_step) ? sym.volume_step : 0.01;
    const min = positive(sym.volume_min) ? sym.volume_min : 0.01;
    const volume = floorToStep(vol * share, step);
    if (volume >= min && roundTo(vol - volume, 8) >= min) partial = { volume, rung: partialsDone + 1, share, band };
  }
  return { sl, sl_rung: slRung, partial };
}

/**
 * Pure: the management of the positions already open (audit 2026-11-11), on every sync whatever the
 * entry gates say. `skipTickets` are positions being closed in the same plan.
 *   key levels  with the signal's key levels on a known basis (owner 2026-11-12): SL+, trailing TP and
 *               the close on a reversed power (keyLevelPlan); they replace the 5m trail and the extended
 *               target, which remain the fallback without key levels;
 *   break-even  with trailing_stop_r > 0: a position at trailing_stop_r R or more moves its stop to its
 *               open price (R from the open price and the stop before break-even);
 *   extended    a farther TP2 or extended target of the current signal moves the take-profit of the
 *               positions on the signal's side;
 *   scale-out   a position of 0.02 lots or more at 1.5R or its target banks half, once per position.
 */
export function manageIntents({ positions = [], sym = {}, settings = OMEGA_DEFAULTS, signal = null, side = null, recentIntentIds = [], skipTickets = [], now = Date.now(), extendOf = () => true, positionMeta = {}, candles = undefined } = {}) {
  const S = { ...OMEGA_DEFAULTS, ...pickSettings(settings ?? {}) };
  const out = [];
  if (!finite(sym.bid) || !finite(sym.ask)) return out;
  const digits = Number.isInteger(sym.digits) ? sym.digits : 2;
  const skip = new Set(skipTickets.filter((t) => t != null));
  const recent = new Set(recentIntentIds);
  const scaledBefore = (ticket) => [...recent].some((rid) => String(rid).startsWith(`ps:${ticket}:`));
  const targetExtTp = positive(signal?.extended_tp) ? signal.extended_tp : positive(signal?.tp2) ? signal.tp2 : null;
  const levels = brokerKeyLevels(signal);
  for (const p of positions) {
    if (p?.ticket == null || skip.has(p.ticket) || (p.side !== "BUY" && p.side !== "SELL") || !isOmegaOwned(p)) continue;
    const buy = p.side === "BUY";
    const open = Number(p.open_price ?? p.entry), curSl = Number(p.sl), curTp = Number(p.tp), vol = Number(p.volume);
    if (!Number.isFinite(open)) continue;
    const move = buy ? sym.bid - open : open - sym.ask;
    const atBreakEven = Number.isFinite(curSl) && (buy ? curSl >= open - 1e-9 : curSl <= open + 1e-9);
    const risk = Number.isFinite(curSl) && !atBreakEven ? Math.abs(open - curSl) : 0;
    const r = risk > 0 ? move / risk : 0;

    // 5m management (docs/RFC_OMEGA_5M_EXECUTION.md, owner 2026-11-12), from the broker's last 5m bars:
    // a confirmation against the position closes it once it is 0.5R in profit (or already protected);
    // from 1R (or once protected) the stop follows the 5m structure, only in the position's favour.
    const m5 = signal?.m5_source === "broker" && finite(signal.m5_close_ms) ? signal : null;
    const protectedPos = atBreakEven && move > 0;
    if (m5 && m5.m5_ready === true && move > 0 && (protectedPos || r >= 0.5) && (buy ? m5.m5_sell === true : m5.m5_buy === true)) {
      out.push({ id: `cl:${p.ticket}:o5:${Math.floor(m5.m5_close_ms / 60_000)}`, kind: "close", ticket: p.ticket, reason: "opposite_5m" });
      continue;
    }
    let movedSl = false;
    // Key-level management: SL+, trailing TP, and the close when the power turned against a winner.
    if (levels) {
      const k = keyLevelPlan({ position: p, sym, signal, levels, now, extend: extendOf(p) });
      if (k.close) {
        out.push({ id: `cl:${p.ticket}:pw:${Math.floor(signal.power_ms / 60_000)}`, kind: "close", ticket: p.ticket, reason: "power_reversal" });
        continue;
      }
      if (k.sl != null) {
        out.push({ id: `ms:${p.ticket}:k:${Math.round(k.sl * 100)}`, kind: "modify_sl", ticket: p.ticket, sl: k.sl, tp: Number.isFinite(curTp) ? curTp : null, reason: `sl_key_level_${k.band}` });
        movedSl = true;
      }
      if (k.tp != null) out.push({ id: `mt:${p.ticket}:${Math.round(k.tp * 100)}`, kind: "modify_tp", ticket: p.ticket, tp: k.tp, reason: "trail_tp_key_level" });
    }
    if (!movedSl && S.trailing_stop_r > 0 && !atBreakEven && risk > 0 && r >= S.trailing_stop_r) {
      out.push({ id: `ms:${p.ticket}:be`, kind: "modify_sl", ticket: p.ticket, sl: roundTo(open, digits), tp: Number.isFinite(curTp) ? curTp : null, reason: "break_even" });
      movedSl = true;
    }
    if (!levels && !movedSl && m5 && finite(m5.m5_atr) && (protectedPos || r >= 1)) {
      const point = positive(sym.point) ? sym.point : Math.pow(10, -digits);
      const spreadPx = (finite(sym.spread_points) ? sym.spread_points : 0) * point;
      const buffer = Math.max(2 * spreadPx, 0.1 * m5.m5_atr);
      const floorPx = (finite(sym.stops_level_points) ? sym.stops_level_points : 0) * point + spreadPx;
      const target = buy ? roundTo(m5.m5_swing_low - buffer, digits) : roundTo(m5.m5_swing_high + buffer, digits);
      const better = Number.isFinite(curSl) ? (buy ? target > curSl + point : target < curSl - point) : true;
      const room = buy ? target < sym.bid - floorPx : target > sym.ask + floorPx;
      if (finite(target) && target > 0 && better && room) {
        out.push({ id: `ms:${p.ticket}:t5:${Math.floor(m5.m5_close_ms / 60_000)}`, kind: "modify_sl", ticket: p.ticket, sl: target, tp: Number.isFinite(curTp) ? curTp : null, reason: "trail_5m" });
      }
    }

    if (!levels && targetExtTp != null && extendOf(p) && p.side === side && Number.isFinite(curTp) && (buy ? targetExtTp > curTp + 0.1 : targetExtTp < curTp - 0.1)) {
      out.push({ id: `mt:${p.ticket}:${Math.round(targetExtTp * 100)}`, kind: "modify_tp", ticket: p.ticket, tp: roundTo(targetExtTp, digits), reason: "extended_tp" });
    }

    // The TP ladder: the SL lock and the progressive partials (ladderPlan). It replaces the single scale-out below.
    if (S.tp_ladder) {
      const partialsDone = [...recent].filter((rid) => String(rid).startsWith(`pl:${p.ticket}:`)).length;
      const lad = ladderPlan({ position: p, sym, signal, levels, settings: S, partialsDone, now, meta: positionMeta?.[p.intent_id] ?? null, candles });
      if (lad.sl != null) {
        // One stop per position per plan: the ladder's lock wins only when it is tighter than a stop already planned.
        const i = out.findIndex((x) => x.kind === "modify_sl" && x.ticket === p.ticket);
        const planned = i >= 0 ? out[i].sl : null;
        if (planned == null || (buy ? lad.sl > planned : lad.sl < planned)) {
          if (i >= 0) out.splice(i, 1);
          out.push({ id: `ms:${p.ticket}:lad:${Math.round(lad.sl * 100)}`.slice(0, INTENT_ID_MAX), kind: "modify_sl", ticket: p.ticket, sl: lad.sl, tp: Number.isFinite(curTp) ? curTp : null, reason: `ladder_lock_tp${lad.sl_rung}` });
        }
      }
      if (lad.partial) out.push({ id: `pl:${p.ticket}:${lad.partial.rung}`, kind: "partial_close", ticket: p.ticket, volume: lad.partial.volume, reason: `ladder_tp${lad.partial.rung}_${Math.round(lad.partial.share * 100)}pct` });
      // ADR-0020 Amendment 4 (platform, merged 2026-11-18): the take-profit moves outward, as often as the key levels
      // allow, only while the stop already locks a profit at or beyond TP1. Before that, an outward move is dropped.
      if (!ladderTp1Locked({ position: p, levels, sym, signal, plannedSl: lad.sl })) {
        for (let i = out.length - 1; i >= 0; i -= 1) if (out[i].kind === "modify_tp" && out[i].ticket === p.ticket) out.splice(i, 1);
      }
      continue;
    }
    const atTarget = Number.isFinite(curTp) && (buy ? sym.bid >= curTp : sym.ask <= curTp);
    if (Number.isFinite(vol) && vol >= 0.02 && move > 0 && !scaledBefore(p.ticket) && (r >= 1.5 || atTarget)) {
      const step = positive(sym.volume_step) ? sym.volume_step : 0.01;
      const scaleVolume = floorToStep(vol / 2, step);
      if (scaleVolume >= (positive(sym.volume_min) ? sym.volume_min : 0.01)) {
        out.push({ id: `ps:${p.ticket}:${Math.round(vol * 100)}`, kind: "partial_close", ticket: p.ticket, volume: scaleVolume, reason: "tp1_scale_out" });
      }
    }
  }
  return out;
}

// The same-side re-entry guard (owner 2026-11-18, relayed and confirmed: "Setuju"). On 2026-11-18 the Position Manager
// closed a SELL on weakening and the next 15m SELL opened again seconds later, four times.
export const REENTRY_EXIT_REASONS = Object.freeze(["pm_take_profit_weakening", "pm_cut_loss"]);
const M15_MS = 15 * 60_000;

/**
 * Pure: whether a new entry on `side` waits after the Position Manager closed one on that side for weakening or a cut
 * loss (`reentry`: { side, exit_price, exit_ms, entry_conf } of the latest such exit, or null). Exits by TP, the ladder
 * or the stop are never one. Returns null (free) or { code, detail }:
 *   reentry_cooldown        the signal's bar must open `reentry_cooldown_bars` 15m bars after the exit;
 *   reentry_needs_pullback  then the price must have pulled back `reentry_pullback_atr` x ATR(M15) from the exit
 *                           (a SELL at or above exit + that, a BUY at or below exit - that), or the strategy agent's
 *                           confidence on its side be back at its level when the closed position opened.
 */
export function reentryGate({ side, reentry, signal, sym, settings = OMEGA_DEFAULTS }) {
  const S = { ...OMEGA_DEFAULTS, ...pickSettings(settings ?? {}) };
  if (!reentry || reentry.side !== side || !finite(reentry.exit_ms)) return null;
  const barOpen = finite(signal?.issued_ms) ? signal.issued_ms - M15_MS : null;
  if (S.reentry_cooldown_bars > 0 && !(finite(barOpen) && barOpen >= reentry.exit_ms + (S.reentry_cooldown_bars - 1) * M15_MS)) {
    return { code: "reentry_cooldown", detail: `${S.reentry_cooldown_bars} closed 15m bar after the ${side} exit at ${reentry.exit_price ?? "—"}` };
  }
  const atr = positive(sym?.atr_value) ? sym.atr_value : null;
  const price = side === "SELL" ? sym?.bid : sym?.ask;
  const need = finite(reentry.exit_price) && atr != null ? roundTo(reentry.exit_price + (side === "SELL" ? 1 : -1) * S.reentry_pullback_atr * atr, Number.isInteger(sym?.digits) ? sym.digits : 2) : null;
  const pulled = need != null && finite(price) && (side === "SELL" ? price >= need : price <= need);
  const agent = typeof signal?.trade_agent === "string" ? signal.trade_agent : null;
  const now = agent ? parseConfidences(signal?.agent_conf)[agent]?.[side === "BUY" ? "long" : "short"] : null;
  const recovered = finite(now) && finite(reentry.entry_conf) && now >= reentry.entry_conf;
  if (pulled || recovered || S.reentry_pullback_atr === 0) return null;
  return { code: "reentry_needs_pullback", detail: `need ${side === "SELL" ? "≥" : "≤"} ${need ?? "—"} (${S.reentry_pullback_atr}×ATR from the exit ${reentry.exit_price ?? "—"}), now ${finite(price) ? price : "—"}${finite(reentry.entry_conf) ? `; or confidence ≥ ${reentry.entry_conf} (now ${finite(now) ? now : "—"})` : ""}` };
}

/** A position whose stop sits at or beyond its open price (break-even or locked profit) risks nothing more. */
export function isProtected(p) {
  const open = Number(p?.open_price ?? p?.entry), sl = Number(p?.sl);
  if (!Number.isFinite(open) || !Number.isFinite(sl) || sl <= 0) return false;
  return p.side === "BUY" ? sl >= open - 1e-9 : p.side === "SELL" ? sl <= open + 1e-9 : false;
}

/**
 * What the positions would lose from the broker's current price to their stops, in account money (pure):
 * the equity, which carries their floating profit and loss, minus this is the equity if every stop is hit.
 * A protected position adds only the floating profit it could give back; a position without a stop, or
 * without what it takes to value it, counts as the whole account (it blocks a new entry rather than hide
 * unbounded risk).
 */
export function openRiskAtStops(positions = [], sym = {}) {
  let total = 0;
  for (const p of positions) {
    if (p?.side !== "BUY" && p?.side !== "SELL") continue;
    if (p.symbol && sym.name && p.symbol !== sym.name) continue;
    const sl = Number(p.sl), vol = Number(p.volume);
    if (!Number.isFinite(sl) || sl <= 0 || !Number.isFinite(vol) || vol <= 0 || !positive(sym.tick_size) || !positive(sym.tick_value)) return Infinity;
    const exit = p.side === "BUY" ? sym.bid : sym.ask;
    if (!finite(exit)) return Infinity;
    const dist = p.side === "BUY" ? exit - sl : sl - exit;
    if (dist > 0) total += (dist / sym.tick_size) * sym.tick_value * vol;
  }
  return total;
}

/**
 * Execution per the strategy agents (owner 2026-11-16, docs/RFC_STRATEGY_EXECUTION.md), on the system's positions
 * only, while the signal says the rules run (`strategy_execution`) and its decision is fresh (POWER_FRESH_MS):
 *   lean flip        the Decision Engine's quorum lean (`power`) beyond LEAN_BAND against a position closes it, in
 *                    profit or not: every system position on the flipped side ("auto close all"); neutral never;
 *   confidence drop  a position in profit whose agent's confidence on its side dropped at this 15m evaluation
 *                    (agent_conf against agent_conf_prev) is closed;
 *   extend           the trailing and extended TP move only while that confidence is stable or rising.
 * A position's agent is the one its open intent recorded (`agents`: intent id → agent); without one, the
 * default agent's. One close per ticket and decision bar (the intent id carries the bar).
 */
/**
 * Pure: the Position Manager's actions (src/position-manager.mjs, owner 2026-11-17) as intents, checked again
 * against the live price: a close; a stop only in the position's favour with the broker's stop distance; a target
 * only out to TP2 (the side's way). Risk-reducing only: never an open, an add or a wider stop. One intent per ticket
 * and 5-minute bar (the id carries the action's bar). `actions` are { id, ticket, action, rule, sl, tp }.
 */
export function positionManagerIntents({ positions = [], sym = {}, actions = [], skipTickets = [] } = {}) {
  const out = [], used = [];
  if (!finite(sym.bid) || !finite(sym.ask)) return { intents: out, used };
  const skip = new Set(skipTickets.filter((t) => t != null));
  const point = positive(sym.point) ? sym.point : 0.01;
  const digits = Number.isInteger(sym.digits) ? sym.digits : 2;
  const floorPx = (finite(sym.stops_level_points) ? sym.stops_level_points : 0) * point + (finite(sym.spread_points) ? sym.spread_points : 0) * point;
  for (const a of actions) {
    const p = positions.find((x) => x?.ticket === a.ticket);
    if (!p || skip.has(p.ticket) || !isOmegaOwned(p) || (p.side !== "BUY" && p.side !== "SELL")) continue;
    const buy = p.side === "BUY", curSl = Number(p.sl), curTp = Number(p.tp);
    const bar = String(a.id).split(":").pop();
    if (a.action === "close") {
      out.push({ id: `pm:${p.ticket}:c:${bar}`, kind: "close", ticket: p.ticket, reason: `pm_${a.rule}` });
    } else if (a.action === "sl" && finite(a.sl)) {
      const sl = roundTo(a.sl, digits);
      const tighter = !Number.isFinite(curSl) || curSl <= 0 || (buy ? sl > curSl + point / 2 : sl < curSl - point / 2);
      const room = buy ? sl < sym.bid - floorPx : sl > sym.ask + floorPx;
      if (!tighter || !room) continue;
      out.push({ id: `pm:${p.ticket}:s:${bar}`, kind: "modify_sl", ticket: p.ticket, sl, tp: Number.isFinite(curTp) ? curTp : null, reason: `pm_${a.rule}` });
    } else if (a.action === "tp" && finite(a.tp)) {
      const tp = roundTo(a.tp, digits);
      const outward = Number.isFinite(curTp) && curTp > 0 && (buy ? tp > curTp + point / 2 && tp > sym.ask + floorPx : tp < curTp - point / 2 && tp < sym.bid - floorPx);
      if (!outward) continue;
      out.push({ id: `pm:${p.ticket}:t:${bar}`, kind: "modify_tp", ticket: p.ticket, tp, reason: `pm_${a.rule}` });
    } else continue;
    used.push(a.id);
  }
  return { intents: out, used };
}

export const LEAN_BAND = 0.15;
export const DEFAULT_POSITION_AGENT = "zone_pullback";
export function strategyExits({ positions = [], signal = null, sym = {}, agents = {}, now = Date.now(), skipTickets = [] } = {}) {
  const intents = [];
  const extendOf = () => true;
  if (signal?.strategy_execution !== true) return { intents, extendOf };
  const fresh = finite(signal.power_ms) && signal.power_ms > 0 && now - signal.power_ms <= POWER_FRESH_MS;
  if (!fresh) return { intents, extendOf: () => false };
  const bar = Math.floor(signal.power_ms / 60_000);
  const conf = parseConfidences(signal.agent_conf), prev = parseConfidences(signal.agent_conf_prev);
  const agentOf = (p) => (typeof agents?.[p.intent_id] === "string" && agents[p.intent_id]) || DEFAULT_POSITION_AGENT;
  const trendOf = (p) => { const a = agentOf(p), k = p.side === "BUY" ? "long" : "short"; return confidenceTrend(conf[a]?.[k], prev[a]?.[k]); };
  const skip = new Set(skipTickets.filter((t) => t != null));
  for (const p of positions) {
    if (p?.ticket == null || skip.has(p.ticket) || (p.side !== "BUY" && p.side !== "SELL") || !isOmegaOwned(p)) continue;
    const dir = p.side === "BUY" ? 1 : -1;
    if (finite(signal.power) && dir * signal.power <= -LEAN_BAND) {
      intents.push({ id: `cl:${p.ticket}:lf:${bar}`, kind: "close", ticket: p.ticket, reason: "lean_flip", agent: agentOf(p) });
      continue;
    }
    const open = Number(p.open_price ?? p.entry);
    const move = Number.isFinite(open) && finite(sym.bid) && finite(sym.ask) ? (dir > 0 ? sym.bid - open : open - sym.ask) : 0;
    // The strategy arm (owner 2026-11-17): with 1 to 3 armed, only an armed strategy closes its own positions this way.
    const armedOk = !signal.armed || String(signal.armed).split(",").includes(agentOf(p));
    if (move > 0 && armedOk && trendOf(p) === "drop") intents.push({ id: `cl:${p.ticket}:cd:${bar}`, kind: "close", ticket: p.ticket, reason: "confidence_drop", agent: agentOf(p) });
  }
  return { intents, extendOf: (p) => ["stable", "rising"].includes(trendOf(p)) };
}

export function planIntents({ signal = null, control = null, settings = OMEGA_DEFAULTS, executor = null, now = Date.now(), engineEnabled = false, recentIntentIds = [], agents = {}, pmActions = [], account: accountSpec = null, eaGate = false, reentry = null, positionMeta = {}, candles = undefined } = {}) {
  const intents = [], notes = [];
  const note = (code, detail) => notes.push(detail ? { code, detail } : { code });
  const S = { ...OMEGA_DEFAULTS, ...pickSettings(settings ?? {}) };
  // Account Profiles phase 2 (docs/RFC_ACCOUNT_PROFILES.md §3-4): new entries are sized within the account's profile.
  // Each limit is the smaller of the profile's cap and the setting; Custom keeps the settings as they are.
  const limits = typeof accountSpec?.profile === "string" ? effectiveLimits(accountSpec.profile, S) : null;
  if (limits && limits.profile !== "custom") {
    if (finite(limits.risk_pct)) S.risk_pct = limits.risk_pct;
    if (Number.isInteger(limits.max_positions)) S.max_positions = limits.max_positions;
    if (finite(limits.max_daily_loss_pct)) S.max_daily_loss_pct = limits.max_daily_loss_pct;
  }
  const positions = Array.isArray(executor?.positions) ? executor.positions : [];
  const recent = new Set(recentIntentIds);

  if (signal?.kill === true || control?.mode === "killed") {
    note("kill");
    if (positions.length) intents.push({ id: closeAllId(killKey(signal, control)), kind: "close_all", reason: "kill" });
    return { intents, notes };
  }
  if (!engineEnabled || S.enabled !== true) { note("engine_off"); return { intents, notes }; }
  if (!executor || executor.connected !== true || !finite(executor.received_ms) || now - executor.received_ms > EXECUTOR_MAX_AGE_MS) {
    note("executor_stale");
    return { intents, notes };
  }

  // The EA still moves stops by itself (OmegaExecutor 1.12+ reports it): said, never a gate.
  if (executor.executor?.local_management === true) note("ea_local_management");

  const side = signal?.side === "BUY" || signal?.side === "SELL" ? signal.side : null;

  // Mean Reversal / Early Exit: close positions if signal explicitly indicates reversal or exit (Omega-owned only)
  if (signal?.action === "EXIT" || signal?.action === "REVERSAL" || signal?.mean_reversal === true || signal?.early_exit === true) {
    for (const p of positions) {
      if (p.ticket != null && isOmegaOwned(p) && !intents.some((it) => it.ticket === p.ticket)) {
        intents.push({ id: `cl:${p.ticket}:rev`, kind: "close", ticket: p.ticket, reason: "mean_reversal" });
      }
    }
    if (intents.length) {
      note("mean_reversal_exit");
      return { intents, notes };
    }
  }

  for (const p of positions) {
    if (side && (p.side === "BUY" || p.side === "SELL") && p.side !== side && p.ticket != null && isOmegaOwned(p)) {
      intents.push({ id: closeId(p.ticket), kind: "close", ticket: p.ticket, reason: "opposite" });
    }
  }
  const account = executor.account ?? {}, sym = executor.symbol ?? {};
  // The strategy agents' exits and the confidence gate on extending (owner 2026-11-16).
  const exits = strategyExits({ positions, signal, sym, agents, now, skipTickets: intents.map((it) => it.ticket) });
  if (exits.intents.length) note(exits.intents.some((it) => it.reason === "lean_flip") ? "lean_flip" : "confidence_drop");
  intents.push(...exits.intents);
  // The Position Manager's actions (owner 2026-11-17): after the strategy exits, before the routine management.
  const pm = positionManagerIntents({ positions, sym, actions: pmActions, skipTickets: intents.filter((it) => it.kind === "close").map((it) => it.ticket) });
  // ADR-0020 Amendment 4: under the TP ladder the Position Manager's outward take-profit (TP2) waits, like every
  // outward move, until the stop locks a profit at or beyond TP1.
  if (S.tp_ladder) {
    const levels = brokerKeyLevels(signal);
    pm.intents = pm.intents.filter((it) => {
      if (it.kind !== "modify_tp") return true;
      const p = positions.find((x) => x.ticket === it.ticket);
      return p ? ladderTp1Locked({ position: p, levels, sym, signal }) : false;
    });
  }
  if (pm.intents.length) note("position_manager");
  intents.push(...pm.intents);

  // Position management runs on every sync, whatever the entry gates say (audit 2026-11-11, owner:
  // "perbaiki"): a blackout, the rollover quarantine, a pause, a wide spread or a full book only stop
  // NEW entries; the positions already open keep their break-even, extended target and scale-out.
  intents.push(...manageIntents({ positions, sym, settings: S, signal, side, recentIntentIds, skipTickets: intents.map((it) => it.ticket), now, extendOf: exits.extendOf, positionMeta, candles }));

  if (!side) { note("no_side"); return { intents, notes }; }

  const issued = signal.issued_ms, id = openId(issued, side);
  const sameSide = positions.filter((p) => p.side === side);
  const decided = finite(signal.decided_ms) ? signal.decided_ms : issued;
  const closing = intents.filter((it) => it.kind === "close").length;
  const armLive = signal.arm_mode === "armed" || signal.arm_mode === "auto";
  const tradeAgent = typeof signal.trade_agent === "string" && signal.trade_agent ? signal.trade_agent : null;
  const posAgent = (p) => (typeof agents?.[p.intent_id] === "string" && agents[p.intent_id]) || DEFAULT_POSITION_AGENT;
  const gates = [
    // USD gold only (owner 2026-11-17, PR #405): a symbol off the list, not priced in USD, with an odd contract
    // size or refused by the EA itself opens nothing. Open positions keep their management above.
    [!goldCheckOf(executor).ok, "symbol_unverified"],
    // An owner-set gold symbol off the list (cent accounts, e.g. "GoldOne") must price as gold: its bid within 2% of
    // the signal's reference entry, else nothing opens.
    [mappedPriceProblem(sym, signal.entry) !== null, "symbol_price_mismatch"],
    // Account Profiles phase 1 (docs/RFC_ACCOUNT_PROFILES.md §1-2, owner 2026-11-18): a new or changed broker spec opens
    // nothing until it validates (src/account-spec.mjs); with OMEGA_EA_VERSION_GATE "on", an EA older than 1.15 (no
    // margin, stops or freeze check of its own) opens nothing either. Open positions keep their management above.
    [accountSpec != null && accountSpec.spec_status !== "validated", "spec_unvalidated"],
    // The profile council (src/profile-council.mjs, OMEGA_PROFILE_COUNCIL_DOWNGRADE "on"): a soft downgrade waiting
    // for its review opens nothing until the council decides (at most PENDING_DOWNGRADE_MAX_MS).
    [accountSpec?.review_pending === true, "profile_review_pending"],
    [eaGate === true && !versionAtLeast(executor.executor?.version ?? null, EXECUTOR_ENTRY_MIN_VERSION), "ea_outdated"],
    [!finite(issued) || !finite(signal.expires_ms), "bad_signal"],
    [now >= signal.expires_ms, "expired"],
    [now - decided > S.max_signal_age_ms, "signal_too_old"],
    [signal.blackout === true, "blackout"],
    [signal.paused === true || control?.mode === "paused", "paused"],
    [account.trade_mode !== "demo" && S.live_armed !== true, "live_not_armed"],
    [recent.has(id) || positions.some((p) => p.intent_id === id), "already_opened"],
    [positions.length - closing >= S.max_positions || sameSide.length >= S.max_positions, "max_positions"],
    [!finite(sym.spread_points) || sym.spread_points > S.max_spread_points, "spread"],
    [isRolloverQuarantine(now), "rollover_quarantine"],
    // No stacking (owner 2026-11-12, "larangan tumpuk posisi"): a second position on a side opens only
    // once every position already on that side is protected (its stop at or beyond its open price).
    [sameSide.some((p) => !isProtected(p)), "same_side_unprotected"],
    // The strategy arm's position rules (RFC §5, owner 2026-11-17 "Ya, semua, live"), while the arm is live (the signal
    // then carries arm_mode): one position per strategy, and never an entry against an Omega position on the other
    // side, open or being closed this sync (the next sync opens once it is gone).
    [armLive && tradeAgent != null && positions.some((p) => isOmegaOwned(p) && posAgent(p) === tradeAgent), "strategy_has_position"],
    [armLive && positions.some((p) => isOmegaOwned(p) && (p.side === "BUY" || p.side === "SELL") && p.side !== side), "opposing_position"]
  ];
  for (const [blocked, code] of gates) if (blocked) { note(code); return { intents, notes }; }
  const re = reentryGate({ side, reentry, signal, sym, settings: S });
  if (re) { note(re.code, re.detail); return { intents, notes }; }

  const needed = [account.equity, account.day_start_balance, signal.entry, signal.stop, signal.tp1, sym.bid, sym.ask, sym.point, sym.tick_size, sym.tick_value, sym.volume_step, sym.volume_min, sym.volume_max];
  if (!needed.every(positive) || !Number.isInteger(sym.digits)) { note("bad_input"); return { intents, notes }; }
  const lossFloor = account.day_start_balance * (1 - S.max_daily_loss_pct / 100);
  if (account.equity <= lossFloor) { note("daily_loss_limit"); return { intents, notes }; }
  // Daily risk budget (owner 2026-11-12): what the day can still lose is the equity above the daily
  // loss floor less what the open positions would lose at their stops; a new entry risks at most that.
  const budget = account.equity - openRiskAtStops(positions.filter((p) => !intents.some((it) => it.kind === "close" && it.ticket === p.ticket)), sym) - lossFloor;
  if (!(budget > 0)) { note("daily_risk_budget"); return { intents, notes }; }

  const buy = side === "BUY";
  const planOk = buy ? signal.stop < signal.entry && signal.entry < signal.tp1 : signal.tp1 < signal.entry && signal.entry < signal.stop;
  if (!planOk) { note("plan_wrong_side"); return { intents, notes }; }
  const planStopDist = Math.abs(signal.entry - signal.stop);
  let stopDist = planStopDist, tpDist = Math.abs(signal.tp1 - signal.entry);
  const minDist = (finite(sym.stops_level_points) ? sym.stops_level_points : 0) * sym.point;
  if (stopDist <= minDist || tpDist <= minDist) { note("stops_level"); return { intents, notes }; }

  // 5m execution (docs/RFC_OMEGA_5M_EXECUTION.md, owner 2026-11-12): a market entry's stop moves to the
  // broker's 5m structure (the swing of the last 3 broker 5m bars beyond a buffer of 2 spreads or 0.1
  // 5m ATR), never wider than the plan's and never closer than 0.5 5m ATR (or the stop level plus 3
  // spreads). The target stays the plan's, so the RRR rises; the lot is capped below.
  let tight = false;
  if (signal.action !== "ENTER_LIMIT" && signal.m5_source === "broker" && positive(signal.m5_atr) && positive(buy ? signal.m5_swing_low : signal.m5_swing_high)) {
    const spreadPx = (finite(sym.spread_points) ? sym.spread_points : 0) * sym.point;
    const buffer = Math.max(2 * spreadPx, 0.1 * signal.m5_atr);
    const px = buy ? sym.ask : sym.bid;
    const d = buy ? px - (signal.m5_swing_low - buffer) : (signal.m5_swing_high + buffer) - px;
    const floorDist = Math.max(0.5 * signal.m5_atr, minDist + 3 * spreadPx);
    if (finite(d) && d >= floorDist && d < stopDist) { stopDist = roundTo(d, sym.digits); tight = true; note("stop_5m"); }
  }

  // Adaptive Volatility Stop: if ATR is available, ensure stopDist >= 0.75 * ATR to prevent noise
  // stop-outs. The target moves with it, so the trade keeps the plan's reward-to-risk that the
  // Decision Engine checked (audit 2026-11-11: a widened stop with the plan's target cut the R).
  // A 5m stop keeps its own floor above.
  if (!tight && S.adaptive_volatility !== false && positive(sym.atr_value)) {
    const minAtrDist = sym.atr_value * 0.75;
    if (stopDist < minAtrDist) {
      stopDist = roundTo(minAtrDist, sym.digits);
      // Scalp (owner 2026-11-12): the target stays at the nearest key level, whatever the stop.
      if (signal.trading_mode !== "scalp") tpDist = roundTo(tpDist * stopDist / planStopDist, sym.digits);
      note("adaptive_stop");
    }
  }

  // Detect Volatility Regime
  const atrPts = positive(sym.atr_points) ? sym.atr_points : (positive(sym.atr_value) && sym.point ? Math.round(sym.atr_value / sym.point) : null);
  const volRegime = atrPts == null ? "NORMAL" : (atrPts > 500 ? "HIGH" : atrPts < 150 ? "LOW" : "NORMAL");
  if (volRegime !== "NORMAL") {
    note(`vol_regime_${volRegime.toLowerCase()}`);
  }

  if (signal.action === "ENTER_LIMIT") {
    const priceAway = buy ? sym.ask > signal.entry + 0.35 * stopDist : sym.bid < signal.entry - 0.35 * stopDist;
    if (priceAway) { note("waiting_for_pullback"); return { intents, notes }; }
    // Owner 2026-11-13 ("setuju"): price past the entry toward the plan's stop by more than 0.35 x the plan's
    // stop distance is not entered. The stop keeps its distance from the fill, so such an entry put the stop
    // well beyond the key level the plan stood on (a SELL at 3903.98 against a 3888.48 entry, its stop 14
    // past the plan's). It waits: price may come back inside the band before the signal expires.
    const pastEntry = buy ? sym.ask < signal.entry - 0.35 * planStopDist : sym.bid > signal.entry + 0.35 * planStopDist;
    if (pastEntry) { note("price_past_entry"); return { intents, notes }; }
  }
  const breached = buy ? sym.bid <= signal.stop : sym.ask >= signal.stop;
  if (breached) { note("stop_breached"); return { intents, notes }; }

  const price = buy ? sym.ask : sym.bid;
  const sl = roundTo(buy ? price - stopDist : price + stopDist, sym.digits);
  const tp = roundTo(buy ? price + tpDist : price - tpDist, sym.digits);
  const lossPerLot = (Math.abs(price - sl) / sym.tick_size) * sym.tick_value;
  let volume = floorToStep((account.equity * S.risk_pct / 100) / lossPerLot, sym.volume_step);
  if (tight) {
    // The money at risk stays within risk_pct; the lot is capped at tight_stop_max_lot_factor x the lot at the plan's stop.
    const planVolume = (account.equity * S.risk_pct / 100) / ((planStopDist / sym.tick_size) * sym.tick_value);
    const cap = floorToStep(planVolume * (finite(S.tight_stop_max_lot_factor) ? S.tight_stop_max_lot_factor : 1.5), sym.volume_step);
    if (volume > cap) { volume = cap; note("lot_capped_5m"); }
  }
  if (volume > sym.volume_max) volume = floorToStep(sym.volume_max, sym.volume_step);
  const pctOf = (money) => roundTo((money / account.equity) * 100, 2);
  const label = limits ? (PROFILES[limits.profile]?.label ?? limits.profile) : null;
  if (!positive(volume) || volume < sym.volume_min) {
    // The minimum lot (RFC §3): allowed only when its real risk stays within the profile's hard cap per trade. Custom
    // has no hard cap of its own, so it skips as before. Either way the reason says the numbers.
    const minRisk = pctOf(lossPerLot * sym.volume_min);
    const stopPts = sym.point > 0 ? Math.round(Math.abs(price - sl) / sym.point) : null;
    if (limits && finite(limits.hard_cap_pct) && minRisk <= limits.hard_cap_pct) {
      volume = sym.volume_min;
      note("min_lot_within_cap", `stop ${stopPts} pts: the minimum lot ${sym.volume_min} risks ${minRisk}% of ${roundTo(account.equity, 2)}, within the ${label} cap of ${limits.hard_cap_pct}%`);
    } else {
      const cap = limits && finite(limits.hard_cap_pct) ? `the ${label} cap of ${limits.hard_cap_pct}%` : `the risk per trade of ${S.risk_pct}%`;
      note("volume_below_min", `stop ${stopPts} pts: the minimum lot ${sym.volume_min} risks ${minRisk}% of ${roundTo(account.equity, 2)}, over ${cap}`);
      return { intents, notes };
    }
  }
  // The profile's total open risk (RFC §4): what the open positions lose at their stops plus this entry's risk.
  if (limits && finite(limits.open_risk_pct)) {
    const openRisk = openRiskAtStops(positions.filter((p) => !intents.some((it) => it.kind === "close" && it.ticket === p.ticket)), sym);
    const room = (account.equity * limits.open_risk_pct) / 100 - openRisk;
    const roomVolume = room > 0 ? floorToStep(room / lossPerLot, sym.volume_step) : 0;
    if (!(roomVolume >= sym.volume_min)) {
      note("open_risk_cap", `open positions risk ${pctOf(openRisk)}% at their stops; the ${label} total open risk is ${limits.open_risk_pct}%`);
      return { intents, notes };
    }
    if (volume > roomVolume) { volume = roomVolume; note("lot_capped_open_risk"); }
  }
  const budgetVolume = floorToStep(budget / lossPerLot, sym.volume_step);
  if (budgetVolume < sym.volume_min) { note("daily_risk_budget"); return { intents, notes }; }
  if (volume > budgetVolume) { volume = budgetVolume; note("lot_capped_daily_budget"); }

  const openIntent = { id, kind: "open", side, volume, entry: price, sl, tp, signal_issued_ms: issued, reason: "signal", stop_source: tight ? "stop_5m" : "plan", trigger_source: typeof signal.trigger_source === "string" ? signal.trigger_source : null };
  // The strategy agent whose plan this is (owner 2026-11-16): its confidence governs the position's exit.
  if (typeof signal.trade_agent === "string" && signal.trade_agent) {
    openIntent.strategy = signal.trade_agent;
    // Its confidence on the side at entry (the re-entry guard's "momentum recovered" reference).
    const c = parseConfidences(signal.agent_conf)[signal.trade_agent]?.[buy ? "long" : "short"];
    if (finite(c)) openIntent.agent_conf = c;
  }
  // The grid's adapted entry and stop (src/grid-adapt.mjs, owner 2026-11-17): recorded on the intent; a 5m stop keeps its own source.
  if (typeof signal.grid_cell === "string" && signal.grid_cell) {
    openIntent.grid_cell = signal.grid_cell;
    if (typeof signal.grid_slice === "string") openIntent.grid_slice = signal.grid_slice;
    if (!tight) openIntent.stop_source = `grid:${signal.grid_cell}`;
  }
  if (volRegime !== "NORMAL") openIntent.vol_regime = volRegime;
  // The mode it opened in and its stop distance (the ladder's step per mode; a later mode switch never changes them).
  if (["scalp", "intraday", "swing"].includes(signal.trading_mode)) openIntent.mode = signal.trading_mode;
  if (finite(price) && finite(sl)) openIntent.r_dist = roundTo(Math.abs(price - sl), sym.digits);
  intents.push(openIntent);
  return { intents, notes };
}
