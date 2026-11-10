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
  trailing_stop_r: 0
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
    ?? num("trailing_stop_r", 0, 5);
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
 * @returns {{ intents: object[], notes: { code: string }[] }}
 */
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
  for (const p of positions) {
    if (side && (p.side === "BUY" || p.side === "SELL") && p.side !== side && p.ticket != null) {
      intents.push({ id: closeId(p.ticket), kind: "close", ticket: p.ticket, reason: "opposite" });
    }
  }
  if (!side) { note("no_side"); return { intents, notes }; }

  const account = executor.account ?? {}, sym = executor.symbol ?? {};
  const issued = signal.issued_ms, id = openId(issued, side);
  const sameSide = positions.filter((p) => p.side === side);
  const decided = finite(signal.decided_ms) ? signal.decided_ms : issued;
  const gates = [
    [!finite(issued) || !finite(signal.expires_ms), "bad_signal"],
    [now >= signal.expires_ms, "expired"],
    [now - decided > S.max_signal_age_ms, "signal_too_old"],
    [signal.blackout === true, "blackout"],
    [signal.paused === true || control?.mode === "paused", "paused"],
    [account.trade_mode !== "demo" && S.live_armed !== true, "live_not_armed"],
    [recent.has(id) || positions.some((p) => p.intent_id === id), "already_opened"],
    [positions.length - intents.length >= S.max_positions || sameSide.length >= S.max_positions, "max_positions"],
    [!finite(sym.spread_points) || sym.spread_points > S.max_spread_points, "spread"]
  ];
  for (const [blocked, code] of gates) if (blocked) { note(code); return { intents, notes }; }

  const needed = [account.equity, account.day_start_balance, signal.entry, signal.stop, signal.tp1, sym.bid, sym.ask, sym.point, sym.tick_size, sym.tick_value, sym.volume_step, sym.volume_min, sym.volume_max];
  if (!needed.every(positive) || !Number.isInteger(sym.digits)) { note("bad_input"); return { intents, notes }; }
  if (account.equity - account.day_start_balance <= -account.day_start_balance * S.max_daily_loss_pct / 100) { note("daily_loss_limit"); return { intents, notes }; }

  const buy = side === "BUY";
  const planOk = buy ? signal.stop < signal.entry && signal.entry < signal.tp1 : signal.tp1 < signal.entry && signal.entry < signal.stop;
  if (!planOk) { note("plan_wrong_side"); return { intents, notes }; }
  const stopDist = Math.abs(signal.entry - signal.stop), tpDist = Math.abs(signal.tp1 - signal.entry);
  const minDist = (finite(sym.stops_level_points) ? sym.stops_level_points : 0) * sym.point;
  if (stopDist <= minDist || tpDist <= minDist) { note("stops_level"); return { intents, notes }; }

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
  if (volume > sym.volume_max) volume = floorToStep(sym.volume_max, sym.volume_step);
  if (!positive(volume) || volume < sym.volume_min) { note("volume_below_min"); return { intents, notes }; }

  intents.push({ id, kind: "open", side, volume, sl, tp, signal_issued_ms: issued, reason: "signal" });
  return { intents, notes };
}
