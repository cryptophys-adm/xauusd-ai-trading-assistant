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
//             account only when live_armed, spread, max positions, the daily loss limit, one open per
//             signal; SL/TP keep the signal's distances from the broker's own price; the volume risks
//             risk_pct of equity at the stop.
// Intent ids are deterministic and at most 31 characters (they become the MT5 order comment).

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
  sor_mode: "auto_failover"
});
export const RISK_PCT_MAX = 2;
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
    ?? num("tight_stop_max_lot_factor", 1, 2);
  if (err) return { error: err };
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
/**
 * Pure: the management of the positions already open (audit 2026-11-11), on every sync whatever the
 * entry gates say. `skipTickets` are positions being closed in the same plan.
 *   break-even  with trailing_stop_r > 0: a position at trailing_stop_r R or more moves its stop to its
 *               open price (R from the open price and the stop before break-even);
 *   extended    a farther TP2 or extended target of the current signal moves the take-profit of the
 *               positions on the signal's side;
 *   scale-out   a position of 0.02 lots or more at 1.5R or its target banks half, once per position.
 */
export function manageIntents({ positions = [], sym = {}, settings = OMEGA_DEFAULTS, signal = null, side = null, recentIntentIds = [], skipTickets = [] } = {}) {
  const S = { ...OMEGA_DEFAULTS, ...pickSettings(settings ?? {}) };
  const out = [];
  if (!finite(sym.bid) || !finite(sym.ask)) return out;
  const digits = Number.isInteger(sym.digits) ? sym.digits : 2;
  const skip = new Set(skipTickets.filter((t) => t != null));
  const recent = new Set(recentIntentIds);
  const scaledBefore = (ticket) => [...recent].some((rid) => String(rid).startsWith(`ps:${ticket}:`));
  const targetExtTp = positive(signal?.extended_tp) ? signal.extended_tp : positive(signal?.tp2) ? signal.tp2 : null;
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
    if (S.trailing_stop_r > 0 && !atBreakEven && risk > 0 && r >= S.trailing_stop_r) {
      out.push({ id: `ms:${p.ticket}:be`, kind: "modify_sl", ticket: p.ticket, sl: roundTo(open, digits), tp: Number.isFinite(curTp) ? curTp : null, reason: "break_even" });
      movedSl = true;
    }
    if (!movedSl && m5 && finite(m5.m5_atr) && (protectedPos || r >= 1)) {
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

    if (targetExtTp != null && p.side === side && Number.isFinite(curTp) && (buy ? targetExtTp > curTp + 0.1 : targetExtTp < curTp - 0.1)) {
      out.push({ id: `mt:${p.ticket}:${Math.round(targetExtTp * 100)}`, kind: "modify_tp", ticket: p.ticket, tp: roundTo(targetExtTp, digits), reason: "extended_tp" });
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

export function planIntents({ signal = null, control = null, settings = OMEGA_DEFAULTS, executor = null, now = Date.now(), engineEnabled = false, recentIntentIds = [] } = {}) {
  const intents = [], notes = [];
  const note = (code) => notes.push({ code });
  const S = { ...OMEGA_DEFAULTS, ...pickSettings(settings ?? {}) };
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

  // Position management runs on every sync, whatever the entry gates say (audit 2026-11-11, owner:
  // "perbaiki"): a blackout, the rollover quarantine, a pause, a wide spread or a full book only stop
  // NEW entries; the positions already open keep their break-even, extended target and scale-out.
  intents.push(...manageIntents({ positions, sym, settings: S, signal, side, recentIntentIds, skipTickets: intents.map((it) => it.ticket) }));

  if (!side) { note("no_side"); return { intents, notes }; }

  const issued = signal.issued_ms, id = openId(issued, side);
  const sameSide = positions.filter((p) => p.side === side);
  const decided = finite(signal.decided_ms) ? signal.decided_ms : issued;
  const closing = intents.filter((it) => it.kind === "close").length;
  const gates = [
    [!finite(issued) || !finite(signal.expires_ms), "bad_signal"],
    [now >= signal.expires_ms, "expired"],
    [now - decided > S.max_signal_age_ms, "signal_too_old"],
    [signal.blackout === true, "blackout"],
    [signal.paused === true || control?.mode === "paused", "paused"],
    [account.trade_mode !== "demo" && S.live_armed !== true, "live_not_armed"],
    [recent.has(id) || positions.some((p) => p.intent_id === id), "already_opened"],
    [positions.length - closing >= S.max_positions || sameSide.length >= S.max_positions, "max_positions"],
    [!finite(sym.spread_points) || sym.spread_points > S.max_spread_points, "spread"],
    [isRolloverQuarantine(now), "rollover_quarantine"]
  ];
  for (const [blocked, code] of gates) if (blocked) { note(code); return { intents, notes }; }

  const needed = [account.equity, account.day_start_balance, signal.entry, signal.stop, signal.tp1, sym.bid, sym.ask, sym.point, sym.tick_size, sym.tick_value, sym.volume_step, sym.volume_min, sym.volume_max];
  if (!needed.every(positive) || !Number.isInteger(sym.digits)) { note("bad_input"); return { intents, notes }; }
  if (account.equity - account.day_start_balance <= -account.day_start_balance * S.max_daily_loss_pct / 100) { note("daily_loss_limit"); return { intents, notes }; }

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
      tpDist = roundTo(tpDist * stopDist / planStopDist, sym.digits);
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
  if (!positive(volume) || volume < sym.volume_min) { note("volume_below_min"); return { intents, notes }; }

  const openIntent = { id, kind: "open", side, volume, entry: price, sl, tp, signal_issued_ms: issued, reason: "signal", stop_source: tight ? "stop_5m" : "plan", trigger_source: typeof signal.trigger_source === "string" ? signal.trigger_source : null };
  if (volRegime !== "NORMAL") openIntent.vol_regime = volRegime;
  intents.push(openIntent);
  return { intents, notes };
}
