// The signal for the owner's MetaTrader 5 Expert Advisor (owner decisions 2026-11-09: "Langsung siap
// live"; execution by an EA on the owner's own terminal, ea/mt5/CryptophysXAUUSD.mq5).
//
// GET /api/ea/signal returns ONE flat JSON object the EA can read without a JSON library:
//   kill            true when EA_SIGNALS_ENABLED is "false": the EA closes its positions and stops
//   blackout        true from 2 hours before to 30 minutes after a High-impact USD event (the event gate)
//   signal_id       the H1 candle key of the latest BUY or SELL decision ("" without one)
//   side            BUY, SELL or NONE (the latest H1 decision is WAIT, or no priced decision)
//   action          ENTER_MARKET or ENTER_LIMIT (the decision's trade plan)
//   entry, stop, tp1  the decision's prices (the 1-hour chart's own key levels, src/strategy-engine.mjs)
//   issued_ms       the close of the decided H1 bar; expires_ms the next H1 close (a new decision)
//   market_price    the last closed 5-minute close of the feed (OANDA), market_ms its close time:
//                   the EA turns the levels into distances from its broker's price with it
//   server_ms       the server time
// The server never sizes a position and never holds a broker credential: the EA sizes each trade
// from the owner's risk input, on the owner's terminal. POST /api/ea/heartbeat keeps the EA's last
// state (mode, positions, last signal, daily loss) for monitoring; it carries no account number.

import { eventRisk, gatedEvents } from "./econ-calendar.mjs";

export const EA_SIGNAL_VERSION = "cryptophys.ea-signal.v1";
const H1_MS = 3_600_000;
const SYMBOL = "OANDA:XAUUSD";
const isPrice = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Pure: the EA's signal from the latest H1 synthesis (ai_analysis JSON) and the context. */
export function eaSignalFrom({ candleKey = null, analysis = null, kill = false, blackout = false, blackoutReason = null, marketPrice = null, marketMs = null, now = Date.now() } = {}) {
  const base = {
    version: EA_SIGNAL_VERSION, kill: Boolean(kill), blackout: Boolean(blackout), blackout_reason: blackoutReason ?? "",
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

/** Loads the latest H1 decision, the event gate and the feed price, and builds the signal. Never throws. */
export async function eaSignal(env, { now = Date.now() } = {}) {
  const kill = String(env?.EA_SIGNALS_ENABLED ?? "true").trim().toLowerCase() === "false";
  let candleKey = null, analysis = null;
  try {
    const row = await env.DB.prepare("SELECT candle_key, ai_analysis FROM ai_syntheses WHERE candle_key LIKE ? ORDER BY id DESC LIMIT 1").bind(`${SYMBOL}:60:%`).first();
    candleKey = row?.candle_key ?? null;
    analysis = row?.ai_analysis ? JSON.parse(row.ai_analysis) : null;
  } catch { analysis = null; }
  let blackout = false, blackoutReason = null;
  try {
    const r = eventRisk(await gatedEvents(env, { now }), now);
    if (r.active.length) { blackout = true; blackoutReason = r.active.map((e) => e.title ?? e.event ?? "high-impact USD event").join("; ").slice(0, 160); }
  } catch { blackout = false; }
  let marketPrice = null, marketMs = null;
  try {
    const rec = JSON.parse((await env.SIGNAL_CACHE?.get?.(`market-data:v2:series:${SYMBOL}|5m`)) || "null");
    const last = (Array.isArray(rec?.candles) ? rec.candles : []).filter((c) => isPrice(c?.close) && c.close_time).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time)).at(-1);
    if (last) { marketPrice = last.close; marketMs = Date.parse(last.close_time); }
  } catch { marketPrice = null; }
  return eaSignalFrom({ candleKey, analysis, kill, blackout, blackoutReason, marketPrice, marketMs, now });
}

export const EA_HEARTBEAT_KEY = "ea:heartbeat:last";
const HEARTBEAT_FIELDS = Object.freeze({
  ea: "string", version: "string", mode: "string", trading_allowed: "boolean", positions: "number",
  last_signal_id: "string", daily_loss_pct: "number", spread_points: "number", note: "string"
});

/** Pure: the heartbeat kept from an EA's POST body: only the known fields, no account number. */
export function heartbeatFrom(body, { now = Date.now() } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const out = { received_at: new Date(now).toISOString() };
  for (const [k, type] of Object.entries(HEARTBEAT_FIELDS)) {
    const v = body[k];
    if (typeof v === type) out[k] = type === "string" ? String(v).slice(0, 120) : v;
  }
  if (!["demo", "live", "contest"].includes(out.mode)) out.mode = "unknown";
  return out;
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
  return { signal: await eaSignal(env, { now }), heartbeat };
}
