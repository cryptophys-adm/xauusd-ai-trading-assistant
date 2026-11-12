// Strategy engine (owner decision 2026-11-06): the trading decision is the consensus of ALL
// agents across the timeframes, not the three-model H1 chain, and it states its key levels and
// reward-to-risk. Deterministic: no model call.
//
// Top-down, as a discretionary multi-timeframe trader works:
//   D1  macro trend      the D1 War Room: every agent's bias, confidence weighted
//   4H  intraday trend   the 4H War Room
//   1H  setup            the 1H War Room, aligned with the trend; GMI and Prophet vetoes
//   15m structure        the 15m War Room must not lean against it; price at a key level
//   5m  entry trigger    a VERIFIED 5m Prophet confirmation (or the 15m Prophet confirmation)
//                        (owner decision 2026-11-08: the engine is evaluated at every closed 5m
//                        bar, with that bar's confirmation and close, not only at the 15m close)
// Key levels come from the HUD snapshots, which are computed from closed bars: Camarilla 1H, 4H,
// daily and weekly, the daily and weekly CPR, the 1H value area and the recent 15m swing. The
// stop sits beyond the next level against the trade, the targets are the next levels with it, and
// BUY or SELL needs a reward-to-risk of at least MIN_RRR to the final target.
//
// Advisory only: no orders, no position size, no broker. The H1 chain stays one input (its
// decision is the 1H Desk's view inside the 1H room) and is reported beside the engine's decision.
import { readTimeframeThread } from "./timeframe-threads.mjs";
import { readWarRoom } from "./war-room.mjs";
import { readNewsDaily } from "./news-daily.mjs";
import { loadHudSnapshot } from "./hud-store.mjs";
import { buildKeyLevels } from "./key-level-agent.mjs";
import { eventRisk, eventCaution, gatedEvents } from "./econ-calendar.mjs";
import { recentReleases } from "./econ-releases.mjs";
import { verifiedM5Confirmation } from "./m5-verification.mjs";
import { setupType } from "./level-readers.mjs";
import { orderImbalance } from "./producer/m5-orderbook.mjs";

export const STRATEGY_VERSION = "cryptophys.strategy-engine.v1";
export const TREND_WEIGHTS = Object.freeze({ D1: 0.5, H4: 0.5 });
export const ALIGNMENT_WEIGHTS = Object.freeze({ D1: 0.3, H4: 0.3, H1: 0.25, M15: 0.15 });
export const MIN_RRR = 1.5;
export const MIN_CONFIDENCE = 0.4;
const LEAN = 0.15; // a lean inside +-LEAN is neutral
/**
 * The engine's thresholds. buildStrategy takes them as `params` (default: these), so the A8 tuning
 * replay (src/strategy-replay.mjs) can recompute a stored hour with a candidate set. The live engine
 * always uses these values; changing one is an owner PR.
 */
export const STRATEGY_PARAMS = Object.freeze({ min_rrr: MIN_RRR, min_confidence: MIN_CONFIDENCE, lean: LEAN, strong_h1: 0.3, near_atr: 0.35 });
const PERIOD_MS = { D1: 86_400_000, H4: 14_400_000, H1: 3_600_000, M15: 900_000 };
const LAYER = {
  D1: { label: "D1", role: "Macro" },
  H4: { label: "4H", role: "Intraday" },
  H1: { label: "1H", role: "Setup" },
  M15: { label: "15m", role: "Location" },
  M5: { label: "5m", role: "Trigger" }
};

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
const sideOf = (v) => (!isNum(v) || Math.abs(v) < LEAN ? "NEUTRAL" : v > 0 ? "BULLISH" : "BEARISH");
const dirOf = (s) => (s === "BUY" || s === "BULLISH" ? 1 : s === "SELL" || s === "BEARISH" ? -1 : 0);
const word = (v) => (!isNum(v) ? "no data" : Math.abs(v) < LEAN ? "neutral" : `${Math.abs(v) < 0.4 ? "slightly " : Math.abs(v) >= 0.7 ? "strongly " : ""}${v > 0 ? "bullish" : "bearish"}`);
const fmt = (p) => (isNum(p) ? p.toFixed(2) : "n/a");

/**
 * Confidence-weighted mean direction of the agents that spoke, in [-1, 1], or null. Each agent's
 * direction is its bias (owner decision 2026-11-06: the action is mostly WAIT without a
 * confirmation, the bias carries the lean); openings stored before the bias existed use the action.
 */
export function roomLean(openings) {
  const ok = (openings || []).filter((o) => o?.status === "ok" && isNum(o.confidence));
  const w = ok.reduce((sum, o) => sum + o.confidence, 0);
  return ok.length && w > 0 ? r2(ok.reduce((sum, o) => sum + dirOf(o.bias || o.stance) * o.confidence, 0) / w) : null;
}

/** Average true range of closed candles ({ high, low, close }), or null. */
export function atr(candles, n = 14) {
  const c = (candles || []).filter((b) => isNum(b?.high) && isNum(b?.low) && isNum(b?.close));
  if (c.length < 2) return null;
  const tr = [];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
  const last = tr.slice(-n);
  return last.reduce((s, v) => s + v, 0) / last.length;
}

/** A room's layer: the confidence-weighted lean of every agent that spoke, its decision and bias. */
function roomLayer(key, room, now) {
  const at = room?.bar_close ?? room?.bar_time ?? null;
  const c = room?.conclusion?.status === "ok" ? room.conclusion : null;
  let lean = room ? roomLean(room.openings) : null;
  if (lean == null && c?.bias) lean = dirOf(c.bias) * (isNum(c.confidence) ? c.confidence : 0.5);
  const agents = (room?.openings || []).filter((o) => o?.status === "ok").length;
  return {
    key, ...LAYER[key], available: lean != null, lean: r2(lean), side: sideOf(lean), agents,
    decision: c?.stance ?? null, bias: c?.bias ?? null, at,
    stale: Boolean(at && now - Date.parse(at) > 2 * PERIOD_MS[key])
  };
}

/**
 * Entry, stop and targets for a direction (+1 long, -1 short) from the price, the key level zones
 * ({ low, high, price, label, major }; a plain level is a zone of zero width) and the 1H ATR.
 * - At a zone with the trade (price inside it or within 0.35 ATR of it, or inside a demand or
 *   supply zone of the 15m HUDs): the entry is the price. Otherwise the planned entry is the
 *   near edge of the nearest zone with the trade (a pullback).
 * - The stop sits beyond the far edge of the first zone against the trade at least 0.5 ATR from
 *   the entry, padded by 0.2 ATR; without one, or beyond 2.5 ATR, it is 1.5 ATR.
 * - The targets are the near edges of the next two MAJOR zones (Key Level Agent candidates), each
 *   at least 0.5 ATR beyond the previous one, or 2R and 3R projections.
 */
export function tradeLevels({ dir, price, levels, atrH1, inZone = false, zoneNote = null, nearAtr = STRATEGY_PARAMS.near_atr }) {
  if (!dir || !isNum(price) || !isNum(atrH1) || atrH1 <= 0) return null;
  const near = nearAtr * atrH1, gap = 0.5 * atrH1, pad = 0.2 * atrH1;
  const lo = (z) => (isNum(z.low) ? z.low : z.price), hi = (z) => (isNum(z.high) ? z.high : z.price);
  const nearEdge = (z) => (dir > 0 ? hi(z) : lo(z)), farEdge = (z) => (dir > 0 ? lo(z) : hi(z));
  // Zones with the trade's back to them: support for a long, resistance for a short.
  const behind = levels.filter((z) => (dir > 0 ? lo(z) <= price : hi(z) >= price)).sort((a, b) => dir * (nearEdge(b) - nearEdge(a)));
  const nearest = behind[0] ?? null;
  const atZone = nearest && price >= lo(nearest) - near && price <= hi(nearest) + near;
  const atLevel = inZone || Boolean(atZone);
  const entry = atLevel ? price : nearest ? nearEdge(nearest) : price;
  const entryNote = atZone ? `price holds at ${nearest.label}` : inZone ? (zoneNote ?? "price is inside a demand or supply zone with the trade") : nearest ? `a pullback to ${nearest.label}` : "price";
  const stopZone = levels.filter((z) => dir * (entry - farEdge(z)) >= gap).sort((a, b) => dir * (farEdge(b) - farEdge(a)))[0] ?? null;
  let stop = stopZone ? farEdge(stopZone) - dir * pad : null;
  let stopNote = stopZone ? `beyond ${stopZone.label}` : null;
  const risk0 = isNum(stop) ? Math.abs(entry - stop) : null;
  if (!isNum(risk0) || risk0 > 2.5 * atrH1) { stop = entry - dir * 1.5 * atrH1; stopNote = "1.5 times the 1H average range"; }
  const risk = Math.abs(entry - stop);
  const targetEdge = (z) => (dir > 0 ? lo(z) : hi(z));
  const ahead = levels.filter((z) => z.major !== false && dir * (targetEdge(z) - entry) >= gap).sort((a, b) => dir * (targetEdge(a) - targetEdge(b)));
  const t1 = ahead[0] ?? null;
  const t2 = t1
    ? ahead.find((z) => dir * (targetEdge(z) - targetEdge(t1)) >= gap && Math.abs(targetEdge(z) - entry) / risk >= 1.5) ?? null
    : null;
  const tp1 = t1 ? targetEdge(t1) : entry + dir * 2 * risk;
  const tp2 = t2 ? targetEdge(t2) : entry + dir * Math.max(3 * risk, Math.abs(tp1 - entry) + risk);
  const rr = (tp) => r2(Math.abs(tp - entry) / risk);
  return {
    at_level: atLevel, entry: r2(entry), entry_note: entryNote,
    stop: r2(stop), stop_note: stopNote, risk: r2(risk),
    tp1: r2(tp1), tp1_note: t1 ? t1.label : "a 2R projection",
    tp2: r2(tp2), tp2_note: t2 ? t2.label : "a projection beyond the first target",
    progressive_stop: r2(entry),
    rrr: { tp1: rr(tp1), tp2: rr(tp2) }
  };
}

const zoneText = (z) => `${z.candidate ? "the" : "a"} ${z.low === z.high ? z.low.toFixed(2) : `${z.low.toFixed(2)}–${z.high.toFixed(2)}`} ${z.candidate ? "key zone" : "level"} (${z.label})`;
/** The Key Level Agent's zones as tradeLevels input: candidates are the major zones. */
function zoneLevels(zones) {
  return (zones || []).filter((z) => isNum(z.low) && isNum(z.high)).map((z) => ({ low: z.low, high: z.high, price: z.price, major: z.candidate, label: zoneText(z) }));
}

/**
 * The plan for a direction chosen elsewhere (owner decision 2026-11-09: the H1 decision is the 1H War
 * Room's quorum; its prices come from here). The same tradeLevels as the strategy, on the strategy's
 * price, 1H ATR and Key Level Agent zones; the strategy's own location (at a level, or inside a
 * demand or supply zone) counts only when the strategy points the same way. Null without a price,
 * an ATR or a direction.
 */
export function planForDirection(strategy, dir) {
  if (!strategy || !(dir === 1 || dir === -1)) return null;
  const sameWay = (strategy.direction === "LONG" && dir > 0) || (strategy.direction === "SHORT" && dir < 0);
  const setupNote = sameWay && strategy.setup?.type && strategy.setup.type !== "none" ? `${strategy.setup.type === "continuation_pullback" ? "a pullback with the trend" : "a stretched sweep into liquidity"}: ${(strategy.setup.evidence || []).join(", ")}` : null;
  return tradeLevels({ dir, price: strategy.price, levels: zoneLevels(strategy.key_levels?.zones), atrH1: strategy.atr_h1, inZone: Boolean(sameWay && strategy.plan?.at_level), zoneNote: setupNote });
}

/**
 * The plan for the H1 decision from the 1-hour chart only (owner decisions 2026-11-09: independent
 * timeframes): the Key Level Agent's zones built from the 1H HUD snapshot and the closed 1H bars, the
 * 1H ATR and the last 1H close. No other chart's levels, no other room. Null without price or ATR.
 */
export function ownTimeframePlan({ snapshot = null, bars = [] } = {}, dir) {
  if (!(dir === 1 || dir === -1)) return null;
  const closed = (bars || []).filter((b) => isNum(b?.close));
  const price = closed.at(-1)?.close ?? snapshot?.huds?.interstellar_eyes?.fields?.close ?? null;
  const atrH1 = atr(closed);
  if (!isNum(price) || !isNum(atrH1)) return null;
  const reading = buildKeyLevels({ snapshots: { "60": snapshot }, bars: { H1: closed }, price, atrH1 });
  const plan = tradeLevels({ dir, price, levels: zoneLevels(reading.zones), atrH1 });
  return plan ? { ...plan, source: "1H chart only", reference_price: r2(price), atr_h1: r2(atrH1) } : null;
}

/** Loads the 1-hour chart's own inputs for ownTimeframePlan. */
export async function loadOwnTimeframePlanInputs(env) {
  let snapshot = null;
  try { snapshot = await loadHudSnapshot(env, { timeframe: "60" }); } catch { snapshot = null; }
  const bars = await seriesCandles(env, "1h");
  return { snapshot, bars: bars.slice(-60) };
}

/** Vetoes and cautions for a direction from the 1H and 15m HUD snapshots, the news and the economic calendar. */
export function compositeSentimentLocal({ news = null, macro = null, newsLean = null, macroScore = null } = {}) {
  let nl = isNum(newsLean) ? newsLean : null;
  if (nl == null && news) {
    if (isNum(news.lean)) nl = news.lean;
    else if (news.counts) {
      const c = news.counts;
      const b = Number(c.bullish) || 0, s = Number(c.bearish) || 0, n = Number(c.neutral) || 0;
      if (b + s + n) nl = (b - s) / (b + s + n);
    } else if (news?.tldr?.status === "ok") {
      nl = (news.tldr.stance === "BUY" || news.tldr.stance === "BULLISH" ? 1 : news.tldr.stance === "SELL" || news.tldr.stance === "BEARISH" ? -1 : 0) * (isNum(news.tldr.confidence) ? news.tldr.confidence : 0.5);
    }
  }
  let ms = isNum(macroScore) ? macroScore : null;
  if (ms == null && macro) {
    const mc = macro?.conclusion?.status === "ok" ? macro.conclusion : macro?.conclusion ?? null;
    if (mc && isNum(mc.confidence)) ms = (mc.bias === "BULLISH" || mc.bias === "BUY" ? 1 : mc.bias === "BEARISH" || mc.bias === "SELL" ? -1 : 0) * mc.confidence;
    else if (isNum(macro.lean)) ms = macro.lean;
    else if (isNum(macro.score)) ms = macro.score;
  }
  const parts = [];
  if (isNum(nl)) parts.push({ v: nl, w: 0.5 });
  if (isNum(ms)) parts.push({ v: ms, w: 0.5 });
  if (!parts.length) return null;
  const tw = parts.reduce((s, p) => s + p.w, 0);
  return Math.round((parts.reduce((s, p) => s + p.v * p.w, 0) / tw) * 100) / 100;
}
export function riskChecks(dir, { h1Snapshot, m15Snapshot, news, calendar = null, macro = null, macroScore = null, composite = null, mode = null, tradingMode = null, env = null, now = Date.now() }) {
  const vetoes = [], cautions = [], supports = [];
  const dm = h1Snapshot?.huds?.decision_matrix?.fields || {};
  const tm = h1Snapshot?.huds?.trade_management?.fields || {};
  const prophet = h1Snapshot?.huds?.prophet?.fields || {};
  // Owner decision 2026-11-06: a GMI and Prophet conflict and a closed GMI gate are cautions (each
  // -0.1 confidence), not vetoes; production 14:15 had a clear bearish consensus blocked by them.
  if (dm.conflict === true || tm.conflict === true) cautions.push("GMI and Prophet conflict on the 1-hour chart");
  if (dm.gate === -1 || tm.gate === -1) cautions.push("the GMI confluence gate is closed on the 1-hour chart");
  // Prophet R38 t_enc 4 "RUTHLESS CUT LOSS" comes only from d_enc 3, a bearish structure break on the 1-hour
  // chart (a bull trap or a true breakdown without a strong trend); its bullish mirror, d_enc -3, is t_enc 1
  // "PYRAMID BULL". It tells longs to get out, so it blocks a long only. Owner 2026-11-12 ("setuju … justru
  // jadikan ini sebagai opportunity"): production 07:01-08:46 UTC held eight bearish decisions (quorum -0.65 to
  // -0.76, every other short guardrail passed) at WAIT because it vetoed both sides; for a short it is support.
  if (prophet.t_enc === 4) {
    if (dir > 0) vetoes.push("Prophet signals a ruthless cut loss on the 1-hour chart: the structure broke down, so no long");
    else if (dir < 0) supports.push("Prophet signals a ruthless cut loss for longs on the 1-hour chart: the structure broke down, which supports a short");
  }
  if (dir > 0 && dm.verdict === -3) vetoes.push("the GMI verdict is a strong sell on the 1-hour chart");
  if (dir < 0 && dm.verdict === 3) vetoes.push("the GMI verdict is a strong buy on the 1-hour chart");
  const chaos = [h1Snapshot, m15Snapshot].filter((s) => s?.huds?.kinetic_engine?.fields?.is_chaos === true).length;
  if (chaos === 2) cautions.push("both the 1-hour and the 15-minute regime read chaotic");
  if (dir && news?.tldr?.status === "ok" && dirOf(news.tldr.stance) === -dir && (news.tldr.confidence ?? 0) >= 0.6) cautions.push(`the last 24 hours of news lean ${String(news.tldr.stance).toLowerCase()}, against the trade`);
  // Event-risk gate (backlog 11.1, owner decision 2026-11-08): a high-impact USD event from 2 hours
  // before to 30 minutes after it is a caution, never a forced WAIT.
  const event = Array.isArray(calendar?.events) ? eventCaution(eventRisk(calendar.events, now)) : null;
  if (event) cautions.push(event);
  const MODE = String(mode ?? tradingMode ?? env?.TRADING_MODE ?? "intraday").trim().toLowerCase();
  const cs = isNum(composite) ? composite : compositeSentimentLocal({ news, macro, macroScore });
  if (MODE === "swing" && isNum(cs) && dir) {
    if (dir * cs <= -0.6) vetoes.push("swing mode: composite sentiment leans strongly against the trade");
    else if (dir * cs < 0) cautions.push("swing mode: composite sentiment leans against the trade");
  }
  return { vetoes, cautions, supports };
}

/** The entry trigger in a direction: a verified 5m confirmation or the 15m Prophet confirmation/setup state. */
export function triggerOf(dir, { confirmations, m15Snapshot }) {
  if (!dir) return { fired: false, source: null, note: "no direction to confirm" };
  const side = dir > 0 ? "buy_confirmed" : "sell_confirmed";
  const readySide = dir > 0 ? "buy_setup_ready" : "sell_setup_ready";
  const m5 = confirmations?.m5_prophet_r38;
  const at = typeof m5?.candle_time === "string" ? ` on the 5m bar closing ${m5.candle_time.slice(11, 16)} UTC` : "";
  if (m5?.verified === true && m5[side] === true) return { fired: true, source: "5m", note: `a verified 5m Prophet ${dir > 0 ? "buy" : "sell"} confirmation${at}` };
  const c15 = confirmations?.chart_prophet_r38;
  if (c15?.[side] === true) return { fired: true, source: "15m", note: `a 15m Prophet ${dir > 0 ? "buy" : "sell"} confirmation` };
  if (c15?.[readySide] === true) return { fired: true, source: "15m", note: `a 15m Prophet ${dir > 0 ? "buy" : "sell"} setup is ready` };
  if (m15Snapshot?.huds?.r37_funnel?.fields?.[side] === true) return { fired: true, source: "15m", note: `a 15m Prophet ${dir > 0 ? "buy" : "sell"} confirmation` };
  if (m15Snapshot?.huds?.prophet?.fields?.[side] === true) return { fired: true, source: "15m", note: `a 15m Prophet ${dir > 0 ? "buy" : "sell"} confirmation` };
  if (m15Snapshot?.huds?.prophet?.fields?.[readySide] === true) return { fired: true, source: "15m", note: `a 15m Prophet ${dir > 0 ? "buy" : "sell"} setup is ready` };
  if (m5?.[side] === true && m5.verified !== true) return { fired: false, source: null, note: "the 5m confirmation is unverified, so it does not count" };
  return { fired: false, source: null, note: `waiting for a verified 5m (or 15m) Prophet ${dir > 0 ? "buy" : "sell"} confirmation` };
}

/**
 * Pure: the strategy from the four War Rooms (every agent's bias), News Daily, the 1H and 15m HUD
 * snapshots, the latest confirmations and the closed 1H and 15m bars.
 */
export function buildStrategy({ rooms = {}, news = null, macro = null, macroScore = null, mode = null, tradingMode = null, env = null, h1Snapshot = null, m15Snapshot = null, h4Snapshot = null, d1Snapshot = null, confirmations = null, h1Bars = [], m15Bars = [], h4Bars = [], d1Bars = [], w1Bars = [], h1Chain = null, calendar = null, releases = [], m5Price = null, now = Date.now() } = {}, params = STRATEGY_PARAMS) {
  const P = params === STRATEGY_PARAMS ? params : { ...STRATEGY_PARAMS, ...params };
  const LEAN = P.lean, MIN_RRR = P.min_rrr, MIN_CONFIDENCE = P.min_confidence;
  const layers = Object.fromEntries(["D1", "H4", "H1", "M15"].map((k) => [k, roomLayer(k, rooms[k], now)]));
  const usable = (k) => layers[k].available && !layers[k].stale;

  // 1. Trend: D1 and 4H. 2. Setup: 1H with the trend (or a strong 1H with a neutral trend and 15m).
  let tw = 0, ts = 0;
  for (const [k, w] of Object.entries(TREND_WEIGHTS)) if (usable(k)) { ts += layers[k].lean * w; tw += w; }
  const trend = tw ? ts / tw : null;
  const h1 = usable("H1") ? layers.H1.lean : null;
  const m15 = usable("M15") ? layers.M15.lean : null;
  let dir = 0, why;
  if (trend == null || h1 == null) why = "the trend or the 1-hour room is missing or stale";
  else if (Math.abs(trend) >= LEAN && h1 * Math.sign(trend) > -LEAN) { dir = Math.sign(trend); why = `the trend is ${word(trend)} and the 1-hour room does not lean against it`; }
  else if (Math.abs(trend) < LEAN && Math.abs(h1) >= P.strong_h1 && m15 != null && m15 * Math.sign(h1) >= LEAN) { dir = Math.sign(h1); why = `the trend is neutral, and the 1-hour and 15-minute rooms both lean ${h1 > 0 ? "bullish" : "bearish"}`; }
  else why = Math.abs(trend) >= LEAN ? `the trend is ${word(trend)} but the 1-hour room leans ${word(h1)}, against it` : `the trend is neutral and the lower rooms do not agree on a side`;
  if (dir && m15 != null && m15 * dir <= -LEAN) { why = `the trend and the 1-hour setup point ${dir > 0 ? "up" : "down"}, but the 15-minute room leans against them`; dir = 0; }

  // Alignment: how much of the weighted agent consensus points the trade's way (0..1).
  let aw = 0, as = 0;
  for (const [k, w] of Object.entries(ALIGNMENT_WEIGHTS)) if (usable(k)) { as += Math.max(0, layers[k].lean * (dir || 1)) * w; aw += w; }
  const alignment = dir && aw ? as / aw : 0;

  const atrH1 = atr(h1Bars);
  // The latest closed 5m close when the engine runs at a 5m close (owner decision 2026-11-08), else the 15m close.
  const price = [m5Price, m15Bars.at(-1)?.close, m15Snapshot?.huds?.interstellar_eyes?.fields?.close, h1Snapshot?.huds?.interstellar_eyes?.fields?.close].find(isNum) ?? null;
  // Key Level Agent (owner decision 2026-11-06): the zones where the key levels of every chart stack.
  const keyLevelReading = buildKeyLevels({
    snapshots: { "15": m15Snapshot, "60": h1Snapshot, "240": h4Snapshot, "1D": d1Snapshot },
    bars: { M15: m15Bars, H1: h1Bars, H4: h4Bars, D1: d1Bars, W1: w1Bars }, price, atrH1,
    // The Projection Agent's chart patterns (owner 2026-11-12); the released figures feed the event patterns.
    patterns: chartPatternsMode(env), events: releases
  });
  const levels = zoneLevels(keyLevelReading.zones);
  const zones = { ...(m15Snapshot?.huds?.aegis_footprint?.fields || {}), ...(m15Snapshot?.huds?.gabfx_price_action?.fields || {}) };
  const inZone = dir > 0 ? zones.in_bull_order_block === true || zones.in_bull_mitigation === true || zones.in_qm_buy === true || zones.in_rbs === true
    : dir < 0 ? zones.in_bear_order_block === true || zones.in_bear_mitigation === true || zones.in_qm_sell === true || zones.in_sbr === true : false;
  // The setup type at price (owner decision 2026-11-08): a pullback with the trend into liquidity,
  // or a stretched sweep into a QM or whale zone, read from the 15m chart plane. It counts as a
  // location with the trade, like a demand or supply zone.
  const setup = setupType({ dir, price, m15Plane: m15Snapshot?.chart_plane ?? null, h1Plane: h1Snapshot?.chart_plane ?? null, near: isNum(atrH1) ? P.near_atr * atrH1 : null });
  const setupNote = setup.type === "none" ? null : `${setup.type === "continuation_pullback" ? "a pullback with the trend" : "a stretched sweep into liquidity"}: ${setup.evidence.join(", ")}`;
  const plan = dir ? tradeLevels({ dir, price, levels, atrH1, inZone: inZone || setup.type !== "none", zoneNote: setupNote, nearAtr: P.near_atr }) : null;
  const { vetoes, cautions, supports } = riskChecks(dir, { h1Snapshot, m15Snapshot, news, macro, macroScore, mode: mode ?? tradingMode ?? env?.TRADING_MODE, env, calendar, now });
  const trigger = triggerOf(dir, { confirmations, m15Snapshot });

  let confidence = dir ? 0.6 * alignment + (plan?.at_level ? 0.15 : 0) + (trigger.fired ? 0.2 : 0) - 0.1 * cautions.length + 0.1 * supports.length - (Object.values(layers).some((l) => l.stale) ? 0.1 : 0) : 0;
  confidence = r2(Math.max(0, Math.min(0.95, confidence)));

  let state, decision = "WAIT", headline;
  const side = dir > 0 ? "long" : "short";
  if (!dir) { state = "NO_SETUP"; headline = `No setup: ${why}.`; }
  else if (vetoes.length) { state = "BLOCKED"; headline = `The ${side} setup is blocked: ${vetoes.join("; ")}.`; }
  else if (!plan) { state = "NO_LEVELS"; headline = `A ${side} bias, but the key levels or the 1-hour range are not available yet.`; }
  else if (!plan.at_level) { state = "SETUP_FORMING"; headline = `A ${side} setup is forming: wait for ${plan.entry_note} near ${fmt(plan.entry)}.`; }
  else if (!trigger.fired) { state = "SETUP_READY"; headline = `The ${side} setup is ready at ${fmt(plan.entry)} (${plan.entry_note}); ${trigger.note}.`; }
  else if (plan.rrr.tp2 < MIN_RRR) { state = "LOW_REWARD"; headline = `The ${side} trigger fired, but the reward to the final target is only ${plan.rrr.tp2}R (at least ${MIN_RRR}R is needed).`; }
  else if (confidence < MIN_CONFIDENCE) { state = "LOW_CONFIDENCE"; headline = `The ${side} trigger fired, but the agents' alignment is too weak (confidence ${Math.round(confidence * 100)}%).`; }
  else { state = "TRIGGERED"; decision = dir > 0 ? "BUY" : "SELL"; headline = `${decision}: ${trigger.note}, with the trend and setup aligned; ${plan.rrr.tp2}R to the final target.`; }

  const layerList = [
    { ...layers.D1, pass: dir ? layers.D1.lean * dir > -LEAN : null, note: `${layers.D1.agents} agents lean ${word(layers.D1.lean)}` },
    { ...layers.H4, pass: dir ? layers.H4.lean * dir > -LEAN : null, note: `${layers.H4.agents} agents lean ${word(layers.H4.lean)}` },
    { ...layers.H1, pass: dir ? layers.H1.lean * dir > -LEAN && !vetoes.length : null, note: `${layers.H1.agents} agents lean ${word(layers.H1.lean)}${vetoes.length ? "; " + vetoes[0] : ""}` },
    { ...layers.M15, pass: dir ? layers.M15.lean * dir > -LEAN && Boolean(plan?.at_level) : null, note: `${layers.M15.agents} agents lean ${word(layers.M15.lean)}; ${plan ? (plan.at_level ? plan.entry_note : "price is away from a level with the trade") : "no levels"}` },
    { key: "M5", ...LAYER.M5, available: Boolean(confirmations?.m5_prophet_r38), lean: null, side: null, agents: null, decision: null, bias: null, at: null, stale: false, pass: dir ? trigger.fired : null, note: trigger.note }
  ];

  return {
    version: STRATEGY_VERSION,
    decision, state, direction: dir > 0 ? "LONG" : dir < 0 ? "SHORT" : "NONE", confidence, headline,
    why_direction: why, alignment: r2(alignment), trend: r2(trend),
    price: r2(price), atr_h1: r2(atrH1),
    plan, min_rrr: MIN_RRR,
    setup: dir ? setup : { type: "none", evidence: [] },
    key_levels: keyLevelReading,
    layers: layerList, trigger, vetoes, cautions, supports,
    h1_chain: h1Chain ? { decision: h1Chain.decision ?? null, confidence: h1Chain.confidence ?? null, candle_key: h1Chain.candle_key ?? null } : null,
    advisory: "Advisory only: no orders are placed and no position size is given."
  };
}

async function seriesCandles(env, interval) {
  try {
    const r = JSON.parse((await env.SIGNAL_CACHE?.get?.(`market-data:v2:series:OANDA:XAUUSD|${interval}`)) || "null");
    return Array.isArray(r?.candles) ? r.candles : [];
  } catch { return []; }
}

/** A 5m context counts for the trigger while its bar closed at most this long ago. */
export const M5_LIVE_MAX_AGE_MS = 16 * 60_000;

/**
 * The live 5m inputs (owner decision 2026-11-08, "the confirmation is critical"): the Prophet R38
 * confirmation and the close of the latest closed 5m bar, from its context (the pull adapter sends it
 * at every 5m close), with VERIFIED only while the 5m Prophet implementation is parity-approved (verifiedM5Confirmation). Null when
 * no fresh context exists.
 */
export async function liveM5Inputs(env, { now = Date.now(), context = null } = {}) {
  let ctx = context;
  if (!ctx) { try { ctx = JSON.parse((await env?.SIGNAL_CACHE?.get?.("context:m5:latest")) || "null"); } catch { ctx = null; } }
  const t = Date.parse(String(ctx?.candle_time ?? ""));
  if (!ctx || !Number.isFinite(t) || now - t > M5_LIVE_MAX_AGE_MS || t > now + 60_000) return null;
  // The trigger is the Prophet R38 confirmation: verified while the 5m Prophet implementation is parity-approved.
  let verified = false;
  try { verified = (await verifiedM5Confirmation(env, ctx.candle_time)).verified === true; } catch { verified = false; }
  const last = Array.isArray(ctx.recent_bars) ? ctx.recent_bars.at(-1) : null;
  const recent = Array.isArray(ctx.recent_confirmations) ? ctx.recent_confirmations : [];
  const recentBuy = recent.some((c) => c?.buy_confirmed === true && now - Date.parse(c.candle_time) <= M5_LIVE_MAX_AGE_MS);
  const recentSell = recent.some((c) => c?.sell_confirmed === true && now - Date.parse(c.candle_time) <= M5_LIVE_MAX_AGE_MS);
  return {
    confirmation: { buy_confirmed: ctx.buy_confirmed === true || recentBuy, sell_confirmed: ctx.sell_confirmed === true || recentSell, verified, candle_time: new Date(t).toISOString() },
    price: isNum(last?.c) ? last.c : null,
    order_imbalance: orderImbalance(ctx),
    // The MT5 fallback (docs/RFC_MT5_FALLBACK.md): this 5m bar came from the broker while TradingView was down.
    feed: ctx.feed === "mt5_fallback" ? "mt5_fallback" : "tradingview"
  };
}

/** Reads the rooms, News Daily, the latest 1H and 15m HUD snapshots and bars: the strategy's inputs. */
export async function loadStrategyInputs(env, { now = Date.now(), m5Context = null } = {}) {
  const safe = async (fn) => { try { return await fn(); } catch { return null; } };
  const db = env.DB;
  const [d1, h4, h1, m15, news, h1Snapshot, m15Snapshot, h4Snapshot, d1Snapshot, h1Bars, m15Bars, h4Bars, d1Bars, w1Bars] = await Promise.all([
    safe(() => readTimeframeThread(db, "D1")), safe(() => readTimeframeThread(db, "H4")), safe(() => readTimeframeThread(db, "H1")),
    safe(() => readWarRoom(db)), safe(() => readNewsDaily(db)),
    safe(() => loadHudSnapshot(env, { timeframe: "60" })), safe(() => loadHudSnapshot(env, { timeframe: "15" })),
    safe(() => loadHudSnapshot(env, { timeframe: "240" })), safe(() => loadHudSnapshot(env, { timeframe: "1D" })),
    seriesCandles(env, "1h"), seriesCandles(env, "15m"), seriesCandles(env, "4h"), seriesCandles(env, "1D"), seriesCandles(env, "1W")
  ]);
  const live = await safe(() => liveM5Inputs(env, { now, context: m5Context }));
  return {
    rooms: { D1: d1, H4: h4, H1: h1, M15: m15 }, news, h1Snapshot, m15Snapshot, h4Snapshot, d1Snapshot,
    // The H1 confirmation from the latest 15m room; the 5m one from the latest closed 5m bar when fresh.
    confirmations: live ? { ...(m15?.confirmations ?? {}), m5_prophet_r38: live.confirmation } : (m15?.confirmations ?? null),
    m5Price: live?.price ?? null,
    m5Feed: live?.feed ?? null,
    // Enough closed bars for the ATR and the Key Level Agent's swings; the last week for its high and low.
    h1Bars: h1Bars.slice(-60), m15Bars: m15Bars.slice(-60), h4Bars: h4Bars.slice(-60), d1Bars: d1Bars.slice(-60), w1Bars: w1Bars.slice(-2),
    h1Chain: m15?.h1 ?? h1?.h1 ?? null,
    // The gated economic events around now (backlog 11.1); a missing calendar gives no caution.
    calendar: { events: await gatedEvents(env, { now }).catch(() => []) },
    // The released figures with a direction for gold: the events of the Projection Agent's event patterns.
    releases: (await safe(() => recentReleases(env, { now }))) ?? [],
    now
  };
}

/** The Projection Agent's chart patterns: CHART_PATTERNS_MODE = "on" (default) | "off". */
export function chartPatternsMode(env) {
  return String(env?.CHART_PATTERNS_MODE ?? "on").trim().toLowerCase() === "off" ? "off" : "on";
}

/** The strategy from the live inputs (GET /api/strategy). */
export async function readStrategy(env, { now = Date.now(), m5Context = null } = {}) {
  let mode = String(env?.TRADING_MODE ?? "").trim().toLowerCase();
  if (!["scalp", "intraday", "swing"].includes(mode)) {
    try {
      const v = String(await env?.SIGNAL_CACHE?.get?.("trading:mode") ?? "").trim().toLowerCase();
      if (["scalp", "intraday", "swing"].includes(v)) mode = v; else mode = "intraday";
    } catch { mode = "intraday"; }
  }
  return buildStrategy(await loadStrategyInputs(env, { now, m5Context }), { mode });
}
