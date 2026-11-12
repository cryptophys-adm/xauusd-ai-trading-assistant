// The signal for the owner's MetaTrader 5 Expert Advisor (owner decisions 2026-11-09: "Langsung siap
// live"; execution by an EA on the owner's own terminal, ea/mt5/CryptophysXAUUSD.mq5).
//
// GET /api/ea/signal returns ONE flat JSON object the EA can read without a JSON library:
//   kill            true when EA_SIGNALS_ENABLED is "false" or Omega set the EA to "killed": the EA
//                   closes its positions and stops (kill_source: "env" or "omega")
//   paused          true when Omega paused the EA: no new entry and no pending order (the EA deletes
//                   its pending orders); open positions keep their stop and target
//   blackout        true from 2 hours before to 30 minutes after a High-impact USD event (the event gate)
//   signal_id       the decision key of the latest BUY or SELL ("" without one): since 2026-11-09 the
//                   Decision Engine's 15m key (src/decision-engine.mjs, the single SSOT); with
//                   DECISION_ENGINE = "off" the H1 candle key of the latest H1 decision
//   side            BUY, SELL or NONE (the latest decision is WAIT, or no priced decision)
//   action          ENTER_MARKET or ENTER_LIMIT (the decision's trade plan)
//   entry, stop, tp1  the decision's prices (the Key Level Agent's zones, src/strategy-engine.mjs);
//                   tp1 is the target the decision chose (its TP1 or TP2)
//   issued_ms       the close of the decided bar; expires_ms the next close of that timeframe (a new decision)
//   market_price    the last closed 5-minute close of the feed (OANDA), market_ms its close time:
//                   the EA turns the levels into distances from its broker's price with it
//   server_ms       the server time
// The server never sizes a position and never holds a broker credential: the EA sizes each trade
// from the owner's risk input, on the owner's terminal. POST /api/ea/heartbeat keeps the EA's last
// state (mode, positions with their levels and floating P&L, last signal, daily loss) for monitoring;
// it carries no account number. The control (active, paused, killed) is set by Omega
// (omega.cryptophys.work, src/ea-execution.mjs) and kept in KV under EA_CONTROL_KEY.

import { readBrokerTrigger, brokerTriggerFields } from "./broker-trigger.mjs";
import { readCorpusBars } from "./corpus-oracle.mjs";
import { gatedEvents } from "./econ-calendar.mjs";
import { decisionEngineEnabled, readLatestDecision, keyCloseMs } from "./decision-engine.mjs";
import { liveM5Inputs } from "./strategy-engine.mjs";

export const EA_SIGNAL_VERSION = "cryptophys.ea-signal.v1";
const H1_MS = 3_600_000;
const M15_MS = 900_000;
const SYMBOL = "OANDA:XAUUSD";
const isPrice = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Pure: the EA's signal from the latest H1 synthesis (ai_analysis JSON) and the context. */
export function eaSignalFrom({ candleKey = null, analysis = null, kill = false, killSource = "", paused = false, blackout = false, blackoutReason = null, marketPrice = null, marketMs = null, now = Date.now() } = {}) {
  const base = {
    version: EA_SIGNAL_VERSION, kill: Boolean(kill), kill_source: kill ? String(killSource || "env") : "", paused: Boolean(paused) && !kill,
    blackout: Boolean(blackout), blackout_reason: blackoutReason ?? "",
    signal_id: "", side: "NONE", action: "", entry: 0, stop: 0, tp1: 0, risk_reward: 0, confidence: 0,
    issued_ms: 0, expires_ms: 0, market_price: isPrice(marketPrice) ? marketPrice : 0, market_ms: Number.isFinite(marketMs) ? marketMs : 0, server_ms: now
  };
  const d = analysis?.decision || null;
  const side = String(d?.decision || "").toUpperCase();
  const open = Number(String(candleKey ?? "").split(":").pop());
  if (!(side === "BUY" || side === "SELL") || !Number.isFinite(open)) return base;
  const entry = d.entry_price, stop = d.stop_loss, tp1 = d.take_profit;
  if (![entry, stop, tp1].every(isPrice)) return base;
  // A plan whose stop or target sits on the wrong side is never sent.
  if (side === "BUY" ? !(stop < entry && entry < tp1) : !(tp1 < entry && entry < stop)) return base;
  const action = String(d.trade_plan?.action || "ENTER_MARKET").toUpperCase() === "ENTER_LIMIT" ? "ENTER_LIMIT" : "ENTER_MARKET";
  return {
    ...base, signal_id: candleKey, side, action, entry, stop, tp1,
    risk_reward: Number.isFinite(d.risk_reward) ? d.risk_reward : 0, confidence: Number.isFinite(d.confidence) ? d.confidence : 0,
    issued_ms: open + H1_MS, expires_ms: open + 2 * H1_MS
  };
}

/**
 * Pure: the entry trigger of a decision's trade (owner 2026-11-11: the confirmation candle is the entry
 * trigger, not a gate of the decision). A market entry needs a Prophet confirmation on its side: the
 * one the decision recorded (a verified 5m or a 15m one at the close), or a verified 5m one printed since
 * (`live`, from liveM5Inputs, read when the EA or Omega asks). A limit at the key level needs none.
 */
export function entryTriggerFor(decision, { live = null, broker = null } = {}) {
  const t = decision?.trade;
  const side = String(decision?.stance || "").toUpperCase();
  const required = t?.action === "ENTER_MARKET";
  const recorded = decision?.guardrails?.[side === "BUY" ? "long" : "short"]?.entry_trigger ?? null;
  const key = side === "BUY" ? "buy_confirmed" : "sell_confirmed";
  const liveFired = live?.verified === true && live?.[key] === true;
  if (recorded?.fired === true) return { required, fired: true, source: recorded.source ?? "decision", note: recorded.note ?? null };
  // A record written before 2026-11-11 has no entry_trigger: its BUY or SELL already passed the confirmation gate.
  if (!recorded) return { required, fired: true, source: "decision", note: "the decision passed the confirmation gate of its time" };
  // 5m execution (docs/RFC_OMEGA_5M_EXECUTION.md, owner 2026-11-12): once the broker's 5m lane is ready, its
  // confirmation on one of the 3 broker 5m bars after the decision's close is the trigger; TradingView's 5m
  // stands in only while the broker lane is not ready or not fresh.
  const close = keyCloseMs(decision?.decision_key);
  if (broker?.latest?.ready === true && Number.isFinite(close)) {
    const hit = (broker.recent || []).filter((b) => b?.ready === true && b[key] === true && b.close_ms > close && b.close_ms <= close + 3 * 5 * 60_000).sort((a, b) => a.close_ms - b.close_ms)[0];
    if (hit) return { required, fired: true, source: "broker_5m", at_ms: hit.close_ms, note: `a broker 5m Prophet ${side === "BUY" ? "buy" : "sell"} confirmation on the 5m bar closing ${new Date(hit.close_ms).toISOString().slice(11, 16)} UTC` };
    return { required, fired: false, source: null, note: `waiting for a broker 5m Prophet ${side === "BUY" ? "buy" : "sell"} confirmation (3 bars after the decision)` };
  }
  if (liveFired) return { required, fired: true, source: "5m", at_ms: Date.parse(String(live.candle_time ?? "")) || null, note: `a verified 5m Prophet ${side === "BUY" ? "buy" : "sell"} confirmation${typeof live.candle_time === "string" ? ` on the 5m bar closing ${live.candle_time.slice(11, 16)} UTC` : ""}` };
  return { required, fired: false, source: null, note: `waiting for a verified 5m (or 15m) Prophet ${side === "BUY" ? "buy" : "sell"} confirmation` };
}

/**
 * Pure: the EA's signal from the latest Decision Engine record (src/decision-engine.mjs). A BUY or
 * SELL with a valid trade; issued at its 15m close, expiring at the next 15m close (the next decision).
 * A market entry is sent only once its entry trigger fired; until then the signal says what it awaits.
 */
export function eaSignalFromDecision({ decision = null, kill = false, killSource = "", paused = false, blackout = false, blackoutReason = null, marketPrice = null, marketMs = null, now = Date.now(), liveM5 = null, broker = null } = {}) {
  const base = eaSignalFrom({ kill, killSource, paused, blackout, blackoutReason, marketPrice, marketMs, now });
  const t = decision?.trade;
  const side = String(decision?.stance || "").toUpperCase();
  const close = keyCloseMs(decision?.decision_key);
  if (!t || !(side === "BUY" || side === "SELL") || t.side !== side || !Number.isFinite(close)) return base;
  const entry = t.entry, stop = t.stop, tp1 = t.tp;
  if (![entry, stop, tp1].every(isPrice)) return base;
  if (side === "BUY" ? !(stop < entry && entry < tp1) : !(tp1 < entry && entry < stop)) return base;
  const decidedMs = Date.parse(String(decision?.decided_at ?? "")) || close;
  const trigger = entryTriggerFor(decision, { live: liveM5, broker });
  if (trigger.required && !trigger.fired) {
    // Nothing to execute yet: the EA and Omega see no side; the signal says what the setup waits for.
    // Flat fields only: the EA parses a flat JSON object.
    return { ...base, awaiting_signal_id: decision.decision_key, awaiting_side: side, awaiting_reason: String(trigger.note ?? ""), awaiting_expires_ms: close + M15_MS };
  }
  return {
    ...base, trigger_required: trigger.required, trigger_source: String(trigger.source ?? ""),
    signal_id: decision.decision_key, side, action: t.action === "ENTER_LIMIT" ? "ENTER_LIMIT" : "ENTER_MARKET", entry, stop, tp1,
    risk_reward: Number.isFinite(t.rrr) ? t.rrr : 0, confidence: Number.isFinite(decision.confidence) ? decision.confidence : 0,
    // A market entry triggered live by a later 5m candle is as fresh as that candle (Omega's signal-age gate).
    issued_ms: close, expires_ms: close + M15_MS, decided_ms: Number.isFinite(trigger.at_ms) && trigger.at_ms > decidedMs ? trigger.at_ms : decidedMs
  };
}

/**
 * Pure: the broker's price minus the feed's, the median over the feed's closed 5m bars matched with the
 * broker's M1 bar closing at the same minute (at least 3 of them), or null. Omega moves the key levels,
 * which are on the feed's scale, onto the broker's with it.
 */
export function feedBasis(brokerM1 = [], feedCandles = []) {
  const closeAt = new Map((brokerM1 || []).filter((b) => Number.isFinite(b?.t) && isPrice(b?.c)).map((b) => [b.t + 60_000, b.c]));
  const offs = (feedCandles || []).map((c) => ({ ms: Date.parse(String(c?.close_time ?? "")), close: c?.close })).filter((c) => Number.isFinite(c.ms) && isPrice(c.close) && closeAt.has(c.ms)).map((c) => closeAt.get(c.ms) - c.close).sort((a, b) => a - b);
  if (offs.length < 3) return null;
  const mid = Math.floor(offs.length / 2);
  const median = offs.length % 2 ? offs[mid] : (offs[mid - 1] + offs[mid]) / 2;
  return Math.round(median * 100) / 100;
}

/**
 * Pure: the flat fields Omega's position management reads from the latest decision, whatever its stance
 * (owner 2026-11-12: "atur SL+ dan Trailing TP juga harus berdasarkan keylevel menyesuaikan Bull/Bear
 * Power"; "Bull/Bear power dihasilkan decision engine hasil quorum"). `power` is the quorum's score
 * (-1 bearish to +1 bullish) at `power_ms`, the decision's close; `key_levels` the Key Level Agent's
 * candidate zones on the feed's scale ("low:high" joined by ","); `feed_basis` the broker minus the feed.
 * Flat values only: the EA parses a flat JSON object and ignores these.
 */
export function managementFields(decision, { basis = null } = {}) {
  const close = keyCloseMs(decision?.decision_key);
  const score = decision?.quorum?.score;
  const levels = (Array.isArray(decision?.key_levels) ? decision.key_levels : []).filter((z) => isPrice(z?.low) && isPrice(z?.high) && z.low <= z.high);
  return {
    trading_mode: typeof decision?.trading_mode === "string" ? decision.trading_mode : "",
    power: Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : 0,
    power_ms: Number.isFinite(close) && Number.isFinite(score) ? close : 0,
    key_levels: levels.map((z) => `${z.low}:${z.high}`).join(","),
    feed_basis: Number.isFinite(basis) ? basis : 0,
    feed_basis_known: Number.isFinite(basis)
  };
}

const BASIS_TTL_MS = 5 * 60_000;
let basisMemo = { at: 0, basis: null };
export function resetFeedBasisMemoForTests() { basisMemo = { at: 0, basis: null }; }

/** Loads the latest decision, the event gate and the feed price, and builds the signal. Never throws. */
/** The EA's event blackout in force: BLACKOUT_MINUTES on both sides, else BLACKOUT_BEFORE_MINUTES (120) and BLACKOUT_AFTER_MINUTES (30). */
export function blackoutWindow(env) {
  const both = Number(env?.BLACKOUT_MINUTES);
  const beforeMs = Math.max(0, (Number.isFinite(both) ? both : (Number(env?.BLACKOUT_BEFORE_MINUTES) || 120))) * 60_000;
  const afterMs = Math.max(0, (Number.isFinite(both) ? both : (Number(env?.BLACKOUT_AFTER_MINUTES) || 30))) * 60_000;
  return { beforeMs, afterMs };
}

export async function eaSignal(env, { now = Date.now() } = {}) {
  const envKill = String(env?.EA_SIGNALS_ENABLED ?? "true").trim().toLowerCase() === "false";
  const control = await readControl(env);
  const kill = envKill || control.mode === "killed";
  const killSource = envKill ? "env" : control.mode === "killed" ? "omega" : "";
  const paused = control.mode === "paused";
  const engine = decisionEngineEnabled(env);
  let candleKey = null, analysis = null, decision = null;
  if (engine) decision = await readLatestDecision(env);
  else try {
    const row = await env.DB.prepare("SELECT candle_key, ai_analysis FROM ai_syntheses WHERE candle_key LIKE ? ORDER BY id DESC LIMIT 1").bind(`${SYMBOL}:60:%`).first();
    candleKey = row?.candle_key ?? null;
    analysis = row?.ai_analysis ? JSON.parse(row.ai_analysis) : null;
  } catch { analysis = null; }
  let blackout = false, blackoutReason = null;
  try {
    const { beforeMs, afterMs } = blackoutWindow(env);
    const events = await gatedEvents(env, { now });
    const active = (Array.isArray(events) ? events : []).filter((e) => {
      const t = Date.parse(e?.time ?? e?.date ?? e?.datetime ?? e?.start ?? "");
      if (!Number.isFinite(t)) return false;
      return now >= t - beforeMs && now <= t + afterMs;
    });
    if (active.length) { blackout = true; blackoutReason = active.map((e) => e.title ?? e.event ?? e.name ?? "high-impact USD event").join("; ").slice(0, 160); }
  } catch { blackout = false; }
  let marketPrice = null, marketMs = null, feedCandles = [];
  try {
    const rec = JSON.parse((await env.SIGNAL_CACHE?.get?.(`market-data:v2:series:${SYMBOL}|5m`)) || "null");
    feedCandles = (Array.isArray(rec?.candles) ? rec.candles : []).filter((c) => isPrice(c?.close) && c.close_time).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
    const last = feedCandles.at(-1);
    if (last) { marketPrice = last.close; marketMs = Date.parse(last.close_time); }
  } catch { marketPrice = null; }
  // The live 5m confirmation (verified while the 5m Prophet implementation is parity-approved) for a market entry.
  let liveM5 = null;
  if (engine && decision?.trade?.action === "ENTER_MARKET") { try { liveM5 = (await liveM5Inputs(env, { now }))?.confirmation ?? null; } catch { liveM5 = null; } }
  // The broker's 5m lane (docs/RFC_OMEGA_5M_EXECUTION.md): the trigger and, for Omega, the 5m stop and management fields.
  const broker = await readBrokerTrigger(env, { now });
  if (engine) {
    // The broker's basis against the feed over the last two hours of closed 5m bars (the key levels' scale).
    // Kept for 5 minutes per isolate: the bridge syncs every few seconds and the basis moves slowly.
    let basis = basisMemo.at && now - basisMemo.at < BASIS_TTL_MS ? basisMemo.basis : null;
    if (!(basisMemo.at && now - basisMemo.at < BASIS_TTL_MS)) {
      try {
        const recent = feedCandles.slice(-24);
        if (recent.length) basis = feedBasis((await readCorpusBars(env, { sinceMs: Date.parse(recent[0].close_time) - 120_000 })).bars, recent);
      } catch { basis = null; }
      basisMemo = { at: now, basis };
    }
    return { ...eaSignalFromDecision({ decision, kill, killSource, paused, blackout, blackoutReason, marketPrice, marketMs, now, liveM5, broker }), ...brokerTriggerFields(broker), ...managementFields(decision, { basis }), source: "decision_engine" };
  }
  return { ...eaSignalFrom({ candleKey, analysis, kill, killSource, paused, blackout, blackoutReason, marketPrice, marketMs, now }), ...brokerTriggerFields(broker), source: "h1_decision" };
}

export const EA_HEARTBEAT_KEY = "ea:heartbeat:last";
const HEARTBEAT_FIELDS = Object.freeze({
  ea: "string", version: "string", mode: "string", trading_allowed: "boolean", positions: "number",
  last_signal_id: "string", daily_loss_pct: "number", spread_points: "number", note: "string",
  control: "string", floating_pnl: "number", today_pnl: "number", currency: "string", terminal_ms: "number"
});
const POSITION_FIELDS = Object.freeze({
  ticket: "number", side: "string", volume: "number", entry: "number", sl: "number", tp: "number",
  profit: "number", swap: "number", opened_ms: "number", signal_id: "string"
});
export const HEARTBEAT_MAX_POSITIONS = 20;
/** The heartbeat fields the server keeps (positions_detail holds the open positions). */
export const HEARTBEAT_FIELD_NAMES = Object.freeze([...Object.keys(HEARTBEAT_FIELDS), "positions_detail"]);

/** Pure: one open position of a heartbeat (known fields only), or null. */
export function positionFrom(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const out = {};
  for (const [k, type] of Object.entries(POSITION_FIELDS)) {
    const v = p[k];
    if (typeof v === type && (type !== "number" || Number.isFinite(v))) out[k] = type === "string" ? String(v).slice(0, 80) : v;
  }
  out.side = String(out.side || "").toUpperCase();
  if (!(out.side === "BUY" || out.side === "SELL") || !Number.isFinite(out.ticket)) return null;
  return out;
}

/** Pure: the heartbeat kept from an EA's POST body: only the known fields, no account number. */
export function heartbeatFrom(body, { now = Date.now() } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const out = { received_at: new Date(now).toISOString() };
  for (const [k, type] of Object.entries(HEARTBEAT_FIELDS)) {
    const v = body[k];
    if (typeof v === type && (type !== "number" || Number.isFinite(v))) out[k] = type === "string" ? String(v).slice(0, 120) : v;
  }
  if (!["demo", "live", "contest"].includes(out.mode)) out.mode = "unknown";
  if (Array.isArray(body.positions_detail)) out.positions_detail = body.positions_detail.slice(0, HEARTBEAT_MAX_POSITIONS).map(positionFrom).filter(Boolean);
  return out;
}

// ---------------------------------------------------------------- control (Omega)

export const EA_CONTROL_KEY = "ea:control";
export const CONTROL_MODES = Object.freeze(["active", "paused", "killed"]);
const DEFAULT_CONTROL = Object.freeze({ mode: "active", reason: "", actor: "", at: null });

/** The EA control set by Omega (KV), or "active". Never throws. */
export async function readControl(env) {
  try {
    const c = JSON.parse((await env?.SIGNAL_CACHE?.get?.(EA_CONTROL_KEY)) || "null");
    if (c && CONTROL_MODES.includes(c.mode)) return { ...DEFAULT_CONTROL, ...c };
  } catch { /* the default */ }
  return { ...DEFAULT_CONTROL };
}

/** Stores an EA heartbeat (KV, 2 days). */
export async function storeHeartbeat(env, body, { now = Date.now() } = {}) {
  const hb = heartbeatFrom(body, { now });
  if (!hb) return { ok: false, error: "body must be a JSON object" };
  await env.SIGNAL_CACHE.put(EA_HEARTBEAT_KEY, JSON.stringify(hb), { expirationTtl: 2 * 86_400 });
  return { ok: true };
}

/** GET /api/ea/status: the current signal and the EA's last heartbeat. */
export async function eaStatus(env, { now = Date.now() } = {}) {
  let heartbeat = null;
  try { heartbeat = JSON.parse((await env.SIGNAL_CACHE?.get?.(EA_HEARTBEAT_KEY)) || "null"); } catch { heartbeat = null; }
  return { signal: await eaSignal(env, { now }), heartbeat, control: await readControl(env) };
}
