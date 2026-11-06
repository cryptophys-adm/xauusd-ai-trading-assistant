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

export const STRATEGY_VERSION = "cryptophys.strategy-engine.v1";
export const TREND_WEIGHTS = Object.freeze({ D1: 0.5, H4: 0.5 });
export const ALIGNMENT_WEIGHTS = Object.freeze({ D1: 0.3, H4: 0.3, H1: 0.25, M15: 0.15 });
export const MIN_RRR = 1.5;
export const MIN_CONFIDENCE = 0.4;
const LEAN = 0.15; // a lean inside +-LEAN is neutral
const PERIOD_MS = { D1: 86_400_000, H4: 14_400_000, H1: 3_600_000, M15: 900_000 };
const LAYER = {
  D1: { label: "D1", role: "Macro trend" },
  H4: { label: "4H", role: "Intraday" },
  H1: { label: "1H", role: "Setup" },
  M15: { label: "15m", role: "Location" },
  M5: { label: "5m", role: "Trigger" }
};
const CAMARILLA_TF = { "15": "15m", "60": "1H", "240": "4H", D: "daily", W: "weekly" };

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
 * The key levels around price from the 1H and 15m HUD snapshots: Camarilla (15m, 1H, 4H, daily,
 * weekly), daily and weekly CPR, the 1H value area, and the low and high of the recent 15m bars.
 * Levels closer than `merge` are merged into one with both labels.
 */
export function keyLevels({ h1Snapshot = null, m15Snapshot = null, m15Bars = [], merge = 0 } = {}) {
  const out = [];
  // Major levels (Camarilla H4/H5/L4/L5, the pivots, the value area) are targets and obstacles;
  // minor ones (Camarilla H3/L3, the 15m swing) only anchor entries and stops.
  const add = (price, label, kind, major = true) => { if (isNum(price) && price > 0) out.push({ price, labels: [label], kind, major }); };
  for (const snap of [h1Snapshot, m15Snapshot]) {
    const cam = snap?.huds?.interstellar_eyes?.fields?.camarilla || {};
    for (const [tf, lv] of Object.entries(cam)) {
      if (!lv || !CAMARILLA_TF[tf]) continue;
      for (const k of ["h3", "h4", "h5", "l3", "l4", "l5"]) add(lv[k], `${CAMARILLA_TF[tf]} Camarilla ${k.toUpperCase()}`, "camarilla", !k.endsWith("3"));
    }
  }
  const chronos = h1Snapshot?.huds?.chronos_matrix?.fields || m15Snapshot?.huds?.chronos_matrix?.fields || {};
  for (const [name, cpr] of [["daily", chronos.daily_cpr], ["weekly", chronos.weekly_cpr]]) {
    if (!cpr) continue;
    add(cpr.pivot, `${name} pivot`, "cpr");
    add(cpr.tc, `${name} CPR top`, "cpr");
    add(cpr.bc, `${name} CPR bottom`, "cpr");
  }
  const fabio = h1Snapshot?.huds?.fabio_amt?.fields || {};
  add(fabio.poc, "1H point of control", "value");
  add(fabio.vah, "1H value area high", "value");
  add(fabio.val, "1H value area low", "value");
  const recent = (m15Bars || []).slice(-8).filter((b) => isNum(b?.high) && isNum(b?.low));
  if (recent.length >= 3) {
    add(Math.min(...recent.map((b) => b.low)), "15m swing low", "swing", false);
    add(Math.max(...recent.map((b) => b.high)), "15m swing high", "swing", false);
  }
  out.sort((a, b) => a.price - b.price);
  const merged = [];
  for (const l of out) {
    const last = merged.at(-1);
    if (last && merge > 0 && l.price - last.price < merge) { last.labels.push(...l.labels); last.price = (last.price + l.price) / 2; last.major = last.major || l.major; }
    else merged.push({ ...l, labels: [...l.labels] });
  }
  return merged.map((l) => ({ price: r2(l.price), label: [...new Set(l.labels)].join(" / "), kind: l.kind, major: l.major }));
}

/**
 * Entry, stop and targets for a direction (+1 long, -1 short) from the price, the key levels and
 * the 1H ATR. `atLevel` says whether price already sits at a level with the trade; otherwise the
 * planned entry is the nearest level with the trade (a pullback).
 */
export function tradeLevels({ dir, price, levels, atrH1, inZone = false }) {
  if (!dir || !isNum(price) || !isNum(atrH1) || atrH1 <= 0) return null;
  const near = 0.35 * atrH1, gap = 0.5 * atrH1, pad = 0.2 * atrH1;
  const against = levels.filter((l) => (dir > 0 ? l.price < price : l.price > price)).sort((a, b) => dir * (b.price - a.price));
  const nearest = against[0] ?? null;
  const atLevel = inZone || (nearest && Math.abs(price - nearest.price) <= near);
  const entry = atLevel ? price : nearest ? nearest.price : price;
  const entryNote = atLevel ? (inZone ? "price is inside a demand or supply zone with the trade" : `price holds at ${nearest.label}`) : nearest ? `a pullback to ${nearest.label}` : "price";
  // The stop: beyond the next level against the trade at least `gap` away, padded; 0.5 to 2.5 ATR.
  const stopLevel = levels.filter((l) => (dir > 0 ? l.price <= entry - gap : l.price >= entry + gap)).sort((a, b) => dir * (b.price - a.price))[0] ?? null;
  let stop = stopLevel ? stopLevel.price - dir * pad : null;
  let stopNote = stopLevel ? `beyond ${stopLevel.label}` : null;
  const risk0 = isNum(stop) ? Math.abs(entry - stop) : null;
  if (!isNum(risk0) || risk0 > 2.5 * atrH1) { stop = entry - dir * 1.5 * atrH1; stopNote = "1.5 times the 1H average range"; }
  const risk = Math.abs(entry - stop);
  // Targets: the next MAJOR levels with the trade (the obstacles price must clear), each at least
  // `gap` beyond the previous one.
  const ahead = levels.filter((l) => l.major !== false && (dir > 0 ? l.price >= entry + gap : l.price <= entry - gap)).sort((a, b) => dir * (a.price - b.price));
  const t1 = ahead[0] ?? null;
  const t2 = t1 ? ahead.find((l) => dir * (l.price - t1.price) >= gap) ?? null : null;
  const tp1 = t1 ? t1.price : entry + dir * 2 * risk;
  const tp2 = t2 ? t2.price : entry + dir * Math.max(3 * risk, Math.abs(tp1 - entry) + risk);
  const rr = (tp) => r2(Math.abs(tp - entry) / risk);
  return {
    at_level: Boolean(atLevel), entry: r2(entry), entry_note: entryNote,
    stop: r2(stop), stop_note: stopNote, risk: r2(risk),
    tp1: r2(tp1), tp1_note: t1 ? t1.label : "a 2R projection",
    tp2: r2(tp2), tp2_note: t2 ? t2.label : "a projection beyond the first target",
    rrr: { tp1: rr(tp1), tp2: rr(tp2) }
  };
}

/** Vetoes and cautions for a direction from the 1H and 15m HUD snapshots and the news. */
function riskChecks(dir, { h1Snapshot, m15Snapshot, news }) {
  const vetoes = [], cautions = [];
  const dm = h1Snapshot?.huds?.decision_matrix?.fields || {};
  const tm = h1Snapshot?.huds?.trade_management?.fields || {};
  const prophet = h1Snapshot?.huds?.prophet?.fields || {};
  // Owner decision 2026-11-06: a GMI and Prophet conflict and a closed GMI gate are cautions (each
  // -0.1 confidence), not vetoes; production 14:15 had a clear bearish consensus blocked by them.
  if (dm.conflict === true || tm.conflict === true) cautions.push("GMI and Prophet conflict on the 1-hour chart");
  if (dm.gate === -1 || tm.gate === -1) cautions.push("the GMI confluence gate is closed on the 1-hour chart");
  if (prophet.t_enc === 4) vetoes.push("Prophet signals a ruthless cut loss on the 1-hour chart");
  if (dir > 0 && dm.verdict === -3) vetoes.push("the GMI verdict is a strong sell on the 1-hour chart");
  if (dir < 0 && dm.verdict === 3) vetoes.push("the GMI verdict is a strong buy on the 1-hour chart");
  const chaos = [h1Snapshot, m15Snapshot].filter((s) => s?.huds?.kinetic_engine?.fields?.is_chaos === true).length;
  if (chaos === 2) cautions.push("both the 1-hour and the 15-minute regime read chaotic");
  if (dir && news?.tldr?.status === "ok" && dirOf(news.tldr.stance) === -dir && (news.tldr.confidence ?? 0) >= 0.6) cautions.push(`the last 24 hours of news lean ${String(news.tldr.stance).toLowerCase()}, against the trade`);
  return { vetoes, cautions };
}

/** The entry trigger in a direction: a verified 5m confirmation or the 15m Prophet confirmation. */
function triggerOf(dir, { confirmations, m15Snapshot }) {
  if (!dir) return { fired: false, source: null, note: "no direction to confirm" };
  const side = dir > 0 ? "buy_confirmed" : "sell_confirmed";
  const m5 = confirmations?.m5_prophet_r38;
  if (m5?.verified === true && m5[side] === true) return { fired: true, source: "5m", note: `a verified 5m Prophet ${dir > 0 ? "buy" : "sell"} confirmation` };
  if (m15Snapshot?.huds?.r37_funnel?.fields?.[side] === true) return { fired: true, source: "15m", note: `a 15m Prophet ${dir > 0 ? "buy" : "sell"} confirmation` };
  if (m5?.[side] === true && m5.verified !== true) return { fired: false, source: null, note: "the 5m confirmation is unverified, so it does not count" };
  return { fired: false, source: null, note: `waiting for a verified 5m (or 15m) Prophet ${dir > 0 ? "buy" : "sell"} confirmation` };
}

/**
 * Pure: the strategy from the four War Rooms (every agent's bias), News Daily, the 1H and 15m HUD
 * snapshots, the latest confirmations and the closed 1H and 15m bars.
 */
export function buildStrategy({ rooms = {}, news = null, h1Snapshot = null, m15Snapshot = null, confirmations = null, h1Bars = [], m15Bars = [], h1Chain = null, now = Date.now() } = {}) {
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
  else if (Math.abs(trend) < LEAN && Math.abs(h1) >= 0.3 && m15 != null && m15 * Math.sign(h1) >= LEAN) { dir = Math.sign(h1); why = `the trend is neutral, and the 1-hour and 15-minute rooms both lean ${h1 > 0 ? "bullish" : "bearish"}`; }
  else why = Math.abs(trend) >= LEAN ? `the trend is ${word(trend)} but the 1-hour room leans ${word(h1)}, against it` : `the trend is neutral and the lower rooms do not agree on a side`;
  if (dir && m15 != null && m15 * dir <= -LEAN) { why = `the trend and the 1-hour setup point ${dir > 0 ? "up" : "down"}, but the 15-minute room leans against them`; dir = 0; }

  // Alignment: how much of the weighted agent consensus points the trade's way (0..1).
  let aw = 0, as = 0;
  for (const [k, w] of Object.entries(ALIGNMENT_WEIGHTS)) if (usable(k)) { as += Math.max(0, layers[k].lean * (dir || 1)) * w; aw += w; }
  const alignment = dir && aw ? as / aw : 0;

  const atrH1 = atr(h1Bars);
  const price = [m15Bars.at(-1)?.close, m15Snapshot?.huds?.interstellar_eyes?.fields?.close, h1Snapshot?.huds?.interstellar_eyes?.fields?.close].find(isNum) ?? null;
  const levels = keyLevels({ h1Snapshot, m15Snapshot, m15Bars, merge: isNum(atrH1) ? 0.1 * atrH1 : 0 });
  const zones = { ...(m15Snapshot?.huds?.aegis_footprint?.fields || {}), ...(m15Snapshot?.huds?.gabfx_price_action?.fields || {}) };
  const inZone = dir > 0 ? zones.in_bull_order_block === true || zones.in_bull_mitigation === true || zones.in_qm_buy === true || zones.in_rbs === true
    : dir < 0 ? zones.in_bear_order_block === true || zones.in_bear_mitigation === true || zones.in_qm_sell === true || zones.in_sbr === true : false;
  const plan = dir ? tradeLevels({ dir, price, levels, atrH1, inZone }) : null;
  const { vetoes, cautions } = riskChecks(dir, { h1Snapshot, m15Snapshot, news });
  const trigger = triggerOf(dir, { confirmations, m15Snapshot });

  let confidence = dir ? 0.6 * alignment + (plan?.at_level ? 0.15 : 0) + (trigger.fired ? 0.2 : 0) - 0.1 * cautions.length - (Object.values(layers).some((l) => l.stale) ? 0.1 : 0) : 0;
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
    key_levels: levels.filter((l) => !isNum(price) || !isNum(atrH1) || Math.abs(l.price - price) <= 4 * atrH1),
    layers: layerList, trigger, vetoes, cautions,
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

/** Reads the rooms, News Daily, the latest 1H and 15m HUD snapshots and bars: the strategy's inputs. */
export async function loadStrategyInputs(env, { now = Date.now() } = {}) {
  const safe = async (fn) => { try { return await fn(); } catch { return null; } };
  const db = env.DB;
  const [d1, h4, h1, m15, news, h1Snapshot, m15Snapshot, h1Bars, m15Bars] = await Promise.all([
    safe(() => readTimeframeThread(db, "D1")), safe(() => readTimeframeThread(db, "H4")), safe(() => readTimeframeThread(db, "H1")),
    safe(() => readWarRoom(db)), safe(() => readNewsDaily(db)),
    safe(() => loadHudSnapshot(env, { timeframe: "60" })), safe(() => loadHudSnapshot(env, { timeframe: "15" })),
    seriesCandles(env, "1h"), seriesCandles(env, "15m")
  ]);
  return {
    rooms: { D1: d1, H4: h4, H1: h1, M15: m15 }, news, h1Snapshot, m15Snapshot,
    confirmations: m15?.confirmations ?? null, h1Bars: h1Bars.slice(-30), m15Bars: m15Bars.slice(-30),
    h1Chain: m15?.h1 ?? h1?.h1 ?? null, now
  };
}

/** The strategy from the live inputs (GET /api/strategy). */
export async function readStrategy(env, { now = Date.now() } = {}) {
  return buildStrategy(await loadStrategyInputs(env, { now }));
}
