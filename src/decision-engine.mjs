// Decision Engine (owner decisions 2026-11-09): ONE decision as the single source of truth, replacing
// the two decisions shown before (the H1 decision of the 1H room and the deterministic Global decision).
// "Hanya ada 1 decision engine sebagai ssot": every agent takes part, the timeframe rooms and the
// background and right-panel agents; the AI decides within guardrails; it runs at every 15m close.
//
// Tier 1, witnesses (each from its own data, unchanged): the D1, 4H, 1H and 15m War Rooms (every
// agent's bias, the room's conclusion), News Daily, the Macro War Room and the strategy engine (the
// multi-timeframe confluence with the Key Level Agent's zones, the 5m trigger, vetoes and cautions).
// Context, not weighted: the economic calendar (the event gate), the market regime, the cross-asset
// correlations and the previous decision.
//
// Tier 2, the AI Decision Council (one model call, the moderator model): the only reader across the
// timeframes. It weighs the witnesses and chooses the stance (BUY, SELL or WAIT), the entry type (at
// market or a limit at the planned pullback), the target (TP1 or TP2), its confidence and the reasons.
//
// Guardrails (deterministic; the council can never break them). A BUY or SELL needs, for its side:
//   fresh         the 15m and the 1H rooms are available and not stale;
//   quorum        more than half of the witnesses' weight leans that way (QUORUM_MIN);
//   no veto       none of the strategy engine's vetoes for that side;
//   levels        a plan from the Key Level Agent's zones (planForDirection), never a model price;
//   reward        at least MIN_RRR reward-to-risk to the chosen target;
//   confidence    the council's confidence is at least MIN_CONFIDENCE.
// The confirmation candle is the ENTRY TRIGGER, not a gate of the decision (owner 2026-11-11, "apa
// sebaiknya masuk sebagai penentu setup entry saja ?" -> yes): in 87 decisions from 2026-11-10 14:45 the
// 5m Prophet confirmation never printed at a 15m close, so the gate only ever passed through the rooms.
// Each side carries entry_trigger (a verified 5m or a 15m Prophet confirmation on that side); a market
// entry waits for it at execution (src/ea-signal.mjs, checked live), a limit at the key level does not.
// A council answer that breaks one becomes WAIT, with the reason kept (overruled). When the model
// fails or its answer is invalid, the deterministic fallback decides: the strategy engine's decision
// when its side passes every guardrail, otherwise WAIT. A high-impact USD event stays a caution
// (owner decision 2026-11-08); the EA itself does not enter during the event blackout.
//
// The decision is stored once per 15m bar (D1 engine_decisions, KV latest). It feeds the MT5 EA
// (src/ea-signal.mjs), Telegram, the Signal Ledger (source "decision") and the Nexus card. Kill
// switch: DECISION_ENGINE = "off" restores the H1 decision for the EA, Telegram and the ledger.
// The server never sizes a position; prices come only from the key-level plan.

import { loadStrategyInputs, buildStrategy, planForDirection, riskChecks, triggerOf, STRATEGY_PARAMS, atr } from "./strategy-engine.mjs";
import { buildGlobalConclusion } from "./global-conclusion.mjs";
import { readMacroRoom } from "./macro-room.mjs";
import { readCorrelations } from "./correlations.mjs";
import { loadRegimeMap, regimeAtClose } from "./market-regime.mjs";
import { eventRisk, cachedCalendar } from "./econ-calendar.mjs";
import { calendarOutlook, surpriseStrength, surprisePull } from "./calendar-agent.mjs";
import { calendarIntel } from "./econ-releases.mjs";
import { hudLevels } from "./hud-levels.mjs";
import { callBusModel, BUS_MAX_TOKENS } from "./multi-agent-bus.mjs";
import { naturalLanguageErrors, onlyNaturalLanguageErrors, NATURAL_LANGUAGE_CORRECTION } from "./natural-language.mjs";
import { shouldNotifyH1 } from "./h1-telegram.mjs";
import { fetchEffectiveDoctrine, formatDoctrineDirectives } from "./doctrine-consumer.mjs";
import { activeWitnessTuning } from "./witness-tuning.mjs";
import { collectNexusAnalytics } from "./nexus-analytics.mjs";
import { marketStructure } from "./market-structure.mjs";
import { learnedBlock, learnedKnowledgeEnabled } from "./learned-knowledge.mjs";
import { effectiveLearnedPack } from "./learned-live.mjs";
import { modelAdvice } from "./model-dataset.mjs";
import { shadowKnowledgeEnabled, shadowItems, planShadowCalls, runShadowCalls } from "./shadow-knowledge.mjs";
import { sessionOf } from "./outcome-scoring.mjs";
import { agentStatuses, agentContext, agentPlans, agentCatalog, priceActionReading, suspendedPatterns, slimPlan, AGENT_IDS, DEFAULT_AGENT } from "./strategy-agents.mjs";
import { readPlanLearning, contextOf } from "./plan-learning.mjs";

export const DECISION_ENGINE_VERSION = "cryptophys.decision-engine.v1";
export const SYMBOL = "OANDA:XAUUSD";
const M15_MS = 900_000;
/** Witness weights (sum 1). A missing or stale witness drops out and the rest renormalise. */
export const WITNESS_WEIGHTS = Object.freeze({ D1: 0.2, H4: 0.2, H1: 0.2, M15: 0.15, NEWS: 0.1, MACRO: 0.05, STRATEGY: 0.1 });
// CALENDAR (owner 2026-11-12: "horizon news release mempengaruhi bobot", 0.08): the economic calendar
// counts only inside a release's horizon. The other witnesses gave it 0.08 in proportion (the session's
// 0.02 floor kept), so outside a horizon, when CALENDAR drops out, their shares are the B-11 ones.
export const EXTENDED_WITNESS_WEIGHTS = Object.freeze({ D1: 0.1469, H4: 0.1469, H1: 0.1469, M15: 0.1103, NEWS: 0.0735, MACRO: 0.0367, STRATEGY: 0.0735, KEY_LEVELS: 0.0459, REGIME: 0.0459, TREND_TF: 0.0459, MACRO_DRIVERS: 0.0276, SESSION: 0.02, CALENDAR: 0.08 });
/**
 * The witness weights in force: the auto-tuned set the run loaded (env.DYNAMIC_WITNESS_WEIGHTS, from
 * src/witness-tuning.mjs) when present, else the B-11 set while GLOBAL_DECISION_WEIGHTED is on, else the base set.
 */
export function activeWitnessWeights(env) {
  if (env?.DYNAMIC_WITNESS_WEIGHTS && typeof env.DYNAMIC_WITNESS_WEIGHTS === "object") {
    return env.DYNAMIC_WITNESS_WEIGHTS;
  }
  return decisionWeightedEnabled(env) ? EXTENDED_WITNESS_WEIGHTS : WITNESS_WEIGHTS;
}
export function decisionWeightedEnabled(env) { return String(env?.GLOBAL_DECISION_WEIGHTED ?? "false").trim().toLowerCase() === "true"; }
export const QUORUM_MIN = 0.5;
export const LEAN = 0.15;
export const QUORUM_DECAY_PER_HOUR = 0.9;
export const MIN_RRR = STRATEGY_PARAMS.min_rrr;
export const MIN_CONFIDENCE = STRATEGY_PARAMS.min_confidence;
export const COUNCIL_DEADLINE_MS = 90_000;
/** The sweep decides a bar whose 15m room did not trigger the engine this long after its close. */
export const SWEEP_AFTER_MS = 4 * 60_000;
export const DECISION_LATEST_KEY = "decision-engine:latest";
/** The caution of a decision made on the MT5 fallback feed (docs/RFC_MT5_FALLBACK.md). */
export const MT5_FALLBACK_CAUTION = "Market data comes from the broker's MT5 bars because TradingView is down; the dollar index is computed from the broker's currency pairs, and news, the 10-year yield and USDT dominance are stale.";
export const TRADING_MODE_KEY = "trading:mode";
/** Runtime trading mode: env first, then KV (UI selector), default intraday. */
export async function tradingMode(env) {
  const envMode = String(env?.TRADING_MODE ?? "").trim().toLowerCase();
  if (["scalp", "intraday", "swing"].includes(envMode)) return envMode;
  try {
    const v = String(await env?.SIGNAL_CACHE?.get?.(TRADING_MODE_KEY) ?? "").trim().toLowerCase();
    if (["scalp", "intraday", "swing"].includes(v)) return v;
  } catch { /* ignore */ }
  return "intraday";
}
/**
 * A person sets the trading mode (owner 2026-11-13: "ya, kerjakan semua"): only through the Omega Worker's
 * POST /api/trading-mode (a signed-in person, same origin), never a GET. A server TRADING_MODE pins the mode,
 * and then the stored one has no effect, so the change is refused rather than silently ignored.
 */
export const TRADING_MODES_LIST = Object.freeze(["scalp", "intraday", "swing"]);
export async function setTradingMode(env, { mode, actor = "" } = {}) {
  const asked = String(mode ?? "").trim().toLowerCase();
  if (!TRADING_MODES_LIST.includes(asked)) return { ok: false, error: "mode must be scalp, intraday or swing" };
  if (!String(actor).trim()) return { ok: false, error: "a person makes this change" };
  const envMode = String(env?.TRADING_MODE ?? "").trim().toLowerCase();
  if (TRADING_MODES_LIST.includes(envMode)) return { ok: false, error: "pinned_by_server", mode: envMode };
  const previous = await tradingMode(env);
  if (previous === asked) return { ok: true, mode: asked, previous, changed: false };
  await env.SIGNAL_CACHE.put(TRADING_MODE_KEY, asked);
  return { ok: true, mode: asked, previous, changed: true };
}
export const DECISION_TELEGRAM_KEY = "telegram:decision-engine:last:v1";

/** The trading modes' thresholds (owner 2026-11-10). Unknown modes read as intraday. Doctrine: engine_thresholds. */
export const MODE_THRESHOLDS = Object.freeze({
  // Scalp (owner 2026-11-12: "untuk mode scalping jangan TP berdasarkan RRR tapi target di Key Level
  // terdekat", "Tanpa batas RRR"): the target is the nearest key level ahead, with no reward minimum.
  scalp: Object.freeze({ quorum_min: 0.45, min_rrr: 0, lean: 0.1, target: "nearest" }),
  intraday: Object.freeze({ quorum_min: 0.5, min_rrr: 1.5, lean: 0.15 }),
  swing: Object.freeze({ quorum_min: 0.6, min_rrr: 2.0, lean: 0.2 })
});
/** Pure: the mode and its thresholds. */
export function modeThresholds(mode) {
  const m = String(mode ?? "intraday").trim().toLowerCase();
  const key = Object.hasOwn(MODE_THRESHOLDS, m) ? m : "intraday";
  return { mode: key, ...MODE_THRESHOLDS[key] };
}

const STANCES = ["BUY", "SELL", "WAIT"];
const BIASES = ["BULLISH", "BEARISH", "NEUTRAL"];
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const clip = (s, n) => String(s ?? "").slice(0, n);
const dirOf = (s) => (s === "BUY" || s === "BULLISH" || s === "LONG" ? 1 : s === "SELL" || s === "BEARISH" || s === "SHORT" ? -1 : 0);
const sideOf = (v) => (!isNum(v) || Math.abs(v) < LEAN ? "NEUTRAL" : v > 0 ? "BULLISH" : "BEARISH");
const stanceOf = (dir) => (dir > 0 ? "BUY" : dir < 0 ? "SELL" : "WAIT");

/** The engine is on unless DECISION_ENGINE is "off". */
export function decisionEngineEnabled(env) {
  return String(env?.DECISION_ENGINE ?? "on").trim().toLowerCase() !== "off";
}

/** The decision key of the 15m bar that closed at `closeIso` (OANDA:XAUUSD:15:<open ms>), or null. */
export function decisionKeyFor(closeIso) {
  const t = Date.parse(String(closeIso ?? ""));
  if (!Number.isFinite(t)) return null;
  const close = Math.floor(t / M15_MS) * M15_MS;
  return `${SYMBOL}:15:${close - M15_MS}`;
}
/** The close (ms) of a decision key's bar. */
export const keyCloseMs = (key) => Number(String(key ?? "").split(":").pop()) + M15_MS;

// ---------------------------------------------------------------- witnesses and quorum

/**
 * Pure: the witness cards from the Global Conclusion's rows (the four rooms, News Daily, the Macro
 * room) and the strategy engine. Each: lean in [-1, 1] (the room's agents' confidence-weighted bias),
 * the witness's own decision and confidence, its summary, and whether it counts (available, not stale).
 */
export function witnessCards({ global = null, strategy = null, context = {}, env = null } = {}) {
  const rows = new Map((global?.timeframes || []).map((t) => [t.key, t]));
  // With GLOBAL_DECISION_WEIGHTED (owner 2026-11-10: on) every witness takes its B-11 weight, so the
  // extended witnesses hold their designed 20 % instead of being added on top of a full set.
  const W = activeWitnessWeights(env);
  const cards = [];
  for (const key of ["D1", "H4", "H1", "M15", "NEWS", "MACRO"]) {
    const t = rows.get(key);
    const lean = isNum(t?.lean) ? r2(t.lean) : null;
    cards.push({
      key, label: t?.label ?? key, role: t?.role ?? null, weight: W[key],
      available: Boolean(t?.available) && lean != null, stale: Boolean(t?.stale), lean, side: sideOf(lean),
      decision: t?.action ?? null, confidence: isNum(t?.confidence) ? r2(t.confidence) : null, summary: clip(t?.summary, 400) || null, at: t?.at ?? null
    });
  }
  const dir = dirOf(strategy?.direction);
  const sLean = strategy ? r2(dir * Math.max(isNum(strategy.alignment) ? strategy.alignment : 0, isNum(strategy.confidence) ? strategy.confidence : 0)) : null;
  cards.push({
    key: "STRATEGY", label: "Strategy", role: "multi-timeframe confluence", weight: W.STRATEGY,
    available: Boolean(strategy), stale: false, lean: sLean, side: sideOf(sLean),
    decision: strategy?.decision ?? null, state: strategy?.state ?? null, confidence: isNum(strategy?.confidence) ? strategy.confidence : null,
    summary: clip(strategy?.headline, 400) || null, at: null
  });
  if (decisionWeightedEnabled(env)) {
    // Owner 2026-11-10 ("buat witness baru benar-benar independen"): each extended witness reads its own
    // data (price against the Key Level Agent's zones, the 1H bars and sensors, the D1/4H/1H bars, the
    // dollar and yields), never the strategy engine's direction or a room's lean (independentWitnesses).
    const ind = context?.independent ?? {};
    const push = (key, label, role, w) => cards.push({ key, label, role, weight: W[key] ?? EXTENDED_WITNESS_WEIGHTS[key], available: isNum(w?.lean), stale: w?.stale === true, lean: isNum(w?.lean) ? w.lean : null, side: sideOf(w?.lean), decision: null, confidence: null, summary: w?.summary ?? null, at: null });
    push("KEY_LEVELS", "Key levels", "price vs zones", ind.key_levels);
    push("REGIME", "Regime", "1H trend quality", ind.regime);
    push("TREND_TF", "Trend TF", "price vs averages", ind.trend_tf);
    push("MACRO_DRIVERS", "Macro drivers", "dollar and yields", ind.macro_drivers);
    const cw = calendarWitness(context?.calendar ?? null);
    cards.push({ key: "CALENDAR", label: "Calendar", role: "release horizon", weight: W.CALENDAR ?? EXTENDED_WITNESS_WEIGHTS.CALENDAR, available: isNum(cw?.lean), stale: false, lean: isNum(cw?.lean) ? cw.lean : null, side: sideOf(cw?.lean), decision: null, confidence: null, summary: cw?.summary ?? null, at: null, phase: cw?.phase ?? null });
    const se = context?.session;
    const sessionText = se ? `${se.day} ${se.date} ${se.time_utc} UTC, market ${se.market_open ? `open, ${se.active.length ? se.active.join(" and ") : "between sessions"} (${se.liquidity} liquidity)` : "closed"}` : null;
    // A session has no direction: context only.
    cards.push({ key: "SESSION", label: "Session", role: "session clock", weight: W.SESSION ?? EXTENDED_WITNESS_WEIGHTS.SESSION, available: false, stale: false, lean: null, side: sideOf(null), decision: null, confidence: null, summary: sessionText, at: null });
  }
  return cards;
}
/** Pure: the weighted quorum of the counting witnesses: the score and each side's share of the weight. */
const _decayFactor = (c, now, decayPerHour) => {
  const t = Date.parse(String(c?.at ?? ""));
  if (!Number.isFinite(t)) return 1;
  const ageHours = Math.max(0, (now - t) / 3_600_000);
  const f = Number(decayPerHour);
  if (!Number.isFinite(f) || f <= 0 || f > 1) return 1;
  return Math.pow(f, ageHours);
};
export function quorumOf(cards, { now = Date.now(), decayPerHour = QUORUM_DECAY_PER_HOUR, analytics = null } = {}) {
  const counting = (cards || []).filter((c) => c.available && !c.stale && isNum(c.lean));
  const decayed = counting.map((c) => {
    let w = c.weight * _decayFactor(c, now, decayPerHour);
    // Apply agent-level compliance discount or stuck disqualification from Nexus Analytics & Intelligent Aether
    if (analytics?.quorum_weighting_input?.agent_weight_discounts?.[c.key] !== undefined) {
      w *= analytics.quorum_weighting_input.agent_weight_discounts[c.key];
    }
    return { ...c, _w: w };
  });
  const allWeight = decayed.reduce((s, c) => s + c._w, 0);
  if (!allWeight) return { score: null, bias: "NEUTRAL", long_share: 0, short_share: 0, neutral_share: 0, witnesses: 0, weight: 0, share_needed_above: 0.5 };
  // Neutral witnesses are excluded from the quorum denominator (G-06): only directional weight counts.
  const directional = decayed.filter((c) => Math.abs(c.lean) >= LEAN);
  const dirWeight = directional.reduce((s, c) => s + c._w, 0);
  const total = dirWeight > 0 ? dirWeight : allWeight;
  const share = (pred) => r2(directional.filter(pred).reduce((s, c) => s + c._w, 0) / total);
  const score = r2(decayed.reduce((s, c) => s + c._w * c.lean, 0) / allWeight);

  // Dynamic Quorum Consensus floor adapted via Nexus Analytics & Aether (execution friction + volatility)
  const baseShare = 0.5;
  const friction = analytics?.quorum_weighting_input?.friction_surcharge ?? 0;
  const vol = analytics?.quorum_weighting_input?.volatility_surcharge ?? 0;
  const shareNeededAbove = r2(clamp(baseShare + friction + vol, 0.45, 0.75));

  return {
    score, bias: sideOf(score),
    long_share: share((c) => c.lean >= LEAN), short_share: share((c) => c.lean <= -LEAN),
    neutral_share: r2((allWeight - dirWeight) / allWeight),
    witnesses: counting.length, weight: r2(allWeight),
    share_needed_above: shareNeededAbove
  };
}

// ---------------------------------------------------------------- composite sentiment
export function compositeSentiment({ news = null, macro = null, newsLean = null, macroScore = null } = {}) {
  let nl = isNum(newsLean) ? newsLean : null;
  if (nl == null && news) {
    if (isNum(news.lean)) nl = news.lean;
    else if (news.counts) {
      const c = news.counts;
      const b = Number(c.bullish) || 0, s = Number(c.bearish) || 0, n = Number(c.neutral) || 0;
      if (b + s + n) nl = (b - s) / (b + s + n);
    } else if (news?.tldr?.status === "ok") {
      nl = dirOf(news.tldr.stance) * (isNum(news.tldr.confidence) ? news.tldr.confidence : 0.5);
    }
  }
  let ms = isNum(macroScore) ? macroScore : null;
  if (ms == null && macro) {
    const mc = macro?.conclusion?.status === "ok" ? macro.conclusion : macro?.conclusion ?? null;
    if (mc && isNum(mc.confidence)) ms = dirOf(mc.bias ?? mc.stance ?? mc.action) * mc.confidence;
    else if (isNum(macro.lean)) ms = macro.lean;
    else if (isNum(macro.score)) ms = macro.score;
  }
  const parts = [];
  if (isNum(nl)) parts.push({ v: nl, w: 0.5 });
  if (isNum(ms)) parts.push({ v: ms, w: 0.5 });
  if (!parts.length) return null;
  const tw = parts.reduce((s, p) => s + p.w, 0);
  return r2(parts.reduce((s, p) => s + p.v * p.w, 0) / tw);
}

// ---------------------------------------------------------------- market context (owner 2026-11-09)
// "masukan sentiment, regime, macro drivers dan juga session (perlu ditambah hari tanggal dan market
// open/closed) menjadi pertimbangan global decision": the right panel's cards go to the council in
// `context.market`, give deterministic cautions, and a closed market is a guardrail.

/** New York clock hours of the sessions, as the Chronos Matrix (and the Nexus session clock) define them. */
export const SESSIONS = Object.freeze([
  Object.freeze({ name: "Tokyo", from: 19, to: 28 }),
  Object.freeze({ name: "London", from: 3, to: 12 }),
  Object.freeze({ name: "New York", from: 8, to: 17 })
]);
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function nyHour(ms) {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(ms));
    return Number(p.find((x) => x.type === "hour")?.value ?? 0) + Number(p.find((x) => x.type === "minute")?.value ?? 0) / 60;
  } catch { return (new Date(ms).getUTCHours() + 19) % 24; }
}

/** Pure: the session at `now`: day and date (UTC), market open or closed, the active sessions, the next change. */
export function sessionAt(now) {
  const d = new Date(now), h = nyHour(now);
  const open = marketOpenAt(now);
  const active = open ? SESSIONS.filter((x) => (h >= x.from && h < x.to) || (h + 24 >= x.from && h + 24 < x.to)).map((x) => x.name) : [];
  // The next weekly close (Friday 22:00 UTC) while open, or the reopen (Sunday 22:00 UTC) while closed.
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 22));
  while (next.getUTCDay() !== (open ? 5 : 0) || next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return {
    day: DAYS[d.getUTCDay()], date: d.toISOString().slice(0, 10), time_utc: d.toISOString().slice(11, 16), new_york_hour: Math.floor(h),
    market_open: open, active, overlap: active.length > 1,
    liquidity: !open ? "closed" : active.length > 1 ? "high" : active.length ? "normal" : "thin",
    next_change: { to: open ? "closed" : "open", at: next.toISOString(), minutes: Math.round((next.getTime() - now) / 60_000) }
  };
}

/** Pure: the regime of a HUD snapshot (the Nexus regime radar's sensors, 0 to 1) and the bar regime label. */
export function regimeOf(snapshot, label = null) {
  const r = snapshot ? hudLevels(snapshot).regime : null;
  const v = Object.fromEntries((r?.axes || []).map((a) => [a.key, a.value]));
  const character = v.trend == null ? null : v.trend > 0.6 ? "trending" : v.trend < 0.45 ? "mean-reverting" : "weakly trending";
  return { label: label ?? null, character, chaos: r?.chaos === true, stretch_z: isNum(r?.z) ? r2(r.z) : null, sensors: v };
}

/**
 * Pure: the macro drivers of the last 24 hours (News Daily's market context, as on the Nexus card) and
 * the cross-asset correlations; `lean` is the dollar's pull on gold (a falling dollar is bullish).
 */
export function macroDriversOf(context = null, correlations = null, now = Date.now()) {
  const pctOf = (k) => (isNum(context?.[k]?.change_24h_percent) ? r2(context[k].change_24h_percent) : null);
  const drivers = { gold: pctOf("gold"), dollar: pctOf("dollar"), oil: pctOf("oil"), usdt_dominance: pctOf("usdt") };
  // The dollar's pull (the lean, the gold-dollar link and the dollar caution) only while fresh, as MACRO_DRIVERS.
  const dollarStale = drivers.dollar != null && !macroInputFresh(context?.dollar?.as_of, now);
  if (dollarStale) drivers.dollar = null;
  const link = drivers.gold == null || drivers.dollar == null ? null : Math.sign(drivers.gold) === -Math.sign(drivers.dollar) ? "inverse (usual)" : "same way (the inverse link is off)";
  const lean = drivers.dollar == null ? null : r2(Math.max(-1, Math.min(1, -drivers.dollar / 0.5)));
  return { change_24h_percent: drivers, dollar_stale: dollarStale, dollar_as_of: context?.dollar?.as_of ?? null, gold_dollar_link: link, lean, cross_assets: (correlations?.assets || []).filter((a) => a.available).map((a) => ({ name: a.name, change_1d: a.change?.["1d"] ?? null, correlation_with_gold: a.correlation?.short ?? null })) };
}

/** Pure: the market sentiment: the witnesses' weighted lean, the composite (news and macro) and the 24-hour headlines. */
export function sentimentOf({ quorum = null, news = null, macro = null } = {}) {
  const c = news?.counts ?? {};
  return {
    weighted_lean: quorum?.score ?? null, bias: quorum?.bias ?? null, composite: compositeSentiment({ news, macro }),
    headlines: { bullish: Number(c.bullish) || 0, bearish: Number(c.bearish) || 0, neutral: Number(c.neutral) || 0 },
    news_tldr: news?.tldr?.status === "ok" ? { stance: news.tldr.stance ?? null, confidence: news.tldr.confidence ?? null } : null
  };
}

/** Pure: the right panel's market context: sentiment, regime (15m and 1H), macro drivers and the session. */
export function marketContextOf(loaded, quorum = null, now = Date.now()) {
  const { inputs = {}, correlations = null, regime = null, macro = null, calendar = null } = loaded || {};
  return {
    sentiment: sentimentOf({ quorum, news: inputs.news ?? null, macro }),
    calendar: calendarContextOf(calendar),
    regime: { m15: regimeOf(inputs.m15Snapshot ?? null), h1: regimeOf(inputs.h1Snapshot ?? null, typeof regime === "string" ? regime : null) },
    macro_drivers: macroDriversOf(inputs.news?.context ?? null, correlations, now),
    session: sessionAt(now)
  };
}

/**
 * Pure: the Calendar Agent's view for the council (owner 2026-11-10): the releases still inside their
 * horizon with actual, forecast, surprise and the rule's effect on gold, the learned horizon, and the
 * next events with their scenario. Null without a calendar.
 */
export function calendarContextOf(outlook) {
  if (!outlook) return null;
  const pick = (p) => ({ title: p.title, time: p.time, status: p.status, horizon_hours_before: p.horizon?.hours_before ?? null, horizon_hours_after: p.horizon?.hours_after ?? null, horizon_learned: p.horizon?.learned === true, ...(p.pre_release ? { pre_release: p.pre_release } : {}), ...(p.release ? { release: p.release } : {}), ...(p.history ? { history: p.history } : {}), scenario: p.text });
  return {
    summary: outlook.summary, consensus_lean: outlook.consensus_lean ?? 0, surprise_lean: outlook.surprise_lean ?? 0,
    released: (outlook.events || []).filter((p) => p.status === "released").map(pick),
    next: (outlook.events || []).filter((p) => p.status === "upcoming" || p.status === "imminent").slice(0, 3).map(pick)
  };
}

/**
 * Pure: the CALENDAR witness (owner 2026-11-12: "horizon news release mempengaruhi bobot"), from the
 * Calendar Agent's outlook. It leans only inside a release's horizon:
 *   - after a release, inside its (learned) horizon: the surprise's pull on gold (the rule's direction
 *     scaled by the surprise), times the strength of the kind's measured reaction (consensusStrength of
 *     its post-release hit rate; whole while unmeasured);
 *   - otherwise before a release, inside its (learned) pre-release horizon: the consensus lean, already
 *     scaled by the measured pre-release drift (src/calendar-agent.mjs).
 * Outside every horizon it has no lean (context; it drops out of the quorum).
 */
export function calendarWitness(outlook) {
  const events = outlook?.events || [];
  // A kind whose reaction gold has not followed reliably (strength 0) does not lean, like a held-back consensus.
  const parts = events.filter((p) => p.status === "released" && p.release?.gold_direction)
    .map((p) => ({ p, v: surprisePull(p.release) * surpriseStrength(p.history ? { horizon_hours: p.history.horizon_hours, hit_rate: p.history.hit_rate } : null) }))
    .filter((x) => x.v);
  if (parts.length) {
    const lean = r2(clamp1(parts.reduce((t, x) => t + x.v, 0) / parts.length));
    return { phase: "after", lean, summary: parts.map(({ p, v }) => `${p.title} released ${p.release.surprise_z != null ? `${p.release.surprise_z > 0 ? "+" : ""}${p.release.surprise_z} SD ` : ""}→ ${r2(v)} until ${String(p.horizon?.to ?? "").slice(11, 16)} UTC`).join("; ") };
  }
  const before = events.filter((p) => p.status === "imminent" && p.consensus_lean);
  if (before.length) {
    const lean = r2(clamp1(before.reduce((t, p) => t + p.consensus_lean, 0) / before.length));
    return { phase: "before", lean, summary: before.map((p) => `${p.title} at ${String(p.time).slice(11, 16)} UTC: consensus ${r2(p.consensus_lean)}${p.pre_release?.contrarian ? ` (contrarian: against ${Math.round(p.pre_release.against_rate * 100)}% over ${p.pre_release.contrarian_hours}h)` : p.pre_release?.horizon_hours > 0 ? ` (drift ${Math.round(p.pre_release.hit_rate * 100)}% over ${p.pre_release.horizon_hours}h)` : ""}`).join("; ") };
  }
  const imminent = events.filter((p) => p.status === "imminent");
  return { phase: imminent.length ? "before" : null, lean: null, summary: imminent.length ? `${imminent.map((p) => p.title).join(", ")} ahead, no consensus held` : "no release inside its horizon" };
}

/** Pure: the cautions the market context gives a side (never a block; the council weighs them). */
export function contextCautions(dir, market = null) {
  const out = [];
  const session = market?.session, h1 = market?.regime?.h1, m15 = market?.regime?.m15, macro = market?.macro_drivers;
  if (session?.market_open && session.liquidity === "thin") out.push("between the trading sessions: thin liquidity");
  if (session?.market_open && session.next_change?.to === "closed" && session.next_change.minutes <= 120) out.push(`the market closes for the weekend in ${session.next_change.minutes} minutes`);
  const z = h1?.stretch_z;
  if (isNum(z) && Math.abs(z) >= 2.5 && Math.sign(z) === dir) out.push(`price is stretched ${Math.abs(z)} standard deviations ${dir > 0 ? "above" : "below"} its 1-hour mean, in the trade's direction`);
  if (m15?.chaos && !h1?.chaos) out.push("the 15-minute regime reads chaotic");
  const dx = macro?.change_24h_percent?.dollar;
  if (isNum(dx) && Math.abs(dx) >= 0.3 && Math.sign(dx) === dir) out.push(`the dollar ${dx > 0 ? "rose" : "fell"} ${Math.abs(dx)}% in 24 hours, against a ${dir > 0 ? "long" : "short"} in gold`);
  // A release inside its horizon whose surprise points against the trade (owner 2026-11-10).
  for (const p of market?.calendar?.released || []) {
    const r = p.release;
    if (r && r.gold_direction && r.gold_direction === -dir && Math.abs(r.surprise_z ?? 0) >= 0.5) out.push(`${p.title} surprised ${r.surprise_z > 0 ? "+" : ""}${r.surprise_z} standard deviations, which by its rule ${r.gold_direction > 0 ? "lifts" : "weighs on"} gold, against a ${dir > 0 ? "long" : "short"}, inside its ${p.horizon_hours_after}-hour horizon`);
  }
  return out;
}

// ---------------------------------------------------------------- independent extended witnesses
const clamp1 = (v) => Math.max(-1, Math.min(1, v));
const closesOf = (bars) => (bars || []).filter((b) => isNum(b?.close));

/**
 * Pure: KEY_LEVELS from price against the Key Level Agent's zones only. Near support leans bullish
 * (a bounce), near resistance bearish, scaled to at most 0.6: 0.6 x (distance to resistance - distance
 * to support) / (sum). A zone at price counts as the side price holds (above its centre: support).
 */
export function keyLevelsLean({ price = null, zones = [], atrH1 = null } = {}) {
  if (!isNum(price)) return null;
  const zs = (zones || []).filter((z) => isNum(z?.low) && isNum(z?.high));
  const major = zs.some((z) => z.candidate) ? zs.filter((z) => z.candidate) : zs;
  const sup = major.filter((z) => z.role === "support" || (z.role === "at price" && price >= (z.price ?? (z.low + z.high) / 2)));
  const res = major.filter((z) => z.role === "resistance" || (z.role === "at price" && price < (z.price ?? (z.low + z.high) / 2)));
  const dSup = sup.length ? Math.min(...sup.map((z) => Math.max(0, price - z.high))) : null;
  const dRes = res.length ? Math.min(...res.map((z) => Math.max(0, z.low - price))) : null;
  if (dSup == null && dRes == null) return null;
  const unit = isNum(atrH1) && atrH1 > 0 ? atrH1 : null;
  const fmt = (d) => (unit ? `${r2(d / unit)} ATR` : r2(d));
  let lean;
  // Production 2026-11-10 15:00: price sat in a zone 0.09 ATR under resistance and the plain ratio gave
  // +0.6. Squeezed between two zones there is no edge: the gap counts in at least one 1H ATR.
  if (dSup != null && dRes != null) { const span = Math.max(dRes + dSup, unit ?? 0); lean = span > 0 ? 0.6 * (dRes - dSup) / span : 0; }
  else if (dSup != null) lean = unit && dSup <= unit ? 0.3 : 0;
  else lean = unit && dRes <= unit ? -0.3 : 0;
  const parts = [dSup != null ? `${fmt(dSup)} above support` : null, dRes != null ? `${fmt(dRes)} below resistance` : null].filter(Boolean);
  return { lean: r2(lean), summary: `price is ${parts.join(" and ")}` };
}

/**
 * Pure: REGIME from the 1H bars and sensors only: the direction of the last 20 closed 1H bars times
 * their efficiency (net move / path), full in a persistent market (Hurst at least 0.55), 0.6 in between,
 * 0.3 when mean-reverting (Hurst under 0.45); 0 in chaos.
 */
export function regimeLean({ h1Bars = [], regime = null, n = 20 } = {}) {
  const c = closesOf(h1Bars).slice(-(n + 1)).map((b) => b.close);
  if (c.length < 6) return null;
  const net = c.at(-1) - c[0];
  let path = 0;
  for (let i = 1; i < c.length; i++) path += Math.abs(c[i] - c[i - 1]);
  const er = path > 0 ? Math.abs(net) / path : 0;
  const hurst = regime?.sensors?.trend;
  const k = isNum(hurst) ? (hurst >= 0.55 ? 1 : hurst < 0.45 ? 0.3 : 0.6) : 0.6;
  const lean = regime?.chaos ? 0 : clamp1(Math.sign(net) * er * k);
  return { lean: r2(lean), summary: `${regime?.chaos ? "chaotic; " : ""}1H efficiency ${r2(er)} over ${c.length - 1} bars, ${net >= 0 ? "up" : "down"}${isNum(hurst) ? `, Hurst ${r2(hurst)}` : ""}` };
}

/**
 * Pure: TREND_TF from the closed bars only: on D1, 4H and 1H, (close - 20-bar mean) / (2 x 14-bar ATR),
 * each within [-1, 1], weighted 0.4, 0.35 and 0.25 (a missing timeframe drops out).
 */
export function trendTfLean({ d1Bars = [], h4Bars = [], h1Bars = [] } = {}) {
  const one = (bars) => {
    const c = closesOf(bars);
    if (c.length < 20) return null;
    const mean = c.slice(-20).reduce((t, b) => t + b.close, 0) / 20;
    const a = atr(c.slice(-30));
    return isNum(a) && a > 0 ? clamp1((c.at(-1).close - mean) / (2 * a)) : null;
  };
  const parts = [["D1", one(d1Bars), 0.4], ["4H", one(h4Bars), 0.35], ["1H", one(h1Bars), 0.25]].filter((p) => isNum(p[1]));
  if (!parts.length) return null;
  const w = parts.reduce((t, p) => t + p[2], 0);
  return { lean: r2(parts.reduce((t, p) => t + p[1] * p[2], 0) / w), summary: parts.map(([k, v]) => `${k} ${v >= 0 ? "+" : ""}${r2(v)}`).join(", ") };
}

/**
 * The macro drivers read 4-hour series (TVC:DXY and TVC:US10Y): a value counts while its last bar closed
 * within two bars (8 hours), the rule of the rooms (2 x the period). Owner 2026-11-12: "kerjakan perbaikan
 * cek kesegaran macro drivers". On 2026-11-11 the TradingView quota ran out at 13:05 UTC and the dollar's
 * 24-hour change of the last News Daily kept counting for hours. A value whose age is unknown counts as
 * stale: it cannot be vouched for.
 */
export const MACRO_DRIVERS_MAX_AGE_MS = 8 * 3_600_000;
export function macroInputFresh(iso, now = Date.now()) {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) && t <= now + 60_000 && now - t <= MACRO_DRIVERS_MAX_AGE_MS;
}

/**
 * Pure: MACRO_DRIVERS from the dollar and yields only (not the macro room, which is its own witness):
 * -0.6 x (DXY 24h % / 0.5) - 0.4 x (US 10-year 1-day change in bp / 10), within [-1, 1]. Each input
 * counts only while fresh (`macroInputFresh`); a stale one drops out and the other carries the lean; with
 * both stale the witness is stale and does not count.
 */
export function macroDriversLean({ newsContext = null, correlations = null, now = Date.now() } = {}) {
  const dollar = newsContext?.dollar;
  const dxyRaw = isNum(dollar?.change_24h_percent) ? dollar.change_24h_percent : null;
  const us10 = (correlations?.assets || []).find((a) => a.id === "us10y" && a.available);
  const bpRaw = isNum(us10?.change?.["1d"]) ? us10.change["1d"] : null;
  if (dxyRaw == null && bpRaw == null) return null;
  const dxy = dxyRaw != null && macroInputFresh(dollar?.as_of, now) ? dxyRaw : null;
  const bp = bpRaw != null && macroInputFresh(us10?.last_close_time, now) ? bpRaw : null;
  const staleText = [dxyRaw != null && dxy == null ? `DXY last bar ${dollar?.as_of ?? "of unknown age"}` : null, bpRaw != null && bp == null ? `US 10-year last bar ${us10?.last_close_time ?? "of unknown age"}` : null].filter(Boolean);
  if (dxy == null && bp == null) return { lean: null, stale: true, summary: `stale: ${staleText.join(", ")}` };
  const parts = [dxy != null ? [-dxy / 0.5, 0.6] : null, bp != null ? [-bp / 10, 0.4] : null].filter(Boolean);
  const w = parts.reduce((t, p) => t + p[1], 0);
  const asOf = [dxy != null ? dollar.as_of : null, bp != null ? us10.last_close_time : null].filter(Boolean).sort()[0] ?? null;
  const summary = [dxy != null ? `DXY ${dxy > 0 ? "+" : ""}${r2(dxy)}% in 24h` : null, bp != null ? `US 10-year ${bp > 0 ? "+" : ""}${r2(bp)} bp in a day` : null].filter(Boolean).join(", ");
  return { lean: r2(clamp1(parts.reduce((t, p) => t + clamp1(p[0]) * p[1], 0) / w)), stale: false, as_of: asOf, summary: staleText.length ? `${summary} (left out, stale: ${staleText.join(", ")})` : summary };
}

/** Pure: the four independent extended witnesses from the loaded inputs. */
export function independentWitnesses(loaded = {}, { now = Date.now() } = {}) {
  const { inputs = {}, strategy = null, correlations = null } = loaded || {};
  const h1Regime = regimeOf(inputs.h1Snapshot ?? null);
  const price = isNum(strategy?.price) ? strategy.price : closesOf(inputs.m15Bars).at(-1)?.close ?? closesOf(inputs.h1Bars).at(-1)?.close ?? null;
  const atrH1 = isNum(strategy?.atr_h1) ? strategy.atr_h1 : atr(closesOf(inputs.h1Bars));
  return {
    key_levels: keyLevelsLean({ price, zones: strategy?.key_levels?.zones ?? [], atrH1 }),
    regime: regimeLean({ h1Bars: inputs.h1Bars ?? [], regime: h1Regime }),
    trend_tf: trendTfLean({ d1Bars: inputs.d1Bars ?? [], h4Bars: inputs.h4Bars ?? [], h1Bars: inputs.h1Bars ?? [] }),
    macro_drivers: macroDriversLean({ newsContext: inputs.news?.context ?? null, correlations, now })
  };
}

// ---------------------------------------------------------------- guardrails

/**
 * Pure: the guardrails for one side (dir +1 long, -1 short) and the plan the side would trade.
 * `inputs` are the strategy engine's inputs (snapshots, news, calendar, confirmations).
 */
export function guardrailsFor(dir, { cards, quorum, strategy, inputs = {}, macro = null, now = Date.now(), env = null }) {
  // Adaptive thresholds per trading mode (Cloudflare Workers: env is threaded in; no process.env).
  const { mode: MODE, quorum_min: QUORUM_MIN, min_rrr: MIN_RRR, lean: LEAN } = modeThresholds(env?.TRADING_MODE);

  const side = stanceOf(dir);
  const card = (k) => (cards || []).find((c) => c.key === k);
  const checks = [];
  const add = (id, pass, detail) => checks.push({ id, pass: Boolean(pass), detail });
  // The session (owner 2026-11-09): no entry while the market is closed.
  const session = inputs.market?.session ?? sessionAt(now);
  add("market_open", session.market_open, `${session.day} ${session.date} ${session.time_utc} UTC: the market is ${session.market_open ? "open" : "closed"}`);
  const fresh = ["M15", "H1"].filter((k) => !(card(k)?.available && !card(k)?.stale));
  add("fresh", !fresh.length, fresh.length ? `the ${fresh.map((k) => card(k)?.label ?? k).join(" and ")} room ${fresh.length > 1 ? "are" : "is"} missing or stale` : "the 15m and 1H rooms are current");
  const share = dir > 0 ? quorum.long_share : quorum.short_share;
  const opposing = dir > 0 ? quorum.short_share : quorum.long_share;
  const scoreDir = dir * (quorum.score ?? 0);
  const quorumPass = share > QUORUM_MIN || (scoreDir >= LEAN && share > opposing);
  const quorumDetail = share > QUORUM_MIN
    ? `${Math.round((share || 0) * 100)}% of the witnesses' weight leans ${dir > 0 ? "bullish" : "bearish"} (more than ${Math.round(QUORUM_MIN * 100)}% needed)`
    : quorumPass
      ? `${Math.round((share || 0) * 100)}% of the witnesses' weight leans ${dir > 0 ? "bullish" : "bearish"} (meets directional lean threshold)`
      : `${Math.round((share || 0) * 100)}% of the witnesses' weight leans ${dir > 0 ? "bullish" : "bearish"} (more than ${Math.round(QUORUM_MIN * 100)}% needed)`;
  add("quorum", quorumPass, quorumDetail);
  // The entry trigger (owner 2026-11-11): recorded with the side, never a gate of the decision.
  let trigger = { fired: false, source: null, note: "no confirmation" };
  try { trigger = triggerOf(dir, { confirmations: inputs.confirmations ?? null, m15Snapshot: inputs.m15Snapshot ?? null }); } catch { /* none */ }
  const roomConfirmed = ["M15", "H1"].filter((k) => card(k)?.decision === side);
  const entryTrigger = { fired: trigger.fired === true, source: trigger.fired ? (trigger.source ?? null) : null, note: trigger.note ?? null, rooms_agree: roomConfirmed };
  let risk = { vetoes: [], cautions: [], supports: [] };
  try { risk = riskChecks(dir, { h1Snapshot: inputs.h1Snapshot ?? null, m15Snapshot: inputs.m15Snapshot ?? null, news: inputs.news ?? null, macro: macro ?? inputs.macro ?? null, calendar: inputs.calendar ?? null, mode: env?.TRADING_MODE ?? null, env, now }); } catch { /* none */ }
  add("no_veto", !risk.vetoes.length, risk.vetoes.length ? risk.vetoes.join("; ") : "no veto");
  const nearest = modeThresholds(env?.TRADING_MODE).target === "nearest";
  const plan = planForDirection(strategy, dir, { scalp: nearest });
  add("levels", Boolean(plan), plan ? `entry ${plan.entry_note}, stop ${plan.stop_note}` : "no key-level plan (price, 1H range or zones missing)");
  if (nearest) {
    // Scalp: the target is the nearest key level ahead (the plan's first target), whatever it pays.
    const atLevel = Boolean(plan) && isNum(plan.tp1) && plan.tp1_note !== TP1_PROJECTION;
    add("reward", atLevel, !plan ? "no plan" : atLevel ? `the target is the nearest key level, ${plan.tp1_note} (${plan.rrr?.tp1 ?? 0}R; scalp: no reward-to-risk minimum)` : "no key level ahead for the scalp target");
  } else {
    const best = plan ? Math.max(plan.rrr?.tp1 ?? 0, plan.rrr?.tp2 ?? 0) : 0;
    add("reward", Boolean(plan) && best >= MIN_RRR, plan ? `${best}R to the best target (at least ${MIN_RRR}R needed)` : "no plan");
  }
  const cautions = [...risk.cautions, ...contextCautions(dir, inputs.market ?? null)];
  return { side, allowed: checks.every((c) => c.pass), checks, plan, vetoes: risk.vetoes, cautions, supports: risk.supports ?? [], min_rrr: MIN_RRR, target_rule: nearest ? "nearest" : "rrr", entry_trigger: entryTrigger };
}

/**
 * Pure: the trade a side takes with the council's choices, inside the guardrails: a market entry only
 * when price is at the level (else a limit at the planned pullback), and the chosen target only when
 * it pays at least MIN_RRR (else the other one). Null when no target pays enough.
 */
export function tradeFor(side, plan, { entryType = "limit", target = "tp1", minRrr = MIN_RRR } = {}) {
  if (!plan || !(side === "BUY" || side === "SELL")) return null;
  // The trading mode's reward threshold (audit 2026-11-11: scalp passed its 1.2R guardrail, then
  // tradeFor still asked 1.5R and turned the trade into WAIT).
  const pays = (t) => isNum(plan[t]) && (plan.rrr?.[t] ?? 0) >= minRrr;
  // Quick Win Priority: Default target is "tp1" at the nearest key level. If the chosen target doesn't pay 1.5R, alternate.
  const t = pays(target) ? target : pays(target === "tp1" ? "tp2" : "tp1") ? (target === "tp1" ? "tp2" : "tp1") : null;
  if (!t) return null;
  const market = entryType !== "limit" && plan.at_level === true;
  return {
    side, action: market ? "ENTER_MARKET" : "ENTER_LIMIT", entry: plan.entry, stop: plan.stop, target: t, tp: plan[t],
    tp1: plan.tp1, tp2: plan.tp2, risk: plan.risk, rrr: plan.rrr?.[t] ?? null, rrr_all: plan.rrr ?? null,
    progressive_stop: plan.progressive_stop ?? null,
    entry_note: plan.entry_note, stop_note: plan.stop_note, tp_note: plan[`${t}_note`] ?? null, at_level: plan.at_level === true,
    // A market entry waits for the confirmation candle at execution; a limit at the key level waits for price.
    trigger_required: market,
    // The strategy agent whose plan this is, when it is not the default agent's.
    ...(plan.agent && plan.agent !== DEFAULT_AGENT ? { strategy: plan.agent, setup: plan.setup ?? null, ...(plan.pattern ? { pattern: plan.pattern } : {}) } : {})
  };
}

// ---------------------------------------------------------------- the council

export const COUNCIL_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    stance: { type: "string", enum: STANCES },
    bias: { type: "string", enum: BIASES },
    confidence: { type: "number" },
    entry_type: { type: "string", enum: ["market", "limit"] },
    target: { type: "string", enum: ["tp1", "tp2"] },
    // The strategy agent whose plan the trade takes (src/strategy-agents.mjs); optional: the default agent's otherwise.
    strategy: { type: "string", enum: [...AGENT_IDS] },
    summary: { type: "string" },
    reasons: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    weighed: { type: "array", items: { type: "string" } }
  },
  required: ["stance", "bias", "confidence", "entry_type", "target", "summary", "reasons", "risks", "weighed"]
});

const WITNESS_KEYS = ["D1", "H4", "H1", "M15", "NEWS", "MACRO", "STRATEGY"];

/** Pure: a side's live agents with a plan the guardrails accept, the default first: [[id, { status, plan }]]. */
export function liveAgentPlans(g) {
  const all = Object.entries(g?.plans || {}).filter(([id, a]) => a?.status === "live" && a.plan && (id === DEFAULT_AGENT || agentPlanPasses(a.plan, g)));
  return all.sort(([a], [b]) => (a === DEFAULT_AGENT ? -1 : b === DEFAULT_AGENT ? 1 : 0));
}

/** Pure: the reward guardrail on an agent's own plan: scalp needs a real level as the first target, the other modes MIN_RRR to the best target. */
export function agentPlanPasses(plan, g) {
  if (!plan || !isNum(plan.entry) || !isNum(plan.stop) || !isNum(plan.tp1)) return false;
  if (g?.target_rule === "nearest") return plan.tp1_note !== TP1_PROJECTION;
  return Math.max(plan.rrr?.tp1 ?? 0, plan.rrr?.tp2 ?? 0) >= (isNum(g?.min_rrr) ? g.min_rrr : MIN_RRR);
}

/** Pure: the council's evidence (the witnesses, the quorum, both sides' guardrails and plans, the context). */
export function councilEvidence({ barClose, cards, quorum, guards, context = {}, agentRecords = null, condition = null }) {
  const plan = (g) => (g.plan ? { entry: g.plan.entry, entry_note: g.plan.entry_note, at_level: g.plan.at_level, stop: g.plan.stop, stop_note: g.plan.stop_note, tp1: g.plan.tp1, tp1_note: g.plan.tp1_note, tp2: g.plan.tp2, tp2_note: g.plan.tp2_note, progressive_stop: g.plan.progressive_stop ?? null, reward_to_risk: g.plan.rrr } : null);
  // The strategies the council may choose from on a side: only when a live agent other than the default
  // sees its setup there (else the evidence is as before: one plan).
  const strategies = (g) => {
    const live = liveAgentPlans(g);
    if (live.length < 2) return null;
    const catalog = agentCatalog();
    // What each strategy earned on this system's own setups (the plan learner's replay, in R per setup),
    // overall and in the present market condition; null while it has no resolved setup.
    const record = (id) => {
      const r = (Array.isArray(agentRecords) ? agentRecords : []).find((x) => x?.agent === id);
      if (!r) return null;
      const here = (r.contexts || []).find((c) => c.context === condition) ?? null;
      return { setups: r.setups, mean_r_per_setup: r.mean_r, filled: r.fill_rate, reached_target: r.target_rate, in_this_market_condition: here ? { setups: here.setups, mean_r_per_setup: here.mean_r } : null };
    };
    // A pattern family's plan names its pattern: that pattern's own trades here, when it has any.
    const patternRecord = (id, pattern) => {
      const x = pattern ? ((Array.isArray(agentRecords) ? agentRecords : []).find((r) => r?.agent === id)?.patterns || []).find((q) => q.pattern === pattern) : null;
      return x ? { setups: x.setups, mean_r_per_setup: x.mean_r } : null;
    };
    return live.map(([id, a]) => ({ id, name: catalog.find((c) => c.id === id)?.label ?? id, made_for: catalog.find((c) => c.id === id)?.fits ?? null, setup: a.plan.setup ?? null, record: record(id), ...(a.plan.pattern ? { this_pattern_record: patternRecord(id, a.plan.pattern) } : {}), plan: plan({ plan: a.plan }) }));
  };
  const side = (g) => ({ allowed: g.allowed, checks: g.checks.map((c) => ({ check: c.id, pass: c.pass, detail: c.detail })), entry_trigger: g.entry_trigger ? { fired: g.entry_trigger.fired, note: g.entry_trigger.note } : null, plan: plan(g), ...(strategies(g) ? { strategies: strategies(g) } : {}), vetoes: g.vetoes, cautions: g.cautions, supports: g.supports ?? [] });
  return {
    bar_close: barClose,
    witnesses: cards.map((c) => ({ key: c.key, name: c.label, role: c.role, weight: c.weight, counts: c.available && !c.stale, lean: c.lean, own_decision: c.decision, state: c.state ?? undefined, confidence: c.confidence, summary: c.summary })),
    // Production 2026-11-09 13:15: the council read the weighted lean (0.42) as the quorum. The quorum
    // is the share of weight leaning one way; the lean is only its strength.
    quorum: { bullish_share: quorum.long_share, bearish_share: quorum.short_share, neutral_share: quorum.neutral_share, share_needed_above: QUORUM_MIN, weighted_lean: quorum.score, lean_bias: quorum.bias },
    long: side(guards.long), short: side(guards.short),
    // The Projection Agent's reading (chart patterns, the way each broke, its record on gold), given with
    // the strategies it helps to choose from.
    ...((strategies(guards.long) || strategies(guards.short)) && Array.isArray(guards.price_action) && guards.price_action.length ? { price_action: guards.price_action } : {}),
    context
  };
}

/** The learned notes' consumer id of the council (Aether items address it in `audience.agents`). */
export const COUNCIL_AGENT = "council";

/**
 * Pure: the council's messages. `learned` is the bundled learned notes' block for the council (Aether A9,
 * owner 2026-11-13: "strengthen autonomous learning & knowledge looping"), or null.
 */
export function councilMessages(evidence, { learned = null } = {}) {
  const doctrineSnippet = (evidence?.context?.doctrine ? `\n\n${evidence.context.doctrine}` : "") + (learned ? `\n\n${learned}` : "");
  const system = [
    "You are the AI Decision Council of the XAUUSD system: the ONE decision for the trader, made at the close of each 15-minute bar.",
    "Witnesses each speak from their own data: the D1, 4H, 1H and 15m War Rooms (their agents' bias as a lean from -1 bearish to +1 bullish, and the room's own decision), News Daily, the Macro War Room and the strategy engine (the multi-timeframe confluence, the key-level plan and the entry trigger). You are the only one who reads across them.",
    "Decide the stance: BUY, SELL or WAIT. A BUY is possible only when long.allowed is true, a SELL only when short.allowed is true; otherwise the guardrails turn it into WAIT, so choose WAIT yourself and say which check is missing. WAIT is always allowed.",
    `The quorum guardrail is already evaluated in long.checks and short.checks: it compares quorum.bullish_share or quorum.bearish_share (the share of the witnesses' weight leaning that way) with quorum.share_needed_above. quorum.weighted_lean is the strength of the lean from -1 to +1, not the quorum; never compare it with ${QUORUM_MIN}.`,
    "context.market.calendar is the Calendar Agent: each release still inside its horizon with its actual against the forecast, the surprise in standard deviations, the rule's effect on gold (gold_direction +1 up, -1 down) and, when enough past releases are measured, the learned horizon and how often gold followed the rule. A large surprise inside its horizon outweighs a weak technical lean; a release gold has not followed reliably weighs less. Before a release (owner 2026-11-12), pre_release says how often gold drifted the consensus way in the hours before past releases of the kind and the consensus lean's strength from it (contrarian: gold drifted against it significantly, so the lean is the other way); horizon_hours_before is the learned window. The CALENDAR witness weighs the calendar only inside a release's horizon (the consensus before, the surprise after) and is out of the quorum otherwise.",
    "context.market holds the right panel's cards: the market sentiment (the witnesses' weighted lean, the news and macro composite, the 24-hour headlines), the regime of the 15m and 1H charts (trending or mean-reverting, chaos, stretch), the macro drivers (gold, the dollar, oil and USDT dominance over 24 hours, the gold-dollar link, cross-asset correlations) and the session (day, date, market open or closed, the active sessions and their liquidity, the next close or open). Weigh them: they confirm or weaken the witnesses and explain the cautions.",
    "Weigh the witnesses by their weight and by how well their reasoning holds up; the higher timeframes carry the trend, the 15m and 1H rooms carry the setup, the strategy engine carries location and trigger. Cautions (an event, conflicts, chaotic regime) lower your confidence.",
    "The confirmation candle (a verified 5m or a 15m Prophet confirmation, in long.entry_trigger and short.entry_trigger) is the entry trigger, not a condition of your stance: decide the side from the witnesses inside the guardrails. A market entry waits for that candle before it is executed; a limit entry at the key level waits only for price, so prefer 'limit' while entry_trigger has not fired.",
    "Prioritize target 'tp1' (structural quick win at the nearest strong key level / liquidity pool) to avoid prolonged floating duration risk. Use 'limit' entry at the key level pullback rather than chasing market momentum. A target needs at least 1.5R.",
    `confidence is 0 to 1; below ${MIN_CONFIDENCE} a BUY or SELL becomes WAIT. bias is where the weight of the evidence leans (BULLISH, BEARISH or NEUTRAL), even when the stance is WAIT.`,
    "Never invent a price: the levels come only from the plans in the evidence. Never mention position size. Write summary, reasons and risks in plain sentences a trader would write: no field names, no words joined by underscores or dots, no key=value. The summary starts with the stance and the bias, for example \"Decision WAIT, bias bullish: ...\". Give one to four reasons and up to three risks. In weighed, list the witness keys you relied on most.",
    ...(evidence?.long?.strategies || evidence?.short?.strategies ? ["A side may list strategies: the strategy agents that see their own setup on the chart now, each with what it is made for (made_for), the setup it sees and its own plan. price_action, when present, is the Projection Agent's reading of the charts: the chart patterns it sees on the 15m, 1H and 4H charts, whether each broke out and which way, and how often that pattern reached its target on gold. Choose the strategy whose made_for matches that price action and what the witnesses describe (the regime, the structure, how price came to the level) and return its id in strategy; the trade then takes that agent's entry, stop and targets. Each strategy's record is what it earned on this system's own past setups, in R per setup, overall and in the present market condition: weigh it with the number of setups behind it, and treat a strategy without a record as untested. Without a clear match keep the first one. The side and the guardrails are decided as before; a strategy only changes where the trade enters, stops and targets."] : []),
    ...(evidence?.context?.model ? ["context.model is the platform's own model, trained on this system's past decisions and connected only after it beat the base rate on decisions it had not seen: long_target_first and short_target_first are its chances for each side against their base rates. Weigh it like a witness; it never overrides the guardrails or the levels."] : []),
    "Return only the JSON object."
  ].join(" ") + doctrineSnippet;
  return [
    { role: "system", content: system },
    { role: "user", content: `EVIDENCE:\n${JSON.stringify(evidence)}` }
  ];
}

/** Pure: the council answer's errors (empty when valid). Normalises the answer in place. */
export function validateCouncil(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return { valid: false, errors: ["not_an_object"] };
  const errors = [];
  o.stance = String(o.stance ?? "").toUpperCase();
  o.bias = String(o.bias ?? "").toUpperCase();
  if (!STANCES.includes(o.stance)) errors.push("stance_invalid");
  if (!BIASES.includes(o.bias)) errors.push("bias_invalid");
  if (!isNum(o.confidence) || o.confidence < 0 || o.confidence > 1) errors.push("confidence_invalid");
  if (!["market", "limit"].includes(o.entry_type)) o.entry_type = "limit";
  if (!["tp1", "tp2"].includes(o.target)) o.target = "tp1";
  if (!AGENT_IDS.includes(o.strategy)) delete o.strategy;
  if (typeof o.summary !== "string" || !o.summary.trim()) errors.push("summary_missing");
  if (!Array.isArray(o.reasons) || !o.reasons.length || o.reasons.some((r) => typeof r !== "string")) errors.push("reasons_invalid");
  if (!Array.isArray(o.risks) || o.risks.some((r) => typeof r !== "string")) o.risks = [];
  o.weighed = Array.isArray(o.weighed) ? o.weighed.map((k) => String(k).toUpperCase()).filter((k) => WITNESS_KEYS.includes(k)) : [];
  if (!errors.length) errors.push(...naturalLanguageErrors([o.summary, ...o.reasons, ...o.risks].join(" ")));
  return { valid: errors.length === 0, errors };
}

/**
 * Pure: the final decision from the council's answer (or null) and the guardrails. The council's
 * BUY or SELL stands only inside the guardrails; without a valid answer the fallback decides.
 */
export function decide({ answer = null, guards, strategy = null, quorum }) {
  const pick = (dir) => (dir > 0 ? guards.long : guards.short);
  let source = answer ? "council" : "fallback";
  let stance, confidence, entryType, target, overruled = null, chosen = null;
  if (answer) {
    stance = answer.stance; confidence = r2(Math.max(0, Math.min(0.95, answer.confidence)));
    entryType = answer.entry_type; target = answer.target; chosen = answer.strategy ?? null;
  } else {
    // Fallback: the strategy engine's decision when its side passes every guardrail.
    const sd = dirOf(strategy?.decision);
    stance = sd ? strategy.decision : "WAIT";
    confidence = isNum(strategy?.confidence) ? r2(strategy.confidence) : 0;
    entryType = "limit"; target = "tp1";
  }
  const dir = dirOf(stance);
  let trade = null;
  if (dir) {
    const g = pick(dir);
    if (!g.allowed) overruled = { by: "guardrail", wanted: stance, failed: g.checks.filter((c) => !c.pass).map((c) => ({ check: c.id, detail: c.detail })) };
    else if (confidence < MIN_CONFIDENCE) overruled = { by: "guardrail", wanted: stance, failed: [{ check: "confidence", detail: `confidence ${Math.round(confidence * 100)}% is below ${Math.round(MIN_CONFIDENCE * 100)}%` }] };
    else {
      const minRrr = isNum(g.min_rrr) ? g.min_rrr : MIN_RRR;
      // The council's strategy agent, when it is live and its plan passes the reward guardrail; else the
      // default agent's plan, as before the agents.
      const agent = chosen && chosen !== DEFAULT_AGENT ? liveAgentPlans(g).find(([id]) => id === chosen)?.[1] ?? null : null;
      // Scalp: always the nearest key level (the plan's first target), whatever the council chose.
      const opts = { entryType, target: g.target_rule === "nearest" ? "tp1" : target, minRrr };
      trade = (agent ? tradeFor(stance, agent.plan, opts) : null) ?? tradeFor(stance, g.plan, opts);
      if (!trade) overruled = { by: "guardrail", wanted: stance, failed: [{ check: "reward", detail: `no target pays ${minRrr}R` }] };
    }
    if (overruled) stance = "WAIT";
  }
  const bias = answer?.bias ?? quorum.bias;
  return { stance, bias, confidence, source, trade, overruled };
}

/** Pure: the fallback's text when the council did not answer. */
function fallbackText({ stance, quorum, strategy, overruled, reason }) {
  const b = String(quorum.bias || "NEUTRAL").toLowerCase();
  const why = overruled ? `the strategy's ${overruled.wanted} was held back (${overruled.failed.map((f) => f.detail).join("; ")})` : strategy?.headline ? strategy.headline.replace(/\.$/, "") : "no witness set gives a trade";
  return {
    summary: `Decision ${stance}, bias ${b}: ${why}. The council did not answer (${reason}), so the deterministic fallback decided.`,
    reasons: [`The witnesses' weighted lean is ${quorum.score == null ? "unknown" : `${quorum.score > 0 ? "+" : ""}${Math.round(quorum.score * 100)}`}.`, ...(strategy?.headline ? [`Strategy engine: ${strategy.headline}`] : [])].slice(0, 4),
    risks: []
  };
}

// ---------------------------------------------------------------- inputs, storage, run

/** Reads every witness and the context. Never throws for a missing source. */
export async function loadDecisionInputs(env, { now = Date.now() } = {}) {
  const safe = async (fn, fb = null) => { try { return await fn(); } catch { return fb; } };
  const inputs = await loadStrategyInputs(env, { now });
  const strategy = await safe(async () => buildStrategy(inputs));
  const macro = await safe(() => readMacroRoom(env.DB, { now }));
  const { D1: d1, H4: h4, H1: h1, M15: m15 } = inputs.rooms;
  const global = buildGlobalConclusion({ d1, h4, h1, m15, news: inputs.news, macro, h1Decision: inputs.h1Chain, strategy, now });
  const correlations = await safe(() => readCorrelations(env, { now }));
  const regime = await safe(async () => regimeAtClose(await loadRegimeMap(env, "60"), now));
  // The Calendar Agent with the released values, surprises and learned horizons (owner 2026-11-10).
  const calendar = await safe(async () => calendarOutlook((await cachedCalendar(env))?.events || [], now, { intel: await calendarIntel(env, { now }) }));
  const analytics = await safe(async () => collectNexusAnalytics(env, { now, days: 30 }));
  return { inputs, strategy, macro, global, correlations, regime, calendar, analytics };
}

/** Pure: the context the council reads beside the witnesses (no weights). */
export function councilContext({ inputs = {}, correlations = null, regime = null, previous = null, market = null, now = Date.now() }) {
  const risk = eventRisk(inputs.calendar?.events || [], now);
  const m5 = inputs.confirmations?.m5_prophet_r38 ?? null;
  return {
    // The 5m entry trigger (the Prophet R38 confirmation of the latest closed 5m bar, when fresh).
    m5_trigger: m5 ? { buy_confirmed: m5.buy_confirmed === true, sell_confirmed: m5.sell_confirmed === true, verified: m5.verified === true, candle_time: m5.candle_time ?? null } : null,
    events: { active: risk.active.map((e) => ({ title: e.title, time: e.time })), next: risk.next.slice(0, 3).map((e) => ({ title: e.title, time: e.time })) },
    regime_1h: regime ?? null,
    cross_assets: (correlations?.assets || []).filter((a) => a.available).map((a) => ({ name: a.name, change_1d: a.change?.["1d"] ?? null, correlation_with_gold: a.correlation?.short ?? null })),
    // The right panel's cards (owner 2026-11-09): sentiment, regime, macro drivers and the session.
    market: market ?? { session: sessionAt(now), macro_drivers: macroDriversOf(inputs.news?.context ?? null, correlations, now) },
    h1_decision: inputs.h1Chain ? { decision: inputs.h1Chain.decision ?? null, confidence: inputs.h1Chain.confidence ?? null } : null,
    previous_decision: previous ? { stance: previous.stance, confidence: previous.confidence, at: previous.bar_close } : null
  };
}

export const DECISION_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS engine_decisions (
    decision_key TEXT PRIMARY KEY,
    bar_close TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    stance TEXT NOT NULL CHECK (stance IN ('BUY', 'SELL', 'WAIT')),
    confidence REAL,
    source TEXT NOT NULL,
    decision_json TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_engine_decisions_close ON engine_decisions(bar_close)"
];
let schemaReady = false;
export function resetDecisionSchemaCacheForTests() { schemaReady = false; }
export async function ensureDecisionSchema(db) {
  if (schemaReady) return;
  for (const sql of DECISION_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}

/** The latest stored decision (KV first, then D1), or null. Never throws. */
export async function readLatestDecision(env) {
  try { const v = JSON.parse((await env?.SIGNAL_CACHE?.get?.(DECISION_LATEST_KEY)) || "null"); if (v?.decision_key) return v; } catch { /* D1 */ }
  try {
    await ensureDecisionSchema(env.DB);
    const row = await env.DB.prepare("SELECT decision_json FROM engine_decisions ORDER BY bar_close DESC LIMIT 1").first();
    return row ? JSON.parse(row.decision_json) : null;
  } catch { return null; }
}

/** The stored decisions of the last `limit` bars, newest first. */
export async function readDecisions(env, { limit = 24 } = {}) {
  await ensureDecisionSchema(env.DB);
  const rows = (await env.DB.prepare("SELECT decision_json FROM engine_decisions ORDER BY bar_close DESC LIMIT ?").bind(Math.max(1, Math.min(200, Number(limit) || 24))).all()).results || [];
  return rows.map((r) => { try { return JSON.parse(r.decision_json); } catch { return null; } }).filter(Boolean);
}

/** Pure: the Telegram text of a decision (prices only from the key-level plan; never a size). */
export function decisionMessage(d) {
  const t = d.trade;
  const px = (v) => (isNum(v) ? v.toFixed(2) : "n/a");
  return [
    `XAUUSD DECISION ENGINE · ${d.stance}`,
    `15m bar closed ${String(d.bar_close).slice(11, 16)} UTC · bias ${String(d.bias).toLowerCase()} · confidence ${Math.round((d.confidence || 0) * 100)}% · ${d.source === "council" ? "AI council" : "fallback"}`,
    ...(t ? [`${t.action === "ENTER_MARKET" ? "Market" : "Limit"} ${t.side} at ${px(t.entry)}, stop ${px(t.stop)}, target ${t.target.toUpperCase()} ${px(t.tp)} (${t.rrr}R)`] : []),
    // The strategy agent the council chose, when it is not the default agent's plan.
    ...(t?.strategy ? [`Strategy: ${agentCatalog().find((a) => a.id === t.strategy)?.label ?? t.strategy}${t.setup ? ` (${t.setup})` : ""}`] : []),
    clip(d.summary, 700),
    ...(d.overruled ? [`Guardrail: ${d.overruled.wanted} held back (${d.overruled.failed.map((f) => f.check).join(", ")}).`] : []),
    "Advisory only: the server places no order and gives no position size."
  ].join("\n");
}

/** Minutes without a Decision Engine message before a heartbeat is sent (owner 2026-11-11); "0" turns it off. */
export const DECISION_HEARTBEAT_MINUTES = 60;
export function heartbeatMinutes(env) {
  const v = Number(env?.DECISION_TELEGRAM_HEARTBEAT_MINUTES ?? DECISION_HEARTBEAT_MINUTES);
  return Number.isFinite(v) && v >= 0 ? v : DECISION_HEARTBEAT_MINUTES;
}

/** The heartbeat: the stance still holds, since when, and this bar's reading. */
export function heartbeatMessage(d, since) {
  const at = (iso) => String(iso ?? "").slice(11, 16) + " UTC";
  return [
    `XAUUSD DECISION ENGINE · still ${d.stance}`,
    `No change ${since ? `since the 15m bar of ${at(since)}` : "to report"}. Bar closed ${at(d.bar_close)} · bias ${String(d.bias).toLowerCase()} · confidence ${Math.round((d.confidence || 0) * 100)}% · ${d.source === "council" ? "AI council" : "fallback"}.`,
    clip(d.summary, 300),
    "Heartbeat: the engine decides every 15m bar and writes here when the stance changes, or once an hour without a change.",
    "Advisory only: the server places no order and gives no position size."
  ].join("\n");
}

/**
 * Sends the decision to Telegram when the stance is new: a BUY or SELL after a different stance, or
 * any change (BUY -> WAIT). The same stance on the next bar is not sent again; DECISION_TELEGRAM_MODE
 * = "all" sends every BUY or SELL bar. With no message for DECISION_TELEGRAM_HEARTBEAT_MINUTES (owner
 * 2026-11-11: "telegram bot lebih dari 1 jam tidak mengirim pesan"), one heartbeat says the stance holds.
 */
export async function notifyDecision(env, d, send, { now = Date.now() } = {}) {
  if (typeof send !== "function") return { sent: false, reason: "no_sender" };
  const kv = env?.SIGNAL_CACHE;
  let prev = null;
  try { prev = JSON.parse((await kv?.get?.(DECISION_TELEGRAM_KEY)) || "null"); } catch { prev = null; }
  if (prev?.decision_key === d.decision_key) return { sent: false, reason: "already_handled" };
  const all = String(env?.DECISION_TELEGRAM_MODE ?? "changes").trim().toLowerCase() === "all";
  const changed = prev?.stance ? prev.stance !== d.stance : d.stance !== "WAIT";
  const notify = all ? shouldNotifyH1(d.stance, prev?.stance ?? null, "changes") : changed;
  const since = prev && prev.stance === d.stance ? (prev.since ?? null) : d.bar_close;
  // A state written before the heartbeat existed has no sent_at: count from now, never a burst at deploy.
  const lastSent = Date.parse(prev?.sent_at ?? "") || (prev ? now : NaN);
  const minutes = heartbeatMinutes(env);
  const heartbeat = !notify && minutes > 0 && Number.isFinite(lastSent) && now - lastSent >= minutes * 60_000;
  if (notify) await send(decisionMessage(d));
  else if (heartbeat) await send(heartbeatMessage(d, since));
  const sentAt = notify || heartbeat ? new Date(now).toISOString() : (Number.isFinite(lastSent) ? new Date(lastSent).toISOString() : null);
  try { await kv?.put?.(DECISION_TELEGRAM_KEY, JSON.stringify({ stance: d.stance, decision_key: d.decision_key, at: new Date(now).toISOString(), since, sent_at: sentAt }), { expirationTtl: 14 * 86_400 }); } catch { /* best effort */ }
  return { sent: notify || heartbeat, reason: notify ? "changed" : heartbeat ? "heartbeat" : "unchanged" };
}

/** Pure: the witnesses, the quorum and both sides' guardrails (with their plans) from the loaded inputs. */
export function assess(loaded, { now = Date.now(), env = null, analytics = null, witnessWeights = null, agentRecords = null } = {}) {
  const { inputs = {}, strategy = null, global = null, macro = null, correlations = null, regime = null } = loaded || {};
  // The extended witnesses read their own data (owner 2026-11-10), and the session describes SESSION
  // (context: a session has no direction).
  const session = sessionAt(now);
  const context = { regime, correlations, session, calendar: loaded?.calendar ?? null, independent: independentWitnesses(loaded, { now }) };
  // The witness weights (owner 2026-11-11: "harusnya bobot itu dinamis sesuai dengan auto tune yang ada di
  // aether"): the set the auto-tuning activated (src/witness-tuning.mjs: replay, discovery and holdout,
  // reverse shadow), loaded by runDecisionEngine; else B-11 (source "default") or the base set ("base").
  const tuned = witnessWeights && decisionWeightedEnabled(env) && witnessWeights.weights && typeof witnessWeights.weights === "object" ? witnessWeights : null;
  const effectiveEnv = tuned ? { ...env, DYNAMIC_WITNESS_WEIGHTS: tuned.weights } : env;
  const source = tuned ? (tuned.source ?? "default") : decisionWeightedEnabled(env) ? "default" : "base";
  const cards = witnessCards({ global, strategy, context, env: effectiveEnv });
  const quorum = quorumOf(cards, { now, analytics });
  const market = marketContextOf(loaded, quorum, now);
  const withMarket = { ...inputs, market };
  const guards = { long: guardrailsFor(1, { cards, quorum, strategy, inputs: withMarket, macro, now, env: effectiveEnv }), short: guardrailsFor(-1, { cards, quorum, strategy, inputs: withMarket, macro, now, env: effectiveEnv }) };
  // MT5 fallback (owner 2026-11-11: trade as usual): the decision stands on the broker's bars while
  // TradingView is down; news and the macro series are stale, which the council should weigh.
  if (inputs?.m5Feed === "mt5_fallback") for (const g of [guards.long, guards.short]) g.cautions = [...g.cautions, MT5_FALLBACK_CAUTION];
  // The strategy agents (owner 2026-11-13, src/strategy-agents.mjs): each agent's own plan per side. The
  // guardrail's plan is the default agent's; a live agent's plan may be chosen by the council, a shadow
  // agent's is only recorded and measured.
  const statuses = agentStatuses(env, { records: agentRecords });
  const scalp = modeThresholds(env?.TRADING_MODE).target === "nearest";
  // The patterns the breaker holds back: their own trades here lost (a pattern family skips them).
  const heldPatterns = suspendedPatterns(agentRecords).map((x) => x.id);
  for (const [dir, g] of [[1, guards.long], [-1, guards.short]]) {
    try { g.plans = agentPlans(dir, agentContext({ strategy, bars: inputs.m15Bars ?? [], regime, scalp, basePlan: g.plan, calibration: inputs.patternCalibration ?? null, suspendedPatterns: heldPatterns }), statuses); } catch { g.plans = {}; }
  }
  // The Projection Agent's reading of the price action, for the council's choice of strategy.
  let priceAction = [];
  try { priceAction = priceActionReading(strategy?.key_levels?.patterns, inputs.patternCalibration ?? null); } catch { priceAction = []; }
  guards.price_action = priceAction;
  return { cards, quorum, guards, market, witness_weights: { ...activeWitnessWeights(effectiveEnv) }, witness_weights_source: source, witness_weights_id: tuned?.id ?? null };
}

/** Pure: both sides' agent plans as the record keeps them ({ long: { id: { status, entry, stop, ... } }, short }), or null without any. */
export function strategyPlansOf(guards) {
  const side = (g) => Object.fromEntries(Object.entries(g?.plans || {}).map(([id, a]) => [id, { status: a.status, ...slimPlan(a.plan) }]));
  const long = side(guards?.long), short = side(guards?.short);
  return Object.keys(long).length || Object.keys(short).length ? { long, short } : null;
}

/** The first target's note when no key level lies ahead (src/strategy-engine.mjs tradeLevels). */
export const TP1_PROJECTION = "a 2R projection";
export const KEY_LEVELS_KEPT = 12;
/** Pure: the Key Level Agent's candidate (and qualified) zones nearest to price ({ low, high }, lowest first), or []. */
export function keyLevelsAround(strategy, n = KEY_LEVELS_KEPT) {
  const price = strategy?.price;
  const zones = (strategy?.key_levels?.zones || []).filter((z) => (z?.candidate || z?.qualified) && isNum(z.low) && isNum(z.high) && z.low <= z.high);
  if (!isNum(price) || !zones.length) return [];
  const dist = (z) => (price < z.low ? z.low - price : price > z.high ? price - z.high : 0);
  return zones.sort((a, b) => dist(a) - dist(b)).slice(0, n).map((z) => ({ low: r2(z.low), high: r2(z.high) })).sort((a, b) => a.low - b.low);
}

/** Pure: the whole decision record from the loaded inputs, their assessment and the council's result (or null). */
/** The model advice the council was given (kept on the decision record), or null. */
const modelAdviceOf = (council) => (council?.model_advice && typeof council.model_advice === "object" ? council.model_advice : null);

export function buildDecisionRecord({ key, barClose, loaded, assessment = null, council = null, previous = null, now = Date.now(), decidedAt = new Date(now).toISOString(), env = null, analytics = null }) {
  const { inputs = {}, strategy = null } = loaded || {};
  const { mode: MODE, quorum_min: MODE_QUORUM_MIN, min_rrr: MODE_MIN_RRR, lean: MODE_LEAN } = modeThresholds(env?.TRADING_MODE);
  const { cards, quorum, guards, market } = assessment ?? assess(loaded, { now, env, analytics });
  const answer = council?.answer ?? null;
  const d = decide({ answer, guards, strategy, quorum });
  let text;
  if (answer) {
    if (d.overruled) {
      const why = d.overruled.failed.map((f) => f.detail).join("; ");
      const body = answer.summary.replace(/^Decision\s+(BUY|SELL|WAIT)[^:]*:\s*/i, "");
      text = {
        summary: `Decision WAIT, bias ${String(d.bias).toLowerCase()}: the council's ${d.overruled.wanted} was held back (${why}). ${body}`,
        reasons: answer.reasons.slice(0, 4),
        risks: answer.risks.slice(0, 3)
      };
    } else {
      text = { summary: answer.summary, reasons: answer.reasons.slice(0, 4), risks: answer.risks.slice(0, 3) };
    }
  } else {
    text = fallbackText({ stance: d.stance, quorum, strategy, overruled: d.overruled, reason: council?.reason ?? "no answer" });
  }
  const cautions = [...new Set([...guards.long.cautions, ...guards.short.cautions])];
  return {
    version: DECISION_ENGINE_VERSION, decision_key: key, symbol: SYMBOL, timeframe: "15",
    bar_close: barClose, decided_at: decidedAt, latency_seconds: Math.max(0, Math.round((Date.parse(decidedAt) - Date.parse(barClose)) / 1000)),
    stance: d.stance, bias: d.bias, confidence: d.confidence, source: d.source,
    model: council?.model ?? null, fallback_model_used: council?.fallback_used === true,
    council_note: answer ? null : (council?.reason ?? null), council_errors: council?.errors ?? [],
    fallback_reason: answer ? null : (d.overruled ? `the strategy's ${d.overruled.wanted} was held back (${d.overruled.failed.map((f) => f.check).join(", ")})` : (council?.reason ?? null)),
    summary: text.summary, reasons: text.reasons, risks: text.risks, weighed: answer?.weighed ?? [],
    overruled: d.overruled, trade: d.trade,
    quorum, witnesses: cards,
    guardrails: { long: { allowed: guards.long.allowed, checks: guards.long.checks, entry_trigger: guards.long.entry_trigger ?? null }, short: { allowed: guards.short.allowed, checks: guards.short.checks, entry_trigger: guards.short.entry_trigger ?? null } },
    cautions, vetoes: { long: guards.long.vetoes, short: guards.short.vetoes }, supports: { long: guards.long.supports ?? [], short: guards.short.supports ?? [] },
    context: { ...councilContext({ inputs, correlations: loaded?.correlations ?? null, regime: loaded?.regime ?? null, previous, market, now }), ...(modelAdviceOf(council) ? { model: modelAdviceOf(council) } : {}) },
    strategy: strategy ? { decision: strategy.decision, state: strategy.state, direction: strategy.direction, confidence: strategy.confidence, headline: strategy.headline, price: strategy.price, atr_h1: strategy.atr_h1 } : null,
    // The Key Level Agent's candidate zones around price, on the feed's scale (owner 2026-11-12): Omega's
    // stop and target follow them while a position is open (src/omega-engine.mjs).
    key_levels: keyLevelsAround(strategy),
    // Every strategy agent's own plan per side (src/strategy-agents.mjs), live or shadow: what each would
    // have traded here, kept so the plan learner can measure each agent on the bars that follow.
    strategy_plans: strategyPlansOf(assessment?.guards ?? guards),
    // The Projection Agent's chart patterns behind those levels (src/chart-patterns.mjs): which pattern, on
    // which chart, and whether it broke out; kept so each pattern's outcome on gold can be measured.
    chart_patterns: (strategy?.key_levels?.patterns || []).slice(0, 16).map((p) => ({ tf: p.tf, id: p.id, status: p.status, direction: p.direction, upper: p.upper, lower: p.lower, target: p.target })),
    // The swing structure of the 4H, 1H and 15m bars (src/market-structure.mjs): labels only, shown beside
    // the decision; not a witness, not read by the council.
    structure: marketStructure({ h4Bars: inputs.h4Bars ?? [], h1Bars: inputs.h1Bars ?? [], m15Bars: inputs.m15Bars ?? [] }),
    // The price feed the decision stood on: TradingView, or the broker's bars (MT5 fallback).
    feed: inputs?.m5Feed === "mt5_fallback" ? "mt5_fallback" : "tradingview",
    trading_mode: MODE, weighted: decisionWeightedEnabled(env), weights: (assessment?.witness_weights ?? { ...activeWitnessWeights(env) }), witness_weights_source: (assessment?.witness_weights_source ?? (decisionWeightedEnabled(env) ? "default" : "base")), witness_weights_id: assessment?.witness_weights_id ?? null, rules: { quorum_min: MODE_QUORUM_MIN, min_rrr: MODE_MIN_RRR, min_confidence: MIN_CONFIDENCE, lean: MODE_LEAN, quorum_lean_band: LEAN },
    advisory: "The server places no order and gives no position size; the EA sizes each trade from the owner's risk input.",
    // The deployed Worker version that decided (2026-11-11: a deploy outside GitHub Actions put back an older build unseen).
    worker_version: typeof env?.CF_VERSION_METADATA?.id === "string" ? env.CF_VERSION_METADATA.id : null
  };
}

/**
 * The council's output budget (owner 2026-11-11). gpt-oss-120b reasons before its JSON and the reasoning
 * shares the budget: at 4096 tokens 2 of 14 answers were cut off (2026-11-11 01:30 and 04:00 UTC) while a
 * normal answer uses about 1,000. A cut-off answer is asked once more, briefly, with twice the budget.
 */
export const COUNCIL_MAX_TOKENS = 6144;
export const COUNCIL_RETRY_MIN_MS = 20_000;
const COUNCIL_BRIEF_NOTE = "Your previous answer ran out of tokens before the JSON. Reply with the JSON object only. Keep any reasoning very short.";

/**
 * Asks the council. Never throws. Besides one plain-language correction, an answer cut off by its token
 * limit is asked once more, briefly, with twice the budget; an answer that is still invalid is asked once
 * from the moderator role's fallback model (as the rooms' conclusions are), within the deadline.
 */
export async function askCouncil(env, evidence, { clock = () => Date.now(), deadlineMs = COUNCIL_DEADLINE_MS } = {}) {
  if (!env?.AI) return { answer: null, reason: "no model binding", errors: [] };
  const deadline = clock() + deadlineMs;
  const runState = {};
  // The council's learned notes (chart 15, the bar's session); none unless LEARNED_KNOWLEDGE_ENABLED.
  const closeMs = Date.parse(evidence?.bar_close ?? "");
  const learned = Number.isFinite(closeMs) && learnedKnowledgeEnabled(env) ? learnedBlock(env, { agent: COUNCIL_AGENT, chart: "15", session: sessionOf(closeMs), pack: await effectiveLearnedPack(env) }) : null;
  const base = councilMessages(evidence, { learned });
  let messages = base;
  let errors = [];
  let maxTokens = COUNCIL_MAX_TOKENS;
  let skipPrimary = null;
  let corrected = false, briefed = false, fellBack = false;
  let last = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await callBusModel(env, { messages, schemaName: "decision_council", schema: COUNCIL_JSON_SCHEMA, maxTokens, effort: "low", deadline, clock, runState, role: "moderator", skipPrimary });
    if (r.status !== "answered") return { answer: null, reason: r.status === "budget_exhausted" ? "out of time" : `model failed: ${clip(r.error, 120)}`, errors, model: r.model ?? null };
    last = r;
    const obj = r.obj && typeof r.obj === "object" ? { ...r.obj } : null;
    const v = r.truncated ? { valid: false, errors: ["answer_cut_off"] } : validateCouncil(obj);
    if (v.valid) return { answer: obj, model: r.model, fallback_used: r.fallback_used === true, errors, ...(attempt ? { retries: attempt } : {}) };
    errors = v.errors;
    const timeLeft = deadline - clock() > COUNCIL_RETRY_MIN_MS;
    if (r.truncated && !briefed && timeLeft) {
      briefed = true; maxTokens = COUNCIL_MAX_TOKENS * 2;
      messages = [...base.slice(0, -1), { ...base.at(-1), content: `${base.at(-1)?.content ?? ""}\n\n${COUNCIL_BRIEF_NOTE}` }];
      continue;
    }
    if (!r.truncated && !corrected && onlyNaturalLanguageErrors(v.errors)) {
      corrected = true;
      messages = [...messages, { role: "assistant", content: clip(r.text, 4000) }, { role: "user", content: NATURAL_LANGUAGE_CORRECTION }];
      continue;
    }
    if (!fellBack && !r.fallback_used && timeLeft) {
      fellBack = true; skipPrimary = `${r.truncated ? "answer cut off" : `invalid_output (${v.errors.slice(0, 4).join(", ")})`}`;
      messages = base; maxTokens = COUNCIL_MAX_TOKENS;
      continue;
    }
    break;
  }
  return { answer: null, reason: last?.truncated ? "answer cut off" : `invalid answer (${errors.join(", ")})`, errors, model: last?.model ?? null };
}

/**
 * Decides the 15m bar that closed at `barClose`, once. Stores it (D1 and KV), sends Telegram through
 * `send`, and records a BUY or SELL in the Signal Ledger through `recordSignal`. Never throws.
 */
export async function runDecisionEngine(env, { barClose, now = Date.now(), clock = () => Date.now(), send = null, recordSignal = null, loaded = null } = {}) {
  if (!decisionEngineEnabled(env)) return { status: "disabled" };
  if (!env?.DB) return { status: "unavailable" };
  const key = decisionKeyFor(barClose);
  if (!key) return { status: "invalid_bar" };
  const closeIso = new Date(keyCloseMs(key)).toISOString();
  try {
    await ensureDecisionSchema(env.DB);
    if (await env.DB.prepare("SELECT 1 AS x FROM engine_decisions WHERE decision_key = ?").bind(key).first()) return { status: "already_decided", decision_key: key };
    const previous = await readLatestDecision(env);
    try { env.TRADING_MODE = await tradingMode(env); } catch { /* keep env */ }
    const data = loaded ?? await loadDecisionInputs(env, { now });
    let witnessWeights = null;
    try { witnessWeights = await activeWitnessTuning(env, { now }); } catch { witnessWeights = null; }
    // The strategy agents' measured records (the plan learner's state): the breaker and the council read them.
    let agentRecords = null;
    try { agentRecords = (await readPlanLearning(env))?.agents ?? null; } catch { agentRecords = null; }
    const assessment = assess(data, { now, env, analytics: data.analytics, witnessWeights, agentRecords });
    const context = councilContext({ inputs: data.inputs, correlations: data.correlations, regime: data.regime, previous, market: assessment.market, now });
    try {
      const doctrinePayload = await fetchEffectiveDoctrine(env, { now });
      if (doctrinePayload?.rules?.length) {
        context.doctrine = formatDoctrineDirectives(doctrinePayload.rules, { role: "council" });
      }
    } catch { /* keep context */ }
    // The platform's own model, once its prospective record connected it by itself (src/model-baseline.mjs
    // promotionGate, owner 2026-11-13: "buat agar autonomous"): its probabilities as advice; null otherwise.
    const inputs = data.inputs || {};
    const advice = await modelAdvice(env, {
      barClose: closeIso, witnesses: assessment.cards, quorum: assessment.quorum,
      guardrails: { long: { allowed: assessment.guards.long.allowed, checks: assessment.guards.long.checks, entry_trigger: assessment.guards.long.entry_trigger ?? null }, short: { allowed: assessment.guards.short.allowed, checks: assessment.guards.short.checks, entry_trigger: assessment.guards.short.entry_trigger ?? null } },
      structure: marketStructure({ h4Bars: inputs.h4Bars ?? [], h1Bars: inputs.h1Bars ?? [], m15Bars: inputs.m15Bars ?? [] }),
      context, feed: inputs.m5Feed === "mt5_fallback" ? "mt5_fallback" : "tradingview", tradingMode: modeThresholds(env?.TRADING_MODE).mode
    });
    if (advice) context.model = advice;
    const evidence = councilEvidence({ barClose: closeIso, cards: assessment.cards, quorum: assessment.quorum, guards: assessment.guards, context, agentRecords, condition: contextOf({ mode: modeThresholds(env?.TRADING_MODE).mode, regime: data.regime }) });
    const council = await askCouncil(env, evidence, { clock });
    if (advice) council.model_advice = advice;
    const record = buildDecisionRecord({ key, barClose: closeIso, loaded: data, assessment, council, previous, now, decidedAt: new Date(clock()).toISOString(), env });
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(key, closeIso, record.decided_at, record.stance, record.confidence ?? null, record.source, JSON.stringify(record)).run();
    if (!Number(ins?.meta?.changes)) return { status: "already_decided", decision_key: key };
    try { await env.SIGNAL_CACHE?.put?.(DECISION_LATEST_KEY, JSON.stringify(record), { expirationTtl: 2 * 86_400 }); } catch { /* D1 has it */ }
    let telegram = null, ledger = null;
    try { telegram = await notifyDecision(env, record, send, { now: clock() }); } catch (e) { telegram = { sent: false, reason: `failed: ${clip(e?.message ?? e, 120)}` }; }
    if (record.trade && typeof recordSignal === "function") { try { ledger = await recordSignal(record); } catch { ledger = 0; } }
    const out = { status: "decided", decision_key: key, stance: record.stance, source: record.source, confidence: record.confidence, latency_seconds: record.latency_seconds, overruled: Boolean(record.overruled), telegram, ledger };
    // Aether A7 for the council (owner 2026-11-13, "1-3"): a learned note addressed to the council is tested
    // by one extra council call with the note, put through the same guardrails, against the stance that was
    // decided. Handed back as a job the caller runs after the decision; it never changes the decision.
    if (shadowKnowledgeEnabled(env)) {
      Object.defineProperty(out, "shadow_job", {
        enumerable: false,
        value: async () => {
          const plan = planShadowCalls({ items: await shadowItems(env), roster: [COUNCIL_AGENT], openings: [{ agent: COUNCIL_AGENT, status: "ok", stance: record.stance }], chart: "M15" });
          if (!plan.length) return { status: "nothing_to_do" };
          const base = learnedKnowledgeEnabled(env) ? learnedBlock(env, { agent: COUNCIL_AGENT, chart: "15", session: sessionOf(keyCloseMs(key)), pack: await effectiveLearnedPack(env) }) : null;
          return runShadowCalls(env, {
            calls: plan, candleKey: key, statementClose: closeIso, clock, schema: COUNCIL_JSON_SCHEMA, schemaName: "decision_council", maxTokens: COUNCIL_MAX_TOKENS, role: "moderator", deadlineMs: COUNCIL_DEADLINE_MS,
            messagesFor: (_agent, note) => councilMessages(evidence, { learned: [base, note].filter(Boolean).join("\n\n") || null }),
            validate: (o) => validateCouncil(o),
            toStance: (o) => decide({ answer: o, guards: assessment.guards, strategy: data.strategy ?? null, quorum: assessment.quorum }).stance
          });
        }
      });
    }
    return out;
  } catch (e) {
    return { status: "failed", decision_key: key, error: clip(e?.message ?? e, 200) };
  }
}

/** XAUUSD trades from Sunday 22:00 to Friday 22:00 UTC. */
export function marketOpenAt(ms) {
  const d = new Date(ms), day = d.getUTCDay(), h = d.getUTCHours();
  return !(day === 6 || (day === 5 && h >= 22) || (day === 0 && h < 22));
}

/** Sweep fallback: decides the last closed 15m bar when no 15m room triggered the engine. */
export async function runPendingDecision(env, { now = Date.now(), ...rest } = {}) {
  if (!decisionEngineEnabled(env)) return { status: "disabled" };
  const close = Math.floor(now / M15_MS) * M15_MS;
  if (now - close < SWEEP_AFTER_MS) return { status: "too_soon" };
  if (!marketOpenAt(close - 1)) return { status: "market_closed" };
  return runDecisionEngine(env, { barClose: new Date(close).toISOString(), now, ...rest });
}
