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
//   confirmation  the 15m or the 1H room decided that side under its confirmation rule, or a verified
//                 5m (or 15m) Prophet confirmation printed that way;
//   no veto       none of the strategy engine's vetoes for that side;
//   levels        a plan from the Key Level Agent's zones (planForDirection), never a model price;
//   reward        at least MIN_RRR reward-to-risk to the chosen target;
//   confidence    the council's confidence is at least MIN_CONFIDENCE.
// A council answer that breaks one becomes WAIT, with the reason kept (overruled). When the model
// fails or its answer is invalid, the deterministic fallback decides: the strategy engine's decision
// when its side passes every guardrail, otherwise WAIT. A high-impact USD event stays a caution
// (owner decision 2026-11-08); the EA itself does not enter during the event blackout.
//
// The decision is stored once per 15m bar (D1 engine_decisions, KV latest). It feeds the MT5 EA
// (src/ea-signal.mjs), Telegram, the Signal Ledger (source "decision") and the Nexus card. Kill
// switch: DECISION_ENGINE = "off" restores the H1 decision for the EA, Telegram and the ledger.
// The server never sizes a position; prices come only from the key-level plan.

import { loadStrategyInputs, buildStrategy, planForDirection, riskChecks, triggerOf, STRATEGY_PARAMS } from "./strategy-engine.mjs";
import { buildGlobalConclusion } from "./global-conclusion.mjs";
import { readMacroRoom } from "./macro-room.mjs";
import { readCorrelations } from "./correlations.mjs";
import { loadRegimeMap, regimeAtClose } from "./market-regime.mjs";
import { eventRisk } from "./econ-calendar.mjs";
import { callBusModel, BUS_MAX_TOKENS } from "./multi-agent-bus.mjs";
import { naturalLanguageErrors, onlyNaturalLanguageErrors, NATURAL_LANGUAGE_CORRECTION } from "./natural-language.mjs";
import { shouldNotifyH1 } from "./h1-telegram.mjs";

export const DECISION_ENGINE_VERSION = "cryptophys.decision-engine.v1";
export const SYMBOL = "OANDA:XAUUSD";
const M15_MS = 900_000;
/** Witness weights (sum 1). A missing or stale witness drops out and the rest renormalise. */
export const WITNESS_WEIGHTS = Object.freeze({ D1: 0.2, H4: 0.2, H1: 0.2, M15: 0.15, NEWS: 0.1, MACRO: 0.05, STRATEGY: 0.1 });
export const EXTENDED_WITNESS_WEIGHTS = Object.freeze({ D1: 0.16, H4: 0.16, H1: 0.16, M15: 0.12, NEWS: 0.08, MACRO: 0.04, STRATEGY: 0.08, KEY_LEVELS: 0.05, REGIME: 0.05, TREND_TF: 0.05, MACRO_DRIVERS: 0.03, SESSION: 0.02 });
export function decisionWeightedEnabled(env) { return String(env?.GLOBAL_DECISION_WEIGHTED ?? "true").trim().toLowerCase() !== "false"; }
export const QUORUM_MIN = 0.5;
export const LEAN = 0.15;
export const QUORUM_DECAY_PER_HOUR = 0.9;
export const MIN_RRR = STRATEGY_PARAMS.min_rrr;
export const MIN_CONFIDENCE = STRATEGY_PARAMS.min_confidence;
export const COUNCIL_DEADLINE_MS = 90_000;
/** The sweep decides a bar whose 15m room did not trigger the engine this long after its close. */
export const SWEEP_AFTER_MS = 4 * 60_000;
export const DECISION_LATEST_KEY = "decision-engine:latest";
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
export const DECISION_TELEGRAM_KEY = "telegram:decision-engine:last:v1";

const STANCES = ["BUY", "SELL", "WAIT"];
const BIASES = ["BULLISH", "BEARISH", "NEUTRAL"];
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
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
  const cards = [];
  for (const key of ["D1", "H4", "H1", "M15", "NEWS", "MACRO"]) {
    const t = rows.get(key);
    const lean = isNum(t?.lean) ? r2(t.lean) : null;
    cards.push({
      key, label: t?.label ?? key, role: t?.role ?? null, weight: WITNESS_WEIGHTS[key],
      available: Boolean(t?.available) && lean != null, stale: Boolean(t?.stale), lean, side: sideOf(lean),
      decision: t?.action ?? null, confidence: isNum(t?.confidence) ? r2(t.confidence) : null, summary: clip(t?.summary, 400) || null, at: t?.at ?? null
    });
  }
  const dir = dirOf(strategy?.direction);
  const sLean = strategy ? r2(dir * Math.max(isNum(strategy.alignment) ? strategy.alignment : 0, isNum(strategy.confidence) ? strategy.confidence : 0)) : null;
  cards.push({
    key: "STRATEGY", label: "Strategy", role: "multi-timeframe confluence", weight: WITNESS_WEIGHTS.STRATEGY,
    available: Boolean(strategy), stale: false, lean: sLean, side: sideOf(sLean),
    decision: strategy?.decision ?? null, state: strategy?.state ?? null, confidence: isNum(strategy?.confidence) ? strategy.confidence : null,
    summary: clip(strategy?.headline, 400) || null, at: null
  });
  if (decisionWeightedEnabled(env)) {
    const dir = (strategy?.direction === "LONG" ? 1 : strategy?.direction === "SHORT" ? -1 : 0);
    const atLevel = Boolean(strategy?.plan?.at_level);
    const align = isNum(strategy?.alignment) ? strategy.alignment : 0;
    const keyLean = strategy ? r2(dir * Math.max(atLevel ? 0.5 : 0.2, align * 0.5)) : null;
    cards.push({ key: "KEY_LEVELS", label: "Key levels", role: "zones", weight: EXTENDED_WITNESS_WEIGHTS.KEY_LEVELS, available: Boolean(strategy?.plan), stale: false, lean: keyLean, side: sideOf(keyLean), decision: null, confidence: null, summary: clip(strategy?.plan?.entry_note, 200) || null, at: null });
    const regimeLean = (typeof context?.regime === "string" && /trend/i.test(context.regime)) ? (dir || 0) * 0.3 : null;
    cards.push({ key: "REGIME", label: "Regime", role: "1H regime", weight: EXTENDED_WITNESS_WEIGHTS.REGIME, available: regimeLean != null, stale: false, lean: regimeLean, side: sideOf(regimeLean), decision: null, confidence: null, summary: context?.regime ?? null, at: null });
    const trendLean = isNum(strategy?.trend) ? strategy.trend : null;
    cards.push({ key: "TREND_TF", label: "Trend TF", role: "cross-TF trend", weight: EXTENDED_WITNESS_WEIGHTS.TREND_TF, available: trendLean != null, stale: false, lean: trendLean, side: sideOf(trendLean), decision: null, confidence: null, summary: null, at: null });
    const macroLean = isNum(context?.macroLean) ? context.macroLean : null;
    cards.push({ key: "MACRO_DRIVERS", label: "Macro drivers", role: "correlations", weight: EXTENDED_WITNESS_WEIGHTS.MACRO_DRIVERS, available: macroLean != null, stale: false, lean: macroLean, side: sideOf(macroLean), decision: null, confidence: null, summary: null, at: null });
    const sessionLean = null; // placeholder; session clock is context only
    cards.push({ key: "SESSION", label: "Session", role: "session clock", weight: EXTENDED_WITNESS_WEIGHTS.SESSION, available: false, stale: false, lean: sessionLean, side: sideOf(sessionLean), decision: null, confidence: null, summary: null, at: null });
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
export function quorumOf(cards, { now = Date.now(), decayPerHour = QUORUM_DECAY_PER_HOUR } = {}) {
  const counting = (cards || []).filter((c) => c.available && !c.stale && isNum(c.lean));
  const decayed = counting.map((c) => ({ ...c, _w: c.weight * _decayFactor(c, now, decayPerHour) }));
  const allWeight = decayed.reduce((s, c) => s + c._w, 0);
  if (!allWeight) return { score: null, bias: "NEUTRAL", long_share: 0, short_share: 0, neutral_share: 0, witnesses: 0, weight: 0 };
  // Neutral witnesses are excluded from the quorum denominator (G-06): only directional weight counts.
  const directional = decayed.filter((c) => Math.abs(c.lean) >= LEAN);
  const dirWeight = directional.reduce((s, c) => s + c._w, 0);
  const total = dirWeight > 0 ? dirWeight : allWeight;
  const share = (pred) => r2(directional.filter(pred).reduce((s, c) => s + c._w, 0) / total);
  const score = r2(decayed.reduce((s, c) => s + c._w * c.lean, 0) / allWeight);
  return {
    score, bias: sideOf(score),
    long_share: share((c) => c.lean >= LEAN), short_share: share((c) => c.lean <= -LEAN),
    neutral_share: r2((allWeight - dirWeight) / allWeight),
    witnesses: counting.length, weight: r2(allWeight)
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

// ---------------------------------------------------------------- guardrails

/**
 * Pure: the guardrails for one side (dir +1 long, -1 short) and the plan the side would trade.
 * `inputs` are the strategy engine's inputs (snapshots, news, calendar, confirmations).
 */
export function guardrailsFor(dir, { cards, quorum, strategy, inputs = {}, macro = null, now = Date.now(), env = null }) {
  // ---- Adaptive mode handling ------------------------------------------------
  // Cloudflare Workers: env is threaded in; process.env does not exist here.
  const MODE = String(env?.TRADING_MODE ?? "intraday").trim().toLowerCase();
  // Adaptive thresholds per mode
  const QUORUM_MIN = MODE === "scalp" ? 0.45 : MODE === "swing" ? 0.6 : 0.5;
  const MIN_RRR = MODE === "scalp" ? 1.2 : MODE === "swing" ? 2.0 : 1.5;
  const LEAN = MODE === "scalp" ? 0.10 : MODE === "swing" ? 0.20 : 0.15;

  const side = stanceOf(dir);
  const card = (k) => (cards || []).find((c) => c.key === k);
  const checks = [];
  const add = (id, pass, detail) => checks.push({ id, pass: Boolean(pass), detail });
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
  const roomConfirmed = ["M15", "H1"].filter((k) => card(k)?.decision === side);
  let trigger = { fired: false, note: "no confirmation" };
  try { trigger = triggerOf(dir, { confirmations: inputs.confirmations ?? null, m15Snapshot: inputs.m15Snapshot ?? null }); } catch { /* none */ }
  add("confirmation", roomConfirmed.length > 0 || trigger.fired, roomConfirmed.length ? `the ${roomConfirmed.map((k) => card(k).label).join(" and ")} room decided ${side}` : trigger.fired ? trigger.note : `no room decided ${side} and ${trigger.note}`);
  let risk = { vetoes: [], cautions: [] };
  try { risk = riskChecks(dir, { h1Snapshot: inputs.h1Snapshot ?? null, m15Snapshot: inputs.m15Snapshot ?? null, news: inputs.news ?? null, macro: macro ?? inputs.macro ?? null, calendar: inputs.calendar ?? null, mode: env?.TRADING_MODE ?? null, env, now }); } catch { /* none */ }
  add("no_veto", !risk.vetoes.length, risk.vetoes.length ? risk.vetoes.join("; ") : "no veto");
  const plan = planForDirection(strategy, dir);
  add("levels", Boolean(plan), plan ? `entry ${plan.entry_note}, stop ${plan.stop_note}` : "no key-level plan (price, 1H range or zones missing)");
  const best = plan ? Math.max(plan.rrr?.tp1 ?? 0, plan.rrr?.tp2 ?? 0) : 0;
  add("reward", Boolean(plan) && best >= MIN_RRR, plan ? `${best}R to the best target (at least ${MIN_RRR}R needed)` : "no plan");
  return { side, allowed: checks.every((c) => c.pass), checks, plan, vetoes: risk.vetoes, cautions: risk.cautions };
}

/**
 * Pure: the trade a side takes with the council's choices, inside the guardrails: a market entry only
 * when price is at the level (else a limit at the planned pullback), and the chosen target only when
 * it pays at least MIN_RRR (else the other one). Null when no target pays enough.
 */
export function tradeFor(side, plan, { entryType = "market", target = "tp1" } = {}) {
  if (!plan || !(side === "BUY" || side === "SELL")) return null;
  const pays = (t) => isNum(plan[t]) && (plan.rrr?.[t] ?? 0) >= MIN_RRR;
  const t = pays(target) ? target : pays(target === "tp1" ? "tp2" : "tp1") ? (target === "tp1" ? "tp2" : "tp1") : null;
  if (!t) return null;
  const market = entryType !== "limit" && plan.at_level === true;
  return {
    side, action: market ? "ENTER_MARKET" : "ENTER_LIMIT", entry: plan.entry, stop: plan.stop, target: t, tp: plan[t],
    tp1: plan.tp1, tp2: plan.tp2, risk: plan.risk, rrr: plan.rrr?.[t] ?? null, rrr_all: plan.rrr ?? null,
    entry_note: plan.entry_note, stop_note: plan.stop_note, tp_note: plan[`${t}_note`] ?? null, at_level: plan.at_level === true
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
    summary: { type: "string" },
    reasons: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    weighed: { type: "array", items: { type: "string" } }
  },
  required: ["stance", "bias", "confidence", "entry_type", "target", "summary", "reasons", "risks", "weighed"]
});

const WITNESS_KEYS = ["D1", "H4", "H1", "M15", "NEWS", "MACRO", "STRATEGY"];

/** Pure: the council's evidence (the witnesses, the quorum, both sides' guardrails and plans, the context). */
export function councilEvidence({ barClose, cards, quorum, guards, context = {} }) {
  const plan = (g) => (g.plan ? { entry: g.plan.entry, entry_note: g.plan.entry_note, at_level: g.plan.at_level, stop: g.plan.stop, stop_note: g.plan.stop_note, tp1: g.plan.tp1, tp1_note: g.plan.tp1_note, tp2: g.plan.tp2, tp2_note: g.plan.tp2_note, reward_to_risk: g.plan.rrr } : null);
  const side = (g) => ({ allowed: g.allowed, checks: g.checks.map((c) => ({ check: c.id, pass: c.pass, detail: c.detail })), plan: plan(g), vetoes: g.vetoes, cautions: g.cautions });
  return {
    bar_close: barClose,
    witnesses: cards.map((c) => ({ key: c.key, name: c.label, role: c.role, weight: c.weight, counts: c.available && !c.stale, lean: c.lean, own_decision: c.decision, state: c.state ?? undefined, confidence: c.confidence, summary: c.summary })),
    // Production 2026-11-09 13:15: the council read the weighted lean (0.42) as the quorum. The quorum
    // is the share of weight leaning one way; the lean is only its strength.
    quorum: { bullish_share: quorum.long_share, bearish_share: quorum.short_share, neutral_share: quorum.neutral_share, share_needed_above: QUORUM_MIN, weighted_lean: quorum.score, lean_bias: quorum.bias },
    long: side(guards.long), short: side(guards.short),
    context
  };
}

/** Pure: the council's messages. */
export function councilMessages(evidence) {
  const system = [
    "You are the AI Decision Council of the XAUUSD system: the ONE decision for the trader, made at the close of each 15-minute bar.",
    "Witnesses each speak from their own data: the D1, 4H, 1H and 15m War Rooms (their agents' bias as a lean from -1 bearish to +1 bullish, and the room's own decision), News Daily, the Macro War Room and the strategy engine (the multi-timeframe confluence, the key-level plan and the entry trigger). You are the only one who reads across them.",
    "Decide the stance: BUY, SELL or WAIT. A BUY is possible only when long.allowed is true, a SELL only when short.allowed is true; otherwise the guardrails turn it into WAIT, so choose WAIT yourself and say which check is missing. WAIT is always allowed.",
    `The quorum guardrail is already evaluated in long.checks and short.checks: it compares quorum.bullish_share or quorum.bearish_share (the share of the witnesses' weight leaning that way) with quorum.share_needed_above. quorum.weighted_lean is the strength of the lean from -1 to +1, not the quorum; never compare it with ${QUORUM_MIN}.`,
    "Weigh the witnesses by their weight and by how well their reasoning holds up; the higher timeframes carry the trend, the 15m and 1H rooms carry the setup, the strategy engine carries location and trigger. Cautions (an event, conflicts, chaotic regime) lower your confidence.",
    `Choose entry_type "market" only when the plan's price is at the level (at_level true), else "limit" (the planned pullback). Choose target "tp1" or "tp2": a target needs at least ${MIN_RRR}R.`,
    `confidence is 0 to 1; below ${MIN_CONFIDENCE} a BUY or SELL becomes WAIT. bias is where the weight of the evidence leans (BULLISH, BEARISH or NEUTRAL), even when the stance is WAIT.`,
    "Never invent a price: the levels come only from the plans in the evidence. Never mention position size. Write summary, reasons and risks in plain sentences a trader would write: no field names, no words joined by underscores or dots, no key=value. The summary starts with the stance and the bias, for example \"Decision WAIT, bias bullish: ...\". Give one to four reasons and up to three risks. In weighed, list the witness keys you relied on most.",
    "Return only the JSON object."
  ].join(" ");
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
  let stance, confidence, entryType, target, overruled = null;
  if (answer) {
    stance = answer.stance; confidence = r2(Math.max(0, Math.min(0.95, answer.confidence)));
    entryType = answer.entry_type; target = answer.target;
  } else {
    // Fallback: the strategy engine's decision when its side passes every guardrail.
    const sd = dirOf(strategy?.decision);
    stance = sd ? strategy.decision : "WAIT";
    confidence = isNum(strategy?.confidence) ? r2(strategy.confidence) : 0;
    entryType = "market"; target = "tp2";
  }
  const dir = dirOf(stance);
  let trade = null;
  if (dir) {
    const g = pick(dir);
    if (!g.allowed) overruled = { by: "guardrail", wanted: stance, failed: g.checks.filter((c) => !c.pass).map((c) => ({ check: c.id, detail: c.detail })) };
    else if (confidence < MIN_CONFIDENCE) overruled = { by: "guardrail", wanted: stance, failed: [{ check: "confidence", detail: `confidence ${Math.round(confidence * 100)}% is below ${Math.round(MIN_CONFIDENCE * 100)}%` }] };
    else {
      trade = tradeFor(stance, g.plan, { entryType, target });
      if (!trade) overruled = { by: "guardrail", wanted: stance, failed: [{ check: "reward", detail: `no target pays ${MIN_RRR}R` }] };
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
  return { inputs, strategy, macro, global, correlations, regime };
}

/** Pure: the context the council reads beside the witnesses (no weights). */
export function councilContext({ inputs = {}, correlations = null, regime = null, previous = null, now = Date.now() }) {
  const risk = eventRisk(inputs.calendar?.events || [], now);
  const m5 = inputs.confirmations?.m5_prophet_r38 ?? null;
  return {
    // The 5m entry trigger (the Prophet R38 confirmation of the latest closed 5m bar, when fresh).
    m5_trigger: m5 ? { buy_confirmed: m5.buy_confirmed === true, sell_confirmed: m5.sell_confirmed === true, verified: m5.verified === true, candle_time: m5.candle_time ?? null } : null,
    events: { active: risk.active.map((e) => ({ title: e.title, time: e.time })), next: risk.next.slice(0, 3).map((e) => ({ title: e.title, time: e.time })) },
    regime_1h: regime ?? null,
    cross_assets: (correlations?.assets || []).filter((a) => a.available).map((a) => ({ name: a.name, change_1d: a.change?.["1d"] ?? null, correlation_with_gold: a.correlation?.short ?? null })),
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
    clip(d.summary, 700),
    ...(d.overruled ? [`Guardrail: ${d.overruled.wanted} held back (${d.overruled.failed.map((f) => f.check).join(", ")}).`] : []),
    "Advisory only: the server places no order and gives no position size."
  ].join("\n");
}

/**
 * Sends the decision to Telegram when the stance is new: a BUY or SELL after a different stance, or
 * any change (BUY -> WAIT). The same stance on the next bar is not sent again; DECISION_TELEGRAM_MODE
 * = "all" sends every BUY or SELL bar.
 */
export async function notifyDecision(env, d, send) {
  if (typeof send !== "function") return { sent: false, reason: "no_sender" };
  const kv = env?.SIGNAL_CACHE;
  let prev = null;
  try { prev = JSON.parse((await kv?.get?.(DECISION_TELEGRAM_KEY)) || "null"); } catch { prev = null; }
  if (prev?.decision_key === d.decision_key) return { sent: false, reason: "already_handled" };
  const all = String(env?.DECISION_TELEGRAM_MODE ?? "changes").trim().toLowerCase() === "all";
  const changed = prev?.stance ? prev.stance !== d.stance : d.stance !== "WAIT";
  const notify = all ? shouldNotifyH1(d.stance, prev?.stance ?? null, "changes") : changed;
  if (notify) await send(decisionMessage(d));
  try { await kv?.put?.(DECISION_TELEGRAM_KEY, JSON.stringify({ stance: d.stance, decision_key: d.decision_key, at: new Date().toISOString() }), { expirationTtl: 14 * 86_400 }); } catch { /* best effort */ }
  return { sent: notify, reason: notify ? "changed" : "unchanged" };
}

/** Pure: the witnesses, the quorum and both sides' guardrails (with their plans) from the loaded inputs. */
export function assess(loaded, { now = Date.now(), env = null } = {}) {
  const { inputs = {}, strategy = null, global = null, macro = null, correlations = null, regime = null } = loaded || {};
  const context = { regime, correlations, macroLean: isNum(macro?.lean) ? macro.lean : (isNum(macro?.score) ? macro.score : null) };
  const cards = witnessCards({ global, strategy, context, env });
  const quorum = quorumOf(cards, { now });
  const guards = { long: guardrailsFor(1, { cards, quorum, strategy, inputs, macro, now, env }), short: guardrailsFor(-1, { cards, quorum, strategy, inputs, macro, now, env }) };
  return { cards, quorum, guards };
}

/** Pure: the whole decision record from the loaded inputs, their assessment and the council's result (or null). */
export function buildDecisionRecord({ key, barClose, loaded, assessment = null, council = null, previous = null, now = Date.now(), decidedAt = new Date(now).toISOString(), env = null }) {
  const { inputs = {}, strategy = null } = loaded || {};
  const MODE = String(env?.TRADING_MODE ?? "intraday").trim().toLowerCase();
  const MODE_QUORUM_MIN = MODE === "scalp" ? 0.45 : MODE === "swing" ? 0.6 : 0.5;
  const MODE_MIN_RRR = MODE === "scalp" ? 1.2 : MODE === "swing" ? 2.0 : 1.5;
  const { cards, quorum, guards } = assessment ?? assess(loaded, { now, env });
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
    guardrails: { long: { allowed: guards.long.allowed, checks: guards.long.checks }, short: { allowed: guards.short.allowed, checks: guards.short.checks } },
    cautions, vetoes: { long: guards.long.vetoes, short: guards.short.vetoes },
    context: councilContext({ inputs, correlations: loaded?.correlations ?? null, regime: loaded?.regime ?? null, previous, now }),
    strategy: strategy ? { decision: strategy.decision, state: strategy.state, direction: strategy.direction, confidence: strategy.confidence, headline: strategy.headline, price: strategy.price, atr_h1: strategy.atr_h1 } : null,
    trading_mode: MODE, weights: WITNESS_WEIGHTS, rules: { quorum_min: MODE_QUORUM_MIN, min_rrr: MODE_MIN_RRR, min_confidence: MIN_CONFIDENCE },
    advisory: "The server places no order and gives no position size; the EA sizes each trade from the owner's risk input."
  };
}

/** Asks the council (one call, one plain-language correction). Never throws. */
export async function askCouncil(env, evidence, { clock = () => Date.now(), deadlineMs = COUNCIL_DEADLINE_MS } = {}) {
  if (!env?.AI) return { answer: null, reason: "no model binding", errors: [] };
  const deadline = clock() + deadlineMs;
  const runState = {};
  let messages = councilMessages(evidence);
  let errors = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await callBusModel(env, { messages, schemaName: "decision_council", schema: COUNCIL_JSON_SCHEMA, maxTokens: BUS_MAX_TOKENS.moderator, effort: "low", deadline, clock, runState, role: "moderator" });
    if (r.status !== "answered") return { answer: null, reason: r.status === "budget_exhausted" ? "out of time" : `model failed: ${clip(r.error, 120)}`, errors, model: r.model ?? null };
    const obj = r.obj && typeof r.obj === "object" ? { ...r.obj } : null;
    const v = validateCouncil(obj);
    if (v.valid) return { answer: obj, model: r.model, fallback_used: r.fallback_used === true, errors };
    errors = v.errors;
    if (attempt === 0 && onlyNaturalLanguageErrors(v.errors)) {
      messages = [...messages, { role: "assistant", content: clip(r.text, 4000) }, { role: "user", content: NATURAL_LANGUAGE_CORRECTION }];
      continue;
    }
    return { answer: null, reason: r.truncated ? "answer cut off" : `invalid answer (${v.errors.join(", ")})`, errors, model: r.model };
  }
  return { answer: null, reason: "invalid answer", errors };
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
    const assessment = assess(data, { now, env });
    const context = councilContext({ inputs: data.inputs, correlations: data.correlations, regime: data.regime, previous, now });
    const council = await askCouncil(env, councilEvidence({ barClose: closeIso, cards: assessment.cards, quorum: assessment.quorum, guards: assessment.guards, context }), { clock });
    const record = buildDecisionRecord({ key, barClose: closeIso, loaded: data, assessment, council, previous, now, decidedAt: new Date(clock()).toISOString(), env });
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(key, closeIso, record.decided_at, record.stance, record.confidence ?? null, record.source, JSON.stringify(record)).run();
    if (!Number(ins?.meta?.changes)) return { status: "already_decided", decision_key: key };
    try { await env.SIGNAL_CACHE?.put?.(DECISION_LATEST_KEY, JSON.stringify(record), { expirationTtl: 2 * 86_400 }); } catch { /* D1 has it */ }
    let telegram = null, ledger = null;
    try { telegram = await notifyDecision(env, record, send); } catch (e) { telegram = { sent: false, reason: `failed: ${clip(e?.message ?? e, 120)}` }; }
    if (record.trade && typeof recordSignal === "function") { try { ledger = await recordSignal(record); } catch { ledger = 0; } }
    return { status: "decided", decision_key: key, stance: record.stance, source: record.source, confidence: record.confidence, latency_seconds: record.latency_seconds, overruled: Boolean(record.overruled), telegram, ledger };
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
