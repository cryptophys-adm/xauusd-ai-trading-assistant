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

import { cellGateText } from "./htf-cells.mjs";
import { confidenceTrend, parseConfidences, CONFIDENCE_CHANGE_MIN } from "./agent-confidence.mjs";
import { changeTokens, changeOn, normalizeChangeThresholds, pendingShareFall, CHANGE_THRESHOLDS_ALL } from "./change-thresholds.mjs";
import { goldCheckOf, goldPriceProblem } from "./gold-symbol.mjs";
import { versionAtLeast, EXECUTOR_ENTRY_MIN_VERSION, effectiveLimits, PROFILES, CUSTOM_CAPS } from "./account-spec.mjs";
import { limitKnobs } from "./omega-limit-knobs.mjs";
import { pmLoosenKnobs } from "./pm-loosen-knobs.mjs";
import { signalLiquidityLevels, liveSpreadSpike, deferModifications } from "./liquidity-lens.mjs";
import { profitLockGateOn, gateBreakEven, gateAtrM5, stopInProfit, gateText, GATE_UNMEASURED, PROFIT_LOCK_GATE_MODES } from "./profit-lock-gate.mjs";
import { isFastId, PM_FAST_MODES } from "./pm-fast.mjs";
import { reentryOn, isReentryId, REENTRY_MODES, REENTRY_RULE, REENTRY_1M } from "./reentry-1m.mjs";
import { limitSupersedeOn, supersededOrders, orderSignalMs, LIMIT_SUPERSEDE_MODES, SUPERSEDE_REASON } from "./limit-supersede.mjs";

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
  // The same-side re-entry guard (owner 2026-11-18, confirmed again: "Setuju keduanya"): see reentryGate. Closed M5 bars.
  reentry_cooldown_bars: 1,
  // The ladder's step per mode (owner 2026-11-18, confirmed: "Setuju"): scalp ladder_lock_pips, intraday and swing in R.
  ladder_r_intraday: 0.5,
  ladder_r_swing: 0.3,
  // Limit entries (docs/RFC_OMEGA_LIMIT_ENTRY.md, owner 2026-11-20): "market" enters a limit plan at market as before;
  // "limit" works the plan's level at the broker as a pending order, held by the council; "council" lets the entry
  // council choose per signal between the market entry, the limit and no entry (§2). The owner's switch only.
  entry_order: "market",
  // Platform ADR-0020 Amendment 8 (owner 2026-11-20, "setuju", "keduanya"): the Position Council may loosen a tightened
  // stop once, within bounds, and move a take profit nearer or further. The owner's switch on the Omega page only;
  // Aether's policy never writes it. Off: today's rules, unchanged.
  pm_loosen_enabled: false,
  // The Positioning & Liquidity analyst's rollback switches (docs/RFC_POSITIONING_LIQUIDITY.md; owner 2026-11-20:
  // "Sekarang breakglass urgent jadi langsung live"): on by default, the owner's switches on the Omega page only;
  // Aether's policy never writes them. Off, the lens contributes nothing (no witness, gate, deferral, reason or level).
  positioning_enabled: true,
  liquidity_enabled: true,
  // SLG1, one profit-lock gate (owner 2026-11-23; src/profit-lock-gate.mjs): "on", no stop moves into profit until the
  // position's MFE on closed bars of its mode's timeframe reaches the mode's threshold; "legacy", today's locks byte for
  // byte. The owner's switch on the Omega page only; Aether's policy never writes it.
  profit_lock_gate: "on",
  // CH1, change thresholds (owner 2026-11-23: "supaya tidak terlalu dini, perubahan confluence dan confidence perlu
  // threshold atau ambang perubahan"; "Live semua (Rekomendasi)"; src/change-thresholds.mjs): the tokens conf, tpw,
  // limit, skip and stance, all on; "off" (or a token left out) is today's rule for that trigger byte for byte. The
  // owner's switch only; Aether's policy never writes it.
  change_thresholds: CHANGE_THRESHOLDS_ALL,
  // PM-1M, the 1m fast-protect layer (owner 2026-11-23: "deploy semuanya live. Tf 1m diperlukan position manager untuk
  // antisipasi TP lebih cepat dan mengurangi kerugian"; src/pm-fast.mjs): "on", the fast TP anticipation and loss
  // reduction on closed broker M1 bars; "off", today's engine byte for byte. The owner's switch only; Aether's policy
  // never writes it.
  pm_fast_1m: "on",
  // RE1, a 1m re-entry after a profit-lock stop (owner 2026-11-23: "Live: gerbang + re-entry (Rekomendasi)";
  // src/reentry-1m.mjs): "on", one re-entry of a setup a break-even or lock stop closed, when a closed broker 1m bar
  // closes back beyond the lock; "off", today's engine byte for byte. The owner's switch only; Aether's policy never
  // writes it.
  reentry_1m: "on",
  // SS1, a newer same-side signal supersedes a resting, unfilled Omega limit (owner 2026-11-23: "Ya, sinyal baru
  // menggantikan (Rekomendasi)"; src/limit-supersede.mjs): "on", the older signal's limit is deleted
  // (superseded_by_signal) and the new signal goes through every gate, placed once the delete is done; "off", today's
  // engine byte for byte. The owner's switch only; Aether's policy never writes it.
  limit_supersede: "on"
});
/** Stage 3 of docs/RFC_OMEGA_LIMIT_ENTRY.md: "limit" and "council" may be switched on (with OmegaExecutor 1.21). */
export const LIMIT_ENTRY_AVAILABLE = true;
export const ENTRY_ORDERS = Object.freeze(["market", "limit", "council"]);
/** The OmegaExecutor that places, deletes and expires pending limits (place_limit, delete_order; RFC §9). */
export const LIMIT_EA_MIN_VERSION = "1.21";
/** ADR-0020 Amendment 7: open positions and pending orders together, per account, never more than this. */
export const PLATFORM_MAX_OPEN = 3;
/**
 * How long a signal waits for the entry council's answer under "council" before the answer counts as silent (today's
 * market path). The council runs in the 5-minute ledger step, so one run always falls inside this window.
 */
export const ENTRY_COUNCIL_WAIT_MS = 6 * 60_000;
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
export function settingsFrom(body, current = OMEGA_DEFAULTS, { ea_version = null } = {}) {
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
    // At most Aggressive's limits (ADR-0020 Amendment 10): no profile, Custom included, allows more.
    ?? num("max_positions", 1, CUSTOM_CAPS.max_positions, { integer: true })
    ?? num("max_daily_loss_pct", 0.1, CUSTOM_CAPS.daily_loss_pct)
    ?? num("max_spread_points", 1, 1000)
    ?? num("max_signal_age_ms", 60_000, 60 * 60_000, { integer: true })
    ?? num("trailing_stop_r", 0, 5)
    ?? num("tight_stop_max_lot_factor", 1, 2)
    ?? num("partial_min_pct", 10, 50)
    ?? num("partial_max_pct", 25, 75)
    ?? num("ladder_lock_pips", 5, 100)
    ?? num("ladder_max_partials", 0, 5, { integer: true })
    ?? num("reentry_cooldown_bars", 0, 12, { integer: true })
    ?? num("ladder_r_intraday", 0.1, 2)
    ?? num("ladder_r_swing", 0.1, 2);
  if (err) return { error: err };
  if (out.partial_min_pct > out.partial_max_pct) return { error: "partial_min_pct must not be above partial_max_pct" };
  if (body.tp_ladder !== undefined) {
    if (typeof body.tp_ladder !== "boolean") return { error: "tp_ladder must be true or false" };
    out.tp_ladder = body.tp_ladder;
  }
  if (body.pm_loosen_enabled !== undefined) {
    if (typeof body.pm_loosen_enabled !== "boolean") return { error: "pm_loosen_enabled must be true or false" };
    out.pm_loosen_enabled = body.pm_loosen_enabled;
  }
  for (const key of ["positioning_enabled", "liquidity_enabled"]) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") return { error: `${key} must be true or false` };
    out[key] = body[key];
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
  if (body.profit_lock_gate !== undefined) {
    if (typeof body.profit_lock_gate !== "string" || !PROFIT_LOCK_GATE_MODES.includes(body.profit_lock_gate)) {
      return { error: "profit_lock_gate must be 'on' or 'legacy'" };
    }
    out.profit_lock_gate = body.profit_lock_gate;
  }
  if (body.pm_fast_1m !== undefined) {
    if (typeof body.pm_fast_1m !== "string" || !PM_FAST_MODES.includes(body.pm_fast_1m)) return { error: "pm_fast_1m must be 'on' or 'off'" };
    out.pm_fast_1m = body.pm_fast_1m;
  }
  if (body.reentry_1m !== undefined) {
    if (typeof body.reentry_1m !== "string" || !REENTRY_MODES.includes(body.reentry_1m)) return { error: "reentry_1m must be 'on' or 'off'" };
    out.reentry_1m = body.reentry_1m;
  }
  if (body.limit_supersede !== undefined) {
    if (typeof body.limit_supersede !== "string" || !LIMIT_SUPERSEDE_MODES.includes(body.limit_supersede)) return { error: "limit_supersede must be 'on' or 'off'" };
    out.limit_supersede = body.limit_supersede;
  }
  if (body.change_thresholds !== undefined) {
    const v = normalizeChangeThresholds(body.change_thresholds);
    if (v == null) return { error: "change_thresholds must be 'off' or a comma-separated list of conf, tpw, limit, skip, stance" };
    out.change_thresholds = v;
  }
  if (body.entry_order !== undefined) {
    if (!ENTRY_ORDERS.includes(body.entry_order)) return { error: "entry_order must be 'market', 'limit' or 'council'" };
    // A switch to "limit" or "council" needs OmegaExecutor 1.21 on the terminal (`ea_version`, its self-report); the value
    // already stored is carried through any other change (Aether's policy writes the whole settings back, never this).
    const switching = body.entry_order !== out.entry_order;
    if (switching && body.entry_order !== "market" && !LIMIT_ENTRY_AVAILABLE) return { error: "limit entries are not available yet (docs/RFC_OMEGA_LIMIT_ENTRY.md stage 3)" };
    if (switching && body.entry_order !== "market" && !versionAtLeast(ea_version, LIMIT_EA_MIN_VERSION)) return { error: `ea_1_21_required: entry_order '${body.entry_order}' needs OmegaExecutor ${LIMIT_EA_MIN_VERSION} or newer on the terminal (it reports ${typeof ea_version === "string" && ea_version ? ea_version : "no version"})` };
    out.entry_order = body.entry_order;
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
  // A manual position the owner delegated to Omega (owner 2026-11-19, src/omega-hitl.mjs): managed like its own.
  if (p.delegated === true) return true;
  if (p.source === "omega") return true;
  if (p.magic === 920200) return true;
  if (typeof p.intent_id === "string" && (p.intent_id.startsWith("open:") || isReentryId(p.intent_id))) return true;
  if (p.source === "manual" || p.source === "external" || p.magic === 0) return false;
  // Fallback for legacy unit tests without source/magic annotations
  return true;
}

/* ---------- pending Omega orders (docs/RFC_OMEGA_LIMIT_ENTRY.md §6) ---------- */
const LIMIT_TYPES = new Set(["BUY_LIMIT", "SELL_LIMIT"]);
/** Omega's own pending limit orders in the terminal's report (by its magic or its "omega" source). */
export function omegaPendingOrders(executor) {
  return (Array.isArray(executor?.orders) ? executor.orders : []).filter((o) => LIMIT_TYPES.has(o?.type) && (o.source === "omega" || o.magic === 920200) && positive(o.ticket));
}
/** A pending order as the gates see it: a position on its side, unprotected until it fills and its stop is locked. */
export function pendingAsPosition(o) {
  return { ticket: o.ticket, side: o.type === "BUY_LIMIT" ? "BUY" : "SELL", volume: o.volume_current ?? o.volume_initial, open_price: o.price_open, sl: o.sl, tp: o.tp, pending: true, source: "omega" };
}
/** What the pending orders would lose at their stops if filled (the price they would fill at to their stop). */
export function pendingRiskAtStops(orders = [], sym = {}) {
  let total = 0;
  for (const o of orders) {
    const sl = Number(o?.sl), vol = Number(o?.volume_current ?? o?.volume_initial), price = Number(o?.price_open);
    if (!(sl > 0) || !(vol > 0) || !(price > 0) || !positive(sym.tick_size) || !positive(sym.tick_value)) return Infinity;
    total += (Math.abs(price - sl) / sym.tick_size) * sym.tick_value * vol;
  }
  return total;
}
/**
 * Why Omega's pending orders must go now, deterministically and without the council (RFC §4, §6), or null: the switch back
 * to market, disarm on a real account (owner disarm or auto-disarm; ADR-0020 Amendment 7: cancelled on disarm or kill),
 * pause, a news blackout, the symbol, money or tick value failing, an unvalidated or downgrading profile, the daily loss
 * floor reached; then (stage 3) the daily risk budget exhausted (`budget`: the equity above the floor less the open and
 * pending risk at the stops), and per order (`order`, with `meta`, its place_limit intent): an order Omega has no record
 * of, a profile downgrade since its placement, a Decision Engine veto of its side, its side's quorum share fallen by more
 * than cancel_share_drop since the placing decision, and its max_pending_life reached. Kill and Omega switched off are
 * handled before this (close_all, engine_off). `available` is the stage switch (LIMIT_ENTRY_AVAILABLE); tests pass it to
 * check the order of the reasons behind it.
 */
export const PROFILE_RANK = Object.freeze({ safe: 0, conservative: 1, aggressive: 2 });
export function pendingDeleteReason({ settings = OMEGA_DEFAULTS, signal = null, control = null, executor = null, account = null, lossFloor = null, available = LIMIT_ENTRY_AVAILABLE, budget = null, order = null, meta = null, now = Date.now() } = {}) {
  const sym = executor?.symbol ?? {};
  if ((settings.entry_order !== "limit" && settings.entry_order !== "council") || !available) return "entry_order_market";
  if (executor?.account?.trade_mode !== "demo" && settings.live_armed !== true) return "disarmed";
  if (signal?.paused === true || control?.mode === "paused") return "paused";
  if (signal?.blackout === true) return "blackout";
  if (!goldCheckOf(executor).ok) return "symbol_unverified";
  if (typeof sym.tick_value_problem === "string" && sym.tick_value_problem !== "") return "tick_value_mismatch";
  if (typeof executor?.account?.money?.problem === "string" && executor.account.money.problem !== "") return "money_unverified";
  if (account != null && account.spec_status !== "validated") return "spec_unvalidated";
  if (account?.review_pending === true) return "profile_review_pending";
  if (finite(lossFloor) && finite(executor?.account?.equity) && executor.account.equity <= lossFloor) return "daily_loss_limit";
  if (budget != null && !(budget > 0)) return "daily_risk_budget";
  if (!order) return null;
  if (!meta || typeof meta !== "object") return "pending_unrecorded";
  const buy = order.type === "BUY_LIMIT";
  const knobs = meta.knobs && finite(meta.knobs.max_pending_life) ? meta.knobs : limitKnobs(meta.mode, null, { changes: changeTokens(settings) });
  const was = PROFILE_RANK[meta.profile], is = PROFILE_RANK[account?.profile];
  if (was != null && is != null && is < was) return "profile_downgrade";
  if ((buy ? signal?.veto_long : signal?.veto_short) === true) return "de_veto";
  // The current 15m decision against the placing one: its side's share of the weighted quorum.
  const share = Number(buy ? signal?.quorum_long_share : signal?.quorum_short_share), share0 = Number(meta.share0);
  if (changeOn(changeTokens(settings), "limit")) {
    // CH1 (owner 2026-11-23, token `limit`): a fall of at least cancel_share_drop (scalp 0.10, intraday and range 0.10,
    // swing 0.15, recorded at placement), outside scalp on the decision before this one too (both after the placing one).
    const sharePrev = Number(buy ? signal?.quorum_long_share_prev : signal?.quorum_short_share_prev);
    if (finite(signal?.power_ms) && finite(meta.decision_ms) && signal.power_ms > meta.decision_ms
      && pendingShareFall({ mode: meta.mode, threshold: knobs.cancel_share_drop, share0, share, sharePrev, prevMs: Number(signal?.decision_prev_ms), currentMs: signal.power_ms, placedDecisionMs: meta.decision_ms })) return "quorum_share_drop";
  } else if (finite(signal?.power_ms) && finite(meta.decision_ms) && signal.power_ms > meta.decision_ms && share >= 0 && share0 >= 0 && share0 - share > knobs.cancel_share_drop + 1e-9) return "quorum_share_drop";
  const placed = positive(order.placed_ms) ? order.placed_ms : Number(meta.placed_ms);
  if ((finite(placed) && now >= placed + knobs.max_pending_life * 60_000) || (finite(meta.expiry_ms) && now >= meta.expiry_ms)) return "pending_expired";
  return null;
}
/** An Omega pending order without a stop: Omega never places one, so it is deleted (its risk is unbounded). */
export function pendingWithoutStop(o) {
  return !(Number(o?.sl) > 0);
}
/** One delete per order and minute: a refused delete is sent again a minute later, never twice in a minute. */
export function deleteOrderIntent(ticket, reason, now = Date.now()) {
  return { id: `del:${ticket}:${Math.floor(now / 60_000)}`.slice(0, INTENT_ID_MAX), kind: "delete_order", ticket, reason };
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
  // The Positioning & Liquidity analyst's lens B (docs/RFC_POSITIONING_LIQUIDITY.md §4.4; owner 2026-11-20,
  // "rekomendasi"): sweep extremes, untaken pools and high-volume nodes join the key levels with source "liquidity",
  // already on the broker's scale (no basis added), only while the lens is on (the signal's liquidity_on).
  const liquidity = signalLiquidityLevels(signal);
  const out = [];
  if (signal?.feed_basis_known === true && finite(signal.feed_basis) && typeof signal.key_levels === "string" && signal.key_levels) {
    for (const part of signal.key_levels.split(",")) {
      const [lo, hi] = part.split(":").map(Number);
      if (positive(lo) && positive(hi) && lo <= hi) out.push({ low: lo + signal.feed_basis, high: hi + signal.feed_basis });
    }
  }
  out.push(...liquidity);
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
 * The stop only moves in the position's favour and keeps the broker's stop distance from price. `lockPx` (SLG1, the
 * profit-lock gate on) replaces the small-profit lock with the gate's first lock.
 */
export function keyLevelPlan({ position: p, sym, signal, levels, now = Date.now(), extend = true, lockPx = null }) {
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
    // SLG1: with the profit-lock gate on, the lock floor is the gate's first lock (`lockPx`, break-even plus the spread
    // plus 0.1 x ATR(M5)); SL+ goes further than it only after the gate.
    const lock = finite(lockPx) ? lockPx : open + dir * Math.max(2 * spreadPx, buffer);
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
  // Range (owner 2026-11-18) is laddered as intraday: +0.5R steps on M15 candles.
  const mode = meta?.mode === "intraday" || meta?.mode === "range" ? "intraday" : meta?.mode === "swing" ? "swing" : "scalp";
  if (mode === "scalp") return { mode, step: S.ladder_lock_pips * GOLD_PIP, unit: "pips" };
  const r = Number(meta?.r_dist);
  if (!(r > 0)) return { mode, step: null, unit: "R" };
  return { mode, step: r * (mode === "intraday" ? S.ladder_r_intraday : S.ladder_r_swing), unit: "R" };
}

export function ladderPlan({ position: p, sym, signal = null, levels = null, settings = OMEGA_DEFAULTS, partialsDone = 0, now = Date.now(), meta = null, candles = undefined, beLockPx = null }) {
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
    // SLG1: with the profit-lock gate on, TP0 is the gate's first lock (`beLockPx`: break-even plus the spread plus
    // 0.1 x ATR(M5)); the planner drops every ladder lock into profit while the gate is closed.
    const target = roundTo(rung === 0 ? (finite(beLockPx) ? beLockPx : open + dir * buffer) : L[rung], digits);
    const better = !finite(curSl) || curSl <= 0 ? true : buy ? target > curSl + point : target < curSl - point;
    // The break-even lock is taken once: its buffer follows the spread and the M5 ATR, so a stop already past the entry
    // is not moved again by a few cents at TP0 (2026-11-19: three modifications in seven seconds).
    const lockedBeyondEntry = finite(curSl) && curSl > 0 && (buy ? curSl > open + point / 2 : curSl < open - point / 2);
    const room = buy ? target < sym.bid - floorPx : target > sym.ask + floorPx;
    if (target > 0 && better && room && !(rung === 0 && lockedBeyondEntry)) { sl = target; slRung = rung; }
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
 * Pure: the stops Omega has commanded recently, per ticket ({ [ticket]: [sl, ...] }), from omega_intents rows
 * ({ payload, status, result }): modify_sl intents still pending or sent, or done with an ok result. The executor's
 * position snapshot can predate a modification Omega has just made (2026-11-19, ticket 362785677: a SELL locked at
 * 3719.19, the next sync still saw the entry stop and sent 3719.23, the one after sent 3719.19 again). The
 * management reads the tightest of these and the snapshot, so a stale snapshot never loosens a stop.
 */
export const STOP_COMMAND_MS = 5 * 60_000;
export function commandedStops(rows = []) {
  const out = {};
  for (const r of rows) {
    let it = r?.payload, res = r?.result;
    try { if (typeof it === "string") it = JSON.parse(it); if (typeof res === "string") res = JSON.parse(res); } catch { continue; }
    // A Position Manager stop-and-target (modify_sltp, ADR-0020 Amendment 6) commands a stop too; the owner's own
    // modify_sltp (manual: ids) may loosen one on purpose and is never held against the snapshot.
    const pmSltp = it?.kind === "modify_sltp" && /^(d:)?pm:/.test(String(it.id ?? ""));
    if ((it?.kind !== "modify_sl" && !pmSltp) || it.ticket == null || !positive(Number(it.sl))) continue;
    const live = r.status === "pending" || r.status === "sent" || (r.status === "done" && res?.ok === true);
    if (!live) continue;
    (out[String(it.ticket)] ??= []).push(Number(it.sl));
  }
  return out;
}

/** Pure: the position with its stop at the tightest of the snapshot's and the stops commanded for it. */
export function withCommandedStop(p, stops = {}) {
  const list = stops?.[String(p?.ticket)];
  if (!Array.isArray(list) || !list.length || (p.side !== "BUY" && p.side !== "SELL")) return p;
  const cur = Number(p.sl), buy = p.side === "BUY";
  let sl = finite(cur) && cur > 0 ? cur : null;
  for (const x of list) if (sl == null || (buy ? x > sl : x < sl)) sl = x;
  return sl === cur ? p : { ...p, sl };
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
 * SLG1 (owner 2026-11-23, src/profit-lock-gate.mjs): with `gates` (the planner passes them while profit_lock_gate is
 * "on"; { [ticket]: gate facts }, a ticket missing reads as closed) no stop moves to or beyond the entry (SL+, the
 * break-even, the 5m trail, the ladder's lock) until the position's gate is open; at the gate the first lock is
 * break-even plus the spread plus 0.1 x ATR(M5) (gateBreakEven), and each lock records the MFE it was made at (mfe_r,
 * mfe_atr). Without `gates` (direct calls, profit_lock_gate "legacy"), no gate: today's locks.
 */
export function manageIntents({ positions = [], sym = {}, settings = OMEGA_DEFAULTS, signal = null, side = null, recentIntentIds = [], skipTickets = [], now = Date.now(), extendOf = () => true, positionMeta = {}, candles = undefined, stops = {}, loosenedFrom = {}, gates = undefined } = {}) {
  const S = { ...OMEGA_DEFAULTS, ...pickSettings(settings ?? {}) };
  const out = [];
  if (!finite(sym.bid) || !finite(sym.ask)) return out;
  const digits = Number.isInteger(sym.digits) ? sym.digits : 2;
  const skip = new Set(skipTickets.filter((t) => t != null));
  const recent = new Set(recentIntentIds);
  const scaledBefore = (ticket) => [...recent].some((rid) => String(rid).startsWith(`ps:${ticket}:`));
  const targetExtTp = positive(signal?.extended_tp) ? signal.extended_tp : positive(signal?.tp2) ? signal.tp2 : null;
  const levels = brokerKeyLevels(signal);
  for (const p0 of positions) {
    if (p0?.ticket == null || skip.has(p0.ticket) || (p0.side !== "BUY" && p0.side !== "SELL") || !isOmegaOwned(p0)) continue;
    const p = withCommandedStop(p0, stops);
    const buy = p.side === "BUY";
    const open = Number(p.open_price ?? p.entry), curSl = Number(p.sl), curTp = Number(p.tp), vol = Number(p.volume);
    if (!Number.isFinite(open)) continue;
    // ADR-0020 Amendment 8: after the council loosened this stop, a mechanical lock waits until it is tighter than the
    // stop before the loosening (`loosenedFrom`), so the ladder never undoes it from where it was.
    const from = Number(loosenedFrom?.[String(p.ticket)]);
    const halfPt = (positive(sym.point) ? sym.point : Math.pow(10, -digits)) / 2;
    const held = (x) => finite(from) && from > 0 && !(buy ? x > from + halfPt : x < from - halfPt);
    const move = buy ? sym.bid - open : open - sym.ask;
    const atBreakEven = Number.isFinite(curSl) && (buy ? curSl >= open - 1e-9 : curSl <= open + 1e-9);
    const risk = Number.isFinite(curSl) && !atBreakEven ? Math.abs(open - curSl) : 0;
    const r = risk > 0 ? move / risk : 0;
    // SLG1: the position's profit-lock gate (null without `gates`: no gate). Closed, a stop at or beyond the entry waits.
    const gate = gates === undefined ? null : gates?.[String(p.ticket)] ?? GATE_UNMEASURED;
    const gatePoint = positive(sym.point) ? sym.point : Math.pow(10, -digits);
    const gateShut = (x) => gate != null && gate.open !== true && stopInProfit(x, open, buy ? 1 : -1, gatePoint);
    const gateBe = gate ? gateBreakEven({ open, dir: buy ? 1 : -1, spread: (finite(sym.spread_points) ? sym.spread_points : 0) * gatePoint, atrM5: gateAtrM5(signal, sym), digits }) : null;

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
      const k = keyLevelPlan({ position: p, sym, signal, levels, now, extend: extendOf(p), ...(gate ? { lockPx: gateBe } : {}) });
      if (k.close) {
        out.push({ id: `cl:${p.ticket}:pw:${Math.floor(signal.power_ms / 60_000)}`, kind: "close", ticket: p.ticket, reason: "power_reversal" });
        continue;
      }
      if (k.sl != null && !held(k.sl) && !gateShut(k.sl)) {
        out.push({ id: `ms:${p.ticket}:k:${Math.round(k.sl * 100)}`, kind: "modify_sl", ticket: p.ticket, sl: k.sl, tp: Number.isFinite(curTp) ? curTp : null, reason: `sl_key_level_${k.band}` });
        movedSl = true;
      }
      if (k.tp != null) out.push({ id: `mt:${p.ticket}:${Math.round(k.tp * 100)}`, kind: "modify_tp", ticket: p.ticket, tp: k.tp, reason: "trail_tp_key_level" });
    }
    if (gate && !movedSl && S.trailing_stop_r > 0 && !atBreakEven && risk > 0 && r >= S.trailing_stop_r) {
      // SLG1: the break-even waits for the gate and then goes to the gate's first lock, with the broker's stop distance.
      const floorPx = (finite(sym.stops_level_points) ? sym.stops_level_points : 0) * gatePoint + (finite(sym.spread_points) ? sym.spread_points : 0) * gatePoint;
      const room = buy ? gateBe < sym.bid - floorPx : gateBe > sym.ask + floorPx;
      if (!gateShut(gateBe) && room && !held(gateBe)) {
        out.push({ id: `ms:${p.ticket}:be`, kind: "modify_sl", ticket: p.ticket, sl: gateBe, tp: Number.isFinite(curTp) ? curTp : null, reason: "break_even" });
        movedSl = true;
      }
    } else if (!movedSl && S.trailing_stop_r > 0 && !atBreakEven && risk > 0 && r >= S.trailing_stop_r && !held(roundTo(open, digits))) {
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
      if (finite(target) && target > 0 && better && room && !held(target) && !gateShut(target)) {
        out.push({ id: `ms:${p.ticket}:t5:${Math.floor(m5.m5_close_ms / 60_000)}`, kind: "modify_sl", ticket: p.ticket, sl: target, tp: Number.isFinite(curTp) ? curTp : null, reason: "trail_5m" });
      }
    }

    if (!levels && targetExtTp != null && extendOf(p) && p.side === side && Number.isFinite(curTp) && (buy ? targetExtTp > curTp + 0.1 : targetExtTp < curTp - 0.1)) {
      out.push({ id: `mt:${p.ticket}:${Math.round(targetExtTp * 100)}`, kind: "modify_tp", ticket: p.ticket, tp: roundTo(targetExtTp, digits), reason: "extended_tp" });
    }

    // The TP ladder: the SL lock and the progressive partials (ladderPlan). It replaces the single scale-out below.
    if (S.tp_ladder) {
      const partialsDone = [...recent].filter((rid) => String(rid).startsWith(`pl:${p.ticket}:`)).length;
      const lad = ladderPlan({ position: p, sym, signal, levels, settings: S, partialsDone, now, meta: positionMeta?.[p.intent_id] ?? null, candles, ...(gate ? { beLockPx: gateBe } : {}) });
      if (lad.sl != null && held(lad.sl)) lad.sl = null;
      if (lad.sl != null && gateShut(lad.sl)) lad.sl = null;
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
  if (gates !== undefined) stampGate(out, positions, gates, sym);
  return out;
}

/**
 * Pure (SLG1): each stop at or beyond its position's entry in `intents` records the MFE its gate measured (mfe_r,
 * mfe_atr), for the audit. Only an open gate lets such a stop through, so these are the locks made at or after it.
 */
export function stampGate(intents, positions, gates, sym = {}) {
  const point = positive(sym.point) ? sym.point : 0.01;
  for (const it of intents) {
    if ((it.kind !== "modify_sl" && it.kind !== "modify_sltp") || !finite(it.sl)) continue;
    const p = positions.find((x) => x?.ticket === it.ticket), g = gates?.[String(it.ticket)];
    if (!p || !g || !stopInProfit(it.sl, Number(p.open_price ?? p.entry), p.side === "BUY" ? 1 : -1, point)) continue;
    it.mfe_r = g.mfe_r ?? null;
    it.mfe_atr = g.mfe_atr ?? null;
  }
  return intents;
}

// The same-side re-entry guard (owner 2026-11-18, relayed and confirmed: "Setuju"). On 2026-11-18 the Position Manager
// closed a SELL on weakening and the next 15m SELL opened again seconds later, four times.
export const REENTRY_EXIT_REASONS = Object.freeze(["pm_take_profit_weakening", "pm_cut_loss"]);
const M5_MS = 5 * 60_000;

/**
 * Pure: whether a new entry on `side` waits after the Position Manager closed one on that side for weakening or a cut
 * loss (`reentry`: { side, exit_ms } of the latest such exit, or null). Exits by TP, the ladder or the stop are never
 * one. Owner 2026-11-18 (relayed and confirmed: "Setuju keduanya"): only a cooldown of `reentry_cooldown_bars` closed M5
 * candles after the exit (1: until the M5 candle the exit fell in has closed); after it the signal is treated as any
 * other. The 0.5×ATR pullback and the confidence bypass of #455 are gone: anchored on a stale exit price they held SELLs
 * for hours through a whole downtrend (13:32 to 15:47 that day). Returns null (free) or { code, detail }.
 */
export function reentryGate({ side, reentry, settings = OMEGA_DEFAULTS, now = Date.now() }) {
  const S = { ...OMEGA_DEFAULTS, ...pickSettings(settings ?? {}) };
  if (!reentry || reentry.side !== side || !finite(reentry.exit_ms) || !(S.reentry_cooldown_bars > 0)) return null;
  const free = Math.floor(reentry.exit_ms / M5_MS) * M5_MS + S.reentry_cooldown_bars * M5_MS;
  if (now >= free) return null;
  return { code: "reentry_cooldown", detail: `${S.reentry_cooldown_bars} closed M5 candle${S.reentry_cooldown_bars > 1 ? "s" : ""} after the ${side} exit${finite(reentry.exit_price) ? ` at ${reentry.exit_price}` : ""}: free at ${new Date(free).toISOString().slice(11, 16)} UTC` };
}

/** A position whose stop sits at or beyond its open price (break-even or locked profit) risks nothing more. */
export function isProtected(p) {
  // ADR-0020 Amendment 8: a position whose stop the council loosened counts as unprotected again, wherever its stop is.
  if (p?.loosened === true) return false;
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
 * SLG1 (owner 2026-11-23): with `gates` (profit_lock_gate "on"), a stop at or beyond the entry (break-even, the TP1
 * lock, TP2 with break-even) and TP2 itself wait for the position's profit-lock gate: dropped, with the gate's reading,
 * while it is closed; at or after it each lock records the MFE it was made at (mfe_r, mfe_atr).
 * PM-1M (owner 2026-11-23, src/pm-fast.mjs): an action with a fast id (pm1:<ticket>:<bar minute>) is the 1m layer's,
 * checked by fastIntent under the same id: its stop into profit waits for the gate as above; a nearer target is not one.
 */
export function positionManagerIntents({ positions = [], sym = {}, actions = [], skipTickets = [], sltp = false, a8 = null, loosenedFrom = {}, gates = undefined } = {}) {
  // `dropped`: each action that became no intent, with the reason in plain words (owner 2026-11-19: the Telegram
  // line says what reached the broker, and why an action did not).
  const out = [], used = [], dropped = [];
  const drop = (a, reason) => dropped.push({ id: a.id, reason });
  if (!finite(sym.bid) || !finite(sym.ask)) { for (const a of actions) drop(a, "no live price from the terminal"); return { intents: out, used, dropped }; }
  const skip = new Set(skipTickets.filter((t) => t != null));
  const point = positive(sym.point) ? sym.point : 0.01;
  const digits = Number.isInteger(sym.digits) ? sym.digits : 2;
  const floorPx = (finite(sym.stops_level_points) ? sym.stops_level_points : 0) * point + (finite(sym.spread_points) ? sym.spread_points : 0) * point;
  for (const a of actions) {
    const p = positions.find((x) => x?.ticket === a.ticket);
    if (!p) { drop(a, "the position is no longer open"); continue; }
    if (skip.has(p.ticket)) { drop(a, "another close of this position comes first"); continue; }
    if (!isOmegaOwned(p) || (p.side !== "BUY" && p.side !== "SELL")) { drop(a, "not an Omega position"); continue; }
    const buy = p.side === "BUY", curSl = Number(p.sl), curTp = Number(p.tp);
    const bar = String(a.id).split(":").pop();
    // ADR-0020 Amendment 8: after a loosening, a stop the manager locks must be tighter than the stop before it.
    const from = Number(loosenedFrom?.[String(p.ticket)]);
    const heldByLoosen = (x) => finite(from) && from > 0 && !(buy ? x > from + point / 2 : x < from - point / 2);
    const a8Rule = typeof a.rule === "string" && (a.rule.startsWith("loosen_") || /^tp_(nearer|further)_/.test(a.rule));
    // SLG1: the position's profit-lock gate while it is on (a ticket missing reads as closed).
    const gate = gates === undefined ? null : gates?.[String(p.ticket)] ?? GATE_UNMEASURED;
    const gateClosed = gate != null && gate.open !== true;
    const intoProfit = (x) => stopInProfit(roundTo(x, digits), Number(p.open_price ?? p.entry), buy ? 1 : -1, point);
    if (!a8Rule && gateClosed && ((a.action === "sl" && finite(a.sl) && intoProfit(a.sl)) || (a.action === "tp" && /^tp2_/.test(String(a.rule))))) {
      drop(a, `${a.action === "tp" ? "TP2 waits" : "the lock waits"} for the profit-lock gate: ${gateText(gate)}`);
      continue;
    }
    if (isFastId(a.id)) {
      // PM-1M (src/pm-fast.mjs): the 1m layer's lock, tightened stop, nearer target or early close, checked again here.
      const r = fastIntent({ a, p, sym, bar, point, digits, floorPx });
      if (r.drop) { drop(a, r.drop); continue; }
      if (r.intent.kind === "modify_sl" && heldByLoosen(r.intent.sl)) { drop(a, `the council loosened this stop: a lock waits until it is tighter than ${from}, the stop before the loosening`); continue; }
      out.push(r.intent);
    } else if (a8Rule) {
      // The council's loosening or target move (ADR-0020 Amendment 8), checked again here against every bound.
      const r = a8Intent({ a, p, sym, bar, a8, point, digits, floorPx });
      if (r.drop) { drop(a, r.drop); continue; }
      out.push(r.intent);
    } else if (a.action === "close") {
      out.push({ id: `pm:${p.ticket}:c:${bar}`, kind: "close", ticket: p.ticket, reason: `pm_${a.rule}` });
    } else if (a.action === "sl" && finite(a.sl)) {
      const sl = roundTo(a.sl, digits);
      const tighter = !Number.isFinite(curSl) || curSl <= 0 || (buy ? sl > curSl + point / 2 : sl < curSl - point / 2);
      const room = buy ? sl < sym.bid - floorPx : sl > sym.ask + floorPx;
      if (!tighter) { drop(a, `the stop is already at or beyond ${sl}`); continue; }
      if (!room) { drop(a, `the live price leaves no room for a stop at ${sl}`); continue; }
      if (heldByLoosen(sl)) { drop(a, `the council loosened this stop: a lock waits until it is tighter than ${from}, the stop before the loosening`); continue; }
      out.push({ id: `pm:${p.ticket}:s:${bar}`, kind: "modify_sl", ticket: p.ticket, sl, tp: Number.isFinite(curTp) ? curTp : null, reason: `pm_${a.rule}` });
    } else if (a.action === "tp" && finite(a.tp)) {
      const tp = roundTo(a.tp, digits);
      const outward = Number.isFinite(curTp) && curTp > 0 && (buy ? tp > curTp + point / 2 && tp > sym.ask + floorPx : tp < curTp - point / 2 && tp < sym.bid - floorPx);
      if (!outward) { drop(a, `a target at ${tp} is not further out than the broker's (${Number.isFinite(curTp) && curTp > 0 ? curTp : "none"})`); continue; }
      if (finite(a.sl)) {
        // ADR-0020 Amendment 6: the target out to TP2 with the stop at break-even or better, in one modification (both
        // or neither; OmegaExecutor 1.18 modify_sltp). The stop never below the entry, never looser, with room.
        const sl = roundTo(a.sl, digits), open = Number(p.open_price ?? p.entry);
        if (!sltp) { drop(a, "TP2 with the break-even stop needs OmegaExecutor 1.18 or newer"); continue; }
        const notLooser = Number.isFinite(curSl) && curSl > 0 ? (buy ? sl >= curSl - point / 2 : sl <= curSl + point / 2) : true;
        const notBelowEntry = Number.isFinite(open) && (buy ? sl >= open - point / 2 : sl <= open + point / 2);
        const room = buy ? sl < sym.bid - floorPx : sl > sym.ask + floorPx;
        if (!notLooser || !notBelowEntry) { drop(a, `a stop at ${sl} would be looser than the broker's or below the entry`); continue; }
        if (!room) { drop(a, `the live price leaves no room for a stop at ${sl}`); continue; }
        if (heldByLoosen(sl) && sl !== roundTo(curSl, digits)) { drop(a, `the council loosened this stop: a lock waits until it is tighter than ${from}, the stop before the loosening`); continue; }
        out.push({ id: `pm:${p.ticket}:t:${bar}`, kind: "modify_sltp", ticket: p.ticket, sl, tp, reason: `pm_${a.rule}` });
      } else out.push({ id: `pm:${p.ticket}:t:${bar}`, kind: "modify_tp", ticket: p.ticket, tp, reason: `pm_${a.rule}` });
    } else { drop(a, "not an action Omega applies"); continue; }
    used.push(a.id);
  }
  if (gates !== undefined) stampGate(out, positions, gates, sym);
  return { intents: out, used, dropped };
}

/**
 * Pure: the loosenings already sent, per ticket ({ [ticket]: { from_sl, sl, id } }), from omega_intents rows
 * ({ payload, status, result }) of modify_sl or modify_sltp intents marked `loosen` (ADR-0020 Amendment 8). A loosening
 * the broker refused (status failed) changed nothing and is not one; pending, sent, done and expired ones are (an
 * unanswered one may have applied). At most one per position: a ticket here is never loosened again, counts as
 * unprotected, and its mechanical locks wait until they are tighter than `from_sl`.
 */
export function loosenRecords(rows = []) {
  const out = {};
  for (const r of rows) {
    let it = r?.payload;
    try { if (typeof it === "string") it = JSON.parse(it); } catch { continue; }
    if ((it?.kind !== "modify_sl" && it?.kind !== "modify_sltp") || it.loosen !== true || it.ticket == null) continue;
    if (r.status === "failed") continue;
    const t = String(it.ticket);
    if (!out[t]) out[t] = { from_sl: finite(Number(it.from_sl)) && Number(it.from_sl) > 0 ? Number(it.from_sl) : null, sl: Number(it.sl), id: it.id ?? null };
  }
  return out;
}

/**
 * Pure: one Amendment 8 action as an intent, or { drop: reason }. `a8` is planIntents' context with the switch on:
 * { original: { [ticket]: { sl, mode, r_dist } }, loosened, stops, blocked, veto(p), riskCheck(p, sl) }.
 *   stop     looser than the broker's stop (the tightest commanded one included), never past the original entry stop,
 *            at most back_share of the way back, from break-even or better never into loss, once per position, never
 *            a delegated position's, within the daily loss budget and the profile caps at the new stop, not against a
 *            veto, never while paused, on a real account not armed, or with the tick value or money unverified;
 *   target   nearer: between the price and the current target, on the right side of price with the broker's stop
 *            distance; further: beyond the current target, never with a stop, not against a veto.
 */
export function a8Intent({ a, p, sym, bar, a8, point = 0.01, digits = 2, floorPx = 0 }) {
  if (!a8) return { drop: "the council's stop and target moves are switched off (ADR-0020 Amendment 8, pm_loosen_enabled)" };
  if (p.delegated === true) return { drop: "a delegated position is never loosened or retargeted by the council" };
  const buy = p.side === "BUY", dir = buy ? 1 : -1, open = Number(p.open_price ?? p.entry), curTp = Number(p.tp);
  const t = String(p.ticket), orig = a8.original?.[t] ?? null;
  const rd = positive(Number(orig?.r_dist)) ? Number(orig.r_dist) : positive(Number(orig?.sl)) && finite(open) ? Math.abs(open - Number(orig.sl)) : null;
  const inR = (x) => (rd ? roundTo((dir * x) / rd, 2) : null);
  const mode = typeof orig?.mode === "string" ? orig.mode : null;
  if (a.action === "sl" && finite(a.sl) && a.rule.startsWith("loosen_")) {
    if (a8.blocked) return { drop: `no loosening: ${a8.blocked}` };
    if (!positive(Number(orig?.sl))) return { drop: "no loosening: the position's original entry stop is unknown" };
    if (a8.loosened?.[t]) return { drop: "no loosening: this position was loosened once already" };
    if (a8.veto?.(p)) return { drop: "no loosening: the Decision Engine vetoes the position's side" };
    const o = Number(orig.sl), sl = roundTo(a.sl, digits);
    const cur = Number(withCommandedStop(p, a8.stops ?? {}).sl);
    if (!positive(cur)) return { drop: "no loosening: the position has no stop" };
    if (!(buy ? sl < cur - point / 2 : sl > cur + point / 2)) return { drop: `no loosening: a stop at ${sl} is not looser than the broker's (${cur})` };
    if (buy ? sl < o - point / 2 : sl > o + point / 2) return { drop: `no loosening: a stop at ${sl} is beyond the original entry stop ${o}` };
    const tightened = dir * (cur - o);
    if (!(tightened > point / 2)) return { drop: "no loosening: the stop was never tightened" };
    const share = pmLoosenKnobs(mode).back_share;
    if (dir * (cur - sl) > share * tightened + point / 2) return { drop: `no loosening: a stop at ${sl} goes more than ${Math.round(share * 100)}% of the way back to ${o}` };
    if (finite(open) && dir * (cur - open) >= -1e-9 && dir * (sl - open) < -point / 2) return { drop: `no loosening: from break-even or better the stop never goes back into loss (${sl} against the entry ${open})` };
    if (!(buy ? sl < sym.bid - floorPx : sl > sym.ask + floorPx)) return { drop: `the live price leaves no room for a stop at ${sl}` };
    const risk = a8.riskCheck?.(p, sl) ?? null;
    if (risk) return { drop: `no loosening: ${risk}` };
    return { intent: { id: `pm:${p.ticket}:s:${bar}`, kind: "modify_sl", ticket: p.ticket, sl, tp: Number.isFinite(curTp) ? curTp : null, reason: `pm_${a.rule}`, loosen: true, from_sl: cur, orig_sl: o, mode,
      risk_r_before: inR(open - cur), risk_r_after: inR(open - sl) } };
  }
  if (a.action === "tp" && finite(a.tp) && /^tp_(nearer|further)_/.test(a.rule)) {
    if (finite(a.sl)) return { drop: "a target move by the council never carries a stop (a target further never comes with a looser stop)" };
    if (!(Number.isFinite(curTp) && curTp > 0)) return { drop: "the position has no target to move" };
    const tp = roundTo(a.tp, digits);
    const right = buy ? tp > sym.ask + floorPx : tp < sym.bid - floorPx;
    if (!right) return { drop: `a target at ${tp} would be on the wrong side of price or inside the broker's stop distance` };
    const nearer = a.rule.startsWith("tp_nearer_");
    if (nearer ? !(buy ? tp < curTp - point / 2 : tp > curTp + point / 2) : !(buy ? tp > curTp + point / 2 : tp < curTp - point / 2)) return { drop: `a target at ${tp} is not ${nearer ? "nearer" : "further out"} than the broker's (${curTp})` };
    if (!nearer && a8.veto?.(p)) return { drop: "no target further: the Decision Engine vetoes the position's side" };
    return { intent: { id: `pm:${p.ticket}:t:${bar}`, kind: "modify_tp", ticket: p.ticket, tp, reason: `pm_${a.rule}`, from_tp: curTp, mode, tp_r_from: finite(open) ? inR(curTp - open) : null, tp_r_to: finite(open) ? inR(tp - open) : null } };
  }
  return { drop: "not an action Omega applies" };
}

/**
 * Pure: one PM-1M fast action (src/pm-fast.mjs, id pm1:<ticket>:<bar minute>) as an intent with the same id, or
 * { drop: reason }. Risk-reducing only: a close; a stop only tighter than the broker's, with the broker's stop distance;
 * a target only nearer than the broker's and on the right side of price with that distance, never with a stop. The
 * profit-lock gate (SLG1) has dropped a stop into profit before this, as for every Position Manager lock.
 */
export function fastIntent({ a, p, sym, bar, point = 0.01, digits = 2, floorPx = 0 }) {
  const buy = p.side === "BUY", curSl = Number(p.sl), curTp = Number(p.tp);
  const id = `pm1:${p.ticket}:${bar}`;
  if (a.action === "close") return { intent: { id, kind: "close", ticket: p.ticket, reason: a.rule } };
  if (a.action === "sl" && finite(a.sl)) {
    const sl = roundTo(a.sl, digits);
    const tighter = !Number.isFinite(curSl) || curSl <= 0 || (buy ? sl > curSl + point / 2 : sl < curSl - point / 2);
    if (!tighter) return { drop: `the stop is already at or beyond ${sl}` };
    if (!(buy ? sl < sym.bid - floorPx : sl > sym.ask + floorPx)) return { drop: `the live price leaves no room for a stop at ${sl}` };
    return { intent: { id, kind: "modify_sl", ticket: p.ticket, sl, tp: Number.isFinite(curTp) ? curTp : null, reason: a.rule } };
  }
  if (a.action === "tp" && finite(a.tp)) {
    if (finite(a.sl)) return { drop: "a fast target move never carries a stop" };
    if (!(Number.isFinite(curTp) && curTp > 0)) return { drop: "the position has no target to bring nearer" };
    const tp = roundTo(a.tp, digits);
    if (!(buy ? tp < curTp - point / 2 : tp > curTp + point / 2)) return { drop: `a target at ${tp} is not nearer than the broker's (${curTp})` };
    if (!(buy ? tp > sym.ask + floorPx : tp < sym.bid - floorPx)) return { drop: `a target at ${tp} would be on the wrong side of price or inside the broker's stop distance` };
    return { intent: { id, kind: "modify_tp", ticket: p.ticket, tp, reason: a.rule, from_tp: curTp } };
  }
  return { drop: "not an action Omega applies" };
}

export const LEAN_BAND = 0.15;
export const DEFAULT_POSITION_AGENT = "zone_pullback";
/**
 * CH1 (owner 2026-11-23), `changes` the change_thresholds tokens (planIntents passes them; absent: today's rules): with
 * `conf` on, confidence_drop and the extend gate need a change of at least CONFIDENCE_CHANGE_MIN, and an "unknown"
 * trend reads as the last known one for the extend gate (the decision before's own trend, the signal's agent_conf_last
 * and agent_conf_last_prev), so a missing reading no longer blocks it. lean_flip is unchanged.
 */
export function strategyExits({ positions = [], signal = null, sym = {}, agents = {}, now = Date.now(), skipTickets = [], changes = null } = {}) {
  const intents = [];
  const extendOf = () => true;
  if (signal?.strategy_execution !== true) return { intents, extendOf };
  const fresh = finite(signal.power_ms) && signal.power_ms > 0 && now - signal.power_ms <= POWER_FRESH_MS;
  if (!fresh) return { intents, extendOf: () => false };
  const bar = Math.floor(signal.power_ms / 60_000);
  const conf = parseConfidences(signal.agent_conf), prev = parseConfidences(signal.agent_conf_prev);
  const agentOf = (p) => (typeof agents?.[p.intent_id] === "string" && agents[p.intent_id]) || DEFAULT_POSITION_AGENT;
  const confOn = changeOn(changes, "conf");
  const band = confOn ? { min: CONFIDENCE_CHANGE_MIN } : undefined;
  const trendOf = (p) => { const a = agentOf(p), k = p.side === "BUY" ? "long" : "short"; return confidenceTrend(conf[a]?.[k], prev[a]?.[k], band); };
  const last = confOn ? parseConfidences(signal.agent_conf_last) : null, lastPrev = confOn ? parseConfidences(signal.agent_conf_last_prev) : null;
  const extendTrend = (p) => {
    const t = trendOf(p);
    if (!confOn || t !== "unknown") return t;
    const a = agentOf(p), k = p.side === "BUY" ? "long" : "short";
    return confidenceTrend(last[a]?.[k], lastPrev[a]?.[k], band);
  };
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
  return { intents, extendOf: (p) => ["stable", "rising"].includes(extendTrend(p)) };
}

/* ---------- live limit entries (docs/RFC_OMEGA_LIMIT_ENTRY.md §2-§6, stage 3) ---------- */
const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * EZ1 (owner 2026-11-23: "decision & signal harusnya memberi nilai zone bukan exact, sehingga omega tidak akan info limit
 * through price"; src/strategy-engine.mjs ENTRY_ZONE): the least reward a limit moved inside the entry zone keeps to its
 * first target, as TP1-KZ's floor (TP1_MIN_R).
 */
export const ZONE_MIN_RR = 1;
/** The least share of the plan's risk (its stop distance) a limit moved inside the entry zone keeps (zone_tight). */
export const ZONE_MIN_RISK_SHARE = 0.5;
/**
 * Pure: the signal's entry zone on the broker's scale ({ low, high }, entry_zone_low/high + feed_basis), or null: none
 * sent, or one that no longer holds the signal's entry or reaches its stop (a grid adaptation moved them).
 */
export function signalEntryZone(signal, digits = 2) {
  const lo = Number(signal?.entry_zone_low), hi = Number(signal?.entry_zone_high), entry = Number(signal?.entry), stop = Number(signal?.stop);
  if (![lo, hi, entry, stop].every(positive) || !(lo < hi) || !(lo <= entry && entry <= hi) || !finite(signal?.feed_basis)) return null;
  if (signal.side === "BUY" ? !(stop < lo) : signal.side === "SELL" ? !(hi < stop) : true) return null;
  return { low: roundTo(lo + signal.feed_basis, digits), high: roundTo(hi + signal.feed_basis, digits) };
}
/**
 * Pure (EZ1b): the limit at the entry zone's near edge (a BUY's high, a SELL's low) when the plan's level is out of the
 * placement band and that edge is inside it: the edge, moved away from price by the gap zoneLimit keeps (max of the
 * stop level, 1 spread, 1 step) where it is that close, then the plan's stop and target kept, with zoneLimit's guards
 * (zone_passed, zone_tight, zone_rr). Null when the edge is out of the band too (today's limit_out_of_band). Its note
 * is limit_zone_edge with { plan_entry, edge, away_r_plan, away_r_edge }; the order records entry_basis "zone_edge".
 */
export function zoneEdgeLimit({ signal, sym = {}, zone, digits = 2, planStopDist, minDist = 0, knobs, from }) {
  const buy = signal.side === "BUY";
  const edge = buy ? zone.high : zone.low;
  const awayEdge = roundTo(buy ? sym.ask - edge : edge - sym.bid, digits + 2);
  if (!(planStopDist > 0) || awayEdge > knobs.placement_band * planStopDist + 1e-9) return null;
  const awayPlan = roundTo(buy ? sym.ask - from : from - sym.bid, digits + 2);
  // The zone's level nearest the plan that clears the gap from price: the edge itself unless price is that close.
  const r = zoneLimit({ signal, sym, zone, digits, planStopDist, minDist, knobs, from: edge });
  const detail = { plan_entry: from, edge, away_r_plan: round3(awayPlan / planStopDist), away_r_edge: round3(awayEdge / planStopDist) };
  return r.ok ? { ...r, from, edge: true, entry_basis: "zone_edge", edge_detail: detail } : { ...r, from, edge_detail: detail };
}

/**
 * Pure: a limit inside the entry zone where the plan's own level cannot rest (through price, or within the stop level):
 * the level nearest the plan's inside the zone that is at least max(the stop level, 1 spread) from price on the
 * correct side (above the bid for a SELL, below the ask for a BUY). The stop and the target stay the plan's (broker
 * scale); the moved limit keeps at least ZONE_MIN_RISK_SHARE of the plan's risk (zone_tight) and must still pay
 * ZONE_MIN_RR to the target, with both at least the stop level away (zone_rr).
 * The whole zone passed (no such level inside it): zone_passed, a missed entry as limit_through_price is.
 */
export function zoneLimit({ signal, sym = {}, zone, digits = 2, planStopDist, minDist = 0, knobs, from }) {
  const buy = signal.side === "BUY";
  const step = Math.pow(10, -digits);
  const spreadPx = positive(sym.spread_points) && positive(sym.point) ? sym.spread_points * sym.point : finite(sym.ask) && finite(sym.bid) ? Math.max(0, sym.ask - sym.bid) : 0;
  const gap = Math.max(minDist, spreadPx, step);
  // Rounded away from price, so the gap holds after rounding.
  const scale = Math.pow(10, digits);
  const at = buy ? Math.min(from, Math.floor((sym.ask - gap) * scale + 1e-6) / scale) : Math.max(from, Math.ceil((sym.bid + gap) * scale - 1e-6) / scale);
  const price = roundTo(at, digits);
  const away = roundTo(buy ? sym.ask - price : price - sym.bid, digits + 2);
  const awayR = planStopDist > 0 ? round3(away / planStopDist) : null;
  const out = { price, away, away_r: awayR, knobs, zone, from };
  if (!finite(price) || (buy ? price < zone.low - step / 2 : price > zone.high + step / 2)) return { ok: false, code: "zone_passed", detail: `the entry zone ${zone.low}-${zone.high} is passed`, ...out };
  const sl = roundTo(Number(signal.stop) + signal.feed_basis, digits), tp = roundTo(Number(signal.tp1) + signal.feed_basis, digits);
  const risk = buy ? price - sl : sl - price, reward = buy ? tp - price : price - tp;
  // A move inside the zone never cuts the plan's risk below half (a stop that tight is hit far more often): zone_tight.
  const floor = Math.max(minDist, ZONE_MIN_RISK_SHARE * planStopDist);
  if (!(risk >= floor - 1e-9)) return { ok: false, code: "zone_tight", detail: `a limit at ${price} leaves ${round3(risk)} of risk to the plan's stop, under ${round3(floor)} (${ZONE_MIN_RISK_SHARE} x the plan's ${round3(planStopDist)})`, ...out };
  if (!(risk > minDist) || !(reward > minDist) || !(reward / risk >= ZONE_MIN_RR - 1e-9)) return { ok: false, code: "zone_rr", detail: `a limit at ${price} pays ${risk > 0 ? round3(reward / risk) : "no"} R to the target, under ${ZONE_MIN_RR}`, ...out };
  return { ok: true, moved: true, sl, tp, rr: round3(reward / risk), ...out };
}

/**
 * Pure: whether the signal's level can rest at the broker as a limit now (RFC §3), before any council is asked:
 * { ok: true, price, away, away_r, knobs } or { ok: false, code }. The limit is the decision's level on the broker's
 * scale (signal.entry + feed_basis); a buy limit waits below the ask, a sell limit above the bid, at most
 * placement_band x the plan's stop distance away, and at least the broker's stop level. Never on a netting account
 * (the fill's position ticket must be the order's).
 */
export function limitPlacement({ signal, sym = {}, account = {}, planStopDist, minDist = 0, changes = null }) {
  const buy = signal?.side === "BUY";
  if (account?.margin_mode !== "hedging") return { ok: false, code: "netting_account", detail: `margin mode ${account?.margin_mode ?? "unknown"}` };
  if (signal?.feed_basis_known !== true || !finite(signal?.feed_basis)) return { ok: false, code: "basis_unknown" };
  const digits = Number.isInteger(sym.digits) ? sym.digits : 2;
  const price = roundTo(Number(signal.entry) + signal.feed_basis, digits);
  const knobs = limitKnobs(signal.trading_mode, null, { changes });
  const away = roundTo(buy ? sym.ask - price : price - sym.bid, digits + 2);
  const awayR = planStopDist > 0 ? round3(away / planStopDist) : null;
  const out = { price, away, away_r: awayR, knobs };
  // EZ1: where the plan's level is through price or within the stop level, its entry zone may still hold a limit.
  const zone = signalEntryZone(signal, digits);
  if (zone && (!(away > 0) || (minDist > 0 && away < minDist))) return zoneLimit({ signal, sym, zone, digits, planStopDist, minDist, knobs, from: price });
  if (!(away > 0)) return { ok: false, code: "limit_through_price", ...out };
  if (minDist > 0 && away < minDist) return { ok: false, code: "limit_stops_level", ...out };
  if (away > knobs.placement_band * planStopDist + 1e-9) {
    // EZ1b: with the signal's "edge" switch, the zone's near edge (a BUY's top, a SELL's bottom) rests the limit when it
    // is inside the band (the plan's own level is not); the plan's stop and target kept, the zone's guards as EZ1's.
    if (zone && signal.entry_zone_edge === true) {
      const edge = zoneEdgeLimit({ signal, sym, zone, digits, planStopDist, minDist, knobs, from: price });
      if (edge) return edge;
    }
    return { ok: false, code: "limit_out_of_band", detail: `${awayR} x the stop from price, the band is ${knobs.placement_band}`, ...out };
  }
  return { ok: true, ...out };
}

/**
 * Pure: the council's stored actions on Omega's pending limits (src/limit-council.mjs), checked again against the live
 * price, as intents (ADR-0020 Amendment 7):
 *   cancel   delete_order with the action's reason;
 *   move     modify_order to the level the council named, only toward price, by at most the action's max_move
 *            (move_max_atr x ATR(14) of the 15m bars), the stop and the target shifted by the same amount (the order's
 *            distances never change), the lot untouched (a modify_order cannot change it), the broker's stop level kept;
 *   convert  ("council" only) the order's delete first (`del:<ticket>:cv`); the market leg follows only once the
 *            terminal has answered it (planIntents' `conversion`).
 * `actions` are { id, ticket, action, rule, price, max_move }. One intent per action; `dropped` says why one became none.
 */
export function limitActionIntents({ orders = [], sym = {}, actions = [], entryOrder = "limit", meta = {} } = {}) {
  const out = [], used = [], dropped = [], removed = [];
  const drop = (a, reason) => dropped.push({ id: a.id, reason });
  const digits = Number.isInteger(sym.digits) ? sym.digits : 2;
  const point = positive(sym.point) ? sym.point : Math.pow(10, -digits);
  const minDist = (finite(sym.stops_level_points) ? sym.stops_level_points : 0) * point;
  for (const a of actions) {
    const o = orders.find((x) => Number(x.ticket) === Number(a.ticket));
    if (!o) { drop(a, "the order is no longer pending"); continue; }
    if (removed.includes(o.ticket)) { drop(a, "another action on this order comes first"); continue; }
    const buy = o.type === "BUY_LIMIT";
    const bar = String(a.id).split(":").pop();
    if (a.action === "cancel") {
      out.push({ ...deleteOrderIntent(o.ticket, a.rule || "council_cancel", 0), id: `del:${o.ticket}:c${bar}`.slice(0, INTENT_ID_MAX) });
      removed.push(o.ticket);
    } else if (a.action === "convert") {
      if (entryOrder !== "council") { drop(a, "a conversion to market needs entry_order council"); continue; }
      const m = meta?.[o.ticket] ?? {};
      out.push({ id: `del:${o.ticket}:cv`.slice(0, INTENT_ID_MAX), kind: "delete_order", ticket: o.ticket, reason: "convert_to_market", side: buy ? "BUY" : "SELL", signal_issued_ms: finite(m.signal_issued_ms) ? m.signal_issued_ms : null });
      removed.push(o.ticket);
    } else if (a.action === "move" && finite(a.price) && finite(a.max_move)) {
      if (!finite(sym.bid) || !finite(sym.ask)) { drop(a, "no live price from the terminal"); continue; }
      const from = Number(o.price_open), to = roundTo(a.price, digits), delta = roundTo(to - from, digits);
      const toward = buy ? delta > 0 : delta < 0;
      const gap = buy ? sym.ask - to : to - sym.bid;
      if (!toward) { drop(a, `a move to ${to} is not toward price (the order rests at ${from})`); continue; }
      if (Math.abs(delta) > a.max_move + point / 2) { drop(a, `a move of ${Math.abs(delta)} is more than ${roundTo(a.max_move, digits)} (move_max_atr x ATR)`); continue; }
      if (!(gap > 0) || gap < minDist) { drop(a, `the live price leaves no room for a limit at ${to}`); continue; }
      // EZ1: an order placed with an entry zone is never moved out of it.
      const z = meta?.[o.ticket]?.entry_zone;
      if (z && finite(z.low) && finite(z.high) && (to < z.low - point / 2 || to > z.high + point / 2)) { drop(a, `a move to ${to} leaves the entry zone ${z.low}-${z.high}`); continue; }
      if (!(Number(o.sl) > 0)) { drop(a, "the order has no stop"); continue; }
      const sl = roundTo(Number(o.sl) + delta, digits), tp = Number(o.tp) > 0 ? roundTo(Number(o.tp) + delta, digits) : 0;
      // The bridge's line has no price field: a modify_order carries the order's new price in the volume field (EA 1.18+).
      out.push({ id: `mo:${o.ticket}:${bar}`.slice(0, INTENT_ID_MAX), kind: "modify_order", ticket: o.ticket, volume: to, sl, tp, reason: `limit_move_${a.rule || "council"}`, from_price: from });
    } else { drop(a, "not an action Omega applies to a pending order"); continue; }
    used.push(a.id);
  }
  return { intents: out, used, dropped, removed };
}

/**
 * Pure: the hard guard a just-filled Omega limit breaches, or null (RFC §5, the deterministic backstop at fill): the
 * broker's tick value, the symbol's volume_min and volume_max, the profile's hard cap per trade and total open risk, and
 * the daily risk budget including this position's risk at its stop. `others` are the other positions, `pending` the
 * pending orders still resting, `limits` the profile's (effectiveLimits; Custom within CUSTOM_CAPS), `lossFloor` the day's floor.
 */
export function fillGuard({ position: p, others = [], pending = [], sym = {}, account = {}, limits = null, lossFloor = null, probation = false, riskScale = 0.5 }) {
  if (typeof sym.tick_value_problem === "string" && sym.tick_value_problem !== "") return "tick_value_mismatch";
  const vol = Number(p?.volume);
  if (!(vol > 0) || (positive(sym.volume_min) && vol < sym.volume_min - 1e-9)) return "volume_below_min";
  if (positive(sym.volume_max) && vol > sym.volume_max + 1e-9) return "volume_above_max";
  const sl = Number(p?.sl), open = Number(p?.open_price);
  const risk = sl > 0 && finite(open) && positive(sym.tick_size) && positive(sym.tick_value) ? (Math.abs(open - sl) / sym.tick_size) * sym.tick_value * vol : Infinity;
  const equity = Number(account?.equity);
  const pct = (money) => (equity > 0 ? roundTo((money / equity) * 100, 2) : Infinity);
  const cap = limits && finite(limits.hard_cap_pct) ? limits.hard_cap_pct * (probation ? riskScale : 1) : null;
  if (cap != null && !(pct(risk) <= cap + 1e-9)) return "hard_cap";
  const otherRisk = openRiskAtStops(others, sym);
  if (limits && finite(limits.open_risk_pct) && !(otherRisk + risk <= (equity * limits.open_risk_pct) / 100 + 1e-6)) return "open_risk_cap";
  if (finite(lossFloor) && !(equity - otherRisk - risk - pendingRiskAtStops(pending, sym) - lossFloor > 0)) return "daily_risk_budget";
  return null;
}

/** Pure: the planned price against the filled price, in R of the planned stop distance (positive: a worse fill). */
export function fillGapR({ side, planned, filled, rDist }) {
  if (!finite(planned) || !finite(filled) || !(rDist > 0)) return null;
  return round3(((side === "BUY" ? 1 : -1) * (filled - planned)) / rDist);
}

const CELL_GATE_REASONS = Object.freeze(["htf_against", "htf_unknown", "cell_collecting", "cell_below_bar", "probation_unconfirmed", "probation_reverted", "range_breakout", "range_mode_agent"]);

export function planIntents({ signal = null, control = null, settings = OMEGA_DEFAULTS, executor = null, now = Date.now(), engineEnabled = false, recentIntentIds = [], agents = {}, pmActions = [], account: accountSpec = null, eaGate = false, reentry = null, positionMeta = {}, candles = undefined, stops = {}, entryCouncil = null, limitActions = [], pendingMeta = {}, limitFills = [], conversion = null, pmLoosen = null, liquiditySpikeSince = null, gates: lockGateFacts = {}, reentry1m = null, supersede = [], modeRisk = null } = {}) {
  const intents = [], notes = [];
  // The Position Manager actions that became no intent, with the reason (said on Telegram by the sync).
  const pmDropped = [];
  const note = (code, detail) => notes.push(detail ? { code, detail } : { code });
  const S = { ...OMEGA_DEFAULTS, ...pickSettings(settings ?? {}) };
  // The liquidity lens off (the owner's switch): its fields on the signal are read as absent (no gate, deferral or level).
  if (S.liquidity_enabled === false && signal?.liquidity_on === true) signal = { ...signal, liquidity_on: false };
  // Account Profiles phase 2 (docs/RFC_ACCOUNT_PROFILES.md §3-4): new entries are sized within the account's profile.
  // Each limit is the smaller of the profile's cap and the setting; Custom keeps the settings within Aggressive's limits
  // (ADR-0020 Amendment 10, CUSTOM_CAPS).
  const profileLimits = typeof accountSpec?.profile === "string" ? effectiveLimits(accountSpec.profile, S) : null;
  if (profileLimits) {
    if (finite(profileLimits.risk_pct)) S.risk_pct = profileLimits.risk_pct;
    if (Number.isInteger(profileLimits.max_positions)) S.max_positions = profileLimits.max_positions;
    if (finite(profileLimits.max_daily_loss_pct)) S.max_daily_loss_pct = profileLimits.max_daily_loss_pct;
  }
  // Reversal probation (src/htf-cells.mjs, owner 2026-11-18): half the risk and half the hard cap per trade. Every other
  // check (the minimum lot against the cap, the open risk, the daily budget, the tick value) stays as it is.
  const probation = signal?.probation === true;
  const scale = probation && finite(signal?.risk_scale) && signal.risk_scale > 0 && signal.risk_scale < 1 ? signal.risk_scale : probation ? 0.5 : 1;
  // MS2, the mode probation (src/mode-selector.mjs, `modeRisk` from the sync): a signal decided in a mode the selector put
  // on probation sizes its new entries at the probation's scale of the risk (0.5). Only the risk per trade: the profile's
  // hard cap stays as it is (the minimum-lot rule is never above it), and an open position is never touched. With the
  // reversal probation as well, the smaller scale (they do not compound).
  const modeScale = finite(modeRisk?.scale) && modeRisk.scale > 0 && modeRisk.scale < 1 && typeof signal?.trading_mode === "string" && signal.trading_mode === modeRisk.mode ? modeRisk.scale : 1;
  const riskScale = Math.min(probation ? scale : 1, modeScale);
  if (riskScale < 1) S.risk_pct = roundTo(S.risk_pct * riskScale, 4);
  const limits = probation && profileLimits ? { ...profileLimits, hard_cap_pct: finite(profileLimits.hard_cap_pct) ? roundTo(profileLimits.hard_cap_pct * scale, 4) : profileLimits.hard_cap_pct } : profileLimits;
  // ADR-0020 Amendment 8: a position whose stop the council loosened (`pmLoosen.loosened`, from omega_intents) counts
  // as unprotected again (isProtected), whatever the switch says now. Without one the positions are the executor's.
  const loosenedRec = pmLoosen?.loosened && typeof pmLoosen.loosened === "object" ? pmLoosen.loosened : {};
  const positions0 = Array.isArray(executor?.positions) ? executor.positions : [];
  const positions = Object.keys(loosenedRec).length ? positions0.map((p) => (loosenedRec[String(p?.ticket)] ? { ...p, loosened: true } : p)) : positions0;
  const recent = new Set(recentIntentIds);
  // Limit entries (docs/RFC_OMEGA_LIMIT_ENTRY.md, stage 3): only with entry_order "limit" or "council". With "market"
  // nothing below changes and the result has its three fields only.
  const limitMode = LIMIT_ENTRY_AVAILABLE && (S.entry_order === "limit" || S.entry_order === "council");
  const extra = limitMode ? { entry_request: null, limit_used: [], limit_dropped: [], fill_checks: [] } : null;
  // Lens B (RFC §6; owner 2026-11-20, "Setuju"): while the live spread spikes, the planner's stop and target
  // modifications (the ladder, the Position Manager, A8) wait up to 10 minutes from the spike's start; closes, kill,
  // pause, the fill guard, the daily limit and every forced close are never deferred (they are not modifications).
  const liqSpike = signal?.liquidity_on === true && liveSpreadSpike(signal, executor?.symbol ?? {});
  const finish = () => {
    if (!liqSpike) return;
    const d = deferModifications(intents, { spike: true, spikeSinceMs: liquiditySpikeSince, now });
    if (!d.deferred.length) return;
    intents.splice(0, intents.length, ...d.intents);
    note("liquidity_modify_deferred", d.deferred.map((it) => it.id).join(",").slice(0, 200));
  };
  // SS1 (src/limit-supersede.mjs): the plan's superseded_by_signal note, which ends with what became of the new signal.
  let ssNote = null, ssSaid = false;
  const ssOutcome = () => {
    if (!ssNote || ssSaid) return;
    ssSaid = true;
    const last = notes.at(-1);
    const entered = intents.some((it) => it.kind === "place_limit" || it.kind === "open");
    ssNote.detail = `${ssNote.detail}; the new signal: ${entered ? "entered" : last && last !== ssNote ? last.code : "no entry"}`;
  };
  const done = () => { ssOutcome(); finish(); return extra ? { intents, notes, pm_dropped: pmDropped, ...extra } : { intents, notes, pm_dropped: pmDropped }; };

  if (signal?.kill === true || control?.mode === "killed") {
    note("kill");
    if (positions.length || omegaPendingOrders(executor).length) intents.push({ id: closeAllId(killKey(signal, control)), kind: "close_all", reason: "kill" });
    return done();
  }
  if (!engineEnabled || S.enabled !== true) {
    note("engine_off");
    // Omega switched off leaves no pending order of its own at the broker (RFC §6).
    for (const o of omegaPendingOrders(executor)) if (!recent.has(deleteOrderIntent(o.ticket, "engine_off", now).id)) intents.push(deleteOrderIntent(o.ticket, "engine_off", now));
    return done();
  }
  if (!executor || executor.connected !== true || !finite(executor.received_ms) || now - executor.received_ms > EXECUTOR_MAX_AGE_MS) {
    note("executor_stale");
    return done();
  }

  // Omega's own pending limits (docs/RFC_OMEGA_LIMIT_ENTRY.md §6): deleted at once, without the council, when a hard
  // reason holds; the ones kept count as positions and as risk at their stops in every gate below.
  let pendingKept = omegaPendingOrders(executor);
  const noStop = pendingKept.filter(pendingWithoutStop);
  if (noStop.length) {
    note("pending_without_stop", noStop.map((o) => o.ticket).join(","));
    for (const o of noStop) { const d = deleteOrderIntent(o.ticket, "pending_without_stop", now); if (!recent.has(d.id)) intents.push(d); }
    pendingKept = pendingKept.filter((o) => !pendingWithoutStop(o));
  }
  if (pendingKept.length && !limitMode) {
    const acct = executor.account ?? {};
    const floor = positive(acct.day_start_balance) ? acct.day_start_balance * (1 - S.max_daily_loss_pct / 100) : null;
    const why = pendingDeleteReason({ settings: S, signal, control, executor, account: accountSpec, lossFloor: floor });
    if (why) {
      note("pending_deleted", why);
      for (const o of pendingKept) { const d = deleteOrderIntent(o.ticket, why, now); if (!recent.has(d.id)) intents.push(d); }
      pendingKept = [];
    }
  } else if (pendingKept.length) {
    // Stage 3: the same hard reasons, then the daily risk budget and each order's own (RFC §4, §6; ADR-0020 A7), with
    // the placing decision's quorum share and the knobs its place_limit intent recorded (`pendingMeta` by order ticket).
    const acct = executor.account ?? {}, sym0 = executor.symbol ?? {};
    const floor = positive(acct.day_start_balance) ? acct.day_start_balance * (1 - S.max_daily_loss_pct / 100) : null;
    const dayBudget = finite(acct.equity) && floor != null ? acct.equity - openRiskAtStops(positions, sym0) - pendingRiskAtStops(pendingKept, sym0) - floor : null;
    const kept = [];
    for (const o of pendingKept) {
      const why = pendingDeleteReason({ settings: S, signal, control, executor, account: accountSpec, lossFloor: floor, budget: dayBudget, order: o, meta: pendingMeta?.[o.ticket] ?? null, now });
      if (!why) { kept.push(o); continue; }
      note("pending_deleted", why);
      const d = deleteOrderIntent(o.ticket, why, now);
      if (!recent.has(d.id)) intents.push(d);
    }
    pendingKept = kept;
  }
  // SS1 (owner 2026-11-23, src/limit-supersede.mjs; limit_supersede "on"): a resting limit of an OLDER signal on the
  // current signal's side is deleted (superseded_by_signal) and holds nothing of the new signal back (same side, max
  // positions, the platform cap, the budget); the new signal goes through every gate below and enters only once the
  // delete is done (superseded_delete_waiting). Open positions, the other side and the same signal's limit: as today.
  // The superseded order's risk still counts where a stop or a fill is checked (A8's budget, the fill guard) until gone.
  const ss1 = limitMode && limitSupersedeOn(S);
  let superseded = [];
  if (ss1 && pendingKept.length) {
    superseded = supersededOrders({ orders: pendingKept, pendingMeta, signal });
    for (const o of superseded) {
      const d = { ...deleteOrderIntent(o.ticket, SUPERSEDE_REASON, now), side: o.type === "BUY_LIMIT" ? "BUY" : "SELL", signal_issued_ms: orderSignalMs(o, pendingMeta?.[o.ticket] ?? null), superseded_by: signal.issued_ms };
      if (!recent.has(d.id)) intents.push(d);
    }
    if (superseded.length) {
      ssNote = { code: SUPERSEDE_REASON, detail: superseded.map((o) => `#${o.ticket} (signal ${orderSignalMs(o, pendingMeta?.[o.ticket] ?? null)}) by signal ${signal.issued_ms}`).join(", ") };
      notes.push(ssNote);
    }
  }
  const isSuperseded = (o) => superseded.some((x) => Number(x.ticket) === Number(o?.ticket));
  if (limitMode && limitActions.length) {
    // The council's keep, move, cancel or convert at the 15m close (src/limit-council.mjs), checked again here.
    const la = limitActionIntents({ orders: superseded.length ? pendingKept.filter((o) => !isSuperseded(o)) : pendingKept, sym: executor.symbol ?? {}, actions: limitActions, entryOrder: S.entry_order, meta: pendingMeta });
    for (const it of la.intents) if (!recent.has(it.id)) intents.push(it);
    if (la.intents.length) note("limit_council", la.intents.map((it) => `${it.ticket}:${it.reason}`).join(","));
    pendingKept = pendingKept.filter((o) => !la.removed.includes(o.ticket));
    extra.limit_used.push(...la.used);
    // SS1: an action on a superseded order is dropped (the order goes as superseded_by_signal).
    const ssTickets = new Set(superseded.map((o) => Number(o.ticket)));
    extra.limit_dropped.push(...(ssTickets.size ? la.dropped.map((d) => (ssTickets.has(Number(limitActions.find((a) => a.id === d.id)?.ticket)) ? { ...d, reason: "the order is superseded by a newer signal (superseded_by_signal)" } : d)) : la.dropped));
  }
  // What the new signal's gates count as resting: every kept order but the superseded ones (SS1; off, every kept one).
  const pendingGate = superseded.length ? pendingKept.filter((o) => !isSuperseded(o)) : pendingKept;
  // SS1, delete first: no entry while a superseded order is still reported (its delete not done yet, or refused and
  // sent again) or a superseded_by_signal delete waits for the terminal's answer (`supersede`, from omega_intents).
  const ssWaiting = ss1 ? [...superseded.map((o) => Number(o.ticket)), ...(Array.isArray(supersede) ? supersede : []).filter((d) => d && d.deleted === null).map((d) => Number(d.ticket))] : [];
  const deleteFirst = () => {
    if (!ssWaiting.length) return false;
    note("superseded_delete_waiting", [...new Set(ssWaiting)].map((t) => `#${t}`).join(","));
    return true;
  };
  if (limitMode && limitFills.length) {
    // A limit that filled (its position's ticket is the order's, RFC §5): the hard guards once more, before anything else.
    const acct = executor.account ?? {}, sym0 = executor.symbol ?? {};
    const floor = positive(acct.day_start_balance) ? acct.day_start_balance * (1 - S.max_daily_loss_pct / 100) : null;
    for (const t of limitFills) {
      const p = positions.find((x) => Number(x?.ticket) === Number(t));
      if (!p) continue;
      const m = pendingMeta?.[t] ?? positionMeta?.[p.intent_id] ?? {};
      const guard = fillGuard({ position: p, others: positions.filter((x) => x !== p), pending: pendingKept, sym: sym0, account: acct, limits: profileLimits, lossFloor: floor, probation: m.probation === true, riskScale: finite(m.risk_scale) ? m.risk_scale : 0.5 });
      extra.fill_checks.push({ ticket: p.ticket, guard });
      if (guard) {
        note("fill_guard", `${p.ticket}:${guard}`);
        intents.push({ id: `cl:${p.ticket}:fg`, kind: "close", ticket: p.ticket, reason: `fill_guard_${guard}` });
      }
    }
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
    // SS1: a superseded order's delete is not a reversal's close.
    if (intents.filter((it) => !(it.kind === "delete_order" && it.reason === SUPERSEDE_REASON)).length) {
      note("mean_reversal_exit");
      return done();
    }
  }

  for (const p of positions) {
    if (side && (p.side === "BUY" || p.side === "SELL") && p.side !== side && p.ticket != null && isOmegaOwned(p)) {
      intents.push({ id: closeId(p.ticket), kind: "close", ticket: p.ticket, reason: "opposite" });
    }
  }
  const account = executor.account ?? {}, sym = executor.symbol ?? {};
  // The strategy agents' exits and the confidence gate on extending (owner 2026-11-16).
  const exits = strategyExits({ positions, signal, sym, agents, now, skipTickets: intents.map((it) => it.ticket), changes: changeTokens(S) });
  if (exits.intents.length) note(exits.intents.some((it) => it.reason === "lean_flip") ? "lean_flip" : "confidence_drop");
  intents.push(...exits.intents);
  // The Position Manager's actions (owner 2026-11-17): after the strategy exits, before the routine management.
  // ADR-0020 Amendment 8, only with the owner's switch on: the context the council's loosening and target moves are
  // checked in again (the original entry stops, the loosenings already sent, the daily loss budget and the profile caps
  // at the new stop, the veto, the arm, the pause, the tick value and the money).
  const closingNow = new Set(intents.filter((it) => it.kind === "close").map((it) => it.ticket));
  const loosenedFrom = Object.fromEntries(Object.entries(loosenedRec).filter(([, r]) => finite(r?.from_sl)).map(([t, r]) => [t, r.from_sl]));
  let a8 = null;
  if (S.pm_loosen_enabled === true) {
    const acct = executor.account ?? {};
    const floor = positive(acct.day_start_balance) ? acct.day_start_balance * (1 - S.max_daily_loss_pct / 100) : null;
    const capLimits = profileLimits;
    const blocked = signal?.paused === true || control?.mode === "paused" ? "Omega is paused"
      : acct.trade_mode !== "demo" && S.live_armed !== true ? "a real account that is not armed live"
      : typeof sym.tick_value_problem === "string" && sym.tick_value_problem !== "" ? "the broker's tick value disagrees with the contract (tick_value_mismatch)"
      : typeof acct.money?.problem === "string" && acct.money.problem !== "" ? `the account's money is not verified (${acct.money.problem})` : null;
    const riskCheck = (p, sl) => {
      if (floor == null || !finite(acct.equity)) return "the daily loss budget cannot be read";
      const after = positions.filter((x) => !closingNow.has(x.ticket)).map((x) => (x.ticket === p.ticket ? { ...x, sl } : x));
      const open = openRiskAtStops(after, sym);
      const left = acct.equity - open - pendingRiskAtStops(pendingKept, sym) - floor;
      if (!(left > 0)) return `the daily loss budget would not hold at the new stop (${finite(left) ? roundTo(left, 2) : "unbounded risk"})`;
      if (capLimits && positive(acct.equity)) {
        const o = Number(p.open_price ?? p.entry), vol = Number(p.volume);
        const tradeRisk = positive(sym.tick_size) && positive(sym.tick_value) && finite(o) && vol > 0 ? (Math.max(0, (p.side === "BUY" ? 1 : -1) * (o - sl)) / sym.tick_size) * sym.tick_value * vol : Infinity;
        if (finite(capLimits.hard_cap_pct) && !(roundTo((tradeRisk / acct.equity) * 100, 2) <= capLimits.hard_cap_pct + 1e-9)) return `the profile's hard cap per trade (${capLimits.hard_cap_pct}%)`;
        if (finite(capLimits.open_risk_pct) && !(open <= (acct.equity * capLimits.open_risk_pct) / 100 + 1e-6)) return `the profile's total open risk (${capLimits.open_risk_pct}%)`;
      }
      return null;
    };
    a8 = { original: pmLoosen?.original ?? {}, loosened: loosenedRec, stops, blocked, riskCheck, veto: (p) => (p.side === "BUY" ? signal?.veto_long : signal?.veto_short) === true };
  }
  // SLG1 (owner 2026-11-23): the profit-lock gate's facts per ticket (`gates`, from the sync or v4), only while
  // profit_lock_gate is "on"; a position without facts reads as closed. "legacy": no gate, today's calls.
  const lockGates = profitLockGateOn(S) ? (lockGateFacts && typeof lockGateFacts === "object" ? lockGateFacts : {}) : undefined;
  const pm = positionManagerIntents({ positions, sym, actions: pmActions, skipTickets: [...closingNow], sltp: versionAtLeast(executor.executor?.version ?? null, "1.18"), ...(a8 ? { a8 } : {}), ...(Object.keys(loosenedFrom).length ? { loosenedFrom } : {}), ...(lockGates ? { gates: lockGates } : {}) });
  // ADR-0020 Amendment 4: under the TP ladder the Position Manager's outward take-profit (TP2) waits, like every
  // outward move, until the stop locks a profit at or beyond TP1. A target the council moves nearer (Amendment 8) is
  // not an outward move.
  if (S.tp_ladder) {
    const levels = brokerKeyLevels(signal);
    pm.intents = pm.intents.filter((it) => {
      if (it.kind !== "modify_tp") return true;
      const p = positions.find((x) => x.ticket === it.ticket);
      if (p && Number(p.tp) > 0 && (p.side === "BUY" ? it.tp < Number(p.tp) : it.tp > Number(p.tp))) return true;
      if (p && ladderTp1Locked({ position: p, levels, sym, signal })) return true;
      const [, t, , b] = String(it.id).split(":");
      pm.dropped.push({ id: `pm:${t}:${b}`, reason: "the TP ladder holds the target until the stop locks TP1 (ADR-0020 Amendment 4)" });
      return false;
    });
  }
  if (pm.intents.length) note("position_manager");
  intents.push(...pm.intents);
  pmDropped.push(...pm.dropped);

  // Position management runs on every sync, whatever the entry gates say (audit 2026-11-11, owner:
  // "perbaiki"): a blackout, the rollover quarantine, a pause, a wide spread or a full book only stop
  // NEW entries; the positions already open keep their break-even, extended target and scale-out.
  const managed = manageIntents({ positions, sym, settings: S, signal, side, recentIntentIds, skipTickets: intents.map((it) => it.ticket), now, extendOf: exits.extendOf, positionMeta, candles, stops, ...(Object.keys(loosenedFrom).length ? { loosenedFrom } : {}), ...(lockGates ? { gates: lockGates } : {}) });
  // ADR-0020 Amendment 8: in the sync that loosens a stop, no mechanical stop or target move for that position (the
  // ladder never re-tightens it from a stale snapshot, and a target further never comes with a looser stop).
  const loosenedNow = new Set(pm.intents.filter((it) => it.loosen === true).map((it) => it.ticket));
  intents.push(...(loosenedNow.size ? managed.filter((it) => !(loosenedNow.has(it.ticket) && ["modify_sl", "modify_sltp", "modify_tp"].includes(it.kind))) : managed));
  // With the switch on, each tightening records the ATR(14, 15m) it was made at: the reference of a later loosening.
  if (S.pm_loosen_enabled === true && positive(sym.atr_value)) for (const it of intents) if ((it.kind === "modify_sl" || it.kind === "modify_sltp") && it.loosen !== true) it.atr = sym.atr_value;

  if (!side) {
    // A range strategy held by the H4/D1 filter or its cell's evidence (src/htf-cells.mjs) says so on the page.
    if (CELL_GATE_REASONS.includes(signal?.awaiting_reason)) note(signal.awaiting_reason, cellGateText(signal));
    else note("no_side");
    return done();
  }

  const issued = signal.issued_ms;
  let id = openId(issued, side);
  // "council" (RFC §2): one limit->market conversion per signal. Its delete went first (`conversion`: { ticket, side,
  // signal_issued_ms, deleted: true | false | null while unanswered, filled }); the market leg is planned only once the
  // terminal answered the delete, never after a fill, under its own id (the order's signal's open id plus ":m"), sized
  // afresh at its own price through every gate below.
  let leg = null;
  if (limitMode && S.entry_order === "council" && conversion && conversion.side === side && finite(conversion.signal_issued_ms)) {
    const legId = `${openId(conversion.signal_issued_ms, side)}:m`;
    if (!recent.has(legId) && !positions.some((p) => p.intent_id === legId)) {
      if (conversion.filled === true) note("conversion_ended_fill", String(conversion.ticket ?? ""));
      else if (conversion.deleted === false) note("conversion_cancel_failed", String(conversion.ticket ?? ""));
      else leg = { ...conversion, id: legId };
    }
  }
  if (leg?.deleted === true) id = leg.id;
  // RE1 (owner 2026-11-23, src/reentry-1m.mjs): a re-entry trigger of the sync's 1m step (`reentry1m`) on this side is an
  // open of its own (id re:<ticket>:<minute>) through every gate below, taken only while the signal's own entry cannot
  // be (already opened, expired or too old): the latest decision's fresh entry goes first. "off": never.
  const decided0 = finite(signal.decided_ms) ? signal.decided_ms : issued;
  const re1 = reentry1m && reentryOn(S) && !leg && reentry1m.side === side && isReentryId(reentry1m.id) && positive(reentry1m.sl) && positive(reentry1m.tp)
    && (recent.has(id) || positions.some((p) => p.intent_id === id) || now >= signal.expires_ms || now - decided0 > S.max_signal_age_ms) ? reentry1m : null;
  if (re1) id = re1.id;
  const sameSide = [...positions, ...pendingGate.map(pendingAsPosition)].filter((p) => p.side === side);
  const decided = finite(signal.decided_ms) ? signal.decided_ms : issued;
  const closing = intents.filter((it) => it.kind === "close").length;
  const armLive = signal.arm_mode === "armed" || signal.arm_mode === "auto";
  const tradeAgent = typeof signal.trade_agent === "string" && signal.trade_agent ? signal.trade_agent : null;
  const posAgent = (p) => (typeof agents?.[p.intent_id] === "string" && agents[p.intent_id]) || DEFAULT_POSITION_AGENT;
  const gates = [
    // Gold priced in USD on any broker, whatever its name (owner 2026-11-19, universal): a symbol not priced in USD,
    // with an odd contract size or refused by the EA itself opens nothing. Open positions keep their management above.
    [!goldCheckOf(executor).ok, "symbol_unverified"],
    // Every symbol must price as gold: its bid within 2% of the signal's reference entry, else nothing opens. This is
    // what tells gold in USD from silver, gold in euro or in grams: a name never decides.
    [goldPriceProblem(sym, signal.entry) !== null, "symbol_price_mismatch"],
    // The account's units per US dollar must be known and agree with its own trades (src/gold-symbol.mjs
    // accountMoney): without them a lot's dollar risk cannot be trusted (the 2026-11-18 lot x100 incident).
    [typeof executor?.account?.money?.problem === "string" && executor.account.money.problem !== "", executor?.account?.money?.problem === "money_mismatch" ? "money_mismatch" : "money_unverified"],
    // One probation position at a time (src/htf-cells.mjs): a second waits until the first is closed.
    [probation && positions.some((p) => positionMeta?.[p.intent_id]?.probation === true), "probation_busy"],
    // A probation trade never hedges: no entry while any position (Omega's or not) is open on the other side.
    [probation && positions.some((p) => (p.side === "BUY" || p.side === "SELL") && p.side !== side), "probation_hedge"],
    // The broker's tick value disagrees with the contract (neither contract × tick size dollars nor that in cents):
    // the loss at the stop cannot be trusted, so nothing opens (src/omega-broker.mjs usdTickValue, 2026-11-18).
    [typeof sym.tick_value_problem === "string" && sym.tick_value_problem !== "", "tick_value_mismatch"],
    // Account Profiles phase 1 (docs/RFC_ACCOUNT_PROFILES.md §1-2, owner 2026-11-18): a new or changed broker spec opens
    // nothing until it validates (src/account-spec.mjs); with OMEGA_EA_VERSION_GATE "on", an EA older than 1.15 (no
    // margin, stops or freeze check of its own) opens nothing either. Open positions keep their management above.
    [accountSpec != null && accountSpec.spec_status !== "validated", "spec_unvalidated"],
    // The profile council (src/profile-council.mjs, OMEGA_PROFILE_COUNCIL_DOWNGRADE "on"): a soft downgrade waiting
    // for its review opens nothing until the council decides (at most PENDING_DOWNGRADE_MAX_MS).
    [accountSpec?.review_pending === true, "profile_review_pending"],
    [eaGate === true && !versionAtLeast(executor.executor?.version ?? null, EXECUTOR_ENTRY_MIN_VERSION), "ea_outdated"],
    [!finite(issued) || !finite(signal.expires_ms), "bad_signal"],
    [!re1 && now >= signal.expires_ms, "expired"],
    [!re1 && now - decided > S.max_signal_age_ms, "signal_too_old"],
    [signal.blackout === true, "blackout"],
    [signal.paused === true || control?.mode === "paused", "paused"],
    [account.trade_mode !== "demo" && S.live_armed !== true, "live_not_armed"],
    [recent.has(id) || positions.some((p) => p.intent_id === id), "already_opened"],
    [positions.length - closing + pendingGate.length >= S.max_positions || sameSide.length >= S.max_positions, "max_positions"],
    // RE1: a re-entry also counts against the platform's cap of open positions and pending orders (ADR-0020 A7).
    [re1 != null && positions.length - closing + pendingGate.length >= PLATFORM_MAX_OPEN, "platform_cap"],
    [!finite(sym.spread_points) || sym.spread_points > S.max_spread_points, "spread"],
    // Lens B (RFC §5.1): no new entry while the live spread is at or above the mode's spread_widen times the hour of
    // the week's median bar spread; the absolute gate above stays. It also holds a limit's placement.
    [signal?.liquidity_on === true && liveSpreadSpike(signal, sym), "liquidity_spread_spike"],
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
  for (const [blocked, code] of gates) if (blocked) { note(code); return done(); }
  const re = reentryGate({ side, reentry, settings: S, now });
  if (re) { note(re.code, re.detail); return done(); }
  if (limitMode) {
    // Stage 3's own gates, after every gate of today (RFC §6): one pending Omega order at a time (any still reported,
    // a delete included), the platform's cap of 3 open positions and pending orders per account (ADR-0020 A7), and
    // OmegaExecutor 1.21 on the terminal.
    // SS1: a superseded order is not "another" pending order (deleteFirst holds the entry until it is gone).
    if (omegaPendingOrders(executor).filter((o) => !isSuperseded(o)).length) { note("pending_order_exists"); return done(); }
    if (positions.length - closing + pendingGate.length >= PLATFORM_MAX_OPEN) { note("platform_cap"); return done(); }
    if (!versionAtLeast(executor.executor?.version ?? null, LIMIT_EA_MIN_VERSION)) { note("ea_1_21_required"); return done(); }
    if (leg && leg.deleted !== true) { note("conversion_waiting_cancel", String(leg.ticket ?? "")); return done(); }
  }

  const needed = [account.equity, account.day_start_balance, signal.entry, signal.stop, signal.tp1, sym.bid, sym.ask, sym.point, sym.tick_size, sym.tick_value, sym.volume_step, sym.volume_min, sym.volume_max];
  if (!needed.every(positive) || !Number.isInteger(sym.digits)) { note("bad_input"); return done(); }
  const lossFloor = account.day_start_balance * (1 - S.max_daily_loss_pct / 100);
  if (account.equity <= lossFloor) { note("daily_loss_limit"); return done(); }
  // Daily risk budget (owner 2026-11-12): what the day can still lose is the equity above the daily
  // loss floor less what the open positions would lose at their stops; a new entry risks at most that.
  const budget = account.equity - openRiskAtStops(positions.filter((p) => !intents.some((it) => it.kind === "close" && it.ticket === p.ticket)), sym) - pendingRiskAtStops(pendingGate, sym) - lossFloor;
  if (!(budget > 0)) { note("daily_risk_budget"); return done(); }

  const buy = side === "BUY";
  const planOk = buy ? signal.stop < signal.entry && signal.entry < signal.tp1 : signal.tp1 < signal.entry && signal.entry < signal.stop;
  if (!planOk) { note("plan_wrong_side"); return done(); }
  const planStopDist = Math.abs(signal.entry - signal.stop);
  let stopDist = planStopDist, tpDist = Math.abs(signal.tp1 - signal.entry);
  const minDist = (finite(sym.stops_level_points) ? sym.stops_level_points : 0) * sym.point;
  if (stopDist <= minDist || tpDist <= minDist) { note("stops_level"); return done(); }

  // Limit entries (RFC §2-§3): which entry this signal gets. "limit": a resting limit, only on the entry council's
  // "place"; "council": the council's measured choice (enter_market, place_limit or skip), today's market path when it
  // is silent. The deterministic refusals of a limit come first, so no council is asked for an order that cannot rest.
  let route = "market", lim = null;
  if (limitMode && !leg && !re1) {
    lim = limitPlacement({ signal, sym, account, planStopDist, minDist, changes: changeTokens(S) });
    const council = entryCouncil && entryCouncil.id === id ? entryCouncil : null;
    const request = () => {
      // The sync files this for the entry council (src/limit-council.mjs, the 5-minute ledger step); planIntents never
      // calls a model. Prices stay inside the system: the request goes to D1 and the model, never to Aether.
      extra.entry_request = { id, side, entry_order: S.entry_order, issued_ms: issued, decided_ms: decided, action: signal.action, mode: signal.trading_mode || null, agent: tradeAgent,
        plan: { entry: signal.entry, stop: signal.stop, tp1: signal.tp1, stop_dist: roundTo(planStopDist, sym.digits) }, market: { bid: sym.bid, ask: sym.ask },
        limit: lim.ok ? { price: lim.price, away_r: lim.away_r, band: lim.knobs.placement_band, life_min: lim.knobs.max_pending_life } : { refused: lim.code, away_r: lim.away_r ?? null },
        // Lens B (docs/RFC_POSITIONING_LIQUIDITY.md §5.3), only while it is on: thin liquidity and the sweep on this side.
        ...(signal.liquidity_on === true ? { liquidity: { weight: signal.liquidity_weight, thin: signal.liquidity_thin === true, sweep: signal.liquidity_sweep === (side === "BUY" ? "sell_side" : "buy_side") ? "with" : signal.liquidity_sweep ? "against" : null } } : {}) };
      note("entry_council_waiting", S.entry_order);
      return done();
    };
    if (S.entry_order === "limit") {
      // A missed limit is a missed trade: no market fallback.
      if (!lim.ok) { note(lim.code, lim.detail); return done(); }
      if (!council) return request();
      if (council.status !== "answered") { note("council_unavailable", council.rule ?? null); return done(); }
      if (council.choice !== "place_limit") { note("council_skip", council.reason ?? null); return done(); }
      route = "limit";
    } else if (!council && now - decided < ENTRY_COUNCIL_WAIT_MS) {
      return request();
    } else if (!council || council.status !== "answered") {
      // A silent council (no answer in time, a model failure, the daily cap) is today's market path, never a skip or a limit.
      note("council_unavailable", council?.rule ?? "no_answer");
    } else if (council.choice === "skip") {
      note("council_skip", council.reason ?? null); return done();
    } else if (council.choice === "place_limit") {
      if (!lim.ok) { note(lim.code, lim.detail); return done(); }
      route = "limit";
    } else note("council_enter_market", council.rule ?? null);
  } else if (leg) {
    // EZ1: the market leg of a conversion enters only while price has not passed the signal's entry zone.
    const zone = signalEntryZone(signal, sym.digits);
    if (zone && (buy ? sym.ask < zone.low : sym.bid > zone.high)) { note("zone_passed", `the entry zone ${zone.low}-${zone.high} is passed`); return done(); }
    note("conversion_market_leg", String(leg.ticket ?? ""));
  }

  // 5m execution (docs/RFC_OMEGA_5M_EXECUTION.md, owner 2026-11-12): a market entry's stop moves to the
  // broker's 5m structure (the swing of the last 3 broker 5m bars beyond a buffer of 2 spreads or 0.1
  // 5m ATR), never wider than the plan's and never closer than 0.5 5m ATR (or the stop level plus 3
  // spreads). The target stays the plan's, so the RRR rises; the lot is capped below.
  let tight = false;
  if (!re1 && route === "market" && signal.action !== "ENTER_LIMIT" && signal.m5_source === "broker" && positive(signal.m5_atr) && positive(buy ? signal.m5_swing_low : signal.m5_swing_high)) {
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
  if (!tight && !re1 && S.adaptive_volatility !== false && positive(sym.atr_value)) {
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

  // The sizing of an entry at `price` with its stop `sl` (today's formula and every hard guard), or null with its note.
  const pctOf = (money) => roundTo((money / account.equity) * 100, 2);
  const label = limits ? (PROFILES[limits.profile]?.label ?? limits.profile) : null;
  const sizeEntry = (price, sl, { zoneMoved = false, maxRisk = null } = {}) => {
    const lossPerLot = (Math.abs(price - sl) / sym.tick_size) * sym.tick_value;
    let volume = floorToStep((account.equity * S.risk_pct / 100) / lossPerLot, sym.volume_step);
    if (tight || zoneMoved) {
      // The money at risk stays within risk_pct; the lot is capped at tight_stop_max_lot_factor x the lot at the plan's stop
      // (a 5m stop, or EZ1's limit moved inside the entry zone toward the plan's stop).
      const planVolume = (account.equity * S.risk_pct / 100) / ((planStopDist / sym.tick_size) * sym.tick_value);
      const cap = floorToStep(planVolume * (finite(S.tight_stop_max_lot_factor) ? S.tight_stop_max_lot_factor : 1.5), sym.volume_step);
      if (volume > cap) { volume = cap; note(zoneMoved ? "lot_capped_zone" : "lot_capped_5m"); }
    }
    if (volume > sym.volume_max) volume = floorToStep(sym.volume_max, sym.volume_step);
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
        return null;
      }
    }
    // The profile's total open risk (RFC §4): what the open positions lose at their stops plus this entry's risk.
    if (limits && finite(limits.open_risk_pct)) {
      const openRisk = openRiskAtStops(positions.filter((p) => !intents.some((it) => it.kind === "close" && it.ticket === p.ticket)), sym);
      const room = (account.equity * limits.open_risk_pct) / 100 - openRisk;
      const roomVolume = room > 0 ? floorToStep(room / lossPerLot, sym.volume_step) : 0;
      if (!(roomVolume >= sym.volume_min)) {
        note("open_risk_cap", `open positions risk ${pctOf(openRisk)}% at their stops; the ${label} total open risk is ${limits.open_risk_pct}%`);
        return null;
      }
      if (volume > roomVolume) { volume = roomVolume; note("lot_capped_open_risk"); }
    }
    const budgetVolume = floorToStep(budget / lossPerLot, sym.volume_step);
    if (budgetVolume < sym.volume_min) { note("daily_risk_budget"); return null; }
    if (volume > budgetVolume) { volume = budgetVolume; note("lot_capped_daily_budget"); }
    // RE1: a re-entry risks at most the original trade's money risk (less the original's loss: 1.0R over the setup).
    if (finite(maxRisk)) {
      const capVolume = maxRisk > 0 ? floorToStep(maxRisk / lossPerLot, sym.volume_step) : 0;
      if (!(capVolume >= sym.volume_min)) { note("reentry_risk_cap", `the minimum lot ${sym.volume_min} risks ${roundTo(lossPerLot * sym.volume_min, 2)}, over the setup's ${roundTo(maxRisk, 2)}`); return null; }
      if (volume > capVolume) { volume = capVolume; note("lot_capped_reentry"); }
    }
    return { volume, lossPerLot };
  };
  // What every entry records: its strategy agent, the grid, the volatility regime, the mode, R and probation.
  const decorate = (it, price, sl, volume, lossPerLot) => {
    // The strategy agent whose plan this is (owner 2026-11-16): its confidence governs the position's exit.
    if (typeof signal.trade_agent === "string" && signal.trade_agent) {
      it.strategy = signal.trade_agent;
      // Its confidence on the side at entry (the re-entry guard's "momentum recovered" reference).
      const c = parseConfidences(signal.agent_conf)[signal.trade_agent]?.[buy ? "long" : "short"];
      if (finite(c)) it.agent_conf = c;
    }
    // The grid's adapted entry and stop (src/grid-adapt.mjs, owner 2026-11-17): recorded on the intent; a 5m stop keeps its own source.
    if (typeof signal.grid_cell === "string" && signal.grid_cell) {
      it.grid_cell = signal.grid_cell;
      if (typeof signal.grid_slice === "string") it.grid_slice = signal.grid_slice;
      if (!tight) it.stop_source = `grid:${signal.grid_cell}`;
    }
    if (volRegime !== "NORMAL") it.vol_regime = volRegime;
    // The mode it opened in and its stop distance (the ladder's step per mode; a later mode switch never changes them).
    if (["scalp", "intraday", "swing", "range"].includes(signal.trading_mode)) it.mode = signal.trading_mode;
    if (finite(price) && finite(sl)) it.r_dist = roundTo(Math.abs(price - sl), sym.digits);
    // ADR-0020 Amendment 8 (switch on): the ATR(14, 15m) at entry, the reference of a later loosening.
    if (S.pm_loosen_enabled === true && positive(sym.atr_value)) it.atr_entry = sym.atr_value;
    // MS2: an entry sized under the mode probation is tagged with its scale.
    if (modeScale < 1) it.mode_probation = modeScale;
    // Reversal probation: tagged, with the money it risks at the stop (its trades' R for the revert check).
    if (probation) {
      it.probation = true;
      it.cell = `${signal.trade_agent}|${signal.side}|${signal.htf_context ?? "against"}`;
      it.risk_usd = roundTo(lossPerLot * volume, 2);
    }
    return it;
  };

  if (re1) {
    // RE1: at market, the trigger's stop (the pullback's extreme plus its buffer) and the original TP1, checked again at
    // the live price: the broker's stop distance, no wider than the original stop, at least 1R to TP1 (TP1-KZ).
    const price = buy ? sym.ask : sym.bid;
    const sl = roundTo(re1.sl, sym.digits), tp = roundTo(re1.tp, sym.digits);
    const sd = buy ? price - sl : sl - price, td = buy ? tp - price : price - tp;
    if (!(sd > minDist) || !(td > minDist)) { note("reentry_stops_level", `stop ${sl}, target ${tp} at ${price}`); return done(); }
    if (positive(re1.max_stop_dist) && sd > re1.max_stop_dist + sym.point / 2) { note("reentry_stop_wide", `the stop distance ${roundTo(sd, sym.digits)} at ${price} is wider than the original ${re1.max_stop_dist}`); return done(); }
    if (!(td + 1e-9 >= REENTRY_1M.min_r * sd)) { note("reentry_reward", `TP1 ${tp} pays ${roundTo(td / sd, 2)}R at ${price}, under ${REENTRY_1M.min_r}R`); return done(); }
    const sized = sizeEntry(price, sl, { maxRisk: finite(re1.max_risk) ? re1.max_risk : 0 });
    if (!sized) return done();
    const { volume, lossPerLot } = sized;
    const it = decorate({ id, kind: "open", side, volume, entry: price, sl, tp, signal_issued_ms: finite(re1.issued_ms) ? re1.issued_ms : issued, reason: REENTRY_RULE, stop_source: "reentry_1m", trigger_source: "broker_m1" }, price, sl, volume, lossPerLot);
    // The setup's own: its strategy agent (its exits), its mode (the ladder's step), the ticket it re-enters and the lock.
    if (typeof re1.strategy === "string" && re1.strategy) {
      it.strategy = re1.strategy;
      const c = parseConfidences(signal.agent_conf)[re1.strategy]?.[buy ? "long" : "short"];
      if (finite(c)) it.agent_conf = c; else delete it.agent_conf;
    }
    if (["scalp", "intraday", "swing", "range"].includes(re1.mode)) it.mode = re1.mode;
    it.reentry_of = re1.ticket;
    it.reentry_lock = re1.lock;
    if (typeof re1.lock_rule === "string") it.reentry_rule = re1.lock_rule;
    if (deleteFirst()) return done();
    note("reentry_1m", `re-entering #${re1.ticket} ${side} at ${price}: stop ${sl}, TP1 ${tp}`);
    intents.push(it);
    return done();
  }

  if (route === "limit") {
    // The limit (RFC §3): the stop and the target keep their distances from the limit price (the adaptive stop above
    // included), sized as if filled there; it expires max_pending_life after placement (never GTC, the EA enforces it).
    const price = lim.price;
    // EZ1: a limit moved inside the entry zone keeps the plan's stop and target where the plan put them.
    const sl = lim.moved === true ? lim.sl : roundTo(buy ? price - stopDist : price + stopDist, sym.digits);
    const tp = lim.moved === true ? lim.tp : roundTo(buy ? price + tpDist : price - tpDist, sym.digits);
    const sized = sizeEntry(price, sl, { zoneMoved: lim.moved === true });
    if (!sized) return done();
    const { volume, lossPerLot } = sized;
    const expiryMs = now + lim.knobs.max_pending_life * 60_000;
    // OmegaExecutor 1.21: `volume` is "<lot>@<limit price>", `ticket` the expiry in UTC epoch seconds.
    const it = decorate({ id, kind: "place_limit", side, volume: `${volume}@${price}`, entry: price, sl, tp, ticket: Math.floor(expiryMs / 1000), signal_issued_ms: issued, reason: "signal", stop_source: "plan", trigger_source: typeof signal.trigger_source === "string" ? signal.trigger_source : null }, price, sl, volume, lossPerLot);
    // What the order's own cancels read at every later sync (RFC §4): the placing decision's quorum share on its side,
    // its close, the profile and the knobs, and the lot it may never exceed.
    const share0 = Number(buy ? signal.quorum_long_share : signal.quorum_short_share);
    Object.assign(it, { lot: volume, entry_order: S.entry_order, placed_ms: now, expiry_ms: expiryMs, share0: share0 >= 0 ? share0 : null,
      decision_ms: finite(signal.power_ms) && signal.power_ms > 0 ? signal.power_ms : issued, profile: typeof accountSpec?.profile === "string" ? accountSpec.profile : null,
      knobs: { max_pending_life: lim.knobs.max_pending_life, move_max_atr: lim.knobs.move_max_atr, cancel_share_drop: lim.knobs.cancel_share_drop, placement_band: lim.knobs.placement_band }, away_r: lim.away_r, basis: signal.feed_basis });
    // EZ1: the entry zone (broker scale) the order may never be moved out of, and where a zone move put it from.
    const zone = signalEntryZone(signal, sym.digits);
    if (zone) it.entry_zone = zone;
    if (lim.edge === true) { it.zone_from = lim.from; it.entry_basis = "zone_edge"; note("limit_zone_edge", JSON.stringify(lim.edge_detail)); }
    else if (lim.moved === true) { it.zone_from = lim.from; note("limit_in_zone", `${lim.from} -> ${price}`); }
    if (deleteFirst()) return done();
    intents.push(it);
    return done();
  }

  if (signal.action === "ENTER_LIMIT") {
    const priceAway = buy ? sym.ask > signal.entry + 0.35 * stopDist : sym.bid < signal.entry - 0.35 * stopDist;
    if (priceAway) { note("waiting_for_pullback"); return done(); }
    // Owner 2026-11-13 ("setuju"): price past the entry toward the plan's stop by more than 0.35 x the plan's
    // stop distance is not entered. The stop keeps its distance from the fill, so such an entry put the stop
    // well beyond the key level the plan stood on (a SELL at 3903.98 against a 3888.48 entry, its stop 14
    // past the plan's). It waits: price may come back inside the band before the signal expires.
    const pastEntry = buy ? sym.ask < signal.entry - 0.35 * planStopDist : sym.bid > signal.entry + 0.35 * planStopDist;
    if (pastEntry) { note("price_past_entry"); return done(); }
  }
  const breached = buy ? sym.bid <= signal.stop : sym.ask >= signal.stop;
  if (breached) { note("stop_breached"); return done(); }

  const price = buy ? sym.ask : sym.bid;
  const sl = roundTo(buy ? price - stopDist : price + stopDist, sym.digits);
  const tp = roundTo(buy ? price + tpDist : price - tpDist, sym.digits);
  const sized = sizeEntry(price, sl);
  if (!sized) return done();
  const { volume, lossPerLot } = sized;
  const openIntent = decorate({ id, kind: "open", side, volume, entry: price, sl, tp, signal_issued_ms: issued, reason: "signal", stop_source: tight ? "stop_5m" : "plan", trigger_source: typeof signal.trigger_source === "string" ? signal.trigger_source : null }, price, sl, volume, lossPerLot);
  // Under "council": how this market entry came (the council's choice, a silent council, or the conversion's leg).
  if (limitMode) {
    openIntent.entry_order = S.entry_order;
    if (leg) openIntent.converted_from = leg.ticket ?? null;
  }
  if (deleteFirst()) return done();
  intents.push(openIntent);
  return done();
}
