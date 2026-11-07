// Live War Room 15m (owner decision 2026-11-05, docs/RFC_INDICATOR_AGENT_PLATFORM.md §12).
//
// Every agent discusses in one room at each 15m candle close, in three phases:
//   1. Communication bus: each agent posts one opening claim from its own data only (one
//      role per agent, no repeated information).
//   2. Consensus Discussion (owner decision 2026-11-07: the term replaces "debate"; stored step
//      names keep the "debate:" prefix): every agent sees the whole bus; agents whose bias differs
//      from the room (at most 7, by confidence) and the Risk Manager answer named agents. It is
//      open for at most 3 minutes, then closed.
//   3. Conclusion: the moderator concludes for the Nexus main panel. The H1 decision chain
//      stays the constraint: a conclusion that differs must say "H1 decision: X", and price
//      levels come only from the validated H1 chain.
// Advisory only: stances are discussion positions, never orders. Primary model only.
// Behind WAR_ROOM_ENABLED; when on, it replaces the legacy live room and the per-H1 HUD
// agents (owner decision: their budget moves here).
import { chatMessages } from "./model-text.mjs";
import { naturalLanguageErrors } from "./natural-language.mjs";
import { HUD_IDS, HUD_NAMES, calibrationCounts, calibrationNote, calibratedLines } from "./hud-reading.mjs";
import { loadHudSnapshot, hudReadings } from "./hud-store.mjs";
import { BUS_DEFAULT_MODEL, BUS_MAX_TOKENS } from "./multi-agent-bus.mjs";
import { newsDeskEvidence } from "./news-daily.mjs";
import { chartDeskReading, chartDeskLabel } from "./timeframe-desk.mjs";
import {
  ROOM_STANCES, ensureThreadSchema, isFifteenMinuteClose, liveEvidence, m15KeyForClose,
  hudEvidenceLines, rowToThreadMessage, validateRoomModerator, threadInternals
} from "./agent-threads.mjs";

const { runStep, writeMessage, upsertThread, callsInLastHour, RULES_NO_REFS, clip, inUnit, parseJson } = threadInternals;

export const WAR_ROOM_OPENING_MS = 90_000;
export const WAR_ROOM_DEBATE_MS = 180_000; // owner: the debate is open for at most 3 minutes
export const WAR_ROOM_CONCLUSION_MS = 60_000;
/**
 * Quorum (production 2026-11-06 13:15: Workers AI 3021 and 3040 failed 14 of 18 openings and the
 * room concluded on four agents): within this wait after the close, a room with fewer than half
 * of its agents heard does not conclude; the queue redelivers the task and only the failed
 * openings are asked again. Past it, the room concludes with whoever spoke.
 */
export const WAR_ROOM_QUORUM_WAIT_MS = 5 * 60_000;
export const WAR_ROOM_MAX_REBUTTALS = 8;
const CLAIM_MAX = 320;
const ARGUMENT_MAX = 420;

export function warRoomEnabled(env) {
  return String(env?.WAR_ROOM_ENABLED ?? "false").trim().toLowerCase() === "true";
}

/**
 * Desk agents (one role each); the HUD agents follow, one per computed 15m HUD. Owner decision
 * 2026-11-06: the 15m Desk analyses only the 15m chart; the H1 chain, which still binds the room,
 * is the Higher-Timeframe Desk's role.
 */
export const DESK_AGENTS = Object.freeze({
  m15: { name: "15m Desk", role: "the local Prophet (signal, direction, structure, trade management) and GMI computation of the 15m candle that just closed: this timeframe's own signal" },
  htf: { name: "Higher-Timeframe Desk", role: "the H1 decision chain, its TradingView reading and the latest 1H War Room conclusion: the higher-timeframe constraint" },
  news: { name: "News Analyst", role: "the fundamental news of the last 24 hours: the daily bias for gold and the headlines behind it" },
  technical: { name: "Technical Analyst", role: "price action only: the closed 15m candles and the 5m execution read" },
  risk: { name: "Risk Manager", role: "risk only: volatility, conflicts between timeframes, what would invalidate a move, and the rule no confirmation, no entry" }
});

/**
 * Owner rule (2026-11-05): no confirmation, no entry. A BUY needs a confirmed buy signal from the
 * H1 Prophet R38 or a VERIFIED 5m Prophet R38 confirmation candle; a SELL needs a confirmed sell.
 */
export function entryAllowed(stance, confirmations) {
  if (stance !== "BUY" && stance !== "SELL") return true;
  const side = stance === "BUY" ? "buy_confirmed" : "sell_confirmed";
  const h1 = confirmations?.h1_prophet_r38?.[side] === true;
  const m5 = confirmations?.m5_prophet_r38?.verified === true && confirmations.m5_prophet_r38[side] === true;
  return h1 || m5;
}

export const SUPPORT_RULE = "A BUY or SELL conclusion also needs at least one agent on the bus or in the Consensus Discussion holding that stance: a confirmation alone never overrules the whole room.";

export const NO_CONFIRMATION_RULE =
  "Rule: no confirmation, no entry. BUY needs a confirmed buy signal (the H1 Prophet R38 confirmation, or a VERIFIED 5m Prophet R38 confirmation candle); SELL needs a confirmed sell signal. Without the matching confirmation the stance is WAIT, or HOLD / CLOSE for a position already open.";

/** Names of desks that earlier rooms used, so their stored messages still read by name. */
const LEGACY_DESK_NAMES = Object.freeze({ h1: "H1 Desk" });

export function agentName(id) {
  if (DESK_AGENTS[id]) return DESK_AGENTS[id].name;
  if (LEGACY_DESK_NAMES[id]) return LEGACY_DESK_NAMES[id];
  if (HUD_NAMES[id]) return HUD_NAMES[id];
  return id === "moderator" ? "Moderator" : String(id);
}

const OPENING_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  properties: { agent: { type: "string" }, stance: { type: "string", enum: [...ROOM_STANCES] }, bias: { type: "string", enum: ["BULLISH", "BEARISH", "NEUTRAL"] }, confidence: { type: "number" }, claim: { type: "string" } },
  required: ["agent", "stance", "bias", "confidence", "claim"]
});
const REBUTTAL_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  properties: { agent: { type: "string" }, stance: { type: "string", enum: [...ROOM_STANCES] }, bias: { type: "string", enum: ["BULLISH", "BEARISH", "NEUTRAL"] }, confidence: { type: "number" }, rebuts: { type: "array", items: { type: "string" } }, argument: { type: "string" } },
  required: ["agent", "stance", "bias", "confidence", "rebuts", "argument"]
});
const CONCLUSION_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  properties: { stance: { type: "string", enum: [...ROOM_STANCES] }, bias: { type: "string", enum: ["BULLISH", "BEARISH", "NEUTRAL"] }, confidence: { type: "number" }, summary: { type: "string" }, reasons: { type: "array", items: { type: "string" } }, dissent: { type: "array", items: { type: "string" } } },
  required: ["stance", "bias", "confidence", "summary", "reasons", "dissent"]
});

/** "interstellar eyes" or "Interstellar-Eyes" name the agent interstellar_eyes (production 16:00). */
export function sameAgent(given, agent) {
  const norm = (x) => String(x ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return norm(given) === norm(agent) || norm(given) === norm(agentName(agent));
}

/**
 * The direction an agent's own data leans, recorded beside its action (owner decision 2026-11-06,
 * Prophet audit): without a confirmation the action is WAIT, but the data may still lean bullish
 * or bearish, and that lean is what the room's trend reads.
 */
export const ROOM_BIASES = Object.freeze(["BULLISH", "BEARISH", "NEUTRAL"]);
export const BIAS_RULE = 'Also give "bias": the direction your own data leans (BULLISH, BEARISH or NEUTRAL), even when your action is WAIT because nothing is confirmed. NEUTRAL only when your data leans neither way.';
export const biasOfStance = (stance) => (stance === "BUY" ? "BULLISH" : stance === "SELL" ? "BEARISH" : "NEUTRAL");
const BIAS_DIRECTION = Object.freeze({ BULLISH: 1, BEARISH: -1, NEUTRAL: 0 });
const biasOf = (o) => (ROOM_BIASES.includes(o?.bias) ? o.bias : biasOfStance(o?.stance));

/**
 * Decision and bias (owner decision 2026-11-06): the stance is the DECISION, what to do now under
 * the confirmation rule; the bias is where the weight of the evidence leans. The conclusion gives both.
 */
export const DECISION_BIAS_RULE = 'Give the decision and the bias separately. "stance" is the DECISION: what to do now, under the confirmation rule. "bias" is the direction the weight of the room\'s evidence leans (BULLISH, BEARISH or NEUTRAL), even when the decision is WAIT. The summary states both first, for example "Decision WAIT, bias bearish: ...".';

/** The confidence-weighted bias of the agents that spoke: NEUTRAL inside +-0.1. */
export function majorityBias(openings) {
  let sum = 0, weight = 0;
  for (const o of openings || []) {
    const c = inUnit(o?.confidence) ? o.confidence : 0.5;
    sum += BIAS_DIRECTION[biasOf(o)] * c;
    weight += c;
  }
  const lean = weight ? sum / weight : 0;
  return Math.abs(lean) < 0.1 ? "NEUTRAL" : lean > 0 ? "BULLISH" : "BEARISH";
}

/** A BULLISH or BEARISH room bias needs at least one agent holding it (NEUTRAL always stands). */
export function biasSupported(bias, supportBiases) {
  return bias === "NEUTRAL" || !supportBiases || supportBiases.has(bias);
}

/** Calibration cap (owner decision A): a HUD agent with no verified statement speaks at <= 0.4. */
export const UNCALIBRATED_CONFIDENCE_CAP = 0.4;

export function validateOpening(o, agent, { verifiedLines = null } = {}) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return { valid: false, errors: ["not_an_object"] };
  const errors = [];
  if (!sameAgent(o.agent, agent)) errors.push("agent_mismatch");
  else o.agent = agent;
  if (verifiedLines === 0 && inUnit(o.confidence)) o.confidence = Math.min(o.confidence, UNCALIBRATED_CONFIDENCE_CAP);
  if (!ROOM_STANCES.includes(o.stance)) errors.push("stance_invalid");
  if (!inUnit(o.confidence)) errors.push("confidence_out_of_range");
  if (typeof o.claim !== "string" || !o.claim.trim()) errors.push("claim_missing");
  else errors.push(...naturalLanguageErrors(o.claim));
  // A missing bias falls back to the action's direction; a malformed one is an error.
  if (o.bias == null || o.bias === "") o.bias = biasOfStance(o.stance);
  else if (ROOM_BIASES.includes(String(o.bias).trim().toUpperCase())) o.bias = String(o.bias).trim().toUpperCase();
  else errors.push("bias_invalid");
  return { valid: errors.length === 0, errors };
}

/** Rebuttal targets as bus ids: an agent's display name is accepted for its id. */
export function normalizeRebuts(rebuts, busAgents) {
  if (!Array.isArray(rebuts)) return null;
  const byName = new Map(busAgents.map(id => [agentName(id).toLowerCase(), id]));
  return rebuts.map(r => (busAgents.includes(r) ? r : byName.get(String(r ?? "").trim().toLowerCase()) ?? r));
}

/**
 * A rebuttal names the bus agents it rebuts. Two cases may name nobody:
 * - In a unanimous room the Risk Manager stress-tests the consensus (preview-e2e: a unanimous
 *   WAIT room left it no one to rebut, and it answered rebuts: []).
 * - A dissenter the bus persuaded concedes: its stance differs from its own opening (`ownStance`).
 *   Production wrote rebuts [itself] or [] for every such concession and lost it as
 *   rebuts_invalid; it is now kept, with its own id dropped and `conceded: true`.
 */
export function validateRebuttal(o, agent, busAgents, { unanimous = false, ownStance = null, ownBias = null } = {}) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return { valid: false, errors: ["not_an_object"] };
  const errors = [];
  if (!sameAgent(o.agent, agent)) errors.push("agent_mismatch");
  else o.agent = agent;
  if (!ROOM_STANCES.includes(o.stance)) errors.push("stance_invalid");
  if (!inUnit(o.confidence)) errors.push("confidence_out_of_range");
  // The bias may move in the debate; a missing one keeps the opening's.
  if (o.bias == null || o.bias === "") o.bias = ownBias ?? biasOfStance(o.stance);
  else if (ROOM_BIASES.includes(String(o.bias).trim().toUpperCase())) o.bias = String(o.bias).trim().toUpperCase();
  else errors.push("bias_invalid");
  const conceded = (ownStance != null && ROOM_STANCES.includes(o.stance) && o.stance !== ownStance) ||
    (ownBias != null && ROOM_BIASES.includes(o.bias) && o.bias !== ownBias);
  const named = normalizeRebuts(o.rebuts, busAgents);
  // Its own id is meaningful only as a concession; beside real targets or in a concession it is dropped.
  const rebuts = named && (conceded || named.some(r => r !== agent)) ? named.filter(r => r !== agent) : named;
  if (!rebuts || (!rebuts.length && !unanimous && !conceded) || rebuts.some(r => r === agent || !busAgents.includes(r))) errors.push("rebuts_invalid");
  else { o.rebuts = rebuts; if (conceded) o.conceded = true; }
  if (typeof o.argument !== "string" || !o.argument.trim()) errors.push("argument_missing");
  else errors.push(...naturalLanguageErrors(o.argument));
  return { valid: errors.length === 0, errors };
}

/**
 * Owner decision 2026-11-06: a BUY or SELL conclusion needs at least one agent on the bus or in the
 * debate holding that stance; a confirmation alone does not let the moderator overrule the room.
 */
export function stanceSupported(stance, supportStances) {
  return !(stance === "BUY" || stance === "SELL") || !supportStances || supportStances.has(stance);
}

/** The conclusion's bias: normalised; a missing one is the room's computed bias. */
export function conclusionBiasErrors(o, { supportBiases = null, roomBias = "NEUTRAL" } = {}) {
  if (!o || typeof o !== "object") return [];
  if (o.bias == null || o.bias === "") o.bias = roomBias;
  else if (ROOM_BIASES.includes(String(o.bias).trim().toUpperCase())) o.bias = String(o.bias).trim().toUpperCase();
  else return ["bias_invalid"];
  return biasSupported(o.bias, supportBiases) ? [] : ["bias_without_support"];
}

export function validateConclusion(o, h1Decision, busAgents, confirmations = null, { supportStances = null, supportBiases = null, roomBias = "NEUTRAL" } = {}) {
  const base = validateRoomModerator(o, h1Decision);
  const errors = [...base.errors, ...conclusionBiasErrors(o, { supportBiases, roomBias })];
  if (o && typeof o === "object" && confirmations && !entryAllowed(o.stance, confirmations)) errors.push("entry_without_confirmation");
  if (o && typeof o === "object" && !stanceSupported(o.stance, supportStances)) errors.push("stance_without_support");
  if (o && typeof o === "object") {
    // A blank trailing entry (seen in preview 2026-11-05: three reasons and "") carries no
    // content: drop blanks before judging the list instead of failing the whole conclusion.
    if (Array.isArray(o.reasons)) o.reasons = o.reasons.filter(r => !(typeof r === "string" && !r.trim()));
    if (!Array.isArray(o.reasons) || o.reasons.length < 1 || o.reasons.length > 3 || o.reasons.some(r => typeof r !== "string" || !r.trim())) errors.push("reasons_invalid");
    else for (const r of o.reasons) errors.push(...naturalLanguageErrors(r));
    if (!Array.isArray(o.dissent) || o.dissent.some(d => !busAgents.includes(d))) errors.push("dissent_invalid");
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

/** The majority stance of the answered openings (ties: WAIT first, then the H1 desk's stance). */
export function majorityStance(openings, h1Stance = "WAIT") {
  const counts = new Map();
  for (const o of openings) counts.set(o.stance, (counts.get(o.stance) || 0) + 1);
  let best = null;
  for (const [stance, n] of counts) {
    const prefer = (s) => (s === "WAIT" ? 2 : s === h1Stance ? 1 : 0);
    if (!best || n > best.n || (n === best.n && prefer(stance) > prefer(best.stance))) best = { stance, n };
  }
  return best?.stance ?? null;
}

/**
 * Who rebuts (at most max, the Risk Manager included):
 * - the agents whose action differs from the majority, by confidence;
 * - with `bias` (owner decision 2026-11-06), the agents whose bias leans against the room's bias.
 *   Production 13:30: all 18 agents said WAIT, so only the Risk Manager debated, although 11 leaned
 *   bearish and 3 bullish. Against a NEUTRAL room every leaning agent dissents;
 * - when anyone dissents against a BULLISH or BEARISH room, its strongest holder defends it;
 * - the Risk Manager.
 */
export function selectRebutters(openings, majority, max = WAR_ROOM_MAX_REBUTTALS, { bias = null } = {}) {
  const others = openings.filter(o => o.agent !== "risk");
  const byConfidence = (a, b) => (b.confidence ?? 0) - (a.confidence ?? 0);
  const stanceDissent = others.filter(o => o.stance !== majority).sort(byConfidence);
  const biasDissent = bias ? others.filter(o => o.stance === majority && biasOf(o) !== "NEUTRAL" && biasOf(o) !== bias).sort(byConfidence) : [];
  const dissent = [...stanceDissent, ...biasDissent];
  const defender = bias && bias !== "NEUTRAL" && dissent.length ? others.filter(o => biasOf(o) === bias && !dissent.includes(o)).sort(byConfidence)[0] : null;
  const picked = dissent.slice(0, Math.max(0, max - 1 - (defender ? 1 : 0))).map(o => o.agent);
  if (defender) picked.push(defender.agent);
  const risk = openings.find(o => o.agent === "risk");
  return risk ? [...picked, "risk"] : picked;
}

/** The debate brief when the action is unanimous but the bias is split. */
export function biasSplitText(bias) {
  return `The bus agrees on the action but not on the bias: the room leans ${bias.toLowerCase()}. Argue the bias: rebut the strongest claims that lean the other way (or, if you hold the room's bias, defend it against them), and put those agents' ids in rebuts. Give your own "bias" after the Consensus Discussion; you may change it if the bus convinced you.`;
}

const ROOM_RULES = [
  "Room stances: BUY, SELL, HOLD (keep an existing position), WAIT (stay flat), CLOSE (exit an existing position). They are discussion positions only.",
  "Never give entry, stop loss, take profit or position size: price levels come only from the validated H1 decision chain."
].join("\n");

function openingMessages(agent, data, h1) {
  const desk = DESK_AGENTS[agent];
  const riskRule = agent === "risk" ? [NO_CONFIRMATION_RULE + " Judge every possible entry against the confirmations in your data, and say plainly whether any entry is confirmed."] : [];
  const who = desk
    ? `You are the ${desk.name} in the XAUUSD Live War Room, which meets at every 15m candle close. Your only role: ${desk.role}.`
    : `You are ${HUD_NAMES[agent]}, one agent per Pine HUD, in the XAUUSD Live War Room, which meets at every 15m candle close. You speak only about the ${HUD_NAMES[agent]} HUD on the 15m candle that just closed. Lean on the statements marked verified by parity or computed from verified bars. The readers already see your calibration status once, next to your name: never mention calibration, verification or comparators in your claim. When every statement is not yet calibrated, keep your confidence at or below ${UNCALIBRATED_CONFIDENCE_CAP}.`;
  return chatMessages([
    who,
    RULES_NO_REFS,
    ROOM_RULES,
    ...riskRule,
    "This is your opening on the communication bus: one claim from your own data only. Do not repeat what other roles cover (the other agents are the 15m Desk, the Higher-Timeframe Desk, the News Analyst, the Technical Analyst, the Risk Manager and one agent per HUD).",
    `The H1 decision is ${h1.decision}.`,
    BIAS_RULE,
    `Required JSON: {"agent":"${agent}","stance":"BUY|SELL|HOLD|WAIT|CLOSE","bias":"BULLISH|BEARISH|NEUTRAL","confidence":0..1,"claim":"<= ${CLAIM_MAX - 40} chars"}`,
    "YOUR DATA:",
    JSON.stringify(data)
  ]);
}

function rebuttalMessages(agent, own, bus, h1, unanimous, confirmations, roomBias = null) {
  const riskRule = agent === "risk"
    ? [NO_CONFIRMATION_RULE + " Rebut every agent on the bus that proposes BUY or SELL without the matching confirmation. CONFIRMATIONS: " + JSON.stringify(confirmations)]
    : [];
  return chatMessages([
    `You are ${agentName(agent)} in the XAUUSD Live War Room Consensus Discussion${DESK_AGENTS[agent] ? " (" + DESK_AGENTS[agent].role + ")" : ""}. The Consensus Discussion is open for at most 3 minutes.`,
    RULES_NO_REFS,
    ROOM_RULES,
    unanimous && roomBias && agent !== "risk"
      ? biasSplitText(roomBias)
      : unanimous
        ? "The bus is unanimous. Stress-test the consensus: challenge the claim most likely to be wrong, put that agent's id in rebuts, and say what would invalidate the consensus. Add only new reasoning from your own role; never restate a claim."
        : "Rebut the strongest claims you disagree with and put those agents' ids in rebuts. Add only new reasoning from your own role; never restate your opening or another agent's claim. You may change your stance or your bias if the bus convinced you: then put the ids of the agents who convinced you in rebuts (or leave it empty), never your own id.",
    ...riskRule,
    "In the argument, call agents by their names (for example the Kinetic Engine), never by an id. Each bus entry says how much of that agent's data is verified by parity or computed from verified bars: weigh that evidence above uncalibrated readings, and never discuss calibration itself.",
    `The H1 decision is ${h1.decision}.`,
    `Required JSON: {"agent":"${agent}","stance":"BUY|SELL|HOLD|WAIT|CLOSE","bias":"BULLISH|BEARISH|NEUTRAL","confidence":0..1,"rebuts":["<agent id>"],"argument":"<= ${ARGUMENT_MAX - 40} chars"}`,
    "YOUR OPENING: " + JSON.stringify({ stance: own.stance, bias: own.bias ?? null, confidence: own.confidence, claim: own.claim }),
    "COMMUNICATION BUS (id, name, stance, bias, confidence, evidence, claim):",
    JSON.stringify(bus)
  ]);
}

function conclusionMessages(h1, bus, debate, confirmations) {
  return chatMessages([
    "You are the moderator of the XAUUSD Live War Room. The Consensus Discussion is closed. Write the conclusion for the main panel.",
    RULES_NO_REFS,
    ROOM_RULES,
    `The H1 decision (${h1.decision}) is the constraint: if your stance differs from it, the summary must say "H1 decision: ${h1.decision}" and why the room still differs.`,
    NO_CONFIRMATION_RULE + " The conclusion obeys it: BUY or SELL only with the matching confirmation below. CONFIRMATIONS: " + JSON.stringify(confirmations),
    SUPPORT_RULE,
    DECISION_BIAS_RULE + " A BULLISH or BEARISH bias needs at least one agent holding it.",
    "Weigh claims by their argument and by their evidence, not by the number of agents: a claim built on data verified by parity, or computed from verified bars, outweighs one built on uncalibrated readings (each bus entry states which). No repetition: the summary states the conclusion once, each reason adds something new, and dissent lists the ids of agents whose stance or bias still differs from yours (never an agent that agrees with both). In the summary and reasons, call agents by their names, never by an id, and never discuss calibration itself.",
    `Required JSON: {"stance":"BUY|SELL|HOLD|WAIT|CLOSE","bias":"BULLISH|BEARISH|NEUTRAL","confidence":0..1,"summary":"<= 360 chars","reasons":["<= 160 chars", "at most 3"],"dissent":["<agent id>"]}`,
    "COMMUNICATION BUS:",
    JSON.stringify(bus),
    "CONSENSUS DISCUSSION:",
    JSON.stringify(debate)
  ]);
}

/** The latest ok conclusion of a timeframe room (for the Higher-Timeframe Desk), or null. */
async function latestRoomConclusion(db, threadId) {
  try {
    const row = await db.prepare("SELECT run_id, stance, confidence, body_json FROM agent_thread_messages WHERE thread_id = ? AND step = 'conclusion' AND status = 'ok' ORDER BY run_id DESC LIMIT 1").bind(threadId).first();
    if (!row) return null;
    const body = parseJson(row.body_json, {}) || {};
    return { bar_open: String(row.run_id).split("#")[0], stance: row.stance, bias: body.bias ?? null, confidence: row.confidence, summary: body.summary ?? null };
  } catch { return null; }
}

/** Each agent's own data: one role each, nothing shared that another role covers. */
function agentData(agent, evidence, hud, h1Detail, confirmations, desk15, oneHour) {
  switch (agent) {
    case "m15": return { timeframe: "15 minutes", reading: desk15.reading, approved_by_parity: desk15.approved_by_parity };
    case "htf": return { h1_decision: h1Detail.decision, confidence: h1Detail.confidence, reasoning: h1Detail.reasoning, tradingview_h1: evidence.h1.tradingview, one_hour_room: oneHour };
    case "news": return evidence.news ? { window: evidence.news.window ?? "the latest hourly batch", consensus: evidence.news.consensus, confidence: evidence.news.confidence, summary: evidence.news.summary, reasons: evidence.news.reasons, counts: evidence.news.counts, headlines: evidence.news.headlines } : { available: false, note: "no news consensus yet" };
    case "technical": return { candles_15m: evidence.m15.candles, execution_5m: { label: evidence.m5.label, bias: evidence.m5.bias, reading: evidence.m5.reading?.summary ?? null, last_bars: evidence.m5.recent_bars.slice(-6) } };
    case "risk": {
      const c = evidence.m15.candles;
      const ranges = c.map(x => Math.round((x.h - x.l) * 100) / 100);
      return { candles_15m: c, ranges_15m: ranges, h1_decision: evidence.h1.decision, h1_confidence: evidence.h1.confidence, news_consensus: evidence.news?.consensus ?? null, execution_5m_label: evidence.m5.label, confirmations };
    }
    default: return { hud: HUD_NAMES[agent], timeframe: "15 minutes", reading: hudEvidenceLines(hud?.readings?.[agent]) };
  }
}

/**
 * Runs the War Room for one 15m close. Idempotent per bar: stored ok steps are reused, failed
 * steps are retried, and a stored ok conclusion ends the run.
 */
export async function runWarRoomBar(env, task, { clock = () => Date.now() } = {}) {
  if (!warRoomEnabled(env)) return { status: "disabled", calls: 0 };
  const db = env.DB;
  await ensureThreadSchema(db);
  const barTime = new Date(Date.parse(task.bar_time)).toISOString();
  if (!isFifteenMinuteClose(barTime)) return { status: "not_15m_close", calls: 0 };
  const live = await liveEvidence(env, task, barTime);
  if (live.status) return { status: live.status, calls: 0 };
  const { evidence, synthesis, confirmations } = live;
  // News Daily (owner decision 2026-11-06): the News Analyst reads the last 24 hours when present.
  const daily = await newsDeskEvidence(db);
  if (daily) evidence.news = daily;
  const decision = parseJson(synthesis?.ai_analysis, {})?.decision || {};
  const h1 = { decision: evidence.h1.decision, confidence: evidence.h1.confidence, candle_key: evidence.h1.candle_key, reasoning: clip(decision.reasoning, 400) };

  let hud = null;
  try {
    const key15 = m15KeyForClose(barTime);
    const carried = task.hud && typeof task.hud === "object" && task.hud.candle_key === key15 ? task.hud : null;
    const snapshot = carried || await loadHudSnapshot(env, { timeframe: "15", candleKey: key15 });
    hud = snapshot ? await hudReadings(env, snapshot) : null;
  } catch { hud = null; }
  // The 15m Desk: the 15m local records of the candle that just closed (owner decision 2026-11-06).
  let desk15 = { available: false, reading: [], approved_by_parity: false };
  try { desk15 = await chartDeskReading(env, m15KeyForClose(barTime)); } catch { /* no desk this bar */ }
  const oneHour = await latestRoomConclusion(db, "tf:H1");
  const roster = [...(desk15.available ? ["m15"] : []), "htf", "news", "technical", "risk", ...HUD_IDS.filter(id => hud?.readings?.[id]?.available)];
  // Evidence status, shown once per agent (owner decision A): no agent repeats it in its text.
  const calibration = Object.fromEntries(roster.map(id => {
    const lines = hud?.readings?.[id]?.lines;
    if (Array.isArray(lines)) return [id, calibrationCounts(lines)];
    if (id === "m15") return [id, { label: chartDeskLabel("15m", desk15) }];
    if (id === "htf") return [id, { label: "parity-approved H1 chain" }];
    if (id === "technical" || id === "risk") return [id, { label: evidence.m5.label }];
    return [id, { label: "news analysis" }];
  }));
  const evidenceNote = (id) => {
    const c = calibration[id] || {};
    if (c.total_lines == null) return c.label || null;
    return calibrationNote(c, "no statement calibrated yet");
  };

  const day = barTime.slice(0, 10);
  const threadId = `warroom:${day}`;
  await upsertThread(db, { id: threadId, kind: "warroom", refKey: day, title: `Live War Room 15m · ${day}`, post: null, now: clock() });
  const existing = new Map(((await db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id = ? AND run_id = ?").bind(threadId, barTime).all()).results || []).map(r => [r.step, rowToThreadMessage(r)]));
  if (existing.get("conclusion")?.status === "ok") return { status: "already_complete", calls: 0 };
  const base = (step, agent, parent_id = null) => ({ thread_id: threadId, run_id: barTime, step, agent, parent_id, bar_time: barTime });
  if (!existing.has("brief")) {
    await writeMessage(db, { ...base("brief", "system"), ts: new Date(clock()).toISOString(), status: "info", body: { roster, calibration, h1: { ...h1, reasoning: undefined }, confirmations, m5_label: evidence.m5.label, m15_close: evidence.m15.candles.at(-1) ?? null, news: evidence.news } });
  }

  // One budget for the bar, shared by every parallel step (and its correction call).
  const roomEnv = { ...env, MULTI_AGENT_FALLBACK_MODEL: env.MULTI_AGENT_MODEL || BUS_DEFAULT_MODEL };
  const maxPerHour = Number(env.WAR_ROOM_MAX_CALLS_PER_HOUR ?? 112);
  let remaining = 0;
  try { remaining = (Number.isFinite(maxPerHour) ? maxPerHour : 0) - (await callsInLastHour(db, clock(), "warroom")); } catch { remaining = 0; }
  let calls = 0;
  const phase = (ms) => {
    const deadline = clock() + ms;
    const runState = { primaryError: null };
    const budgetOk = async () => clock() < deadline && remaining-- > 0;
    return (stepBase, opts) => { calls += 1; return runStep(roomEnv, db, stepBase, { ...opts, deadline, clock, runState, budgetOk }); };
  };

  // Phase 1: the communication bus.
  const open = phase(WAR_ROOM_OPENING_MS);
  const openings = await Promise.all(roster.map(agent => {
    const prior = existing.get("open:" + agent);
    if (prior?.status === "ok") return prior;
    return open(base("open:" + agent, agent), {
      messages: openingMessages(agent, agentData(agent, evidence, hud, h1, confirmations, desk15, oneHour), h1), schemaName: "war_room_opening", schema: OPENING_SCHEMA,
      // An unapproved 15m chain speaks like any uncalibrated agent: at 0.4 or lower.
      maxTokens: BUS_MAX_TOKENS.agent, effort: "low", validate: (o) => validateOpening(o, agent, { verifiedLines: agent === "m15" ? (desk15.approved_by_parity ? null : 0) : calibration[agent]?.total_lines == null ? null : calibratedLines(calibration[agent]) }),
      toBody: (o) => ({ body: { claim: clip(o.claim, CLAIM_MAX), bias: o.bias, name: agentName(agent) }, refs: [] })
    });
  }));
  const answered = openings.filter(m => m?.status === "ok");
  if (answered.length && answered.length * 2 < roster.length && clock() - Date.parse(barTime) < WAR_ROOM_QUORUM_WAIT_MS) {
    return { status: "waiting_for_quorum", calls, openings: answered.length, roster: roster.length };
  }
  const bus = answered.map(m => ({ id: m.agent, name: agentName(m.agent), stance: m.stance, bias: m.bias ?? null, confidence: m.confidence, evidence: evidenceNote(m.agent), claim: m.claim }));
  const busAgents = bus.map(b => b.id);

  // Phase 2: the Consensus Discussion, open for at most 3 minutes.
  const majority = majorityStance(answered, h1.decision);
  const roomBias = majorityBias(answered);
  const rebutters = selectRebutters(answered, majority, WAR_ROOM_MAX_REBUTTALS, { bias: roomBias });
  const unanimous = answered.every(m => m.stance === majority);
  const biasSplit = unanimous && rebutters.some(a => a !== "risk") ? roomBias : null;
  const debateStep = phase(WAR_ROOM_DEBATE_MS);
  const openingId = new Map(answered.map(m => [m.agent, m.id]));
  const debate = (await Promise.all(rebutters.map(agent => {
    const prior = existing.get("debate:" + agent);
    if (prior?.status === "ok") return prior;
    const own = answered.find(m => m.agent === agent);
    return debateStep(base("debate:" + agent, agent, openingId.get(agent) ?? null), {
      messages: rebuttalMessages(agent, own, bus, h1, unanimous, confirmations, biasSplit), schemaName: "war_room_rebuttal", schema: REBUTTAL_SCHEMA,
      maxTokens: BUS_MAX_TOKENS.agent, effort: "low", validate: (o) => validateRebuttal(o, agent, busAgents, { unanimous, ownStance: own?.stance ?? null, ownBias: own?.bias ?? null }),
      toBody: (o) => ({ body: { argument: clip(o.argument, ARGUMENT_MAX), bias: o.bias, rebuts: [...new Set(o.rebuts)].slice(0, 4), ...(o.conceded ? { conceded: true } : {}), name: agentName(agent) }, refs: [] })
    });
  }))).filter(m => m?.status === "ok");

  // Phase 3: the conclusion for the main panel.
  if (!answered.length) return { status: "no_openings", calls };
  const conclude = phase(WAR_ROOM_CONCLUSION_MS);
  await conclude(base("conclusion", "moderator"), {
    messages: conclusionMessages(h1, bus, debate.map(m => ({ id: m.agent, name: agentName(m.agent), stance: m.stance, bias: m.bias ?? null, confidence: m.confidence, rebuts: m.rebuts, argument: m.argument })), confirmations),
    schemaName: "war_room_conclusion", schema: CONCLUSION_SCHEMA, maxTokens: BUS_MAX_TOKENS.moderator, effort: "low",
    validate: (o) => validateConclusion(o, h1.decision, busAgents, confirmations, { supportStances: new Set([...answered.map(m => m.stance), ...debate.map(m => m.stance)]), supportBiases: new Set([...answered.map(biasOf), ...debate.map(biasOf)]), roomBias }),
    toBody: (o) => ({ body: { summary: clip(o.summary, 400), bias: o.bias, reasons: o.reasons.slice(0, 3).map(r => clip(r, 200)), dissent: [...new Set(o.dissent)], majority, majority_bias: roomBias, h1_decision: h1.decision }, refs: [] })
  });
  return { status: "complete", calls, openings: answered.length, rebuttals: debate.length };
}

/** The latest War Room run (or the one at barTime): brief, bus, debate and conclusion. */
export async function readWarRoom(db, { barTime = null } = {}) {
  await ensureThreadSchema(db);
  const run = barTime
    ? new Date(Date.parse(barTime)).toISOString()
    : (await db.prepare("SELECT MAX(run_id) AS r FROM agent_thread_messages WHERE thread_id LIKE 'warroom:%'").first())?.r;
  if (!run) return null;
  const rows = ((await db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id = ? AND run_id = ? ORDER BY id").bind(`warroom:${run.slice(0, 10)}`, run).all()).results || []).map(rowToThreadMessage);
  if (!rows.length) return null;
  const brief = rows.find(m => m.step === "brief") || null;
  const pick = (m) => ({ id: m.agent, name: agentName(m.agent), status: m.status, model: m.model, fallback_used: m.fallback_used, errors: m.errors, stance: m.stance, bias: m.bias ?? null, confidence: m.confidence, ts: m.ts, claim: m.claim, argument: m.argument, rebuts: m.rebuts, rebuts_names: (m.rebuts || []).map(agentName), conceded: m.conceded === true });
  // Steps run in parallel, so rows land in completion order: show them in roster order.
  const order = new Map((brief?.roster || []).map((id, i) => [id, i]));
  const byRoster = (a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99);
  const openings = rows.filter(m => m.step.startsWith("open:")).map(pick).sort(byRoster);
  const debate = rows.filter(m => m.step.startsWith("debate:")).map(pick).sort(byRoster);
  const c = rows.find(m => m.step === "conclusion");
  const conclusion = c ? { status: c.status, stance: c.stance, bias: c.bias ?? null, majority_bias: c.majority_bias ?? null, confidence: c.confidence, summary: c.summary ?? null, reasons: c.reasons ?? [], dissent: (c.dissent || []).map(id => ({ id, name: agentName(id) })), majority: c.majority ?? null, h1_decision: c.h1_decision ?? null, ts: c.ts } : null;
  const started = brief?.ts ?? rows[0].ts;
  return {
    bar_time: run,
    phase: c?.status === "ok" ? "closed" : debate.length ? "debate" : "opening",
    started_at: started,
    debate_window_seconds: WAR_ROOM_DEBATE_MS / 1000,
    roster: (brief?.roster || openings.map(o => o.id)).map(id => ({ id, name: agentName(id), role: DESK_AGENTS[id]?.role ?? `the ${agentName(id)} HUD on the 15m chart`, calibration: brief?.calibration?.[id] ?? null })),
    h1: brief?.h1 ?? null,
    m5_label: brief?.m5_label ?? null,
    confirmations: brief?.confirmations ?? null,
    m15_close: brief?.m15_close ?? null,
    openings,
    debate,
    conclusion
  };
}

/** TLDR cards for the right panel: Threads 1H and News Thread. */
export async function readTldr(db) {
  await ensureThreadSchema(db);
  const synth = await db.prepare("SELECT candle_key, ai_analysis FROM ai_syntheses WHERE timeframe = '60' OR candle_key LIKE '%:60:%' ORDER BY id DESC LIMIT 1").first();
  let h1 = null;
  if (synth) {
    const d = parseJson(synth.ai_analysis, {})?.decision || {};
    let consensus = null;
    try {
      const mod = await db.prepare("SELECT insight, confidence FROM bus_messages WHERE candle_key = ? AND agent = 'moderator' AND status = 'ok' ORDER BY ts DESC LIMIT 1").bind(synth.candle_key).first();
      const body = parseJson(mod?.insight, null);
      if (body) consensus = { stance: body.stance ?? null, confidence: mod.confidence ?? null, summary: clip(body.summary, 300) };
    } catch { consensus = null; }
    h1 = { candle_key: synth.candle_key, decision: String(d.decision || "WAIT").toUpperCase(), confidence: d.confidence ?? null, tldr: clip(d.reasoning, 280), consensus };
  }
  const t = await db.prepare("SELECT t.id, t.ref_key, t.title, t.created_at, t.post_json, m.stance, m.confidence, m.body_json FROM agent_threads t LEFT JOIN agent_thread_messages m ON m.thread_id = t.id AND m.step = 'moderator' AND m.status = 'ok' WHERE t.kind = 'news' ORDER BY t.created_at DESC LIMIT 1").first();
  const post = parseJson(t?.post_json, {}) || {};
  const news = t ? { thread_id: t.id, title: t.title, created_at: t.created_at, consensus: t.stance ?? null, confidence: t.confidence ?? null, tldr: clip(parseJson(t.body_json, {})?.summary, 300), headlines: (post.headlines || []).slice(0, 3) } : null;
  return { h1, news };
}
